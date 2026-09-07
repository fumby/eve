// EVE's procedural memory: one markdown file per skill in memory/skills/,
// human-readable and hand-editable, exactly like memory/store/. The split with
// long-term memory is the point of having both — MEMORY holds small durable
// FACTS that are worth carrying in context every turn; a SKILL holds a longer
// PROCEDURE that costs nothing until the moment it is relevant. So the index
// (name + when to use it) rides in the system prompt, and the body is fetched
// on demand with view_skill.
//
// A skill is written for the next time, not about this time: the steps that
// worked, in order, and the pitfalls that cost time — never the story of the
// session that produced it.
import fs from "node:fs";
import path from "node:path";
import { STATE_ROOT } from "../core/config.js";
import { writeFileAtomic } from "../core/atomic.js";
// The credential filter comes from the memory store rather than being restated
// here. This codebase already learned that lesson the expensive way: a filter
// guarding one door is a filter with a hole in it, and a skill body ("run the
// deploy with KEY=sk-…") is every bit as good a hiding place as a memory.
import { isSensitive, SensitiveContentError, slugify } from "../memory/store.js";

export interface StoredSkill {
  name: string; // kebab-case slug; doubles as the filename
  title: string; // short human name, e.g. "Printing a booklet at Arci"
  when: string; // ONE line: the trigger. This is what rides in the prompt.
  created: string; // YYYY-MM-DD
  updated: string; // YYYY-MM-DD
  uses: number; // times view_skill has opened it
  lastUsed: string; // YYYY-MM-DD, or "" if never
  body: string; // the procedure itself
}

const SKILLS_DIR = path.join(STATE_ROOT, "memory", "skills");
const TRASH_DIR = path.join(SKILLS_DIR, ".trash");

// A procedure that no longer fits on a page has stopped being a procedure and
// started being a transcript. The cap is generous enough for a real workflow
// with pitfalls and verification, and small enough that view_skill can never
// blow up a turn by returning a pasted session.
export const MAX_BODY_CHARS = 8000;

export function skillsDir(): string {
  return SKILLS_DIR;
}

// Tolerant of hand edits, same as the memory store: a malformed file is
// skipped rather than crashing the index that every turn depends on.
function parseSkillFile(file: string): StoredSkill | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(SKILLS_DIR, file), "utf8");
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
  const when = meta.when ?? "";
  if (!when) return null; // a skill with no trigger can never be reached
  const name = meta.name ?? file.replace(/\.md$/, "");
  return {
    name,
    title: meta.title || name,
    when,
    created: meta.created ?? "",
    updated: meta.updated || (meta.created ?? ""),
    // Number(undefined) is NaN and NaN sorts unpredictably; an unparseable
    // counter is simply zero uses, which is also what a hand-written skill has.
    uses: Number.isFinite(Number(meta.uses)) ? Number(meta.uses) : 0,
    lastUsed: meta.lastUsed ?? "",
    body: m[2]!.trim(),
  };
}

// One serializer, so the usage stamp below can never write a file shaped
// differently from the one save wrote.
function renderSkillFile(s: StoredSkill): string {
  return (
    `---\nname: ${s.name}\ntitle: ${s.title}\nwhen: ${s.when}\n` +
    `created: ${s.created}\nupdated: ${s.updated}\nuses: ${s.uses}\nlastUsed: ${s.lastUsed}\n---\n\n${s.body}\n`
  );
}

export function listSkills(): StoredSkill[] {
  let files: string[];
  try {
    files = fs.readdirSync(SKILLS_DIR);
  } catch {
    return []; // no skills yet = honestly none, not broken
  }
  return files
    .filter((f) => f.endsWith(".md"))
    .map(parseSkillFile)
    .filter((x): x is StoredSkill => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): StoredSkill | null {
  if (!fs.existsSync(path.join(SKILLS_DIR, `${name}.md`))) return null;
  return parseSkillFile(`${name}.md`);
}

// Same deal as the memory store: memory/skills/ is git-ignored with no remote
// and no backup, so a replacement that lands is final unless the outgoing
// version was kept first. A failed copy ABORTS the write.
function trashExisting(file: string, name: string): void {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-"); // colon-free: macOS paths
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    fs.copyFileSync(file, path.join(TRASH_DIR, `${name}.${stamp}.md`));
  } catch (err) {
    throw new Error(
      `refusing to overwrite the skill [${name}]: could not keep a copy of the current ` +
        `version in memory/skills/.trash/ (${err instanceof Error ? err.message : String(err)}). ` +
        `Nothing was changed.`,
    );
  }
}

