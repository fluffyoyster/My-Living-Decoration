/* Wallpaper SDK — shared by every wallpaper package.
 *
 *   WE.boot(manifestUrl)      -> Promise<ctx>   host context (monitors, props, settings) or browser fallbacks
 *   WE.Audio                   system-audio / mic / synthetic analysis: bands, bass/mid/treble, beat, onset, bpm
 *   WE.Clock                   time/date strings
 *   WE.Glyphs                  signed-distance-field atlas for A-Z 0-9 : · , / (CPU 8SSEDT)
 *   WE.GL                      WebGL2 helpers: programs, float textures, FBOs, ping-pong, fullscreen quad
 *   WE.Governor                adaptive quality tiers + FPS cap + pause handling
 *   WE.Loop                    render loop wiring (pause/resume/visibility/stats)
 *
 * Works inside the Electron host (window.host present) and in a plain browser /
 * headless Chromium (?fakeaudio=1 for a synthetic music signal).
 */
(function () {
  'use strict';
  const WE = {};
  const q = new URLSearchParams(location.search);
  WE.query = q;
  WE.hasHost = typeof window.host !== 'undefined';
  WE.log = (...a) => { console.log('[we]', ...a); if (WE.hasHost) { try { window.host.log(a.map(String).join(' ')); } catch (_) {} } };

  // ------------------------------------------------------------------ boot / host context
  // opts.defaults: prop defaults (the host also fills these from wallpaper.json,
  // but a plain-browser preview has no host, so wallpapers pass them here too).
  WE.boot = async function (opts = {}) {
    const defaults = opts.defaults || {};
    const manifest = opts.manifest || null;

    let ctx = null;
    if (WE.hasHost) { try { ctx = await window.host.getContext(); } catch (e) { WE.log('host context failed', e); } }
    if (!ctx) {
      const w = window.innerWidth, h = window.innerHeight;
      const split = q.get('monitors') ? parseInt(q.get('monitors'), 10) : 1;   // ?monitors=2 simulates a spanned dual setup
      const mons = [];
      for (let i = 0; i < split; i++) mons.push({ index: i, key: 'dev' + i, primary: i === 0, x: Math.round(i * w / split), y: 0, w: Math.round(w / split), h, name: 'Dev ' + i });
      ctx = { wallpaperId: manifest ? manifest.id : null, layout: split > 1 ? 'span' : 'per-monitor', slot: { id: 'dev', key: 'dev', width: w, height: h }, monitors: mons, covered: [], props: {}, settings: { audioSource: q.get('fakeaudio') ? 'fake' : 'mic', quality: q.get('quality') || 'auto', fpsCap: 60 }, preview: !!q.get('preview'), debug: !!q.get('debug') };
    }
    ctx.props = Object.assign({}, defaults, ctx.props || {});
    // ?p.<name>=<value> overrides a prop (tuning / screenshots)
    for (const [k, v] of q.entries()) if (k.startsWith('p.')) { const n = k.slice(2); ctx.props[n] = (v === 'true' || v === 'false') ? v === 'true' : (isNaN(+v) ? v : +v); }
    if (q.get('fakeaudio')) ctx.settings = Object.assign({}, ctx.settings, { audioSource: 'fake' });
    if (q.get('quality')) ctx.settings = Object.assign({}, ctx.settings, { quality: q.get('quality') });
    WE.ctx = ctx;
    WE.manifest = manifest;
    return ctx;
  };

  // ------------------------------------------------------------------ audio
  const NB = 24;                       // bands
  const FMIN = 35, FMAX = 16000;

  class Audio {
    constructor() {
      this.bands = new Float32Array(NB);       // smoothed, normalized 0..1+
      this.raw = new Float32Array(NB);         // normalized, unsmoothed (for flux)
      this.prevRaw = new Float32Array(NB);
      this.bass = 0; this.mid = 0; this.treble = 0; this.energy = 0;
      this.beat = 0; this.onset = false; this.kick = 0; this.bpm = 0; this.silent = true;
      this.level = 0;                          // slow AGC reference
      this.source = 'none'; this.status = 'idle';
      this.flux = new Float32Array(64); this.fluxI = 0; this.lastOnset = 0; this.onsets = [];
      this.time = 0; this.ambient = 0;
      this._ctx = null; this._an = null; this._stream = null; this._db = null; this._ranges = null;
      this._fake = null;
      this.gain = 1;
    }

    async start(source) {
      this.stop();
      this.source = source || 'system';
      this.status = 'starting';
      if (this.source === 'fake') { this._fake = { t: 0, bpm: 124 }; this.status = 'ok'; return true; }
      try {
        let stream;
        if (this.source === 'mic') {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
        } else {
          // Electron: the main process answers this with the Windows loopback device.
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
          for (const t of stream.getVideoTracks()) t.stop();
          if (!stream.getAudioTracks().length) throw new Error('no system audio track');
        }
        this._stream = stream;
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        this._ctx = ctx;
        ctx.onstatechange = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 4096;                     // ~11.7 Hz per bin at 48 kHz: real bass resolution
        an.smoothingTimeConstant = 0;          // we do our own smoothing
        an.minDecibels = -100; an.maxDecibels = -10;
        src.connect(an);
        this._an = an;
        this._db = new Float32Array(an.frequencyBinCount);
        this._ranges = Audio.binRanges(an.frequencyBinCount, ctx.sampleRate);
        this.status = 'ok';
        WE.log('audio source:', this.source, ctx.sampleRate + 'Hz');
        return true;
      } catch (e) {
        this.status = 'failed: ' + (e && e.message || e);
        WE.log('audio failed (' + this.source + '):', e && e.message || e);
        // Fall back to ambient (silent) mode; retry later from the loop.
        this._retryAt = performance.now() + 15000;
        return false;
      }
    }

    stop() {
      try { if (this._stream) for (const t of this._stream.getTracks()) t.stop(); } catch (_) {}
      try { if (this._ctx) this._ctx.close(); } catch (_) {}
      this._stream = null; this._ctx = null; this._an = null; this._fake = null;
      this.status = 'idle';
    }

    static binRanges(n, rate) {
      const ranges = [];
      const nyq = rate / 2;
      for (let i = 0; i < NB; i++) {
        const f0 = FMIN * Math.pow(FMAX / FMIN, i / NB), f1 = FMIN * Math.pow(FMAX / FMIN, (i + 1) / NB);
        let b0 = Math.floor(f0 / nyq * n), b1 = Math.max(b0 + 1, Math.floor(f1 / nyq * n));
        ranges.push([Math.min(b0, n - 1), Math.min(b1, n)]);
      }
      return ranges;
    }

    /** Call once per frame with dt in seconds. */
    update(dt) {
      this.time += dt;
      const raw = this.raw;
      this.prevRaw.set(raw);
      if (this._fake) this._fakeBands(dt, raw);
      else if (this._an) this._realBands(raw);
      else {
        raw.fill(0);
        if (this._retryAt && performance.now() > this._retryAt) { this._retryAt = 0; this.start(this.source); }
      }

      // --- global automatic gain: slow-decaying peak of the overall level
      let sum = 0; for (let i = 0; i < NB; i++) sum += raw[i];
      const inst = sum / NB;
      if (inst > this.level) this.level += (inst - this.level) * Math.min(1, dt * 4);
      else this.level -= this.level * Math.min(1, dt * 0.08);   // ~12 s half-ish life
      const ref = Math.max(this.level, 0.02);
      this.silent = inst < 0.004;

      // --- normalized + smoothed bands (fast attack, slower release)
      const a = 1 - Math.exp(-dt * 30), r = 1 - Math.exp(-dt * 8);
      let bass = 0, mid = 0, treb = 0;
      for (let i = 0; i < NB; i++) {
        const v = Math.min(1.6, raw[i] / ref * this.gain);
        const s = this.bands[i];
        this.bands[i] = v > s ? s + (v - s) * a : s + (v - s) * r;
        if (i < 6) bass += this.bands[i]; else if (i < 16) mid += this.bands[i]; else treb += this.bands[i];
      }
      this.bass = bass / 6; this.mid = mid / 10; this.treble = treb / 8;
      this.energy = 0.5 * this.bass + 0.3 * this.mid + 0.2 * this.treble;

      // --- onset detection: spectral flux vs adaptive threshold
      let flux = 0, bflux = 0;
      for (let i = 0; i < NB; i++) {
        const d = raw[i] / ref - this.prevRaw[i] / ref;
        if (d > 0) { flux += d; if (i < 6) bflux += d; }
      }
      const hist = this.flux;
      let mean = 0; for (let i = 0; i < hist.length; i++) mean += hist[i]; mean /= hist.length;
      const thresh = mean * 1.6 + 0.08;
      hist[this.fluxI] = flux; this.fluxI = (this.fluxI + 1) % hist.length;
      const now = this.time;
      this.onset = false;
      if (flux > thresh && now - this.lastOnset > 0.11 && !this.silent) {
        this.onset = true; this.lastOnset = now;
        this.beat = 1;
        this.onsets.push(now); if (this.onsets.length > 48) this.onsets.shift();
        this._estimateBpm();
      } else {
        this.beat *= Math.exp(-dt * 6);
      }
      const kickNow = Math.min(1, bflux * 1.5);
      this.kick = kickNow > this.kick ? kickNow : this.kick * Math.exp(-dt * 5);

      // ambient LFO so visuals never fully die in silence
      this.ambient = 0.5 + 0.5 * Math.sin(this.time * 0.35) * Math.sin(this.time * 0.11 + 1.3);
    }

    _realBands(raw) {
      const an = this._an, db = this._db;
      an.getFloatFrequencyData(db);
      const R = this._ranges;
      for (let i = 0; i < NB; i++) {
        const [b0, b1] = R[i];
        let s = 0;
        for (let b = b0; b < b1; b++) s += Math.pow(10, db[b] / 20);   // dB -> linear amplitude
        // tilt: give highs a little more weight so treble bands reach the same range as bass
        raw[i] = (s / (b1 - b0)) * (1 + i * 0.12);
      }
    }

    _fakeBands(dt, raw) {
      const f = this._fake; f.t += dt;
      const beatLen = 60 / f.bpm, ph = (f.t % beatLen) / beatLen, bar = Math.floor(f.t / beatLen) % 4;
      const kick = Math.exp(-ph * 9), snare = (bar % 2 === 1) ? Math.exp(-ph * 12) : 0;
      const hat = Math.exp(-((f.t % (beatLen / 2)) / (beatLen / 2)) * 14) * 0.6;
      const pad = 0.35 + 0.25 * Math.sin(f.t * 0.7) + 0.15 * Math.sin(f.t * 2.3);
      for (let i = 0; i < NB; i++) {
        const x = i / (NB - 1);
        let v = 0.02;
        v += kick * Math.exp(-Math.pow((x - 0.05) / 0.12, 2)) * 0.9;
        v += snare * Math.exp(-Math.pow((x - 0.45) / 0.2, 2)) * 0.6;
        v += hat * Math.exp(-Math.pow((x - 0.9) / 0.15, 2)) * 0.5;
        v += pad * Math.exp(-Math.pow((x - 0.3) / 0.25, 2)) * 0.25;
        v += (Math.random() * 0.03);
        raw[i] = v * 0.08;
      }
    }

    _estimateBpm() {
      const o = this.onsets; if (o.length < 8) return;
      const iv = [];
      for (let i = 1; i < o.length; i++) { let d = o[i] - o[i - 1]; if (d < 0.2) continue; while (d < 0.33) d *= 2; while (d > 1.0) d /= 2; iv.push(d); }
      if (iv.length < 5) return;
      iv.sort((a, b) => a - b);
      const med = iv[iv.length >> 1];
      const bpm = 60 / med;
      this.bpm = this.bpm ? this.bpm * 0.8 + bpm * 0.2 : bpm;
    }
  }
  Audio.NB = NB;
  WE.Audio = Audio;

  // ------------------------------------------------------------------ clock
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const DAYS_LONG = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  WE.Clock = {
    now(opts = {}) {
      const d = new Date();
      let h = d.getHours(); const ampm = h >= 12 ? 'PM' : 'AM';
      if (!opts.hour24) { h = h % 12; if (h === 0) h = 12; }
      const hh = opts.hour24 ? String(h).padStart(2, '0') : String(h);
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const day = opts.longDay ? DAYS_LONG[d.getDay()] : DAYS[d.getDay()];
      const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
      return { hh, mm, ss, ampm, day, date, year: String(d.getFullYear()), time: `${hh}:${mm}`, ms: d.getMilliseconds() };
    },
  };

  // ------------------------------------------------------------------ glyph SDF atlas
  // Renders each character with Canvas 2D, then computes a signed distance
  // field with the 8-point Sequential Euclidean Distance Transform (8SSEDT).
  // Stored as R8: 0.5 = glyph edge, <0.5 inside, 1.0 far outside.
  WE.Glyphs = {
    CHARS: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ:·,/.-',
    build(opts = {}) {
      const cellW = opts.cellW || 112, cellH = opts.cellH || 144, spread = opts.spread || 22;
      const font = opts.font || `900 ${Math.round(cellH * 0.66)}px "Segoe UI Black", "Segoe UI", "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;
      const chars = opts.chars || this.CHARS;
      const cols = Math.ceil(Math.sqrt(chars.length)), rows = Math.ceil(chars.length / cols);
      const W = cols * cellW, H = rows * cellH;
      const cv = document.createElement('canvas'); cv.width = cellW; cv.height = cellH;
      const g = cv.getContext('2d', { willReadFrequently: true });
      const atlas = new Uint8Array(W * H).fill(255);
      const map = {};
      // distance transform buffers
      const N = cellW * cellH;
      const dxIn = new Int16Array(N), dyIn = new Int16Array(N), dxOut = new Int16Array(N), dyOut = new Int16Array(N);
      const advance = {};

      for (let ci = 0; ci < chars.length; ci++) {
        const ch = chars[ci];
        g.clearRect(0, 0, cellW, cellH);
        g.fillStyle = '#fff'; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(ch, cellW / 2, cellH / 2 + cellH * 0.02);
        const m = g.measureText(ch);
        advance[ch] = (m.width || cellW * 0.5) / cellW;   // relative advance for layout
        const px = g.getImageData(0, 0, cellW, cellH).data;
        // inside mask from alpha
        const inside = new Uint8Array(N);
        for (let i = 0; i < N; i++) inside[i] = px[i * 4 + 3] > 127 ? 1 : 0;
        const dOut = edt(inside, cellW, cellH, dxOut, dyOut, 1);   // seeds = inside pixels -> distance to the glyph (for outside pixels)
        const dIn = edt(inside, cellW, cellH, dxIn, dyIn, 0);      // seeds = outside pixels -> distance to the edge (for inside pixels)
        const cx = (ci % cols) * cellW, cy = Math.floor(ci / cols) * cellH;
        for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) {
          const i = y * cellW + x;
          const d = inside[i] ? -dIn[i] : dOut[i];            // signed, px
          const v = 0.5 + d / (2 * spread);
          atlas[(cy + y) * W + cx + x] = Math.round(Math.max(0, Math.min(1, v)) * 255);
        }
        map[ch] = { u: cx / W, v: cy / H, w: cellW / W, h: cellH / H, col: ci % cols, row: Math.floor(ci / cols) };
      }
      return { data: atlas, width: W, height: H, cellW, cellH, cols, rows, map, spread, advance, chars };

      // 8SSEDT: for every pixel, distance to the nearest pixel whose mask value == `target`
      function edt(mask, w, h, dx, dy, target) {
        const INF = 1 << 14;
        for (let i = 0; i < w * h; i++) { const t = mask[i] === target; dx[i] = t ? 0 : INF; dy[i] = t ? 0 : INF; }
        const dist2 = (i) => dx[i] * dx[i] + dy[i] * dy[i];
        const cmp = (i, j, ox, oy) => { if (j < 0 || j >= w * h) return; const nx = dx[j] + ox, ny = dy[j] + oy; if (nx * nx + ny * ny < dist2(i)) { dx[i] = nx; dy[i] = ny; } };
        // pass 1
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) { const i = y * w + x; if (x > 0) cmp(i, i - 1, 1, 0); if (y > 0) cmp(i, i - w, 0, 1); if (x > 0 && y > 0) cmp(i, i - w - 1, 1, 1); if (x < w - 1 && y > 0) cmp(i, i - w + 1, 1, 1); }
          for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (x < w - 1) cmp(i, i + 1, 1, 0); }
        }
        // pass 2
        for (let y = h - 1; y >= 0; y--) {
          for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (x < w - 1) cmp(i, i + 1, 1, 0); if (y < h - 1) cmp(i, i + w, 0, 1); if (x < w - 1 && y < h - 1) cmp(i, i + w + 1, 1, 1); if (x > 0 && y < h - 1) cmp(i, i + w - 1, 1, 1); }
          for (let x = 0; x < w; x++) { const i = y * w + x; if (x > 0) cmp(i, i - 1, 1, 0); }
        }
        const out = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(dist2(i));
        return out;
      }
    },
  };

  // ------------------------------------------------------------------ WebGL2 helpers
  WE.GL = {
    create(canvas, opts = {}) {
      const gl = canvas.getContext('webgl2', Object.assign({ alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true }, opts));
      if (!gl) throw new Error('WebGL2 not available');
      const ext = {
        cbf: gl.getExtension('EXT_color_buffer_float'),
        fl: gl.getExtension('OES_texture_float_linear'),
        fb: gl.getExtension('EXT_float_blend'),
        hfl: gl.getExtension('OES_texture_half_float_linear'),
      };
      if (!ext.cbf) WE.log('EXT_color_buffer_float missing — float render targets unavailable');
      gl.ext = ext;
      return gl;
    },

    program(gl, vs, fs, name = 'program') {
      const sh = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          const info = gl.getShaderInfoLog(s);
          const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}: ${l}`).join('\n');
          throw new Error(`[${name}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader:\n${info}\n${lines}`);
        }
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[${name}] link: ${gl.getProgramInfoLog(p)}`);
      const uniforms = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); const nm = u.name.replace(/\[0\]$/, ''); uniforms[nm] = gl.getUniformLocation(p, u.name); }
      return { p, u: uniforms, name };
    },

    /** Create a texture. fmt: 'rgba32f' | 'rgba16f' | 'r16f' | 'rg16f' | 'r8' | 'rgba8' */
    texture(gl, w, h, fmt, opts = {}) {
      const F = {
        rgba32f: [gl.RGBA32F, gl.RGBA, gl.FLOAT], rgba16f: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
        r16f: [gl.R16F, gl.RED, gl.HALF_FLOAT], rg16f: [gl.RG16F, gl.RG, gl.HALF_FLOAT], r32f: [gl.R32F, gl.RED, gl.FLOAT],
        r8: [gl.R8, gl.RED, gl.UNSIGNED_BYTE], rgba8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
      }[fmt];
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, F[0], w, h, 0, F[1], F[2], opts.data || null);
      const filter = opts.filter || ((fmt === 'rgba32f' || fmt === 'r32f') ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      const wrap = opts.wrap || gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      return { t, w, h, fmt };
    },

    fbo(gl, tex) {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.t, 0);
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete (${tex.fmt} ${tex.w}x${tex.h}): 0x${st.toString(16)}`);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { f, tex, w: tex.w, h: tex.h };
    },

    target(gl, w, h, fmt, opts) { return this.fbo(gl, this.texture(gl, w, h, fmt, opts)); },

    pingpong(gl, w, h, fmt, opts) {
      const a = this.target(gl, w, h, fmt, opts), b = this.target(gl, w, h, fmt, opts);
      return { a, b, get read() { return this.a; }, get write() { return this.b; }, swap() { const t = this.a; this.a = this.b; this.b = t; }, w, h };
    },

    destroyTarget(gl, t) { if (!t) return; gl.deleteFramebuffer(t.f); gl.deleteTexture(t.tex.t); },

    quad(gl) {
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      return vao;
    },

    QUAD_VS: `#version 300 es
      layout(location=0) in vec2 aPos; out vec2 vUv;
      void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`,

    bind(gl, target, w, h) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null);
      gl.viewport(0, 0, target ? target.w : w, target ? target.h : h);
    },

    tex(gl, unit, tex, loc) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex.t || tex); gl.uniform1i(loc, unit); },
  };

  // ------------------------------------------------------------------ quality governor
  // Tiers are wallpaper-defined; the governor only picks an index.
  class Governor {
    constructor(tierCount, settings) {
      this.count = tierCount; this.tier = Math.min(tierCount - 1, 2);
      this.settings = settings || {}; this.avg = 16.7; this.slowFor = 0; this.fastFor = 0; this.lastChange = 0; this.onChange = null;
      this.applySettings(settings);
    }
    applySettings(s) {
      this.settings = s || {};
      this.fpsCap = Number(s && s.fpsCap != null ? s.fpsCap : 60);
      const q = (s && s.quality) || 'auto';
      this.auto = q === 'auto';
      const fixed = { low: 0, medium: Math.min(this.count - 1, 1), high: this.count - 1 }[q];
      if (fixed != null && fixed !== this.tier) { this.tier = fixed; this.lastChange = performance.now(); if (this.onChange) this.onChange(this.tier); }
      if (this.auto && !this._autoInit) { this._autoInit = true; }
    }
    /** ms = frame time. Returns true if the tier changed. */
    frame(ms, now) {
      this.avg += (ms - this.avg) * 0.05;
      if (!this.auto) return false;
      const target = 1000 / (this.fpsCap || 60);
      let changed = false;
      if (this.avg > target * 1.3) { this.slowFor += ms; this.fastFor = 0; }
      else if (this.avg < target * 0.72) { this.fastFor += ms; this.slowFor = 0; }
      else { this.slowFor = 0; this.fastFor = 0; }
      if (this.slowFor > 2500 && this.tier > 0 && now - this.lastChange > 4000) { this.tier--; changed = true; }
      else if (this.fastFor > 12000 && this.tier < this.count - 1 && now - this.lastChange > 20000) { this.tier++; changed = true; }
      if (changed) { this.slowFor = 0; this.fastFor = 0; this.lastChange = now; if (this.onChange) this.onChange(this.tier); }
      return changed;
    }
  }
  WE.Governor = Governor;

  // ------------------------------------------------------------------ loop
  // WE.Loop.run({ frame(dt, t), governor, onPause?, stats() })
  WE.Loop = {
    run(o) {
      let paused = false, hidden = false, last = performance.now(), acc = 0, frames = 0, fpsT = last, raf = 0, fps = 0;
      const gov = o.governor;
      const tick = (now) => {
        raf = 0;
        if (paused || hidden) return;
        const cap = gov ? gov.fpsCap : 60;
        const minDt = cap > 0 ? 1000 / cap : 0;
        const elapsed = now - last;
        if (minDt && elapsed < minDt - 0.5) { raf = requestAnimationFrame(tick); return; }
        const dt = Math.min(0.1, elapsed / 1000);
        last = now;
        try { o.frame(dt, now / 1000); } catch (e) { WE.log('frame error', e && e.stack || e); paused = true; return; }
        if (gov) gov.frame(elapsed, now);
        frames++;
        if (now - fpsT > 1000) {
          fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now;
          if (o.stats) { const s = o.stats(fps); if (WE.hasHost) { try { window.host.stats(s); } catch (_) {} } }
        }
        raf = requestAnimationFrame(tick);
      };
      const start = () => { if (!raf && !paused && !hidden) { last = performance.now(); raf = requestAnimationFrame(tick); } };
      const setPaused = (p) => { paused = !!p; if (paused) { if (raf) cancelAnimationFrame(raf); raf = 0; if (o.onPause) o.onPause(true); } else { if (o.onPause) o.onPause(false); start(); } };
      document.addEventListener('visibilitychange', () => { hidden = document.hidden && !WE.hasHost; if (!hidden) start(); });
      if (WE.hasHost) window.host.onPause(setPaused);
      start();
      return { setPaused, get fps() { return fps; } };
    },
  };

  // ------------------------------------------------------------------ identify overlay (monitor numbers)
  WE.identify = function (monitors) {
    for (const m of monitors) {
      const d = document.createElement('div');
      d.textContent = String(m.index + 1);
      Object.assign(d.style, { position: 'fixed', left: m.x + 'px', top: m.y + 'px', width: m.w + 'px', height: m.h + 'px', display: 'grid', placeItems: 'center', font: '900 260px "Segoe UI", sans-serif', color: 'rgba(255,255,255,0.9)', textShadow: '0 0 60px #000', pointerEvents: 'none', zIndex: 10, transition: 'opacity .6s', opacity: '1' });
      document.body.appendChild(d);
      setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 700); }, 2000);
    }
  };

  // ------------------------------------------------------------------ small math utils
  WE.util = {
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    lerp: (a, b, t) => a + (b - a) * t,
    smooth: (t) => t * t * (3 - 2 * t),
    hexToRgb: (hex) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; },
    rand: (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000000) / 1000000; }; },
  };

  window.WE = WE;
})();
