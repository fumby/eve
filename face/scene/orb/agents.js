// The constellation: each real sub-agent is a small glowing avatar orbiting
// the orb on its own gently tilted path, breathing slowly, dimming as it
// swings behind. It reacts: a dispatch fires a beam from the orb, the avatar
// flares and a sonar ring expands at the peak; while working it carries a
// steady pulsing halo and may leave orbit to settle beside its panel (in
// fast, out slow); done or error sends it drifting back. Nothing snaps —
// every position, size and opacity eases with the shared rhythm.

import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { ease, RHYTHM } from "../ease.js";
import { hash01 } from "../rng.js";
import { mergeRoster } from "../agent-map.js";
import { assignOrbits, orbitPoint, safeBand, ORB_RADIUS, RING_OUTER, AVATAR_RADIUS, FOV_DEG } from "./orbit.js";
import { rectAnchor, screenToPlaneZ0, pushOutOfRadius, slotOffset } from "./dock-math.js";
import { resolveAvatar, sharedGlowTexture } from "./avatars.js";

const R = ORB_RADIUS;
const AVATAR_SIZE = AVATAR_RADIUS * 2;
const DOCK_MIN_R = RING_OUTER + 1.5;

export function createAgents({ camera, fx, labels, ctx }) {
  const object = new THREE.Group();
  const agents = new Map(); // id → runtime
  let order = []; // ids in roster order
  let band = null;
  let viewport = { width: 1, height: 1 };
  let hiddenForMobile = false;
  const resolution = new THREE.Vector2(1, 1);
  const glowTex = sharedGlowTexture();
  const _v = new THREE.Vector3();
  let rectClock = 0;

  // ---- construction ------------------------------------------------------
  function makeAgent(desc, index) {
    const tex = resolveAvatar(desc, (real) => {
      a.sprite.material.map = real;
      a.sprite.material.needsUpdate = true;
    });
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
    sprite.renderOrder = 6;
    sprite.scale.setScalar(AVATAR_SIZE);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(desc.color || "#2DD4A8"), transparent: true, opacity: 0.35, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }),
    );
    glow.renderOrder = 5;
    glow.scale.setScalar(AVATAR_SIZE * 2.4);
    object.add(glow, sprite);

    const a = {
      desc,
      index,
      sprite,
      glow,
      orbit: null,
      theta: 0,
      pos: [0, 0, 0],
      target: [0, 0, 0],
      alpha: 1, // eased far-side dimming
      breathePhase: hash01(desc.id) * Math.PI * 2,
      state: "idle", // idle | working | error
      flare: 0, // 0..1 envelope while a beam is out
      flareT: -1, // time into current flare, -1 = none
      flareDur: 2.4,
      glowScale: 1,
      glowOpacity: 0.35,
      dock: null, // { el, opts, rect, lastRect }
      docked: 0, // eased 0..1 — how far along "in dock" it is (for calm size)
      tether: null,
      errorT: 0,
      doneT: 0,
      label: desc.label || "",
    };
    labels.ensure(desc);
    return a;
  }

  function ensureTether(a) {
    if (a.tether) return a.tether;
    const geo = new LineGeometry();
    geo.setPositions(new Float32Array(2 * 3));
    const mat = new LineMaterial({ color: new THREE.Color(a.desc.color || "#2DD4A8").getHex(), linewidth: 1.5, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    mat.resolution = resolution;
    const line = new Line2(geo, mat);
    line.renderOrder = 4;
    line.visible = false;
    object.add(line);
    a.tether = { geo, mat, line };
    return a.tether;
  }

  // ---- orbits --------------------------------------------------------------
  // Only real obstacles count: the cards column when it holds cards, the side
  // panel when it is open. On a narrow window the panels would eat the whole
  // band, so if what's left is too thin we ignore them — better an agent
  // passing behind glass than six agents clumped at the orb's rim.
  function measureInsets() {
    const w = viewport.width;
    const cards = document.getElementById("cards");
    const panel = document.getElementById("panel");
    const hasCards = cards && cards.children.length > 0;
    const cr = hasCards ? cards.getBoundingClientRect() : null;
    const panelOpen = panel && !panel.classList.contains("collapsed");
    const pr = panelOpen ? panel.getBoundingClientRect() : null;
    return {
      left: cr && cr.width > 0 ? Math.max(0, cr.right) : 0,
      right: pr && pr.width > 0 ? Math.max(0, w - pr.left) : panel ? 40 : 0,
      top: 64,
      bottom: 120,
    };
  }
  function recomputeOrbits() {
    if (!viewport.width) return;
    const args = { camZ: camera.position.z, fovDeg: FOV_DEG, aspect: viewport.width / viewport.height, viewport, tilt: 0.6 };
    band = safeBand({ ...args, insetsPx: measureInsets() });
    if (band.rMax - band.rMin < 4) band = safeBand({ ...args, insetsPx: { top: 64, bottom: 120 } });
    const orbits = assignOrbits(order, band);
    for (const id of order) {
      const a = agents.get(id);
      const o = orbits[id];
      if (!a.orbit) {
        a.orbit = { ...o };
        a.theta = o.phase;
        orbitPoint(a.orbit, a.theta, a.pos);
        a.target[0] = a.pos[0]; a.target[1] = a.pos[1]; a.target[2] = a.pos[2];
      } else {
        // keep motion continuous: only the radius/tilt targets move, eased in update
        a.orbitTarget = o;
      }
    }
  }

  // ---- roster --------------------------------------------------------------
  function setRoster(list) {
    const merged = mergeRoster(list);
    const keep = new Set(merged.map((d) => d.id));
    for (const id of [...agents.keys()]) if (!keep.has(id)) remove(id);
    order = [];
    merged.forEach((d, i) => {
      order.push(d.id);
      if (!agents.has(d.id)) agents.set(d.id, makeAgent(d, i));
      else Object.assign(agents.get(d.id).desc, d);
    });
    recomputeOrbits();
  }
  function add(desc) {
    if (!desc || !desc.id) return false;
    if (agents.has(desc.id)) return true;
    const merged = mergeRoster([...order.map((id) => agents.get(id).desc), desc]);
    setRoster(merged);
    return true;
  }
  function remove(id) {
    const a = agents.get(id);
    if (!a) return;
    object.remove(a.sprite, a.glow);
    a.sprite.material.map?.dispose?.();
    a.sprite.material.dispose();
    a.glow.material.dispose();
    if (a.tether) {
      object.remove(a.tether.line);
      a.tether.geo.dispose();
      a.tether.mat.dispose();
    }
    labels.remove(id);
    agents.delete(id);
    order = order.filter((x) => x !== id);
  }

  // ---- reactions -----------------------------------------------------------
  function dispatch(id, opts = {}) {
    const a = agents.get(id);
    if (!a) return false;
    a.label = opts.label || a.label;
    labels.setStatus(id, a.label);
    a.flareT = 0;
    a.flareDur = opts.duration || 2.4;
    const color = a.desc.color || "#2DD4A8";
    fx.ringPulse({ at: [0, 0, 0], from: R * 1.1, to: R * 1.8, duration: 0.6, opacity: 0.45, color }); // the "sending" beat
    fx.beam({
      target: () => a.pos,
      color,
      duration: a.flareDur,
      onPeak: () => fx.ringPulse({ follow: () => a.pos, from: AVATAR_SIZE * 0.6, to: AVATAR_SIZE * 3.2, duration: 0.9, opacity: 0.8, color }),
    });
    a.state = "working";
    return true;
  }
  function working(id, opts = {}) {
    const a = agents.get(id);
    if (!a) return false;
    if (opts.label) {
      a.label = opts.label;
      labels.setStatus(id, a.label);
    }
    a.state = "working";
    return true;
  }
  function done(id) {
    const a = agents.get(id);
    if (!a) return false;
    a.state = "idle";
    a.doneT = 0.6;
    undock(id);
    return true;
  }
  function error(id, opts = {}) {
    const a = agents.get(id);
    if (!a) return false;
    a.state = "idle";
    a.errorT = 1.2;
    if (opts.label) labels.setStatus(id, opts.label);
    undock(id);
    return true;
  }
  function dock(id, target, opts = {}) {
    const a = agents.get(id);
    if (!a) return false;
    const el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) return false;
    a.dock = { el, opts: { side: "right", gap: 28, slot: 0, tether: true, ...opts }, rect: el.getBoundingClientRect() };
    if (a.dock.opts.tether) ensureTether(a);
    return true;
  }
  function undock(id) {
    const a = agents.get(id);
    if (!a || !a.dock) return false;
    a.dock = null;
    return true;
  }

  // ---- per frame -------------------------------------------------------------
  function dockTarget(a, out) {
    const d = a.dock;
    if (!d) return null;
    if (viewport.width < 2 || viewport.height < 2) return null; // not laid out yet — stay in orbit
    if (!d.el.isConnected) {
      a.dock = null; // the card went away: drift home
      return null;
    }
    const pt = rectAnchor(d.rect, d.opts.side, d.opts.gap);
    const so = slotOffset(d.opts.slot || 0);
    const p = screenToPlaneZ0({ x: pt.x + so.x, y: pt.y + so.y }, viewport, camera.position.z, FOV_DEG, viewport.width / viewport.height);
    const q = pushOutOfRadius(p, DOCK_MIN_R);
    out[0] = q[0]; out[1] = q[1]; out[2] = 0.5; // a hair in front of the orb plane
    return out;
  }

  const _t = [0, 0, 0];
  const _labelRows = [];
  const orbScreen = { x: 0, y: 0, r: 0 };

  return {
    object,
    setRoster,
    add,
    remove,
    list: () => order.map((id) => ({ ...agents.get(id).desc })),
    dispatch,
    working,
    done,
    error,
    dock,
    undock,
    get(id) {
      return agents.get(id) || null;
    },
    /** world position of an agent (for beams from outside) */
    positionOf(id) {
      return agents.get(id)?.pos || null;
    },
    resize(w, h) {
      viewport = { width: w, height: h };
      resolution.set(w, h);
      hiddenForMobile = w < 640;
      recomputeOrbits();
    },
    update(dt, t, cur, levels, ctx2) {
      const reduced = !!(ctx2?.flags?.reducedMotion);
      object.visible = !hiddenForMobile;
      // refresh dock rects at ~4 Hz, not per frame
      rectClock -= dt;
      const refreshRects = rectClock <= 0;
      if (refreshRects) rectClock = 0.25;

      // orb centre on screen for label occlusion
      _v.set(0, 0, 0).project(camera);
      orbScreen.x = ((_v.x + 1) / 2) * viewport.width;
      orbScreen.y = ((1 - _v.y) / 2) * viewport.height;
      const halfH = camera.position.z * Math.tan((FOV_DEG * Math.PI) / 360);
      const pxPerUnit = viewport.height / 2 / halfH;
      orbScreen.r = R * 1.1 * pxPerUnit;

      _labelRows.length = 0;
      for (const id of order) {
        const a = agents.get(id);
        if (!a.orbit) continue;
        // orbit parameters ease toward any new assignment (resize/roster change)
        if (a.orbitTarget) {
          a.orbit.radius = ease(a.orbit.radius, a.orbitTarget.radius, RHYTHM.slow, dt);
          a.orbit.tilt = ease(a.orbit.tilt, a.orbitTarget.tilt, RHYTHM.slow, dt);
          if (Math.abs(a.orbit.radius - a.orbitTarget.radius) < 0.01) a.orbitTarget = null;
        }
        if (!reduced) a.theta += dt * a.orbit.speed;
        orbitPoint(a.orbit, a.theta, _t);

        // where it wants to be: its dock, or its orbit
        if (a.dock && refreshRects && a.dock.el.isConnected) a.dock.rect = a.dock.el.getBoundingClientRect();
        const dockPt = a.dock ? dockTarget(a, a.target) : null;
        const goal = dockPt || _t;
        const k = dockPt ? RHYTHM.dockIn : a.docked > 0.02 ? RHYTHM.dockOut : RHYTHM.fast * 3;
        a.pos[0] = ease(a.pos[0], goal[0], k, dt);
        a.pos[1] = ease(a.pos[1], goal[1], k, dt);
        a.pos[2] = ease(a.pos[2], goal[2], k, dt);
        a.docked = ease(a.docked, dockPt ? 1 : 0, dockPt ? RHYTHM.dockIn : RHYTHM.dockOut, dt);

        // envelopes
        if (a.flareT >= 0) {
          a.flareT += dt;
          const u = Math.min(1, a.flareT / a.flareDur);
          a.flare = Math.sin(Math.PI * u);
          if (u >= 1) a.flareT = -1;
        } else a.flare = ease(a.flare, 0, RHYTHM.fast, dt);
        if (a.doneT > 0) a.doneT -= dt;
        if (a.errorT > 0) a.errorT -= dt;

        const workingPulse = a.state === "working" ? 0.5 + 0.3 * Math.sin(2 * Math.PI * 0.9 * t + a.breathePhase) : 0;
        const breathe = 1 + 0.05 * Math.sin(t * 0.9 + a.breathePhase) * (1 - 0.85 * a.docked);
        const doneFlare = a.doneT > 0 ? Math.sin(Math.PI * (1 - a.doneT / 0.6)) * 0.4 : 0;
        const far = a.pos[2] < 0;
        a.alpha = ease(a.alpha, far ? 0.55 : 1, RHYTHM.mood, dt);

        // avatar
        const s = AVATAR_SIZE * breathe * (1 + 0.35 * a.flare + doneFlare) * (1 - 0.1 * a.docked);
        a.sprite.position.set(a.pos[0], a.pos[1], a.pos[2]);
        a.sprite.scale.setScalar(s);
        a.sprite.material.opacity = a.alpha;
        // glow: breathing + working halo + flare
        const glowTargetScale = 1 + 0.35 * (a.state === "working" ? 1 : 0) + 0.7 * a.flare;
        a.glowScale = ease(a.glowScale, glowTargetScale, RHYTHM.fast, dt);
        const glowTargetOp = 0.3 + 0.35 * workingPulse + 0.6 * a.flare + doneFlare;
        a.glowOpacity = ease(a.glowOpacity, glowTargetOp, RHYTHM.fast, dt);
        a.glow.position.copy(a.sprite.position);
        a.glow.scale.setScalar(AVATAR_SIZE * 2.4 * a.glowScale * breathe);
        a.glow.material.opacity = a.glowOpacity * a.alpha;
        if (a.errorT > 0) a.glow.material.color.set("#F05252");
        else a.glow.material.color.set(a.desc.color || "#2DD4A8");

        // tether
        if (a.tether) {
          const on = a.dock && a.dock.opts.tether;
          const targetOp = on ? 0.25 : 0;
          a.tether.mat.opacity = ease(a.tether.mat.opacity, targetOp, RHYTHM.fast, dt);
          a.tether.line.visible = a.tether.mat.opacity > 0.01;
          if (a.tether.line.visible) {
            const d = Math.hypot(a.pos[0], a.pos[1], a.pos[2]) || 1;
            const from = [(a.pos[0] / d) * R * 1.02, (a.pos[1] / d) * R * 1.02, (a.pos[2] / d) * R * 1.02];
            a.tether.geo.setPositions([from[0], from[1], from[2], a.pos[0], a.pos[1], a.pos[2]]);
          }
        }

        _labelRows.push({
          id: a.desc.id,
          name: a.desc.name,
          specialty: a.desc.specialty,
          color: a.desc.color,
          world: a.pos,
          radiusPx: (s / 2) * pxPerUnit * (camera.position.z / (camera.position.z - a.pos[2])),
          alpha: 1,
          working: a.state === "working",
        });
      }
      labels.update(_labelRows, camera, viewport, orbScreen, !hiddenForMobile);
    },
    dispose() {
      for (const id of [...agents.keys()]) remove(id);
      glowTex.dispose();
    },
  };
}
