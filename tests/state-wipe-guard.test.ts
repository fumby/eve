// The wipe guard: a bare `node --test` run must NEVER be able to write
// EVE's real state.
//
// The failure this pins happened live on 2026-09-06 at 22:07: a new test
// file (tests/morning.test.ts) seeds conversations.json through writeJson,
// and was run BARE — `node --test tests/morning.test.ts` — outside
// `npm test`, so no EVE_STATE_DIR was set and STATE_ROOT resolved to the
// real checkout. The seed overwrote data/conversations.json: every stored
// conversation Umberto had (the "ho fame" dinner thread, the ESSEC
// timetable evening, weeks of transcripts) replaced by two junk turns
// "x"/"y" — silently, green the whole time. Invariant #2 says the suite
// "refuses to run un-isolated"; that guard only fires INSIDE an isolated
// run, where STATE_ROOT is already a sandbox, so the bare run — the one
// that matters — sailed through.
//
// The fix under test lives in src/core/atomic.ts: writeFileAtomic refuses
// when the node:test runner is active (NODE_TEST_CONTEXT is set by the
// runner itself, and only by it), EVE_STATE_DIR is unset, and the target
// lives under the real checkout. `npm test` sets the variable, so the
// suite is unaffected; tsx scripts never set NODE_TEST_CONTEXT, so live
// checks are unaffected. Only the dangerous combination fails.
//
// Every probe runs as a CHILD process: the parent suite is always
// isolated (the npm script sets EVE_STATE_DIR), so no in-process code path
// can reproduce the bare-run condition. The bare child gets the env with
// EVE_STATE_DIR stripped — exactly what a human's bare invocation looks
// like — and tries to write a canary into the real data/.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const CANARY = `wipe-canary-${process.pid}.json`;
const REAL_CANARY = path.join(ROOT, "data", CANARY);
const STORE_JS = path.join(ROOT, "src", "core", "store.js");

// The env a bare run sees: NODE_TEST_CONTEXT arrives from the runner
// itself inside the child; EVE_STATE_DIR is what npm test provides and bare
// runs lack. Strip the npm_* variables so no inherited script context
// sneaks the variable back in.
function bareEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "EVE_STATE_DIR" || k === "NODE_TEST_CONTEXT" || k.startsWith("npm_")) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

// A leftover canary in the REAL data/ is the red state itself — this hook
// sweeps every wipe-canary-*.json (any pid: a crashed earlier run counts
// too), and runs after the file's tests no matter how they ended.
after(() => {
  try {
    for (const f of fs.readdirSync(path.join(ROOT, "data"))) {
      if (f.startsWith("wipe-canary-")) fs.rmSync(path.join(ROOT, "data", f), { force: true });
    }
  } catch {
    /* no data/ dir — nothing to sweep */
  }
});

test("a bare node --test run refuses to write the real state", () => {
  // The probe: a one-file test that writes through the same writeJson the
  // morning fixture used. Under the guard it must FAIL LOUDLY; without the
  // guard it exits 0 and the canary lands in the real data/.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-wipe-probe-"));
  const probe = path.join(probeDir, "probe.test.ts");
  fs.writeFileSync(
    probe,
    `import { test } from "node:test";\n` +
      `import { writeJson } from ${JSON.stringify(STORE_JS)};\n` +
      `test("seeding the store the way morning.test.ts does", () => {\n` +
      `  writeJson(${JSON.stringify(CANARY)}, { seed: true });\n` +
      `});\n`,
  );

  const child = spawnSync(NODE, ["--import", "tsx", "--test", probe], {
    cwd: ROOT, // tsx and the TS config resolve from the repo
    env: bareEnv(),
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = `${child.stdout ?? ""}${child.stderr ?? ""}`;

  // The refusal must be loud and teaching, not a stack-trace mystery.
  assert.notEqual(child.status, 0, `the bare run exited 0 — the canary (${CANARY}) landed in the REAL data/. The guard in src/core/atomic.ts is not firing; child output above.`);
  assert.match(out, /EVE_STATE_DIR/, "the refusal must name the missing variable");
  assert.match(out, /npm test/, "the refusal must say how to run tests correctly");
  assert.ok(!fs.existsSync(REAL_CANARY), "the canary reached the real data/ — the write was not refused");
});

test("an ISOLATED node --test run (EVE_STATE_DIR set) writes freely", async () => {
  // The guard must be inert exactly where the suite works: this parent
  // process HAS EVE_STATE_DIR (set by the npm script), so the same
  // write must succeed — against the sandbox, not the repo.
  const { writeJson } = await import("../src/core/store.js");
  const { STATE_ROOT } = await import("../src/core/config.js");
  writeJson(CANARY, { fine: true });
  const landed = path.join(STATE_ROOT, "data", CANARY);
  assert.ok(fs.existsSync(landed), "sandboxed write did not land");
  assert.notEqual(STATE_ROOT, ROOT, "parent suite is somehow unisolated — do not run this file bare");
  fs.rmSync(landed, { force: true });
});

test("a direct tsx run (no test runner) writes as before", () => {
  // NODE_TEST_CONTEXT is set ONLY by the test runner. A script run with
  // plain tsx (npm run eve, the face server, every scripts/*-check) must
  // keep working — the guard can only ever fire inside `node --test`.
  // Sandboxed on purpose: the point is the guard keys on the RUNNER, not
  // the directory, so an isolated direct run must write fine too.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-wipe-direct-"));
  const script = path.join(dir, "direct.mjs");
  fs.writeFileSync(
    script,
    `import { writeJson } from ${JSON.stringify(STORE_JS)};\n` +
      `writeJson(process.argv[2], { direct: true });\n` +
      `console.log("wrote");\n`,
  );
  const child = spawnSync(NODE, ["--import", "tsx", script, CANARY], {
    cwd: ROOT,
    env: bareEnv({ EVE_STATE_DIR: dir }),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(child.status, 0, `a direct tsx run was refused — the guard is over-firing:\n${child.stdout ?? ""}${child.stderr ?? ""}`);
  assert.match(child.stdout ?? "", /wrote/);
  assert.ok(fs.existsSync(path.join(dir, "data", CANARY)), "the direct write did not land in its sandbox");
});
