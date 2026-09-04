// The component catalog EVE's head-of-design hands to Claude Code: what can be
// installed into the per-project preview app, how, and what visual job each
// piece does. Everything here is pure data + string builders — no I/O, so it
// can be embedded in a system prompt or written to a reference file by whoever
// owns that step.
//
// Three libraries: shadcn/ui primitives (the skeleton of any screen), MagicUI
// (the pieces that make a hero feel alive: backdrops, text effects, motion,
// device frames) and `motion` for hand-rolled animation when neither covers it.
import type { CatalogEntry } from "./types.js";

// ── shadcn/ui ───────────────────────────────────────────────────────────────
// Only components `npx shadcn@latest add <name>` actually knows about — a
// misspelled name here becomes a failed install mid-compose, so the list is
// the registry's, not a wish list.
const SHADCN: ReadonlyArray<readonly [name: string, useFor: string]> = [
  ["accordion", "collapsible FAQ / spec sections"],
  ["alert", "inline callout with icon and title"],
  ["alert-dialog", "blocking confirm for destructive actions"],
  ["aspect-ratio", "fixed-ratio media boxes"],
  ["avatar", "user / team image with fallback initials"],
  ["badge", "small status or category pill"],
  ["breadcrumb", "path trail navigation"],
  ["button", "primary / secondary / ghost actions"],
  ["calendar", "date picker grid (react-day-picker)"],
  ["card", "the default content surface: header, body, footer"],
  ["carousel", "swipeable slides (embla)"],
  ["chart", "recharts wrappers themed to the design tokens"],
  ["checkbox", "boolean form input"],
  ["collapsible", "show/hide a region with a trigger"],
  ["command", "command palette / cmd-k search (cmdk)"],
  ["context-menu", "right-click menu"],
  ["dialog", "modal window"],
  ["drawer", "bottom sheet on mobile (vaul)"],
  ["dropdown-menu", "click-triggered menu of actions"],
  ["form", "react-hook-form + zod field wiring with labels and errors"],
  ["hover-card", "rich preview on hover"],
  ["input", "single-line text field"],
  ["input-otp", "one-time-code segmented input"],
  ["label", "accessible form label"],
  ["menubar", "desktop-app style menu bar"],
  ["navigation-menu", "top nav with flyout panels"],
  ["pagination", "page number controls"],
  ["popover", "small floating panel anchored to a trigger"],
  ["progress", "determinate progress bar"],
  ["radio-group", "single-choice options"],
  ["resizable", "draggable split panes"],
  ["scroll-area", "styled scroll container"],
  ["select", "dropdown single select"],
  ["separator", "horizontal / vertical rule"],
  ["sheet", "side panel that slides in"],
  ["sidebar", "app shell sidebar with collapsible sections"],
  ["skeleton", "loading placeholder blocks"],
  ["slider", "range input"],
  ["sonner", "toast notifications"],
  ["switch", "on/off toggle"],
  ["table", "data table primitives"],
  ["tabs", "tabbed panels"],
  ["textarea", "multi-line text field"],
  ["toggle", "pressed / unpressed button"],
  ["toggle-group", "exclusive or multi toggle set"],
  ["tooltip", "short hover hint"],
];

export const SHADCN_COMPONENTS: CatalogEntry[] = SHADCN.map(([name, useFor]) => ({
  name,
  library: "shadcn",
  useFor,
  install: `npx shadcn@latest add ${name}`,
  importPath: `@/components/ui/${name}`,
  docs: `https://ui.shadcn.com/docs/components/${name}`,
}));

// ── MagicUI ─────────────────────────────────────────────────────────────────
// MagicUI publishes into the shadcn registry, so the install is the same CLI
// pointed at a JSON URL. Each entry carries the visual *job* it does — that is
// how the prompt groups them, and it is the field the composer actually reads
// when picking pieces for a hero.
type MagicJob = "backgrounds" | "text effects" | "motion" | "surfaces & frames" | "buttons";

const MAGIC_JOB_ORDER: readonly MagicJob[] = [
  "backgrounds",
  "text effects",
  "motion",
  "surfaces & frames",
  "buttons",
];

const MAGIC_JOB_HINT: Record<MagicJob, string> = {
  backgrounds: "ambient texture behind the hero, layer 1–2 of them",
  "text effects": "headline / metric treatment",
  motion: "continuous movement that keeps the page alive",
  "surfaces & frames": "product-surface frames and showcase panels",
  buttons: "CTAs that draw the eye",
};

