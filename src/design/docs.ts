// The design agent's filing cabinet: one design root per project holding
// design.md, .prism/brief.md, .prism/references/<feature>/ and
// features/<slug>.md. Every path goes through assertWithinProject so neither
// EVE nor Claude Code can write outside a project root, and every write is
// atomic so a half-written design.md is never read back.
import fs from "node:fs";
import path from "node:path";
import { audit } from "../core/audit.js";
import { writeFileAtomic } from "../core/atomic.js";
import { loadConfig } from "../core/config.js";
import { assertSlug, assertWithinProject, expandProjectPath } from "./paths.js";
import { isKnownFont } from "./fonts.js";
import { briefTemplate, designMdTemplate, featureTemplate } from "./templates.js";
import { hexToHslParts, normalizeHex } from "./tokens.js";
import type { DesignTokens, ProjectRef } from "./types.js";

const DESIGN_MD = "design.md";
const BRIEF_MD = path.join(".prism", "brief.md");
const REFERENCES_DIR = path.join(".prism", "references");
const FEATURES_DIR = "features";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
// Directories a listing never descends into — the preview app's node_modules
// alone would swamp any prompt.
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "out", "dist"]);

// ── project resolution ──────────────────────────────────────────────────────

export function listProjects(): ProjectRef[] {
  const projects = loadConfig().design?.projects ?? {};
  return Object.entries(projects).map(([slug, p]) => ({ slug, root: expandProjectPath(p) }));
}

// Split out from resolveProjectRoot so the error path is testable without a
// config.json on disk.
export function resolveFromMap(map: Record<string, string>, slug: string): ProjectRef {
  assertSlug(slug, "project slug");
  const known = Object.keys(map);
  const p = map[slug];
  if (p === undefined) {
    throw new Error(
      known.length
        ? `unknown design project "${slug}" — known projects: ${known.join(", ")}`
        : `unknown design project "${slug}" — no design projects are configured (config.json → design.projects)`,
    );
  }
  return { slug, root: expandProjectPath(p) };
}

export function resolveProjectRoot(slug: string): ProjectRef {
  return resolveFromMap(loadConfig().design?.projects ?? {}, slug);
}

// mkdir -p for the fixed layout; safe to call before every operation.
export function ensureProjectLayout(ref: ProjectRef): void {
  for (const rel of ["", ".prism", REFERENCES_DIR, FEATURES_DIR]) {
    fs.mkdirSync(path.join(ref.root, rel), { recursive: true });
  }
}

// ── generic file access ─────────────────────────────────────────────────────

export function readProjectFile(ref: ProjectRef, rel: string): string | null {
  const abs = assertWithinProject(ref.root, rel);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
    throw err;
  }
}

// Root-relative POSIX paths of the files under relDir (recursive, skipping
// build/dependency dirs), sorted. exts filters by extension when given
// (".md" or "md" both work). A missing dir is an empty list, not an error.
export function listProjectFiles(ref: ProjectRef, relDir: string, exts?: string[]): string[] {
  const base = assertWithinProject(ref.root, relDir);
  const wanted = exts?.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (wanted && !wanted.includes(path.extname(e.name).toLowerCase())) continue;
      out.push(path.relative(ref.root, abs).split(path.sep).join("/"));
    }
  };
  walk(base);
  return out.sort();
}

function writeProjectFile(ref: ProjectRef, rel: string, text: string, event: string): string {
  const abs = assertWithinProject(ref.root, rel);
  ensureProjectLayout(ref);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  writeFileAtomic(abs, text.endsWith("\n") ? text : text + "\n");
  audit(event, { project: ref.slug, path: abs, bytes: Buffer.byteLength(text) });
  return abs;
}

// ── the three documents ─────────────────────────────────────────────────────

export function readDesignDoc(ref: ProjectRef): string | null {
  return readProjectFile(ref, DESIGN_MD);
}

export function readBrief(ref: ProjectRef): string | null {
  return readProjectFile(ref, BRIEF_MD);
}

function featurePath(featureSlug: string): string {
  return path.join(FEATURES_DIR, `${assertSlug(featureSlug, "feature slug")}.md`);
}

export function readFeatureDoc(ref: ProjectRef, featureSlug: string): string | null {
  return readProjectFile(ref, featurePath(featureSlug));
}

export function writeDesignDoc(ref: ProjectRef, text: string): string {
  return writeProjectFile(ref, DESIGN_MD, text, "design_doc_written");
}

export function writeBrief(ref: ProjectRef, text: string): string {
  return writeProjectFile(ref, BRIEF_MD, text, "design_brief_written");
}

export function writeFeatureDoc(ref: ProjectRef, featureSlug: string, text: string): string {
  return writeProjectFile(ref, featurePath(featureSlug), text, "design_feature_written");
}

