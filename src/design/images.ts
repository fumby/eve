// Tier 5: image generation for mockups. The planner asks for a hero shot or a
// product still, we get PNG bytes back from Gemini's image models, write them
// under the preview app's public/assets/ and hand the composer a URL it must
// use verbatim. The Gemini call is one small seam (ImageGenerator) so every
// other line here — prompt shaping, path hygiene, PNG check, atomic write,
// audit — runs in tests with a fake generator and no network. With no key in
// .env the whole tier reports itself as off instead of failing mid-dispatch.
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, Modality, type GenerateContentResponse } from "@google/genai";
import { audit } from "../core/audit.js";
import { loadConfig } from "../core/config.js";
import { assertSlug, assertWithinProject } from "./paths.js";
import {
  assetUrl,
  type DesignTokens,
  type ImageAspect,
  type ImageQuality,
  type ImageRequest,
  type ImageResult,
  type ProjectRef,
} from "./types.js";

// Flat per-image estimates (Gemini bills image output per image, not per
// token). Counted into the dispatch budget before the call, like every other
// spend in the design agent.
export const IMAGE_PRICE_USD: Record<ImageQuality, number> = { standard: 0.04, premium: 0.12 };

// Both names are accepted because Google's own docs and tooling use both;
// GEMINI_API_KEY is what .env.example asks for.
export function imagesAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
}

export function imageModelFor(quality: ImageQuality): string {
  return loadConfig().design.imageModels[quality];
}

// ── prompt shaping ──────────────────────────────────────────────────────────

const ASPECT_HINT: Record<ImageAspect, string> = {
  "16:9": "Aspect ratio 16:9, wide composition.",
  "1:1": "Aspect ratio 1:1, square composition.",
  "4:3": "Aspect ratio 4:3, gently landscape composition.",
  "3:2": "Aspect ratio 3:2, classic landscape composition.",
  "9:16": "Aspect ratio 9:16, tall portrait composition.",
};

// The default look of AI imagery is violet/cyan gradient soup with a caption
// baked in; every prompt bans that outright, palette or no palette.
const HOUSE_BANS = "NO violet, NO cyan, NO purple-blue gradients";
const NO_CHROME = "no text, no watermark, no UI chrome unless asked";
const DEFAULT_STYLE =
  "Style: photographic, editorial, cinematic lighting, shallow depth of field, real materials and textures, no illustration or clip-art look.";

// "near-black" or "near-white" from a #rrggbb, so the palette sentence reads
// truthfully for light design systems too. Anything unparseable stays neutral.
function toneOf(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return "";
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum < 0.5 ? "near-black " : "near-white ";
}

export function buildImagePrompt(input: {
  prompt: string;
  aspect?: ImageAspect;
  palette?: { accent: string; background: string; forbid?: string[] };
  style?: string;
}): string {
  // The user's own words go first: image models weight the opening of a
  // prompt most, and the constraints below are guard-rails, not the subject.
  const lines: string[] = [input.prompt.trim()];
  if (input.aspect) lines.push(ASPECT_HINT[input.aspect]);

  const extraBans = (input.palette?.forbid ?? [])
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .map((f) => `NO ${f}`);
  const bans = [HOUSE_BANS, ...extraBans, NO_CHROME].join(", ");
  if (input.palette) {
    const { accent, background } = input.palette;
    lines.push(
      `Palette: ${toneOf(background)}${background} with ${accent} as the ONLY accent. ${bans}.`,
    );
  } else {
    lines.push(`${bans}.`);
  }

  lines.push(input.style?.trim() || DEFAULT_STYLE);
  return lines.join("\n");
}

// ── where images live ───────────────────────────────────────────────────────

// <root>/.prism/preview/public/assets/<feature>/<slug>.png — Next.js serves
// public/ at the site root, so this maps 1:1 onto assetUrl() once the export
// is behind the preview basePath.
export function imagePathFor(project: ProjectRef, featureSlug: string, slug: string): string {
  assertSlug(featureSlug, "feature slug");
  assertSlug(slug, "image slug");
  return assertWithinProject(
    project.root,
    path.join(".prism", "preview", "public", "assets", featureSlug, `${slug}.png`),
  );
}

// ── the Gemini seam ─────────────────────────────────────────────────────────

// Returns PNG bytes. `opts.aspect` is a hint the real generator forwards as
// imageConfig.aspectRatio (the prompt text alone is unreliable for framing);
// fakes may ignore it.
export type ImageGenerator = (
  model: string,
  prompt: string,
  opts?: { aspect?: ImageAspect },
) => Promise<Buffer>;

