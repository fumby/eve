// Umberto's phone — a secretary's job #4: call a restaurant, a business, a
// person, for him. Uses FaceTime (the `facetime://` URL scheme) to place an
// audio call — it works with any phone number, not just Apple devices, when
// the Mac is signed in to iCloud. Gated by the Tier 6 gate: it's an outward
// action that reaches a person and can't be taken back.
//
// The call opens FaceTime with the number pre-filled; Umberto confirms in the
// gate first, then sees the call window appear and can hang up if it's wrong.
// EVE does not auto-press the green button — the call starts dialling but the
// UI gives him a beat to cancel.
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EveTool } from "../core/registry.js";

const execFileAsync = promisify(execFile);

// Open a facetime:// URL — the system handler is FaceTime.app, which opens
// the call window with the number pre-filled. `open` is the macOS default
// handler for URL schemes; it does not need Mail or Messages to be running.
async function openFaceTime(phone: string): Promise<string> {
  // Sanitise: digits, +, spaces, hyphens only — never let a shell metachar
  // near the URL. A phone number is digits and a leading +.
  const clean = phone.replace(/[^\d+\-\s]/g, "").trim();
  if (!clean) throw new Error(`that doesn't look like a phone number: "${phone}"`);
  if (!clean.startsWith("+") && !/^\d{4,}$/.test(clean.replace(/[\-\s]/g, ""))) {
    throw new Error(`that doesn't look like a phone number: "${phone}". Give the full number with country code, e.g. +39 081 1234567.`);
  }
  try {
    await execFileAsync("open", ["facetime://" + clean], { timeout: 10_000 });
    return clean;
  } catch (err) {
    throw new Error(
      `couldn't open FaceTime for ${clean}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const phoneTools: EveTool[] = [
  {
    name: "call_number",
    description:
      "Place a phone call to a number via FaceTime — a restaurant, a business, a person. Use it when Umberto asks you to 'call X', 'ring Y', 'phone Z', or when he gives you a number to dial. It opens FaceTime with the number pre-filled; the call starts when he confirms in the gate. The number must include the country code for international calls (e.g. +39 for Italy, +33 for France). This is a real outward action — it reaches a person — so it always asks Umberto first.",
    schema: z.object({
      number: z
        .string()
        .min(4)
        .max(30)
        .describe("The phone number to call, with country code, e.g. '+39 081 1234567' or '+33 1 42 86 82 00'."),
      who: z
        .string()
        .optional()
        .describe("Who or what the number belongs to, e.g. 'the restaurant' or 'the dentist'. Helps the confirmation prompt."),
    }),
    needsConfirmation: true,
    confirmIntent: (input) => {
      const number = String(input.number);
      const who = input.who ? String(input.who) : "";
      return {
        human: `Call ${who ? `${who} ` : ""}at ${number}?\n\nFaceTime will open with this number — you can cancel in the call window if it's wrong.`,
        log: `call_number ${number}`,
      };
    },
    run: async (input) => {
      const number = String(input.number);
      const who = input.who ? String(input.who) : "";
      const dialled = await openFaceTime(number);
      return `Opening FaceTime to call ${who ? `${who} ` : ""}at ${dialled}. The call window should appear — confirm in the FaceTime window.`;
    },
  },
];
