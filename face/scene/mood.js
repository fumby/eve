// The five moods the orb can be in. Each is a target the scene eases toward,
// never a look it jumps to. Numbers are tuned for the wireframe orb of
// radius 5.5 seen from z=40; keep the *characters* if you retune:
//   idle       dim, slow, almost dormant
//   listening  the ONE warm colour — unmistakable "I'm recording you"
//   processing dim body, faster churn, hue cycling teal↔purple; rings take over
//   speaking   bright, lively, voice-deformed, gentle size pulse, extra spin
//   error      red, sharp-edged, nearly frozen
// Pure module.

export const MOODS = Object.freeze({
  idle: {
    color: "#2DD4A8", color2: "#2DD4A8", hueCycle: 0,
    bright: 0.55, disp: 0.06, churn: 0.25, spin: 0.10, halo: 0.9,
    rings: 0, bgGlow: 0.35, sizePulse: 0, sharp: 0,
  },
  listening: {
    color: "#F5B54A", color2: "#F5B54A", hueCycle: 0,
    bright: 1.0, disp: 0.10, churn: 0.35, spin: 0.15, halo: 1.5,
    rings: 0, bgGlow: 0.70, sizePulse: 0.01, sharp: 0,
  },
  processing: {
    color: "#2DD4A8", color2: "#7C6BF0", hueCycle: 0.6,
    bright: 0.60, disp: 0.09, churn: 1.10, spin: 0.35, halo: 0.8,
    rings: 1, bgGlow: 0.85, sizePulse: 0, sharp: 0,
  },
  speaking: {
    color: "#3EE8BC", color2: "#2DD4A8", hueCycle: 0,
    bright: 1.15, disp: 0.12, churn: 0.70, spin: 0.30, halo: 1.2,
    rings: 0, bgGlow: 0.70, sizePulse: 0.04, sharp: 0,
  },
  error: {
    color: "#F05252", color2: "#F05252", hueCycle: 0,
    bright: 0.90, disp: 0.02, churn: 0.05, spin: 0.0, halo: 0.7,
    rings: 0, bgGlow: 0.50, sizePulse: 0, sharp: 1,
  },
});

export const MOOD_NAMES = Object.freeze(Object.keys(MOODS));
export const SCALAR_KEYS = Object.freeze([
  "hueCycle", "bright", "disp", "churn", "spin", "halo", "rings", "bgGlow", "sizePulse", "sharp",
]);

export function isMood(name) {
  return Object.prototype.hasOwnProperty.call(MOODS, name);
}

/** 0..1 phase of the processing hue cycle at time t (seconds) for a rate in Hz. */
export function hueCyclePhase(t, rateHz) {
  if (!rateHz) return 0;
  return 0.5 + 0.5 * Math.sin(2 * Math.PI * rateHz * t);
}

/** Linear blend of two moods' scalars (colours are handled by the caller). */
export function blendMood(a, b, x) {
  const out = {};
  for (const k of SCALAR_KEYS) out[k] = a[k] + (b[k] - a[k]) * x;
  return out;
}
