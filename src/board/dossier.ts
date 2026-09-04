// The dossier layer: what a valid board seat IS.
//
// A dossier is a knowledge base, not a personality — numbered doctrine entries
// with sources, which are the only things a seat may cite. The parser and the
// citation gate live here and were written before any dossier existed, because
// they define validity. Two hard rules from the design brief:
//   - a malformed dossier loses ITS OWN seat, with a logged reason — it must
//     never take the board down, and it must never vanish silently;
//   - anti-fabrication machinery fails closed: duplicate doctrine ids make
//     citations ambiguous, so the whole file is rejected.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "../core/config.js";
import { readJson, writeJson } from "../core/store.js";

export interface DoctrineEntry {
  id: string; // "D1" — explicit in the file, never derived from ordering
  title: string;
  source: string;
  body: string;
  retired: boolean;
  verification: "sourced" | "user";
}

export interface Seat {
  id: string;
  name: string;
  seat: string; // seat title, e.g. "Offers & Acquisition"
  status: string;
  domains: string[];
  doctrine: DoctrineEntry[]; // includes retired entries (ids stay reserved)
  shownIds: string[]; // what a live seat is actually shown = citable set
  objection: string; // the anti-sycophancy section
  blindSpots: string;
  voice: string;
}

export const BOARD_DIR = path.join(ROOT, "board");
const VERIFICATION_FILE = "board-verification.json"; // lives in data/, server-owned

interface VerificationRecord {
  hash: string;
  state: "sourced" | "user";
}

// ---------------------------------------------------------------- hashing
// Verification is server-owned. The state recorded at fact-check time is only
// honoured while the entry's substance is byte-identical; edit the substance
// and the state silently drops to "user" — the fact-check no longer covers
// what the entry now says, and a hand edit must never wear its badge.
export function entryHash(entry: { source: string; body: string }): string {
  return crypto
    .createHash("sha256")
    .update(entry.source + "\n" + entry.body)
    .digest("hex")
    .slice(0, 24);
}

type VerificationMap = Record<string, VerificationRecord>;

export function loadVerification(): VerificationMap {
  return readJson<VerificationMap>(VERIFICATION_FILE, {});
}

export function markSourced(advisorId: string, entryId: string, hash: string): void {
  const map = loadVerification();
  map[`${advisorId}:${entryId.toUpperCase()}`] = { hash, state: "sourced" };
  writeJson(VERIFICATION_FILE, map);
}

function resolveVerification(
  map: VerificationMap,
  advisorId: string,
  entry: { id: string; source: string; body: string },
): "sourced" | "user" {
  const rec = map[`${advisorId}:${entry.id}`];
  if (!rec) return "user";
  return rec.hash === entryHash(entry) && rec.state === "sourced" ? "sourced" : "user";
}

// ---------------------------------------------------------------- parser
export interface ParseFailure {
  file: string;
  reason: string;
}

export function parseDossier(
  raw: string,
  fileLabel = "(inline)",
): { seat: Seat } | { error: ParseFailure } {
  const fail = (reason: string) => ({ error: { file: fileLabel, reason } });

  // frontmatter
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) return fail("missing frontmatter");
  const meta: Record<string, string> = {};
  for (const line of fm[1]!.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) meta[m[1]!] = m[2]!.trim();
  }
  const id = meta.id ?? "";
  const name = meta.name ?? "";
  if (!id || !name) return fail("frontmatter needs id and name");
  const domains = (meta.domains ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0) return fail("no domains — this seat could never be routed to");

  const body = raw.slice(fm[0].length);
  const section = (heading: string): string => {
    const re = new RegExp(`^# ${heading}\\s*$([\\s\\S]*?)(?=^# |$(?![\\s\\S]))`, "im");
    return re.exec(body)?.[1]?.trim() ?? "";
  };

  // doctrine entries: "### D<n> — Title"
  const doctrineSection = section("Doctrine");
  const doctrine: DoctrineEntry[] = [];
  const seen = new Set<string>();
  const entryRe = /^### +(D\d+)\s*[—-]\s*(.+)$/gim;
  const matches = [...doctrineSection.matchAll(entryRe)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const entryId = m[1]!.toUpperCase();
    if (seen.has(entryId)) {
      // Ambiguous citations must fail closed — reject the whole file.
      return fail(`duplicate doctrine id ${entryId}`);
    }
    seen.add(entryId);
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : doctrineSection.length;
    const chunk = doctrineSection.slice(start, end).trim();
    const sourceMatch = chunk.match(/^Source:\s*(.+)$/im);
    const retired = /^Status:\s*retired\s*$/im.test(chunk);
    const text = chunk
      .replace(/^Source:.*$/im, "")
      .replace(/^Status:.*$/im, "")
      .trim();
    doctrine.push({
      id: entryId,
      title: m[2]!.trim(),
      source: sourceMatch?.[1]?.trim() ?? "",
      body: text,
      retired,
      verification: "user", // resolved against the hash file in loadSeats
    });
  }
  if (doctrine.filter((d) => !d.retired).length === 0) {
    return fail("no live doctrine — there is nothing to cite");
  }

  return {
    seat: {
      id,
      name,
      seat: meta.seat ?? name,
      status: meta.status ?? "active",
      domains,
      doctrine,
      shownIds: doctrine.filter((d) => !d.retired).map((d) => d.id),
      objection: section("Characteristic objection"),
      blindSpots: section("Blind spots"),
      voice: section("Voice"),
    },
  };
}

export function loadSeats(): { seats: Seat[]; warnings: string[] } {
  const seats: Seat[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(BOARD_DIR)) return { seats, warnings: ["board/ directory missing"] };
  const verification = loadVerification();

  for (const file of fs.readdirSync(BOARD_DIR).filter((f) => f.endsWith(".md"))) {
    let raw: string;
    try {
      // Tolerant UTF-8: a wrongly-encoded file degrades to a warning, not an
      // exception that takes out the whole roster.
      raw = fs.readFileSync(path.join(BOARD_DIR, file)).toString("utf8");
    } catch (err) {
      warnings.push(`${file}: unreadable (${err instanceof Error ? err.message : err})`);
      continue;
    }
    const parsed = parseDossier(raw, file);
    if ("error" in parsed) {
      // The roster shrinks LOUDLY. A quorum that quietly shrinks is worse
      // than a stale one.
      warnings.push(`${parsed.error.file}: seat dropped — ${parsed.error.reason}`);
      continue;
    }
    const seat = parsed.seat;
    if (seat.status === "disabled") continue;
    for (const d of seat.doctrine) {
      d.verification = resolveVerification(verification, seat.id, d);
    }
    seats.push(seat);
  }
  return { seats, warnings };
}

// ---------------------------------------------------------------- gate
// Pure. The valid set is what the seat WAS SHOWN — not everything in the file.
// Retirement makes those diverge, and the gap is a seat citing something that
// was withheld from it.
export function gateCitations(returned: unknown, shownIds: string[]): string[] {
  if (!Array.isArray(returned)) return [];
  const shown = new Set(shownIds.map((s) => s.toUpperCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of returned) {
    if (typeof item !== "string") continue; // structure where a string belonged
    const id = item.trim().toUpperCase();
    if (!shown.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------- coercion
// Every field a model returns is hostile input — not because the model is
// adversarial, but because a schema-declared boolean can arrive as the string
// "false", which is truthy. Identity checks, never truthiness.
export function asBool(v: unknown): boolean {
  return v === true || v === "true";
}

export function asText(v: unknown, maxLen = 4000): string {
  return typeof v === "string" ? v.trim().slice(0, maxLen) : "";
}

export function asConfidence(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}
