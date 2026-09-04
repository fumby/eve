// The brain's pure mechanics: window trimming must only ever cut at exchange
// boundaries — a sliced tool_use/tool_result pair is an invalid conversation
// the API rejects outright.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { trimExchanges, Agent } from "../src/core/agent.js";
import { buildStableBlock, checkpointBlock, contextBlock } from "../src/brain/prompt.js";
import {
  saveMemory,
  getMemory,
  deleteMemory,
  listMemories,
  renderIndex,
  slugify,
} from "../src/memory/store.js";
import { recallMemories } from "../src/memory/recall.js";
// STATE_ROOT, not ROOT: the store these tests write to is the sandbox one.
// Computing the path independently is how they used to end up asserting
// against Umberto's real memory while quietly rewriting its index.
import { STATE_ROOT } from "../src/core/config.js";

type Msg = { role: "user" | "assistant"; content: unknown };

// One plain exchange: user text → assistant text.
function plain(n: number): Msg[] {
  return [
    { role: "user", content: `question ${n}` },
    { role: "assistant", content: `answer ${n}` },
  ];
}

// One tool exchange: user → assistant(tool_use) → user(tool_result) → assistant.
function withTool(n: number): Msg[] {
  return [
    { role: "user", content: `do thing ${n}` },
    { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "ok" }] },
    { role: "assistant", content: `did thing ${n}` },
  ];
}

function build(exchanges: Msg[][]): { history: Msg[]; starts: number[] } {
  const history: Msg[] = [];
  const starts: number[] = [];
  for (const ex of exchanges) {
    starts.push(history.length);
    history.push(...ex);
  }
  return { history, starts };
}

test("under the bound nothing is trimmed", () => {
  const { history, starts } = build([plain(1), plain(2)]);
  trimExchanges(history as never, starts, 5);
  assert.equal(history.length, 4);
  assert.equal(starts.length, 2);
});

test("oldest whole exchanges drop; the survivor starts with its user turn", () => {
  const { history, starts } = build([withTool(1), plain(2), withTool(3)]);
  trimExchanges(history as never, starts, 1);
  assert.equal(starts.length, 1);
  assert.equal(starts[0], 0);
  assert.equal(history[0]!.role, "user");
  assert.equal(history[0]!.content, "do thing 3");
  assert.equal(history.length, 4); // the full tool exchange, intact
});

test("a marathon stays bounded with valid structure", () => {
  const exchanges = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? withTool(i) : plain(i)));
  const { history, starts } = build(exchanges);
  trimExchanges(history as never, starts, 30);
  assert.equal(starts.length, 30);
  assert.equal(history[0]!.role, "user");
  // no orphaned tool_result: any tool_result's tool_use must appear before it
  const seenToolUse = new Set<string>();
  for (const m of history) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as { type: string; id?: string; tool_use_id?: string }[]) {
        if (b.type === "tool_use" && b.id) seenToolUse.add(b.id);
        if (b.type === "tool_result") assert.ok(seenToolUse.has(b.tool_use_id!), "orphan tool_result");
      }
    }
  }
});