const MAGIC: ReadonlyArray<readonly [name: string, job: MagicJob, useFor: string]> = [
  // backgrounds
  ["grid-pattern", "backgrounds", "hero backdrop: static SVG grid, mask it radially"],
  ["animated-grid-pattern", "backgrounds", "hero backdrop: grid whose cells fade in and out"],
  ["dot-pattern", "backgrounds", "hero backdrop: dot lattice, quieter than a grid"],
  ["flickering-grid", "backgrounds", "hero backdrop: canvas grid of flickering squares"],
  ["retro-grid", "backgrounds", "hero backdrop: perspective floor grid, synthwave feel"],
  ["particles", "backgrounds", "hero backdrop: drifting particles that react to the cursor"],
  ["meteors", "backgrounds", "hero backdrop: streaking meteor trails, continuous motion"],
  ["ripple", "backgrounds", "hero backdrop: concentric pulsing rings behind a focal element"],
  ["warp-background", "backgrounds", "hero backdrop: wraps children in a warp-speed beam field"],
  // text effects
  ["sparkles-text", "text effects", "text effect: headline with animated sparkles"],
  ["text-reveal", "text effects", "text effect: paragraph revealed word-by-word on scroll"],
  ["text-animate", "text effects", "text effect: enter/exit animation per char, word or line"],
  ["hyper-text", "text effects", "text effect: scramble-in letters, hacker feel"],
  ["morphing-text", "text effects", "text effect: one word melts into the next"],
  ["aurora-text", "text effects", "text effect: flowing aurora gradient inside the glyphs"],
  ["animated-shiny-text", "text effects", "text effect: shimmer sweep across a short label"],
  ["line-shadow-text", "text effects", "text effect: hatched drop-shadow behind display type"],
  ["word-rotate", "text effects", "text effect: cycles through a list of words"],
  ["typing-animation", "text effects", "text effect: typewriter reveal, continuous"],
  ["number-ticker", "text effects", "text effect: metric counts up to its value"],
  ["animated-gradient-text", "text effects", "text effect: gradient sweep on an announcement pill"],
  // motion
  ["marquee", "motion", "motion: infinite horizontal/vertical scroll of logos, quotes, cards"],
  ["animated-list", "motion", "motion: notification feed where items slide in one by one"],
  ["blur-fade", "motion", "motion: blur+fade entrance for sections and images"],
  ["animated-beam", "motion", "motion: beam travelling between two refs, for integrations diagrams"],
  ["orbiting-circles", "motion", "motion: icons orbiting a centre, for ecosystems"],
  ["scroll-progress", "motion", "motion: thin progress bar tracking page scroll"],
  ["scroll-based-velocity", "motion", "motion: text that scrolls faster as you scroll"],
  ["confetti", "motion", "motion: celebration burst on an event"],
  // surfaces & frames
  ["bento-grid", "surfaces & frames", "surface: feature bento layout of cards"],
  ["magic-card", "surfaces & frames", "surface: card with cursor-following spotlight border"],
  ["neon-gradient-card", "surfaces & frames", "surface: card with animated neon gradient border"],
  ["border-beam", "surfaces & frames", "frame: light beam running around a relative container"],
  ["shine-border", "surfaces & frames", "frame: animated shining border on any box"],
  ["terminal", "surfaces & frames", "product-surface frame: animated terminal window with typed lines"],
  ["dock", "surfaces & frames", "surface: macOS-style magnifying dock of icons"],
  ["globe", "surfaces & frames", "surface: interactive WebGL globe (cobe)"],
  ["icon-cloud", "surfaces & frames", "surface: rotating 3D sphere of icons"],
  ["safari", "surfaces & frames", "product-surface frame: Safari browser window mockup"],
  ["iphone", "surfaces & frames", "product-surface frame: iPhone device mockup"],
  ["android", "surfaces & frames", "product-surface frame: Android device mockup"],
  ["hero-video-dialog", "surfaces & frames", "surface: video thumbnail that opens a lightbox"],
  ["avatar-circles", "surfaces & frames", "surface: overlapping avatars + count, social proof"],
  ["animated-circular-progress-bar", "surfaces & frames", "surface: ring gauge that animates to a value"],
  ["lens", "surfaces & frames", "surface: magnifier lens over an image"],
  // buttons
  ["shimmer-button", "buttons", "button: CTA with a travelling shimmer"],
  ["pulsating-button", "buttons", "button: CTA with a soft pulsing halo"],
  ["rainbow-button", "buttons", "button: CTA with animated rainbow border glow"],
  ["shiny-button", "buttons", "button: CTA with a glossy shine sweep"],
  ["ripple-button", "buttons", "button: click ripple feedback"],
  ["interactive-hover-button", "buttons", "button: arrow slides in and fills on hover"],
];

const magicInstall = (name: string) => `npx shadcn@latest add "https://magicui.design/r/${name}.json"`;

