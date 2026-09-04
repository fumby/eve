// The composer: EVE's head-of-design runs Claude Code headlessly (Agent SDK)
// to write the mockup pages inside a project's .prism/preview app. This file
// owns exactly four things and nothing else:
//
//   1. the sanitized, reproducible query() options — preset Claude Code system
//      prompt, SDK isolation mode (no ~/.claude or project settings leak in),
//      an env ALLOWLIST (the SDK's `env` replaces the child env, so this is the
//      boundary that keeps DEEPGRAM/ELEVENLABS/SUPABASE keys out of the child),
//      and a permission handler that denies anything not pre-approved;
//   2. a redacted copy of those options logged per dispatch under
//      logs/design/<dispatchId>.options.json, so any run can be replayed;
//   3. translating the SDK's message stream into DesignEvents EVE can relay;
//   4. process hygiene: aborting mid-run must leave no orphaned node/npm/
//      claude processes, so a process-tree sweeper runs on every exit path.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  query as sdkQuery,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ROOT, STATE_ROOT } from "../core/config.js";
import { audit } from "../core/audit.js";
import { writeFileAtomic } from "../core/atomic.js";
import type { ComposerRequest, ComposerResult, DesignEvent } from "./types.js";

const execFileAsync = promisify(execFile);

// ── tool boundary ───────────────────────────────────────────────────────────
// Everything Claude Code needs to build a Next.js + shadcn page and nothing
// that reaches outside the project: no subagents, no web, no notebooks, no
// background-task control. Bash is opened only for the exact commands the
// preview app needs; anything else (rm, curl, git …) lands in canUseTool and
// is denied with a message the model can read.
export const COMPOSER_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash(npm install:*)",
  "Bash(npm run:*)",
  "Bash(npx shadcn:*)",
  "Bash(npx shadcn@latest:*)",
  "Bash(npx magicui-cli:*)",
  "Bash(next build:*)",
  "Bash(ls:*)",
  "Bash(mkdir:*)",
  "Bash(cat:*)",
];

// The SDK's sdk-tools.d.ts names the subagent tool "Agent" (Task is its older
// alias) and the background-task killer "TaskStop" (formerly KillShell). Both
// spellings are listed so the block holds across CLI versions.
export const COMPOSER_DISALLOWED_TOOLS = [
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "KillShell",
  "TaskStop",
  "TodoWrite",
];

// ── env allowlist ───────────────────────────────────────────────────────────
// Only what the Claude Code child needs to authenticate and find its own
// binaries. Nothing else from EVE's process env crosses this line.
const ENV_ALLOWLIST = ["ANTHROPIC_API_KEY", "HOME", "PATH", "USER", "LANG", "TMPDIR"] as const;
export const COMPOSER_CLIENT_APP = "eve-design/1.0";

export function composerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  out.CLAUDE_AGENT_SDK_CLIENT_APP = COMPOSER_CLIENT_APP;
  return out;
}

// ── options ─────────────────────────────────────────────────────────────────
export interface BuildOptionsDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  // Called for every tool call the permission handler denies.
  onDeny?: (tool: string, input: Record<string, unknown>) => void;
  // TEST-ONLY. scripts/design-composer-check.ts widens Bash to "sleep" so it
  // can prove the abort path kills a long-running child. Production callers
  // never set this; the allowlist above is the boundary.
  allowedToolsOverride?: string[];
}

function isoAt(now: () => number): string {
  return new Date(now()).toISOString();
}

// A short, human label for a tool call: the file it touches (relative to the
// project when possible, else the basename), or the command's first 80 chars.
export function toolLabel(input: unknown, projectRoot?: string): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const fp = rec.file_path ?? rec.path ?? rec.notebook_path;
  if (typeof fp === "string" && fp) {
    if (projectRoot) {
      const rel = path.relative(projectRoot, fp);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
    }
    return path.isAbsolute(fp) ? path.basename(fp) : fp;
  }
  if (typeof rec.command === "string") {
    const oneLine = rec.command.replace(/\s+/g, " ").trim();
    return oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
  }
  if (typeof rec.pattern === "string") return rec.pattern;
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v) return v.length > 80 ? v.slice(0, 80) + "…" : v;
  }
  return "";
}