function humanize(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Adds "- <YYYY-MM-DD> <line>" at the end of the ## Log section (or appends a
// ## Log section if the doc predates it). Creates the doc from the template
// when it does not exist yet, so a log line can never be lost for want of a
// file. `now` is injectable for tests.
export function appendFeatureLog(ref: ProjectRef, featureSlug: string, line: string, now: Date = new Date()): void {
  const slug = assertSlug(featureSlug, "feature slug");
  const existing =
    readFeatureDoc(ref, slug) ??
    featureTemplate({
      slug,
      title: humanize(slug),
      intent: "Opened by a log entry before the feature was briefed — the intent gets written on the first dispatch.",
    });
  const entry = `- ${now.toISOString().slice(0, 10)} ${line.trim().replace(/\s*\n\s*/g, " ")}`;
  const lines = existing.replace(/\s+$/, "").split("\n");
  const logIdx = lines.findIndex((l) => /^##\s+Log\s*$/.test(l));
  let next: string;
  if (logIdx === -1) {
    next = [...lines, "", "## Log", "", entry].join("\n") + "\n";
  } else {
    // The Log section runs to the next "## " heading or the end of the doc.
    let end = lines.length;
    for (let i = logIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }
    // Trim blank lines at the section tail so entries stay contiguous.
    let tail = end;
    while (tail > logIdx + 1 && (lines[tail - 1] ?? "").trim() === "") tail--;
    const before = lines.slice(0, tail);
    const after = lines.slice(end);
    next = [...before, ...(tail === logIdx + 1 ? [""] : []), entry, ...(after.length ? ["", ...after] : [])].join("\n") + "\n";
  }
  writeFeatureDoc(ref, slug, next);
}

// ── reference images (Tier 7) ───────────────────────────────────────────────

export function referencesDir(ref: ProjectRef, featureSlug: string): string {
  return path.join(ref.root, REFERENCES_DIR, assertSlug(featureSlug, "feature slug"));
}

export function listReferenceImages(ref: ProjectRef, featureSlug: string): string[] {
  const dir = referencesDir(ref, featureSlug);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort();
}

// Each entry is a bare filename (looked up in the feature's references dir)
// or a path relative to the project root. Everything is checked before
// anything is returned so the caller gets every problem in one message.
export function validateReferenceImages(ref: ProjectRef, featureSlug: string, given: string[]): string[] {
  const dir = referencesDir(ref, featureSlug);
  const problems: string[] = [];
  const out: string[] = [];
  for (const raw of given) {
    // "./hero.png" means the same as "hero.png".
    const entry = String(raw).trim().replace(/^(?:\.\/)+/, "");
    if (!entry) {
      problems.push("an empty entry");
      continue;
    }
    if (path.isAbsolute(entry) || entry.startsWith("/") || entry.startsWith("\\")) {
      problems.push(`"${entry}" is an absolute path — give a filename in .prism/references/${featureSlug}/ or a path relative to the project root`);
      continue;
    }
    if (entry.split(/[\\/]/).includes("..")) {
      problems.push(`"${entry}" climbs out of the project (..) — not allowed`);
      continue;
    }
    const ext = path.extname(entry).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      problems.push(`"${entry}" is not an image we can use — reference images must be .png, .jpg, .jpeg or .webp`);
      continue;
    }
    const abs = entry.includes("/") ? assertWithinProject(ref.root, entry) : path.join(dir, entry);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      problems.push(`"${entry}" does not exist (looked at ${abs})`);
      continue;
    }
    out.push(abs);
  }
  if (problems.length) {
    throw new Error(`reference images for ${ref.slug}/${featureSlug}: ${problems.join("; ")}`);
  }
  return out;
}

// ── bootstrap ───────────────────────────────────────────────────────────────

interface ScanFindings {
  name: string | null;
  description: string | null;
  readmeHeading: string | null;
  readmeParagraph: string | null;
  cssFiles: string[];
  hexByFrequency: Array<[string, number]>;
  hasEveIdentity: boolean;
  identityParagraph: string | null;
  notes: string[];
}

function readIfFile(p: string): string | null {
  try {
    return fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

// First "# heading" and the first non-heading, non-blank paragraph after it.
function headingAndParagraph(md: string): { heading: string | null; paragraph: string | null } {
  const lines = md.split("\n");
  let heading: string | null = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (m) {
      heading = m[1] ?? null;
      i++;
      break;
    }
  }
  const para: string[] = [];
  for (; i < lines.length; i++) {
    const l = (lines[i] ?? "").trim();
    if (!l) {
      if (para.length) break;
      continue;
    }
    if (l.startsWith("#") || l.startsWith("<!--")) {
      if (para.length) break;
      continue;
    }
    para.push(l);
  }
  return { heading, paragraph: para.length ? para.join(" ") : null };
}

// *.css / *.scss up to two directory levels below `root`, skipping the usual
// dependency and build dirs plus .prism (the preview app is generated from
// the very tokens we are trying to guess).
function findStylesheets(root: string, maxDepth = 2): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && e.name !== ".prism" && !e.name.startsWith(".")) walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (e.isFile() && /\.s?css$/i.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out.sort();
}

