// GLSL ES 3.00 sources for "Bulb" — a raymarched hybrid 3D fractal.
(function () {
  'use strict';
  const S = {};

  S.COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define PI 3.141592653589793
#define TAU 6.283185307179586
uint pcg(uint v){ v = v*747796405u + 2891336453u; uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (w >> 22u) ^ w; }
float rnd(inout uint s){ s = pcg(s); return float(s) * (1.0/4294967296.0); }
vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a + b*cos(TAU*(c*t+d)); }
`;

  // ------------------------------------------------------------------ the fractal
  // Every iteration slot blends three formulas by weight (uSlotW[i] = bulb, box, ifs),
  // so two genomes can be interpolated continuously — that is what makes the
  // Electric-Sheep-style morphing possible in 3D.
  S.FRACTAL_GLSL = `
#define MAXI 18
uniform vec3 uSlotW[8];
uniform float uItersF;                 // fractional iteration count: detail "grows" smoothly
uniform float uPower;                  // mandelbulb
uniform vec3 uJuliaC; uniform float uJuliaMix;
uniform float uBoxScale, uBoxFold, uMinR2, uFixedR2;   // mandelbox
uniform float uIfsScale; uniform vec3 uIfsOffset;      // kaleidoscopic IFS
uniform mat3 uRot1, uRot2;
uniform float uLinearity;              // 0 = log DE (bulb), 1 = linear DE (box / ifs)
uniform float uBailout;

// returns distance estimate; outputs orbit trap + iteration fraction for colouring
float DE(vec3 p, out float trap, out float iterN, out float trap2){
  vec3 z = p; float dr = 1.0; float r = length(z);
  vec3 c = mix(p, uJuliaC, uJuliaMix);
  trap = 1e9; iterN = 0.0; trap2 = 1e9;
  int n = int(ceil(uItersF));
  float lastW = uItersF - floor(uItersF); if (lastW <= 0.0) lastW = 1.0;
  for (int i = 0; i < MAXI; i++) {
    if (i >= n) break;
    vec3 w = uSlotW[i & 7];
    vec3 zn = vec3(0.0); float drn = 0.0;
    if (w.x > 0.0) {
      float rr = max(length(z), 1e-6);
      float th = acos(clamp(z.z / rr, -1.0, 1.0)) * uPower, ph = atan(z.y, z.x) * uPower;
      float zr = pow(rr, uPower);
      vec3 zb = zr * vec3(sin(th)*cos(ph), sin(th)*sin(ph), cos(th)) + c;
      float drb = pow(rr, uPower - 1.0) * uPower * dr + 1.0;
      zn += w.x * zb; drn += w.x * drb;
    }
    if (w.y > 0.0) {
      vec3 zb = clamp(z, -uBoxFold, uBoxFold) * 2.0 - z;
      float r2 = dot(zb, zb); float drb = dr;
      if (r2 < uMinR2) { float t = uFixedR2 / uMinR2; zb *= t; drb *= t; }
      else if (r2 < uFixedR2) { float t = uFixedR2 / r2; zb *= t; drb *= t; }
      zb = zb * uBoxScale + c; drb = drb * abs(uBoxScale) + 1.0;
      zn += w.y * zb; drn += w.y * drb;
    }
    if (w.z > 0.0) {
      vec3 zb = abs(uRot1 * z);
      if (zb.x < zb.y) zb.xy = zb.yx;
      if (zb.x < zb.z) zb.xz = zb.zx;
      if (zb.y < zb.z) zb.yz = zb.zy;
      zb = uRot2 * zb;
      zb = zb * uIfsScale - uIfsOffset * (uIfsScale - 1.0);
      float drb = dr * abs(uIfsScale);
      zn += w.z * zb; drn += w.z * drb;
    }
    if (i == n - 1) { zn = mix(z, zn, lastW); drn = mix(dr, drn, lastW); }   // fractional last step
    z = zn; dr = max(drn, 1e-6);
    r = length(z);
    trap = min(trap, r);
    trap2 = min(trap2, abs(z.x) + abs(z.y) * 0.5);
    iterN += 1.0;
    if (r > uBailout) break;
  }
  float deLog = 0.5 * log(max(r, 1e-6)) * r / dr;
  float deLin = (r - 1.5) / dr;
  return mix(deLog, deLin, uLinearity);
}
float DEo(vec3 p){ float a, b, c2; return DE(p, a, b, c2); }
`;

  S.RAY_FS = S.COMMON + S.FRACTAL_GLSL + `
uniform vec2 uRes;              // ray target size
uniform vec3 uCamPos[4]; uniform mat3 uCamRot[4]; uniform vec4 uMonRect[4]; uniform int uNMon;   // one camera per monitor
uniform float uHalfFovY;
uniform int uSteps; uniform float uStepMul; uniform float uPixel; uniform float uFar;
uniform int uAoSamples;
uniform vec3 uPalA, uPalB, uPalC, uPalD; uniform float uHue; uniform float uTrapScale;
uniform vec3 uLightDir; uniform vec3 uFogColor; uniform float uFogDensity;
uniform vec3 uGlowColor; uniform float uGlow;
uniform float uBright; uniform vec4 uAudio;
uniform float uTime; uniform vec2 uJitter;   // sub-pixel jitter (ray texels) for temporal accumulation
in vec2 vUv; out vec4 o;

vec3 normalAt(vec3 p, float eps){
  vec2 e = vec2(1.0, -1.0) * eps;
  return normalize(e.xyy * DEo(p + e.xyy) + e.yyx * DEo(p + e.yyx) + e.yxy * DEo(p + e.yxy) + e.xxx * DEo(p + e.xxx));
}
float ao(vec3 p, vec3 n, float scale){
  float occ = 0.0, sca = 1.0;
  for (int i = 1; i <= 5; i++) {
    if (i > uAoSamples) break;
    float h = scale * float(i) * 0.6;
    float d = DEo(p + n * h);
    occ += (h - d) * sca; sca *= 0.7;
  }
  return clamp(1.0 - 1.5 * occ / scale, 0.0, 1.0);
}

void main(){
  // which monitor is this pixel on? each gets its own camera on the same fractal
  vec2 uvj = vUv + uJitter / uRes;
  int mi = 0;
  for (int i = 0; i < 4; i++) { if (i >= uNMon) break; vec4 m = uMonRect[i]; if (uvj.x >= m.x && uvj.x < m.x + m.z && uvj.y >= m.y && uvj.y < m.y + m.w) mi = i; }
  vec4 mr = uMonRect[mi];
  vec2 luv = (uvj - mr.xy) / mr.zw;
  vec2 ndc = luv * 2.0 - 1.0;
  float aspect = (mr.z * uRes.x) / (mr.w * uRes.y);
  // mild cylindrical projection so wide screens sweep instead of stretch
  float halfH = min(1.3, atan(tan(uHalfFovY) * aspect));
  float yaw = ndc.x * halfH;
  float pitch = ndc.y * uHalfFovY;
  vec3 rdc = normalize(vec3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch)));
  vec3 rd = uCamRot[mi] * rdc;
  vec3 ro = uCamPos[mi];

  float t = 0.0, glow = 0.0, minD = 1e9, steps = 0.0;
  bool hit = false, inside = false;
  float trap = 1e9, itn = 0.0, trapB = 1e9;
  vec3 p = ro;
  for (int i = 0; i < 160; i++) {
    if (i >= uSteps) break;
    p = ro + rd * t;
    float tr, it, tb;
    float d = DE(p, tr, it, tb);
    if (i == 0 && d < 0.0) { inside = true; break; }          // camera engulfed: show fog, the camera will relocate
    float eps = uPixel * t;
    minD = min(minD, d);
    glow += 0.035 / (1.0 + d * d * 600.0);
    if (d < eps) { hit = true; trap = tr; itn = it; trapB = tb; break; }
    t += d * uStepMul;
    steps += 1.0;
    if (t > uFar) break;
  }

  vec3 col;
  float fogT = 1.0 - exp(-t * uFogDensity);
  if (hit) {
    float eps = max(uPixel * t, 1e-5);
    vec3 n = normalAt(p, eps * 2.0);
    float occ = ao(p, n, max(eps * 12.0, 0.01));
    float stepShade = 1.0 - clamp(steps / float(uSteps), 0.0, 1.0) * 0.7;     // crevices darken (cheap AO #2)
    float k = trap * uTrapScale + itn * 0.03 + uHue;
    vec3 base = pal(k, uPalA, uPalB, uPalC, uPalD);
    base *= 0.75 + 0.5 * smoothstep(0.0, 0.6, trapB);                          // fine banding from the second trap
    vec3 l = normalize(uLightDir);                                            // key light, camera-relative
    float dif = max(dot(n, l), 0.0);
    float head = max(dot(n, -rd), 0.0) * 0.35;                                // headlight so the view is never black
    float bak = max(dot(n, -l), 0.0) * 0.2;
    vec3 h = normalize(l - rd);
    float spec = pow(max(dot(n, h), 0.0), 36.0) * 0.55;
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    col = base * (0.35 + 1.15 * dif + head + bak) * occ * stepShade;
    col += spec * occ * mix(vec3(1.0), base, 0.5);
    col += rim * base * 0.4 * occ;
    col += base * uAudio.y * 0.15;                                            // beat flash on the surface
    col = mix(col, uFogColor, fogT);
  } else {
    col = uFogColor * (inside ? 1.5 : 0.8) * (1.0 - 0.4 * abs(ndc.y)) + uGlowColor * 0.03 * (1.0 - 0.5 * abs(ndc.y));
  }
  col += uGlowColor * glow * uGlow * (1.0 + uAudio.z * 0.8);
  col *= uBright;
  o = vec4(col, hit ? 1.0 : 0.0);
}`;

  // ------------------------------------------------------------------ spores (free physarum, food = fractal brightness)
  S.AGENT_UPDATE_FS = S.COMMON + `
