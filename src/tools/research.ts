import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { EveTool } from "../core/registry.js";
import { streamTurn } from "../core/provider.js";
import { audit } from "../core/audit.js";
import { loadConfig } from "../core/config.js";
import { emitAgentEvent } from "../core/agent-events.js";

// Deep research runs as its own focused pass, separate from the conversation:
// its own prompt, its own (larger) search budget, and higher effort. Only the
// finished report comes back into the chat, so a dozen pages of sources never
// crowd out what EVE and Umberto were actually talking about.
const RESEARCH_PROMPT = `You are a rigorous research assistant. Investigate the
question thoroughly using web search, then write a report for someone who needs
to rely on it.

How to work:
- Search several times from different angles before concluding. Follow up on
  what you find rather than stopping at the first result.
- Prefer primary and authoritative sources. Note when sources disagree.
- Fetch full pages when a snippet is not enough to answer accurately.

How to report:
- Open with a direct answer to the question in two or three sentences.
- Then the supporting detail, organised by what the reader needs to know.
- Attribute every substantive claim to a source, with its URL.
- Say plainly what you could NOT establish, and what remains uncertain or
  disputed. Never fill a gap with a plausible guess.
- Note the date of time-sensitive information.
- Do not pad. A short report that answers the question beats a long one.`;

const MAX_ROUNDS = 8;

async function research(
  question: string,
  searches: number,
  maxTokens: number,
): Promise<{ report: string; searches: string[] }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const searchesRun: string[] = [];
  let report = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let stopReason: string | null = null;
    let content: Anthropic.ContentBlock[] = [];

    for await (const ev of streamTurn({
      system: RESEARCH_PROMPT,
      messages,
      web: { maxSearches: searches, fetchPages: true },
      effort: "high",
      maxTokens,
    })) {
      if (ev.type === "text") report += ev.delta;
      else if (ev.type === "serverTool") {
        searchesRun.push(ev.query);
        emitAgentEvent({ agent: "research", phase: "working", label: `search: ${ev.query.slice(0, 60)}` });
      }
      else if (ev.type === "done") {
        stopReason = ev.stopReason;
        content = ev.assistantContent;
      }
    }

    messages.push({ role: "assistant", content });
    // pause_turn = the server-side search loop hit its per-request cap;
    // re-sending resumes it. Anything else means the report is finished.
    if (stopReason !== "pause_turn") break;
  }

  return { report: report.trim(), searches: searchesRun };
}

export const researchTools: EveTool[] = [
  {
    name: "deep_research",
    description:
      "Research a question thoroughly on the web and come back with a sourced report. Use this when Umberto asks you to research, investigate, compare, or look into something properly — not for a quick fact you could get with a single search, which you can already do on your own. Takes a minute or two and costs real money, so use it for questions that deserve it. Good for: study topics he needs to understand deeply, comparing options, or checking what is currently true about a fast-moving subject.",
    schema: z.object({
      question: z
        .string()
        .min(8)
        .describe(
          "The research question, self-contained and specific. Include the context that matters (field of study, timeframe, which country) — the researcher cannot see your conversation.",
        ),
      depth: z
        .enum(["standard", "exhaustive"])
        .default("standard")
        .describe(
          "'standard' for most questions (up to ~10 searches). 'exhaustive' only when he explicitly wants everything (~25 searches, slower and costlier).",
        ),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const exhaustive = input.depth === "exhaustive";
      const started = Date.now();
      emitAgentEvent({ agent: "research", phase: "dispatch", label: String(input.question).slice(0, 80) });
      let report: string;
      let searches: string[];
      try {
        ({ report, searches } = await research(
          String(input.question),
          exhaustive ? 25 : 10,
          exhaustive ? 8000 : 4000,
        ));
      } catch (err) {
        emitAgentEvent({ agent: "research", phase: "error", label: String(err).slice(0, 80) });
        throw err;
      }
      audit("deep_research", {
        question: String(input.question),
        depth: String(input.depth),
        searches: searches.length,
        seconds: Math.round((Date.now() - started) / 1000),
      });
      if (!report) {
        emitAgentEvent({ agent: "research", phase: "error", label: "empty report" });
        throw new Error("the research pass came back empty — try rephrasing the question");
      }
      emitAgentEvent({
        agent: "research",
        phase: "done",
        label: `${searches.length} searches · ${Math.round((Date.now() - started) / 1000)}s`,
      });
      return (
        `Research report (${searches.length} searches, ${Math.round((Date.now() - started) / 1000)}s):\n\n${report}\n\n` +
        `[Summarise this for Umberto in your own voice. Keep the sources — he should be able to check them. ` +
        `If he is listening rather than reading, give him the answer and the key points aloud and offer the detail.]`
      );
    },
  },
  {
    name: "research_status",
    description:
      "Report what web access EVE currently has. Use when Umberto asks whether you can search the internet or how research works.",
    schema: z.object({}),
    needsConfirmation: false,
    run: async () => {
      const cfg = loadConfig();
      return (
        `Web access: live search and page-fetching are available in normal conversation ` +
        `(up to 5 searches per turn), plus the deep_research tool for thorough investigation ` +
        `(10 searches standard, 25 exhaustive). Searches run through Anthropic's servers and ` +
        `return real sources with citations. Model: ${cfg.model}. ` +
        `All research activity is logged in logs/audit.jsonl.`
      );
    },
  },
];
