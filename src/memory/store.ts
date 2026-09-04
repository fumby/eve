// EVE's long-term memory: one markdown file per memory in memory/store/,
// human-readable and hand-editable — the files ARE the memory; every index or
// vector built over them is derived and disposable. Each file carries a type
// (which shapes when it's worth recalling), a one-line hook (the searchable
// summary), and a body that records why the fact matters and how to apply it.
import fs from "node:fs";
import path from "node:path";
import { STATE_ROOT } from "../core/config.js";

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
  };
}

export function listMemories(): StoredMemory[] {
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
    .sort((a, b) => a.name.localeCompare(b.name));
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
  const mem: StoredMemory = {
    name,
    type: input.type,
    hook,
    created: existing?.created || new Date().toISOString().slice(0, 10),
    body,
  };
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const file = path.join(STORE_DIR, `${name}.md`);
  trashExisting(file, name);
  fs.writeFileSync(
    file,
    `---\nname: ${mem.name}\ntype: ${mem.type}\nhook: ${mem.hook}\ncreated: ${mem.created}\n---\n\n${mem.body}\n`,
  );
  writeIndex();
  return mem;
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
    parts.push(`${TYPE_LABELS[t]}:\n${of.map((m) => `- [${m.name}] ${m.hook}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

function writeIndex(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(
    INDEX_FILE,
    "# EVE's memory index\n" +
      "Auto-generated from the memory files — edit or delete THOSE, not this list.\n\n" +
      renderIndex() +
      "\n",
  );
}

// Wire-compatible view for the face panel and anything else that still
// expects the old { id, text } fact shape.
export function memoriesAsFacts(): { id: string; text: string }[] {
  return listMemories().map((m) => ({ id: m.name, text: m.hook }));
}
