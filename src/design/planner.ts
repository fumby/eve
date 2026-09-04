// The planner: one Sonnet-class call that reads the three docs and the
// request and returns a validated plan — slugs, a SPECIFIC visual direction,
// components to install, image briefs, the brief's standing decisions and
// forbidden moves lifted verbatim, and open questions. It never composes;
// dispatch.ts executes the plan deterministically (images → composer →
// audit). "The brief is law" lives here: a request that conflicts with a
// standing decision comes back as proceed:false + the conflict, and EVE asks.
import { z } from "zod";
import { streamTurn } from "../core/provider.js";
import { loadConfig } from "../core/config.js";
import { renderCatalogForPrompt, findComponent, MAGICUI_BACKGROUNDS } from "./catalog.js";
import { renderFontsForPrompt } from "./fonts.js";
import { tokensToPromptSummary } from "./tokens.js";
import { SLUG_RE, type DesignTokens, type ImageAspect, type ImageQuality } from "./types.js";

export const PlanSchema = z.object({
  proceed: z.boolean(),
  // When proceed is false: what in the brief the request collides with.
  briefConflict: z.string().nullable().default(null),
  featureSlug: z.string().regex(SLUG_RE),
  screenName: z.string().regex(SLUG_RE),
  featureTitle: z.string().min(2),
  featureIntent: z.string().min(2),
  description: z.string().min(20),
  visualDirection: z.string().min(40),
  quality: z.enum(["standard", "premium"]).default("standard"),
  components: z.array(z.string()).min(1),
  images: z
    .array(
      z.object({
        slug: z.string().regex(SLUG_RE),
        alt: z.string().min(3),
        prompt: z.string().min(20),
        quality: z.enum(["standard", "premium"]).default("standard"),
        aspect: z.enum(["16:9", "1:1", "4:3", "3:2", "9:16"]).default("16:9"),
      }),
    )
    .max(3)
    .default([]),
  standingDecisions: z.array(z.string()).default([]),
  forbiddenMoves: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  summary: z.string().min(5),
});
export type Plan = z.infer<typeof PlanSchema>;

export interface PlannerInput {
  projectSlug: string;
  request: string;
  featureSlug?: string;
  screenName?: string;
  quality?: ImageQuality;
  designMd: string;
  briefMd: string;
  featureMd: string | null;
  tokens: DesignTokens;
  imagesAvailable: boolean;
  referenceImages: string[];
  budgetUsd: number;
}

export interface PlannerResult {
  plan: Plan;
  costUsd: number;
  raw: string;
}

export function plannerSystemPrompt(input: PlannerInput): string {
  return `You are the head-of-design planner for "${input.projectSlug}". You turn a request into ONE precise plan for a single screen. You do not write code. Output JSON only.

# THE BRIEF IS LAW
.prism/brief.md holds standing design decisions and explicit forbidden moves. When the request conflicts with the brief, the BRIEF WINS: set proceed=false, put the exact clash in briefConflict, list what to ask in openQuestions, and still fill the other fields with your best brief-compliant alternative. Never silently override the brief because of the request's wording ("make it sci-fi" does not cancel "no sci-fi"). Errata (if present) beat the body.

# What award-quality means here — visual elements are REQUIRED, present, continuous
Every hero/screen must contain ALL of: (1) ambient background texture, VISIBLE at opacity ≥ 0.4, from ${MAGICUI_BACKGROUNDS.join(", ")} — layering two is good; (2) an inline product surface composed in TSX showing what the product does (conversation excerpt with animated typing, voice waveform, command palette, status readout, terminal, code annotation) — a hero without one is incomplete; (3) continuous motion, ≥ 2 things always running (breathing pulse, scanline drift, number tickers, oscillating waveform, blinking caret, marquee, orbiting circles); (4) hover states on ≥ 3 elements; (5) ≥ 3 mono marginalia annotations at 14–16px; (6) a massive editorial wordmark at display scale. One accent used precisely; no violet/cyan cyberpunk defaults; no forbidden fonts.
Rule of thumb: if a viewer looking for 3 seconds can't tell anything moves, the page failed.

# visualDirection must name SPECIFICS, not adjectives
Bad: "premium cyberpunk hero". Good: "GridPattern at opacity-50 layered with drifting accent Particles (quantity 60), a ConversationSurface in mono with TypingAnimation on the latest line, a breathing accent status pulse with 'LISTENING · 287ms' mono label, BlurFade entry on the wordmark, BorderBeam on CTA hover, hover-reveal tooltips on three mono marginalia annotations, wordmark 'EVE' at text-[128px] tracking-tight leading-[0.9] in font-display". Name components by their catalog names, opacities by class, sizes by class.

# Components
Choose ONLY from the catalog below by exact name. Always include at least one background from the list above and at least one motion component (border-beam, number-ticker, typing-animation, marquee, particles…). Include the shadcn primitives the screen needs (button, card, badge, tooltip…).
${renderCatalogForPrompt()}

# Fonts (already fixed by design.md — do not change them; listed so you can describe type)
${renderFontsForPrompt()}

# Images
${
  input.imagesAvailable
    ? "Image generation IS available (Gemini). Plan 1–2 images max only when they add what TSX can't: an atmospheric backdrop, a product render, a conceptual illustration. Each prompt MUST repeat the palette (name the background and accent hex, say 'NO violet, NO cyan') and the mood; no text, no UI chrome, no people unless the brief wants them. Give a slug (kebab-case), alt text, aspect."
    : "Image generation is NOT available right now — images must be []. Compose everything in TSX (patterns, particles, surfaces)."
}

# Slugs
featureSlug and screenName are kebab-case. Reuse the given ones if provided${input.featureSlug ? ` (featureSlug is fixed: ${input.featureSlug})` : ""}${input.screenName ? ` (screenName is fixed: ${input.screenName})` : ""}. Reference images (if any) live under .prism/references/<featureSlug>/ — the slug you pick decides whether they are found.

# Budget
This dispatch may spend at most $${input.budgetUsd.toFixed(2)} in total (planner + images + Claude Code composer). Prefer standard quality unless the request says premium.

# Output — JSON only, exactly this shape
{"proceed": true|false, "briefConflict": null|"...", "featureSlug": "...", "screenName": "...", "featureTitle": "...", "featureIntent": "...", "description": "what this screen is and what it must communicate (2–4 sentences)", "visualDirection": "specific, as above (5–10 sentences)", "quality": "standard"|"premium", "components": ["grid-pattern", "particles", "border-beam", "button", "card", ...], "images": [{"slug": "...", "alt": "...", "prompt": "...", "quality": "standard", "aspect": "16:9"}], "standingDecisions": ["verbatim lines from the brief that shape this screen"], "forbiddenMoves": ["verbatim forbidden moves from the brief"], "openQuestions": ["only real ones"], "summary": "one sentence EVE can say aloud"}`;
}

