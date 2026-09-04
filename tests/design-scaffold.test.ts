// scaffold.ts writes the per-project preview app. Rendering is tested as
// pure text; the disk paths run against a fresh mkdtemp root (cleaned up in
// after()). Nothing here runs npm — the real build verification is a
// separate, manual ship test.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SCAFFOLD_FILES,
  isBuilt,
  isInstalled,
  pageFile,
  prepareScaffold,
  previewDir,
  readMockupManifest,
  refreshTokenFiles,
  renderScaffoldFiles,
  upsertMockup,
} from "../src/design/scaffold.js";
import { PathError } from "../src/design/paths.js";
import { designMdTemplate } from "../src/design/templates.js";
import { parseTokens } from "../src/design/tokens.js";
import type { DesignTokens, ProjectRef } from "../src/design/types.js";

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eve-design-scaffold-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const project = (slug: string): ProjectRef => ({ slug, root: path.join(tmp, slug) });

const TOKENS: DesignTokens = {
  fonts: { display: "Instrument Serif", body: "Inter Tight", mono: "JetBrains Mono" },
  colors: { background: "#07090c", foreground: "#e8ecef", accent: "#2dd4a8", muted: "#11161c", border: "#1c232b" },
  radius: "0.5rem",
  mode: "dark",
  shadcn: { baseColor: "zinc", style: "new-york" },
};

// Round-trip through the template + parser so the test uses the same tokens
// a real project would (the parser canonicalises font names, etc.).
const tokens = parseTokens(designMdTemplate({ name: "Demo", tokens: TOKENS }));

// ── rendering ───────────────────────────────────────────────────────────────

test("renderScaffoldFiles: every SCAFFOLD_FILES entry is rendered, ≥13 files, nothing extra", () => {
  const files = renderScaffoldFiles(project("demo"), tokens);
  const keys = Object.keys(files).sort();
  assert.ok(keys.length >= 13, `expected ≥13 files, got ${keys.length}`);
  assert.deepEqual(keys, [...SCAFFOLD_FILES].sort());
  for (const rel of SCAFFOLD_FILES) assert.equal(typeof files[rel], "string", `${rel} must render to a string`);
});

test("renderScaffoldFiles: next.config is a static export under the preview basePath", () => {
  const files = renderScaffoldFiles(project("demo"), tokens);
  const next = files["next.config.mjs"]!;
  assert.match(next, /output:\s*"export"/);
  assert.match(next, /trailingSlash:\s*true/);
  assert.match(next, /basePath:\s*"\/api\/demo\/preview"/);
  assert.match(next, /assetPrefix:\s*"\/api\/demo\/preview"/);
  assert.match(next, /images:\s*\{\s*unoptimized:\s*true\s*\}/);
  assert.match(next, /ignoreBuildErrors:\s*false/);
  assert.match(next, /ignoreDuringBuilds:\s*true/);
});

test("renderScaffoldFiles: package.json is the pinned dependency set, named <slug>-preview", () => {
  const files = renderScaffoldFiles(project("demo"), tokens);
  const pkg = JSON.parse(files["package.json"]!) as {
    name: string;
    private: boolean;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(pkg.name, "demo-preview");
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.build, "next build");
  assert.equal(pkg.dependencies.next, "^15.3.0");
  assert.equal(pkg.dependencies.react, "^19.0.0");
  assert.equal(pkg.dependencies["tailwind-merge"], "^3.0.2");
  assert.equal(pkg.dependencies.motion, "^12.0.0");
  assert.equal(pkg.devDependencies.tailwindcss, "^3.4.17");
  assert.equal(pkg.devDependencies.typescript, "^5.7.0");
  // the override exists so a future pin can be tried without editing source
  const other = renderScaffoldFiles(project("demo"), tokens, { nextVersion: "^15.4.0" });
  assert.equal((JSON.parse(other["package.json"]!) as { dependencies: Record<string, string> }).dependencies.next, "^15.4.0");
});

