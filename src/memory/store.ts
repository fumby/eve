// EVE's long-term memory: one markdown file per memory in memory/store/,
// human-readable and hand-editable — the files ARE the memory; every index or
// vector built over them is derived and disposable. Each file carries a type
// (which shapes when it's worth recalling), a one-line hook (the searchable
// summary), and a body that records why the fact matters and how to apply it.
import fs from "node:fs";
import path from "node:path";
import { STATE_ROOT } from "../core/config.js";
import { writeFileAtomic } from "../core/atomic.js";

export const MEMORY_TYPES = ["me", "style", "project", "personal", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const TYPE_LABELS: Record<MemoryType, string> = {
  me: "About Umberto",
  style: "How he wants EVE to work",
  project: "Studies, ventures & active projects",
  personal: "Personal life (handle with care)",
  reference: "Pointers & references",
};

export interface StoredMemory {
  name: string; // kebab-case slug; doubles as the filename
  type: MemoryType;
  hook: string; // one line, what the index and search see first
  created: string; // YYYY-MM-DD, when first written
  body: string; // the fact + why it matters + how to apply it
  // ── Source provenance. Where the fact came from and how much to trust it.
  // A memory Umberto explicitly told EVE and one the Haiku extractor guessed
  // from a transcript are different things — the first is confirmed, the
  // second is an inference. The review flagged this: "A statement you
  // explicitly confirmed should be distinguishable from a model inference."
  source?: "user" | "extractor" | "core"; // who said it
  confirmed?: boolean; // did Umberto explicitly confirm it?
  verified?: string; // YYYY-MM-DD, last date it was checked against reality
  // ── Supersession. Facts change, and until now a corrected fact was simply
  // saved beside the old one: both stayed in the index, both came back from
  // recall, and nothing said which was current. So contradictions accumulated
  // and EVE got to pick. A memory that replaces another names it in
  // `supersedes`; the replaced file is stamped with `supersededBy` and drops
  // out of the index and out of recall — but is NEVER deleted. It stays on
  // disk, readable, one hand-edit away from coming back.
  //
  // `supersededBy` is stored on the RETIRED file rather than derived by
  // scanning every other memory for a pointer at it: "is this current?" is
  // then a property of the file in your hand, which is what makes the filter
  // in listMemories() cheap and what makes a hand-edit enough to undo it.
  supersedes?: string; // this memory replaced that one
  supersededBy?: string; // this memory WAS replaced by that one — retired
  supersededOn?: string; // YYYY-MM-DD, when it was retired
  // ── Expiry. Some memories are true only until a date ("voucher valid
  // until 1 September"). `expires` is that date; the weekly hygiene scan
  // flags a memory whose expiry has passed so Umberto can retire or renew
  // it — the scan proposes, it never touches the store.
  expires?: string; // YYYY-MM-DD — stale after this date
  // ── Origin. The 2026-09-06 memory audit's central finding: a memory was
  // a plausible summary with no way back to the turn that produced it.
  // `origin` names the conversation (and turn, when known) a memory came
  // from, so "where did you get that?" is one read_conversation away.
  // Absent on older memories and hand edits — honestly unknown, never
  // guessed.
  origin?: string; // conversation id (+ "#turn" when known)
}

const STORE_DIR = path.join(STATE_ROOT, "memory", "store");
const INDEX_FILE = path.join(STORE_DIR, "INDEX.md");
const TRASH_DIR = path.join(STORE_DIR, ".trash");

// Nothing that smells like a credential lands here unless Umberto himself says
// so. This lives at the one function that writes a memory file rather than in
// the extractor, because the extractor is only one of the ways in — the
// save_memory tool and anything the Factory spawns are the others, and a filter
// guarding one door is a filter with a hole in it.
//
// TWO regexes on purpose. Keywords are case-insensitive: "PASSWORD" and
// "password" are equally a password. The structured shapes must NOT be — AKIA…,
// eyJ…, an Italian IBAN and a codice fiscale are DEFINED by their case, and
// folding it turns the codice-fiscale shape (six letters, two digits, …) into
// something ordinary prose can stumble into.
//
// "token" and "secret" are deliberately narrow. Bare, they refuse ordinary
// speech — "~13k tokens cached per turn" and "nothing secret about it" are both
// things worth remembering, and the second was caught by a test fixture, not by
// theory. They count only with a credential-ish prefix or suffix, or when
// something is being assigned to them.
export const SENSITIVE =
  /api[ _-]?key|password|passwd|credential|(?:auth|access|bearer|api|refresh|personal)[ _-]?tokens?\b|\btokens?\s*[:=]|(?:client|api|app|shared)[ _-]?secrets?\b|\bsecret[ _-]?(?:key|token|access)\b|\bsecrets?\s*[:=]|bearer |sk-[a-z0-9]|pa-[A-Za-z0-9_]{8}|\b(?:\d[ -]?){13,19}\b/i;

// Case-sensitive, shape-based: GitHub tokens (classic and fine-grained), AWS
// access-key ids, JWTs, Italian IBANs (IT + 2 check + CIN + ABI + CAB + 12) and
// codici fiscali (6+2+1+2+1+3+1, always written uppercase).
export const SENSITIVE_STRUCTURED =
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}|\bIT\d{2}[A-Z]\d{10}[A-Za-z0-9]{12}\b|\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z][0-9A-Z]{3}[A-Z]\b/;

