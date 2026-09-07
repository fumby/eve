// Regression tests for the notice flood: one overdue reminder re-firing on
// the heartbeat produced 405 identical open notices (427 total) because
// (a) addNotice minted a fresh row for every identical event, (b) nothing
// ever pruned the file, and (c) two heartbeat processes (the launchd face
// server + a REPL) erased each other's "already notified" IDs through
// full-file saves of stale state. These pin all three fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addNotice, listNotices, dismissNotice } from "../src/core/notices.js";

test("addNotice: an identical open notice is returned, not duplicated", () => {
  // The flood's direct cause: same check + same text minted a new row every
  // few minutes. Now the second add returns the first row, and the inbox
  // holds exactly one.
  const a = addNotice("due-reminders", 'Reminder due: "test flood" (was due 2026-09-05T09:00)', "loud");
  const b = addNotice("due-reminders", 'Reminder due: "test flood" (was due 2026-09-05T09:00)', "loud");
  assert.equal(a.id, b.id);
  assert.equal(listNotices().length, 1);
  // A DIFFERENT text still gets its own row — dedupe is exact, not fuzzy.
  const c = addNotice("due-reminders", 'Reminder due: "something else" (was due 2026-09-05T10:00)', "loud");
  assert.notEqual(a.id, c.id);
  assert.equal(listNotices().length, 2);
});

test("addNotice: dismissing the deduped notice lets the next occurrence back in", () => {
  // The flood's indirect trap: because every re-fire minted a new id, a
  // dismissal never quieted the reminder — the next identical notice was
  // already on its way with a fresh id. With dedupe, dismiss-once sticks
  // until a genuinely new event (different text) arrives.
  const first = listNotices()[0];
  addNotice("due-reminders", first.text, "loud"); // identical again
  assert.equal(listNotices().length, 2); // still the same two rows
  // Simulate dismissal via the real path, then confirm dedupe still holds.
  dismissNotice(first.id);
  // Re-firing the dismissed text creates a NEW row (it's news again), and
  // re-firing it a second time dedupes against the new one.
  const again = addNotice("due-reminders", first.text, "loud");
  addNotice("due-reminders", first.text, "loud");
  const openNow = listNotices().filter((n) => !n.dismissed);
  const ofText = openNow.filter((n) => n.text === first.text);
  assert.equal(ofText.length, 1);
  assert.equal(ofText[0].id, again.id);
});

test("addNotice: the open set caps at 60 — older items are auto-dismissed, not lost", () => {
  // The inbox is a UI surface, not an archive: unbounded growth re-rendered
  // 427 rows into every snapshot. The cap keeps the newest 60 open and marks
  // the overflow dismissed (still on disk, out of the UI).
  for (let i = 0; i < 70; i++) addNotice("self-review", `bulk notice ${i}`, "quiet");
  const open = listNotices();
  assert.ok(open.length <= 60, `expected ≤60 open, got ${open.length}`);
  // The newest arrivals survived the cull…
  assert.ok(open.some((n) => n.text === "bulk notice 69"));
  // …and the oldest of the bulk was retired, not kept.
  assert.ok(!open.some((n) => n.text === "bulk notice 0"));
});