// Creating with no name derives one from the title and never clobbers a
// different skill that happens to share the slug — the overwrite is simply not
// expressible from the frictionless path, which is what the memory store
// learned to do and for the same reason.
export function saveSkill(
  input: { name?: string; title: string; when: string; body: string },
  // Set ONLY by code that has already been through the confirmation gate —
  // a separate argument so no model-authored tool-call JSON can reach it.
  opts: { confirmedByHuman?: boolean } = {},
): StoredSkill {
  const title = input.title.replace(/\s+/g, " ").trim();
  const when = input.when.replace(/\s+/g, " ").trim();
  const body = input.body.trim();
  if (body.length > MAX_BODY_CHARS) {
    throw new Error(
      `that skill is ${body.length} characters; the limit is ${MAX_BODY_CHARS}. A skill is the ` +
        `procedure and its pitfalls, not the session that produced it — cut the narration and retry.`,
    );
  }
  // Before the name is resolved and before anything touches disk, so a refused
  // skill leaves no file, no trash copy, no index entry.
  if (!opts.confirmedByHuman && isSensitive(`${title}\n${when}\n${body}`)) {
    throw new SensitiveContentError(
      "Refused: that skill reads like it contains a credential or a personal identifier " +
        "(API key, token, password, card number, IBAN, codice fiscale). Nothing was written " +
        "to disk. Write the step as 'read the key from .env', not the key itself.",
    );
  }
  let name = input.name?.trim() || slugify(title);
  if (!input.name) {
    let candidate = name;
    for (let i = 2; getSkill(candidate) && i < 100; i++) candidate = `${name}-${i}`;
    name = candidate;
  }
  const existing = getSkill(name);
  const today = new Date().toISOString().slice(0, 10);
  const skill: StoredSkill = {
    name,
    title,
    when,
    created: existing?.created || today,
    updated: today,
    // Usage survives a rewrite: an edited skill is the same skill, and zeroing
    // the counter would erase the only evidence of which ones earn their place.
    uses: existing?.uses ?? 0,
    lastUsed: existing?.lastUsed ?? "",
    body,
  };
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const file = path.join(SKILLS_DIR, `${name}.md`);
  trashExisting(file, name);
  writeFileAtomic(file, renderSkillFile(skill));
  return skill;
}

export function deleteSkill(name: string): StoredSkill | null {
  const skill = getSkill(name);
  if (!skill) return null;
  fs.rmSync(path.join(SKILLS_DIR, `${name}.md`));
  return skill;
}

// Reading a skill counts as using it. The stamp is best-effort on purpose:
// this is bookkeeping for a future pruning pass, and a skill that cannot be
// re-written (read-only disk, a file open elsewhere) must still be readable.
export function touchSkill(name: string): void {
  const skill = getSkill(name);
  if (!skill) return;
  try {
    writeFileAtomic(
      path.join(SKILLS_DIR, `${name}.md`),
      renderSkillFile({
        ...skill,
        uses: skill.uses + 1,
        lastUsed: new Date().toISOString().slice(0, 10),
      }),
    );
  } catch {
    // A lost count is not worth failing a read over.
  }
}

// What rides in the system prompt: the trigger line and nothing else. The
// bodies stay on disk until view_skill asks for one — that is the whole
// economy of keeping procedures out of memory.
export function renderSkillIndex(): string {
  const all = listSkills();
  if (all.length === 0) return "(no skills written yet)";
  return all.map((s) => `- [${s.name}] ${s.when}`).join("\n");
}
