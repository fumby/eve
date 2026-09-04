// Mic capture via PvRecorder (prebuilt binary, 16 kHz 16-bit mono — exactly
// what Deepgram wants). Tap-to-toggle: start(), speak, stop() → PCM buffer.
import { PvRecorder } from "@picovoice/pvrecorder-node";

export class CaptureError extends Error {}

export class Recorder {
  private recorder: PvRecorder | null = null;
  private frames: Int16Array[] = [];
  private running = false;
  private loop: Promise<void> | null = null;

  readonly sampleRate = 16000;

  // onFrame lets a live transcriber consume audio WHILE it's being captured.
  start(onFrame?: (frame: Int16Array) => void): void {
    try {
      this.recorder = new PvRecorder(512, -1); // 512-sample frames, default mic
      this.recorder.start();
    } catch (err) {
      throw new CaptureError(
        `Couldn't open the microphone (${err instanceof Error ? err.message : err}). ` +
          "macOS may be waiting for you to grant mic access to your terminal — check System Settings → Privacy & Security → Microphone.",
      );
    }
    this.frames = [];
    this.running = true;
    this.loop = (async () => {
      while (this.running && this.recorder) {
        try {
          const frame = await this.recorder.read();
          this.frames.push(frame);
          onFrame?.(frame);
        } catch {
          break; // recorder released mid-read during stop()
        }
      }
    })();
  }

  async stop(): Promise<Int16Array> {
    this.running = false;
    try {
      this.recorder?.stop();
    } catch {
      // already stopped
    }
    await this.loop;
    this.recorder?.release();
    this.recorder = null;

    const total = this.frames.reduce((n, f) => n + f.length, 0);
    const pcm = new Int16Array(total);
    let off = 0;
    for (const f of this.frames) {
      pcm.set(f, off);
      off += f.length;
    }
    this.frames = [];
    return pcm;
  }
}
