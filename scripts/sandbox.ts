// MUST be the first import in every verification script:
//
//     import "./sandbox.js";
//
// Points EVE's mutable state at a throwaway directory, so a check can never
// write over a real conversation, memory, or audit log. Before this existed,
// scripts/brain-check.ts alone had put 30 synthetic conversations into
// data/conversations.json — enough that the "previous session" EVE reported was
// a test run rather than anything Umberto had said.
//
// It uses NOTHING from src/ at the top level, and that is load-bearing. ROOT and
// STATE_ROOT are module-level constants, and ESM evaluates every static import
// before the first statement of the importing module runs — so a static
// `import { STATE_ROOT }` here would read the variable before it is set. The
// environment is prepared with node builtins only; src/ is reached by dynamic
// import afterwards, when the answer is already correct.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.EVE_STATE_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-check-"));
  // Every write path creates its own directory with { recursive: true }, so an
  // empty sandbox is enough. Nothing is seeded on purpose: the checks that need
  // memories create and delete their own, and copying Umberto's real ones into
  // /tmp would spread his personal notes for no gain.
  process.env.EVE_STATE_DIR = dir;
  console.log(`[sandbox] stato isolato in ${dir}`);
}

// Now that the variable is set, ask the real config what it resolved to.
const { ROOT, STATE_ROOT } = await import("../src/core/config.js");

// The guard used to be `STATE_ROOT === ROOT`, a raw string compare, and that is
// not the same question. STATE_ROOT is path.resolve(EVE_STATE_DIR), which
// normalises "." and ".." and trailing slashes but does NOT resolve symlinks or
// case. This Mac's filesystem is case-insensitive, so
// EVE_STATE_DIR=/Users/YOU/trillion — one lowercase letter — IS the
// real checkout and passed the old check; so does any symlink pointing at it.
// Compare what the FILESYSTEM calls them instead.
//
// Containment is checked BOTH ways, and the second direction is the one that
// bites: EVE_STATE_DIR=$HOME also passed the old check, and then every write
// lands in a directory that already holds the real repo.
function canonical(p: string): string {
  // realpathSync throws on a path that doesn't exist yet — a hand-set sandbox
  // directory usually doesn't — so canonicalise the deepest ancestor that does
  // and re-attach the rest. Symlinks and case are resolved for that ancestor,
  // which is where the aliasing lives.
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...[...tail].reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // hit the filesystem root
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

const realRoot = canonical(ROOT);
const realState = canonical(STATE_ROOT);
const contains = (outer: string, inner: string): boolean =>
  outer === inner || inner.startsWith(outer + path.sep);

if (contains(realRoot, realState) || contains(realState, realRoot)) {
  console.error(
    `❌ sandbox non attiva: lo stato (${STATE_ROOT} → ${realState})\n` +
      `   coincide con il progetto reale, sta dentro di esso, o lo contiene (${realRoot}).\n` +
      `   Questo script scriverebbe — e cancellerebbe — conversazioni, memorie e log veri.\n` +
      `   Non impostare EVE_STATE_DIR a mano, oppure impostala a una directory usa-e-getta.`,
  );
  process.exit(1);
}

export { PROJECT_ROOT };
