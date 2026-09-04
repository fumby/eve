// The face's pure math: easing rhythm, moods, audio levels, orbits, docking,
// the background web, and the agent-event mapping. These modules import no
// three.js and no DOM, so the scene's rules can be checked here without a
// browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ease, easeArray, RHYTHM, hexToRgb, rgbToHex } from "../face/scene/ease.js";
import { MOODS, MOOD_NAMES, SCALAR_KEYS, hueCyclePhase, blendMood, isMood } from "../face/scene/mood.js";
import {
  AsymSmoother,
  synthetic,
  selectSource,
  bassBinRange,
  bassFromSpectrum,
  loudFromWaveform,
} from "../face/scene/levels.js";
import {
  cameraZFor,
  viewExtents,
  safeBand,
  assignOrbits,
  orbitPoint,
  orbitDistance,
  RING_OUTER,
  AVATAR_RADIUS,
} from "../face/scene/orb/orbit.js";
import {
  rectAnchor,
  screenToPlaneZ0,
  planeZ0ToScreen,
  pushOutOfRadius,
  slotOffset,
} from "../face/scene/orb/dock-math.js";
import { layoutNetwork } from "../face/scene/bg/network-layout.js";
import {
  DEFAULT_ROSTER,
  designEventToPhase,
  normalizeAgentEvent,
  mergeRoster,
  colorFor,
} from "../face/scene/agent-map.js";
import { hash01, mulberry32 } from "../face/scene/rng.js";

// ------------------------------------------------------------------ ease
test("ease: converges monotonically and is frame-rate independent", () => {
  let a = 0;
  let last = 0;
  for (let i = 0; i < 60; i++) {
    a = ease(a, 1, RHYTHM.mood, 1 / 60);
    assert.ok(a >= last && a <= 1);
    last = a;
  }
  // ~98% after one second at RHYTHM.mood
  assert.ok(a > 0.97 && a < 0.99, `got ${a}`);
  // two half-steps land where one full step lands
  const one = ease(0, 1, 4, 0.016);
  const two = ease(ease(0, 1, 4, 0.008), 1, 4, 0.008);
  assert.ok(Math.abs(one - two) < 1e-9);
  assert.equal(ease(0.3, 1, 4, 0), 0.3);
});

test("easeArray + hex helpers", () => {
  const c = easeArray([0, 0, 0], [1, 0.5, 0], 4, 1);
  assert.ok(c[0] > 0.97 && Math.abs(c[1] - 0.5 * c[0]) < 1e-6 && c[2] === 0);
  assert.deepEqual(hexToRgb("#ffffff"), [1, 1, 1]);
  assert.equal(rgbToHex(hexToRgb("#2dd4a8")), "#2dd4a8");
  assert.equal(rgbToHex(hexToRgb("#fff")), "#ffffff");
});

