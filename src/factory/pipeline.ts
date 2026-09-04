// The spawn pipeline: walks one task pending → researching → drafting_spec →
// writing_prompt → awaiting_approval, or to failed. Whatever happens inside,
// a started task ALWAYS ends in a terminal-or-awaiting state — no exception
// escapes run(). Only Tier 2 re-runs on revision; research stays cached on
// the task so a rejection never re-burns the search budget.
import { loadConfig } from "../core/config.js";
import { audit } from "../core/audit.js";
import { emitAgentEvent } from "../core/agent-events.js";
import type { Registry } from "../core/registry.js";
import { isFactoryAllowed } from "../core/registry.js";
import {
  getTask,
  getResearch,
  transition,
  updateTask,
  listAgents,
  createTask,
  tasksCreatedToday,
} from "./store.js";
import { researchDomain } from "./research.js";
import { generateSystemPrompt, sanitizeUserText, slugFor, writeSpecMarkdown } from "./generate.js";
import type { Manifest, SkillsReport, SpawnTask } from "./types.js";

export const FACTORY_AGENT = {
  id: "factory",
  name: "Factory",
  specialty: "Mints new sub-agents",
  initial: "F",
};

// The Factory tells the face what it's doing at every step.
function progress(taskId: string, label: string, phase: "dispatch" | "working" | "done" | "error" = "working"): void {
  emitAgentEvent({ agent: "factory", phase, label, detail: { taskId }, descriptor: FACTORY_AGENT });
}

// The catalog a spawned agent may draw from: every registered tool that
// passes the factory policy. Dispatch tools of other spawned agents are
// excluded by that policy — the hierarchy stays flat.
export function factoryCatalog(registry: Registry): string[] {
  return registry
    .all()
    .filter(isFactoryAllowed)
    .map((t) => t.name)
    .sort();
}

export class CapReached extends Error {}
export class RefusedInput extends Error {}

// Creation is where the daily cap and the sanitizer bite — before any model
// call, so an attacker can't queue work even if approvals are gated.
export function stageTask(input: {
  requestedBy: string;
  nameHint: string;
  roleDescription: string;
  specialRequirements?: string;
}): SpawnTask {
  const cap = loadConfig().factory.dailyCap;
  if (tasksCreatedToday() >= cap) {
    throw new CapReached(`the Factory already staged ${cap} agents today — the daily cap`);
  }
  const role = sanitizeUserText(input.roleDescription);
  if (role.refused) throw new RefusedInput(`role description refused: ${role.refused}`);
  const reqs = sanitizeUserText(input.specialRequirements ?? "");
  if (reqs.refused) throw new RefusedInput(`special requirements refused: ${reqs.refused}`);
  const nameHint = sanitizeUserText(input.nameHint).text.slice(0, 60);
  if (!nameHint) throw new RefusedInput("a name hint is required");
  const task = createTask({
    requestedBy: input.requestedBy,
    nameHint,
    roleDescription: role.text,
    specialRequirements: reqs.text,
  });
  audit("factory_task", { id: task.id, event: "staged", nameHint });
  return task;
}

function takenSlugs(): Set<string> {
  return new Set(listAgents().map((a) => a.slug));
}

function buildManifest(task: SpawnTask, report: SkillsReport, systemPrompt: string, catalog: string[]): Manifest {
  const allowed = new Set(catalog);
  return {
    slug: task.slug!,
    name: task.nameHint,
    specialty: report.domain,
    system_prompt: systemPrompt,
    // Defense in depth: even if research named a withheld tool, it can't
    // reach the manifest.
    tool_allowlist: report.tools_available.filter((t) => allowed.has(t)),
    model: loadConfig().factory.model,
  };
}

// Tier 2 alone: (re)generate the prompt for a task whose research is done.
// Used by the first pass and by every revision round.
export async function writePromptStage(taskId: string, registry: Registry): Promise<void> {
  const task = getTask(taskId);
  if (!task || !task.researchReportId || !task.slug) throw new Error(`task ${taskId} not ready for prompt`);
  const research = getResearch(task.researchReportId);
  if (!research) throw new Error(`research ${task.researchReportId} missing`);
  const catalog = factoryCatalog(registry);
  const toolAllowlist = research.report.tools_available.filter((t) => catalog.includes(t));

  progress(taskId, task.approvalIterations > 0 ? "revising prompt" : "writing prompt");
  const systemPrompt = await generateSystemPrompt({
    name: task.nameHint,
    slug: task.slug,
    specialty: research.report.domain,
    roleDescription: task.roleDescription,
    specialRequirements: task.specialRequirements,
    report: research.report,
    toolAllowlist,
    priorPrompt: task.proposedManifest?.system_prompt,
    revisionFeedback: task.revisionFeedback ?? undefined,
  });
  updateTask(taskId, { proposedManifest: buildManifest(task, research.report, systemPrompt, catalog) });
  transition(taskId, "awaiting_approval");
  audit("factory_task", { id: taskId, event: "awaiting_approval", iteration: task.approvalIterations });
  progress(taskId, `ready for approval: ${task.nameHint}`, "done");
}

// The whole pipeline for a fresh task. Never throws.
export async function runPipeline(taskId: string, registry: Registry): Promise<SpawnTask | null> {
  const start = getTask(taskId);
  if (!start || start.status !== "pending") return start;
  progress(taskId, `spawning: ${start.nameHint}`, "dispatch");
  try {
    // Slug first — a collision fails before any tokens burn.
    const { slug, error } = slugFor(start.nameHint, takenSlugs());
    if (error) throw new Error(`slug: ${error}`);
    updateTask(taskId, { slug });

    transition(taskId, "researching");
    progress(taskId, `researching: ${start.roleDescription.slice(0, 60)}`);
    const catalog = factoryCatalog(registry);
    const { report, cached } = await researchDomain(start.roleDescription, { toolCatalog: catalog });
    updateTask(taskId, { researchReportId: report.id });
    audit("factory_task", { id: taskId, event: "researched", cached, sources: report.report.sources.length });

    transition(taskId, "drafting_spec");
    progress(taskId, "drafting spec");
    writeSpecMarkdown({
      slug,
      name: start.nameHint,
      specialty: report.report.domain,
      roleDescription: start.roleDescription,
      specialRequirements: start.specialRequirements,
      report: report.report,
      toolAllowlist: report.report.tools_available.filter((t) => catalog.includes(t)),
      model: loadConfig().factory.model,
    });

    transition(taskId, "writing_prompt");
    await writePromptStage(taskId, registry);
    return getTask(taskId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      updateTask(taskId, { error: message });
      transition(taskId, "failed");
    } catch {
      // even the failure path must not throw past here
    }
    audit("factory_task", { id: taskId, event: "failed", error: message });
    progress(taskId, `failed: ${message.slice(0, 80)}`, "error");
    return getTask(taskId);
  }
}
