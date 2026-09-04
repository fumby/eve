// The guard that makes the isolation real. The plumbing that routes EVE's
// mutable state through STATE_ROOT is easy to set up and just as easy to lose:
// one edit to the `test` script in package.json and the whole suite quietly
// goes back to writing over real conversations, real memories and the real
// audit log — silently, and green the entire time. That is exactly how it
// happened before. So the suite refuses to run un-isolated.
//
// If this test is failing for you: run `npm test`, not a bare
// `node --test`. The npm script sets EVE_STATE_DIR to a throwaway directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, STATE_ROOT } from "../src/core/config.js";
import { DATA_DIR } from "../src/core/store.js";

test("the suite never runs against EVE's real state", () => {
  assert.notEqual(
    STATE_ROOT,
    ROOT,
    `STATE_ROOT resolved to the project itself (${ROOT}).\n` +
      `Every write in this suite would land on Umberto's real data/, memory/store/\n` +
      `and logs/. Run the suite with \`npm test\`, which sets EVE_STATE_DIR to a\n` +
      `throwaway directory. If you changed that script, put it back.`,
  );
});

// Asserting the variable is set is not the same as asserting the writes follow
// it: DATA_DIR is computed once at module load, so a path that was wired to
// ROOT before this change would keep pointing there no matter what the variable
// says. Check where the writes actually go.
test("the write paths follow STATE_ROOT, not just the variable", async () => {
  assert.ok(
    DATA_DIR.startsWith(STATE_ROOT),
    `DATA_DIR (${DATA_DIR}) is not under STATE_ROOT (${STATE_ROOT})`,
  );
  assert.ok(!DATA_DIR.startsWith(path.join(ROOT, "data")), "DATA_DIR still points at the real data/");

  // memory/store.ts keeps STORE_DIR private, so prove the same thing through
  // behaviour: write a memory and check it did NOT land in the real store.
  // This is the assertion that would have caught the old damage — every
  // `npm test` was rewriting memory/store/INDEX.md for real.
  const { saveMemory, deleteMemory } = await import("../src/memory/store.js");
  const name = "test-state-isolation-canary";
  const realStore = path.join(ROOT, "memory", "store", `${name}.md`);
  try {
    saveMemory({
      name,
      type: "reference",
      hook: "Canary for the state-isolation guard",
      body: "If this file shows up in the real store, isolation is broken.",
    });
    assert.ok(
      !fs.existsSync(realStore),
      `a memory written by the test suite landed in the REAL store at ${realStore}`,
    );
  } finally {
    try {
      deleteMemory(name);
    } catch {
      /* the sandbox is thrown away anyway */
    }
  }
});
