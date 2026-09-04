// Tier 6 audit: does the page TSX Claude Code wrote actually contain the
// visual elements the brief requires? Installing a component is not using it;
// "premium" in a prompt is not motion on screen. This is a cheap static read
// of the file — regexes over JSX, not a parser — tuned to catch the failure
// modes we know about (installed-but-unused, invisible texture, no product
// surface, nothing moving, 11px marginalia, dropped images) and to stay quiet
// otherwise. Pure: no I/O.
import { MAGICUI_BACKGROUNDS } from "./catalog.js";
import { FORBIDDEN_FAMILIES } from "./fonts.js";
import type { AuditCheck, AuditReport } from "./types.js";

export interface AuditOptions {
  // Image URLs the planner generated for this screen — each must appear verbatim.
  imageUrls?: string[];
  // Override the ambient-background component list (defaults to the catalog's).
  backgroundNames?: readonly string[];
}

const pascal = (kebab: string): string =>
  kebab
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");

// Every JSX opening tag for `Name`, with its attribute text (up to the closing
// `>` or `/>`). Good enough for className inspection.
function jsxTags(tsx: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(tsx)) !== null) out.push(m[1] ?? "");
  return out;
}

const classNamesOf = (attrs: string): string => {
  const m = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{cn\(([^)]*)\)\})/.exec(attrs);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? "").toString();
};

const LOW_OPACITY = /\bopacity-(?:0|5|10|15|20|25|30|35)\b|opacity-\[0?\.(?:0\d|1\d|2\d|3\d)\]/;

const MOTION_COMPONENTS = [
  "NumberTicker",
  "TypingAnimation",
  "Marquee",
  "AnimatedList",
  "OrbitingCircles",
  "BorderBeam",
  "AnimatedBeam",
  "Meteors",
  "Particles",
  "Ripple",
  "WordRotate",
  "MorphingText",
  "SparklesText",
  "AnimatedGridPattern",
  "FlickeringGrid",
  "AnimatedShinyText",
  "ShineBorder",
  "ScrollProgress",
  "AuroraText",
  "HyperText",
];

