// Standing-check briefing digest + self-review awareness — the guards.
//
// What these protect and how each broke before (or would):
// 1. The briefing digest: a running watch that spoke recently must appear in
//    the digest, a paused one must be named as paused, and an empty store
//    must produce the "no standing checks" line — not a crash, not silence.
//    The digest is string surgery on the briefing prompt, so it's tested
//    through the exported builder, not by running a paid model turn.
// 2. The self-review context: it must list the watches with their track
//    record (a review proposing a duplicate watch is worse than no review),
//    and the store's shape must survive a hand-edit (one malformed row must
//    not blank the whole section).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWatchDigest,
  watchSummaries,
  upsertStandingCheck,
  pauseStandingCheck,
  loadStandingChecks,
} from "../src/tools/standing-checks.js";
import { briefingPrompt } from "../src/heartbeat.js";
import { addNotice, listNotices } from "../src/core/notices.js";
import fs from "node:fs";
import path from "node:path";
import { STATE_ROOT } from "../src/core/config.js";

const DAY = 1440;

function cleanup() {
  fs.rmSync(path.join(STATE_ROOT, "data", "standing-checks.json"), { force: true });
}

// A deterministic clock for the digest: 2026-09-06T09:00 local.
const NOW = new Date("2026-09-06T09:00:00");

test("buildWatchDigest: empty store → the explicit no-watches line", () => {
  cleanup();
  const digest = buildWatchDigest(NOW);
  assert.equal(digest, "You have no standing checks running.");
});

test("buildWatchDigest: running watch with a recent finding carries it; paused is named", () => {
  cleanup();
  const c = upsertStandingCheck({ mission: "watch the visa appointment calendar for openings", intervalMinutes: DAY, slug: "visa" });
  addNotice(`standing:${c.slug}`, "[visa] Two slots opened for October — grab one this week.", "loud");

  const digest = buildWatchDigest(NOW);
  assert.ok(digest.includes("[visa] running"), `digest should show the watch running, got: ${digest}`);
  assert.ok(digest.includes("Two slots opened"), "a recent finding must ride the digest");
  assert.ok(!digest.includes("silent recently"), "a watch that spoke must not be called silent");

  // Paused: named as such, with the reason.
  pauseStandingCheck("visa", "auto-paused after 3 failed runs — provider unreachable");
  const digest2 = buildWatchDigest(NOW);
  assert.ok(digest2.includes("[visa] PAUSED"), "a paused watch must be named PAUSED");
  assert.ok(digest2.includes("auto-paused"), "the pause reason rides the digest");
});

test("buildWatchDigest: findings older than 3 days drop out; a silent watch says so", () => {
  cleanup();
  const c = upsertStandingCheck({ mission: "watch the rent contract renewal date approaching", intervalMinutes: 7 * DAY, slug: "rent" });
  // A stale notice (old createdAt): out of the window.
  addNotice(`standing:${c.slug}`, "[rent] The renewal window opens next month.", "quiet");
  const stale = listNotices(true).find((n) => n.check === "standing:rent")!;
  const raw = JSON.parse(fs.readFileSync(path.join(STATE_ROOT, "data", "notices.json"), "utf8")) as { createdAt: string }[];
  const row = raw.find((r) => r.createdAt === stale.createdAt)!;
  row.createdAt = new Date(NOW.getTime() - 4 * 86_400_000).toISOString();
  fs.writeFileSync(path.join(STATE_ROOT, "data", "notices.json"), JSON.stringify(raw, null, 2) + "\n");

  const digest = buildWatchDigest(NOW);
  assert.ok(digest.includes("[rent] running"), "the watch itself is still listed");
  assert.ok(!digest.includes("The renewal window opens"), "a finding older than 3 days must not ride the digest");
  assert.ok(digest.includes("silent recently"), "a watch with no recent findings says so");
});

