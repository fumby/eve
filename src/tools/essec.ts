// essec_knowledge — EVE's own knowledge about Umberto's university. He started
// the Global BBA at ESSEC (Cergy campus) in September 2026, and almost
// everything that matters about that school lives behind a login: myESSEC's
// agenda, the program centre, the registrar's pages, the news. A search engine
// cannot see any of it, so EVE reads it the way he does — through HIS logged-in
// Chrome (the dedicated EVE profile, src/tools/cdp.ts) — and keeps what she
// learns in data/essec-knowledge.json, one entry per page, each carrying the
// URL and date it came from.
//
// Four rules this file exists to enforce, each with a failure behind it:
//
// 1. NO ENTRY WITHOUT PROVENANCE. Every entry names the URL and the day it was
//    read. "ESSEC knowledge" with no source is indistinguishable from a model
//    inventing a deadline — the same reason memories carry source/confirmed/
//    verified (src/memory/store.ts).
// 2. ESSEC HOSTS ONLY. This tool drives a browser holding Umberto's live
//    sessions — his Gmail, his Drive, his bank if he ever logs in there. An
//    ungated "fetch any URL in his browser" tool is a confused-deputy hole, so
//    the host allowlist is checked before Chrome is even started. General web
//    reading is fetch_url's job, on an anonymous fetch.
// 3. NOTHING PERSONAL LANDS HERE. The registrar page (/service/mon-registraire)
//    renders his birth date, home address, phone numbers, national student
//    number and his family's contact details. This was not hypothetical — it is
//    what the first live read of that page returned. A knowledge file about a
//    SCHOOL has no business holding any of it, and this store is read back into
//    prompts, so the guard refuses the whole entry rather than trimming it.
// 4. HONEST EMPTINESS. If the session is logged out, or the page is a login
//    wall, the tool says so and stores nothing. Fabricated school knowledge is
//    worse than no school knowledge: he would act on it.
//
// Browsing is read-only on the world (it navigates a scratch tab and reads
// text), so it is NOT Tier-6 gated — it sends nothing, spends nothing, deletes
// nothing, changes no setting. And nothing here runs on the heartbeat: building
// knowledge is something Umberto or EVE-in-conversation decides to do, never a
// background crawl of his school account while nobody is watching.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { readJson, writeJson } from "../core/store.js";
import { isSensitive } from "../memory/store.js";
import { ensureChrome, openScratchTab, closeTab, Cdp, sleep } from "./cdp.js";
import { audit } from "../core/audit.js";
// localDate, not toISOString(): "today" for a briefing is his wall clock, and
// UTC flips the day on a late-evening run in Europe/Rome.
import { localDate } from "../core/time.js";

export const ESSEC_SECTIONS = [
  "campus",
  "program",
  "courses",
  "deadlines",
  "services",
  "contacts",
  "faq",
  "misc",
] as const;
export type EssecSection = (typeof ESSEC_SECTIONS)[number];

// Bumped only when the shape below changes in a way an older EVE would
// misread. saveEntries refuses to write over a file stamped NEWER than this,
// because the older shape would silently drop the fields it doesn't know.
export const SCHEMA_VERSION = 1;

export interface EssecSource {
  // The URL as ASKED for: canonical, fragment stripped, and the merge key.
  // Deliberately not the final URL — myESSEC redirects, and some of those
  // land on addresses carrying a per-session nonce, which as a key would mint
  // a brand new entry on every run and quietly break idempotency.
  url: string;
  fetchedAt: string; // ISO instant of the read that produced this text
  finalUrl?: string; // where the browser actually ended up, when it differs
}

export interface EssecEntry {
  section: EssecSection;
  title: string;
  text: string;
  source: EssecSource; // REQUIRED. An entry without one is refused, not defaulted.
  note?: string; // why this page was worth keeping, in Umberto's terms
  // Same provenance vocabulary as memories: a page EVE read is not the same
  // as a fact Umberto looked at and said yes to.
  confirmed?: boolean;
  verified?: string; // YYYY-MM-DD, last time it was checked against reality
}

export interface EssecKnowledge {
  schemaVersion: number;
  updatedAt: string;
  entries: EssecEntry[];
  // Rows that came off disk without usable provenance. They are kept — the
  // file is hand-editable and a slip must never cost Umberto what he wrote —
  // but they are held apart from `entries` so nothing downstream dereferences
  // a missing `source`. The review found this: one hand-added row with no
  // `source` made read/search/browse all throw, and the tool stopped working
  // entirely while the 27 good entries sat there intact.
  ignoredRows: unknown[];
}

const FILE = "essec-knowledge.json";

// Sanity bounds. A store nobody can read is not knowledge, and an unbounded
// scrape of a WordPress site will happily grow until the prompt that loads it
// costs more than the answer. These are the ceilings, not a target.
export const MAX_ENTRIES = 300;
export const MAX_ENTRY_CHARS = 8000;
export const MAX_STORE_CHARS = 1_500_000;
// The ceiling on ONE render back into a prompt. Separate from the store's own
// cap on purpose: the store may hold everything his school says, but a single
// "read" must stay something a turn can afford to carry.
export const MAX_RENDER_CHARS = 20_000;

// Rule 2. Anchored at a dot or the start, so "essec.fr.evil.example" — the
// lookalike host that a prefix match would wave through — does not pass.
const ESSEC_HOST = /(^|\.)essec\.(fr|edu)$/i;

export function isEssecUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && ESSEC_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

