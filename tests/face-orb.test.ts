// The new face's orb renderer, tested at its pure boundary: createEveOrbScene
// builds every mesh, and frame() turns them into draws with finite matrices
// and per-kind uniforms. mountOrb itself needs WebGL, so it is covered by the
// browser checks (scripts/face-turn-check.ts drives the real page); what this
// file protects is the geometry/animation contract the handoff pinned: the
// triangulated globe, the three segmented bands, the particle membrane, and
// the breathing — none of which may silently lose a draw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEveOrbScene } from "../face/orb/eve-orb.js";

const scene = createEveOrbScene();

test("scene builds the accepted assembly: every named mesh present", () => {
  const names = new Set(scene.meshes.map((m) => m.name));
  // The handoff's named layers — the design reference, verbatim.
  for (const name of [
    "localized radiance",
    "recessed inner circuitry",
    "broad radial blue panels",
    "narrow teal segmented crown",
    "light between panel layers",
    "circular machined tracks",
    "fine radial graduations",
    "flowing particle membrane",
    "translucent veil filaments",
    "undulating luminous hems",
    "drifting edge dust",
    "opaque spherical core",
    "triangulated rotating globe",
    "thin luminous core contour",
  ]) {
    assert.ok(names.has(name), `missing mesh: ${name}`);
  }
  assert.equal(scene.meshes.length, 14);
});

test("every mesh has aligned attribute buffers (positions/colors/data)", () => {
  for (const m of scene.meshes) {
    assert.equal(m.positions.length % 3, 0, `${m.name}: positions not vec3-aligned`);
    assert.equal(m.colors.length % 4, 0, `${m.name}: colors not vec4-aligned`);
    assert.equal(m.data.length % 4, 0, `${m.name}: data not vec4-aligned`);
    assert.equal(m.positions.length / 3, m.colors.length / 4, `${m.name}: color count mismatch`);
    assert.equal(m.positions.length / 3, m.data.length / 4, `${m.name}: data count mismatch`);
  }
});

test("frame() draws the full stack, in draw order, with finite matrices", () => {
  const f = scene.frame(1.5, 500, 500, 2);
  assert.equal(f.draws.length, 16); // 14 meshes + 2 glow passes (membrane, dust)
  const kinds = new Set();
  for (const d of f.draws) {
    assert.ok(d.matrix.every((x) => Number.isFinite(x)), `non-finite matrix in ${d.name}`);
    assert.ok(d.uniforms.uTime === 1.5, `uTime not carried for ${d.name}`);
    kinds.add(d.kind);
  }
  // kinds 0..7 are all exercised (globe, bands, membrane, dust, contour, core,
  // haze): the whole accepted visual stack is actually drawn, not just present.
  for (const k of [0, 1, 2, 3, 4, 5, 7]) assert.ok(kinds.has(k), `kind ${k} never drawn`);
});

test("breathing: identical frames at the same time, different 150ms later", () => {
  // The one shared clock drives size/phase; two times must differ in the
  // uTime uniform — a frozen renderer (or a dropped clock) fails here.
  const a = scene.frame(2, 400, 400, 1);
  const b = scene.frame(2, 400, 400, 1);
  const c = scene.frame(2.15, 400, 400, 1);
  for (let i = 0; i < a.draws.length; i++) {
    assert.equal(a.draws[i].uniforms.uTime, b.draws[i].uniforms.uTime);
    assert.notEqual(a.draws[i].uniforms.uTime, c.draws[i].uniforms.uTime);
    // the membrane's model matrix shifts with the shared breathing offset
    if (a.draws[i].kind === 1) {
      assert.notDeepEqual(a.draws[i].matrix, c.draws[i].matrix, "band matrix did not move");
    }
  }
});

test("the globe rotates independently of the outer assembly", () => {
  // Rotation happens IN the vertex shader (uKind<.5 spins p.xz by uTime;
  // uKind 1-3 deform in-shader too) — the matrices are only the two camera
  // paths: the core's (static framing) and the assembly's (slow drift). So
  // the independence contract is: two distinct matrices, both finite, and
  // the shared clock that drives both rotations actually advances.
  const t1 = scene.frame(3, 400, 400, 1);
  const t2 = scene.frame(3.2, 400, 400, 1);
  const globe = (f) => f.draws.find((d) => d.kind === 0);
  const bands = (f) => f.draws.find((d) => d.kind === 1);
  // distinct transform paths — never the same matrix
  assert.notDeepEqual(globe(t1).matrix, bands(t1).matrix, "globe and assembly share a matrix");
  // the assembly's slow drift moves its matrix (the x/y wobble in model())
  assert.notDeepEqual(bands(t1).matrix, bands(t2).matrix, "assembly did not drift");
  // the clock that spins the globe in-shader advances for both
  assert.ok(t2.time > t1.time);
  for (const d of t1.draws) assert.ok(d.uniforms.uTime === t1.time, `${d.name} lost the shared clock`);
});

