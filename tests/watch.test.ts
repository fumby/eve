// The repo watch's rules, on fixtures — no network anywhere. What matters:
// signal pings exactly once, noise never pings, and the very first sight of a
// repo is a baseline (no replaying history the day the watch turns on).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeRuns,
  judgePushEvents,
  judgeStalePRs,
  judgeAlerts,
  hadWeeklyStreak,
  isEmergencyRef,
  type RunInfo,
  type PushEventInfo,
  type PrInfo,
  type AlertInfo,
} from "../src/watch/github.js";

const BRANCHES = ["main", "master", "production"];

const run = (over: Partial<RunInfo>): RunInfo => ({
  id: 1,
  head_branch: "main",
  conclusion: "failure",
  name: "CI",
  head_sha: "abcdef1234567",
  actor: { login: "umberto" },
  ...over,
});

// Three sentences, spec format: what. why. next ("If it were me").
function assertPingShape(ping: string): void {
  assert.match(ping, /If it were me:/);
  assert.ok(ping.trim().endsWith("."), "ping must end with a period");
  assert.equal((ping.match(/\. /g) ?? []).length, 2, `not three sentences: ${ping}`);
}

test("runs: first sight is a baseline — no pings, everything marked seen", () => {
  const r = judgeRuns([run({ id: 7 })], BRANCHES, undefined);
  assert.equal(r.pings.length, 0);
  assert.deepEqual(r.seen, [7]);
});

test("runs: a new failure on main pings once, in the right shape", () => {
  const first = judgeRuns([run({ id: 8 })], BRANCHES, [7]);
  assert.equal(first.pings.length, 1);
  assertPingShape(first.pings[0]!);
  assert.match(first.pings[0]!, /CI failed on main/);
  // same run again: silence
  const second = judgeRuns([run({ id: 8 })], BRANCHES, first.seen);
  assert.equal(second.pings.length, 0);
});

test("runs: green, feature-branch, and bot runs never ping", () => {
  const runs = [
    run({ id: 10, conclusion: "success" }),
    run({ id: 11, head_branch: "feature/x" }),
    run({ id: 12, actor: { login: "dependabot[bot]" } }),
  ];
  assert.equal(judgeRuns(runs, BRANCHES, []).pings.length, 0);
});

test("pushes: hotfix/rollback ping, main does not, and only once", () => {
  assert.ok(isEmergencyRef("refs/heads/hotfix/payment-bug"));
  assert.ok(isEmergencyRef("refs/heads/rollback/v2"));
  assert.ok(!isEmergencyRef("refs/heads/main"));
  const ev = (id: string, ref: string): PushEventInfo => ({
    id,
    type: "PushEvent",
    actor: { login: "umberto" },
    payload: { ref },
  });
  const first = judgePushEvents([ev("a", "refs/heads/hotfix/x"), ev("b", "refs/heads/main")], []);
  assert.equal(first.pings.length, 1);
  assertPingShape(first.pings[0]!);
  const second = judgePushEvents([ev("a", "refs/heads/hotfix/x")], first.seen);
  assert.equal(second.pings.length, 0);
});

test("stale PRs: 48h silence pings once per stretch; activity resets; bots never", () => {
  const now = new Date("2026-08-15T12:00:00Z");
  const old = "2026-08-10T12:00:00Z";
  const pr = (over: Partial<PrInfo>): PrInfo => ({
    number: 5,
    title: "Add pricing page",
    updated_at: old,
    user: { login: "umberto" },
    ...over,
  });
  const marks: Record<string, string> = {};
  const first = judgeStalePRs("r/x", [pr({})], 48, marks, now);
  assert.equal(first.length, 1);
  assertPingShape(first[0]!);
  assert.match(first[0]!, /no activity for 5 days/);
  // still stale, already pinged for this silence: quiet
  assert.equal(judgeStalePRs("r/x", [pr({})], 48, marks, now).length, 0);
  // new activity, then stale again: pings again
  const later = judgeStalePRs("r/x", [pr({ updated_at: "2026-08-12T12:00:00Z" })], 48, marks, now);
  assert.equal(later.length, 1);
  // fresh and bot PRs: never
  assert.equal(judgeStalePRs("r/x", [pr({ number: 6, updated_at: now.toISOString() })], 48, marks, now).length, 0);
  assert.equal(judgeStalePRs("r/x", [pr({ number: 7, user: { login: "dependabot[bot]" } })], 48, marks, now).length, 0);
});

test("alerts: HIGH and CRITICAL ping once; MEDIUM never", () => {
  const alert = (n: number, severity: string): AlertInfo => ({
    number: n,
    security_advisory: { severity, cve_id: "CVE-2026-0001" },
    dependency: { package: { name: "left-pad" } },
  });
  const first = judgeAlerts([alert(1, "critical"), alert(2, "medium"), alert(3, "high")], undefined);
  assert.equal(first.pings.length, 2);
  for (const p of first.pings) assertPingShape(p);
  const second = judgeAlerts([alert(1, "critical"), alert(3, "high")], first.pinged);
  assert.equal(second.pings.length, 0);
});

test("dormancy: needs a real 4-week streak, not scattered commits", () => {
  const quiet = Array(20).fill(0);
  assert.ok(hadWeeklyStreak([...quiet, 1, 2, 3, 1, ...quiet]));
  assert.ok(!hadWeeklyStreak([1, 0, 1, 0, 1, 0, 1, 0]));
  assert.ok(!hadWeeklyStreak([]));
  assert.ok(!hadWeeklyStreak(quiet));
});