export function buildQueryOptions(req: ComposerRequest, deps: BuildOptionsDeps = {}): Options {
  const now = deps.now ?? Date.now;
  const allowedTools = deps.allowedToolsOverride ?? [...COMPOSER_ALLOWED_TOOLS];

  // Fresh controller per run, so runComposer can pull the plug on this query
  // alone. If the caller handed us a signal, it is wired through — the SDK
  // only listens to its own controller.
  const abortController = new AbortController();
  if (req.signal) {
    if (req.signal.aborted) abortController.abort(req.signal.reason);
    else req.signal.addEventListener("abort", () => abortController.abort(req.signal?.reason), { once: true });
  }

  const emit = (kind: DesignEvent["kind"], text: string, detail?: Record<string, unknown>): void => {
    const event: DesignEvent = { at: isoAt(now), dispatchId: req.dispatchId, kind, text };
    if (detail) event.detail = detail;
    try {
      req.onEvent(event);
    } catch {
      // a listener must never break the run it is watching
    }
  };

  // With allowedTools set, the CLI auto-allows those and routes everything
  // else here. There is no human at this prompt, so the only answer is a
  // clear "no" the model can act on. (The SDK emits a one-time
  // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning because Read/Write/… bypass this
  // callback — that is exactly the intended split.)
  const canUseTool = async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    const label = toolLabel(input, req.projectRoot);
    emit("warn", `denied: ${toolName} ${label}`.trim(), { tool: toolName, input });
    deps.onDeny?.(toolName, input);
    return {
      behavior: "deny",
      message:
        `EVE's design composer does not allow "${toolName}${label ? " " + label : ""}". ` +
        `Only these tools are available: ${allowedTools.join(", ")}. ` +
        `Stay inside the project directory and use an allowed command, or skip this step and explain why.`,
    };
  };

  // Claude Code's stderr is diagnostics, not results — surface it as warnings
  // so a failing run explains itself in the event log.
  const stderr = (data: string): void => {
    for (const raw of data.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      emit("warn", line.length > 300 ? line.slice(0, 300) + "…" : line);
    }
  };

  return {
    cwd: req.projectRoot,
    model: req.model,
    maxTurns: req.maxTurns,
    maxBudgetUsd: req.maxBudgetUsd,
    permissionMode: "default",
    allowedTools,
    disallowedTools: [...COMPOSER_DISALLOWED_TOOLS],
    canUseTool,
    // Always Claude Code's own system prompt: it is what makes the child
    // behave like Claude Code (file discipline, tool etiquette).
    systemPrompt: { type: "preset", preset: "claude_code" },
    // SDK isolation mode: no ~/.claude/settings.json, no project settings, no
    // CLAUDE.md. What the child knows is exactly what we hand it.
    settingSources: [],
    // Project .mcp.json is not a "setting", so isolate MCP explicitly too.
    strictMcpConfig: true,
    env: composerEnv(deps.env),
    persistSession: false,
    includePartialMessages: false,
    abortController,
    stderr,
  };
}

// ── redaction for the per-dispatch options log ─────────────────────────────
const SECRET_KEY_RE = /KEY|TOKEN|SECRET|URL/i;

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
  if (typeof value === "string") return SECRET_KEY_RE.test(key) ? "<redacted>" : value;
  if (typeof value !== "object") return value; // number | boolean | bigint | symbol
  if (depth > 6) return "[nested]";
  if (Array.isArray(value)) return value.map((v) => redactValue("", v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  const plain = proto === Object.prototype || proto === null;
  if (!plain) {
    // AbortController, streams, Maps … — the constructor name is enough to
    // reproduce the shape, and never leaks what's inside.
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "Object";
    return `[${name}]`;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const r = redactValue(k, v, depth + 1);
    if (r !== undefined) out[k] = r;
  }
  return out;
}

export function redactOptionsForLog(options: unknown): Record<string, unknown> {
  const r = redactValue("options", options, 0);
  return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r };
}

