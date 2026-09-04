// The studies reader's containment, on a fixture tree. Every one of these was
// reproduced against src/tools/notes.ts before it was written — none is
// hypothetical:
//
//   1. safeJoin() was a LEXICAL prefix check. path.resolve does not follow
//      symlinks, so a directory symlink inside the studies folder
//      ("linkdir" -> "../outside") produces a path spelled entirely inside the
//      root, passes startsWith(), and then reads the file on the other side. A
//      readFileSync through "linkdir/secret.md" returned the outside file.
//   2. The dotfile skip lived only in walk(). A path the model supplies never
//      goes through the walk, so read_note(".env") was reachable — and the
//      studies folder sits in a home directory full of them.
//   3. fs.realpathSync does NOT canonicalise case on macOS. It resolves
//      symlinks and hands back the CALLER's spelling, so a case-variant path
//      compares !== the real one while opening exactly the same directory —
//      which defeats every ===/startsWith containment test built on it. Only
//      fs.realpathSync.native goes through the platform realpath. The last two
//      tests here are the ones that go red if canonical() is ever downgraded.
//
// The fix is not local to this file: notes.ts reuses canonical()/resolveInside()
// from src/projects/read.ts rather than carrying a second implementation, so
// these tests and tests/projects.test.ts guard one set of rules from two doors.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// This suite writes studiesDir into runtime state, so it gets a state directory
// of its OWN rather than sharing the one npm test exports. node --test runs
// test files concurrently, saveRuntime() is a read-modify-write of a single
// runtime.json, and a write interleaved with tests/config-runtime.test.ts can
// drop the key that suite just set. The env var has to be in place before
// config.js is evaluated (STATE_ROOT is computed at module load), which is why
// these two imports are dynamic and everything above them is stdlib.
process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-notes-state-"));
const { setStudiesDir } = await import("../src/core/config.js");
const { noteTools } = await import("../src/tools/notes.js");

const searchNotes = noteTools.find((t) => t.name === "search_notes")!;
const readNote = noteTools.find((t) => t.name === "read_note")!;

// ── the fixture ──────────────────────────────────────────────────────────
// A studies folder with a dotfile, a secret living outside it, both kinds of
// symlink pointing at that secret, and one honest symlink pointing back inside.
// mkdtemp is canonicalised natively so the root string here IS the filesystem's
// spelling — otherwise the case tests below would be comparing two guesses.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "eve-notes-")));
const root = path.join(tmp, "studies");
const outside = path.join(tmp, "outside");
fs.mkdirSync(path.join(root, "sub"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });

fs.writeFileSync(path.join(outside, "secret.md"), "TOP SECRET VALUE\n");
fs.writeFileSync(path.join(root, ".env"), "GROQ_API_KEY=gsk_realkeyvalue123456\n");
// The dotfiles that matter for read_note. ".env" alone proves nothing: extname
// (".env") is "", so the TEXT_EXT allowlist refuses it by accident and a dot
// guard that does not exist still looks present. These two wear a readable
// extension, so only a real dot-segment check can stop them — and a dotted
// DIRECTORY is the sharp case, since the dot is not in the basename at all.
fs.mkdirSync(path.join(root, ".private"), { recursive: true });
fs.writeFileSync(path.join(root, ".private", "diary.md"), "PRIVATE DIARY VALUE\n");
fs.writeFileSync(path.join(root, ".secrets.txt"), "DOTFILE SECRET VALUE\n");
fs.writeFileSync(path.join(root, "algebra.md"), "Notes on break-even analysis.\n");
fs.writeFileSync(path.join(root, "sub", "finance.md"), "Notes on the cost of capital.\n");
fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "link.md")); // file symlink
fs.symlinkSync(outside, path.join(root, "linkdir")); // DIRECTORY symlink — the one that bites
// An HONEST symlink: it points back inside the root, but its stored target is
// spelled in a different case. On a case-insensitive volume that is the same
// directory; to a string comparison it is not. This is what separates
// realpathSync.native (returns the on-disk spelling, allows the read) from
// realpathSync (returns this link's spelling, refuses a file that is inside).
fs.symlinkSync(path.join(root, "sub").toUpperCase(), path.join(root, "shortcut"));

// The two case tests below are meaningless on a case-sensitive volume, where
// the variant spelling is simply a different, absent path. Detected, not assumed.
const CASE_INSENSITIVE = fs.existsSync(root.toUpperCase());

setStudiesDir(root);

const read = (p: string) => readNote.run({ path: p });
const search = (q: string) => searchNotes.run({ query: q });

