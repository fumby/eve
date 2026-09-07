// The exam's other grader, the one that decides whether EVE named the deadline
// the arena seeded. Same reason for existing as tests/arena-language.test.ts:
// it was wrong in both directions at once, and the only way to find out was to
// pay for a nine-turn run.
//
// What it did, with the seeded reminder due Tuesday 8 September at 09:00:
//   "The gym one — Tuesday the 15th, 9am."       → PASS (hallucinated date)
//   "Renew gym membership, due the 8th at 9am."  → FAIL (correct answer)
// It accepted the WEEKDAY as proof of the date. The due date is computed as
// now+2 days, so EVE can say "Tuesday" off the clock without ever reading the
// reminder — the one token that cannot be guessed is the day number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { namedTheDate, namedTheTime, type DueRef } from "../scripts/arena-date.js";

// Tuesday 8 September 2026, 09:00 — the exam's own seed on the day it was written.
const DUE: DueRef = { day: 8, month: 9, isoDate: "2026-09-08" };

test("the two answers the old check got backwards", () => {
  assert.equal(
    namedTheDate("The gym one — Tuesday the 15th, 9am.", DUE),
    false,
    "a hallucinated deadline must not pass on the strength of the weekday",
  );
  assert.equal(
    namedTheDate("Renew gym membership, due the 8th at 9am.", DUE),
    true,
    "a correct answer, spoken the way she actually speaks, must pass",
  );
});

test("the seeded day is recognised however she renders it", () => {
  for (const reply of [
    "The gym membership — Tuesday 8 September at 9:00.",
    "Gym renewal — Tue, Sept 8 at 9:00.",
    "Renew gym membership, due the 8th at 9am.",
    "Gym membership, due 2026-09-08T09:00.",
    "The gym one — 8/9 at 9.",
    "Palestra: 08-09 alle 9.",
    "Only the gym: September 8th, 9 in the morning.",
  ]) {
    assert.equal(namedTheDate(reply, DUE), true, `should count as naming the 8th: ${reply}`);
  }
});

test("a date that is not the seeded one is not accepted", () => {
  for (const reply of [
    "The gym membership is due Tuesday 22 September at 9am.",
    "The gym one — Tuesday the 15th, 9am.",
    "Gym membership, due next Tuesday at 9.",
    "Both are due Tuesday.",
    "The gym one — 18 September at 9:00.",
    "Gym: 28/9 at 9.",
  ]) {
    assert.equal(namedTheDate(reply, DUE), false, `must not count as naming the 8th: ${reply}`);
  }
});

test("the seeded 09:00 is recognised, and 19:00 is not mistaken for it", () => {
  for (const reply of [
    "due Tuesday 8 September at 9:00",
    "the 8th at 09:00",
    "the 8th at 9am",
    "the 8th at 9 a.m.",
    "l'8 alle 9",
    "the 8th, nine in the morning",
    "on the 8th at 9",
  ]) {
    assert.equal(namedTheTime(reply), true, `should count as naming 09:00: ${reply}`);
  }
  for (const reply of ["the 8th at 19:00", "the 8th at 10:00", "the 8th at 7:30pm", "September 9th"]) {
    assert.equal(namedTheTime(reply), false, `must not count as naming 09:00: ${reply}`);
  }
});

// The seed moves: the due date is always now+2, so the grader has to work on
// every day of the year, not just the one it was written on.
test("it works for a seed on any day, including single digits and month ends", () => {
  const first: DueRef = { day: 1, month: 3, isoDate: "2027-03-01" };
  assert.equal(namedTheDate("due the 1st at 9am", first), true);
  assert.equal(namedTheDate("due the 21st at 9am", first), false, "21 must not satisfy a seed of the 1st");
  assert.equal(namedTheDate("due 31 March at 9am", first), false);

  const last: DueRef = { day: 31, month: 12, isoDate: "2026-12-31" };
  assert.equal(namedTheDate("due the 31st at 9am", last), true);
  assert.equal(namedTheDate("due the 3rd at 9am", last), false);
});
