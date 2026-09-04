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

if (STATE_ROOT === ROOT) {
  console.error(
    `❌ sandbox non attiva: lo stato punta al progetto reale (${ROOT}).\n` +
      `   Questo script scriverebbe su conversazioni, memorie e log veri.\n` +
      `   Non impostare EVE_STATE_DIR a mano, oppure impostala a una directory usa-e-getta.`,
  );
  process.exit(1);
}

export { PROJECT_ROOT };
