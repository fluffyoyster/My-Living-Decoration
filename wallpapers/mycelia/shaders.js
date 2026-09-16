// GLSL ES 3.00 sources for "Mycelia". Kept as JS strings so the wallpaper
// works from file:// without fetch.
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

  // ------------------------------------------------------------------ fractal flame (Electric Sheep)
  // One chaos-game iteration per point per pass. Points persist across frames.
  S.FLAME_UPDATE_FS = S.COMMON + `
uniform sampler2D uPts;
uniform uint uFrame;
uniform float uCum[4];        // cumulative xform weights (last = 1)
uniform vec3 uAff[8];         // per xform: (a,b,c),(d,e,f)
uniform float uVars[64];      // 4 xforms x 16 variation weights
uniform float uColors[4];
uniform float uSym;           // rotational symmetry order (1 = none)
uniform float uMirror;        // 0/1 dihedral
uniform vec2 uFinal;          // final transform: (spherical weight, swirl weight) — audio driven
in vec2 vUv;
out vec4 o;

vec2 variation(int j, vec2 t){
  float r2 = dot(t,t), r = sqrt(r2) + 1e-6;
  float th = atan(t.x, t.y);           // Draves' theta = arctan(x/y)
  if (j==0) return t;
  if (j==1) return sin(t);
  if (j==2) return t / (r2 + 1e-4);
  if (j==3) { float s=sin(r2), c=cos(r2); return vec2(t.x*s - t.y*c, t.x*c + t.y*s); }
  if (j==4) return vec2((t.x-t.y)*(t.x+t.y), 2.0*t.x*t.y) / r;
  if (j==5) return vec2(th/PI, r-1.0);
  if (j==6) return r*vec2(sin(th+r), cos(th-r));
  if (j==7) return r*vec2(sin(th*r), -cos(th*r));
  if (j==8) return (th/PI)*vec2(sin(PI*r), cos(PI*r));
  if (j==9) return vec2(cos(th)+sin(r), sin(th)-cos(r)) / r;
  if (j==10) return vec2(sin(th)/r, r*cos(th));
  if (j==11) return vec2(sin(th)*cos(r), cos(th)*sin(r));
  if (j==12) { float om = (fract(t.x*12.9898 + t.y*78.233)>0.5) ? PI : 0.0; float sr=sqrt(r); return sr*vec2(cos(th*0.5+om), sin(th*0.5+om)); }
  if (j==13) return 4.0/(r2+4.0) * t;
  if (j==14) return 2.0/(r+1.0) * t;
  return exp(t.x-1.0)*vec2(cos(PI*t.y), sin(PI*t.y));   // 15 exponential
}

void main(){
  vec4 P = texture(uPts, vUv);
  uint s = pcg(uint(gl_FragCoord.x) + uint(gl_FragCoord.y)*4096u + uFrame*2654435761u);
  vec2 p = P.xy; float c = P.z; float age = P.w;

  float r = rnd(s);
  int i = 0;
  if (r > uCum[0]) i = 1;
  if (r > uCum[1]) i = 2;
  if (r > uCum[2]) i = 3;

  vec3 A = uAff[i*2], B = uAff[i*2+1];
  vec2 t = vec2(A.x*p.x + A.y*p.y + A.z, B.x*p.x + B.y*p.y + B.z);
  vec2 q = vec2(0.0);
  for (int j = 0; j < 16; j++) {
    float w = uVars[i*16 + j];
    if (w != 0.0) q += w * variation(j, t);
  }
  c = (c + uColors[i]) * 0.5;

  // audio-driven final transform: bounded variations only (bubble / swirl) so
  // the attractor breathes with the bass without blowing points off-screen
  if (uFinal.x > 0.0) q = mix(q, variation(13, q), uFinal.x);
  if (uFinal.y > 0.0) q = mix(q, variation(3, q), uFinal.y);

  // symmetry group
  if (uSym > 1.5) { float k = floor(rnd(s)*uSym); float a = TAU*k/uSym; float ca=cos(a), sa=sin(a); q = vec2(q.x*ca - q.y*sa, q.x*sa + q.y*ca); }
  if (uMirror > 0.5 && rnd(s) < 0.5) q.x = -q.x;

  age += 1.0;
  bool bad = any(isnan(q)) || any(isinf(q)) || dot(q,q) > 1.0e4;
  if (bad || rnd(s) < 0.0008) { q = vec2(rnd(s), rnd(s))*2.0-1.0; c = rnd(s); age = 0.0; }
  o = vec4(q, c, min(age, 64.0));
}`;

  S.FLAME_PLOT_VS = S.COMMON + `
uniform sampler2D uPts;
uniform int uSide;
uniform vec2 uCenter; uniform float uZoom; uniform float uRot; uniform vec2 uAspect;
uniform vec3 uPalA, uPalB, uPalC, uPalD; uniform float uHue;
uniform float uAlpha; uniform float uPointSize;
out vec4 vCol;
void main(){
  int id = gl_VertexID;
  ivec2 tc = ivec2(id % uSide, id / uSide);
  vec4 P = texelFetch(uPts, tc, 0);
  if (P.w < 16.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 1.0; vCol = vec4(0.0); return; }
  vec2 p = (P.xy - uCenter) * uZoom;
  float ca = cos(uRot), sa = sin(uRot);
  p = vec2(p.x*ca - p.y*sa, p.x*sa + p.y*ca);
  gl_Position = vec4(p * uAspect, 0.0, 1.0);
  gl_PointSize = uPointSize;
  vec3 col = pal(P.z*0.9 + uHue, uPalA, uPalB, uPalC, uPalD);
  vCol = vec4(col * uAlpha, uAlpha);
}`;

  S.POINT_FS = S.COMMON + `
in vec4 vCol; out vec4 o;
void main(){ o = vCol; }`;

  // multiply the whole target by CONSTANT_ALPHA (blend trick) — fragment outputs nothing useful
  S.ZERO_FS = S.COMMON + `
out vec4 o; void main(){ o = vec4(0.0); }`;

  // ------------------------------------------------------------------ glyph field (min-blended SDF quads)
  S.GLYPH_VS = S.COMMON + `
layout(location=0) in vec2 aPos;                // unit quad 0..1
layout(location=1) in vec4 aRect;               // x,y,w,h in field px
layout(location=2) in vec4 aUv;                 // u,v,w,h in atlas
uniform vec2 uRes;
out vec2 vUv;
void main(){
  vec2 p = aRect.xy + aPos * aRect.zw;
  vUv = aUv.xy + aPos * aUv.zw;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;
  S.GLYPH_FS = S.COMMON + `
