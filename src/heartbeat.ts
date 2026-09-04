// The heartbeat: EVE acting without being spoken to. A light loop that wakes
// on an interval, runs config-defined checks when they're due, and routes
// anything noteworthy into the notices inbox. Quiet by default — most ticks
// produce nothing. Cleanly separable so it can move to an always-on host.
import { loadConfig, type Config, type HeartbeatCheck } from "./core/config.js";
import { readJson, writeJson } from "./core/store.js";
import { addNotice, osNotification, type Notice } from "./core/notices.js";
import { localMinute } from "./core/time.js";
import { audit } from "./core/audit.js";
import { Agent } from "./core/agent.js";
import type { Registry } from "./core/registry.js";
import { loadReminders } from "./tools/reminders.js";

interface HeartbeatState {
  nextDue: Record<string, string>;
  notifiedReminders: string[];
}

const STATE_FILE = "heartbeat.json";
const loadState = (): HeartbeatState =>
  readJson<HeartbeatState>(STATE_FILE, { nextDue: {}, notifiedReminders: [] });
const saveState = (s: HeartbeatState) => writeJson(STATE_FILE, s);

export function inQuietHours(cfg: Config, now = new Date()): boolean {
  const [sh, sm] = cfg.quietHours.start.split(":").map(Number);
  const [eh, em] = cfg.quietHours.end.split(":").map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = (sh ?? 0) * 60 + (sm ?? 0);
  const end = (eh ?? 0) * 60 + (em ?? 0);
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

function nextOccurrence(at: string, from: Date): Date {
  const [h, m] = at.split(":").map(Number);
  const next = new Date(from);
  next.setHours(h ?? 8, m ?? 0, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private runningChecks = new Set<string>();

  constructor(
    private registry: Registry,
    private onNotice?: (n: Notice) => void,
  ) {}

  start(): void {
    const cfg = loadConfig();
    this.timer = setInterval(() => void this.tick(), cfg.heartbeat.tickSeconds * 1000);
    this.timer.unref(); // never keep the process alive just for the heartbeat
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Config is re-read every tick: editing config.json (or /pause) takes
  // effect live, no restart needed.
  async tick(): Promise<void> {
    const cfg = loadConfig();
    if (cfg.heartbeat.paused) return;
    const now = new Date();
    const state = loadState();

    for (const check of cfg.heartbeat.checks) {
      const due = state.nextDue[check.name];
      if (due === undefined) {
        // First time we've seen this check: short interval checks fire on the
        // next tick; time-of-day checks wait for their hour; long-period
        // checks (like the monthly board review, which costs real money)
        // schedule a full period out instead of firing at boot.
        state.nextDue[check.name] =
          typeof check.at === "string"
            ? nextOccurrence(check.at, now).toISOString()
            : check.intervalMinutes >= 1440
              ? new Date(now.getTime() + check.intervalMinutes * 60_000).toISOString()
              : now.toISOString();
        saveState(state);
        continue;
      }
      if (new Date(due) > now || this.runningChecks.has(check.name)) continue;

      // Schedule the next run BEFORE running: a slow check never snowballs.
      state.nextDue[check.name] =
        typeof check.at === "string"
          ? nextOccurrence(check.at, now).toISOString()
          : new Date(now.getTime() + check.intervalMinutes * 60_000).toISOString();
      saveState(state);

      this.runningChecks.add(check.name);
      try {
        await this.runCheck(check, cfg);
      } catch {
        // A failing check must never kill the loop; it just tries again next time.
      } finally {
        this.runningChecks.delete(check.name);
      }
    }
  }

  async runCheck(check: HeartbeatCheck, cfg: Config): Promise<void> {
    // The repo watch can surface several distinct events in one tick — each
    // deserves its own notice, so it emits a list rather than one text.
    if (check.kind === "repo_watch") {
      const { repoWatchTick } = await import("./watch/github.js");
      for (const text of await repoWatchTick()) this.emit(check, cfg, text);
      return;
    }

    let text: string | null = null;
    if (check.kind === "due_reminders") text = this.checkDueReminders();
    else if (check.kind === "daily_briefing") text = await this.composeBriefing();
    else if (check.kind === "board_review") text = await this.standingBoardReview();

    if (!text) return; // quiet by default
    this.emit(check, cfg, text);
  }

  private emit(check: HeartbeatCheck, cfg: Config, text: string): void {
    const notice = addNotice(check.name, text, check.loudness);
    audit("notice", { check: check.name, loudness: check.loudness, id: notice.id });
    const interruptOk = check.loudness === "loud" && !inQuietHours(cfg);
    if (interruptOk) {
      osNotification(text);
      this.onNotice?.(notice);
    }
  }

  private checkDueReminders(): string | null {
    const state = loadState();
    const now = localMinute(); // reminders are stored as local minutes
    const due = loadReminders().filter(
      (r) => !r.done && r.due !== null && r.due <= now && !state.notifiedReminders.includes(r.id),
    );
    if (due.length === 0) return null;
    state.notifiedReminders.push(...due.map((r) => r.id));
    saveState(state);
    const list = due.map((r) => `"${r.text}" (was due ${r.due})`).join("; ");
    return due.length === 1 ? `Reminder due: ${list}` : `Reminders due: ${list}`;
  }

  // The most valuable thing a real board does is show up when nobody called
  // the meeting. Once a month it convenes over the situation itself — no
  // router (there is no question to route), every seat seated.
  async standingBoardReview(): Promise<string | null> {
    const { convene } = await import("./board/meeting.js");
    const result = await convene(
      "You did not call this meeting, so there is no question but the business — " +
        "Umberto's situation itself. Read the brief. What would you put on the " +
        "agenda this month that he is not already looking at? Name the specific " +
        "fact that moves you, say what it implies, and give one concrete thing to " +
        "do in the next 30 days. If his situation genuinely warrants nothing, say " +
        "so plainly rather than manufacturing a concern. Do not ask what he wants " +
        "to discuss — this is your agenda, not his.",
      { unprompted: true, allSeats: true },
    );
    if (!result.ok) return null; // budget off or roster empty: stay quiet, log carries why
    return `Unprompted board review — ${result.record!.spoken} (full minutes: ask me for the board minutes)`;
  }

  // The briefing is composed by the SAME brain and tools as a spoken or typed
  // turn — the heartbeat just decides when a turn happens.
  async composeBriefing(): Promise<string> {
    const agent = new Agent(this.registry, "heartbeat");
    return agent.runTurn(
      "(This is your scheduled daily-briefing check — Umberto didn't type this.) " +
        "Compose his morning briefing: check list_reminders for today and open items, " +
        "get_weather for his home city if one is configured (skip weather gracefully if not), " +
        "and mention anything from memory that matters today, like approaching exams. " +
        "Keep it warm, spoken-style, and under 120 words.",
    );
  }
}
