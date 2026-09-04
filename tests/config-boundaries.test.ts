// config.json is static, versioned configuration: read at startup by every
// entry point, edited by hand, committed. Nothing EVE runs may write to it.
//
// This guard exists because the rule was already broken. set_location rewrote
// config.json in place with a bare writeFileSync under ROOT — so it dirtied the
// checkout on every call, ignored EVE_STATE_DIR (a sandboxed run still hit the
// real file), and could truncate the file a crash mid-write would leave
// unparseable at the next startup. It sat there live and registered, three
// stated invariants broken at once, with nothing to catch it.
//
// The settings EVE changes about herself belong in data/runtime.json, which is
// gitignored, follows STATE_ROOT, and is written atomically — see saveRuntime
// in src/core/config.ts, and setStudiesDir / setHeartbeatPaused / setLocation
// for the shape a new one should take.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ROOT } from "../src/core/config.js";
import { scanForWrites, type ProtectedPath } from "./boundary-scan.js";

// The lookbehind is the whole trick. A bare /config\.json/ also matches
// "tsconfig.json", which src/design/scaffold.ts writes legitimately as part of
// a generated Next app — the guard would have failed on day one for a file
// that has nothing to do with this rule. Excluding a preceding word character,
// dot or hyphen drops tsconfig.json, next.config.json and the like, while
// "config.json", ROOT + "/config.json" and path.join(ROOT, "config.json") all
// still match. Slash is deliberately NOT excluded: a nested config.json under
// some other directory is not the protected file, but a guard that errs toward
// firing is the right kind of wrong — a human then decides.
const PROTECTED: ProtectedPath[] = [
  { pattern: /(?<![\w.\-])config\.json/, label: "config.json" },
];

// Without this, a scan that silently found nothing would let the guard below
// pass while checking absolutely nothing.
test("the config boundary scan actually reads the source tree", () => {
  const { files } = scanForWrites(PROTECTED);
  assert.ok(files.length > 0, "scanned zero files — the guard below would pass vacuously");
  const rel = files.map((f) => path.relative(ROOT, f));
  // The one legitimate reader, and the file where the violation actually lived.
  assert.ok(rel.includes("src/core/config.ts"), "src/core/config.ts not scanned");
  assert.ok(rel.includes("src/tools/weather.ts"), "src/tools/weather.ts not scanned");
  assert.ok(rel.includes("scripts/design-dispatch.ts"), "scripts/ not scanned");
});

test("no executable code anywhere writes to config.json", () => {
  const { offences } = scanForWrites(PROTECTED);
  const report = offences
    .map((o) => `  ${o.file}:${o.line} — ${o.write}() near ${o.protectedBy}\n      ${o.text}`)
    .join("\n");
  assert.deepEqual(
    offences,
    [],
    `A filesystem write appeared next to config.json:\n${report}\n\n` +
      `That file is versioned configuration and is READ-ONLY at runtime. Writing\n` +
      `it breaks three invariants at once: it lands under ROOT instead of\n` +
      `STATE_ROOT (so a sandboxed run mutates the real checkout), it is not\n` +
      `atomic unless it goes through the repo's own helper, and it makes a\n` +
      `git pull collide with whatever EVE decided about herself.\n\n` +
      `Put the setting in data/runtime.json instead: add a field to\n` +
      `RuntimeSettings and a setter beside setStudiesDir in src/core/config.ts,\n` +
      `then let loadConfig apply it over the config.json default. Callers keep\n` +
      `reading cfg.<field> exactly as before.`,
  );
});
