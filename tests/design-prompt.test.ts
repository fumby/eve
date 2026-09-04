// The composer prompt is the contract Claude Code builds against: it must
// name the files to read, the required visual elements, the forbidden moves,
// every generated image URL verbatim, the exact output path and the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildComposerPrompt, composerPaths } from "../src/design/prompt.js";
import { buildRepairPrompt } from "../src/design/dispatch.js";
import type { DesignTokens } from "../src/design/types.js";

const tokens: DesignTokens = {
  fonts: { display: "Instrument Serif", body: "Inter Tight", mono: "JetBrains Mono" },
  colors: { background: "#07090c", foreground: "#e8ecef", accent: "#2dd4a8", muted: "#11161c", border: "#1c232b" },
  radius: "0.5rem",
  mode: "dark",
  shadcn: { baseColor: "zinc", style: "new-york" },
};

const input = {
  projectSlug: "eve",
  projectRoot: "/tmp/eve-design",
  featureSlug: "landing",
  screenName: "hero",
  description: "The hero for EVE's landing page.",
  visualDirection: "GridPattern at opacity-50, Particles, ConversationSurface with TypingAnimation, BorderBeam on CTA hover.",
  quality: "standard" as const,
  tokens,
  components: ["grid-pattern", "particles", "border-beam", "button"],
  images: [
    { result: { url: "/api/eve/preview/assets/landing/backdrop.png", path: "/x/backdrop.png", model: "m", costUsd: 0.04 }, alt: "atmospheric backdrop" },
    { result: { url: "/api/eve/preview/assets/landing/render.png", path: "/x/render.png", model: "m", costUsd: 0.04 }, alt: "product render" },
  ],
  referenceImages: ["/tmp/eve-design/.prism/references/landing/ref-1.png"],
  forbiddenMoves: ["no violet/cyan cyberpunk defaults"],
  standingDecisions: ["one accent used precisely"],
  installed: false,
  installCommands: ["npx shadcn@latest add button", 'npx shadcn@latest add "https://magicui.design/r/grid-pattern.json"'],
};

test("composerPaths derive page/out paths under .prism/preview", () => {
  const p = composerPaths(input);
  assert.equal(p.pageRel, ".prism/preview/app/landing/hero/page.tsx");
  assert.equal(p.outRel, ".prism/preview/out/landing/hero/index.html");
  assert.match(p.page, /^\/tmp\/eve-design\/\.prism\/preview\/app\/landing\/hero\/page\.tsx$/);
});

test("the composer prompt carries every non-negotiable section", () => {
  const s = buildComposerPrompt(input);
  // read-first list, in order
  const iDesign = s.indexOf("/tmp/eve-design/design.md");
  const iBrief = s.indexOf("/tmp/eve-design/.prism/brief.md");
  const iFeature = s.indexOf("/tmp/eve-design/features/landing.md");
  assert.ok(iDesign > 0 && iBrief > iDesign && iFeature > iBrief);
  // references read first with vision
  assert.match(s, /READ THESE FIRST/);
  assert.match(s, /ref-1\.png/);
  // brief is law + forbidden moves
  assert.match(s, /THE BRIEF IS LAW/);
  assert.match(s, /no violet\/cyan cyberpunk defaults/);
  assert.match(s, /Space Grotesk/);
  // required visual elements
  assert.match(s, /opacity ≥ 0\.4/);
  assert.match(s, /product surface/i);
  assert.match(s, /at least two things running/);
  assert.match(s, /hover states on at least three/i);
  assert.match(s, /mono marginalia/i);
  assert.match(s, /text-\[96px\]/);
  // images verbatim, both of them, with the basePath rule
  assert.match(s, /\/api\/eve\/preview\/assets\/landing\/backdrop\.png/);
  assert.match(s, /\/api\/eve\/preview\/assets\/landing\/render\.png/);
  assert.match(s, /NOT auto-prefixed/);
  assert.match(s, /Never drop one silently/);
  // components + install commands + the installed≠used rule
  assert.match(s, /npx shadcn@latest add button/);
  assert.match(s, /magicui\.design\/r\/grid-pattern\.json/);
  assert.match(s, /installed component that never appears in the page TSX is a bug/);
  // steps: npm install on first dispatch, page path, build, DONE line
  assert.match(s, /run `npm install`/);
  assert.match(s, /\.prism\/preview\/app\/landing\/hero\/page\.tsx/);
  assert.match(s, /"use client"/);
  assert.match(s, /npm run build/);
  assert.match(s, /DONE: \.prism\/preview\/out\/landing\/hero\/index\.html/);
  assert.match(s, /\/api\/eve\/preview\/landing\/hero\//);
  assert.ok(s.length > 4000 && s.length < 12000, `prompt is ${s.length} chars`);
});

test("installed projects skip npm install; premium adds the extra bar", () => {
  const s = buildComposerPrompt({ ...input, installed: true, quality: "premium", images: [], referenceImages: [] });
  assert.match(s, /do NOT run npm install again/);
  assert.match(s, /Premium tier/);
  assert.doesNotMatch(s, /READ THESE FIRST/);
  assert.doesNotMatch(s, /Generated imagery/);
});

test("the repair prompt names the failing checks and the image URLs", () => {
  const s = buildRepairPrompt({
    pageRel: ".prism/preview/app/landing/hero/page.tsx",
    outRel: ".prism/preview/out/landing/hero/index.html",
    built: true,
    auditText: "✗ background: none\n✓ hover-states: 4",
    imageUrls: ["/api/eve/preview/assets/landing/backdrop.png"],
  });
  assert.match(s, /ONE repair pass/);
  assert.match(s, /✗ background: none/);
  assert.match(s, /backdrop\.png/);
  assert.match(s, /DONE: \.prism\/preview\/out\/landing\/hero\/index\.html/);
  const notBuilt = buildRepairPrompt({ pageRel: "p", outRel: "o", built: false, auditText: "", imageUrls: [] });
  assert.match(notBuilt, /does NOT exist/);
});