// ── SDK messages → DesignEvents ────────────────────────────────────────────
function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// tool_result content is a string or a list of content blocks; we only want
// the words.
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function toDesignEvents(msg: SDKMessage, dispatchId: string, projectRoot?: string): DesignEvent[] {
  const at = new Date().toISOString();
  const ev = (kind: DesignEvent["kind"], text: string, detail?: Record<string, unknown>): DesignEvent =>
    detail ? { at, dispatchId, kind, text, detail } : { at, dispatchId, kind, text };

  switch (msg.type) {
    case "system": {
      if (msg.subtype !== "init") return [];
      const tools = Array.isArray(msg.tools) ? msg.tools : [];
      return [
        ev("info", `Claude Code ${msg.claude_code_version} · model ${msg.model} · ${tools.length} tools`, {
          version: msg.claude_code_version,
          model: msg.model,
          tools,
          cwd: msg.cwd,
          permissionMode: msg.permissionMode,
          sessionId: msg.session_id,
        }),
      ];
    }
    case "assistant": {
      const out: DesignEvent[] = [];
      const content = (msg.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return out;
      for (const block of content as Array<Record<string, unknown>>) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "tool";
          const label = toolLabel(block.input, projectRoot);
          out.push(ev("cc_tool", `${name} ${label}`.trim(), { tool: name, input: block.input, id: block.id }));
        } else if (block.type === "text" && typeof block.text === "string") {
          const text = clip(block.text, 200);
          if (text) out.push(ev("cc_text", text));
        }
      }
      return out;
    }
    case "user": {
      const out: DesignEvent[] = [];
      const content = (msg.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return out;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block && typeof block === "object" && block.type === "tool_result" && block.is_error === true) {
          out.push(ev("warn", `tool error: ${clip(blockText(block.content), 200)}`, { toolUseId: block.tool_use_id }));
        }
      }
      return out;
    }
    case "result": {
      const cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
      return [
        ev("cc_result", `done: ${msg.subtype} · $${cost.toFixed(4)} · ${msg.num_turns} turns`, {
          costUsd: cost,
          turns: msg.num_turns,
          durationMs: msg.duration_ms,
          subtype: msg.subtype,
        }),
      ];
    }
    default:
      return [];
  }
}

// ── running it ──────────────────────────────────────────────────────────────
// Structurally satisfied by the SDK's query(); tests inject an async
// generator instead. close() is the SDK's hard stop (sync).
export type ComposerQueryFn = (params: {
  prompt: string;
  options?: Options;
}) => AsyncGenerator<SDKMessage, void> & { close?: () => void };

export interface RunComposerDeps {
  query?: ComposerQueryFn;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  // Where <dispatchId>.options.json goes. Default ROOT/logs/design.
  logDir?: string;
  // TEST-ONLY — see BuildOptionsDeps.allowedToolsOverride.
  allowedToolsOverride?: string[];
}

const DEFAULT_LOG_DIR = path.join(STATE_ROOT, "logs", "design");
// After the result message the CLI is meant to exit on its own; if it
// lingers (a stuck MCP teardown, say) we stop waiting and close it.
const POST_RESULT_LINGER_MS = 10_000;

function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_") || "dispatch";
}

