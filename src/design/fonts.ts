// The font catalog: which Google Fonts the design agent may pick, which it may
// never pick, and how a family name turns into a next/font/google import.
// Pure data + string helpers — no I/O.
//
// Why a curated list at all: left to its own devices a model reaches for the
// same five "AI SaaS" faces (Space Grotesk, Plus Jakarta, Poppins…), and every
// mockup ends up looking like every other launch page. Ordering inside each
// role is deliberate — most distinctive first — so a prompt that lists the
// catalog nudges towards the interesting end.
import type { FontEntry, FontRole } from "./types.js";

// Every family below is the exact Google Fonts name (spaces kept), which is
// also what next/font/google expects once spaces become underscores.
export const FONT_CATALOG: FontEntry[] = [
  // ── display ──────────────────────────────────────────────────────────────
  { family: "Instrument Serif", role: "display", notes: "editorial high-contrast serif; the italic is the signature move; single weight (400)" },
  { family: "Fraunces", role: "display", notes: "soft 'wonky' old-style serif, variable weight + optical size; warm and opinionated" },
  { family: "Playfair Display", role: "display", notes: "classic Didone-flavoured serif for very large sizes; variable" },
  { family: "Bricolage Grotesque", role: "display", notes: "quirky grotesque with optical sizes and width; variable; personality without being a serif" },
  { family: "Syne", role: "display", notes: "wide art-school grotesque; heavy weights are poster-like; variable" },
  { family: "Unbounded", role: "display", notes: "extended geometric sans; loud, futuristic without neon; variable" },
  { family: "Cormorant Garamond", role: "display", notes: "elegant, sharp Garamond; best at 96px+ with tight tracking" },
  { family: "Newsreader", role: "display", notes: "newspaper serif with optical sizes; calm authority; variable" },
  { family: "Bodoni Moda", role: "display", notes: "modern Didone with optical sizes; fashion/luxury register; variable" },
  { family: "DM Serif Display", role: "display", notes: "compact high-contrast serif, single weight (400); pairs with DM Sans/DM Mono" },
  { family: "Archivo", role: "display", notes: "grotesque with a wide width axis; the closest Google Fonts gets to Cabinet Grotesk; variable" },
  { family: "Familjen Grotesk", role: "display", notes: "friendly Swedish grotesque with a little quirk; variable" },
  // ── body ─────────────────────────────────────────────────────────────────
  { family: "Inter Tight", role: "body", notes: "Inter's tighter cousin — reads as considered rather than default; variable" },
  { family: "Geist", role: "body", notes: "Vercel's sans; crisp at 14–18px, great with Geist Mono; variable" },
  { family: "Manrope", role: "body", notes: "semi-geometric, slightly wide; friendly product UI; variable" },
  { family: "DM Sans", role: "body", notes: "low-contrast geometric with optical sizes; neutral but not bland; variable" },
  { family: "Onest", role: "body", notes: "humanist sans tuned for interfaces; quiet; variable" },
  { family: "Figtree", role: "body", notes: "rounded-ish geometric; approachable consumer feel; variable" },
  { family: "Source Sans 3", role: "body", notes: "workhorse humanist sans; long-form comfortable; variable" },
  { family: "Instrument Sans", role: "body", notes: "the sans sibling of Instrument Serif; width axis; variable" },
  { family: "Schibsted Grotesk", role: "body", notes: "newsroom grotesque; sturdy at small sizes; variable" },
  // ── mono ─────────────────────────────────────────────────────────────────
  { family: "JetBrains Mono", role: "mono", notes: "tall x-height coding mono; excellent for marginalia and tickers; variable" },
  { family: "IBM Plex Mono", role: "mono", notes: "characterful slab-ish mono; static weights" },
  { family: "Geist Mono", role: "mono", notes: "clean, narrow-ish mono; pairs with Geist; variable" },
  { family: "DM Mono", role: "mono", notes: "light, airy mono for labels; weights 300/400/500 only" },
  { family: "Fira Code", role: "mono", notes: "ligature mono; reads as 'terminal' at 13–14px; variable" },
  { family: "Martian Mono", role: "mono", notes: "wide, technical mono with a width axis; variable" },
];

// The "generic AI SaaS" tells. A tokens block naming one of these fails
// validation, and the TSX audit greps for them — so plain "Inter" stays off
// the list on purpose (it would match "Inter Tight", "interface", "pointer").
// Compared case-insensitively.
export const FORBIDDEN_FAMILIES: ReadonlySet<string> = new Set([
  "Space Grotesk",
  "Plus Jakarta Sans",
  "Poppins",
  "Montserrat",
  "Roboto",
  "Open Sans",
  "Lato",
  "Space Mono",
  "Nunito",
  "Raleway",
  "Arial",
  "Helvetica",
]);