// The merge key. Two reads of the same page must update one entry, not stack
// up — so the fragment goes (my.essec.fr/en/#calendar is the home page), the
// host is lowercased, and a trailing slash is dropped. The QUERY STRING stays:
// the program centre's sections are ?category=academics, ?category=study-plan…
// and dropping it would collapse seven different pages into one.
export function canonicalUrl(url: string): string {
  const u = new URL(url); // throws on nonsense — callers below hold a validated URL

  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

// The same key, but total. Used when comparing against URLs ALREADY IN THE
// STORE, which is a plain JSON file Umberto is invited to hand-edit — house
// doctrine is that every state file is readable and editable by hand. One typo
// in one url there made canonicalUrl throw inside the merge lookup, and since
// that lookup runs for every incoming entry, a single malformed line bricked
// every future save of every page. A URL we cannot parse simply keys as
// itself: it will never match a real one, so the bad row is inert instead of
// fatal.
function canonicalKey(url: string): string {
  try {
    return canonicalUrl(url);
  } catch {
    return url;
  }
}

// ── the store ────────────────────────────────────────────────────────────

// The shape every reader downstream is allowed to assume. Checked here, once,
// because `entries` comes from a JSON file a human is invited to edit.
function isUsableEntry(e: unknown): e is EssecEntry {
  const x = e as Partial<EssecEntry> | null;
  return (
    !!x &&
    typeof x === "object" &&
    typeof x.title === "string" &&
    typeof x.text === "string" &&
    typeof x.section === "string" &&
    !!x.source &&
    typeof x.source === "object" &&
    typeof x.source.url === "string" &&
    x.source.url.length > 0 &&
    typeof x.source.fetchedAt === "string" &&
    x.source.fetchedAt.length > 0
  );
}

export function loadKnowledge(): EssecKnowledge {
  const raw = readJson<Partial<EssecKnowledge>>(FILE, {});
  const rows: unknown[] = Array.isArray(raw.entries) ? raw.entries : [];
  const kept = Array.isArray(raw.ignoredRows) ? [...raw.ignoredRows] : [];
  return {
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : SCHEMA_VERSION,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    entries: rows.filter(isUsableEntry),
    ignoredRows: [...kept, ...rows.filter((r) => !isUsableEntry(r))],
  };
}

function saveKnowledge(k: EssecKnowledge): void {
  // Written field by field, so nothing derived leaks into the file and the
  // quarantined rows survive the round trip instead of being silently dropped.
  const onDisk = {
    schemaVersion: k.schemaVersion,
    updatedAt: k.updatedAt,
    entries: k.entries,
    ...(k.ignoredRows.length > 0 ? { ignoredRows: k.ignoredRows } : {}),
  };
  const serialised = JSON.stringify(onDisk);
  if (serialised.length > MAX_STORE_CHARS) {
    throw new Error(
      `the ESSEC knowledge store would be ${Math.round(serialised.length / 1000)}k characters ` +
        `(cap ${Math.round(MAX_STORE_CHARS / 1000)}k). Nothing was written. Prune entries before adding more.`,
    );
  }
  writeJson(FILE, onDisk);
}

/**
 * Merge entries in by section + canonical URL. Re-running a seed updates the
 * text and the fetch date in place; it never appends a second copy. That
 * idempotency is the whole reason the URL is the key.
 */
export function saveEntries(incoming: EssecEntry[]): { added: number; updated: number } {
  const current = loadKnowledge();
  if (current.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `data/${FILE} is schema v${current.schemaVersion} and this build understands v${SCHEMA_VERSION}. ` +
        "Refusing to write: an older shape would drop the fields it cannot see.",
    );
  }

  let added = 0;
  let updated = 0;
  for (const entry of incoming) {
    // Rule 1, at the one function that writes. A caller that forgets IS the
    // hole, so this throws instead of quietly stamping a default.
    if (!entry.source?.url || !entry.source.fetchedAt) {
      throw new Error(`refusing to store "${entry.title}" — an ESSEC entry must carry its source URL and fetch date`);
    }
    if (!isEssecUrl(entry.source.url)) {
      throw new Error(`refusing to store "${entry.title}" — ${entry.source.url} is not an ESSEC address`);
    }
    if (!ESSEC_SECTIONS.includes(entry.section)) {
      throw new Error(`refusing to store "${entry.title}" — "${entry.section}" is not one of: ${ESSEC_SECTIONS.join(", ")}`);
    }
    const key = canonicalUrl(entry.source.url);
    const stored: EssecEntry = {
      ...entry,
      title: entry.title.trim().slice(0, 200),
      text: entry.text.trim().slice(0, MAX_ENTRY_CHARS),
      source: {
        url: key,
        fetchedAt: entry.source.fetchedAt,
        ...(entry.source.finalUrl ? { finalUrl: entry.source.finalUrl } : {}),
      },
    };
    const i = current.entries.findIndex((e) => e.section === entry.section && canonicalKey(e.source.url) === key);
    if (i >= 0) {
      // A hand-added `confirmed` survives a re-read: Umberto saying "yes, that
      // is right" is his fact about the entry, not the page's.
      current.entries[i] = { ...current.entries[i], ...stored };
      updated++;
    } else {
      if (current.entries.length >= MAX_ENTRIES) {
        throw new Error(
          `the ESSEC store already holds ${current.entries.length} entries (cap ${MAX_ENTRIES}). ` +
            `"${stored.title}" was not added — prune first.`,
        );
      }
      current.entries.push(stored);
      added++;
    }
  }
  current.schemaVersion = SCHEMA_VERSION;
  current.updatedAt = new Date().toISOString();
  saveKnowledge(current);
  return { added, updated };
}

// ── reading it back ──────────────────────────────────────────────────────

function entryHeader(e: EssecEntry): string {
  const day = e.source.fetchedAt.slice(0, 10);
  const mark = e.confirmed ? " ✓" : "";
  const via = e.source.finalUrl ? ` → ${e.source.finalUrl}` : "";
  return `[${e.section}] ${e.title}${mark}\n  source: ${e.source.url}${via} (read ${day})`;
}

