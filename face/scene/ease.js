// The one rhythm every property in the scene shares. Nothing ever snaps:
// a value moves toward its target by a fraction that depends only on how
// much time passed, so 60 Hz and 30 Hz land in the same place after the
// same second. Pure module — no three, no DOM — so tests can import it.

/** Frame-rate independent exponential approach. k = "speed": ~98% in 4/k s. */
export function ease(cur, target, k, dt) {
  if (dt <= 0) return cur;
  return cur + (target - cur) * (1 - Math.exp(-k * dt));
}

/** Component-wise ease over plain arrays (rgb, xyz). Mutates and returns `cur`. */
export function easeArray(cur, target, k, dt) {
  for (let i = 0; i < cur.length; i++) cur[i] = ease(cur[i], target[i], k, dt);
  return cur;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Speeds (1/s) — the shared vocabulary for "how fast does this settle". */
export const RHYTHM = Object.freeze({
  mood: 4, // state changes: ~1 s to fully arrive
  fast: 10, // small reactive things: brightness ticks, flares
  slow: 1.5, // long settles: orbit radius changes, returning to orbit
  dockIn: 6, // an agent arriving at its panel — snappy
  dockOut: 1.5, // an agent drifting back to orbit — graceful
});

/** #rrggbb → [r,g,b] in 0..1 (sRGB, no gamma math here). */
export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** [r,g,b] 0..1 → #rrggbb. */
export function rgbToHex(rgb) {
  return (
    "#" +
    rgb
      .map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}
