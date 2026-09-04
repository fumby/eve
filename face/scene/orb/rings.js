// The "helix": three thin glowing rings orbiting just outside the orb while
// she is thinking — each tilted differently, precessing at its own speed,
// with bright pulses travelling around it and a colour drifting from teal
// toward purple. They emerge (scale + fade) as processing eases in and
// dissolve as it eases out; they are the focal point of that state.

import * as THREE from "three";
import { RING_VERT, RING_FRAG } from "./shaders.js";
import { ORB_RADIUS } from "./orbit.js";
import { ease } from "../ease.js";

const R = ORB_RADIUS;
const SPECS = [
  { r: 1.45, tilt: [1.15, 0.3], speed: 0.25, pulse: 0.22, phase: 0.0 },
  { r: 1.6, tilt: [-0.85, -0.5], speed: -0.18, pulse: 0.17, phase: 0.33 },
  { r: 1.75, tilt: [0.35, 1.1], speed: 0.32, pulse: 0.27, phase: 0.66 },
];

export function createRings() {
  const object = new THREE.Group();
  const rings = SPECS.map((spec, i) => {
    const holder = new THREE.Group();
    holder.rotation.x = spec.tilt[0];
    holder.rotation.z = spec.tilt[1];
    const uniforms = {
      uTime: { value: 0 },
      uSpeed: { value: spec.pulse },
      uPhase: { value: spec.phase },
      uColorA: { value: new THREE.Color("#2DD4A8") },
      uColorB: { value: new THREE.Color("#7C6BF0") },
      uDrift: { value: 0 },
      uOpacity: { value: 0 },
    };
    const mesh = new THREE.Mesh(
      new THREE.TorusGeometry(R * spec.r, 0.035, 6, 200),
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        premultipliedAlpha: true,
      }),
    );
    mesh.rotation.x = Math.PI / 2; // torus lies in the holder's XZ plane
    mesh.renderOrder = 3;
    holder.add(mesh);
    holder.visible = false;
    object.add(holder);
    return { holder, mesh, uniforms, spec, i };
  });

  let vis = 0;

  return {
    object,
    update(dt, t, cur, levels, ctx) {
      vis = ease(vis, cur.rings, 3.5, dt);
      const reduced = ctx?.flags?.reducedMotion;
      for (const rg of rings) {
        rg.holder.visible = vis > 0.01;
        if (!rg.holder.visible) continue;
        rg.holder.rotation.y += dt * rg.spec.speed * (reduced ? 0.3 : 1);
        rg.uniforms.uTime.value = t;
        rg.uniforms.uOpacity.value = vis * (0.55 + 0.35 * cur.bright);
        rg.uniforms.uDrift.value = 0.5 + 0.5 * Math.sin(t * 0.35 + rg.i * 2.1);
        // pulses quicken a little with the voice, so thinking-while-speaking feels alive
        rg.uniforms.uSpeed.value = rg.spec.pulse * (1 + 0.6 * levels.loud);
        const s = 0.9 + 0.1 * vis;
        rg.holder.scale.setScalar(s);
      }
    },
    get visibility() {
      return vis;
    },
    dispose() {
      for (const rg of rings) {
        rg.mesh.geometry.dispose();
        rg.mesh.material.dispose();
      }
    },
  };
}
