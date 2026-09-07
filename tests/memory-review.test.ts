// The periodic background review — the pass that runs WHILE a conversation is
// still going, every N exchanges, instead of waiting for a clean close that on
// the face usually never comes.
//
// The model call is not what is risky here; what happens to a proposal after
// the model has spoken is. So applyProposals() is exercised directly with
// synthetic proposals: the credential refusal, the near-duplicate check, the
// supersedes link and what happens when the model gets that link wrong, and
// the skill overlap check. All of it used to be reachable only by paying for a
// real extraction and hoping it proposed the shape you wanted to test.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyProposals, parseProposals, reviewDue } from "../src/memory/extractor.js";
import { saveMemory, getMemory, deleteMemory, listMemories } from "../src/memory/store.js";
import { getSkill, deleteSkill, skillsDir } from "../src/skills/store.js";
import { loadConfig } from "../src/core/config.js";

// Lexical scoring, always — see tests/memory-supersede.test.ts for why.
delete process.env.VOYAGE_API_KEY;

// Named cleanup, never a sweep of the whole store. The suite shares ONE
// sandbox state directory across test files that run concurrently, so a
// "delete everything" helper here reaches into another file's fixtures
// mid-assertion — which is exactly how this file first went green while
// turning tests/memory-sensitive.test.ts red.
const sweep = (...names: string[]): void => {
  for (const name of names) {
    deleteMemory(name);
    deleteSkill(name);
    fs.rmSync(path.join(skillsDir(), `${name}.md`), { force: true });
  }
};

const proposals = (over: Partial<Parameters<typeof applyProposals>[0]> = {}) => ({
  memories: [],
  skills: [],
  ...over,
});

// ── the cadence ────────────────────────────────────────────────────────────

test("the review fires on the interval and never on a fresh agent's first turn", () => {
  const every = loadConfig().memory.reviewEveryExchanges;
  assert.ok(every > 0, "reviewEveryExchanges is 0 — the periodic pass is switched off in config.json");
  assert.equal(reviewDue(0), false, "a review fired at zero exchanges — every new agent would pay for one");
  assert.equal(reviewDue(every), true);
  assert.equal(reviewDue(every - 1), false);
  assert.equal(reviewDue(every * 3), true, "the cadence stops after the first interval");
});

// ── the guards that stand between a proposal and the store ─────────────────

test("a proposal that reads like a credential is refused before it can be embedded", async () => {
  const r = await applyProposals(
    proposals({
      memories: [
        {
          type: "reference" as const,
          hook: "Umberto's ledger api_key is worth remembering",
          body: "The key is sk-abc123def456 and it goes in the header.",
        },
      ],
    }),
  );
  assert.deepEqual(r.saved, []);
  assert.equal(r.skipped[0]?.reason, "sensitive content refused");
  // Scoped to the credential, not to the store: other test files are writing
  // to the same sandbox at the same time.
  assert.ok(
    !listMemories({ includeRetired: true }).some((m) => `${m.hook}${m.body}`.includes("sk-abc123")),
    "the credential was written to disk anyway",
  );
});

// The ORDER of the two guards is load-bearing and the comment in the extractor
// says so: the duplicate check embeds the hook through the Voyage API, so the
// credential refusal has to come first or the secret leaves the machine on its
// way to being told it was a duplicate. The store's own throw is a backstop —
// it would keep the file off disk while the text was already gone.
test("a credential never reaches the embedding API on its way to being refused", async () => {
  saveMemory({ type: "me", hook: "Umberto keeps his notes in Obsidian", body: "Since last year." });

  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  process.env.VOYAGE_API_KEY = "not-a-real-key";
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    throw new Error("no network in tests");
  }) as typeof globalThis.fetch;

  try {
    const r = await applyProposals(
      proposals({
        memories: [
          {
            type: "reference" as const,
            hook: "The deploy password is worth writing down",
            body: "password: hunter2-and-a-half, used for the staging box.",
          },
        ],
      }),
    );
    assert.deepEqual(r.saved, []);
    assert.deepEqual(
      calls,
      [],
      `the hook was sent to ${calls[0]} before being refused — the secret left the machine`,
    );
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.VOYAGE_API_KEY;
    sweep("umberto-keeps-his-notes-in-obsidian");
  }
});

test("a near-duplicate of something already stored is skipped", async () => {
  const stored = saveMemory({
    type: "project",
    hook: "Umberto's ESSEC Global BBA starts in September 2026",
    body: "Cergy campus.",
  });
  const r = await applyProposals(
    proposals({
      memories: [
        {
          type: "project" as const,
          hook: "Umberto's ESSEC Global BBA starts September 2026",
          body: "He begins at Cergy.",
        },
      ],
    }),
  );
  assert.deepEqual(r.saved, [], "a restatement of a stored memory was saved as a second copy");
  assert.match(r.skipped[0]!.reason, /already covered by/);
  sweep(stored.name);
});

