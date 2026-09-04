// GLSL for the orb layer. Noise is Ashima simplex (public domain), used to
// displace the wireframe sphere so it breathes; fresnel gives the
// energy-field look — edges facing away from the camera glow brighter than
// the centre. Every fragment shader ends with three's colour-space include so
// linear uniforms match the built-in materials on the same canvas.

export const SNOISE = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float fbm3(vec3 p){
  float f = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { f += a * snoise(p); p *= 2.03; a *= 0.5; }
  return f;
}
`;

// Shared by the wireframe and the translucent fill: same displacement, so
// the two never disagree about where the surface is.
export const ORB_VERT = /* glsl */ `
uniform float uTime;
uniform float uBreath;   // resting displacement amplitude
uniform float uAudio;    // voice-driven displacement amplitude
uniform float uChurn;    // how fast the noise drifts
uniform float uFreq;     // spatial frequency
uniform float uSharp;    // 0..1 — error mood: higher frequency, harder edges
varying float vFacing;
varying float vNoise;
${SNOISE}
void main(){
  vec3 nrm = normalize(position);
  float freq = uFreq * (1.0 + uSharp * 1.5);
  float n1 = fbm3(nrm * freq + vec3(uTime * uChurn * 0.35, uTime * uChurn * 0.21, -uTime * uChurn * 0.17));
  float n2 = snoise(nrm * freq * 2.2 - vec3(uTime * uChurn * 0.6));
  float d = uBreath * n1 + uAudio * n2;
  vec3 p = position * (1.0 + d);
  vNoise = n1;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 vn = normalize(normalMatrix * nrm);
  vFacing = dot(vn, normalize(-mv.xyz));
  gl_Position = projectionMatrix * mv;
}
`;

// Wireframe: fresnel-lit lines, colour = mix of the two mood colours.
export const ORB_WIRE_FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uHueMix;
uniform float uBright;
uniform float uOpacity;
varying float vFacing;
varying float vNoise;
void main(){
  float facing = clamp(vFacing, 0.0, 1.0);
  float fres = pow(1.0 - facing, 1.6);
  vec3 body = mix(uColorA, uColorB, uHueMix);
  vec3 col = mix(body, vec3(1.0), fres * 0.55) * uBright;
  col += body * max(vNoise, 0.0) * 0.25;
  float alpha = (0.07 + 0.6 * fres) * uOpacity * min(1.0, uBright + 0.25);
  gl_FragColor = vec4(col * alpha, alpha);
  #include <colorspace_fragment>
}
`;

// Translucent fill: only the rim really shows, giving the body a faint volume.
export const ORB_FILL_FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uHueMix;
uniform float uBright;
uniform float uOpacity;
varying float vFacing;
void main(){
  float facing = clamp(vFacing, 0.0, 1.0);
  float rim = pow(1.0 - facing, 3.0);
  vec3 body = mix(uColorA, uColorB, uHueMix);
  float alpha = rim * 0.2 * uBright * uOpacity;
  gl_FragColor = vec4(body * alpha, alpha);
  #include <colorspace_fragment>
}
`;

// Glow shell: a slightly larger BackSide sphere whose rim lights up.
export const SHELL_VERT = /* glsl */ `
varying float vFacing;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 vn = normalize(normalMatrix * normal);
  vFacing = abs(dot(vn, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`;
export const SHELL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFacing;
void main(){
  float f = pow(1.0 - vFacing, 2.2) * (0.35 + 0.65 * smoothstep(0.0, 0.22, vFacing));
  float alpha = f * uOpacity;
  gl_FragColor = vec4(uColor * alpha, alpha);
  #include <colorspace_fragment>
}
`;

// Processing rings: thin tori with bright pulses travelling around them.
export const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
export const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uPhase;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uDrift;   // 0..1 teal→purple
uniform float uOpacity;
varying vec2 vUv;
void main(){
  float u = vUv.x;
  float p1 = exp(-fract(u - uTime * uSpeed - uPhase) * 14.0);
  float p2 = exp(-fract(u - uTime * uSpeed - uPhase + 0.5) * 14.0);
  float pulse = p1 + p2;
  vec3 col = mix(uColorA, uColorB, uDrift);
  float alpha = (0.22 + 0.9 * pulse) * uOpacity;
  gl_FragColor = vec4(mix(col, vec3(1.0), pulse * 0.4) * alpha, alpha);
  #include <colorspace_fragment>
}
`;
