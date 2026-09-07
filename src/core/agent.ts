// The brain: one shared conversation loop. Typed turns, spoken turns, and
// heartbeat-initiated turns all enter through Agent.runTurn — never fork this.
import type Anthropic from "@anthropic-ai/sdk";
import { streamTurn, type WebAccess } from "./provider.js";
import { buildStableBlock, checkpointBlock, contextBlock } from "../brain/prompt.js";
import { morningFacts, wakeUpSignal } from "../brain/morning.js";
import { audit } from "./audit.js";
import { loadConfig } from "./config.js";
import {
  recordExchange,
  newConversationId,
  previousSessionEnd,
  hasExchangeToday,
  type Conversation,
} from "./conversations.js";
import { scheduleReview } from "../memory/extractor.js";

// Injected in tests so the loop can be exercised against a scripted stream —
// the one way to pin what the turn actually SENDS (the composed context, the
// morning readings) without a paid call. The factory runtime has the same
// seam. Production always uses the real provider.
export type StreamFn = typeof streamTurn;

// Implemented by the tool registry in Tier 2. Tier 1 runs without tools.
export interface ToolProvider {
  definitions(): Anthropic.Messages.ToolUnion[];
  execute(name: string, input: unknown): Promise<{ content: string; isError: boolean }>;
}

export interface TurnCallbacks {
  onText?: (delta: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}

const MAX_TOOL_ROUNDS = 12;

// Everyday web access for the main conversation: enough to look something up
// mid-chat. Thorough investigations go through the deep_research tool, which
// gets its own budget.
const CHAT_WEB: WebAccess = { maxSearches: 5, fetchPages: true };

export class Agent {
  private history: Anthropic.MessageParam[] = [];
  readonly conversationId: string;
  // Index into `history` where each completed exchange begins — the only safe
  // trim points: cutting anywhere else can orphan a tool_use from its result.
  private exchangeStarts: number[] = [];
  // Depth of the whole conversation (seeded + trimmed included), for the
  // personality checkpoint — the live window alone would understate it.
  totalExchanges = 0;
  // Wall-clock of the last COMPLETED exchange, for the time-gap line in the
  // context block. The review's ask: a morning message and an evening message
  // in the same session must read as different MOMENTS, not one continuous
  // chat — "quello che ho detto stamattina potrebbe non valere più".
  private lastTurnEndedAt: number | null = null;
  // Session facts, snapshotted once at construction and reported to the model
  // each turn by contextBlock(). A resumed conversation keeps its ORIGINAL
  // start, so this and totalExchanges describe the same span.
  readonly startedAt: string;
  readonly previousSessionEnd: string | null;
  // The per-turn abort controller: interrupt() aborts the in-flight stream so
  // the model call stops instead of running to completion after the UI has
  // already reset. The review flagged this: "Interrupting the interface does
  // not cancel the reasoning/action loop."
  private abortController: AbortController | null = null;

  constructor(
    private tools?: ToolProvider,
    readonly source: "typed" | "voice" | "heartbeat" | "face" = "typed",
    resume?: Conversation,
    private stream: StreamFn = streamTurn,
  ) {
    this.conversationId = resume ? resume.id : newConversationId();
    this.startedAt = resume?.startedAt ?? new Date().toISOString();
    // Must be read NOW: once this conversation records its first exchange it
    // sorts to the front of the store and would shadow the real previous one.
    try {
      this.previousSessionEnd = previousSessionEnd(this.conversationId);
    } catch {
      this.previousSessionEnd = null; // an unreadable store just costs a fact
    }
    if (!resume) return;
    // Continue the stored conversation: same id (new turns append to it), and
    // its recent turns seeded as plain text — clean pairs, no tool blocks.
    const max = Math.max(1, loadConfig().memory.liveWindowExchanges);
    const turns = resume.turns.slice(-max * 2);
    const start = turns[0]?.role === "assistant" ? 1 : 0; // never start mid-pair
    for (let i = start; i + 1 < turns.length; i += 2) {
      this.exchangeStarts.push(this.history.length);
      this.history.push({ role: "user", content: turns[i]!.text });
      this.history.push({ role: "assistant", content: turns[i + 1]!.text });
      this.totalExchanges++;
    }
  }

