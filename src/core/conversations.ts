// Conversations on disk. Until now EVE's history lived only in memory and died
// with the process, so nothing she talked about could ever be looked back at —
// and the mind map's "working memory" region would have had nothing in it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_ROOT } from "./config.js";
import { readJson, writeJson } from "./store.js";
import { writeFileAtomic } from "./atomic.js";
import { localDate } from "./time.js";

export interface ConvTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface Conversation {
  id: string;
  startedAt: string;
  updatedAt: string;
  source: string; // typed | voice | face | heartbeat
  turns: ConvTurn[];
  // When the memory extractor last processed this conversation. A resumed
  // conversation that grew since then counts as unprocessed again.
  distilledAt?: string;
}

const FILE = "conversations.json";
const MAX_CONVERSATIONS = 60;
const MAX_TURNS = 200;

// ── the transcripts archive ────────────────────────────────────────────────
// The live store is bounded at MAX_CONVERSATIONS; before the archive existed
// the overflow was DROPPED on the floor — a year of talking and the only
// thing left was the last 60 threads. Now an evicted conversation lands in
// memory/transcripts/ as one human-readable markdown file (same "files are
// the memory" doctrine as memory/store/), inside the tree the hourly backup
// snapshots, and the SAME lexical search that covers the live store covers
// the archive — one query, both shelves.
const TRANSCRIPTS_DIR = path.join(STATE_ROOT, "memory", "transcripts");

export function transcriptsDir(): string {
  return TRANSCRIPTS_DIR;
}

export const loadConversations = (): Conversation[] =>
  readJson<Conversation[]>(FILE, []);

export function newConversationId(): string {
  return crypto.randomBytes(4).toString("hex");
}

// Appends a pair of turns to the given conversation, creating it on first use.
export function recordExchange(
  id: string,
  source: string,
  userText: string,
  assistantText: string,
): void {
  const all = loadConversations();
  let conv = all.find((c) => c.id === id);
  const now = new Date().toISOString();
  if (!conv) {
    conv = { id, startedAt: now, updatedAt: now, source, turns: [] };
    all.push(conv);
  }
  conv.turns.push({ role: "user", text: userText, at: now });
  conv.turns.push({ role: "assistant", text: assistantText, at: now });
  if (conv.turns.length > MAX_TURNS) conv.turns.splice(0, conv.turns.length - MAX_TURNS);
  conv.updatedAt = now;

  // Keep the newest conversations; the ones that fall off the end are
  // ARCHIVED, not dropped — the transcript is the record of what was said,
  // and losing it made "what was that error string" unanswerable forever.
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const keep = all.slice(0, MAX_CONVERSATIONS);
  const evicted = all.slice(MAX_CONVERSATIONS);
  for (const gone of evicted) archiveConversation(gone.id);
  writeJson(FILE, keep);
}

// Moves one conversation from the live store to memory/transcripts/. Idempotent:
// archiving an id that is not in the live store (already archived, or never
// existed) is a no-op, and a file already on disk for that id is never
// overwritten — the transcript is the only copy, and a clobber would be final.
export function archiveConversation(id: string): void {
  const all = loadConversations();
  const conv = all.find((c) => c.id === id);
  if (!conv || conv.turns.length === 0) return;
  const file = path.join(TRANSCRIPTS_DIR, `${conv.id}.md`);
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  if (fs.existsSync(file)) return; // already archived — never clobber
  writeFileAtomic(file, renderTranscript(conv));
  writeJson(FILE, all.filter((c) => c.id !== id));
}

// A transcript as human-readable markdown, front-matter for browsing, turns
// verbatim. The conversation id is the filename AND in the header, so a hit
// names its conversation either way it is read.
function renderTranscript(conv: Conversation): string {
  const meta = [
    `id: ${conv.id}`,
    `source: ${conv.source}`,
    `startedAt: ${conv.startedAt}`,
    `updatedAt: ${conv.updatedAt}`,
    `turns: ${conv.turns.length}`,
    ...(conv.distilledAt ? [`distilledAt: ${conv.distilledAt}`] : []),
  ];
  const body = conv.turns
    .map((t) => `**${t.role === "user" ? "Umberto" : "EVE"}** (${t.at}): ${t.text}`)
    .join("\n\n");
  return `---\n${meta.join("\n")}\n---\n\n# Conversation ${conv.id} — ${conversationTitle(conv)}\n\n${body}\n`;
}

