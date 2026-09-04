// docs.ts is the only design module that touches disk. Everything here runs
// against a fresh mkdtemp directory (cleaned up in after()), never against
// config.json — project resolution is exercised through resolveFromMap.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendFeatureLog,
  bootstrapProject,
  ensureProjectLayout,
  listProjectFiles,
  listReferenceImages,
  readBrief,
  readDesignDoc,
  readFeatureDoc,
  readProjectFile,
  referencesDir,
  resolveFromMap,
  validateReferenceImages,
  writeBrief,
  writeDesignDoc,
  writeFeatureDoc,
} from "../src/design/docs.js";
import { PathError } from "../src/design/paths.js";
import { featureTemplate } from "../src/design/templates.js";
import { parseTokens } from "../src/design/tokens.js";
import type { ProjectRef } from "../src/design/types.js";

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eve-design-docs-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const project = (slug: string): ProjectRef => ({ slug, root: path.join(tmp, slug) });

// A 1x1 PNG is enough for "exists and has the right extension".
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// ── resolution ──────────────────────────────────────────────────────────────

test("resolveFromMap: known slug expands ~ and relative paths; unknown slug lists the known ones", () => {
  const map = { eve: "~/TRILLION/design", acme: "/abs/acme", rel: "design/rel" };
  assert.equal(resolveFromMap(map, "eve").root, path.join(os.homedir(), "TRILLION/design"));
  assert.equal(resolveFromMap(map, "acme").root, "/abs/acme");
  assert.ok(path.isAbsolute(resolveFromMap(map, "rel").root));
  assert.throws(() => resolveFromMap(map, "nope"), /unknown design project "nope" — known projects: eve, acme, rel/);
  assert.throws(() => resolveFromMap({}, "nope"), /no design projects are configured/);
  assert.throws(() => resolveFromMap(map, "Not A Slug"), PathError);
  assert.throws(() => resolveFromMap(map, "../etc"), PathError);
});

// ── layout + read/write ─────────────────────────────────────────────────────

test("ensureProjectLayout creates root/.prism/references/features and is idempotent", () => {
  const ref = project("layout");
  ensureProjectLayout(ref);
  ensureProjectLayout(ref);
  for (const rel of ["", ".prism", ".prism/references", "features"]) {
    assert.ok(fs.statSync(path.join(ref.root, rel)).isDirectory(), rel);
  }
});

