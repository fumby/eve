// fonts.ts, tokens.ts and templates.ts are pure; these tests pin the contract
// the composer relies on: strict tokens parsing with every problem named,
// shadcn-format HSL, generated files that reference the right variables and
// identifiers, and templates that round-trip through the parser.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FONT_CATALOG,
  FORBIDDEN_FAMILIES,
  VARIABLE_FONTS,
  canonicalFont,
  fontsForRole,
  genericFamilyFor,
  googleFontImportName,
  isForbiddenFont,
  isKnownFont,
  renderFontsForPrompt,
  staticWeightsFor,
} from "../src/design/fonts.js";
import {
  TokenError,
  derivePalette,
  extractTokensBlock,
  hexToHsl,
  normalizeHex,
  parseTokens,
  renderComponentsJson,
  renderFontsTs,
  renderGlobalsCss,
  renderTailwindConfig,
  renderTokensYaml,
  tokensAreValid,
  tokensToPromptSummary,
} from "../src/design/tokens.js";
import { briefTemplate, designMdTemplate, featureTemplate } from "../src/design/templates.js";
import type { DesignTokens } from "../src/design/types.js";

const VALID_YAML = `fonts:
  display: "Instrument Serif"
  body: "Inter Tight"
  mono: "JetBrains Mono"
colors:
  background: "#07090c"
  foreground: "#e8ecef"
  accent: "#2DD4A8"
  muted: "#11161c"
  border: "#1c232b"
radius: "0.5rem"
mode: dark
shadcn:
  baseColor: zinc
  style: new-york
`;

const wrap = (yaml: string, fence = "```yaml tokens") =>
  `# X — Design System\n\nintro\n\n${fence}\n${yaml.endsWith("\n") ? yaml : yaml + "\n"}\`\`\`\n\n## Type\n\nprose\n`;

const TOKENS: DesignTokens = {
  fonts: { display: "Instrument Serif", body: "Inter Tight", mono: "JetBrains Mono" },
  colors: { background: "#07090c", foreground: "#e8ecef", accent: "#2dd4a8", muted: "#11161c", border: "#1c232b" },
  radius: "0.5rem",
  mode: "dark",
  shadcn: { baseColor: "zinc", style: "new-york" },
};

const failure = (yaml: string): string => {
  try {
    parseTokens(wrap(yaml));
  } catch (err) {
    assert.ok(err instanceof TokenError, "expected a TokenError");
    return err.message;
  }
  assert.fail("expected parseTokens to throw");
};

// ── fonts ───────────────────────────────────────────────────────────────────

test("font catalog: every role has entries, distinctive faces come first, no forbidden family sneaks in", () => {
  assert.ok(FONT_CATALOG.length >= 18);
  assert.equal(fontsForRole("display")[0]?.family, "Instrument Serif");
  assert.equal(fontsForRole("body")[0]?.family, "Inter Tight");
  assert.equal(fontsForRole("mono")[0]?.family, "JetBrains Mono");
  for (const f of FONT_CATALOG) {
    assert.ok(!isForbiddenFont(f.family), `${f.family} is both in the catalog and forbidden`);
    assert.match(f.family, /^[A-Z][A-Za-z0-9 ]+$/, `${f.family} is not an exact Google Fonts family name`);
    assert.ok(f.notes.length > 8);
  }
  const names = FONT_CATALOG.map((f) => f.family);
  assert.equal(new Set(names).size, names.length, "duplicate family in the catalog");
});

test("forbidden families include the generic-SaaS set and are matched case-insensitively", () => {
  for (const f of ["Space Grotesk", "Plus Jakarta Sans", "Poppins", "Montserrat", "Roboto", "Open Sans", "Lato", "Space Mono", "Arial", "Helvetica"]) {
    assert.ok(FORBIDDEN_FAMILIES.has(f), `${f} should be forbidden`);
  }
  assert.ok(isForbiddenFont("space grotesk"));
  assert.ok(isForbiddenFont("  POPPINS "));
  assert.ok(!isForbiddenFont("Inter Tight"));
  // A bare "Inter" in the forbidden set would make the TSX audit's substring
  // grep flag "interface"/"pointer" — keep it out.
  assert.ok(!FORBIDDEN_FAMILIES.has("Inter"));
});

