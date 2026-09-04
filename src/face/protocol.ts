// The wire protocol between EVE's face (browser) and the face server.
// Binary WS frames are raw 16 kHz mono Int16 PCM from the mic; everything
// else is JSON matching these types.
import type { Notice } from "../core/notices.js";
import type { Reminder } from "../tools/reminders.js";
import type { DesignEvent } from "../design/types.js";
import type { AgentPhase, AgentDescriptor } from "../core/agent-events.js";

// Memory as the face panel sees it: id (the store name) + text (the hook).
export interface Fact {
  id: string;
  text: string;
}

export type FaceState = "idle" | "listening" | "processing" | "speaking";

export type ClientMsg =
  | { type: "mic"; on: boolean }
  | { type: "interrupt" }
  | { type: "confirm_response"; id: string; ok: boolean }
  | { type: "dismiss"; noticeId: string }
  | { type: "set_paused"; paused: boolean }
  | { type: "refresh" }
  // The Factory's approval gate, from the face card.
  | { type: "factory_approve"; taskId: string }
  | { type: "factory_reject"; taskId: string; feedback: string | null };

export interface Snapshot {
  /** True when this server was started against a throwaway state directory.
   *  face-turn-check refuses to drive a server that is not sandboxed: the
   *  script writes nothing itself, the SERVER records the conversations, so
   *  isolating only the script would isolate nothing. */
  sandboxed: boolean;
  paused: boolean;
  state: FaceState;
  notices: Notice[];
  reminders: Reminder[];
  facts: Fact[];
  usage: { turns: number; inputTokens: number; outputTokens: number; cost: number };
  /** Her real sub-agents — the face's constellation. */
  agents: AgentDescriptor[];
  /** Factory manifests awaiting Umberto's approval — sent on every snapshot,
   *  so a reloaded page never loses pending work. */
  factoryPending: FactoryPending[];
}

export interface FactoryPending {
  taskId: string;
  name: string;
  slug: string;
  specialty: string;
  systemPrompt: string;
  tools: string[];
  model: string;
  round: number; // 1-based revision round
  specPath: string;
}

export type ServerMsg =
  | { type: "state"; state: FaceState }
  | {
      type: "heard";
      text: string;
      interim: boolean;
      language?: string | null;
      speakers?: number;
    }
  | { type: "reply_delta"; text: string }
  | { type: "tool_call"; name: string }
  // One spoken sentence, ready to fetch at /tts/<segId>. The end of a turn is
  // signalled by turn_done rather than an is_final flag: flagging the final
  // segment requires holding each sentence until the next arrives, which
  // delays the FIRST audible word — the one latency that matters most.
  | { type: "speak_segment"; baseTurnId: string; segId: string; seq: number }
  | { type: "turn_done"; baseTurnId: string }
  | { type: "turn_error"; message: string }
  | {
      type: "latency";
      transcriptMs: number | null;
      firstTokenMs: number | null;
      firstSegmentMs: number | null;
    }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "notice"; notice: Notice }
  | { type: "confirm_request"; id: string; intent: string }
  // Sent when a confirmation is answered (by any client) or times out, so
  // every connected page can drop its stale card.
  | { type: "confirm_resolved"; id: string }
  // Live progress from a background design dispatch (planner, Claude Code
  // tool use, images, audit) — see src/design/types.ts DesignEvent.
  | { type: "design_event"; event: DesignEvent }
  | {
      type: "agent_event";
      agent: string;
      phase: AgentPhase;
      label?: string;
      detail?: Record<string, unknown>;
      descriptor?: AgentDescriptor;
    };