uniform sampler2D uAtlas; in vec2 vUv; out vec4 o;
void main(){ o = vec4(texture(uAtlas, vUv).r); }`;

  // ------------------------------------------------------------------ physarum agents
  // Two populations share one texture:
  //   free  (kind < 1): classic physarum — sense/deposit a trail, graze on the flame
  //   clock (kind >= 1): a crowd packed inside the glyphs (Pikmin-title style).
  //                      They never deposit trail or read it — the clock is its own layer.
  S.AGENT_UPDATE_FS = S.COMMON + `
uniform sampler2D uAgents;     // x, y (trail px), heading, kind (0..1 free | 1..2 clock)
uniform sampler2D uTrail;
uniform vec2 uRes;             // trail map size
uniform uint uFrame;
uniform float uSA, uSD, uRA, uSS;         // sensor angle, sensor dist, turn angle, step
uniform vec4 uAudio;           // bass, beat, treble, energy
uniform float uOnset;          // 1 on the onset frame
uniform float uTime;
uniform float uRespawn;
uniform float uPx;             // trail-resolution scale (1 = 540 px tall)
uniform sampler2D uHist;       // flame histogram: free spores graze on it like food
uniform float uFood, uFoodGain;
in vec2 vUv; out vec4 o;

float sense(vec2 p){
  vec2 uv = p / uRes;
  float t = texture(uTrail, uv).r;
  float food = min(1.0, log(1.0 + texture(uHist, uv).a * uFoodGain));
  return t + food*uFood;
}

