/* WE.ClockCrowd — the slime-mold clock (Physarum polycephalum look).
 *
 * The time / seconds / date glyphs of every monitor become distance fields. A growth
 * field spreads through each glyph by contagion from random seeds (lobed fronts;
 * seconds grow fastest, big digits slowest) and dies back where a digit changed.
 * Inside the grown area the composite draws a two-scale animated cellular vein
 * network — thick yellow trunks, a fine mesh, dark polygonal gaps — whose cells
 * drift slowly and pulse like shuttle streaming, with a translucent sheet at the fronts.
 *
 *   const clock = new WE.ClockCrowd(gl);
 *   clock.alloc({ fieldW, fieldH });                    // simulation resolution (≈ half render res)
 *   clock.layout(monitors, { fullW, fullH, scale, x, y, showSeconds, showDate, hour24 });
 *   each frame: clock.setTime(); clock.update(dt, { beat, bass });
 *   composite: clock.field / clock.fieldOld / clock.morph, clock.layer (R growth 0..1, G rate), clock.texel
 *              through WE.ClockCrowd.COMPOSITE_GLSL -> clockComposite(...)
 *
 * Requires wallpaper-sdk.js (WE.GL, WE.Glyphs, WE.Clock).
 */
(function () {
  'use strict';
  const WE = window.WE;
  const G = WE.GL;

  const COMMON = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
#define PI 3.141592653589793
#define TAU 6.283185307179586
uint pcg(uint v){ v = v*747796405u + 2891336453u; uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (w >> 22u) ^ w; }
float rnd(inout uint s){ s = pcg(s); return float(s) * (1.0/4294967296.0); }
vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a + b*cos(TAU*(c*t+d)); }
float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=fract(sin(dot(i,vec2(127.1,311.7)))*43758.5453), b=fract(sin(dot(i+vec2(1,0),vec2(127.1,311.7)))*43758.5453),
        c=fract(sin(dot(i+vec2(0,1),vec2(127.1,311.7)))*43758.5453), d=fract(sin(dot(i+vec2(1,1),vec2(127.1,311.7)))*43758.5453);
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
`;

  // glyph field: R = signed distance (0.5 = edge), G = 1 - growth rate (min-blended like the distance)
  const GLYPH_VS = COMMON + `
layout(location=0) in vec2 aPos; layout(location=1) in vec4 aRect; layout(location=2) in vec4 aUv; layout(location=3) in float aRate;
uniform vec2 uRes; out vec2 vUv; out float vRate;
void main(){ vec2 p = aRect.xy + aPos * aRect.zw; vUv = aUv.xy + aPos * aUv.zw; vRate = aRate; gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0); }`;
  const GLYPH_FS = COMMON + `
uniform sampler2D uAtlas; in vec2 vUv; in float vRate; out vec4 o;
void main(){ float d = texture(uAtlas, vUv).r; o = vec4(d, d < 0.6 ? 1.0 - vRate : 1.0, 1.0, 1.0); }`;

  // growth by contagion, confined to the glyph
  const GROW_FS = COMMON + `
uniform sampler2D uMold;               // R growth 0..1, G rate
uniform sampler2D uField, uFieldOld; uniform float uMorph;
uniform vec2 uRes; uniform float uDt; uniform float uTime; uniform uint uFrame;
uniform float uGrow, uSeed, uDie; uniform vec2 uAudio;
in vec2 vUv; out vec4 o;
void main(){
  vec2 px = 1.0 / uRes;
  vec4 F = mix(texture(uFieldOld, vUv), texture(uField, vUv), uMorph);
  float f = F.r, rate = 1.0 - F.g;
  float inside = smoothstep(0.50, 0.465, f);
  float m = texture(uMold, vUv).r;
  float nb = 0.0;
  for (int i = 0; i < 8; i++) { float a = float(i) * TAU / 8.0; nb += texture(uMold, vUv + vec2(cos(a), sin(a)) * px * 2.0).r; }
  nb /= 8.0;
  uint s = pcg(uint(gl_FragCoord.x) * 7u + uint(gl_FragCoord.y) * 4099u + uFrame * 2654435761u);
  vec2 q = vUv * uRes;
  float front = 0.35 + 1.2 * n2(q * 0.09 + uTime * 0.2) * n2(q * 0.21 - uTime * 0.13);   // lobed, uneven fronts
  float grow = nb * (1.0 - m) * uGrow * rate * front * (1.0 + uAudio.y * 0.8) * uDt;
  float seed = (rnd(s) < uSeed * rate * uDt) ? 0.3 : 0.0;
  m += (grow + seed) * inside;
  m -= m * uDie * uDt * (1.0 - inside);
  o = vec4(clamp(m, 0.0, 1.0), rate, 0.0, 1.0);
}`;
  const INIT_FS = COMMON + `
