// String builders for the three documents the design agent keeps per project:
// design.md (the design system, tokens block included), .prism/brief.md (the
// private strategic memory) and features/<slug>.md (per-feature spec + log).
// Pure — text in, text out. The design.md template is opinionated on purpose:
// a bootstrapped project should read like a decision already made, never like
// a form waiting to be filled in.
import type { DesignTokens } from "./types.js";
import { renderTokensYaml } from "./tokens.js";

export function designMdTemplate(input: { name: string; tokens: DesignTokens; notes?: string }): string {
  const { name, tokens: t } = input;
  const c = t.colors;
  const modeWord = t.mode === "dark" ? "dark" : "light";
  const notes = input.notes?.trim() ? `\n> ${input.notes.trim().replace(/\n+/g, " ")}\n` : "";
  return `# ${name} — Design System

One accent, real typography, continuous quiet motion: ${name} should feel like an instrument someone tuned by hand, not a template someone filled in.
${notes}
\`\`\`yaml tokens
${renderTokensYaml(t)}\`\`\`

## Type

- **Display — ${t.fonts.display}.** Headlines and numbers that carry a screen. 96–140px on desktop (clamp to 48–64px on mobile), hand-tuned tracking between −0.04em and −0.02em, line-height 0.95–1.0. Where the face has an italic, use it for the one word that matters, not the whole line.
- **Body — ${t.fonts.body}.** 16–18px, line-height 1.5–1.6, measure 60–72 characters. Weight 400 for prose, 500 for labels; never fake emphasis with colour when weight will do.
- **Mono — ${t.fonts.mono}.** 14–16px for marginalia: timestamps, tickers, coordinates, status readouts, keyboard hints. Uppercase mono at 12–13px with 0.08em tracking is the only permitted small-caps move.
- Type does the hierarchy. Two sizes on a surface is usually enough; three is the ceiling.

## Color

- ${modeWord === "dark" ? "Dark" : "Light"} mode. Background \`${c.background}\`, foreground \`${c.foreground}\`, muted surface \`${c.muted}\`, hairline border \`${c.border}\`.
- **One accent — \`${c.accent}\` — used precisely.** It marks the live thing: the active state, the primary action, the number that just changed, the caret. It is never a decorative fill, never a gradient, never a background wash behind a headline.
- Everything else is value, not hue: surfaces separate by 3–6% lightness steps and hairline borders, not by colour.
- Contrast is real: body text on background at 12:1 or better; muted text never below 4.5:1.

## Motion

- Motion is continuous and ambient: at idle at least two things are always moving, slowly enough that you notice them only when you look. Named moves — use these names in components:
  - **breathing pulse** — a 4–6s ease-in-out opacity/scale breath on the live indicator or the accent dot.
  - **scanline drift** — a faint horizontal line or grid offset crossing a surface over 12–20s, opacity 0.05–0.1.
  - **ticker** — mono marginalia (timestamps, counters, log lines) advancing on their own.
  - **blinking caret** — a 1s step caret wherever text is "being written".
- Entrances are quick and quiet (150–250ms, ease-out, ≤ 8px travel). No bounce, no spring overshoot, no parallax.
- Respect \`prefers-reduced-motion\`: keep the state, drop the movement.

## Layout & texture

- Layered ${modeWord} surfaces: base → panel → card, each one lightness step apart, hairline borders throughout.
- Grid or dot patterns sit at ≥ 0.4 opacity so they read as texture, not as an accident; layer them (grid under, dots or a scanline over) and let them run under panels rather than stopping at edges.
- Generous margins, tight components: 96–160px section rhythm, 8px internal spacing steps, radius \`${t.radius}\` everywhere a corner shows.
- Every hero has a product surface in it. A headline over a background is not a hero.

## Components

- shadcn/ui primitives (${t.shadcn.style}, ${t.shadcn.baseColor} base, CSS variables) for anything interactive: button, input, dialog, tabs, table, tooltip, command.
- MagicUI for texture and motion: grid/dot/flickering patterns, border-beam, shine-border, number-ticker, animated-list, marquee, blur-fade, terminal.
- Product surfaces are composed in TSX from those parts — a dashboard, an inbox, a session, a console — never dropped in as an image.
- Icons: lucide only, 16px inline / 20px in buttons, stroke 1.5.

## Voice of the UI

- Short, specific, lowercase-friendly. Labels say what the thing is ("session", "queue", "last run") not what it hopes you feel.
- Numbers get units and precision ("2.4s", "$0.12", "3 open"). Empty states say what will appear there and how.
- No exclamation marks, no "welcome back", no filler adjectives. The interface is calm because it knows what it is doing.
`;
}

export function briefTemplate(input: {
  name: string;
  positioning: string;
  persona: string;
  goals: string[];
  brandLanguage: string[];
  decisions: string[];
  forbidden: string[];
  themes: string[];
  bootstrapNotes: string[];
}): string {
  const bullets = (items: string[], indent = "") =>
    items.length ? items.map((s) => `${indent}- ${s}`).join("\n") : `${indent}- (none yet)`;
  return `# ${input.name} — Design Brief (private)

> The brief is law: when a request conflicts with a standing decision, the brief wins — surface the conflict, don't override.

## Positioning

${input.positioning.trim()}

## Persona

${input.persona.trim()}

## Business goals

${bullets(input.goals)}

## Brand language

${bullets(input.brandLanguage)}

## Standing design decisions

${bullets(input.decisions)}

### Forbidden moves

${bullets(input.forbidden)}

## Ongoing themes

${bullets(input.themes)}

## Bootstrap notes

${bullets(input.bootstrapNotes)}
`;
}

export function featureTemplate(input: { slug: string; title: string; intent: string }): string {
  return `# ${input.title}

slug: ${input.slug}

## Intent

${input.intent.trim()}

## Screens

| screen | purpose | status | url |
| --- | --- | --- | --- |

## Visual direction

- Follows design.md; note here only what this feature adds or bends.

## Open questions

- (none yet)

## Log

`;
}