void main(){
  vec4 A = texture(uAgents, vUv);
  uint s = pcg(uint(gl_FragCoord.x)*7u + uint(gl_FragCoord.y)*4099u + uFrame*2654435761u);
  vec2 p = A.xy; float h = A.z; float kind = A.w;
  float bass = uAudio.x, beat = uAudio.y, treb = uAudio.z, energy = uAudio.w;

  // ---------------- free spores (physarum)
  float sa = uSA * (1.0 + treb*0.6);
  float sd = uSD;
  vec2 dF = vec2(cos(h), sin(h));
  vec2 dL = vec2(cos(h+sa), sin(h+sa));
  vec2 dR = vec2(cos(h-sa), sin(h-sa));
  float vF = sense(p + dF*sd), vL = sense(p + dL*sd), vR = sense(p + dR*sd);
  float ra = uRA * (1.0 + beat*0.5);
  if (vF > vL && vF > vR) { }
  else if (vF < vL && vF < vR) { h += (rnd(s) < 0.5 ? ra : -ra); }
  else if (vL > vR) h += ra;
  else if (vR > vL) h -= ra;
  h += (rnd(s)-0.5) * (0.08 + energy*0.25);

  // onset burst
  if (uOnset > 0.5 && rnd(s) < 0.35) h += (rnd(s)-0.5) * 2.4;

  float ss = uSS * (1.0 + bass*0.9 + beat*1.2);
  p += vec2(cos(h), sin(h)) * ss;
  p = mod(p, uRes);                                   // torus
  o = vec4(p, h, kind);
}`;

  // trail deposit: free spores only
  S.AGENT_DEPOSIT_VS = S.COMMON + `
uniform sampler2D uAgents;
uniform int uSide; uniform vec2 uRes; uniform float uDeposit;
out vec4 vCol;
void main(){
  int id = gl_VertexID;
  vec4 A = texelFetch(uAgents, ivec2(id % uSide, id / uSide), 0);
  vec2 uv = A.xy / uRes;
  gl_Position = vec4(uv*2.0-1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  vCol = vec4(uDeposit);
}`;

  S.TRAIL_DIFFUSE_FS = S.COMMON + `
uniform sampler2D uTrail; uniform vec2 uRes; uniform float uDecay;
in vec2 vUv; out vec4 o;
void main(){
  vec2 px = 1.0/uRes;
  float s = 0.0;
  s += texture(uTrail, vUv + px*vec2(-1,-1)).r; s += texture(uTrail, vUv + px*vec2(0,-1)).r; s += texture(uTrail, vUv + px*vec2(1,-1)).r;
  s += texture(uTrail, vUv + px*vec2(-1, 0)).r; s += texture(uTrail, vUv).r * 2.0;         s += texture(uTrail, vUv + px*vec2(1, 0)).r;
  s += texture(uTrail, vUv + px*vec2(-1, 1)).r; s += texture(uTrail, vUv + px*vec2(0, 1)).r; s += texture(uTrail, vUv + px*vec2(1, 1)).r;
  float v = (s / 10.0) * uDecay;
  o = vec4(max(v - 0.0005, 0.0));
}`;

  // sparkle: a subset of agents drawn straight into the composite as bright spores
  S.SPARKLE_VS = S.COMMON + `
uniform sampler2D uAgents; uniform int uSide; uniform int uStride; uniform vec2 uRes;
uniform vec3 uPalA, uPalB, uPalC, uPalD; uniform float uHue; uniform float uBright; uniform float uSize;
out vec4 vCol;
void main(){
  int id = gl_VertexID * uStride;
  vec4 A = texelFetch(uAgents, ivec2(id % uSide, id / uSide), 0);
  vec2 uv = A.xy / uRes;
  gl_Position = vec4(uv*2.0-1.0, 0.0, 1.0);
  gl_PointSize = uSize;
  vCol = vec4(pal(0.6 + uHue + A.z*0.05, uPalA, uPalB, uPalC, uPalD) * uBright, 1.0);
}`;
  S.SPARKLE_FS = S.COMMON + `
in vec4 vCol; out vec4 o;
void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.1, length(d)); o = vCol * a; }`;

  // ------------------------------------------------------------------ composite
  S.COMPOSITE_FS = S.COMMON + `
