// EVE's self-improvement check — a heartbeat that runs on a schedule and has
// EVE herself look at her own configuration, her memory, her tools, and her
// recent conversations, and propose what could be better. She comes back with
// a REPORT — observations and suggestions — never with code. Nothing here
// writes to src/, nothing runs a build, nothing edits a file in the repo.
// The report lands as a quiet notice in the inbox for Umberto to read.
//
// This is the "she can come back with reports if she wants and tell me what
// she thinks we could implement" — a periodic self-review that surfaces ideas,
// not one that acts on them. Acting is Umberto's call, always.
import { loadConfig } from "../core/config.js";
import { listMemories, memoriesAsFacts } from "../memory/store.js";
import { listSkills } from "../skills/store.js";
import { loadConversations, conversationTitle } from "../core/conversations.js";
import { loadReminders } from "../tools/reminders.js";
import { loadStandingChecks } from "./standing-checks.js";
import { Agent } from "../core/agent.js";
import type { Registry } from "../core/registry.js";
import { addNotice } from "../core/notices.js";
import { audit } from "../core/audit.js";

const REVIEW_PROMPT = `You are reviewing your OWN configuration and capabilities as EVE, Umberto's personal assistant. This is a self-improvement check — you look at what you can do, what you've been doing, and what's missing, and you PROPOSE improvements. You do NOT code, you do NOT edit files, you do NOT change settings. You report.

Look at:
- Your tools and capabilities (what you can and can't do)
- Your memory (what you know, what's missing, what might be stale)
- Your skills (procedures you've written for yourself)
- Recent conversations (what Umberto has been asking about)
- Your reminders and commitments (what's pending)
- Your standing checks (what you're already watching on a schedule — never
  propose a near-duplicate; and if one has been running for weeks without
  ever speaking up, say whether it's still worth its cost)

Then write a short report (under 200 words) with:
1. ONE thing that's working well — something you did recently that was useful
2. ONE gap you noticed — something Umberto needed that you couldn't do
3. ONE suggestion — what you think we could implement next, and why

Be honest. If everything is fine, say so — don't manufacture a suggestion. If you noticed a pattern in what Umberto asks for that you can't do yet, name it. This is a report TO Umberto, not an action you take.

Reply with just the report text, no JSON, no code. Speak in your own voice — warm, direct, under 200 words.`;

export async function runSelfReview(registry: Registry): Promise<string | null> {
  const cfg = loadConfig();
  const tools = registry.all().map((t) => ({
    name: t.name,
    description: (t.description ?? "").slice(0, 100),
  }));

  const memories = memoriesAsFacts();
  const skills = listSkills().map((s) => ({ name: s.name, when: s.when, uses: s.uses }));
  const conversations = loadConversations().slice(0, 10).map((c) => ({
    title: conversationTitle(c),
    turns: c.turns.length,
    source: c.source,
    updated: c.updatedAt.slice(0, 10),
  }));
  const reminders = loadReminders().filter((r) => !r.done);
  // Her standing watches, with their track record — the review proposes new
  // ones from recurring topics, so it must know which exist and which earn
  // their keep (weeks of silence = a candidate for removal, not renewal).
  const checks = loadStandingChecks().map((c) => ({
    slug: c.slug,
    mission: c.mission.slice(0, 120),
    every: c.intervalMinutes >= 1440 ? `${Math.round(c.intervalMinutes / 1440)}d` : `${Math.round(c.intervalMinutes / 60)}h`,
    paused: c.paused,
    lastRun: c.lastRunAt ? c.lastRunAt.slice(0, 10) : "never",
    lastSpoke: c.lastResultAt ? c.lastResultAt.slice(0, 10) : "never spoke up",
  }));

  const context = [
    `Current tools (${tools.length}):`,
    ...tools.map((t) => `  - ${t.name}: ${t.description}`),
    "",
    `Memory (${memories.length} entries):`,
    ...memories.map((m) => `  - ${m.text}`),
    "",
    `Skills (${skills.length}):`,
    ...skills.map((s) => `  - ${s.name} (${s.uses} uses): ${s.when}`),
    "",
    `Recent conversations (${conversations.length}):`,
    ...conversations.map((c) => `  - ${c.title} (${c.turns} turns, ${c.source}, ${c.updated})`),
    "",
    `Open reminders (${reminders.length}):`,
    ...reminders.map((r) => `  - ${r.text}${r.due ? ` (due ${r.due})` : ""}`),
    "",
    `Standing checks (${checks.length}):`,
    ...checks.map((c) => `  - ${c.slug} (every ${c.every}${c.paused ? ", PAUSED" : ""}): ${c.mission} — last run ${c.lastRun}, ${c.lastSpoke}`),
    "",
    `Config: model=${cfg.model}, heartbeat checks=${cfg.heartbeat.checks.length}, quiet hours=${cfg.quietHours.start}–${cfg.quietHours.end}`,
  ].join("\n");

  try {
    const agent = new Agent(registry, "heartbeat");
    const report = await agent.runTurn(
      `(This is your scheduled self-improvement review — Umberto didn't type this.)\n\n` +
      REVIEW_PROMPT + "\n\n--- YOUR CURRENT STATE ---\n" + context,
    );

    if (report && report.trim().length > 10) {
      audit("self_review", { length: report.length });
      addNotice(
        "self-review",
        `Self-review: ${report.trim().slice(0, 500)}`,
        "quiet", // never interrupt — this is a suggestion, not an emergency
      );
      return report.trim();
    }
    return null;
  } catch (err) {
    audit("self_review_error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// The heartbeat check entry point — called from the Heartbeat class when the
// "self_review" check is due. Returns the report text or null.
export async function selfReviewCheck(registry: Registry): Promise<string | null> {
  return runSelfReview(registry);
}
