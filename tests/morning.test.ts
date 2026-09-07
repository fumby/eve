// The wake-up trigger and the morning facts: the machine half of the morning
// brief. Since 2026-09-06 nothing is pushed at a fixed hour any more — the
// brief belongs to the exchange where Umberto SAYS he's awake, and to no
// other — so what the machine owes that moment is (1) recognising his
// wake-up words, deterministically, so a normal first message never briefs,
// and (2) the two readings the brief must never depend on a tool call for:
// today's classes from the stored myESSEC timetable, and what his standing
// watches have said lately. The day's first exchange stays a plain fact. The instrumentation contract (facts in,
// zero instructions) holds for every one of these lines. The behavioural half
// — what EVE does with them, and the song — lives in brain/identity.md's
// "Mornings" section, which is why these tests pin the FACTS, never the
// behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contextBlock, type SessionFacts } from "../src/brain/prompt.js";
import { morningFacts, wakeUpSignal } from "../src/brain/morning.js";
import { hasExchangeToday, type Conversation } from "../src/core/conversations.js";
import { Agent, type StreamFn } from "../src/core/agent.js";
import { loadConfig, STATE_ROOT } from "../src/core/config.js";
import { writeJson } from "../src/core/store.js";
import { localDate } from "../src/core/time.js";
import { addNotice } from "../src/core/notices.js";
import { saveEntries } from "../src/tools/essec.js";
import { upsertStandingCheck } from "../src/tools/standing-checks.js";

// The store is a plain JSON file (house doctrine: hand-editable state), so the
// fixture writes rows directly with the `at` stamps it wants — recordExchange
// stamps the real clock, which would make these tests pass only on the day
// they happen to run.
function seed(rows: { id: string; source: string; at: string }[]): void {
  const convs: Conversation[] = rows.map((r) => ({
    id: r.id,
    startedAt: r.at,
    updatedAt: r.at,
    source: r.source,
    turns: [{ role: "user", text: "x", at: r.at }, { role: "assistant", text: "y", at: r.at }],
  }));
  writeJson("conversations.json", convs);
}

// A fixed LOCAL noon, same discipline as brain.test.ts: assertions about
// calendar days must not depend on when the suite runs.
const NOON = new Date(2026, 8, 7, 12, 0, 0); // 7 September 2026, local
const iso = (d: Date): string => d.toISOString();

test("hasExchangeToday: empty day is false; a real exchange is true; a heartbeat never counts", () => {
  seed([]); // no conversations at all
  assert.equal(hasExchangeToday(NOON), false);

  seed([{ id: "hb", source: "heartbeat", at: iso(NOON) }]); // a standing check or an on-demand brief ran
  assert.equal(hasExchangeToday(NOON), false, "a heartbeat turn is EVE alone, not contact");

  seed([{ id: "real", source: "face", at: iso(new Date(2026, 8, 7, 8, 15)) }]); // he said buongiorno at 8:15
  assert.equal(hasExchangeToday(NOON), true);
});

test("yesterday's conversation does not consume today's wake-up moment", () => {
  seed([{ id: "last-night", source: "face", at: iso(new Date(2026, 8, 6, 23, 30)) }]);
  assert.equal(hasExchangeToday(NOON), false);
});

test("the context block states the first-exchange fact, plainly, once", () => {
  const withFact = contextBlock(
    {
      startedAt: NOON.toISOString(),
      exchanges: 0,
      source: "face",
      previousSessionEnd: null,
      firstToday: true,
    },
    NOON,
  );
  assert.match(withFact, /^Primo scambio di oggi con Umberto\.$/m);
  // The instrumentation contract: no instruction rides the fact. The morning
  // ritual itself is identity's, and these two layers must stay separable.
  assert.doesNotMatch(withFact, /brief|musica|metti|suona|song/i);

  const withoutFact = contextBlock(
    {
      startedAt: NOON.toISOString(),
      exchanges: 3,
      source: "face",
      previousSessionEnd: null,
    },
    NOON,
  );
  assert.doesNotMatch(withoutFact, /Primo scambio/);
});

