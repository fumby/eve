// Guards for the executive-assistant defects the review reproduced: a
// truncated id could resolve to the WRONG record, and a decision could be
// listed without the evidence that justified it.
//
// Two of these reproduce a real, watched failure:
//   1. Two commitments created in the same millisecond share their leading id
//      characters. `list.find(c => c.id.startsWith(id))` took the FIRST match
//      silently, so "mark that one done" marked the other one done. The rule
//      now: an exact id always wins, a prefix is honoured only when exactly
//      one record matches, and an ambiguous prefix REFUSES and names the
//      candidates. src/tools/decisions.ts had the identical hole in
//      close_decision — an outcome written against the wrong recommendation
//      is worse still, because the ledger is what future advice learns from.
//   2. list_decisions printed the recommendation but not the facts, the
//      unknowns, or what would change EVE's mind — so the ledger showed a
//      conclusion with its evidence stripped off, which is exactly the shape
//      of advice that gets re-trusted without being re-checked.
//
// The state files are written directly here on purpose: newId() is
// millisecond-based, so racing it for a same-millisecond collision is flaky.
// data/*.json is human-editable by design, and a hand-built row is the
// honest way to pin a collision that really happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson, writeJson } from "../src/core/store.js";
import { commitmentTools } from "../src/tools/commitments.js";
import { decisionTools } from "../src/tools/decisions.js";
import { parseCalendarRead, incompletenessNotes, emptyDayAnswer } from "../src/tools/calendar.js";
import { topicTokens, matchesTopic } from "../src/tools/meeting-prep.js";

const commitment = (name: string) => commitmentTools.find((t) => t.name === name)!;
const decision = (name: string) => decisionTools.find((t) => t.name === name)!;

// Append rather than overwrite: the state dir is shared with every other test
// file in the run, so this file only ever adds rows it owns and only ever
// asserts about those rows — never a global count.
function seedCommitments(rows: unknown[]): void {
  const all = readJson<unknown[]>("commitments.json", []);
  writeJson("commitments.json", [...all, ...rows]);
}
function seedDecisions(rows: unknown[]): void {
  const all = readJson<unknown[]>("decisions.json", []);
  writeJson("decisions.json", [...all, ...rows]);
}

test("update_commitment: an ambiguous id prefix refuses instead of guessing", async () => {
  // The reproduced failure: two commitments banked in the same second, both
  // ids beginning "mzk8p1". Umberto says "mark mzk8p1 done" and the FIRST
  // match wins — the wrong promise is closed and the right one stays open,
  // silently. The prefix must now be refused, by name.
  const now = new Date().toISOString();
  const base = {
    owner: "Marco",
    status: "waiting" as const,
    due: null,
    followUp: null,
    source: "executive-fixes test",
    createdAt: now,
    updatedAt: now,
  };
  seedCommitments([
    { ...base, id: "amb1x-alpha", text: "Send Marco the sailing invoice" },
    { ...base, id: "amb1x-beta", text: "Chase Marco about the mooring fee" },
  ]);

  await assert.rejects(
    () => commitment("update_commitment").run({ id: "amb1x", status: "done" }),
    (err: Error) => {
      assert.match(err.message, /ambiguous/i);
      // The refusal has to be actionable: both full ids on the table.
      assert.match(err.message, /amb1x-alpha/);
      assert.match(err.message, /amb1x-beta/);
      return true;
    },
    "an id prefix matching two commitments must throw, not pick one",
  );

  // Neither record was touched by the refused call…
  const afterRefusal = readJson<Array<{ id: string; status: string }>>("commitments.json", []);
  assert.equal(afterRefusal.find((c) => c.id === "amb1x-alpha")?.status, "waiting");
  assert.equal(afterRefusal.find((c) => c.id === "amb1x-beta")?.status, "waiting");

  // …and the FULL id still resolves, to exactly the record it names.
  const out = await commitment("update_commitment").run({ id: "amb1x-beta", status: "done" });
  assert.match(out, /mooring fee/);
  const after = readJson<Array<{ id: string; status: string }>>("commitments.json", []);
  assert.equal(after.find((c) => c.id === "amb1x-beta")?.status, "done");
  assert.equal(after.find((c) => c.id === "amb1x-alpha")?.status, "waiting");
});