// The names of archived conversations (ids), for tools that need to know
// what moved without parsing markdown.
export function loadArchived(): string[] {
  try {
    return fs
      .readdirSync(TRANSCRIPTS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

// Reads one archived transcript back (full text), by conversation id.
export function readArchivedTranscript(id: string): string | null {
  const f = path.join(TRANSCRIPTS_DIR, `${id}.md`);
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return null;
  }
}

export function getConversation(id: string): Conversation | null {
  return loadConversations().find((c) => c.id === id) ?? null;
}

export function markDistilled(id: string): void {
  const all = loadConversations();
  const conv = all.find((c) => c.id === id);
  if (!conv) return;
  conv.distilledAt = new Date().toISOString();
  writeJson(FILE, all);
}

// Conversations the extractor still owes a pass: substantial, settled (older
// than the resume window, so they won't grow mid-extraction), and either never
// distilled or grown since the last distillation.
export function undistilled(settledMinutes: number): Conversation[] {
  const cutoff = Date.now() - settledMinutes * 60_000;
  return loadConversations().filter(
    (c) =>
      c.source !== "heartbeat" &&
      c.turns.length >= 4 &&
      Date.parse(c.updatedAt) < cutoff &&
      (!c.distilledAt || c.distilledAt < c.updatedAt),
  );
}

// The conversation to pick back up after a restart or reconnect: the newest
// one, if it's recent enough to still be "what we were just doing". Sources
// don't matter — a thread started at the desk continues in the app.
export function latestResumable(windowMinutes: number): Conversation | null {
  const newest = loadConversations()[0]; // stored newest-first by recordExchange
  if (!newest || newest.turns.length === 0) return null;
  const ageMs = Date.now() - Date.parse(newest.updatedAt);
  return ageMs <= windowMinutes * 60_000 ? newest : null;
}

// When the session before this one ended — the newest stored conversation that
// isn't the current one. Read it ONCE, at Agent construction: after the first
// recordExchange the current conversation sorts to the front and would shadow
// the real previous session forever after.
export function previousSessionEnd(excludeId: string): string | null {
  const prev = loadConversations().find((c) => c.id !== excludeId); // stored newest-first
  return prev?.updatedAt ?? null;
}

// Has Umberto exchanged a turn with EVE yet today (local day)? This is the
// wake-up fact's ground truth, and it has to be computed PER TURN from the
// store — the model cannot infer it, because "previous session ended
// yesterday" stays true for the WHOLE first conversation of the day, and a
// heartbeat turn (a standing check, an on-demand brief — never recorded as a
// conversation) is EVE talking to herself, not an exchange with him. (The
// morning brief is NOT keyed on this fact — it needs his wake-up words, see
// wakeUpSignal in src/brain/morning.ts; this stays a plain observation.)
// Turns false the moment the
// day's first real exchange completes, so the fact fires exactly once a day
// no matter how many surfaces are open.
export function hasExchangeToday(now = new Date()): boolean {
  const today = localDate(now);
  // Local midnight, per the same wall-clock rule as reminders: comparing
  // local-day strings against UTC instants is how reminders fired two hours
  // late, and this fact would drift the same way.
  const dayStart = Date.parse(`${today}T00:00:00`);
  return loadConversations().some(
    (c) =>
      c.source !== "heartbeat" &&
      // Cheap gate first — conversations are stored newest-first, so a store
      // whose newest activity predates today answers on the first row.
      Date.parse(c.updatedAt) >= dayStart &&
      c.turns.some((t) => localDate(new Date(t.at)) === today),
  );
}

// A short human-readable title for a conversation: its first user line.
export function conversationTitle(conv: Conversation): string {
  const first = conv.turns.find((t) => t.role === "user")?.text ?? "(empty)";
  const oneLine = first.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine;
}

// ── searching what was actually said ───────────────────────────────────────
// Semantic recall over the memory store answers "what do I know about X". It
// cannot answer "what was that error string" or "which shop did he name" —
// embeddings are precisely the wrong tool for an exact token, and those facts
// were never distilled into a memory in the first place. This is the other
// half: a plain lexical scan over the transcripts themselves.

export interface TurnHit {
  conversationId: string;
  title: string;
  /** Where the hit lives: "typed"/"voice"/"face"/"heartbeat" for the live
   * store, "archive" for memory/transcripts/. The tool layer says which
   * reader can follow up (read_conversation vs the archived file). */
  source: string;
  at: string;
  /** Index of the matching turn inside the conversation, for scrolling. */
  index: number;
  role: "user" | "assistant";
  excerpt: string;
  score: number;
}

// Lowercased, de-accented, punctuation flattened to spaces. Umberto writes in
// Italian as often as English, so "perché" typed as "perche" has to match, and
// a name followed by a comma has to match the bare name.
//
// NFD is what does the de-accenting, and it is load-bearing rather than
// decorative: it splits "é" into "e" plus a combining mark, and the alnum
// filter on the next line then drops the mark. Without it the whole character
// is non-alnum and the "e" goes with it, so "perché" normalizes to "perch"
// and an unaccented query silently stops matching.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const EXCERPT_RADIUS = 180;

// A window of the original text around the match — the ORIGINAL, not the
// normalized form: the answer to "what exactly did he write" must come back
// spelled the way he wrote it.
function excerptAround(text: string, norm: string, needle: string): string {
  const at = norm.indexOf(needle);
  if (at < 0) return text.slice(0, EXCERPT_RADIUS * 2).trim();
  // The normalized string is built with per-character replacements that can
  // collapse runs, so its offsets only approximate the original's. Close
  // enough for a window; the whole turn is one read_conversation away.
  const from = Math.max(0, at - EXCERPT_RADIUS);
  const to = Math.min(text.length, at + needle.length + EXCERPT_RADIUS);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`;
}

// One archived transcript as a live-shaped conversation, so the SAME scoring
// pass covers both shelves. Malformed files are skipped, never a crash —
// same tolerance as every other reader in this codebase.
function archivedAsConversation(file: string): Conversation | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(TRANSCRIPTS_DIR, file), "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  if (!meta.id || !meta.turns) return null;
  // Rebuild the turns from the rendered body. The renderer writes
  // "**Role** (at): text" blocks — the same verbatim texts, round-tripped.
  const turns: ConvTurn[] = [];
  const re = /\*\*(Umberto|EVE)\*\* \(([^)]+)\): ([\s\S]*?)(?=\n\n\*\*(?:Umberto|EVE)\*\*|$)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(m[2]!)) !== null) {
    turns.push({
      role: mm[1] === "Umberto" ? "user" : "assistant",
      text: mm[3]!.trim(),
      at: mm[2]!,
    });
  }
  if (turns.length === 0) return null;
  return {
    id: meta.id,
    startedAt: meta.startedAt ?? "",
    updatedAt: meta.updatedAt ?? meta.startedAt ?? "",
    source: "archive",
    turns,
    ...(meta.distilledAt ? { distilledAt: meta.distilledAt } : {}),
  };
}

export function searchConversations(query: string, limit = 5): TurnHit[] {
  const nq = normalize(query);
  const terms = [...new Set(nq.split(" ").filter((t) => t.length >= 2))];
  if (terms.length === 0) return [];

  // Both shelves, live store first so a hit in each sorts by its own recency.
  let archived: string[] = [];
  try {
    archived = fs.readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    archived = []; // no archive yet = honestly empty, not broken
  }
  const convs: Conversation[] = [
    ...loadConversations(),
    ...archived
      .map(archivedAsConversation)
      .filter((c): c is Conversation => c !== null),
  ];

  const hits: TurnHit[] = [];
  for (const conv of convs) {
    const title = conversationTitle(conv);
    conv.turns.forEach((turn, index) => {
      const norm = normalize(turn.text);
      const matched = terms.filter((t) => norm.includes(t));
      if (matched.length === 0) return;
      const phrase = terms.length > 1 && norm.includes(nq);
      const coverage = matched.length / terms.length;
      // Half the terms, or the whole phrase. Without a floor, a three-word
      // query comes back with every turn that happens to contain "the".
      if (!phrase && coverage < 0.5) return;
      hits.push({
        conversationId: conv.id,
        title,
        source: conv.source,
        at: turn.at,
        index,
        role: turn.role,
        excerpt: excerptAround(turn.text, norm, phrase ? nq : matched[0]!),
        score: coverage + (phrase ? 1 : 0),
      });
    });
  }

  // Best match first, then the most recent — when two turns say the same thing
  // the later one is usually the one that still holds.
  return hits
    .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at))
    .slice(0, Math.max(1, limit));
}

// Turns either side of a point in one conversation, for reading around a hit.
// Bounded in both directions: a caller asking for a window must not be able to
// pull a 200-turn transcript into the context window.
export function conversationWindow(
  id: string,
  around?: number,
  radius = 4,
): { conv: Conversation; from: number; turns: ConvTurn[] } | null {
  const conv = getConversation(id);
  if (!conv || conv.turns.length === 0) return null;
  const r = Math.min(Math.max(1, radius), 12);
  const centre = around === undefined ? conv.turns.length - 1 : Math.min(Math.max(0, around), conv.turns.length - 1);
  const from = Math.max(0, centre - r);
  return { conv, from, turns: conv.turns.slice(from, Math.min(conv.turns.length, centre + r + 1)) };
}