export const MAGICUI_COMPONENTS: CatalogEntry[] = MAGIC.map(([name, , useFor]) => ({
  name,
  library: "magicui",
  useFor,
  install: magicInstall(name),
  importPath: `@/components/ui/${name}`, // shadcn 4.x files registry:ui items under the ui alias — verified by a real build
  // The registry URL is MagicUI's current documented path; the old CLI still
  // works but is no longer what their docs show, so it is a footnote.
  docs: `https://magicui.design/docs/components/${name} — legacy: npx magicui-cli add ${name}`,
}));

// The ambient-texture set. A hero without one of these behind it reads flat.
export const MAGICUI_BACKGROUNDS: readonly string[] = [
  "grid-pattern",
  "animated-grid-pattern",
  "dot-pattern",
  "flickering-grid",
  "retro-grid",
  "particles",
  "meteors",
  "ripple",
  "warp-background",
];

// Pieces that keep moving on their own once mounted — what the "≥2 continuous
// motions" hero rule is satisfied with.
export const MAGICUI_MOTION_HINTS: readonly string[] = [
  "typing-animation",
  "number-ticker",
  "marquee",
  "animated-list",
  "orbiting-circles",
  "border-beam",
  "animated-beam",
  "meteors",
  "particles",
  "ripple",
  "sparkles-text",
  "word-rotate",
  "morphing-text",
];

// ── motion (framer-motion) ──────────────────────────────────────────────────
export const MOTION_ENTRIES: CatalogEntry[] = [
  {
    name: "motion",
    library: "framer-motion",
    useFor:
      "custom motion when shadcn/MagicUI don't cover it: motion.div, variants, whileHover, layout, useScroll — MagicUI already depends on motion, so it is usually installed",
    install: "npm install motion",
    importPath: "motion/react",
    docs: "https://motion.dev/docs/react",
  },
];

// ── lookup + install planning ───────────────────────────────────────────────
export const ALL_COMPONENTS: CatalogEntry[] = [
  ...SHADCN_COMPONENTS,
  ...MAGICUI_COMPONENTS,
  ...MOTION_ENTRIES,
];

const BY_NAME = new Map(ALL_COMPONENTS.map((c) => [c.name, c]));

export function findComponent(name: string): CatalogEntry | undefined {
  return BY_NAME.get(name.trim());
}

// Turns a wish list into the exact shell lines to run: shadcn names collapse
// into a single `add` (one install, one dependency resolution), MagicUI stays
// one line per registry URL, `motion` becomes its npm install. Unknown names
// throw rather than silently vanish — a typo here would otherwise surface as a
// missing import three steps later.
export function installCommandsFor(names: string[]): string[] {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const unknown = wanted.filter((n) => !BY_NAME.has(n));
  if (unknown.length > 0) {
    throw new Error(
      `unknown component${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")} — ` +
        `not in the catalog. Valid names are: shadcn (${SHADCN_COMPONENTS.map((c) => c.name).join(", ")}); ` +
        `MagicUI (${MAGICUI_COMPONENTS.map((c) => c.name).join(", ")}); ` +
        `and "motion".`,
    );
  }
  const shadcn = wanted.filter((n) => BY_NAME.get(n)?.library === "shadcn");
  const magic = wanted.filter((n) => BY_NAME.get(n)?.library === "magicui");
  const motion = wanted.filter((n) => BY_NAME.get(n)?.library === "framer-motion");

  const lines: string[] = [];
  if (shadcn.length > 0) lines.push(`npx shadcn@latest add ${shadcn.join(" ")}`);
  for (const n of magic) lines.push(magicInstall(n));
  for (const n of motion) lines.push(BY_NAME.get(n)!.install);
  return lines;
}

// ── renderings ──────────────────────────────────────────────────────────────
const magicNamesByJob = (job: MagicJob): string[] =>
  MAGIC.filter(([, j]) => j === job).map(([name]) => name);

// Compact enough to live in a system prompt (budget: 2500 chars). Names only —
// the composer can read the full markdown reference on disk when it needs the
// per-component blurb.
export function renderCatalogForPrompt(): string {
  const lines: string[] = [];
  lines.push("COMPONENT CATALOG (preview app: Next.js + Tailwind + shadcn)");
  lines.push(
    `shadcn/ui — install: npx shadcn@latest add <a> <b> …; import "@/components/ui/<name>":`,
  );
  lines.push(SHADCN_COMPONENTS.map((c) => c.name).join(" "));
  lines.push(
    `MagicUI — install one line per component: npx shadcn@latest add "https://magicui.design/r/<name>.json"; import "@/components/ui/<name>" (the shadcn CLI files MagicUI under ui/, not magicui/):`,
  );
  for (const job of MAGIC_JOB_ORDER) {
    lines.push(`- ${job} (${MAGIC_JOB_HINT[job]}): ${magicNamesByJob(job).join(" ")}`);
  }
  lines.push(
    `motion — npm install motion; import "motion/react": hand-rolled animation only when the above don't cover it (MagicUI already pulls in motion).`,
  );
  lines.push(
    "RULE: install with the exact command, then IMPORT and USE it — an installed component that never appears in the page TSX is a bug.",
  );
  return lines.join("\n");
}

