// The languages he actually speaks to her. Scribe's detector is confident and
// occasionally wrong on a short, noisy clip — Umberto, 2026-09-07: "sometimes
// she thinks I'm speaking in Chinese or Russian" — and a wrong language poisons
// the turn: the transcript comes back in the wrong script and the model is
// told he spoke Russian. So English and Italian are the only detections the
// recogniser of record may return; anything else is treated as a mis-hearing
// and the clip goes to the multi-language fallback, which only ever answers in
// one of ten languages with English and Italian among them. The seam makes
// this testable without the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribeBest, isExpectedLanguage, EXPECTED_LANGUAGES, type Heard } from "../src/voice/stt.js";

const wav = Buffer.alloc(44);
const scribeSays = (text: string, language: string | null): Heard => ({
  text,
  language,
  confidence: 0.9,
  speakers: 1,
  source: "scribe",
});

test("only English and Italian are expected; unknown is allowed, anything else is not", () => {
  assert.deepEqual([...EXPECTED_LANGUAGES].sort(), ["eng", "ita"]);
  assert.equal(isExpectedLanguage("eng"), true);
  assert.equal(isExpectedLanguage("ita"), true);
  assert.equal(isExpectedLanguage(null), true, "no detection is not a wrong detection");
  for (const wrong of ["rus", "zho", "cmn", "fra", "deu"]) assert.equal(isExpectedLanguage(wrong), false, wrong);
});

test("a Scribe result in English or Italian is returned as is", async () => {
  const heard = await transcribeBest(wav, "ignored", {
    scribe: async () => scribeSays("ricordami di chiamare Marco", "ita"),
    deepgram: async () => { throw new Error("must not be called"); },
  });
  assert.equal(heard.source, "scribe");
  assert.equal(heard.language, "ita");
  assert.equal(heard.text, "ricordami di chiamare Marco");
});

test("a Scribe result in another language is a mis-hearing: the fallback text wins, language unknown", async () => {
  const heard = await transcribeBest(wav, "remind me to call Marco", {
    scribe: async () => scribeSays("напомни мне позвонить Марко", "rus"),
    deepgram: async () => { throw new Error("the live caption was enough"); },
  });
  assert.equal(heard.source, "deepgram");
  assert.equal(heard.text, "remind me to call Marco");
  assert.equal(heard.language, null, "never the wrong language — and no note to the model about Russian");
});

test("…and without a live caption, the fallback recogniser is asked", async () => {
  let asked = 0;
  const heard = await transcribeBest(wav, null, {
    scribe: async () => scribeSays("提醒我给马可打电话", "zho"),
    deepgram: async () => { asked++; return "remind me to call Marco"; },
  });
  assert.equal(asked, 1);
  assert.equal(heard.text, "remind me to call Marco");
  assert.equal(heard.language, null);
});
