// The I/O half of the project reader. Everything that touches the disk is here
// so redact.ts stays pure; the split is the same one ledger.ts / ledger-sql.ts
// already uses, and for the same reason.
//
// The single invariant this file exists to hold: EVE reads inside a folder
// Umberto confirmed, and nowhere else. Two things were reproduced before this
// was written, and both shape the code:
//   1. A lexical prefix check does not hold. A directory symlink inside the
//      root ("linkdir" -> "../outside") sails through it, and only realpath
//      shows otherwise. src/tools/notes.ts had exactly that hole; it now calls
//      resolveInside() below rather than carrying a second copy of the rules.
//   2. fs.realpathSync does NOT canonicalise case on macOS. It resolves
//      symlinks and hands back the caller's spelling, so on case-insensitive
//      APFS a root of "/users/you" compared !== "/Users/..." and
//      every containment refusal missed by one character. Only
//      fs.realpathSync.native goes through the platform realpath and returns
//      the on-disk spelling. Every path here is canonicalised through
//      canonical(), and nothing may call fs.realpathSync directly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, ROOT } from "../core/config.js";
import {
  hasDotSegment,
  isReadableFilename,
  isSecretFilename,
  redactLines,
  safeRelPath,
  READABLE_EXT,
  SKIP_DIRS,
} from "./redact.js";

const MAX_WALK = 4000; // entries yielded per call
const MAX_DIRS = 2000; // directories visited per call — breadth needs a bound too
const MAX_DEPTH = 8;
const MAX_HITS = 8;
const MAX_BYTES = 512_000; // refuse to load anything larger, checked before reading
const MAX_RETURN = 20_000; // what actually reaches the turn — notes.ts:96's cap
const SNIPPET = 220;

export class ProjectError extends Error {}

