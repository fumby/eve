// The exam grader's own grader.
//
// scripts/arena-eval.ts decides, from EVE's reply text, whether she answered in
// the language she was asked in. That judgement has been wrong twice, and both
// times it was expensive to find out: the only way to exercise it was a
// nine-turn paid run against the live provider.
//
//   1. The first version scored Italian against eleven hand-picked WEATHER
//      words. EVE's correct Italian reply "Nebbia, 23–34°C, 3% di pioggia.
//      Alba alle 6:42, tramonto alle 19:34." hit one of them and the exam card
//      printed FAIL for a section she had passed.
//   2. It had no English side at all, so when she answered the ENGLISH question
//      "What time is it right now?" with "19:45, domenica 6 settembre." the
//      grader printed PASS and a real defect went into the report as a green.
//
// That is why this test exists in tests/ while the thing it tests lives in
// scripts/: the arena itself makes paid model calls and must stay out of the
// suite, but this piece of it is pure, offline and free. A grader that has only
// ever been green is not known to work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, IT_MARKERS, EN_MARKERS } from "../scripts/arena-language.js";

const detect = (s: string): string => detectLanguage(s).detected;

// The two historical failures, as literal regression cases.
test("the two grader bugs that cost real exam runs stay fixed", () => {
  assert.equal(
    detect("Nebbia, 23–34°C, 3% di pioggia. Alba alle 6:42, tramonto alle 19:34."),
    "it",
    "EVE's real Italian weather reply — the one the word-list grader called English",
  );
  assert.equal(
    detect("19:45, domenica 6 settembre."),
    "it",
    "EVE's real Italian answer to an ENGLISH question — the drift the old grader could not see",
  );
});

// Bug 1 was a topic word-list. Prove the detector no longer depends on the
// subject by asking it about weather it has never been shown.
test("Italian is detected across topics, not just the weather sentence it was tuned on", () => {
  for (const reply of [
    "Sole, 28 gradi.",
    "Domani a Roma sole e 28 gradi.",
    "Poco nuvoloso, massime sui 30.",
    "Ho mandato il messaggio? No, il gate ha rifiutato. Vuoi che riprovi?",
    "Sono le 19:45 di domenica.",
    "Solo la palestra — martedì 8 settembre alle 9:00.",
    "C'è nebbia, 23 gradi.",
    "L'ora dell'alba è alle 6:42.",
  ]) {
    assert.equal(detect(reply), "it", `should read as Italian: ${reply}`);
  }
});

// Bug 2 was a missing English side. The mirror of every Italian case above must
// work, or an English answer to the Italian turn is graded as no answer at all.
test("English is detected in the telegraphic shape EVE actually replies in", () => {
  for (const reply of [
    "Overcast, 22–33°C, no rain expected. Sunrise 6:52, sunset 7:50pm.",
    "Fog, 23–34 degrees, 3% chance of rain. Sunrise 6:42, sunset 19:34.",
    "Sunny, 28 degrees.",
    "Thunderstorms, 24 degrees, 80% rain.",
    "It's 7:45 PM.",
    "Two things: call prof Rossi about thesis feedback, and renew your gym membership.",
    "Nothing on record — I don't have anything from last Tuesday.",
    "That didn't go through — the confirmation prompt got declined.",
  ]) {
    assert.equal(detect(reply), "en", `should read as English: ${reply}`);
  }
});

// The margin exists so one incidental foreign token cannot fail a whole turn.
// Every string here is an ENGLISH sentence carrying Italian proper nouns —
// exactly what an answer about Umberto's evening, his contacts, or his city
// looks like. None of them may come back as "it".
test("an Italian name inside an English sentence is not language drift", () => {
  for (const reply of [
    "Booked: Trattoria da Enzo, 20:30.",
    "Dinner at Osteria della Pace, 8.",
    "Declined — nothing went to Luca Di Marco.",
    "Sunny in Roma tomorrow, 28 degrees.",
    "Tickets for La Scala and Il Duomo.",
  ]) {
    assert.notEqual(detect(reply), "it", `must not read as Italian: ${reply}`);
  }
});

// A clock reading is in no language. Calling that drift would invent a defect —
// the arena's job is to report what it can see, not to guess.
test("a reply with no language in it is unknown, not a guess", () => {
  for (const reply of ["19:45.", "7:45.", "Done.", "RUNTURN ERROR: fetch failed"]) {
    assert.equal(detect(reply), "unknown", `should be undecidable: ${reply}`);
  }
});

// The rule that keeps the two lists honest. Layer 2 is topic vocabulary, which
// is the shape of the ORIGINAL bug; it is only safe while every entry has a
// counterpart on the other side. A word added to one list alone re-creates the
// asymmetry that made a correct Italian reply score as English.
test("no marker appears in both lists, and single ASCII letters stay out", () => {
  for (const w of IT_MARKERS) {
    assert.ok(!EN_MARKERS.has(w), `"${w}" is in BOTH lists — a marker that fires for both sides measures nothing`);
  }
  for (const w of [...IT_MARKERS, ...EN_MARKERS]) {
    assert.ok(
      w.length > 1 || w === "è",
      `"${w}" is a single ASCII letter — tokenising "e.g." yields "e", and "è" is the one deliberate exception`,
    );
  }
  // "all" is unambiguous English, but splitting the Italian elision "all'una"
  // produces it. It must stay out of the English list or every "all'..." in an
  // Italian reply scores a point for English.
  assert.ok(!EN_MARKERS.has("all"), '"all" must stay out — it is the split half of Italian "all\'una"');
});
