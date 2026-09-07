// Headless check of the face's self-heal: a stale "working" panel must
// reconcile against a snapshot that says the server is idle.
//
// The bug this pins is the one Umberto saw on 2026-09-06: the "ho fame"
// turn died server-side, the turn_error went to a half-dead socket, and
// when the phone reconnected it received a fresh snapshot with
// state:"idle" — which renderSnapshot answered by keeping the stale
// "working" panel exactly where it was ("preparing options for you /
// in progress", for two hours). The snapshot IS the server's truth; a
// client that ignores it when it disagrees with its local panel lies
// forever.
//
// This drives the REAL page with the REAL shell.js — no DOM mocks — via
// the console hook the face exposes for exactly this (window.EveShell.
// onMsg feeds a server message by hand). The page is served statically
// with no WebSocket backend: the socket fails and retries in the
// background, which is fine — EveShell.onMsg is independent of it.
//
// Run: node --import tsx scripts/face-reconcile-check.ts
// Exit 0 = the face reconciles; 1 = it kept a stale panel (or broke).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FACE_DIR = path.join(ROOT, "face");
const PORT = 3987; // never the real face port — this check must not meet the real server

// ── a minimal static server for face/, same MIME mapping the real one uses ──
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = http.createServer((req, res) => {
  const rel = ((req.url ?? "/").split("?")[0] ?? "/") === "/" ? "index.html" : ((req.url ?? "/").slice(1).split("?")[0] ?? "index.html");
  const file = path.resolve(FACE_DIR, rel);
  if (!file.startsWith(FACE_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

// ── locate the cached headless chromium (same one the face checks use) ──
const CANDIDATES = [
  process.env.EVE_HEADLESS_SHELL,
  path.join(
    process.env.HOME ?? "",
    "Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  ),
].filter(Boolean) as string[];
const SHELL = CANDIDATES.find((p) => fs.existsSync(p));
if (!SHELL) {
  console.error("no headless chromium found — set EVE_HEADLESS_SHELL or install the playwright cache");
  process.exit(1);
}

const CDP_PORT = 3988;
const proc = spawn(SHELL, [
  "--headless",
  `--remote-debugging-port=${CDP_PORT}`,
  // Headless WebGL needs SwiftShader, else the orb's fail() path hides the
  // canvas and a healthy page looks broken (learned the long way).
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--no-first-run",
  "--mute-audio",
  `http://127.0.0.1:${PORT}/`,
]);
proc.on("exit", () => {/* reaped in finally */});

// ── a zero-dependency CDP driver over Node's global WebSocket ──
async function cdp(): Promise<(method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>> {
  let ws: WebSocket | null = null;
  for (let i = 0; i < 40 && !ws; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === "page");
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      /* browser not up yet */
    }
  }
  if (!ws) throw new Error("headless browser never answered");
  await new Promise<void>((r, j) => {
    ws!.addEventListener("open", () => r());
    ws!.addEventListener("error", () => j(new Error("cdp websocket failed")));
  });
  let seq = 0;
  const pending = new Map<number, { r: (v: any) => void; j: (e: Error) => void }>();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      m.error ? p.j(new Error(m.error.message)) : p.r(m.result);
    }
  });
  return (method, params = {}) =>
    new Promise((r, j) => {
      const id = ++seq;
      pending.set(id, { r, j });
      ws!.send(JSON.stringify({ id, method, params }));
    });
}

const call = await cdp();
const evalInPage = async (expression: string): Promise<any> => {
  const res = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`);
  return res.result.value;
};

let exitCode = 1; // set to 0 only on PASS; the finally cleans up before exit
try {
  // Wait for the app controller: the module sets window.EveShell on load.
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    up = await evalInPage("Boolean(window.EveShell && document.querySelector('#eve-state-label'))");
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error("shell.js never exposed window.EveShell — module load failed?");

  // Reproduce the evening exactly: a tool step lands (the face shows
  // "working" and a running step), then the server dies mid-turn and the
  // client reconnects to a snapshot that says idle.
  const scenario = `
    (async () => {
      const served = await (await fetch("/shell.js")).text();
      const hasFix = served.includes("reconnection moment");
      window.EveShell.onMsg({ type: "tool_call", name: "open_options_window" });
      window.EveShell.onMsg({ type: "snapshot", snapshot: {
        state: "idle", paused: false, sandboxed: false,
        notices: [], reminders: [], facts: [], usage: null,
        agents: [], factoryPending: [],
      }});
      const label = document.querySelector("#eve-state-label")?.textContent ?? "";
      const stale = [...document.querySelectorAll("#eveProgress .eve-step.running")].length;
      // The crossfade face marks the visible panel with .is-active (the old
      // hidden attribute is gone); the tab strip mirrors it.
      const visiblePanel = document.querySelector(".eve-state-panel.is-active")?.getAttribute("aria-label") ?? "(none)";
      const panelClasses = [...document.querySelectorAll(".eve-state-panel")].map(p => p.getAttribute("aria-label") + ":" + (p.classList.contains("is-active") ? "A" : "-")).join(" ");
      return JSON.stringify({ hasFix, label, staleRunningSteps: stale, visiblePanel, panelClasses });
    })()
  `;
  const raw = await evalInPage(scenario);
  const result = JSON.parse(raw as string);
  console.log(`served shell.js has the fix: ${result.hasFix}`);
  console.log(`state label: ${result.label}`);
  console.log(`visible panel after idle snapshot: ${result.visiblePanel}`);
  console.log(`steps still "running": ${result.staleRunningSteps}`);

  // The guard: after a snapshot that says the server is IDLE, the face must
  // not still be showing the working panel — and the step the user was
  // staring at must be closed, not left mid-spin.
  const reconciled =
    result.visiblePanel !== "working" && result.staleRunningSteps === 0;
  // NOTE: no process.exit() inside the try — it would skip the finally and
  // leak the headless browser on port 3988, where the NEXT run's CDP would
  // find it and probe a stale page (exactly the confusion this check's own
  // first sessions produced). Set the code, fall through to cleanup.
  if (reconciled) {
    console.log("PASS — the face reconciled to the server's idle truth");
    exitCode = 0;
  } else {
    console.error(
      "FAIL — the face kept the stale working panel after an idle snapshot.\n" +
        "This is the two-hour 'in progress' bug: renderSnapshot must reconcile\n" +
        "against snapshot.state instead of preserving the local panel.",
    );
    exitCode = 1;
  }
} finally {
  proc.kill("SIGKILL");
  server.close();
}
process.exit(exitCode);
