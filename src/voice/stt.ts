// The ears seam: give me audio, get back text. Deepgram behind one function —
// swap transcribers here without touching anything else.
import { loadConfig, requireKey } from "../core/config.js";
import { memoriesAsFacts } from "../memory/store.js";
import { coreKnowledge } from "../brain/prompt.js";
import { loadReminders } from "../tools/reminders.js";

export class SttError extends Error {}

// Speech recognition hears what it expects to hear. Without this, "Umberto"
// comes back "Humberto" and EVE's own name gets dropped or turned into
// "Steve". We boost her name plus the proper nouns from Umberto's actual
// world — the people and places in his memory and reminders — so the words
// that matter most to him are the ones she gets right.
const STOPWORDS = new Set([
  "umberto's", "this", "that", "these", "those", "there", "then", "when", "what",
  "with", "from", "have", "will", "your", "about", "review", "email", "remind",
]);

export function buildKeyterms(): string[] {
  const cfg = loadConfig();
  const terms = new Set<string>(cfg.stt.keyterms);
  const harvest = (text: string): void => {
    for (const word of text.split(/\s+/)) {
      const clean = word.replace(/[^\p{L}\p{N}'-]/gu, "");
      if (clean.length > 3 && /^\p{Lu}/u.test(clean) && !STOPWORDS.has(clean.toLowerCase())) {
        terms.add(clean);
      }
    }
  };
  try {
    for (const f of memoriesAsFacts()) harvest(f.text);
    harvest(coreKnowledge()); // names in his core files are prime keyterms
    for (const r of loadReminders()) if (!r.done) harvest(r.text);
  } catch {
    // personal data unreadable — the configured base terms still apply
  }
  return [...terms].slice(0, 50); // keep the query bounded
}

function keytermQuery(): string {
  return buildKeyterms()
    .map((t) => `&keyterm=${encodeURIComponent(t)}`)
    .join("");
}

// PCM 16-bit mono → WAV (Deepgram-friendly, self-describing)
export function pcmToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataLen = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataLen).copy(buf, 44);
  return buf;
}

// Live transcription: stream mic frames over Deepgram's WebSocket WHILE the
// user is talking, so the transcript is ~ready the moment they tap "send".
// Auth rides the 'token' subprotocol (browser-style WebSocket allows no
// headers). If anything fails, the caller falls back to prerecorded REST.
export class LiveTranscriber {
  private ws: WebSocket;
  private finals: string[] = [];
  private failed = false;
  private open = false;
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private closeResolvers: (() => void)[] = [];

  constructor(onInterim?: (text: string) => void) {
    const cfg = loadConfig();
    const params = new URLSearchParams({
      model: cfg.stt.model,
      language: cfg.stt.language,
      smart_format: "true",
      interim_results: "true",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
    });
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}${keytermQuery()}`, [
      "token",
      requireKey("DEEPGRAM_API_KEY"),
    ]);
    this.ws.addEventListener("open", () => {
      this.open = true;
      for (const buf of this.queue.splice(0)) this.ws.send(buf);
    });
    this.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          is_final?: boolean;
          channel?: { alternatives?: { transcript?: string }[] };
        };
        // After CloseStream, Deepgram flushes remaining Results and then sends
        // Metadata — that's the "all done" signal (arrives before the close).
        if (msg.type === "Metadata") {
          this.resolveClose();
          return;
        }
        if (msg.type !== "Results") return;
        const text = msg.channel?.alternatives?.[0]?.transcript ?? "";
        if (msg.is_final && text) this.finals.push(text);
        if (onInterim) {
          const live = [...this.finals, msg.is_final ? "" : text].join(" ").trim();
          if (live) onInterim(live);
        }
      } catch {
        // ignore malformed frames
      }
    });
    this.ws.addEventListener("error", () => {
      this.failed = true;
      this.resolveClose();
    });
    this.ws.addEventListener("close", () => this.resolveClose());
  }

  private resolveClose(): void {
    for (const r of this.closeResolvers.splice(0)) r();
  }

  sendPcm(frame: Int16Array): void {
    if (this.failed) return;
    // Copy into a plain ArrayBuffer-backed view (satisfies WebSocket.send and
    // survives any reuse of the recorder's frame buffer).
    const bytes = new Uint8Array(
      (frame.buffer as ArrayBuffer).slice(frame.byteOffset, frame.byteOffset + frame.length * 2),
    );
    if (this.open && this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
    else this.queue.push(bytes);
  }

  // Returns the final transcript, or null when streaming failed and the
  // caller should fall back to prerecorded transcription.
  async finish(timeoutMs = 4000): Promise<string | null> {
    if (this.failed) return null;
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      await new Promise<void>((resolve) => {
        this.closeResolvers.push(resolve);
        setTimeout(resolve, timeoutMs).unref?.();
      });
    } catch {
      return null;
    }
    if (this.failed) return null;
    return this.finals.join(" ").replace(/\s+/g, " ").trim();
  }

  abort(): void {
    this.failed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

// Recognisers reliably mangle "Eve" when it opens a sentence — it lands as
// Ivy, Iv, Eva, Evie. She is addressed by name constantly, so fix it in place
// rather than making the brain guess. Only touches the vocative (name at the
// start, or after a comma), so someone actually called Ivy survives.
const NAME_MISHEARINGS = /\b(ivy|ivie|iv|ive|eva|evie|evy|yves|eves|ib)\b/gi;

export function fixName(text: string): string {
  return text
    .replace(/^(\s*)(ivy|ivie|iv|ive|eva|evie|evy|yves|eves|ib)\b/i, "$1Eve")
    .replace(/([,.!?]\s+)(ivy|ivie|iv|ive|eva|evie|evy|yves|eves|ib)\b/gi, "$1Eve")
    .replace(/\b(hey|ciao|hi|hello|ok|okay|senti|scusa)(\s+)(ivy|ivie|iv|ive|eva|evie|evy|yves|eves|ib)\b/gi,
      (_m, greet: string, sp: string) => `${greet}${sp}Eve`);
}

export interface Heard {
  text: string;
  language: string | null; // ISO code Scribe detected, e.g. "ita"
  confidence: number;
  speakers: number;
  source: "scribe" | "deepgram";
}

// ElevenLabs Scribe v2: 90+ languages with real automatic detection, and it
// tells us which language it heard instead of silently guessing. Measured
// against Deepgram's `multi` (a 10-language classifier) on synthetic speech:
// Italian 88%→100%, Portuguese 89%→100%, Polish 0%→88%, Romanian 22%→100%,
// Chinese garbage→perfect. Costs ~160ms more than streaming, which is worth it.
export async function transcribeScribe(wav: Buffer): Promise<Heard> {
  const cfg = loadConfig();
  const form = new FormData();
  form.append("model_id", cfg.stt.scribeModel);
  if (cfg.stt.diarize) form.append("diarize", "true");
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");

  let res: Response;
  try {
    res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": requireKey("ELEVENLABS_API_KEY") },
      body: form,
      // A stalled connection without a cap once hung a whole face turn in
      // "processing" with zero traces. Typical latency is 1-3s; 15s is only
      // there to turn a hang into a fallback.
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SttError("Couldn't reach ElevenLabs for transcription.");
  }
  if (!res.ok) {
    throw new SttError(`Scribe said no (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    text?: string;
    language_code?: string;
    language_probability?: number;
    words?: { type?: string; text?: string; speaker_id?: string }[];
  };