export function renderKnowledge(section?: EssecSection, maxCharsPerEntry = 1200): string {
  const k = loadKnowledge();
  const entries = section ? k.entries.filter((e) => e.section === section) : k.entries;
  if (entries.length === 0) {
    return section
      ? `Nothing stored under "${section}" yet. Browse a myESSEC page into it with essec_knowledge/browse.`
      : "The ESSEC knowledge store is empty. Nothing has been read from myESSEC yet — say so plainly rather than guessing about his school.";
  }
  const quarantined = k.ignoredRows.length > 0
    ? ` ${k.ignoredRows.length} row(s) in the file carry no source and are held aside, unused — tell Umberto if he asks why a page seems missing.`
    : "";
  const head = `ESSEC knowledge — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${
    section ? ` in "${section}"` : ` across ${new Set(entries.map((e) => e.section)).size} sections`
  }, last updated ${k.updatedAt.slice(0, 10) || "never"}.${quarantined}`;

  // A ceiling on the WHOLE render, not just on each entry. This function was
  // written when the store held 27 pages and a full read was a couple of
  // thousand characters; the deeper crawl took it to 95, and "read section
  // courses" — which the daily briefing asks for by name — became 31,000
  // characters of prompt every morning, with the two classes he actually has
  // today buried in forty course pages. Growth in the store must not silently
  // become growth in every prompt.
  //
  // What is cut is SAID, with the way to get it: an answer that quietly stops
  // early is the same failure as a scrape that quietly stored nothing.
  const blocks: string[] = [];
  let used = head.length;
  let shown = 0;
  for (const e of entries) {
    const block = `${entryHeader(e)}${e.note ? `\n  note: ${e.note}` : ""}\n${e.text.slice(0, maxCharsPerEntry)}`;
    if (shown > 0 && used + block.length > MAX_RENDER_CHARS) break;
    blocks.push(block);
    used += block.length + 2;
    shown++;
  }
  const omitted = entries.length - shown;
  const tail =
    omitted > 0
      ? `\n\n(${omitted} further entr${omitted === 1 ? "y is" : "ies are"} stored and not shown here — this is a length cap, not the end of what is known. ` +
        `Use essec_knowledge/search with a keyword to reach a specific one.)`
      : "";
  return [head, ...blocks].join("\n\n") + tail;
}

export interface EssecHit {
  entry: EssecEntry;
  score: number;
  excerpt: string;
}

/**
 * Keyword search over titles, notes and page text. Deliberately lexical and
 * dependency-free: this store is small, and a semantic index here would be one
 * more thing that can be stale about a school that changes its rooms weekly.
 */
