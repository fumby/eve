// memory/core/ and brain/identity.md are Umberto's to write, never EVE's. That
// protection is not a parser, a permission bit, or a marker in the text — it is
// simply the absence of any code that writes there. An absence is easy to break
// by accident, so this test is what keeps it true: it reads every source file
// and fails if a filesystem write ever appears next to one of those paths.
// The scanner itself lives in ./boundary-scan.ts, shared with the config guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/core/config.js";
import { isComment, scanForWrites, sourceFiles, type ProtectedPath } from "./boundary-scan.js";

const SRC = path.join(ROOT, "src");

// The protected paths, in every textual form they take in this codebase: the
// literal path, the constants that hold it, and the split path.join() form
// (path.join(ROOT, "memory", "core") never contains the substring "memory/core").
// The identity patterns name brain/identity.md specifically, not any file that
// happens to be called identity.md. A bare /identity\.md/ was over-broad in the
// other direction: it fired on a check script's throwaway copy in a temp dir,
// which is not the protected file and never was. Precision here is not a
// loophole — the thing being protected is the one under brain/.
// The named-constant patterns stay even though boundToProtectedPath() infers
// bindings: a name IMPORTED from another module has no visible initialiser in
// the file that uses it.
const PROTECTED: ProtectedPath[] = [
  { pattern: /memory\/core/, label: "memory/core" },
  { pattern: /["']memory["']\s*,\s*["']core["']/, label: 'path.join(…, "memory", "core")' },
  { pattern: /\bCORE_DIR\b/, label: "CORE_DIR" },
  { pattern: /\bCORE_FILES\b/, label: "CORE_FILES" },
  { pattern: /brain\/identity\.md/, label: "brain/identity.md" },
  { pattern: /["']brain["']\s*,\s*["']identity\.md["']/, label: 'path.join(…, "brain", "identity.md")' },
  { pattern: /\bidentityFile\b/, label: "identityFile" },
];

// Without this, a scan that silently found nothing would let every other
// assertion below pass while checking absolutely nothing.
test("the boundary scan actually reads the source tree", () => {
  const { files } = scanForWrites(PROTECTED);
  assert.ok(
    files.length > 0,
    `scanned zero files under ${SRC} — the guard below would pass vacuously`,
  );
  // Sanity: the files that define the boundary must be among them.
  const rel = files.map((f) => path.relative(ROOT, f));
  assert.ok(rel.includes("src/brain/prompt.ts"), "src/brain/prompt.ts not scanned");
  assert.ok(rel.includes("src/memory/store.ts"), "src/memory/store.ts not scanned");
  // …and so must the directories the original guard never looked at. scripts/
  // is where the real violation lived while this test reported green.
  assert.ok(rel.includes("scripts/brain-check.ts"), "scripts/ not scanned");
  assert.ok(
    rel.some((f) => f.startsWith("tests/")),
    "tests/ not scanned",
  );
});

// The other invariant that rests on nothing but care: confirmedByHuman is the
// one documented way past the credential filter — in saveMemory(), and now in
// saveSkill(), which shares the same filter — and it is legitimate ONLY because
// the confirmation gate already asked Umberto. It is a separate argument
// precisely so no model-authored tool-call JSON can reach it — but nothing stops
// a future caller from simply hardcoding it true. This makes "only in a file
// that OWNS a gate, and computed from the same predicate that gate opens on" a
// checked fact rather than a convention.
//
// Two files, not one, since skills arrived. They are listed with the predicate
// each must use rather than allowed as a set of paths: a stray `true` in a file
// that happens to be on the list is the failure this test exists to catch, and
// the pairing is what keeps the list from becoming a hole. That the named
// predicate really is the gate's is checked behaviourally next door — see
// tests/memory-sensitive.test.ts and tests/skills.test.ts, which assert the
// gate fires on exactly the content the store refuses.
const GATED_WRITERS: { file: string; predicate: RegExp; label: string }[] = [
  {
    file: path.join("src", "tools", "memory.ts"),
    predicate: /confirmedByHuman:\s*sensitiveForSave\(/,
    label: "sensitiveForSave()",
  },
  {
    file: path.join("src", "tools", "skills.ts"),
    predicate: /confirmedByHuman:\s*sensitiveSkill\(/,
    label: "sensitiveSkill()",
  },
];

test("confirmedByHuman is only ever passed from a tool that owns a gate", () => {
  const assignments: { file: string; line: number; text: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isComment(line)) continue;
      // `confirmedByHuman:` assigns a value; `confirmedByHuman?:` only declares
      // the option's type, and `opts.confirmedByHuman` only reads it.
      if (!/confirmedByHuman\s*:/.test(line)) continue;
      if (/confirmedByHuman\s*\?\s*:/.test(line)) continue;
      assignments.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
    }
  }

  const where = assignments.map((a) => `  ${a.file}:${a.line} — ${a.text}`).join("\n");
  const allowed = new Map(GATED_WRITERS.map((w) => [w.file, w]));

  assert.ok(assignments.length > 0, "confirmedByHuman has no call sites — did it get renamed?");

  const strays = assignments.filter((a) => !allowed.has(a.file));
  assert.deepEqual(
    strays.map((a) => `${a.file}:${a.line}`),
    [],
    `confirmedByHuman is passed from outside the gated tools:\n${where}\n\n` +
      `It is the only way past the credential filter in saveMemory()/saveSkill(),\n` +
      `and it is sound ONLY where the confirmation gate has already asked Umberto.\n` +
      `Those tools are where the gate is; anywhere else the claim is simply untrue.\n` +
      `Allowed: ${GATED_WRITERS.map((w) => w.file).join(", ")}.\n` +
      `Route the new caller through save_memory / save_skill instead.`,
  );

  for (const a of assignments) {
    const rule = allowed.get(a.file)!;
    assert.match(
      a.text,
      rule.predicate,
      `confirmedByHuman must be computed from ${rule.label} — the SAME predicate\n` +
        `that decides whether ${a.file}'s gate opens. A literal true (or any other\n` +
        `condition) would claim Umberto approved something he was never asked about.\n` +
        `Found at ${a.file}:${a.line}: ${a.text}`,
    );
  }
});

test("no executable code anywhere writes to memory/core/ or brain/identity.md", () => {
  const { offences } = scanForWrites(PROTECTED);
  const report = offences
    .map((o) => `  ${o.file}:${o.line} — ${o.write}() near ${o.protectedBy}\n      ${o.text}`)
    .join("\n");
  assert.deepEqual(
    offences,
    [],
    `A filesystem write appeared next to a protected path:\n${report}\n\n` +
      `memory/core/ and brain/identity.md are READ-ONLY for EVE. They hold what\n` +
      `Umberto has said about himself in his own words; everything EVE learns on\n` +
      `her own belongs in memory/store/ instead. Nothing in the code enforces this\n` +
      `but the absence of a writer — which is exactly what this test guards.\n\n` +
      `If EVE genuinely needs to write there, that is Umberto's decision to make\n` +
      `deliberately, not a test to patch out of the way.`,
  );
});
