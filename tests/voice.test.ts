import test from "node:test";
import assert from "node:assert/strict";
import { SentenceAssembler, speechify } from "../src/voice/tts.js";
import { pcmToWav, fixName } from "../src/voice/stt.js";

test("single short reply: nothing emitted until flush", () => {
  const a = new SentenceAssembler();
  assert.deepEqual(a.push("Got it."), []); // under min length — held
  assert.equal(a.flush(), "Got it.");
});

test("multi-sentence stream emits each complete sentence once, in order", () => {
  const a = new SentenceAssembler();
  const out: string[] = [];
  for (const delta of [
    "The four Ps are product, price",
    ", place, and promotion. Break-even is fixed",
    " costs over margin. And that",
    "'s the gist!",
  ]) {
    out.push(...a.push(delta));
  }
  assert.deepEqual(out, [
    "The four Ps are product, price, place, and promotion.",
    "Break-even is fixed costs over margin.",
  ]);
  assert.equal(a.flush(), "And that's the gist!");
});

test("one giant delta containing several sentences emits them all", () => {
  const a = new SentenceAssembler();
  const out = a.push(
    "This is the first full sentence of the reply. Here comes a second complete sentence right after. Tail.",
  );
  assert.deepEqual(out, [
    "This is the first full sentence of the reply.",
    "Here comes a second complete sentence right after.",
  ]);
  assert.equal(a.flush(), "Tail.");
});

test("unpunctuated run splits at the length fallback, not mid-word", () => {
  const a = new SentenceAssembler();
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const out = a.push(words);
  assert.ok(out.length >= 1, "long run should split");
  for (const s of out) assert.ok(/^word\d+/.test(s) && /word\d+$/.test(s), `clean word bounds: ${s}`);
  assert.notEqual(a.flush(), null);
});

test("flush is empty after only whitespace", () => {
  const a = new SentenceAssembler();
  a.push("   \n ");
  assert.equal(a.flush(), null);
});

test("speechify says temperatures instead of reading symbols", () => {
  assert.equal(
    speechify("Today it will be 22–29°C in Barcelona."),
    "Today it will be 22 to 29 degrees in Barcelona.",
  );
  // Italian is detected from the sentence, so the units are spoken in Italian
  assert.equal(
    speechify("Domani il sole sorge e ci sono 22–29°C con il 13% di pioggia."),
    "Domani il sole sorge e ci sono 22 a 29 gradi con il 13 per cento di pioggia.",
  );
});

test("speechify turns ISO timestamps into something sayable", () => {
  assert.equal(
    speechify("Your reminder is due 2026-08-21T18:00 sharp."),
    "Your reminder is due 21/08/2026 at 18:00 sharp.",
  );
});

test("speechify strips markdown and stray symbols", () => {
  assert.equal(speechify("That is **really** important"), "That is really important");
  assert.equal(speechify("wind 12 km/h today"), "wind 12 kilometers per hour today");
});

test("speechify leaves ordinary prose untouched", () => {
  const plain = "Sunrise in Barcelona tomorrow is at 7:00, and it should stay dry.";
  assert.equal(speechify(plain), plain);
});

test("fixName repairs her name when it opens the phrase", () => {
  assert.equal(fixName("Ivy, remind me to study"), "Eve, remind me to study");
  assert.equal(fixName("Iv ricordami di studiare"), "Eve ricordami di studiare");
  assert.equal(fixName("Hey Ivy, what's the weather?"), "Hey Eve, what's the weather?");
  assert.equal(fixName("Ciao Eva, come stai?"), "Ciao Eve, come stai?");
  assert.equal(fixName("Okay, Evie, add a reminder"), "Okay, Eve, add a reminder");
});

test("fixName leaves unrelated words and mid-sentence names alone", () => {
  assert.equal(fixName("Eve, remind me"), "Eve, remind me");
  const plain = "I planted ivy in the garden and it grew";
  assert.equal(fixName(plain), plain);
  assert.equal(fixName("the river Ive runs north"), "the river Ive runs north");
});

test("pcmToWav writes a well-formed 16kHz mono header", () => {
  const pcm = new Int16Array([0, 1000, -1000, 32767]);
  const wav = pcmToWav(pcm, 16000);
  assert.equal(wav.length, 44 + 8);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16000); // sample rate
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(40), 8); // data bytes
  assert.equal(wav.readInt16LE(50), 32767); // last sample intact
});