// A decision row with everything record_decision would have written, so the
// two decision tests share one shape.
function decisionRow(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    context: "Test context for the executive-fixes guard",
    facts: "",
    unknowns: "",
    options: [{ name: "Do it", pro: "It works", con: "It costs" }],
    recommendation: "Do it",
    uncertainty: "",
    wouldChangeMind: "",
    nextStep: "Draft the email",
    owner: "me",
    reviewBy: null,
    status: "open" as const,
    outcome: null,
    lesson: null,
    createdAt: new Date().toISOString(),
    closedAt: null,
    ...extra,
  };
}

test("close_decision: an ambiguous id prefix refuses and names the candidates", async () => {
  // Same collision as the commitments one, with a worse consequence: the
  // outcome ("we passed on it") gets written against the wrong
  // recommendation, and the ledger — the thing future advice is checked
  // against — is now quietly wrong about what happened.
  seedDecisions([
    decisionRow("dec9z-alpha", "Whether to take the Barcelona internship"),
    decisionRow("dec9z-beta", "Whether to renew the boat mooring"),
  ]);

  await assert.rejects(
    () => decision("close_decision").run({ id: "dec9z", outcome: "We passed on it in the end" }),
    (err: Error) => {
      assert.match(err.message, /ambiguous/i);
      assert.match(err.message, /dec9z-alpha/);
      assert.match(err.message, /dec9z-beta/);
      // The titles make the choice answerable without a second lookup.
      assert.match(err.message, /Barcelona internship/);
      return true;
    },
    "an id prefix matching two decisions must throw, not close one at random",
  );

  // Nothing was closed by the refused call.
  const afterRefusal = readJson<Array<{ id: string; status: string }>>("decisions.json", []);
  assert.equal(afterRefusal.find((d) => d.id === "dec9z-alpha")?.status, "open");
  assert.equal(afterRefusal.find((d) => d.id === "dec9z-beta")?.status, "open");

  // The full id closes exactly the decision it names, and only it.
  const out = await decision("close_decision").run({
    id: "dec9z-beta",
    outcome: "Renewed the mooring for another year",
    lesson: "Ask for the winter rate earlier",
  });
  assert.match(out, /boat mooring/);
  const after = readJson<Array<{ id: string; status: string; outcome: string | null }>>("decisions.json", []);
  assert.equal(after.find((d) => d.id === "dec9z-beta")?.status, "closed");
  assert.equal(after.find((d) => d.id === "dec9z-beta")?.outcome, "Renewed the mooring for another year");
  assert.equal(after.find((d) => d.id === "dec9z-alpha")?.status, "open");
});

test("list_decisions: the evidence is listed, not just the conclusion", async () => {
  // The ledger existed to make advice inspectable. Listing only the
  // recommendation stripped the facts it rests on, the unknowns it was
  // hedged against, and what would overturn it — so a stale recommendation
  // read exactly like a fresh one.
  seedDecisions([
    decisionRow("ev4t-only", "Whether to buy the second monitor", {
      facts: "FACTMARKER the shop quoted 240 EUR on 2026-08-30",
      unknowns: "UNKNOWNMARKER whether the desk fits two panels",
      wouldChangeMind: "CHANGEMARKER a delivery date past October",
    }),
  ]);

  const out = await decision("list_decisions").run({});
  assert.match(out, /Whether to buy the second monitor/);
  assert.match(out, /FACTMARKER the shop quoted 240 EUR on 2026-08-30/);
  assert.match(out, /UNKNOWNMARKER whether the desk fits two panels/);
  assert.match(out, /CHANGEMARKER a delivery date past October/);
});

