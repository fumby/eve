// Umberto's calendar — the single thing a secretary does first: tell him
// what his day looks like. Read-only via osascript + Calendar.app.
//
// Three live-caught bugs shaped this file:
//   1. `date "2026-09-06T22:00:00.000Z"` — AppleScript parses that ISO
//      string as MARCH 2012 on this Mac. Any date passed as a string was
//      garbage, so the old reader queried a nonsense range. Dates are now
//      built inside AppleScript from numeric components.
//   2. `text 1 thru 2 of (d as string)` to get the hour assumes the US
//      date format; this Mac renders "Sunday, 6 September 2026…", so the
//      "hour" extracted was "Su". Times now come back as epoch seconds,
//      computed against a component-built 1970 reference — no string
//      parsing anywhere, in either direction.
//   3. One glitchy subscribed calendar made `every event` error mid-list
//      (-1728) and kill the whole query. Each calendar is now its own
//      try block: one bad calendar costs its own events, not the day.
//   4. The query asked for events whose START fell inside the window, so an
//      event already running when the window opened was not returned at all
//      — from 10:00, a 09:00–13:00 block did not exist and the day read as
//      clear. The whose clause now tests interval OVERLAP. The same read
//      could also come back short in two silent ways (a calendar that
//      errored, the event cap); both now travel back as marker lines and
//      every answer built from them says so.
// Values cross the bridge as osascript ARGUMENTS (data, not script) and as
// tab-separated epoch/text coming back.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { runAppleScript, ensureAppRunning } from "./applescript.js";

const CALENDAR_APP = "/System/Applications/Calendar.app";

// One AppleScript date built from five numeric argv items, offset by base.
// `day of d to 1` FIRST: setting month on the 31st rolls the date over
// (May 31 → February → March 3) — verified-classic AppleScript trap.
const DATE_FROM_ARGV = (base: string, y: number, m: number, d: number, h: number, min: number) => `
  set ${base} to current date
  set day of ${base} to 1
  set year of ${base} to (item ${y} of argv as integer)
  set month of ${base} to (item ${m} of argv as integer)
  set day of ${base} to (item ${d} of argv as integer)
  set hours of ${base} to (item ${h} of argv as integer)
  set minutes of ${base} to (item ${min} of argv as integer)
  set seconds of ${base} to 0`;

// Tab-separated: epochStart <TAB> epochEnd <TAB> summary <TAB> location <TAB> calendar
// (summary/location can't contain tabs — AppleScript strings from Calendar
// don't carry them, and a newline in a title would break line-splitting, so
// both are scrubbed in-script.)
const EVENTS_SCRIPT = `on run argv
${DATE_FROM_ARGV("f", 1, 2, 3, 4, 5)}
${DATE_FROM_ARGV("t", 6, 7, 8, 9, 10)}
  set maxN to (item 11 of argv as integer)
  set out to ""
  set n to 0
  set capped to false
  tell application "Calendar"
    repeat with c in calendars
      set calName to "(unnamed calendar)"
      try
        set calName to (name of c)
      end try
      -- One bad calendar (a subscribed calendar whose events can't all be
      -- fetched) must cost its own events, not the whole day. Verified live.
      -- It must NOT cost them silently, though: the failure comes back as an
      -- ERR line on the same channel, because a swallowed error let the day
      -- be reported clear when a whole calendar had not been read.
      try
        -- OVERLAP, not "starts in the window": selecting on the start date
        -- alone dropped every event already running when the window opened,
        -- so a day with a 09:00-13:00 block looked clear from 10:00. Both
        -- properties carry \`its\` — a compound whose clause mis-parses
        -- without it on the second one.
        set evs to (every event of c whose (its start date is less than t) and (its end date is greater than f))
        repeat with e in evs
          if n is greater than or equal to maxN then
            set capped to true
            exit repeat
          end if
          try
            set s to (start date of e)
            set en to (end date of e)
            set evTitle to (summary of e)
            if evTitle is missing value then set evTitle to "(no title)"
            set evLoc to (location of e)
            if evLoc is missing value then set evLoc to ""
            -- Date COMPONENTS, not epoch seconds: AppleScript formats big
            -- numbers in the system locale — on this Mac that is Italian
            -- scientific notation ("1,7886672E+9"), which Number() cannot
            -- parse and every event silently vanished. Small numbers (year,
            -- month, day, hours, minutes) are rendered plainly in every
            -- locale. TS rebuilds the Date from the components.
            set y1 to year of s
            set mo1 to (month of s as integer)
            set d1 to day of s
            set h1 to hours of s
            set mi1 to minutes of s
            set y2 to year of en
            set mo2 to (month of en as integer)
            set d2 to day of en
            set h2 to hours of en
            set mi2 to minutes of en
            set cleanSum to evTitle
            set cleanLoc to evLoc
            set out to out & y1 & "	" & mo1 & "	" & d1 & "	" & h1 & "	" & mi1 & "	" & y2 & "	" & mo2 & "	" & d2 & "	" & h2 & "	" & mi2 & "	" & cleanSum & "	" & cleanLoc & "	" & calName & linefeed
            set n to n + 1
          end try
        end repeat
      on error errText
        -- Marker line on the same tab-separated channel. errText is scrubbed
        -- TS-side; it is not trusted to be one line.
        set out to out & "ERR" & "	" & calName & "	" & errText & linefeed
      end try
    end repeat
  end tell
  if capped then set out to out & "CAP" & "	" & maxN & linefeed
  return out
end run`;

