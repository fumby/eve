// perplexity_search: fast, cited web answers via Perplexity's Sonar API.
// Complements deep_research (Anthropic's own web search, thorough, slow,
// multi-round) with a single quick round-trip for "what's the current X"
// questions — one HTTP call, an answer, and a source list.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { requireKey } from "../core/config.js";
import { audit } from "../core/audit.js";

const ENDPOINT = "https://api.perplexity.ai/chat/completions";

interface PerplexityResponse {
  choices: { message: { content: string } }[];
  citations?: string[];
  search_results?: { title: string; url: string }[];
}

async function ask(question: string, model: string): Promise<{ answer: string; sources: string[] }> {
  const key = requireKey("PERPLEXITY_API_KEY");
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: question }],
      }),
    });
  } catch (err) {
    throw new Error(`Perplexity is unreachable right now (${String(err)})`);
  }

  if (!res.ok) {
    if (res.status === 401) throw new Error("Perplexity rejected the API key — check PERPLEXITY_API_KEY in .env");
    if (res.status === 429) throw new Error("Perplexity rate-limited this request — try again shortly");
    const body = await res.text().catch(() => "");
    throw new Error(`Perplexity request failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
  }

  const json = (await res.json()) as PerplexityResponse;
  const answer = json.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("Perplexity returned an empty answer");
  const sources =
    json.citations ?? json.search_results?.map((r) => r.url) ?? [];
  return { answer, sources };
}

export const perplexityTools: EveTool[] = [
  {
    name: "perplexity_search",
    description:
      "Ask a question and get a fast, sourced answer from Perplexity's web-search model. Use this for quick current-events or fact questions where you'd otherwise guess or need a single search — cheaper and faster than deep_research, which is for thorough multi-source investigation instead. Not for anything requiring Umberto's private data (use query_ledger, recall_memories, etc. for that).",
    schema: z.object({
      question: z
        .string()
        .min(4)
        .describe("The question, self-contained — Perplexity cannot see your conversation."),
      depth: z
        .enum(["quick", "thorough"])
        .default("quick")
        .describe("'quick' uses the fast sonar model; 'thorough' uses sonar-pro for harder questions."),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const question = String(input.question);
      const model = input.depth === "thorough" ? "sonar-pro" : "sonar";
      const started = Date.now();
      const { answer, sources } = await ask(question, model);
      audit("perplexity_search", {
        question,
        model,
        sources: sources.length,
        ms: Date.now() - started,
      });
      const sourceLines = sources.length ? `\n\nSources:\n${sources.map((s) => `- ${s}`).join("\n")}` : "";
      return `${answer}${sourceLines}`;
    },
  },
];