// ── the brief moved: nothing fires at a fixed hour ──────────────────────
//
// Twelve mornings of an 08:00 push taught the lesson: it spoke to an empty
// room, it could not know when he actually woke, and by the time he heard it
// the picture was stale. The brief now happens when he says he's awake. This
// pins the retirement so a "helpful" re-add of the check has to be deliberate.
test("the heartbeat no longer pushes a brief at a fixed hour — the brief is the wake-up exchange", () => {
  const kinds = loadConfig().heartbeat.checks.map((c) => c.kind);
  assert.ok(
    !kinds.includes("daily_briefing"),
    `config.json still schedules a daily briefing (checks: ${kinds.join(", ")})`,
  );
});

// ── the morning facts, rendered ─────────────────────────────────────────
//
// What the wake-up carries beyond the observation itself: today's classes
// from the stored timetable and the standing watches' recent word.
// Both were prompt-injected into the old 08:00 briefing for one reason — the
// model must not be able to skip them by skipping a tool call — and that
// reason moves with the brief. They are FACTS: dated readings of what is on
// disk, in the block's own language, with the guidance about what to do with
// a stale timetable left to identity.

const BASE: SessionFacts = {
  startedAt: NOON.toISOString(),
  exchanges: 0,
  source: "face",
  previousSessionEnd: null,
  firstToday: true,
  wokeUp: true,
};
const NO_CLASSES = { status: "empty" as const, readDay: "", coversThrough: "", today: [] };

test("the context block carries today's classes as a dated reading, in the block's own language", () => {
  const block = contextBlock(
    {
      ...BASE,
      morning: {
        classes: {
          status: "classes",
          readDay: "2026-09-06",
          coversThrough: "2026-09-08",
          today: [
            { date: "2026-09-07", start: "08:30", end: "11:30", course: "Macroeconomics", room: "Classroom P.101 | P | Campus Cergy", professor: "Antoine MARTIN" },
            { date: "2026-09-07", start: "13:00", end: "16:00", course: "Geopolitics", room: "Classroom A.133 | A | Campus Cergy", professor: "Josephine STARON" },
          ],
        },
        watches: [],
      },
    },
    NOON,
  );
  assert.match(block, /Lezioni ESSEC di oggi/);
  assert.match(block, /08:30–11:30 Macroeconomics — Classroom P\.101/, "time, course and room — the room is what he actually needs");
  assert.match(block, /Geopolitics/);
  assert.match(block, /Antoine MARTIN/);
  // The day the timetable was READ is in the line: a stored page read must
  // never sound like a live lookup once EVE turns it into speech.
  assert.match(block, /2026-09-06/);
  // Still facts, still no instruction — the same contract as the wake-up line.
  assert.doesNotMatch(block, /brief|musica|metti|suona|song|offer|never|browse/i);
});

test("a timetable that cannot see today says so as a fact — no free day implied, no instruction attached", () => {
  const stale = contextBlock(
    { ...BASE, morning: { classes: { status: "stale", readDay: "2026-09-06", coversThrough: "2026-09-08", today: [] }, watches: [] } },
    NOON,
  );
  assert.match(stale, /2026-09-08/, "it names the last day it does cover");
  assert.doesNotMatch(stale, /nessuna lezione/i, "'no classes' would be a confident lie");
  assert.doesNotMatch(stale, /offer|refresh|browse|brief/i, "what to do about a stale timetable is identity's line, not the fact's");

  const none = contextBlock(
    { ...BASE, morning: { classes: { status: "none", readDay: "2026-09-06", coversThrough: "2026-09-08", today: [] }, watches: [] } },
    NOON,
  );
  assert.match(none, /nessuna lezione/i);
  assert.match(none, /2026-09-08/, "the window is stated so 'nothing today' stays checkable");

  const empty = contextBlock({ ...BASE, morning: { classes: NO_CLASSES, watches: [] } }, NOON);
  assert.doesNotMatch(empty, /ESSEC|lezion/i, "nothing stored leaves no trace — a line about having no timetable reads as a free day");
});

test("standing watches ride the wake-up: what they said lately, and whether one is paused", () => {
  const block = contextBlock(
    {
      ...BASE,
      morning: {
        classes: NO_CLASSES,
        watches: [
          { slug: "weather-paris", paused: false, pausedReason: "", findings: ["Storm tomorrow 14:00–18:00 — take the umbrella."] },
          { slug: "thesis", paused: true, pausedReason: "3 consecutive failures", findings: [] },
        ],
      },
    },
    NOON,
  );
  assert.match(block, /\[weather-paris\]/);
  assert.match(block, /umbrella/);
  assert.match(block, /\[thesis\].*in pausa/i);
  assert.match(block, /3 consecutive failures/);

  const quiet = contextBlock({ ...BASE, morning: { classes: NO_CLASSES, watches: [] } }, NOON);
  assert.doesNotMatch(quiet, /Controlli|watch/i, "no watches, no line — absence leaves no trace");
});

