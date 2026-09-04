// The distant web: additive points for nodes and dust, thin lines between
// near nodes, all in one Group that rotates and drifts as a body. Dim by
// design — it reads as depth behind the orb, never as clutter.

import * as THREE from "three";
import { layoutNetwork } from "./network-layout.js";

const POINT_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;
uniform float uTime;
uniform float uScale;
varying vec3 vColor;
varying float vTw;
void main(){
  vColor = aColor;
  vTw = 0.7 + 0.3 * sin(uTime * 0.8 + aPhase);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale * (120.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;
const POINT_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vTw;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  a *= a;
  float alpha = a * uOpacity * vTw;
  gl_FragColor = vec4(vColor * alpha, alpha);
  #include <colorspace_fragment>
}
`;

function pointsFrom(count, pos, col, size, opacity, scale, seedPhase) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) phase[i] = ((i * 7919 + seedPhase) % 628) / 100;
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: opacity }, uScale: { value: scale } },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
  });
  return new THREE.Points(geo, mat);
}

export function createNetwork({ mobile = false } = {}) {
  const layout = layoutNetwork({ nodes: mobile ? 50 : 100, dust: mobile ? 150 : 300 });
  const group = new THREE.Group();
  group.position.set(0, 0, -60);

  const nodes = pointsFrom(layout.nodes.count, layout.nodes.pos, layout.nodes.col, layout.nodes.size, 0.55, 1.0, 11);
  const dustCol = new Float32Array(layout.dust.count * 3);
  for (let i = 0; i < layout.dust.count; i++) {
    dustCol[i * 3] = 0.6; dustCol[i * 3 + 1] = 0.7; dustCol[i * 3 + 2] = 0.85;
  }
  const dust = pointsFrom(layout.dust.count, layout.dust.pos, dustCol, layout.dust.size, 0.28, 0.6, 37);

  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute("position", new THREE.BufferAttribute(layout.edges.pos, 3));
  edgeGeo.setAttribute("color", new THREE.BufferAttribute(layout.edges.col, 3));
  const edges = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );

  group.add(edges, nodes, dust);
  const mats = [nodes.material, dust.material];

  return {
    group,
    update(dt, t, reducedMotion) {
      const k = reducedMotion ? 0.3 : 1;
      group.rotation.y += dt * 0.012 * k;
      group.rotation.x = 0.1 * Math.sin(t * 0.05 * k);
      group.position.x = 3.0 * Math.sin(t * 0.03 * k);
      for (const m of mats) m.uniforms.uTime.value = t;
    },
    dispose() {
      for (const o of [nodes, dust, edges]) {
        o.geometry.dispose();
        o.material.dispose();
      }
    },
  };
}
