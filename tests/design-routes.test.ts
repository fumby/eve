// The preview route: pure matching/resolution first, then the real handler on
// a real socket against a throwaway static export — no network beyond
// 127.0.0.1, no config.json (the slug lookup is injected).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  PREVIEW_MIME,
  PREVIEW_CSP,
  NOT_BUILT_REASON,
  matchPreviewPath,
  resolvePreviewFile,
  previewOutDir,
  handlePreviewRequest,
  type PreviewDeps,
} from "../src/design/routes.js";

// ---------------------------------------------------------------- fixture
const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-preview-"));
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eve-preview-empty-")); // never built
const out = previewOutDir(root);

const FILES: Record<string, string | Buffer> = {
  "index.html": "<!doctype html><title>root</title>",
  "_next/static/chunks/a.js": "console.log('a')",
  "_next/static/css/a.css": "body{margin:0}",
  "assets/f/img.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "landing/hero/index.html": "<!doctype html><title>hero</title>",
};
for (const [rel, body] of Object.entries(FILES)) {
  const abs = path.join(out, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

const deps: Omit<PreviewDeps, "pathname"> = {
  resolveRoot: (slug) => (slug === "demo" ? root : slug === "empty" ? emptyRoot : null),
  knownSlugs: () => ["demo", "empty"],
};

function startServer(extra: Partial<PreviewDeps> = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (handlePreviewRequest(req, res, { ...deps, ...extra, pathname })) return;
    // Anything the preview route declined must reach here untouched: if the
    // handler had written a header, this writeHead would throw.
    res.writeHead(418, { "X-Fell-Through": "1", "Content-Type": "text/plain" });
    res.end("fell through");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

let base = "";
let stop: () => Promise<void> = async () => {};

before(async () => {
  const s = await startServer();
  base = s.url;
  stop = s.close;
});

after(async () => {
  await stop();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(emptyRoot, { recursive: true, force: true });
});

const get = (p: string, init: RequestInit = {}) => fetch(base + p, { redirect: "manual", ...init });

// ---------------------------------------------------------------- MIME + CSP
test("MIME map: text types carry a charset, binaries don't", () => {
  assert.equal(PREVIEW_MIME[".html"], "text/html; charset=utf-8");
  assert.equal(PREVIEW_MIME[".js"], "text/javascript; charset=utf-8");
  assert.equal(PREVIEW_MIME[".css"], "text/css; charset=utf-8");
  assert.equal(PREVIEW_MIME[".json"], "application/json; charset=utf-8");
  assert.equal(PREVIEW_MIME[".webmanifest"], "application/manifest+json; charset=utf-8");
  assert.equal(PREVIEW_MIME[".png"], "image/png");
  assert.equal(PREVIEW_MIME[".woff2"], "font/woff2");
  assert.equal(PREVIEW_MIME[".svg"], "image/svg+xml");
  for (const ext of [".mjs", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".ttf", ".txt", ".map", ".xml"]) {
    assert.ok(PREVIEW_MIME[ext], `${ext} is mapped`);
  }
  assert.match(PREVIEW_CSP, /script-src 'self' 'unsafe-inline'/);
  assert.match(PREVIEW_CSP, /frame-ancestors 'self'/);
});

// ---------------------------------------------------------------- matchPreviewPath
test("matchPreviewPath: bare prefix, trailing slash, nested rest, kebab slugs", () => {
  assert.deepEqual(matchPreviewPath("/api/demo/preview"), { slug: "demo", rest: "" });
  assert.deepEqual(matchPreviewPath("/api/demo/preview/"), { slug: "demo", rest: "" });
  assert.deepEqual(matchPreviewPath("/api/my-app-2/preview/landing/hero/"), {
    slug: "my-app-2",
    rest: "landing/hero/",
  });
  assert.deepEqual(matchPreviewPath("/api/demo/preview/_next/static/chunks/a.js"), {
    slug: "demo",
    rest: "_next/static/chunks/a.js",
  });
  // rest stays percent-encoded — decoding is resolvePreviewFile's job
  assert.deepEqual(matchPreviewPath("/api/demo/preview/a%20b/"), { slug: "demo", rest: "a%20b/" });
});

test("matchPreviewPath: everything else is null so the face falls through", () => {
  for (const p of [
    "/",
    "/api/mind-map",
    "/api/Demo/preview",
    "/api/-bad/preview",
    "/api/bad-/preview",
    "/api/a--b/preview",
    "/api/demo/previews",
    "/api/demo/preview-x",
    "/api/demo/",
    "/apix/demo/preview",
    "/mind/api/demo/preview",
  ]) {
    assert.equal(matchPreviewPath(p), null, p);
  }
});

// ---------------------------------------------------------------- resolvePreviewFile
test("resolvePreviewFile: root index, routes, _next and assets map to files", () => {
  assert.deepEqual(resolvePreviewFile(out, ""), { kind: "file", path: path.join(out, "index.html") });
  assert.deepEqual(resolvePreviewFile(out, "/"), { kind: "file", path: path.join(out, "index.html") });
  assert.deepEqual(resolvePreviewFile(out, "landing/hero/"), {
    kind: "file",
    path: path.join(out, "landing/hero/index.html"),
  });
  assert.deepEqual(resolvePreviewFile(out, "_next/static/chunks/a.js"), {
    kind: "file",
    path: path.join(out, "_next/static/chunks/a.js"),
  });
  assert.deepEqual(resolvePreviewFile(out, "assets/f/img.png"), {
    kind: "file",
    path: path.join(out, "assets/f/img.png"),
  });
  // percent-encoding is undone before the lookup
  assert.deepEqual(resolvePreviewFile(out, "landing%2Fhero%2F"), {
    kind: "file",
    path: path.join(out, "landing/hero/index.html"),
  });
});

test("resolvePreviewFile: a slash-less route redirects to its trailing-slash form", () => {
  assert.deepEqual(resolvePreviewFile(out, "landing/hero"), { kind: "redirect", location: "landing/hero/" });
  assert.deepEqual(resolvePreviewFile(out, "landing"), { kind: "redirect", location: "landing/" });
  // …but a dotted last segment is a file, not a route
  assert.equal(resolvePreviewFile(out, "landing/hero.txt").kind, "missing");
});

test("resolvePreviewFile: traversal, NUL, backslash, bad escapes and absolute paths are all missing", () => {
  for (const rest of [
    "../package.json",
    "landing/../../x",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "..%2f..%2fetc%2fpasswd",
    "a..b.png",
    "x%00y.png",
    "a%5cb.png",
    "%zz",
    "/etc/passwd",
    "//etc/passwd",
  ]) {
    const r = resolvePreviewFile(out, rest);
    assert.equal(r.kind, "missing", rest);
    if (r.kind === "missing") assert.ok(r.reason.length > 0, rest);
  }
});

test("resolvePreviewFile: 'no such file' vs 'not built yet' are told apart", () => {
  const gone = resolvePreviewFile(out, "nope/");
  assert.equal(gone.kind, "missing");
  if (gone.kind === "missing") assert.match(gone.reason, /no such file: nope\/index\.html/);

  const dir = resolvePreviewFile(out, "_next/static/chunks/"); // a directory, not a file
  assert.equal(dir.kind, "missing");

  const unbuilt = resolvePreviewFile(previewOutDir(emptyRoot), "landing/hero/");
  assert.deepEqual(unbuilt, { kind: "missing", reason: NOT_BUILT_REASON });
});

test("previewOutDir joins the conventional export folder", () => {
  assert.equal(previewOutDir("/x/y"), path.join("/x/y", ".prism", "preview", "out"));
});

// ---------------------------------------------------------------- HTTP
test("GET a screen: 200, html, CSP, nosniff, referrer policy, no-store", async () => {
  const res = await get("/api/demo/preview/landing/hero/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("content-security-policy"), PREVIEW_CSP);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(FILES["landing/hero/index.html"] as string)));
  assert.equal(await res.text(), FILES["landing/hero/index.html"]);
});

test("GET the bare prefix (with and without slash) serves the root index", async () => {
  for (const p of ["/api/demo/preview", "/api/demo/preview/"]) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(await res.text(), FILES["index.html"]);
  }
});

test("GET a slash-less route: 301 to the trailing-slash form, query kept", async () => {
  const res = await get("/api/demo/preview/landing/hero");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/api/demo/preview/landing/hero/");
  await res.arrayBuffer();

  const q = await get("/api/demo/preview/landing/hero?x=1");
  assert.equal(q.status, 301);
  assert.equal(q.headers.get("location"), "/api/demo/preview/landing/hero/?x=1");
  await q.arrayBuffer();
});

test("GET an asset: 200 image/png, exact bytes, not cached", async () => {
  const res = await get("/api/demo/preview/assets/f/img.png");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, FILES["assets/f/img.png"]);
});

test("GET _next/static: immutable cache header, right types", async () => {
  const js = await get("/api/demo/preview/_next/static/chunks/a.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await js.text(), FILES["_next/static/chunks/a.js"]);

  const css = await get("/api/demo/preview/_next/static/css/a.css");
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(css.headers.get("cache-control"), "public, max-age=31536000, immutable");
  await css.arrayBuffer();
});

test("404 for an unknown slug names it and lists the known projects", async () => {
  const res = await get("/api/nope/preview/landing/hero/");
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /no design project 'nope'/);
  assert.match(body, /known projects: demo, empty/);
});

test("404 for a screen that isn't there, and for a project never built", async () => {
  const res = await get("/api/demo/preview/nope/");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /no such file/);

  const unbuilt = await get("/api/empty/preview/landing/hero/");
  assert.equal(unbuilt.status, 404);
  assert.equal(await unbuilt.text(), NOT_BUILT_REASON);
});

test("404 for traversal attempts (encoded dots and slashes)", async () => {
  // Fully-encoded separators survive URL parsing and reach the handler intact…
  const res = await get("/api/demo/preview/%2e%2e%2f%2e%2e%2fetc%2fpasswd");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /refusing a path/);

  const mixed = await get("/api/demo/preview/landing/..%2f..%2findex.html");
  assert.equal(mixed.status, 404);
  assert.match(await mixed.text(), /refusing a path/);

  // …while dot-segments with real slashes are collapsed by the URL parser
  // before matching, so they can't even name the preview prefix any more.
  const collapsed = await get("/api/demo/preview/%2e%2e/%2e%2e/etc/passwd");
  assert.equal(collapsed.status, 418);
  await collapsed.arrayBuffer();
});

