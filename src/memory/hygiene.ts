// Memory hygiene: the clock that keeps the index honest.
//
// Memories are point-in-time facts with no expiry. "Barcelona holiday 15–20
// August 2026" sat live in the index a month after the holiday ended, and
// nothing would ever have flagged it — EVE kept "knowing" a past event as if
// it were current. This module is the scan that notices.
//
// Doctrine: it PROPOSES, never touches. The scan is pure over the store
// (plus an injectable clock); acting on a flag — retire, verify, forget — is
// Umberto's call, delivered as a quiet notice, same as self-review. Nothing
// here writes to memory/store/ directly.
import { listMemories } from "./store.js";

export interface HygieneFlag {
  name: string;
  reason: "period-passed" | "expired";
  /** The date or range that ended, as written in the memory. */
  evidence: string;
  hook: string;
}

// ── the date scanner ───────────────────────────────────────────────────────
// Finds DATES AND RANGES in prose that have plainly ENDED before `today`.
// Deliberately conservative — a false positive costs a real memory's place in
// the index (a nag every week about a memory that is fine trains Umberto to
// ignore hygiene notices), while a false negative only delays a flag by a
// week until the next scan.
//
// Three shapes, all requiring a YEAR (a yearless date is ambiguous and never
// actionable):
//   1. day-precision: "15–20 August 2026", "15-20 August 2026", "2026-08-15"
//   2. month-precision: "August 2026", "Aug 2026" — flagged only once the
//      WHOLE month has ended
//   3. bare day + month + year: "20 Aug 2026"
// The scanner returns the matched text and its end date; interpretation
// ("has it ended?") stays in the caller's injectable clock.

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, febbraio: 2, february: 2, feb: 2, marzo: 3, march: 3, mar: 3,
  aprile: 4, april: 4, apr: 4, maggio: 5, may: 5, mag: 5, giugno: 6, june: 6, jun: 6,
  luglio: 7, july: 7, jul: 7, agosto: 8, august: 8, aug: 8, settembre: 9, september: 9,
  sep: 9, sett: 9, ottobre: 10, october: 10, oct: 10, ott: 10, novembre: 11, november: 11,
  nov: 11, dicembre: 12, december: 12, dec: 12, dic: 12,
};

const monthEnd = (year: number, month: number, day?: number): Date =>
  new Date(Date.UTC(year, month - 1, day ?? new Date(Date.UTC(year, month, 0)).getUTCDate()));

export interface PassedDate {
  text: string;
  endedAt: Date;
}

export function findPassedDates(text: string, today: Date): PassedDate[] {
  const out: PassedDate[] = [];
  const lower = text.toLowerCase();

  // 1. ISO dates: 2026-08-20 (an end or single day)
  for (const m of lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getTime() < today.getTime()) out.push({ text: m[0], endedAt: d });
  }

  // 2. Day ranges with a named month + year: "15–20 august 2026",
  //    "15-20 august 2026", also single days "20 aug 2026".
  for (const m of lower.matchAll(/\b(\d{1,2})(?:\s*[–—-]\s*(\d{1,2}))?\s+([a-z]+)\.?\s+(\d{4})\b/g)) {
    const month = MONTHS[m[3]!];
    if (!month) continue;
    const year = Number(m[4]);
    const endDay = m[2] ? Number(m[2]) : Number(m[1]);
    const d = monthEnd(year, month, endDay);
    if (d.getTime() < today.getTime()) out.push({ text: m[0], endedAt: d });
  }

  // 3. Bare month + year: "august 2026", "settembre 2026" — month precision,
  //    flagged only once the month has fully ended.
  for (const m of lower.matchAll(/\b([a-z]+)\.?\s+(\d{4})\b/g)) {
    const month = MONTHS[m[1]!];
    if (!month) continue;
    const year = Number(m[2]);
    const d = monthEnd(year, month); // last day of that month
    if (d.getTime() < today.getTime()) out.push({ text: m[0], endedAt: d });
  }

  return out;
}

// ── the scan over the store ────────────────────────────────────────────────
// A memory is flagged when:
//   - its explicit `expires` date has passed (and it was not verified after
//     that date — verified means checked against reality, so nagging about
//     it would be noise), or
//   - its hook or body names a date or range that has plainly ended — a
//     memory ABOUT a past period, still presented as current knowledge.
// Timeless preferences ("dislikes tofu") carry no dates and never flag.
export function memoryHygiene(today: Date = new Date()): HygieneFlag[] {
  const flags: HygieneFlag[] = [];
  for (const mem of listMemories()) {
    // Explicit expiry beats prose scanning — it is a deliberate field.
    if (mem.expires) {
      const exp = new Date(`${mem.expires}T23:59:59Z`);
      if (!Number.isNaN(exp.getTime()) && exp.getTime() < today.getTime()) {
        // Recently verified memories are not re-flagged: `verified` means
        // someone checked it against reality on that date.
        if (mem.verified && Date.parse(`${mem.verified}T23:59:59Z`) >= exp.getTime()) continue;
        flags.push({ name: mem.name, reason: "expired", evidence: mem.expires, hook: mem.hook });
      }
      continue; // an explicit expiry is authoritative; no double flagging
    }
    const passed = findPassedDates(`${mem.hook}\n${mem.body}`, today);
    if (passed.length > 0) {
      // Same courtesy for prose dates: verified after the period ended means
      // someone looked at it and left it standing.
      const latest = passed.reduce((a, b) => (a.endedAt > b.endedAt ? a : b));
      if (mem.verified && Date.parse(`${mem.verified}T23:59:59Z`) >= latest.endedAt.getTime()) continue;
      flags.push({ name: mem.name, reason: "period-passed", evidence: latest.text, hook: mem.hook });
    }
  }
  return flags;
}

// The notice text a hygiene flag becomes — quiet, actionable, no content leak
// beyond what already rides in INDEX.md (hooks only).
export function hygieneNotice(flags: HygieneFlag[]): string | null {
  if (flags.length === 0) return null;
  const lines = flags.map(
    (f) => `- [${f.name}] "${f.hook}" — ${f.reason === "expired" ? `expired ${f.evidence}` : `its period (${f.evidence}) has passed`}`,
  );
  return (
    `Some memories may be stale — a date or period they name has ended:\n${lines.join("\n")}\n` +
    `Ask Umberto whether to retire each one (save_memory with supersedes), update it, or keep it.`
  );
}
