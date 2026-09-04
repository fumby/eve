// Transient effects, all pooled so nothing allocates mid-scene:
//   - ring pulses: an expanding, fading ring sprite (sonar ping at an agent on
//     dispatch; the "sending" beat at the orb; slow pulse waves while thinking)
//   - beams: a luminous line from the orb out to an agent that races out and
//     back (tier 6)
//   - arcs: short energy arcs from the orb toward a tool as it runs (tier 6)
// Every effect is driven by the shared clock and eases; nothing pops.

import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { ORB_RADIUS } from "./orbit.js";
import { hash01 } from "../rng.js";

const R = ORB_RADIUS;

function ringTexture(size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.75, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const smooth = (x) => x * x * (3 - 2 * x);

export function createFx({ camera }) {
  const object = new THREE.Group();
  const tex = ringTexture();

  // ---- ring pulses -------------------------------------------------------
  const RINGS = 12;
  const rings = [];
  for (let i = 0; i < RINGS; i++) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }),
    );
    s.visible = false;
    s.renderOrder = 7;
    object.add(s);
    rings.push({ sprite: s, t: 0, dur: 1, from: 1, to: 2, op: 0.5, at: null, follow: null });
  }
  function ringPulse({ at = [0, 0, 0], follow = null, from = R * 1.1, to = R * 1.8, duration = 0.6, opacity = 0.5, color = "#2DD4A8" }) {
    const slot = rings.find((r) => !r.sprite.visible) || rings[0];
    slot.t = 0;
    slot.dur = duration;
    slot.from = from;
    slot.to = to;
    slot.op = opacity;
    slot.at = at;
    slot.follow = follow;
    slot.sprite.material.color.set(color);
    slot.sprite.visible = true;
    slot.sprite.scale.setScalar(from);
    slot.sprite.material.opacity = opacity;
    if (!follow) slot.sprite.position.set(at[0], at[1], at[2]);
  }

  // ---- beams (tier 6) ----------------------------------------------------
  const BEAMS = 6;
  const beams = [];
  const resolution = new THREE.Vector2(1, 1);
  for (let i = 0; i < BEAMS; i++) {
    const geo = new LineGeometry();
    geo.setPositions(new Float32Array(25 * 3));
    const raceGeo = new LineGeometry();
    raceGeo.setPositions(new Float32Array(25 * 3));
    const bodyMat = new LineMaterial({ color: 0xffffff, linewidth: 1.5, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    const raceMat = new LineMaterial({ color: 0xffffff, linewidth: 3.5, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    bodyMat.resolution = resolution;
    raceMat.resolution = resolution;
    const body = new Line2(geo, bodyMat);
    const race = new Line2(raceGeo, raceMat);
    body.visible = race.visible = false;
    body.renderOrder = race.renderOrder = 4;
    object.add(body, race);
    beams.push({ geo, raceGeo, body, race, bodyMat, raceMat, curve: new Float32Array(25 * 3), t: 0, dur: 2.4, target: null, color: "#ffffff", active: false, len: 1, onPeak: null, peaked: false });
  }
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _p = new THREE.Vector3();
  const _scratch = new Float32Array(25 * 3);
  const _sub = new Float32Array(25 * 3);
  function writeCurve(geo, from, to, arr = _scratch) {
    // quadratic bezier bowed 8% off the chord, like the mind map's arcs
    _a.set(from[0], from[1], from[2]);
    _b.set(to[0], to[1], to[2]);
    _c.copy(_a).add(_b).multiplyScalar(0.5);
    const off = _b.clone().sub(_a).length() * 0.08;
    _c.y += off;
    let len = 0;
    let prevX = 0, prevY = 0, prevZ = 0;
    for (let i = 0; i < 25; i++) {
      const u = i / 24;
      const w0 = (1 - u) * (1 - u), w1 = 2 * (1 - u) * u, w2 = u * u;
      _p.set(
        w0 * _a.x + w1 * _c.x + w2 * _b.x,
        w0 * _a.y + w1 * _c.y + w2 * _b.y,
        w0 * _a.z + w1 * _c.z + w2 * _b.z,
      );
      arr[i * 3] = _p.x; arr[i * 3 + 1] = _p.y; arr[i * 3 + 2] = _p.z;
      if (i > 0) len += Math.hypot(_p.x - prevX, _p.y - prevY, _p.z - prevZ);
      prevX = _p.x; prevY = _p.y; prevZ = _p.z;
    }
    if (geo) geo.setPositions(arr);
    return len;
  }
  // The visible slice of a curve between u0..u1 (0..1), resampled to 25 points.
  function writeSubCurve(geo, curve, u0, u1) {
    for (let i = 0; i < 25; i++) {
      const u = u0 + (u1 - u0) * (i / 24);
      const f = Math.min(23.999, Math.max(0, u * 24));
      const k = Math.floor(f), w = f - k;
      for (let c = 0; c < 3; c++) _sub[i * 3 + c] = curve[k * 3 + c] * (1 - w) + curve[(k + 1) * 3 + c] * w;
    }
    geo.setPositions(_sub);
  }
  /**
   * Fire a beam from the orb's surface to a moving target. target() returns
   * [x,y,z] each frame. onPeak fires at the middle of the race.
   */
  function beam({ target, color = "#2DD4A8", duration = 2.4, onPeak = null }) {
    const b = beams.find((x) => !x.active) || beams[0];
    b.active = true;
    b.t = 0;
    b.dur = duration;
    b.target = target;
    b.color = color;
    b.onPeak = onPeak;
    b.peaked = false;
    b.bodyMat.color.set(color);
    b.raceMat.color.set(color);
    b.body.visible = b.race.visible = true;
  }

  // ---- arcs (tier 6): a short flick from the orb toward a tool ------------
  const ARCS = 8;
  const arcs = [];
  for (let i = 0; i < ARCS; i++) {
    const geo = new LineGeometry();
    geo.setPositions(new Float32Array(25 * 3));
    const mat = new LineMaterial({ color: 0xffffff, linewidth: 1.5, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    mat.resolution = resolution;
    const line = new Line2(geo, mat);
    line.visible = false;
    line.renderOrder = 4;
    object.add(line);
    arcs.push({ geo, line, mat, t: 0, dur: 0.7, active: false });
  }
  function arc(name = "tool", color = "#67E8F9") {
    const a = arcs.find((x) => !x.active) || arcs[0];
    const h = hash01(String(name));
    const ang = h * Math.PI * 2;
    const el = (hash01(name + "!") - 0.5) * 1.2;
    const dir = [Math.cos(ang) * Math.cos(el), Math.sin(el), Math.sin(ang) * Math.cos(el)];
    const from = dir.map((v) => v * R * 1.02);
    const to = dir.map((v) => v * R * 1.9);
    writeCurve(a.geo, from, to);
    a.mat.color.set(color);
    a.active = true;
    a.t = 0;
    a.line.visible = true;
  }

  return {
    object,
    ringPulse,
    beam,
    arc,
    resize(w, h) {
      resolution.set(w, h);
    },
    update(dt, t) {
      // ring pulses
      for (const r of rings) {
        if (!r.sprite.visible) continue;
        r.t += dt;
        const u = Math.min(1, r.t / r.dur);
        const e = 1 - (1 - u) * (1 - u); // ease-out growth
        r.sprite.scale.setScalar(r.from + (r.to - r.from) * e);
        r.sprite.material.opacity = r.op * (1 - u) * (1 - u);
        if (r.follow) {
          const p = r.follow();
          if (p) r.sprite.position.set(p[0], p[1], p[2]);
        }
        if (u >= 1) r.sprite.visible = false;
      }
      // beams
      for (const b of beams) {
        if (!b.active) continue;
        b.t += dt;
        const u = Math.min(1, b.t / b.dur);
        const tp = b.target ? b.target() : null;
        if (!tp) {
          b.active = false;
          b.body.visible = b.race.visible = false;
          continue;
        }
        // from the orb's surface toward the (moving) target, refreshed each frame
        const d = Math.hypot(tp[0], tp[1], tp[2]) || 1;
        const from = [(tp[0] / d) * R * 1.02, (tp[1] / d) * R * 1.02, (tp[2] / d) * R * 1.02];
        b.len = writeCurve(b.geo, from, tp, b.curve);
        // race: a bright head that runs out over the first ~40%, holds, and runs back
        let head;
        if (u < 0.42) head = smooth(u / 0.42);
        else if (u < 0.58) head = 1;
        else head = 1 - smooth((u - 0.58) / 0.42);
        const tail = 0.35;
        writeSubCurve(b.raceGeo, b.curve, Math.max(0, head - tail), Math.max(0.02, head));
        const env = Math.sin(Math.PI * u);
        b.raceMat.opacity = 0.45 + 0.55 * env;
        b.bodyMat.opacity = 0.08 + 0.22 * env;
        if (!b.peaked && u >= 0.5) {
          b.peaked = true;
          b.onPeak?.();
        }
        if (u >= 1) {
          b.active = false;
          b.body.visible = b.race.visible = false;
        }
      }
      // arcs
      for (const a of arcs) {
        if (!a.active) continue;
        a.t += dt;
        const u = Math.min(1, a.t / a.dur);
        a.mat.opacity = Math.sin(Math.PI * u) * 0.8;
        if (u >= 1) {
          a.active = false;
          a.line.visible = false;
        }
      }
    },
    dispose() {
      tex.dispose();
      for (const r of rings) r.sprite.material.dispose();
      for (const b of beams) {
        b.geo.dispose();
        b.raceGeo.dispose();
        b.bodyMat.dispose();
        b.raceMat.dispose();
      }
      for (const a of arcs) {
        a.geo.dispose();
        a.mat.dispose();
      }
    },
  };
}