test("isKnownFont: exact and case-insensitive, optional role check, canonical spelling", () => {
  assert.ok(isKnownFont("Instrument Serif"));
  assert.ok(isKnownFont("instrument serif"));
  assert.ok(isKnownFont("Instrument Serif", "display"));
  assert.ok(!isKnownFont("Instrument Serif", "mono"));
  assert.ok(!isKnownFont("Comic Sans MS"));
  assert.ok(!isKnownFont("Space Grotesk"));
  assert.equal(canonicalFont("jetbrains   mono")?.family, "JetBrains Mono");
});

test("googleFontImportName turns spaces into underscores", () => {
  assert.equal(googleFontImportName("Instrument Serif"), "Instrument_Serif");
  assert.equal(googleFontImportName("Source Sans 3"), "Source_Sans_3");
  assert.equal(googleFontImportName("IBM Plex Mono"), "IBM_Plex_Mono");
  assert.equal(googleFontImportName("Geist"), "Geist");
});

test("weights: variable families omit weight, static ones get their real weights", () => {
  assert.equal(staticWeightsFor("Inter Tight"), null);
  assert.equal(staticWeightsFor("Fraunces"), null);
  assert.deepEqual(staticWeightsFor("Instrument Serif"), ["400"]);
  assert.deepEqual(staticWeightsFor("DM Mono"), ["400", "500"]);
  assert.deepEqual(staticWeightsFor("IBM Plex Mono"), ["400", "700"]);
  for (const v of VARIABLE_FONTS) assert.ok(isKnownFont(v), `${v} in VARIABLE_FONTS but not in the catalog`);
  assert.equal(genericFamilyFor("Instrument Serif"), "serif");
  assert.equal(genericFamilyFor("Inter Tight"), "sans-serif");
  assert.equal(genericFamilyFor("JetBrains Mono"), "monospace");
});

test("renderFontsForPrompt is compact, grouped by role, distinctive first, ≤ 900 chars", () => {
  const s = renderFontsForPrompt();
  assert.ok(s.length <= 900, `too long: ${s.length}`);
  const first = s.split("\n")[0] ?? "";
  assert.match(first, /^display: Instrument Serif, Fraunces/);
  assert.match(first, /; body: Inter Tight/);
  assert.match(first, /; mono: JetBrains Mono/);
  assert.match(s, /Never: .*Space Grotesk/);
});

// ── tokens: extraction + parsing ────────────────────────────────────────────

test("extractTokensBlock finds only the ```yaml tokens fence", () => {
  assert.equal(extractTokensBlock(wrap(VALID_YAML)), VALID_YAML);
  assert.equal(extractTokensBlock(wrap(VALID_YAML, "```yaml tokens   ")), VALID_YAML);
  assert.equal(extractTokensBlock(wrap(VALID_YAML, "```yaml")), null);
  assert.equal(extractTokensBlock("# nothing here\n"), null);
  // Windows line endings still open the fence.
  assert.equal(extractTokensBlock("```yaml tokens\r\nradius: \"1px\"\n```\n"), 'radius: "1px"\n');
});

test("parseTokens: valid block, hex lower-cased, defaults applied, canonical font spelling", () => {
  const t = parseTokens(wrap(VALID_YAML.replace('"Instrument Serif"', '"instrument serif"')));
  assert.equal(t.fonts.display, "Instrument Serif");
  assert.equal(t.colors.accent, "#2dd4a8");
  assert.equal(t.mode, "dark");
  assert.deepEqual(t.shadcn, { baseColor: "zinc", style: "new-york" });
  assert.equal(t.colors.card, undefined);
  const noDefaults = parseTokens(wrap(VALID_YAML.replace(/mode: dark\nshadcn:\n  baseColor: zinc\n  style: new-york\n/, "")));
  assert.equal(noDefaults.mode, "dark");
  assert.deepEqual(noDefaults.shadcn, { baseColor: "zinc", style: "new-york" });
});

