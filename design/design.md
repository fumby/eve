# EVE — Design System

One accent, real typography, continuous quiet motion: EVE should feel like an instrument someone tuned by hand, not a template someone filled in.

> Bootstrapped from package.json "eve": EVE — a voice-first personal AI assistant. Edit the tokens block to retune; the prose below is the standing design system.

```yaml tokens
fonts:
  display: "Instrument Serif"
  body: "Inter Tight"
  mono: "JetBrains Mono"
colors:
  background: "#07090c"
  foreground: "#e8ecef"
  accent: "#2dd4a8"
  muted: "#11161c"
  border: "#1c232b"
radius: "0.5rem"
mode: dark
shadcn:
  baseColor: zinc
  style: new-york
```

## Type

- **Display — Instrument Serif.** Headlines and numbers that carry a screen. 96–140px on desktop (clamp to 48–64px on mobile), hand-tuned tracking between −0.04em and −0.02em, line-height 0.95–1.0. Where the face has an italic, use it for the one word that matters, not the whole line.
- **Body — Inter Tight.** 16–18px, line-height 1.5–1.6, measure 60–72 characters. Weight 400 for prose, 500 for labels; never fake emphasis with colour when weight will do.
- **Mono — JetBrains Mono.** 14–16px for marginalia: timestamps, tickers, coordinates, status readouts, keyboard hints. Uppercase mono at 12–13px with 0.08em tracking is the only permitted small-caps move.
- Type does the hierarchy. Two sizes on a surface is usually enough; three is the ceiling.

## Color

- Dark mode. Background `#07090c`, foreground `#e8ecef`, muted surface `#11161c`, hairline border `#1c232b`.
- **One accent — `#2dd4a8` — used precisely.** It marks the live thing: the active state, the primary action, the number that just changed, the caret. It is never a decorative fill, never a gradient, never a background wash behind a headline.
- Everything else is value, not hue: surfaces separate by 3–6% lightness steps and hairline borders, not by colour.
- Contrast is real: body text on background at 12:1 or better; muted text never below 4.5:1.

## Motion

- Motion is continuous and ambient: at idle at least two things are always moving, slowly enough that you notice them only when you look. Named moves — use these names in components:
  - **breathing pulse** — a 4–6s ease-in-out opacity/scale breath on the live indicator or the accent dot.
  - **scanline drift** — a faint horizontal line or grid offset crossing a surface over 12–20s, opacity 0.05–0.1.
  - **ticker** — mono marginalia (timestamps, counters, log lines) advancing on their own.
  - **blinking caret** — a 1s step caret wherever text is "being written".
- Entrances are quick and quiet (150–250ms, ease-out, ≤ 8px travel). No bounce, no spring overshoot, no parallax.
- Respect `prefers-reduced-motion`: keep the state, drop the movement.

## Layout & texture

- Layered dark surfaces: base → panel → card, each one lightness step apart, hairline borders throughout.
- Grid or dot patterns sit at ≥ 0.4 opacity so they read as texture, not as an accident; layer them (grid under, dots or a scanline over) and let them run under panels rather than stopping at edges.
- Generous margins, tight components: 96–160px section rhythm, 8px internal spacing steps, radius `0.5rem` everywhere a corner shows.
- Every hero has a product surface in it. A headline over a background is not a hero.

## Components

- shadcn/ui primitives (new-york, zinc base, CSS variables) for anything interactive: button, input, dialog, tabs, table, tooltip, command.
- MagicUI for texture and motion: grid/dot/flickering patterns, border-beam, shine-border, number-ticker, animated-list, marquee, blur-fade, terminal.
- Product surfaces are composed in TSX from those parts — a dashboard, an inbox, a session, a console — never dropped in as an image.
- Icons: lucide only, 16px inline / 20px in buttons, stroke 1.5.

## Voice of the UI

- Short, specific, lowercase-friendly. Labels say what the thing is ("session", "queue", "last run") not what it hopes you feel.
- Numbers get units and precision ("2.4s", "$0.12", "3 open"). Empty states say what will appear there and how.
- No exclamation marks, no "welcome back", no filler adjectives. The interface is calm because it knows what it is doing.
