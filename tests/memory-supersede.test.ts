// Supersession: what happens when a fact CHANGES. Before this existed, the new
// version was simply saved beside the old one — both in the index, both coming
// back from recall, nothing saying which was current — and EVE got to pick.
// These tests protect the three properties that make retirement safe enough to
// leave ungated: it destroys nothing, it is validated before anything is
// written, and a retired memory is genuinely out of sight of the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  saveMemory,
  getMemory,
  listMemories,
  retiredMemories,
  renderIndex,
  deleteMemory,
} from "../src/memory/store.js";
import { recallMemories } from "../src/memory/recall.js";
import { memoryTools } from "../src/tools/memory.js";
// STATE_ROOT, not ROOT — the store under test is the sandbox one.
import { STATE_ROOT } from "../src/core/config.js";

const STORE = path.join(STATE_ROOT, "memory", "store");
const fileFor = (name: string): string => path.join(STORE, `${name}.md`);

// Lexical recall, always. With a Voyage key in the environment these tests
// would score against a live API — a network hiccup would read as a logic bug,
// and the property under test (retired entries are not candidates at all) is
// the same either way.
delete process.env.VOYAGE_API_KEY;

const saveTool = memoryTools.find((t) => t.name === "save_memory")!;
const recallTool = memoryTools.find((t) => t.name === "recall_memories")!;
const gateFires = (input: Record<string, unknown>): boolean =>
  typeof saveTool.needsConfirmation === "function"
    ? saveTool.needsConfirmation(input)
    : saveTool.needsConfirmation;

// Each test owns its names and cleans up after itself: the suite shares one
// sandbox store, and a leftover memory changes what renderIndex() and recall
// return for everyone downstream.
function sweep(...names: string[]): void {
  for (const n of names) {
    deleteMemory(n);
    fs.rmSync(fileFor(n), { force: true });
  }
}

// ── the core property ──────────────────────────────────────────────────────

