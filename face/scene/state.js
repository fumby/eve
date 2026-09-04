// The scene's shared store. A mood is a set of targets; `cur` is where the
// orb actually is right now, easing toward those targets every frame with
// the one shared rhythm. Levels are chosen here too — real audio when it is
// flowing, a speech-like synthetic signal when it is not — and smoothed with
// a fast attack and a slow decay. Every layer reads `cur` and `levels`;
// nothing writes them but this file.

import { ease, easeArray, hexToRgb, RHYTHM } from "./ease.js";
import { MOODS, SCALAR_KEYS, isMood, hueCyclePhase } from "./mood.js";
import { AsymSmoother, selectSource } from "./levels.js";

export function createState() {
  const targets = {}; // scalars + color/color2 arrays
  const cur = { color: hexToRgb(MOODS.idle.color), color2: hexToRgb(MOODS.idle.color2), hueMix: 0, body: hexToRgb(MOODS.idle.color) };
  for (const k of SCALAR_KEYS) cur[k] = MOODS.idle[k];

  let mood = "idle";
  let baseMood = "idle";
  let flashTimer = 0;
  let manualLevels = null;
  let sources = { playback: null, mic: null };
  const selectState = {};
  const loudS = new AsymSmoother(18, 4);
  const bassS = new AsymSmoother(14, 3);
  const levels = { loud: 0, bass: 0, live: false, source: "none" };
  const flags = { reducedMotion: false, perf: false, mobile: false };

  function applyMood(name) {
    const m = MOODS[name];
    for (const k of SCALAR_KEYS) targets[k] = m[k];
    targets.color = hexToRgb(m.color);
    targets.color2 = hexToRgb(m.color2);
  }
  applyMood("idle");

  function nowMs() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  return {
    cur,
    levels,
    flags,
    get mood() {
      return mood;
    },
    setState(name) {
      if (!isMood(name)) return false;
      baseMood = name;
      if (flashTimer > 0) return true; // the flash finishes first, then lands on the new base
      mood = name;
      applyMood(name);
      return true;
    },
    /** Temporary mood (the error flash), then back to whatever the base is by then. */
    flash(name, ms = 2500) {
      if (!isMood(name)) return false;
      mood = name;
      applyMood(name);
      flashTimer = Math.max(0.05, ms / 1000);
      return true;
    },
    setLevels(v) {
      manualLevels = v && typeof v === "object" ? { loud: +v.loud || 0, bass: +v.bass || 0 } : null;
    },
    setLevelSources(s) {
      sources = { ...sources, ...(s || {}) };
    },
    /** Called once per frame by the loop, before any layer reads cur/levels. */
    update(dt, t) {
      if (flashTimer > 0) {
        flashTimer -= dt;
        if (flashTimer <= 0) {
          flashTimer = 0;
          mood = baseMood;
          applyMood(baseMood);
        }
      }
      for (const k of SCALAR_KEYS) cur[k] = ease(cur[k], targets[k], RHYTHM.mood, dt);
      easeArray(cur.color, targets.color, RHYTHM.mood, dt);
      easeArray(cur.color2, targets.color2, RHYTHM.mood, dt);
      // hue cycling only has an effect while the mood asks for it (eased in/out via hueCycle)
      cur.hueMix = ease(cur.hueMix, hueCyclePhase(t, cur.hueCycle) * Math.min(1, cur.hueCycle / 0.3), 6, dt);
      // the colour she is showing right now — what every glow should track
      for (let i = 0; i < 3; i++) cur.body[i] = cur.color[i] + (cur.color2[i] - cur.color[i]) * cur.hueMix;

      // levels: manual override → real source for the mood → synthetic
      let raw;
      if (manualLevels) {
        raw = { loud: manualLevels.loud, bass: manualLevels.bass, live: true };
        levels.source = "manual";
      } else {
        const src = mood === "listening" ? sources.mic : mood === "speaking" ? sources.playback : null;
        let real = null;
        try {
          real = src ? src() : null;
        } catch {
          real = null;
        }
        raw = selectSource(real, mood, nowMs(), selectState);
        levels.source = raw.live ? "real" : mood === "listening" || mood === "speaking" ? "synthetic" : "none";
      }
      levels.loud = loudS.step(raw.loud, dt);
      levels.bass = bassS.step(raw.bass, dt);
      levels.live = !!raw.live;
    },
    snapshot() {
      return { mood, base: baseMood, cur: { ...cur, color: [...cur.color], color2: [...cur.color2], body: [...cur.body] }, levels: { ...levels } };
    },
  };
}