// One dispatch can run the composer more than once (a repair pass after the
// TSX audit); every run keeps its own log rather than overwriting the first.
function nextLogPath(logDir: string, base: string): string {
  const first = path.join(logDir, `${base}.options.json`);
  if (!fs.existsSync(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = path.join(logDir, `${base}.${n}.options.json`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runComposer(req: ComposerRequest, deps: RunComposerDeps = {}): Promise<ComposerResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const logDir = deps.logDir ?? DEFAULT_LOG_DIR;
  const denials: Array<{ tool: string; input?: unknown }> = [];
  const optionDeps: BuildOptionsDeps = {
    now,
    onDeny: (tool, input) => denials.push({ tool, input }),
  };
  if (deps.env) optionDeps.env = deps.env;
  if (deps.allowedToolsOverride) optionDeps.allowedToolsOverride = deps.allowedToolsOverride;
  const options = buildQueryOptions(req, optionDeps);
  const ac = options.abortController as AbortController;

  // 1. Log first, run second: if the run explodes we still know exactly what
  //    was asked of Claude Code.
  fs.mkdirSync(logDir, { recursive: true });
  const optionsLogPath = nextLogPath(logDir, safeFileName(req.dispatchId));
  writeFileAtomic(
    optionsLogPath,
    JSON.stringify(
      {
        dispatchId: req.dispatchId,
        at: new Date(started).toISOString(),
        prompt: req.prompt,
        options: redactOptionsForLog(options),
      },
      null,
      2,
    ) + "\n",
  );

  const emit = (event: DesignEvent): void => {
    try {
      req.onEvent(event);
    } catch {
      // never let a listener break the run
    }
  };
  const warn = (text: string): void =>
    emit({ at: new Date(now()).toISOString(), dispatchId: req.dispatchId, kind: "warn", text });

  const result: ComposerResult = {
    ok: false,
    subtype: "spawn_failed",
    costUsd: 0,
    turns: 0,
    durationMs: 0,
    sessionId: null,
    resultText: "",
    permissionDenials: [],
    errors: [],
    optionsLogPath,
  };

  // Processes alive before we start are somebody else's (another dispatch,
  // the face server …); the sweeper must leave them alone.
  const spare = (await listDescendants(process.pid)).map((p) => p.pid);
  const sweep = () => sweepOrphans(process.pid, { spare });

  let q: ReturnType<ComposerQueryFn> | null = null;
  let resultMsg: SDKResultMessage | null = null;
  try {
    if (ac.signal.aborted) {
      result.subtype = "aborted";
      result.errors.push("aborted before Claude Code was started");
      return result;
    }

    const runQuery = deps.query ?? (sdkQuery as ComposerQueryFn);
    q = runQuery({ prompt: req.prompt, options });

    // The abort must win even if the generator is mid-await, so every next()
    // is raced against it. The dangling next() is given a no-op catch — its
    // eventual rejection is the SDK's AbortError, which we already know about.
    const aborted = new Promise<never>((_, reject) => {
      const bail = () => reject(new Error("aborted"));
      if (ac.signal.aborted) bail();
      else ac.signal.addEventListener("abort", bail, { once: true });
    });
    aborted.catch(() => {});

    for (;;) {
      const nextP = q.next();
      nextP.catch(() => {});
      const racers: Array<Promise<IteratorResult<SDKMessage, void>>> = [nextP, aborted];
      if (resultMsg) {
        racers.push(
          new Promise((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), POST_RESULT_LINGER_MS).unref(),
          ),
        );
      }
      const step = await Promise.race(racers);
      if (step.done) break;
      const msg = step.value;
      for (const event of toDesignEvents(msg, req.dispatchId, req.projectRoot)) emit(event);
      if (msg.type === "result") resultMsg = msg;
    }
    if (!resultMsg && !ac.signal.aborted) {
      // The stream ended without a verdict — the CLI died quietly.
      result.errors.push("Claude Code ended without a result message");
    }
  } catch (err) {
    if (ac.signal.aborted) {
      // expected: the SDK throws its AbortError once we pull the plug
    } else if (resultMsg) {
      // The CLI exited non-zero after an error result — the result message is
      // still the authoritative account; keep the exception as a footnote.
      result.errors.push(errText(err));
    } else {
      result.subtype = "spawn_failed";
      result.errors.push(errText(err));
      warn(`Claude Code failed to run: ${errText(err)}`);
    }
  } finally {
    if (resultMsg) {
      result.subtype = resultMsg.subtype;
      result.ok = resultMsg.subtype === "success";
      result.costUsd = resultMsg.total_cost_usd ?? 0;
      result.turns = resultMsg.num_turns ?? 0;
      result.sessionId = resultMsg.session_id ?? null;
      result.resultText = resultMsg.subtype === "success" ? resultMsg.result : "";
      if (resultMsg.subtype !== "success") result.errors.push(...(resultMsg.errors ?? []));
    } else if (ac.signal.aborted) {
      result.subtype = "aborted";
    }
    // The SDK's own list is authoritative when it exists; otherwise what our
    // handler saw is the best record we have.
    const fromSdk = (resultMsg?.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: d.tool_input }));
    result.permissionDenials = fromSdk.length ? fromSdk : denials;

    if (ac.signal.aborted) {
      // Pull the plug in the SDK's own way first, then make sure nothing it
      // spawned outlives it.
      try {
        q?.close?.();
      } catch {
        /* already closed */
      }
      const swept = await sweep();
      warn(`aborted: Claude Code stopped${swept.length ? ` · ${swept.length} process(es) swept` : ""}`);
    }
    result.durationMs = Math.max(0, now() - started);
    // Always: no run of any outcome leaves children behind, and every run
    // shows up in the audit trail with what it cost.
    await sweep();
    audit("design_composer", {
      dispatchId: req.dispatchId,
      subtype: result.subtype,
      costUsd: result.costUsd,
      turns: result.turns,
      durationMs: result.durationMs,
      ok: result.ok,
    });
  }
  return result;
}