test("write/read round trips for design.md, brief and feature docs (atomic, newline-terminated, abs path returned)", () => {
  const ref = project("rw");
  assert.equal(readDesignDoc(ref), null);
  assert.equal(readBrief(ref), null);
  assert.equal(readFeatureDoc(ref, "hero"), null);

  const p1 = writeDesignDoc(ref, "# RW — Design System");
  assert.equal(p1, path.join(ref.root, "design.md"));
  assert.equal(readDesignDoc(ref), "# RW — Design System\n");

  const p2 = writeBrief(ref, "# brief\n");
  assert.equal(p2, path.join(ref.root, ".prism", "brief.md"));
  assert.equal(readBrief(ref), "# brief\n");

  const p3 = writeFeatureDoc(ref, "hero", featureTemplate({ slug: "hero", title: "Hero", intent: "x" }));
  assert.equal(p3, path.join(ref.root, "features", "hero.md"));
  assert.match(readFeatureDoc(ref, "hero") ?? "", /^# Hero\n/);
  // no temp files left behind by the atomic write
  assert.deepEqual(fs.readdirSync(path.join(ref.root, "features")), ["hero.md"]);

  assert.throws(() => writeFeatureDoc(ref, "Bad Slug", "x"), PathError);
  assert.throws(() => readProjectFile(ref, "../outside.md"), PathError);
  assert.equal(readProjectFile(ref, "features"), null, "a directory reads as null, not an exception");
});

test("listProjectFiles returns sorted root-relative paths, filters by extension, skips node_modules", () => {
  const ref = project("list");
  ensureProjectLayout(ref);
  fs.writeFileSync(path.join(ref.root, "features", "b.md"), "b");
  fs.writeFileSync(path.join(ref.root, "features", "a.md"), "a");
  fs.writeFileSync(path.join(ref.root, "features", "notes.txt"), "t");
  fs.mkdirSync(path.join(ref.root, ".prism", "references", "hero"), { recursive: true });
  fs.writeFileSync(path.join(ref.root, ".prism", "references", "hero", "one.png"), PNG);
  fs.mkdirSync(path.join(ref.root, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(ref.root, "node_modules", "x", "index.md"), "no");
  assert.deepEqual(listProjectFiles(ref, "features"), ["features/a.md", "features/b.md", "features/notes.txt"]);
  assert.deepEqual(listProjectFiles(ref, "features", [".md"]), ["features/a.md", "features/b.md"]);
  assert.deepEqual(listProjectFiles(ref, "features", ["md"]), ["features/a.md", "features/b.md"]);
  assert.deepEqual(listProjectFiles(ref, ".prism", ["png"]), [".prism/references/hero/one.png"]);
  assert.ok(!listProjectFiles(ref, ".").some((p) => p.includes("node_modules")));
  assert.deepEqual(listProjectFiles(ref, "does-not-exist"), []);
});

// ── feature log ─────────────────────────────────────────────────────────────

test("appendFeatureLog creates the doc when missing and appends dated bullets under ## Log, in order", () => {
  const ref = project("log");
  const d1 = new Date("2026-08-15T10:00:00Z");
  const d2 = new Date("2026-08-16T10:00:00Z");
  appendFeatureLog(ref, "landing-hero", "dispatch d1: hero — first pass", d1);
  let md = readFeatureDoc(ref, "landing-hero") ?? "";
  assert.match(md, /^# Landing Hero\n/);
  assert.match(md, /## Log\n\n- 2026-08-15 dispatch d1: hero — first pass\n$/);
  appendFeatureLog(ref, "landing-hero", "hero ready → /api/x/preview/landing-hero/hero/", d2);
  md = readFeatureDoc(ref, "landing-hero") ?? "";
  assert.match(md, /## Log\n\n- 2026-08-15 dispatch d1: hero — first pass\n- 2026-08-16 hero ready → \/api\/x\/preview\/landing-hero\/hero\/\n$/);
  assert.equal((md.match(/## Log/g) ?? []).length, 1);

  // Log in the middle of a doc: entries go at the end of that section, and
  // the following section is untouched.
  writeFeatureDoc(ref, "mid", "# Mid\n\n## Log\n\n- 2026-01-01 old\n\n## After\n\nkeep me\n");
  appendFeatureLog(ref, "mid", "new", d2);
  assert.equal(readFeatureDoc(ref, "mid"), "# Mid\n\n## Log\n\n- 2026-01-01 old\n- 2026-08-16 new\n\n## After\n\nkeep me\n");

  // No Log section at all: one is added at the end.
  writeFeatureDoc(ref, "nolog", "# No log\n\n## Intent\n\nx\n");
  appendFeatureLog(ref, "nolog", "first", d1);
  assert.equal(readFeatureDoc(ref, "nolog"), "# No log\n\n## Intent\n\nx\n\n## Log\n\n- 2026-08-15 first\n");
});

// ── reference images ────────────────────────────────────────────────────────

test("listReferenceImages: abs paths, images only, sorted; validateReferenceImages rejects the bad and returns the good", () => {
  const ref = project("refs");
  const dir = referencesDir(ref, "hero");
  assert.equal(dir, path.join(ref.root, ".prism", "references", "hero"));
  assert.deepEqual(listReferenceImages(ref, "hero"), []);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "b.png"), PNG);
  fs.writeFileSync(path.join(dir, "a.jpg"), PNG);
  fs.writeFileSync(path.join(dir, "c.webp"), PNG);
  fs.writeFileSync(path.join(dir, "notes.txt"), "no");
  fs.writeFileSync(path.join(dir, "anim.gif"), "no");
  fs.mkdirSync(path.join(ref.root, "moodboard"), { recursive: true });
  fs.writeFileSync(path.join(ref.root, "moodboard", "m.jpeg"), PNG);
  assert.deepEqual(listReferenceImages(ref, "hero"), [path.join(dir, "a.jpg"), path.join(dir, "b.png"), path.join(dir, "c.webp")]);

  assert.deepEqual(validateReferenceImages(ref, "hero", ["b.png", "moodboard/m.jpeg", ".prism/references/hero/a.jpg"]), [
    path.join(dir, "b.png"),
    path.join(ref.root, "moodboard", "m.jpeg"),
    path.join(dir, "a.jpg"),
  ]);
  assert.deepEqual(validateReferenceImages(ref, "hero", []), []);

  const bad = (given: string[]) => {
    try {
      validateReferenceImages(ref, "hero", given);
    } catch (err) {
      return (err as Error).message;
    }
    assert.fail(`expected ${JSON.stringify(given)} to be rejected`);
  };
  assert.match(bad(["../secrets.png"]), /"\.\.\/secrets\.png" climbs out of the project/);
  assert.match(bad(["moodboard/../../x.png"]), /climbs out of the project/);
  assert.match(bad(["/etc/passwd.png"]), /"\/etc\/passwd\.png" is an absolute path/);
  assert.match(bad(["anim.gif"]), /"anim\.gif" is not an image we can use/);
  assert.match(bad(["notes.txt"]), /not an image we can use/);
  assert.match(bad(["missing.png"]), /"missing\.png" does not exist/);
  // every problem in one message, in order
  const all = bad(["b.png", "../x.png", "anim.gif", "missing.png"]);
  assert.match(all, /reference images for refs\/hero: /);
  assert.ok(all.indexOf("../x.png") < all.indexOf("anim.gif") && all.indexOf("anim.gif") < all.indexOf("missing.png"));
  assert.throws(() => validateReferenceImages(ref, "Bad Slug", []), PathError);
});

// ── bootstrap ───────────────────────────────────────────────────────────────

test("bootstrapProject writes a parseTokens-valid design.md and a brief with forbidden moves; second call is a no-op", () => {
  const scan = path.join(tmp, "acme-repo");
  const ref: ProjectRef = { slug: "acme", root: path.join(scan, "design") };
  fs.mkdirSync(path.join(scan, "src", "ui"), { recursive: true });
  fs.writeFileSync(path.join(scan, "package.json"), JSON.stringify({ name: "acme", description: "Acme ships tools for people who ship." }));
  fs.writeFileSync(path.join(scan, "README.md"), "# Acme\n\nAcme ships tools for people who ship.\n\n## Install\n\nnpm i acme\n");
  // greys and near-black/near-white dominate by count; the saturated colour must still win the accent
  fs.writeFileSync(
    path.join(scan, "src", "ui", "theme.css"),
    ":root{--bg:#000;--fg:#fff;--line:#222222;--line2:#222222;--line3:#222;--brand:#ff6a00;--brand2:#FF6A00;--warm:#ff6a00;--muted:#888}\n",
  );
  fs.mkdirSync(path.join(scan, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(scan, "node_modules", "pkg", "x.css"), "a{color:#00ffcc}b{color:#00ffcc}c{color:#00ffcc}d{color:#00ffcc}\n");

  const first = bootstrapProject(ref);
  assert.equal(first.created, true);
  assert.equal(readDesignDoc(ref), first.designMd);
  assert.equal(readBrief(ref), first.briefMd);
  const tokens = parseTokens(first.designMd);
  assert.equal(tokens.colors.accent, "#ff6a00", "most frequent saturated colour wins; node_modules ignored");
  assert.deepEqual(tokens.fonts, { display: "Instrument Serif", body: "Inter Tight", mono: "JetBrains Mono" });
  assert.equal(tokens.mode, "dark");
  assert.equal(tokens.colors.background, "#07090c");
  assert.equal(tokens.radius, "0.5rem");
  assert.match(first.designMd, /^# Acme — Design System/);
  assert.doesNotMatch(first.designMd, /TODO|TBD|REPLACE/);
  assert.match(first.briefMd, /^# Acme — Design Brief \(private\)/);
  assert.match(first.briefMd, /The brief is law/);
  assert.match(first.briefMd, /### Forbidden moves\n\n- no violet\/cyan cyberpunk defaults\n- no Space Grotesk \/ Plus Jakarta/);
  assert.match(first.briefMd, /Acme ships tools for people who ship\./);
  assert.match(first.briefMd, /## Bootstrap notes\n\n- bootstrapped \d{4}-\d{2}-\d{2}/);
  assert.match(first.briefMd, /#ff6a00 picked as the most frequent saturated colour \(3 uses\)/);

  const second = bootstrapProject(ref);
  assert.equal(second.created, false);
  assert.equal(second.designMd, first.designMd);
  assert.equal(second.briefMd, first.briefMd);

  // Only the missing file is written when one of the two exists.
  fs.rmSync(path.join(ref.root, ".prism", "brief.md"));
  writeDesignDoc(ref, "# custom design\n");
  const third = bootstrapProject(ref);
  assert.equal(third.created, true);
  assert.equal(third.designMd, "# custom design\n");
  assert.equal(readDesignDoc(ref), "# custom design\n");
  assert.match(readBrief(ref) ?? "", /Design Brief/);
});

test("bootstrapProject with nothing to scan commits to the defaults, and the eve slug gets its positioning", () => {
  const bare: ProjectRef = { slug: "bare", root: path.join(tmp, "empty-parent", "bare") };
  const b = bootstrapProject(bare, { scanRoots: [] });
  assert.equal(b.created, true);
  const t = parseTokens(b.designMd);
  assert.equal(t.colors.accent, "#2dd4a8");
  assert.match(b.designMd, /^# Bare — Design System/);
  assert.match(b.briefMd, /no saturated colour stood out/);

  const eve: ProjectRef = { slug: "eve", root: path.join(tmp, "eve-home", "design") };
  const e = bootstrapProject(eve, { scanRoots: [] });
  assert.match(e.designMd, /^# EVE — Design System/);
  assert.match(e.briefMd, /EVE — Umberto's voice-first assistant, business advisor and friend: playful, witty, empathetic/);
  for (const move of ["no violet/cyan cyberpunk defaults", "no Space Grotesk / Plus Jakarta", "no stock-illustration people", "no decorative gradient fills on the accent", "no hero without a product surface"]) {
    assert.ok(e.briefMd.includes(`- ${move}`), move);
  }
  assert.doesNotThrow(() => parseTokens(e.designMd));
});
