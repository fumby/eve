import { loadEnv } from "../src/core/config.js";
import { synthesize } from "../src/voice/tts.js";
import { writeFileSync } from "node:fs";

loadEnv();
try {
  const b = await synthesize("Ciao Umberto, sto verificando la voce.");
  writeFileSync("/tmp/voice-check.mp3", b);
  console.log("SINTESI OK:", b.byteLength, "bytes → /tmp/voice-check.mp3");
} catch (e) {
  console.log("SINTESI FALLITA:", e instanceof Error ? e.message : String(e));
}