uniform sampler2D uHist;      // flame histogram for ONE tile (rgb = colour sum, a = density)
uniform sampler2D uTrail;     // mycelium
uniform sampler2D uField, uFieldOld; uniform float uMorph;
uniform sampler2D uClockLayer;// mold clock (R density, G veins)
uniform vec2 uMoldPx;
uniform sampler2D uPrev;      // previous composite (feedback)
uniform vec2 uRes; uniform vec2 uHistRes;
uniform float uTiles;         // mirrored flame tiles across the width
uniform float uTime;
uniform vec4 uAudio;          // bass, beat, treble, energy
uniform float uGain, uGamma, uBright;
uniform float uKaleido;       // extra fold count (0 = off)
uniform float uWarp;          // domain-warp amount
uniform float uFill;          // magnified self-similar layer that fills the corners
uniform float uFeedback, uFbZoom, uFbRot;
uniform vec3 uPalA, uPalB, uPalC, uPalD; uniform float uHue;
uniform vec3 uMycA, uMycB, uMycC, uMycD;
uniform float uClockContrast; // shadow/underlay strength behind the clock crowd
uniform float uMycGain;
uniform int uView;            // debug: 0 normal, 1 flame only, 2 trail only, 3 glyph field, 4 clock layer
in vec2 vUv; out vec4 o;
` + WE.ClockCrowd.COMPOSITE_GLSL + `

vec2 rot(vec2 p, float a){ float c=cos(a), s=sin(a); return vec2(p.x*c-p.y*s, p.x*s+p.y*c); }
float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=fract(sin(dot(i,vec2(127.1,311.7)))*43758.5453), b=fract(sin(dot(i+vec2(1,0),vec2(127.1,311.7)))*43758.5453),
        c=fract(sin(dot(i+vec2(0,1),vec2(127.1,311.7)))*43758.5453), d=fract(sin(dot(i+vec2(1,1),vec2(127.1,311.7)))*43758.5453);
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }

// log-density tone mapping (Draves) with a cheap density-estimation blur
vec3 flameAt(vec2 fuv){
  vec2 ef = smoothstep(0.0, 0.03, fuv) * smoothstep(1.0, 0.97, fuv);
  float edgeFade = ef.x * ef.y;
  vec2 hp = 1.0 / uHistRes;
  vec4 Hc = texture(uHist, fuv);
  vec4 Hn = texture(uHist, fuv + vec2(hp.x, 0.0)) + texture(uHist, fuv - vec2(hp.x, 0.0)) + texture(uHist, fuv + vec2(0.0, hp.y)) + texture(uHist, fuv - vec2(0.0, hp.y));
  float sparse = 1.0 - smoothstep(0.0, 6.0 / uGain, Hc.a);
  vec4 H = mix(Hc, (Hc + Hn) * 0.2, sparse * 0.85) * edgeFade;
  float dens = H.a;
  float k = dens > 0.0 ? log(1.0 + dens * uGain) / dens : 0.0;
  vec3 flame = H.rgb * k * uBright;
  flame = pow(max(flame, 0.0), vec3(1.0 / uGamma));
  float fl = max(flame.r, max(flame.g, flame.b));
  flame *= fl > 1e-4 ? (1.0 - exp(-fl * 1.5)) / fl : 0.0;
  return max(flame - 0.025, 0.0);
}