// The ONE place a path becomes "real". Uses the native realpath so the spelling
// is the filesystem's, not the caller's — see the header note.
export function canonical(p: string): string {
  return fs.realpathSync.native(p);
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function projectMap(): Record<string, string> {
  return loadConfig().projects ?? {};
}

// Refuses a root too big to be a project, whatever it arrived from — config.json,
// a hand-edited data/runtime.json, or set_project_dir. Checked in BOTH
// directions: refusing a root inside the EVE checkout is the obvious half, but
// a root that CONTAINS the checkout is the dangerous one — "/Users" is neither
// "~" nor "/", and it reaches brain/identity.md and memory/core/, which
// invariant 1 says are Umberto's alone. This is the enforcement point; the
// prose in AGENT.md is not.
export function assertGrantableRoot(rawRoot: string): void {
  let realRoot: string;
  try {
    realRoot = canonical(rawRoot);
  } catch {
    throw new ProjectError(`${rawRoot} isn't there`);
  }
  const realHome = canonical(os.homedir());
  const realEve = canonical(ROOT);
  if (realRoot === path.parse(realRoot).root) {
    throw new ProjectError("refusing the filesystem root as a project folder");
  }
  if (realRoot === realHome) {
    throw new ProjectError("refusing the whole home folder as a project — name the project's own folder");
  }
  if (realRoot === realEve || realRoot.startsWith(realEve + path.sep)) {
    throw new ProjectError("that folder is inside EVE's own checkout, which she doesn't read through this tool");
  }
  if (realEve.startsWith(realRoot + path.sep)) {
    throw new ProjectError(
      "refusing that folder: it contains EVE's own checkout, so granting it would hand over her identity and memory files too",
    );
  }
}

// slug -> the real, canonicalised directory EVE may read.
export function resolveRoot(slug: string): string {
  const map = projectMap();
  // Object.hasOwn, not `map[slug]`: a slug of "constructor" or "toString"
  // otherwise resolves to something off Object.prototype instead of missing.
  const configured = Object.hasOwn(map, slug) ? map[slug] : undefined;
  if (!configured) {
    const known = Object.keys(map);
    throw new ProjectError(
      known.length
        ? `no project called "${slug}" — known projects: ${known.join(", ")}`
        : `no project folders are configured yet — ask Umberto where the project lives, then use set_project_dir`,
    );
  }
  const expanded = expandHome(configured);
  let real: string;
  try {
    real = canonical(expanded);
  } catch {
    throw new ProjectError(`the folder for "${slug}" (${expanded}) isn't there any more`);
  }
  if (!fs.statSync(real).isDirectory()) throw new ProjectError(`${expanded} isn't a folder`);
  assertGrantableRoot(real);
  return real;
}

// What a refusal is CALLED, per caller. src/tools/notes.ts reuses resolveInside
// for its studies folder, and the only thing it needs to differ is the words
// Umberto hears — so that is the only thing parameterised. Copying the checks
// to reword them is how the studies reader got a lexical-only guard in the
// first place; one implementation, two vocabularies.
export interface InsideLabels {
  folder: string;
  searchTool: string;
}
const PROJECT_LABELS: InsideLabels = { folder: "project folder", searchTool: "search_project" };

// Resolve a model-supplied relative path to a real file inside the root, or
// throw. Three checks, each closing a hole the previous one leaves: dot
// segments (so ".env" is unreachable even when named directly), the lexical
// prefix (cheap, catches ".."), and canonical realpath (catches the symlink).
export function resolveInside(realRoot: string, rel: string, labels: InsideLabels = PROJECT_LABELS): string {
  if (path.isAbsolute(rel)) throw new ProjectError(`give a path relative to the ${labels.folder}`);
  if (hasDotSegment(rel)) throw new ProjectError(`refusing ${rel}: hidden files and folders are out of bounds`);
  const lexical = path.resolve(realRoot, rel);
  if (lexical !== realRoot && !lexical.startsWith(realRoot + path.sep)) {
    throw new ProjectError(`refusing ${rel}: outside the ${labels.folder}`);
  }
  let real: string;
  try {
    real = canonical(lexical);
  } catch {
    throw new ProjectError(`no file at ${rel} — try ${labels.searchTool} first`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new ProjectError(`refusing ${rel}: it points outside the ${labels.folder}`);
  }
  return real;
}

export interface WalkEntry {
  rel: string;
  full: string;
  mtimeMs: number;
  size: number;
}

// A walk that hit a cap must SAY so. A truncated count reported as a total is
// a false statement about Umberto's project, and the ground rules in
// src/brain/prompt.ts forbid exactly that.
export interface WalkStats {
  truncated: boolean;
}

// Yields only files EVE may actually open. Symlinks are skipped whole — a link
// is either redundant (it points inside, where the walk already goes) or an
// escape, and there is no third case worth the risk.
export function* walkProject(realRoot: string, stats?: WalkStats): Generator<WalkEntry> {
  let yielded = 0;
  let dirs = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: realRoot, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) {
      if (stats) stats.truncated = true;
      continue;
    }
    if (++dirs > MAX_DIRS) {
      if (stats) stats.truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      if (stats) stats.truncated = true;
      continue; // an unreadable directory is not a reason to abandon the walk
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      // The budget is spent on files that can actually be RESULTS. Counting
      // before the filter let a folder of images exhaust it and silently
      // truncate a search that had not yet looked at a single readable file.
      if (!isReadableFilename(entry.name)) continue;
      if (++yielded > MAX_WALK) {
        if (stats) stats.truncated = true;
        return;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      yield { rel: path.relative(realRoot, full), full, mtimeMs: st.mtimeMs, size: st.size };
    }
  }
}

// A NUL byte in the first few KB means this is not text, whatever the
// extension says. Reading it as utf8 yields replacement characters, which cost
// three bytes each and tell nobody anything.
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 4096).includes(0);
}

export interface SearchHit {
  rel: string;
  snippet: string;
}

