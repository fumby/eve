// Memory hygiene — the clock that keeps the index honest.
//
// The failure this file guards against: memories are point-in-time facts with
// no expiry. "Barcelona holiday 15–20 August 2026" sat live in the index a
// month after the holiday ended, and nothing would ever have flagged it. EVE
// kept "knowing" a past event as if it were current — exactly the context rot
// the memory structure exists to prevent.
//
// The fix under test: a PURE scanning function, memoryHygiene(), that finds
// memories whose referenced period has plainly PASSED (a date or range in the
// hook/body that ended before today), plus an expiry field the scan honours.
// It proposes; it never touches the store. Acting is Umberto's call (via a
// quiet notice) — same doctrine as self-review.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-hygiene-"));

const { saveMemory, getMemory, listMemories } = await import("../src/memory/store.js");
const { memoryHygiene, findPassedDates } = await import("../src/memory/hygiene.js");

// A fixed clock: the tests must not depend on when the suite runs.
const TODAY = new Date("2026-09-06T12:00:00+02:00");

// ── the date scanner, pure and injectable ──────────────────────────────────

test("findPassedDates spots a plain past date and a past range", () => {
  const past = findPassedDates("Holiday runs 15–20 August 2026.", TODAY);
  assert.ok(past.length > 0, "a range that ended before today was not seen as past");
  const future = findPassedDates("Thesis defense is in November 2026.", TODAY);
  assert.equal(future.length, 0, "a future month was flagged as past");
  const none = findPassedDates("He dislikes tofu and certain legumes.", TODAY);
  assert.equal(none.length, 0, "a timeless preference was flagged as past");
});

test("findPassedDates needs a YEAR — 15–20 August with no year is not actionable", () => {
  const noYear = findPassedDates("Trip planned 15–20 August.", TODAY);
  assert.equal(noYear.length, 0, "a yearless range must not be flagged: it is ambiguous, and a false positive costs a real memory");
});

test("findPassedDates honours month granularity — September 2026 has not ended on Sep 6", () => {
  // "in September 2026" is still current on Sep 6: the month has not finished.
  const current = findPassedDates("The exam session falls in September 2026.", TODAY);
  assert.equal(current.length, 0, "a still-running month was treated as ended");
  // …but August 2026 has fully ended by Sep 6.
  const ended = findPassedDates("The sublet ran through August 2026.", TODAY);
  assert.ok(ended.length > 0);
});

test("ISO dates and 'd MMM YYYY' both parse", () => {
  assert.ok(findPassedDates("Deadline was 2026-08-20.", TODAY).length > 0);
  assert.ok(findPassedDates("Deadline was 20 Aug 2026.", TODAY).length > 0);
  // Day precision: 1 September is already past on 6 September — the month
  // itself being current only protects the BARE "September 2026" form.
  "Jan Feb Mar Apr May Jun Jul Aug Sep".split(" ").forEach((m) => {
    assert.ok(
      findPassedDates(`Refill due 1 ${m} 2026.`, TODAY).length > 0,
      `1 ${m} 2026 should be past on 2026-09-06`,
    );
  });
  "Oct Nov Dec".split(" ").forEach((m) => {
    assert.equal(
      findPassedDates(`Refill due 1 ${m} 2026.`, TODAY).length,
      0,
      `1 ${m} 2026 should NOT be past on 2026-09-06`,
    );
  });
});

// ── the scan over the store, proposing only ────────────────────────────────

test("memoryHygiene flags a memory whose period has passed — and proposes nothing else", () => {
  saveMemory({
    type: "personal",
    hook: "Barcelona holiday: 15–20 August 2026",
    body: "He will be in Barcelona those days. Plan around it.",
  });
  saveMemory({
    type: "me",
    hook: "Umberto dislikes tofu and certain legumes",
    body: "A lasting food preference. Applies to every food choice.",
  });
  const flags = memoryHygiene(TODAY);
  const barca = flags.find((f) => f.name.includes("barcelona"));
  assert.ok(barca, "the past-period memory was not flagged");
  assert.equal(barca!.reason, "period-passed");
  assert.ok(
    !flags.some((f) => f.name.includes("tofu")),
    "a timeless preference must never be flagged",
  );
});

test("a memory with an explicit expires field is flagged when past", () => {
  saveMemory({
    type: "reference",
    hook: "Uber Eats voucher ZTX10 valid until 1 September 2026",
    body: "Code on the account. One use.",
    expires: "2026-09-01",
  });
  const flags = memoryHygiene(TODAY);
  const voucher = flags.find((f) => f.name.includes("ztx10"));
  assert.ok(voucher, "the explicit expiry was not honoured");
  assert.equal(voucher!.reason, "expired");
});

test("an expired-but-verified memory is NOT flagged again", () => {
  // Verified means checked against reality recently; nagging about it every
  // week would train Umberto to ignore the hygiene notices.
  saveMemory({
    type: "reference",
    hook: "ZTX11 voucher expired quietly",
    body: "It was used up long ago.",
    expires: "2026-08-01",
    verified: "2026-09-05",
  });
  const flags = memoryHygiene(TODAY);
  assert.ok(!flags.some((f) => f.name.includes("ztx11")), "a recently-verified memory must not be re-flagged");
});

test("a future expires date is never a flag", () => {
  saveMemory({
    type: "project",
    hook: "ZTX12 exam window opens 1 December 2026",
    body: "Registration needed before then.",
    expires: "2026-12-01",
  });
  const flags = memoryHygiene(TODAY);
  assert.ok(!flags.some((f) => f.name.includes("ztx12")));
});

test("confirmed and inferred memories are flagged alike — stale is stale", () => {
  saveMemory({
    type: "personal",
    hook: "ZTX13 Napoli trip 10–12 July 2026",
    body: "Short visit, back Sunday.",
  });
  const flags = memoryHygiene(TODAY);
  assert.ok(flags.some((f) => f.name.includes("ztx13")));
});

test("the scan proposes — it never touches the store", () => {
  const before = listMemories().length;
  memoryHygiene(TODAY);
  assert.equal(listMemories().length, before, "the scan must not save, retire or delete anything");
  const barca = getMemory("barcelona-holiday-15-20-august-2026");
  assert.ok(barca, "the flagged memory is untouched on disk");
  assert.ok(!barca!.supersededBy, "the flagged memory must not be retired by the scan");
});

test("retired memories are out of scope — the index is what needs hygiene", () => {
  saveMemory({
    type: "personal",
    hook: "ZTX14 old flat viewing 3 June 2026",
    body: "Scheduled for the afternoon.",
  });
  saveMemory({
    type: "personal",
    hook: "ZTX14b replacement note for the viewing",
    body: "The viewing happened; the new flat is in Cergy.",
    supersedes: "ztx14-old-flat-viewing-3-june-2026",
  });
  const flags = memoryHygiene(TODAY);
  assert.ok(!flags.some((f) => f.name.includes("ztx14-old")), "a retired memory must not be flagged");
});
