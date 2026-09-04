// The orb: a finely subdivided wireframe icosahedron whose surface is
// displaced by drifting noise so it breathes even at rest, lit by fresnel so
// its edges glow brighter than its centre — a translucent field of energy,
// not a ball. A faint fill gives it body, a BackSide shell a soft halo, and a
// wide additive sprite the atmosphere. Everything it shows comes from the
// eased `cur` values in state, plus the live audio levels.

import * as THREE from "three";
import { ORB_VERT, ORB_WIRE_FRAG, ORB_FILL_FRAG, SHELL_VERT, SHELL_FRAG } from "./shaders.js";
import { ORB_RADIUS } from "./orbit.js";

export function glowTexture(stops, size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createOrb({ detail = 5 } = {}) {
  const group = new THREE.Group();
  const R = ORB_RADIUS;

  const uniforms = {
    uTime: { value: 0 },
    uBreath: { value: 0.06 },
    uAudio: { value: 0 },
    uChurn: { value: 0.25 },
    uFreq: { value: 1.35 },
    uSharp: { value: 0 },
    uColorA: { value: new THREE.Color("#2DD4A8") },
    uColorB: { value: new THREE.Color("#2DD4A8") },
    uHueMix: { value: 0 },
    uBright: { value: 0.55 },
    uOpacity: { value: 1 },
  };

  const geometry = new THREE.IcosahedronGeometry(R, detail);

  const wire = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: ORB_VERT,
      fragmentShader: ORB_WIRE_FRAG,
      wireframe: true,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
    }),
  );
  wire.renderOrder = 2;

  const fill = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FILL_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
    }),
  );
  fill.renderOrder = 1;

  const shellUniforms = { uColor: { value: new THREE.Color("#2DD4A8") }, uOpacity: { value: 0.35 } };
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.32, 48, 32),
    new THREE.ShaderMaterial({
      uniforms: shellUniforms,
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
    }),
  );
  shell.renderOrder = 0;

  const atmoTex = glowTexture([
    [0, "rgba(255,255,255,0.55)"],
    [0.25, "rgba(255,255,255,0.22)"],
    [0.6, "rgba(255,255,255,0.05)"],
    [1, "rgba(255,255,255,0)"],
  ]);
  const atmo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: atmoTex,
      color: new THREE.Color("#2DD4A8"),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  atmo.renderOrder = -1;
  atmo.scale.setScalar(R * 5.2);

  group.add(atmo, shell, fill, wire);

  const colA = new THREE.Color(), colB = new THREE.Color(), bodyCol = new THREE.Color();

  return {
    group,
    uniforms,
    /** cur: eased mood values; levels: {loud, bass} already smoothed. */
    update(dt, t, cur, levels) {
      uniforms.uTime.value = t;
      uniforms.uBreath.value = cur.disp;
      uniforms.uAudio.value = cur.disp * 0.5 + 0.22 * levels.loud;
      uniforms.uChurn.value = cur.churn;
      uniforms.uSharp.value = cur.sharp;
      uniforms.uBright.value = cur.bright;
      uniforms.uHueMix.value = cur.hueMix;
      colA.setRGB(cur.color[0], cur.color[1], cur.color[2]);
      colB.setRGB(cur.color2[0], cur.color2[1], cur.color2[2]);
      uniforms.uColorA.value.copy(colA);
      uniforms.uColorB.value.copy(colB);
      // halo follows the mood colour and size
      const body = bodyCol.setRGB(cur.body[0], cur.body[1], cur.body[2]);
      shellUniforms.uColor.value.copy(body);
      shellUniforms.uOpacity.value = 0.05 + 0.11 * cur.bright * cur.halo;
      atmo.material.color.copy(body);
      atmo.material.opacity = 0.14 + 0.2 * cur.halo * cur.bright;
      atmo.scale.setScalar(R * (3.2 + 1.0 * cur.halo));
      // two-axis tumble: mostly Y, a slight breathing tilt
      group.rotation.y += dt * cur.spin;
      group.rotation.x = 0.35 + 0.08 * Math.sin(t * 0.13);
      group.rotation.z = 0.05 * Math.sin(t * 0.09);
      // gentle size pulse: mood-driven plus a touch of bass
      const s = 1 + cur.sizePulse * Math.sin(t * Math.PI * 2 * 1.1) + 0.06 * levels.bass * cur.bright;
      group.scale.setScalar(s);
    },
    dispose() {
      geometry.dispose();
      wire.material.dispose();
      fill.material.dispose();
      shell.geometry.dispose();
      shell.material.dispose();
      atmoTex.dispose();
      atmo.material.dispose();
    },
  };
}