// A colour worth being *the* accent: clearly saturated and neither near-white
// nor near-black. Greys and page backgrounds are the most frequent hexes in
// any stylesheet, which is exactly why frequency alone would pick the wrong one.
function isAccentCandidate(hex: string): boolean {
  const { s, l } = hexToHslParts(hex);
  return s >= 0.3 && l >= 0.2 && l <= 0.8;
}

function scanRoot(root: string, f: ScanFindings): void {
  const pkg = readIfFile(path.join(root, "package.json"));
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { name?: unknown; description?: unknown };
      if (typeof j.name === "string" && !f.name) f.name = j.name;
      if (typeof j.description === "string" && !f.description) f.description = j.description;
      f.notes.push(`package.json at ${root}: name ${JSON.stringify(j.name ?? null)}`);
    } catch {
      f.notes.push(`package.json at ${root} did not parse`);
    }
  }
  for (const doc of ["README.md", "AGENT.md"]) {
    const text = readIfFile(path.join(root, doc));
    if (!text) continue;
    const { heading, paragraph } = headingAndParagraph(text);
    if (heading && !f.readmeHeading) f.readmeHeading = heading;
    if (paragraph && !f.readmeParagraph) f.readmeParagraph = paragraph;
    if (doc === "AGENT.md") f.hasEveIdentity = true;
    f.notes.push(`${doc} at ${root}: "${heading ?? "(no heading)"}"`);
  }
  const identity = readIfFile(path.join(root, "brain", "identity.md"));
  if (identity) {
    f.hasEveIdentity = true;
    const { paragraph } = headingAndParagraph(identity);
    if (paragraph && !f.identityParagraph) f.identityParagraph = paragraph;
    f.notes.push(`brain/identity.md at ${root} read`);
  }
  const counts = new Map<string, number>(f.hexByFrequency);
  for (const file of findStylesheets(root)) {
    const css = readIfFile(file);
    if (!css) continue;
    f.cssFiles.push(file);
    for (const m of css.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
      const hex = normalizeHex(m[0]);
      if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }
  f.hexByFrequency = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const DEFAULT_FORBIDDEN = [
  "no violet/cyan cyberpunk defaults",
  "no Space Grotesk / Plus Jakarta",
  "no stock-illustration people",
  "no decorative gradient fills on the accent",
  "no hero without a product surface",
];

// Writes design.md and .prism/brief.md when either is missing, guessing what
// it can from the surrounding repo and committing to concrete defaults for
// the rest — a bootstrapped project is immediately dispatchable, and every
// guess is written down in the brief's Bootstrap notes so it can be corrected.
export function bootstrapProject(
  ref: ProjectRef,
  opts?: { scanRoots?: string[] },
): { created: boolean; designMd: string; briefMd: string } {
  ensureProjectLayout(ref);
  const existingDesign = readDesignDoc(ref);
  const existingBrief = readBrief(ref);
  if (existingDesign !== null && existingBrief !== null) {
    return { created: false, designMd: existingDesign, briefMd: existingBrief };
  }

  const findings: ScanFindings = {
    name: null,
    description: null,
    readmeHeading: null,
    readmeParagraph: null,
    cssFiles: [],
    hexByFrequency: [],
    hasEveIdentity: false,
    identityParagraph: null,
    notes: [],
  };
  const roots = [ref.root, ...(opts?.scanRoots ?? [path.dirname(ref.root)])];
  for (const r of roots) scanRoot(expandProjectPath(r), findings);

  const isEve = ref.slug === "eve";
  // A short README heading is the best name we have; long ones are usually
  // taglines, so fall back to package.json's name, then the slug.
  const heading = findings.readmeHeading?.replace(/\s+[—:-].*$/, "").trim() ?? "";
  const name = isEve ? "EVE" : (heading && heading.length <= 40 ? heading : null) ?? findings.name ?? humanize(ref.slug);
  const accentPick = findings.hexByFrequency.find(([hex]) => isAccentCandidate(hex));
  const accent = accentPick?.[0] ?? "#2dd4a8";

  const fonts = { display: "Instrument Serif", body: "Inter Tight", mono: "JetBrains Mono" } as const;
  for (const fam of Object.values(fonts)) {
    // The defaults are catalog families by construction; this guards the
    // catalog being edited out from under them.
    if (!isKnownFont(fam)) throw new Error(`bootstrap default font "${fam}" is not in the font catalog`);
  }
  const tokens: DesignTokens = {
    fonts: { ...fonts },
    colors: {
      background: "#07090c",
      foreground: "#e8ecef",
      accent,
      muted: "#11161c",
      border: "#1c232b",
    },
    radius: "0.5rem",
    mode: "dark",
    shadcn: { baseColor: "zinc", style: "new-york" },
  };

  const description = findings.description ?? findings.readmeParagraph;
  const positioning = isEve
    ? "EVE — Umberto's voice-first assistant, business advisor and friend: playful, witty, empathetic. The interface is her face: a calm, live instrument that is visibly listening, thinking and speaking — never a chat window with a logo."
    : description
      ? `${name} — ${description}`
      : `${name} — a product that should read as designed on purpose: one accent, real typography, a live product surface in every hero.`;
  const persona = isEve
    ? "Umberto: business-administration student, Italian/English, builds and runs EVE himself. Wants an assistant that feels like a person who knows him — warm, quick, a little cheeky — and a face that looks like a hand-tuned instrument, not a dashboard template." +
      (findings.identityParagraph ? ` From brain/identity.md: ${findings.identityParagraph}` : "")
    : `The person who opens ${name} to get something specific done and judges it in the first two seconds: fluent, impatient with filler, reassured by precision.`;
  const goals = isEve
    ? [
        "Every mockup ships as a working static page under /api/eve/preview/ that Umberto can open on his phone.",
        "The face should make EVE feel present at idle (breathing, ticking, listening) without ever demanding attention.",
        "Keep each dispatch inside its USD cap; prefer one excellent screen over three passable ones.",
      ]
    : [
        `Ship product surfaces for ${name} that look decided, not defaulted.`,
        "Reuse the design system across features so every screen is recognisably the same product.",
        "Keep dispatches cheap: one screen, composed from shadcn + MagicUI parts, audited before it is shown.",
      ];
  const brandLanguage = [
    `${tokens.fonts.display} display over ${tokens.fonts.body} body, ${tokens.fonts.mono} for marginalia`,
    `dark, layered surfaces (${tokens.colors.background} → ${tokens.colors.muted}), hairline borders ${tokens.colors.border}`,
    `one accent ${accent} used precisely — the live indicator, the primary action, the number that just changed`,
    "continuous ambient motion: breathing pulse, scanline drift, ticker, blinking caret",
    "grid/dot texture at ≥ 0.4 opacity, layered under panels",
  ];
  const decisions = [
    "The tokens block in design.md is the only source of fonts and colours; generated files are never edited by hand.",
    "Every hero contains a real product surface composed in TSX.",
    "Type carries hierarchy; colour marks state. Two type sizes per surface, three at most.",
    "Motion is ambient and slow at idle, quick and quiet on interaction; reduced-motion keeps state and drops movement.",
    "shadcn/ui new-york primitives for anything interactive; MagicUI for texture and motion; lucide icons only.",
  ];
  const bootstrapNotes = [
    `bootstrapped ${new Date().toISOString().slice(0, 10)} by scanning ${roots.map((r) => expandProjectPath(r)).join(", ")}`,
    ...findings.notes,
    findings.cssFiles.length
      ? `stylesheets read: ${findings.cssFiles.join(", ")}`
      : "no stylesheets found within two levels — colours are the defaults",
    findings.hexByFrequency.length
      ? `most frequent hexes: ${findings.hexByFrequency.slice(0, 6).map(([h, n]) => `${h}×${n}`).join(", ")}`
      : "no hex colours found",
    accentPick
      ? `accent ${accent} picked as the most frequent saturated colour (${accentPick[1]} uses)`
      : `accent ${accent} is the default — no saturated colour stood out`,
    "fonts, radius, mode and the shadcn base are defaults — change them in design.md's tokens block, then re-dispatch",
  ];

  const designMd =
    existingDesign ??
    designMdTemplate({
      name,
      tokens,
      notes: `Bootstrapped from ${findings.name ? `package.json "${findings.name}"` : "defaults"}${description ? `: ${description}` : ""}. Edit the tokens block to retune; the prose below is the standing design system.`,
    });
  const briefMd =
    existingBrief ??
    briefTemplate({
      name,
      positioning,
      persona,
      goals,
      brandLanguage,
      decisions,
      forbidden: DEFAULT_FORBIDDEN,
      themes: [],
      bootstrapNotes,
    });

  const written: string[] = [];
  if (existingDesign === null) written.push(writeDesignDoc(ref, designMd));
  if (existingBrief === null) written.push(writeBrief(ref, briefMd));
  audit("design_bootstrap", { project: ref.slug, root: ref.root, written, accent });
  return { created: true, designMd, briefMd };
}
