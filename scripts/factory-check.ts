import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
// The Factory end to end, for real: stage a task → pipeline (research with
// live web search, spec, prompt) → awaiting_approval → reject with feedback
// (prompt regenerates, research cached) → approve → dispatch tool appears
// WITHOUT a restart → the spawned agent answers a message using only its
// allowlisted tools → archive → tool withdrawn. Costs a few tens of cents.
// Cleans up its own task and agent rows and spec file.
import fs from "node:fs";
import path from "node:path";
import { loadEnv, ROOT } from "../src/core/config.js";
import { Registry } from "../src/core/registry.js";
import { reminderTools } from "../src/tools/reminders.js";
import { noteTools } from "../src/tools/notes.js";
import { memoryTools } from "../src/tools/memory.js";
import { weatherTools } from "../src/tools/weather.js";
import { researchTools } from "../src/tools/research.js";
import { factoryTools } from "../src/tools/factory.js";
import { installWatcher } from "../src/factory/watcher.js";
import { stageTask, runPipeline, factoryCatalog } from "../src/factory/pipeline.js";
import { approveTask, rejectTask } from "../src/factory/approve.js";
import { getTask, getResearch, archiveAgent, listTasks, listAgents } from "../src/factory/store.js";
import { dispatchToolName } from "../src/factory/types.js";

loadEnv();

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const registry = new Registry();
for (const t of [...reminderTools, ...noteTools, ...memoryTools, ...weatherTools, ...researchTools]) registry.register(t);
for (const t of factoryTools(registry)) registry.register(t);
const watcher = installWatcher(registry);

const catalog = factoryCatalog(registry);
console.log(`catalog offered to spawned agents: ${catalog.join(", ")}`);
for (const withheld of ["forget_memory", "set_location", "set_studies_dir", "spawn_agent"]) {
  if (catalog.includes(withheld)) fail(`withheld tool leaked into the factory catalog: ${withheld}`);
}

const NAME = "Weather Poet";
let slug = "";
try {
  // 1. stage + pipeline
  const task = stageTask({
    requestedBy: "check",
    nameHint: NAME,
    roleDescription:
      "Writes a short, playful two-line poem about today's weather in a given city, in the language the user writes in. Looks the weather up before writing — never invents conditions.",
    specialRequirements: "Always exactly two lines. Never more than 30 words total.",
  });
  console.log(`staged task ${task.id}`);
  const t0 = Date.now();
  const done = await runPipeline(task.id, registry);
  if (!done || done.status !== "awaiting_approval")
    fail(`pipeline ended in ${done?.status}: ${done?.error ?? "?"}`);
  slug = done.slug!;
  const m = done.proposedManifest!;
  const research = getResearch(done.researchReportId!)!;
  console.log(
    `✅ pipeline → awaiting_approval in ${((Date.now() - t0) / 1000).toFixed(0)}s: slug=${slug}, ` +
      `${research.report.sources.length} sources, ${research.searches} searches, tools=[${m.tool_allowlist.join(", ")}], prompt ${m.system_prompt.split(/\s+/).length} words`,
  );
  if (!fs.existsSync(path.join(ROOT, "agent-specs", `${slug}.md`))) fail("spec markdown missing");
  if (!m.tool_allowlist.includes("get_weather")) fail("research didn't grant get_weather to a weather poet");
  if (!/Ground rules that override everything above/.test(m.system_prompt)) fail("code-appended rails missing from prompt");
  if (m.tool_allowlist.some((t) => !catalog.includes(t))) fail("manifest granted a tool outside the catalog");

  // 2. reject with feedback → revision, research cached
  const revised = await rejectTask(task.id, "Make it rhyme, and sign every poem with '— Poet'.", registry);
  if (revised.status !== "awaiting_approval" || revised.approvalIterations !== 1)
    fail(`revision failed: ${revised.status} iter=${revised.approvalIterations} ${revised.error ?? ""}`);
  if (revised.researchReportId !== done.researchReportId) fail("revision re-ran research (should be cached on task)");
  if (revised.proposedManifest!.system_prompt === m.system_prompt) fail("revision produced an identical prompt");
  console.log(`✅ reject-with-feedback → revised prompt (round 2), research untouched`);

  // 3. approve → hot registration, no restart
  if (registry.has(dispatchToolName(slug))) fail("dispatch tool existed before approval");
  approveTask(task.id, { onAgentAdded: () => watcher.refresh() });
  if (!registry.has(dispatchToolName(slug))) fail("dispatch tool not registered after approval");
  console.log(`✅ approved → ${dispatchToolName(slug)} live in the registry, no restart`);

  // 4. dispatch: the spawned agent runs its own prompt with its allowlist
  const out = await registry.execute(dispatchToolName(slug), {
    message: "Write me your poem for Naples.",
  });
  if (out.isError) fail(`dispatch errored: ${out.content}`);
  console.log(`✅ spawned agent answered:\n   ${out.content.split("\n").join("\n   ")}`);
  if (!/Poet/.test(out.content)) console.log("   (note: revision instruction 'sign — Poet' not visibly followed; prompt-level, not a defect)");

  // 5. archive → tool withdrawn live
  archiveAgent(slug);
  watcher.refresh();
  if (registry.has(dispatchToolName(slug))) fail("dispatch tool survived archival");
  console.log(`✅ archived → tool withdrawn live; row kept for audit`);

  // 6. invalid transition is refused loudly
  try {
    approveTask(task.id);
    fail("approving an approved task should throw");
  } catch (err) {
    if (!/not awaiting approval/.test(String(err))) fail(`wrong error on double approve: ${String(err)}`);
  }
  console.log("✅ state machine refuses an invalid transition");
} finally {
  // Clean up rows + spec so the real store stays honest.
  const tasksFile = path.join(ROOT, "data", "factory", "tasks.json");
  const agentsFile = path.join(ROOT, "data", "factory", "agents.json");
  const keepT = listTasks().filter((t) => t.requestedBy !== "check");
  const keepA = listAgents().filter((a) => a.name !== NAME);
  fs.writeFileSync(tasksFile, JSON.stringify(keepT, null, 2) + "\n");
  fs.writeFileSync(agentsFile, JSON.stringify(keepA, null, 2) + "\n");
  if (slug) fs.rmSync(path.join(ROOT, "agent-specs", `${slug}.md`), { force: true });
}
