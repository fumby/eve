// EVE's face server: serves the orb page and bridges it to the same brain,
// tools, gate, and heartbeat the terminal uses. Localhost only, by design.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { loadEnv, loadConfig, setHeartbeatPaused, ROOT, STATE_ROOT } from "../core/config.js";
import { Registry } from "../core/registry.js";
import { reminderTools, loadReminders } from "../tools/reminders.js";
import { loadConversations, getConversation } from "../core/conversations.js";
import { extractConversation, catchUpExtractions } from "../memory/extractor.js";
import { buildSkeleton } from "../mind/skeleton.js";
import { nodeDetail } from "../mind/detail.js";
import { noteTools } from "../tools/notes.js";
import { projectTools } from "../tools/projects.js";
import { memoryTools } from "../tools/memory.js";
import { listMemories, memoriesAsFacts } from "../memory/store.js";
import { weatherTools } from "../tools/weather.js";
import { researchTools } from "../tools/research.js";
import { perplexityTools } from "../tools/perplexity.js";
import { boardTools } from "../tools/board.js";
import { ledgerTools } from "../tools/ledger.js";
import { Heartbeat } from "../heartbeat.js";
import { listNotices, dismissNotice } from "../core/notices.js";
import { usageToday, audit, onAuditEvent } from "../core/audit.js";
import { warmTts } from "../voice/tts.js";
import { FaceTurns } from "./turns.js";
import { sameOrigin } from "./origin.js";
import { PREVIEW_MIME, handlePreviewRequest } from "../design/routes.js";
import { resolveProjectRoot } from "../design/docs.js";
import { designTools, setDesignNoticeSink } from "../design/tools.js";
import { onDesignEvent } from "../design/dispatch.js";
import { onAgentEvent } from "../core/agent-events.js";
import { agentRoster } from "./roster.js";
import type { ClientMsg, ServerMsg, Snapshot, FactoryPending } from "./protocol.js";
import { factoryTools } from "../tools/factory.js";
import { installWatcher } from "../factory/watcher.js";
import { pendingApproval } from "../factory/store.js";
import { approveTask, rejectTask } from "../factory/approve.js";

loadEnv();
const PORT = loadConfig().face.port;
const FACE_DIR = path.join(ROOT, "face");

const watchers: ReturnType<typeof installWatcher>[] = [];
function buildRegistry(): Registry {
  const r = new Registry();
  for (const t of [...reminderTools, ...noteTools, ...projectTools, ...memoryTools, ...weatherTools, ...researchTools, ...perplexityTools, ...boardTools, ...ledgerTools, ...designTools]) r.register(t);
  // The Factory's own tools, plus every approved spawned agent as a
  // dispatch_to_<slug> tool — loaded now, refreshed live by the watcher.
  for (const t of factoryTools(r)) r.register(t);
  watchers.push(installWatcher(r));
  return r;
}
const refreshWatchers = () => watchers.forEach((w) => w.refresh());
// Hot reload across processes: an approval from the terminal REPL lands in
// data/factory/agents.json; this server notices within 30s and registers
// (or withdraws) the dispatch tool without a restart. Cheap: one file read.
setInterval(refreshWatchers, 30_000).unref();

function factoryPending(): FactoryPending[] {
  return pendingApproval().map((t) => ({
    taskId: t.id,
    name: t.proposedManifest!.name,
    slug: t.proposedManifest!.slug,
    specialty: t.proposedManifest!.specialty,
    systemPrompt: t.proposedManifest!.system_prompt,
    tools: t.proposedManifest!.tool_allowlist,
    model: t.proposedManifest!.model,
    round: t.approvalIterations + 1,
    specPath: `agent-specs/${t.proposedManifest!.slug}.md`,
  }));
}

// ---------------------------------------------------------------- broadcast
const clients = new Set<WebSocket>();
// Whoever last picked up the mic owns the audio for that turn.
let activeClient: WebSocket | null = null;

