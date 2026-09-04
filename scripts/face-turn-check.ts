import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
// Headless verification of the face's full voice loop — no browser, no mic.
// Streams say-generated speech over the face WebSocket exactly like the page
// does, then asserts the event sequence and fetches every TTS segment.
// Run with the face server up: npm run face -- --no-open ; npx tsx scripts/face-turn-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadEnv, loadConfig } from "../src/core/config.js";

loadEnv();
const PORT = loadConfig().face.port;
const BASE = `http://127.0.0.1:${PORT}`;

function speechPcm(phrase: string): Int16Array {
  const aiff = path.join(os.tmpdir(), "eve-face-check.aiff");
  const wav = path.join(os.tmpdir(), "eve-face-check.wav");
  execFileSync("say", ["-o", aiff, phrase]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const bytes = fs.readFileSync(wav).subarray(44);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

interface Collected {
  msgs: Record<string, unknown>[];
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function collector(ws: WebSocket): Collected {
  const msgs: Record<string, unknown>[] = [];
  const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.type === m.type) {
        waiters.splice(i, 1)[0]!.resolve(m);
      }
    }
  });
  return {
    msgs,
    waitFor: (type, timeoutMs = 60_000) =>
      new Promise((resolve, reject) => {
        const existing = msgs.find((m) => m.type === type);
        if (existing) return resolve(existing);
        const t = setTimeout(() => {
          // Name the failure point: what DID arrive tells you where it hung.
          const seen = msgs.map((m) => String(m.type)).join(", ") || "(nothing)";
          reject(new Error(`timed out waiting for "${type}" — received so far: ${seen}`));
        }, timeoutMs);
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      }),
  };
}

async function speakTurn(ws: WebSocket, col: Collected, phrase: string): Promise<void> {
  const pcm = speechPcm(phrase);
  ws.send(JSON.stringify({ type: "mic", on: true }));
  for (let off = 0; off < pcm.length; off += 512) {
    const frame = pcm.subarray(off, Math.min(off + 512, pcm.length));
    // TS types TypedArray#buffer as ArrayBuffer | SharedArrayBuffer; ws.send
    // takes only the former. The recorder never hands us a shared buffer, so
    // narrowing is honest rather than a workaround.
    const bytes = frame.buffer as ArrayBuffer;
    ws.send(bytes.slice(frame.byteOffset, frame.byteOffset + frame.length * 2));
    await new Promise((r) => setTimeout(r, 24)); // ~realtime pacing
  }
  ws.send(JSON.stringify({ type: "mic", on: false }));
}

