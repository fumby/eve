// Run one design dispatch from the terminal and watch it narrate — the same
// path EVE's design_dispatch tool takes, minus the gate. Costs real money
// (capped by config.json design.maxDispatchUsd, or --max-usd).
//
//   npx tsx scripts/design-dispatch.ts <project> "<request>" [--feature f] [--screen s] [--quality premium] [--max-usd 5]
import { loadEnv } from "../src/core/config.js";
import { runDispatch } from "../src/design/dispatch.js";

loadEnv();

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--")));
const [project, request] = positional;
if (!project || !request) {
  console.error('usage: npx tsx scripts/design-dispatch.ts <project> "<request>" [--feature f] [--screen s] [--quality premium] [--max-usd 5]');
  process.exit(2);
}

const started = Date.now();
const result = await runDispatch(
  {
    project,
    request,
    ...(flag("feature") ? { featureSlug: flag("feature")! } : {}),
    ...(flag("screen") ? { screenName: flag("screen")! } : {}),
    ...(flag("quality") === "premium" ? { quality: "premium" as const } : {}),
    ...(flag("max-usd") ? { maxUsd: Number(flag("max-usd")) } : {}),
  },
  {
    sink: (e) => {
      const t = new Date(e.at).toTimeString().slice(0, 8);
      console.log(`[${t}] ${e.kind.padEnd(9)} ${e.text}`);
    },
  },
);

console.log("\n— result —");
console.log(JSON.stringify({ ...result, composer: result.composer ? { ...result.composer, resultText: result.composer.resultText.slice(0, 400) } : null }, null, 2));
console.log(`\n${result.ok ? "✅" : "❌"} ${result.summary} · wall ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(result.ok ? 0 : 1);
