// Docking: an agent leaves orbit and settles next to a panel. The panel is a
// DOM rectangle; the agent lives in world space on the orb's z=0 plane. These
// helpers turn one into the other. Pure module.

import { viewExtents } from "./orbit.js";

/** A screen point just outside a rect on the given side, gap px away. */
export function rectAnchor(rect, side = "right", gapPx = 28) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  switch (side) {
    case "left":
      return { x: rect.left - gapPx, y: cy };
    case "top":
      return { x: cx, y: rect.top - gapPx };
    case "bottom":
      return { x: cx, y: rect.bottom + gapPx };
    default:
      return { x: rect.right + gapPx, y: cy };
  }
}

/** Screen px → world point on the z=0 plane for a camera at (0,0,camZ) looking at the origin. */
export function screenToPlaneZ0(pt, viewport, camZ, fovDeg, aspect) {
  const { halfW, halfH } = viewExtents(camZ, fovDeg, aspect);
  const nx = (pt.x / viewport.width) * 2 - 1;
  const ny = 1 - (pt.y / viewport.height) * 2;
  return [nx * halfW, ny * halfH, 0];
}

/** World point on z=0 → screen px, the inverse of the above (for tests). */
export function planeZ0ToScreen(p, viewport, camZ, fovDeg, aspect) {
  const { halfW, halfH } = viewExtents(camZ, fovDeg, aspect);
  const nx = p[0] / halfW;
  const ny = p[1] / halfH;
  return { x: ((nx + 1) / 2) * viewport.width, y: ((1 - ny) / 2) * viewport.height };
}

/** If p is inside the orb's exclusion radius, push it out along its own direction. */
export function pushOutOfRadius(p, minR) {
  const d = Math.hypot(p[0], p[1]);
  if (d >= minR) return p;
  if (d < 1e-6) return [minR, 0, p[2] || 0];
  const s = minR / d;
  return [p[0] * s, p[1] * s, p[2] || 0];
}

/** Several agents docked to one card stack downward. */
export function slotOffset(index, stepPx = 46) {
  return { x: 0, y: index * stepPx };
}
