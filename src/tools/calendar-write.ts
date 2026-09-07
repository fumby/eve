// Calendar writes — EVE can create an event in Umberto's macOS Calendar via
// AppleScript. Gated by the Tier 6 gate: it's an outward action that changes
// his schedule, so he sees the exact event before it's created.
//
// Injection safety: title/location/calendar name ride as osascript ARGUMENTS
// (`on run argv`), never interpolated into string literals — a title with a
// newline or quote is data, not script. Dates are passed as NUMERIC
// COMPONENTS and assembled inside AppleScript with explicit year/month/day/
// hours/minutes setters: no locale on earth parses "date <string>" the same
// way, and the JS Date.toString() format is rejected outright (verified
// live: "Invalid date and time"). Day-of-month rollover (May 31 → set
// February) is prevented by zeroing the day to 1 before setting the month.
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EveTool } from "../core/registry.js";
import { audit } from "../core/audit.js";

const execFileAsync = promisify(execFile);

// Calendar is a sandboxed app whose AppleScript support refuses one-shot
// `launch` when it isn't already running (-600, verified live). `open -g`
// starts it in the background without stealing focus. Harmless if it's
// already running. Called before every Calendar script, both read and write.
async function ensureCalendarRunning(): Promise<void> {
  try {
    await execFileAsync("open", ["-g", "/System/Applications/Calendar.app"], { timeout: 10_000 });
    // Give the app a beat to accept Apple events. 3s has never failed live;
    // if it's still not ready the script errors clearly rather than silently.
    await new Promise((r) => setTimeout(r, 3_000));
  } catch {
    // `open` failing (a headless Mac, a broken install) must not mask the
    // real error — let the AppleScript itself report what went wrong.
  }
}

async function runAppleScript(script: string, args: string[], timeoutMs = 15_000): Promise<string> {
  await ensureCalendarRunning();
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const why = e.stderr?.trim() || e.message;
    throw new Error(`couldn't reach Calendar: ${why.slice(0, 200)}`);
  }
}

// Everything user-shaped comes from argv. Dates arrive as five numeric text
// arguments per timestamp; the script builds them component-wise, which no
// locale can misparse (the string-date route was rejected by AppleScript
// itself on this Mac — see the header note).
const ADD_SCRIPT = `on run argv
  set evTitle to item 1 of argv
  set evLoc to item 2 of argv
  set calName to item 3 of argv
  -- start: items 4-8 (year, month, day, hours, minutes)
  set s to current date
  set day of s to 1
  set year of s to (item 4 of argv as integer)
  set month of s to (item 5 of argv as integer)
  set day of s to (item 6 of argv as integer)
  set hours of s to (item 7 of argv as integer)
  set minutes of s to (item 8 of argv as integer)
  set seconds of s to 0
  -- end: items 9-13
  set e to current date
  set day of e to 1
  set year of e to (item 9 of argv as integer)
  set month of e to (item 10 of argv as integer)
  set day of e to (item 11 of argv as integer)
  set hours of e to (item 12 of argv as integer)
  set minutes of e to (item 13 of argv as integer)
  set seconds of e to 0
  tell application "Calendar"
    -- launch, not activate: start the app if it isn't running, without
    -- stealing focus. Without this, event creation fails outright (-600)
    -- whenever Calendar happens to be closed — verified live.
    launch
    if calName is "" then
      set targetCal to calendar 1
    else
      set targetCal to first calendar whose name is calName
    end if
    set evProps to {summary:evTitle, start date:s, end date:e}
    if evLoc is not "" then set evProps to evProps & {location:evLoc}
    make new event at end of events of targetCal with properties evProps
    return "created"
  end tell
end run`;

// JS Date → five numeric text args (year, month 1-12, day, hours, minutes).
function dateArgs(d: Date): string[] {
  return [
    String(d.getFullYear()),
    String(d.getMonth() + 1),
    String(d.getDate()),
    String(d.getHours()),
    String(d.getMinutes()),
  ];
}

export const calendarWriteTools: EveTool[] = [
  {
    name: "add_event",
    description:
      "Create a new event in Umberto's macOS Calendar. Use it when he says 'schedule X', 'put Y on my calendar', 'remind me about Z on Thursday at 3'. Requires his explicit confirmation — the gate shows the exact event title, date, time, and location. Creates the event in his first calendar unless a specific calendar name is given.",
    schema: z.object({
      title: z.string().min(1).max(200).describe("The event title, e.g. 'Dentist appointment' or 'Call with Marco'"),
      start: z.string().min(1).describe("Start date and time, ISO format 'YYYY-MM-DDTHH:MM' (e.g. '2026-09-10T15:00')"),
      end: z.string().optional().describe("End date and time, ISO format. If omitted, defaults to 1 hour after start."),
      location: z.string().optional().describe("Optional location, e.g. 'Studio 3, via Mezzocannone' or 'Zoom'"),
      calendar: z.string().optional().describe("Optional calendar name. If omitted, uses his first calendar."),
    }),
    needsConfirmation: true,
    factoryAllowed: false,
    confirmIntent: (input) => {
      const title = String(input.title);
      const start = String(input.start);
      const end = input.end ? String(input.end) : "(1 hour)";
      const loc = input.location ? String(input.location) : "(no location)";
      const cal = input.calendar ? String(input.calendar) : "(default)";
      return {
        human: `Create this calendar event?\n\n  title: ${title}\n  start: ${start}\n  end: ${end}\n  location: ${loc}\n  calendar: ${cal}`,
        log: `add_event "${title.replace(/[\r\n\t\x00-\x1f]/g, " ")}" at ${start}`,
      };
    },
    run: async (input) => {
      const title = String(input.title);
      const startStr = String(input.start);
      // `new Date("2026-09-10T15:00")` parses as LOCAL time per spec — which
      // is what he means when he says "at 3 on Thursday".
      const startDate = new Date(startStr);
      if (isNaN(startDate.getTime())) {
        throw new Error(`invalid start date: "${startStr}". Use ISO format like '2026-09-10T15:00'.`);
      }
      const endDate = input.end
        ? new Date(String(input.end))
        : new Date(startDate.getTime() + 3_600_000);
      if (isNaN(endDate.getTime())) {
        throw new Error(`invalid end date: "${String(input.end)}". Use ISO format like '2026-09-10T16:00'.`);
      }
      if (endDate <= startDate) {
        throw new Error(`the end must be after the start (${startStr} → ${String(input.end ?? "(+1h)")}).`);
      }
      const location = input.location ? String(input.location) : "";
      const calendar = input.calendar ? String(input.calendar) : "";
      await runAppleScript(ADD_SCRIPT, [title, location, calendar, ...dateArgs(startDate), ...dateArgs(endDate)]);
      audit("event_created", { title: title.slice(0, 80), start: startStr, calendar: calendar || "(default)" });
      return `Event "${title}" created for ${startStr}${location ? ` at ${location}` : ""}.`;
    },
  },
];
