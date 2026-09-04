// Shared contracts for EVE's head-of-design sub-agent. Everything under
// src/design/ codes against these; nothing here does I/O.
//
// The agent reads/writes three documents per project (design.md — the design
// system; .prism/brief.md — strategic memory; features/<slug>.md — per-feature
// spec), composes mockups on a per-project Next.js + Tailwind + shadcn app at
// <project>/.prism/preview/ by spawning Claude Code (Agent SDK), and the face
// server serves the static export under /api/<slug>/preview/.

// kebab-case: project slugs, feature slugs, screen names, image slugs.
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const HEX_RE = /^#(?:[0-9a-fA-F]{6})$/;

export interface ProjectRef {
  slug: string;
  // Absolute path to the project's design root (holds design.md, .prism/, features/).
  root: string;
}

// ── design.md tokens ────────────────────────────────────────────────────────
export type FontRole = "display" | "body" | "mono";
export type ShadcnBaseColor = "slate" | "gray" | "zinc" | "neutral" | "stone";
export type ShadcnStyle = "default" | "new-york";

export interface DesignTokens {
  // Google Font family names, exactly as next/font/google expects them.
  fonts: Record<FontRole, string>;
  // Hex strings (#rrggbb). background/foreground/accent/muted/border are
  // required; the rest fall back to sensible derivations in the renderer.
  colors: {
    background: string;
    foreground: string;
    accent: string;
    accentForeground?: string;
    muted: string;
    mutedForeground?: string;
    border: string;
    card?: string;
    destructive?: string;
  };
  // CSS length for --radius, e.g. "0.5rem".
  radius: string;
  mode: "dark" | "light";
  shadcn: { baseColor: ShadcnBaseColor; style: ShadcnStyle };
}

// ── component + font catalogs ───────────────────────────────────────────────
export type CatalogLibrary = "shadcn" | "magicui" | "framer-motion";

export interface CatalogEntry {
  name: string;
  library: CatalogLibrary;
  useFor: string;
  // Exact install command (or "" when it ships with the library install).
  install: string;
  // Import path inside the preview app once installed.
  importPath: string;
  docs?: string;
}

export interface FontEntry {
  family: string;
  role: FontRole;
  notes: string;
}

// ── composer (Claude Code via the Agent SDK) ────────────────────────────────
export type DesignEventKind =
  | "info" // planner/orchestration narration
  | "cc_tool" // Claude Code used a tool: text = "Read design.md"
  | "cc_text" // Claude Code said something (trimmed)
  | "cc_result" // Claude Code finished: text = summary, detail = cost/turns
  | "image" // an image was generated
  | "audit" // TSX audit line
  | "warn"
  | "error";

export interface DesignEvent {
  at: string; // ISO
  dispatchId: string;
  kind: DesignEventKind;
  text: string;
  detail?: Record<string, unknown>;
}

export type DesignEventSink = (event: DesignEvent) => void;

export interface ComposerRequest {
  dispatchId: string;
  // Claude Code's cwd — the project design root (design.md, .prism/, features/).
  projectRoot: string;
  prompt: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  onEvent: DesignEventSink;
  signal?: AbortSignal;
}

export interface ComposerResult {
  ok: boolean;
  // SDK result subtype: success | error_max_turns | error_max_budget_usd |
  // error_during_execution | aborted | spawn_failed
  subtype: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  sessionId: string | null;
  resultText: string;
  permissionDenials: Array<{ tool: string; input?: unknown }>;
  errors: string[];
  // Where the full options object for this run was logged (logs/design/…).
  optionsLogPath: string;
}

// ── images ──────────────────────────────────────────────────────────────────
export type ImageQuality = "standard" | "premium";
export type ImageAspect = "16:9" | "1:1" | "4:3" | "3:2" | "9:16";

export interface ImageRequest {
  project: ProjectRef;
  featureSlug: string;
  slug: string;
  prompt: string;
  quality: ImageQuality;
  aspect?: ImageAspect;
}

export interface ImageResult {
  // Full URL with the preview basePath baked in: /api/<slug>/preview/assets/<feature>/<slug>.png
  url: string;
  // Absolute path on disk (under .prism/preview/public/assets/).
  path: string;
  model: string;
  costUsd: number;
}

// ── TSX audit (Tier 6) ──────────────────────────────────────────────────────
export interface AuditCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AuditReport {
  pass: boolean;
  checks: AuditCheck[];
}

// ── the dispatch result EVE relays ──────────────────────────────────────────
export interface MockupResult {
  dispatchId: string;
  project: string;
  featureSlug: string;
  screenName: string;
  ok: boolean;
  // Served URL (path only, host-relative): /api/<slug>/preview/<feature>/<screen>/
  url: string | null;
  pagePath: string; // .prism/preview/app/<feature>/<screen>/page.tsx
  indexPath: string; // .prism/preview/out/<feature>/<screen>/index.html
  images: ImageResult[];
  audit: AuditReport | null;
  composer: ComposerResult | null;
  costUsd: number; // planner + composer + images
  openQuestions: string[];
  summary: string;
}

// ── URL helpers (pure) ──────────────────────────────────────────────────────
export function previewBasePath(projectSlug: string): string {
  return `/api/${projectSlug}/preview`;
}

export function mockupUrl(projectSlug: string, featureSlug: string, screenName: string): string {
  return `${previewBasePath(projectSlug)}/${featureSlug}/${screenName}/`;
}

export function assetUrl(projectSlug: string, featureSlug: string, imageSlug: string): string {
  return `${previewBasePath(projectSlug)}/assets/${featureSlug}/${imageSlug}.png`;
}