// Families with a variable weight axis on Google Fonts: next/font/google
// serves the whole axis when `weight` is omitted. Everything not listed here
// is treated as static and gets explicit weights (see staticWeightsFor).
export const VARIABLE_FONTS: ReadonlySet<string> = new Set([
  "Fraunces",
  "Playfair Display",
  "Bricolage Grotesque",
  "Syne",
  "Unbounded",
  "Newsreader",
  "Bodoni Moda",
  "Archivo",
  "Familjen Grotesk",
  "Inter Tight",
  "Geist",
  "Manrope",
  "DM Sans",
  "Onest",
  "Figtree",
  "Source Sans 3",
  "Instrument Sans",
  "Schibsted Grotesk",
  "JetBrains Mono",
  "Geist Mono",
  "Fira Code",
  "Martian Mono",
]);

// Static families that do NOT ship 400+700 — asking next/font/google for a
// weight a family lacks fails the build, so these get their real weights.
const STATIC_WEIGHT_OVERRIDES: Record<string, string[]> = {
  "Instrument Serif": ["400"],
  "DM Serif Display": ["400"],
  "DM Mono": ["400", "500"],
};

// Serif display faces whose italics are worth loading (they all ship one).
// Kept deliberately short: requesting `style: italic` for a family without an
// italic file breaks the build.
const ITALIC_FONTS: ReadonlySet<string> = new Set([
  "Instrument Serif",
  "Fraunces",
  "Playfair Display",
  "Cormorant Garamond",
  "Newsreader",
  "Bodoni Moda",
  "DM Serif Display",
]);

const SERIF_FONTS: ReadonlySet<string> = new Set([
  "Instrument Serif",
  "Fraunces",
  "Playfair Display",
  "Cormorant Garamond",
  "Newsreader",
  "Bodoni Moda",
  "DM Serif Display",
]);

function normalise(family: string): string {
  return family.trim().replace(/\s+/g, " ").toLowerCase();
}

// Case/whitespace-insensitive lookup returning the catalog entry with the
// canonical family name — the model sometimes writes "instrument serif" and
// the canonical spelling is what next/font/google needs.
export function canonicalFont(family: string): FontEntry | undefined {
  const key = normalise(family);
  return FONT_CATALOG.find((f) => normalise(f.family) === key);
}

export function isKnownFont(family: string, role?: FontRole): boolean {
  const entry = canonicalFont(family);
  if (!entry) return false;
  return role === undefined || entry.role === role;
}

export function isForbiddenFont(family: string): boolean {
  const key = normalise(family);
  for (const f of FORBIDDEN_FAMILIES) if (normalise(f) === key) return true;
  return false;
}

export function fontsForRole(role: FontRole): FontEntry[] {
  return FONT_CATALOG.filter((f) => f.role === role);
}

// "Instrument Serif" → "Instrument_Serif": the identifier next/font/google
// exports for the family.
export function googleFontImportName(family: string): string {
  return family.trim().replace(/\s+/g, "_");
}

// null means "variable — omit the weight option"; otherwise the exact weights
// to request. Unknown families get the safe ["400","700"].
export function staticWeightsFor(family: string): string[] | null {
  const canonical = canonicalFont(family)?.family ?? family.trim();
  if (VARIABLE_FONTS.has(canonical)) return null;
  return STATIC_WEIGHT_OVERRIDES[canonical] ?? ["400", "700"];
}

export function hasItalic(family: string): boolean {
  return ITALIC_FONTS.has(canonicalFont(family)?.family ?? family.trim());
}

// Generic CSS fallback for a family, used in font stacks so a mockup still
// reads right for the ~100ms before the webfont lands.
export function genericFamilyFor(family: string): "serif" | "sans-serif" | "monospace" {
  const entry = canonicalFont(family);
  if (entry?.role === "mono") return "monospace";
  if (SERIF_FONTS.has(entry?.family ?? family.trim())) return "serif";
  return "sans-serif";
}

// Two lines, ≤ 900 chars: line one lists the catalog by role (distinctive
// first) — prompt.ts quotes just that line as "fonts available for a swap";
// line two names the forbidden families so the model never has to guess.
export function renderFontsForPrompt(): string {
  const group = (role: FontRole) => `${role}: ${fontsForRole(role).map((f) => f.family).join(", ")}`;
  const line1 = `${group("display")}; ${group("body")}; ${group("mono")} (exact Google Fonts names, most distinctive first)`;
  const line2 = `Never: ${[...FORBIDDEN_FAMILIES].join(", ")} (generic AI-SaaS tells).`;
  return `${line1}\n${line2}`;
}
