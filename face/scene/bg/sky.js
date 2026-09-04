// The sky: one full-screen quad, one shader. Dark base brighter in the
// centre, four layers of fbm nebula drifting in different directions and
// colours (cool greens, a touch of magenta, a touch of blue), two star grids
// (dense-fine, sparse-large) each twinkling on its own rhythm, a soft glow
// pooled behind the orb in the orb's live colour, and a vignette so the eye
// stays centred. Cost is per pixel, so the background renderer's pixel
// ratio is the lever; OCTAVES drops from 4 to 3 in performance mode.

import * as THREE from "three";

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uAspect;
uniform vec3 uGlowColor;
uniform float uGlowStrength;
uniform vec2 uParallax;
uniform vec3 uNebA; uniform vec3 uNebB; uniform vec3 uNebC; uniform vec3 uNebD;
varying vec2 vUv;

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p){
  float h = hash21(p);
  return vec2(h, hash21(p + h + 7.1));
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1,0)), c = hash21(i + vec2(0,1)), d = hash21(i + vec2(1,1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < OCTAVES; i++) { v += a * vnoise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
// One nebula layer: domain-warped fbm, thresholded into wisps.
float nebula(vec2 p, vec2 drift, float scale, float t){
  vec2 q = p * scale + drift * t;
  float w = fbm(q * 1.7 + vec2(3.1, 9.4));
  float n = fbm(q + (w - 0.5) * 0.9);
  return smoothstep(0.42, 0.85, n);
}
// A star grid: one star per cell for cells whose hash clears the threshold.
float stars(vec2 p, float cells, float thresh, float t, float sizeMul){
  vec2 g = p * cells;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float h = hash21(cell);
  if (h < thresh) return 0.0;
  vec2 pos = 0.15 + 0.7 * hash22(cell + 0.37);
  float d = length(f - pos);
  float size = (0.02 + 0.06 * hash21(cell + 1.7)) * sizeMul;
  float tw = 0.55 + 0.45 * sin(t * (0.6 + 1.6 * hash21(cell + 4.2)) + h * 6.2831);
  float core = smoothstep(size, 0.0, d);
  float haze = smoothstep(size * 4.0, 0.0, d) * 0.15;
  return (core + haze) * tw * (0.5 + 0.5 * h);
}

void main(){
  vec2 uv = vUv - 0.5;
  vec2 p = vec2(uv.x * uAspect, uv.y);       // aspect-corrected, centred
  vec2 pp = p + uParallax;                    // background camera wander

  float t = uTime;
  float rc = length(p);
  // dark base, brighter toward the centre
  vec3 col = mix(vec3(0.027, 0.031, 0.047), vec3(0.055, 0.075, 0.105), 1.0 - smoothstep(0.0, 0.9, rc));

  // nebula layers, each its own drift and colour
  float nA = nebula(pp, vec2( 0.010,  0.004), 1.15, t);
  float nB = nebula(pp + 4.0, vec2(-0.007,  0.006), 0.85, t);
  float nC = nebula(pp - 2.5, vec2( 0.004, -0.008), 1.45, t);
  float nD = nebula(pp + 9.0, vec2(-0.005, -0.003), 0.65, t);
  col += uNebA * nA * 0.34;
  col += uNebB * nB * 0.26;
  col += uNebC * nC * 0.22;
  col += uNebD * nD * 0.20;

  // stars: dense & fine, sparse & large
  float s1 = stars(pp + 13.0, 90.0, 0.94, t, 1.0);
  float s2 = stars(pp - 21.0, 28.0, 0.985, t * 0.8, 1.9);
  col += vec3(0.85, 0.92, 1.0) * (s1 * 0.85 + s2 * 1.1);

  // the orb lights the space behind it
  float g = pow(smoothstep(0.62, 0.0, rc), 1.8);
  col += uGlowColor * g * uGlowStrength * 0.55;

  // vignette
  col *= 1.0 - smoothstep(0.55, 1.35, rc) * 0.6;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export function createSky({ octaves = 4 } = {}) {
  const uniforms = {
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uGlowColor: { value: new THREE.Color("#2DD4A8") },
    uGlowStrength: { value: 0.35 },
    uParallax: { value: new THREE.Vector2(0, 0) },
    uNebA: { value: new THREE.Color("#1a6f5c") },
    uNebB: { value: new THREE.Color("#3c2a6e") },
    uNebC: { value: new THREE.Color("#1d3a6e") },
    uNebD: { value: new THREE.Color("#2a8f70") },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: { OCTAVES: octaves },
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return {
    mesh,
    uniforms,
    setOctaves(n) {
      material.defines.OCTAVES = n;
      material.needsUpdate = true;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
