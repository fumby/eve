// A tiny bus for "a sub-agent is doing something": the board's seats when a
// meeting fans out, the Researcher during deep_research, the Head of Design
// while a dispatch runs. The face subscribes and animates the constellation;
// the audit log keeps the milestones (not the per-search "working" ticks).
// Lives in core/ so board/, tools/ and design/ can import it without cycles.
import { audit } from "./audit.js";

export type AgentPhase = "dispatch" | "working" | "done" | "error";

export interface AgentDescriptor {
  id: string;
  name: string;
  specialty: string;
  color?: string;
  avatarUrl?: string;
  initial?: string;
}

export interface AgentEvent {
  agent: string;
  phase: AgentPhase;
  label?: string;
  detail?: Record<string, unknown>;
  /** Only needed for an agent the face has never seen — lets it appear at runtime. */
  descriptor?: AgentDescriptor;
  at: string;
}

type Listener = (e: AgentEvent) => void;
const listeners: Listener[] = [];

export function onAgentEvent(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function emitAgentEvent(e: Omit<AgentEvent, "at">): void {
  const full: AgentEvent = { ...e, at: new Date().toISOString() };
  if (full.phase !== "working") {
    audit("agent_event", {
      agent: full.agent,
      phase: full.phase,
      ...(full.label ? { label: full.label.slice(0, 120) } : {}),
    });
  }
  for (const fn of listeners) {
    try {
      fn(full);
    } catch {
      // a spectator must never break the work it is watching
    }
  }
}
