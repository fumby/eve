// Browser audio: mic capture (worklet → WS binary frames) and the segment
// player. Playback decodes each sentence and schedules it on the Web Audio
// clock instead of handing MP3s to an <audio> element — an element restarts
// its pipeline per sentence and MP3s carry encoder padding, which is heard as
// a break or click at the start of speech. Scheduled buffers butt up against
// each other exactly, so a reply sounds like one continuous voice.

export class MicCapture {
  constructor(ws) {
    this.ws = ws;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("capture-worklet.js");
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "eve-capture");
    this.node.port.onmessage = (e) => {
      if (this.ws.readyState === 1) this.ws.send(e.data);
    };
    this.src.connect(this.node);
    this.node.connect(this.ctx.destination); // worklet emits silence; keeps the graph alive
    // A second tap on the same source just to READ levels for the orb — the
    // analyser is a sink, it never touches what goes to the server. (iOS: this
    // is a separate context from playback, created inside the mic tap, on purpose.)
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.5;
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.src.connect(this.analyser);
  }

  /** {loud, bass, live} for the orb; live=false whenever there is nothing real to read. */
  levels() {
    if (!this.analyser || !this.ctx || this.ctx.state !== "running") return { loud: 0, bass: 0, live: false };
    this.analyser.getByteTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);
    return {
      loud: rmsLoud(this.timeData),
      bass: bassLevel(this.freqData, this.ctx.sampleRate, this.analyser.fftSize),
      live: true,
    };
  }

  async stop() {
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.analyser?.disconnect();
      this.analyser = null;
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.ctx?.close();
    } catch {
      /* already torn down */
    }
  }
}

const LEAD_IN = 0.06; // small cushion so the first buffer is never scheduled late

// Level maths shared by both analysers. Kept in sync with face/scene/levels.js
// (the pure, tested versions) — duplicated here so audio.js stays standalone.
function rmsLoud(bytes, gain = 3.2) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / bytes.length) * gain);
}
function bassLevel(bins, sampleRate, fftSize, lowHz = 40, highHz = 200) {
  const hzPerBin = sampleRate / fftSize;
  const lo = Math.max(0, Math.floor(lowHz / hzPerBin));
  const hi = Math.min(bins.length - 1, Math.max(lo, Math.ceil(highHz / hzPerBin)));
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += bins[i];
  return Math.min(1, sum / ((hi - lo + 1) * 255));
}

// Safari and Chrome disagree about Web Audio in ways that are hard to test for
// from here, and silent failure is the worst outcome — so if the scheduled
// path can't start, fall back to a plain <audio> element (which is what worked
// before) and report which path is live rather than going quiet.
const AudioCtx = window.AudioContext || window.webkitAudioContext;

export class SegmentPlayer {
  constructor(onDone, onStatus) {
    this.onDone = onDone;
    this.onStatus = onStatus ?? (() => {});
    this.mode = "pending"; // "webaudio" | "element"
    this.el = null;
    this.queue = [];
    this.base = null;
    this.turnDone = false;
    this.draining = false;
    this.abortCtl = null;
    this.sources = new Set();
    this.nextStart = 0;
    this.ctx = null;
    this.elPlaying = false;
  }