test("without the morning facts, the block carries nothing about classes or watches", () => {
  const block = contextBlock({ startedAt: NOON.toISOString(), exchanges: 3, source: "face", previousSessionEnd: null }, NOON);
  assert.doesNotMatch(block, /ESSEC|Controlli|Lezioni/);
});

// ── the morning facts, gathered ─────────────────────────────────────────
//
// morningFacts() is what the agent calls when his words say he has just woken
// up (wakeUpSignal) — never on the day's first exchange alone. It reads what
// is already on disk and nothing else — never the browser, never a model
// — so the brief carries his classes even if the model never calls
// essec_knowledge, and it degrades to "nothing" rather than a throw when a
// store is missing: a broken store must never cost him his first reply.

function cleanupStores(): void {
  fs.rmSync(path.join(STATE_ROOT, "data", "essec-knowledge.json"), { force: true });
  fs.rmSync(path.join(STATE_ROOT, "data", "standing-checks.json"), { force: true });
  fs.rmSync(path.join(STATE_ROOT, "data", "notices.json"), { force: true });
}

// The myESSEC home page's "COMING SOON" shape, as parseSessions expects it.
const HOME_TIMETABLE = [
  "COMING SOON",
  "ONSITE",
  "Macroeconomics",
  "7 September 2026",
  "08:30 – 11:30",
  "Classroom P.101 | P | Campus Cergy",
  "Antoine MARTIN",
  "ONSITE",
  "Geopolitics",
  "7 September 2026",
  "13:00 – 16:00",
  "Classroom A.133 | A | Campus Cergy",
  "Josephine STARON",
  "ONSITE",
  "Financial Accounting 1",
  "8 September 2026",
  "13:00 – 16:00",
  "Classroom B.223 | B | Campus Cergy",
  "Wolfgang DICK",
].join("\n");

test("morningFacts reads the stores: classes and watches reach the brief with no tool call", async () => {
  cleanupStores();
  saveEntries([
    {
      section: "courses",
      title: "MyESSEC home — upcoming classes",
      text: HOME_TIMETABLE,
      source: { url: "https://my.essec.fr/en/", fetchedAt: "2026-09-06T18:47:58.792Z" },
    },
  ]);
  upsertStandingCheck({ mission: "watch the Paris weather for storms and cold snaps", intervalMinutes: 720, slug: "weather-paris" });
  addNotice("standing:weather-paris", "Storm tomorrow 14:00–18:00 — take the umbrella.", "loud");

  // 07:00 on the 7th, local: the timetable covers it, and the notice above
  // (stamped with the real clock, when this suite runs) is inside the 3-day
  // window only if the suite runs within three days of that morning — so the
  // watch assertion uses the real clock, and the classes assertion the fixed one.
  const facts = await morningFacts(new Date(2026, 8, 7, 7, 0));
  assert.equal(facts.classes.status, "classes");
  assert.equal(facts.classes.readDay, "2026-09-06");
  assert.deepEqual(facts.classes.today.map((s) => s.course), ["Macroeconomics", "Geopolitics"]);

  const live = await morningFacts();
  assert.equal(live.watches.length, 1);
  assert.equal(live.watches[0]?.slug, "weather-paris");
  assert.equal(live.watches[0]?.paused, false);
  assert.ok(live.watches[0]?.findings[0]?.includes("umbrella"), "the watch's recent word rides along");

  cleanupStores();
  const bare = await morningFacts(new Date(2026, 8, 7, 7, 0));
  assert.equal(bare.classes.status, "empty");
  assert.deepEqual(bare.watches, []);
});

// ── the trigger: his words, never the calendar ──────────────────────────
//
// His ask, verbatim in spirit: "trigger the brief only after an explicit
// phrase such as 'I woke up' or 'I'm awake', also look at the time — and add
// tests so a normal first message does not trigger the brief." The detector
// is the deterministic floor (identity may recognise more), so it is pinned
// here on both sides: what fires, and — the half that protects him — what
// must not.

const AT = (h: number, m = 0): Date => new Date(2026, 8, 7, h, m, 0); // 7 September 2026, local

