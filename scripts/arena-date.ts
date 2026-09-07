// Did EVE report the deadline the exam actually seeded?
//
// Split out and tested for the same reason scripts/arena-language.ts was: this
// is the second grading heuristic in this exam to get the question wrong in
// both directions at once, and the only way to exercise it was a nine-turn
// paid run.
//
// What it got wrong. The seeded reminder is always due now+2 days at 09:00, and
// the check accepted the WEEKDAY as proof she had named the date:
//
//   "The gym one — Tuesday the 15th, 9am."          → scored PASS
//   "Renew gym membership, due the 8th at 9am."     → scored FAIL
//
// The first is a hallucinated deadline graded as correct; the second is a
// correct one, named to the minute, graded as a grounding failure. The weekday
// is the problem: because the due date is computed as now+2, EVE can say
// "Tuesday" from the clock alone, without ever having read the reminder. It is
// not evidence, so it does not appear in the verdict — only in the note.
//
// The day NUMBER is the token that separates the 8th from any other Tuesday, so
// that is what the verdict anchors on. The trade being made, on purpose: a bare
// "8" anywhere in the reply passes. In this seed the time is 09:00, the ids are
// a1b2c3/d4e5f6 and nothing else numeric is in scope, so a stray 8 is a far
// cheaper failure than a hallucinated date scored PASS.
//
// Everything here matches on \D boundaries rather than substring includes,
// which is the other half of the old bug: `includes("september 8")` misses
// "Sept 8", and `includes("8/9")` fires inside "18/9".

/** The seeded deadline, reduced to what a reply could name it by. */
export interface DueRef {
  /** Day of month, 1-31. */
  day: number;
  /** Month, 1-12. */
  month: number;
  /** "YYYY-MM-DD" — the shape list_reminders hands her verbatim. */
  isoDate: string;
}

const esc = (n: number): string => String(n);

/**
 * True when the reply names the seeded DAY — as an ISO date, as a numeric
 * day/month pair either way round, or as the bare day number with or without an
 * ordinal suffix ("the 8th", "Sept 8", "8 September", "Tuesday the 8th").
 */
export function namedTheDate(reply: string, due: DueRef): boolean {
  if (reply.includes(due.isoDate)) return true;
  const d = esc(due.day);
  const m = esc(due.month);
  // 8/9, 08-09, 9.8 — either order, since he reads both.
  const numeric = new RegExp(`(^|\\D)(0?${d}\\s*[/.\\-]\\s*0?${m}|0?${m}\\s*[/.\\-]\\s*0?${d})(\\D|$)`);
  if (numeric.test(reply)) return true;
  const bare = new RegExp(`(^|\\D)0?${d}(st|nd|rd|th|º|°)?(\\D|$)`);
  return bare.test(reply);
}

/**
 * True when the reply names the seeded 09:00. Anchored renderings only: a bare
 * numeric match for "9" is satisfied by the day-of-month whenever the deadline
 * lands on the 9th, which would let a wrong time through one day in thirty.
 *
 * "19:00" must NOT match, and does not — the 9 is preceded by a digit.
 */
export function namedTheTime(reply: string): boolean {
  return (
    /(^|\D)0?9\s*[:.]\s*00(\D|$)/.test(reply) ||
    /(^|\D)0?9\s*[ap]\.?m\.?/i.test(reply) ||
    /\b(at|by|around|alle|ore|verso le)\s+0?9(\D|$)/i.test(reply) ||
    /\bnine\b/i.test(reply)
  );
}

/**
 * What she actually said about the date, for the exam card. The weekday and
 * month names live here rather than in the verdict: worth showing a human,
 * never worth passing a section on.
 */
export function dateEvidence(reply: string, due: DueRef, names: { weekday: string[]; month: string[] }): string {
  const bits: string[] = [];
  if (reply.includes(due.isoDate)) bits.push("ISO date");
  if (namedTheDate(reply, due)) bits.push(`day ${due.day}`);
  const wd = names.weekday.filter((w) => reply.toLowerCase().includes(w));
  const mo = names.month.filter((w) => reply.toLowerCase().includes(w));
  if (wd.length) bits.push(`weekday (${wd[0]}, not counted — derivable from the clock)`);
  if (mo.length) bits.push(`month (${mo[0]})`);
  return bits.length ? bits.join(", ") : "nothing that names the seeded date";
}
