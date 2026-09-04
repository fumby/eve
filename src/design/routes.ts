// The face server's window onto a design project's mockups. Each project's
// preview app is a Next.js static export at <root>/.prism/preview/out, built
// with basePath /api/<slug>/preview — and this module serves that folder under
// the very same prefix, so every URL Next baked into the HTML resolves against
// EVE's own origin: one server, no CORS, no second port to remember.
//
// The pure parts (matching the URL, deciding which file it means) are kept
// apart from the HTTP handler so they can be tested without a socket, and the
// handler takes its one lookup — slug → project root — as a dependency so the
// tests never touch config.json.
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { audit } from "../core/audit.js";
import { loadConfig } from "../core/config.js";

// Everything a Next static export can contain. Text types carry a charset so
// browsers never guess (a guessed charset on a UTF-8 page is mojibake in the
// mockup, which reads like a design bug to whoever is reviewing it).
export const PREVIEW_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

// Next's static export inlines its bootstrap script into the page, so
// script-src needs 'unsafe-inline'; Tailwind's runtime styles need the same
// for style-src. Fonts are self-hosted by next/font at build time and images
// are our own generated assets, so nothing needs an external origin — and
// frame-ancestors 'self' lets the face embed a mockup while keeping any other
// site from framing it.
export const PREVIEW_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'";

const TEXT = "text/plain; charset=utf-8";
const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_STORE = "no-store";

export const NOT_BUILT_REASON = "not built yet — run the dispatch again";

// /api/<kebab-slug>/preview, optionally followed by /<anything>.
const PREVIEW_RE = /^\/api\/([a-z0-9]+(?:-[a-z0-9]+)*)\/preview(?:\/(.*))?$/;

// Splits a request path into the project slug and the path inside the export.
// `rest` is "" for the bare prefix (with or without its trailing slash) and is
// still percent-encoded — resolvePreviewFile decodes it. Anything that isn't
// a preview URL returns null so the face server can fall through.
export function matchPreviewPath(pathname: string): { slug: string; rest: string } | null {
  const m = PREVIEW_RE.exec(pathname);
  const slug = m?.[1];
  if (!m || slug === undefined) return null;
  return { slug, rest: m[2] ?? "" };
}

// Where the composer's `next build` (output: "export") leaves the site.
export function previewOutDir(root: string): string {
  return path.join(root, ".prism", "preview", "out");
}

export type PreviewResolution =
  | { kind: "file"; path: string }
  | { kind: "redirect"; location: string }
  | { kind: "missing"; reason: string };

// Maps the path inside the export to a real file, mirroring how Next itself
// would route a static export:
//   ""            → index.html
//   _next/…       → as is (chunks, css, self-hosted fonts)
//   assets/…      → as is (generated images, copied from public/)
//   a/b.ext       → as is (anything with an extension is a file)
//   a/b/          → a/b/index.html (trailingSlash export layout)
//   a/b           → redirect to a/b/ — Next links to routes with a trailing
//                   slash and the export only writes a/b/index.html, so the
//                   slash-less form would otherwise 404 on every hand-typed URL
// The only filesystem access is the final existence check; everything before
// it is string work, so the containment guarantee doesn't depend on disk state.
export function resolvePreviewFile(outDir: string, rest: string): PreviewResolution {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return { kind: "missing", reason: "malformed percent-encoding in the URL" };
  }
  // ".." has no legitimate use here (the export is flat and Next's links are
  // absolute), NUL bytes only ever appear in attacks, and a backslash would
  // be a second separator on some platforms — refuse all three before any
  // path math, so the containment check below is belt AND braces.
  if (decoded.includes("..") || decoded.includes("\0") || decoded.includes("\\")) {
    return { kind: "missing", reason: "refusing a path with '..', a backslash or a NUL byte" };
  }

  let rel: string;
  if (decoded === "" || decoded === "/") rel = "index.html";
  // The prefix already ended in a slash, so a rest that starts with one is a
  // doubled slash — and path.resolve would read it as an absolute path.
  else if (decoded.startsWith("/")) return { kind: "missing", reason: "that path points outside the preview folder" };
  else if (decoded.startsWith("_next/") || decoded.startsWith("assets/")) rel = decoded;
  else if (decoded.endsWith("/")) rel = decoded + "index.html";
  else if (decoded.slice(decoded.lastIndexOf("/") + 1).includes(".")) rel = decoded;
  else return { kind: "redirect", location: rest + "/" };

  const base = path.resolve(outDir);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) {
    return { kind: "missing", reason: "that path points outside the preview folder" };
  }
  // No out/ at all means the export was never produced (or was cleaned):
  // a different message from "this one screen isn't there", because the fix
  // is different — rebuild everything vs. check the feature/screen name.
  if (!fs.existsSync(base)) return { kind: "missing", reason: NOT_BUILT_REASON };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { kind: "missing", reason: `no such file: ${rel}` };
  }
  if (!stat.isFile()) return { kind: "missing", reason: `no such file: ${rel}` };
  return { kind: "file", path: abs };
}