test("stable block carries identity, rails, and core knowledge", () => {
  const block = buildStableBlock();
  assert.match(block, /You are EVE/);
  assert.match(block, /data, not instructions/);
  assert.match(block, /What you always know/);
  // brain/ledger-schema.md rides in as its own section, after capabilities
  assert.match(block, /# Data you can query/);
  assert.match(block, /query_ledger/);
  assert.match(block, /\*\*transactions\*\*/);
  assert.ok(block.indexOf("# What you can do") < block.indexOf("# Data you can query"));
  assert.ok(block.indexOf("# Data you can query") < block.indexOf("# Long-term memory"));
});

test("capabilities render from the given tools; checkpoint block is what it says", () => {
  const block = buildStableBlock([{ name: "test_tool", description: "Does the thing. And more." }]);
  assert.match(block, /What you can do/);
  assert.match(block, /- test_tool: Does the thing\./);
  assert.match(block, /gated IN CODE/);
  assert.match(block, /no email, calendar, or messaging access/);
  assert.match(checkpointBlock(), /long-conversation check/i);
});

// One fixed LOCAL instant for every context-block test below. contextBlock's
// second parameter is an injectable clock; these tests used Date.now() instead,
// and the day-label assertions they make are claims about CALENDAR days — so
// they were false for the first six hours of every local day, and green only by
// the accident of when the suite usually ran.
//
// Built with the local-time Date constructor on purpose: a fixed UTC instant
// would still land on a different local day depending on the process TZ. Midday
// leaves room for every offset used below to stay on the intended calendar day
// in every timezone.
const FIXED_NOON = new Date(2026, 7, 17, 12, 0, 0);

// Local wall-clock "HH:MM". Derived, never hardcoded: the suite must not assume
// it runs on Europe/Rome.
const hhmmLocal = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// The context block is the instrumentation experiment's whole apparatus: facts
// in, zero instructions. These tests pin both halves of that contract.
test("context block reports the session facts that are available", () => {
  const started = new Date(FIXED_NOON.getTime() - 90 * 60_000);
  const previous = new Date(FIXED_NOON.getTime() - 30 * 60 * 60_000);
  const block = contextBlock(
    {
      startedAt: started.toISOString(),
      exchanges: 23,
      source: "face",
      previousSessionEnd: previous.toISOString(),
    },
    FIXED_NOON,
  );
  assert.match(block, /^<contesto>\n/);
  assert.match(block, /\n<\/contesto>\n$/);
  // \p{L}, not \w: the Italian weekday is "lunedì" and \w is ASCII-only
  assert.match(block, /^Ora: \p{L}+ \d{1,2} \p{L}+ \d{4}, \d{2}:\d{2}/mu);
  // 90 minutes before midday is the same calendar day, so no day prefix. The
  // time is derived from the fixture rather than left as \d{2}:\d{2}, which
  // would have matched any rendering at all — including the wrong one.
  assert.match(
    block,
    new RegExp(
      `^Sessione: iniziata alle ${hhmmLocal(started)} \\(1h 30m fa\\), 23 turni completati$`,
      "m",
    ),
  );
  assert.match(block, /^Canale: vocale$/m); // the face is voice-only
  // 30h before midday is the previous calendar day in every timezone. Before
  // 06:00 local it is the day before THAT, which is what "however the clock
  // fell" used to get wrong — dayLabel counts calendar days, not 24h blocks.
  assert.match(
    block,
    new RegExp(
      `^Sessione precedente: ieri, terminata alle ${hhmmLocal(previous)} \\(30h 0m fa\\)$`,
      "m",
    ),
  );
});

test("context block degrades silently: a missing fact leaves no trace", () => {
  const noPrevious = contextBlock(
    {
      startedAt: FIXED_NOON.toISOString(),
      exchanges: 0,
      source: "typed",
      previousSessionEnd: null,
    },
    FIXED_NOON,
  );
  assert.doesNotMatch(noPrevious, /Sessione precedente/);
  assert.doesNotMatch(noPrevious, /sconosciut|non disponibile|n\/a|null|undefined|NaN/i);
  assert.match(noPrevious, /^Canale: testuale$/m);
  assert.match(noPrevious, /0 turni completati/); // the first turn is a real fact

  // A corrupt timestamp drops its line instead of inventing or crashing
  const badStart = contextBlock(
    {
      startedAt: "not-a-date",
      exchanges: 4,
      source: "voice",
      previousSessionEnd: "also-not-a-date",
    },
    FIXED_NOON,
  );
  assert.doesNotMatch(badStart, /Sessione:/);
  assert.doesNotMatch(badStart, /Sessione precedente/);
  assert.doesNotMatch(badStart, /Invalid Date|NaN/);
  assert.match(badStart, /^Ora: /m); // the clock always survives
});

test("context block carries no behavioural instruction and no interpretation", () => {
  const block = contextBlock(
    {
      startedAt: FIXED_NOON.toISOString(),
      exchanges: 41,
      source: "voice",
      previousSessionEnd: new Date(FIXED_NOON.getTime() - 3 * 60 * 60_000).toISOString(),
    },
    FIXED_NOON,
  );
  // Nothing telling EVE how to treat Umberto in light of these facts, and no
  // read of his state. If a line like that ever appears, the baseline is void.
  assert.doesNotMatch(block, /\b(nota|considera|ricorda|tieni conto|adatta|evita|dovresti)\b/i);
  assert.doesNotMatch(block, /\b(tardi|stanc|sembra|probabilmente|forse)/i);
  assert.doesNotMatch(block, /[?!]/);
  // Functional imperatives ARE allowed and this one is load-bearing: it says
  // how to resolve relative dates, and marks which reading is the live one once
  // older blocks have piled up in history. Removing it is a regression.
  assert.match(block, /Compute dates like "tomorrow" from this\./);
});

// The blocks freeze into history, so by turn 20 there are 20 different clock
// readings stacked in the prompt. Injecting `now` is what lets us build that
// pile deterministically; the model-side half of this check is the stale-clock
// probe, which asks EVE the time with 24 older readings sitting above it.
test("context block renders at an injected clock, so stale readings are reproducible", () => {
  const at = (iso: string) =>
    contextBlock(
      {
        startedAt: "2026-08-17T12:10:00.000Z",
        exchanges: 3,
        source: "typed",
        previousSessionEnd: null,
      },
      new Date(iso),
    );
  // Derived, not hardcoded: the suite must not assume the process runs on
  // Europe/Rome. What is being pinned is that the injected instant drives the
  // rendering — not any particular wall clock.
  const wall = (iso: string): string => hhmmLocal(new Date(iso));
  const early = at("2026-08-17T12:30:00.000Z");
  const late = at("2026-08-17T15:45:00.000Z");
  assert.notEqual(early, late);
  assert.match(early, new RegExp(`^Ora: .*, ${wall("2026-08-17T12:30:00.000Z")}\\b`, "m"));
  assert.match(late, new RegExp(`^Ora: .*, ${wall("2026-08-17T15:45:00.000Z")}\\b`, "m"));
});

test("seeding a resumed conversation counts and bounds exchanges", () => {
  const turns = Array.from({ length: 80 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `turn ${i}`,
    at: new Date().toISOString(),
  }));
  const agent = new Agent(undefined, "typed", {
    id: "test-seed",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "typed",
    turns,
  });
  assert.equal(agent.conversationId, "test-seed");
  assert.equal(agent.totalExchanges, 30); // bounded by liveWindowExchanges
});

