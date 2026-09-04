// Tier 5 image seam, without Gemini: prompt shaping, path hygiene, the PNG
// check, the atomic write and the URL/cost the composer relies on — all with a
// fake generator. No network anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  IMAGE_PRICE_USD,
  buildImagePrompt,
  describeImageForPrompt,
  generateImage,
  imageModelFor,
  imagePathFor,
  imagesAvailable,
  type ImageGenerator,
} from "../src/design/images.js";
import { PathError } from "../src/design/paths.js";
import type { DesignTokens, ImageResult, ProjectRef } from "../src/design/types.js";

// A real, decodable 1×1 PNG built by hand (signature + IHDR + IDAT + IEND)
// so the magic-byte check is exercised against genuine bytes, not a stub.
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // One scanline: filter byte 0 + one RGB pixel.
  const raw = Buffer.from([0, 0x0a, 0x0a, 0x0a]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TOKENS: DesignTokens = {
  fonts: { display: "Instrument Serif", body: "Inter", mono: "JetBrains Mono" },
  colors: {
    background: "#0a0a0a",
    foreground: "#fafafa",
    accent: "#e11d48",
    muted: "#171717",
    border: "#262626",
  },
  radius: "0.5rem",
  mode: "dark",
  shadcn: { baseColor: "neutral", style: "new-york" },
};

function withTempProject<T>(fn: (project: ProjectRef) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-design-images-"));
  return fn({ slug: "eve", root }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

// ── prompt ──────────────────────────────────────────────────────────────────

test("buildImagePrompt: user prompt first, then aspect, palette with NO violet, style", () => {
  const p = buildImagePrompt({
    prompt: "A matte black desk lamp on a walnut table",
    aspect: "16:9",
    palette: { accent: "#e11d48", background: "#0a0a0a", forbid: ["neon green"] },
  });
  assert.ok(p.startsWith("A matte black desk lamp on a walnut table"), "user prompt must lead");
  assert.match(p, /Aspect ratio 16:9, wide composition\./);
  assert.match(p, /Palette: near-black #0a0a0a with #e11d48 as the ONLY accent\./);
  assert.match(p, /NO violet, NO cyan, NO purple-blue gradients/);
  assert.match(p, /NO neon green/);
  assert.match(p, /no text, no watermark, no UI chrome unless asked/);
  assert.match(p, /photographic|editorial/i);
  // Ordering: prompt < aspect < palette < style.
  const iAspect = p.indexOf("Aspect ratio");
  const iPalette = p.indexOf("Palette:");
  const iStyle = p.indexOf("Style:");
  assert.ok(0 < iAspect && iAspect < iPalette && iPalette < iStyle, `bad ordering:\n${p}`);
});

test("buildImagePrompt: no palette still bans violet; light backgrounds read near-white; custom style wins", () => {
  const bare = buildImagePrompt({ prompt: "Fog over a harbour" });
  assert.ok(bare.startsWith("Fog over a harbour"));
  assert.match(bare, /NO violet/);
  assert.doesNotMatch(bare, /Palette:/);
  assert.match(bare, /Style: photographic/);

  const light = buildImagePrompt({
    prompt: "x",
    palette: { accent: "#0f766e", background: "#ffffff" },
    style: "Style: flat vector, two colours.",
  });
  assert.match(light, /near-white #ffffff/);
  assert.match(light, /Style: flat vector, two colours\./);
  assert.doesNotMatch(light, /photographic/);
});

// ── paths ───────────────────────────────────────────────────────────────────

test("imagePathFor: builds under .prism/preview/public/assets and rejects bad slugs + traversal", () => {
  const project: ProjectRef = { slug: "eve", root: "/tmp/eve-design-root" };
  const p = imagePathFor(project, "landing-hero", "hero-shot");
  assert.equal(
    p,
    path.join("/tmp/eve-design-root", ".prism", "preview", "public", "assets", "landing-hero", "hero-shot.png"),
  );
  for (const bad of ["../escape", "Hero", "hero_shot", "hero shot", "", "-lead", "a/b", "hero.png"]) {
    assert.throws(() => imagePathFor(project, "landing-hero", bad), PathError, `image slug ${JSON.stringify(bad)}`);
    assert.throws(() => imagePathFor(project, bad, "hero-shot"), PathError, `feature slug ${JSON.stringify(bad)}`);
  }
});

// ── availability + model ────────────────────────────────────────────────────

test("imagesAvailable: true with GEMINI_API_KEY or GOOGLE_API_KEY, false otherwise", () => {
  assert.equal(imagesAvailable({}), false);
  assert.equal(imagesAvailable({ GEMINI_API_KEY: "" }), false);
  assert.equal(imagesAvailable({ GEMINI_API_KEY: "k" }), true);
  assert.equal(imagesAvailable({ GOOGLE_API_KEY: "k" }), true);
});

test("imageModelFor reads config.json and prices are the documented flat rates", () => {
  assert.equal(typeof imageModelFor("standard"), "string");
  assert.equal(typeof imageModelFor("premium"), "string");
  assert.ok(imageModelFor("standard").length > 0);
  assert.deepEqual(IMAGE_PRICE_USD, { standard: 0.04, premium: 0.12 });
});

// ── generateImage ───────────────────────────────────────────────────────────

test("generateImage: writes the PNG, returns full basePath url, model and cost, audits", async () => {
  await withTempProject(async (project) => {
    const png = tinyPng();
    const calls: Array<{ model: string; prompt: string; aspect?: string }> = [];
    const generate: ImageGenerator = async (model, prompt, opts) => {
      calls.push({ model, prompt, ...(opts?.aspect ? { aspect: opts.aspect } : {}) });
      return png;
    };
    const r = await generateImage(
      {
        project,
        featureSlug: "landing-hero",
        slug: "hero-shot",
        prompt: "A matte black desk lamp",
        quality: "premium",
        aspect: "16:9",
      },
      { generate, tokens: TOKENS, env: {} },
    );
    assert.equal(r.url, "/api/eve/preview/assets/landing-hero/hero-shot.png");
    assert.equal(
      r.path,
      path.join(project.root, ".prism", "preview", "public", "assets", "landing-hero", "hero-shot.png"),
    );
    assert.equal(r.costUsd, 0.12);
    assert.equal(r.model, imageModelFor("premium"));
    assert.ok(fs.existsSync(r.path), "png must be on disk");
    assert.ok(fs.readFileSync(r.path).equals(png), "bytes written verbatim");
    // No stray temp files from the atomic write.
    assert.deepEqual(fs.readdirSync(path.dirname(r.path)), ["hero-shot.png"]);
    // The generator got the shaped prompt with the design system's palette.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.model, imageModelFor("premium"));
    assert.equal(calls[0]?.aspect, "16:9");
    assert.ok(calls[0]?.prompt.startsWith("A matte black desk lamp"));
    assert.match(calls[0]?.prompt ?? "", /#e11d48 as the ONLY accent/);
    assert.match(calls[0]?.prompt ?? "", /Aspect ratio 16:9/);
  });
});

test("generateImage: standard quality costs 0.04 and uses the standard model", async () => {
  await withTempProject(async (project) => {
    const r = await generateImage(
      { project, featureSlug: "pricing", slug: "plan-cards", prompt: "x", quality: "standard" },
      { generate: async () => tinyPng(), env: {} },
    );
    assert.equal(r.costUsd, 0.04);
    assert.equal(r.model, imageModelFor("standard"));
    assert.equal(r.url, "/api/eve/preview/assets/pricing/plan-cards.png");
  });
});

test("generateImage: non-PNG bytes from the generator → error, nothing written", async () => {
  await withTempProject(async (project) => {
    await assert.rejects(
      generateImage(
        { project, featureSlug: "landing-hero", slug: "hero-shot", prompt: "x", quality: "standard" },
        { generate: async () => Buffer.from("<html>not an image</html>"), env: {} },
      ),
      /isn't a PNG/,
    );
    assert.equal(fs.existsSync(path.join(project.root, ".prism")), false, "no partial write");
  });
});

test("generateImage: no key and no injected generator → the 'add GEMINI_API_KEY' error", async () => {
  await withTempProject(async (project) => {
    await assert.rejects(
      generateImage(
        { project, featureSlug: "landing-hero", slug: "hero-shot", prompt: "x", quality: "standard" },
        { env: {} },
      ),
      /image generation is off: add GEMINI_API_KEY \(with billing enabled\) to \.env/,
    );
  });
});

test("generateImage: bad slugs are refused before anything else happens", async () => {
  await withTempProject(async (project) => {
    let called = false;
    const generate: ImageGenerator = async () => {
      called = true;
      return tinyPng();
    };
    await assert.rejects(
      generateImage(
        { project, featureSlug: "../etc", slug: "hero-shot", prompt: "x", quality: "standard" },
        { generate, env: {} },
      ),
      PathError,
    );
    await assert.rejects(
      generateImage(
        { project, featureSlug: "landing-hero", slug: "Hero Shot", prompt: "x", quality: "standard" },
        { generate, env: {} },
      ),
      PathError,
    );
    assert.equal(called, false, "generator must not run for invalid slugs");
  });
});

test("generateImage: a throwing generator surfaces its message", async () => {
  await withTempProject(async (project) => {
    await assert.rejects(
      generateImage(
        { project, featureSlug: "landing-hero", slug: "hero-shot", prompt: "x", quality: "standard" },
        {
          generate: async () => {
            throw new Error("Gemini (m) returned no image; it said: \"quota exceeded\"");
          },
          env: {},
        },
      ),
      /quota exceeded/,
    );
  });
});

// ── describe ────────────────────────────────────────────────────────────────

test("describeImageForPrompt spells out the verbatim-url rule", () => {
  const r: ImageResult = {
    url: "/api/eve/preview/assets/landing-hero/hero-shot.png",
    path: "/x/hero-shot.png",
    model: "m",
    costUsd: 0.04,
  };
  assert.equal(
    describeImageForPrompt(r, "hero shot"),
    "IMAGE hero shot: /api/eve/preview/assets/landing-hero/hero-shot.png (use this FULL url verbatim in an <img> tag; do not strip the prefix)",
  );
});
