// The approval gate — the point of the whole Factory. Nothing becomes a
// dispatchable agent until Umberto has read its manifest and said yes.
// Reject-with-feedback re-runs ONLY the prompt stage (research is cached on
// the task); reject-without-feedback is terminal; the iteration cap turns
// perpetual rejection into a clean failure instead of an open LLM tap.
import { loadConfig } from "../core/config.js";
import { audit } from "../core/audit.js";
import { addNotice } from "../core/notices.js";
import type { Registry } from "../core/registry.js";
import { getTask, saveAgent, transition, updateTask } from "./store.js";
import { writePromptStage } from "./pipeline.js";
import type { SpawnedAgent, SpawnTask } from "./types.js";

export class NotApprovable extends Error {}

export interface ApprovalHooks {
  // Called after the row lands so the registry can register the dispatch
  // tool immediately (the watcher would catch it within a tick anyway).
  onAgentAdded?: (agent: SpawnedAgent, taskId: string) => void;
}

export function approveTask(taskId: string, hooks: ApprovalHooks = {}): SpawnedAgent {
  const task = getTask(taskId);
  if (!task || task.status !== "awaiting_approval" || !task.proposedManifest) {
    throw new NotApprovable(`task ${taskId} is not awaiting approval`);
  }
  const agent = saveAgent(task.proposedManifest, taskId);
  transition(taskId, "approved");
  audit("factory_task", { id: taskId, event: "approved", slug: agent.slug });
  audit("factory_agent", { slug: agent.slug, event: "added", createdByTaskId: taskId });
  hooks.onAgentAdded?.(agent, taskId);
  return agent;
}

// Feedback → revision (bounded); no feedback → terminal rejection.
export async function rejectTask(
  taskId: string,
  feedback: string | null,
  registry: Registry,
): Promise<SpawnTask> {
  const task = getTask(taskId);
  if (!task || task.status !== "awaiting_approval") {
    throw new NotApprovable(`task ${taskId} is not awaiting approval`);
  }
  const clean = (feedback ?? "").trim();
  if (!clean) {
    transition(taskId, "rejected");
    audit("factory_task", { id: taskId, event: "rejected" });
    return getTask(taskId)!;
  }

  const max = loadConfig().factory.maxRevisions;
  const iterations = task.approvalIterations + 1;
  if (iterations >= max) {
    updateTask(taskId, { revisionFeedback: clean, approvalIterations: iterations, error: `rejected ${max} times` });
    transition(taskId, "failed");
    audit("factory_task", { id: taskId, event: "failed", error: "revision cap" });
    addNotice("factory", `The ${task.nameHint} agent was rejected ${max} times, so I dropped it — start a fresh request if you still want it.`, "quiet");
    return getTask(taskId)!;
  }

  updateTask(taskId, { revisionFeedback: clean, approvalIterations: iterations });
  transition(taskId, "writing_prompt");
  audit("factory_task", { id: taskId, event: "revision", iteration: iterations });
  try {
    await writePromptStage(taskId, registry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateTask(taskId, { error: message });
    try {
      transition(taskId, "failed");
    } catch {
      // stay quiet — the task is already recorded as errored
    }
    audit("factory_task", { id: taskId, event: "failed", error: message });
  }
  return getTask(taskId)!;
}
