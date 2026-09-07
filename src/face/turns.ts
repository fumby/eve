// Voice-turn orchestration for the face: browser mic frames in, transcript,
// one brain turn, per-sentence TTS segments out. Same brain, same tools —
// only the ears and mouth are remoted to the browser.
import crypto from "node:crypto";
import { Agent, type StreamFn } from "../core/agent.js";
import { loadConfig } from "../core/config.js";
import { latestResumable } from "../core/conversations.js";
import type { Registry } from "../core/registry.js";
import { LiveTranscriber, transcribeBest, pcmToWav, type Heard } from "../voice/stt.js";
import { SentenceAssembler, synthesize } from "../voice/tts.js";
import { audit } from "../core/audit.js";
import { addNotice } from "../core/notices.js";
import type { FaceState, ServerMsg } from "./protocol.js";

const SEGMENT_TTL_MS = 120_000;

type TextTurnOpts = { speak?: boolean; client?: { device: "phone" | "mac"; place?: string } };

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
    // The model seam, injected by tests so the turn rules (queue vs interrupt)
    // can be exercised against a scripted stream. Production passes nothing.
    stream?: StreamFn,
  ) {
    // A reconnect (or app relaunch) inside the resume window picks the last
    // conversation back up instead of meeting Umberto as a stranger.
    this.agent = new Agent(
      registry,
      "face",
      latestResumable(loadConfig().memory.resumeWindowMinutes) ?? undefined,
      stream,
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
    this.agent.cancel(); // stop the model call, not just the UI
    if (this.live) {
      this.live.abort();
      this.live = null;
      this.chunks = [];
    }
    if (this.state !== "idle") this.setState("idle");
    // A barge-in is a change of direction: follow-ups queued for the answer
    // he just cut off no longer make sense — drop them, he said something new.
    this.followUps = [];
  }

  // A typed turn: text in, streamed text + spoken TTS out. The same brain,
  // tools, and gate as a voice turn — only the input is already transcribed
  // (by Glaido dictating into the text field, or by typing). TTS is offered
  // because the face is a voice surface: a reply she can also speak is more
  // useful than one she can only show. `speak` lets the client opt out.
  //
  // FOLLOW-UPS, and the one thing that is not one. A message that arrives
  // while she is THINKING (processing — no words yet) is QUEUED, not sent,
  // and fed to her the moment the live turn lands: the old behavior of
  // interrupting meant a quick second message silently killed the first
  // answer, and Umberto asked for follow-ups instead — keep talking, she
  // takes it in order. The queue is capped (a runaway paste cannot mint
  // twenty paid turns) and drained one at a time, each as its own turn so
  // the transcript reads like it happened.
  //
  // A message while she is SPEAKING is different (his ask, 2026-09-06): she
  // has to stop saying what she was saying, listen, and answer the new thing.
  // So speaking → interrupt (which also drops the queue: a change of
  // direction), then the new turn runs at once. tests/face-turns.test.ts
  // pins both halves.
  private followUps: { text: string; opts: TextTurnOpts }[] = [];

  async textTurn(
    text: string,
    opts: TextTurnOpts = {},
  ): Promise<void> {
    if (this.state === "speaking") {
      this.interrupt(); // he spoke over her — the reply stops here
    }
    if (this.state === "processing") {
      if (this.followUps.length >= 5) {
        this.send({ type: "turn_error", message: "I'm still working on the last messages — give me a moment before sending more." });
        return;
      }
      this.followUps.push({ text, opts });
      // Tell every tab what is queued: the face shows "queued · next" in the
      // workspace, and the sender's input stays open for more.
      this.send({ type: "chat_queued", text, position: this.followUps.length });
      return;
    }
    if (this.state === "listening") {
      this.interrupt(); // he typed while the mic was open — the text wins
    }
    await this.runTextTurn(text, opts);
  }

  /** Drain the queue: each follow-up becomes its own turn, in arrival order. */
  private async drainFollowUps(): Promise<void> {
    while (this.followUps.length > 0 && this.state === "idle") {
      const next = this.followUps.shift()!;
      await this.runTextTurn(next.text, next.opts);
    }
  }

  // A turn that dies must leave two traces before the socket message goes
  // out, because the socket is the one channel that can drop it: on
  // 2026-09-06 the "ho fame" turn hit a provider 400 (context ceiling),
  // textTurn's catch sent turn_error to a socket that was already half
  // dead, and NOTHING else recorded the failure — no audit line, no
  // notice. The phone reconnected to a snapshot saying idle, kept
  // rendering the stale "working" panel, and the only evidence the turn
  // ever existed was a usage line. The audit trail explains the gap; the
  // notice survives reconnects in the inbox, quiet — a failure he can
  // read, not one that interrupts him.
  private traceFailedTurn(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    audit("turn_error", { source: "face", message: message.slice(0, 400) });
    addNotice("turn-error", `A turn failed: ${message.slice(0, 300)}`, "quiet");
    return message;
  }

  private async runTextTurn(
    text: string,
    opts: TextTurnOpts,
  ): Promise<void> {
    const turnId = crypto.randomBytes(4).toString("hex");
    // Echo the text: the sender's own tab could render it locally, but every
    // OTHER open tab is a mirror — without the text riding this message, they
    // never see what he said. (The "I didn't see my message anywhere" bug.)
    this.send({ type: "chat_turn", turnId, text });
    this.setState("processing");

    const wantVoice = opts.speak !== false;
    const base = crypto.randomBytes(4).toString("hex");
    this.currentBase = base;
    this.aborted = false;
    const assembler = new SentenceAssembler();
    let seq = 0;
    let synthChain: Promise<void> = Promise.resolve();
    let spoke = false;

    const pushSentence = (sentence: string): void => {
      if (!wantVoice) return;
      const mySeq = seq++;
      synthChain = synthChain.then(async () => {
        if (this.aborted || this.currentBase !== base) return;
        try {
          const bytes = await synthesize(sentence);
          if (this.aborted || this.currentBase !== base) return;
          const segId = `${base}-${mySeq}`;
          this.segments.set(segId, { bytes, expires: Date.now() + SEGMENT_TTL_MS });
          if (!spoke) {
            spoke = true;
            this.setState("speaking");
          }
          this.send({ type: "speak_segment", baseTurnId: base, segId, seq: mySeq });
        } catch {
          // a synth failure is a hiccup, not a turn failure
        }
      });
    };

    try {
      await this.agent.runTurn(
        text,
        {
          onText: (delta) => {
            // Stale-turn guard, same as pushSentence: after an interrupt +
            // replacement, the old turn's stream may still resolve with
            // buffered deltas. Without this check they land in the NEW
            // turn's card — the review's overlapping-turns finding, in its
            // visible form.
            if (this.currentBase !== base) return;
            this.send({ type: "chat_delta", turnId, text: delta });
            if (wantVoice) for (const s of assembler.push(delta)) pushSentence(s);
          },
          onToolCall: (name) => this.send({ type: "tool_call", name }),
        },
        undefined,
        opts.client,
      );
      if (wantVoice) {
        const rest = assembler.flush();
        if (rest && !this.aborted) pushSentence(rest);
        await synthChain;
      }
      this.send({ type: "chat_done", turnId, spoke });
      this.send({ type: "turn_done", baseTurnId: base });
      audit("text_turn", { turnId, spoke, source: "face" });
    } catch (err) {
      this.send({ type: "turn_error", message: this.traceFailedTurn(err) });
    }
    this.setState("idle");
    // Follow-ups sent while that turn ran start now — she takes them in order.
    void this.drainFollowUps();
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
            // Stale-turn guard (see textTurn): a replaced turn's buffered
            // deltas must not land in the new turn's transcript.
            if (this.currentBase !== base) return;
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
        message: this.traceFailedTurn(err),
      });
    }
    this.setState("idle");
    void this.drainFollowUps();
  }
}
