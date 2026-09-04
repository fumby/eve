// The component catalog is pure data + string builders; these tests pin the
// shapes the composer and audit rely on: unique names, real install commands,
// grouped install lines, a prompt rendering that fits its budget, and a
// markdown reference that mentions every component.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHADCN_COMPONENTS,
  MAGICUI_COMPONENTS,
  MOTION_ENTRIES,
  MAGICUI_BACKGROUNDS,
  MAGICUI_MOTION_HINTS,
  ALL_COMPONENTS,
  findComponent,
  installCommandsFor,
  renderCatalogForPrompt,
  renderCatalogMarkdown,
} from "../src/design/catalog.js";

const REQUIRED_SHADCN = (
  "accordion alert alert-dialog aspect-ratio avatar badge breadcrumb button calendar card carousel " +
  "chart checkbox collapsible command context-menu dialog drawer dropdown-menu form hover-card input " +
  "input-otp label menubar navigation-menu pagination popover progress radio-group resizable " +
  "scroll-area select separator sheet sidebar skeleton slider sonner switch table tabs textarea " +
  "toggle toggle-group tooltip"
).split(" ");

const REQUIRED_MAGICUI = (
  "animated-grid-pattern grid-pattern dot-pattern flickering-grid retro-grid particles meteors ripple " +
  "warp-background marquee sparkles-text animated-list bento-grid blur-fade text-reveal text-animate " +
  "hyper-text morphing-text aurora-text animated-shiny-text line-shadow-text word-rotate " +
  "typing-animation number-ticker border-beam shine-border magic-card shimmer-button pulsating-button " +
  "rainbow-button animated-beam orbiting-circles scroll-progress terminal dock globe icon-cloud safari " +
  "iphone"
).split(" ");

const allNames = () => ALL_COMPONENTS.map((c) => c.name);

test("no duplicate names across ALL_COMPONENTS", () => {
  const names = allNames();
  assert.equal(new Set(names).size, names.length);
  assert.equal(ALL_COMPONENTS.length, SHADCN_COMPONENTS.length + MAGICUI_COMPONENTS.length + MOTION_ENTRIES.length);
});

test("the required shadcn and MagicUI sets are all present, with the right shapes", () => {
  const shadcn = new Set(SHADCN_COMPONENTS.map((c) => c.name));
  for (const n of REQUIRED_SHADCN) assert.ok(shadcn.has(n), `missing shadcn ${n}`);
  for (const c of SHADCN_COMPONENTS) {
    assert.equal(c.library, "shadcn");
    assert.equal(c.install, `npx shadcn@latest add ${c.name}`);
    assert.equal(c.importPath, `@/components/ui/${c.name}`);
    assert.ok(c.useFor.length > 0);
  }

  const magic = new Set(MAGICUI_COMPONENTS.map((c) => c.name));
  for (const n of REQUIRED_MAGICUI) assert.ok(magic.has(n), `missing magicui ${n}`);
  for (const c of MAGICUI_COMPONENTS) {
    assert.equal(c.library, "magicui");
    assert.equal(c.install, `npx shadcn@latest add "https://magicui.design/r/${c.name}.json"`);
    assert.equal(c.importPath, `@/components/ui/${c.name}`);
    assert.ok(c.docs?.includes(`legacy: npx magicui-cli add ${c.name}`), `docs of ${c.name} lacks legacy note`);
    assert.ok(c.useFor.length > 0);
  }

  assert.equal(MOTION_ENTRIES.length, 1);
  const motion = MOTION_ENTRIES[0]!;
  assert.equal(motion.name, "motion");
  assert.equal(motion.library, "framer-motion");
  assert.equal(motion.install, "npm install motion");
  assert.equal(motion.importPath, "motion/react");
  assert.match(motion.useFor, /MagicUI already depends on motion/);
});

test("every install string starts with npx or npm", () => {
  for (const c of ALL_COMPONENTS) {
    assert.match(c.install, /^(npx|npm) /, `${c.name}: ${c.install}`);
  }
});

test("MAGICUI_BACKGROUNDS and MAGICUI_MOTION_HINTS are subsets of the MagicUI names", () => {
  const magic = new Set(MAGICUI_COMPONENTS.map((c) => c.name));
  assert.equal(MAGICUI_BACKGROUNDS.length, 9);
  for (const n of MAGICUI_BACKGROUNDS) assert.ok(magic.has(n), `background ${n} not in catalog`);
  for (const n of MAGICUI_MOTION_HINTS) assert.ok(magic.has(n), `motion hint ${n} not in catalog`);
  assert.equal(new Set(MAGICUI_BACKGROUNDS).size, MAGICUI_BACKGROUNDS.length);
  assert.equal(new Set(MAGICUI_MOTION_HINTS).size, MAGICUI_MOTION_HINTS.length);
});