// Markdown cells can't hold a bare pipe; nothing in the catalog has one today,
// but the escape is cheaper than the surprise.
const cell = (s: string) => s.replace(/\|/g, "\\|");

function table(entries: CatalogEntry[]): string {
  const rows = entries.map(
    (c) => `| ${cell(c.name)} | ${cell(c.useFor)} | \`${cell(c.install)}\` | \`${cell(c.importPath)}\` |`,
  );
  return ["| name | use for | install | import |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

// The full reference written to .prism/preview/prism/component_catalog.md:
// one table per library, then the hero recipe with snippets the composer can
// lift verbatim.
export function renderCatalogMarkdown(): string {
  const magicUiTables = MAGIC_JOB_ORDER.map((job) => {
    const names = new Set(magicNamesByJob(job));
    return `### ${job}\n\n${table(MAGICUI_COMPONENTS.filter((c) => names.has(c.name)))}`;
  }).join("\n\n");

  return `# Component catalog

Everything installable into the preview app, and what each piece is for. Install with the exact command shown, then **import and use it** — an installed component that never appears in the page TSX is a bug.

## shadcn/ui

Primitives. Group several into one install: \`npx shadcn@latest add button card badge\`. Import from \`@/components/ui/<name>\`.

${table(SHADCN_COMPONENTS)}

## MagicUI

Installed through the shadcn registry, one line per component: \`npx shadcn@latest add "https://magicui.design/r/<name>.json"\` (legacy: \`npx magicui-cli add <name>\`). Import from \`@/components/ui/<name>\` — the shadcn CLI files MagicUI registry items under the ui alias, not a magicui/ folder (verified by a real build). MagicUI depends on \`motion\`, so installing any of these also brings in motion.

${magicUiTables}

## motion (framer-motion)

${table(MOTION_ENTRIES)}

## How to compose a hero

Every hero mockup must contain all of the following — the audit checks for them:

1. **Ambient texture** — at least one component from the backgrounds list (${MAGICUI_BACKGROUNDS.join(", ")}) rendered at **≥ 0.4 opacity** (\`opacity-40\` or higher), positioned \`absolute inset-0\` behind the content. Layer two for depth (e.g. GridPattern under Particles) and mask the edges so it fades rather than stops.
2. **An inline product surface** — the product itself, built in TSX (a Card, a Terminal, a Safari/iPhone frame holding real UI, a bento of metrics). Not a screenshot, not a placeholder image.
3. **≥ 2 continuous motions** — pieces that keep moving on their own: ${MAGICUI_MOTION_HINTS.join(", ")}.
4. **Hover states on ≥ 3 elements** — \`hover:\` classes or \`whileHover\` on buttons, cards, nav items; a static page reads as a picture.
5. **≥ 3 mono marginalia at 14–16px** — small \`font-mono text-sm\` (14px) or \`text-base\` (16px) labels in the margins: version tags, coordinates, live readouts, timestamps. They make the surface feel instrumented.

### Snippets

Ambient texture — GridPattern at half opacity, radially masked:

\`\`\`tsx
import { GridPattern } from "@/components/ui/grid-pattern";

<section className="relative overflow-hidden">
  <GridPattern
    width={40}
    height={40}
    className="absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_center,white,transparent_70%)]"
  />
  {/* content */}
</section>
\`\`\`

CTA wrapped with BorderBeam — the beam needs a \`relative\` container with \`overflow-hidden\`:

\`\`\`tsx
import { Button } from "@/components/ui/button";
import { BorderBeam } from "@/components/ui/border-beam";

<div className="relative inline-flex overflow-hidden rounded-lg">
  <Button size="lg" className="hover:brightness-110">Start free</Button>
  <BorderBeam size={120} duration={8} />
</div>
\`\`\`

NumberTicker readout inside a mono label:

\`\`\`tsx
import { NumberTicker } from "@/components/ui/number-ticker";

<span className="font-mono text-sm text-muted-foreground">
  req/s <NumberTicker value={12840} className="text-foreground" />
</span>
\`\`\`
`;
}