  // When more than one person is picked up, Umberto is the one being answered:
  // he's holding the mic, so he's whoever spoke most. His words are the
  // request; other voices are kept but clearly marked as background, so EVE
  // can ignore chatter yet still translate someone who's talking to her.
  let text = (json.text ?? "").trim();
  let speakers = 1;
  if (cfg.stt.diarize && json.words?.length) {
    const bySpeaker = new Map<string, string[]>();
    for (const w of json.words) {
      if (w.type !== "word" || !w.text) continue;
      const id = w.speaker_id ?? "speaker_0";
      if (!bySpeaker.has(id)) bySpeaker.set(id, []);
      bySpeaker.get(id)!.push(w.text);
    }
    speakers = bySpeaker.size;
    if (speakers > 1) {
      const ranked = [...bySpeaker.entries()].sort((a, b) => b[1].length - a[1].length);
      const [, mainWords] = ranked[0]!;
      const others = ranked.slice(1).map(([, w]) => w.join(" ").trim());
      text =
        `${mainWords.join(" ").trim()}\n` +
        `(Other voices were picked up nearby, not addressed to you unless the ` +
        `main speaker says so: ${others.map((o) => `"${o}"`).join("; ")})`;
    }
  }

  return {
    text: fixName(text),
    language: json.language_code ?? null,
    confidence: json.language_probability ?? 0,
    speakers,
    source: "scribe",
  };
}

// The recognizer EVE actually uses. Scribe is the authority; the Deepgram
// result already in hand (from the live caption socket) is the safety net, so
// a flaky network degrades instead of losing the turn.
export async function transcribeBest(wav: Buffer, deepgramFallback: string | null): Promise<Heard> {
  try {
    const heard = await transcribeScribe(wav);
    if (heard.text) return heard;
  } catch {
    // fall through to whatever Deepgram gave us
  }
  const text = (deepgramFallback ?? "").trim() || (await transcribe(wav));
  return { text: fixName(text), language: null, confidence: 0, speakers: 1, source: "deepgram" };
}

export async function transcribe(wav: Buffer): Promise<string> {
  const cfg = loadConfig();
  const params = new URLSearchParams({
    model: cfg.stt.model,
    language: cfg.stt.language,
    smart_format: "true",
  });
  let res: Response;
  try {
    res = await fetch(`https://api.deepgram.com/v1/listen?${params}${keytermQuery()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${requireKey("DEEPGRAM_API_KEY")}`,
        "Content-Type": "audio/wav",
      },
      signal: AbortSignal.timeout(15_000), // hang → error → caller's fallback
      body: new Uint8Array(wav),
    });
  } catch {
    throw new SttError("Couldn't reach Deepgram — network trouble. The typed interface still works.");
  }
  if (!res.ok) {
    throw new SttError(`Deepgram said no (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  return json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}
