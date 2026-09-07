// Scene assembly and the frame loop.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

import { fetchSkeleton, observe } from "./data.js";
import { layoutAll, ANCHORS } from "./regions.js";
import { uTime, buildRegionInstances, buildCore, buildStarfield, buildDust, buildMembrane, radialTexture } from "./nodes.js";
import { buildEdges, PulsePool, arc } from "./edges.js";

const statsEl = document.getElementById("stats");

// ---------------------------------------------------------------- skeleton
let skeleton;
try {
  skeleton = await fetchSkeleton();
} catch (err) {
  // A silent black page is the worst outcome for a page whose whole job is
  // showing what's there. Say it, then halt.
  statsEl.textContent = `failed to load mind — is the server up? (${err.message})`;
  statsEl.classList.add("error");
  throw err;
}

const positions = layoutAll(skeleton);
const nodeById = new Map(skeleton.nodes.map((n) => [n.id, n]));

// ---------------------------------------------------------------- renderer
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
stage.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.position = "fixed";
labelRenderer.domElement.style.top = "0";
labelRenderer.domElement.style.pointerEvents = "none";
document.getElementById("labels").appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#05070B");
scene.fog = new THREE.FogExp2(0x05070b, 0.012);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 400);
// Intro: arrive from further out and glide home over the first seconds. The
// final position is unchanged, so every interaction afterwards starts from
// exactly the framing the old hard cut used to land on.
const HOME = new THREE.Vector3(0, 7, 26);
camera.position.copy(HOME).multiplyScalar(1.7).add(new THREE.Vector3(0, 4, 0));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.25;
controls.minDistance = 4;
controls.maxDistance = 60;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.15, 0.6, 0.72);
composer.addPass(bloom);

scene.add(buildStarfield());
scene.add(buildDust()); // near-field motes — depth cue between sky and nodes
const membrane = buildMembrane();
scene.add(membrane);

// ---------------------------------------------------------------- regions
const regionGroups = new Map();
const instancedMeshes = [];
for (const region of skeleton.regions) {
  const group = new THREE.Group();
  group.name = region.name;
  scene.add(group);
  regionGroups.set(region.name, group);

  if (region.name === "core") continue;
  const nodes = skeleton.nodes.filter((n) => n.region === region.name);
  const built = buildRegionInstances(nodes, positions);
  if (built) {
    group.add(built.mesh, built.aura);
    instancedMeshes.push(built.mesh);
  }
  // Region heading label — regions and the core only, never one per node.
  const anchor = ANCHORS[region.name] ?? [0, 0, 0];
  const div = document.createElement("div");
  div.className = "mind-label";
  div.textContent = region.name;
  const label = new CSS2DObject(div);
  label.position.set(anchor[0], anchor[1] + 3.6, anchor[2]);
  group.add(label);
}

const core = buildCore("#2DD4A8");
regionGroups.get("core")?.add(core.group);
{
  const div = document.createElement("div");
  div.className = "mind-label";
  div.textContent = "EVE";
  const label = new CSS2DObject(div);
  label.position.set(0, 3.2, 0);
  core.group.add(label);
}

// ---------------------------------------------------------------- edges
const { groups: edgeGroups, curves } = buildEdges(skeleton.edges, positions);
const edgeLayer = new THREE.Group();
for (const g of edgeGroups) edgeLayer.add(g);
scene.add(edgeLayer);

const pulses = new PulsePool(scene, 64);

// ---------------------------------------------------------------- stats
const s = skeleton.stats;
const broken = Object.entries(s).filter(([k, v]) => v === "error").map(([k]) => k);
statsEl.textContent =
  `${s.nodes} nodes · ${s.edges} edges · ${s.memory_shown ?? 0}/${s.memory_total ?? 0} memories · ` +
  `${s.similarity ?? "?"} similarity (top ${s.similarity_top_k} @ ${s.similarity_threshold})` +
  (broken.length ? ` · ⚠ ${broken.join(", ")} unavailable` : "");
if (broken.length) statsEl.classList.add("error");

