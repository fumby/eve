// Interaction: hover, click-to-fly, the detail panel, search, deep links.
import * as THREE from "three";
import { ctx, cancelIntro } from "./scene.js";
import { fetchNode } from "./data.js";
import { ANCHORS } from "./regions.js";

const { scene, camera, controls, renderer, skeleton, positions, nodeById, instancedMeshes, edgeGroups, curves } = ctx;

const tooltip = document.getElementById("tooltip");
const inspector = document.getElementById("inspector");
const inspectorBody = document.getElementById("inspectorBody");
const searchInput = document.getElementById("search");
const searchMeta = document.getElementById("searchMeta");
const searchWrap = document.querySelector(".searchwrap");
const crumb = document.getElementById("crumb");
const help = document.getElementById("help");
const helpBtn = document.getElementById("helpBtn");
const resetBtn = document.getElementById("resetBtn");

// The header wraps to two rows on small screens, so everything anchored below
// it follows its measured height instead of the 54px desktop assumption. Measured
// once at init and on resize — never per frame.
const hdr = document.getElementById("hdr");
function syncHeaderHeight() {
  document.documentElement.style.setProperty("--hdr-h", `${hdr.offsetHeight}px`);
}
syncHeaderHeight();
addEventListener("resize", syncHeaderHeight);
if (document.fonts) document.fonts.ready.then(syncHeaderHeight).catch(() => {});

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

renderer.domElement.addEventListener("dblclick", resetView);

