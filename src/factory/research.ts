// Tier 1 of the Factory: the research subagent. Before EVE mints an agent for
// a new domain, something has to establish what such an agent should actually
// be able to do — from evidence, not vibes. This runs a bounded web-research
// loop and forces a structured Skills Report out the far end, so Tier 2 (the
// spec drafter) always starts from real sources and only real tool names.
// Reports are cached by normalized query: a rejected manifest never re-burns
// the search budget.
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { streamTurn, type WebAccess } from "../core/provider.js";
import { emitAgentEvent } from "../core/agent-events.js";
import { audit } from "../core/audit.js";
import { SkillsReportSchema, type ResearchReport, type SkillsReport } from "./types.js";
import { cachedResearch, saveResearch } from "./store.js";

export const EMIT_TOOL = "emit_skills_report";
const DEFAULT_MAX_ITERATIONS = 8;
// Six searches triangulate a domain (vendor docs, an OSS project, a blog or
// two) without wandering; fetching lets the model read a page when a snippet
// is not enough to quote it honestly.
const RESEARCH_WEB: WebAccess = { maxSearches: 6, fetchPages: true };
// A 15-source report with excerpts is a few thousand tokens on its own; the
// conversational default in config.json is sized for spoken replies.
const MAX_TOKENS = 8000;

// The system prompt, kept pure so a test can pin what the model is told
// without a model in the room.
export function buildResearchPrompt(domain: string, catalog: string[]): string {
  const catalogText =
    catalog.length > 0 ? catalog.join(", ") : "(the catalog is empty — leave tools_available empty)";
  return (
    `You are a research specialist. Your job: research what an agent that does ` +
    `"${domain}" should be capable of, and produce a structured Skills Report.\n\n` +
    `Use web_search 3-6 times to gather real evidence from real sources — vendor docs, ` +
    `open-source projects, technical blogs. Fetch a page when a snippet is not enough to ` +
    `quote it accurately. Prefer primary sources; never invent a URL or a quote.\n\n` +
    `End by calling ${EMIT_TOOL} — that call is the deliverable; prose alone does not count. ` +
    `Fill it with:\n` +
    `- domain: one line naming the domain.\n` +
    `- competencies: 4-8 concrete capabilities such an agent needs (verbs, not adjectives).\n` +
    `- tools_available: ONLY names from this catalog, and only the ones this agent would ` +
    `actually use: ${catalogText}. Do not invent names.\n` +
    `- tools_wishlist: tools we do not have that this agent would need — name, purpose, ` +
    `external_dependency (the API/service it would rely on, or empty).\n` +
    `- design_patterns: 2-5 real patterns you observed in the sources (how existing agents ` +
    `or products in this domain are structured).\n` +
    `- sources: 5-15 entries with url, title and an excerpt under 400 characters — short, ` +
    `attributable, taken from the page itself.`
  );
}