// ---------------------------------------------------------------- legend
const legendEl = document.getElementById("legend");
for (const region of skeleton.regions) {
  const count = skeleton.nodes.filter((n) => n.region === region.name).length;
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.innerHTML = `<span class="swatch"></span><span class="nm"></span> <span class="n"></span>`;
  chip.querySelector(".swatch").style.background = region.color;
  chip.querySelector(".swatch").style.boxShadow = `0 0 8px ${region.color}`; // CSS currentColor can't see an inline background
  chip.querySelector(".nm").textContent = region.name;
  chip.querySelector(".n").textContent = count;
  chip.onclick = () => {
    const g = regionGroups.get(region.name);
    if (!g) return;
    g.visible = !g.visible;
    chip.classList.toggle("off", !g.visible);
  };
  legendEl.appendChild(chip);
}

// ---------------------------------------------------------------- live
function resolve(id) {
  return positions.get(id) ?? null;
}

function curveBetween(a, b) {
  return curves.get(`${a}|${b}`)?.curve ?? curves.get(`${b}|${a}`)?.curve ?? null;
}

const flares = new Map(); // nodeId → { until, mesh }

export const liveHandlers = {
  onRecall(memId) {
    const from = resolve(memId);
    const to = resolve("core:eve");
    if (!from || !to) return; // unknown id → drop silently, never fake it
    pulses.fire(from, to, curveBetween(memId, "core:eve"), "#A78BFA", { duration: 900 });
  },
  onWrite(memId) {
    const from = ANCHORS.working;
    const to = resolve(memId) ?? ANCHORS.memory;
    pulses.fire(from, to, null, "#67E8F9", { duration: 1000 });
  },
  onTool(toolName) {
    const from = resolve("core:eve");
    const to = resolve(`tool:${toolName}`);
    if (!from || !to) return;
    pulses.fire(from, to, curveBetween("core:eve", `tool:${toolName}`), "#8B93A1", { duration: 850 });
  },
  onTurn() {
    coreFlare = performance.now();
  },
  onAlert() {
    membraneFlare = performance.now();
  },
};
window.liveHandlers = liveHandlers; // drive every animation from the console

let coreFlare = 0;
let membraneFlare = 0;

observe((ev) => {
  if (ev.type === "recall") liveHandlers.onRecall(ev.id);
  else if (ev.type === "write") liveHandlers.onWrite(ev.id);
  else if (ev.type === "tool") liveHandlers.onTool(ev.name);
  else if (ev.type === "turn") liveHandlers.onTurn();
  else if (ev.type === "alert") liveHandlers.onAlert();
});

// Ambient synaptic firing along real similarity edges only.
const simKeys = [...curves.entries()].filter(([, v]) => v.kind === "similarity");
let nextSpark = performance.now() + 1200;

// ---------------------------------------------------------------- governor
const frameTimes = [];
let degraded = 0;
let lowSince = 0;

// ---------------------------------------------------------------- intro
// Radial ease only — it composes cleanly with autoRotate, the idle drift and
// the inspector's fly lerp, all of which also write camera.position. Any
// pointer grab cancels it so a user mid-intro is never fought.
const _introOff = new THREE.Vector3(); // scratch — the loop must not allocate
const introStartAt = performance.now();
const introFrom = camera.position.distanceTo(controls.target);
const introTo = HOME.length();
const INTRO_MS = 2800;
let introActive = true;
// Any real camera intent — grab or scroll — hands control straight back to
// the user, and the exposure snaps to its final grade so no half-developed
// frame is ever left stranded.
const cancelIntro = () => {
  if (!introActive) return;
  introActive = false;
  renderer.toneMappingExposure = 1.06;
};
export { cancelIntro };
renderer.domElement.addEventListener("pointerdown", cancelIntro);
renderer.domElement.addEventListener("wheel", cancelIntro, { passive: true });

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let prevDrift = 0;