void main(){
  vec2 uv = vUv;
  float bass = uAudio.x, beat = uAudio.y, treb = uAudio.z, energy = uAudio.w;

  // --- mirrored tiling: each tile gets the whole flame, seams stay continuous
  float tiles = max(uTiles, 1.0);
  float tx = uv.x * tiles;
  float fx = fract(tx);
  if (mod(floor(tx), 2.0) > 0.5) fx = 1.0 - fx;
  vec2 tuv = vec2(fx, uv.y);
  float aspect = (uRes.x / tiles) / uRes.y;

  // --- domain warp + optional kaleidoscope fold (in tile space)
  vec2 q = (tuv - 0.5) * vec2(aspect, 1.0);
  float wamp = uWarp * (0.35 + bass*0.9);
  vec2 warp = vec2(n2(q*3.0 + uTime*0.15), n2(q*3.0 + 7.3 - uTime*0.12)) - 0.5;
  q += warp * wamp * 0.12;
  if (uKaleido > 0.5) {
    float a = atan(q.y, q.x), r = length(q);
    float seg = TAU / uKaleido;
    a = mod(a, seg); a = abs(a - seg*0.5);
    a += uTime*0.05;
    q = vec2(cos(a), sin(a)) * r;
  }
  vec2 fuv = q / vec2(aspect, 1.0) + 0.5;
  vec3 flame = flameAt(fuv);
  // magnified copy of the centre, slowly turning: self-similar detail for the corners
  if (uFill > 0.0) {
    vec2 q2 = rot(q, uTime*0.03 + bass*0.02) * 0.3;
    vec2 fuv2 = q2 / vec2(aspect, 1.0) + 0.5;
    flame += flameAt(fuv2) * uFill * (0.35 + 0.45 * smoothstep(0.3, 1.0, length(q)));   // mostly toward the edges
    vec2 q3 = rot(q, -uTime*0.05) * 0.12;                                                  // and a tighter one for the centre
    flame += flameAt(q3 / vec2(aspect, 1.0) + 0.5) * uFill * 0.6 * (1.0 - smoothstep(0.0, 0.4, length(q)));
  }

  // --- mycelium
  float t = max(texture(uTrail, uv).r * uMycGain - 0.06, 0.0);   // floor: no fog from faint traces
  float body = 1.0 - exp(-t * 1.3);
  vec3 myc = pal(t*0.25 + uHue*0.5 + 0.1, uMycA, uMycB, uMycC, uMycD) * body;
  myc += vec3(1.0, 0.95, 0.85) * smoothstep(3.0, 7.0, t) * 0.6;        // white-hot hyphae cores

  vec3 col = flame + myc * (1.0 + beat*0.35);
  if (uView == 1) { o = vec4(flame, 1.0); return; }
  if (uView == 2) { o = vec4(myc, 1.0); return; }

  // --- feedback (video-echo / tunnel)
  vec2 fb = uv - 0.5; float fa = uRes.x / uRes.y; fb = rot(fb * vec2(fa,1.0), uFbRot + bass*0.004) / vec2(fa,1.0);
  fb = fb * (1.0 - uFbZoom - bass*0.006) + 0.5;
  vec2 pf = smoothstep(0.0, 0.02, fb) * smoothstep(1.0, 0.98, fb);
  vec3 prev = texture(uPrev, fb).rgb * pf.x * pf.y;
  prev = mix(prev, prev.gbr, 0.05 + beat*0.05);        // slow hue drift along the echo
  col += prev * uFeedback * 0.9;
  col = min(col, vec3(8.0));

  // --- mold clock on top: its own simulation, never mixed into the scene
  float f = mix(texture(uFieldOld, uv).r, texture(uField, uv).r, uMorph);
  if (uView == 3) { o = vec4(vec3(f), 1.0); return; }
  if (uView == 4) { vec2 M = texture(uClockLayer, uv).rg; o = vec4(M.r, M.g, 0.0, 1.0); return; }
  col = clockComposite(col, f, uClockLayer, uv, uMoldPx, uMycA, uMycB, uMycC, uMycD, uHue, uClockContrast, uTime);
  o = vec4(col, 1.0);
}`;

  // ------------------------------------------------------------------ bloom + final
  S.DOWNSAMPLE_FS = S.COMMON + `
