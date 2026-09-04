// Meshes and shaders. The reverse-fresnel glow here is what makes a node read
// as a bead of light rather than a shaded ball — white-hot core bleeding into a
// coloured halo, which bloom then turns into an actual light source.
import * as THREE from "three";
import { hash01 } from "./regions.js";

export const uTime = { value: 0 }; // one shared clock referenced by every material

// ---------------------------------------------------------------- textures
let radialTex = null;
export function radialTexture() {
  if (radialTex) return radialTex; // generate once, reuse everywhere
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  radialTex = new THREE.CanvasTexture(c);
  return radialTex;
}

// ---------------------------------------------------------------- glow node
const GLOW_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalW = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

const GLOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    float facing = max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0);
    float core = pow(facing, 2.5);
    float rim  = pow(1.0 - facing, 2.0);
    vec3 col = mix(uColor, vec3(1.0), core * 0.85) + uColor * rim * 1.4;
    gl_FragColor = vec4(col, (core * 0.95 + rim * 0.6) * uOpacity);
  }`;

export function glowMaterial(color, opacity = 1) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
  });
}

// ------------------------------------------------------- instanced regions
// Note: three.js injects instanceMatrix/instanceColor into a ShaderMaterial on
// an InstancedMesh — declaring them here is a redefinition error.
const INST_VERT = /* glsl */ `
  attribute float aPhase;
  attribute float aFreshness;
  uniform float uTime;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vFresh;
  void main() {
    vFresh = aFreshness;
    // Frequency AND offset vary per node, so the field shimmers organically
    // instead of pulsing in unison. Fresher memories breathe deeper.
    float freq = 3.5 + 2.5 * fract(aPhase * 0.7);
    float breathe = 1.0 + 0.06 * (0.4 + 0.6 * aFreshness) * sin(uTime * freq + aPhase * 6.283);
    vec3 p = position * breathe;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    vNormalW = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

const INST_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vFresh;
  varying vec3 vInstanceColor;
  void main() {
    float facing = max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0);
    float core = pow(facing, 2.5);
    float rim  = pow(1.0 - facing, 2.0);
    vec3 base = vInstanceColor * (0.45 + 0.75 * vFresh);
    vec3 col = mix(base, vec3(1.0), core * 0.85) + base * rim * 1.4;
    gl_FragColor = vec4(col, (core * 0.95 + rim * 0.6) * uOpacity);
  }`;

// Billboarded quads for the aura: two triangles instead of a sphere shell, an
// analytic falloff instead of a hard-edged disk, and — the trick — the SAME
// instanceMatrix/instanceColor buffers as the cores, so any scale animation
// moves both layers in lockstep for free.
const AURA_VERT = /* glsl */ `
  attribute float aPhase;
  attribute float aFreshness;
  uniform float uTime;
  varying vec2 vUv;
  varying float vFresh;
  void main() {
    vUv = uv - 0.5;
    vFresh = aFreshness;
    float freq = 3.5 + 2.5 * fract(aPhase * 0.7);
    float breathe = 1.0 + 0.06 * (0.4 + 0.6 * aFreshness) * sin(uTime * freq + aPhase * 6.283);
    // instance origin in view space, then expand in screen space
    vec4 origin = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float scale = length(vec3(instanceMatrix[0][0], instanceMatrix[1][1], instanceMatrix[2][2])) * 0.58;
    origin.xy += position.xy * scale * 3.4 * breathe;
    gl_Position = projectionMatrix * origin;
  }`;

const AURA_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vFresh;
  varying vec3 vInstanceColor;
  void main() {
    float d = length(vUv) * 2.0;
    float a = pow(max(1.0 - d, 0.0), 2.2);
    gl_FragColor = vec4(vInstanceColor * (0.5 + 0.8 * vFresh), a * uOpacity * (0.25 + 0.4 * vFresh));
  }`;

function withInstanceColorVarying(shader) {
  // three.js declares vInstanceColor only when USE_INSTANCING_COLOR is set;
  // it is, on any InstancedMesh with instanceColor — but the varying must be
  // declared in the vertex stage too.
  return shader;
}