  // Called from the mic click — a real user gesture, so the context is
  // allowed to start. Doing it here means it's already running when her
  // first sentence lands, instead of waking up mid-word.
  async prime() {
    if (this.mode === "element") return;
    try {
      if (!this.ctx) {
        if (!AudioCtx) throw new Error("no AudioContext");
        this.ctx = new AudioCtx();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.5;
        this.timeData = new Uint8Array(this.analyser.fftSize);
        this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") await this.ctx.resume();
      if (this.ctx.state !== "running") throw new Error(`context ${this.ctx.state}`);
      if (this.mode !== "webaudio") {
        this.mode = "webaudio";
        this.onStatus("webaudio", null);
      }
    } catch (err) {
      this.useElementFallback(err);
    }
  }

  // Last-resort player: one <audio> at a time, chained on 'ended'. Slightly
  // gappier between sentences, but it plays.
  useElementFallback(err) {
    if (this.mode === "element") return;
    this.mode = "element";
    this.ctx = null;
    this.analyser = null;
    if (!this.el) {
      this.el = new Audio();
      this.el.addEventListener("ended", () => this.elementEnded());
      this.el.addEventListener("error", () => this.elementEnded());
    }
    this.onStatus("element", err ? String(err.message ?? err) : null);
  }

  elementEnded() {
    this.elPlaying = false;
    void this.drain();
    this.maybeFinish();
  }

  /**
   * {loud, bass, live} read from the playback analyser, for the orb. On the
   * <audio> fallback path there is no analyser (iOS Safari will not let a
   * MediaElementSource feed one while also playing aloud — the robust pattern
   * would be a silent duplicate into the analyser; not built here), so it
   * reports live=false and the scene's synthetic voice motion takes over
   * while `playing` is true.
   */
  levels() {
    if (this.mode === "element") return { loud: 0, bass: 0, live: false, playing: this.elPlaying };
    if (!this.analyser || !this.ctx || this.ctx.state !== "running" || this.sources.size === 0) {
      return { loud: 0, bass: 0, live: false, playing: false };
    }
    this.analyser.getByteTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);
    return {
      loud: rmsLoud(this.timeData),
      bass: bassLevel(this.freqData, this.ctx.sampleRate, this.analyser.fftSize),
      live: true,
      playing: true,
    };
  }

  push(seg) {
    if (this.base !== null && seg.baseTurnId !== this.base) return; // stale turn
    if (this.base === null) {
      this.base = seg.baseTurnId;
      this.nextStart = 0;
    }
    this.queue.push(seg);
    void this.drain();
  }

  markDone(baseTurnId) {
    if (this.base === null || baseTurnId === this.base) {
      this.turnDone = true;
      this.maybeFinish();
    }
  }

  // One fetch at a time keeps sentences in order; scheduling is what makes
  // playback seamless, so there's nothing to gain from parallel downloads.
  async drain() {
    if (this.draining) return;
    this.draining = true;
    await this.prime();

    while (this.queue.length > 0 && this.base !== null) {
      // Element path plays one at a time; wait for the current one to end.
      if (this.mode === "element" && this.elPlaying) break;
      const seg = this.queue.shift();
      const url = `/tts/${encodeURIComponent(seg.segId)}`;
      try {
        if (this.mode === "element") {
          this.elPlaying = true;
          this.el.src = url;
          await this.el.play();
          break; // resume draining when it ends
        }
        this.abortCtl = new AbortController();
        const res = await fetch(url, { signal: this.abortCtl.signal });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        const bytes = await res.arrayBuffer();
        if (this.base === null) break; // interrupted while downloading
        const buffer = await this.ctx.decodeAudioData(bytes);
        if (this.base === null) break;
        this.schedule(buffer);
      } catch (err) {
        if (err && err.name === "AbortError") break;
        console.warn("segment failed", err);
        // If Web Audio is the problem, switch players and retry this segment
        // rather than dropping the sentence on the floor.
        if (this.mode === "webaudio") {
          this.useElementFallback(err);
          this.queue.unshift(seg);
        } else {
          this.elPlaying = false;
        }
      }
    }
    this.abortCtl = null;
    this.draining = false;
    this.maybeFinish();
  }

  schedule(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    // Start exactly where the previous sentence ends — no gap, no overlap.
    const at = Math.max(this.ctx.currentTime + LEAD_IN, this.nextStart);
    src.start(at);
    this.nextStart = at + buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.maybeFinish();
    };
  }

  maybeFinish() {
    if (!this.turnDone || this.draining) return;
    if (this.queue.length > 0 || this.sources.size > 0 || this.elPlaying) return;
    const wasActive = this.base !== null;
    this.base = null;
    this.turnDone = false;
    this.nextStart = 0;
    if (wasActive) this.onDone();
  }

  stop() {
    this.queue.length = 0;
    try {
      this.abortCtl?.abort();
    } catch {
      /* fine */
    }
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    if (this.el) {
      try {
        this.el.pause();
        this.el.removeAttribute("src");
      } catch {
        /* fine */
      }
    }
    this.elPlaying = false;
    const wasActive = this.base !== null;
    this.base = null;
    this.turnDone = false;
    this.nextStart = 0;
    if (wasActive) this.onDone();
  }

  get active() {
    return this.base !== null || this.sources.size > 0 || !!this.elPlaying;
  }
}