test("aspect is respected (portrait and landscape both valid)", () => {
  for (const [w, h] of [[500, 500], [900, 1440], [1440, 900]]) {
    const f = scene.frame(1, w, h, 1);
    for (const d of f.draws) {
      assert.ok(Number.isFinite(d.matrix[0]), `bad projection at ${w}x${h} (${d.name})`);
      assert.ok(d.matrix[5] > 0, `degenerate fov at ${w}x${h} (${d.name})`);
    }
  }
});

// ---------------------------------------------------------------------------
// The build-up and her voice — both pure options on frame(), both no-ops by
// default, so the accepted still orb is what every existing caller still gets.

test("defaults reproduce the accepted orb: fully formed, silent, veil clock = time", () => {
  const plain = scene.frame(2.5, 500, 500, 2);
  const explicit = scene.frame(2.5, 500, 500, 2, { reveal: 1, voice: 0, bass: 0, flow: 2.5 });
  assert.deepEqual(plain.draws.map((d) => d.uniforms), explicit.draws.map((d) => d.uniforms));
  assert.deepEqual(plain.draws.map((d) => d.matrix), explicit.draws.map((d) => d.matrix));
  for (const d of plain.draws) {
    assert.equal(d.uniforms.uVoice, 0, `${d.name}: voice leaked into the default frame`);
    assert.equal(d.uniforms.uBass, 0);
    assert.equal(d.uniforms.uFlow, 2.5, `${d.name}: the veil's clock must equal time at rest`);
    // base passes at full gain, the two glow passes at their fixed .045
    assert.ok(d.uniforms.uGain === 1 || d.uniforms.uGain === 0.045, `${d.name}: uGain ${d.uniforms.uGain}`);
  }
});

test("the build-up assembles her inside out, and ends exactly formed", () => {
  const gain = (reveal, name) => scene.frame(1, 400, 400, 1, { reveal }).draws.find((d) => d.name === name && d.uniforms.uPointScale === 1).uniforms.uGain;
  // early: the globe is lit; the dust and the radiance are still dark
  assert.ok(gain(0.2, "triangulated rotating globe") > 0.5, "the globe should be the first thing seen");
  assert.equal(gain(0.2, "drifting edge dust"), 0, "dust before the globe has formed");
  assert.equal(gain(0.2, "localized radiance"), 0);
  // mid: the bands are coming up, the veil has not started
  assert.ok(gain(0.45, "broad radial blue panels") > 0.5);
  assert.equal(gain(0.45, "flowing particle membrane"), 0, "the veil before the bands");
  // the order is the design: no layer starts before the one inside it
  const order = [
    "opaque spherical core", "triangulated rotating globe", "thin luminous core contour",
    "recessed inner circuitry", "broad radial blue panels", "narrow teal segmented crown",
    "circular machined tracks", "fine radial graduations", "light between panel layers",
    "undulating luminous hems", "translucent veil filaments", "flowing particle membrane", "drifting edge dust",
  ];
  const firstLit = (name) => { for (let r = 0; r <= 1; r += 0.01) if (gain(r, name) > 0) return r; return 1; };
  const starts = order.map(firstLit);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] >= starts[i - 1], `${order[i]} lights up before ${order[i - 1]}`);
  // formed: every layer at exactly its accepted gain, the assembly at full size
  const done = scene.frame(1, 400, 400, 1, { reveal: 1 });
  const plain = scene.frame(1, 400, 400, 1);
  assert.deepEqual(done.draws.map((d) => d.uniforms.uGain), plain.draws.map((d) => d.uniforms.uGain));
  assert.deepEqual(done.draws[0].matrix, plain.draws[0].matrix, "a formed orb must not be scaled");
  // forming: she starts small and grows
  const forming = scene.frame(1, 400, 400, 1, { reveal: 0 });
  assert.ok(Math.abs(forming.draws[0].matrix[0]) < Math.abs(plain.draws[0].matrix[0]), "the assembly did not start small");
});

test("her voice reaches the veil: levels are carried, clamped, and actually read by the shader", () => {
  const f = scene.frame(3, 400, 400, 1, { voice: 0.8, bass: 0.4, flow: 7.25 });
  for (const d of f.draws) {
    assert.equal(d.uniforms.uVoice, 0.8);
    assert.equal(d.uniforms.uBass, 0.4);
    assert.equal(d.uniforms.uFlow, 7.25, `${d.name}: the veil's own clock is not carried`);
    assert.equal(d.uniforms.uTime, 3, `${d.name}: the wall clock must not follow the veil's`);
  }
  // out-of-range levels are clamped, never handed raw to the GPU
  const loud = scene.frame(3, 400, 400, 1, { voice: 4, bass: -1 });
  assert.equal(loud.draws[0].uniforms.uVoice, 1);
  assert.equal(loud.draws[0].uniforms.uBass, 0);
  // a uniform declared but never read would be a silent no-op
  for (const u of ["uVoice", "uBass", "uFlow"]) assert.ok(scene.vertexSource.split(u).length > 2, `${u} is declared but never read`);
});