test("405 for anything but GET/HEAD, with an Allow header", async () => {
  const res = await get("/api/demo/preview/landing/hero/", { method: "POST", body: "x" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
  assert.match(await res.text(), /read-only/);
});

test("HEAD returns the headers and no body", async () => {
  const res = await get("/api/demo/preview/landing/hero/", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(FILES["landing/hero/index.html"] as string)));
  assert.equal(res.headers.get("content-security-policy"), PREVIEW_CSP);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test("a non-preview path is declined untouched: handler returns false, nothing written", async () => {
  const res = await get("/mind/index.html");
  assert.equal(res.status, 418);
  assert.equal(res.headers.get("x-fell-through"), "1");
  await res.arrayBuffer();

  // And directly, with no socket at all: false comes back before res is touched.
  const untouched = { writeHead: () => assert.fail("must not write") } as unknown as http.ServerResponse;
  const ok = handlePreviewRequest({} as http.IncomingMessage, untouched, {
    resolveRoot: () => assert.fail("must not resolve"),
    pathname: "/api/mind-map",
  });
  assert.equal(ok, false);
});

test("basePrefix: stripped for matching, restored on the redirect Location", async () => {
  const s = await startServer({ basePrefix: "/eve" });
  try {
    const res = await fetch(`${s.url}/eve/api/demo/preview/landing/hero`, { redirect: "manual" });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/eve/api/demo/preview/landing/hero/");
    await res.arrayBuffer();
    // A proxy that strips the prefix before forwarding still gets it back on Location.
    const stripped = await fetch(`${s.url}/api/demo/preview/landing/hero`, { redirect: "manual" });
    assert.equal(stripped.status, 301);
    assert.equal(stripped.headers.get("location"), "/eve/api/demo/preview/landing/hero/");
    await stripped.arrayBuffer();
  } finally {
    await s.close();
  }
});