// Neither regex carries /g — .test() on a /g regex is STATEFUL and would
// alternate true/false across calls, letting every second secret through.
export function isSensitive(text: string): boolean {
  if (SENSITIVE.test(text) || SENSITIVE_STRUCTURED.test(text)) return true;
  // IBANs are printed in groups of four ("IT60 X054 2811 1010 0000 0123 456").
  // Spaces only: newlines survive, so joining fields for a single check can
  // never fabricate a match across a field boundary.
  return SENSITIVE_STRUCTURED.test(text.replace(/[  ]/g, ""));
}

// The exact fields a save would persist, normalised exactly as saveMemory will
// write them. Both the store's own refusal and the save_memory tool's gate ask
// through here, so the gate can never open on a different string than the one
// being judged — a hook whose whitespace collapses into an IBAN would otherwise
// slip past the gate and then be refused at the write.
export function sensitiveForSave(input: { name?: string; hook: string; body: string }): boolean {
  return isSensitive(
    `${input.name ?? ""}\n${input.hook.replace(/\s+/g, " ").trim()}\n${input.body.trim()}`,
  );
}

// Thrown rather than returned: a boolean has to be checked by every caller, and
// the caller who forgets IS the hole. The message names the category and never
// the match — registry.execute() writes err.message into logs/audit.jsonl, so
// echoing the secret would persist it in plaintext in the one file whose whole
// purpose is to be safe to open.
export class SensitiveContentError extends Error {
  constructor(
    message = "Refused: that memory reads like a credential or a personal identifier " +
      "(API key, token, password, card number, IBAN, codice fiscale). Nothing was " +
      "written to disk. Do not reword it to get past this check.",
  ) {
    super(message);
    this.name = "SensitiveContentError";
  }
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "memory"
  );
}