// Builds cores + auras for one region, sharing instance buffers.
export function buildRegionInstances(nodes, positions) {
  const count = nodes.length;
  if (count === 0) return null;

  const sphere = new THREE.SphereGeometry(1, 24, 16);
  const coreMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uOpacity: { value: 1 } },
    vertexShader: INST_VERT.replace(
      "varying float vFresh;",
      "varying float vFresh;\n  varying vec3 vInstanceColor;",
    ).replace("vFresh = aFreshness;", "vFresh = aFreshness;\n    vInstanceColor = instanceColor;"),
    fragmentShader: INST_FRAG,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.InstancedMesh(sphere, coreMat, count);
  const quad = new THREE.PlaneGeometry(1, 1);
  const auraMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uOpacity: { value: 1 } },
    vertexShader: AURA_VERT.replace(
      "varying float vFresh;",
      "varying float vFresh;\n  varying vec3 vInstanceColor;",
    ).replace("vFresh = aFreshness;", "vFresh = aFreshness;\n    vInstanceColor = instanceColor;"),
    fragmentShader: AURA_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const aura = new THREE.InstancedMesh(quad, auraMat, count);

  const phases = new Float32Array(count);
  const fresh = new Float32Array(count);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const ids = [];

  nodes.forEach((n, i) => {
    const p = positions.get(n.id) ?? [0, 0, 0];
    m.makeScale(n.size, n.size, n.size);
    m.setPosition(p[0], p[1], p[2]);
    mesh.setMatrixAt(i, m);
    aura.setMatrixAt(i, m);
    col.set(n.color);
    mesh.setColorAt(i, col);
    aura.setColorAt(i, col);
    phases[i] = hash01(n.id) * 6.283;
    fresh[i] = n.freshness ?? 1;
    ids.push(n.id);
  });

  for (const target of [mesh, aura]) {
    target.geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
    target.geometry.setAttribute("aFreshness", new THREE.InstancedBufferAttribute(fresh, 1));
    target.instanceMatrix.needsUpdate = true;
    if (target.instanceColor) target.instanceColor.needsUpdate = true;
  }
  mesh.userData.ids = ids;
  aura.renderOrder = -1;
  aura.frustumCulled = false; // quads are expanded in the shader; CPU bounds lie

  return { mesh, aura, ids };
}

// ---------------------------------------------------------------- the core
export function buildCore(color = "#2DD4A8") {
  const group = new THREE.Group();
  const nucleus = new THREE.Group();
  group.add(nucleus);

  const inner = new THREE.Mesh(
    new THREE.SphereGeometry(0.62, 32, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending }),
  );
  nucleus.add(inner);

  const shell = new THREE.Mesh(new THREE.SphereGeometry(1.15, 32, 24), glowMaterial(color, 0.9));
  nucleus.add(shell);

  const tex = radialTexture();
  const coronaTight = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(color), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  coronaTight.scale.setScalar(4.2);
  const coronaWide = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(color), transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  coronaWide.scale.setScalar(8.5);
  nucleus.add(coronaTight, coronaWide);

  // Prompt rings. A torus's symmetry axis is Z, so spinning it about Z is
  // invisible — these turn about Y.
  const ringMat = (opacity) =>
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  const stable = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.012, 8, 128), ringMat(0.5));
  stable.rotation.x = Math.PI / 2;
  const dynamic = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.01, 8, 128), ringMat(0.28));
  dynamic.rotation.x = Math.PI / 2.35;
  dynamic.rotation.z = 0.4;
  group.add(stable, dynamic);

  return { group, nucleus, inner, shell, coronaTight, coronaWide, stable, dynamic };
}

// ---------------------------------------------------------------- starfield
export function buildStarfield(count = 600) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = 80 + Math.random() * 80;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(p) * Math.cos(t);
    pos[i * 3 + 1] = r * Math.cos(p);
    pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
    phase[i] = Math.random() * 6.283;
    size[i] = 1 + Math.random() * 2.6;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aPhase; attribute float aSize;
      uniform float uTime;
      varying float vTw;
      void main() {
        // peaks cross the bloom threshold, which is what makes them sparkle
        vTw = 0.35 + 0.9 * (0.5 + 0.5 * sin(uTime * 1.1 + aPhase));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (150.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vTw;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d) * vTw;
        gl_FragColor = vec4(0.86, 0.92, 1.0, a * 0.85);
      }`,
  });
  return new THREE.Points(geo, mat);
}

// ---------------------------------------------------------------- membrane
export function buildMembrane(radius = 26) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.06 }, uColor: { value: new THREE.Color("#7FD8C4") } },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity; uniform vec3 uColor;
      varying vec3 vN; varying vec3 vV;
      void main() {
        // abs(), not max(): BackSide flips the normals, and max() clamps to
        // zero everywhere — which renders as a solid disk instead of a rim.
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
        gl_FragColor = vec4(uColor, f * uOpacity);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat);
}
