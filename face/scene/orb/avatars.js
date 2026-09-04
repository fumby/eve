// Avatar textures with a three-step fallback so a brand-new agent looks
// finished instantly with zero art: an explicit image if given, else a
// conventional /avatars/<id>.png, else one generated on the fly — a soft
// coloured halo, a disc fading from a dark core out to the agent's accent,
// a thin rim, and the agent's initial in the centre.

import * as THREE from "three";

export function generateAvatar({ name = "?", color = "#2DD4A8" }, size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const cx = size / 2, cy = size / 2;

  // soft halo
  const halo = g.createRadialGradient(cx, cy, size * 0.3, cx, cy, size * 0.5);
  halo.addColorStop(0, hexA(color, 0.35));
  halo.addColorStop(1, hexA(color, 0));
  g.fillStyle = halo;
  g.fillRect(0, 0, size, size);

  // disc: dark core → accent
  const r = size * 0.36;
  const disc = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
  disc.addColorStop(0, "#0e0f13");
  disc.addColorStop(0.55, hexA(color, 0.35));
  disc.addColorStop(1, hexA(color, 0.9));
  g.fillStyle = disc;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();

  // thin rim
  g.lineWidth = Math.max(2, size * 0.012);
  g.strokeStyle = hexA(color, 0.9);
  g.beginPath();
  g.arc(cx, cy, r - g.lineWidth / 2, 0, Math.PI * 2);
  g.stroke();

  // initial (or a short monogram if the descriptor gives one)
  const initial = String(arguments[0].initial || name.trim()[0] || "?").toUpperCase().slice(0, 2);
  g.fillStyle = "rgba(255,255,255,0.92)";
  g.font = `600 ${Math.round(size * (initial.length > 1 ? 0.27 : 0.36))}px Inter, -apple-system, "SF Pro Text", sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(initial, cx, cy + size * 0.015);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const loader = new THREE.TextureLoader();

// The conventional images live in face/avatars/; index.json lists which ids
// have one, so a roster of six agents costs one request, not six 404s.
let manifest = null;
function loadManifest() {
  if (manifest) return manifest;
  manifest = fetch("avatars/index.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : []))
    .then((list) => new Set(Array.isArray(list) ? list.map(String) : []))
    .catch(() => new Set());
  return manifest;
}

/**
 * Resolve an avatar texture: explicit URL → avatars/<id>.png (if listed in
 * avatars/index.json) → generated. Returns the generated texture immediately
 * (so nothing is ever blank) and calls onReplace(tex) if a real image loads.
 */
export function resolveAvatar(desc, onReplace) {
  const generated = generateAvatar(desc);
  loadManifest().then((have) => {
    const candidates = [];
    if (desc.avatarUrl) candidates.push(desc.avatarUrl);
    if (have.has(desc.id)) candidates.push(`avatars/${encodeURIComponent(desc.id)}.png`);
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return;
      const url = candidates[i++];
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          onReplace?.(tex);
        },
        undefined,
        () => tryNext(), // a bad URL falls through to the next candidate
      );
    };
    tryNext();
  });
  return generated;
}

let glowTex = null;
export function sharedGlowTexture() {
  if (glowTex) return glowTex;
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,0.6)");
  grad.addColorStop(0.28, "rgba(255,255,255,0.14)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.03)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
