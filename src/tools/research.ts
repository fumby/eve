import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { EveTool } from "../core/registry.js";
import { streamTurn } from "../core/provider.js";
import { audit } from "../core/audit.js";
import { loadConfig } from "../core/config.js";
import { emitAgentEvent } from "../core/agent-events.js";
import { guardOutbound } from "../memory/privacy.js";

// Deep research runs as its own focused pass, separate from the conversation:
// its own prompt, its own (larger) search budget, and higher effort. Only the
// finished report comes back into the chat, so a dozen pages of sources never
// crowd out what EVE and Umberto were actually talking about.
//
// "Find the best X" questions (best dermatologist, best laptop, best school)
// get a METHOD, not just thoroughness. The web is full of SEO listicles and
// paid placements that look like rankings; an objective answer has to be
// BUILT: define what best means, gather candidates from independent kinds of
// sources, distrust the listicles, verify the finalists against primary
// sources, and rank on evidence with the reasoning shown. Umberto asked for
// exactly this: "she has to understand what the best depends on, and be
// objective and unbiased". This prompt is that requirement as prose.
export const RESEARCH_PROMPT = `You are a rigorous research assistant. Investigate the
question thoroughly using web search, then write a report for someone who needs
to rely on it.

How to work:
- Search several times from different angles before concluding. Follow up on
  what you find rather than stopping at the first result.
- Prefer primary and authoritative sources. Note when sources disagree.
- Fetch full pages when a snippet is not enough to answer accurately.

When the question is "find the best X" (a person, product, service, place,
school — anything ranked or chosen), do NOT answer by repeating what the first
ranking pages say. Work the method:

1. DEFINE "best" first, before looking at candidates. What does quality in
   this domain actually depend on? Which criteria are measurable or
   verifiable (qualifications, certifications, registries, reviews over time,
   independent testing), and which are matters of taste (state both kinds —
   taste criteria must not silently drive the ranking)? If the ask is
   ambiguous, resolve it from what the reader actually needs, and say how you
   read it.
2. GATHER candidates from INDEPENDENT kinds of sources, not one list:
   official registers and professional bodies, hospitals/employers and their
   own pages, review platforms, specialist forums, news and independent
   testing. The same name appearing in several UNRELATED kinds of sources is
   signal; a name that only ever appears in one SEO listicle is not.
3. DISTRUST the ranking pages. Listicles, "top 10" sites and paid-placement
   directories are LEADS, not evidence — many take money for inclusion.
   Treat their claims as unverified until a primary source confirms them.
4. VERIFY each finalist against primary sources: the official register or
   certifying body, the practice's or manufacturer's own page, the employer's
   site, court/disciplinary/testing records where they exist. A claim you
   could not verify is a caveat, not a finding.
5. RANK with the reasoning visible: for each pick, say which criteria it
   wins on and which it loses on, and cite the source for each substantive
   claim. Disclose conflicts of interest where you can see them (paid
   listings, affiliate links).
6. Name what you could NOT establish — if "best" cannot be settled
   objectively, say so and give the shortlist the reader can settle
   themselves.

How to report:
- Open with a direct answer to the question in two or three sentences.
- Then the supporting detail, organised by what the reader needs to know.
- Attribute every substantive claim to a source, with its URL.
- Say plainly what you could NOT establish, and what remains uncertain or
  disputed. Never fill a gap with a plausible guess.
- Note the date of time-sensitive information.
- Do not pad. A short report that answers the question beats a long one.`;

// The nudge appended to the deep_research tool's RETURN, so the finished
// research actually REACHES Umberto instead of dying in the scrollback:
// the /report window (Mac opens, phone gets the link) and the email offer.
export const DELIVERY_HINT =
  `[DELIVERY: call open_report_window with this report's verdict, ranked picks, evidence and sources — ` +
  `it opens a readable page on his Mac at /report and he gets the link on his phone. ` +
  `Offer to email it too (send_email, gated) if he wants it in his inbox. ` +
  `Then summarise the verdict and the top pick in your own voice; keep the sources — he should be able to check them.]`;

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
      "Research a question thoroughly on the web and come back with a sourced report. Use this when Umberto asks you to research, investigate, compare, or look into something properly — not for a quick fact you could get with a single search, which you can already do on your own. This is THE tool for 'find me the best X' asks — best doctor, best product, best school: it defines what best means in that domain, gathers candidates from independent kinds of sources, distrusts SEO listicles, verifies finalists against primary sources (registers, certifying bodies, official pages), and ranks with visible reasoning. Takes a minute or two and costs real money, so use it for questions that deserve it. Good for: study topics he needs to understand deeply, comparing options, checking what is currently true about a fast-moving subject.",
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
      // The privacy guard: a deep-research question composed from his
      // recalled memories is a leak wearing the clothes of a search — the
      // question goes to web searches and to Claude for synthesis, none of
      // it gated.
      const refused = guardOutbound(String(input.question), "to deep research (web searches + synthesis)");
      if (refused) return refused;
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
        DELIVERY_HINT
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