// ── containment ──────────────────────────────────────────────────────────
test("a symlinked DIRECTORY cannot walk a read out of the studies folder", async () => {
  // The reproduced failure. This path is spelled entirely inside the root, so
  // the lexical check accepts it; only realpath reveals where it lands.
  await assert.rejects(() => read("linkdir/secret.md"));
  await assert.rejects(() => read("linkdir/../outside/secret.md"));
});

test("a symlinked FILE cannot either", async () => {
  await assert.rejects(() => read("link.md"));
});

test("..-escapes and absolute paths are refused", async () => {
  // An outcome guard, not a guard on one line: isAbsolute, the lexical prefix
  // and the realpath check each catch all three of these on their own, and this
  // only goes red once every layer is gone. Verified by removing them in turn.
  await assert.rejects(() => read("../outside/secret.md"));
  await assert.rejects(() => read("sub/../../outside/secret.md"));
  await assert.rejects(() => read(path.join(outside, "secret.md")));
});

test("a dotfile is refused when the model names it directly", async () => {
  // The second reproduced failure: the dotfile skip lives in walk(), and a path
  // the model supplies never passes through the walk. A guard that lives only
  // in the walker is a guard with the front door open.
  await assert.rejects(() => read(".env"));
  await assert.rejects(() => read(".secrets.txt"));
  await assert.rejects(() => read(".private/diary.md"));
  await assert.rejects(() => read("sub/../.private/diary.md"));
});

test("no refusal ever hands back the file it refused", async () => {
  // A guard that throws but still returns content is not a guard. Belt and
  // braces on the two paths that actually reach a secret.
  for (const p of ["linkdir/secret.md", "link.md", ".env", ".secrets.txt", ".private/diary.md"]) {
    const out = await read(p).catch((e: unknown) => `THREW: ${(e as Error).message}`);
    assert.ok(out.startsWith("THREW: "), `${p} was read instead of refused: ${out}`);
    assert.ok(!out.includes("TOP SECRET VALUE"), `${p} leaked the outside file`);
    assert.ok(!out.includes("gsk_realkeyvalue123456"), `${p} leaked the key`);
    assert.ok(!out.includes("DIARY VALUE") && !out.includes("DOTFILE SECRET"), `${p} leaked a dotfile`);
  }
});

test("an ordinary note still reads, and the walk still finds it", async () => {
  // The guards have to leave the tool doing its job — a reader that refuses
  // everything passes every containment test and is worthless.
  assert.ok((await read("algebra.md")).includes("break-even analysis"));
  assert.ok((await read("sub/finance.md")).includes("cost of capital"));
  const hits = await search("break-even");
  assert.ok(hits.includes("algebra.md"), hits);
});

test("the walk surfaces neither the dotfile nor anything symlinked", async () => {
  const hits = await search("e"); // matches nearly everything
  assert.ok(!hits.includes(".env"), hits);
  assert.ok(!hits.includes(".secrets") && !hits.includes("diary"), hits);
  assert.ok(!hits.includes("link"), `a symlink was walked: ${hits}`);
  assert.ok(!hits.includes("TOP SECRET VALUE"), hits);
});

// ── what the native realpath is for ──────────────────────────────────────
test("the studies root is reported in the filesystem's spelling, not the caller's", {
  skip: CASE_INSENSITIVE ? false : "volume is case-sensitive",
}, async () => {
  // Every containment check in notes.ts is a comparison against this root. If
  // it keeps the spelling that happened to be in runtime.json instead of the
  // one on disk, the checks are comparing against a string the filesystem does
  // not use. fs.realpathSync returns "/PRIVATE/VAR/..." here; only .native
  // returns the real spelling.
  setStudiesDir(root.toUpperCase());
  try {
    const hits = await search("break-even");
    assert.ok(hits.includes(root), `root was reported as the caller spelled it:\n${hits}`);
    assert.ok(!hits.includes(root.toUpperCase()), hits);
  } finally {
    setStudiesDir(root);
  }
});

test("a note behind an inside symlink spelled in another case is still readable", {
  skip: CASE_INSENSITIVE ? false : "volume is case-sensitive",
}, async () => {
  // "shortcut" points at this same root's own sub/ directory, spelled in upper
  // case. With fs.realpathSync the resolved path comes back in the link's
  // spelling, fails startsWith(root + sep), and a note that is plainly inside
  // the folder gets refused. With .native it resolves to the on-disk spelling
  // and reads. This is the guard that goes red if canonical() is downgraded.
  assert.ok((await read("shortcut/finance.md")).includes("cost of capital"));
});