async function main(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const col = collector(ws);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("cannot reach face server — is `npm run face` running?")));
  });
  const hello = await col.waitFor("snapshot", 5000);
  // The server, not this script, is what writes conversations to disk. Driving
  // a normal `npm run face` would put synthetic turns straight into Umberto's
  // real history — which is exactly how 11 test conversations got there.
  if (!(hello.snapshot as { sandboxed?: boolean }).sandboxed) {
    throw new Error(
      "il server face NON e' isolato: scriverebbe conversazioni vere.\n" +
        "   Avvialo con:  npm run face:sandbox\n" +
        "   poi rilancia questo check.",
    );
  }
  console.log("✓ connected, snapshot received (server isolato)");

  // ---- Phase 1: plain voice turn -------------------------------------
  console.log("\nPhase 1 — voice turn: streaming speech…");
  await speakTurn(ws, col, "Hello Eve. In one or two short sentences, how are you tonight?");
  const heardFinal = await (async () => {
    for (;;) {
      const h = await col.waitFor("heard");
      if (!(h.interim as boolean)) return h;
      col.msgs.splice(col.msgs.indexOf(h), 1);
    }
  })();
  console.log(`✓ heard: "${String(heardFinal.text)}"`);
  await col.waitFor("turn_done", 90_000);
  const deltas = col.msgs.filter((m) => m.type === "reply_delta").length;
  const segs = col.msgs.filter((m) => m.type === "speak_segment");
  const seqs = segs.map((s) => s.seq as number);
  console.log(`✓ turn_done — ${deltas} reply deltas, ${segs.length} speak_segments (seq ${seqs.join(",")})`);
  if (segs.length === 0) throw new Error("no speak_segments emitted");
  if (!seqs.every((s, i) => s === i)) throw new Error(`segment seq not ordered: ${seqs.join(",")}`);
  if (new Set(segs.map((s) => s.baseTurnId)).size !== 1) throw new Error("mixed baseTurnIds in one turn");
  for (const s of segs) {
    const res = await fetch(`${BASE}/tts/${String(s.segId)}`);
    if (!res.ok) throw new Error(`segment ${String(s.segId)} fetch failed: ${res.status}`);
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength < 1000) throw new Error(`segment ${String(s.segId)} suspiciously small`);
  }
  console.log(`✓ all ${segs.length} segment mp3s fetched`);
  const lat = col.msgs.find((m) => m.type === "latency");
  if (lat) {
    const f = (v: unknown) => (v === null ? "—" : `${((v as number) / 1000).toFixed(2)}s`);
    console.log(`✓ latency: transcript ${f(lat.transcriptMs)} · first token ${f(lat.firstTokenMs)} · first audio segment ${f(lat.firstSegmentMs)}`);
  }

  // ---- Phase 2: the gate over the wire -------------------------------
  console.log("\nPhase 2 — gate: asking for a confirmation-required action…");
  const cityBefore = JSON.stringify(loadConfig().location);
  col.msgs.length = 0;
  await speakTurn(ws, col, "Please set my home city to Naples. Call the tool right away, no need to double check.");
  // She may answer in prose instead of calling the tool when her resumed
  // memory holds earlier declined runs of this very check — that's prudence,
  // not a broken gate. One explicit insistence separates the two: after a
  // direct order the tool call (and thus the wire gate) is non-negotiable.
  let confirm = await Promise.race([
    col.waitFor("confirm_request", 90_000),
    col.waitFor("turn_done", 90_000).then(() => null),
  ]).catch(() => null);
  if (!confirm) {
    console.log("… answered without calling the tool (remembered declines) — insisting once");
    col.msgs.length = 0;
    await speakTurn(ws, col, "Yes, I am sure. Call the set location tool right now.");
    confirm = await col.waitFor("confirm_request", 90_000);
  }
  console.log(`✓ confirm_request arrived: "${String(confirm.intent)}"`);
  ws.send(JSON.stringify({ type: "confirm_response", id: confirm.id, ok: false }));
  await col.waitFor("turn_done", 90_000);
  const cityAfter = JSON.stringify(loadConfig().location);
  if (cityBefore !== cityAfter) throw new Error("declined action still changed config!");
  console.log("✓ declined — config untouched, turn completed gracefully");

  // ---- Phase 3: kill switch ------------------------------------------
  console.log("\nPhase 3 — kill switch over the wire…");
  col.msgs.length = 0;
  ws.send(JSON.stringify({ type: "set_paused", paused: true }));
  const snap1 = await col.waitFor("snapshot", 5000);
  if (!(snap1.snapshot as { paused: boolean }).paused) throw new Error("pause did not stick");
  col.msgs.length = 0;
  ws.send(JSON.stringify({ type: "set_paused", paused: false }));
  const snap2 = await col.waitFor("snapshot", 5000);
  if ((snap2.snapshot as { paused: boolean }).paused) throw new Error("resume did not stick");
  console.log("✓ pause + resume both persisted and broadcast");

  // ---- Phase 4: audio goes to ONE client only ------------------------
  // Regression guard: a second open tab used to receive the same segments and
  // play them in unison, which sounds like EVE stuttering/echoing herself.
  console.log("\nPhase 4 — second client must NOT receive audio…");
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const col2 = collector(ws2);
  await new Promise<void>((res, rej) => {
    ws2.addEventListener("open", () => res());
    ws2.addEventListener("error", () => rej(new Error("second client could not connect")));
  });
  await col2.waitFor("snapshot", 5000);
  col.msgs.length = 0;
  col2.msgs.length = 0;
  await speakTurn(ws, col, "Say the single word: acknowledged.");
  await col.waitFor("turn_done", 90_000);
  const segsA = col.msgs.filter((m) => m.type === "speak_segment").length;
  const segsB = col2.msgs.filter((m) => m.type === "speak_segment").length;
  const mirroredB = col2.msgs.filter((m) => m.type === "reply_delta").length;
  if (segsA === 0) throw new Error("speaking client got no audio");
  if (segsB > 0) throw new Error(`idle client received ${segsB} audio segments — double-voice bug is back`);
  if (mirroredB === 0) throw new Error("idle client should still mirror the transcript");
  console.log(`✓ speaker got ${segsA} segment(s); observer got 0 audio but ${mirroredB} transcript deltas`);
  ws2.close();

  console.log("\n✅ Face voice loop, gate, kill switch, and single-listener audio all verified.");
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