const mentionsBilling = (s: string): boolean => /quota|billing|429|resource_exhausted/i.test(s);
const BILLING_HINT =
  " — images need billing enabled on the AI Studio project behind GEMINI_API_KEY (the free tier has no image quota)";

export function geminiGenerator(apiKey: string): ImageGenerator {
  const ai = new GoogleGenAI({ apiKey });
  return async (model, prompt, opts) => {
    let res: GenerateContentResponse;
    try {
      res = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseModalities: [Modality.IMAGE],
          ...(opts?.aspect ? { imageConfig: { aspectRatio: opts.aspect } } : {}),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Gemini (${model}) refused the image request: ${msg.slice(0, 200)}${mentionsBilling(msg) ? BILLING_HINT : ""}`,
      );
    }

    const parts = (res.candidates ?? []).flatMap((c) => c.content?.parts ?? []);
    // Prefer a PNG part; fall back to any inline image so the caller's magic-
    // byte check produces the error rather than us guessing.
    const image =
      parts.find((p) => p.inlineData?.data && p.inlineData.mimeType === "image/png") ??
      parts.find((p) => p.inlineData?.data);
    if (image?.inlineData?.data) return Buffer.from(image.inlineData.data, "base64");

    // No image: whatever the model said in text is the best clue we have —
    // quota, safety, or "I can't draw that" all show up there.
    const said = parts
      .map((p) => p.text ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    const blocked = res.promptFeedback?.blockReason;
    let msg = `Gemini (${model}) returned no image`;
    if (said) msg += `; it said: "${said}"`;
    if (blocked) msg += ` (prompt blocked: ${blocked})`;
    if (mentionsBilling(said)) msg += BILLING_HINT;
    throw new Error(msg);
  };
}

// ── generate + persist ──────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer): boolean => b.length > PNG_MAGIC.length && b.subarray(0, 8).equals(PNG_MAGIC);

// Same temp-then-rename dance as core/atomic.ts, for bytes: a half-written PNG
// would be served as a broken image by the preview until the next dispatch.
function writeBytesAtomic(target: string, bytes: Buffer): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

export async function generateImage(
  req: ImageRequest,
  deps: { generate?: ImageGenerator; env?: NodeJS.ProcessEnv; tokens?: DesignTokens } = {},
): Promise<ImageResult> {
  const projectSlug = assertSlug(req.project.slug, "project slug");
  const featureSlug = assertSlug(req.featureSlug, "feature slug");
  const slug = assertSlug(req.slug, "image slug");
  if (!Object.prototype.hasOwnProperty.call(IMAGE_PRICE_USD, req.quality)) {
    throw new Error(`image quality must be "standard" or "premium", got ${JSON.stringify(req.quality)}`);
  }
  const target = imagePathFor(req.project, featureSlug, slug);

  const env = deps.env ?? process.env;
  let generate = deps.generate;
  if (!generate) {
    if (!imagesAvailable(env)) {
      throw new Error("image generation is off: add GEMINI_API_KEY (with billing enabled) to .env");
    }
    generate = geminiGenerator(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "");
  }

  const model = imageModelFor(req.quality);
  const prompt = buildImagePrompt({
    prompt: req.prompt,
    ...(req.aspect ? { aspect: req.aspect } : {}),
    ...(deps.tokens
      ? { palette: { accent: deps.tokens.colors.accent, background: deps.tokens.colors.background } }
      : {}),
  });

  const png = await generate(model, prompt, req.aspect ? { aspect: req.aspect } : undefined);
  if (!Buffer.isBuffer(png) || !isPng(png)) {
    throw new Error(
      `the image model (${model}) returned something that isn't a PNG (${Buffer.isBuffer(png) ? png.length : 0} bytes) — nothing was written`,
    );
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeBytesAtomic(target, png);

  const costUsd = IMAGE_PRICE_USD[req.quality];
  audit("design_image", { project: projectSlug, feature: featureSlug, slug, model, costUsd });
  return { url: assetUrl(projectSlug, featureSlug, slug), path: target, model, costUsd };
}

// The composer (Claude Code) tends to "helpfully" rewrite /api/<slug>/preview/
// assets/… into /assets/…, which 404s behind the basePath. Say it plainly.
export function describeImageForPrompt(r: ImageResult, alt: string): string {
  return `IMAGE ${alt}: ${r.url} (use this FULL url verbatim in an <img> tag; do not strip the prefix)`;
}
