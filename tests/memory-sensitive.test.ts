// The credential filter, and where it lives. It used to sit in the extractor,
// which guarded one of three ways into the store; it now sits in saveMemory()
// itself, so every writer hits the same wall. The two paths react differently
// on purpose: the extractor is unattended, so it skips silently, while the
// save_memory tool has a human on the other end and asks him instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  SENSITIVE,
  SENSITIVE_STRUCTURED,
  SensitiveContentError,
  isSensitive,
  saveMemory,
  getMemory,
  deleteMemory,
  renderIndex,
} from "../src/memory/store.js";
import { Registry, isFactoryAllowed, type EveTool } from "../src/core/registry.js";
import { memoryTools } from "../src/tools/memory.js";
// STATE_ROOT, not ROOT: the store these tests write to is the sandbox one.
// Computing the path independently is how they used to end up asserting
// against Umberto's real memory while quietly rewriting its index.
import { STATE_ROOT } from "../src/core/config.js";

// Assembled from pieces so this file never looks like a real leaked credential
// to a secret scanner. AKIAIOSFODNN7EXAMPLE is AWS's own documentation sample.
const GH_CLASSIC = "ghp" + "_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const GH_FINE = "github" + "_pat_11ABCDEFG0abcdefghijkl_ZZZZZZZZZZ";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const JWT = "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig";
const IBAN = "IT60X0542811101000000123456";
const IBAN_SPACED = "IT60 X054 2811 1010 0000 0123 456";
const CF = "RSSMRA85T10A562S";

const STORE = path.join(STATE_ROOT, "memory", "store");
const TRASH = path.join(STORE, ".trash");
// Only ever this file's own leavings — the real undo history is Umberto's.
const trashFor = (name: string): string[] =>
  (fs.existsSync(TRASH) ? fs.readdirSync(TRASH) : []).filter((f) => f.startsWith(`${name}.`));
const sweepTrash = (name: string): void => {
  for (const f of trashFor(name)) fs.rmSync(path.join(TRASH, f), { force: true });
};

const saveTool = memoryTools.find((t) => t.name === "save_memory")!;
const gateFires = (input: Record<string, unknown>): boolean =>
  typeof saveTool.needsConfirmation === "function"
    ? saveTool.needsConfirmation(input)
    : saveTool.needsConfirmation;

// ── the patterns ───────────────────────────────────────────────────────────

test("the keyword half still refuses everything it always refused", () => {
  for (const s of [
    "My api key is hunter2",
    "the password is swordfish",
    "passwd rotation is monthly",
    "his credential for the portal",
    "bearer abc.def.ghi",
    "sk-abc123def",
    "pa-FAKE123fakefake456",
    "card 4111 1111 1111 1111",
  ])
    assert.ok(isSensitive(s), `should have been refused: ${s}`);
});

test("structured secrets: github, aws, jwt, italian IBAN and codice fiscale", () => {
  for (const s of [GH_CLASSIC, GH_FINE, AWS_KEY, JWT, IBAN, CF])
    assert.ok(isSensitive(s), `should have been refused: ${s.slice(0, 10)}…`);
  assert.ok(isSensitive(`rotated the aws key ${AWS_KEY} this morning`));
  // IBANs are printed in groups of four — that must not be a way through.
  assert.ok(isSensitive(`his IBAN is ${IBAN_SPACED}`));
});

// "token" and "secret" used to be bare keywords, which refused ordinary shop
// talk about prompt caching and the plain English word. They count now only
// where a credential would actually sit.
test("token is refused as a credential, allowed as a unit of text", () => {
  for (const s of ["auth token abc", "access-token xyz", "refresh_token q", "token: abc123", "token=abc"])
    assert.ok(isSensitive(s), `should have been refused: ${s}`);
  for (const s of [
    "the design dispatch cost $1.33 for 36 turns, ~13k tokens cached",
    "prompt caching holds about 13k tokens per turn",
    "her reply was under 200 tokens",
  ])
    assert.equal(isSensitive(s), false, `false positive on: ${s}`);
});

test("secret is refused as a credential, allowed as an English word", () => {
  for (const s of ["client secret abc", "the secret key is x", "api secret y", "secret: hunter2", "secret=abc"])
    assert.ok(isSensitive(s), `should have been refused: ${s}`);
  for (const s of [
    "A plain lasting preference, nothing secret about it",
    "He is secretive about the new venture's name",
    "the secret of a good espresso is the pressure",
  ])
    assert.equal(isSensitive(s), false, `false positive on: ${s}`);
});