function send(msg: ServerMsg): void {
  const json = JSON.stringify(msg);
  // Spoken audio goes ONLY to the client that asked — every other open tab is
  // a read-only mirror (transcript, panel, notices). Broadcasting audio makes
  // two tabs play her reply in unison, which sounds like a stutter/echo.
  if (msg.type === "speak_segment") {
    if (activeClient && activeClient.readyState === WebSocket.OPEN) activeClient.send(json);
    return;
  }
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(json);
}

// ---------------------------------------------------------------- the gate
// Same semantics as the terminal gate: ask, wait max 60s, silence = No.
const pendingConfirms = new Map<string, (ok: boolean) => void>();
const registry = buildRegistry();
registry.confirm = (_tool, intent) =>
  new Promise<boolean>((resolve) => {
    const id = crypto.randomBytes(3).toString("hex");
    const timer = setTimeout(() => {
      pendingConfirms.delete(id);
      send({ type: "confirm_resolved", id });
      resolve(false);
    }, 60_000);
    pendingConfirms.set(id, (ok) => {
      clearTimeout(timer);
      pendingConfirms.delete(id);
      send({ type: "confirm_resolved", id });
      resolve(ok);
    });
    send({ type: "confirm_request", id, intent });
  });

const turns = new FaceTurns(registry, send);

async function snapshot(): Promise<Snapshot> {
  return {
    sandboxed: STATE_ROOT !== ROOT,
    paused: loadConfig().heartbeat.paused,
    state: turns.state,
    notices: listNotices(),
    reminders: loadReminders().filter((r) => !r.done),
    facts: memoriesAsFacts(),
    usage: await usageToday(),
    agents: agentRoster(),
    factoryPending: factoryPending(),
  };
}

