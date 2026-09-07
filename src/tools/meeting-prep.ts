// Meeting preparation — the review's workflow: before a meeting, Umberto
// should have attendees, the last discussion, outstanding promises, and the
// questions worth asking, assembled in one brief. This tool GATHERS the raw
// material from the real stores (calendar, conversations, commitments,
// mail); the brain composes the brief from what comes back. It does not
// fabricate: each line names its source, and missing material is stated as
// missing — the review's "state when a source could not be refreshed".
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { loadConversations, searchConversations, conversationTitle } from "../core/conversations.js";
import { runAppleScript, ensureAppRunning } from "./applescript.js";
import { readRecentMail } from "./mail.js";

const CALENDAR_APP = "/System/Applications/Calendar.app";

// Today's events, one line each — same bridge contract as calendar.ts
// (component dates in, component dates out).
//
// The whose-clause tests OVERLAP, not "starts inside the day". Selecting on
// the start date alone dropped every event that began earlier and ran INTO
// the day — the 09:00–13:00 block seen from a 10:00 window simply wasn't
// there, and the brief then said "Calendar that day: clear." while he was in
// a meeting. `its` is repeated on the second property: a compound whose
// clause silently mis-parses without it.
const TODAY_SCRIPT = `on run argv
  set f to current date
  set day of f to 1
  set year of f to (item 1 of argv as integer)
  set month of f to (item 2 of argv as integer)
  set day of f to (item 3 of argv as integer)
  set hours of f to 0
  set minutes of f to 0
  set seconds of f to 0
  set t to f + (1 * days)
  set out to ""
  tell application "Calendar"
    repeat with c in calendars
      try
        set evs to (every event of c whose (its start date is less than t) and (its end date is greater than f))
        repeat with e in evs
          try
            set evTitle to (summary of e)
            if evTitle is missing value then set evTitle to "(no title)"
            set s to (start date of e)
            set calName to (name of c)
            -- Date COMPONENTS only. An epoch renders in this Mac's locale as
            -- Italian scientific notation ("1,7886672E+9"), which Number()
            -- cannot parse; small numbers are plain in every locale. The
            -- start DATE (not just its clock) now crosses too, because an
            -- overlapping event may have begun on an earlier day and the
            -- brief has to be able to say so.
            set y1 to year of s
            set mo1 to (month of s as integer)
            set d1 to day of s
            set hh to hours of s
            set mm to minutes of s
            set out to out & y1 & "	" & mo1 & "	" & d1 & "	" & hh & "	" & mm & "	" & evTitle & "	" & calName & linefeed
          end try
        end repeat
      end try
    end repeat
  end tell
  return out
end run`;

// The topic's meaningful words. The old code took `topic.split(" ")[0]` — the
// FIRST word only — so "meeting with Marco" searched for "meeting" and missed
// every commitment owned by Marco, which is the one thing that prep was for.
// Words of 4+ characters carry identity; short words do too when capitalised
// ("Bo", "IE"), so those are kept as well. A handful of connectives are
// dropped: "with" is long enough to pass the length rule and matches half the
// ledger, which is noise dressed as a hit.
const CONNECTIVES = new Set([
  "with", "from", "about", "into", "that", "this", "these", "those", "there",
  "then", "than", "over", "under", "before", "after", "next", "will", "would",
  "have", "been", "your", "yours", "their", "them", "they", "and", "the", "for",
]);