// ------------------------------------------------------------------ mood
test("moods: five, complete, valid colours; listening is the only warm one", () => {
  assert.deepEqual(MOOD_NAMES, ["idle", "listening", "processing", "speaking", "error"]);
  for (const name of MOOD_NAMES) {
    const m = MOODS[name];
    for (const k of SCALAR_KEYS) assert.equal(typeof m[k], "number", `${name}.${k}`);
    assert.match(m.color, /^#[0-9a-f]{6}$/i);
    assert.match(m.color2, /^#[0-9a-f]{6}$/i);
  }
  const warm = MOOD_NAMES.filter((n) => {
    const [r, g, b] = hexToRgb(MOODS[n].color);
    return r > g && r > b && n !== "error";
  });
  assert.deepEqual(warm, ["listening"]);
  assert.ok(MOODS.processing.rings === 1 && MOODS.idle.rings === 0);
  assert.ok(MOODS.error.churn < 0.1 && MOODS.error.spin === 0);
  assert.ok(isMood("speaking") && !isMood("bored"));
});

test("hueCyclePhase in [0,1]; blendMood midpoint", () => {
  for (let t = 0; t < 10; t += 0.37) {
    const p = hueCyclePhase(t, 0.6);
    assert.ok(p >= 0 && p <= 1);
  }
  assert.equal(hueCyclePhase(3, 0), 0);
  const mid = blendMood(MOODS.idle, MOODS.speaking, 0.5);
  assert.ok(Math.abs(mid.bright - (0.55 + 1.15) / 2) < 1e-9);
});

// ------------------------------------------------------------------ levels
test("AsymSmoother rises faster than it falls", () => {
  const up = new AsymSmoother(18, 4);
  const down = new AsymSmoother(18, 4);
  down.reset(1);
  const dt = 1 / 60;
  let rise = 0, fall = 0;
  for (let i = 0; i < 6; i++) {
    rise = up.step(1, dt);
    fall = down.step(0, dt);
  }
  assert.ok(rise > 1 - fall, `rise ${rise} vs fall distance ${1 - fall}`);
  assert.ok(rise <= 1 && fall >= 0);
});

test("synthetic: speaking livelier than listening, both in range", () => {
  const stats = (mode) => {
    const xs = [];
    for (let t = 0; t < 20; t += 1 / 30) xs.push(synthetic(mode, t).loud);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const varc = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    return { varc, min: Math.min(...xs), max: Math.max(...xs) };
  };
  const s = stats("speaking"), l = stats("listening");
  assert.ok(s.varc > l.varc * 3, `speaking var ${s.varc} listening var ${l.varc}`);
  for (const x of [s, l]) assert.ok(x.min >= 0 && x.max <= 1);
  assert.deepEqual(synthetic("idle", 3), { loud: 0, bass: 0, live: false });
});

test("selectSource: real within hold-off, else synthetic", () => {
  const st = {};
  const real = { loud: 0.4, bass: 0.2, live: true };
  assert.equal(selectSource(real, "speaking", 1000, st).live, true);
  // silence but still live and within hold-off → still real
  const quiet = { loud: 0, bass: 0, live: true };
  assert.equal(selectSource(quiet, "speaking", 1300, st).live, true);
  // past hold-off with no signal → synthetic
  assert.equal(selectSource(quiet, "speaking", 1500, st).live, false);
  // no analyser at all → synthetic
  assert.equal(selectSource(null, "listening", 2000, st).live, false);
});

test("bass bins cover 40–200 Hz for 44.1k and 48k; loudness from waveform", () => {
  const [lo44, hi44] = bassBinRange(44100, 1024);
  const [lo48, hi48] = bassBinRange(48000, 1024);
  assert.ok(lo44 * (44100 / 1024) <= 40 && hi44 * (44100 / 1024) >= 200);
  assert.ok(lo48 * (48000 / 1024) <= 40 && hi48 * (48000 / 1024) >= 200);
  const bins = new Uint8Array(512).fill(0);
  for (let i = lo48; i <= hi48; i++) bins[i] = 255;
  assert.equal(bassFromSpectrum(bins, 48000, 1024), 1);
  assert.equal(bassFromSpectrum(new Uint8Array(512), 48000, 1024), 0);
  const silence = new Uint8Array(256).fill(128);
  assert.equal(loudFromWaveform(silence), 0);
  const loud = new Uint8Array(256).map((_, i) => (i % 2 ? 255 : 0));
  assert.ok(loudFromWaveform(loud) > 0.9);
});

// ------------------------------------------------------------------ orbits
test("cameraZFor pulls back in portrait only", () => {
  assert.equal(cameraZFor(1.6), 40);
  assert.equal(cameraZFor(1.0), 40);
  assert.ok(cameraZFor(0.6) > cameraZFor(1.6));
  assert.ok(cameraZFor(0.3) <= 40 * 1.8 + 1e-9);
});

test("safe band: rMin clears the rings, rMax shrinks with insets and narrow aspect", () => {
  const viewport = { width: 1440, height: 900 };
  const wide = safeBand({ camZ: 40, aspect: 1.6, viewport, insetsPx: { left: 342, right: 260, top: 76, bottom: 130 } });
  assert.ok(wide.rMin > RING_OUTER + AVATAR_RADIUS);
  assert.ok(wide.rMax > wide.rMin);
  const noInsets = safeBand({ camZ: 40, aspect: 1.6, viewport, insetsPx: {} });
  assert.ok(noInsets.rMax > wide.rMax);
  // Orbits span ±r horizontally but only ±r·sin(tilt) vertically, so a
  // narrower aspect tightens the band and a portrait one tightens it further.
  const square = safeBand({ camZ: 40, aspect: 1.0, viewport: { width: 900, height: 900 }, insetsPx: {} });
  assert.ok(square.rMax < noInsets.rMax);
  const portrait = safeBand({ camZ: 40, aspect: 0.7, viewport: { width: 630, height: 900 }, insetsPx: {} });
  assert.ok(portrait.rMax < square.rMax);
  // perspective clamp: both projected extents stay inside the usable half-extents
  const { halfW, halfH } = viewExtents(40, 60, 1.6);
  const s = Math.abs(Math.sin(0.6));
  const P = 40 / (40 - noInsets.rMax * s);
  assert.ok(noInsets.rMax * P <= halfW - AVATAR_RADIUS + 1e-6);
  assert.ok(noInsets.rMax * s * P <= halfH - AVATAR_RADIUS + 1e-6);
  // a 1280×720 window with the side panel open still leaves a real band
  const laptop = safeBand({ camZ: 40, aspect: 1280 / 720, viewport: { width: 1280, height: 720 }, insetsPx: { right: 260, top: 64, bottom: 120 } });
  assert.ok(laptop.rMax - laptop.rMin > 4, `band ${laptop.rMin.toFixed(1)}–${laptop.rMax.toFixed(1)}`);
});

test("assignOrbits: distinct radii/phases, alternating tilts, inside band, deterministic", () => {
  const ids = DEFAULT_ROSTER.map((a) => a.id);
  const band = safeBand({ camZ: 40, aspect: 1.6, viewport: { width: 1440, height: 900 }, insetsPx: { left: 342, right: 260, top: 76, bottom: 130 } });
  const o1 = assignOrbits(ids, band);
  const o2 = assignOrbits(ids, band);
  assert.deepEqual(o1, o2);
  const radii = ids.map((id) => o1[id].radius);
  const phases = ids.map((id) => o1[id].phase);
  assert.equal(new Set(radii.map((r) => r.toFixed(3))).size, ids.length);
  assert.equal(new Set(phases.map((p) => p.toFixed(3))).size, ids.length);
  for (const id of ids) {
    const o = o1[id];
    assert.ok(o.radius >= band.rMin && o.radius <= band.rMax, `${id} radius ${o.radius} band ${band.rMin}-${band.rMax}`);
    assert.ok(o.speed >= 0.05 && o.speed <= 0.11);
    assert.ok(Math.abs(o.tilt) >= 0.35 && Math.abs(o.tilt) <= 0.6);
  }
  const signs = ids.map((id) => Math.sign(o1[id].tilt));
  for (let i = 1; i < signs.length; i++) assert.notEqual(signs[i], signs[i - 1]);
});

test("orbitPoint stays at the orbit radius on the tilted plane", () => {
  const orbit = { radius: 14, speed: 0.07, phase: 0.3, tilt: 0.45, yaw: 0.2 };
  for (let th = 0; th < Math.PI * 2; th += 0.5) {
    assert.ok(Math.abs(orbitDistance(orbit, th) - 14) < 1e-9);
  }
  const p = orbitPoint({ radius: 10, tilt: 0, yaw: 0 }, Math.PI / 2);
  assert.ok(Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9 && Math.abs(p[2] - 10) < 1e-9);
  const q = orbitPoint({ radius: 10, tilt: Math.PI / 2, yaw: 0 }, Math.PI / 2);
  assert.ok(Math.abs(q[1] + 10) < 1e-9); // fully tilted: z becomes -y
});

// ------------------------------------------------------------------ docking
test("dock math: screen↔plane round-trip, anchors, push-out, slots", () => {
  const vp = { width: 1440, height: 900 };
  const pt = { x: 400, y: 300 };
  const w = screenToPlaneZ0(pt, vp, 40, 60, 1.6);
  const back = planeZ0ToScreen(w, vp, 40, 60, 1.6);
  assert.ok(Math.abs(back.x - pt.x) < 1e-6 && Math.abs(back.y - pt.y) < 1e-6);
  const rect = { left: 22, top: 500, width: 300, height: 120, right: 322, bottom: 620 };
  assert.deepEqual(rectAnchor(rect, "right", 28), { x: 350, y: 560 });
  assert.deepEqual(rectAnchor(rect, "top", 10), { x: 172, y: 490 });
  const pushed = pushOutOfRadius([1, 0, 0], 8);
  assert.ok(Math.abs(Math.hypot(pushed[0], pushed[1]) - 8) < 1e-9);
  assert.deepEqual(pushOutOfRadius([20, 5, 0], 8), [20, 5, 0]);
  assert.deepEqual(pushOutOfRadius([0, 0, 0], 8), [8, 0, 0]);
  assert.ok(slotOffset(2).y > slotOffset(1).y && slotOffset(0).y === 0);
});

// ------------------------------------------------------------------ network
test("network layout: counts, clusters, edge threshold, determinism", () => {
  const a = layoutNetwork();
  const b = layoutNetwork();
  assert.equal(a.nodes.count, 100);
  assert.equal(a.dust.count, 300);
  assert.equal(new Set(a.nodes.cluster).size, 8);
  assert.deepEqual(Array.from(a.nodes.pos.slice(0, 9)), Array.from(b.nodes.pos.slice(0, 9)));
  assert.ok(a.edges.count > 0, "some nodes should be linked");
  for (let k = 0; k < a.edges.count; k++) {
    const p = a.edges.pos;
    const i = k * 6;
    const d = Math.hypot(p[i] - p[i + 3], p[i + 1] - p[i + 4], p[i + 2] - p[i + 5]);
    assert.ok(d < a.linkDist);
  }
  const m = layoutNetwork({ nodes: 50, dust: 150 });
  assert.equal(m.nodes.count, 50);
  assert.equal(m.dust.count, 150);
});

test("rng: hash01 stable in [0,1); mulberry32 deterministic", () => {
  assert.equal(hash01("drucker"), hash01("drucker"));
  assert.notEqual(hash01("drucker"), hash01("munger"));
  const h = hash01("anything");
  assert.ok(h >= 0 && h < 1);
  const r1 = mulberry32(7), r2 = mulberry32(7);
  assert.equal(r1(), r2());
});

// ------------------------------------------------------------------ agents
test("default roster: the six real sub-agents, cool colours", () => {
  assert.deepEqual(
    DEFAULT_ROSTER.map((a) => a.id),
    ["drucker", "munger", "newport", "hormozi", "design", "research"],
  );
  // Nothing in the amber/orange/yellow band (hue 15°–70°): that band is
  // reserved for the "listening" state so it reads unmistakably.
  const hueOf = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return 0;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  };
  for (const a of DEFAULT_ROSTER) {
    const h = hueOf(a.color);
    assert.ok(h < 15 || h > 70, `${a.id} colour hue ${h.toFixed(0)}° sits in the amber band`);
  }
  const amber = hueOf(MOODS.listening.color);
  assert.ok(amber >= 15 && amber <= 70);
});

test("designEventToPhase / normalizeAgentEvent / mergeRoster / colorFor", () => {
  assert.equal(designEventToPhase("cc_tool"), "working");
  assert.equal(designEventToPhase("image"), "working");
  assert.equal(designEventToPhase("error"), "error");
  assert.equal(designEventToPhase("nope"), null);

  const known = new Set(["design"]);
  assert.deepEqual(normalizeAgentEvent({ agent: "design", phase: "dispatch", label: "x" }, known), {
    agent: "design", phase: "dispatch", label: "x",
  });
  assert.equal(normalizeAgentEvent({ agent: "ghost", phase: "dispatch" }, known), null);
  const withDesc = normalizeAgentEvent(
    { agent: "ghost", phase: "working", descriptor: { name: "Ghost", specialty: "haunting" } },
    known,
  );
  assert.equal(withDesc.descriptor.id, "ghost");
  assert.equal(normalizeAgentEvent({ agent: "design", phase: "flying" }, known), null);
  assert.equal(normalizeAgentEvent(null, known), null);

  const merged = mergeRoster([{ id: "design", name: "Head of Design", specialty: "mockups" }, { id: "x", name: "X" }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].color, "#F0A6FF"); // default colour kept
  assert.match(merged[1].color, /^#[0-9a-f]{6}$/i);
  assert.equal(mergeRoster([]).length, DEFAULT_ROSTER.length);
  assert.equal(colorFor("abc"), colorFor("abc"));
});