uniform sampler2D uAgents; uniform sampler2D uTrail; uniform sampler2D uScene;
uniform vec2 uRes; uniform uint uFrame;
uniform float uSA, uSD, uRA, uSS; uniform vec4 uAudio; uniform float uOnset; uniform float uFood;
in vec2 vUv; out vec4 o;
float sense(vec2 p){ vec2 uv = p / uRes; vec3 c = texture(uScene, uv).rgb; return texture(uTrail, uv).r + dot(c, vec3(0.3, 0.5, 0.2)) * uFood; }
void main(){
  vec4 A = texture(uAgents, vUv);
  uint s = pcg(uint(gl_FragCoord.x)*7u + uint(gl_FragCoord.y)*4099u + uFrame*2654435761u);
  vec2 p = A.xy; float h = A.z;
  float bass = uAudio.x, beat = uAudio.y, treb = uAudio.z, energy = uAudio.w;
  float sa = uSA * (1.0 + treb*0.6);
  vec2 dF = vec2(cos(h), sin(h)), dL = vec2(cos(h+sa), sin(h+sa)), dR = vec2(cos(h-sa), sin(h-sa));
  float vF = sense(p + dF*uSD), vL = sense(p + dL*uSD), vR = sense(p + dR*uSD);
  float ra = uRA * (1.0 + beat*0.5);
  if (vF > vL && vF > vR) { } else if (vF < vL && vF < vR) { h += (rnd(s) < 0.5 ? ra : -ra); } else if (vL > vR) h += ra; else if (vR > vL) h -= ra;
  h += (rnd(s)-0.5) * (0.08 + energy*0.25);
  if (uOnset > 0.5 && rnd(s) < 0.35) h += (rnd(s)-0.5) * 2.4;
  p += vec2(cos(h), sin(h)) * uSS * (1.0 + bass*0.9 + beat*1.2);
  p = mod(p, uRes);
  o = vec4(p, h, A.w);
}`;
  S.DEPOSIT_VS = S.COMMON + `
