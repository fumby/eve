// Conversations on disk. Until now EVE's history lived only in memory and died
// with the process, so nothing she talked about could ever be looked back at —
// and the mind map's "working memory" region would have had nothing in it.
import crypto from "node:crypto";
import { readJson, writeJson } from "./store.js";

export interface ConvTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface Conversation {
  id: string;
  startedAt: string;
  updatedAt: string;
  source: string; // typed | voice | face | heartbeat
  turns: ConvTurn[];
  // When the memory extractor last processed this conversation. A resumed
  // conversation that grew since then counts as unprocessed again.
  distilledAt?: string;
}

const FILE = "conversations.json";
const MAX_CONVERSATIONS = 60;
const MAX_TURNS = 200;

export const loadConversations = (): Conversation[] =>
  readJson<Conversation[]>(FILE, []);

export function newConversationId(): string {
  return crypto.randomBytes(4).toString("hex");
}

// Appends a pair of turns to the given conversation, creating it on first use.
export function recordExchange(
  id: string,
  source: string,
  userText: string,
  assistantText: string,
): void {
  const all = loadConversations();
  let conv = all.find((c) => c.id === id);
  const now = new Date().toISOString();
  if (!conv) {
    conv = { id, startedAt: now, updatedAt: now, source, turns: [] };
    all.push(conv);
  }
  conv.turns.push({ role: "user", text: userText, at: now });
  conv.turns.push({ role: "assistant", text: assistantText, at: now });
  if (conv.turns.length > MAX_TURNS) conv.turns.splice(0, conv.turns.length - MAX_TURNS);
  conv.updatedAt = now;

  // Keep the newest conversations; old ones age out rather than growing forever.
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  writeJson(FILE, all.slice(0, MAX_CONVERSATIONS));
}

export function getConversation(id: string): Conversation | null {
  return loadConversations().find((c) => c.id === id) ?? null;
}

export function markDistilled(id: string): void {
  const all = loadConversations();
  const conv = all.find((c) => c.id === id);
  if (!conv) return;
  conv.distilledAt = new Date().toISOString();
  writeJson(FILE, all);
}

// Conversations the extractor still owes a pass: substantial, settled (older
// than the resume window, so they won't grow mid-extraction), and either never
// distilled or grown since the last distillation.
export function undistilled(settledMinutes: number): Conversation[] {
  const cutoff = Date.now() - settledMinutes * 60_000;
  return loadConversations().filter(
    (c) =>
      c.source !== "heartbeat" &&
      c.turns.length >= 4 &&
      Date.parse(c.updatedAt) < cutoff &&
      (!c.distilledAt || c.distilledAt < c.updatedAt),
  );
}

// The conversation to pick back up after a restart or reconnect: the newest
// one, if it's recent enough to still be "what we were just doing". Sources
// don't matter — a thread started at the desk continues in the app.
export function latestResumable(windowMinutes: number): Conversation | null {
  const newest = loadConversations()[0]; // stored newest-first by recordExchange
  if (!newest || newest.turns.length === 0) return null;
  const ageMs = Date.now() - Date.parse(newest.updatedAt);
  return ageMs <= windowMinutes * 60_000 ? newest : null;
}

// When the session before this one ended — the newest stored conversation that
// isn't the current one. Read it ONCE, at Agent construction: after the first
// recordExchange the current conversation sorts to the front and would shadow
// the real previous session forever after.
export function previousSessionEnd(excludeId: string): string | null {
  const prev = loadConversations().find((c) => c.id !== excludeId); // stored newest-first
  return prev?.updatedAt ?? null;
}

// A short human-readable title for a conversation: its first user line.
export function conversationTitle(conv: Conversation): string {
  const first = conv.turns.find((t) => t.role === "user")?.text ?? "(empty)";
  const oneLine = first.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine;
}