interface CalEvent {
  start: Date;
  end: Date;
  summary: string;
  location: string;
  calendar: string;
}

// One field can never contain a tab (the delimiter); a newline would break
// line-splitting, so both are flattened HERE in TS rather than in
// AppleScript — string surgery is clearer in the language built for it.
const clean = (s: string): string => s.replace(/[	\r\n]/g, " ");

/**
 * What one bridge read actually produced: the events, plus the two ways the
 * answer can be incomplete. Both used to be invisible — a calendar that
 * errored was swallowed by the per-calendar try, and hitting the event cap
 * looked exactly like having no more events. Either one can turn "you're
 * booked" into "your day is clear", which is the failure that matters.
 */
export interface CalendarRead {
  events: CalEvent[];
  /** Calendars whose read errored, with why — named, so callers can name them. */
  failures: Array<{ calendar: string; why: string }>;
  /** True when the event cap was reached and events were left unread. */
  capped: boolean;
}

/**
 * Split the bridge's stdout into events and incompleteness markers. Pure and
 * exported so the marker handling can be tested against captured bridge
 * output without a Mac, a Calendar.app, or any events in it.
 */
export function parseCalendarRead(raw: string): CalendarRead {
  const failures: Array<{ calendar: string; why: string }> = [];
  let capped = false;
  const eventLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split("	");
    if (fields[0] === "ERR") {
      // An AppleScript error string may itself contain a newline, in which
      // case its tail arrives as a line of its own and is dropped as an
      // unparseable event line — the marker still reports WHICH calendar
      // failed, which is the part that changes what EVE may claim.
      failures.push({
        calendar: clean(fields[1] ?? "").trim() || "(unnamed calendar)",
        why: clean(fields.slice(2).join(" ")).trim().slice(0, 120),
      });
      continue;
    }
    if (fields[0] === "CAP") {
      capped = true;
      continue;
    }
    eventLines.push(line);
  }
  return { events: parseEvents(eventLines.join("\n")), failures, capped };
}

/**
 * The sentences a caller MUST append when the read was incomplete. Kept next
 * to the parser so no output path can forget one: a "free slot" computed
 * from a partial read is the dangerous case, not the merely untidy one.
 */
export function incompletenessNotes(read: CalendarRead): string[] {
  const notes: string[] = [];
  if (read.failures.length > 0)
    notes.push(`(some calendars could not be read: ${[...new Set(read.failures.map((f) => f.calendar))].join(", ")})`);
  if (read.capped) notes.push(`(list may be incomplete — event cap reached)`);
  return notes;
}

