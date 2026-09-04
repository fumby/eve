// design.md's ```yaml tokens block is the single source of truth for a
// project's fonts, colours, radius and mode. This module reads it strictly
// (every problem reported at once, in plain language the model can relay) and
// renders the four generated files the preview app is built on:
// tailwind.config.ts, app/globals.css, lib/fonts.ts and components.json.
// Everything here is pure — parse text in, file text out.
import YAML from "yaml";
import { HEX_RE } from "./types.js";
import type { DesignTokens, FontRole, ShadcnBaseColor, ShadcnStyle } from "./types.js";
import {
  canonicalFont,
  genericFamilyFor,
  googleFontImportName,
  hasItalic,
  isForbiddenFont,
  isKnownFont,
  staticWeightsFor,
} from "./fonts.js";

export class TokenError extends Error {}

const FONT_ROLES: FontRole[] = ["display", "body", "mono"];
const REQUIRED_COLORS = ["background", "foreground", "accent", "muted", "border"] as const;
const OPTIONAL_COLORS = ["accentForeground", "mutedForeground", "card", "destructive"] as const;
const BASE_COLORS: ShadcnBaseColor[] = ["slate", "gray", "zinc", "neutral", "stone"];
const STYLES: ShadcnStyle[] = ["default", "new-york"];
const RADIUS_RE = /^\d*\.?\d+(px|rem|em)$/;
const SHORT_HEX_RE = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/;

// ── extraction ──────────────────────────────────────────────────────────────