test("a valid supersedes link retires the old memory and reports the pair", async () => {
  const old = saveMemory({
    type: "project",
    hook: "The Arci booklet prints at 300 copies",
    body: "Agreed with the printer in July.",
  });
  const r = await applyProposals(
    proposals({
      memories: [
        {
          type: "project" as const,
          hook: "The booklet print run was raised to 500 copies",
          body: "Decided at the September meeting.",
          supersedes: old.name,
        },
      ],
    }),
  );
  assert.equal(r.saved.length, 1);
  assert.deepEqual(r.retired, [{ name: old.name, by: r.saved[0]!.name }]);
  assert.equal(getMemory(old.name)!.supersededBy, r.saved[0]!.name);
  assert.ok(
    !listMemories().some((m) => m.name === old.name),
    "the retired memory is still competing with the one that replaced it",
  );
  sweep(old.name, r.saved[0]!.name);
});

// This is the one that matters. The store validates the link BEFORE writing
// anything, so a hallucinated name used to throw away the whole proposal — and
// the fact the session actually learned went with it.
test("a supersedes link the model got wrong costs the link, not the fact", async () => {
  const r = await applyProposals(
    proposals({
      memories: [
        {
          type: "me" as const,
          hook: "Umberto rides a 125cc scooter in Cergy",
          body: "Bought used in September.",
          supersedes: "a-memory-that-never-existed",
        },
      ],
    }),
  );
  assert.equal(r.saved.length, 1, "the fact was thrown away along with the bad link");
  assert.deepEqual(r.retired, [], "something was retired on the strength of a name that does not exist");
  assert.match(r.skipped[0]!.reason, /saved, but not superseding \[a-memory-that-never-existed\]/);
  sweep(r.saved[0]!.name);
});

// ── skills ─────────────────────────────────────────────────────────────────

test("a skill is written once, and a second proposal for the same trigger is not", async () => {
  sweep("printing-a-booklet");
  const first = await applyProposals(
    proposals({
      skills: [
        {
          title: "Printing a booklet",
          when: "When Umberto needs a document printed as a stapled booklet",
          body: "## Procedure\n1. Ring the shop before 10.\n2. Send the PDF as A4.\n## Pitfalls\n- A5 gets you A5 sheets.",
        },
      ],
    }),
  );
  assert.equal(first.skills.length, 1);
  assert.ok(getSkill("printing-a-booklet"));

  const second = await applyProposals(
    proposals({
      skills: [
        {
          title: "Booklet printing at the shop",
          when: "When Umberto needs a document printed as a stapled booklet at the shop",
          body: "## Procedure\n1. Call them first.\n2. Send A4.\n## Pitfalls\n- Do not ask for A5.",
        },
      ],
    }),
  );
  assert.deepEqual(second.skills, [], "a near-identical trigger produced a second competing skill");
  assert.match(second.skipped[0]!.reason, /skill already covered by \[printing-a-booklet\]/);
  sweep("printing-a-booklet");
});

test("a skill proposal that is really a transcript is skipped, not thrown", async () => {
  const r = await applyProposals(
    proposals({
      skills: [
        {
          title: "Everything from today",
          when: "When Umberto asks about anything we did today",
          body: "x".repeat(9000),
        },
      ],
    }),
  );
  assert.deepEqual(r.skills, []);
  assert.match(r.skipped[0]!.reason, /the limit is 8000/);
});

test("the pass writes at most two skills, however many are proposed", async () => {
  // Deliberately unrelated triggers: with overlapping ones the OTHER guard
  // fires first and this test would pass for the wrong reason.
  const many = [
    "When Umberto needs a scooter registered in France",
    "When a Supabase migration has to be rolled back",
    "When the printer refuses a PDF with embedded fonts",
    "When an ESSEC deadline lands during exam week",
  ].map((when, i) => ({
    title: `Skill number ${i + 1}`,
    when,
    body: `## Procedure\n1. Step one for ${i}.\n2. Step two for ${i}.\n## Pitfalls\n- None known yet.`,
  }));
  const r = await applyProposals(proposals({ skills: many }));
  assert.equal(r.skills.length, 2, "the cap on skills per pass is gone — one session can bury the store");
  sweep(...r.skills.map((sk) => sk.name));
});

// ── the parser ─────────────────────────────────────────────────────────────

test("the parser reads skills and supersedes, and drops what it cannot use", () => {
  const p = parseProposals(
    `here you go: {"memories":[
      {"type":"me","hook":"Umberto moved to Cergy","body":"For ESSEC.","supersedes":"lives-naples"},
      {"type":"nonsense","hook":"Something else entirely","body":"With a body long enough."},
      {"type":"me","hook":"short","body":"too short a hook"}
     ],"skills":[
      {"title":"Doing the thing","when":"When the thing needs doing","body":"## Procedure\\n1. Do it carefully."},
      {"title":"Bad","when":"x","body":"y"}
     ]}`,
  );
  assert.equal(p.memories.length, 2, "a malformed memory took a good one down with it");
  assert.equal(p.memories[0]!.supersedes, "lives-naples");
  assert.equal(p.memories[1]!.type, "reference", "an unknown type should fall back, not vanish");
  assert.equal(p.memories[1]!.supersedes, undefined);
  assert.equal(p.skills.length, 1, "the too-short skill was accepted");
  assert.equal(p.skills[0]!.title, "Doing the thing");

  // A reply with no skills key at all is the common case and must not throw.
  assert.deepEqual(parseProposals('{"memories":[]}'), { memories: [], skills: [] });
  assert.deepEqual(parseProposals("no json here"), { memories: [], skills: [] });
});
