// Shared Chrome DevTools Protocol client + dedicated-profile lifecycle.
// Extracted from claude-chrome.ts so the web-order tool can drive the same
// dedicated Chrome profile (Umberto's logins for Uber Eats / Deliveroo /
// Just Eat live there, granted once by him in that window).
//
// The profile: ~/.eve-chrome-profile, debugging port 9222. `ensureChrome`
// launches it if it isn't up (window appears once for login; then sessions
// persist). Cdp is a minimal JSON-RPC-over-ws client.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import http from "node:http";
import { WebSocket } from "ws";

const execFileP = promisify(execFile);

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const CHROME_PROFILE_DIR = "/Users/YOU/.eve-chrome-profile";
export const DEBUG_PORT = 9222;

export async function chromeIsUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

export async function ensureChrome(): Promise<void> {
  if (await chromeIsUp()) return;
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  await execFileP(CHROME, [
    "--remote-debugging-port=" + DEBUG_PORT,
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
    "-g",
    "about:blank",
  ]).catch(() => {}); // Chrome daemonises; the call never resolves normally
  for (let i = 0; i < 30; i++) {
    if (await chromeIsUp()) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("Chrome (profilo EVE) non si avvia — verifica che non sia bloccato da macOS.");
}

export async function getWsUrl(): Promise<string> {
  const body = await new Promise<string>((resolve, reject) => {
    http.get(`http://127.0.0.1:${DEBUG_PORT}/json/list`, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
  const targets = JSON.parse(body) as { type: string; webSocketDebuggerUrl?: string; url?: string }[];
  // Prefer a real page (not devtools/internal), most recent first.
  const page = targets.filter(t => t.type === "page" && t.url && !t.url.startsWith("devtools")).pop();
  if (!page?.webSocketDebuggerUrl) throw new Error("Nessuna tab Chrome raggiungibile via CDP.");
  return page.webSocketDebuggerUrl;
}

// A page of our own, so a crawl never steals the tab Umberto is reading.
// getWsUrl() hands back the LAST open page — fine for web_order, which drives
// one checkout the human is watching, but the ESSEC knowledge crawl loads
// twenty pages in a row, and doing that in whatever tab happens to be frontmost
// would navigate away from his Deliveroo cart or his claude.ai thread mid-use.
// Chrome only mints a target over PUT (a GET returns 405 on current builds).
export interface ScratchTab {
  id: string;
  wsUrl: string;
}

export async function openScratchTab(): Promise<ScratchTab> {
  const body = await new Promise<string>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: DEBUG_PORT, path: "/json/new?about:blank", method: "PUT" },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      },
    );
    req.on("error", reject);
    req.end();
  });
  const target = JSON.parse(body) as { id?: string; webSocketDebuggerUrl?: string };
  if (!target.id || !target.webSocketDebuggerUrl) {
    throw new Error(`Chrome non ha aperto una tab di servizio: ${body.slice(0, 200)}`);
  }
  return { id: target.id, wsUrl: target.webSocketDebuggerUrl };
}

// Best effort on purpose: a leaked blank tab is untidy, a throw here would mask
// the real error from the work that just failed inside the try block.
export async function closeTab(id: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = http.get(`http://127.0.0.1:${DEBUG_PORT}/json/close/${id}`, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.setTimeout(1500, () => {
      req.destroy();
      resolve();
    });
  });
}

export class Cdp {
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

  // Evaluate a JS expression, return the value (JSON-friendly).
  async eval(expression: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r?.result?.value;
  }

  // ── reading a page you do not trust ──────────────────────────────────
  // eval() above runs in the page's MAIN world, where every global belongs to
  // the document: a page that redefines JSON.stringify decides what comes back.
  // That is fine for driving a checkout the human is watching, and NOT fine for
  // a guard — the ESSEC crawl decides whether it is allowed to store a page by
  // asking the page where it is. A hostile document could hand back
  // "https://my.essec.fr/…" and walk straight through the host check.
  //
  // An isolated world is a separate JS context over the SAME DOM: fresh
  // built-ins and fresh DOM wrappers, so nothing the page patched applies. It
  // is destroyed on every navigation, so it is created per page, after load.
  async isolatedWorld(worldName = "eve-read"): Promise<{ contextId: number; frameId: string }> {
    await this.send("Page.enable");
    const tree = await this.send("Page.getFrameTree");
    const frameId = tree?.frameTree?.frame?.id;
    if (!frameId) throw new Error("CDP non espone il frame principale — impossibile leggere la pagina in sicurezza.");
    const world = await this.send("Page.createIsolatedWorld", {
      frameId,
      worldName,
      grantUniveralAccess: false,
    });
    const contextId = world?.executionContextId;
    if (typeof contextId !== "number") throw new Error("CDP non ha creato il contesto isolato.");
    return { contextId, frameId };
  }

  // The URL according to the BROWSER, not according to the page. Page JS cannot
  // reach this at all, which is the point: it is the one fact the host check
  // must not take the document's word for.
  async frameUrl(): Promise<string> {
    await this.send("Page.enable");
    const tree = await this.send("Page.getFrameTree");
    const url = tree?.frameTree?.frame?.url;
    if (typeof url !== "string") throw new Error("CDP non espone l'URL del frame principale.");
    return url;
  }

  // Evaluate inside an isolated world. Same shape as eval(), different world.
  async evalIn(contextId: number, expression: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: false,
    });
    if (r?.exceptionDetails) {
      throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r?.result?.value;
  }

  on(listener: (method: string, params: any) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