export function plannerUserMessage(input: PlannerInput): string {
  return `# Request from Umberto
${input.request.trim()}
${input.quality ? `\nRequested quality: ${input.quality}` : ""}
${input.referenceImages.length > 0 ? `\nReference images available (${input.referenceImages.length}): ${input.referenceImages.map((r) => r.split("/").pop()).join(", ")}` : ""}

# design.md
${input.designMd.trim()}

# .prism/brief.md
${input.briefMd.trim()}

# features/${input.featureSlug ?? "<new>"}.md
${input.featureMd?.trim() ?? "(no feature doc yet — propose featureTitle and featureIntent)"}

# Tokens (parsed)
${tokensToPromptSummary(input.tokens)}

Return the JSON plan now.`;
}

function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("planner returned no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

// Validates a parsed plan and normalises what the schema can't: unknown
// component names are dropped with a note; a background is added if missing;
// fixed slugs win over the model's choice.
export function normalisePlan(raw: unknown, input: PlannerInput): { plan: Plan; notes: string[] } {
  const notes: string[] = [];
  const parsed = PlanSchema.parse(raw);
  const known: string[] = [];
  for (const c of parsed.components) {
    if (findComponent(c)) known.push(c);
    else notes.push(`dropped unknown component "${c}"`);
  }
  if (!known.some((c) => (MAGICUI_BACKGROUNDS as readonly string[]).includes(c))) {
    known.unshift("grid-pattern");
    notes.push("added grid-pattern (no ambient background was planned)");
  }
  const plan: Plan = {
    ...parsed,
    components: [...new Set(known)],
    featureSlug: input.featureSlug ?? parsed.featureSlug,
    screenName: input.screenName ?? parsed.screenName,
    quality: input.quality ?? parsed.quality,
    images: input.imagesAvailable ? parsed.images : [],
  };
  if (!input.imagesAvailable && parsed.images.length > 0) notes.push("images dropped: generation unavailable");
  return { plan, notes };
}

export async function runPlanner(
  input: PlannerInput,
  deps: { model?: string; stream?: typeof streamTurn } = {},
): Promise<PlannerResult & { notes: string[] }> {
  const cfg = loadConfig();
  const model = deps.model ?? cfg.design.plannerModel;
  const stream = deps.stream ?? streamTurn;
  const price = cfg.pricing;
  const system = plannerSystemPrompt(input);
  let messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: plannerUserMessage(input) },
  ];
  let costUsd = 0;
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = "";
    for await (const ev of stream({ system, messages, model, effort: "medium", maxTokens: 3500 })) {
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "done") {
        costUsd += (ev.usage.inputTokens / 1e6) * price.inputPerMTok + (ev.usage.outputTokens / 1e6) * price.outputPerMTok;
      }
    }
    try {
      const { plan, notes } = normalisePlan(extractJson(text), input);
      return { plan, costUsd, raw: text, notes };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      messages = [
        ...messages,
        { role: "assistant", content: text },
        { role: "user", content: `That plan did not validate: ${lastErr.slice(0, 600)}. Return the corrected JSON only.` },
      ];
    }
  }
  throw new Error(`the design planner could not produce a valid plan: ${lastErr}`);
}

export type { ImageAspect };