test("wakeUpSignal: an explicit wake-up fires at any hour, in his languages", () => {
  for (const said of [
    "Eve, I just woke up.",
    "I woke up",
    "ok I'm awake",
    "I\u2019m awake now", // curly apostrophe, as a phone keyboard types it
    "I am awake",
    "just got up, what's today like?",
    "mi sono appena svegliato",
    "Mi sono svegliata ora",
    "sono sveglio",
    "sono sveglia eve",
    "appena alzato, che ore sono?",
    "mi sono alzato adesso",
    "I'm up",
    "got out of bed just now",
    "finalmente in piedi",
    "je viens de me réveiller",
    "I just woke up, what happened yesterday?", // the time-shift word is in ANOTHER clause
  ]) {
    assert.equal(wakeUpSignal(said, AT(7, 30)), true, `should fire at 07:30: ${said}`);
    assert.equal(wakeUpSignal(said, AT(15, 0)), true, `a nap is a wake-up too — should fire at 15:00: ${said}`);
  }
});

test("wakeUpSignal: a bare morning greeting fires only in the morning", () => {
  for (const said of ["buongiorno", "Buon giorno Eve", "good morning", "Morning!", "bonjour"]) {
    assert.equal(wakeUpSignal(said, AT(7, 10)), true, `a greeting at 07:10 is a wake-up: ${said}`);
    assert.equal(wakeUpSignal(said, AT(5, 0)), true, `05:00 opens the window: ${said}`);
    assert.equal(wakeUpSignal(said, AT(11, 59)), true, `still morning at 11:59: ${said}`);
    assert.equal(wakeUpSignal(said, AT(12, 0)), false, `12:00 closes it — noon is not morning: ${said}`);
    assert.equal(wakeUpSignal(said, AT(16, 0)), false, `the same word at 16:00 is a hello: ${said}`);
    assert.equal(wakeUpSignal(said, AT(4, 30)), false, `04:30 is the night, not a morning greeting: ${said}`);
  }
  assert.equal(wakeUpSignal("Eve, buongiorno!", AT(7, 10)), true, "a vocative before the greeting is still a greeting");
});

test("a normal first message does not trigger the brief", () => {
  // Each of these is a plausible FIRST message of the day at 08:00 — the
  // exact moment the old 08:00 push used to fire — and none of them is him
  // saying he woke up. They get their own answer, never a briefing.
  const normal = [
    "what's on my calendar today?",
    "ricordami di chiamare Marco alle 5",
    "che ore sono?",
    "ciao",
    "how's the weather?",
    "ask the board about the pricing",
    "what's on this morning?", // "morning" as a time of day, not a greeting
    "can you wake up the face server?", // "wake up", not "woke up"
    "riassumi la lezione di macroeconomia",
    "play some music",
    // Mentions of waking that are not HIM, NOW: third person, past tense,
    // negation. The review caught every one of these firing — and each one
    // would have opened with a gate card for The Clash and a six-part brief.
    "my sister woke up sick last night, can you find a pharmacy",
    "the baby woke up three times",
    "remind me: the neighbours woke up the whole street",
    "my brother woke up at 3am and called me",
    "she woke up",
    "when I woke up yesterday I had a headache, remind me to buy aspirin",
    "set an alarm, I just got up late yesterday and missed class",
    "I have not woken up yet, still in bed",
    "I'm not awake yet, give me a minute",
    "I'm up for a coffee, want to join?", // "up for", not "up"
    "non sono sveglio per niente, parlami più tardi",
    "non sono sveglio, dammi due minuti",
    "non mi sono svegliato in tempo",
    "quando mi sono svegliato ieri avevo mal di testa",
    "je ne suis pas réveillé",
    // A greeting inside a request is the request, not a wake-up.
    "scrivi a Marco: buongiorno e buon compleanno",
    "send Marco a message saying good morning and happy birthday",
    "how do you say 'buongiorno' in French?",
    "remind me to say bonjour to the neighbour",
    "morning run planned at 8",
    "good morning, remind me to call Marco after class", // a greeting with a task attached is a task
  ];
  for (const said of normal) {
    assert.equal(wakeUpSignal(said, AT(8, 0)), false, `must not fire at 08:00: ${said}`);
    assert.equal(wakeUpSignal(said, AT(15, 0)), false, `must not fire at 15:00: ${said}`);
  }

  // And the block the agent builds for such a message — first exchange of
  // the day, no wake-up — carries the first-exchange fact and NOTHING of the
  // brief: no wake-up line, no classes, no watches. The morning readings are
  // gathered only behind the wake-up (agent.ts), so a first message never
  // pays for them either.
  seed([]);
  assert.equal(hasExchangeToday(AT(8, 0)), false, "it is the day's first exchange");
  const block = contextBlock(
    { startedAt: AT(8, 0).toISOString(), exchanges: 0, source: "face", previousSessionEnd: null, firstToday: true },
    AT(8, 0),
  );
  assert.match(block, /Primo scambio di oggi/);
  assert.doesNotMatch(block, /Sveglia|ESSEC|Lezioni|Controlli/);
});