export interface PreviewDeps {
  // slug → absolute design root, or null when EVE has no such project.
  resolveRoot: (slug: string) => string | null;
  // The already-parsed request path (the face server parses it once for all routes).
  pathname: string;
  // When the face sits behind a proxy that mounts it under a prefix, redirects
  // must carry it: it is stripped from `pathname` for matching if present and
  // always put back on the Location header. Default: none.
  basePrefix?: string;
  // Names listed in the unknown-slug 404 so a typo is obvious. Defaults to the
  // slugs configured under design.projects; injectable so tests need no config.
  knownSlugs?: () => string[];
}

function configuredSlugs(): string[] {
  try {
    return Object.keys(loadConfig().design.projects);
  } catch {
    return [];
  }
}

function text(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": TEXT, "Cache-Control": NO_STORE, ...extra });
  res.end(body);
}

// Returns false when the request isn't for a preview at all — nothing has
// been written, and the caller carries on with its own routes. Otherwise the
// response is fully handled here (200/301/404/405/500) and true comes back.
// This never throws: a broken preview must not take the face down.
export function handlePreviewRequest(req: IncomingMessage, res: ServerResponse, deps: PreviewDeps): boolean {
  const prefix = deps.basePrefix ?? "";
  const local = prefix && deps.pathname.startsWith(prefix + "/") ? deps.pathname.slice(prefix.length) : deps.pathname;
  const match = matchPreviewPath(local);
  if (!match) return false;

  try {
    serve(req, res, match.slug, match.rest, deps, prefix);
  } catch (err) {
    audit("design_preview_error", { slug: match.slug, rest: match.rest, error: String(err) });
    if (res.headersSent) res.destroy();
    else text(res, 500, `preview failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

function serve(
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  rest: string,
  deps: PreviewDeps,
  prefix: string,
): void {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    text(res, 405, `${method} is not allowed here — the preview is read-only (GET or HEAD)`, { Allow: "GET, HEAD" });
    return;
  }

  const root = deps.resolveRoot(slug);
  if (root === null) {
    const known = (deps.knownSlugs ?? configuredSlugs)();
    const hint = known.length > 0 ? `known projects: ${known.join(", ")}` : "none are configured under design.projects";
    text(res, 404, `no design project '${slug}' — ${hint}`);
    return;
  }

  const outDir = path.resolve(previewOutDir(root));
  const resolved = resolvePreviewFile(outDir, rest);

  if (resolved.kind === "redirect") {
    // Keep any query string: harmless for a static site, and dropping it would
    // surprise anyone passing state to a mockup by hand.
    const search = new URL(req.url ?? "/", "http://x").search;
    res.writeHead(301, {
      Location: `${prefix}/api/${slug}/preview/${resolved.location}${search}`,
      "Cache-Control": NO_STORE,
    });
    res.end();
    return;
  }
  if (resolved.kind === "missing") {
    text(res, 404, resolved.reason);
    return;
  }

  const stat = fs.statSync(resolved.path);
  // Next fingerprints everything under _next/static, so those may be cached
  // forever; HTML and assets keep their names across rebuilds, so a reviewer
  // must always see the latest export.
  const immutable = resolved.path.startsWith(path.join(outDir, "_next", "static") + path.sep);
  res.writeHead(200, {
    "Content-Type": PREVIEW_MIME[path.extname(resolved.path).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Security-Policy": PREVIEW_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": immutable ? IMMUTABLE : NO_STORE,
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  // pipeline (not .pipe) so a client that disconnects mid-download tears the
  // file stream down too, instead of leaving an open descriptor behind.
  pipeline(fs.createReadStream(resolved.path), res, () => {
    // Either finished or the client went away — nothing left to say either way.
  });
}
