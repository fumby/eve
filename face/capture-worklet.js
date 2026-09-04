// AudioWorklet: downsample the mic to 16 kHz mono Int16 frames (512 samples)
// regardless of the device's native rate, and post them to the main thread.
class EveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000; // context rate → 16k
    this.readPos = 0;
    this.out = new Int16Array(512);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = this.readPos;
    while (i < ch.length) {
      const i0 = Math.floor(i);
      const i1 = Math.min(i0 + 1, ch.length - 1);
      const frac = i - i0;
      const s = ch[i0] * (1 - frac) + ch[i1] * frac;
      this.out[this.n++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (this.n === 512) {
        const copy = this.out.slice();
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.n = 0;
      }
      i += this.step;
    }
    this.readPos = i - ch.length;
    return true;
  }
}
registerProcessor("eve-capture", EveCapture);
