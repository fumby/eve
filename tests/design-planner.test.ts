// The planner: prompts carry the non-negotiable sections, plans validate and
// normalise (fixed slugs win, unknown components dropped, a background is
// always present, images dropped when generation is off), and the run loop
// retries once on an invalid plan — all with an injected fake model stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalisePlan, plannerSystemPrompt, plannerUserMessage, runPlanner, type PlannerInput } from "../src/design/planner.js";
import type { DesignTokens } from "../src/design/types.js";

const tokens: DesignTokens = {
  fonts: { display: "Instrument Serif", body: "Inter Tight", mono: "JetBrains Mono" },
  colors: { background: "#07090c", foreground: "#e8ecef", accent: "#2dd4a8", muted: "#11161c", border: "#1c232b" },
  radius: "0.5rem",
  mode: "dark",
  shadcn: { baseColor: "zinc", style: "new-york" },
};

const base: PlannerInput = {
  projectSlug: "eve",
  request: "Design the landing hero for EVE — editorial, show the voice loop",
  designMd: "# EVE — Design System\n```yaml tokens\n```\n## Type\nbig",
  briefMd: "# brief\n### Forbidden moves\n- no violet/cyan cyberpunk defaults\n- no hero without a product surface",
  featureMd: null,
  tokens,
  imagesAvailable: false,
  referenceImages: [],
  budgetUsd: 10,
};

const validPlan = {
  proceed: true,
  briefConflict: null,
  featureSlug: "landing",
  screenName: "hero",
  featureTitle: "Landing",
  featureIntent: "First screen anyone sees",
  description: "The hero for EVE's landing page: wordmark, one line of promise, the voice loop as a live surface.",
  visualDirection:
    "GridPattern at opacity-50 layered with drifting accent Particles, a ConversationSurface with TypingAnimation on the latest line, a breathing status pulse with LISTENING · 287ms label, BorderBeam on CTA hover.",
  quality: "standard",
  components: ["grid-pattern", "particles", "border-beam", "typing-animation", "button", "not-a-real-component"],
  images: [{ slug: "backdrop", alt: "atmospheric backdrop", prompt: "near-black with a teal glow, no violet, no cyan, editorial", quality: "standard", aspect: "16:9" }],
  standingDecisions: ["one accent used precisely"],
  forbiddenMoves: ["no violet/cyan cyberpunk defaults"],
  openQuestions: [],
  summary: "A landing hero with the voice loop as the product surface.",
};

test("system prompt carries BRIEF IS LAW, the visual requirements, catalog and the JSON shape", () => {
  const s = plannerSystemPrompt(base);
  assert.match(s, /THE BRIEF IS LAW/);
  assert.match(s, /opacity ≥ 0\.4/);
  assert.match(s, /product surface/);
  assert.match(s, /npx shadcn@latest add/);
  assert.match(s, /"proceed": true\|false/);
  assert.match(s, /images must be \[\]/);
  const withImages = plannerSystemPrompt({ ...base, imagesAvailable: true });
  assert.match(withImages, /NO violet, NO cyan/);
  const fixed = plannerSystemPrompt({ ...base, featureSlug: "landing", screenName: "hero" });
  assert.match(fixed, /featureSlug is fixed: landing/);
});

test("user message includes the request, both docs and the token summary", () => {
  const u = plannerUserMessage(base);
  assert.match(u, /Design the landing hero/);
  assert.match(u, /# design\.md/);
  assert.match(u, /# \.prism\/brief\.md/);
  assert.match(u, /Instrument Serif|#2dd4a8/);
});

test("normalisePlan drops unknown components, keeps a background, honours fixed slugs and image availability", () => {
  const { plan, notes } = normalisePlan(validPlan, { ...base, featureSlug: "welcome", screenName: "top" });
  assert.equal(plan.featureSlug, "welcome");
  assert.equal(plan.screenName, "top");
  assert.ok(!plan.components.includes("not-a-real-component"));
  assert.ok(plan.components.includes("grid-pattern"));
  assert.deepEqual(plan.images, []); // imagesAvailable false
  assert.ok(notes.some((n) => /unknown component/.test(n)));
  assert.ok(notes.some((n) => /images dropped/.test(n)));

  const noBg = normalisePlan({ ...validPlan, components: ["button", "card"] }, base);
  assert.equal(noBg.plan.components[0], "grid-pattern");

  const withImages = normalisePlan(validPlan, { ...base, imagesAvailable: true });
  assert.equal(withImages.plan.images.length, 1);
});

test("normalisePlan rejects bad slugs and short directions", () => {
  assert.throws(() => normalisePlan({ ...validPlan, featureSlug: "Landing Page" }, base));
  assert.throws(() => normalisePlan({ ...validPlan, visualDirection: "premium hero" }, base));
});

function fakeStream(replies: string[]) {
  let i = 0;
  return async function* (_opts: unknown) {
    const text = replies[Math.min(i, replies.length - 1)]!;
    i++;
    yield { type: "text" as const, delta: text };
    yield {
      type: "done" as const,
      stopReason: "end_turn",
      assistantContent: [],
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
}

test("runPlanner parses a fenced JSON plan and meters cost from usage", async () => {
  const stream = fakeStream(["Here you go:\n```json\n" + JSON.stringify(validPlan) + "\n```"]);
  const r = await runPlanner(base, { stream: stream as never, model: "fake" });
  assert.equal(r.plan.featureSlug, "landing");
  assert.ok(r.costUsd > 0 && r.costUsd < 0.05, `cost ${r.costUsd}`);
});

test("runPlanner retries once on an invalid plan, then gives up in prose", async () => {
  const good = fakeStream(["not json at all", JSON.stringify(validPlan)]);
  const r = await runPlanner(base, { stream: good as never, model: "fake" });
  assert.equal(r.plan.screenName, "hero");

  const bad = fakeStream(["nope", "still nope"]);
  await assert.rejects(() => runPlanner(base, { stream: bad as never, model: "fake" }), /could not produce a valid plan/);
});

test("a brief conflict comes back as proceed:false with the clash, not silently overridden", () => {
  const { plan } = normalisePlan({ ...validPlan, proceed: false, briefConflict: "request asks for sci-fi; brief forbids sci-fi", openQuestions: ["Keep the editorial direction?"] }, base);
  assert.equal(plan.proceed, false);
  assert.match(plan.briefConflict ?? "", /sci-fi/);
  assert.equal(plan.openQuestions.length, 1);
});
