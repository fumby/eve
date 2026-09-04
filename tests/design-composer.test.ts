// The composer's contract, without the network or a Claude Code spawn: the
// options are exactly the sanitized shape the user demanded (preset prompt,
// isolation mode, env allowlist), the redacted log leaks nothing, SDK
// messages become the right DesignEvents, runComposer behaves on success /
// spawn failure / abort with a fake query, and the sweeper really kills a
// real child process.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  COMPOSER_ALLOWED_TOOLS,
  COMPOSER_DISALLOWED_TOOLS,
  buildQueryOptions,
  composerEnv,
  listDescendants,
  redactOptionsForLog,
  runComposer,
  sweepOrphans,
  toDesignEvents,
  toolLabel,
  type ComposerQueryFn,
} from "../src/design/composer.js";
import type { ComposerRequest, DesignEvent } from "../src/design/types.js";

const FAKE_ENV: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test-123",
  HOME: "/Users/test",
  PATH: "/usr/bin:/bin",
  USER: "test",
  LANG: "en_US.UTF-8",
  TMPDIR: "/tmp",
  DEEPGRAM_API_KEY: "dg-secret",
  ELEVENLABS_API_KEY: "el-secret",
  SUPABASE_LEDGER_URL: "postgres://x:y@z/db",
  SHELL: "/bin/zsh",
};

function makeReq(over: Partial<ComposerRequest> = {}): { req: ComposerRequest; events: DesignEvent[] } {
  const events: DesignEvent[] = [];
  const req: ComposerRequest = {
    dispatchId: "d-test-1",
    projectRoot: "/tmp/proj",
    prompt: "do the thing",
    model: "claude-sonnet-4-5",
    maxTurns: 7,
    maxBudgetUsd: 1.25,
    onEvent: (e) => events.push(e),
    ...over,
  };
  return { req, events };
}

// ── hand-built SDK messages ────────────────────────────────────────────────
const SID = "11111111-2222-3333-4444-555555555555";
const initMsg = {
  type: "system",
  subtype: "init",
  apiKeySource: "user",
  claude_code_version: "2.1.233",
  cwd: "/tmp/proj",
  tools: ["Read", "Write", "Edit", "Bash"],
  mcp_servers: [],
  model: "claude-sonnet-4-5",
  permissionMode: "default",
  slash_commands: [],
  output_style: "default",
  skills: [],
  plugins: [],
  uuid: SID,
  session_id: SID,
} as unknown as SDKMessage;