// Tolerant of hand edits: a malformed file is skipped, never a crash; an
// unknown type falls back to "reference" rather than hiding the memory.
function parseMemoryFile(file: string): StoredMemory | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(STORE_DIR, file), "utf8");
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
  const hook = meta.hook ?? "";
  if (!hook) return null;
  const type = (MEMORY_TYPES as readonly string[]).includes(meta.type ?? "")
    ? (meta.type as MemoryType)
    : "reference";
  return {
    name: meta.name ?? file.replace(/\.md$/, ""),
    type,
    hook,
    created: meta.created ?? "",
    body: m[2]!.trim(),
    ...(meta.source ? { source: meta.source as "user" | "extractor" | "core" } : {}),
    ...(meta.confirmed ? { confirmed: meta.confirmed === "true" } : {}),
    ...(meta.verified ? { verified: meta.verified } : {}),
    // Absent is the common case and must stay undefined rather than "": the
    // retirement filter tests truthiness, and an empty string read as "retired"
    // would hide every memory in the store at once.
    ...(meta.supersedes ? { supersedes: meta.supersedes } : {}),
    ...(meta.supersededBy ? { supersededBy: meta.supersededBy } : {}),
    ...(meta.supersededOn ? { supersededOn: meta.supersededOn } : {}),
    // Same absent-is-undefined rule as the supersession fields: an empty
    // `expires:` must not read as "expired at the epoch".
    ...(meta.expires ? { expires: meta.expires } : {}),
    ...(meta.origin ? { origin: meta.origin } : {}),
  };
}

// The bytes of a memory file, in one place: saving a memory and stamping a
// retired one both go through here, so a field can never be written by one
// path and dropped by the other. Optional lines are omitted entirely when
// absent — an empty `supersededBy:` would parse back as a retired memory.
function renderMemoryFile(mem: StoredMemory): string {
  const lines = [
    `name: ${mem.name}`,
    `type: ${mem.type}`,
    `hook: ${mem.hook}`,
    `created: ${mem.created}`,
  ];
  if (mem.source) lines.push(`source: ${mem.source}`);
  if (mem.confirmed) lines.push(`confirmed: ${mem.confirmed}`);
  if (mem.verified) lines.push(`verified: ${mem.verified}`);
  if (mem.supersedes) lines.push(`supersedes: ${mem.supersedes}`);
  if (mem.supersededBy) lines.push(`supersededBy: ${mem.supersededBy}`);
  if (mem.supersededOn) lines.push(`supersededOn: ${mem.supersededOn}`);
  if (mem.expires) lines.push(`expires: ${mem.expires}`);
  if (mem.origin) lines.push(`origin: ${mem.origin}`);
  return `---\n${lines.join("\n")}\n---\n\n${mem.body}\n`;
}

// Current memories only, unless asked otherwise. EVERY reader that feeds the
// model — the prompt index, recall, the extractor's duplicate check, the mind
// map — goes through here, so a retired memory stops competing the moment it is
// stamped, in one place rather than four.
export function listMemories(opts: { includeRetired?: boolean } = {}): StoredMemory[] {
  let files: string[];
  try {
    files = fs.readdirSync(STORE_DIR);
  } catch {
    return []; // no store yet = honestly empty, not broken
  }
  return files
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
    .map(parseMemoryFile)
    .filter((x): x is StoredMemory => x !== null)
    .filter((m) => opts.includeRetired || !m.supersededBy)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The retired ones, newest retirement first. Nothing that reaches the model
// reads this — it exists so INDEX.md can show a human what was set aside and
// what replaced it, and so recall can be asked for history on purpose.
export function retiredMemories(): StoredMemory[] {
  return listMemories({ includeRetired: true })
    .filter((m) => m.supersededBy)
    .sort((a, b) => (b.supersededOn ?? "").localeCompare(a.supersededOn ?? ""));
}

export function getMemory(name: string): StoredMemory | null {
  const f = `${name}.md`;
  if (!fs.existsSync(path.join(STORE_DIR, f))) return null;
  return parseMemoryFile(f);
}

// The only undo this system has. memory/store/ is git-ignored, the repo has no
// remote and there is no backup anywhere, so an overwrite that lands is final.
// And save_memory is deliberately NOT confirmation-gated — saving should be
// frictionless — which makes replacing a memory the one destructive operation
// here that nobody ever approves. So the outgoing version is kept first.
//
// A dotted SUBdirectory is invisible to the store that owns it: listMemories()
// keeps only names ending in ".md", so ".trash" is dropped before
// parseMemoryFile is ever reached, and STORE_DIR is read in exactly one place.
//
// existsSync rather than the already-parsed `existing`: parseMemoryFile returns
// null for a malformed file, and a hand-broken memory is precisely the one you
// most want a copy of before replacing it.
//
// A failed copy ABORTS the save. The whole value of this is "the previous
// version survives"; backing up, failing, and destroying the original anyway is
// the exact outcome it exists to prevent. Creations never come through here, so
// the common path is untouched.
function trashExisting(file: string, name: string): void {
  if (!fs.existsSync(file)) return; // first write of this memory — nothing to keep
  const stamp = new Date().toISOString().replace(/[:.]/g, "-"); // colon-free: macOS paths
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    fs.copyFileSync(file, path.join(TRASH_DIR, `${name}.${stamp}.md`));
  } catch (err) {
    throw new Error(
      `refusing to overwrite [${name}]: could not keep a copy of the current version in ` +
        `memory/store/.trash/ (${err instanceof Error ? err.message : String(err)}). ` +
        `Nothing was changed.`,
    );
  }
}