test("the wake-up observation rides the block as a fact, with the readings behind it", () => {
  const block = contextBlock({ ...BASE, morning: { classes: NO_CLASSES, watches: [] } }, NOON);
  assert.match(block, /^Sveglia: dalle sue parole, Umberto si è appena svegliato\.$/m);
  // Same contract as every other line: an observation, no instruction.
  assert.doesNotMatch(block, /brief|musica|metti|suona|song|offer|never|browse/i);

  const noWake = contextBlock({ ...BASE, wokeUp: false }, NOON);
  assert.doesNotMatch(noWake, /Sveglia/);
});

// ── the wiring: what the turn actually sends ────────────────────────────
//
// Everything above pins the pieces. This pins the ASSEMBLY, through the real
// Agent.runTurn with a scripted stream, because the retired behaviour is one
// edit away — `wokeUp = firstToday || …`, or gathering the readings on every
// turn — and none of the piecewise tests would notice. What is asserted is
// the last user message the model would have received: on a normal first
// message of the day, the first-exchange fact and nothing of the brief; on
// "I just woke up", the observation and both readings, first exchange or not;
// on a heartbeat turn, never.

function scriptedStream(seen: string[]): StreamFn {
  return async function* (opts) {
    const last = opts.messages[opts.messages.length - 1];
    seen.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
    yield { type: "text", delta: "ok" };
    yield {
      type: "done",
      stopReason: "end_turn",
      assistantContent: [{ type: "text", text: "ok", citations: null }],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
}

test("through the turn loop: a normal first message sends no brief, a wake-up sends the readings, a heartbeat never", async () => {
  cleanupStores();
  seed([]); // no exchange today: the first message IS the day's first exchange
  const today = localDate(new Date());
  saveEntries([
    {
      section: "courses",
      title: "Macroeconomics — session",
      text: [`${today} 08:30`, "Onsite", "Macroeconomics", "Date", "Schedule", "08:30 – 11:30", "Location", "Classroom P.101 | P | Campus Cergy", "Antoine MARTIN"].join("\n"),
      source: { url: "https://my.essec.fr/en/agenda/test", fetchedAt: new Date().toISOString() },
    },
  ]);
  upsertStandingCheck({ mission: "watch the Paris weather for storms and cold snaps", intervalMinutes: 720, slug: "weather-paris" });
  addNotice("standing:weather-paris", "Rain from 14:00 — take the umbrella.", "loud");

  const seen: string[] = [];
  await new Agent(undefined, "face", undefined, scriptedStream(seen)).runTurn("what's on my calendar today?");
  const normal = seen[0] ?? "";
  assert.match(normal, /Primo scambio di oggi/, "it was the day's first exchange");
  assert.doesNotMatch(normal, /Sveglia|Lezioni|Controlli|Macroeconomics|weather-paris/, "and it got no brief material");

  // Now an exchange exists today, so this is NOT the first — and it briefs anyway.
  await new Agent(undefined, "face", undefined, scriptedStream(seen)).runTurn("Eve, I just woke up.");
  const wake = seen[1] ?? "";
  assert.doesNotMatch(wake, /Primo scambio/, "not the day's first exchange any more");
  assert.match(wake, /Sveglia: dalle sue parole/);
  assert.match(wake, /Lezioni ESSEC di oggi/);
  assert.match(wake, /08:30–11:30 Macroeconomics — Classroom P\.101/);
  assert.match(wake, /\[weather-paris\] attivo; di recente: Rain from 14:00/);

  // A heartbeat turn is EVE alone: the same words never brief.
  await new Agent(undefined, "heartbeat", undefined, scriptedStream(seen)).runTurn("I just woke up");
  assert.doesNotMatch(seen[2] ?? "", /Sveglia|Lezioni|Controlli/);
  cleanupStores();
});
