// One-off verification (Sep 6): the standing-checks Tier-6 gate. Creates a
// check through the tool on a registry with NO confirm hook — exactly the
// heartbeat's registry — and asserts the auto-deny: nothing created, a gate
// note in the inbox. Run with: npx tsx scripts/gate-check-standing.ts
import "./sandbox.js";

const { Registry } = await import("../src/core/registry.js");
const { standingCheckTools, loadStandingChecks } = await import("../src/tools/standing-checks.js");
const { listNotices } = await import("../src/core/notices.js");

const r = new Registry(); // no confirm hook — exactly the heartbeat's registry
for (const t of standingCheckTools) r.register(t);
const before = loadStandingChecks().length;
const res = await r.execute("create_standing_check", {
  mission: "this must never be created without Umberto saying yes to it",
  interval_minutes: 720,
});
const created = loadStandingChecks().length - before;
const noted = listNotices().some((n) => n.check === "gate" && n.text.includes("create standing check"));
console.log("isError:", res.isError);
console.log("content:", res.content.slice(0, 120));
console.log("checks created:", created, "(must be 0)");
console.log("gate note in inbox:", noted);
if (!res.isError || created !== 0 || !noted) {
  console.error("GATE CHECK FAILED");
  process.exit(1);
}
console.log("GATE CHECK PASSED");