const assistantToolsMsg = {
  type: "assistant",
  parent_tool_use_id: null,
  uuid: SID,
  session_id: SID,
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [
      { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/tmp/proj/design.md" } },
      { type: "tool_use", id: "tu_2", name: "Write", input: { file_path: "/tmp/proj/.prism/preview/app/landing/hero/page.tsx", content: "x" } },
      { type: "tool_use", id: "tu_3", name: "Bash", input: { command: "npm run build" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
} as unknown as SDKMessage;

const assistantTextMsg = {
  type: "assistant",
  parent_tool_use_id: null,
  uuid: SID,
  session_id: SID,
  message: {
    id: "msg_2",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [
      { type: "text", text: "   " },
      { type: "text", text: "  I'll start by reading the design system.  " },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
} as unknown as SDKMessage;

const toolErrorMsg = {
  type: "user",
  parent_tool_use_id: null,
  uuid: SID,
  session_id: SID,
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tu_3", is_error: true, content: "npm ERR! missing script: build" },
      { type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "fine" },
    ],
  },
} as unknown as SDKMessage;

const resultSuccess = {
  type: "result",
  subtype: "success",
  duration_ms: 4321,
  duration_api_ms: 4000,
  is_error: false,
  num_turns: 3,
  result: "Wrote the hero page.",
  stop_reason: "end_turn",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: {},
  permission_denials: [],
  uuid: SID,
  session_id: SID,
} as unknown as SDKMessage;

const resultBudget = {
  type: "result",
  subtype: "error_max_budget_usd",
  duration_ms: 9000,
  duration_api_ms: 8000,
  is_error: true,
  num_turns: 6,
  stop_reason: null,
  total_cost_usd: 0.51,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: {},
  permission_denials: [{ tool_name: "Bash", tool_use_id: "tu_9", tool_input: { command: "rm -rf /" } }],
  errors: ["budget of $0.50 exceeded"],
  uuid: SID,
  session_id: SID,
} as unknown as SDKMessage;

// ── composerEnv ────────────────────────────────────────────────────────────
test("composerEnv: exactly the allowlist plus the client app tag — no DEEPGRAM/ELEVENLABS/SUPABASE", () => {
  const env = composerEnv(FAKE_ENV);
  assert.deepEqual(Object.keys(env).sort(), [
    "ANTHROPIC_API_KEY",
    "CLAUDE_AGENT_SDK_CLIENT_APP",
    "HOME",
    "LANG",
    "PATH",
    "TMPDIR",
    "USER",
  ]);
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, "eve-design/1.0");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test-123");
  assert.equal("DEEPGRAM_API_KEY" in env, false);
  assert.equal("SUPABASE_LEDGER_URL" in env, false);
  assert.equal("SHELL" in env, false);
});

test("composerEnv: missing allowlisted keys are simply absent (no undefined values)", () => {
  const env = composerEnv({ HOME: "/h" });
  assert.deepEqual(env, { HOME: "/h", CLAUDE_AGENT_SDK_CLIENT_APP: "eve-design/1.0" });
});

// ── buildQueryOptions ──────────────────────────────────────────────────────
test("buildQueryOptions: preset system prompt, isolation mode, allowlisted env, tool boundary, limits", () => {
  const { req } = makeReq();
  const o = buildQueryOptions(req, { env: FAKE_ENV });
  assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.deepEqual(o.settingSources, []);
  assert.deepEqual(Object.keys(o.env ?? {}).sort(), [
    "ANTHROPIC_API_KEY",
    "CLAUDE_AGENT_SDK_CLIENT_APP",
    "HOME",
    "LANG",
    "PATH",
    "TMPDIR",
    "USER",
  ]);
  assert.equal((o.env ?? {}).DEEPGRAM_API_KEY, undefined);
  assert.deepEqual(o.allowedTools, COMPOSER_ALLOWED_TOOLS);
  assert.deepEqual(o.disallowedTools, COMPOSER_DISALLOWED_TOOLS);
  assert.equal(o.permissionMode, "default");
  assert.equal(o.maxBudgetUsd, 1.25);
  assert.equal(o.maxTurns, 7);
  assert.equal(o.cwd, "/tmp/proj");
  assert.equal(o.model, "claude-sonnet-4-5");
  assert.equal(o.persistSession, false);
  assert.equal(o.includePartialMessages, false);
  assert.equal(o.strictMcpConfig, true);
  assert.ok(o.abortController instanceof AbortController);
  assert.equal(typeof o.canUseTool, "function");
  assert.equal(typeof o.stderr, "function");
});

test("buildQueryOptions: allowed tools contain the shadcn/npm essentials and no web/subagent tools", () => {
  for (const t of ["Read", "Write", "Edit", "Glob", "Grep", "Bash(npm install:*)", "Bash(npx shadcn@latest:*)", "Bash(next build:*)"]) {
    assert.ok(COMPOSER_ALLOWED_TOOLS.includes(t), `missing ${t}`);
  }
  for (const t of ["Task", "Agent", "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite"]) {
    assert.ok(COMPOSER_DISALLOWED_TOOLS.includes(t), `should disallow ${t}`);
  }
});

test("buildQueryOptions: canUseTool denies Bash rm with a prose message and records the denial", async () => {
  const { req, events } = makeReq();
  const denied: string[] = [];
  const o = buildQueryOptions(req, { env: FAKE_ENV, onDeny: (tool) => denied.push(tool) });
  const res = await o.canUseTool!("Bash", { command: "rm -rf node_modules" }, {
    signal: new AbortController().signal,
    toolUseID: "tu_x",
    requestId: "req_x",
  });
  assert.ok(res && res.behavior === "deny");
  assert.match(res.message, /does not allow "Bash rm -rf node_modules"/);
  assert.match(res.message, /Read, Write, Edit/);
  assert.deepEqual(denied, ["Bash"]);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "warn");
  assert.match(events[0]!.text, /^denied: Bash rm -rf node_modules/);
});

test("buildQueryOptions: stderr lines become trimmed warn events, capped at 300 chars", () => {
  const { req, events } = makeReq();
  const o = buildQueryOptions(req, { env: FAKE_ENV });
  o.stderr!("  first line  \n\n" + "x".repeat(400) + "\n");
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "warn");
  assert.equal(events[0]!.text, "first line");
  assert.equal(events[1]!.text.length, 301); // 300 + ellipsis
});

test("buildQueryOptions: an already-aborted caller signal aborts the controller; a live one is wired through", () => {
  const dead = new AbortController();
  dead.abort();
  const { req: r1 } = makeReq({ signal: dead.signal });
  assert.equal(buildQueryOptions(r1, { env: FAKE_ENV }).abortController!.signal.aborted, true);

  const live = new AbortController();
  const { req: r2 } = makeReq({ signal: live.signal });
  const o = buildQueryOptions(r2, { env: FAKE_ENV });
  assert.equal(o.abortController!.signal.aborted, false);
  live.abort();
  assert.equal(o.abortController!.signal.aborted, true);
});

test("buildQueryOptions: allowedToolsOverride is honoured (test-only hook)", () => {
  const { req } = makeReq();
  const o = buildQueryOptions(req, { env: FAKE_ENV, allowedToolsOverride: ["Read", "Bash(sleep:*)"] });
  assert.deepEqual(o.allowedTools, ["Read", "Bash(sleep:*)"]);
});

// ── redactOptionsForLog ────────────────────────────────────────────────────
test("redactOptionsForLog: secrets redacted, functions and AbortController rendered as names", () => {
  const { req } = makeReq();
  const o = buildQueryOptions(req, { env: FAKE_ENV });
  const r = redactOptionsForLog(o);
  const env = r.env as Record<string, string>;
  assert.equal(env.ANTHROPIC_API_KEY, "<redacted>");
  assert.equal(env.HOME, "/Users/test");
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, "eve-design/1.0");
  assert.equal(r.canUseTool, "[Function: canUseTool]");
  assert.equal(r.stderr, "[Function: stderr]");
  assert.equal(r.abortController, "[AbortController]");
  assert.deepEqual(r.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.deepEqual(r.allowedTools, COMPOSER_ALLOWED_TOOLS);
  // must be JSON-serialisable and free of the raw key
  const json = JSON.stringify(r);
  assert.equal(json.includes("sk-ant-test-123"), false);
});

test("redactOptionsForLog: pure — does not mutate the input; redacts TOKEN/SECRET/URL keys anywhere", () => {
  const input: Options = { env: { MY_TOKEN: "t", CLIENT_SECRET: "s", DATABASE_URL: "u", PLAIN: "p" }, cwd: "/x" };
  const before = JSON.stringify(input);
  const r = redactOptionsForLog(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(r.env, { MY_TOKEN: "<redacted>", CLIENT_SECRET: "<redacted>", DATABASE_URL: "<redacted>", PLAIN: "p" });
});

// ── toDesignEvents ─────────────────────────────────────────────────────────
test("toDesignEvents: init → info with version/model/tool count", () => {
  const ev = toDesignEvents(initMsg, "d1");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.kind, "info");
  assert.equal(ev[0]!.text, "Claude Code 2.1.233 · model claude-sonnet-4-5 · 4 tools");
  assert.equal(ev[0]!.dispatchId, "d1");
});

test("toDesignEvents: assistant tool_use → cc_tool with short labels (relative to project when given)", () => {
  const ev = toDesignEvents(assistantToolsMsg, "d1", "/tmp/proj");
  assert.deepEqual(
    ev.map((e) => [e.kind, e.text]),
    [
      ["cc_tool", "Read design.md"],
      ["cc_tool", "Write .prism/preview/app/landing/hero/page.tsx"],
      ["cc_tool", "Bash npm run build"],
    ],
  );
  // without a project root, absolute paths fall back to the basename
  const bare = toDesignEvents(assistantToolsMsg, "d1");
  assert.equal(bare[1]!.text, "Write page.tsx");
});

test("toDesignEvents: assistant text → cc_text trimmed, empties skipped", () => {
  const ev = toDesignEvents(assistantTextMsg, "d1");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.kind, "cc_text");
  assert.equal(ev[0]!.text, "I'll start by reading the design system.");
});