// Two constants instead of one exist precisely for this: folding case would
// make AKIA… match akia… and put the codice-fiscale shape within reach of
// ordinary uppercase prose. This test fails if anyone ever adds /i.
test("the structured patterns are case-sensitive, and neither regex is global", () => {
  assert.equal(SENSITIVE_STRUCTURED.test(AWS_KEY.toLowerCase()), false);
  assert.equal(SENSITIVE_STRUCTURED.test(CF.toLowerCase()), false);
  assert.equal(SENSITIVE_STRUCTURED.flags.includes("i"), false);
  // .test() on a /g regex is stateful — it would let every second secret past.
  assert.equal(SENSITIVE.flags.includes("g"), false);
  assert.equal(SENSITIVE_STRUCTURED.flags.includes("g"), false);
});

// A filter that refuses ordinary life is a filter that gets switched off.
test("ordinary memories are not refused", () => {
  for (const s of [
    "Umberto's thesis is on family business governance in Italian SMEs",
    "His favourite espresso bar is Caffè Nembo on via Toledo",
    "Barcelona holiday runs 15-20 August 2026",
    "The dragonfruit checklist is kept in the fridge",
    "The zanzibar gateway lantern ritual",
    "EVE ROADMAP 2026 Q1 PLAN A",
    "MILANO 12 MAGGIO 2026",
    "He moves to Cergy near Paris on 24 August 2026",
  ])
    assert.equal(isSensitive(s), false, `false positive on: ${s}`);
});

// ── the chokepoint ─────────────────────────────────────────────────────────

test("saveMemory refuses at the chokepoint and leaves nothing behind", () => {
  const name = "test-sensitive-never-written";
  const store = path.join(STATE_ROOT, "memory", "store");
  const trash = path.join(store, ".trash");
  const trashBefore = fs.existsSync(trash) ? fs.readdirSync(trash).length : 0;
  const indexBefore = renderIndex();

  assert.throws(
    () => saveMemory({ name, type: "reference", hook: `The deploy key is ${GH_CLASSIC}`, body: "Body long enough." }),
    SensitiveContentError,
  );
  assert.equal(fs.existsSync(path.join(store, `${name}.md`)), false, "a refused memory was written");
  assert.equal(getMemory(name), null);
  assert.equal(renderIndex(), indexBefore, "a refused memory touched the index");
  // Ordering against the .trash copy: the refusal fires first, so nothing is
  // trashed either.
  assert.equal(fs.existsSync(trash) ? fs.readdirSync(trash).length : 0, trashBefore);
});

// registry.execute() writes err.message into logs/audit.jsonl. If the message
// quoted the match, the secret would be persisted in plaintext in the one file
// whose whole purpose is to be safe to open.
test("the refusal never repeats the secret back", () => {
  try {
    saveMemory({ type: "reference", hook: `codice fiscale ${CF} for the form`, body: "Body long enough." });
    assert.fail("expected SensitiveContentError");
  } catch (err) {
    assert.ok(err instanceof SensitiveContentError);
    assert.ok(!err.message.includes(CF), "the refusal echoed the secret");
    assert.match(err.message, /Nothing was.*written/);
  }
});

// An explicit name is used verbatim as the filename AND rendered into INDEX.md,
// which rides in the cached system prompt on every single turn.
test("a name cannot smuggle a secret past the filter", () => {
  assert.throws(
    () => saveMemory({ name: AWS_KEY, type: "reference", hook: "A perfectly ordinary hook line", body: "Body long enough." }),
    SensitiveContentError,
  );
  assert.equal(fs.existsSync(path.join(STATE_ROOT, "memory", "store", `${AWS_KEY}.md`)), false);
});

// The gate is asked about the same normalised string the store will judge —
// otherwise a hook whose whitespace collapses into an IBAN would slip past the
// gate and then be refused at the write, which is a throw, not a question.
test("gate predicate and store refusal agree, including after normalisation", () => {
  const split = { type: "reference", hook: `IBAN   ${IBAN_SPACED}`, body: "Body long enough." };
  assert.equal(gateFires(split as unknown as Record<string, unknown>), true);
  assert.throws(() => saveMemory(split as never), SensitiveContentError);
});

// ── the two reactions ──────────────────────────────────────────────────────