uniform sampler2D uAgents; uniform int uSide; uniform vec2 uRes; uniform float uDeposit;
out vec4 vCol;
void main(){ int id = gl_VertexID; vec4 A = texelFetch(uAgents, ivec2(id % uSide, id / uSide), 0); gl_Position = vec4(A.xy / uRes * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = 1.0; vCol = vec4(uDeposit); }`;
  S.POINT_FS = S.COMMON + `in vec4 vCol; out vec4 o; void main(){ o = vCol; }`;
  S.DIFFUSE_FS = S.COMMON + `
uniform sampler2D uTrail; uniform vec2 uRes; uniform float uDecay;
in vec2 vUv; out vec4 o;
void main(){ vec2 px = 1.0/uRes; float s = 0.0;
  s += texture(uTrail, vUv + px*vec2(-1,-1)).r; s += texture(uTrail, vUv + px*vec2(0,-1)).r; s += texture(uTrail, vUv + px*vec2(1,-1)).r;
  s += texture(uTrail, vUv + px*vec2(-1, 0)).r; s += texture(uTrail, vUv).r * 2.0;         s += texture(uTrail, vUv + px*vec2(1, 0)).r;
  s += texture(uTrail, vUv + px*vec2(-1, 1)).r; s += texture(uTrail, vUv + px*vec2(0, 1)).r; s += texture(uTrail, vUv + px*vec2(1, 1)).r;
  o = vec4(max((s / 10.0) * uDecay - 0.0005, 0.0)); }`;

  // ------------------------------------------------------------------ composite (upscale + temporal smoothing + layers)
  S.COMPOSITE_FS = S.COMMON + `
uniform sampler2D uRay;        // low-res raymarch result
uniform sampler2D uPrev;       // previous composite (temporal smoothing)
uniform sampler2D uTrail;      // spores
uniform sampler2D uField, uFieldOld; uniform float uMorph; uniform sampler2D uClockLayer;
uniform vec2 uRes; uniform vec2 uRayRes;
uniform float uTemporal;       // 0..1 history weight
uniform float uSporeAmt; uniform vec3 uMycA, uMycB, uMycC, uMycD; uniform float uHue;
uniform float uClockContrast; uniform vec4 uAudio;
uniform int uView; uniform vec2 uMoldPx; uniform float uTime;
in vec2 vUv; out vec4 o;
` + WE.ClockCrowd.COMPOSITE_GLSL + `
void main(){
  vec2 uv = vUv;
  // bicubic-ish upsample: 4 bilinear taps offset by half a low-res texel, softens the aliasing of the raymarch
  vec3 ray = texture(uRay, uv).rgb;
  vec3 prev = texture(uPrev, uv).rgb;
  vec3 col = mix(ray, prev, uTemporal);        // jittered frames accumulate into a supersampled image
  if (uView == 1) { o = vec4(ray, 1.0); return; }

  float t = max(texture(uTrail, uv).r - 0.05, 0.0);
  float lum = dot(ray, vec3(0.3, 0.5, 0.2));
  vec3 myc = pal(t*0.25 + uHue*0.5 + 0.3, uMycA, uMycB, uMycC, uMycD) * (1.0 - exp(-t * 1.4)) * uSporeAmt * 0.35 * smoothstep(0.03, 0.35, lum);
  col += myc;                                   // faint, and only where the fractal is lit
  if (uView == 2) { o = vec4(myc, 1.0); return; }

  float f = mix(texture(uFieldOld, uv).r, texture(uField, uv).r, uMorph);
  if (uView == 4) { vec2 M = texture(uClockLayer, uv).rg; o = vec4(M.r, M.g, 0.0, 1.0); return; }
  col = clockComposite(col, f, uClockLayer, uv, uMoldPx, uMycA, uMycB, uMycC, uMycD, uHue, uClockContrast, uTime);
  o = vec4(col, 1.0);
}`;

  S.DOWNSAMPLE_FS = S.COMMON + `
uniform sampler2D uSrc; uniform vec2 uRes; uniform float uThresh;
in vec2 vUv; out vec4 o;
void main(){ vec2 px = 1.0/uRes;
  vec3 c = (texture(uSrc, vUv + px*vec2(-0.5,-0.5)).rgb + texture(uSrc, vUv + px*vec2(0.5,-0.5)).rgb + texture(uSrc, vUv + px*vec2(-0.5, 0.5)).rgb + texture(uSrc, vUv + px*vec2(0.5, 0.5)).rgb) * 0.25;
  float l = dot(c, vec3(0.299,0.587,0.114));
  o = vec4(c * smoothstep(uThresh, uThresh + 0.6, l), 1.0); }`;
  S.BLUR_FS = S.COMMON + `
uniform sampler2D uSrc; uniform vec2 uDir; in vec2 vUv; out vec4 o;
void main(){ vec3 c = texture(uSrc, vUv).rgb * 0.2270270270;
  c += texture(uSrc, vUv + uDir*1.3846153846).rgb * 0.3162162162; c += texture(uSrc, vUv - uDir*1.3846153846).rgb * 0.3162162162;
  c += texture(uSrc, vUv + uDir*3.2307692308).rgb * 0.0702702703; c += texture(uSrc, vUv - uDir*3.2307692308).rgb * 0.0702702703;
  o = vec4(c, 1.0); }`;
  S.FINAL_FS = S.COMMON + `
uniform sampler2D uComp, uBloom; uniform vec2 uRes; uniform float uTime; uniform vec4 uAudio;
uniform float uBloomAmt, uCA, uGrain; uniform vec4 uMon[4]; uniform int uNMon;
in vec2 vUv; out vec4 o;
vec3 tonemap(vec3 x){ return x / (1.0 + x) * 1.2; }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
void main(){
  float beat = uAudio.y;
  vec2 c = vec2(0.5); vec2 sz = vec2(1.0);
  for (int i = 0; i < 4; i++) { if (i >= uNMon) break; vec4 m = uMon[i]; if (vUv.x >= m.x && vUv.x <= m.x+m.z && vUv.y >= m.y && vUv.y <= m.y+m.w) { c = m.xy + m.zw*0.5; sz = m.zw; } }
  vec2 d = (vUv - c) / sz;
  float ca = uCA * (0.3 + beat*1.8) / uRes.x; vec2 dir = d * 2.0;
  vec3 col;
  col.r = texture(uComp, vUv + dir*ca*2.0).r; col.g = texture(uComp, vUv).g; col.b = texture(uComp, vUv - dir*ca*2.0).b;
  col += texture(uBloom, vUv).rgb * uBloomAmt * (1.0 + beat*0.5);
  col = tonemap(col);
  float vig = 1.0 - smoothstep(0.5, 1.1, length(d) * 1.1);
  col *= mix(0.75, 1.0, vig);
  col += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
  o = vec4(pow(max(col, 0.0), vec3(1.0/1.05)), 1.0);
}`;
  S.ZERO_FS = S.COMMON + `out vec4 o; void main(){ o = vec4(0.0); }`;

  window.BULB_SHADERS = S;
})();
