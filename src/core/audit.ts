// The visible audit trail: logs/audit.jsonl, one JSON line per event. When
// EVE surprises you, this is how you find out what happened — and what it cost.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { STATE_ROOT, loadConfig } from "./config.js";

const LOG_DIR = path.join(STATE_ROOT, "logs");
const LOG = path.join(LOG_DIR, "audit.jsonl");

// The mind map subscribes here rather than the other way round, so nothing in
// EVE's hot path has to know a visualiser exists. Handlers must never throw.
type MindListener = (event: string, detail: Record<string, unknown>) => void;
const mindListeners: MindListener[] = [];
export function onAuditEvent(fn: MindListener): void {
  mindListeners.push(fn);
}

export function audit(event: string, detail: Record<string, unknown> = {}): void {
  for (const fn of mindListeners) {
    try {
      fn(event, detail);
    } catch {
      // a spectator must never break the thing it is watching
    }
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Spread FIRST: a detail key named "event" or "ts" must never overwrite the
    // line's own label — the Factory files use detail.event as a sub-stage.
    fs.appendFileSync(LOG, JSON.stringify({ ...detail, ts: new Date().toISOString(), event }) + "\n");
  } catch {
    // The audit trail must never take EVE down with it.
  }
}

// Running cost tally for today, straight from the log. Cache reads bill at
// 10% of the input price and cache writes at 125% — counted honestly so the
// caching Tier's savings are measured, not asserted.
export async function usageToday(): Promise<{
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}> {
  const totals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
  if (!fs.existsSync(LOG)) return totals;
  const today = new Date().toISOString().slice(0, 10);
  const rl = readline.createInterface({ input: fs.createReadStream(LOG) });
  for await (const line of rl) {
    try {
      const e = JSON.parse(line) as {
        ts?: string;
        event?: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
      if (e.event !== "model_turn" || !e.ts?.startsWith(today)) continue;
      totals.turns++;
      totals.inputTokens += e.inputTokens ?? 0;
      totals.outputTokens += e.outputTokens ?? 0;
      totals.cacheReadTokens += e.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += e.cacheWriteTokens ?? 0;
    } catch {
      // skip malformed lines
    }
  }
  const p = loadConfig().pricing;
  totals.cost =
    (totals.inputTokens / 1_000_000) * p.inputPerMTok +
    (totals.outputTokens / 1_000_000) * p.outputPerMTok +
    (totals.cacheReadTokens / 1_000_000) * p.inputPerMTok * 0.1 +
    (totals.cacheWriteTokens / 1_000_000) * p.inputPerMTok * 1.25;
  return totals;
}