test("renderScaffoldFiles: layout, index page, tsconfig and manifest agree on the conventions", () => {
  const files = renderScaffoldFiles(project("demo"), tokens);
  const layout = files["app/layout.tsx"]!;
  assert.match(layout, /import "\.\/globals\.css"/);
  assert.match(layout, /import \{ fontVars \} from "@\/lib\/fonts"/);
  assert.match(layout, /<html lang="en" className=\{cn\(fontVars, "dark"\)\}/);
  assert.match(layout, /min-h-dvh bg-background text-foreground font-body antialiased/);
  assert.match(layout, /title: "demo — design previews"/);
  // light mode drops the dark class
  const light = renderScaffoldFiles(project("demo"), { ...tokens, mode: "light" });
  assert.match(light["app/layout.tsx"]!, /className=\{cn\(fontVars, ""\)\}/);

  const page = files["app/page.tsx"]!;
  assert.match(page, /import rawManifest from "\.\.\/prism\/mockups\.json"/);
  assert.match(page, /import Link from "next\/link"/);
  // hrefs are basePath-relative: Next's <Link> prepends basePath itself
  assert.match(page, /href=\{`\/\$\{m\.feature\}\/\$\{m\.screen\}\/`\}/);
  assert.doesNotMatch(page, /href=\{`\/api\//);
  assert.match(page, /Nothing built yet/);

  const tsconfig = JSON.parse(files["tsconfig.json"]!) as { compilerOptions: Record<string, unknown> };
  assert.deepEqual(tsconfig.compilerOptions.paths, { "@/*": ["./*"] });
  assert.equal(tsconfig.compilerOptions.resolveJsonModule, true);
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.jsx, "preserve");
  assert.equal(tsconfig.compilerOptions.moduleResolution, "bundler");

  assert.deepEqual(JSON.parse(files["prism/mockups.json"]!), { project: "demo", mockups: [] });
  assert.match(files[".gitignore"]!, /node_modules\/\n\.next\/\nout\/\n\*\.tsbuildinfo/);
  assert.match(files["README.md"]!, /\/api\/demo\/preview\//);
  assert.match(files["README.md"]!, /edit design\.md/i);
  assert.equal(files["next-env.d.ts"]!.trim().split("\n").length, 2);
  assert.match(files["lib/utils.ts"]!, /twMerge\(clsx\(inputs\)\)/);
  assert.match(files["prism/component_catalog.md"]!, /grid-pattern/);
  // token-derived files come from tokens.ts renderers, not re-rendered here
  assert.match(files["app/globals.css"]!, /--primary: [\d. %]+; \/\* #2dd4a8 \*\//);
  assert.match(files["tailwind.config.ts"]!, /darkMode: \["class"\]/);
  assert.match(files["lib/fonts.ts"]!, /from "next\/font\/google"/);
  assert.equal((JSON.parse(files["components.json"]!) as { style: string }).style, "new-york");
});

test("renderScaffoldFiles rejects a non-slug project name", () => {
  assert.throws(() => renderScaffoldFiles({ slug: "Not Ok", root: tmp }, tokens), PathError);
});

// ── prepareScaffold ─────────────────────────────────────────────────────────

test("prepareScaffold writes every file once; a second call is a no-op that leaves the dir alone", () => {
  const ref = project("scaf");
  const first = prepareScaffold(ref, tokens);
  assert.equal(first.created, true);
  assert.equal(first.dir, previewDir(ref));
  assert.equal(first.dir, path.join(ref.root, ".prism", "preview"));
  assert.equal(first.files.length, SCAFFOLD_FILES.length);
  for (const rel of SCAFFOLD_FILES) {
    const abs = path.join(first.dir, rel);
    assert.ok(fs.existsSync(abs), `${rel} should exist`);
    assert.ok(first.files.includes(abs));
  }
  // the project layout came along for the ride
  assert.ok(fs.existsSync(path.join(ref.root, "features")));
  assert.ok(fs.existsSync(path.join(ref.root, ".prism", "references")));
  // no stray temp files from the atomic writes
  const strays = fs.readdirSync(first.dir).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(strays, []);

  // simulate an installed component + a hand edit, then re-run
  const marker = path.join(first.dir, "components", "ui", "button.tsx");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "export const Button = () => null;\n");
  fs.writeFileSync(path.join(first.dir, "app", "page.tsx"), "// hand-edited\n");
  const second = prepareScaffold(ref, { ...tokens, colors: { ...tokens.colors, accent: "#ff0000" } });
  assert.equal(second.created, false);
  assert.deepEqual(second.files, []);
  assert.equal(second.dir, first.dir);
  assert.equal(fs.readFileSync(marker, "utf8"), "export const Button = () => null;\n");
  assert.equal(fs.readFileSync(path.join(first.dir, "app", "page.tsx"), "utf8"), "// hand-edited\n");
  // and the token files were NOT touched by prepareScaffold either
  assert.match(fs.readFileSync(path.join(first.dir, "app", "globals.css"), "utf8"), /#2dd4a8/);
});

// ── refreshTokenFiles ───────────────────────────────────────────────────────

test("refreshTokenFiles rewrites only the token-derived files, and only when they changed", () => {
  const ref = project("refresh");
  prepareScaffold(ref, tokens);
  const dir = previewDir(ref);
  const pageBefore = fs.readFileSync(path.join(dir, "app", "page.tsx"), "utf8");

  // same tokens → nothing to write
  assert.deepEqual(refreshTokenFiles(ref, tokens), []);

  const retuned: DesignTokens = { ...tokens, colors: { ...tokens.colors, accent: "#ff5500" } };
  const written = refreshTokenFiles(ref, retuned);
  const rels = written.map((p) => path.relative(dir, p)).sort();
  assert.ok(rels.includes("app/globals.css"), `globals.css must be rewritten, got ${rels.join(", ")}`);
  for (const rel of rels) {
    assert.ok(["tailwind.config.ts", "app/globals.css", "lib/fonts.ts", "components.json"].includes(rel), `${rel} is not a token file`);
  }
  const css = fs.readFileSync(path.join(dir, "app", "globals.css"), "utf8");
  assert.match(css, /#ff5500/);
  assert.doesNotMatch(css, /#2dd4a8/);
  // non-token files are untouched
  assert.equal(fs.readFileSync(path.join(dir, "app", "page.tsx"), "utf8"), pageBefore);

  // a font change reaches lib/fonts.ts and tailwind.config.ts
  const refonted: DesignTokens = { ...retuned, fonts: { ...retuned.fonts, display: "Fraunces" } };
  const again = refreshTokenFiles(ref, refonted).map((p) => path.relative(dir, p));
  assert.ok(again.includes("lib/fonts.ts"));
  assert.match(fs.readFileSync(path.join(dir, "lib", "fonts.ts"), "utf8"), /Fraunces/);

  // tailwind.config.ts and components.json belong to the shadcn CLI after
  // scaffold (it patches keyframes into them) — a refresh never touches them
  fs.writeFileSync(path.join(dir, "components.json"), "{}\n");
  assert.ok(!refreshTokenFiles(ref, refonted).map((p) => path.relative(dir, p)).includes("components.json"));
  assert.equal(fs.readFileSync(path.join(dir, "components.json"), "utf8"), "{}\n");

  // CLI-appended keyframes in globals.css survive a token refresh (spliced, not overwritten)
  const cssPath = path.join(dir, "app", "globals.css");
  fs.appendFileSync(cssPath, "\n@keyframes cli-blink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }\n");
  const recolored: DesignTokens = { ...refonted, colors: { ...refonted.colors, accent: "#00aaff" } };
  refreshTokenFiles(ref, recolored);
  const after = fs.readFileSync(cssPath, "utf8");
  assert.match(after, /#00aaff/);
  assert.match(after, /cli-blink/);
});

// ── manifest ────────────────────────────────────────────────────────────────

test("mockup manifest: missing → empty; upsert sorts, replaces same feature+screen, round-trips", () => {
  const ref = project("manifest");
  assert.deepEqual(readMockupManifest(ref), { project: "manifest", mockups: [] });

  prepareScaffold(ref, tokens);
  assert.deepEqual(readMockupManifest(ref), { project: "manifest", mockups: [] });

  upsertMockup(ref, { feature: "landing", screen: "hero", title: "Landing hero", url: "/api/manifest/preview/landing/hero/", builtAt: "2026-08-15T10:00:00.000Z" });
  upsertMockup(ref, { feature: "auth", screen: "sign-in", title: "Sign in", url: "/api/manifest/preview/auth/sign-in/", builtAt: "2026-08-15T10:05:00.000Z" });
  upsertMockup(ref, { feature: "landing", screen: "faq", title: "FAQ", url: "/api/manifest/preview/landing/faq/", builtAt: "2026-08-15T10:06:00.000Z" });
  let m = readMockupManifest(ref);
  assert.deepEqual(
    m.mockups.map((e) => `${e.feature}/${e.screen}`),
    ["auth/sign-in", "landing/faq", "landing/hero"],
  );

  // rebuild of landing/hero replaces the entry rather than adding a second
  upsertMockup(ref, { feature: "landing", screen: "hero", title: "Landing hero v2", url: "/api/manifest/preview/landing/hero/", builtAt: "2026-08-15T11:00:00.000Z" });
  m = readMockupManifest(ref);
  assert.equal(m.mockups.length, 3);
  const hero = m.mockups.find((e) => e.feature === "landing" && e.screen === "hero")!;
  assert.equal(hero.title, "Landing hero v2");
  assert.equal(hero.builtAt, "2026-08-15T11:00:00.000Z");

  // what is on disk is exactly what the index page will import
  const onDisk = JSON.parse(fs.readFileSync(path.join(previewDir(ref), "prism", "mockups.json"), "utf8"));
  assert.deepEqual(onDisk, m);
  assert.deepEqual(Object.keys(onDisk), ["project", "mockups"]);

  // bad slugs never reach the file
  assert.throws(() => upsertMockup(ref, { feature: "../x", screen: "hero", title: "t", url: "u", builtAt: "b" }), PathError);
  assert.equal(readMockupManifest(ref).mockups.length, 3);

  // corruption is reported, not swallowed
  fs.writeFileSync(path.join(previewDir(ref), "prism", "mockups.json"), "{ not json");
  assert.throws(() => readMockupManifest(ref), /not valid JSON/);
  fs.writeFileSync(path.join(previewDir(ref), "prism", "mockups.json"), JSON.stringify({ project: "manifest", mockups: [{ feature: "x" }] }));
  assert.throws(() => readMockupManifest(ref), /malformed entry/);
});

// ── probes ──────────────────────────────────────────────────────────────────

test("isInstalled / isBuilt / pageFile probe the preview dir and reject traversal", () => {
  const ref = project("probes");
  prepareScaffold(ref, tokens);
  const dir = previewDir(ref);
  assert.equal(isInstalled(ref), false);
  fs.mkdirSync(path.join(dir, "node_modules", "next"), { recursive: true });
  assert.equal(isInstalled(ref), true);

  assert.equal(isBuilt(ref, "landing", "hero"), false);
  fs.mkdirSync(path.join(dir, "out", "landing", "hero"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "landing", "hero", "index.html"), "<!doctype html>");
  assert.equal(isBuilt(ref, "landing", "hero"), true);
  assert.equal(isBuilt(ref, "landing", "faq"), false);

  assert.equal(pageFile(ref, "landing", "hero"), path.join(dir, "app", "landing", "hero", "page.tsx"));
  assert.throws(() => pageFile(ref, "../../etc", "passwd"), PathError);
  assert.throws(() => pageFile(ref, "landing", "../hero"), PathError);
  assert.throws(() => pageFile(ref, "landing", "Hero Screen"), PathError);
  assert.throws(() => isBuilt(ref, "..", "hero"), PathError);
});
