// The shared machinery behind the boundary guards. Not a *.test.ts, so the
// suite's glob never runs it directly — it is imported by the guards that do.
//
// It exists because there is now more than one "nothing may write here" rule
// (memory/core/ + brain/identity.md, and config.json), and the hard part of
// those guards is not the rule — it is this scanner. Two hand-copied versions
// would drift, and the blind spots that drift opens are exactly the ones this
// file already learned about the expensive way: see the comments below.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/core/config.js";

export interface ProtectedPath {
  pattern: RegExp;
  label: string;
}

// Vendored or generated trees: not ours to police, and scanning them is noise.
// desktop/venv holds pywebview's own JS; design/.prism/preview is a generated
// Next app (a dot-directory, so it is skipped anyway).
const SKIP_DIRS = new Set(["node_modules", "venv", "dist", "__pycache__"]);

// Anything that can create, truncate, move, or destroy a file. Call-shaped on
// purpose: a bare substring would match prose — "rm" alone hits the word "warm"
// in a string literal two lines from a legitimate read of identity.md.
// writeFileAtomic and writeJson are this repo's OWN write helpers; a guard that
// only knew node:fs would leave a door open straight through src/core/atomic.ts.
// mkdirSync is deliberately absent — creating a directory destroys nothing.
const WRITE_CALL =
  /\b(writeFileAtomic|writeJson|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|rename|unlinkSync|unlink|truncateSync|truncate|rmdirSync|rmSync|rm)\s*\(/;

// A write call and the path it targets are rarely on the same line — the path
// is usually built a line above, or passed a line below.
const WINDOW = 2;

// NOTE for anyone writing a new guard on top of this: only // and /* comments
// are skipped, so an assertion MESSAGE is scanned like any other code. Naming a
// write helper with an open paren inside a failure string, within two lines of
// the path that guard protects, makes the guard fire on its own text. Name them
// without the paren in prose.
export function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

export function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|js|mts)$/.test(entry.name)) found.push(full);
  }
  return found;
}

// EVERY top-level directory holding executable code, discovered at runtime.
// Scoping this to src/ was the original guard's blind spot: scripts/ is just as
// executable, and scripts/brain-check.ts really was writing to brain/identity.md
// the whole time the guard sat green. Discovery rather than a hardcoded list, so
// a new directory is covered the day it appears — not the day someone remembers.
export function allSourceFiles(): string[] {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
    .flatMap((e) => sourceFiles(path.join(ROOT, e.name)));
}

// A local name bound to a protected path is exactly as dangerous as the path
// itself, and the guard has to see it as one. This is the OTHER half of the
// blind spot: brain-check.ts calls its constant IDENTITY, not IDENTITY_FILE,
// and writes to it 21 lines below the literal — so widening the directory scope
// alone would still have missed it. Match on what a name is bound to, never on
// the fixed set of names that happen to be used in src/.
function boundToProtectedPath(lines: string[], protectedPaths: ProtectedPath[]): ProtectedPath[] {
  const bound: ProtectedPath[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isComment(lines[i]!)) continue;
    const declared = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[i]!);
    if (!declared) continue;
    // The path can spill onto the next line or two in a wrapped path.join().
    const initialiser = lines
      .slice(i, i + 3)
      .filter((l) => !isComment(l))
      .join("\n");
    if (!protectedPaths.some((p) => p.pattern.test(initialiser))) continue;
    const name = declared[1]!;
    bound.push({
      pattern: new RegExp(`\\b${name}\\b`),
      label: `${name} (bound to a protected path at line ${i + 1})`,
    });
  }
  return bound;
}

export interface Offence {
  file: string;
  line: number;
  write: string;
  protectedBy: string;
  text: string;
}

// Every executable file in the repo, checked for a filesystem write sitting
// within WINDOW lines of any of the given protected paths.
export function scanForWrites(protectedPaths: ProtectedPath[]): {
  files: string[];
  offences: Offence[];
} {
  const files = allSourceFiles();
  const offences: Offence[] = [];
  // One write call can sit in range of the same path on several nearby lines;
  // report it once, or the failure drowns the reader in repeats.
  const seen = new Set<string>();
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const protectedHere = [...protectedPaths, ...boundToProtectedPath(lines, protectedPaths)];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isComment(line)) continue;
      const write = line.match(WRITE_CALL);
      if (!write) continue;
      // Look at the neighbourhood: the path may sit just above or just below.
      for (let j = Math.max(0, i - WINDOW); j <= Math.min(lines.length - 1, i + WINDOW); j++) {
        const near = lines[j]!;
        if (isComment(near)) continue;
        for (const p of protectedHere) {
          if (!p.pattern.test(near)) continue;
          const rel = path.relative(ROOT, file);
          const key = `${rel}:${i}:${p.label}`;
          if (seen.has(key)) continue;
          seen.add(key);
          offences.push({
            file: rel,
            line: i + 1,
            write: write[1]!,
            protectedBy: p.label,
            text: line.trim(),
          });
        }
      }
    }
  }
  return { files, offences };
}