test("a retired memory leaves the index and recall but stays on disk", async () => {
  saveMemory({
    type: "project",
    hook: "Umberto's zolfanello venture ships in March",
    body: "Launch was set for March after the supplier call.",
    name: "zolfanello-launch-march",
  });
  saveMemory({
    type: "project",
    hook: "Umberto's zolfanello venture ships in September",
    body: "The supplier slipped; September is the real date now.",
    name: "zolfanello-launch-september",
    supersedes: "zolfanello-launch-march",
  });

  const live = listMemories().map((m) => m.name);
  assert.ok(live.includes("zolfanello-launch-september"), "the replacement is missing");
  assert.ok(
    !live.includes("zolfanello-launch-march"),
    "the retired memory is still in the live list — it will keep contradicting its replacement",
  );

  // Out of the prompt index...
  assert.ok(!renderIndex().includes("zolfanello-launch-march"));
  // ...out of recall...
  const { hits } = await recallMemories("zolfanello venture ships");
  assert.ok(
    !hits.some((h) => h.memory.name === "zolfanello-launch-march"),
    "recall still returns the retired memory",
  );
  // ...but NOT gone. This is the promise that makes retirement safe.
  assert.ok(fs.existsSync(fileFor("zolfanello-launch-march")), "the retired file was deleted");
  const old = getMemory("zolfanello-launch-march")!;
  assert.equal(old.supersededBy, "zolfanello-launch-september");
  assert.match(old.supersededOn!, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(old.body, "Launch was set for March after the supplier call.", "the body was rewritten");
  assert.equal(getMemory("zolfanello-launch-september")!.supersedes, "zolfanello-launch-march");

  sweep("zolfanello-launch-march", "zolfanello-launch-september");
});

test("include_retired is the only way back to it, and says so in the result", async () => {
  saveMemory({ type: "me", hook: "Umberto lives in Naples", body: "Home base, with his father.", name: "lives-naples" });
  saveMemory({
    type: "me",
    hook: "Umberto lives in Cergy",
    body: "Moved for ESSEC.",
    name: "lives-cergy",
    supersedes: "lives-naples",
  });

  const plain = await recallTool.run({ query: "where Umberto lives" });
  assert.ok(!plain.includes("lives-naples"), "an ordinary recall leaked the retired memory");

  const withHistory = await recallTool.run({ query: "where Umberto lives", include_retired: true });
  assert.ok(withHistory.includes("lives-naples"), "include_retired did not reach the retired memory");
  assert.match(
    withHistory,
    /RETIRED — replaced by \[lives-cergy\]/,
    "history came back unlabelled — nothing tells EVE which of these she still believes",
  );

  sweep("lives-naples", "lives-cergy");
});

// ── validation happens BEFORE anything is written ──────────────────────────

test("superseding a name that does not exist writes nothing at all", () => {
  assert.throws(
    () =>
      saveMemory({
        type: "me",
        hook: "Umberto switched to a standing desk",
        body: "Bought one in September.",
        name: "standing-desk",
        supersedes: "no-such-memory",
      }),
    /no stored memory by that name/,
  );
  assert.equal(
    getMemory("standing-desk"),
    null,
    "the new memory was saved anyway — a mistyped supersedes silently becomes a duplicate",
  );
  sweep("standing-desk");
});

test("a memory cannot supersede itself, and cannot retire an already-retired one", () => {
  saveMemory({ type: "me", hook: "Umberto drinks his coffee black", body: "No sugar.", name: "coffee-black" });
  assert.throws(
    () =>
      saveMemory({
        type: "me",
        hook: "Umberto drinks his coffee black",
        body: "Still no sugar.",
        name: "coffee-black",
        supersedes: "coffee-black",
      }),
    /cannot supersede itself/,
  );

  saveMemory({
    type: "me",
    hook: "Umberto takes his coffee with milk",
    body: "Changed this autumn.",
    name: "coffee-milk",
    supersedes: "coffee-black",
  });
  // Reasoning from a retired memory means something upstream is stale, so it
  // is refused loudly and pointed at the current one rather than chaining.
  assert.throws(
    () =>
      saveMemory({
        type: "me",
        hook: "Umberto takes his coffee with oat milk",
        body: "Switched again.",
        name: "coffee-oat",
        supersedes: "coffee-black",
      }),
    /already retired by \[coffee-milk\]/,
  );
  assert.equal(getMemory("coffee-oat"), null, "the refused save still landed");

  sweep("coffee-black", "coffee-milk", "coffee-oat");
});

// ── what a human sees ──────────────────────────────────────────────────────

test("INDEX.md keeps the history the prompt index deliberately drops", () => {
  saveMemory({ type: "project", hook: "The ARCI report prints at 300 copies", body: "Agreed with the printer.", name: "arci-300" });
  saveMemory({
    type: "project",
    hook: "The ARCI report prints at 500 copies",
    body: "Raised after the second meeting.",
    name: "arci-500",
    supersedes: "arci-300",
  });

  const index = fs.readFileSync(path.join(STORE, "INDEX.md"), "utf8");
  assert.match(index, /## Retired/, "INDEX.md has no retired section");
  assert.match(index, /\[arci-300\][\s\S]*replaced by \[arci-500\]/);
  // The prompt index rides in the cached system block on EVERY turn. History
  // there would cost tokens forever to say what EVE no longer believes.
  assert.ok(
    !renderIndex().includes("arci-300"),
    "the retired memory reached renderIndex() — it is now in the system prompt every turn",
  );
  assert.deepEqual(
    retiredMemories().map((m) => m.name).filter((n) => n === "arci-300"),
    ["arci-300"],
  );

  sweep("arci-300", "arci-500");
});

// ── the gate ───────────────────────────────────────────────────────────────

test("retiring is ungated by default, and a credential still is not", () => {
  const plain = {
    type: "me",
    hook: "Umberto now uses a 125cc scooter",
    body: "Upgraded from the 50cc.",
    supersedes: "scooter-50cc",
  };
  assert.equal(
    gateFires(plain),
    false,
    "supersede is asking for confirmation by default — every writer with no human attached will now auto-deny it",
  );
  // The credential check is code-owned and unconditional; a save that is both
  // sensitive AND superseding must still ask the question with a wrong answer.
  const sensitive = { ...plain, body: "His api_key is in the drawer." };
  assert.equal(gateFires(sensitive), true, "a credential slipped past the gate by riding a supersede");
  const intent = saveTool.confirmIntent!(sensitive);
  assert.match(intent.human, /secret/i, "the gate asked about retirement instead of the credential");
  assert.ok(
    !intent.log.includes("api_key"),
    "the audit line carries the flagged content it exists to keep out of logs",
  );
});
