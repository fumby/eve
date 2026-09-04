// Entry point for EVE's living face. Three stacked layers — background
// (own renderer), orb (transparent renderer), labels (DOM) — one loop, one
// shared easing rhythm. Installs window.EveOrb so shell.js (the DOM + socket
// controller) and the browser console can drive it.

import { createLoop } from "./loop.js";
import { createState } from "./state.js";
import { createBackgroundLayer } from "./bg/layer.js";
import { createOrbLayer } from "./orb/layer.js";
import { createRings } from "./orb/rings.js";
import { createFx } from "./orb/fx.js";
import { createAgents } from "./orb/agents.js";
import { createLabels } from "./labels.js";
import { DEFAULT_ROSTER } from "./agent-map.js";

const params = new URLSearchParams(location.search);
const ua = navigator.userAgent || "";
const coarse = matchMedia("(pointer: coarse)").matches;
const mobile = /iPhone|iPad|iPod|Android/i.test(ua) || (coarse && innerWidth < 900);
const reducedMotionMq = matchMedia("(prefers-reduced-motion: reduce)");
let perf = params.get("perf") === "1" || mobile;
// ?nopause=1: verification mode — timer-driven loop, frames kept in the drawing
// buffer so a frame rendered while hidden is what a screenshot sees.
const verify = params.get("nopause") === "1";
if (verify) document.documentElement.classList.add("verify");

const state = createState();
state.flags.mobile = mobile;
state.flags.perf = perf;
state.flags.reducedMotion = reducedMotionMq.matches;

const bgRoot = document.getElementById("bg-root");
const orbRoot = document.getElementById("orb-root");
const bg = createBackgroundLayer({ root: bgRoot, mobile, perf, preserve: verify });
const orbLayer = createOrbLayer({ root: orbRoot, mobile, perf, preserve: verify });

const loop = createLoop({ ignoreHidden: verify });
const ctx = { state, orbLayer, bg, loop, flags: state.flags, viewport: { width: 1, height: 1 } };

// Attached to the orb: the processing rings and the pooled effects.
const rings = orbLayer.addExtra(createRings());
const fx = orbLayer.addExtra(createFx({ camera: orbLayer.camera }));
ctx.rings = rings;
ctx.fx = fx;
// The constellation of her real sub-agents, and their DOM labels.
const labels = createLabels({ root: document.getElementById("agent-labels") });
const agents = orbLayer.addExtra(createAgents({ camera: orbLayer.camera, fx, labels, ctx }));
ctx.agents = agents;
ctx.labels = labels;
agents.setRoster(DEFAULT_ROSTER); // the server's roster (snapshot.agents) replaces this when it arrives
// While she is thinking, a faint wave ripples outward every couple of seconds.
let waveTimer = 0;
orbLayer.addExtra({
  update(dt, t, cur) {
    if (rings.visibility > 0.5) {
      waveTimer -= dt;
      if (waveTimer <= 0) {
        waveTimer = 2.2;
        fx.ringPulse({ at: [0, 0, 0], from: 5.5 * 1.1, to: 5.5 * 2.6, duration: 1.6, opacity: 0.22, color: "#" + [0, 1, 2].map((i) => Math.round(cur.body[i] * 255).toString(16).padStart(2, "0")).join("") });
      }
    } else waveTimer = 0.4;
  },
});

function resize() {
  const w = innerWidth, h = innerHeight;
  if (!w || !h) return; // not laid out yet — a real resize follows
  ctx.viewport.width = w;
  ctx.viewport.height = h;
  bg.resize(w, h);
  orbLayer.resize(w, h);
}
addEventListener("resize", resize);
resize();

let labelsShown = false;
loop.subscribe((dt, t, frame) => {
  state.update(dt, t);
  bg.update(dt, t, frame, state.cur, state.flags.reducedMotion);
  orbLayer.update(dt, t, state.cur, state.levels, ctx);
  if (!labelsShown) {
    // labels fade in with the orb canvas, never ahead of it
    labelsShown = true;
    document.getElementById("agent-labels")?.classList.add("ready");
  }
});
loop.start();

reducedMotionMq.addEventListener?.("change", (e) => {
  state.flags.reducedMotion = e.matches;
});

let disposed = false;
function dispose() {
  if (disposed) return;
  disposed = true;
  loop.stop();
  orbLayer.dispose();
  labels.dispose();
  bg.dispose();
}
// iOS/WKWebView: release GL contexts when the page goes away; if the page is
// restored from the back/forward cache, start fresh rather than resume dead contexts.
addEventListener("pagehide", dispose);
addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});

const api = {
  setState: (m) => state.setState(m),
  flash: (m, ms) => state.flash(m, ms),
  getState: () => state.snapshot(),
  setLevels: (v) => state.setLevels(v),
  setLevelSources: (s) => state.setLevelSources(s),
  // legacy shim from the old orb: a single brightness scalar
  setVoiceBright: (v) => state.setLevels(v > 0 ? { loud: v, bass: v * 0.5 } : null),
  perf(on) {
    if (on === undefined) return perf;
    perf = !!on;
    state.flags.perf = perf;
    bg.setPerf(perf);
    orbLayer.setPerf(perf);
    return perf;
  },
  reducedMotion(on) {
    if (on === undefined) return state.flags.reducedMotion;
    state.flags.reducedMotion = !!on;
    return state.flags.reducedMotion;
  },
  pause: () => loop.pause(),
  resume: () => loop.resume(),
  /** Run `seconds` of simulation right now (60 fixed steps per second) — for tests and screenshots. */
  step: (seconds = 1) => loop.step(1 / 60, Math.max(1, Math.round(seconds * 60))),
  dispose,
  agents: {
    setRoster: (list) => agents.setRoster(list),
    list: () => agents.list(),
    add: (desc) => agents.add(desc),
    remove: (id) => agents.remove(id),
    dispatch: (id, opts) => agents.dispatch(id, opts),
    working: (id, opts) => agents.working(id, opts),
    done: (id) => agents.done(id),
    error: (id, opts) => agents.error(id, opts),
    dock: (id, target, opts) => agents.dock(id, target, opts),
    undock: (id) => agents.undock(id),
    positionOf: (id) => agents.positionOf(id),
  },
  fx: {
    pulseWave: () => fx.ringPulse({ at: [0, 0, 0], from: 5.5 * 1.1, to: 5.5 * 2.6, duration: 1.6, opacity: 0.3 }),
    sonar: (at, color) => fx.ringPulse({ at, from: 1, to: 6, duration: 0.9, opacity: 0.8, color }),
    arc: (name, color) => fx.arc(name, color),
    beam: (opts) => fx.beam(opts),
  },
  ctx,
  get debug() {
    return { fps: Math.round(loop.fps), t: loop.t, frame: loop.frame, mobile, perf, mood: state.mood, levels: { ...state.levels } };
  },
};
window.EveOrb = api;
export default api;

if (params.get("demo") === "1") {
  import("./demo.js").then((m) => m.startDemo(api)).catch((e) => console.warn("[eve] demo failed", e));
}
