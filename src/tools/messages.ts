// Umberto's messages — a secretary's job #3: know who texted and be able to
// reply. Read + send via osascript + Messages.app. Reading message bodies is
// limited by Messages.app's AppleScript dictionary (the `message` class name
// conflicts with the AppleScript `message` keyword, so `every message of c`
// fails to parse), so the tool surfaces chat participants and IDs — enough
// to say "Iacopo texted you" and to send a reply.
//
// Sending is gated by the Tier 6 confirmation gate: it's an outward action,
// and EVE never sends a text without Umberto saying yes to the exact content
// and recipient.
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
    if (why.includes("not authorized") || why.includes("permission")) {
      throw new Error(
        "Messages.app access isn't working — it may not be running, or the terminal needs Automation permission (System Settings → Privacy & Security → Automation).",
      );
    }
    throw new Error(`couldn't reach Messages: ${why.slice(0, 200)}`);
  }
}

interface ImChat {
  id: string;
  participant: string;
}

function listChatsScript(maxChats: number): string {
  return `tell application "Messages"
  set out to ""
  set i to 0
  repeat with c in chats
    set i to i + 1
    if i > ${maxChats} then exit repeat
    set cid to ""
    set pn to ""
    try
      set cid to (id of c)
    end try
    try
      set p to (participant of c)
      set pn to (name of item 1 of p)
    end try
    set out to out & cid & "\\t" & pn & linefeed
  end repeat
  return out
end tell`;
}

function parseChats(raw: string): ImChat[] {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, participant] = line.split("\t");
      return { id: id ?? "", participant: participant ?? "" };
    });
}

// Send a message to an existing chat by its ID. The `send` command takes a
// string and a target chat reference.
function sendScript(chatId: string, text: string): string {
  // Escape the text for AppleScript string literals. Backslash and double-
  // quote are the obvious ones; control characters (newlines, tabs, null
  // bytes) are the injection vector — a \n in the text breaks out of the
  // string literal and the next line is parsed as AppleScript. Strip them.
  const esc = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t\x00-\x1f]/g, " "); // no control chars in a string literal
  const escId = chatId
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t\x00-\x1f]/g, " ");
  return `tell application "Messages"
  set c to (first chat whose id is "${escId}")
  send "${esc}" to c
  return "sent"
end tell`;
}

export const messageTools: EveTool[] = [
  {
    name: "list_messages",
    description:
      "List Umberto's recent iMessage/SMS chats: who he's been texting, by participant name or phone number. Use this for 'who texted me / did anyone message me / has X replied' — it returns the most recent chats so he can see who's been in touch. Read-only; does not show message contents (Messages.app's AppleScript dictionary doesn't expose them reliably). If he wants to see what someone said, read it on his phone.",
    schema: z.object({
      max: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(10)
        .describe("How many recent chats to list. Default 10."),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const max = Number(input.max);
      const raw = await runAppleScript(listChatsScript(max));
      const chats = parseChats(raw);
      if (chats.length === 0) return "No iMessage chats found.";
      const lines = chats.map((c) => {
        const display = c.participant || c.id.split(";").pop() || c.id;
        return `  • ${display}`;
      });
      return `${chats.length} recent chat${chats.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
    },
  },
  {
    name: "send_message",
    description:
      "Send an iMessage or SMS to one of Umberto's contacts. Requires his explicit confirmation — the gate shows him the exact message and recipient before anything is sent. Use when he asks you to 'text X that Y' or 'tell Z I'll be late'. Find the chat with list_messages first if you need the recipient. This is a real outward action; it costs nothing but it reaches a person.",
    schema: z.object({
      recipient: z
        .string()
        .min(1)
        .describe("The recipient's name or phone number, exactly as list_messages shows it."),
      text: z
        .string()
        .min(1)
        .max(4000)
        .describe("The message text to send, verbatim. Keep it short — it's a text, not an email."),
    }),
    needsConfirmation: true,
    confirmIntent: (input) => {
      const recipient = String(input.recipient);
      const text = String(input.text);
      return {
        human: `Send this iMessage to ${recipient}?\n\n  "${text}"`,
        log: `send_message to ${recipient} (${text.length} chars, content withheld)`,
      };
    },
    run: async (input) => {
      const recipient = String(input.recipient);
      const text = String(input.text);
      // Find the chat by participant name or phone number in the ID.
      const raw = await runAppleScript(listChatsScript(50));
      const chats = parseChats(raw);
      const match = chats.find(
        (c) =>
          c.participant.toLowerCase().includes(recipient.toLowerCase()) ||
          c.id.toLowerCase().includes(recipient.toLowerCase().replace(/\s/g, "")),
      );
      if (!match) {
        throw new Error(
          `couldn't find a chat with "${recipient}" — use list_messages to see who he's been texting, then give the exact name or number.`,
        );
      }
      await runAppleScript(sendScript(match.id, text));
      return `Sent to ${match.participant || recipient}: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`;
    },
  },
];