// Saving with an explicit existing name updates that memory (created date
// survives). Without a name, one is derived from the hook — and never silently
// clobbers a different memory that happens to share the slug.
export function saveMemory(
  input: {
    name?: string;
    type: MemoryType;
    hook: string;
    body: string;
    supersedes?: string;
    source?: "user" | "extractor" | "core";
    confirmed?: boolean;
    verified?: string;
    expires?: string;
    origin?: string;
  },
  // Umberto answered the confirmation gate himself and said yes. A SEPARATE
  // argument, deliberately not part of `input`: `input` is what a model's
  // tool-call JSON becomes, so nothing the model writes can ever set this.
  // Only code that has actually been through the gate passes it.
  opts: { confirmedByHuman?: boolean } = {},
): StoredMemory {
  const hook = input.hook.replace(/\s+/g, " ").trim();
  const body = input.body.trim();
  // Before the name is resolved, before .trash, before anything touches disk:
  // a refused memory leaves no trace at all — no file, no trash copy, no index
  // rewrite. input.name is checked too: an explicit name is used verbatim as
  // the filename AND rendered into INDEX.md, which rides in the cached system
  // prompt on every single turn.
  if (!opts.confirmedByHuman && sensitiveForSave(input)) throw new SensitiveContentError();
  let name = input.name?.trim() || slugify(hook);
  if (!input.name) {
    let candidate = name;
    for (let i = 2; getMemory(candidate) && i < 100; i++) candidate = `${name}-${i}`;
    name = candidate;
  }
  const existing = getMemory(name);

  // Everything that can refuse the supersession is checked HERE, before the
  // new memory is written — a retirement that turns out to be impossible must
  // not leave a half-done pair behind.
  const retiring = input.supersedes?.trim();
  if (retiring) {
    const target = getMemory(retiring);
    if (!target) {
      throw new Error(
        `cannot supersede "${retiring}" — no stored memory by that name. ` +
          `Check the index and use the exact name, or save without superseding.`,
      );
    }
    if (target.name === name) {
      throw new Error(
        `a memory cannot supersede itself — to change [${name}] in place, use update_memory.`,
      );
    }
    if (target.supersededBy) {
      // Reasoning from a retired memory is a real error worth surfacing: it is
      // out of the index and out of recall, so seeing it at all means something
      // upstream is stale.
      throw new Error(
        `[${retiring}] was already retired by [${target.supersededBy}] — supersede that one instead.`,
      );
    }
  }

  const mem: StoredMemory = {
    name,
    type: input.type,
    hook,
    created: existing?.created || new Date().toISOString().slice(0, 10),
    body,
    ...(input.source ? { source: input.source } : {}),
    ...(input.confirmed ? { confirmed: input.confirmed } : {}),
    ...(input.verified ? { verified: input.verified } : {}),
    ...(input.expires ? { expires: input.expires } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(retiring ? { supersedes: retiring } : {}),
  };
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const file = path.join(STORE_DIR, `${name}.md`);
  trashExisting(file, name);
  // Atomic since a background reviewer writes here too: a reader that catches a
  // half-written file sees a memory with no hook, and parseMemoryFile drops
  // those silently — a memory that vanishes for one read and comes back is
  // worse to debug than one that was never saved.
  writeFileAtomic(file, renderMemoryFile(mem));

  // ORDER IS LOAD-BEARING. The replacement is on disk before the old one is
  // retired, so the failure mode of a crash between the two is a visible
  // contradiction (both live — today's normal state), never a silent hole
  // where a retired memory has nothing standing in for it.
  if (retiring) {
    try {
      stampRetired(retiring, name);
    } catch (err) {
      throw new Error(
        `[${name}] was saved, but [${retiring}] could NOT be retired ` +
          `(${err instanceof Error ? err.message : String(err)}) — both are live and they ` +
          `may contradict each other. Tell Umberto rather than retrying blindly.`,
      );
    }
  }
  writeIndex();
  return mem;
}

// Stamps the retirement onto the outgoing memory. Rewrites the file rather
// than deleting it: the whole promise of supersession is that the old fact is
// still there to read, so this must never be a deletion in disguise.
function stampRetired(name: string, by: string): void {
  const mem = getMemory(name);
  if (!mem) throw new Error(`[${name}] disappeared between the check and the write`);
  writeFileAtomic(
    path.join(STORE_DIR, `${name}.md`),
    renderMemoryFile({ ...mem, supersededBy: by, supersededOn: new Date().toISOString().slice(0, 10) }),
  );
}

export function deleteMemory(name: string): StoredMemory | null {
  const mem = getMemory(name);
  if (!mem) return null;
  fs.rmSync(path.join(STORE_DIR, `${name}.md`));
  writeIndex();
  return mem;
}

// The hooks list, grouped by type — rendered into the stable block so EVE
// always knows WHAT she remembers, and into INDEX.md for human browsing.
export function renderIndex(): string {
  const all = listMemories();
  if (all.length === 0) return "(no long-term memories stored yet)";
  const parts: string[] = [];
  for (const t of MEMORY_TYPES) {
    const of = all.filter((m) => m.type === t);
    if (of.length === 0) continue;
    parts.push(`${TYPE_LABELS[t]}:\n${of.map((m) => {
      const provenance = m.confirmed ? " ✓" : m.source === "extractor" ? " ~" : "";
      const age = m.verified ? ` (verified ${m.verified})` : "";
      return `- [${m.name}] ${m.hook}${provenance}${age}`;
    }).join("\n")}`);
  }
  return parts.join("\n\n");
}

function writeIndex(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  // The retired list is written HERE and nowhere else. renderIndex() rides in
  // the cached system prompt every turn, so putting history there would cost
  // tokens forever to say what EVE no longer believes; INDEX.md is the file a
  // human opens, and that is exactly who the list is for.
  const retired = retiredMemories();
  const history =
    retired.length === 0
      ? ""
      : "\n\n## Retired (kept on disk, out of the index and out of recall)\n" +
        retired
          .map((m) => `- [${m.name}] ${m.hook}\n  → replaced by [${m.supersededBy}] on ${m.supersededOn || "an unrecorded date"}`)
          .join("\n");
  writeFileAtomic(
    INDEX_FILE,
    "# EVE's memory index\n" +
      "Auto-generated from the memory files — edit or delete THOSE, not this list.\n" +
      "To bring a retired memory back, delete its `supersededBy:` line by hand.\n\n" +
      renderIndex() +
      history +
      "\n",
  );
}

// Wire-compatible view for the face panel and anything else that still
// expects the old { id, text } fact shape.
export function memoriesAsFacts(): { id: string; text: string }[] {
  return listMemories().map((m) => ({ id: m.name, text: m.hook }));
}
