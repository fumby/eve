// The mouth seam: give me text, hear it aloud. ElevenLabs synthesizes per
// sentence; macOS's built-in afplay plays them in order. Because synthesis of
// sentence N+1 overlaps playback of sentence N, EVE starts talking while she's
// still "writing" — no native audio deps needed.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, requireKey } from "../core/config.js";

export class TtsError extends Error {}

// What looks fine on screen ("22–29°C") makes TTS stumble or read symbol
// names aloud. Everything here is turned into words before synthesis, in the
// language of the sentence — EVE switches between Italian and English.
const IT_HINT =
  /\b(il|lo|la|le|gli|di|del|della|che|per|con|non|sono|alle|una|uno|gradi|domani|oggi|sole|ricordami|ciao)\b/gi;

export function speechify(text: string): string {
  const italian = (text.match(IT_HINT) ?? []).length >= 2;
  const deg = italian ? "gradi" : "degrees";
  const to = italian ? " a " : " to ";
  const pct = italian ? " per cento" : " percent";
  const kmh = italian ? " chilometri orari" : " kilometers per hour";

  return (
    text
      // strip markdown that would otherwise be spoken as punctuation
      .replace(/\*\*(.+?)\*\*/gs, "$1")
      .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$)/g, "$1$2")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/`([^`]+)`/g, "$1")
      // ISO timestamps → natural spoken form ("2026-08-21T18:00" is unreadable)
      .replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?/g, (_m, y, mo, d, h, mi) =>
        italian ? `${d}/${mo}/${y} alle ${h}:${mi}` : `${d}/${mo}/${y} at ${h}:${mi}`,
      )
      .replace(/(\d{4})-(\d{2})-(\d{2})/g, "$3/$2/$1")
      // numeric ranges: en/em dash between digits means "to", not a hyphen
      .replace(/(\d)\s*[–—]\s*(\d)/g, `$1${to}$2`)
      // temperatures and other units
      .replace(/(\d)\s*°\s*C\b/g, `$1 ${deg}`)
      .replace(/(\d)\s*°\s*F\b/g, `$1 ${deg} Fahrenheit`)
      .replace(/(\d)\s*°/g, `$1 ${deg}`)
      .replace(/°C/g, deg)
      .replace(/(\d)\s*%/g, `$1${pct}`)
      .replace(/\bkm\/h\b/gi, kmh)
      // leftover symbols that TTS reads literally
      .replace(/[–—]/g, ", ")
      .replace(/\s*→\s*/g, italian ? " verso " : " to ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

// Pure sentence assembly from streamed text deltas. push() returns every
// complete sentence the new delta finished; flush() returns the remainder.
export class SentenceAssembler {
  private buffer = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const m = this.buffer.match(/^([\s\S]*?[.!?…][")'\]]?)(\s+)(?=\S)/);
      if (m && m[1] && m[1].length >= 25) {
        out.push(m[1].trim());
        this.buffer = this.buffer.slice(m[0].length);
        continue;
      }
      if (this.buffer.length > 250) {
        const cut = this.buffer.lastIndexOf(" ", 250);
        if (cut > 40) {
          out.push(this.buffer.slice(0, cut).trim());
          this.buffer = this.buffer.slice(cut + 1);
          continue;
        }
      }
      return out;
    }
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? rest : null;
  }
}

// Exported: the face server caches these bytes per sentence; the terminal
// Speaker writes them to a temp file for afplay.
export async function synthesize(rawText: string): Promise<Buffer> {
  const cfg = loadConfig();
  const text = speechify(rawText);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voice.voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": requireKey("ELEVENLABS_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id: cfg.voice.ttsModel }),
      // Hang-proofing: a dead connection becomes a visible "voice hiccup"
      // instead of a turn stuck in "speaking" forever.
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) {
    throw new TtsError(`ElevenLabs said no (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Fire-and-forget: establish the TLS connection to ElevenLabs before the
// first sentence needs it (~100–200ms off the first audible word).
export function warmTts(): void {
  void fetch("https://api.elevenlabs.io/v1/models", {
    headers: { "xi-api-key": requireKey("ELEVENLABS_API_KEY") },
  }).catch(() => {});
}

export interface SpeakerHooks {
  onError?: (msg: string) => void;
  onFirstPlay?: () => void; // fires when the first audio actually starts
}

// One Speaker per spoken reply. feed() text deltas as they stream, then end().
// stop() is the barge-in: kills playback and abandons the rest.
export class Speaker {
  private assembler = new SentenceAssembler();
  private queue: string[] = [];
  private stopped = false;
  private player: ChildProcess | null = null;
  private worker: Promise<void>;
  private wake: (() => void) | null = null;
  private ended = false;
  private playedAnything = false;
  private dir: string;

  constructor(private hooks: SpeakerHooks = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-tts-"));
    this.worker = this.pump();
  }

  feed(delta: string): void {
    if (this.stopped) return;
    for (const sentence of this.assembler.push(delta)) this.enqueue(sentence);
  }

  async end(): Promise<void> {
    if (!this.stopped) {
      const rest = this.assembler.flush();
      if (rest) this.enqueue(rest);
    }
    this.ended = true;
    this.wake?.();
    await this.worker;
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.player?.kill("SIGKILL");
    this.ended = true;
    this.wake?.();
  }

  get interrupted(): boolean {
    return this.stopped;
  }

  private enqueue(sentence: string): void {
    this.queue.push(sentence);
    this.wake?.();
  }

  private async pump(): Promise<void> {
    let n = 0;
    let playing: Promise<void> = Promise.resolve();
    while (true) {
      if (this.stopped) break;
      const sentence = this.queue.shift();
      if (sentence === undefined) {
        if (this.ended) break;
        await new Promise<void>((r) => (this.wake = r));
        this.wake = null;
        continue;
      }
      const file = path.join(this.dir, `s${n++}.mp3`);
      try {
        fs.writeFileSync(file, await synthesize(sentence)); // overlaps with previous playback
      } catch (err) {
        this.hooks.onError?.(err instanceof Error ? err.message : String(err));
        continue; // text was already printed; skip the audio for this sentence
      }
      await playing;
      if (this.stopped) break;
      playing = this.play(file);
    }
    await playing;
  }

  private play(file: string): Promise<void> {
    if (!this.playedAnything) {
      this.playedAnything = true;
      this.hooks.onFirstPlay?.();
    }
    return new Promise((resolve) => {
      this.player = spawn("afplay", [file], { stdio: "ignore" });
      this.player.on("exit", () => {
        this.player = null;
        resolve();
      });
      this.player.on("error", () => resolve());
    });
  }
}

// Convenience for one-shot lines ("thinking" chimes, greetings).
export async function say(text: string): Promise<void> {
  const speaker = new Speaker();
  speaker.feed(text);
  await speaker.end();
}
