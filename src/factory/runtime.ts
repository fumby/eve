// The ONE runtime every Factory-spawned agent runs on. A spawned agent is a
// row of configuration (prompt, model, tool allowlist) — this file turns that
// row into a tool-use loop and a dispatch tool EVE can call. There are no
// per-agent classes and no per-slug branches anywhere here: if two agents
// behave differently it is because their rows differ, never because the code
// knows their names.
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { streamTurn } from "../core/provider.js";
import { isFactoryAllowed, type EveTool, type Registry } from "../core/registry.js";
import { audit } from "../core/audit.js";
import { emitAgentEvent, type AgentDescriptor } from "../core/agent-events.js";
import { dispatchToolName, type SpawnedAgent } from "./types.js";
import { PROMPT_RAILS } from "./generate.js";

// Fewer rounds than EVE's own loop: a specialist gets a focused job, not a
// conversation, and a runaway chain here costs money on a second model call.
const MAX_TOOL_ROUNDS = 8;
const MAX_TOKENS = 2048;

// Which registered tools this row may actually see. Two conditions, both
// enforced at run time rather than trusted from the row: the tool must be on
// the row's allowlist AND still be something the Factory is allowed to hand
// out (agents.json is hand-editable and a tool's policy can change after the
// agent was spawned). Pure, so it can be tested without a Registry.
export function filterDefinitions(all: EveTool[], allowlist: string[]): EveTool[] {
  const wanted = new Set(allowlist);
  return all.filter((t) => wanted.has(t.name) && isFactoryAllowed(t));
}

// The runtime is the last hop and does not trust the row: name and specialty
// come from user text and web-shaped research, and the dispatch tool's
// description is copied into EVE's OWN system prompt every turn. One line,
// capped — never a vehicle for a smuggled paragraph.
const oneLine = (s: string, max: number): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
export const safeName = (row: SpawnedAgent): string => oneLine(row.name, 60) || row.slug;
export const safeSpecialty = (row: SpawnedAgent): string => oneLine(row.specialty, 120);

// The face has never heard of a spawned agent, so every event carries enough
// for it to appear in the constellation on first sight.
function describe(row: SpawnedAgent): AgentDescriptor {
  const name = safeName(row);
  return {
    id: row.slug,
    name,
    specialty: safeSpecialty(row),
    initial: (name.charAt(0) || row.slug.charAt(0)).toUpperCase(),
  };
}

// The rails are code-owned at write time; make them code-owned at RUN time
// too, so a hand-edited or legacy row can't run without them.
function withRails(systemPrompt: string): string {
  return systemPrompt.trimEnd().endsWith(PROMPT_RAILS)
    ? systemPrompt
    : `${systemPrompt.trimEnd()}\n\n${PROMPT_RAILS}`;
}

// Injected in tests so the loop can be exercised against a scripted stream;
// production always uses the real provider seam.
export type StreamFn = typeof streamTurn;

export class ConfigDrivenAgent {
  constructor(
    private row: SpawnedAgent,
    private registry: Registry,
    private stream: StreamFn = streamTurn,
  ) {}

  async run(message: string, opts: { onText?: (delta: string) => void } = {}): Promise<string> {
    const { row } = this;
    const descriptor = describe(row);
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 1000);

    // Resolved once per run, not per round: a watcher tick mid-run must not
    // change what this agent can see halfway through its own work.
    const granted = new Set(filterDefinitions(this.registry.all(), row.tool_allowlist).map((t) => t.name));
    const tools = this.registry
      .definitions()
      .filter((d) => granted.has((d as { name: string }).name));

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: message }];
    let fullText = "";

    emitAgentEvent({ agent: row.slug, phase: "dispatch", label: message.slice(0, 80), descriptor });
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const pending: { id: string; name: string; input: unknown }[] = [];
        let assistantContent: Anthropic.ContentBlock[] = [];
        let stopReason: string | null = null;

        for await (const ev of this.stream({
          system: withRails(row.system_prompt),
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          effort: "medium",
          maxTokens: MAX_TOKENS,
          model: row.model,
        })) {
          if (ev.type === "text") {
            fullText += ev.delta;
            opts.onText?.(ev.delta);
          } else if (ev.type === "toolUse") {
            pending.push(ev);
          } else if (ev.type === "done") {
            assistantContent = ev.assistantContent;
            stopReason = ev.stopReason;
            audit("model_turn", { source: `spawned:${row.slug}`, ...ev.usage });
          }
        }
        messages.push({ role: "assistant", content: assistantContent });

        if (stopReason !== "tool_use" || pending.length === 0) {
          emitAgentEvent({
            agent: row.slug,
            phase: "done",
            label: `${round + 1} round${round === 0 ? "" : "s"} · ${seconds()}s`,
            descriptor,
          });
          return fullText.trim() || `(${row.name} returned no text)`;
        }

        // Every requested tool runs; all results go back in ONE user message.
        // The allowlist is re-checked per call — the model was only shown
        // granted tools, but a name it invents or remembers from elsewhere
        // must still bounce off the same wall.
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const t of pending) {
          emitAgentEvent({ agent: row.slug, phase: "working", label: `tool: ${t.name}`, descriptor });
          const result = granted.has(t.name)
            ? await this.registry.execute(t.name, t.input)
            : { content: `${t.name}: tool not granted to this agent`, isError: true };
          results.push({
            type: "tool_result",
            tool_use_id: t.id,
            content: result.content,
            is_error: result.isError,
          });
        }
        messages.push({ role: "user", content: results });
      }
      emitAgentEvent({
        agent: row.slug,
        phase: "done",
        label: `stopped at ${MAX_TOOL_ROUNDS} tool rounds · ${seconds()}s`,
        descriptor,
      });
      return (
        (fullText.trim() ? fullText.trim() + "\n\n" : "") +
        `[${row.name} stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls without a final answer.]`
      );
    } catch (err) {
      emitAgentEvent({ agent: row.slug, phase: "error", label: String(err).slice(0, 80), descriptor });
      throw err;
    }
  }
}

// The tool EVE sees for a spawned agent. factoryAllowed is false on purpose:
// the org stays flat — EVE delegates to specialists, specialists never
// delegate to each other.
export function buildDispatchTool(row: SpawnedAgent, registry: Registry): EveTool {
  // Advertise exactly what the runtime will honour: the allowlist AS FILTERED
  // by factory policy, so EVE is never told the specialist has a tool that
  // would be refused at run time.
  const granted = filterDefinitions(registry.all(), row.tool_allowlist).map((t) => t.name);
  const grantedNames = granted.length > 0 ? granted.join(", ") : "none";
  return {
    name: dispatchToolName(row.slug),
    description:
      `Delegate to ${safeName(row)} (${safeSpecialty(row)}): a specialist agent Umberto had the Factory spawn. ` +
      `Use it when a request falls squarely inside that specialty and a focused pass would serve him better than you improvising — ` +
      `it runs its own model call with its own prompt and comes back with a written answer you then relay in your own voice. ` +
      `It cannot see this conversation, so put everything it needs in the message (context, constraints, what a good answer looks like). ` +
      `Its tools: ${grantedNames}. It cannot delegate further.`,
    schema: z.object({
      message: z
        .string()
        .min(1)
        .describe("The self-contained brief for the specialist: the task, the relevant context, and what to come back with."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => new ConfigDrivenAgent(row, registry).run(String(input.message)),
  };
}
