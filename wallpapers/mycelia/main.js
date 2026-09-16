// Mycelia — living kaleidoscope + spore clock.
//
// Layers (all WebGL2, see shaders.js):
//   1. fractal flame (Electric Sheep): GPU chaos game -> log-density histogram
//   2. physarum spores: agents sense/deposit a trail; glyph distance fields pull
//      them into the time, date and weekday; digits regrow when they change
//   3. composite: domain warp, optional kaleidoscope fold, feedback echo,
//      sparkle spores, bloom, beat-driven chromatic aberration
(async function () {
  'use strict';
  const errBox = document.getElementById('err');
  const fail = (e) => { console.error(e); errBox.style.display = 'grid'; errBox.textContent = String(e && e.stack || e); };
  window.addEventListener('error', (e) => fail(e.error || e.message));

  const DEFAULTS = {
    intensity: 1, symmetry: 6, kaleido: 0, palette: 'aurora', flameSpeed: 1, warp: 0.8, feedback: 0.2, bloom: 0.5,
    sporeDensity: 1, sporeSpeed: 1, clockScale: 1, clockX: 0.5, clockY: 0.5, clockContrast: 0.8, fill: 'auto', fillDepth: 0.35, hour24: false, showSeconds: true, showDate: true,
  };
  const ctx = await WE.boot({ defaults: DEFAULTS });
  const props = ctx.props;
  let settings = ctx.settings || {};
  const S = window.MYCELIA_SHADERS;
  const U = WE.util;
  const DEBUG_VIEW = { flame: 1, trail: 2, field: 3, clock: 4 }[WE.query.get('view')] || 0;

  const canvas = document.getElementById('c');
  let gl;
  try { gl = WE.GL.create(canvas); } catch (e) { return fail(e); }
  if (!gl.ext.cbf) return fail('This GPU/driver does not support float render targets (EXT_color_buffer_float).');

  // ------------------------------------------------------------------ palettes
  const PALETTES = {
    // cosine palettes (IQ): colour = a + b*cos(2pi*(c*t + d)); f = flame, m = mycelium
    aurora: { f: [[0.50, 0.50, 0.50], [0.50, 0.50, 0.50], [1, 1, 1], [0.00, 0.33, 0.67]], m: [[0.45, 0.55, 0.55], [0.45, 0.45, 0.45], [1, 1, 1], [0.55, 0.20, 0.40]] },
    spore:  { f: [[0.50, 0.50, 0.50], [0.50, 0.50, 0.50], [1, 1, 0.5], [0.80, 0.90, 0.30]], m: [[0.50, 0.50, 0.50], [0.50, 0.50, 0.50], [2, 1, 0], [0.50, 0.20, 0.25]] },
    ember:  { f: [[0.50, 0.50, 0.50], [0.50, 0.50, 0.50], [1, 0.7, 0.4], [0.00, 0.15, 0.20]], m: [[0.80, 0.50, 0.40], [0.20, 0.40, 0.20], [2, 1, 1], [0.00, 0.25, 0.25]] },
    acid:   { f: [[0.50, 0.50, 0.50], [0.50, 0.50, 0.50], [2, 1, 0], [0.50, 0.20, 0.25]], m: [[0.60, 0.70, 0.30], [0.40, 0.30, 0.60], [1, 1, 1], [0.30, 0.60, 0.10]] },
    ocean:  { f: [[0.50, 0.50, 0.50], [0.50, 0.50, 0.50], [1, 1, 1], [0.30, 0.20, 0.20]], m: [[0.20, 0.50, 0.80], [0.30, 0.40, 0.30], [1, 1, 1], [0.15, 0.35, 0.50]] },
  };
  const palette = () => PALETTES[props.palette] || PALETTES.aurora;

  // ------------------------------------------------------------------ quality tiers
  const TIERS = [
    { name: 'low',    scale: 0.5,  flame: 160, agents: 288, iters: 2, hist: 0.6,  trail: 0.5,  sparkle: 32, pointSize: 1 },
    { name: 'medium', scale: 0.66, flame: 224, agents: 384, iters: 3, hist: 0.6,  trail: 0.5,  sparkle: 20, pointSize: 1 },
    { name: 'high',   scale: 0.8,  flame: 256, agents: 512, iters: 3, hist: 0.6,  trail: 0.55, sparkle: 14, pointSize: 1 },
    { name: 'ultra',  scale: 1.0,  flame: 320, agents: 608, iters: 4, hist: 0.65, trail: 0.6,  sparkle: 10, pointSize: 1.5 },
  ];
  const gov = new WE.Governor(TIERS.length, settings);
  let covered = (ctx.covered || []).length > 0;
  let tierIdx = ctx.preview ? 0 : gov.tier;

  // ------------------------------------------------------------------ programs
  const P = {};
  try {
    P.flameUpd = WE.GL.program(gl, WE.GL.QUAD_VS, S.FLAME_UPDATE_FS, 'flame-update');
    P.flamePlot = WE.GL.program(gl, S.FLAME_PLOT_VS, S.POINT_FS, 'flame-plot');
    P.zero = WE.GL.program(gl, WE.GL.QUAD_VS, S.ZERO_FS, 'zero');
    P.agentUpd = WE.GL.program(gl, WE.GL.QUAD_VS, S.AGENT_UPDATE_FS, 'agent-update');
    P.deposit = WE.GL.program(gl, S.AGENT_DEPOSIT_VS, S.POINT_FS, 'deposit');
    P.diffuse = WE.GL.program(gl, WE.GL.QUAD_VS, S.TRAIL_DIFFUSE_FS, 'diffuse');
    P.sparkle = WE.GL.program(gl, S.SPARKLE_VS, S.SPARKLE_FS, 'sparkle');
    P.comp = WE.GL.program(gl, WE.GL.QUAD_VS, S.COMPOSITE_FS, 'composite');
    P.down = WE.GL.program(gl, WE.GL.QUAD_VS, S.DOWNSAMPLE_FS, 'downsample');
    P.blur = WE.GL.program(gl, WE.GL.QUAD_VS, S.BLUR_FS, 'blur');
    P.final = WE.GL.program(gl, WE.GL.QUAD_VS, S.FINAL_FS, 'final');
  } catch (e) { return fail(e); }
  const quad = WE.GL.quad(gl);
  const crowd = new WE.ClockCrowd(gl);

  // ------------------------------------------------------------------ state
  const dpr = window.devicePixelRatio || 1;
  let W = 0, H = 0;                 // render resolution (px)
  let T = null;                      // current tier object
  let R = {};                        // render targets
  let flamePts = null, agents = null;
  let frame = 0;
  const monitors = (ctx.monitors && ctx.monitors.length ? ctx.monitors : [{ index: 0, x: 0, y: 0, w: window.innerWidth * dpr, h: window.innerHeight * dpr }]);
  let tiles = 1;
  function tileCount() {
    const f = props.fill;
    if (f && f !== 'auto') return U.clamp(parseInt(f, 10) || 1, 1, 4);
    const fullW = window.innerWidth * dpr, fullH = window.innerHeight * dpr;
    return U.clamp(Math.round((fullW / fullH) / 1.9), 1, 4);   // ~one mandala per 16:9 worth of width
  }

  const audio = new WE.Audio();
  audio.start(settings.audioSource || 'system');

  function destroyAll() {
    for (const k of Object.keys(R)) {
      const v = R[k];
      if (!v) continue;
      if (v.a && v.b) { WE.GL.destroyTarget(gl, v.a); WE.GL.destroyTarget(gl, v.b); }
      else WE.GL.destroyTarget(gl, v);
    }
    R = {};
  }

  function alloc() {
    T = TIERS[covered ? 0 : tierIdx];
    const fullW = Math.max(2, Math.round(window.innerWidth * dpr)), fullH = Math.max(2, Math.round(window.innerHeight * dpr));
    W = Math.max(2, Math.round(fullW * T.scale)); H = Math.max(2, Math.round(fullH * T.scale));
    canvas.width = W; canvas.height = H;
    destroyAll();
    const hw = Math.round(W * T.hist), hh = Math.round(H * T.hist);
    const tw = Math.round(W * T.trail), th = Math.round(H * T.trail);
    const bw = Math.max(2, Math.round(W * 0.25)), bh = Math.max(2, Math.round(H * 0.25));

    tiles = tileCount();
    R.hist = WE.GL.target(gl, Math.max(2, Math.round(hw / tiles)), hh, 'rgba16f');
    R.trail = WE.GL.pingpong(gl, tw, th, 'r16f', { wrap: gl.REPEAT });   // torus, like the agents
    R.comp = WE.GL.pingpong(gl, W, H, 'rgba16f');
    R.bloomA = WE.GL.target(gl, bw, bh, 'rgba16f');
    R.bloomB = WE.GL.target(gl, bw, bh, 'rgba16f');

    // flame points
    const fs = T.flame;
    const fdata = new Float32Array(fs * fs * 4);
    for (let i = 0; i < fs * fs; i++) { fdata[i * 4] = Math.random() * 2 - 1; fdata[i * 4 + 1] = Math.random() * 2 - 1; fdata[i * 4 + 2] = Math.random(); fdata[i * 4 + 3] = 0; }
    R.flame = WE.GL.pingpong(gl, fs, fs, 'rgba32f', { filter: gl.NEAREST });
    gl.bindTexture(gl.TEXTURE_2D, R.flame.a.tex.t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, fs, fs, gl.RGBA, gl.FLOAT, fdata);
    flamePts = fs * fs;

    // spores
    const as = Math.round(T.agents * Math.sqrt(U.clamp(props.sporeDensity, 0.4, 1.6)));
    const adata = new Float32Array(as * as * 4);
    for (let i = 0; i < as * as; i++) {
      adata[i * 4] = Math.random() * tw; adata[i * 4 + 1] = Math.random() * th; adata[i * 4 + 2] = Math.random() * Math.PI * 2;
      adata[i * 4 + 3] = Math.random();
    }
    R.agents = WE.GL.pingpong(gl, as, as, 'rgba32f', { filter: gl.NEAREST });
    gl.bindTexture(gl.TEXTURE_2D, R.agents.a.tex.t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, as, as, gl.RGBA, gl.FLOAT, adata);
    agents = { side: as, count: as * as };

    // clear render targets
    for (const t of [R.hist, R.trail.a, R.trail.b, R.comp.a, R.comp.b, R.bloomA, R.bloomB]) { WE.GL.bind(gl, t); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    crowd.alloc({ fieldW: tw, fieldH: th });
    layoutClock();
    WE.log(`alloc tier=${T.name} render=${W}x${H} hist=${hw}x${hh} trail=${tw}x${th} flame=${flamePts} spores=${agents.count}`);
  }

  gov.onChange = (t) => { tierIdx = t; alloc(); };
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(alloc, 250); });

  function layoutClock() {
    crowd.layout(monitors, { fullW: window.innerWidth * dpr, fullH: window.innerHeight * dpr, scale: props.clockScale, x: props.clockX, y: props.clockY, showSeconds: props.showSeconds, showDate: props.showDate, hour24: props.hour24 });
  }

  // ------------------------------------------------------------------ flame genomes (Electric Sheep)
  const VAR_POOL = [0, 0, 2, 2, 2, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13, 14, 15];
  function randomXform(rng) {
    const ang = rng() * Math.PI * 2, sc = 0.42 + rng() * 0.5, sh = (rng() - 0.5) * 0.5;
    const aff = [Math.cos(ang) * sc, -Math.sin(ang) * sc + sh, (rng() - 0.5) * 1.7, Math.sin(ang) * sc, Math.cos(ang) * sc, (rng() - 0.5) * 1.7];
    const vars = new Float32Array(16);
    const nv = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < nv; i++) vars[VAR_POOL[Math.floor(rng() * VAR_POOL.length)]] += 0.3 + rng() * 0.7;
    vars[0] += 0.15;
    let sum = 0; for (let i = 0; i < 16; i++) sum += vars[i];
    for (let i = 0; i < 16; i++) vars[i] /= sum;
    return { weight: 0.4 + rng() * 1.0, aff, vars, color: rng() };
  }
  function randomGenome(rng, from) {
    const x = [];
    for (let i = 0; i < 4; i++) x.push(from && rng() < 0.5 ? cloneX(from.x[i]) : randomXform(rng));
    return { x };
  }
  const cloneX = (o) => ({ weight: o.weight, aff: o.aff.slice(), vars: new Float32Array(o.vars), color: o.color });
  function lerpGenome(A, B, t, out) {
    for (let i = 0; i < 4; i++) {
      const a = A.x[i], b = B.x[i], o = out.x[i];
      o.weight = U.lerp(a.weight, b.weight, t); o.color = U.lerp(a.color, b.color, t);
      for (let k = 0; k < 6; k++) o.aff[k] = U.lerp(a.aff[k], b.aff[k], t);
      for (let k = 0; k < 16; k++) o.vars[k] = U.lerp(a.vars[k], b.vars[k], t);
    }
    return out;
  }
  const rng = U.rand(WE.query.get('seed') ? +WE.query.get('seed') : (Date.now() & 0xffff) + 7);
  let genA = randomGenome(rng), genB = randomGenome(rng, genA), genCur = randomGenome(rng);
  let morphT = 0, lastMutate = 0;
  const gCum = new Float32Array(4), gAff = new Float32Array(24), gVars = new Float32Array(64), gCol = new Float32Array(4);
  function uploadGenome(g) {
    let tot = 0; for (const x of g.x) tot += x.weight;
    let acc = 0;
    for (let i = 0; i < 4; i++) {
      acc += g.x[i].weight / tot; gCum[i] = i === 3 ? 1 : acc;
      for (let k = 0; k < 6; k++) gAff[i * 6 + k] = g.x[i].aff[k];
      gVars.set(g.x[i].vars, i * 16);
      gCol[i] = g.x[i].color;
    }
  }

  // ------------------------------------------------------------------ camera / animation state
  let camRot = 0, hue = 0, beatSpin = 0, sporeTime = 0;

  // log-density gain: normalises for samples-per-texel so every tier looks the same
  function histGain() {
    const densNorm = (T.flame * T.flame * T.iters) / (R.hist.w * R.hist.h);   // samples per texel per frame
    return 0.35 / Math.max(0.05, densNorm * 10);                              // ~10 frames of accumulation
  }

  // ------------------------------------------------------------------ frame
  function drawQuad(prog) { gl.useProgram(prog.p); gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null); }

  function frameFn(dt, t) {
    frame++;
    audio.update(dt);
    const inten = props.intensity;
    const bass = U.clamp(audio.bass * inten, 0, 1.5), beat = audio.beat * Math.min(1, inten * 1.2), treb = U.clamp(audio.treble * inten, 0, 1.5), energy = U.clamp(audio.energy * inten, 0, 1.5);
    const amb = audio.silent ? audio.ambient : 0;
    const dts = dt * 60;   // frame-rate normalised step
    crowd.setTime();
    crowd.update(dt, { beat, bass });

    // --- flame genome evolution
    const speed = props.flameSpeed * (1 + energy * 0.6);
    morphT += dt / 28 * speed;
    if (morphT >= 1) { morphT = 0; genA = genB; genB = randomGenome(rng, genA); }
    if (audio.onset && energy > 0.45 && t - lastMutate > 2.5 && Math.random() < 0.5) {
      lastMutate = t;
      const x = genB.x[Math.floor(Math.random() * 4)];
      const j = VAR_POOL[Math.floor(Math.random() * VAR_POOL.length)];
      x.vars[j] = Math.min(1, x.vars[j] + 0.25 + Math.random() * 0.4);
      let sum = 0; for (let i = 0; i < 16; i++) sum += x.vars[i]; for (let i = 0; i < 16; i++) x.vars[i] /= sum;
      x.aff[2] += (Math.random() - 0.5) * 0.3; x.aff[5] += (Math.random() - 0.5) * 0.3;
    }
    lerpGenome(genA, genB, U.smooth(morphT), genCur);
    uploadGenome(genCur);

    hue += dt * (0.012 * props.flameSpeed + bass * 0.01 + amb * 0.01);
    if (audio.onset) beatSpin += (Math.random() < 0.5 ? 1 : -1) * 0.05 * inten;
    beatSpin *= Math.exp(-dt * 0.8);
    camRot += dt * (0.02 + amb * 0.03) + beatSpin * dt;

    gl.disable(gl.DEPTH_TEST);

    // ==== 1. flame: chaos game iterations + plot
    const zoom = 1.05 * (1 + bass * 0.09 + amb * 0.04);
    const aspect = (W / tiles) / H, stretch = U.clamp(aspect / 1.777, 1, 1.6);
    for (let it = 0; it < T.iters; it++) {
      WE.GL.bind(gl, R.flame.write);
      gl.useProgram(P.flameUpd.p);
      WE.GL.tex(gl, 0, R.flame.read.tex, P.flameUpd.u.uPts);
      gl.uniform1ui(P.flameUpd.u.uFrame, (frame * 8 + it) >>> 0);
      gl.uniform1fv(P.flameUpd.u.uCum, gCum);
      gl.uniform3fv(P.flameUpd.u.uAff, gAff);
      gl.uniform1fv(P.flameUpd.u.uVars, gVars);
      gl.uniform1fv(P.flameUpd.u.uColors, gCol);
      gl.uniform1f(P.flameUpd.u.uSym, props.symmetry);
      gl.uniform1f(P.flameUpd.u.uMirror, props.symmetry >= 2 ? 1 : 0);
      gl.uniform2f(P.flameUpd.u.uFinal, U.clamp(bass * 0.35 + amb * 0.08, 0, 0.6), U.clamp(audio.kick * inten * 0.25, 0, 0.5));
      gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      R.flame.swap();

      // decay the histogram, then plot the new positions
      WE.GL.bind(gl, R.hist);
      gl.enable(gl.BLEND);
      if (it === 0) { gl.blendFunc(gl.ZERO, gl.CONSTANT_ALPHA); gl.blendColor(0, 0, 0, Math.pow(0.90, dts)); drawQuad(P.zero); }
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(P.flamePlot.p);
      WE.GL.tex(gl, 0, R.flame.read.tex, P.flamePlot.u.uPts);
      gl.uniform1i(P.flamePlot.u.uSide, T.flame);
      gl.uniform2f(P.flamePlot.u.uCenter, 0.16 * Math.sin(t * 0.061), 0.12 * Math.sin(t * 0.047 + 1.7));   // slow drift so no static gap sits under the clock
      gl.uniform1f(P.flamePlot.u.uZoom, zoom);
      gl.uniform1f(P.flamePlot.u.uRot, camRot);
      gl.uniform2f(P.flamePlot.u.uAspect, stretch / aspect, 1);
      const pf = palette().f;
      gl.uniform3fv(P.flamePlot.u.uPalA, pf[0]); gl.uniform3fv(P.flamePlot.u.uPalB, pf[1]); gl.uniform3fv(P.flamePlot.u.uPalC, pf[2]); gl.uniform3fv(P.flamePlot.u.uPalD, pf[3]);
      gl.uniform1f(P.flamePlot.u.uHue, hue);
      gl.uniform1f(P.flamePlot.u.uAlpha, 1.0);
      gl.uniform1f(P.flamePlot.u.uPointSize, T.pointSize);
      gl.drawArrays(gl.POINTS, 0, flamePts);
      gl.disable(gl.BLEND);
    }

    // ==== 2. spores
    sporeTime += dt;
    const substeps = T.name === 'ultra' && dt < 0.02 ? 1 : 1;
    for (let s = 0; s < substeps; s++) {
      WE.GL.bind(gl, R.agents.write);
      gl.useProgram(P.agentUpd.p);
      WE.GL.tex(gl, 0, R.agents.read.tex, P.agentUpd.u.uAgents);
      WE.GL.tex(gl, 1, R.trail.read.tex, P.agentUpd.u.uTrail);
      gl.uniform2f(P.agentUpd.u.uRes, R.trail.w, R.trail.h);
      gl.uniform1ui(P.agentUpd.u.uFrame, frame >>> 0);
      const px = R.trail.h / 540;                  // scale physarum params with trail resolution
      gl.uniform1f(P.agentUpd.u.uSA, 0.42);
      gl.uniform1f(P.agentUpd.u.uSD, 9 * px);
      gl.uniform1f(P.agentUpd.u.uRA, 0.45);
      gl.uniform1f(P.agentUpd.u.uSS, 1.15 * px * props.sporeSpeed * Math.min(dts, 2.5));   // capped: no tunnelling at low fps
      gl.uniform4f(P.agentUpd.u.uAudio, bass, beat, treb, energy + amb * 0.3);
      gl.uniform1f(P.agentUpd.u.uOnset, audio.onset ? 1 : 0);
      gl.uniform1f(P.agentUpd.u.uTime, sporeTime);
      gl.uniform1f(P.agentUpd.u.uPx, px);
      WE.GL.tex(gl, 4, R.hist.tex, P.agentUpd.u.uHist);
      gl.uniform1f(P.agentUpd.u.uFood, 0.5);
      gl.uniform1f(P.agentUpd.u.uFoodGain, histGain());
      gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      R.agents.swap();
    }
    // deposit
    WE.GL.bind(gl, R.trail.read);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.deposit.p);
    WE.GL.tex(gl, 0, R.agents.read.tex, P.deposit.u.uAgents);
    gl.uniform1i(P.deposit.u.uSide, agents.side);
    gl.uniform2f(P.deposit.u.uRes, R.trail.w, R.trail.h);
    const depositAmt = 0.05 * (262144 / agents.count) * (1 + energy * 0.5) * dts;
    gl.uniform1f(P.deposit.u.uDeposit, depositAmt);
    gl.drawArrays(gl.POINTS, 0, agents.count);
    gl.disable(gl.BLEND);
    // diffuse + decay
    WE.GL.bind(gl, R.trail.write);
    gl.useProgram(P.diffuse.p);
    WE.GL.tex(gl, 0, R.trail.read.tex, P.diffuse.u.uTrail);
    gl.uniform2f(P.diffuse.u.uRes, R.trail.w, R.trail.h);
    gl.uniform1f(P.diffuse.u.uDecay, Math.pow(0.925, dts));
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    R.trail.swap();

    // ==== 3. composite
    WE.GL.bind(gl, R.comp.write);
    gl.useProgram(P.comp.p);
    WE.GL.tex(gl, 0, R.hist.tex, P.comp.u.uHist);
    WE.GL.tex(gl, 1, R.trail.read.tex, P.comp.u.uTrail);
    WE.GL.tex(gl, 2, crowd.field.tex, P.comp.u.uField);
    WE.GL.tex(gl, 3, crowd.fieldOld.tex, P.comp.u.uFieldOld);
    WE.GL.tex(gl, 4, R.comp.read.tex, P.comp.u.uPrev);
    gl.uniform1f(P.comp.u.uMorph, U.smooth(crowd.morph));
    gl.uniform2f(P.comp.u.uRes, W, H);
    gl.uniform2f(P.comp.u.uHistRes, R.hist.w, R.hist.h);
    gl.uniform1f(P.comp.u.uTime, t);
    gl.uniform4f(P.comp.u.uAudio, bass, beat, treb, energy);
    gl.uniform1f(P.comp.u.uGain, histGain());
    gl.uniform1f(P.comp.u.uGamma, 1.9);
    gl.uniform1f(P.comp.u.uBright, 1.3);
    gl.uniform1f(P.comp.u.uKaleido, props.kaleido);
    gl.uniform1f(P.comp.u.uTiles, tiles);
    gl.uniform1f(P.comp.u.uFill, props.fillDepth);
    WE.GL.tex(gl, 5, crowd.layer.tex, P.comp.u.uClockLayer);
    gl.uniform2fv(P.comp.u.uMoldPx, crowd.texel);
    gl.uniform1f(P.comp.u.uWarp, props.warp);
    gl.uniform1f(P.comp.u.uFeedback, props.feedback);
    gl.uniform1f(P.comp.u.uFbZoom, 0.006 + amb * 0.004);
    gl.uniform1f(P.comp.u.uFbRot, 0.0025);
    const pf = palette().f, pm = palette().m;
    gl.uniform3fv(P.comp.u.uPalA, pf[0]); gl.uniform3fv(P.comp.u.uPalB, pf[1]); gl.uniform3fv(P.comp.u.uPalC, pf[2]); gl.uniform3fv(P.comp.u.uPalD, pf[3]);
    gl.uniform3fv(P.comp.u.uMycA, pm[0]); gl.uniform3fv(P.comp.u.uMycB, pm[1]); gl.uniform3fv(P.comp.u.uMycC, pm[2]); gl.uniform3fv(P.comp.u.uMycD, pm[3]);
    gl.uniform1f(P.comp.u.uHue, hue);
    gl.uniform1f(P.comp.u.uClockContrast, props.clockContrast);
    gl.uniform1f(P.comp.u.uMycGain, 0.7);
    gl.uniform1i(P.comp.u.uView, DEBUG_VIEW);
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);

    // sparkle spores on top
    if (DEBUG_VIEW) { R.comp.swap(); }
    else {
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.sparkle.p);
    WE.GL.tex(gl, 0, R.agents.read.tex, P.sparkle.u.uAgents);
    gl.uniform1i(P.sparkle.u.uSide, agents.side);
    gl.uniform1i(P.sparkle.u.uStride, T.sparkle);
    gl.uniform2f(P.sparkle.u.uRes, R.trail.w, R.trail.h);
    gl.uniform3fv(P.sparkle.u.uPalA, pm[0]); gl.uniform3fv(P.sparkle.u.uPalB, pm[1]); gl.uniform3fv(P.sparkle.u.uPalC, pm[2]); gl.uniform3fv(P.sparkle.u.uPalD, pm[3]);
    gl.uniform1f(P.sparkle.u.uHue, hue);
    gl.uniform1f(P.sparkle.u.uBright, 0.06 + beat * 0.3 + treb * 0.1);
    gl.uniform1f(P.sparkle.u.uSize, Math.max(2, 3 * T.scale + beat * 2));
    gl.drawArrays(gl.POINTS, 0, Math.floor(agents.count / (T.sparkle * 2)));
    gl.disable(gl.BLEND);
    R.comp.swap();
    }

    // ==== 4. bloom
    WE.GL.bind(gl, R.bloomA);
    gl.useProgram(P.down.p);
    WE.GL.tex(gl, 0, R.comp.read.tex, P.down.u.uSrc);
    gl.uniform2f(P.down.u.uRes, R.bloomA.w, R.bloomA.h);
    gl.uniform1f(P.down.u.uThresh, 0.75);
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    for (let i = 0; i < 2; i++) {
      WE.GL.bind(gl, R.bloomB); gl.useProgram(P.blur.p); WE.GL.tex(gl, 0, R.bloomA.tex, P.blur.u.uSrc); gl.uniform2f(P.blur.u.uDir, 1 / R.bloomA.w, 0);
      gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      WE.GL.bind(gl, R.bloomA); WE.GL.tex(gl, 0, R.bloomB.tex, P.blur.u.uSrc); gl.uniform2f(P.blur.u.uDir, 0, 1 / R.bloomA.h);
      gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    }

    // ==== 5. final to screen
    WE.GL.bind(gl, null, W, H);
    gl.useProgram(P.final.p);
    WE.GL.tex(gl, 0, R.comp.read.tex, P.final.u.uComp);
    WE.GL.tex(gl, 1, R.bloomA.tex, P.final.u.uBloom);
    gl.uniform2f(P.final.u.uRes, W, H);
    gl.uniform1f(P.final.u.uTime, t);
    gl.uniform4f(P.final.u.uAudio, bass, beat, treb, energy);
    gl.uniform1f(P.final.u.uBloomAmt, props.bloom);
    gl.uniform1f(P.final.u.uCA, 0.8 * inten);
    gl.uniform1f(P.final.u.uGrain, 0.012);
    const mon = new Float32Array(16);
    const fw = window.innerWidth * dpr, fh = window.innerHeight * dpr;
    const nMon = Math.min(4, monitors.length);
    for (let i = 0; i < nMon; i++) { const m = monitors[i]; mon.set([m.x / fw, 1 - (m.y + m.h) / fh, m.w / fw, m.h / fh], i * 4); }
    gl.uniform4fv(P.final.u.uMon, mon);
    gl.uniform1i(P.final.u.uNMon, nMon);
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
  }

  // ------------------------------------------------------------------ host wiring
  if (WE.hasHost) {
    window.host.onProps((p) => {
      const old = Object.assign({}, props);
      Object.assign(props, p);
      if (p.sporeDensity !== old.sporeDensity || p.fill !== old.fill) alloc();
      else if (['clockScale', 'clockX', 'clockY', 'showSeconds', 'showDate', 'hour24'].some(k => p[k] !== old[k])) layoutClock();
    });
    window.host.onSettings((s) => {
      const prevSrc = settings.audioSource;
      settings = s; gov.applySettings(s);
      if (s.audioSource !== prevSrc) audio.start(s.audioSource);
    });
    window.host.onCovered((list) => { const c = (list || []).length > 0; if (c !== covered) { covered = c; alloc(); } });
    window.host.onContext((c) => { Object.assign(ctx, c); monitors.splice(0, monitors.length, ...c.monitors); layoutClock(); });
    window.host.onIdentify(() => WE.identify(monitors.map(m => ({ index: m.index, x: m.x / dpr, y: m.y / dpr, w: m.w / dpr, h: m.h / dpr }))));
  }

  alloc();

  WE.Loop.run({
    frame: frameFn,
    governor: gov,
    stats: (fps) => ({ fps, tier: T.name, width: W, height: H, audio: `${audio.source} ${audio.status}${audio.bpm ? ' ~' + Math.round(audio.bpm) + 'bpm' : ''}` }),
  });
})().catch((e) => { console.error(e); const b = document.getElementById('err'); b.style.display = 'grid'; b.textContent = String(e && e.stack || e); });