function frame() {
  requestAnimationFrame(frame);
  if (document.hidden) return; // no work at all while hidden

  const t0 = performance.now();
  const t = clock.getElapsedTime();
  uTime.value = t; // one shared clock, written once per frame

  // idle vertical drift applied as a DELTA so it composes with OrbitControls
  if (controls.autoRotate) {
    const drift = Math.sin(t * 0.22) * 0.5;
    camera.position.y += drift - prevDrift;
    prevDrift = drift;
  } else {
    prevDrift = Math.sin(t * 0.22) * 0.5;
  }

  // Intro: shrink the orbit radius with a cubic ease-out while exposure
  // develops like a photograph. Both are dead by INTRO_MS and were skipped
  // entirely (introActive false) if the user grabbed the scene first.
  if (introActive) {
    const p = Math.min(1, (t0 - introStartAt) / INTRO_MS);
    const e = 1 - Math.pow(1 - p, 3);
    _introOff.copy(camera.position).sub(controls.target);
    camera.position.copy(controls.target).addScaledVector(_introOff.normalize(), introFrom + (introTo - introFrom) * e);
    renderer.toneMappingExposure = 1.06 * (0.25 + 0.75 * e);
    if (p >= 1) {
      introActive = false;
      renderer.toneMappingExposure = 1.06; // land exactly on the old grade
    }
  }

  core.nucleus.rotation.y = t * 0.12;
  core.coronaTight.material.rotation = t * 0.25;
  core.coronaWide.material.rotation = -t * 0.15;
  core.stable.rotation.y = t * 0.22; // Y, not Z — Z is the torus symmetry axis
  core.dynamic.rotation.y = -t * 0.16;
  core.dynamic.material.opacity = 0.22 + 0.1 * Math.sin(t * 0.9);

  // The wide fresnel shell breathes in counterphase with the tight one, so
  // the core's atmosphere swells instead of blinking.
  core.shellWide.material.uniforms.uOpacity.value = 0.32 + 0.1 * Math.sin(t * 0.6 + 1.5);

  if (coreFlare) {
    const e = Math.max(0, 1 - (t0 - coreFlare) / 1200);
    core.nucleus.scale.setScalar(1 + e * 0.35);
    core.dynamic.material.opacity = 0.22 + e * 0.7;
    if (e <= 0) coreFlare = 0;
  }
  if (membraneFlare) {
    const e = Math.max(0, 1 - (t0 - membraneFlare) / 2000);
    membrane.material.uniforms.uOpacity.value = 0.06 + Math.sin(e * Math.PI) * 0.16;
    if (e <= 0) {
      membraneFlare = 0;
      membrane.material.uniforms.uOpacity.value = 0.06;
    }
  } else {
    // Idle: the membrane breathes around its resting opacity so the edge of
    // the world reads as a living boundary, not a fixed glass shell.
    membrane.material.uniforms.uOpacity.value = 0.055 + 0.018 * Math.sin(t * 0.3);
  }

  if (degraded < 2 && simKeys.length && t0 > nextSpark) {
    const [key, val] = simKeys[Math.floor(Math.random() * simKeys.length)];
    const [a, b] = key.split("|");
    const forward = Math.random() > 0.5;
    pulses.fire(
      positions.get(forward ? a : b),
      positions.get(forward ? b : a),
      val.curve,
      "#C4B5FD",
      { duration: 1400, scale: 0.28, opacity: 0.4 },
    );
    nextSpark = t0 + 800 + Math.random() * 1200;
  }

  pulses.update(t0);
  controls.update();
  composer.render();
  labelRenderer.render(scene, camera);

  // FPS governor — degrade only on sustained slowness, never one GC pause.
  frameTimes.push(performance.now() - t0);
  if (frameTimes.length > 60) frameTimes.shift();
  if (frameTimes.length === 60) {
    const avg = frameTimes.reduce((x, y) => x + y, 0) / 60;
    if (avg > 33) {
      if (!lowSince) lowSince = t0;
      else if (t0 - lowSince > 3000 && degraded < 2) {
        degraded++;
        if (degraded === 1) {
          composer.removePass(bloom);
          console.info("[mind] fps low — bloom disabled");
        } else {
          for (const g of edgeGroups) {
            if (g.material.uniforms?.uShimmer) g.material.uniforms.uShimmer.value = 0;
            if (g.material.uniforms?.uFlow) g.material.uniforms.uFlow.value = 0;
          }
          console.info("[mind] fps still low — pulses and shimmer frozen");
        }
        lowSince = t0;
      }
    } else lowSince = 0;
  }
}
frame();

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

export const ctx = {
  scene, camera, controls, renderer, skeleton, positions, nodeById,
  regionGroups, instancedMeshes, edgeGroups, curves, core, pulses,
};

// Dynamic import at the bottom: inspector.js imports this module, and a static
// import back the other way would deadlock against the top-level await above.
import("./inspector.js");
