// THE seam between EVE and the model provider. Nothing outside this file may
// import the Anthropic SDK — swap providers, add retries, or log costs here.
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, requireKey, type Config } from "./config.js";

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "toolUse"; id: string; name: string; input: unknown }
  // Anthropic-side tools (web search / fetch) run on their servers; we don't
  // execute them, we just report that they happened so the UI can say so.
  | { type: "serverTool"; name: string; query: string }
  | {
      type: "done";
      stopReason: string | null;
      assistantContent: Anthropic.ContentBlock[];
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      };
    };

export interface WebAccess {
  maxSearches: number;
  fetchPages: boolean;
}

// Thrown for anything the network/provider does wrong; the message is written
// for a human reading a terminal, never a stack trace.
export class ProviderError extends Error {}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireKey("ANTHROPIC_API_KEY") });
  return client;
}

export async function* streamTurn(opts: {
  // A plain string goes through untouched; an array of blocks lets callers
  // mark a stable prefix with cache_control themselves.
  system: string | Anthropic.Messages.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Messages.ToolUnion[];
  // When set, Anthropic's own web search/fetch tools are offered alongside
  // EVE's. They execute server-side and their results arrive in the response.
  web?: WebAccess;
  // null means "send no output_config at all" — for models that don't take an
  // effort parameter (the cheap extractor model, e.g. Haiku).
  effort?: Config["effort"] | null;
  maxTokens?: number;
  // Override the configured model (the extractor runs on a cheaper one).
  model?: string;
  // Force the model to call one specific tool (the Factory's research loop
  // uses this on its final iteration so it always emits a report).
  forceTool?: string;
  // Multi-turn callers set this so the conversation prefix itself is cached
  // incrementally (breakpoint on the newest message). One-shot callers (board
  // seats, research) leave it off — a cache write with no future read is pure
  // surcharge.
  cacheConversation?: boolean;
}): AsyncGenerator<ProviderEvent> {
  const cfg = loadConfig();
  const tools: Anthropic.Messages.ToolUnion[] = [...(opts.tools ?? [])];
  if (opts.web) {
    tools.push({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: opts.web.maxSearches,
    } as Anthropic.Messages.ToolUnion);
    if (opts.web.fetchPages) {
      tools.push({
        type: "web_fetch_20260209",
        name: "web_fetch",
        max_uses: opts.web.maxSearches,
        citations: { enabled: true },
      } as Anthropic.Messages.ToolUnion);
    }
  }

  let stream;
  try {
    stream = getClient().messages.stream({
      model: opts.model ?? cfg.model,
      max_tokens: opts.maxTokens ?? cfg.maxTokens,
      ...(opts.effort === null ? {} : { output_config: { effort: opts.effort ?? cfg.effort } }),
      system: opts.system,
      messages: opts.cacheConversation ? withPrefixBreakpoint(opts.messages) : opts.messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(opts.forceTool ? { tool_choice: { type: "tool", name: opts.forceTool } } : {}),
    });
  } catch (err) {
    throw toProviderError(err);
  }

  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      } else if (
        event.type === "content_block_start" &&
        event.content_block.type === "server_tool_use"
      ) {
        // Announced as it starts, not after the fact, so "searching…" shows
        // while the user is actually waiting on it.
        yield { type: "serverTool", name: event.content_block.name, query: "" };
      }
    }
    const msg = await stream.finalMessage();
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        yield { type: "toolUse", id: block.id, name: block.name, input: block.input };
      }
    }
    yield {
      type: "done",
      stopReason: msg.stop_reason,
      assistantContent: msg.content,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (err) {
    throw toProviderError(err);
  }
}

// Marks the newest message's last content block as a cache breakpoint, so the
// next request in the same conversation reads everything up to here at cache
// price. Clones rather than mutates — history arrays are reused across turns.
function withPrefixBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last || typeof last.content !== "string" && last.content.length === 0) return messages;
  const ephemeral = { type: "ephemeral" as const };
  const content: Anthropic.ContentBlockParam[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content, cache_control: ephemeral }]
      : last.content.map((b, i) =>
          i === (last.content as Anthropic.ContentBlockParam[]).length - 1
            ? ({ ...b, cache_control: ephemeral } as Anthropic.ContentBlockParam)
            : b,
        );
  return [...messages.slice(0, -1), { ...last, content }];
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderError(
      "My API key was rejected — check ANTHROPIC_API_KEY in .env.",
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError(
      "I'm being rate-limited right now. Give me a few seconds and try again.",
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(
      "I couldn't reach the model — the network seems down. Try again in a moment.",
    );
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(`The model provider returned an error: ${err.message}`);
  }
  if (err instanceof Error && /Missing ANTHROPIC_API_KEY/.test(err.message)) {
    return new ProviderError(err.message);
  }
  return new ProviderError(
    `Something unexpected went wrong talking to the model: ${err instanceof Error ? err.message : String(err)}`,
  );
}