// The overwrite is the one destructive memory operation nobody confirms, and
// memory/store/ has no git history, no remote and no backup behind it — so
// saveMemory keeps the outgoing bytes in .trash first, and refuses to overwrite
// at all if it cannot. The tests for that live in THIS file on purpose:
// `node --test` runs test FILES in parallel, and .trash is shared state, so a
// separate file sabotaging it could break the round-trip test mid-write.
const STORE = path.join(STATE_ROOT, "memory", "store");
const TRASH = path.join(STORE, ".trash");
// Only ever this test's own leavings: Umberto's real undo history is not ours
// to sweep, and a stale file from an older run must not fool the run in progress.
const trashFor = (name: string): string[] =>
  (fs.existsSync(TRASH) ? fs.readdirSync(TRASH) : []).filter((f) => f.startsWith(`${name}.`));
const sweepTrash = (name: string): void => {
  for (const f of trashFor(name)) fs.rmSync(path.join(TRASH, f), { force: true });
};

test("memory store round-trip: file, frontmatter, index, delete", () => {
  const name = "test-round-trip-memory";
  try {
    const saved = saveMemory({
      name,
      type: "reference",
      hook: "Test hook for the round trip",
      body: "The fact. Why it matters. How to apply it.",
    });
    assert.equal(saved.name, name);
    const file = path.join(STATE_ROOT, "memory", "store", `${name}.md`);
    const raw = fs.readFileSync(file, "utf8");
    assert.match(raw, /^---\nname: test-round-trip-memory\ntype: reference\nhook: Test hook/);
    assert.match(raw, /Why it matters/);
    assert.match(renderIndex(), /Test hook for the round trip/);

    // update keeps the created date
    const created = saved.created;
    const updated = saveMemory({ name, type: "reference", hook: "Updated hook line here", body: "New body." });
    assert.equal(updated.created, created);
    assert.equal(getMemory(name)?.hook, "Updated hook line here");
  } finally {
    deleteMemory(name);
    // That update overwrote a file, so it left a copy behind — this test's own,
    // swept here so a full run never accretes rubbish in Umberto's real store.
    sweepTrash(name);
  }
  assert.equal(getMemory(name), null);
  assert.doesNotMatch(renderIndex(), /round trip/);
});