test("the save_memory tool asks instead of throwing, and never logs the secret", async () => {
  const reg = new Registry();
  for (const t of memoryTools) reg.register(t);

  const input = {
    type: "reference",
    hook: `Umberto's IBAN is ${IBAN_SPACED}`,
    body: "He asked me to keep this handy for the transfer.",
  };
  assert.equal(gateFires(input), true, "the gate did not fire on a credential");

  // Declined: not saved, and the tool reports a refusal rather than a crash.
  const asked: string[] = [];
  reg.confirm = async (_tool, intent) => {
    asked.push(intent);
    return false;
  };
  const declined = await reg.execute("save_memory", input);
  assert.equal(declined.isError, true);
  assert.match(declined.content, /declined/i);
  assert.doesNotMatch(declined.content, /tool failed/, "it threw instead of asking");
  assert.equal(getMemory("umberto-s-iban-is-it60-x054-2811-1010-0000-0123-456"), null);

  // What Umberto was shown carries the text he needs to judge…
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /looks like it contains a secret/);
  assert.ok(asked[0]!.includes(IBAN_SPACED), "he was asked without being shown the content");

  // …but what would reach logs/audit.jsonl and the notices inbox does not.
  const logged = saveTool.confirmIntent!(input).log;
  assert.ok(!logged.includes(IBAN_SPACED), "the audit line carries the secret");
  assert.ok(!logged.includes(IBAN), "the audit line carries the secret");
  assert.match(logged, /content withheld/);
});

test("approving at the gate lets the same memory through", async () => {
  const reg = new Registry();
  for (const t of memoryTools) reg.register(t);
  reg.confirm = async () => true;
  let saved: string | null = null;
  try {
    const r = await reg.execute("save_memory", {
      type: "reference",
      hook: `The office alarm code note ${CF}`,
      body: "He asked for this on purpose.",
    });
    assert.equal(r.isError, false, `approved save still failed: ${r.content}`);
    saved = /^Saved \[([^\]]+)\]/.exec(r.content)?.[1] ?? null;
    assert.ok(saved, `could not read the saved name back from: ${r.content}`);
    assert.equal(getMemory(saved!)?.type, "reference");
  } finally {
    // deleteMemory, never a raw rmSync: only it rewrites INDEX.md, and a
    // stranded index entry would ride in EVE's system prompt every turn.
    if (saved) deleteMemory(saved);
  }
});

// An ordinary memory must not have acquired a confirmation step.
test("an ordinary memory still saves without asking anything", async () => {
  const reg = new Registry();
  for (const t of memoryTools) reg.register(t);
  reg.confirm = async () => {
    assert.fail("an ordinary memory should never reach the gate");
  };
  // save_memory derives its own name now, so the cleanup MUST read the real one
  // back out of the result. Passing a name here and deleting that name would
  // delete nothing and leave a memory behind in Umberto's store on every run.
  let saved: string | null = null;
  try {
    const r = await reg.execute("save_memory", {
      type: "reference",
      hook: "A test fixture hook that saves without asking",
      body: "A plain lasting preference, worth remembering for planning his days.",
    });
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /^Saved \[/);
    saved = /^Saved \[([^\]]+)\]/.exec(r.content)?.[1] ?? null;
    assert.ok(saved, `could not read the saved name back from: ${r.content}`);
  } finally {
    if (saved) deleteMemory(saved);
  }
});

// ── create and update are two tools ────────────────────────────────────────

// The whole of option A: the overwrite is not expressible from the
// frictionless path, rather than expressible and guarded.
test("save_memory cannot address an existing memory at all", async () => {
  const reg = new Registry();
  for (const t of memoryTools) reg.register(t);
  const name = "test-a-existing";
  let collateral: string | null = null;
  try {
    saveMemory({ name, type: "reference", hook: "The original hook survives", body: "original body." });

    // Zod strips the unknown key: the name is not addressable, so this creates
    // a NEW memory under a derived slug and leaves the original alone.
    const r = await reg.execute("save_memory", {
      name,
      type: "reference",
      hook: "An attempt to replace it silently",
      body: "replacement body.",
    });
    assert.equal(r.isError, false, r.content);
    collateral = /^Saved \[([^\]]+)\]/.exec(r.content)?.[1] ?? null;
    assert.notEqual(collateral, name, "save_memory still addressed an existing memory");
    assert.equal(getMemory(name)?.hook, "The original hook survives");
    assert.equal(Object.keys(saveTool.schema.shape).includes("name"), false, "name is still in the schema");
  } finally {
    deleteMemory(name);
    if (collateral) deleteMemory(collateral);
    sweepTrash(name);
  }
});

test("update_memory refuses a name that does not exist, and writes nothing", async () => {
  const reg = new Registry();
  for (const t of memoryTools) reg.register(t);
  reg.confirm = async () => true;
  const name = "test-a-absent";
  const before = renderIndex();
  const r = await reg.execute("update_memory", {
    name,
    type: "reference",
    hook: "A hook for a memory that is not there",
    body: "Body long enough to pass.",
  });
  assert.equal(r.isError, true);
  assert.match(r.content, /no stored memory named/);
  assert.equal(getMemory(name), null);
  assert.equal(renderIndex(), before, "a failed update touched the index");
});

