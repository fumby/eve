import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
// Dry run of the repo watch against the real GitHub account: prints what the
// watcher can see and every ping it WOULD send — without sending a single
// notice or writing any state. Safe to run any time.
import { loadEnv, loadConfig } from "../src/core/config.js";
import { repoWatchTick, watchedRepos } from "../src/watch/github.js";

loadEnv();

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.log("No GITHUB_TOKEN in .env yet — the watch is blind until it's there.");
  console.log("Create a fine-grained token at github.com/settings/personal-access-tokens");
  console.log("(read-only: contents, actions, pull requests, Dependabot alerts),");
  console.log("add GITHUB_TOKEN=... to .env, then run this again.");
  process.exit(0);
}

const cfg = loadConfig();
const repos = await watchedRepos(token);
console.log(`Watching ${repos.length} repo(s):`);
for (const r of repos) {
  const silent = Math.floor((Date.now() - Date.parse(r.pushed_at)) / 86_400_000);
  console.log(`  - ${r.full_name} (default ${r.default_branch}, last push ${silent}d ago)`);
}
console.log(
  `Rate budget: ~${repos.length * 2}/min fast lane + slow sweep every 15min — limit is 5000/h.`,
);
console.log(`Rules: CI on [${cfg.watch.branches.join(", ")}], PRs stale >${cfg.watch.stalePRHours}h, CVE ≥ HIGH, hotfix/rollback pushes, dormant ${cfg.watch.dormantDays}d+.\n`);

const pings = await repoWatchTick({ dryRun: true });
if (pings.length === 0) {
  console.log("Would ping: nothing right now. (First run baselines history — old failures don't replay.)");
} else {
  console.log(`Would ping ${pings.length} time(s):`);
  for (const p of pings) console.log(`  🔔 ${p}\n`);
}