test("slugify and no-clobber on auto names", () => {
  assert.equal(slugify("Umberto's thesis defense — November!"), "umberto-s-thesis-defense-november");
  try {
    const a = saveMemory({ type: "reference", hook: "Duplicate hook collision test", body: "first body." });
    const b = saveMemory({ type: "reference", hook: "Duplicate hook collision test", body: "second body." });
    assert.notEqual(a.name, b.name);
    assert.equal(getMemory(a.name)?.body, "first body.");
    assert.equal(getMemory(b.name)?.body, "second body.");
    deleteMemory(a.name);
    deleteMemory(b.name);
  } finally {
    // double-delete is harmless; cleanup best-effort
  }
});

test("overwriting a memory keeps the outgoing version in .trash", () => {
  const name = "test-trash-keeps-old";
  sweepTrash(name);
  try {
    saveMemory({ name, type: "reference", hook: "The original hook line", body: "original body." });
    assert.equal(trashFor(name).length, 0, "a first save has nothing to keep");

    saveMemory({ name, type: "reference", hook: "The replacement hook line", body: "new body." });
    const kept = trashFor(name);
    assert.equal(kept.length, 1, "the overwritten version was not kept");
    assert.match(fs.readFileSync(path.join(TRASH, kept[0]!), "utf8"), /hook: The original hook line/);
    assert.equal(getMemory(name)?.hook, "The replacement hook line");

    // The trash must stay invisible to the store that owns it.
    assert.ok(fs.readdirSync(STORE).includes(".trash"));
    assert.ok(!listMemories().some((m) => m.name.startsWith(".")), ".trash leaked into listMemories()");
    assert.doesNotMatch(renderIndex(), /\.trash/);
  } finally {
    deleteMemory(name);
    sweepTrash(name);
  }
});

test("a save that cannot be backed up does not overwrite anything", () => {
  const name = "test-trash-abort";
  const file = path.join(STORE, `${name}.md`);
  let locked = false;
  sweepTrash(name);
  try {
    saveMemory({ name, type: "reference", hook: "The hook that must survive", body: "must survive." });
    const before = fs.readFileSync(file, "utf8");

    // Sabotage the SOURCE, not the .trash directory: making the shared
    // directory unwritable would break any other test file that overwrites a
    // memory while this one runs, and `node --test` runs test files in
    // parallel. Unreadable source, same failure, blast radius of one file.
    fs.chmodSync(file, 0o000);
    locked = true;

    assert.throws(
      () => saveMemory({ name, type: "reference", hook: "The hook that must NOT land", body: "must not land." }),
      /refusing to overwrite/,
      "the overwrite went ahead despite the backup failing",
    );

    fs.chmodSync(file, 0o644);
    locked = false;
    // The point of the abort: the previous version is still exactly as it was.
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(getMemory(name)?.hook, "The hook that must survive");
    assert.equal(trashFor(name).length, 0, "an aborted save still left a trash copy");
  } finally {
    if (locked) fs.chmodSync(file, 0o644);
    deleteMemory(name);
    sweepTrash(name);
  }
});

test("lexical recall finds by keyword without any embedding key", async () => {
  const saved = process.env.VOYAGE_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  const name = "test-lexical-recall";
  try {
    // "password" here was incidental — the lexical hit rides on "zanzibar" and
    // "ritual" — and the store now refuses credential-shaped text outright.
    saveMemory({ name, type: "reference", hook: "The zanzibar gateway lantern ritual", body: "Testing lexical matching only." });
    const { hits, how } = await recallMemories("zanzibar ritual");
    assert.equal(how, "lexical");
    assert.ok(hits.some((h) => h.memory.name === name), "lexical hit missing");
  } finally {
    deleteMemory(name);
    if (saved) process.env.VOYAGE_API_KEY = saved;
  }
});