export function searchProject(realRoot: string, query: string): { hits: SearchHit[]; truncated: boolean } {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  const stats: WalkStats = { truncated: false };
  for (const entry of walkProject(realRoot, stats)) {
    if (hits.length >= MAX_HITS) break;
    const nameHit = entry.rel.toLowerCase().includes(q);
    let snippet = "";
    if (entry.size <= MAX_BYTES) {
      let raw: Buffer;
      try {
        raw = fs.readFileSync(entry.full);
      } catch {
        continue;
      }
      if (looksBinary(raw)) {
        if (!nameHit) continue;
      } else {
        const text = raw.toString("utf8");
        // Cheap test FIRST. Redacting every walked file before checking whether
        // it even matches made a search 21x slower than it needed to be, on a
        // path that runs inside a voice turn.
        if (text.toLowerCase().includes(q)) {
          // Redact whole lines, THEN window. The other order is how a bare key
          // value escapes: a 220-character window can open after the key name,
          // leaving nothing for a name-driven rule to match on.
          const safe = redactLines(text).text;
          const idx = safe.toLowerCase().indexOf(q);
          if (idx >= 0) {
            snippet = safe.slice(Math.max(0, idx - 60), idx + SNIPPET).replace(/\s+/g, " ").trim();
          }
        }
        if (!snippet && !nameHit) continue;
      }
    } else if (!nameHit) {
      continue;
    }
    hits.push({ rel: safeRelPath(entry.rel), snippet });
  }
  return { hits, truncated: stats.truncated };
}

export interface ReadResult {
  rel: string;
  text: string;
  redacted: number;
  truncated: boolean;
}

export function readProjectFile(realRoot: string, rel: string): ReadResult {
  const full = resolveInside(realRoot, rel);
  const base = path.basename(full);
  // The name guard runs HERE as well as in the walk. A path the model supplies
  // never passes through the walk, so a guard that lives only there is a guard
  // with the front door open.
  if (isSecretFilename(base)) {
    throw new ProjectError(`refusing to open ${rel}: that's a credentials file`);
  }
  if (!READABLE_EXT.has(path.extname(base).toLowerCase())) {
    throw new ProjectError(
      `I only read text and source formats (${[...READABLE_EXT].slice(0, 8).join(", ")}…), and ${base} isn't one`,
    );
  }
  const st = fs.statSync(full);
  if (!st.isFile()) throw new ProjectError(`${rel} isn't a regular file`);
  // Checked BEFORE the read: readFileSync-then-slice pulls the whole file into
  // memory first, and these folders hold multi-megabyte exports.
  if (st.size > MAX_BYTES) {
    throw new ProjectError(`${rel} is ${Math.round(st.size / 1024)} KB — too big to read whole`);
  }
  const raw = fs.readFileSync(full);
  if (looksBinary(raw)) {
    throw new ProjectError(`${rel} has a text extension but binary content, so there's nothing to read`);
  }
  const { text, redacted } = redactLines(raw.toString("utf8"));
  const truncated = text.length > MAX_RETURN;
  return {
    rel: safeRelPath(path.relative(realRoot, full)),
    text: truncated ? text.slice(0, MAX_RETURN) + "\n…(truncated)" : text,
    redacted,
    truncated,
  };
}

// ── Status ───────────────────────────────────────────────────────────────
// Read-only git, fixed argv, no shell. `-c core.fsmonitor=` and `--no-pager`
// are there because a repository's own config can otherwise name a command for
// git to run.
type GitResult = { ok: true; out: string } | { ok: false; why: "unavailable" | "answered-no" };

