import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
// Audio pipeline health check, no microphone needed:
//   ElevenLabs (mouth) synthesizes a phrase → afplay plays it →
//   the same audio goes to Deepgram (ears) → transcript should match.
// Run: npx tsx scripts/voice-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadEnv, loadConfig, requireKey } from "../src/core/config.js";

loadEnv();
const cfg = loadConfig();

const PHRASE = "Hello Umberto, this is EVE. Testing one, two, three.";

async function main(): Promise<void> {
  console.log(`1) Synthesizing with ElevenLabs voice ${cfg.voice.voiceId}…`);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voice.voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": requireKey("ELEVENLABS_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: PHRASE, model_id: cfg.voice.ttsModel }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const mp3 = Buffer.from(await res.arrayBuffer());
  const file = path.join(os.tmpdir(), "eve-voice-check.mp3");
  fs.writeFileSync(file, mp3);
  console.log(`   ok — ${mp3.length} bytes of audio`);

  console.log("2) Playing through your speakers (afplay)…");
  execFileSync("afplay", [file]);
  console.log("   ok — playback finished");

  console.log("3) Feeding the same audio to Deepgram…");
  const dg = await fetch(
    `https://api.deepgram.com/v1/listen?model=${cfg.stt.model}&language=${cfg.stt.language}&smart_format=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${requireKey("DEEPGRAM_API_KEY")}`,
        "Content-Type": "audio/mpeg",
      },
      body: new Uint8Array(mp3),
    },
  );
  if (!dg.ok) throw new Error(`Deepgram ${dg.status}: ${(await dg.text()).slice(0, 300)}`);
  const json = (await dg.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  console.log(`   heard back: "${transcript}"`);

  // Deepgram's smart formatting may write "one two three" as "123" — accept both.
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]/g, "").replace("onetwothree", "123");
  if (norm(transcript).includes("testing123")) {
    console.log("\n✅ Mouth and ears both work. Mic capture is the only untested piece — run: npm run voice");
  } else {
    console.log("\n⚠️ Transcript didn't match the phrase — check the output above.");
  }
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