// Every place the TSX names a font family: CSS-in-JS fontFamily, Tailwind
// arbitrary font-[…] classes, and next/font/google import identifiers
// (Space_Grotesk → "Space Grotesk"). Quoted lists are split on commas.
export function fontFamiliesReferenced(tsx: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const css = /fontFamily\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
  while ((m = css.exec(tsx)) !== null) {
    for (const part of (m[1] ?? m[2] ?? m[3] ?? "").split(",")) {
      const f = part.trim().replace(/^["']|["']$/g, "");
      if (f) out.push(f);
    }
  }
  const tw = /\bfont-\[(?:'|")?([^\]'"]+)(?:'|")?\]/g;
  while ((m = tw.exec(tsx)) !== null) {
    for (const part of (m[1] ?? "").split(",")) {
      const f = part.trim().replace(/_/g, " ");
      if (f) out.push(f);
    }
  }
  const imp = /import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/g;
  while ((m = imp.exec(tsx)) !== null) {
    for (const raw of (m[1] ?? "").split(",")) {
      const ident = raw.trim().split(/\s+as\s+/)[0]?.trim();
      if (ident) out.push(ident.replace(/_/g, " "));
    }
  }
  return out;
}

const SURFACE_NAME =
  /\b(?:function|const)\s+([A-Z][A-Za-z0-9]*(?:Surface|Readout|Waveform|Terminal|Palette|Conversation|Transcript|Ticker|Status|Console|Excerpt|Monitor|Panel|Feed|Log))\b/g;

export function auditPageTsx(tsx: string, opts: AuditOptions = {}): AuditReport {
  const checks: AuditCheck[] = [];
  const backgrounds = opts.backgroundNames ?? MAGICUI_BACKGROUNDS;

  // 1. Ambient background texture — present AND visible.
  {
    const used = backgrounds.map(pascal).filter((n) => jsxTags(tsx, n).length > 0);
    if (used.length === 0) {
      checks.push({
        name: "background",
        ok: false,
        detail: `no ambient background component in the JSX (expected one of ${backgrounds.map(pascal).join(", ")} rendered as a tag)`,
      });
    } else {
      const dim = used.filter((n) => jsxTags(tsx, n).every((a) => LOW_OPACITY.test(classNamesOf(a))));
      checks.push({
        name: "background",
        ok: dim.length < used.length,
        detail:
          dim.length < used.length
            ? `uses ${used.join(", ")}`
            : `${used.join(", ")} present but every instance is at opacity ≤ 0.35 — the brief wants ≥ 0.4, visible at first glance`,
      });
    }
  }

  // 2. Inline product surface — a component that shows what the product does.
  {
    const names = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = SURFACE_NAME.exec(tsx)) !== null) names.add(m[1]!);
    SURFACE_NAME.lastIndex = 0;
    const rendered = [...names].filter((n) => jsxTags(tsx, n).length > 0);
    checks.push({
      name: "product-surface",
      ok: rendered.length > 0,
      detail:
        rendered.length > 0
          ? `product surface(s): ${rendered.join(", ")}`
          : "no product-surface component (a *Surface/*Readout/*Waveform/*Terminal/*Conversation/*Ticker/*Status function rendered in the page) — a hero without one is incomplete",
    });
  }

  // 3. Continuous motion — at least two independent things moving at idle.
  {
    const signals: string[] = [];
    for (const c of MOTION_COMPONENTS) if (jsxTags(tsx, c).length > 0) signals.push(c);
    const animateClasses = new Set(tsx.match(/\banimate-\[?[a-zA-Z0-9_\-().,%]+\]?/g) ?? []);
    for (const a of animateClasses) if (!/animate-none/.test(a)) signals.push(a);
    if (/@keyframes\s+[\w-]+/.test(tsx)) signals.push("@keyframes");
    if (/setInterval\s*\(/.test(tsx)) signals.push("setInterval");
    if (/repeat\s*:\s*Infinity/.test(tsx)) signals.push("motion repeat:Infinity");
    const distinct = [...new Set(signals)];
    checks.push({
      name: "continuous-motion",
      ok: distinct.length >= 2,
      detail:
        distinct.length >= 2
          ? `motion signals: ${distinct.slice(0, 6).join(", ")}`
          : `only ${distinct.length} motion signal(s) (${distinct.join(", ") || "none"}) — need ≥ 2 running continuously (ticker, breathing pulse, drifting particles, blinking caret…)`,
    });
  }

  // 4. Hover states on ≥ 3 elements.
  {
    const tags = tsx.match(/<[A-Za-z][^>]*>/g) ?? [];
    const hovering = tags.filter((t) => /\bhover:|whileHover=|group-hover:/.test(t)).length;
    checks.push({
      name: "hover-states",
      ok: hovering >= 3,
      detail: hovering >= 3 ? `${hovering} elements with hover states` : `${hovering} element(s) with hover states — need ≥ 3 (not just the CTA)`,
    });
  }

  // 5. Mono marginalia, ≥ 3, sized 14–16px (not text-xs / 11px).
  {
    const tags = tsx.match(/<[A-Za-z][^>]*>/g) ?? [];
    const mono = tags.filter((t) => /\bfont-mono\b/.test(t) && /\b(?:uppercase|tracking-)/.test(t));
    const sized = mono.filter((t) => !/\btext-(?:xs|\[1[01]px\]|\[0\.[67]\d*rem\])\b/.test(t));
    checks.push({
      name: "mono-marginalia",
      ok: sized.length >= 3,
      detail:
        sized.length >= 3
          ? `${sized.length} mono annotations at ≥ 14px`
          : `${mono.length} mono annotation(s), ${sized.length} sized ≥ 14px — need ≥ 3 at text-sm/14–16px (not text-xs/11px)`,
    });
  }

  // 6. Generated images referenced verbatim.
  if (opts.imageUrls && opts.imageUrls.length > 0) {
    const missing = opts.imageUrls.filter((u) => !tsx.includes(u));
    checks.push({
      name: "images-referenced",
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `all ${opts.imageUrls.length} generated image(s) referenced`
          : `generated image(s) NOT referenced verbatim: ${missing.join(", ")} — use the full URL in an <img src>`,
    });
  }

  // 7. Client directive when the page uses client-only features.
  {
    const needsClient = /\b(?:useEffect|useState|useRef|onClick|onMouse|motion\.)/.test(tsx);
    const hasClient = /^\s*["']use client["']/.test(tsx);
    checks.push({
      name: "client-directive",
      ok: !needsClient || hasClient,
      detail: !needsClient
        ? "server component (no hooks/handlers)"
        : hasClient
          ? '"use client" present'
          : 'page uses hooks/handlers but has no "use client" directive at the top — the build will fail',
    });
  }

  // 8. Forbidden fonts never sneak in by name — checked only where a font is
  //    actually named (fontFamily:, font-[…], next/font/google imports), as
  //    whole family names: "Inter Tight" is fine, "setInterval" is not a font.
  {
    const forbidden = new Map([...FORBIDDEN_FAMILIES].map((f) => [f.toLowerCase(), f]));
    const hit = [...new Set(fontFamiliesReferenced(tsx).map((f) => forbidden.get(f.toLowerCase())).filter((f): f is string => !!f))];
    checks.push({
      name: "no-forbidden-fonts",
      ok: hit.length === 0,
      detail: hit.length === 0 ? "no forbidden font families" : `forbidden font family referenced: ${hit.join(", ")}`,
    });
  }

  // 9. Imported components are used (installed ≠ used).
  {
    const unused: string[] = [];
    const re = /import\s*\{([^}]*)\}\s*from\s*["']@\/components\/(?:ui|magicui)\/[^"']+["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tsx)) !== null) {
      for (const raw of m[1]!.split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Z]/.test(name) && jsxTags(tsx, name).length === 0 && !new RegExp(`\\b${name}\\b`).test(tsx.slice(m.index + m[0].length))) {
          unused.push(name);
        }
      }
    }
    checks.push({
      name: "imports-used",
      ok: unused.length === 0,
      detail: unused.length === 0 ? "every imported component is rendered" : `imported but never rendered: ${unused.join(", ")}`,
    });
  }

  const required = new Set([
    "background",
    "product-surface",
    "continuous-motion",
    "hover-states",
    "mono-marginalia",
    "images-referenced",
    "client-directive",
    "no-forbidden-fonts",
  ]);
  const pass = checks.every((c) => c.ok || !required.has(c.name));
  return { pass, checks };
}

export function renderAuditForPrompt(report: AuditReport): string {
  return report.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n");
}