/**
 * What to say when the read came back with no events. Its own function
 * because it is the sentence that can do harm: "clear" is a claim about the
 * WHOLE calendar, and a read that lost a calendar or stopped at the cap has
 * not earned it. Pure, so the claim is testable without a Mac.
 */
export function emptyDayAnswer(span: string, notes: string[]): string {
  if (notes.length === 0) return `${span} is clear — nothing on the calendar.`;
  return `${span}: I found nothing on the calendar, but the read was incomplete, so I can't call it clear.\n${notes.join("\n")}`;
}

function parseEvents(raw: string): CalEvent[] {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("	");
      if (parts.length < 12) return null;
      const num = (v: string | undefined) => Number(v ?? NaN);
      const start = new Date(num(parts[0]), num(parts[1]) - 1, num(parts[2]), num(parts[3]), num(parts[4]));
      const end = new Date(num(parts[5]), num(parts[6]) - 1, num(parts[7]), num(parts[8]), num(parts[9]));
      return {
        start,
        end,
        summary: clean(parts.slice(10, -2).join("	")),
        location: clean(parts[parts.length - 2] ?? ""),
        calendar: clean(parts[parts.length - 1] ?? ""),
      };
    })
    .filter((e): e is CalEvent => e !== null && !isNaN(e.start.getTime()) && !isNaN(e.end.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

// Five numeric args per Date (AppleScript builds it component-wise).
function dateArgs(d: Date): string[] {
  return [
    String(d.getFullYear()),
    String(d.getMonth() + 1),
    String(d.getDate()),
    String(d.getHours()),
    String(d.getMinutes()),
  ];
}

/**
 * One read of the real calendar. Exported so a live check can point it at an
 * arbitrary window — the interval-overlap behaviour is only observable when
 * the window opens in the middle of an event.
 */
export async function fetchEvents(from: Date, to: Date, max: number): Promise<CalendarRead> {
  await ensureAppRunning(CALENDAR_APP, "Calendar");
  const raw = await runAppleScript(EVENTS_SCRIPT, [...dateArgs(from), ...dateArgs(to), String(max)]);
  return parseCalendarRead(raw);
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function dayLabelShort(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
function clock(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export const calendarTools: EveTool[] = [
  {
    name: "get_calendar",
    description:
      "Read Umberto's calendar for a day or range of days: what meetings and appointments he has, when they start, where, and which calendar they're on. Use this for the daily briefing ('what's my day'), any 'what do I have on / what's on today / what's on tomorrow' question, and before suggesting a time to meet. Read-only — you cannot create or move events with this tool (add_event can create one, and it's gated).",
    schema: z.object({
      days: z
        .number()
        .int()
        .min(1)
        .max(7)
        .default(1)
        .describe("How many days from the start to show. 1 = just that day, 2 = that day and the next, etc."),
      start: z
        .enum(["today", "tomorrow"])
        .default("today")
        .describe("Where to start the range."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const days = Number(input.days);
      const from = startOfDay(new Date());
      if (input.start === "tomorrow") from.setDate(from.getDate() + 1);
      const to = new Date(from);
      to.setDate(to.getDate() + days);
      const read = await fetchEvents(from, to, Math.min(days * 30, 100));
      const events = read.events;
      const notes = incompletenessNotes(read);
      const span =
        days === 1 ? dayLabel(from) : `${dayLabel(from)} through ${dayLabel(new Date(to.getTime() - 86_400_000))}`;
      // "Clear" is a claim about the whole calendar. When part of it did not
      // come back, EVE has found nothing — which is not the same thing, and
      // saying it the same way is how she tells him a booked day is free.
      if (events.length === 0) return emptyDayAnswer(span, notes);
      const lines = events.map((e) => {
        const dur = (e.end.getTime() - e.start.getTime()) / 60_000;
        const allDay = dur % 1440 === 0 && e.start.getHours() === 0 && e.start.getMinutes() === 0;
        const base = allDay
          ? `All day — ${e.summary}`
          : `${clock(e.start)}–${clock(e.end)} — ${e.summary}`;
        const loc = e.location ? ` (${e.location})` : "";
        return `  • ${base}${loc} [${e.calendar}]`;
      });
      const header =
        days === 1
          ? `${dayLabel(from)} — ${events.length} event${events.length === 1 ? "" : "s"}:`
          : `${dayLabel(from)} — next ${days} days (${events.length} events):`;
      return [`${header}\n${lines.join("\n")}`, ...notes].join("\n");
    },
  },
  {
    name: "find_free_slots",
    description:
      "Find free time in Umberto's calendar over the next few days — blocks of at least the given length with no events. Use this when he asks 'when am I free', 'find me a slot to...', or wants a clear stretch to study, travel, or take a call. Read-only; it reports gaps, it does not book them (add_event books, and it's gated).",
    schema: z.object({
      minutes: z
        .number()
        .int()
        .min(15)
        .max(480)
        .default(60)
        .describe("Minimum free block length in minutes. Default 60 (one hour)."),
      days: z
        .number()
        .int()
        .min(1)
        .max(7)
        .default(2)
        .describe("How many days from the start to search. Default 2."),
      start: z
        .enum(["today", "tomorrow"])
        .default("today")
        .describe("Where to start the search."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const minutes = Number(input.minutes);
      const days = Number(input.days);
      const from = startOfDay(new Date());
      if (input.start === "tomorrow") from.setDate(from.getDate() + 1);
      const to = new Date(from);
      to.setDate(to.getDate() + days);
      const read = await fetchEvents(from, to, days * 30);
      const events = read.events;
      // A gap computed from a partial read is the dangerous output of this
      // whole file — it is an invitation to book over something real. The
      // notes ride on every answer here, empty list or not.
      const notes = incompletenessNotes(read);

      // Busy intervals clipped to each day's waking window 08:00–22:00
      // (a "free slot" at 3am is not what he's asking for), then gaps.
      const minMs = minutes * 60_000;
      const slots: string[] = [];
      for (let day = 0; day < days; day++) {
        const winStart = new Date(from);
        winStart.setDate(winStart.getDate() + day);
        winStart.setHours(8, 0, 0, 0);
        const winEnd = new Date(winStart);
        winEnd.setHours(22, 0, 0, 0);
        let cursor = winStart.getTime();
        const busy = events
          .filter((e) => e.end > winStart && e.start < winEnd)
          .sort((a, b) => a.start.getTime() - b.start.getTime());
        for (const b of busy) {
          const bs = Math.max(b.start.getTime(), winStart.getTime());
          const be = Math.min(b.end.getTime(), winEnd.getTime());
          if (bs - cursor >= minMs) {
            slots.push(`${clock(new Date(cursor))}–${clock(new Date(bs))} (${Math.round((bs - cursor) / 60_000)} min) on ${dayLabelShort(new Date(cursor))}`);
          }
          cursor = Math.max(cursor, be);
        }
        if (winEnd.getTime() - cursor >= minMs) {
          slots.push(`${clock(new Date(cursor))}–${clock(winEnd)} (${Math.round((winEnd.getTime() - cursor) / 60_000)} min) on ${dayLabelShort(new Date(cursor))}`);
        }
      }
      if (slots.length === 0) {
        return [
          `No free block of at least ${minutes} min between ${dayLabelShort(from)} and ${dayLabelShort(new Date(to.getTime() - 86_400_000))} (08:00–22:00).`,
          ...notes,
        ].join("\n");
      }
      return [
        `Free slots (≥ ${minutes} min):\n${slots.map((s) => `  • ${s}`).join("\n")}`,
        ...(notes.length > 0 ? [...notes, "These gaps come from an incomplete read — check before booking."] : []),
      ].join("\n");
    },
  },
];