// The model invents tool names; only what the registry actually offers may
// reach a manifest. Order is preserved, duplicates collapse.
export function filterToolsAvailable(names: string[], catalog: string[]): string[] {
  const allowed = new Set(catalog);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (!allowed.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// One client tool: the report itself. Its schema is the zod contract from
// types.ts, so what the model is asked for and what we accept never drift.
export function emitSkillsReportTool(): Anthropic.Messages.ToolUnion {
  const schema = z.toJSONSchema(SkillsReportSchema) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: EMIT_TOOL,
    description:
      "Deliver the finished Skills Report. Call this once, after researching, as the final step of the job — the report is what the Factory reads; anything said in prose is discarded.",
    input_schema: schema as Anthropic.Tool.InputSchema,
  };
}

export type StreamFn = typeof streamTurn;

export interface ResearchLoopResult {
  report: SkillsReport;
  searches: number;
  forced: boolean;
  iterations: number;
}

// The loop itself, with the provider injectable so tests can script a model
// without a network. researchDomain wraps it with the cache and the store.
export async function runResearchLoop(
  roleDescription: string,
  catalog: string[],
  maxIterations: number,
  stream: StreamFn = streamTurn,
): Promise<ResearchLoopResult> {
  const system = buildResearchPrompt(roleDescription, catalog);
  const tools = [emitSkillsReportTool()];
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Research this role and deliver the Skills Report: ${roleDescription}` },
  ];
  let searches = 0;
  const rounds = Math.max(1, Math.floor(maxIterations));

  for (let i = 0; i < rounds; i++) {
    const last = i === rounds - 1;
    const pending: { id: string; name: string; input: unknown }[] = [];
    let assistantContent: Anthropic.ContentBlock[] = [];
    let stopReason: string | null = null;

    for await (const ev of stream({
      system,
      messages,
      tools,
      web: RESEARCH_WEB,
      effort: "medium",
      maxTokens: MAX_TOKENS,
      // The final round leaves the model no choice: it must hand in a report.
      ...(last ? { forceTool: EMIT_TOOL } : {}),
    })) {
      if (ev.type === "serverTool") {
        if (ev.name === "web_search") searches++;
        emitAgentEvent({ agent: "factory", phase: "working", label: `research: ${ev.name}` });
      } else if (ev.type === "toolUse") {
        pending.push(ev);
      } else if (ev.type === "done") {
        assistantContent = ev.assistantContent;
        stopReason = ev.stopReason;
        audit("model_turn", { source: "factory:research", ...ev.usage });
      }
    }

    // An empty assistant turn is invalid on the wire; skip it and let the
    // API merge our consecutive user messages.
    if (assistantContent.length > 0) messages.push({ role: "assistant", content: assistantContent });

    // The server-side search loop hit its per-request cap; re-sending
    // resumes it where it left off. Anything else we add derails the search.
    if (stopReason === "pause_turn" && pending.length === 0) continue;

    // Refusals do not improve with retries; stop spending.
    if (stopReason === "refusal") {
      audit("factory_research", { query: roleDescription.slice(0, 120), event: "refused", iteration: i + 1 });
      break;
    }

    if (pending.length === 0) {
      // The model talked instead of delivering. Nudge, don't give up.
      messages.push({
        role: "user",
        content:
          `You have not called ${EMIT_TOOL} yet. If you still need evidence, search once or ` +
          `twice more; then call ${EMIT_TOOL} with the complete report.`,
      });
      continue;
    }

    // Every tool_use gets a tool_result, all in ONE user message — the API
    // rejects a dangling tool_use, and it must directly follow the assistant turn.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of pending) {
      if (t.name !== EMIT_TOOL) {
        results.push({
          type: "tool_result",
          tool_use_id: t.id,
          content: `No tool named "${t.name}" exists here. The only client tool is ${EMIT_TOOL}.`,
          is_error: true,
        });
        continue;
      }
      const parsed = SkillsReportSchema.safeParse(t.input ?? {});
      if (parsed.success) {
        return {
          report: {
            ...parsed.data,
            tools_available: filterToolsAvailable(parsed.data.tools_available, catalog),
          },
          searches,
          forced: last,
          iterations: i + 1,
        };
      }
      // Hand the zod issues straight back: the model fixes its own report.
      const problems = parsed.error.issues
        .map((iss) => `${iss.path.join(".") || "(input)"}: ${iss.message}`)
        .join("; ");
      audit("factory_research", { query: roleDescription.slice(0, 120), event: "report_rejected", problems: problems.slice(0, 400) });
      emitAgentEvent({ agent: "factory", phase: "working", label: "research: report rejected, retrying" });
      results.push({
        type: "tool_result",
        tool_use_id: t.id,
        content: `Report rejected — ${problems}. Fix exactly these and call ${EMIT_TOOL} again.`,
        is_error: true,
      });
    }
    messages.push({ role: "user", content: results });
  }

  throw new Error("research produced no valid report");
}

// Research a role description into a persisted Skills Report. Cache first —
// same normalized query within the TTL returns the stored report and burns
// nothing. Model weirdness (no tool call, invalid report, invented tools) is
// absorbed inside the loop; only exhausting every iteration throws.
export async function researchDomain(
  roleDescription: string,
  opts: { toolCatalog?: string[]; maxIterations?: number } = {},
): Promise<{ report: ResearchReport; cached: boolean }> {
  const catalog = opts.toolCatalog ?? [];
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const hit = cachedResearch(roleDescription);
  if (hit) {
    emitAgentEvent({ agent: "factory", phase: "done", label: "research: cached report" });
    return { report: hit, cached: true };
  }

  const started = Date.now();
  emitAgentEvent({ agent: "factory", phase: "working", label: `research: ${roleDescription.slice(0, 80)}` });
  let result: ResearchLoopResult;
  try {
    result = await runResearchLoop(roleDescription, catalog, maxIterations);
  } catch (err) {
    emitAgentEvent({ agent: "factory", phase: "error", label: `research: ${String(err instanceof Error ? err.message : err).slice(0, 80)}` });
    throw err;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const saved = saveResearch(roleDescription, result.report, {
    searches: result.searches,
    forced: result.forced,
  });
  audit("factory_research", {
    query: saved.query,
    id: saved.id,
    searches: result.searches,
    forced: result.forced,
    iterations: result.iterations,
    sources: saved.report.sources.length,
    seconds,
  });
  emitAgentEvent({
    agent: "factory",
    phase: "done",
    label: `research: ${result.searches} searches · ${saved.report.sources.length} sources · ${seconds}s`,
  });
  return { report: saved, cached: false };
}