// The fence must open with a line reading ```yaml tokens (trailing spaces
// allowed, up to three leading spaces as markdown permits). Plain ```yaml
// blocks are ignored so design.md can carry other YAML examples.
export function extractTokensBlock(designMd: string): string | null {
  const m = /^[ \t]{0,3}```yaml[ \t]+tokens[ \t]*\r?\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/m.exec(designMd);
  return m ? (m[1] ?? "") : null;
}

// ── colour helpers ──────────────────────────────────────────────────────────

// "#ABC" → "#aabbcc"; "#AABBCC" → "#aabbcc"; anything else → null.
export function normalizeHex(value: string): string | null {
  const v = value.trim();
  const short = SHORT_HEX_RE.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return HEX_RE.test(v) ? v.toLowerCase() : null;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex);
  if (!h) throw new TokenError(`not a hex colour: ${JSON.stringify(hex)}`);
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHslParts(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// The shadcn CSS-variable form: "h s% l%" with at most one decimal (a
// trailing ".0" is dropped, matching shadcn's own theme files, e.g.
// "240 10% 3.9%"). No hsl() wrapper — Tailwind adds it via hsl(var(--x)).
export function hexToHsl(hex: string): string {
  const [h, s, l] = rgbToHslParts(...hexToRgb(hex));
  const one = (n: number) => {
    const t = n.toFixed(1);
    return t.endsWith(".0") ? t.slice(0, -2) : t;
  };
  return `${one(h)} ${one(s * 100)}% ${one(l * 100)}%`;
}

export function hexToHslParts(hex: string): { h: number; s: number; l: number } {
  const [h, s, l] = rgbToHslParts(...hexToRgb(hex));
  return { h, s, l };
}

// Shift lightness by `delta` (−1..1) keeping hue and saturation.
export function adjustLightness(hex: string, delta: number): string {
  const [h, s, l] = rgbToHslParts(...hexToRgb(hex));
  return rgbToHex(...hslToRgb(h, s, Math.max(0, Math.min(1, l + delta))));
}

// Linear RGB mix: weight 1 = all `a`, 0 = all `b`.
export function mixHex(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const w = Math.max(0, Math.min(1, weight));
  return rgbToHex(ar * w + br * (1 - w), ag * w + bg * (1 - w), ab * w + bb * (1 - w));
}

// WCAG relative luminance, used to pick readable text over the accent.
export function relativeLuminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// ── parsing ─────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Parses and validates the tokens block. Every problem is collected and
// thrown together so the model fixes design.md in one pass rather than
// discovering errors one at a time.
export function parseTokens(designMd: string): DesignTokens {
  const prefix = "design.md tokens block: ";
  const block = extractTokensBlock(designMd);
  if (block === null) {
    throw new TokenError(`${prefix}missing — design.md needs a fenced block opening with \`\`\`yaml tokens (see the design.md template)`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(block);
  } catch (err) {
    throw new TokenError(`${prefix}the YAML does not parse — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw)) throw new TokenError(`${prefix}expected a YAML mapping with fonts, colors, radius, mode, shadcn`);

  const problems: string[] = [];

  // fonts
  const fonts = {} as Record<FontRole, string>;
  const rawFonts = isRecord(raw.fonts) ? raw.fonts : null;
  if (!rawFonts) problems.push("fonts is missing (needs display, body, mono)");
  for (const role of FONT_ROLES) {
    const v = rawFonts?.[role];
    if (typeof v !== "string" || !v.trim()) {
      if (rawFonts) problems.push(`fonts.${role} is missing`);
      continue;
    }
    if (isForbiddenFont(v)) {
      problems.push(`fonts.${role}: "${v}" is on the forbidden list (generic AI-SaaS look) — pick a family from the font catalog instead`);
      continue;
    }
    // Any catalog family may serve any role on purpose (a mono body, a serif
    // UI) — the role filter is a prompt nudge, not a rule.
    if (!isKnownFont(v)) {
      problems.push(`fonts.${role}: "${v}" is not in the font catalog — pick a family from the catalog (exact Google Fonts name)`);
      continue;
    }
    fonts[role] = canonicalFont(v)!.family;
  }

  // colours — note the YAML footgun: an unquoted #hex is a comment, so a
  // missing value usually means the author forgot the quotes.
  const colors: Record<string, string> = {};
  const rawColors = isRecord(raw.colors) ? raw.colors : null;
  if (!rawColors) problems.push("colors is missing (needs background, foreground, accent, muted, border)");
  const checkColor = (key: string, required: boolean) => {
    const v = rawColors?.[key];
    if (v === undefined || v === null || v === "") {
      if (required && rawColors) problems.push(`colors.${key} is missing (hex values must be quoted: ${key}: "#2dd4a8" — an unquoted # starts a YAML comment)`);
      return;
    }
    const hex = typeof v === "string" ? normalizeHex(v) : null;
    if (!hex) {
      problems.push(`colors.${key}: ${JSON.stringify(v)} is not a hex colour (#rrggbb or #rgb)`);
      return;
    }
    colors[key] = hex;
  };
  for (const key of REQUIRED_COLORS) checkColor(key, true);
  for (const key of OPTIONAL_COLORS) checkColor(key, false);

  // radius
  let radius = "";
  if (raw.radius === undefined || raw.radius === null) {
    problems.push('radius is missing (a CSS length like "0.5rem" or "8px")');
  } else if (typeof raw.radius !== "string" || !RADIUS_RE.test(raw.radius.trim())) {
    problems.push(`radius: ${JSON.stringify(raw.radius)} must be a CSS length like "0.5rem", "8px" or "0px" (a bare number is not enough)`);
  } else {
    radius = raw.radius.trim();
  }

  // mode
  let mode: DesignTokens["mode"] = "dark";
  if (raw.mode !== undefined && raw.mode !== null) {
    if (raw.mode === "dark" || raw.mode === "light") mode = raw.mode;
    else problems.push(`mode: ${JSON.stringify(raw.mode)} must be "dark" or "light"`);
  }

  // shadcn
  let baseColor: ShadcnBaseColor = "zinc";
  let style: ShadcnStyle = "new-york";
  if (raw.shadcn !== undefined && raw.shadcn !== null) {
    if (!isRecord(raw.shadcn)) {
      problems.push("shadcn must be a mapping with baseColor and style");
    } else {
      const bc = raw.shadcn.baseColor;
      if (bc !== undefined && bc !== null) {
        if (typeof bc === "string" && (BASE_COLORS as string[]).includes(bc)) baseColor = bc as ShadcnBaseColor;
        else problems.push(`shadcn.baseColor: ${JSON.stringify(bc)} must be one of ${BASE_COLORS.join(", ")}`);
      }
      const st = raw.shadcn.style;
      if (st !== undefined && st !== null) {
        if (typeof st === "string" && (STYLES as string[]).includes(st)) style = st as ShadcnStyle;
        else problems.push(`shadcn.style: ${JSON.stringify(st)} must be one of ${STYLES.join(", ")}`);
      }
    }
  }

  if (problems.length) throw new TokenError(prefix + problems.join("; "));

  const tokens: DesignTokens = {
    fonts,
    colors: {
      background: colors.background!,
      foreground: colors.foreground!,
      accent: colors.accent!,
      muted: colors.muted!,
      border: colors.border!,
    },
    radius,
    mode,
    shadcn: { baseColor, style },
  };
  if (colors.accentForeground) tokens.colors.accentForeground = colors.accentForeground;
  if (colors.mutedForeground) tokens.colors.mutedForeground = colors.mutedForeground;
  if (colors.card) tokens.colors.card = colors.card;
  if (colors.destructive) tokens.colors.destructive = colors.destructive;
  return tokens;
}

