// Email sending — the write half of the mail bridge. One AppleScript run
// builds the outgoing message and SENDS it: `make new outgoing message` and
// `send` are in the same script, so there is no pause between them and no
// second window to review. The outgoing window is `visible:true`, but it
// appears and goes; it is not a review surface, and nothing here may describe
// it as one. The Tier 6 gate is therefore the ONLY place Umberto sees the
// mail before the recipient does — which is why the gate prompt carries the
// body WHOLE, uncut. The review found it cut at 600 chars: a promise, a
// price, or a "yes" past that point was invisible at the moment he approved.
//
// Injection safety: the body rides in as an osascript ARGUMENT (`on run
// argv`), never interpolated into a string literal — a multi-line email
// body can't be safely quoted in AppleScript source (newlines break out of
// literals), and arguments don't need quoting at all. Subject and recipient
// are short single-line strings, still escaped the standard way.
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EveTool } from "../core/registry.js";
import { audit } from "../core/audit.js";

const execFileAsync = promisify(execFile);

async function runAppleScript(script: string, args: string[], timeoutMs = 20_000): Promise<string> {
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
    throw new Error(`couldn't reach Mail: ${why.slice(0, 200)}`);
  }
}

// The script reads its three values from argv — osascript passes everything
// after the script as arguments to `on run`, with no shell or literal
// parsing of the values at all. Newlines in the body survive verbatim.
const SEND_SCRIPT = `on run argv
  set bodyText to item 3 of argv
  tell application "Mail"
    set newMsg to make new outgoing message with properties {subject:(item 2 of argv), visible:true}
    tell newMsg
      make new to recipient at end of to recipients with properties {address:(item 1 of argv)}
      set content to bodyText
    end tell
    send newMsg
    return "sent"
  end tell
end run`;

export const mailWriteTools: EveTool[] = [
  {
    name: "send_email",
    description:
      "Send an email through Mail.app. Use it when Umberto asks you to 'email X', 'write to Y', or 'reply to Z saying…'. It ALWAYS asks him first, and his yes SENDS IT IMMEDIATELY — Mail composes and sends in one step, so there is no draft window to review afterwards and no way to unsend. The confirmation prompt is his only look at it, and it shows the exact recipient, subject, and the complete body. Keep the body clean prose: no markdown, it goes out as plain text.",
    schema: z.object({
      to: z.string().min(3).describe("Recipient email address, e.g. 'marco.rossi@example.com'. One address; say so plainly if he asks for multiple."),
      subject: z.string().min(1).max(200).describe("The subject line."),
      body: z.string().min(1).max(20000).describe("The full email body, plain prose, ready to send as-is."),
    }),
    needsConfirmation: true,
    factoryAllowed: false,
    confirmIntent: (input) => {
      const body = String(input.body);
      // The WHOLE body, never a slice: this prompt is the last thing between
      // the text and the recipient. For a long body we also state its length
      // and repeat its closing lines, because a surface that truncates a long
      // prompt would otherwise hide precisely the end of the mail — the sign-
      // off, the number, the commitment — behind an ellipsis nobody notices.
      const tail =
        body.length > 1500
          ? `\n\n(that is the complete body, ${body.length} chars — it ends: …${body.slice(-300)})`
          : "";
      return {
        human: `Send this email?\n\n  to: ${String(input.to)}\n  subject: ${String(input.subject)}\n\n${body}${tail}\n\nSaying yes sends it immediately — Mail composes and sends in one step, so this is your only look at it, and it cannot be unsent.`,
        // The recipient/subject ride in the log (an address is not a secret);
        // the BODY is withheld — notices and audit are plaintext files.
        log: `send_email to ${String(input.to)} subject "${String(input.subject)}" (body withheld, ${body.length} chars)`,
      };
    },
    run: async (input) => {
      const to = String(input.to);
      const subject = String(input.subject);
      const body = String(input.body);
      // The subject/recipient are still single-line strings — validate rather
      // than escape: an email address or subject containing control
      // characters or quotes is a mistake, not a case to sanitize.
      if (/[\r\n\x00-\x1f]/.test(to) || /[\r\n\x00-\x1f]/.test(subject)) {
        throw new Error("the recipient and subject must each be a single line — control characters aren't valid in either.");
      }
      // All three ride as osascript ARGUMENTS, which need NO literal escaping
      // at all (verified live: quotes, newlines, and leading dashes pass
      // verbatim). Single-line-ness of to/subject is validated above; the
      // body may be multi-line — that's the whole reason for the argv path.
      await runAppleScript(SEND_SCRIPT, [to, subject, body]);
      audit("email_sent", { to, subject, chars: body.length });
      // Only what was observed: the script returned without error, so Mail
      // accepted the send. Where Mail files it afterwards is never checked
      // here, and the old line claimed the Sent folder as if it had been.
      return `Email sent to ${to} — "${subject}" (sent via Mail).`;
    },
  },
];
