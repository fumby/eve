// Edges and pulses. Every edge is an arc, not a line: straight lines slice
// through clusters and read as a wireframe, arcs read as anatomy.
import * as THREE from "three";
import { uTime, radialTexture } from "./nodes.js";
import { hash01 } from "./regions.js";

const SEGMENTS = 24;

export const EDGE_STYLE = {
  similarity: { color: "#A78BFA", opacity: 0.2, kindClass: "shimmer" },
  recall: { color: "#C4B5FD", opacity: 0.22, kindClass: "flow", speed: -0.32 }, // inward: memory → core
  capability: { color: "#8B93A1", opacity: 0.18, kindClass: "flow", speed: 0.28 }, // outward
  owns: { color: "#6B7280", opacity: 0.14, kindClass: "plain" },
  thread: { color: "#67E8F9", opacity: 0.18, kindClass: "flow", speed: 0.22 },
  knowledge: { color: "#F5A524", opacity: 0.16, kindClass: "plain" },
};

// Control point: midpoint pushed ~12% of the chord along a perpendicular
// derived from the outward direction, so edges bow around clusters.
export function arc(a, b) {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const mid = va.clone().add(vb).multiplyScalar(0.5);
  const chord = vb.clone().sub(va);
  const outward = mid.clone().normalize();
  let perp = chord.clone().cross(outward);
  if (perp.lengthSq() < 1e-6) perp = new THREE.Vector3(0, 1, 0);
  perp.normalize().multiplyScalar(chord.length() * 0.12);
  return new THREE.QuadraticBezierCurve3(va, mid.add(perp), vb);
}

// ShaderMaterial ignores .opacity, but the hover code sets it. Route the
// property into the uniform so nothing downstream needs a special case.
function shimOpacity(material) {
  Object.defineProperty(material, "opacity", {
    get() {
      return material.uniforms.uOpacity.value;
    },
    set(v) {
      material.uniforms.uOpacity.value = v;
    },
    configurable: true,
  });
  return material;
}