export function searchKnowledge(query: string, limit = 6): EssecHit[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  if (words.length === 0) return [];
  const hits: EssecHit[] = [];
  for (const entry of loadKnowledge().entries) {
    const title = entry.title.toLowerCase();
    const note = (entry.note ?? "").toLowerCase();
    const text = entry.text.toLowerCase();
    let score = 0;
    let firstAt = -1;
    for (const w of words) {
      if (title.includes(w)) score += 5;
      if (note.includes(w)) score += 3;
      const at = text.indexOf(w);
      if (at >= 0) {
        score += 1;
        if (firstAt < 0 || at < firstAt) firstAt = at;
      }
    }
    if (score === 0) continue;
    const start = firstAt < 0 ? 0 : Math.max(0, firstAt - 120);
    hits.push({ entry, score, excerpt: entry.text.slice(start, start + 400) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── his timetable, read back out of what was stored ──────────────────────
//
// The briefing needs one specific thing out of this store — "what has he got
// today" — and it must get it WITHOUT touching the browser. Everything below
// is pure: it reads entries that are already on disk, and there is deliberately
// no path from here to browsePages. The heartbeat runs unattended, and a
// crawl of his school account while nobody is watching is exactly what rule 4
// at the top of this file forbids.

export interface ClassSession {
  date: string; // YYYY-MM-DD, the day the session runs
  start: string; // HH:MM
  end: string; // HH:MM, or "" when the page only gave a start
  course: string;
  room: string; // "Classroom P.101 | P | Campus Cergy", verbatim; "" if absent
  professor: string;
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

// "7 September 2026" — myESSEC renders the English pages with no leading zero.
const LONG_DATE = /^(\d{1,2}) ([A-Za-zéûà]+) (\d{4})$/;
// "08:30 – 11:30". The separator is a U+2013 EN DASH on the live pages, but a
// hyphen and an em dash cost nothing to accept and one of them will show up.
const TIME_RANGE = /^(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})$/;
// "2026-09-07 08:30" — the agenda pages' own machine-readable stamp.
const ISO_STAMP = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2})$/;
// Lines that are labels or modality, never a course name or a professor.
const LABEL = /^(onsite|online|hybrid|remote|distanciel|présentiel|presentiel|date|schedule|location|horaire|lieu|access moodle|cours|course|sessions|trombinoscope|attendance)$/i;
const LOOKS_LIKE_ROOM = /(^classroom\b|\bcampus\b|\bamphi|\bsalle\b)/i;

function longDateToIso(day: string, month: string, year: string): string | null {
  const m = MONTHS[month.toLowerCase()];
  return m ? `${year}-${m}-${day.padStart(2, "0")}` : null;
}

/**
 * Pull class sessions out of a stored page's text. Two shapes exist in the
 * store and both are real, so both are parsed rather than one being blessed:
 *
 *  A. The myESSEC home page's "COMING SOON" list — six lines, no labels, back
 *     to back: ONSITE / course / "7 September 2026" / "08:30 – 11:30" /
 *     "Classroom P.101 | P | Campus Cergy" / professor. Anchored on the date
 *     line being IMMEDIATELY followed by the time range, because "ONSITE" is
 *     not guaranteed (an online session says something else) while those two
 *     adjacent lines are the shape itself.
 *
 *  B. A per-session /en/agenda/<id> page — labelled, with the date and start
 *     time also given as a machine stamp ("2026-09-07 08:30"). Anchored on that
 *     stamp: it needs no month-name table and cannot be confused with prose.
 *
 * Anything it cannot parse it simply does not return. A timetable line invented
 * from a half-matched page would be worse than silence — the briefing speaks
 * these out loud as fact.
 */
export function parseSessions(text: string): ClassSession[] {
  const lines = text.split("\n").map((l) => l.trim());
  const out: ClassSession[] = [];
  const at = (i: number): string => lines[i] ?? "";

  for (let i = 0; i < lines.length; i++) {
    const line = at(i);

    // Shape B first: the stamp is unambiguous, and an agenda page also holds a
    // long date further down that shape A's rule would (correctly) ignore.
    const stamp = ISO_STAMP.exec(line);
    if (stamp) {
      const after = lines.slice(i + 1, i + 14);
      const course = after.find((l) => l.length > 1 && !LABEL.test(l) && !/^\d/.test(l)) ?? "";
      const timeAt = after.findIndex((l) => TIME_RANGE.test(l));
      const range = timeAt >= 0 ? TIME_RANGE.exec(after[timeAt] ?? "") : null;
      const roomAt = after.findIndex((l) => LOOKS_LIKE_ROOM.test(l));
      const room = roomAt >= 0 ? (after[roomAt] ?? "") : "";
      // The professor follows the room — except that an ONLINE session has no
      // "Location" block at all, and then the name sits directly under the time
      // instead. Anchoring only on the room lost the teacher of every online
      // course in the store (his Spanish class, live: room genuinely absent,
      // "Mari Sol GARCIA SOMOZA" right there on the next line and dropped).
      const profAt = roomAt >= 0 ? roomAt + 1 : timeAt + 1;
      const maybeProf = timeAt >= 0 || roomAt >= 0 ? (after[profAt] ?? "") : "";
      out.push({
        date: stamp[1] ?? "",
        start: range?.[1] ?? stamp[2] ?? "",
        end: range?.[2] ?? "",
        course,
        room,
        // No e-mail: the address is on the line below the name, and the briefing
        // says a person out loud rather than reading out a mailbox.
        professor: !LABEL.test(maybeProf) && !maybeProf.includes("@") && /[A-Za-zÀ-ÿ]/.test(maybeProf) ? maybeProf : "",
      });
      continue;
    }

    // Shape A: date line, then the time range on the very next line.
    const long = LONG_DATE.exec(line);
    const range = TIME_RANGE.exec(at(i + 1));
    if (!long || !range) continue;
    const iso = longDateToIso(long[1] ?? "", long[2] ?? "", long[3] ?? "");
    if (!iso) continue;
    const course = at(i - 1);
    if (!course || LABEL.test(course)) continue; // no course name = not a session block
    const room = LOOKS_LIKE_ROOM.test(at(i + 2)) ? at(i + 2) : "";
    const prof = room ? at(i + 3) : at(i + 2);
    out.push({
      date: iso,
      start: range[1] ?? "",
      end: range[2] ?? "",
      course,
      room,
      professor: !LABEL.test(prof) && /[A-Za-zÀ-ÿ]/.test(prof) ? prof : "",
    });
  }
  return out;
}

/** Every session the store knows about, deduplicated and in time order. */
export function storedSessions(): { sessions: ClassSession[]; readDay: string } {
  const seen = new Set<string>();
  const sessions: ClassSession[] = [];
  let readAt = "";
  for (const e of loadKnowledge().entries) {
    // Timetable pages are filed under "courses"; nothing else is scanned, so a
    // news item quoting a date and a time cannot become a lecture.
    if (e.section !== "courses") continue;
    for (const s of parseSessions(e.text)) {
      const key = `${s.date}|${s.start}|${s.course.toLowerCase()}`;
      if (seen.has(key)) continue; // the home page and an agenda page overlap
      seen.add(key);
      sessions.push(s);
    }
    if (e.source.fetchedAt > readAt) readAt = e.source.fetchedAt;
  }
  sessions.sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
  return { sessions, readDay: readAt.slice(0, 10) };
}

/** What the stored timetable says about one day — the reading itself, with
 *  no opinion about what to say. Four states, because two of the "nothing"
 *  cases are opposites: "none" is a real answer (the snapshot covers today
 *  and lists nothing), "stale" is the snapshot running out BEFORE today, and
 *  "empty" is no timetable stored at all. Collapsing any two of them is how a
 *  free day gets asserted on a lecture morning. */
export interface ClassesToday {
  status: "classes" | "none" | "stale" | "empty";
  readDay: string; // YYYY-MM-DD the snapshot was read; "" when empty
  coversThrough: string; // the last day the snapshot lists; "" when empty
  today: ClassSession[]; // in time order; filled only for "classes"
}

/**
 * The reading behind both consumers of the timetable: the on-demand brief's
 * digest below, and the wake-up context block (src/brain/prompt.ts), which
 * renders it as a fact in its own language and must carry no guidance at all
 * (tests/morning.test.ts pins that). So this returns data, and the words —
 * including what to say about a stale snapshot — are each caller's own.
 *
 * The staleness case is the one that earns this function. The myESSEC home page
 * lists only the next few sessions, so a store read a fortnight ago has NOTHING
 * to say about today — and "no classes today" would be a lie told confidently.
 * So the reading compares today against the last day the snapshot actually
 * covers, and says it cannot answer when it cannot.
 */
export function classesToday(now = new Date()): ClassesToday {
  const { sessions, readDay } = storedSessions();
  if (sessions.length === 0) return { status: "empty", readDay: "", coversThrough: "", today: [] };
  const today = localDate(now);
  const coversThrough = sessions[sessions.length - 1]?.date ?? "";
  const todays = sessions.filter((s) => s.date === today);
  if (todays.length > 0) return { status: "classes", readDay, coversThrough, today: todays };
  if (today > coversThrough) return { status: "stale", readDay, coversThrough, today: [] };
  return { status: "none", readDay, coversThrough, today: [] };
}

/**
 * The on-demand brief's class line (`npm run brief`, and any daily_briefing
 * heartbeat check), built from the store alone — the same trick as
 * buildWatchDigest in standing-checks.ts, and for the same reason: it must
 * reach the brief even on the path where essec_knowledge is not registered
 * (scripts/brief-now.ts builds a small registry), and even if the model skips
 * the tool call. This is the one consumer that attaches GUIDANCE to the stale
 * case, because a heartbeat turn has nobody at the keyboard: it must not
 * browse, and it must say plainly what it cannot know. The spoken morning
 * brief (the wake-up exchange) gets the same reading through
 * src/brain/morning.ts, without these words — identity supplies its own.
 */
export function buildClassesDigest(now = new Date()): string {
  const reading = classesToday(now);
  if (reading.status === "empty") return ""; // nothing stored: add nothing to the prompt
  const { readDay, coversThrough } = reading;
  if (reading.status === "classes") {
    const lines = reading.today.map((s) => {
      const when = s.end ? `${s.start}–${s.end}` : s.start;
      const where = s.room ? ` — ${s.room}` : "";
      const who = s.professor ? ` (${s.professor})` : "";
      return `- ${when} ${s.course}${where}${who}`;
    });
    return (
      `His ESSEC classes today, from the myESSEC timetable stored on ${readDay} ` +
      `(a stored page read, not live):\n${lines.join("\n")}`
    );
  }
  if (reading.status === "stale") {
    return (
      `The stored myESSEC timetable was read on ${readDay} and only runs to ${coversThrough}, ` +
      `so it cannot say what he has today. Say that plainly rather than implying a free day, ` +
      `and offer to refresh it when he is at his machine — never browse from the briefing.`
    );
  }
  return `No ESSEC classes today in the myESSEC timetable stored on ${readDay}, which covers through ${coversThrough}.`;
}

// ── reading a page ───────────────────────────────────────────────────────

export interface PageRead {
  url: string;
  title: string;
  // The page as it will be STORED: boilerplate stripped.
  text: string;
  // The page as innerText handed it over. Kept because the logged-in shell —
  // "MY ACCOUNT", "NOTIFICATIONS", "Logout" — is precisely the furniture that
  // stripChrome removes, so asking `text` whether we are logged in always
  // answered "unknown" and the seed stopped on a session that was fine. The
  // login check reads this; nothing else does, and it is never persisted.
  raw: string;
  // A real password box on the page. This is the login signal that works:
  // matching prose for "se connecter" refused eduroam.essec.fr, whose French
  // documentation explains how to *connect to the wifi* — ordinary words, not
  // a login wall. A password input is not a turn of phrase.
  hasPasswordField: boolean;
  // Same-origin ESSEC links found on the page. Not stored in an entry — they
  // are how the seed finds this week's news items instead of hardcoding a list
  // that is stale the day after it is written.
  links: string[];
}

// myESSEC is a WordPress site: the same header and footer are in the innerText
// of every page. On a short service page that boilerplate was 40% of the text,
// so it is stripped here — in TypeScript, not in the injected JS, so it is a
// pure function the suite can test without a browser anywhere near it.
const CHROME_LINES = new Set(
  [
    "rechercher",
    "search",
    "notifications",
    "contact",
    "my account",
    "mon compte",
    "tools",
    "outils",
    "fr",
    "en",
    "|",
    "essec.fr",
    "essec knowledge",
    "respect for others",
    "download myessec app",
    "legal informations | personal data protection policy",
    "mentions légales | politique de confidentialité",
  ].map((s) => s.toLowerCase()),
);

export function stripChrome(text: string): string {
  const out: string[] = [];
  let prevWasNotificationsLabel = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const low = line.toLowerCase();
    // The notification badge is a bare count that only ever follows the
    // "NOTIFICATIONS" label. Anchored to that, rather than to "a small number
    // near the top": the news and event cards put the DAY on its own line, and
    // the loose version silently deleted it — leaving "September 2026" with no
    // date on exactly the entries stored under "deadlines".
    if (prevWasNotificationsLabel && /^\d{1,3}$/.test(line)) {
      prevWasNotificationsLabel = false;
      continue;
    }
    prevWasNotificationsLabel = low === "notifications";
    if (CHROME_LINES.has(low)) continue;
    if (/^myessec ©\s*groupe essec/i.test(line)) continue; // the year moves; the line doesn't
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Is this page the logged-in myESSEC, a login wall, or something we can't
 * tell? Deliberately three-valued, and "in" needs POSITIVE evidence — a
 * logged-in shell we can see — rather than the absence of a login form. The
 * seed refuses to run on anything but "in": an empty scrape reported as
 * success is exactly how a knowledge store fills up with nothing.
 */
export function loginState(page: PageRead): "in" | "out" | "unknown" {
  const text = page.raw.toLowerCase();
  const url = page.url.toLowerCase();
  if (/\/(login|signin|connexion|sso|cas|auth)\b/.test(url) || /\baccounts\.google\.com|login\.microsoftonline/.test(url)) {
    return "out";
  }
  if (page.hasPasswordField) return "out"; // a real login box, whatever it says
  if (/\b(my account|mon compte|logout|déconnexion|deconnexion|notifications)\b/.test(text)) return "in";
  return "unknown";
}

// Rule 3. The markers are DATA LABELS, not his name — his name is in the nav
// of every page, and matching it would refuse the whole site. Two distinct
// markers are required because a single "nationality" can appear in ordinary
// prose on an exchange page; the registrar record trips six at once.
const PERSONAL_MARKERS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bbirth ?date\b|\bdate de naissance\b|\bbirthplace\b|\blieu de naissance\b/i, label: "birth date" },
  { pattern: /\bnationality\b|\bnationalité\b/i, label: "nationality" },
  { pattern: /\bINE\b\s*\n?\s*\d/i, label: "national student number" },
  { pattern: /\bpersonal e-?mail\b|\be-?mail personnel\b/i, label: "personal e-mail" },
  { pattern: /\benrollment status\b|\bstatut d'inscription\b/i, label: "enrolment record" },
  { pattern: /\bb00\d{6}\b/i, label: "student id" },
  { pattern: /\bemergency contact\b|\bcontact d'urgence\b|\blearner record\b/i, label: "emergency contact" },
  { pattern: /\bmy ISIC card\b|\bcarte ISIC\b/i, label: "ISIC card" },
  { pattern: /\biban\b|\bcarte bancaire\b|\bcard number\b/i, label: "payment details" },
  // The review's catch: the header of this file promises to keep out his "home
  // address, phone numbers and his family's contact details", and there was no
  // pattern for any of the three — /service/mon-registraire was refused only
  // because it happened to trip several unrelated markers at once. A page
  // rendering just his coordinates matched nothing and would have been stored.
  // Qualified rather than bare: "address" and "phone number" appear on the
  // school's own contact pages, and refusing those would empty the store.
  {
    pattern: /\b(home|personal|postal|mailing) address\b|\badresse (personnelle|postale|de r[ée]sidence)\b|\bmes coordonn[ée]es\b|\bmy contact details\b/i,
    label: "home address",
  },
  {
    pattern: /\bt[ée]l[ée]phone (portable|fixe|personnel)\b|\b(mobile|home|personal) (phone|number)\b|\bnum[ée]ro de portable\b/i,
    label: "personal phone",
  },
  {
    pattern: /\b(next of kin|parent\/guardian|responsable l[ée]gal|personne à prévenir)\b/i,
    label: "family contact",
  },
];

// Markers that mean "this is a person's record" on their own. A school page
// does not render a national student number or a date of birth in passing, and
// requiring a SECOND marker before refusing let a page whose only personal
// content was an emergency contact through — one marker, stored.
const STRONG_MARKERS = new Set([
  "national student number",
  "student id",
  "birth date",
  "emergency contact",
  "family contact",
]);

export function personalMarkers(text: string): string[] {
  return PERSONAL_MARKERS.filter((m) => m.pattern.test(text)).map((m) => m.label);
}

/**
 * The one place that decides whether a page may become an entry. Returns null
 * when it may, or the plain-language reason it may not — which is what the
 * tool and the seed both print. No bypass flag: a "store it anyway" argument
 * is a hole that a model can talk itself through.
 */
export function refusalReason(page: PageRead): string | null {
  // THE REDIRECT HOLE, found on the first live crawl. The allowlist was checked
  // on the URL we ASK for, but myESSEC's "service" pages are mostly redirects:
  // /service/offres-de-monitorat lands on docs.google.com, /service/forums-et-
  // evenements-carrieres on jobteaser.com, /service/faq-registraire on
  // ernest.essec.edu. Two of those are third-party sites Umberto is logged into
  // in this very profile, so an allowlist that only looks at the request is an
  // open redirect straight through the confused-deputy guard — this tool would
  // have read a Google Sheet of his and stored it. Checked here, on the URL the
  // browser actually ended up at, and it fires before anything else.
  //
  // Honest about what this does and doesn't buy: the page has already loaded by
  // the time we can see where it went. What the check prevents is that content
  // being READ INTO the store and back into EVE's prompt. Stopping the
  // navigation itself would need request interception, which is a bigger
  // machine than this one.
  if (!isEssecUrl(page.url)) {
    let host = page.url;
    try {
      host = new URL(page.url).hostname;
    } catch {
      /* keep the raw string — a URL we can't parse is a reason in itself */
    }
    return `that myESSEC link redirects off ESSEC to ${host}, and this tool only reads ESSEC pages — it is running in the browser holding every session Umberto has, so nothing from there is stored`;
  }
  const state = loginState(page);
  if (state === "out") {
    return "that page is a login wall, not the page itself — myESSEC is not logged in in EVE's Chrome profile";
  }
  if (page.text.trim().length < 60) {
    return "the page came back with almost no text (it may still have been loading, or it needs a click to open)";
  }
  const personal = personalMarkers(`${page.raw}\n${page.text}`);
  if (personal.length >= 2 || personal.some((m) => STRONG_MARKERS.has(m))) {
    return `that page is Umberto's personal record (${personal.slice(0, 4).join(", ")}) — his own data, not knowledge about the school; nothing was stored`;
  }
  if (isSensitive(`${page.raw}\n${page.text}`)) {
    // The shared filter from the memory store, applied as-is rather than
    // softened for web pages. It costs something real — the registrar FAQ is
    // refused because its help articles are ABOUT passwords — and that is the
    // trade accepted on purpose: a student portal is exactly the kind of place
    // that renders "your temporary password is …" on a page, and a second,
    // weaker filter for scraped text would be the hole. Reported, so the loss
    // is visible and he can read the page himself.
    return (
      "that page trips the credential filter, and this store is plain text read back into prompts; " +
      "nothing was stored. The filter does not try to tell a leaked password from a help page that " +
      "merely talks about one — if it is the latter, read it yourself"
    );
  }
  return null;
}

// ── driving the browser ──────────────────────────────────────────────────

// A page is "ready" when the document is complete AND the text has stopped
// growing. myESSEC renders its agenda client-side and took ~6.5s live; a fixed
// sleep would either truncate the slow pages or waste minutes across a crawl.
async function readPage(cdp: Cdp, url: string): Promise<PageRead> {
  await cdp.send("Page.navigate", { url });
  let last = -1;
  let stableFor = 0;
  for (let i = 0; i < 26; i++) {
    await sleep(600);
    const len = await cdp.eval(
      `(document.readyState === "complete" && document.body) ? document.body.innerText.length : -1`,
    );
    const n = typeof len === "number" ? len : -1;
    if (n > 120 && n === last) {
      stableFor++;
      if (stableFor >= 2) break; // two quiet polls in a row = rendered
    } else {
      stableFor = 0;
    }
    last = n;
  }

  // WHERE WE ARE comes from the browser, and WHAT IS ON THE PAGE is read in a
  // world the page cannot reach into. The review found the hole this closes:
  // the first version asked the page for everything through one
  // JSON.stringify({...}) call in the page's own main world, where
  // JSON.stringify is a writable global. A document that redefines it chooses
  // what this function returns — including the URL that the host check, the
  // login check and the personal-record scan all judge. The guard that is the
  // entire reason this tool is left ungated was taking the word of the thing it
  // was guarding against.
  //
  // location.href is [Unforgeable], but it never reached us unforged: only its
  // rendering did. So the URL is now Page.getFrameTree's, which page JS cannot
  // touch at all, and the DOM read happens in a fresh isolated context.
  const frameUrl = await cdp.frameUrl();
  const { contextId } = await cdp.isolatedWorld();
  const read = await cdp.evalIn(
    contextId,
    `JSON.stringify({
      title: document.title,
      text: (document.body ? document.body.innerText : ""),
      hasPasswordField: !!document.querySelector("input[type=password]"),
      links: [...new Set([...document.querySelectorAll("a[href]")].map(a => a.href))].slice(0, 300),
    })`,
  );
  const parsed = JSON.parse(typeof read === "string" ? read : "{}") as Partial<PageRead>;
  const rawText = typeof parsed.text === "string" ? parsed.text : "";
  return {
    // Never parsed.url: the browser's answer, always.
    url: frameUrl,
    title: (typeof parsed.title === "string" ? parsed.title : "").trim(),
    text: stripChrome(rawText),
    raw: rawText,
    hasPasswordField: parsed.hasPasswordField === true,
    links: Array.isArray(parsed.links)
      ? parsed.links.filter((l): l is string => typeof l === "string" && isEssecUrl(l))
      : [],
  };
}

// One scratch tab for a whole piece of work, opened and closed exactly once.
// Shared by the crawl and the login preflight so there is a single place that
// knows how to clean up — a leaked tab per page is what the first version did.
async function withScratchTab<T>(fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  await ensureChrome();
  const tab = await openScratchTab();
  const cdp = new Cdp();
  try {
    await cdp.connect(tab.wsUrl);
    return await fn(cdp);
  } finally {
    cdp.close();
    await closeTab(tab.id);
  }
}

/**
 * Is myESSEC logged in in EVE's Chrome profile? Reads the home page and stores
 * NOTHING — the seed calls this first so that a logged-out run stops with a
 * clear message instead of filling the store with login walls.
 */
export async function checkEssecLogin(homeUrl = "https://my.essec.fr/en/"): Promise<{
  state: "in" | "out" | "unknown";
  page: PageRead;
}> {
  if (!isEssecUrl(homeUrl)) throw new Error(`${homeUrl} is not an ESSEC address`);
  const page = await withScratchTab((cdp) => readPage(cdp, homeUrl));
  return { state: loginState(page), page };
}

export interface BrowseRequest {
  url: string;
  section: EssecSection;
  title?: string;
  note?: string;
}

export interface BrowseOutcome {
  url: string;
  section: EssecSection;
  ok: boolean;
  title: string;
  chars: number;
  reason?: string; // why nothing was stored, when ok is false
  links: string[]; // ESSEC links seen on the page, for a caller that walks further
  // Where the browser ACTUALLY ended up, when that differs from `url`. Reported
  // on refusals too, which is the point: most myESSEC /service/… links are
  // redirects, and a caller that wants to record "this link leaves ESSEC, and
  // for where" needs the destination even though nothing was stored. It is a
  // URL, never page content — this interface carries no text at all, so a
  // caller building a note from an outcome cannot leak what was on the page
  // even if it tries.
  finalUrl?: string;
}

/**
 * A myESSEC link that leaves ESSEC becomes an entry saying SO, and nothing else.
 *
 * Sixteen of the first crawl's forty-five pages did this, landing on Google
 * Docs, Sheets, JobTeaser, Airtable, Affluences and linktr.ee. The second crawl
 * found the sharpest one: /service/gmail is a redirect into his actual inbox,
 * which this very browser is logged into, and refusalReason turned away fifteen
 * thousand characters of his mail. But "refused" and "there was nothing there"
 * are different facts, and only a stub tells them apart — it is what lets EVE
 * say "that tile is your Drive, and I don't read it" instead of "I don't know".
 *
 * This lives here, beside the guard, rather than in the seed script, because it
 * is the same boundary rule and it has to hold whoever writes a stub:
 *
 *   - the text is a fixed sentence plus the destination. A BrowseOutcome
 *     carries no page text AT ALL, so there is nothing here to leak even by
 *     accident — the type is the guarantee;
 *   - the ORIGIN, never the full URL. Those redirects end at
 *     docs.google.com/spreadsheets/d/<his sheet id> and
 *     notebook.google.com/notebook/<his notebook id>, and a store that gets read
 *     back into prompts has no business holding those either;
 *   - null when the page did not actually leave ESSEC, so an on-host redirect
 *     (ernest.essec.edu, handicap.essec.edu) is stored as the page it is.
 */
export function offHostStub(req: BrowseRequest, outcome: BrowseOutcome, fetchedAt: string): EssecEntry | null {
  if (outcome.ok || !outcome.finalUrl || isEssecUrl(outcome.finalUrl)) return null;
  let origin: string;
  try {
    origin = new URL(outcome.finalUrl).origin;
  } catch {
    return null; // a destination we cannot parse: say nothing rather than something wrong
  }
  return {
    section: req.section,
    title: `${req.title?.trim() || req.url} — leaves ESSEC`,
    text:
      `This myESSEC link is a redirect, not a page: it lands on ${origin}, which is not an ESSEC address. ` +
      `Nothing from there has been read or stored. essec_knowledge runs inside the browser holding every ` +
      `session Umberto has, so it stops at the ESSEC boundary by design — if he needs what is behind this ` +
      `link, he opens it himself.`,
    source: { url: req.url, fetchedAt, finalUrl: origin },
    ...(req.note ? { note: req.note } : {}),
  };
}

/**
 * Read a list of ESSEC pages through one scratch tab and store what survives
 * the guards. One tab for the whole list on purpose: the seed walks ~25 pages,
 * and opening a tab per page is 25 windows' worth of churn in his Chrome.
 *
 * Every page is reported — stored, refused, or failed. A page that could not
 * be read is never silently dropped, because a silent drop reads exactly like
 * "there was nothing there".
 */
export async function browsePages(requests: BrowseRequest[]): Promise<BrowseOutcome[]> {
  const bad = requests.find((r) => !isEssecUrl(r.url));
  if (bad) {
    // Checked BEFORE Chrome is touched: the allowlist is the whole reason this
    // tool is safe to leave ungated, so it must not depend on the browser.
    throw new Error(
      `${bad.url} is not an ESSEC address. essec_knowledge only reads my.essec.fr / essec.edu — ` +
        "for anything else use fetch_url, which does not drive Umberto's logged-in browser.",
    );
  }
  const outcomes: BrowseOutcome[] = [];
  await withScratchTab(async (cdp) => {
    for (const req of requests) {
      let page: PageRead;
      try {
        page = await readPage(cdp, req.url);
      } catch (err) {
        outcomes.push({
          url: req.url,
          section: req.section,
          ok: false,
          title: req.title ?? "",
          chars: 0,
          reason: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
          links: [],
        });
        continue;
      }
      // Computed once and attached to every outcome below: "where did this
      // actually land" is as much a part of the report as "was it stored".
      const moved = canonicalKey(page.url) !== canonicalKey(req.url) ? { finalUrl: page.url } : {};
      const reason = refusalReason(page);
      if (reason) {
        outcomes.push({
          url: req.url,
          section: req.section,
          ok: false,
          title: page.title,
          chars: page.text.length,
          reason,
          links: page.links,
          ...moved,
        });
        continue;
      }
      const entry: EssecEntry = {
        section: req.section,
        title: req.title?.trim() || page.title || req.url,
        text: page.text,
        source: {
          url: req.url,
          fetchedAt: new Date().toISOString(),
          ...moved,
        },
        ...(req.note ? { note: req.note } : {}),
      };
      try {
        saveEntries([entry]);
      } catch (err) {
        // The cap, the schema check and a poisoned store all throw from here.
        // Uncaught, that threw away `outcomes` — every page already read, with
        // its reason — and the seed died printing nothing at all. The whole
        // contract of this function is that every page is reported.
        outcomes.push({
          url: req.url,
          section: req.section,
          ok: false,
          title: entry.title,
          chars: entry.text.length,
          reason: `read fine, but could not be stored: ${err instanceof Error ? err.message : String(err)}`,
          links: page.links,
          ...moved,
        });
        continue;
      }
      outcomes.push({
        url: req.url,
        section: req.section,
        ok: true,
        title: entry.title,
        chars: entry.text.length,
        links: page.links,
        ...moved,
      });
    }
  });
  audit("essec_browse", {
    pages: outcomes.length,
    stored: outcomes.filter((o) => o.ok).length,
    refused: outcomes.filter((o) => !o.ok).length,
  });
  return outcomes;
}

// ── the tool ─────────────────────────────────────────────────────────────

export const essecTools: EveTool[] = [
  {
    name: "essec_knowledge",
    description:
      "Build and consult EVE's own knowledge about ESSEC, where Umberto studies (Global BBA, Cergy campus, started September 2026). Actions: 'read' returns what is already known (optionally one section), 'search' looks for a keyword across it, 'browse' opens a myESSEC page in his logged-in Chrome, reads the text, and stores it with its URL and today's date. Reach for read/search BEFORE answering anything about his school, timetable, deadlines or campus services — and if the store has nothing, say so instead of guessing. Browse only ESSEC addresses (my.essec.fr, essec.edu); a page that turns out to be a login wall or his personal registrar record is refused and reported, never stored.",
    schema: z.object({
      action: z.enum(["read", "search", "browse"]).describe("read = what's known; search = keyword lookup; browse = read a myESSEC page and store it."),
      url: z
        .string()
        .url()
        .optional()
        .describe("browse only: the myESSEC / essec.edu page to read, e.g. https://my.essec.fr/en/news/."),
      section: z
        .enum(ESSEC_SECTIONS)
        .optional()
        .describe("Which part of the knowledge: campus, program, courses, deadlines, services, contacts, faq, misc. Required for browse; optional filter for read."),
      title: z.string().max(200).optional().describe("browse only: a short title for the entry. Defaults to the page title."),
      note: z.string().max(500).optional().describe("browse only: why this page matters to Umberto, in one line."),
      query: z.string().max(200).optional().describe("search only: the keywords to look for."),
    }),
    // Read-only on the world and locked to ESSEC hosts (see rule 2 at the top):
    // it sends nothing, spends nothing, deletes nothing, changes no setting.
    needsConfirmation: false,
    // …but it does drive the browser that holds every session Umberto has. A
    // Factory agent running unattended has no business in there.
    factoryAllowed: false,
    run: async (input) => {
      const action = String(input.action);

      if (action === "read") {
        const section = input.section ? (String(input.section) as EssecSection) : undefined;
        return renderKnowledge(section);
      }

      if (action === "search") {
        const query = String(input.query ?? "").trim();
        if (!query) throw new Error("search needs a query — the keywords to look for in the ESSEC knowledge");
        const hits = searchKnowledge(query);
        if (hits.length === 0) {
          const total = loadKnowledge().entries.length;
          return total === 0
            ? `Nothing is stored about ESSEC yet, so "${query}" finds nothing. Tell Umberto that plainly — do not answer from guesswork about his school.`
            : `No match for "${query}" in the ${total} stored ESSEC entries. It may simply never have been read; offer to browse the page.`;
        }
        return hits
          .map((h) => `${entryHeader(h.entry)}\n  …${h.excerpt.replace(/\n+/g, " ")}…`)
          .join("\n\n");
      }

      // browse
      const url = String(input.url ?? "");
      if (!url) throw new Error("browse needs a url — the myESSEC page to read");
      if (!input.section) throw new Error(`browse needs a section — one of: ${ESSEC_SECTIONS.join(", ")}`);
      const [outcome] = await browsePages([
        {
          url,
          section: String(input.section) as EssecSection,
          ...(input.title ? { title: String(input.title) } : {}),
          ...(input.note ? { note: String(input.note) } : {}),
        },
      ]);
      if (!outcome) throw new Error("the browse returned no outcome at all — treat that as a failure, not as an empty page");
      if (!outcome.ok) {
        return `Nothing was stored from ${url} — ${outcome.reason}. Say this to Umberto as it is; do not fill the gap from memory.`;
      }
      return (
        `Stored under "${outcome.section}": ${outcome.title} (${outcome.chars} characters, source ${url}, read today).\n` +
        `Read it back any time with essec_knowledge/read or search it by keyword.`
      );
    },
  },
];