export function tokensAreValid(designMd: string): { ok: true; tokens: DesignTokens } | { ok: false; error: string } {
  try {
    return { ok: true, tokens: parseTokens(designMd) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// The inverse of parseTokens: the YAML body of a tokens block, in the field
// order the template documents. Values are JSON-quoted so a "#hex" can never
// be read as a YAML comment.
export function renderTokensYaml(t: DesignTokens): string {
  const q = (v: string) => JSON.stringify(v);
  const lines = [
    "fonts:",
    `  display: ${q(t.fonts.display)}`,
    `  body: ${q(t.fonts.body)}`,
    `  mono: ${q(t.fonts.mono)}`,
    "colors:",
    `  background: ${q(t.colors.background)}`,
    `  foreground: ${q(t.colors.foreground)}`,
    `  accent: ${q(t.colors.accent)}`,
  ];
  if (t.colors.accentForeground) lines.push(`  accentForeground: ${q(t.colors.accentForeground)}`);
  lines.push(`  muted: ${q(t.colors.muted)}`);
  if (t.colors.mutedForeground) lines.push(`  mutedForeground: ${q(t.colors.mutedForeground)}`);
  lines.push(`  border: ${q(t.colors.border)}`);
  if (t.colors.card) lines.push(`  card: ${q(t.colors.card)}`);
  if (t.colors.destructive) lines.push(`  destructive: ${q(t.colors.destructive)}`);
  lines.push(
    `radius: ${q(t.radius)}`,
    `mode: ${t.mode}`,
    "shadcn:",
    `  baseColor: ${t.shadcn.baseColor}`,
    `  style: ${t.shadcn.style}`,
  );
  return lines.join("\n") + "\n";
}

// ── derived palette ─────────────────────────────────────────────────────────

export interface Palette {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

// Fills every shadcn slot from the five required tokens plus whatever
// optional ones were given. The brand accent becomes --primary and --ring;
// shadcn's own --accent is the *hover surface* (ghost buttons, menu items),
// so it is derived from muted rather than the brand colour — otherwise the
// one accent the design system asks to use precisely lands on every hover.
export function derivePalette(t: DesignTokens): Palette {
  const dark = t.mode === "dark";
  const c = t.colors;
  const card = c.card ?? adjustLightness(c.background, dark ? 0.03 : -0.03);
  const accentForeground =
    c.accentForeground ?? (relativeLuminance(c.accent) > 0.4 ? "#0b0f14" : "#fafafa");
  const mutedForeground = c.mutedForeground ?? mixHex(c.foreground, c.background, 0.62);
  const hover = adjustLightness(c.muted, dark ? 0.04 : -0.04);
  const destructive = c.destructive ?? (dark ? "#7f1d1d" : "#ef4444");
  const destructiveForeground = relativeLuminance(destructive) > 0.4 ? "#0b0f14" : "#fef2f2";
  return {
    background: c.background,
    foreground: c.foreground,
    card,
    cardForeground: c.foreground,
    popover: card,
    popoverForeground: c.foreground,
    primary: c.accent,
    primaryForeground: accentForeground,
    secondary: c.muted,
    secondaryForeground: c.foreground,
    muted: c.muted,
    mutedForeground,
    accent: hover,
    accentForeground: c.foreground,
    destructive,
    destructiveForeground,
    border: c.border,
    input: c.border,
    ring: c.accent,
  };
}

// ── renderers ───────────────────────────────────────────────────────────────

function fontStack(family: string): string {
  const generic = genericFamilyFor(family);
  const fallback =
    generic === "monospace"
      ? '"ui-monospace", "SFMono-Regular", "Menlo", "monospace"'
      : generic === "serif"
        ? '"Georgia", "Times New Roman", "serif"'
        : '"system-ui", "-apple-system", "Segoe UI", "sans-serif"';
  return fallback;
}

export function renderTailwindConfig(t: DesignTokens): string {
  return `import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

// Generated from design.md's tokens block — edit design.md, not this file.
const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
      },
      fontFamily: {
        display: ["var(--font-display)", ${fontStack(t.fonts.display)}],
        body: ["var(--font-body)", ${fontStack(t.fonts.body)}],
        mono: ["var(--font-mono)", ${fontStack(t.fonts.mono)}],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [animate],
};

export default config;
`;
}

// The shadcn CLI appends keyframes (and sometimes @layer additions) to
// globals.css when it installs components. Token refreshes must not wipe
// those, so the generated part is fenced and spliced, never overwritten.
export const GLOBALS_TOKENS_START = "/* prism:tokens:start */";
export const GLOBALS_TOKENS_END = "/* prism:tokens:end */";

// Replaces the fenced region of an on-disk globals.css with the fenced region
// of a freshly rendered one; returns null when the on-disk file has no fence
// (caller decides whether to overwrite).
export function spliceGlobalsCss(onDisk: string, rendered: string): string | null {
  const s = onDisk.indexOf(GLOBALS_TOKENS_START);
  const e = onDisk.indexOf(GLOBALS_TOKENS_END);
  const rs = rendered.indexOf(GLOBALS_TOKENS_START);
  const re = rendered.indexOf(GLOBALS_TOKENS_END);
  if (s < 0 || e < s || rs < 0 || re < rs) return null;
  const region = rendered.slice(rs, re + GLOBALS_TOKENS_END.length);
  return onDisk.slice(0, s) + region + onDisk.slice(e + GLOBALS_TOKENS_END.length);
}

export function renderGlobalsCss(t: DesignTokens): string {
  const p = derivePalette(t);
  const vars = [
    ["--background", p.background],
    ["--foreground", p.foreground],
    ["--card", p.card],
    ["--card-foreground", p.cardForeground],
    ["--popover", p.popover],
    ["--popover-foreground", p.popoverForeground],
    ["--primary", p.primary],
    ["--primary-foreground", p.primaryForeground],
    ["--secondary", p.secondary],
    ["--secondary-foreground", p.secondaryForeground],
    ["--muted", p.muted],
    ["--muted-foreground", p.mutedForeground],
    ["--accent", p.accent],
    ["--accent-foreground", p.accentForeground],
    ["--destructive", p.destructive],
    ["--destructive-foreground", p.destructiveForeground],
    ["--border", p.border],
    ["--input", p.input],
    ["--ring", p.ring],
  ]
    .map(([name, hex]) => `    ${name}: ${hexToHsl(hex!)}; /* ${hex} */`)
    .join("\n");
  const radiusLine = `    --radius: ${t.radius};`;
  const dark = t.mode === "dark";
  const rootBlock = `  :root {\n${vars}\n${radiusLine}${dark ? "\n    color-scheme: dark;" : ""}\n  }`;
  // Dark projects repeat the values on .dark so shadcn components that toggle
  // the class (and any <html class="dark">) resolve to the same palette.
  const darkBlock = dark ? `\n  .dark {\n${vars}\n${radiusLine}\n    color-scheme: dark;\n  }` : "";
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

${GLOBALS_TOKENS_START}
/* Generated from design.md's tokens block — edit design.md, not this file.
   Mode: ${t.mode}. Fonts: ${t.fonts.display} / ${t.fonts.body} / ${t.fonts.mono}.
   Only the region between the prism:tokens markers is re-rendered on a token
   change; anything the shadcn CLI appends below the end marker is kept. */
@layer base {
${rootBlock}${darkBlock}
}
${GLOBALS_TOKENS_END}

@layer base {
  * {
    @apply border-border;
  }
  html {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  body {
    @apply bg-background text-foreground font-body;
  }
  h1, h2, h3, h4, h5, h6 {
    @apply font-display;
    text-wrap: balance;
  }
  code, kbd, samp, pre {
    @apply font-mono;
  }
}
`;
}

// lib/fonts.ts for the preview app. Static families get explicit weights
// (asking for a weight a family lacks fails the build); variable families
// omit `weight` so the whole axis is served. Imports are de-duplicated in
// case one family serves two roles.
export function renderFontsTs(t: DesignTokens): string {
  const roles: FontRole[] = ["display", "body", "mono"];
  const importNames = [...new Set(roles.map((r) => googleFontImportName(t.fonts[r])))];
  const decl = (role: FontRole) => {
    const family = t.fonts[role];
    const opts: string[] = ['subsets: ["latin"]'];
    const weights = staticWeightsFor(family);
    if (weights) opts.push(`weight: [${weights.map((w) => JSON.stringify(w)).join(", ")}]`);
    if (hasItalic(family)) opts.push('style: ["normal", "italic"]');
    opts.push(`variable: "--font-${role}"`, 'display: "swap"');
    return `export const ${role} = ${googleFontImportName(family)}({ ${opts.join(", ")} });`;
  };
  return `import { ${importNames.join(", ")} } from "next/font/google";

// Generated from design.md's tokens block — edit design.md, not this file.
${roles.map(decl).join("\n")}

// Put on <html> (or <body>) so --font-display/--font-body/--font-mono resolve everywhere.
export const fontVars = [display.variable, body.variable, mono.variable].join(" ");
`;
}

// components.json for the shadcn CLI. The CLI validates this file with a
// strict schema (verified against shadcn 4.18: unknown top-level keys are
// rejected), so nothing beyond the documented fields goes in — the preview
// URL basePath is a Next.js concern (next.config) and is deliberately not
// written here even though the caller passes it for symmetry with the other
// scaffold renderers.
export function renderComponentsJson(t: DesignTokens, _opts: { basePath: string }): string {
  const json = {
    $schema: "https://ui.shadcn.com/schema.json",
    style: t.shadcn.style,
    rsc: true,
    tsx: true,
    tailwind: {
      config: "tailwind.config.ts",
      css: "app/globals.css",
      baseColor: t.shadcn.baseColor,
      cssVariables: true,
      prefix: "",
    },
    aliases: {
      components: "@/components",
      utils: "@/lib/utils",
      ui: "@/components/ui",
      lib: "@/lib",
      hooks: "@/hooks",
    },
    iconLibrary: "lucide",
  };
  return JSON.stringify(json, null, 2) + "\n";
}

// One paragraph for prompts: everything a composer needs to stay on-system
// without reading design.md again.
export function tokensToPromptSummary(t: DesignTokens): string {
  const c = t.colors;
  const extras = [
    c.accentForeground ? `accent-foreground ${c.accentForeground}` : null,
    c.mutedForeground ? `muted-foreground ${c.mutedForeground}` : null,
    c.card ? `card ${c.card}` : null,
    c.destructive ? `destructive ${c.destructive}` : null,
  ].filter(Boolean);
  return (
    `Design tokens — fonts: display "${t.fonts.display}", body "${t.fonts.body}", mono "${t.fonts.mono}" ` +
    `(loaded via lib/fonts.ts as font-display / font-body / font-mono). ` +
    `Colours (${t.mode} mode): background ${c.background}, foreground ${c.foreground}, accent ${c.accent} ` +
    `(the one accent — used precisely, never as a decorative fill), muted ${c.muted}, border ${c.border}` +
    `${extras.length ? ", " + extras.join(", ") : ""}. ` +
    `Radius ${t.radius}. shadcn ${t.shadcn.style}/${t.shadcn.baseColor}, CSS variables on. ` +
    `Use the Tailwind tokens (bg-background, text-foreground, text-primary, border-border…) rather than raw hex.`
  );
}