// ── process hygiene ─────────────────────────────────────────────────────────
export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}

// `ps -eo pid=,ppid=,command=` works the same on macOS and Linux (BSD and
// procps both accept the = form for header-less columns).
async function listAllProcesses(): Promise<ProcInfo[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 });
  const out: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: (m[3] ?? "").trim() });
  }
  return out;
}

// Every process under rootPid (children, grandchildren …), breadth-first so a
// parent always precedes its children.
export async function listDescendants(rootPid: number = process.pid): Promise<ProcInfo[]> {
  const all = await listAllProcesses();
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of all) {
    const list = byParent.get(p.ppid);
    if (list) list.push(p);
    else byParent.set(p.ppid, [p]);
  }
  const out: ProcInfo[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift() as number;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

// What a Claude Code run can leave behind: the native `claude` binary, node/
// npm/npx (installs, next build), shells from the Bash tool. Children of a
// matched process are swept with it (sh -c "sleep 40" takes sleep along), so
// the pattern names the roots of the trees to fell, not every leaf.
export const ORPHAN_MATCH = /(^|\/)(node|npm|npx|next|sh|bash|zsh|claude)\b/;

export interface SweepOptions {
  // ms between SIGTERM and SIGKILL. Default 800.
  grace?: number;
  match?: RegExp;
  // pids to leave alone (e.g. everything that was already running before a
  // dispatch started).
  spare?: number[];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; treat as alive so we report honestly.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false; // already gone, or not ours
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// SIGTERM, then SIGKILL whatever survives the grace period. Never throws —
// this runs in finally blocks and must not mask the real outcome.
export async function sweepOrphans(rootPid: number = process.pid, opts: SweepOptions = {}): Promise<number[]> {
  const killed: number[] = [];
  try {
    const grace = opts.grace ?? 800;
    const match = opts.match ?? ORPHAN_MATCH;
    const spare = new Set(opts.spare ?? []);
    const descendants = await listDescendants(rootPid);
    const doomed = new Set<number>();
    for (const p of descendants) {
      // BFS order guarantees the parent was classified before its children.
      if (p.pid === process.pid || spare.has(p.pid)) continue;
      if (doomed.has(p.ppid) || match.test(p.command)) doomed.add(p.pid);
    }
    if (doomed.size === 0) return killed;

    for (const pid of doomed) if (signal(pid, "SIGTERM")) killed.push(pid);

    // Poll rather than sleep the whole grace: a clean exit returns fast.
    const deadline = Date.now() + grace;
    let survivors = [...doomed].filter(alive);
    while (survivors.length && Date.now() < deadline) {
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      survivors = survivors.filter(alive);
    }
    for (const pid of survivors) {
      if (signal(pid, "SIGKILL") && !killed.includes(pid)) killed.push(pid);
    }
  } catch {
    // ps missing or unreadable — nothing sensible to do; report what we did.
  }
  return killed;
}
