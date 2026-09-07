// Standing checks: recurring agent-turns EVE schedules herself. What these
// tests protect, and how each broke before (or would):
//
// 1. The gate — create_standing_check is Tier-6 flagged. An unflagged create
//    tool means EVE can commit real money on a schedule with nobody asked.
// 2. The claim race — the face server and a REPL both run heartbeats and
//    tick independently; without the read-check-write claim they ran the
//    same check twice (the 405-notice flood's shape, on a paid path).
// 3. NOTHING means quiet — the whole design is "silent unless worth it";
//    a NOTHING reply must produce no notice, no lastResultAt.
// 4. Failure → backoff → auto-pause — a check whose runs keep failing must
//    stop itself and SAY SO, never burn budget silently forever.
// 5. The cadence bounds and the cap are enforced in the store, not just in
//    the tool schema — the store is reachable from code that has no gate.
// 6. The mission filter — a scheduled prompt is the worst place to persist
//    a credential; the store refuses it like memories and skills do.
// 7. state isolation — writes go through STATE_ROOT like everything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadStandingChecks,
  upsertStandingCheck,
  getStandingCheck,
  pauseStandingCheck,
  resumeStandingCheck,
  removeStandingCheck,
  dueStandingChecks,
  claimStandingCheck,
  runStandingCheck,
  standingCheckTools,
  MIN_INTERVAL_MIN,
} from "../src/tools/standing-checks.js";
import { listNotices } from "../src/core/notices.js";
import { STATE_ROOT } from "../src/core/config.js";
import fs from "node:fs";
import path from "node:path";

const DAY = 1440;

function cleanup() {
  // The suite runs under a throwaway EVE_STATE_DIR; still, start each test
  // from an empty store so counts are exact.
  fs.rmSync(path.join(STATE_ROOT, "data", "standing-checks.json"), { force: true });
}

test("create_standing_check is Tier-6 gated and the gate text names the cadence", () => {
  cleanup();
  const create = standingCheckTools.find((t) => t.name === "create_standing_check");
  assert.ok(create, "create_standing_check must exist");
  assert.equal(create.needsConfirmation, true, "creating a standing check spends real money on a schedule — it must be gated");
  const intent = create.confirmIntent?.({ mission: "watch the flights to Naples", interval_minutes: 10080 });
  assert.ok(intent?.human.includes("every 7 days"), `gate text should name the cadence, got: ${intent?.human}`);
  // The LOG rendering must not carry the mission text (audit/notice safe).
  assert.ok(!intent?.log.includes("watch the flights"), "the log rendering must not carry the mission text");
});

test("the store enforces cadence bounds, cap, and mission hygiene itself", () => {
  cleanup();
  // Under 6h: polling, not watching.
  assert.throws(() => upsertStandingCheck({ mission: "check the thing carefully now", intervalMinutes: 60 }));
  assert.throws(() => upsertStandingCheck({ mission: "check the thing carefully now", intervalMinutes: MIN_INTERVAL_MIN - 1 }));
  // Over 90 days.
  assert.throws(() => upsertStandingCheck({ mission: "check the thing carefully now", intervalMinutes: 129_601 }));
  // Too short / too long missions.
  assert.throws(() => upsertStandingCheck({ mission: "too short", intervalMinutes: DAY }));
  // A credential in the mission is refused outright.
  assert.throws(
    () =>
      upsertStandingCheck({
        mission: "rotate the key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA when it expires",
        intervalMinutes: DAY,
      }),
    /credential/i,
  );
  // Good create passes and is idempotent by slug.
  const a = upsertStandingCheck({ mission: "watch the thesis supervisor page for updates", intervalMinutes: DAY, slug: "thesis" });
  const b = upsertStandingCheck({ mission: "watch the thesis supervisor page for updates, v2", intervalMinutes: 2 * DAY, slug: "thesis" });
  assert.equal(a.id, b.id, "same slug = same check (update, not duplicate)");
  assert.equal(b.intervalMinutes, 2 * DAY, "the update took");
  // The cap: 12 checks max. "thesis" is #1; add 11 more to reach 12, then
  // the 13th is refused.
  for (let i = 0; i < 11; i++) {
    upsertStandingCheck({ mission: `standing watch number ${i} on something specific`, intervalMinutes: DAY, slug: `watch-${i}` });
  }
  assert.equal(loadStandingChecks().length, 12);
  assert.throws(() => upsertStandingCheck({ mission: "the thirteenth watch on something specific", intervalMinutes: DAY }), /cap 12/);
});

test("due/claim: cadence elapsed → due; claim is exclusive; early claim does not re-claim", () => {
  cleanup();
  const c = upsertStandingCheck({ mission: "watch the currency exchange rate for the rent", intervalMinutes: DAY, slug: "fx" });
  // Never ran → due now.
  assert.equal(dueStandingChecks().length, 1);
  const claimed = claimStandingCheck(c.id);
  assert.ok(claimed, "a due check claims");
  // Immediately after the claim, not due (interval not elapsed).
  assert.equal(dueStandingChecks().length, 0);
  // A second claim of the same id is refused — the loser of the race skips.
  assert.equal(claimStandingCheck(c.id), null);
  // After the interval elapses, due again.
  const future = new Date(Date.now() + (DAY + 1) * 60_000);
  assert.equal(dueStandingChecks(future).length, 1);
  // Paused checks are never due.
  pauseStandingCheck("fx", "test");
  assert.equal(dueStandingChecks(future).length, 0);
  resumeStandingCheck("fx");
  assert.equal(dueStandingChecks(future).length, 1);
});

