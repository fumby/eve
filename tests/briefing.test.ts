// The morning briefing's source list is the contract: every source the prompt
// names is a promise the briefing either keeps or silently breaks. The two
// that were missing are what this file guards:
//
// 1. His class timetable. His classes live on myESSEC behind his login and NOT
//    in his Mac calendar (checked live against Calendar on a lecture day:
//    zero events), so a prompt that only named get_calendar promised the
//    day's picture and delivered a free day on his first morning of lectures.
//    The prompt must name essec_knowledge — with the staleness rule, because
//    the timetable is a stored page read: the briefing must date it, never
//    pass it off as live.
// 2. Never browse from the briefing. essec_knowledge/browse drives his
//    logged-in Chrome; that is a conversational act (essec.ts's own rule —
//    nothing browser-touching runs on the heartbeat), so a prompt that can
//    run unattended (npm run brief, any re-added daily_briefing check) must
//    say so in as many words. The SPOKEN morning brief moved to the wake-up
//    exchange on 2026-09-06 (brain/identity.md, tests/morning.test.ts); this
//    prompt is the on-demand one.
// 3. His study workspace: the review schedule in ~/ESSEC says which topics
//    are due, and the briefing names search_notes so revision makes it into
//    the morning picture — skipping quietly when no studies folder is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefingPrompt } from "../src/heartbeat.js";

test("the briefing draws on his class timetable, never browses for it", () => {
  const p = briefingPrompt("");
  assert.match(p, /essec_knowledge/);
  assert.match(p, /section 'courses'/);
  assert.match(p, /not in Calendar/);
  // The staleness rule: a stored timetable is dated, and refreshing is offered
  // as a conversational act, never performed by the briefing itself.
  assert.match(p, /offer to refresh/);
  assert.match(p, /never browse from the briefing/);
});

test("the briefing still names every source it named before", () => {
  const p = briefingPrompt("");
  // The sources the old prompt promised. If one of these goes, the briefing
  // silently stops covering that part of his day.
  for (const source of [
    "get_calendar",
    "list_reminders",
    "get_weather",
    "check_unread",
    "list_commitments",
    "list_decisions",
  ]) {
    assert.ok(p.includes(source), `the briefing lost ${source}`);
  }
});

test("the briefing reaches his study workspace for revision due today", () => {
  const p = briefingPrompt("");
  assert.match(p, /search_notes/);
  assert.match(p, /skip quietly if no studies folder/);
});

test("the watch digest rides in the prompt", () => {
  const p = briefingPrompt("Your standing watches: one running.");
  assert.ok(p.includes("Your standing watches: one running."));
});