test("toDesignEvents: cc_text is capped at 200 chars", () => {
  const long = { ...(assistantTextMsg as object), message: { content: [{ type: "text", text: "y".repeat(500) }] } } as unknown as SDKMessage;
  const ev = toDesignEvents(long, "d1");
  assert.equal(ev[0]!.text.length, 201);
});

test("toDesignEvents: error tool_result → warn 'tool error: …'; non-errors ignored", () => {
  const ev = toDesignEvents(toolErrorMsg, "d1");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.kind, "warn");
  assert.equal(ev[0]!.text, "tool error: npm ERR! missing script: build");
});

test("toDesignEvents: result success and error_max_budget_usd → cc_result", () => {
  const ok = toDesignEvents(resultSuccess, "d1");
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.kind, "cc_result");
  assert.equal(ok[0]!.text, "done: success · $0.0123 · 3 turns");
  assert.deepEqual(ok[0]!.detail, { costUsd: 0.0123, turns: 3, durationMs: 4321, subtype: "success" });

  const bad = toDesignEvents(resultBudget, "d1");
  assert.equal(bad[0]!.text, "done: error_max_budget_usd · $0.5100 · 6 turns");
  assert.equal(bad[0]!.detail!.subtype, "error_max_budget_usd");
});

test("toDesignEvents: other message types are ignored", () => {
  const other = { type: "stream_event", event: {}, parent_tool_use_id: null, uuid: SID, session_id: SID } as unknown as SDKMessage;
  assert.deepEqual(toDesignEvents(other, "d1"), []);
  const status = { type: "system", subtype: "status", status: "compacting", uuid: SID, session_id: SID } as unknown as SDKMessage;
  assert.deepEqual(toDesignEvents(status, "d1"), []);
});