test("runStandingCheck: NOTHING → quiet; found → tagged notice; failure → backoff then auto-pause", async () => {
  cleanup();
  const c = upsertStandingCheck({ mission: "watch the visa appointment calendar for openings", intervalMinutes: DAY, slug: "visa" });
  const claimed = claimStandingCheck(c.id)!;

  // The fake agent: a factory returning an OBJECT with runTurn (the seam's
  // shape — the heartbeat passes () => new Agent(...)).
  const says = (reply: string) => () => ({ runTurn: async () => reply });
  const blows = (msg: string) => () => ({
    runTurn: async () => {
      throw new Error(msg);
    },
  });

  // NOTHING → no notice, no lastResultAt, failures reset.
  const notice1 = await runStandingCheck(claimed, says("NOTHING"));
  assert.equal(notice1, null);
  let stored = getStandingCheck("visa")!;
  assert.equal(stored.lastResultAt, "", "a NOTHING run must not mark lastResultAt");
  assert.equal(stored.consecutiveFailures, 0);

  // Found → tagged notice text.
  const notice2 = await runStandingCheck(claimed, says(
    "The visa calendar opened two slots for October — worth grabbing one this week.",
  ));
  assert.ok(notice2?.startsWith("[visa] "), "the notice is tagged with the watch slug");
  stored = getStandingCheck("visa")!;
  assert.ok(stored.lastResultAt !== "", "a found run marks lastResultAt");

  // Failure → retry backoff, then auto-pause at 3 with a quiet notice.
  // (Presence, not count: the inbox caps its OPEN set at 60, and earlier
  // tests in the suite may have already filled it — a new notice can
  // auto-dismiss an old one, so length need not grow.)
  const hadPauseNotice = listNotices().some((n) => n.text.includes("paused the standing check"));
  await runStandingCheck(claimed, blows("provider exploded"));
  stored = getStandingCheck("visa")!;
  assert.equal(stored.consecutiveFailures, 1);
  assert.ok(stored.retryAt !== "", "a failed run sets a retry delay");
  // While in backoff, not due.
  assert.equal(dueStandingChecks().length, 0);

  // Simulate the backoff elapsing (30 min): claim again, fail twice more.
  // The claim takes a `now` so the test can step past the backoff without
  // waiting for it.
  const afterBackoff = new Date(Date.now() + 31 * 60_000);
  let claim2 = claimStandingCheck(c.id, afterBackoff)!;
  await runStandingCheck(claim2, blows("still broken"));
  stored = getStandingCheck("visa")!;
  claim2 = claimStandingCheck(c.id, new Date(Date.now() + 62 * 60_000))!;
  await runStandingCheck(claim2, blows("broken again"));
  stored = getStandingCheck("visa")!;
  assert.equal(stored.paused, true, "three consecutive failures auto-pause the check");
  assert.ok(stored.pausedReason.includes("auto-paused"), "the pause reason says why");
  assert.ok(listNotices().some((n) => n.text.includes("paused the standing check")), "the auto-pause leaves a notice");
  assert.ok(
    !hadPauseNotice || listNotices().filter((n) => n.text.includes("paused the standing check")).length >= 1,
  );
  // A paused check is never due, even far in the future.
  assert.equal(dueStandingChecks(new Date(Date.now() + 90 * DAY * 60_000)).length, 0);
  // Resume resets the failure counter.
  resumeStandingCheck("visa");
  stored = getStandingCheck("visa")!;
  assert.equal(stored.consecutiveFailures, 0);
  assert.equal(stored.paused, false);
});

test("remove works by slug and list tool reports running state", async () => {
  cleanup();
  upsertStandingCheck({ mission: "watch the rent contract renewal date approaching", intervalMinutes: 7 * DAY, slug: "rent" });
  const list = standingCheckTools.find((t) => t.name === "list_standing_checks")!;
  const out = (await list.run({})) as string;
  assert.ok(out.includes("[rent]") && out.includes("running"), `list should show the check running, got: ${out}`);
  assert.ok(removeStandingCheck("rent"));
  assert.equal(loadStandingChecks().length, 0);
  // Removing again: honestly nothing there.
  assert.equal(removeStandingCheck("rent"), null);
});

test("state isolation: standing checks land under STATE_ROOT, never the real data/", () => {
  cleanup();
  upsertStandingCheck({ mission: "the isolation canary watch over the real data folder", intervalMinutes: DAY, slug: "canary" });
  assert.ok(
    fs.existsSync(path.join(STATE_ROOT, "data", "standing-checks.json")),
    "the store must live under STATE_ROOT",
  );
  assert.ok(
    !fs.existsSync(path.join(STATE_ROOT, "..", "data", "standing-checks.json")) ||
      STATE_ROOT === path.resolve(STATE_ROOT, ".."),
    "no write may land next to the checkout",
  );
});
