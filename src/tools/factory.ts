// EVE's hands on the Factory. spawn_agent stages a task and runs the pipeline
// in the background (EVE's turn returns at once; a loud notice announces the
// manifest is ready to review). factory_status lets her answer "how's that
// agent coming along?"; approval itself is NOT a tool — it lives on the face
// card and the REPL, in Umberto's hands only.
import { z } from "zod";
import type { EveTool, Registry } from "../core/registry.js";
import { addNotice, osNotification } from "../core/notices.js";
import { audit } from "../core/audit.js";
import { runPipeline, stageTask, CapReached, RefusedInput } from "../factory/pipeline.js";
import { getTask, listTasks, pendingApproval, activeAgents } from "../factory/store.js";
import type { SpawnTask } from "../factory/types.js";

// Strong references to in-flight pipelines: never let one be collected mid-run.
const IN_FLIGHT = new Set<Promise<unknown>>();

export function announceReady(task: SpawnTask): void {
  const m = task.proposedManifest;
  const text =
    `The Factory finished drafting "${m?.name ?? task.nameHint}" (${m?.specialty ?? "new agent"}) — ` +
    `it wants tools: ${m?.tool_allowlist.join(", ") || "none"}. Review and approve it in the face or with /factory in the terminal.`;
  addNotice("factory", text, "loud");
  osNotification(text);
}

export function factoryTools(registry: Registry): EveTool[] {
  return [
    {
      name: "spawn_agent",
      description:
        "Ask the Factory to design a NEW specialist sub-agent: it researches what such an agent should be able to do, drafts its system prompt, picks its tools from the catalog, and stages a manifest for Umberto to approve. Nothing goes live without his approval. Use when Umberto asks for a new kind of helper that no existing tool or agent covers. Runs in the background — tell him you've started it and that he'll get a notice to review.",
      schema: z.object({
        name_hint: z.string().min(2).max(60).describe("A short name for the agent, e.g. 'Doc Summarizer'"),
        role_description: z
          .string()
          .min(15)
          .max(1500)
          .describe("One paragraph: what the agent does and for whom"),
        special_requirements: z
          .string()
          .max(800)
          .optional()
          .describe("Any constraints: tone, language, must/must-not, output format"),
      }),
      needsConfirmation: false,
      factoryAllowed: false,
      run: async (input) => {
        let task: SpawnTask;
        try {
          task = stageTask({
            requestedBy: "umberto",
            nameHint: String(input.name_hint),
            roleDescription: String(input.role_description),
            specialRequirements: input.special_requirements ? String(input.special_requirements) : "",
          });
        } catch (err) {
          if (err instanceof CapReached || err instanceof RefusedInput) return `Not staged: ${err.message}`;
          throw err;
        }
        const p = runPipeline(task.id, registry)
          .then((t) => {
            if (t?.status === "awaiting_approval") announceReady(t);
            else if (t?.status === "failed")
              addNotice("factory", `The Factory couldn't build "${t.nameHint}": ${t.error ?? "unknown error"}`, "quiet");
          })
          .catch((err) => audit("factory_task", { id: task.id, event: "pipeline_crash", error: String(err) }))
          .finally(() => IN_FLIGHT.delete(p));
        IN_FLIGHT.add(p);
        return `Staged spawn task ${task.id} for "${task.nameHint}". The Factory is researching now; Umberto will get a notice when the manifest is ready to approve.`;
      },
    },
    {
      name: "factory_status",
      description:
        "Report on the Factory: tasks in flight or awaiting approval, and the spawned agents currently active. Use when Umberto asks about an agent he requested or what agents exist.",
      schema: z.object({}),
      needsConfirmation: false,
      factoryAllowed: false,
      run: async () => {
        const tasks = listTasks().slice(-10).reverse();
        const pending = pendingApproval();
        const agents = activeAgents();
        const lines = [
          agents.length
            ? `Active spawned agents: ${agents.map((a) => `${a.name} [${a.slug}] — ${a.specialty}`).join("; ")}.`
            : "No spawned agents are active yet.",
          pending.length
            ? `Awaiting Umberto's approval: ${pending.map((t) => `"${t.nameHint}" (task ${t.id})`).join(", ")}.`
            : "Nothing awaiting approval.",
          tasks.length
            ? `Recent tasks: ${tasks.map((t) => `${t.nameHint} → ${t.status}${t.error ? ` (${t.error})` : ""}`).join("; ")}.`
            : "",
        ];
        return lines.filter(Boolean).join("\n");
      },
    },
  ];
}

export { getTask };
