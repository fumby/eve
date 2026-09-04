// Where the sub-agents may fly. The camera looks down -Z from z=camZ with a
// vertical fov; the orb sits at the origin. An orbit is a tilted circle
// around it. The "safe band" is the ring of radii that keeps every agent
// clearly outside the orb's rings and glow, inside the screen, and clear of
// the fixed side panels — accounting for perspective, which makes the near
// half of a tilted orbit look bigger than it is. Pure module.

import { clamp } from "../ease.js";
import { hash01 } from "../rng.js";

export const ORB_RADIUS = 5.5;
export const RING_OUTER = ORB_RADIUS * 1.75; // outermost processing ring
export const AVATAR_RADIUS = 1.2; // world units, half the sprite size
export const BASE_CAM_Z = 40;
export const FOV_DEG = 60;

/** Camera distance: 40 in landscape, pulled back in portrait so the orb keeps room. */
export function cameraZFor(aspect) {
  const a = Math.max(0.2, aspect || 1);
  return BASE_CAM_Z * clamp(1 / a, 1, 1.8);
}

/** Half-extents of the z=0 plane visible from the camera, in world units. */
export function viewExtents(camZ, fovDeg = FOV_DEG, aspect = 1) {
  const halfH = camZ * Math.tan((fovDeg * Math.PI) / 360);
  return { halfW: halfH * aspect, halfH };
}

/**
 * The band [rMin, rMax] of orbit radii.
 * insetsPx: {left, right, top, bottom} — screen pixels the UI covers from each edge.
 * viewport: {width, height} in px. tilt: the largest |tilt| any orbit will use.
 */
export function safeBand({ camZ, fovDeg = FOV_DEG, aspect, viewport, insetsPx, tilt = 0.6 }) {
  const { halfW, halfH } = viewExtents(camZ, fovDeg, aspect);
  const wpp = (2 * halfH) / Math.max(1, viewport.height); // world units per pixel at z=0
  const ins = { left: 0, right: 0, top: 0, bottom: 0, ...(insetsPx || {}) };
  const usableX = Math.max(0, Math.min(halfW - ins.left * wpp, halfW - ins.right * wpp) - AVATAR_RADIUS);
  const usableY = Math.max(0, Math.min(halfH - ins.top * wpp, halfH - ins.bottom * wpp) - AVATAR_RADIUS);
  const rMin = RING_OUTER + AVATAR_RADIUS + 0.6;
  // An orbit is a circle in XZ tilted about X: it spans ±r horizontally but only
  // ±r·sin(tilt) vertically (yaw about Y leaves y untouched). Perspective: a point
  // comes toward the camera by up to r·sin(tilt), projecting larger by
  // camZ/(camZ - r·s). Require both projected extents to fit:
  //   r·P ≤ usableX  and  r·s·P ≤ usableY,  P = camZ/(camZ - r·s)
  // ⇒ r ≤ U/(1 + U·s/camZ) with U = usableX, and U = usableY/s respectively.
  const s = Math.max(0.2, Math.abs(Math.sin(tilt)));
  const clamp = (U) => U / (1 + (U * s) / camZ);
  let rMax = Math.min(clamp(usableX), clamp(usableY / s));
  rMax = Math.max(rMin + 0.5, rMax);
  return { rMin, rMax, halfW, halfH, wpp, usableX, usableY };
}

/**
 * Give each agent its own path: radii spread across the band in golden-ratio
 * order (neighbours in the list are not neighbours in radius), speeds that
 * differ, phases spread around the circle with a per-id nudge, and tilts
 * alternating in sign so the planes differ. Deterministic for the same ids.
 */
export function assignOrbits(ids, band) {
  const n = ids.length;
  const out = {};
  const span = Math.max(0, band.rMax - band.rMin);
  const golden = 0.6180339887;
  ids.forEach((id, i) => {
    const h = hash01(id);
    const slot = n <= 1 ? 0.5 : (i * golden) % 1; // 0..1 spread
    const radius = band.rMin + span * (0.15 + 0.7 * slot);
    const speed = 0.05 + 0.06 * ((i * golden + h * 0.3) % 1); // rad/s
    const phase = (i * 2 * Math.PI) / Math.max(1, n) + h * 0.4;
    const tilt = (i % 2 === 0 ? 1 : -1) * (0.35 + 0.25 * ((h + i * 0.37) % 1));
    const yaw = h * Math.PI * 2 * 0.25 - Math.PI * 0.25; // small plane rotation
    out[id] = { radius, speed, phase, tilt, yaw };
  });
  return out;
}

/** Position on the orbit at angle θ: circle in XZ, tilted about X, yawed about Y. */
export function orbitPoint(orbit, theta, out = [0, 0, 0]) {
  const { radius: r, tilt, yaw = 0 } = orbit;
  const x0 = r * Math.cos(theta);
  const z0 = r * Math.sin(theta);
  // tilt about X
  const y1 = -z0 * Math.sin(tilt);
  const z1 = z0 * Math.cos(tilt);
  // yaw about Y
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  out[0] = x0 * cy + z1 * sy;
  out[1] = y1;
  out[2] = -x0 * sy + z1 * cy;
  return out;
}

/** Radial distance of an orbit point from the origin (should equal radius). */
export function orbitDistance(orbit, theta) {
  const p = orbitPoint(orbit, theta);
  return Math.hypot(p[0], p[1], p[2]);
}
