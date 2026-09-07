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

// Two processes run heartbeats (the launchd face server + any REPL session),
// and a full-file save of a snapshot held across an await is how they erased
// each other's state: process A loads, awaits a slow check, saves its stale
// copy, and process B's "already notified" IDs written in the meantime are
// gone — so an overdue reminder re-fires every few minutes, forever (405
// duplicate notices traced to exactly this). Every write below therefore
// re-reads the file and merges ONLY its own keys, so concurrent writers add
// to each other's work instead of replacing it.
function updateNextDue(key: string, value: string): void {
  const fresh = loadState();
  fresh.nextDue[key] = value;
  writeJson(STATE_FILE, fresh);
}

function addNotified(ids: string[]): void {
  if (ids.length === 0) return;
  const fresh = loadState();
  const have = new Set(fresh.notifiedReminders);
  for (const id of ids) have.add(id);
  fresh.notifiedReminders = [...have];
  writeJson(STATE_FILE, fresh);
}

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

    for (const check of cfg.heartbeat.checks) {
      const due = loadState().nextDue[check.name];
      if (due === undefined) {
        // First time we've seen this check: short interval checks fire on the
        // next tick; time-of-day checks wait for their hour; long-period
        // checks (like the monthly board review, which costs real money)
        // schedule a full period out instead of firing at boot.
        updateNextDue(
          check.name,
          typeof check.at === "string"
            ? nextOccurrence(check.at, now).toISOString()
            : check.intervalMinutes >= 1440
              ? new Date(now.getTime() + check.intervalMinutes * 60_000).toISOString()
              : now.toISOString(),
        );
        continue;
      }
      if (new Date(due) > now || this.runningChecks.has(check.name)) continue;

      // Schedule the next run BEFORE running: a slow check never snowballs.
      // updateNextDue merges this one key into the fresh file — never a
      // stale full-file save that would erase what a concurrent heartbeat
      // (the face server + a REPL can both be ticking) wrote meanwhile.
      updateNextDue(
        check.name,
        typeof check.at === "string"
          ? nextOccurrence(check.at, now).toISOString()
          : new Date(now.getTime() + check.intervalMinutes * 60_000).toISOString(),
      );

      this.runningChecks.add(check.name);
      try {
        await this.runCheck(check, cfg);
      } catch {
        // A failing check must never kill the loop; it just tries again next time.
      } finally {
        this.runningChecks.delete(check.name);
      }
    }

    // Standing checks: recurring agent-turns EVE set up herself, as data
    // (data/standing-checks.json). One per tick: a slow check never delays
    // the others, and the per-tick cost stays bounded no matter how many
    // exist. Skipped entirely while paused — /pause halts ALL proactive
    // behavior, these included.
    try {
      const { dueStandingChecks, claimStandingCheck, runStandingCheck } = await import(
        "./tools/standing-checks.js"
      );
      const due = dueStandingChecks(now);
      const next = due[0];
      if (next) {
        // Claim FIRST, run after: the claim is the read-check-write that
        // keeps the face server's heartbeat and a REPL's heartbeat from
        // running the same check twice (same discipline as nextDue above).
        const claimed = claimStandingCheck(next.id, now);
        if (claimed) {
          const { Agent } = await import("./core/agent.js");
          const notice = await runStandingCheck(claimed, () => new Agent(this.registry, "heartbeat"));
          if (notice) {
            this.emit(
              {
                name: `standing:${claimed.slug}`,
                kind: "standing_check",
                intervalMinutes: claimed.intervalMinutes,
                loudness: "loud",
              },
              cfg,
              notice,
            );
          }
        }
      }
    } catch {
      // A broken standing check must never kill the loop.
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
    else if (check.kind === "self_review") text = await this.selfReview();
    else if (check.kind === "waiting_for_review") text = await this.waitingForReview();
    else if (check.kind === "memory_hygiene") text = await this.memoryHygiene();

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
    // Merge our IDs into the FRESH file: a full-file save of the state loaded
    // two lines up would erase anything a concurrent heartbeat wrote between
    // the load and here — which is exactly the 405-duplicate-notices bug.
    addNotified(due.map((r) => r.id));
    const list = due.map((r) => `"${r.text}" (was due ${r.due})`).join("; ");
    return due.length === 1 ? `Reminder due: ${list}` : `Reminders due: ${list}`;
  }

  // The waiting-for review — an executive assistant's core proactivity, from
  // the review: surface what's stalled WITHOUT interrupting. Each item fires
  // once per follow-up date (deduped by the notices layer), carrying a
  // prepared next step rather than a bare nag. Quiet by config: it waits in
  // the inbox for the morning briefing or a glance, it never interrupts.
  private async waitingForReview(): Promise<string | null> {
    const today = new Date().toISOString().slice(0, 10);
    const parts: string[] = [];

    // Commitments past due, or waiting-for items past their follow-up date.
    const { openCommitmentsDue } = await import("./tools/commitments.js");
    for (const c of openCommitmentsDue(today)) {
      const kind = c.status === "waiting" ? "Still waiting on" : c.status === "blocked" ? "Blocked" : "Past due";
      parts.push(
        `${kind}: ${c.text} — owner: ${c.owner}` +
          `${c.due ? `, due ${c.due}` : ""}${c.followUp ? `, follow-up was ${c.followUp}` : ""}. ` +
          `Next step: ${c.status === "waiting" ? `prepare a follow-up message to ${c.owner}` : "check what it needs and move it forward"}.`,
      );
    }

    // Decisions whose review date arrived — the loop that makes advice
    // accountable. The recommendation is named against its uncertainty so the
    // review is a real question, not a ritual.
    const { decisionsDueForReview } = await import("./tools/decisions.js");
    for (const d of decisionsDueForReview(today)) {
      parts.push(
        `Decision to review: "${d.title}" — recommended: ${d.recommendation}. ` +
          `Next step: ask Umberto what actually happened, then close it with the outcome${d.owner !== "me" ? ` (owner: ${d.owner})` : ""}.`,
      );
    }

    if (parts.length === 0) return null;
    return parts.join("\n");
  }

  // Memory hygiene: the weekly clock over the long-term store. Memories are
  // point-in-time facts with no expiry of their own — "holiday 15–20 August"
  // sat live in the index a month after it ended, and nothing would ever have
  // flagged it. The scan PROPOSES (a quiet notice listing candidates); it
  // never retires, updates or deletes anything. Acting is Umberto's call,
  // same doctrine as self-review.
  private async memoryHygiene(): Promise<string | null> {
    const { memoryHygiene: scan, hygieneNotice } = await import("./memory/hygiene.js");
    return hygieneNotice(scan());
  }

  // Self-improvement: EVE reviews her own state and comes back with a report
  // of what's working, what's missing, and what she suggests implementing next.
  // She does NOT code — this is a report to Umberto, not an action. It lands as
  // a quiet notice in the inbox; he reads it when he wants, and decides what to
  // do with it. The review is weekly (not daily) because it costs a model call
  // and the report is never urgent.
  async selfReview(): Promise<string | null> {
    const { selfReviewCheck } = await import("./tools/self-review.js");
    await selfReviewCheck(this.registry);
    return null; // quiet: the notice inside is the report, not a spoken message
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
  // turn — the heartbeat just decides when a turn happens. Since 2026-09-06 no
  // heartbeat check schedules it: the morning brief lives in the wake-up
  // exchange (brain/identity.md, "Mornings", fed by src/brain/morning.ts) and
  // is SPOKEN there, where a notice never was. This path stays for
  // `npm run brief` and for a daily_briefing check deliberately re-added to
  // config.json — tests/morning.test.ts pins that none is there by accident.
  async composeBriefing(): Promise<string> {
    // The standing-watch digest rides the prompt directly rather than a tool
    // call: a few lines the briefing must reflect even if the model skips a
    // tool. Built in standing-checks.ts (tested there).
    const { buildWatchDigest } = await import("./tools/standing-checks.js");
    const watchDigest = buildWatchDigest();

    // Today's classes ride the prompt for the same reason, plus one more: the
    // briefing already ASKS for essec_knowledge, but scripts/brief-now.ts builds
    // a small registry that does not register it, so on that path the model
    // cannot call it at all. This is a pure read of what is already on disk —
    // it never browses (essec.ts's rule 4: the heartbeat does not crawl his
    // school account unattended). Empty string when nothing is stored.
    const { buildClassesDigest } = await import("./tools/essec.js");
    const classesDigest = buildClassesDigest();

    const agent = new Agent(this.registry, "heartbeat");
    return agent.runTurn(briefingPrompt(watchDigest, classesDigest));
  }
}