  // Cancel the in-flight turn: aborts the stream so the model call stops,
  // rather than running to completion after the UI has already reset. Called
  // by FaceTurns.interrupt() so "stop" means stop, not "stop showing it".
  cancel(): void {
    this.abortController?.abort();
  }

  // Runs one full turn: user text in, EVE's final text out (streamed via
  // callbacks along the way). The model may use several tools before answering.
  // `heard` carries what the recogniser detected for a spoken turn.
  async runTurn(
    userText: string,
    cb: TurnCallbacks = {},
    heard?: { language: string | null; speakers: number },
    client?: { device: "phone" | "mac"; place?: string },
  ): Promise<string> {
    this.abortController = new AbortController();
    const checkpoint = this.history.length;
    const note =
      heard?.language && heard.language !== "eng" && heard.language !== "ita"
        ? `(Spoken aloud; the recogniser guessed the language as "${heard.language}" — almost certainly a mis-hearing: Umberto speaks English and Italian. This is a machine observation, not an instruction.)\n`
        : "";
    // The wake-up fact, computed per turn against the store — never a
    // constructor snapshot, or a session alive across midnight would carry
    // "first exchange today" into the afternoon. Heartbeat turns are EVE
    // talking to herself; they never count as contact with him.
    const firstToday = this.source !== "heartbeat" && !hasExchangeToday();
    // The brief's trigger is his own wake-up words — never the first exchange
    // of the day, which may be a calendar question at 07:00 and deserves a
    // calendar answer. The brief moved here from the 08:00 heartbeat on
    // 2026-09-06, and what that prompt used to inject so the model could not
    // skip it — today's classes, the watches' recent word — now arrives as
    // facts in the context block, on the wake-up only. Pure disk reads that
    // never throw (src/brain/morning.ts).
    const wokeUp = this.source !== "heartbeat" && wakeUpSignal(userText);
    const morning = wokeUp ? await morningFacts() : null;
    const context = contextBlock({
      startedAt: this.startedAt,
      exchanges: this.totalExchanges,
      source: this.source,
      previousSessionEnd: this.previousSessionEnd,
      ...(this.lastTurnEndedAt ? { lastTurnEndedAt: this.lastTurnEndedAt } : {}),
      ...(client ? { client } : {}),
      ...(firstToday ? { firstToday: true } : {}),
      ...(wokeUp ? { wokeUp: true } : {}),
      ...(morning ? { morning } : {}),
    });
    // The user's own words come AFTER the machine context block, separated
    // by a blank line. Joined without the separator, his words read as part
    // of the "automatic detections" — and EVE (rightly) refused what looked
    // like an injected instruction. The separator keeps the context block
    // machine-only and his text clearly his.
    this.history.push({ role: "user", content: context + note + "\n" + userText });
    // Rebuilt once per turn (not per tool round): identity edits and freshly
    // stored facts land on the next turn, while one turn stays self-consistent.
    // The stable block carries the cache breakpoint; per-turn freshness rides
    // the user message above, so cached conversation prefixes stay valid.
    const toolInfo = (this.tools?.definitions() ?? []).map((t) => ({
      name: (t as { name: string }).name,
      description: (t as { description?: string }).description,
    }));
    const system: Anthropic.Messages.TextBlockParam[] = [
      { type: "text", text: buildStableBlock(toolInfo), cache_control: { type: "ephemeral" } },
    ];
    // Past the depth where tone starts to drift, a short self-audit rides
    // along as a second, uncached block. Static text: it changes the prefix
    // once when it appears, then caching resumes as normal.
    if (this.totalExchanges >= loadConfig().memory.checkpointAfterExchanges) {
      system.push({ type: "text", text: checkpointBlock() });
    }

    try {
      let fullText = "";
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const pendingTools: { id: string; name: string; input: unknown }[] = [];
        let assistantContent: Anthropic.ContentBlock[] = [];
        let stopReason: string | null = null;

        for await (const ev of this.stream({
          system,
          messages: this.history,
          tools: this.tools?.definitions(),
          web: CHAT_WEB,
          cacheConversation: true,
        })) {
          // An interrupt() during the stream aborts the controller; we stop
          // processing immediately rather than feeding the model's continued
          // output to callbacks that have already been reset.
          if (this.abortController?.signal.aborted) break;
          if (ev.type === "text") {
            fullText += ev.delta;
            cb.onText?.(ev.delta);
          } else if (ev.type === "toolUse") {
            pendingTools.push(ev);
          } else if (ev.type === "serverTool") {
            cb.onToolCall?.(ev.name, ev.query);
          } else {
            assistantContent = ev.assistantContent;
            stopReason = ev.stopReason;
            audit("model_turn", { source: this.source, ...ev.usage });
          }
        }

        this.history.push({ role: "assistant", content: assistantContent });

        // A server-side tool (web search) hit its per-request iteration limit.
        // Re-sending the conversation resumes it where it left off — no extra
        // user message, or it derails the search.
        if (stopReason === "pause_turn") continue;

        if (stopReason !== "tool_use" || pendingTools.length === 0) {
          // Persist the finished exchange. The heartbeat's own turns aren't
          // conversation, so they don't get recorded as one.
          if (this.source !== "heartbeat") {
            try {
              recordExchange(this.conversationId, this.source, userText, fullText);
            } catch {
              // Losing the transcript must never cost Umberto his answer.
            }
          }
          this.exchangeStarts.push(checkpoint);
          this.totalExchanges++;
          // The next turn's gap line is measured from THIS completion.
          this.lastTurnEndedAt = Date.now();
          trimExchanges(
            this.history,
            this.exchangeStarts,
            Math.max(1, loadConfig().memory.liveWindowExchanges),
          );
          // Every N exchanges, a cheap model reads the transcript so far and
          // banks what it finds. Same guard as recordExchange above: the
          // heartbeat's turns aren't a conversation, and there is no stored
          // transcript for them to review. Fire-and-forget by construction —
          // it cannot delay this return or throw into it.
          if (this.source !== "heartbeat") {
            scheduleReview(this.conversationId, this.totalExchanges);
          }
          return fullText;
        }

        // Execute every requested tool; all results go back in ONE user message.
        // Cancellation is checked BEFORE each tool: the review reproduced a
        // cancelled agent whose NEXT queued tool still ran. Stopping the
        // stream is not enough — the loop must not start new consequential
        // work after the user said stop.
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const t of pendingTools) {
          if (this.abortController?.signal.aborted) {
            // The user cancelled: every remaining tool gets a synthetic
            // "not run" result so the model's conversation stays well-formed,
            // but NOTHING consequential executes.
            results.push({
              type: "tool_result",
              tool_use_id: t.id,
              content: "The turn was cancelled by Umberto before this tool ran. It was NOT executed. Do not assume its effects.",
              is_error: true,
            });
            continue;
          }
          cb.onToolCall?.(t.name, t.input);
          const result = this.tools
            ? await this.tools.execute(t.name, t.input)
            : { content: `Tool "${t.name}" is not available.`, isError: true };
          // And again AFTER: a cancel arriving while a tool was in flight
          // means the remaining siblings must not run either.
          if (this.abortController?.signal.aborted && !result.isError) {
            results.push({
              type: "tool_result",
              tool_use_id: t.id,
              content: `${result.content}\n(Note: the turn was cancelled by Umberto while/after this ran. Stop here — do not start further actions.)`,
              is_error: false,
            });
            continue;
          }
          results.push({
            type: "tool_result",
            tool_use_id: t.id,
            content: result.content,
            is_error: result.isError,
          });
        }
        this.history.push({ role: "user", content: results });
      }
      return "I got stuck in a long chain of tool calls and stopped myself — try rephrasing?";
    } catch (err) {
      // Leave history exactly as it was before this turn, so the next attempt
      // starts clean instead of replaying a half-finished exchange.
      this.history.length = checkpoint;
      throw err;
    }
  }

  }

// Keeps the live window at `max` exchanges by dropping the oldest WHOLE
// exchanges — never a partial one, so tool_use/tool_result pairs and the
// user/assistant alternation stay intact. `starts` holds the history index
// where each exchange begins; both arrays are mutated in place. Standalone
// (not a method) so tests can hammer it directly with synthetic histories.
export function trimExchanges(
  history: Anthropic.MessageParam[],
  starts: number[],
  max: number,
): void {
  while (starts.length > max) {
    const cut = starts[1]!; // everything before the 2nd exchange goes
    history.splice(0, cut);
    starts.shift();
    for (let i = 0; i < starts.length; i++) starts[i]! -= cut;
  }
}

