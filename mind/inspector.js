// Interaction: hover, click-to-fly, the detail panel, search, deep links.
import * as THREE from "three";
import { ctx } from "./scene.js";
import { fetchNode } from "./data.js";

const { scene, camera, controls, renderer, skeleton, positions, nodeById, instancedMeshes, edgeGroups, curves } = ctx;

const tooltip = document.getElementById("tooltip");
const inspector = document.getElementById("inspector");
const inspectorBody = document.getElementById("inspectorBody");
const searchInput = document.getElementById("search");

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null;
let overlay = null;
let flyTarget = null;
let fetchToken = 0;

// A legend-hidden region must not stay clickable, so visibility is checked all
// the way up the parent chain rather than on the object alone.
function visibleUpChain(obj) {
  let o = obj;
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

function pick(event) {
  pointer.x = (event.clientX / innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const targets = instancedMeshes.filter(visibleUpChain);
  const hits = raycaster.intersectObjects(targets, false);
  for (const h of hits) {
    const ids = h.object.userData.ids;
    if (ids && h.instanceId !== undefined && ids[h.instanceId]) return ids[h.instanceId];
  }
  // the core is a plain mesh group, not instanced
  const coreHit = raycaster.intersectObject(ctx.core.shell, false);
  if (coreHit.length) return "core:eve";
  return null;
}

function showTooltip(id, x, y) {
  const n = nodeById.get(id);
  if (!n) return;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(x + 14, innerWidth - 280)}px`;
  tooltip.style.top = `${y + 14}px`;
  tooltip.replaceChildren();
  const r = document.createElement("div");
  r.className = "r";
  r.textContent = n.region;
  const l = document.createElement("div");
  l.textContent = n.label; // textContent: memory bodies are raw user text
  tooltip.append(r, l);
  const detail = n.extra?.category ?? n.extra?.due ?? n.extra?.role ?? (n.extra?.turns ? `${n.extra.turns} turns` : null);
  if (detail) {
    const d = document.createElement("div");
    d.className = "d";
    d.textContent = String(detail);
    tooltip.append(d);
  }
}

// Merged-per-kind geometry can't brighten one node's edges in place, so dim
// every base line and draw that node's edges as a temporary overlay.
function highlightEdges(id) {
  clearHighlight();
  const pts = [];
  for (const [key, val] of curves) {
    const [a, b] = key.split("|");
    if (a !== id && b !== id) continue;
    const sampled = val.curve.getPoints(24);
    for (let i = 0; i < sampled.length - 1; i++) {
      pts.push(sampled[i], sampled[i + 1]);
    }
  }
  if (!pts.length) return;
  for (const g of edgeGroups) g.material.opacity = 0.04;
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  overlay = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  scene.add(overlay); // parented at the root so region toggles don't hide it
}

function clearHighlight() {
  if (overlay) {
    scene.remove(overlay);
    overlay.geometry.dispose();
    overlay.material.dispose();
    overlay = null;
  }
  for (const g of edgeGroups) g.material.opacity = g.userData.baseOpacity;
}

// ---------------------------------------------------------------- pointer
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  flyTarget = null; // grabbing the camera cancels any in-flight glide
});

renderer.domElement.addEventListener("pointermove", (e) => {
  const id = pick(e);
  if (id !== hovered) {
    hovered = id;
    if (id) {
      highlightEdges(id);
    } else {
      clearHighlight();
      tooltip.hidden = true;
    }
  }
  if (id) showTooltip(id, e.clientX, e.clientY);
});

renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt) return;
  const travel = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (travel > 6) return; // that was a drag, not a click
  const id = pick(e);
  if (id) focusNode(id);
});

renderer.domElement.addEventListener("dblclick", () => {
  flyTarget = { pos: new THREE.Vector3(0, 7, 26), target: new THREE.Vector3(0, 0, 0) };
  controls.autoRotate = true;
  inspector.hidden = true;
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    inspector.hidden = true;
    clearHighlight();
  }
});

// ---------------------------------------------------------------- focus
export function focusNode(id) {
  const p = positions.get(id);
  if (!p) return;
  const target = new THREE.Vector3(...p);
  const dir = camera.position.clone().sub(controls.target).normalize();
  flyTarget = { pos: target.clone().add(dir.multiplyScalar(5.5)), target };
  controls.autoRotate = false;
  history.replaceState(null, "", `#node=${encodeURIComponent(id)}`);
  void openInspector(id);
}

async function openInspector(id) {
  const token = ++fetchToken;
  inspector.hidden = false;
  inspectorBody.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "body";
  loading.textContent = "loading…";
  inspectorBody.append(loading);

  let detail;
  try {
    detail = await fetchNode(id);
  } catch {
    if (token !== fetchToken) return;
    loading.textContent = "couldn't load this node.";
    return;
  }
  if (token !== fetchToken) return; // a later click won the race

  inspectorBody.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = detail.title;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = detail.type;
  inspectorBody.append(h, badge);

  for (const f of detail.fields ?? []) {
    const row = document.createElement("div");
    row.className = "field";
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = f.label;
    const v = document.createElement("span");
    v.textContent = f.value;
    row.append(k, v);
    inspectorBody.append(row);
  }

  const body = document.createElement("div");
  body.className = "body";
  body.textContent = detail.body; // never innerHTML — this is raw user text
  inspectorBody.append(body);

  if (detail.neighbors?.length) {
    const h3 = document.createElement("h3");
    h3.textContent = "closest memories";
    inspectorBody.append(h3);
    for (const n of detail.neighbors) {
      const btn = document.createElement("button");
      btn.className = "neighbor";
      const sim = document.createElement("span");
      sim.className = "sim";
      sim.textContent = n.sim.toFixed(2);
      const label = document.createElement("span");
      label.textContent = n.label;
      btn.append(sim, label);
      btn.onclick = () => focusNode(n.id); // wander onward
      inspectorBody.append(btn);
    }
  }
}

document.getElementById("closeInspector").onclick = () => {
  inspector.hidden = true;
};

// ---------------------------------------------------------------- search
searchInput.addEventListener("keydown", (e) => {
  e.stopPropagation(); // typing must never drive the scene
  if (e.key !== "Enter") return;
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return;
  const ranked = skeleton.nodes
    .map((n) => {
      const hay = `${n.label} ${n.id}`.toLowerCase();
      const i = hay.indexOf(q);
      if (i < 0) return null;
      return { n, score: (i === 0 ? 0 : 100) + n.label.length };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);
  if (ranked[0]) focusNode(ranked[0].n.id);
});

// ---------------------------------------------------------------- fly loop
(function fly() {
  requestAnimationFrame(fly);
  if (!flyTarget) return;
  camera.position.lerp(flyTarget.pos, 0.08);
  controls.target.lerp(flyTarget.target, 0.08);
  if (camera.position.distanceTo(flyTarget.pos) < 0.05) flyTarget = null;
})();

// ---------------------------------------------------------------- deep link
const m = location.hash.match(/#node=(.+)/);
if (m) {
  const id = decodeURIComponent(m[1]);
  if (positions.has(id)) focusNode(id);
}