// ── the calendar read's two silent ways of being wrong ───────────────────
// These drive the REAL parser with captured-shape bridge output, so they run
// on any machine, with or without Calendar.app and with or without events in
// it. The AppleScript half (interval overlap instead of start-in-window) was
// verified against the live app instead — a whose clause cannot be stubbed.
//
// What broke before: the per-calendar `try` swallowed a failing calendar
// whole, and hitting the event cap looked identical to having no more events.
// Either one turns "you are booked" into "your day is clear", and the free-
// slot finder then offers a gap over a real meeting.
test("calendar: a failed calendar and a hit cap come back as facts, not silence", () => {
  const evLine = [2026, 9, 7, 9, 0, 2026, 9, 7, 13, 0, "Board meeting", "Milan", "Work"].join("\t");
  const raw = [
    evLine,
    "ERR\tHoliday subscription\tAppleEvent handler failed. (-1728)",
    "CAP\t30",
  ].join("\n");

  const read = parseCalendarRead(raw);
  // The event still parses — a marker line must not corrupt the real data.
  assert.equal(read.events.length, 1);
  assert.equal(read.events[0]?.summary, "Board meeting");
  // …and the two incompletenesses are now visible to the caller.
  assert.deepEqual(read.failures.map((f) => f.calendar), ["Holiday subscription"]);
  assert.match(read.failures[0]?.why ?? "", /-1728/);
  assert.equal(read.capped, true);

  const notes = incompletenessNotes(read);
  assert.equal(notes.length, 2);
  assert.ok(notes.some((n) => n.includes("some calendars could not be read: Holiday subscription")), notes.join(" | "));
  assert.ok(notes.some((n) => n.includes("event cap reached")), notes.join(" | "));
});

test("calendar: a day with an unread calendar is never called clear", () => {
  // The dangerous sentence. With nothing wrong, "clear" is a fair claim; with
  // a calendar missing from the read it is a guess wearing the same words.
  const complete = emptyDayAnswer("Monday, 7 September 2026", []);
  assert.match(complete, /is clear/);

  const partial = emptyDayAnswer(
    "Monday, 7 September 2026",
    incompletenessNotes({ events: [], failures: [{ calendar: "Work", why: "boom" }], capped: false }),
  );
  assert.doesNotMatch(partial, /is clear/);
  assert.match(partial, /can't call it clear/);
  assert.match(partial, /some calendars could not be read: Work/);
});

test("calendar: a multi-line AppleScript error never invents an event", () => {
  // An AppleScript error string can carry a newline, so its tail arrives as a
  // line of its own. It must be dropped as unparseable, not counted as an
  // event — the whole point is that a broken read cannot inflate the day.
  const read = parseCalendarRead("ERR\tFamily\tsomething failed:\nwith a second line of detail\n");
  assert.equal(read.events.length, 0);
  assert.deepEqual(read.failures.map((f) => f.calendar), ["Family"]);
  assert.equal(read.capped, false);
});

// ── meeting prep's topic matching ────────────────────────────────────────
// The reproduced defect: prepare_meeting searched `topic.split(" ")[0]` — the
// first word and nothing else. "meeting with Marco" therefore searched for
// "meeting", which matches nothing anybody owns, so the one thing prep exists
// to surface — what Marco owes, or is owed — was silently absent from the
// brief. These pin the tokens, because the failure looked exactly like an
// empty ledger.
test("meeting prep: the topic's names are searched, not just its first word", () => {
  assert.deepEqual(topicTokens("meeting with Marco"), ["meeting", "marco"]);
  // Short but capitalised survives — "Bo" is a person, "IE" is a university.
  assert.deepEqual(topicTokens("coffee with Bo about IE"), ["coffee", "bo", "ie"]);
  // A topic of nothing but connectives still searches for something.
  assert.deepEqual(topicTokens("with the"), ["with the"]);

  const tokens = topicTokens("meeting with Marco");
  // The case the review reproduced: the commitment's TEXT never says Marco,
  // only its owner does.
  assert.ok(matchesTopic(tokens, "Send the mooring paperwork", "Marco"));
  // And the other direction: named in the text, owned by someone else.
  assert.ok(matchesTopic(tokens, "Chase Marco about the invoice", "me"));
  // "with" is dropped, so it cannot drag in the whole ledger as a false hit.
  assert.ok(!matchesTopic(tokens, "Review the budget with Anna", "Anna"));
});
