// Claude in Chrome — EVE drives the claude.ai web UI through the Chrome
// DevTools Protocol, using Umberto's own logged-in session (his Max
// subscription, not an API key). A dedicated Chrome profile keeps EVE's
// automation separate from his daily browsing.
//
// Why a separate profile: CDP needs Chrome started with --remote-debugging-port,
// which nobody wants on their main profile. We launch a dedicated user-data-dir
// once, Umberto logs into claude.ai in that window, and the login persists in
// the profile — subsequent runs are headless-capable.
//
// Honesty note (kept visible on purpose): this automates the web UI, which is
// more fragile than an API and can, in principle, trip Anthropic's bot
// detection. It is one channel among several (claude API, claude-code, hermes,
// chatgpt); if it breaks, EVE relays through the others. The tool reports
// failures plainly instead of pretending.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import { WebSocket } from "ws";
import { audit } from "../core/audit.js";
import { emitAgentEvent } from "../core/agent-events.js";

const execFileP = promisify(execFile);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE_DIR = "/Users/YOU/.eve-chrome-profile";
const DEBUG_PORT = 9222;
const CLAUDE_URL = "https://claude.ai/new";

// ── Chrome lifecycle ─────────────────────────────────────────────────────

async function chromeIsUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function ensureChrome(): Promise<void> {
  if (await chromeIsUp()) return;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  // -g keeps it in background; the window belongs to EVE's profile, not his.
  await execFileP(CHROME, [
    "--remote-debugging-port=" + DEBUG_PORT,
    `--user-data-dir=${PROFILE_DIR}`,
    "-g",
    "about:blank",
  ]).catch(() => {}); // Chrome daemonises; the execFile call never resolves normally
  // Wait for the debugging endpoint
  for (let i = 0; i < 30; i++) {
    if (await chromeIsUp()) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("Chrome (profilo EVE) non si avvia — verifica che non sia bloccato da macOS.");
}

async function getWsUrl(): Promise<string> {
  const body = await new Promise<string>((resolve, reject) => {
    http.get(`http://127.0.0.1:${DEBUG_PORT}/json/list`, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
  const targets = JSON.parse(body) as { type: string; webSocketDebuggerUrl?: string }[];
  const page = targets.find(t => t.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("Nessuna tab Chrome raggiungibile via CDP.");
  return page.webSocketDebuggerUrl;
}

// ── Minimal CDP client over ws ───────────────────────────────────────────

class Cdp {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners: Array<(method: string, params: any) => void> = [];

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(String(data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params);
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener: (method: string, params: any) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

// ── Claude web session ───────────────────────────────────────────────────

async function askClaudeInChrome(prompt: string, opts: { model?: string } = {}): Promise<string> {
  await ensureChrome();
  const cdp = new Cdp();
  await cdp.connect(await getWsUrl());
  try {
    // Fresh chat
    await cdp.send("Page.navigate", { url: CLAUDE_URL });
    await sleep(2500); // SPA boot
    await waitForClaudeReady(cdp);

    // Type the prompt into the composer. claude.ai's composer is a ProseMirror
    // div; setting .value doesn't work, we go through paste.
    const escaped = JSON.stringify(prompt);
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const p = document.querySelector('div[contenteditable="true"]');
        if (!p) return 'NO_COMPOSER';
        const dt = new DataTransfer();
        dt.setData('text/plain', ${escaped});
        p.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
        return 'OK';
      })()`,
      awaitPromise: false,
    });
    await sleep(400);

    // Submit with the keyboard so the site's own handlers run.
    for (const key of ["Enter"]) {
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    await sleep(1500);

    // Read responses as they stream. The last assistant message grows until
    // the stop button disappears.
    const answer = await waitForClaudeAnswer(cdp);
    return answer;
  } finally {
    cdp.close();
  }
}

async function waitForClaudeReady(cdp: Cdp): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `!!document.querySelector('div[contenteditable="true"]')`,
      returnByValue: true,
    });
    if (r?.result?.value === true) return;
    await sleep(500);
  }
  throw new Error("claude.ai non mostra il composer — forse serve il login (apri il profilo EVE di Chrome una volta e accedi).");
}

async function waitForClaudeAnswer(cdp: Cdp): Promise<string> {
  // Poll the DOM: the answer is the last assistant bubble; when the aria-stop
  // button disappears, the response is complete. Timeout 3 min.
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastText = "";
  while (Date.now() < deadline) {
    await sleep(2500);
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const stop = document.querySelector('button[aria-label="Stop"]') || document.querySelector('button[aria-label*="stop" i]');
        const blocks = document.querySelectorAll('[data-testid="assistant-message"], .font-claude-message');
        const last = blocks.length ? blocks[blocks.length - 1].innerText : "";
        return JSON.stringify({ generating: !!stop, text: last });
      })()`,
      returnByValue: true,
    });
    try {
      const state = JSON.parse(r?.result?.value ?? "{}");
      if (typeof state.text === "string" && state.text.length > 0) lastText = state.text;
      if (!state.generating && lastText) return lastText;
    } catch { /* transient parse noise while streaming */ }
  }
  return lastText || "(Claude non ha risposto entro 3 minuti)";
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Tool registration ─────────────────────────────────────────────────────

export const claudeChromeTools: EveTool[] = [
  {
    name: "claude_chrome",
    description:
      "Ask Claude on claude.ai through Umberto's logged-in Chrome session (his Max subscription, not an API key). Use it when you want Claude's web-UI answer or a second opinion through the web app itself — for coding use claude-code, for pure reasoning the claude API call is more reliable. The first run may need a one-time login in EVE's Chrome profile; if it fails, report that plainly.",
    schema: z.object({
      prompt: z.string().min(1).max(8000).describe("The question or task for Claude, self-contained."),
    }),
    needsConfirmation: () => false,
    run: async (input: { prompt: string }) => {
      const started = Date.now();
      const descriptor = { id: "claude-chrome", name: "Claude (Chrome)", specialty: "claude web session" };
      emitAgentEvent({ agent: "claude-chrome", phase: "dispatch", label: input.prompt.slice(0, 80), descriptor });
      try {
        const answer = await askClaudeInChrome(input.prompt);
        audit("delegate", { to: "claude-chrome", seconds: Math.round((Date.now() - started) / 1000) });
        emitAgentEvent({ agent: "claude-chrome", phase: "done", label: `${Math.round((Date.now() - started) / 1000)}s`, descriptor });
        return answer;
      } catch (err) {
        emitAgentEvent({ agent: "claude-chrome", phase: "error", label: String(err).slice(0, 80), descriptor });
        throw err;
      }
    },
  },
];