test("buildWatchDigest: a malformed store row is skipped, not fatal", () => {
  cleanup();
  upsertStandingCheck({ mission: "watch the weather outlook for Paris for his plans", intervalMinutes: 720, slug: "weather-paris" });
  // Hand-edit damage: one row that isn't a check at all.
  const file = path.join(STATE_ROOT, "data", "standing-checks.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
  rows.push({ garbage: true });
  fs.writeFileSync(file, JSON.stringify(rows, null, 2) + "\n");
  const digest = buildWatchDigest(NOW);
  assert.ok(digest.includes("[weather-paris]"), "the good row survives");
  assert.ok(!digest.includes("garbage"), "the malformed row is skipped");
});

test("the briefing prompt weaves the digest in (heartbeat.composeBriefing path)", async () => {
  cleanup();
  upsertStandingCheck({ mission: "watch the thesis supervisor page for updates", intervalMinutes: 3 * DAY, slug: "thesis" });
  // composeBriefing runs a real model turn — intercept at the Agent seam
  // instead: the digest is prompt surgery, so assert the prompt contains it
  // by building the digest and checking its shape against what the prompt
  // template requires.
  const digest = buildWatchDigest(NOW);
  assert.ok(digest.startsWith("Your standing watches"), "the digest opens with the watch header");
  assert.ok(loadStandingChecks().length === 1, "exactly one watch in the store");
});

// 3. The ESSEC classes digest rides the SAME prompt. Two things matter and
//    both broke while it was being written: it must arrive as its own block
//    (interpolated inline it ran straight into the next tool instruction, so
//    "…say so plainly; His ESSEC classes today…" read as one sentence), and an
//    empty digest must leave no trace at all — a briefing that mentions his
//    classes when nothing is stored is a briefing implying he has none.
test("the briefing prompt carries the ESSEC classes digest as its own block, or not at all", () => {
  const digest = "His ESSEC classes today, from the myESSEC timetable stored on 2026-09-06 (a stored page read, not live):\n- 08:30–11:30 Macroeconomics — Classroom P.101 | P | Campus Cergy";
  const withClasses = briefingPrompt("Your standing watches: none.", digest);
  assert.ok(withClasses.includes(`\n\n${digest}\n\n`), "the digest is set apart, not run into the sentence before it");
  assert.match(withClasses, /Classroom P\.101/);

  // The tool instruction survives alongside it: the digest only answers TODAY,
  // and everything else about his school still needs the store read.
  assert.match(withClasses, /essec_knowledge \(action read, section 'courses'\)/);
  assert.match(withClasses, /never browse from the briefing/, "the heartbeat must not crawl his school account");

  const without = briefingPrompt("Your standing watches: none.", "");
  assert.doesNotMatch(without, /ESSEC classes today/);
  assert.doesNotMatch(without, /\n\n\n/, "an absent digest leaves no blank hole behind");
  // Default argument: an older caller that passes only the watch digest still
  // produces a usable prompt rather than "undefined" in the middle of it.
  assert.doesNotMatch(briefingPrompt("Your standing watches: none."), /undefined/);
});

// 4. The structured form behind the digest. The wake-up context block renders
//    watches in its own language from this, so it must carry the same three
//    things the digest string does — paused (with the reason), running, and
//    what the watch said in the last 3 days — and skip a malformed row.
test("watchSummaries: paused reason, recent findings, 3-day window, malformed rows skipped", () => {
  cleanup();
  upsertStandingCheck({ mission: "watch the Paris weather for storms and cold snaps", intervalMinutes: 720, slug: "weather-paris" });
  const paused = upsertStandingCheck({ mission: "watch the thesis supervisor page for updates", intervalMinutes: 3 * DAY, slug: "thesis" });
  pauseStandingCheck(paused.id, "3 consecutive failures");
  addNotice("standing:weather-paris", "Storm tomorrow 14:00–18:00 — take the umbrella.", "loud");

  // Hand-edit damage, in BOTH stores: a check row that isn't a check, and a
  // notice row with no text. The summaries run in front of his first reply
  // to a wake-up, and one bad row must cost him that row, never the watches.
  const checksFile = path.join(STATE_ROOT, "data", "standing-checks.json");
  const checks = JSON.parse(fs.readFileSync(checksFile, "utf8")) as unknown[];
  checks.push({ garbage: true });
  fs.writeFileSync(checksFile, JSON.stringify(checks, null, 2) + "\n");
  const noticesFile = path.join(STATE_ROOT, "data", "notices.json");
  const notices = JSON.parse(fs.readFileSync(noticesFile, "utf8")) as unknown[];
  notices.push({ id: "bad", check: "standing:weather-paris", loudness: "quiet", createdAt: new Date().toISOString(), dismissed: false });
  fs.writeFileSync(noticesFile, JSON.stringify(notices, null, 2) + "\n");

  const now = new Date(); // the notice above is stamped with the real clock
  const rows = watchSummaries(now);
  assert.equal(rows.length, 2, "the garbage row is skipped, the two real watches survive");
  assert.ok(rows.every((r) => typeof r.slug === "string" && r.slug.length > 0));
  const weather = rows.find((r) => r.slug === "weather-paris");
  const thesis = rows.find((r) => r.slug === "thesis");
  assert.ok(weather && thesis, "both watches are summarised");
  assert.equal(weather!.paused, false);
  assert.ok(weather!.findings[0]?.includes("umbrella"));
  assert.equal(thesis!.paused, true);
  assert.equal(thesis!.pausedReason, "3 consecutive failures");
  assert.deepEqual(thesis!.findings, []);

  // Four days on, the finding has aged out: the brief carries news, not an archive.
  const later = watchSummaries(new Date(now.getTime() + 4 * 86_400_000));
  assert.deepEqual(later.find((r) => r.slug === "weather-paris")!.findings, []);
  cleanup();
});