test("parseTokens: 3-digit hex expands to 6, optional colours are kept", () => {
  const t = parseTokens(wrap(VALID_YAML.replace('accent: "#2DD4A8"', 'accent: "#F0A"\n  card: "#123"\n  destructive: "#dc2626"')));
  assert.equal(t.colors.accent, "#ff00aa");
  assert.equal(t.colors.card, "#112233");
  assert.equal(t.colors.destructive, "#dc2626");
  assert.equal(normalizeHex("#ABC"), "#aabbcc");
  assert.equal(normalizeHex("#abcdeg"), null);
});

test("parseTokens: missing block, unparsable YAML, non-mapping", () => {
  assert.throws(() => parseTokens("# no tokens\n"), (e: unknown) => e instanceof TokenError && /^design\.md tokens block: missing/.test((e as Error).message));
  assert.match(failure("fonts: [unclosed"), /^design\.md tokens block: the YAML does not parse/);
  assert.match(failure("- just\n- a list\n"), /expected a YAML mapping/);
});

test("parseTokens: every validation failure is reported, together, with the prefix", () => {
  const msg = failure(`fonts:
  display: "Space Grotesk"
  body: "Comic Sans MS"
colors:
  background: "#07090c"
  foreground: not-a-colour
  accent: #2dd4a8
  muted: "#11161c"
radius: 8
mode: sepia
shadcn:
  baseColor: mauve
  style: old-york
`);
  assert.match(msg, /^design\.md tokens block: /);
  assert.match(msg, /fonts\.display: "Space Grotesk" is on the forbidden list .*catalog/);
  assert.match(msg, /fonts\.body: "Comic Sans MS" is not in the font catalog/);
  assert.match(msg, /fonts\.mono is missing/);
  assert.match(msg, /colors\.foreground: "not-a-colour" is not a hex colour/);
  // unquoted #hex is a YAML comment → reads as missing, and the message says why
  assert.match(msg, /colors\.accent is missing .*quoted/);
  assert.match(msg, /colors\.border is missing/);
  assert.match(msg, /radius: 8 must be a CSS length/);
  assert.match(msg, /mode: "sepia" must be "dark" or "light"/);
  assert.match(msg, /shadcn\.baseColor: "mauve" must be one of slate, gray, zinc, neutral, stone/);
  assert.match(msg, /shadcn\.style: "old-york" must be one of default, new-york/);
  // problems are joined into one message
  assert.ok(msg.split("; ").length >= 9, msg);
});

test("parseTokens: missing top-level sections and radius units", () => {
  assert.match(failure("radius: \"0.5rem\"\n"), /fonts is missing/);
  assert.match(failure("radius: \"0.5rem\"\n"), /colors is missing/);
  assert.match(failure(VALID_YAML.replace('radius: "0.5rem"', 'radius: "0.5"')), /radius: "0.5" must be a CSS length/);
  assert.match(failure(VALID_YAML.replace('radius: "0.5rem"', "")), /radius is missing/);
  assert.match(failure(VALID_YAML.replace('radius: "0.5rem"', 'radius: "12%"')), /radius: "12%" must be a CSS length/);
  for (const ok of ['"0px"', '"8px"', '"0.5rem"', '".75em"', '"1.25rem"']) {
    assert.doesNotThrow(() => parseTokens(wrap(VALID_YAML.replace('"0.5rem"', ok))), ok);
  }
});

test("tokensAreValid wraps parseTokens", () => {
  const good = tokensAreValid(wrap(VALID_YAML));
  assert.ok(good.ok && good.tokens.fonts.body === "Inter Tight");
  const bad = tokensAreValid(wrap(VALID_YAML.replace('"Inter Tight"', '"Poppins"')));
  assert.ok(!bad.ok && /Poppins/.test(bad.error));
});

// ── hexToHsl ────────────────────────────────────────────────────────────────

test("hexToHsl produces shadcn-format 'h s% l%' with 1-decimal precision", () => {
  assert.equal(hexToHsl("#0f172a"), "222.2 47.4% 11.2%"); // shadcn slate-900
  assert.equal(hexToHsl("#ffffff"), "0 0% 100%");
  assert.equal(hexToHsl("#000"), "0 0% 0%");
  assert.equal(hexToHsl("#ff0000"), "0 100% 50%");
  assert.equal(hexToHsl("#00ff00"), "120 100% 50%");
  assert.equal(hexToHsl("#0000ff"), "240 100% 50%");
  assert.equal(hexToHsl("#2dd4a8"), "164.2 66% 50.4%");
  assert.equal(hexToHsl("#18181B"), "240 5.9% 10%"); // shadcn zinc-900
  assert.throws(() => hexToHsl("blue"), TokenError);
});

