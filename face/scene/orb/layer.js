// The orb layer: a transparent renderer that composites over the background
// canvas. Everything attached to the orb lives here — the orb itself, its
// halo, later the rings, the sub-agents and the beams. Nothing writes depth;
// order is explicit via renderOrder, so the glow layers never fight.

import * as THREE from "three";
import { createOrb } from "./orb.js";
import { cameraZFor } from "./orbit.js";

export function createOrbLayer({ root, mobile = false, perf = false, preserve = false }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: preserve });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = true;
  renderer.domElement.classList.add("orb-canvas");
  root.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.set(0, 0, 40);
  camera.lookAt(0, 0, 0);

  const orb = createOrb({ detail: mobile || perf ? 4 : 5 });
  scene.add(orb.group);

  let perfMode = perf;
  let width = 1, height = 1;
  let ready = false;
  const extras = []; // rings, agents, fx — added by later tiers

  function applyPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(perfMode ? Math.min(dpr, 1.25) : Math.min(dpr, mobile ? 1.5 : 2));
  }
  function resize(w, h) {
    width = w; height = h;
    applyPixelRatio();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = cameraZFor(camera.aspect);
    camera.updateProjectionMatrix();
    for (const e of extras) e.resize?.(w, h, camera);
  }

  return {
    renderer,
    scene,
    camera,
    orb,
    get perf() {
      return perfMode;
    },
    setPerf(on) {
      perfMode = !!on;
      resize(width, height);
    },
    resize,
    /** Later tiers register {update(dt,t,cur,levels,ctx), resize?, dispose?} here. */
    addExtra(e) {
      extras.push(e);
      if (e.object) scene.add(e.object);
      e.resize?.(width, height, camera);
      return e;
    },
    update(dt, t, cur, levels, ctx) {
      orb.update(dt, t, cur, levels);
      for (const e of extras) e.update?.(dt, t, cur, levels, ctx);
      renderer.render(scene, camera);
      if (!ready) {
        ready = true;
        renderer.domElement.classList.add("ready");
      }
    },
    dispose() {
      for (const e of extras) e.dispose?.();
      orb.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };
}