test("toolLabel: file paths, commands, patterns, fallbacks", () => {
  assert.equal(toolLabel({ file_path: "/a/b/c.tsx" }, "/a"), "b/c.tsx");
  assert.equal(toolLabel({ file_path: "/elsewhere/c.tsx" }, "/a"), "c.tsx");
  assert.equal(toolLabel({ file_path: "rel/c.tsx" }), "rel/c.tsx");
  assert.equal(toolLabel({ command: "  npm   run\nbuild  " }), "npm run build");
  assert.equal(toolLabel({ command: "x".repeat(100) }).length, 81);
  assert.equal(toolLabel({ pattern: "**/*.tsx" }), "**/*.tsx");
  assert.equal(toolLabel({}), "");
  assert.equal(toolLabel(null), "");
});

// ── runComposer with a fake query ─────────────────────────────────────────
function tmpLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eve-composer-test-"));
}

test("runComposer: success path — ok, cost, turns, options log written, ≥3 events forwarded", async () => {
  const logDir = tmpLogDir();
  try {
    const seen: Array<{ prompt: string; options?: Options }> = [];
    const fake: ComposerQueryFn = (params) => {
      seen.push(params);
      return (async function* () {
        yield initMsg;
        yield assistantToolsMsg;
        yield resultSuccess;
      })();
    };
    const { req, events } = makeReq({ dispatchId: "d-ok" });
    const res = await runComposer(req, { query: fake, env: FAKE_ENV, logDir });

    assert.equal(res.ok, true);
    assert.equal(res.subtype, "success");
    assert.equal(res.costUsd, 0.0123);
    assert.equal(res.turns, 3);
    assert.equal(res.sessionId, SID);
    assert.equal(res.resultText, "Wrote the hero page.");
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.permissionDenials, []);
    assert.equal(res.optionsLogPath, path.join(logDir, "d-ok.options.json"));
    assert.ok(fs.existsSync(res.optionsLogPath));
    const logged = JSON.parse(fs.readFileSync(res.optionsLogPath, "utf8")) as { prompt: string; options: Record<string, unknown> };
    assert.equal(logged.prompt, "do the thing");
    assert.equal((logged.options.env as Record<string, string>).ANTHROPIC_API_KEY, "<redacted>");
    assert.deepEqual(logged.options.settingSources, []);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.prompt, "do the thing");
    assert.deepEqual(seen[0]!.options?.systemPrompt, { type: "preset", preset: "claude_code" });
    assert.ok(events.length >= 3, `only ${events.length} events`);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["info", "cc_tool", "cc_tool", "cc_tool", "cc_result"],
    );
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("runComposer: a second run with the same dispatchId keeps both option logs", async () => {
  const logDir = tmpLogDir();
  try {
    const fake: ComposerQueryFn = () =>
      (async function* () {
        yield resultSuccess;
      })();
    const { req } = makeReq({ dispatchId: "d-twice" });
    const a = await runComposer(req, { query: fake, env: FAKE_ENV, logDir });
    const b = await runComposer(req, { query: fake, env: FAKE_ENV, logDir });
    assert.equal(path.basename(a.optionsLogPath), "d-twice.options.json");
    assert.equal(path.basename(b.optionsLogPath), "d-twice.2.options.json");
    assert.ok(fs.existsSync(a.optionsLogPath) && fs.existsSync(b.optionsLogPath));
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("runComposer: error result carries subtype, cost, denials and errors; ok false", async () => {
  const logDir = tmpLogDir();
  try {
    const fake: ComposerQueryFn = () =>
      (async function* () {
        yield initMsg;
        yield resultBudget;
      })();
    const { req } = makeReq({ dispatchId: "d-budget" });
    const res = await runComposer(req, { query: fake, env: FAKE_ENV, logDir });
    assert.equal(res.ok, false);
    assert.equal(res.subtype, "error_max_budget_usd");
    assert.equal(res.costUsd, 0.51);
    assert.equal(res.turns, 6);
    assert.deepEqual(res.permissionDenials, [{ tool: "Bash", input: { command: "rm -rf /" } }]);
    assert.deepEqual(res.errors, ["budget of $0.50 exceeded"]);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("runComposer: query that throws → spawn_failed with the message", async () => {
  const logDir = tmpLogDir();
  try {
    const fake: ComposerQueryFn = () => {
      throw new Error("Claude Code executable not found");
    };
    const { req, events } = makeReq({ dispatchId: "d-boom" });
    const res = await runComposer(req, { query: fake, env: FAKE_ENV, logDir });
    assert.equal(res.ok, false);
    assert.equal(res.subtype, "spawn_failed");
    assert.deepEqual(res.errors, ["Claude Code executable not found"]);
    assert.ok(fs.existsSync(res.optionsLogPath), "options log is written before the spawn");
    assert.ok(events.some((e) => e.kind === "warn" && /failed to run/.test(e.text)));
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("runComposer: generator that rejects mid-stream → spawn_failed", async () => {
  const logDir = tmpLogDir();
  try {
    const fake: ComposerQueryFn = () =>
      (async function* () {
        yield initMsg;
        throw new Error("process exited with code 1");
      })();
    const { req } = makeReq({ dispatchId: "d-mid" });
    const res = await runComposer(req, { query: fake, env: FAKE_ENV, logDir });
    assert.equal(res.subtype, "spawn_failed");
    assert.deepEqual(res.errors, ["process exited with code 1"]);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("runComposer: aborted before iteration → subtype aborted, query never spawned", async () => {
  const logDir = tmpLogDir();
  try {
    let called = 0;
    const fake: ComposerQueryFn = () => {
      called++;
      return (async function* () {
        yield resultSuccess;
      })();
    };
    const ac = new AbortController();
    ac.abort();
    const { req } = makeReq({ dispatchId: "d-abort-early", signal: ac.signal });
    const res = await runComposer(req, { query: fake, env: FAKE_ENV, logDir });
    assert.equal(res.ok, false);
    assert.equal(res.subtype, "aborted");
    assert.equal(called, 0);
    assert.ok(fs.existsSync(res.optionsLogPath));
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("runComposer: aborted mid-iteration → subtype aborted, close() called, returns promptly", async () => {
  const logDir = tmpLogDir();
  try {
    let closed = 0;
    const ac = new AbortController();
    const fake: ComposerQueryFn = () => {
      const gen = (async function* () {
        yield initMsg;
        yield assistantToolsMsg;
        // "long-running tool": hang until aborted (never resolves otherwise)
        await new Promise<void>((resolve) => ac.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted by SDK");
      })() as ReturnType<ComposerQueryFn>;
      gen.close = () => {
        closed++;
      };
      return gen;
    };
    const { req, events } = makeReq({ dispatchId: "d-abort-mid", signal: ac.signal });
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 60);
    const res = await runComposer(req, { query: fake, env: FAKE_ENV, logDir });
    assert.equal(res.subtype, "aborted");
    assert.equal(res.ok, false);
    assert.equal(closed, 1);
    assert.ok(Date.now() - t0 < 5000, "abort must not wait on the hung generator");
    assert.ok(events.some((e) => e.kind === "info"));
    assert.ok(events.some((e) => e.kind === "cc_tool"));
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("runComposer: onEvent that throws does not break the run", async () => {
  const logDir = tmpLogDir();
  try {
    const fake: ComposerQueryFn = () =>
      (async function* () {
        yield initMsg;
        yield resultSuccess;
      })();
    const { req } = makeReq({
      dispatchId: "d-throwing-sink",
      onEvent: () => {
        throw new Error("sink exploded");
      },
    });
    const res = await runComposer(req, { query: fake, env: FAKE_ENV, logDir });
    assert.equal(res.ok, true);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

// ── process hygiene ────────────────────────────────────────────────────────
test("listDescendants + sweepOrphans: a spawned sleep is listed, then killed within ~1.5 s", async () => {
  const child = spawn("sleep", ["30"], { detached: false, stdio: "ignore" });
  const pid = child.pid!;
  child.on("error", () => {});
  // give ps a moment to see it
  await new Promise((r) => setTimeout(r, 100));

  const before = await listDescendants(process.pid);
  assert.ok(before.some((p) => p.pid === pid && /sleep/.test(p.command)), `sleep ${pid} not in ${JSON.stringify(before)}`);

  const t0 = Date.now();
  const killed = await sweepOrphans(process.pid, { match: /sleep/ });
  assert.ok(killed.includes(pid), `killed=${JSON.stringify(killed)}`);

  // wait for the exit to be reaped so ps stops listing it
  const deadline = Date.now() + 1500;
  let gone = false;
  while (Date.now() < deadline) {
    const now = await listDescendants(process.pid);
    if (!now.some((p) => p.pid === pid)) {
      gone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(gone, "sleep still listed after sweep");
  assert.ok(Date.now() - t0 < 1500, "sweep took too long");
});

test("sweepOrphans: fells the whole subtree under a matched shell (sh -c sleep)", async () => {
  // the trailing `true` stops sh from exec-ing straight into sleep
  const child = spawn("sh", ["-c", "sleep 30; true"], { detached: false, stdio: "ignore" });
  const shPid = child.pid!;
  child.on("error", () => {});
  await new Promise((r) => setTimeout(r, 150));

  const before = await listDescendants(process.pid);
  const sleepProc = before.find((p) => p.ppid === shPid && /sleep 30/.test(p.command));
  assert.ok(sleepProc, `no sleep child of sh ${shPid} in ${JSON.stringify(before)}`);

  const killed = await sweepOrphans(process.pid, { match: /(^|\/)sh\b/ });
  assert.ok(killed.includes(shPid));
  assert.ok(killed.includes(sleepProc.pid), "the sleep under sh must go too");
  await new Promise((r) => setTimeout(r, 100));
  const after = await listDescendants(process.pid);
  assert.equal(after.some((p) => p.pid === sleepProc.pid), false);
});

test("sweepOrphans: leaves spared pids and never throws", async () => {
  const child = spawn("sleep", ["30"], { detached: false, stdio: "ignore" });
  const pid = child.pid!;
  child.on("error", () => {});
  try {
    await new Promise((r) => setTimeout(r, 100));
    const killed = await sweepOrphans(process.pid, { match: /sleep/, spare: [pid] });
    assert.equal(killed.includes(pid), false);
    assert.equal(child.exitCode, null);
    // an unusable root pid is not an error
    assert.deepEqual(await sweepOrphans(999_999_999, { match: /sleep/ }), []);
  } finally {
    child.kill("SIGKILL");
  }
});
