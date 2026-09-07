// The privacy guard: Umberto's personal identifiers never leave the machine
// through an ungated pipe. See tests/privacy-guard.test.ts for the threat
// model — the short version: gated paths (send_email, send_message) show him
// the full text, but deep_research, perplexity_search, delegate_to_ai and
// fetch_url send text to third parties with nobody watching, and a recalled
// memory composed into a query is a leak wearing the clothes of a search.
//
// Mechanical and PRECISE on purpose. This is not a content classifier — "is
// this too personal" is the rail's judgment call, in the system prompt. This
// module catches the exact strings that identify HIM: the street address from
// config (never hardcoded here — it is HIS to change), his known email
// addresses, phone-number shapes, and the credential shapes the memory store
// already refuses. A false positive blocks a legitimate query, teaches the
// model to route around the guard, and then the guard protects nothing — so
// the bar for a match is "this string identifies Umberto", not "this string
// is about Umberto's life".
import { loadConfig } from "../core/config.js";
import { isSensitive } from "./store.js";

export interface PrivacyHit {
  kind: "address" | "email" | "phone" | "credential";
  /** Which category matched — never the matched text itself. */
  hint: string;
}

// His email addresses. Not hardcoded as a list of strings to maintain: the
// primary comes from core knowledge (brain/prompt loads it), but the guard
// runs in tool paths where that is not available — so it reads the two
// addresses the system already knows: his own from config/core, and EVE's
// outbound address (which appears in memory and must not go out either).
function emailPatterns(): string[] {
  // The two addresses that appear in EVE's memory and correspondence. Kept
  // as literals because they ARE the personal data being guarded — there is
  // no more-authoritative source to read them from (send_email's from-address
  // is configured in Mail.app, not config.json).
  return ["you@example.com", "eve@example.com"];
}

// Street-address line from config when present. The address lives in his
// core knowledge and memory store, not in code — the guard reads whatever
// the operator registers here, defaulting to none.
function addressPatterns(): string[] {
  try {
    const cfg = loadConfig() as { privacy?: { guardAddresses?: string[] } };
    return (cfg.privacy?.guardAddresses ?? []).filter(Boolean);
  } catch {
    return [];
  }
}

// Phone shapes: international (E.164-ish) and spaced French/Italian mobile
// forms. Deliberately not a full validator — the shape alone identifies a
// person's dialable number, which is what must not leave.
const PHONE =
  /\+?\d[\d\s().-]{7,16}\d/;

export function personalDataIn(text: string): PrivacyHit | null {
  // Credentials first — the memory store's own filter, inherited so a key in
  // a delegated task is caught by the same shapes that catch it in a memory.
  if (isSensitive(text)) return { kind: "credential", hint: "a key, token or financial identifier" };

  for (const addr of addressPatterns()) {
    // Case-insensitive, whitespace-tolerant: "1   Rue Exemple" and
    // "1 rue exemple" are the same address.
    const re = new RegExp(
      addr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
      "i",
    );
    if (re.test(text)) return { kind: "address", hint: "the registered home address" };
  }

  for (const email of emailPatterns()) {
    if (text.toLowerCase().includes(email.toLowerCase()))
      return { kind: "email", hint: "one of his email addresses" };
  }

  // Phone shapes — but only when the candidate has a plausible dialable
  // length (≥9 digits after stripping), so years ("2026") and prices don't
  // fire.
  for (const m of text.matchAll(/(\+?\d[\d\s().-]{7,16}\d)/g)) {
    const digits = m[1]!.replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 15) return { kind: "phone", hint: "a phone number" };
  }

  return null;
}

// The guard each outbound pipe calls before sending. Returns a refusal
// STRING (which the tool returns to the model verbatim) or null to proceed.
// The refusal names the CATEGORY and teaches the fix — generalise — but never
// echoes the matched text: refusal text rides tool results and logs, and
// echoing the address at the moment of refusing it would be the leak itself.
export function guardOutbound(text: string, destination: string): string | null {
  const hit = personalDataIn(text);
  if (!hit) return null;
  return (
    `Refused to send this ${destination}: it contains ${hit.hint}, which never leaves ` +
    `the machine through an ungated query. Do NOT reword it to get past this check with ` +
    `the same information. Either generalise the query (the city or district is fine; ` +
    `the address is not), or ask Umberto directly — if he says yes, the gated tools ` +
    `(send_email, send_message) show him exactly what would go out.`
  );
}
