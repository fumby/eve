import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The project root, derived exactly as src/core/config.ts derives it (two
// levels up from src/core/). NOT imported from config.js: config imports
// this file, and the guard must sit below everything — no cycles.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every JSON state write in EVE goes through this file (store.writeJson,
// config.saveRuntime, the memory store, the factory). That makes it the one
// place a bare test run can be stopped before it overwrites Umberto's real
// data — which happened live on 2026-09-06: a test file run with plain
// `node --test` (no EVE_STATE_DIR) seeded conversations.json and replaced
// every stored conversation with two junk turns, silently, green the whole
// time. tests/state-isolation.test.ts only fires INSIDE an isolated run,
// where STATE_ROOT is already a sandbox, so the bare run — the one that
// matters — sailed through it.
//
// The signal is the runner itself: NODE_TEST_CONTEXT is set by node:test in
// every process it spawns and by nothing else in production, and a
// directly-executed test file names itself in argv[1]. Either being true
// while EVE_STATE_DIR is unset means a test is reaching for the REAL
// checkout — refuse, loudly, before any tmp file is even created.
export function refuseUnisolatedTestWrite(target: string): void {
  if (process.env.EVE_STATE_DIR) return; // sandboxed — the npm test way
  const runnerActive = Boolean(process.env.NODE_TEST_CONTEXT);
  const entry = process.argv[1] ?? "";
  const directTestFile = /\.(test|spec)\.(c|m)?[jt]s$/.test(entry);
  if (!runnerActive && !directTestFile) return; // production: server, REPL, scripts
  const resolved = path.resolve(target);
  if (!resolved.startsWith(ROOT + path.sep)) return; // outside the checkout — not ours to police
  throw new Error(
    `A test is writing EVE's REAL state (${resolved}). ` +
      `The test runner is active but EVE_STATE_DIR is unset, so this write lands on ` +
      `Umberto's actual data — the exact combination that wiped data/conversations.json ` +
      `on 2026-09-06. Run the suite with \`npm test\`, which sets EVE_STATE_DIR to a ` +
      `throwaway directory. Test fixtures must write through a sandboxed state root, ` +
      `never the real one.`,
  );
}

// Write to a sibling temp file, then rename over the target: a reader (or a
// crash, or a second writer) never sees a half-written file. Same-directory
// rename is atomic on macOS and Linux. Dependency-free so config.ts can use it
// without importing the store.
export function writeFileAtomic(target: string, contents: string): void {
  refuseUnisolatedTestWrite(target);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}