// ---------------------------------------------------------------- http
const MIME: Record<string, string> = {
  ...PREVIEW_MIME,
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const MIND_DIR = path.join(ROOT, "mind");

// The head-of-design agent's mockups. resolveProjectRoot throws on an unknown
// slug, but the preview route wants a null so it can answer with a plain 404.
const resolveRoot = (slug: string): string | null => {
  try {
    return resolveProjectRoot(slug).root;
  } catch {
    return null;
  }
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;

  // ---- design previews ----------------------------------------------
  if (handlePreviewRequest(req, res, { resolveRoot, pathname })) return;

  // ---- the mind map -------------------------------------------------
  if (pathname === "/api/mind-map") {
    void (async () => {
      try {
        const skeleton = await buildSkeleton({
          memories: listMemories(),
          conversations: loadConversations(),
          reminders: loadReminders(),
          tools: registry.all(),
          agentName: "EVE",
          model: loadConfig().model,
        });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(skeleton));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    })();
    return;
  }

  if (pathname.startsWith("/api/mind-map/node/")) {
    const id = decodeURIComponent(pathname.slice("/api/mind-map/node/".length));
    void (async () => {
      try {
        const detail = await nodeDetail(id);
        if (!detail) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown node" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(detail));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    })();
    return;
  }

  if (pathname === "/mind" || pathname.startsWith("/mind/")) {
    const rel = pathname === "/mind" || pathname === "/mind/" ? "index.html" : pathname.slice(6);
    const file = path.resolve(MIND_DIR, rel);
    if (!file.startsWith(MIND_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store, must-revalidate",
    });
    res.end(fs.readFileSync(file));
    return;
  }

  if (pathname.startsWith("/tts/")) {
    const bytes = turns.getSegment(pathname.slice("/tts/".length));
    if (!bytes) {
      res.writeHead(404).end("segment expired");
      return;
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": bytes.length });
    res.end(bytes);
    return;
  }

  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(FACE_DIR, rel);
  if (!file.startsWith(FACE_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  // Never cache the face's own assets. A browser holding a stale shell.js
  // against a fresh audio.js is a silent, baffling breakage — and these are
  // small local files, so there is nothing to gain by caching them.
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-store, must-revalidate",
  });
  res.end(fs.readFileSync(file));
});

// ---------------------------------------------------------------- websocket
// Two socket servers share one HTTP server, so BOTH must use noServer and the
// upgrade is routed by hand below. Attaching both with { server } makes the
// non-matching one destroy the socket — which silently killed the voice
// pipeline the first time this was wired up.
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  clients.add(ws);
  void snapshot().then((s) => ws.send(JSON.stringify({ type: "snapshot", snapshot: s })));

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      turns.onAudio(data as Buffer);
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch {
      return;
    }
    switch (msg.type) {
      case "mic":
        if (msg.on) {
          activeClient = ws; // this tab asked, so this tab hears the answer
          turns.micOn();
          warmTts();
        } else void turns.micOff();
        break;
      case "interrupt":
        turns.interrupt();
        break;
      case "confirm_response":
        pendingConfirms.get(msg.id)?.(msg.ok);
        break;
      case "dismiss":
        dismissNotice(msg.noticeId);
        void snapshot().then((s) => send({ type: "snapshot", snapshot: s }));
        break;
      case "set_paused":
        setHeartbeatPaused(msg.paused);
        audit("kill_switch", { paused: msg.paused, via: "face" });
        void snapshot().then((s) => send({ type: "snapshot", snapshot: s }));
        break;
      case "refresh":
        void snapshot().then((s) => ws.send(JSON.stringify({ type: "snapshot", snapshot: s })));
        break;
      // ---- the Factory's approval gate. Every tab gets a fresh snapshot
      // afterwards so the resolved card disappears everywhere at once.
      case "factory_approve":
        try {
          const a = approveTask(msg.taskId, { onAgentAdded: refreshWatchers });
          audit("factory_task", { id: msg.taskId, event: "approved_via", via: "face", slug: a.slug });
        } catch (err) {
          send({ type: "turn_error", message: `approve: ${err instanceof Error ? err.message : String(err)}` });
        }
        void snapshot().then((s) => send({ type: "snapshot", snapshot: s }));
        break;
      case "factory_reject":
        void rejectTask(msg.taskId, msg.feedback, registry)
          .catch((err) => send({ type: "turn_error", message: `reject: ${err instanceof Error ? err.message : String(err)}` }))
          .then(() => snapshot())
          .then((s) => s && send({ type: "snapshot", snapshot: s }));
        break;
    }
  });
  ws.on("close", () => {
    clients.delete(ws);
    if (activeClient === ws) activeClient = null;
    // Last tab gone = the session is over as far as Umberto is concerned:
    // run the memory extractor on what was said. Guarded inside against
    // re-runs on unchanged conversations, so tab-hopping costs nothing.
    if (clients.size === 0) {
      void extractConversation(getConversation(turns.conversationId));
    }
  });
});

// ---------------------------------------------------------------- observers
// A strictly read-only spectator stream for the mind map, on its OWN path and
// its OWN socket set. It must never be able to slow a real turn down: every
// send is timeout-guarded and dead sockets are pruned, and nothing here ever
// touches the voice socket or its state.
const observers = new Set<WebSocket>();
const observerWss = new WebSocketServer({ noServer: true });

// The single upgrade router. The voice socket keeps every path that isn't the
// observer one, so face/shell.js (which connects to the root) is untouched.
//
// Both sockets are same-origin only, checked here before the handshake. This
// is the whole authentication story: browsers attach Origin to a WebSocket
// handshake and cannot forge it, but they place NO same-origin restriction on
// opening one — so without this, any page Umberto happened to visit could
// connect to her (localhost is reachable from any tab; so is the tailnet name
// once she lives there), read the snapshot her memories are in, and answer
// the confirmation gate on his behalf. A missing Origin is a non-browser
// client — the headless check scripts — and is allowed through.
server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (origin && !sameOrigin(origin, req.headers.host, req.headers["x-forwarded-host"])) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  const target = pathname === "/ws/observe" ? observerWss : wss;
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

observerWss.on("connection", (ws) => {
  observers.add(ws);
  ws.on("close", () => observers.delete(ws));
  ws.on("error", () => observers.delete(ws));
  ws.on("message", () => {
    /* read-only: anything a spectator sends is ignored */
  });
});