const SHIMMER_MAT = () =>
  shimOpacity(
    new THREE.ShaderMaterial({
      uniforms: { uTime, uOpacity: { value: 0.2 }, uColor: { value: new THREE.Color("#A78BFA") }, uShimmer: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aPhase; varying float vPhase;
        void main(){ vPhase=aPhase; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; uniform float uOpacity; uniform vec3 uColor; uniform float uShimmer;
        varying float vPhase;
        void main(){
          float s = 1.0 + uShimmer * 0.55 * sin(uTime * 1.6 + vPhase);
          gl_FragColor = vec4(uColor, uOpacity * s);
        }`,
    }),
  );

const FLOW_MAT = (color, speed) =>
  shimOpacity(
    new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uOpacity: { value: 0.2 },
        uColor: { value: new THREE.Color(color) },
        uSpeed: { value: speed },
        uFlow: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aPhase; attribute float aT; attribute float aWeight;
        varying float vPhase; varying float vT; varying float vW;
        void main(){ vPhase=aPhase; vT=aT; vW=aWeight;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; uniform float uOpacity; uniform vec3 uColor;
        uniform float uSpeed; uniform float uFlow;
        varying float vPhase; varying float vT; varying float vW;
        void main(){
          // The SIGN of uSpeed sets the direction of travel: outward reads as
          // dispatch, inward as recall. That is most of why this looks like
          // thought rather than decoration.
          float head = fract(uTime * uSpeed + vPhase);
          float d = fract(head - vT);
          float comet = exp(-d * 9.0) * uFlow;
          vec3 col = mix(uColor, vec3(1.0), comet * 0.8);
          gl_FragColor = vec4(col, (uOpacity * 0.75 + comet * 0.8) * (0.35 + 0.65 * vW));
        }`,
    }),
  );

// Builds one merged LineSegments per edge kind — 6 draw calls, not 400 — and
// keeps a side map of curves so the pulse system can look one up by endpoints.
export function buildEdges(edges, positions) {
  const curves = new Map();
  const byKind = new Map();

  for (const e of edges) {
    const a = positions.get(e.source);
    const b = positions.get(e.target);
    if (!a || !b) continue; // never draw an edge to a node that isn't there
    const curve = arc(a, b);
    curves.set(`${e.source}|${e.target}`, { curve, kind: e.kind, weight: e.weight ?? 0.5 });
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push({ ...e, curve });
  }

  const groups = [];
  for (const [kind, list] of byKind) {
    const style = EDGE_STYLE[kind] ?? { color: "#8B93A1", opacity: 0.15, kindClass: "plain" };
    const positionsArr = [];
    const phases = [];
    const ts = [];
    const weights = [];

    for (const e of list) {
      const pts = e.curve.getPoints(SEGMENTS);
      const phase = hash01(`${e.source}|${e.target}`) * 6.283;
      for (let i = 0; i < pts.length - 1; i++) {
        for (const [p, t] of [
          [pts[i], i / (pts.length - 1)],
          [pts[i + 1], (i + 1) / (pts.length - 1)],
        ]) {
          positionsArr.push(p.x, p.y, p.z);
          phases.push(phase);
          ts.push(t);
          weights.push(e.weight ?? 0.5);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positionsArr, 3));
    geo.setAttribute("aPhase", new THREE.Float32BufferAttribute(phases, 1));
    geo.setAttribute("aT", new THREE.Float32BufferAttribute(ts, 1));
    geo.setAttribute("aWeight", new THREE.Float32BufferAttribute(weights, 1));

    let mat;
    if (style.kindClass === "shimmer") mat = SHIMMER_MAT();
    else if (style.kindClass === "flow") mat = FLOW_MAT(style.color, style.speed ?? 0.25);
    else
      mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(style.color),
        transparent: true,
        opacity: style.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    if (mat.uniforms) {
      mat.uniforms.uOpacity.value = style.opacity;
      if (mat.uniforms.uColor) mat.uniforms.uColor.value = new THREE.Color(style.color);
    }

    const lines = new THREE.LineSegments(geo, mat);
    lines.userData.kind = kind;
    lines.userData.baseOpacity = style.opacity;
    groups.push(lines);
  }

  return { groups, curves };
}

// ---------------------------------------------------------------- pulses
// Preallocated pool. fire() drops the pulse silently when an id can't be
// resolved — an animation flying between two meaningless points is a lie.
export class PulsePool {
  constructor(scene, size = 64) {
    this.scene = scene;
    this.free = [];
    this.active = [];
    const tex = radialTexture();
    for (let i = 0; i < size; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      s.visible = false;
      s.scale.setScalar(0.5);
      scene.add(s);
      this.free.push(s);
    }
  }

  fire(fromPos, toPos, curve, color, { duration = 1100, scale = 0.55, opacity = 0.95 } = {}) {
    const sprite = this.free.pop();
    if (!sprite) return false; // pool exhausted; drop rather than allocate mid-frame
    sprite.material.color.set(color);
    sprite.visible = true;
    this.active.push({
      sprite,
      curve: curve ?? null,
      from: fromPos,
      to: toPos,
      start: performance.now(),
      duration,
      scale,
      opacity,
    });
    return true;
  }

  update(now) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      const t = (now - p.start) / p.duration;
      if (t >= 1) {
        p.sprite.visible = false;
        this.free.push(p.sprite);
        this.active.splice(i, 1);
        continue;
      }
      if (p.curve) {
        const pt = p.curve.getPoint(t);
        p.sprite.position.copy(pt);
      } else {
        p.sprite.position.set(
          p.from[0] + (p.to[0] - p.from[0]) * t,
          p.from[1] + (p.to[1] - p.from[1]) * t,
          p.from[2] + (p.to[2] - p.from[2]) * t,
        );
      }
      const swell = Math.sin(t * Math.PI); // fattest at mid-flight
      p.sprite.scale.setScalar(p.scale * (0.55 + swell * 0.9));
      p.sprite.material.opacity = p.opacity * swell;
    }
  }
}