uniform sampler2D uSrc; uniform vec2 uRes; uniform float uThresh;
in vec2 vUv; out vec4 o;
void main(){
  vec2 px = 1.0/uRes;
  vec3 c = texture(uSrc, vUv + px*vec2(-0.5,-0.5)).rgb + texture(uSrc, vUv + px*vec2(0.5,-0.5)).rgb
         + texture(uSrc, vUv + px*vec2(-0.5, 0.5)).rgb + texture(uSrc, vUv + px*vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float l = dot(c, vec3(0.299,0.587,0.114));
  o = vec4(c * smoothstep(uThresh, uThresh + 0.6, l), 1.0);
}`;
  S.BLUR_FS = S.COMMON + `
uniform sampler2D uSrc; uniform vec2 uDir;
in vec2 vUv; out vec4 o;
void main(){
  vec3 c = texture(uSrc, vUv).rgb * 0.2270270270;
  c += texture(uSrc, vUv + uDir*1.3846153846).rgb * 0.3162162162;
  c += texture(uSrc, vUv - uDir*1.3846153846).rgb * 0.3162162162;
  c += texture(uSrc, vUv + uDir*3.2307692308).rgb * 0.0702702703;
  c += texture(uSrc, vUv - uDir*3.2307692308).rgb * 0.0702702703;
  o = vec4(c, 1.0);
}`;
  S.FINAL_FS = S.COMMON + `
uniform sampler2D uComp, uBloom;
uniform vec2 uRes; uniform float uTime; uniform vec4 uAudio;
uniform float uBloomAmt, uCA, uGrain;
uniform vec4 uMon[4]; uniform int uNMon;   // monitor rects in uv for per-screen vignette
in vec2 vUv; out vec4 o;
vec3 tonemap(vec3 x){ return x / (1.0 + x) * 1.25; }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
void main(){
  float beat = uAudio.y;
  // find this pixel's monitor for the vignette center
  vec2 c = vec2(0.5); vec2 sz = vec2(1.0);
  for (int i = 0; i < 4; i++) { if (i >= uNMon) break; vec4 m = uMon[i]; if (vUv.x >= m.x && vUv.x <= m.x+m.z && vUv.y >= m.y && vUv.y <= m.y+m.w) { c = m.xy + m.zw*0.5; sz = m.zw; } }
  vec2 d = (vUv - c) / sz;                       // -0.5..0.5 within the monitor
  float ca = uCA * (0.4 + beat*1.6) / uRes.x;
  vec2 dir = d * 2.0;
  vec3 col;
  col.r = texture(uComp, vUv + dir*ca*2.0).r;
  col.g = texture(uComp, vUv).g;
  col.b = texture(uComp, vUv - dir*ca*2.0).b;
  col += texture(uBloom, vUv).rgb * uBloomAmt * (1.0 + beat*0.6);
  col = tonemap(col);
  float vig = 1.0 - smoothstep(0.45, 1.05, length(d) * 1.1);
  col *= mix(0.8, 1.0, vig);
  col += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
  col = pow(max(col, 0.0), vec3(1.0/1.1));
  o = vec4(col, 1.0);
}`;

  window.MYCELIA_SHADERS = S;
})();
