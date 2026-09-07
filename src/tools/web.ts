import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { EveTool } from "../core/registry.js";
import { requireKey, loadConfig } from "../core/config.js";
import { guardOutbound } from "../memory/privacy.js";

// Strip HTML to readable text: drop script/style blocks, then tags, then
// collapse whitespace. A regex, not a parser — this is for EVE reading a page
// on the fly, not for faithfully rendering one. Good enough for the common
// case; the truncation below keeps the worst noise out of the context window.
function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const webTools: EveTool[] = [
  {
    name: "fetch_url",
    description:
      "Fetch a web page by URL and return its text content, or if a question is given, answer it about the page. Strips HTML to text and truncates to ~10k chars. Use this to read a page, look something up at a URL, or answer a question about what a given URL says.",
    schema: z.object({
      url: z
        .string()
        .url()
        .describe("The full URL to fetch, e.g. 'https://example.com/article'."),
      question: z
        .string()
        .optional()
        .describe(
          "An optional question about the page. If given, the page content is sent to Claude to answer it; if omitted, the raw cleaned text is returned.",
        ),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const url = String(input.url);
      // The privacy guard: a URL with his identifiers in it (a query string
      // carrying his email, a path with his address) is a leak to whoever
      // owns the server — and to every proxy in between.
      const refused = guardOutbound(url, "to the web server you asked to fetch");
      if (refused) return refused;
      const res = await fetch(url, {
        headers: { "User-Agent": "EVE/1.0 (personal assistant)" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`fetch failed (${res.status} ${res.statusText})`);
      const html = await res.text();
      const text = htmlToText(html).slice(0, 10000);

      const question = input.question ? String(input.question) : "";
      if (!question) return text || "(the page had no readable text content)";

      // A question was asked: send the page content to Claude and return her
      // answer. Same path delegate.ts uses for a deep-reasoning call — plain
      // Anthropic SDK, no tools, EVE's configured model.
      const client = new Anthropic({ apiKey: requireKey("ANTHROPIC_API_KEY") });
      const completion = await client.messages.create({
        model: loadConfig().model,
        max_tokens: 4096,
        system:
          "You answer questions about web page content accurately and concisely. " +
          "Answer in the language the user uses. If the answer isn't in the text, say so.",
        messages: [
          {
            role: "user",
            content:
              `Here is the text content of ${url} (truncated to 10000 chars):\n\n` +
              `${text}\n\n` +
              `Question: ${question}`,
          },
        ],
      });
      const answer = completion.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter(Boolean)
        .join("")
        .trim();
      return answer || "(Claude returned no answer.)";
    },
  },
];