uniform sampler2D uField; in vec2 vUv; out vec4 o;
void main(){ vec4 F = texture(uField, vUv); float inside = smoothstep(0.50, 0.465, F.r); o = vec4(inside, 1.0 - F.g, 0.0, 1.0); }`;

  // GLSL for the wallpaper's composite. Inputs: scene colour, field sample f (mixed),
  // mold layer sample M (rg), layer texel size, uv, palette, hue, contrast, time.
  const COMPOSITE_GLSL = `
float cn2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=fract(sin(dot(i,vec2(127.1,311.7)))*43758.5453), b=fract(sin(dot(i+vec2(1,0),vec2(127.1,311.7)))*43758.5453),
        c=fract(sin(dot(i+vec2(0,1),vec2(127.1,311.7)))*43758.5453), d=fract(sin(dot(i+vec2(1,1),vec2(127.1,311.7)))*43758.5453);
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
vec2 ch2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
// animated Worley: returns (F1, F2 - F1); cell points wander slowly so the mesh reorganises
vec2 worley(vec2 p, float t){
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 h = ch2(ip + g);
    vec2 pt = g + 0.5 + 0.38 * sin(t * (0.35 + 0.45 * h) + h * 6.2831);
    float d = length(pt - fp);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return vec2(f1, f2 - f1);
}
// vein mask + a pseudo-height for shading. cell = cell size in px, width = vein half-width in px
float veinAt(vec2 px, float cell, float width, float t){
  vec2 w = worley(px / cell, t);
  return 1.0 - smoothstep(0.0, width / cell, w.y);
}
vec3 clockComposite(vec3 col, float f, sampler2D moldTex, vec2 uv, vec2 moldPx, vec3 mA, vec3 mB, vec3 mC, vec3 mD, float hue, float contrast, float time){
  if (f > 0.99) return col;                                   // nowhere near the clock: free
  vec2 M = texture(moldTex, uv).rg;
  float m = M.r, rate = M.g;
  float halo = smoothstep(0.98, 0.5, f);
  col *= 1.0 - halo * 0.6 * contrast;
  float insideM = smoothstep(0.5, 0.46, f);
  vec3 deep = vec3(0.38, 0.30, 0.03), yel = vec3(0.98, 0.86, 0.14), hi = vec3(1.0, 0.98, 0.60);
  // underlay: the digit is always readable as a dark olive shape
  col = mix(col, deep * 0.55, insideM * 0.8 * contrast);
  float grown = smoothstep(0.08, 0.6, m);
  // --- vein network (pixel units at a 1080-tall screen)
  vec2 px = uv / moldPx * 2.0;                                 // field is half res -> px ≈ render px
  float ts = time * (0.6 + rate);                              // seconds line reorganises faster
  float fine = veinAt(px + 13.7, 6.5, 1.7, ts);
  float trunk = veinAt(px, 17.0, 3.4, ts * 0.6);
  float vein = max(fine * 0.85, trunk);
  vein *= 0.75 + 0.25 * cn2(px * 0.08 + time * 0.05);        // some veins thinner / fainter
  // shuttle streaming: brightness travelling along the veins
  float pulse = 0.85 + 0.15 * sin(px.x * 0.11 + px.y * 0.07 - time * 2.2 * (0.5 + rate));
  // tube shading from the vein's own profile
  float vx = veinAt(px + vec2(1.2, 0.0), 17.0, 3.4, ts * 0.6) - veinAt(px - vec2(1.2, 0.0), 17.0, 3.4, ts * 0.6);
  float vy = veinAt(px + vec2(0.0, 1.2), 17.0, 3.4, ts * 0.6) - veinAt(px - vec2(0.0, 1.2), 17.0, 3.4, ts * 0.6);
  vec3 nrm = normalize(vec3(-vx * 1.5, -vy * 1.5, 1.0));
  float shade = 0.6 + 0.55 * max(dot(nrm, normalize(vec3(-0.4, 0.65, 0.65))), 0.0);
  float grain = 0.9 + 0.1 * cn2(px * 0.9 + time * 0.1);
  // sheet: translucent plasmodium between the veins, strongest at the growing front
  float frontZone = smoothstep(0.08, 0.35, m) * (1.0 - smoothstep(0.35, 0.8, m));
  float sheetA = insideM * (0.42 * grown + 0.6 * frontZone);
  col = mix(col, yel * 0.5, sheetA);
  // veins appear as the colony grows (edges first, then the mesh fills in)
  float veinA = insideM * grown * vein * pulse;
  vec3 veinCol = mix(deep, yel, 0.55 + 0.45 * trunk) * shade * grain;
  veinCol = mix(veinCol, hi, trunk * 0.35 * shade);
  return mix(col, veinCol * 1.9, clamp(veinA, 0.0, 1.0));
}`;

  class ClockCrowd {
    constructor(gl, opts = {}) {
      this.gl = gl;
      this.atlas = opts.atlas || WE.Glyphs.build({ cellW: 112, cellH: 144, spread: 22 });
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.atlasTex = G.texture(gl, this.atlas.width, this.atlas.height, 'r8', { data: this.atlas.data, filter: gl.LINEAR });
      this.P = {
        glyph: G.program(gl, GLYPH_VS, GLYPH_FS, 'clock-glyph'),
        grow: G.program(gl, G.QUAD_VS, GROW_FS, 'clock-grow'),
        init: G.program(gl, G.QUAD_VS, INIT_FS, 'clock-init'),
      };
      this.quad = G.quad(gl);
      this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
      const ub = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ub);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.instBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, 96 * 9 * 4, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 36, 0); gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 36, 16); gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 36, 32); gl.vertexAttribDivisor(3, 1);
      gl.bindVertexArray(null);
      this.R = {}; this.rects = []; this.string = ''; this.morph = 1; this.ready = false; this.frame = 0; this.time = 0;
      this.opts = { scale: 1, x: 0.5, y: 0.5, showSeconds: true, showDate: true, hour24: false };
      this.speed = WE.query && WE.query.get('clockspeed') ? +WE.query.get('clockspeed') : 1;   // overall speed multiplier
    }

    destroy() {
      const gl = this.gl;
      for (const k of Object.keys(this.R)) { const v = this.R[k]; if (!v) continue; if (v.a && v.b) { G.destroyTarget(gl, v.a); G.destroyTarget(gl, v.b); } else G.destroyTarget(gl, v); }
      this.R = {};
    }

    /** fieldW/H: simulation resolution (≈ half render res). Agents are sized from the glyph area in layout(). */
    alloc({ fieldW, fieldH, agentSide }) {
      const gl = this.gl;
      const old = this.R.mold ? this.R.mold.read : null;
      const keep = old ? { f: old.f, w: old.w, h: old.h } : null;
      const R = {};
      this.fw = fieldW; this.fh = fieldH;
      R.field = G.target(gl, fieldW, fieldH, 'rgba8');
      R.fieldOld = G.target(gl, fieldW, fieldH, 'rgba8');
      R.mold = G.pingpong(gl, fieldW, fieldH, 'rgba16f');
      for (const t of [R.field, R.fieldOld]) { G.bind(gl, t); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      for (const t of [R.mold.a, R.mold.b]) { G.bind(gl, t); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      if (keep) {   // carry the existing network over so a quality-tier change never blinks the clock
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, keep.f); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, R.mold.a.f);
        gl.blitFramebuffer(0, 0, keep.w, keep.h, 0, 0, fieldW, fieldH, gl.COLOR_BUFFER_BIT, gl.LINEAR);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      this.destroy();
      this.R = R;
      this.keptTrail = !!keep;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.string = ''; this.ready = false;
      if (this.monitors) this.layout(this.monitors, this.layoutOpts);
    }
    get field() { return this.R.field; }
    get fieldOld() { return this.R.fieldOld; }
    /** RG16F: R = growth 0..1, G = line rate. Same resolution as the field. */
    get layer() { return this.R.mold ? this.R.mold.read : null; }
    get spread() { return this.rects.length ? this.atlas.spread * this.rects[0].Ch / this.atlas.cellH : 20; }
    get texel() { return [1 / this.fw, 1 / this.fh]; }

    /** monitors: [{x,y,w,h}] in full-res px (y down); opts: fullW, fullH, scale, x (0..1 across), y (0..1 down) */
    layout(monitors, opts) {
      this.monitors = monitors; this.layoutOpts = opts;
      Object.assign(this.opts, opts);
      this.rects = [];
      if (!this.R.field) return;
      const k = this.fw / opts.fullW;
      for (const m of monitors) {
        const x0 = m.x * k, w = m.w * k, h = m.h * k, y0 = this.fh - (m.y + m.h) * k;
        const Ch = h * 0.26 * (opts.scale || 1);
        const Cw = Ch * this.atlas.cellW / this.atlas.cellH;
        this.rects.push({ mon: m, x0, y0, w, h, Ch, Cw, cx: x0 + w * (opts.x == null ? 0.5 : opts.x), cy: y0 + h * (1 - (opts.y == null ? 0.5 : opts.y)) });
      }
      this.string = ''; this.ready = false;
    }

    _measure(str, size, Cw) { let w = 0; for (const ch of str) w += (ch === ' ' ? 0.28 : (this.atlas.advance[ch] || 0.55) + 0.04) * Cw * size; return w; }
    _emit(out, str, size, cx, cy, cr, rate) {
      const Cw = cr.Cw * size, Ch = cr.Ch * size;
      let x = cx - this._measure(str, size, cr.Cw) / 2;
      for (const ch of str) {
        const adv = (ch === ' ' ? 0.28 : (this.atlas.advance[ch] || 0.55) + 0.04) * Cw;
        const g = this.atlas.map[ch];
        if (g) out.push(x + adv / 2 - Cw / 2, cy - Ch / 2, Cw, Ch, g.u, g.v + g.h, g.w, -g.h, rate);
        x += adv;
      }
    }

    _renderField(target, str) {
      const gl = this.gl, inst = [];
      const parts = str.split('|');
      for (const cr of this.rects) {
        const gap = cr.Ch * 0.05;
        const line2 = this.opts.showDate ? 0.34 : 0;
        const total = cr.Ch + (line2 ? gap + cr.Ch * line2 : 0);
        const top = cr.cy + total / 2, y1 = top - cr.Ch / 2;
        const time = parts[0], sec = this.opts.showSeconds ? parts[1] : '';
        const secSize = 0.42;
        const wTime = this._measure(time, 1, cr.Cw), wSec = sec ? this._measure(sec, secSize, cr.Cw) + cr.Cw * 0.12 : 0;
        const blockW = Math.max(wTime + wSec, line2 ? this._measure(parts[2], line2, cr.Cw) : 0);
        const cx = Math.min(Math.max(cr.cx, cr.x0 + blockW / 2 + cr.Cw * 0.3), cr.x0 + cr.w - blockW / 2 - cr.Cw * 0.3);
        const startX = cx - (wTime + wSec) / 2;
        // growth rates: big digits slow (they change once a minute), seconds fast, date medium
        this._emit(inst, time, 1, startX + wTime / 2, y1, cr, 0.32);
        if (sec) this._emit(inst, sec, secSize, startX + wTime + cr.Cw * 0.12 + this._measure(sec, secSize, cr.Cw) / 2, y1 - cr.Ch * (1 - secSize) * 0.28, cr, 1.0);
        if (line2) this._emit(inst, parts[2], line2, cx, top - cr.Ch - gap - cr.Ch * line2 / 2, cr, 0.5);
        const bw = blockW * 1.15, bh = total * 1.25;
        cr.rect = [cx - bw / 2, cr.cy - bh / 2, bw, bh];
      }
      const n = Math.min(96, inst.length / 9);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(inst.slice(0, n * 9)));
      G.bind(gl, target);
      gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.P.glyph.p);
      gl.uniform2f(this.P.glyph.u.uRes, target.w, target.h);
      G.tex(gl, 0, this.atlasTex, this.P.glyph.u.uAtlas);
      gl.enable(gl.BLEND); gl.blendEquation(gl.MIN); gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
      gl.bindVertexArray(null);
      gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
    }

    _init() {   // start fully grown (first frame and after a re-allocation): never a blink
      const gl = this.gl;
      G.bind(gl, this.R.mold.write);
      gl.useProgram(this.P.init.p);
      G.tex(gl, 0, this.R.field.tex, this.P.init.u.uField);
      gl.bindVertexArray(this.quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      this.R.mold.swap();
    }

    /** Call every frame; re-renders the glyph field only when the displayed string changes. */
    setTime() {
      const c = WE.Clock.now({ hour24: this.opts.hour24 });
      const str = `${c.time}|${c.ss}|${c.day} · ${c.date}`;
      if (str === this.string || !this.R.field) return false;
      if (!this.ready) { this._renderField(this.R.field, str); this._renderField(this.R.fieldOld, str); this.morph = 1; this.ready = true; if (!this.keptTrail) this._init(); this.keptTrail = false; }
      else { const t = this.R.field; this.R.field = this.R.fieldOld; this.R.fieldOld = t; this._renderField(this.R.field, str); this.morph = 0; }
      this.string = str;
      return true;
    }

    update(dt, { beat = 0, bass = 0 } = {}) {
      const gl = this.gl;
      if (!this.R.mold || !this.ready) return;
      this.frame++; this.time += dt;
      if (this.morph < 1) this.morph = Math.min(1, this.morph + dt / 0.35);
      const P = this.P.grow;
      G.bind(gl, this.R.mold.write);
      gl.useProgram(P.p);
      G.tex(gl, 0, this.R.mold.read.tex, P.u.uMold);
      G.tex(gl, 1, this.R.field.tex, P.u.uField);
      G.tex(gl, 2, this.R.fieldOld.tex, P.u.uFieldOld);
      gl.uniform1f(P.u.uMorph, WE.util.smooth(this.morph));
      gl.uniform2f(P.u.uRes, this.fw, this.fh);
      gl.uniform1f(P.u.uDt, Math.min(dt, 0.05) * this.speed);
      gl.uniform1f(P.u.uTime, this.time);
      gl.uniform1ui(P.u.uFrame, this.frame >>> 0);
      gl.uniform1f(P.u.uGrow, 7.0);
      gl.uniform1f(P.u.uSeed, 0.03);
      gl.uniform1f(P.u.uDie, 4.0);
      gl.uniform2f(P.u.uAudio, bass, beat);
      gl.bindVertexArray(this.quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      this.R.mold.swap();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    /** kept for API compatibility: the colony is drawn by the composite, nothing to do here */
    draw() {}
  }
  ClockCrowd.COMPOSITE_GLSL = COMPOSITE_GLSL;
  WE.ClockCrowd = ClockCrowd;
})();
