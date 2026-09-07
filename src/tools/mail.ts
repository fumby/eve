// Umberto's email — a secretary's job #2: know what's in the inbox without
// him opening it. Read-only via osascript + Mail.app. EVE can see unread
// counts, recent senders, and message subjects; she cannot send or delete.
//
// Mail.app's AppleScript is the only path that reads the live mail store
// without a framework, IMAP credentials, or Full Disk Access. It runs inside
// a fixed argv (no shell), a timeout, and a cap on the messages returned so
// a 4000-message inbox never blocks a voice turn.
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EveTool } from "../core/registry.js";

const execFileAsync = promisify(execFile);

async function runAppleScript(script: string, timeoutMs = 20_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const why = e.stderr?.trim() || e.message;
    if (why.includes("not authorized") || why.includes("permission") || why.includes("AppleEvent")) {
      throw new Error(
        "Mail.app access isn't working — it may not be running, or the terminal needs Automation permission (System Settings → Privacy & Security → Automation).",
      );
    }
    throw new Error(`couldn't read the mail: ${why.slice(0, 200)}`);
  }
}

// Mail.app iterates messages newest-first by default. We ask for the first N
// from each inbox and merge them into one list, sorted by date.
function recentMailScript(maxPerInbox: number): string {
  return `tell application "Mail"
  set out to ""
  repeat with a in accounts
    set an to (name of a)
    repeat with mb in every mailbox of a
      if (name of mb) is "INBOX" or (name of mb) is "Inbox" then
        set i to 0
        repeat with m in (messages of mb)
          set i to i + 1
          if i > ${maxPerInbox} then exit repeat
          set d to (date received of m)
          set s to (sender of m)
          set sub to (subject of m)
          if sub is missing value then set sub to "(no subject)"
          set isRead to (read status of m)
          set out to out & (d as string) & "\t" & s & "\t" & sub & "\t" & isRead & "\t" & an & linefeed
        end repeat
      end if
    end repeat
  end repeat
  return out
end tell`;
}

// Unread count per inbox — a count, not an iteration over every message (that
// hangs on 4000+ messages). Mail.app's `count of messages of mailbox` is fast;
// `read status` is the only thing that needs iteration, and we cap it.
function unreadCountScript(): string {
  return `tell application "Mail"
  set out to ""
  set total to 0
  repeat with a in accounts
    set an to (name of a)
    repeat with mb in every mailbox of a
      if (name of mb) is "INBOX" or (name of mb) is "Inbox" then
        set unread to 0
        set i to 0
        repeat with m in (messages of mb)
          set i to i + 1
          if i > 200 then exit repeat
          if (read status of m) is false then set unread to unread + 1
        end repeat
        set out to out & an & ": " & unread & " unread (of first " & i & ")\\n"
        set total to total + unread
      end if
    end repeat
  end repeat
  return "Total unread (capped): " & total & linefeed & out
end tell`;
}

export interface MailItem {
  date: string;
  sender: string;
  subject: string;
  read: boolean;
  account: string;
}

function parseMail(raw: string): MailItem[] {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [date, sender, subject, read, account] = line.split("\t");
      return {
        date: date ?? "",
        sender: sender ?? "",
        subject: subject ?? "",
        read: read === "true",
        account: account ?? "",
      };
    });
}

/**
 * The read-only inbox read, as one call: script + parse + newest-first sort.
 * Exported so other tools (prepare_meeting) can use the REAL inbox path
 * instead of growing a second copy of this AppleScript beside it — a copied
 * bridge script is a copy that stops getting the fixes this one has had.
 * `max` is per inbox, as in the script; the merged list is sorted by date.
 *
 * `timeoutMs` is a caller's budget, not a constant. Mail answers this script
 * roughly one message per two seconds on this Mac (4 accounts, one Apple
 * Event per property per message): measured, 8 per inbox lands just inside
 * the 20s default and 12 per inbox takes ~45s. A caller that asks for more
 * has to be able to say how long it can wait, or it gets cut off at the
 * default and told the inbox was unreadable when it simply wasn't finished.
 */
export async function readRecentMail(max = 8, timeoutMs?: number): Promise<MailItem[]> {
  const items = parseMail(await runAppleScript(recentMailScript(max), timeoutMs));
  // Mail.app returns newest-first PER inbox, interleaved across accounts.
  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return items;
}

export const mailTools: EveTool[] = [
  {
    name: "get_inbox",
    description:
      "Read Umberto's email inbox: how many unread, and the most recent messages (sender, subject, date, read/unread) across all his Mail.app accounts. Use this for the daily briefing ('anything in my inbox I need to deal with?'), for any 'who emailed me / what did X send / is there anything from Y' question, and before suggesting he check email. This tool itself is read-only — it cannot reply or delete. Sending is a separate tool, send_email, which asks Umberto first and sends immediately on his yes; so when he wants a reply sent, draft it and call send_email rather than offering a reminder instead.",
    schema: z.object({
      max: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(8)
        .describe("Max messages to return per inbox. Default 8."),
      onlyUnread: z
        .boolean()
        .default(false)
        .describe("If true, only return unread messages. Default false (all recent)."),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const max = Number(input.max);
      const onlyUnread = input.onlyUnread === true;
      let items = await readRecentMail(max);
      if (onlyUnread) items = items.filter((m) => !m.read);
      if (items.length === 0) {
        return onlyUnread
          ? "No unread messages in any inbox."
          : "No messages in any inbox.";
      }
      const unreadCount = items.filter((m) => !m.read).length;
      const header = `${items.length} message${items.length === 1 ? "" : "s"} (${unreadCount} unread):`;
      const lines = items.map(
        (m) =>
          `  • ${m.read ? "✓" : "○"} ${m.date} — ${m.sender} | ${m.subject}` +
          (m.account ? ` [${m.account}]` : ""),
      );
      return `${header}\n${lines.join("\n")}`;
    },
  },
  {
    name: "check_unread",
    description:
      "Get a quick unread email count across all of Umberto's inboxes, plus the senders and subjects of the first few unread. Use this for the daily briefing and for 'do I have anything unread?' — faster than get_inbox when he just wants the count. Read-only.",
    schema: z.object({}),
    needsConfirmation: false,
    run: async () => {
      const raw = await runAppleScript(unreadCountScript());
      // The script returns "Total unread (capped): N\n" + per-account lines.
      // Also get the first few unread senders/subjects.
      const unread = (await readRecentMail(50))
        .filter((m) => !m.read)
        .slice(0, 5)
        .map((m) => `  • ${m.date} — ${m.sender} | ${m.subject}`);
      const body = unread.length > 0 ? `\nMost recent unread:\n${unread.join("\n")}` : "";
      return `${raw}${body}`;
    },
  },
];