export function topicTokens(topic: string): string[] {
  const words = topic.split(/[^\p{L}\p{N}'@._-]+/u).filter(Boolean);
  const kept = words
    .filter((w) => (w.length > 3 || /^\p{Lu}/u.test(w)) && !CONNECTIVES.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());
  const unique = [...new Set(kept)];
  // Never return nothing: a topic made entirely of connectives still has to
  // search for something, and the whole phrase is the honest fallback.
  return unique.length > 0 ? unique : [topic.toLowerCase()];
}

/** True when any meaningful token of the topic appears in any of the fields. */
export function matchesTopic(tokens: string[], ...fields: string[]): boolean {
  const hay = fields.join(" ").toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

export const meetingPrepTools: EveTool[] = [
  {
    name: "prepare_meeting",
    description:
      "Gather everything relevant for an upcoming meeting into one brief: today's calendar around it, what Umberto and the other party last discussed (searched in stored conversations), open commitments involving them (especially anything waiting-for or overdue), and recent emails. Use it when he says 'prepare me for the meeting', 'what should I know before seeing X', or before any scheduled call. Each section names its source; if a source has nothing, the brief SAYS so rather than padding. You compose the final brief from this material: objective, people, last state, what's owed in each direction, and the two or three questions he should ask.",
    schema: z.object({
      topic: z
        .string()
        .min(2)
        .max(200)
        .describe("The meeting's subject or the other party's name, e.g. 'thesis meeting with professor Bianchi' — used to search conversations and commitments."),
      when: z
        .string()
        .optional()
        .describe("When the meeting is, ISO 'YYYY-MM-DDTHH:MM'. Omit to look at today's calendar."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const topic = String(input.topic);
      const tokens = topicTokens(topic);
      const parts: string[] = [];

      // 1. Calendar today (or the meeting's day): what surrounds the meeting.
      const day = input.when ? new Date(String(input.when)) : new Date();
      if (!isNaN(day.getTime())) {
        try {
          await ensureAppRunning(CALENDAR_APP, "Calendar");
          const args = [String(day.getFullYear()), String(day.getMonth() + 1), String(day.getDate())];
          const raw = await runAppleScript(TODAY_SCRIPT, args);
          const lines = raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map((l) => {
              const [y, mo, d, h, m, title, cal] = l.split("	");
              const start = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(m));
              const hh = String(Number(h)).padStart(2, "0");
              const mm = String(Number(m)).padStart(2, "0");
              // An overlapping event can have started on an earlier day. Say
              // so rather than printing yesterday's clock time as if it were
              // a slot in this day.
              const startedEarlier =
                Number(y) !== day.getFullYear() || Number(mo) !== day.getMonth() + 1 || Number(d) !== day.getDate();
              const when = startedEarlier ? `from ${Number(d)}/${Number(mo)} ${hh}:${mm} (runs into this day)` : `${hh}:${mm}`;
              return { start, line: `  ${when} — ${title} [${cal}]` };
            })
            // Chronological. The bridge returns calendar by calendar, so the
            // day arrived shuffled (13:00 above 07:30) — and now that an
            // event from the previous day can appear in the list, an
            // unordered brief reads as a wrong one.
            .filter((e) => !isNaN(e.start.getTime()))
            .sort((a, b) => a.start.getTime() - b.start.getTime())
            .map((e) => e.line);
          parts.push(
            lines.length
              ? `Calendar that day (${lines.length} events):\n${lines.join("\n")}`
              : `Calendar that day: clear.`,
          );
        } catch (err) {
          parts.push(`Calendar: could not be read (${err instanceof Error ? err.message : String(err)}). State this in the brief.`);
        }
      }

      // 2. Past conversations about the topic — the last discussion.
      const hits = searchConversations(topic, 4);
      parts.push(
        hits.length
          ? `Last discussions (searched stored conversations for "${topic}"):\n` +
            hits
              .map((h) => `  ${h.at.slice(0, 10)} (${h.source}) — ${h.excerpt.slice(0, 180)}${h.excerpt.length > 180 ? "…" : ""}`)
              .join("\n")
          : `No stored conversations mention "${topic}" — this may be a first meeting, or it predates stored history (kept: ${loadConversations().length} conversations).`,
      );

      // 3. Commitments involving the topic — what's owed in each direction.
      try {
        const { openCommitments } = await import("./commitments.js");
        // ANY meaningful token, against the text AND the owner: "meeting with
        // Marco" has to find what Marco owes, which searching "meeting" never
        // did.
        const relevant = openCommitments().filter((c) => matchesTopic(tokens, c.text, c.owner));
        parts.push(
          relevant.length
            ? `Open commitments involving this:\n` +
              relevant
                .map((c) => `  ${c.status === "waiting" ? "WAITING ON" : c.status === "blocked" ? "BLOCKED" : "PENDING"}: ${c.text} (owner: ${c.owner}${c.due ? `, due ${c.due}` : ""})`)
                .join("\n")
            : `No tracked commitments involve "${topic}".`,
        );
      } catch {
        parts.push("Commitments: unreadable.");
      }

      // 4. Open recommendations on this topic — consult before re-deriving.
      // Not "decisions already taken": record_decision stores what EVE
      // RECOMMENDED, and an open one is a proposal Umberto has not answered.
      try {
        const { openDecisions } = await import("./decisions.js");
        const rel = openDecisions().filter((d) => matchesTopic(tokens, d.title));
        if (rel.length > 0) {
          parts.push(
            `Open recommendations on this (proposed, not yet his decision — consult, don't re-derive):\n` +
              rel.map((d) => `  ${d.title}: recommended ${d.recommendation}`).join("\n"),
          );
        }
      } catch {
        // no ledger = nothing to consult
      }

      // 5. Recent email. The description has promised "recent emails" since
      // this tool shipped and run() never opened Mail — the brief simply had
      // no email in it, and nothing said so. It goes through mail.ts's own
      // read-only path (readRecentMail), not a second copy of that
      // AppleScript: a copied bridge script is one that stops getting the
      // fixes the original has had.
      try {
        // 8 per inbox with a 40s budget, chosen by measurement rather than
        // taste: Mail answers this script at roughly one message per two
        // seconds here, so 8 per inbox (~30 messages across his accounts)
        // comes back in around 20s, while 12 per inbox measured 45s and 30
        // per inbox blew past 45s and reported the inbox unreadable every
        // time. Prep is a gather-everything tool and can wait; it cannot
        // wait two minutes.
        const mail = await readRecentMail(8, 40_000);
        const relevant = mail.filter((m) => matchesTopic(tokens, m.sender, m.subject)).slice(0, 8);
        parts.push(
          relevant.length
            ? `Recent emails (inbox via Mail.app):\n` +
              relevant
                .map((m) => `  ${m.read ? "✓" : "○ UNREAD"} ${m.date} — ${m.sender} | ${m.subject}`)
                .join("\n")
            : `Recent emails (inbox via Mail.app): read ${mail.length} recent message${mail.length === 1 ? "" : "s"}, none from or about "${topic}". Say that plainly — do not imply there was nothing in the inbox.`,
        );
      } catch (err) {
        parts.push(
          `Recent emails (inbox via Mail.app): COULD NOT BE READ (${err instanceof Error ? err.message : String(err)}). ` +
            `State this in the brief — the inbox was not checked, which is not the same as no email.`,
        );
      }

      return [
        `MEETING PREP MATERIAL — "${topic}"`,
        `(Gathered from live sources; compose the brief from this. Say plainly if a section is empty.)`,
        "",
        ...parts,
      ].join("\n\n");
    },
  },
];
