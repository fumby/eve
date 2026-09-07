// Bake-off: which of EVE's research backends actually finds "the best X"?
//
// Runs ONE question through the three live paths exactly as production code
// would — deep_research (Anthropic server-side web search, multi-round),
// perplexity_search quick (sonar) and thorough (sonar-pro) — and saves each
// output for side-by-side judging. Real API spend, real latency: the ranking
// of "which research type is the best one" must come from observation, not
// from a README. The outputs land in the given dir as three .md files plus a
// manifest.json with timings; a human (or Hermes) reads them and judges.
//
// Usage: npx tsx scripts/research-bakeoff.ts [outdir]
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnv } from "../src/core/config.js";
import { researchTools } from "../src/tools/research.js";
import { perplexityTools } from "../src/tools/perplexity.js";

// Self-contained, as the deep_research schema demands — the sub-agent cannot
// see the conversation. Deliberately the exact shape of Umberto's real ask
// ("find me the best dermatologist in surgery, Paris") with the ambiguity
// left IN: a good researcher resolves it, a lazy one assumes.
const QUESTION =
  "Find the best dermatologist for surgery in Paris, France — chirurgie " +
  "dermatologique, a dermatologist who operates (e.g. skin cancer, mole " +
  "removal). The reader is a 21-year-old student in Cergy who can travel " +
  "anywhere in Paris. 'Best' must be judged on verifiable evidence, not " +
  "marketing.";

async function run(
  label: string,
  outDir: string,
  fn: () => Promise<string>,
): Promise<{ label: string; ms: number; chars: number }> {
  const started = Date.now();
  process.stdout.write(`[${label}] running…\n`);
  let out: string;
  try {
    out = await fn();
  } catch (err) {
    out = `ERROR: ${String(err)}`;
  }
  const ms = Date.now() - started;
  writeFileSync(`${outDir}/${label}.md`, out);
  process.stdout.write(`[${label}] done in ${Math.round(ms / 1000)}s, ${out.length} chars\n`);
  return { label, ms, chars: out.length };
}

async function main() {
  loadEnv();
  const outDir = process.argv[2] ?? "/tmp/eve-bakeoff";
  mkdirSync(outDir, { recursive: true });

  const deep = researchTools.find((t) => t.name === "deep_research");
  const pplx = perplexityTools.find((t) => t.name === "perplexity_search");
  if (!deep || !pplx) throw new Error("research tools not found in registry exports");

  const results: { label: string; ms: number; chars: number }[] = [];

  // A — the incumbent: Anthropic web search, standard depth (the default EVE
  // would pick). This is the path the methodology upgrade would land in.
  results.push(
    await run("A-deep-research", outDir, () => deep.run({ question: QUESTION, depth: "standard" })),
  );

  // B — Perplexity quick (sonar): the cheap single-shot path.
  results.push(
    await run("B-perplexity-sonar", outDir, () => pplx.run({ question: QUESTION, depth: "quick" })),
  );

  // C — Perplexity thorough (sonar-pro): the "harder questions" single-shot.
  results.push(
    await run("C-perplexity-sonar-pro", outDir, () => pplx.run({ question: QUESTION, depth: "thorough" })),
  );

  writeFileSync(`${outDir}/manifest.json`, JSON.stringify({ question: QUESTION, results }, null, 2));
  process.stdout.write(`manifest written to ${outDir}/manifest.json\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