test("update_memory asks, and a refusal changes nothing", async () => {
  const reg = new Registry();
  for (const t of memoryTools) reg.register(t);
  const name = "test-a-declined";
  const asked: string[] = [];
  reg.confirm = async (_t, intent) => {
    asked.push(intent);
    return false;
  };
  try {
    saveMemory({ name, type: "reference", hook: "The hook that must survive", body: "surviving body." });
    const r = await reg.execute("update_memory", {
      name,
      type: "reference",
      hook: "The hook that must not land",
      body: "landing body.",
    });
    assert.equal(r.isError, true);
    assert.match(r.content, /declined/i);
    assert.equal(getMemory(name)?.hook, "The hook that must survive");
    assert.equal(trashFor(name).length, 0, "a declined update still trashed a copy");

    // The diff is what makes the question answerable.
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /BEFORE[\s\S]*The hook that must survive/);
    assert.match(asked[0]!, /AFTER[\s\S]*The hook that must not land/);
  } finally {
    deleteMemory(name);
    sweepTrash(name);
  }
});

test("update_memory approved replaces the entry and keeps the old one in .trash", async () => {
  const reg = new Registry();
  for (const t of memoryTools) reg.register(t);
  reg.confirm = async () => true;
  const name = "test-a-approved";
  try {
    saveMemory({ name, type: "reference", hook: "The hook being replaced", body: "the older body." });
    const r = await reg.execute("update_memory", {
      name,
      type: "project",
      hook: "The hook that replaces it",
      body: "the newer body.",
    });
    assert.equal(r.isError, false, r.content);
    assert.equal(getMemory(name)?.hook, "The hook that replaces it");
    assert.equal(getMemory(name)?.type, "project");

    const kept = trashFor(name);
    assert.equal(kept.length, 1, "the replaced version was not kept");
    assert.match(fs.readFileSync(path.join(TRASH, kept[0]!), "utf8"), /hook: The hook being replaced/);
  } finally {
    deleteMemory(name);
    sweepTrash(name);
  }
});

// Same separation as save_memory's: the human sees what he is replacing, the
// audit trail and the notices inbox get the name and nothing else.
test("the update diff reaches Umberto but never logs/audit.jsonl", () => {
  const name = "test-a-intent";
  try {
    saveMemory({ name, type: "reference", hook: "A distinctive old hook here", body: "distinctive old body." });
    const { human, log } = memoryTools
      .find((t) => t.name === "update_memory")!
      .confirmIntent!({ name, type: "reference", hook: "A distinctive new hook here", body: "distinctive new body." });

    assert.ok(human.includes("A distinctive old hook here"), "the diff omits what is being replaced");
    assert.ok(human.includes("A distinctive new hook here"), "the diff omits the replacement");
    for (const secretish of ["distinctive old body", "distinctive new body", "old hook", "new hook"])
      assert.ok(!log.includes(secretish), `the audit line carries content: ${secretish}`);
    assert.match(log, /^update_memory .* \(content withheld\)$/);
  } finally {
    deleteMemory(name);
    sweepTrash(name);
  }
});

// Neither writer is offered to Factory-spawned agents. Deciding what deserves
// durable memory about Umberto is EVE's judgement, and a spawned agent runs on
// a model-written system prompt. Stated explicitly on the tools rather than
// derived, so it cannot change as a side effect of how a gate is expressed.
test("no Factory-spawned agent is handed any memory tool at all", () => {
  assert.ok(memoryTools.length >= 4, "a memory tool was added — decide its Factory policy");
  for (const tool of memoryTools)
    assert.equal(
      isFactoryAllowed(tool),
      false,
      `${tool.name} is reachable from a spawned agent — memory is closed by default,\n` +
        `writes because durable memory about Umberto is EVE's judgement, reads because a\n` +
        `"personal" entry is his private life. Open it per-agent, deliberately, or not at all.`,
    );
});

// The derivation itself still has to be right for every other tool: a
// CONDITIONAL gate must not read as "always gated" and silently withhold a
// tool that has no explicit flag.
test("a conditional gate is not mistaken for an unconditional one", () => {
  const conditional: EveTool = {
    ...saveTool,
    name: "plain_conditional_tool",
    factoryAllowed: undefined,
    needsConfirmation: () => true,
  };
  assert.equal(isFactoryAllowed(conditional), true);
  assert.equal(isFactoryAllowed({ ...conditional, needsConfirmation: true }), false);
});
