// Audio levels for the orb: how loud, how much bass, and whether the number
// is real. Smoothing is asymmetric on purpose — a syllable should make the
// orb leap and then ease back, not twitch. When nothing real is flowing, a
// synthetic signal with the cadence of speech keeps her looking alive.
// Pure module.

import { clamp01, ease } from "./ease.js";

/** Fast up, slow down. attack/decay are speeds (1/s). */
export class AsymSmoother {
  constructor(attack = 18, decay = 4) {
    this.attack = attack;
    this.decay = decay;
    this.value = 0;
  }
  step(x, dt) {
    const k = x > this.value ? this.attack : this.decay;
    this.value = ease(this.value, clamp01(x), k, dt);
    return this.value;
  }
  reset(v = 0) {
    this.value = v;
  }
}

/**
 * Speech-like motion when there is no analyser to read. Listening = a gentle
 * waver; speaking = a livelier churn with syllable-ish bursts. Deterministic
 * in t, so tests can compare the two.
 */
export function synthetic(mode, t) {
  if (mode === "speaking") {
    const syll = Math.max(0, Math.sin(t * 7.3) * 0.6 + Math.sin(t * 11.1 + 1.7) * 0.4);
    const breath = 0.5 + 0.5 * Math.sin(t * 0.9);
    const loud = clamp01(0.25 + 0.55 * syll * (0.6 + 0.4 * breath));
    const bass = clamp01(0.15 + 0.5 * Math.max(0, Math.sin(t * 3.1 + 0.4)));
    return { loud, bass, live: false };
  }
  if (mode === "listening") {
    const loud = clamp01(0.12 + 0.08 * Math.sin(t * 2.2) + 0.05 * Math.sin(t * 5.7 + 2.0));
    const bass = clamp01(0.08 + 0.05 * Math.sin(t * 1.4));
    return { loud, bass, live: false };
  }
  return { loud: 0, bass: 0, live: false };
}

/**
 * Real when a real reading arrived recently and carries signal; synthetic
 * otherwise. `state` remembers when we last saw real signal so a pause
 * between words doesn't flip the source back and forth (hold-off ms).
 */
export function selectSource(real, mode, nowMs, state, holdMs = 400) {
  if (real && real.live && real.loud > 0.03) state.lastRealMs = nowMs;
  const useReal = real && real.live && nowMs - (state.lastRealMs ?? -Infinity) <= holdMs;
  if (useReal) return { loud: real.loud, bass: real.bass, live: true };
  const s = synthetic(mode, nowMs / 1000);
  return { loud: s.loud, bass: s.bass, live: false };
}

/**
 * Bass = mean magnitude of the FFT bins covering lowHz..highHz, normalised
 * 0..1. Bin i covers i * sampleRate / fftSize Hz. Works for 44.1 k and 48 k.
 */
export function bassFromSpectrum(bins, sampleRate, fftSize, lowHz = 40, highHz = 200) {
  if (!bins || !bins.length || !sampleRate || !fftSize) return 0;
  const hzPerBin = sampleRate / fftSize;
  const lo = Math.max(0, Math.floor(lowHz / hzPerBin));
  const hi = Math.min(bins.length - 1, Math.max(lo, Math.ceil(highHz / hzPerBin)));
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += bins[i];
  return clamp01(sum / ((hi - lo + 1) * 255));
}

/** Which bins bassFromSpectrum will read — exported for tests. */
export function bassBinRange(sampleRate, fftSize, lowHz = 40, highHz = 200) {
  const hzPerBin = sampleRate / fftSize;
  const lo = Math.max(0, Math.floor(lowHz / hzPerBin));
  const hi = Math.max(lo, Math.ceil(highHz / hzPerBin));
  return [lo, hi];
}

/** RMS of time-domain bytes (128 = silence), scaled like the old ampLoop did. */
export function loudFromWaveform(bytes, gain = 3.2) {
  if (!bytes || !bytes.length) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  return clamp01(Math.sqrt(sum / bytes.length) * gain);
}
