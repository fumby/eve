// THE seam between EVE and the model provider. Nothing outside this file may
// import the Anthropic SDK — swap providers, add retries, or log costs here.
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, requireKey, type Config, type FallbackModel } from "./config.js";
import { audit } from "./audit.js";
import { addNotice } from "./notices.js";

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

// One client per endpoint+key, not one per process: a fallback entry may point
// at a different Anthropic-compatible endpoint with its own key, and rebuilding
// the client on every turn would throw away the connection pool.
const clients = new Map<string, Anthropic>();
function getClient(entry: Attempt): Anthropic {
  const cacheKey = `${entry.baseUrl ?? ""}|${entry.keyEnv ?? "ANTHROPIC_API_KEY"}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = new Anthropic({
      apiKey: requireKey(entry.keyEnv ?? "ANTHROPIC_API_KEY"),
      ...(entry.baseUrl ? { baseURL: entry.baseUrl } : {}),
    });
    clients.set(cacheKey, c);
  }
  return c;
}

// ── the fallback chain ─────────────────────────────────────────────────────
// A 429 or a 529 used to end the turn. In a terminal that is an annoyance you
// retype; mid-sentence in a spoken conversation it is EVE stopping dead, and
// there is no "try again" button in a voice UI.
//
// So the configured model is entry 0 of a chain, and config.fallbacks are the
// rest. Deliberately NOT a provider abstraction: every entry speaks the
// Anthropic Messages API, optionally at another base URL (any
// Anthropic-compatible gateway) with its own key. Generalising the wire
// protocol would trade a real optimisation — ~13k tokens of prompt caching
// tuned against one provider — for flexibility nobody here uses.
export interface Attempt {
  model: string;
  baseUrl?: string;
  keyEnv?: string;
}

// Sticky for the life of the process. Swapping back and forth per turn would
// mean re-paying the cache write on every alternation, and a model that just
// refused you is usually still refusing thirty seconds later.
let activeEntry = 0;

// Called when Umberto picks a new model (set_model): a stale fallback slot
// from a previous outage must not decide which entry the NEXT turn starts
// from. The sticky index exists to save cache writes mid-outage, not to
// override an explicit human choice.
export function resetChain(): void {
  activeEntry = 0;
}

export function chain(cfg: Config): Attempt[] {
  return [
    { model: cfg.model },
    ...cfg.fallbacks.map((f: FallbackModel) => ({
      model: f.model,
      ...(f.baseUrl ? { baseUrl: f.baseUrl } : {}),
      ...(f.keyEnv ? { keyEnv: f.keyEnv } : {}),
    })),
  ];
}

// Worth trying the next entry: the model is busy, missing, or unreachable.
// NOT auth. A rejected key is a broken .env, and falling past it would hide
// the one error whose message already says exactly what to fix — while
// quietly running the whole session somewhere Umberto did not choose.
export function worthFallingBack(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.NotFoundError) return true;
  if (err instanceof Anthropic.APIError) {
    const status = (err as { status?: number }).status;
    // 529 is Anthropic's "overloaded" and is not one of the SDK's own classes.
    return typeof status === "number" && status >= 500;
  }
  return false;
}

// THE entry point. Walks the chain from wherever this process currently is,
// and yields the first attempt that gets as far as producing an event.
//
// The one hard rule: once anything has been yielded, there is no falling back.
// A retry after partial output would repeat the text — and on the voice path
// that is EVE saying the first half of a sentence twice, which is worse than
// the error it was trying to hide.
//
// A caller that PINS a model (the extractor, the board seats) gets a single
// attempt, as before. The chain exists for the conversation; a background job
// that asked for a cheap model must not quietly land on an expensive one.
export async function* streamTurn(opts: Parameters<typeof attemptTurn>[1]): AsyncGenerator<ProviderEvent> {
  const cfg = loadConfig();
  if (opts.model) {
    yield* attemptTurn({ model: opts.model }, opts);
    return;
  }
  const entries = chain(cfg);
  const from = entries[activeEntry]!;
  yield* runChain(entries, (entry) => attemptTurn(entry, opts), activeEntry, (won) => {
    if (won !== activeEntry) announceSwap(from, entries[won]!, won);
  });
}

// The walk itself, with the attempt injected. Split out for one reason: the
// behaviour worth protecting here is what happens on FAILURE, and reaching it
// through the real client would mean waiting for a real rate limit. The tests
// hand it a generator that throws on cue.
export async function* runChain(
  entries: Attempt[],
  attempt: (entry: Attempt) => AsyncGenerator<ProviderEvent>,
  start: number,
  onWin: (index: number) => void,
): AsyncGenerator<ProviderEvent> {
  if (entries.length === 0) {
    throw new ProviderError("The model chain is empty — check `model` in config.json.");
  }
  for (let i = Math.min(Math.max(0, start), entries.length - 1); i < entries.length; i++) {
    let yielded = false;
    try {
      for await (const ev of attempt(entries[i]!)) {
        yielded = true;
        yield ev;
      }
      onWin(i);
      return;
    } catch (err) {
      const last = i === entries.length - 1;
      if (yielded || last || !worthFallingBack(err)) throw toProviderError(err);
      audit("provider_fallback", {
        from: entries[i]!.model,
        to: entries[i + 1]!.model,
        reason: err instanceof Error ? err.message.slice(0, 160) : String(err),
      });
    }
  }
}

// Sticky, and said out loud. A silent downgrade would have EVE sounding
// different for the rest of the session with nothing to explain why.
function announceSwap(from: Attempt, to: Attempt, index: number): void {
  activeEntry = index;
  audit("provider_switched", { from: from.model, to: to.model });
  addNotice(
    "provider",
    `${from.model} wasn't answering, so I switched to ${to.model} and carried on. ` +
      `I'll stay on it until you restart me.`,
    "quiet",
  );
}

// One attempt against one entry in the chain. Everything below this line is
// exactly what streamTurn used to be, with the model coming from the entry.
async function* attemptTurn(entry: Attempt, opts: {
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
    stream = getClient(entry).messages.stream({
      model: entry.model,
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
