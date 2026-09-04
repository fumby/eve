// The background layer: its own renderer, so the orb can stay crisp while
// this — the most expensive part of the scene — quietly drops to half
// resolution and every other frame in performance mode. Nobody notices:
// the sky drifts too slowly for framerate to show.

import * as THREE from "three";
import { createSky } from "./sky.js";
import { createNetwork } from "./network.js";
import { ease } from "../ease.js";

export function createBackgroundLayer({ root, mobile = false, perf = false, preserve = false }) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: preserve });
  renderer.setClearColor(0x07080c, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.domElement.classList.add("bg-canvas");
  root.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);
  camera.position.set(0, 0, 40);

  const sky = createSky({ octaves: perf ? 3 : 4 });
  const network = createNetwork({ mobile });
  scene.add(sky.mesh, network.group);

  let perfMode = perf;
  let width = 1, height = 1;
  const glowColor = new THREE.Color("#2DD4A8");
  let glowStrength = 0.35;
  let ready = false;

  function applyPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    const cap = perfMode ? Math.min(dpr, 2) * 0.5 : Math.min(dpr, mobile ? 1.25 : 1.5);
    renderer.setPixelRatio(cap);
  }

  function resize(w, h) {
    width = w; height = h;
    applyPixelRatio();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    sky.uniforms.uAspect.value = w / h;
  }

  return {
    renderer,
    get perf() {
      return perfMode;
    },
    setPerf(on) {
      perfMode = !!on;
      sky.setOctaves(perfMode ? 3 : 4);
      resize(width, height);
    },
    resize,
    /** cur = eased mood values from state; render every other frame in perf mode. */
    update(dt, t, frame, cur, reducedMotion) {
      // colour + strength track the orb, eased so the sky settles with it
      glowColor.setRGB(cur.body[0], cur.body[1], cur.body[2]);
      glowStrength = ease(glowStrength, cur.bgGlow, 4, dt);
      sky.uniforms.uTime.value = t;
      sky.uniforms.uGlowColor.value.copy(glowColor);
      sky.uniforms.uGlowStrength.value = glowStrength;
      // very slow wandering camera; calmer under reduced motion
      const k = reducedMotion ? 0.25 : 1;
      camera.position.x = 1.6 * Math.sin(t * 0.07) * k;
      camera.position.y = 1.1 * Math.sin(t * 0.05 + 1.3) * k;
      camera.lookAt(0, 0, 0);
      sky.uniforms.uParallax.value.set(camera.position.x * 0.004, camera.position.y * 0.004);
      network.update(dt, t, reducedMotion);
      if (perfMode && frame % 2 === 1) return;
      renderer.render(scene, camera);
      if (!ready) {
        ready = true;
        renderer.domElement.classList.add("ready");
      }
    },
    dispose() {
      sky.dispose();
      network.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };
}
