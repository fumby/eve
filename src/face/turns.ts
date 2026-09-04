// Voice-turn orchestration for the face: browser mic frames in, transcript,
// one brain turn, per-sentence TTS segments out. Same brain, same tools —
// only the ears and mouth are remoted to the browser.
import crypto from "node:crypto";
import { Agent } from "../core/agent.js";
import { loadConfig } from "../core/config.js";
import { latestResumable } from "../core/conversations.js";
import type { Registry } from "../core/registry.js";
import { LiveTranscriber, transcribeBest, pcmToWav, type Heard } from "../voice/stt.js";
import { SentenceAssembler, synthesize } from "../voice/tts.js";
import { audit } from "../core/audit.js";
import type { FaceState, ServerMsg } from "./protocol.js";

const SEGMENT_TTL_MS = 120_000;

export class FaceTurns {
  state: FaceState = "idle";

  private live: LiveTranscriber | null = null;
  private chunks: Buffer[] = []; // raw PCM kept for the REST fallback
  private currentBase: string | null = null;
  private aborted = false;
  private segments = new Map<string, { bytes: Buffer; expires: number }>();
  private agent: Agent;

  constructor(
    registry: Registry,
    private send: (msg: ServerMsg) => void,
  ) {
    // A reconnect (or app relaunch) inside the resume window picks the last
    // conversation back up instead of meeting Umberto as a stranger.
    this.agent = new Agent(
      registry,
      "face",
      latestResumable(loadConfig().memory.resumeWindowMinutes) ?? undefined,
    );
  }

  get conversationId(): string {
    return this.agent.conversationId;
  }

  getSegment(segId: string): Buffer | null {
    const now = Date.now();
    for (const [k, v] of this.segments) if (v.expires < now) this.segments.delete(k);
    return this.segments.get(segId)?.bytes ?? null;
  }

  private setState(state: FaceState): void {
    this.state = state;
    this.send({ type: "state", state });
  }

  micOn(): void {
    if (this.state === "listening" || this.state === "processing") return;
    this.aborted = true; // any still-running synth chain stops emitting
    this.chunks = [];
    this.live = new LiveTranscriber((text) => this.send({ type: "heard", text, interim: true }));
    this.setState("listening");
  }

  onAudio(data: Buffer): void {
    if (!this.live) return;
    // Copy to an aligned buffer before viewing as Int16 (ws buffers are pooled).
    const copy = Buffer.from(data);
    this.chunks.push(copy);
    this.live.sendPcm(new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 2)));
  }

  async micOff(): Promise<void> {
    if (this.state !== "listening" || !this.live) return;
    const lt = this.live;
    this.live = null;
    this.setState("processing");
    const tap = Date.now();
    try {
      // The live socket's job was the caption while he spoke; Scribe is the
      // recogniser of record, and it gets the complete audio.
      const liveText = await lt.finish();
      const all = Buffer.concat(this.chunks);
      this.chunks = [];
      const pcm = new Int16Array(all.buffer, all.byteOffset, Math.floor(all.length / 2));
      const result = await transcribeBest(pcmToWav(pcm, 16000), liveText);

      if (!result.text) {
        this.send({ type: "turn_error", message: "I couldn't make out anything — try again?" });
        this.setState("idle");
        return;
      }
      this.send({
        type: "heard",
        text: result.text,
        interim: false,
        language: result.language,
        speakers: result.speakers,
      });
      await this.runTurn(result, tap);
    } catch (err) {
      this.send({
        type: "turn_error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.setState("idle");
    }
  }

  interrupt(): void {
    this.aborted = true;
    if (this.live) {
      this.live.abort();
      this.live = null;
      this.chunks = [];
    }
    if (this.state !== "idle") this.setState("idle");
  }

  private async runTurn(heard: Heard, tap: number): Promise<void> {
    const text = heard.text;
    const base = crypto.randomBytes(4).toString("hex");
    this.currentBase = base;
    this.aborted = false;
    const marks = { transcript: Date.now(), firstToken: 0, firstSegment: 0 };
    const assembler = new SentenceAssembler();
    let seq = 0;
    let synthChain: Promise<void> = Promise.resolve();

    const pushSentence = (sentence: string): void => {
      const mySeq = seq++;
      synthChain = synthChain.then(async () => {
        if (this.aborted || this.currentBase !== base) return;
        try {
          const bytes = await synthesize(sentence);
          if (this.aborted || this.currentBase !== base) return;
          const segId = `${base}-${mySeq}`;
          this.segments.set(segId, { bytes, expires: Date.now() + SEGMENT_TTL_MS });
          if (!marks.firstSegment) {
            marks.firstSegment = Date.now();
            this.setState("speaking");
          }
          this.send({ type: "speak_segment", baseTurnId: base, segId, seq: mySeq });
        } catch (err) {
          this.send({
            type: "turn_error",
            message: `voice hiccup: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
    };

    try {
      await this.agent.runTurn(
        text,
        {
          onText: (delta) => {
            if (!marks.firstToken) marks.firstToken = Date.now();
            this.send({ type: "reply_delta", text: delta });
            for (const s of assembler.push(delta)) pushSentence(s);
          },
          onToolCall: (name) => this.send({ type: "tool_call", name }),
        },
        { language: heard.language, speakers: heard.speakers },
      );
      const rest = assembler.flush();
      if (rest && !this.aborted) pushSentence(rest);
      await synthChain;
      this.send({ type: "turn_done", baseTurnId: base });
      const latency = {
        transcriptMs: marks.transcript - tap,
        firstTokenMs: marks.firstToken ? marks.firstToken - tap : null,
        firstSegmentMs: marks.firstSegment ? marks.firstSegment - tap : null,
      };
      this.send({ type: "latency", ...latency });
      audit("voice_latency", {
        ...latency,
        stt: heard.source,
        language: heard.language,
        speakers: heard.speakers,
        source: "face",
      });
    } catch (err) {
      this.send({
        type: "turn_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    this.setState("idle");
  }
}