test("findComponent: hit, trim, miss", () => {
  assert.equal(findComponent("button")?.importPath, "@/components/ui/button");
  assert.equal(findComponent(" grid-pattern ")?.library, "magicui");
  assert.equal(findComponent("motion")?.importPath, "motion/react");
  assert.equal(findComponent("Button"), undefined);
  assert.equal(findComponent("nope"), undefined);
});

test("installCommandsFor: dedupes, groups shadcn into one line, one line per MagicUI, motion via npm", () => {
  const lines = installCommandsFor([
    "button",
    "card",
    "grid-pattern",
    "button", // duplicate
    "border-beam",
    "motion",
    " badge ", // whitespace
  ]);
  assert.deepEqual(lines, [
    "npx shadcn@latest add button card badge",
    'npx shadcn@latest add "https://magicui.design/r/grid-pattern.json"',
    'npx shadcn@latest add "https://magicui.design/r/border-beam.json"',
    "npm install motion",
  ]);
  assert.deepEqual(installCommandsFor([]), []);
  assert.deepEqual(installCommandsFor(["particles"]), [
    'npx shadcn@latest add "https://magicui.design/r/particles.json"',
  ]);
  assert.deepEqual(installCommandsFor(["tabs", "tabs"]), ["npx shadcn@latest add tabs"]);
});

test("installCommandsFor: unknown names throw with prose listing valid names", () => {
  assert.throws(
    () => installCommandsFor(["button", "hologram-thing"]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /unknown component "hologram-thing"/);
      assert.match(err.message, /Valid names are/);
      assert.match(err.message, /accordion/);
      assert.match(err.message, /grid-pattern/);
      assert.match(err.message, /"motion"/);
      return true;
    },
  );
  assert.throws(() => installCommandsFor(["a", "b"]), /unknown components "a", "b"/);
});

test("renderCatalogForPrompt: fits the budget and carries the install shapes + the rule", () => {
  const text = renderCatalogForPrompt();
  assert.ok(text.length <= 2500, `prompt rendering is ${text.length} chars`);
  assert.ok(text.includes("npx shadcn@latest add"));
  assert.ok(text.includes("magicui.design/r/"));
  assert.ok(text.includes("npm install motion"));
  assert.match(text, /IMPORT and USE/);
  assert.match(text, /never appears in the page TSX is a bug/);
  // every MagicUI component is named under exactly one job group
  const groupLines = text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(groupLines.length, 5);
  for (const label of ["backgrounds", "text effects", "motion", "surfaces & frames", "buttons"]) {
    assert.ok(groupLines.some((l) => l.startsWith(`- ${label}`)), `missing group ${label}`);
  }
  for (const c of MAGICUI_COMPONENTS) {
    const hits = groupLines.filter((l) => l.split(": ")[1]!.split(" ").includes(c.name));
    assert.equal(hits.length, 1, `${c.name} appears in ${hits.length} groups`);
  }
  // shadcn names all appear on one line
  const shadcnLine = text.split("\n").find((l) => l.startsWith("accordion "));
  assert.ok(shadcnLine);
  for (const c of SHADCN_COMPONENTS) assert.ok(shadcnLine.split(" ").includes(c.name), `${c.name} not on shadcn line`);
});

test("renderCatalogMarkdown: names every component, the opacity rule, and the three snippets", () => {
  const md = renderCatalogMarkdown();
  for (const c of ALL_COMPONENTS) assert.ok(md.includes(`| ${c.name} |`), `markdown lacks ${c.name}`);
  assert.ok(md.includes("opacity"));
  assert.match(md, /How to compose a hero/);
  assert.match(md, /0\.4 opacity/);
  assert.match(md, /2 continuous motions/);
  assert.match(md, /3 elements/);
  assert.match(md, /14–16px/);
  assert.match(md, /import \{ GridPattern \} from "@\/components\/ui\/grid-pattern"/);
  assert.match(md, /opacity-50/);
  assert.match(md, /import \{ BorderBeam \} from "@\/components\/ui\/border-beam"/);
  assert.match(md, /<BorderBeam/);
  assert.match(md, /import \{ NumberTicker \} from "@\/components\/ui\/number-ticker"/);
  assert.match(md, /font-mono[^\n]*\n[^\n]*<NumberTicker/);
  assert.ok(md.includes('npx shadcn@latest add "https://magicui.design/r/<name>.json"'));
  assert.ok(md.includes("legacy: `npx magicui-cli add <name>`"));
  // every table row has the four columns
  for (const line of md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| name") && !l.startsWith("| ---"))) {
    assert.equal(line.split(" | ").length, 4, line);
  }
});
