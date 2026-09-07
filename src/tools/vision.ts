import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import type { EveTool } from "../core/registry.js";
import { requireKey } from "../core/config.js";

// Gemini's inlineData needs a MIME type. Infer it from the extension when the
// source doesn't carry one (no Content-Type header, or a bare local path); fall
// back to PNG — the format the spec names and one Gemini always accepts inline.
function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".gif") return "image/gif";
  if (e === ".webp") return "image/webp";
  if (e === ".bmp") return "image/bmp";
  return "image/png";
}

const MODEL = "gemini-2.5-flash";

export const visionTools: EveTool[] = [
  {
    name: "look_at_image",
    description:
      "Analyze an image using Gemini vision. Give it a local file path or a URL to an image and a question about it, and it returns a text analysis. Use this whenever you need to understand, describe, or answer questions about the contents of an image — a screenshot, a photo, a chart, a diagram. The question defaults to 'Describe what you see in detail' when omitted.",
    schema: z.object({
      source: z
        .string()
        .min(1)
        .describe("Path to a local image file, or a URL (http/https) pointing at an image."),
      question: z
        .string()
        .optional()
        .describe(
          "What to ask Gemini about the image. Defaults to 'Describe what you see in detail'.",
        ),
    }),
    // Read-only: the image is sent to Gemini and the analysis comes back as text.
    // Nothing on disk or in the world changes, so no gate.
    needsConfirmation: false,
    // Paid calls are not free to retry — don't hand this to spawned agents that
    // might burn through the quota without a human watching.
    factoryAllowed: false,
    run: async (input) => {
      const source = String(input.source);
      const question =
        typeof input.question === "string" && input.question.trim()
          ? input.question
          : "Describe what you see in detail.";

      let mimeType: string;
      let base64: string;

      if (/^https?:\/\//i.test(source)) {
        // A URL: fetch the bytes and inline them as base64. Gemini's
        // fileData.fileUri is GCS-only, so the reliable path for an arbitrary
        // web URL is to pull the image down and send it inline.
        let res: Response;
        try {
          res = await fetch(source);
        } catch {
          throw new Error(`I couldn't reach the URL "${source}". Check that it's accessible.`);
        }
        if (!res.ok) throw new Error(`Fetching the image failed (${res.status}).`);
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.startsWith("image/")) {
          mimeType = contentType.split(";")[0]!.trim();
        } else {
          mimeType = mimeFromExt(path.extname(new URL(source).pathname));
        }
        base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      } else {
        // A local file: expand a leading ~ (path.resolve doesn't), then read.
        const file = path.resolve(source.replace(/^~/, os.homedir()));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          throw new Error(`No image file at "${source}". Give me a path or a URL that exists.`);
        }
        mimeType = mimeFromExt(path.extname(file));
        base64 = fs.readFileSync(file).toString("base64");
      }

      const key = requireKey("GEMINI_API_KEY");
      const ai = new GoogleGenAI({ apiKey: key });
      let response;
      try {
        response = await ai.models.generateContent({
          model: MODEL,
          contents: [
            {
              parts: [
                { text: question },
                { inlineData: { mimeType, data: base64 } },
              ],
            },
          ],
        });
      } catch (err) {
        throw new Error(
          `Gemini image analysis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const text = response.text;
      if (!text) throw new Error("Gemini returned no text for that image.");
      return text;
    },
  },
];