// ── renderers ───────────────────────────────────────────────────────────────

test("renderTailwindConfig references CSS variables, font vars, radius, globs and the animate plugin", () => {
  const s = renderTailwindConfig(TOKENS);
  for (const v of ["--background", "--foreground", "--primary", "--muted", "--accent", "--border", "--input", "--ring", "--card", "--popover", "--destructive", "--secondary"]) {
    assert.ok(s.includes(`hsl(var(${v}))`), `missing ${v}`);
  }
  assert.ok(s.includes('display: ["var(--font-display)"'));
  assert.ok(s.includes('body: ["var(--font-body)"'));
  assert.ok(s.includes('mono: ["var(--font-mono)"'));
  assert.ok(s.includes('lg: "var(--radius)"'));
  for (const g of ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"]) assert.ok(s.includes(g), g);
  assert.ok(s.includes("tailwindcss-animate"));
  assert.ok(s.includes('darkMode: ["class"]'));
});

test("renderGlobalsCss: shadcn variable names, derived colours, dark on :root and .dark, fonts on body/headings", () => {
  const s = renderGlobalsCss(TOKENS);
  assert.ok(s.startsWith("@tailwind base;\n@tailwind components;\n@tailwind utilities;"));
  for (const v of [
    "--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground",
    "--primary", "--primary-foreground", "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
    "--accent", "--accent-foreground", "--destructive", "--destructive-foreground", "--border", "--input", "--ring", "--radius",
  ]) {
    assert.ok(new RegExp(`^\\s+${v}: `, "m").test(s), `missing ${v}`);
  }
  assert.ok(s.includes(`--primary: ${hexToHsl("#2dd4a8")}`), "primary = accent");
  assert.ok(s.includes(`--ring: ${hexToHsl("#2dd4a8")}`), "ring = accent");
  assert.ok(s.includes("--radius: 0.5rem"));
  assert.ok(s.includes(":root {"));
  assert.ok(s.includes(".dark {"));
  assert.equal((s.match(/color-scheme: dark;/g) ?? []).length, 2);
  assert.ok(s.includes("@apply bg-background text-foreground font-body;"));
  assert.ok(/h1, h2, h3, h4, h5, h6 \{\s+@apply font-display;/.test(s));

  const light = renderGlobalsCss({ ...TOKENS, mode: "light", colors: { ...TOKENS.colors, background: "#ffffff", foreground: "#111111" } });
  assert.ok(!light.includes(".dark {"));
  assert.ok(!light.includes("color-scheme: dark"));
});

test("derivePalette: card is background shifted 3%, provided optionals win, accent foreground reads over the accent", () => {
  const p = derivePalette(TOKENS);
  assert.equal(p.card, "#0d1016"); // #07090c lightened by 3% in HSL
  assert.equal(p.popover, p.card);
  assert.equal(p.primary, "#2dd4a8");
  assert.equal(p.primaryForeground, "#0b0f14"); // a bright mint wants dark text
  assert.equal(p.input, TOKENS.colors.border);
  assert.notEqual(p.accent, p.primary, "shadcn --accent is the hover surface, not the brand accent");
  const custom = derivePalette({ ...TOKENS, colors: { ...TOKENS.colors, card: "#123456", accentForeground: "#ffffff", mutedForeground: "#888888", destructive: "#ff0000" } });
  assert.equal(custom.card, "#123456");
  assert.equal(custom.primaryForeground, "#ffffff");
  assert.equal(custom.mutedForeground, "#888888");
  assert.equal(custom.destructive, "#ff0000");
  const light = derivePalette({ ...TOKENS, mode: "light", colors: { ...TOKENS.colors, background: "#ffffff" } });
  assert.equal(light.card, "#f7f7f7"); // darkened 3%
});

test("renderFontsTs imports the next/font/google identifiers, sets variables, weights only for static faces", () => {
  const s = renderFontsTs(TOKENS);
  assert.ok(s.includes('import { Instrument_Serif, Inter_Tight, JetBrains_Mono } from "next/font/google";'));
  assert.ok(/export const display = Instrument_Serif\(\{ subsets: \["latin"\], weight: \["400"\], style: \["normal", "italic"\], variable: "--font-display", display: "swap" \}\);/.test(s), s);
  assert.ok(/export const body = Inter_Tight\(\{ subsets: \["latin"\], variable: "--font-body", display: "swap" \}\);/.test(s), s);
  assert.ok(/export const mono = JetBrains_Mono\(\{ subsets: \["latin"\], variable: "--font-mono", display: "swap" \}\);/.test(s), s);
  assert.ok(s.includes('export const fontVars = [display.variable, body.variable, mono.variable].join(" ");'));
  // one family in two roles is imported once
  const dup = renderFontsTs({ ...TOKENS, fonts: { display: "Geist", body: "Geist", mono: "IBM Plex Mono" } });
  assert.ok(dup.includes('import { Geist, IBM_Plex_Mono } from "next/font/google";'));
  assert.ok(dup.includes('IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "700"]'));
});

test("renderComponentsJson is a valid shadcn components.json (documented fields only)", () => {
  const s = renderComponentsJson(TOKENS, { basePath: "/api/eve/preview" });
  const j = JSON.parse(s) as Record<string, unknown>;
  assert.equal(j.$schema, "https://ui.shadcn.com/schema.json");
  assert.equal(j.style, "new-york");
  assert.equal(j.rsc, true);
  assert.equal(j.tsx, true);
  assert.deepEqual(j.tailwind, { config: "tailwind.config.ts", css: "app/globals.css", baseColor: "zinc", cssVariables: true, prefix: "" });
  assert.deepEqual(j.aliases, { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui", lib: "@/lib", hooks: "@/hooks" });
  assert.equal(j.iconLibrary, "lucide");
  // shadcn's schema is strict at the top level: nothing undocumented may appear
  assert.deepEqual(Object.keys(j).sort(), ["$schema", "aliases", "iconLibrary", "rsc", "style", "tailwind", "tsx"]);
  const stone = JSON.parse(renderComponentsJson({ ...TOKENS, shadcn: { baseColor: "stone", style: "default" } }, { basePath: "" })) as { style: string; tailwind: { baseColor: string } };
  assert.equal(stone.style, "default");
  assert.equal(stone.tailwind.baseColor, "stone");
});

test("tokensToPromptSummary is one paragraph naming fonts, hexes, radius and mode", () => {
  const s = tokensToPromptSummary(TOKENS);
  assert.ok(!s.includes("\n"));
  for (const needle of ["Instrument Serif", "Inter Tight", "JetBrains Mono", "#07090c", "#e8ecef", "#2dd4a8", "#11161c", "#1c232b", "0.5rem", "dark"]) {
    assert.ok(s.includes(needle), needle);
  }
});

// ── templates ───────────────────────────────────────────────────────────────

test("designMdTemplate is complete, opinionated, placeholder-free and round-trips through parseTokens", () => {
  const md = designMdTemplate({ name: "Acme", tokens: TOKENS, notes: "bootstrapped from package.json" });
  assert.ok(md.startsWith("# Acme — Design System\n"));
  for (const h of ["## Type", "## Color", "## Motion", "## Layout & texture", "## Components", "## Voice of the UI"]) assert.ok(md.includes(`\n${h}\n`), h);
  assert.doesNotMatch(md, /TODO|TBD|REPLACE/);
  assert.match(md, /96–140px/);
  assert.match(md, /breathing pulse/);
  assert.match(md, /scanline drift/);
  assert.match(md, /ticker/);
  assert.match(md, /blinking caret/);
  assert.match(md, /0\.4 opacity/);
  assert.match(md, /shadcn/);
  assert.match(md, /MagicUI/);
  assert.ok(md.includes("bootstrapped from package.json"));
  assert.deepEqual(parseTokens(md), TOKENS);

  const full: DesignTokens = {
    ...TOKENS,
    mode: "light",
    colors: { ...TOKENS.colors, accentForeground: "#ffffff", mutedForeground: "#666666", card: "#fafafa", destructive: "#dc2626" },
    shadcn: { baseColor: "stone", style: "default" },
  };
  assert.deepEqual(parseTokens(designMdTemplate({ name: "Full", tokens: full })), full);
  assert.equal(renderTokensYaml(TOKENS).split("\n")[0], "fonts:");
});

test("briefTemplate has every section, the 'brief is law' note and nested forbidden moves", () => {
  const md = briefTemplate({
    name: "Acme",
    positioning: "Acme — tools for people who ship.",
    persona: "The impatient builder.",
    goals: ["ship", "stay legible"],
    brandLanguage: ["one accent"],
    decisions: ["type carries hierarchy"],
    forbidden: ["no Space Grotesk / Plus Jakarta", "no hero without a product surface"],
    themes: [],
    bootstrapNotes: ["scanned /tmp/x"],
  });
  assert.ok(md.startsWith("# Acme — Design Brief (private)\n"));
  assert.match(md, /The brief is law: when a request conflicts with a standing decision, the brief wins — surface the conflict, don't override\./);
  for (const h of ["## Positioning", "## Persona", "## Business goals", "## Brand language", "## Standing design decisions", "### Forbidden moves", "## Ongoing themes", "## Bootstrap notes"]) {
    assert.ok(md.includes(`\n${h}\n`), h);
  }
  assert.ok(md.indexOf("### Forbidden moves") > md.indexOf("## Standing design decisions"));
  assert.ok(md.indexOf("### Forbidden moves") < md.indexOf("## Ongoing themes"));
  assert.match(md, /- no Space Grotesk \/ Plus Jakarta/);
  assert.match(md, /## Ongoing themes\n\n- \(none yet\)/);
});

test("featureTemplate has the slug line, screens table and a Log section", () => {
  const md = featureTemplate({ slug: "landing-hero", title: "Landing hero", intent: "Make the hero a live product surface." });
  assert.ok(md.startsWith("# Landing hero\n\nslug: landing-hero\n"));
  assert.match(md, /## Intent\n\nMake the hero a live product surface\./);
  assert.match(md, /\| screen \| purpose \| status \| url \|/);
  for (const h of ["## Screens", "## Visual direction", "## Open questions", "## Log"]) assert.ok(md.includes(`\n${h}\n`), h);
  assert.doesNotMatch(md, /TODO|TBD|REPLACE/);
});

test("globals.css: the token region is fenced and splicing keeps CLI-appended keyframes", async () => {
  const { renderGlobalsCss, spliceGlobalsCss, GLOBALS_TOKENS_START, GLOBALS_TOKENS_END, parseTokens } = await import("../src/design/tokens.js");
  const { designMdTemplate } = await import("../src/design/templates.js");
  const tokens = parseTokens(designMdTemplate({ name: "T", tokens: {
    fonts: { display: "Instrument Serif", body: "Inter Tight", mono: "JetBrains Mono" },
    colors: { background: "#07090c", foreground: "#e8ecef", accent: "#2dd4a8", muted: "#11161c", border: "#1c232b" },
    radius: "0.5rem", mode: "dark", shadcn: { baseColor: "zinc", style: "new-york" } } }));
  const v1 = renderGlobalsCss(tokens);
  assert.ok(v1.includes(GLOBALS_TOKENS_START) && v1.includes(GLOBALS_TOKENS_END));
  const cliTail = "\n@keyframes blink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }\n";
  const onDisk = v1 + cliTail;
  const v2 = renderGlobalsCss({ ...tokens, colors: { ...tokens.colors, accent: "#ff6600" } });
  const spliced = spliceGlobalsCss(onDisk, v2);
  assert.ok(spliced, "splice should succeed when both have fences");
  assert.ok(spliced!.endsWith(cliTail), "CLI-appended keyframes must survive");
  assert.ok(spliced!.includes("#ff6600") && !spliced!.includes("#2dd4a8"), "token region must be replaced");
  assert.equal(spliceGlobalsCss("no fence here", v2), null);
});
