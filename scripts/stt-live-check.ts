import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
// Verifies streaming STT without a microphone: generates speech with macOS
// `say`, streams it to Deepgram's live WebSocket in mic-sized frames, and
// times how fast the final transcript lands after CloseStream.
// Run: npx tsx scripts/stt-live-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadEnv } from "../src/core/config.js";
import { LiveTranscriber } from "../src/voice/stt.js";

loadEnv();

const PHRASE = "Hello Eve, please add a reminder to review the finance chapter tomorrow morning.";

async function main(): Promise<void> {
  const aiff = path.join(os.tmpdir(), "eve-stt-live.aiff");
  const wav = path.join(os.tmpdir(), "eve-stt-live.wav");
  execFileSync("say", ["-o", aiff, PHRASE]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const bytes = fs.readFileSync(wav).subarray(44); // skip WAV header
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));

  let lastInterim = "";
  const lt = new LiveTranscriber((t) => (lastInterim = t));

  console.log(`1) Streaming ${(pcm.length / 16000).toFixed(1)}s of audio in 512-sample frames…`);
  // Pace near real time (a hair faster) — that's what a live mic produces,
  // and Deepgram's live endpoint is built for realtime input.
  for (let off = 0; off < pcm.length; off += 512) {
    lt.sendPcm(pcm.subarray(off, Math.min(off + 512, pcm.length)));
    await new Promise((r) => setTimeout(r, 24));
  }

  console.log(`   interim while streaming: "${lastInterim}"`);
  console.log("2) CloseStream → waiting for final transcript…");
  const t0 = Date.now();
  const finalText = await lt.finish();
  const ms = Date.now() - t0;

  if (finalText === null) {
    console.log("❌ live socket failed — the voice mode would fall back to prerecorded REST");
    process.exit(1);
  }
  console.log(`   final after ${ms}ms: "${finalText}"`);
  const ok = /finance chapter/i.test(finalText) && ms < 2000;
  console.log(ok ? `\n✅ Streaming STT works — transcript finalized in ${ms}ms after end-of-speech.`
                 : "\n⚠️ Check the transcript/timing above.");
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