// The briefing prompt, in its own function because it is the part worth
// guarding: which sources the morning picture is drawn from is a promise the
// briefing either keeps or silently breaks, and the ESSEC line is the one that
// was missing — his classes live on myESSEC behind his login, never in his Mac
// calendar, so a briefing that only read Calendar showed a free day on his first
// morning of lectures. The staleness rule matters as much as the inclusion: the
// timetable comes from a stored page read, so it must be dated, never passed
// off as live. And browsing (which drives his logged-in Chrome) stays a
// conversational act: the heartbeat never crawls his school account while
// nobody is watching — essec.ts's own rule.
export function briefingPrompt(watchDigest: string, classesDigest = ""): string {
  return (
    "(This is a briefing turn you run on your own — `npm run brief` on demand, or a " +
    "daily_briefing heartbeat check if one is ever configured. Umberto didn't type this.) " +
    "Compose his morning briefing. Use your tools to gather the day's picture: " +
    "get_calendar for today's schedule (skip gracefully if Calendar isn't reachable) " +
    "— if an event overlaps another, say so plainly; " +
    // The classes digest is dropped in as its own block further down, the way
    // the watch digest is — it is several lines, and interpolated here it ran
    // straight into the next tool instruction. The tool call stays in the list
    // regardless: the digest only carries TODAY, and everything else he asks of
    // his school — a deadline, a room next week, who teaches what — still needs
    // the store read properly.
    "essec_knowledge (action read, section 'courses') for anything else about his " +
    "classes — his school life lives on myESSEC, not in Calendar; if the stored " +
    "timetable is more than a " +
    "few days old, say which day it is from and offer to refresh it when he's there " +
    "(never browse from the briefing); " +
    "list_reminders for today's and open " +
    "items; get_weather for his home city if one is configured (skip weather gracefully " +
    "if not); check_unread for anything pressing in his inbox (skip gracefully if Mail " +
    "isn't reachable); list_commitments for anything waiting-for or past due; and " +
    "list_decisions for any decision he owes a review or an answer on. " +
    "Mention anything from memory that matters today, like approaching exams; " +
    "search_notes in his study workspace for revision due today (the review " +
    "schedule) — skip quietly if no studies folder is configured. " +
    "If a source could not be " +
    "refreshed, say which one rather than presenting a partial picture as complete. " +
    `${watchDigest} Weave in anything a watch found that still matters today; if a watch ` +
    "is paused or keeps failing, say so — it needs his attention. " +
    // Read off the stored timetable rather than a live lookup, so it arrives
    // already dated. Empty when nothing is stored: the prompt then says nothing
    // about classes at all rather than asserting a free day.
    `${classesDigest ? `\n\n${classesDigest}\n\n` : ""}` +
    "Lead with what he has today, then the two or three priorities that actually matter, " +
    "then what needs a decision from him. Keep it warm, spoken-style, under 160 words."
  );
}