// The distinction is load-bearing. "git is not installed", "git timed out" and
// "git ran and told me this is not a repository" are three different facts,
// and collapsing them into null made EVE state the third one whenever any of
// the first two happened — inventing something about Umberto's project.
function git(realRoot: string, args: string[]): GitResult {
  try {
    const out = execFileSync("git", ["-c", "core.fsmonitor=", "--no-pager", ...args], {
      cwd: realRoot,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1_000_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    // A numeric exit status means git ran and answered "no" (not a repo, no
    // commits). Anything else — ENOENT, a timeout's SIGTERM, EACCES — means we
    // never got an answer at all.
    if (typeof e.status === "number") return { ok: false, why: "answered-no" };
    return { ok: false, why: "unavailable" };
  }
}

export interface ProjectStatus {
  slug: string;
  root: string;
  gitAnswered: boolean;
  isRepo: boolean;
  branch: string | null;
  hasCommits: boolean;
  dirtyFiles: number;
  commits: string[];
  selfDescription: { file: string; lines: string[] } | null;
  recent: Array<{ rel: string; mtimeMs: number }>;
  fileCount: number;
  truncated: boolean;
}

// README first. CLAUDE.md and AGENT.md in these folders are second-person
// instructions written FOR a coding agent, and putting one at the top of
// EVE's turn is handing another agent's system prompt to her verbatim. A
// human-facing README says what the project is without addressing anybody.
const SELF_DESCRIBING = ["README.md", "README.txt", "CLAUDE.md", "AGENT.md", "AGENTS.md"];

export function projectStatus(slug: string, realRoot: string): ProjectStatus {
  const inside = git(realRoot, ["rev-parse", "--is-inside-work-tree"]);
  const gitAnswered = inside.ok || inside.why === "answered-no";
  const isRepo = inside.ok && inside.out === "true";
  const branchR = isRepo ? git(realRoot, ["branch", "--show-current"]) : null;
  // `-- .` scopes both to the granted folder. Without it, a project nested
  // inside a larger repository reports the WHOLE repository's dirty files and
  // commits — facts about a tree EVE was never granted. `-uall` makes each
  // untracked file its own line, so a count of lines is a count of files.
  const statusR = isRepo ? git(realRoot, ["status", "--porcelain", "-uall", "--", "."]) : null;
  const logR = isRepo ? git(realRoot, ["log", "-3", "--date=short", "--format=%h %ad %s", "--", "."]) : null;

  let selfDescription: ProjectStatus["selfDescription"] = null;
  for (const name of SELF_DESCRIBING) {
    let full: string;
    try {
      // Through the same door as everything else. A plain path.join here let a
      // README.md that is a symlink to a file outside the root be read and
      // printed — the one place in this file that skipped its own guard.
      full = resolveInside(realRoot, name);
      if (isSecretFilename(path.basename(full)) || !fs.statSync(full).isFile()) continue;
      const raw = fs.readFileSync(full);
      if (looksBinary(raw)) continue;
      const { text } = redactLines(raw.toString("utf8"));
      // Trimmed hard: this is read out loud. A long line is clipped rather
      // than dropped, so a heading keeps its sense.
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((l) => (l.length > 160 ? l.slice(0, 160) + "…" : l));
      selfDescription = { file: name, lines };
      break;
    } catch {
      continue;
    }
  }

  const stats: WalkStats = { truncated: false };
  const all: WalkEntry[] = [];
  for (const e of walkProject(realRoot, stats)) all.push(e);
  const recent = [...all]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 8)
    .map((e) => ({ rel: safeRelPath(e.rel), mtimeMs: e.mtimeMs }));

  const commits = logR?.ok ? logR.out.split("\n").filter(Boolean) : [];
  return {
    slug,
    root: realRoot,
    gitAnswered,
    isRepo,
    branch: branchR?.ok ? branchR.out || null : null,
    // Only a git that ANSWERED can tell us there are no commits.
    hasCommits: commits.length > 0,
    dirtyFiles: statusR?.ok ? statusR.out.split("\n").filter((l) => l.trim()).length : 0,
    commits,
    selfDescription,
    recent,
    fileCount: all.length,
    truncated: stats.truncated,
  };
}