// One shared home gesture — the header button, the R key and dbl-click all
// land in exactly the same place, so none of the three can drift apart.
function resetView() {
  cancelIntro(); // a reset mid-intro would fight the intro's radial write
  flyTarget = { pos: new THREE.Vector3(0, 7, 26), target: new THREE.Vector3(0, 0, 0) };
  controls.autoRotate = true;
  closeInspector();
  // Going home means leaving the node: drop the deep link too, so a reload
  // after a reset starts from home instead of snapping back to the old node.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}

resetBtn.onclick = resetView;

// ---------------------------------------------------------------- help card
function setHelpOpen(open) {
  help.hidden = !open;
  helpBtn.classList.toggle("active", open);
  helpBtn.setAttribute("aria-expanded", String(open));
}
helpBtn.onclick = () => setHelpOpen(help.hidden);
// Clicking anywhere else folds the card away — it's a popover, not a panel.
document.addEventListener("pointerdown", (e) => {
  if (help.hidden) return;
  if (help.contains(e.target) || helpBtn.contains(e.target)) return;
  setHelpOpen(false);
});

addEventListener("keydown", (e) => {
  // Modifier-held keys are browser shortcuts (Cmd+R reload) — never ours.
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (e.key === "Escape") {
    setHelpOpen(false);
    closeInspector();
    clearHighlight();
  } else if (plain && (e.key === "r" || e.key === "R")) {
    resetView();
  } else if (plain && e.key === "?") {
    setHelpOpen(help.hidden);
  }
  // Typing never reaches here: the search field stops propagation on keydown,
  // so R and ? can't fire while the user is mid-query.
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
  pushCrumb(id);
  document.body.classList.add("inspecting");
  void openInspector(id);
}

// Every path that hides the inspector (Esc, ×, reset) funnels through here so
// the crumb position and the body class can never disagree with the panel.
// The hash is untouched: hiding the panel is not leaving the node — the camera
// is still focused, and the deep link should keep pointing at it.
function closeInspector() {
  inspector.hidden = true;
  document.body.classList.remove("inspecting");
}

// ---------------------------------------------------------------- crumb
// A short trail of where focus has been. Region first (with a jump back to its
// anchor), node second, then the label of the node actually focused — each
// link is a deep link, so the trail doubles as a path to re-walk.
let crumbNodes = []; // [id, ...] — most recent first, capped
const CRUMB_MAX = 4;

function pushCrumb(id) {
  crumbNodes = [id, ...crumbNodes.filter((x) => x !== id)].slice(0, CRUMB_MAX);
  renderCrumb(id);
}

function regionOf(id) {
  return nodeById.get(id)?.region ?? null;
}

function labelOf(id) {
  return nodeById.get(id)?.label ?? id;
}

function renderCrumb(currentId) {
  crumb.replaceChildren();
  const region = regionOf(currentId);
  if (region) {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = region;
    a.title = `jump to the ${region} region`;
    a.onclick = (e) => {
      e.preventDefault();
      const anchor = ANCHORS[region] ?? [0, 0, 0];
      flyTarget = { pos: new THREE.Vector3(anchor[0], anchor[1] + 6, anchor[2] + 11), target: new THREE.Vector3(...anchor) };
      controls.autoRotate = false;
    };
    crumb.append(a);
  }
  // crumbNodes is newest-first internally; displayed reversed so the trail
  // reads chronologically left to right and ends on the current node.
  const trail = [...crumbNodes].reverse();
  for (const id of trail) {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "›";
    crumb.append(sep);
    const a = document.createElement("a");
    a.href = `#node=${encodeURIComponent(id)}`;
    a.textContent = labelOf(id);
    a.title = labelOf(id);
    if (id === currentId) a.className = "now";
    a.onclick = (e) => {
      // The trail and the URL update together — both go through focusNode —
      // so they can never diverge.
      if (positions.has(id)) {
        e.preventDefault();
        focusNode(id);
      }
    };
    crumb.append(a);
  }
  const x = document.createElement("button");
  x.className = "x";
  x.type = "button";
  x.textContent = "×";
  x.title = "Clear the trail";
  x.setAttribute("aria-label", "Clear the focus trail");
  x.onclick = () => {
    crumbNodes = [];
    crumb.hidden = true;
  };
  crumb.append(x);
  crumb.hidden = false;
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
  closeInspector();
};

// ---------------------------------------------------------------- search
// Live result count while typing, Enter jumps to the first match, and each
// further Enter cycles to the next. The ranked order is the same as before —
// prefix matches win, then the shortest label — so muscle memory holds.
let searchResults = [];
let searchIndex = -1;
let lastQuery = "";
let searchStepped = false; // false until the first Enter — typing always re-arms the top match

function runSearch(q) {
  return skeleton.nodes
    .map((n) => {
      const hay = `${n.label} ${n.id}`.toLowerCase();
      const i = hay.indexOf(q);
      if (i < 0) return null;
      return { n, score: (i === 0 ? 0 : 100) + n.label.length };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);
}

function updateSearchMeta() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    searchMeta.hidden = true;
    searchMeta.classList.remove("none");
    searchWrap.classList.remove("has-meta");
    searchResults = [];
    searchIndex = -1;
    lastQuery = "";
    return;
  }
  // Only re-rank when the query changed — arrow keys and focus moves must not
  // shift the match set out from under the user. A new query also re-arms the
  // pager so its first Enter lands on the top match, not the second.
  if (q !== lastQuery) {
    searchResults = runSearch(q);
    searchIndex = searchResults.length ? 0 : -1;
    lastQuery = q;
    searchStepped = false;
  }
  searchMeta.hidden = false;
  searchWrap.classList.add("has-meta");
  if (!searchResults.length) {
    searchMeta.classList.add("none");
    searchMeta.textContent = "no match";
    return;
  }
  searchMeta.classList.remove("none");
  if (searchResults.length === 1) {
    searchMeta.textContent = "1 match";
    return;
  }
  // current/total — the count doubles as the affordance for Enter cycling.
  searchMeta.replaceChildren();
  const b = document.createElement("b");
  b.textContent = `${searchIndex + 1}/${searchResults.length}`;
  searchMeta.append(b);
}

searchInput.addEventListener("input", updateSearchMeta);
searchInput.addEventListener("focus", updateSearchMeta);
searchInput.addEventListener("keydown", (e) => {
  e.stopPropagation(); // typing must never drive the scene
  if (e.key !== "Enter") return;
  e.preventDefault();
  updateSearchMeta(); // re-rank first if the user typed then Enter'd without an input event (e.g. paste + Enter)
  if (!searchResults.length) return;
  // First Enter lands on the top match; every later Enter advances and wraps.
  // Same first-hit behaviour as the old code, now with a visible pager.
  if (searchStepped) searchIndex = (searchIndex + 1) % searchResults.length;
  searchStepped = true;
  focusNode(searchResults[searchIndex].n.id);
  updateSearchMeta();
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
