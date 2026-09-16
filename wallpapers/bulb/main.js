// Bulb — an ever-evolving raymarched 3D fractal, Electric-Sheep style.
//
//  * genome = hybrid of Mandelbulb / Mandelbox / kaleidoscopic IFS + palette + light + camera
//  * a breeding pool: offspring = crossover(two parents) + mutation; the scene morphs
//    continuously from one genome to the next ("sheep" -> "sheep"), forever
//  * ♥ keep / ⏭ skip from the control panel steer the pool (Electric Sheep voting)
//  * music restructures the geometry (power, fold scale, rotation snaps, iteration depth)
//  * terrain-following camera flight: always hugging the surface, so detail keeps growing
//  * faint physarum spores crawl on the bright surfaces; crowd clock on the left
(async function () {
  'use strict';
  const errBox = document.getElementById('err');
  const fail = (e) => { console.error(e); errBox.style.display = 'grid'; errBox.textContent = String(e && e.stack || e); };
  window.addEventListener('error', (e) => fail(e.error || e.message));

  const DEFAULTS = {
    intensity: 1, evolveSpeed: 1, cameraSpeed: 1, detail: 0, rayScale: 'auto', glow: 1, fog: 1, brightness: 1,
    sporeAmount: 0.3, clockScale: 0.6, clockX: 0.16, clockY: 0.5, clockContrast: 0.8, hour24: false, showSeconds: true, showDate: true,
  };
  const ctx = await WE.boot({ defaults: DEFAULTS });
  const props = ctx.props;
  let settings = ctx.settings || {};
  const S = window.BULB_SHADERS;
  const U = WE.util;
  const DEBUG_VIEW = { ray: 1, spores: 2, clock: 4 }[WE.query.get('view')] || 0;

  const canvas = document.getElementById('c');
  let gl;
  try { gl = WE.GL.create(canvas); } catch (e) { return fail(e); }
  if (!gl.ext.cbf) return fail('This GPU/driver does not support float render targets (EXT_color_buffer_float).');

  // ------------------------------------------------------------------ tiers
  const TIERS = [
    { name: 'low',    scale: 0.75, ray: 0.30, steps: 56,  itersMax: 10, ao: 3, spores: 192, crowd: 192, temporal: 0.5 },
    { name: 'medium', scale: 0.85, ray: 0.40, steps: 72,  itersMax: 12, ao: 4, spores: 256, crowd: 224, temporal: 0.45 },
    { name: 'high',   scale: 1.0,  ray: 0.50, steps: 96,  itersMax: 14, ao: 5, spores: 320, crowd: 256, temporal: 0.4 },
    { name: 'ultra',  scale: 1.0,  ray: 0.66, steps: 128, itersMax: 16, ao: 5, spores: 384, crowd: 288, temporal: 0.35 },
  ];
  const gov = new WE.Governor(TIERS.length, settings);
  let covered = (ctx.covered || []).length > 0;
  let tierIdx = ctx.preview ? 0 : gov.tier;

  // ------------------------------------------------------------------ programs
  const P = {};
  try {
    P.ray = WE.GL.program(gl, WE.GL.QUAD_VS, S.RAY_FS, 'ray');
    P.agent = WE.GL.program(gl, WE.GL.QUAD_VS, S.AGENT_UPDATE_FS, 'agent');
    P.deposit = WE.GL.program(gl, S.DEPOSIT_VS, S.POINT_FS, 'deposit');
    P.diffuse = WE.GL.program(gl, WE.GL.QUAD_VS, S.DIFFUSE_FS, 'diffuse');
    P.comp = WE.GL.program(gl, WE.GL.QUAD_VS, S.COMPOSITE_FS, 'composite');
    P.down = WE.GL.program(gl, WE.GL.QUAD_VS, S.DOWNSAMPLE_FS, 'down');
    P.blur = WE.GL.program(gl, WE.GL.QUAD_VS, S.BLUR_FS, 'blur');
    P.final = WE.GL.program(gl, WE.GL.QUAD_VS, S.FINAL_FS, 'final');
  } catch (e) { return fail(e); }
  const quad = WE.GL.quad(gl);
  const crowd = new WE.ClockCrowd(gl);

  // ------------------------------------------------------------------ state
  const dpr = window.devicePixelRatio || 1;
  let W = 0, H = 0, T = null, R = {}, agents = null, frame = 0;
  const monitors = (ctx.monitors && ctx.monitors.length ? ctx.monitors : [{ index: 0, x: 0, y: 0, w: window.innerWidth * dpr, h: window.innerHeight * dpr }]);
  const audio = new WE.Audio();
  audio.start(settings.audioSource || 'system');

  function destroyAll() {
    for (const k of Object.keys(R)) { const v = R[k]; if (!v) continue; if (v.a && v.b) { WE.GL.destroyTarget(gl, v.a); WE.GL.destroyTarget(gl, v.b); } else WE.GL.destroyTarget(gl, v); }
    R = {};
  }
  function rayScale() { const r = props.rayScale; return (r && r !== 'auto') ? U.clamp(parseFloat(r), 0.25, 1) : T.ray; }

  function alloc() {
    T = TIERS[covered ? 0 : tierIdx];
    const fullW = Math.max(2, Math.round(window.innerWidth * dpr)), fullH = Math.max(2, Math.round(window.innerHeight * dpr));
    W = Math.max(2, Math.round(fullW * T.scale)); H = Math.max(2, Math.round(fullH * T.scale));
    canvas.width = W; canvas.height = H;
    destroyAll();
    const rs = rayScale();
    const rw = Math.max(2, Math.round(W * rs)), rh = Math.max(2, Math.round(H * rs));
    const tw = Math.round(W * 0.5), th = Math.round(H * 0.5);
    const bw = Math.max(2, Math.round(W * 0.25)), bh = Math.max(2, Math.round(H * 0.25));
    R.ray = WE.GL.target(gl, rw, rh, 'rgba16f');
    R.comp = WE.GL.pingpong(gl, W, H, 'rgba16f');
    R.trail = WE.GL.pingpong(gl, tw, th, 'r16f', { wrap: gl.REPEAT });
    R.bloomA = WE.GL.target(gl, bw, bh, 'rgba16f');
    R.bloomB = WE.GL.target(gl, bw, bh, 'rgba16f');
    const as = T.spores;
    const adata = new Float32Array(as * as * 4);
    for (let i = 0; i < as * as; i++) { adata[i * 4] = Math.random() * tw; adata[i * 4 + 1] = Math.random() * th; adata[i * 4 + 2] = Math.random() * Math.PI * 2; adata[i * 4 + 3] = Math.random(); }
    R.agents = WE.GL.pingpong(gl, as, as, 'rgba32f', { filter: gl.NEAREST });
    gl.bindTexture(gl.TEXTURE_2D, R.agents.a.tex.t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, as, as, gl.RGBA, gl.FLOAT, adata);
    agents = { side: as, count: as * as };
    for (const t of [R.ray, R.trail.a, R.trail.b, R.comp.a, R.comp.b, R.bloomA, R.bloomB]) { WE.GL.bind(gl, t); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    crowd.alloc({ fieldW: tw, fieldH: th });
    layoutClock();
    WE.log(`alloc tier=${T.name} render=${W}x${H} ray=${rw}x${rh} steps=${T.steps} spores=${agents.count} crowd=${T.crowd * T.crowd}`);
  }
  function layoutClock() {
    crowd.layout(monitors, { fullW: window.innerWidth * dpr, fullH: window.innerHeight * dpr, scale: props.clockScale, x: props.clockX, y: props.clockY, showSeconds: props.showSeconds, showDate: props.showDate, hour24: props.hour24 });
  }
  gov.onChange = (t) => { tierIdx = t; alloc(); };
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(alloc, 250); });

  // ------------------------------------------------------------------ genomes
  const rng = U.rand(WE.query.get('seed') ? +WE.query.get('seed') : (Date.now() & 0xffff) + 13);
  const rr = (a, b) => a + rng() * (b - a);
  const gauss = () => (rng() + rng() + rng() - 1.5) * 1.15;

  function randomSlots() {
    const kind = ['bulb', 'box', 'ifs', 'bulb-ifs', 'ifs-box', 'box-bulb', 'tri'][Math.floor(rng() * 7)];
    const one = (k) => k === 'bulb' ? [1, 0, 0] : k === 'box' ? [0, 1, 0] : [0, 0, 1];
    const slots = [];
    for (let i = 0; i < 8; i++) {
      let w;
      if (kind === 'bulb' || kind === 'box' || kind === 'ifs') w = one(kind);
      else if (kind === 'bulb-ifs') w = (i % 3 === 2) ? one('bulb') : one('ifs');
      else if (kind === 'ifs-box') w = (i % 2 === 0) ? one('ifs') : one('box');
      else if (kind === 'box-bulb') w = (i % 4 === 3) ? one('bulb') : one('box');
      else w = [rng(), rng(), rng()];
      if (rng() < 0.2) { const o = one(['bulb', 'box', 'ifs'][Math.floor(rng() * 3)]); w = w.map((v, j) => v * 0.6 + o[j] * 0.4); }
      const s = w[0] + w[1] + w[2]; slots.push(w.map(v => v / s));
    }
    return { kind, slots };
  }
  function randomGenome() {
    const { kind, slots } = randomSlots();
    const hue = rng();
    return {
      kind, slots,
      power: rr(5, 9), juliaC: [gauss() * 0.3, gauss() * 0.3, gauss() * 0.3], juliaMix: rng() < 0.5 ? 0 : rr(0.2, 0.7),
      boxScale: (rng() < 0.5 ? -1 : 1) * rr(1.5, 2.8), boxFold: rr(0.85, 1.15), minR2: rr(0.15, 0.55), fixedR2: rr(0.9, 1.2),
      ifsScale: rr(1.55, 2.2), ifsOff: [rr(0.8, 1.4), rr(0.6, 1.3), rr(0.6, 1.3)],
      rot1: [gauss() * 0.5, gauss() * 0.5, gauss() * 0.5], rot2: [gauss() * 0.5, gauss() * 0.5, gauss() * 0.5],
      iters: rr(9, 13), bailout: 6,
      trapScale: rr(0.25, 0.9),
      pal: [[rr(0.4, 0.55), rr(0.4, 0.55), rr(0.4, 0.55)], [rr(0.4, 0.6), rr(0.4, 0.6), rr(0.4, 0.6)], [rr(0.5, 1.0), rr(0.5, 1.0), rr(0.5, 1.0)], [hue, hue + rr(0.15, 0.45), hue + rr(0.4, 0.8)]],
      fogColor: [rr(0.01, 0.07), rr(0.01, 0.07), rr(0.02, 0.12)], fogDensity: rr(0.08, 0.28),
      glowColor: [rr(0.1, 0.9), rr(0.1, 0.9), rr(0.3, 1.0)], glow: rr(0.3, 1.1),
      light: [rr(0, Math.PI * 2), rr(0.3, 1.2)],
      hover: rr(0.3, 0.6), camSpeed: rr(0.5, 1.2), bright: rr(0.9, 1.3),
    };
  }
  const NUM = ['power', 'juliaMix', 'boxScale', 'boxFold', 'minR2', 'fixedR2', 'ifsScale', 'iters', 'trapScale', 'fogDensity', 'glow', 'hover', 'camSpeed', 'bright'];
  const VEC = ['juliaC', 'ifsOff', 'rot1', 'rot2', 'fogColor', 'glowColor', 'light'];
  const RANGE = { power: [4, 10], juliaMix: [0, 0.8], boxScale: [-3, 3], boxFold: [0.7, 1.3], minR2: [0.1, 0.7], fixedR2: [0.8, 1.4], ifsScale: [1.5, 2.3], iters: [7, 15], trapScale: [0.15, 1.2], fogDensity: [0.1, 1], glow: [0, 1.6], hover: [0.2, 0.9], camSpeed: [0.2, 1.6], bright: [0.6, 1.5] };
  const clone = (g) => JSON.parse(JSON.stringify(g));
  function constrain(g) {
    for (const k of NUM) g[k] = U.clamp(g[k], RANGE[k][0], RANGE[k][1]);
    if (Math.abs(g.boxScale) < 1.4) g.boxScale = 1.4 * Math.sign(g.boxScale || 1);
    for (let i = 0; i < 8; i++) { const s = g.slots[i]; const t = Math.max(1e-6, s[0] + s[1] + s[2]); g.slots[i] = s.map(v => Math.max(0, v) / t); }
    return g;
  }
  function crossover(a, b) {
    const g = clone(a);
    for (const k of NUM) g[k] = rng() < 0.5 ? a[k] : (rng() < 0.5 ? b[k] : U.lerp(a[k], b[k], rng()));
    for (const k of VEC) g[k] = rng() < 0.5 ? clone(a[k]) : clone(b[k]);
    g.pal = rng() < 0.5 ? clone(a.pal) : clone(b.pal);
    for (let i = 0; i < 8; i++) g.slots[i] = rng() < 0.5 ? a.slots[i].slice() : b.slots[i].slice();
    g.kind = a.kind + '×' + b.kind;
    return g;
  }
  function mutate(g, rate) {
    for (const k of NUM) if (rng() < rate) g[k] += gauss() * (RANGE[k][1] - RANGE[k][0]) * 0.12;
    for (const k of VEC) if (rng() < rate) g[k] = g[k].map(v => v + gauss() * 0.2);
    if (rng() < rate) g.pal[3] = g.pal[3].map(v => v + gauss() * 0.08);
    if (rng() < rate * 1.5) { const i = Math.floor(rng() * 8); const f = randomSlots().slots[i]; g.slots[i] = g.slots[i].map((v, j) => U.lerp(v, f[j], 0.5 + rng() * 0.5)); }
    if (rng() < rate * 0.5) g.slots = randomSlots().slots;   // occasional big jump: a new species
    return constrain(g);
  }
  function lerpGenome(a, b, t, out) {
    for (const k of NUM) out[k] = U.lerp(a[k], b[k], t);
    for (const k of VEC) out[k] = a[k].map((v, i) => U.lerp(v, b[k][i], t));
    out.pal = a.pal.map((row, i) => row.map((v, j) => U.lerp(v, b.pal[i][j], t)));
    for (let i = 0; i < 8; i++) out.slots[i] = a.slots[i].map((v, j) => U.lerp(v, b.slots[i][j], t));
    out.bailout = 6;
    return constrain(out);
  }

  // ------------------------------------------------------------------ the pool (Electric Sheep breeding)
  let pool = [];
  async function loadPool() {
    try {
      const saved = WE.hasHost ? await window.host.getData('bulb-pool') : JSON.parse(localStorage.getItem('bulb-pool') || 'null');
      if (saved && Array.isArray(saved.pool) && saved.pool.length) pool = saved.pool.filter(p => p && p.g && p.g.slots);
    } catch (_) {}
    while (pool.length < 8) pool.push({ g: randomGenome(), likes: 0, born: Date.now() });
  }
  function savePool() {
    const data = { pool: pool.slice(-40) };
    try { if (WE.hasHost) window.host.setData('bulb-pool', data); else localStorage.setItem('bulb-pool', JSON.stringify(data)); } catch (_) {}
  }
  function pickParent() {
    // liked genomes breed more; recent ones a little more; everyone gets a chance
    const w = pool.map(p => 1 + p.likes * 3 + Math.max(0, 1 - (Date.now() - (p.born || 0)) / 3.6e6));
    let r = rng() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return pool[i].g; }
    return pool[pool.length - 1].g;
  }
  function breed() {
    let g;
    if (rng() < 0.15) g = randomGenome();                                // fresh blood
    else g = mutate(crossover(pickParent(), pickParent()), 0.25);
    if (pool.length < 40 && rng() < 0.35) pool.push({ g: clone(g), likes: 0, born: Date.now() });
    return g;
  }
  await loadPool();
  let genA = clone(pool[Math.floor(rng() * pool.length)].g), genB = breed(), genCur = clone(genA);
  let morphT = 0, morphDur = 35, skipping = false, lastMutate = 0;
  function nextSheep() { genA = clone(genCur); genB = breed(); morphT = 0; morphDur = rr(25, 50) / Math.max(0.2, props.evolveSpeed); skipping = false; }

  function like() {
    pool.push({ g: clone(genCur), likes: 1, born: Date.now() });
    // also credit the parents currently on screen
    for (const p of pool) if (p.g === genA || p.g === genB) p.likes += 0.5;
    savePool();
    flash('♥ kept this look');
  }
  function skip() { skipping = true; flash('⏭ breeding the next one'); }
  function flash(msg) {
    const d = document.createElement('div'); d.textContent = msg;
    Object.assign(d.style, { position: 'fixed', left: '50%', top: '8%', transform: 'translateX(-50%)', padding: '10px 18px', borderRadius: '12px', background: 'rgba(0,0,0,.55)', color: '#fff', font: '600 20px "Segoe UI", sans-serif', pointerEvents: 'none', transition: 'opacity .8s', zIndex: 9 });
    document.body.appendChild(d); setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 900); }, 1200);
  }

  // ------------------------------------------------------------------ CPU mirror of the distance estimator (for the camera)
  function euler(e) {
    const [a, b, c] = e; const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
    // Rz(c) * Ry(b) * Rx(a), column-major for GL
    const m = [
      cb * cc, cb * sc, -sb,
      sa * sb * cc - ca * sc, sa * sb * sc + ca * cc, sa * cb,
      ca * sb * cc + sa * sc, ca * sb * sc - sa * cc, ca * cb,
    ];
    return m;
  }
  const mulM = (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
  function deJS(p, g, m1, m2, itersF, linearity) {
    let z = p.slice(), dr = 1, r = Math.hypot(z[0], z[1], z[2]);
    const c = [U.lerp(p[0], g.juliaC[0], g.juliaMix), U.lerp(p[1], g.juliaC[1], g.juliaMix), U.lerp(p[2], g.juliaC[2], g.juliaMix)];
    const n = Math.ceil(itersF); let lastW = itersF - Math.floor(itersF); if (lastW <= 0) lastW = 1;
    for (let i = 0; i < n; i++) {
      const w = g.slots[i & 7];
      let zn = [0, 0, 0], drn = 0;
      if (w[0] > 0) {
        const rr0 = Math.max(r, 1e-6), th = Math.acos(U.clamp(z[2] / rr0, -1, 1)) * g.power, ph = Math.atan2(z[1], z[0]) * g.power, zr = Math.pow(rr0, g.power);
        const zb = [zr * Math.sin(th) * Math.cos(ph) + c[0], zr * Math.sin(th) * Math.sin(ph) + c[1], zr * Math.cos(th) + c[2]];
        const drb = Math.pow(rr0, g.power - 1) * g.power * dr + 1;
        zn = zn.map((v, k) => v + w[0] * zb[k]); drn += w[0] * drb;
      }
      if (w[1] > 0) {
        let zb = z.map(v => U.clamp(v, -g.boxFold, g.boxFold) * 2 - v);
        const r2 = zb[0] * zb[0] + zb[1] * zb[1] + zb[2] * zb[2]; let drb = dr;
        if (r2 < g.minR2) { const t = g.fixedR2 / g.minR2; zb = zb.map(v => v * t); drb *= t; }
        else if (r2 < g.fixedR2) { const t = g.fixedR2 / r2; zb = zb.map(v => v * t); drb *= t; }
        zb = zb.map((v, k) => v * g.boxScale + c[k]); drb = drb * Math.abs(g.boxScale) + 1;
        zn = zn.map((v, k) => v + w[1] * zb[k]); drn += w[1] * drb;
      }
      if (w[2] > 0) {
        let zb = mulM(m1, z).map(Math.abs);
        if (zb[0] < zb[1]) [zb[0], zb[1]] = [zb[1], zb[0]];
        if (zb[0] < zb[2]) [zb[0], zb[2]] = [zb[2], zb[0]];
        if (zb[1] < zb[2]) [zb[1], zb[2]] = [zb[2], zb[1]];
        zb = mulM(m2, zb);
        zb = zb.map((v, k) => v * g.ifsScale - g.ifsOff[k] * (g.ifsScale - 1));
        const drb = dr * Math.abs(g.ifsScale);
        zn = zn.map((v, k) => v + w[2] * zb[k]); drn += w[2] * drb;
      }
      if (i === n - 1) { zn = zn.map((v, k) => U.lerp(z[k], v, lastW)); drn = U.lerp(dr, drn, lastW); }
      z = zn; dr = Math.max(drn, 1e-6);
      r = Math.hypot(z[0], z[1], z[2]);
      if (r > g.bailout) break;
    }
    const deLog = 0.5 * Math.log(Math.max(r, 1e-6)) * r / dr, deLin = (r - 1.5) / dr;
    return U.lerp(deLog, deLin, linearity);
  }

  // ------------------------------------------------------------------ camera: orbit that keeps the surface at a chosen distance
  // A CPU ray along the view direction measures where the fractal surface is, so
  // the camera can sit a set distance from it (inside cavities for box-like
  // genomes, outside for bulbs) and creep closer over each genome's life.
  const newCam = (i) => ({ pos: [0, 0, 2.6], theta: rng() * Math.PI * 2 + i * 2.1, phi: 0.3, R: 2.6, dive: 0, fade: 0, drift: [0, 0], stuck: 0 });
  const cams = [newCam(0), newCam(1), newCam(2), newCam(3)];
  const cam = cams[0];
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function marchJS(DEfn, from, dir, maxT) {
    let t = 0;
    for (let i = 0; i < 64; i++) { const d = DEfn([from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t]); if (d < 0.004) return t; t += Math.max(d * 0.8, 0.002); if (t > maxT) return null; }
    return null;
  }
  function updateCamera(cam, dt, DEfn, g, energy, onsetStrong, life) {
    const spd = props.cameraSpeed * g.camSpeed;
    cam.theta += dt * (0.045 + energy * 0.05) * spd;
    cam.phi = 0.25 * Math.sin(cam.theta * 0.37) + 0.15 * Math.sin(cam.theta * 1.7 + 1.0);
    if (onsetStrong) cam.dive = 1;
    cam.dive *= Math.exp(-dt * 0.4);
    const dir = [Math.cos(cam.phi) * Math.cos(cam.theta), Math.sin(cam.phi), Math.cos(cam.phi) * Math.sin(cam.theta)];
    // how far we want the nearest surface (in the middle of the view) to be:
    // starts wide, creeps closer over the genome's life, bass/onset dives pull in
    const want = g.hover * 2.4 * (1 - 0.45 * life) * (1 - 0.4 * cam.dive);
    const sOut = marchJS(DEfn, [0, 0, 0], dir, 4);                 // first surface going outward from the centre
    const sIn = marchJS(DEfn, dir.map(v => v * 4), dir.map(v => -v), 4); // first surface coming in from outside
    let targetR;
    if (sOut != null && sOut > 0.35) targetR = Math.max(0.08, sOut - want);          // hollow centre: fly inside it
    else if (sIn != null) targetR = (4 - sIn) + want;                                 // solid centre: hover outside
    else targetR = 2.2;
    cam.R = U.lerp(cam.R, targetR, 1 - Math.exp(-dt * 0.7));
    cam.pos = dir.map(v => v * cam.R);
    // safety: never sit inside the surface; if it morphs into us, back off along the radial
    const d = DEfn(cam.pos);
    if (d < 0.06) { cam.R += (0.06 - d) * 2; cam.pos = dir.map(v => v * cam.R); }
    if (d < 0.005) cam.stuck += dt; else cam.stuck = 0;
    if (cam.stuck > 0.4) { cam.theta += 1.3; cam.R = targetR + 0.5; cam.fade = 1; cam.stuck = 0; }
    cam.fade *= Math.exp(-dt * 2.5);
    // look at the centre, drifting a little so the composition breathes
    cam.drift[0] += (rng() - 0.5) * dt * 0.3; cam.drift[1] += (rng() - 0.5) * dt * 0.3;
    cam.drift = cam.drift.map(v => v * Math.exp(-dt * 0.3));
    const tgt = [cam.drift[0] * 0.4, cam.drift[1] * 0.4, 0];
    const look = norm3([tgt[0] - cam.pos[0], tgt[1] - cam.pos[1], tgt[2] - cam.pos[2]]);
    let up = [0, 1, 0];
    let r = cross(look, up); if (Math.hypot(...r) < 1e-3) r = [1, 0, 0]; r = norm3(r);
    up = cross(r, look);
    return [r[0], r[1], r[2], up[0], up[1], up[2], look[0], look[1], look[2]];
  }

  // ------------------------------------------------------------------ frame
  let hue = 0, rotSnap = [0, 0, 0], rotSnapTarget = [0, 0, 0], itersGrow = 0, lastOnsetStrong = 0, lastDE = null, lastG = null, lastIters = 0;
  const slotBuf = new Float32Array(24);
  const PALETTES_M = [[0.45, 0.55, 0.55], [0.45, 0.45, 0.45], [1, 1, 1], [0.55, 0.20, 0.40]];

  function frameFn(dt, t) {
    frame++;
    audio.update(dt);
    const inten = props.intensity;
    const bass = U.clamp(audio.bass * inten, 0, 1.5), beat = audio.beat * Math.min(1, inten * 1.2), treb = U.clamp(audio.treble * inten, 0, 1.5), energy = U.clamp(audio.energy * inten, 0, 1.5);
    const amb = audio.silent ? audio.ambient : 0;

    // --- evolution
    morphT += dt / morphDur * (skipping ? 12 : 1) * (1 + energy * 0.5);
    if (morphT >= 1) nextSheep();
    lerpGenome(genA, genB, U.smooth(U.clamp(morphT, 0, 1)), genCur);
    const onsetStrong = audio.onset && energy > 0.5;
    if (onsetStrong && t - lastMutate > 3) { lastMutate = t; mutate(genB, 0.12); }   // the music nudges where we're heading
    if (audio.onset) rotSnapTarget = rotSnapTarget.map(v => v + (rng() < 0.5 ? 1 : -1) * (Math.PI / 12) * (0.5 + rng()) * inten);
    rotSnap = rotSnap.map((v, i) => U.lerp(v, rotSnapTarget[i], 1 - Math.exp(-dt * 8)));
    hue += dt * (0.008 + bass * 0.006) * props.evolveSpeed;

    // --- live (audio) genome: structure changes, not just wobble
    const g = clone(genCur);
    g.power += bass * 1.3 + amb * 0.3;
    g.boxScale *= 1 + bass * 0.09;
    g.ifsScale += bass * 0.22 + audio.kick * inten * 0.12;
    g.juliaMix = U.clamp(g.juliaMix + audio.kick * inten * 0.25, 0, 0.9);
    g.rot2 = g.rot2.map((v, i) => v + rotSnap[i] * 0.35);
    g.rot1 = g.rot1.map((v, i) => v + rotSnap[(i + 1) % 3] * 0.15);
    itersGrow = U.lerp(itersGrow, U.clamp(morphT * 3, 0, 2) + energy * 1.5, 1 - Math.exp(-dt * 0.5));   // detail grows through each sheep's life
    const itersF = U.clamp(g.iters + itersGrow + props.detail - 2, 4, T.itersMax);
    constrain(g);
    const m1 = euler(g.rot1), m2 = euler(g.rot2);
    let bulbW = 0; for (const s of g.slots) bulbW += s[0]; bulbW /= 8;
    const linearity = 1 - bulbW;
    const DEfn = (p) => deJS(p, g, m1, m2, itersF, linearity);
    lastDE = DEfn; lastG = g; lastIters = itersF;
    const strongNow = onsetStrong && t - lastOnsetStrong > 2.5 && (lastOnsetStrong = t, true);
    const nCams = Math.min(4, Math.max(1, monitors.length));
    const camRots = [], camPosArr = new Float32Array(12), camRotArr = new Float32Array(36), monRects = new Float32Array(16);
    const fw = window.innerWidth * dpr, fh = window.innerHeight * dpr;
    for (let i = 0; i < nCams; i++) {
      const rot = updateCamera(cams[i], dt, DEfn, g, energy + amb * 0.3, strongNow, U.clamp(morphT, 0, 1));
      camRots.push(rot);
      camPosArr.set(cams[i].pos, i * 3); camRotArr.set(rot, i * 9);
      const m = monitors[i] || monitors[0];
      monRects.set([m.x / fw, 1 - (m.y + m.h) / fh, m.w / fw, m.h / fh], i * 4);
    }
    const camRot = camRots[0];

    gl.disable(gl.DEPTH_TEST);

    // ==== 1. raymarch
    WE.GL.bind(gl, R.ray);
    gl.useProgram(P.ray.p);
    const u = P.ray.u;
    gl.uniform2f(u.uRes, R.ray.w, R.ray.h);
    gl.uniform3fv(u.uCamPos, camPosArr);
    gl.uniformMatrix3fv(u.uCamRot, false, camRotArr);
    gl.uniform4fv(u.uMonRect, monRects);
    gl.uniform1i(u.uNMon, nCams);
    const halfFovY = 0.5;
    gl.uniform1f(u.uHalfFovY, halfFovY);
    gl.uniform1i(u.uSteps, T.steps);
    gl.uniform1f(u.uStepMul, 0.72);
    gl.uniform1f(u.uPixel, Math.tan(halfFovY) * 2 / R.ray.h * 0.9);
    gl.uniform1f(u.uFar, 8);
    gl.uniform1i(u.uAoSamples, T.ao);
    for (let i = 0; i < 8; i++) slotBuf.set(g.slots[i], i * 3);
    gl.uniform3fv(u.uSlotW, slotBuf);
    gl.uniform1f(u.uItersF, itersF);
    gl.uniform1f(u.uPower, g.power);
    gl.uniform3fv(u.uJuliaC, g.juliaC); gl.uniform1f(u.uJuliaMix, g.juliaMix);
    gl.uniform1f(u.uBoxScale, g.boxScale); gl.uniform1f(u.uBoxFold, g.boxFold); gl.uniform1f(u.uMinR2, g.minR2); gl.uniform1f(u.uFixedR2, g.fixedR2);
    gl.uniform1f(u.uIfsScale, g.ifsScale); gl.uniform3fv(u.uIfsOffset, g.ifsOff);
    gl.uniformMatrix3fv(u.uRot1, false, m1); gl.uniformMatrix3fv(u.uRot2, false, m2);
    gl.uniform1f(u.uLinearity, linearity);
    gl.uniform1f(u.uBailout, g.bailout);
    gl.uniform3fv(u.uPalA, g.pal[0]); gl.uniform3fv(u.uPalB, g.pal[1]); gl.uniform3fv(u.uPalC, g.pal[2]); gl.uniform3fv(u.uPalD, g.pal[3]);
    gl.uniform1f(u.uHue, hue + beat * 0.03);
    gl.uniform1f(u.uTrapScale, g.trapScale);
    {   // key light sits up-left-front of the camera, nudged by the genome so genomes differ
      const lx = 0.45 + Math.cos(g.light[0]) * 0.35, ly = 0.75, lz = -0.35 + Math.sin(g.light[0]) * 0.25;
      const cr = camRot;
      gl.uniform3f(u.uLightDir, cr[0] * lx + cr[3] * ly + cr[6] * lz, cr[1] * lx + cr[4] * ly + cr[7] * lz, cr[2] * lx + cr[5] * ly + cr[8] * lz);
    }
    gl.uniform3fv(u.uFogColor, g.fogColor.map(v => v * props.fog));
    gl.uniform1f(u.uFogDensity, g.fogDensity * props.fog);
    gl.uniform3fv(u.uGlowColor, g.glowColor);
    gl.uniform1f(u.uGlow, g.glow * props.glow);
    gl.uniform1f(u.uBright, g.bright * props.brightness * (1 - Math.max(...cams.slice(0, nCams).map(c => c.fade))));
    gl.uniform4f(u.uAudio, bass, beat, treb, energy);
    gl.uniform1f(u.uTime, t);
    { const h2 = (n, b) => { let f = 1, r = 0; while (n > 0) { f /= b; r += f * (n % b); n = Math.floor(n / b); } return r; }; const j = frame % 8; gl.uniform2f(u.uJitter, h2(j + 1, 2) - 0.5, h2(j + 1, 3) - 0.5); }
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);

    // ==== 2. spores (faint, crawling on the bright surfaces)
    if (props.sporeAmount > 0.001) {
      const dts = Math.min(dt * 60, 2.5), px = R.trail.h / 540;
      WE.GL.bind(gl, R.agents.write);
      gl.useProgram(P.agent.p);
      WE.GL.tex(gl, 0, R.agents.read.tex, P.agent.u.uAgents);
      WE.GL.tex(gl, 1, R.trail.read.tex, P.agent.u.uTrail);
      WE.GL.tex(gl, 2, R.ray.tex, P.agent.u.uScene);
      gl.uniform2f(P.agent.u.uRes, R.trail.w, R.trail.h);
      gl.uniform1ui(P.agent.u.uFrame, frame >>> 0);
      gl.uniform1f(P.agent.u.uSA, 0.42); gl.uniform1f(P.agent.u.uSD, 9 * px); gl.uniform1f(P.agent.u.uRA, 0.45);
      gl.uniform1f(P.agent.u.uSS, 1.1 * px * dts);
      gl.uniform4f(P.agent.u.uAudio, bass, beat, treb, energy);
      gl.uniform1f(P.agent.u.uOnset, audio.onset ? 1 : 0);
      gl.uniform1f(P.agent.u.uFood, 1.2);
      gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      R.agents.swap();
      WE.GL.bind(gl, R.trail.read);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(P.deposit.p);
      WE.GL.tex(gl, 0, R.agents.read.tex, P.deposit.u.uAgents);
      gl.uniform1i(P.deposit.u.uSide, agents.side);
      gl.uniform2f(P.deposit.u.uRes, R.trail.w, R.trail.h);
      gl.uniform1f(P.deposit.u.uDeposit, 0.05 * (102400 / agents.count) * dts);
      gl.drawArrays(gl.POINTS, 0, agents.count);
      gl.disable(gl.BLEND);
      WE.GL.bind(gl, R.trail.write);
      gl.useProgram(P.diffuse.p);
      WE.GL.tex(gl, 0, R.trail.read.tex, P.diffuse.u.uTrail);
      gl.uniform2f(P.diffuse.u.uRes, R.trail.w, R.trail.h);
      gl.uniform1f(P.diffuse.u.uDecay, Math.pow(0.93, dts));
      gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      R.trail.swap();
    }

    // ==== 3. mold clock
    crowd.setTime();
    crowd.update(dt, { beat, bass });

    // ==== 4. composite (upscale + temporal + layers)
    WE.GL.bind(gl, R.comp.write);
    gl.useProgram(P.comp.p);
    WE.GL.tex(gl, 0, R.ray.tex, P.comp.u.uRay);
    WE.GL.tex(gl, 1, R.comp.read.tex, P.comp.u.uPrev);
    WE.GL.tex(gl, 2, R.trail.read.tex, P.comp.u.uTrail);
    WE.GL.tex(gl, 3, crowd.field.tex, P.comp.u.uField);
    WE.GL.tex(gl, 4, crowd.fieldOld.tex, P.comp.u.uFieldOld);
    WE.GL.tex(gl, 5, crowd.layer.tex, P.comp.u.uClockLayer);
    gl.uniform2fv(P.comp.u.uMoldPx, crowd.texel);
    gl.uniform1f(P.comp.u.uTime, t);
    gl.uniform1f(P.comp.u.uMorph, U.smooth(crowd.morph));
    gl.uniform2f(P.comp.u.uRes, W, H);
    gl.uniform2f(P.comp.u.uRayRes, R.ray.w, R.ray.h);
    gl.uniform1f(P.comp.u.uTemporal, Math.max(...cams.slice(0, nCams).map(c => c.fade)) > 0.05 ? 0 : Math.min(0.85, T.temporal + 0.25));
    gl.uniform1f(P.comp.u.uSporeAmt, props.sporeAmount);
    gl.uniform3fv(P.comp.u.uMycA, PALETTES_M[0]); gl.uniform3fv(P.comp.u.uMycB, PALETTES_M[1]); gl.uniform3fv(P.comp.u.uMycC, PALETTES_M[2]); gl.uniform3fv(P.comp.u.uMycD, PALETTES_M[3]);
    gl.uniform1f(P.comp.u.uHue, hue);
    gl.uniform1f(P.comp.u.uClockContrast, props.clockContrast);
    gl.uniform4f(P.comp.u.uAudio, bass, beat, treb, energy);
    gl.uniform1i(P.comp.u.uView, DEBUG_VIEW);
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    R.comp.swap();

    // ==== 5. bloom
    WE.GL.bind(gl, R.bloomA);
    gl.useProgram(P.down.p);
    WE.GL.tex(gl, 0, R.comp.read.tex, P.down.u.uSrc);
    gl.uniform2f(P.down.u.uRes, R.bloomA.w, R.bloomA.h);
    gl.uniform1f(P.down.u.uThresh, 0.7);
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    for (let i = 0; i < 2; i++) {
      WE.GL.bind(gl, R.bloomB); gl.useProgram(P.blur.p); WE.GL.tex(gl, 0, R.bloomA.tex, P.blur.u.uSrc); gl.uniform2f(P.blur.u.uDir, 1 / R.bloomA.w, 0);
      gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      WE.GL.bind(gl, R.bloomA); WE.GL.tex(gl, 0, R.bloomB.tex, P.blur.u.uSrc); gl.uniform2f(P.blur.u.uDir, 0, 1 / R.bloomA.h);
      gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    }

    // ==== 6. final
    WE.GL.bind(gl, null, W, H);
    gl.useProgram(P.final.p);
    WE.GL.tex(gl, 0, R.comp.read.tex, P.final.u.uComp);
    WE.GL.tex(gl, 1, R.bloomA.tex, P.final.u.uBloom);
    gl.uniform2f(P.final.u.uRes, W, H);
    gl.uniform1f(P.final.u.uTime, t);
    gl.uniform4f(P.final.u.uAudio, bass, beat, treb, energy);
    gl.uniform1f(P.final.u.uBloomAmt, 0.45 * props.glow);
    gl.uniform1f(P.final.u.uCA, 1.0 * inten);
    gl.uniform1f(P.final.u.uGrain, 0.01);
    const mon = new Float32Array(16), nMon = Math.min(4, monitors.length);
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
      if (p.rayScale !== old.rayScale) alloc();
      else if (['clockScale', 'clockX', 'clockY', 'showSeconds', 'showDate', 'hour24'].some(k => p[k] !== old[k])) layoutClock();
    });
    window.host.onSettings((s) => { const prev = settings.audioSource; settings = s; gov.applySettings(s); if (s.audioSource !== prev) audio.start(s.audioSource); });
    window.host.onCovered((list) => { const c = (list || []).length > 0; if (c !== covered) { covered = c; alloc(); } });
    window.host.onContext((c) => { Object.assign(ctx, c); monitors.splice(0, monitors.length, ...c.monitors); layoutClock(); });
    window.host.onIdentify(() => WE.identify(monitors.map(m => ({ index: m.index, x: m.x / dpr, y: m.y / dpr, w: m.w / dpr, h: m.h / dpr }))));
    if (window.host.onAction) window.host.onAction((name) => { if (name === 'like') like(); else if (name === 'skip') skip(); else if (name === 'fresh') { genB = randomGenome(); skipping = true; flash('✨ fresh genome'); } });
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'l') like(); if (e.key === 'n') skip(); });
  if (WE.query.get('debug')) window.__bulb = { get genome() { return genCur; }, get live() { return lastG; }, get iters() { return lastIters; }, de: (p) => lastDE ? lastDE(p) : null, get cam() { return cam; }, pool: () => pool, like, skip };

  alloc();
  WE.Loop.run({
    frame: frameFn,
    governor: gov,
    stats: (fps) => ({ fps, tier: T.name, width: W, height: H, audio: `${audio.source} ${audio.status}${audio.bpm ? ' ~' + Math.round(audio.bpm) + 'bpm' : ''} · sheep ${Math.round(morphT * 100)}% (${genB.kind})` }),
  });
})().catch((e) => { console.error(e); const b = document.getElementById('err'); b.style.display = 'grid'; b.textContent = String(e && e.stack || e); });
