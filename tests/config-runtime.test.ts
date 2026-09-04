// The runtime-override mechanism itself had no behavioural test — setStudiesDir
// and setHeartbeatPaused have always gone untested, and set_location was written
// against config.json instead, which is how it drifted. This covers the contract
// the static guard in config-boundaries.test.ts cannot see: the setting still
// takes effect, and config.json on disk does not move while it does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, STATE_ROOT, loadConfig, loadRuntime, setLocation } from "../src/core/config.js";

const CONFIG = path.join(ROOT, "config.json");

test("setLocation persists to runtime state and leaves config.json untouched", () => {
  // The bytes of the real, versioned file. If a future edit routes this back
  // through config.json, this is what notices.
  const before = fs.readFileSync(CONFIG, "utf8");

  const city = { city: "Testville", lat: 12.5, lon: -3.25 };
  setLocation(city);

  // It took effect for every reader, through the same cfg.location they already use.
  assert.deepEqual(loadConfig().location, city);

  // It landed in runtime state, under STATE_ROOT — so a sandboxed run like this
  // one never touches the real data/ directory.
  assert.deepEqual(loadRuntime().location, city);
  const runtimeFile = path.join(STATE_ROOT, "data", "runtime.json");
  assert.ok(fs.existsSync(runtimeFile), `expected runtime state at ${runtimeFile}`);
  assert.notEqual(STATE_ROOT, ROOT, "suite is not sandboxed — run it with npm test");

  // And the versioned file did not move.
  assert.equal(
    fs.readFileSync(CONFIG, "utf8"),
    before,
    "config.json changed on disk — a runtime setting was written to versioned config",
  );
});

test("a runtime override replaces the config.json default for the same key", () => {
  const fromConfig = JSON.parse(fs.readFileSync(CONFIG, "utf8")) as { location: unknown };
  const override = { city: "Elsewhere", lat: -8, lon: 44.75 };
  setLocation(override);

  assert.deepEqual(loadConfig().location, override);
  assert.notDeepEqual(
    loadConfig().location,
    fromConfig.location,
    "the override did not win over the config.json default",
  );
});

// A hand-edited runtime.json is expected — the file is documented as editable —
// so a malformed entry must fall back to the default rather than crash startup,
// the way the other two overrides already do.
test("a malformed location in runtime state falls back to the config.json default", () => {
  // Read the default FIRST. config-boundaries.test.ts flags any write within two
  // lines of a name bound to config.json, and CONFIG is exactly such a name — so
  // putting this read next to the writeFileSync below trips the guard on this
  // very file. Keep them apart; the guard cannot tell which path a write targets.
  const fromConfig = JSON.parse(fs.readFileSync(CONFIG, "utf8")) as { location: unknown };

  const runtimeFile = path.join(STATE_ROOT, "data", "runtime.json");
  const rt = JSON.parse(fs.readFileSync(runtimeFile, "utf8")) as Record<string, unknown>;
  rt.location = { lat: "not a number" };
  fs.writeFileSync(runtimeFile, JSON.stringify(rt, null, 2) + "\n");

  assert.deepEqual(
    loadConfig().location,
    fromConfig.location,
    "a junk override should be ignored, not adopted or thrown on",
  );
});