export function emitMindEvent(event: Record<string, unknown>): void {
  if (observers.size === 0) return;
  const json = JSON.stringify(event);
  for (const ws of [...observers]) {
    if (ws.readyState !== WebSocket.OPEN) {
      observers.delete(ws);
      continue;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      // A half-open socket (sleeping tab) must never hold anything up.
      observers.delete(ws);
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }, 1000);
    try {
      ws.send(json, () => {
        settled = true;
        clearTimeout(timer);
      });
    } catch {
      settled = true;
      clearTimeout(timer);
      observers.delete(ws);
    }
  }
}

// Translate EVE's own audit trail into mind-map events. Only real activity —
// nothing synthesised to keep the map busy.
function toMindEvent(event: string, detail: Record<string, unknown>): void {
  if (event === "tool_ran") {
    const name = String(detail.tool ?? "");
    emitMindEvent({ type: "tool", name });
    if (name === "remember_fact") emitMindEvent({ type: "write" });
    if (name === "list_reminders" || name === "search_notes") emitMindEvent({ type: "recall" });
  } else if (event === "model_turn") {
    emitMindEvent({ type: "turn" });
  } else if (event === "notice") {
    emitMindEvent({ type: "alert" });
  }
}

// Turns happening inside THIS process (face voice) arrive directly…
onAuditEvent(toMindEvent);

// …but `npm run eve` and `npm run voice` are separate processes, so their
// events would never reach an observer. The audit log is the one thing every
// process writes to, so tail it: the map then reflects everything EVE does,
// wherever it happened.
const AUDIT_LOG = path.join(STATE_ROOT, "logs", "audit.jsonl");
let auditOffset = fs.existsSync(AUDIT_LOG) ? fs.statSync(AUDIT_LOG).size : 0;

function drainAuditLog(): void {
  try {
    if (!fs.existsSync(AUDIT_LOG)) return;
    const size = fs.statSync(AUDIT_LOG).size;
    if (size < auditOffset) auditOffset = 0; // log was rotated or truncated
    if (size === auditOffset) return;
    const fd = fs.openSync(AUDIT_LOG, "r");
    const buf = Buffer.alloc(size - auditOffset);
    fs.readSync(fd, buf, 0, buf.length, auditOffset);
    fs.closeSync(fd);
    auditOffset = size;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { event?: string } & Record<string, unknown>;
        // Only forward if nobody is watching's cheap check already passed.
        if (e.event && e.source !== "face") toMindEvent(e.event, e);
      } catch {
        // partial line mid-write; the next drain picks it up
      }
    }
  } catch {
    // the map going quiet must never disturb EVE
  }
}

setInterval(drainAuditLog, 700).unref();

// ---------------------------------------------------------------- heartbeat
// Its own confirm-less registry: background actions auto-deny + leave a note.
const heartbeat = new Heartbeat(buildRegistry(), (n) => {
  send({ type: "notice", notice: n });
});
heartbeat.start();

// ---------------------------------------------------------------- design
// Background design dispatches narrate themselves to every open tab, and
// their completion notice is pushed the moment it lands (not on next snapshot).
onDesignEvent((event) => send({ type: "design_event", event }));
// Sub-agent activity → the constellation (board seats, researcher, head of design).
onAgentEvent((e) =>
  send({
    type: "agent_event",
    agent: e.agent,
    phase: e.phase,
    ...(e.label ? { label: e.label } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
    ...(e.descriptor ? { descriptor: e.descriptor } : {}),
  }),
);
setDesignNoticeSink((n) => send({ type: "notice", notice: n }));

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`EVE's face is at ${url}  (Ctrl+C to close)`);
  if (!process.argv.includes("--no-open")) spawn("open", [url], { stdio: "ignore" });
  // Settle memory debt from sessions that ended without a clean close.
  void catchUpExtractions().then((n) => {
    if (n > 0) console.log(`[memory] extractor caught up: ${n} memorie(s) kept`);
  });
});
