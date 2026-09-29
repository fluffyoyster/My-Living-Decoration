// Garbage Collector — live read-only system text, formed into evolving shapes.
(async function () {
  'use strict';
  const errBox = document.getElementById('err');
  const fail = (e) => { console.error(e); errBox.style.display = 'grid'; errBox.textContent = String(e && e.stack || e); };
  window.addEventListener('error', (e) => fail(e.error || e.message));

  const DEFAULTS = {
    roundSeconds: 300, formations: 'shuffle', density: 1, glyphScale: 1, spin: 1,
    colorMode: 'uniform', baseColor: '#c3ccd8',
    colFile: '#c3ccd8', colReg: '#c3ccd8', colDll: '#c3ccd8', colStack: '#c3ccd8', colNet: '#c3ccd8',
    colDns: '#c3ccd8', colPs: '#c3ccd8', colHist: '#c3ccd8', colProc: '#c3ccd8',
    glow: 0.7, clockScale: 1, clockX: 0.16, clockY: 0.82, clockColor: '#8f9aa8',
    hour24: false, showDate: true, redactView: true,
  };
  const ctx = await WE.boot({ defaults: DEFAULTS });
  const props = ctx.props;
  let settings = ctx.settings || {};
  const S = window.GC_SHADERS;
  const U = WE.util;
  const DBG_DIE = !!WE.query.get('startdie');   // debug: begin rounds in the death phase

  const canvas = document.getElementById('c');
  const ui = document.getElementById('ui');
  const uic = ui.getContext('2d');
  let gl;
  try { gl = WE.GL.create(canvas); } catch (e) { return fail(e); }
  if (!gl.ext.cbf) return fail('This GPU/driver does not support float render targets (EXT_color_buffer_float).');

  const SRC_KEYS = ['file', 'reg', 'dll', 'stack', 'net', 'dns', 'ps', 'hist', 'proc'];
  const SRCID = { file: 0, reg: 1, dll: 2, stack: 3, net: 4, dns: 5, ps: 6, hist: 7, proc: 8 };

  // ---------------- glyph atlas ----------------
  const atlas = WE.Glyphs.build({ cellW: 96, cellH: 128, spread: 20 });
  const atlasTex = WE.GL.texture(gl, atlas.width, atlas.height, 'r8', { data: atlas.data, filter: gl.LINEAR });
  const CHARSET = atlas.chars;
  const charToGlyph = (ch) => { const i = CHARSET.indexOf(ch); return i; };

  // ---------------- tiers (glyph budget) ----------------
  const TIERS = [
    { name: 'low', G: 96, scale: 0.7, bloom: 0.22 },
    { name: 'medium', G: 112, scale: 0.85, bloom: 0.28 },
    { name: 'high', G: 128, scale: 1.0, bloom: 0.33 },
  ];
  const gov = new WE.Governor(TIERS.length, settings);
  let tierIdx = ctx.preview ? 0 : gov.tier;
  let T = TIERS[tierIdx];

  // ---------------- programs ----------------
  const P = {};
  try {
    P.sim = WE.GL.program(gl, S.QUAD_VS, S.SIM_FS, 'sim');
    P.glyph = WE.GL.program(gl, S.GLYPH_VS, S.GLYPH_FS, 'glyph');
    P.down = WE.GL.program(gl, S.QUAD_VS, S.DOWN_FS, 'down');
    P.blur = WE.GL.program(gl, S.QUAD_VS, S.BLUR_FS, 'blur');
    P.final = WE.GL.program(gl, S.QUAD_VS, S.FINAL, 'final');
  } catch (e) { return fail(e); }
  const quad = WE.GL.quad(gl);

  // instanced corner quad
  const cornerVAO = gl.createVertexArray();
  gl.bindVertexArray(cornerVAO);
  const cbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cbuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // ---------------- state textures ----------------
  const dpr = window.devicePixelRatio || 1;
  let G = T.G, W = 0, H = 0;
  let pos, vel, par, meta, simFB, scene, bloomA, bloomB;
  let monPx = [], monSide = [], tubeX = [], uMonArr = new Float32Array(24), minWHg = 400, glyphPx = 18;
  let tubeVis = 0, tubeY = 0, tubeWpx = 160, tubeMaxY = 80, taskbarPx = 30;
  const uPistonStart = 1.3, uPistonDur = 2.0;
  let pistonXarr = new Float32Array(6), pistonActive = 0, pistonWpx = 40, pistonHpx = 40;
  function computeTube() {
    if (phase === PHASE.ASSEMBLE) {
      const dn = U.clamp(phaseT / 0.5, 0, 1);
      const retract = U.clamp((phaseT - (POUR_DUR + 0.4)) / 0.6, 0, 1);
      tubeY = tubeMaxY * dn * (1 - retract);           // extends, then RETRACTS up into the roof
      tubeVis = (dn > 0.01 && retract < 0.999) ? 1 : 0;
    } else { tubeVis = 0; tubeY = 0; }
  }
  function computeDeath() {
    if (phase !== PHASE.DIE) { pistonActive = 0; return; }
    const k = U.clamp((phaseT - uPistonStart) / uPistonDur, 0, 1);
    for (let i = 0; i < monPx.length; i++) {
      const R = monPx[i], side = monSide[i];
      const inner = side > 0 ? R[0] : R[0] + R[2];
      const outer = side > 0 ? R[0] + R[2] : R[0];
      pistonXarr[i] = inner + (outer - inner) * k;
    }
    pistonActive = phaseT > uPistonStart ? 1 : 0;
  }

  function computeMonitors() {
    const mons = (ctx.monitors && ctx.monitors.length) ? ctx.monitors
      : [{ index: 0, x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of mons) { minX = Math.min(minX, m.x); minY = Math.min(minY, m.y); maxX = Math.max(maxX, m.x + m.w); maxY = Math.max(maxY, m.y + m.h); }
    const totW = Math.max(1, maxX - minX), totH = Math.max(1, maxY - minY);
    const sx = W / totW, sy = H / totH;
    monPx = mons.map(m => [(m.x - minX) * sx, (m.y - minY) * sy, m.w * sx, m.h * sy]);
    const gcx = W * 0.5;
    monSide = monPx.map(r => (mons.length === 1 ? 1 : ((r[0] + r[2] * 0.5) < gcx ? -1 : 1)));
    tubeX = monPx.map(r => r[0] + r[2] * 0.5);
    uMonArr = new Float32Array(24);
    for (let i = 0; i < Math.min(6, monPx.length); i++) uMonArr.set(monPx[i], i * 4);
    for (let i = monPx.length; i < 6; i++) uMonArr.set(monPx[monPx.length - 1] || [0, 0, W, H], i * 4);
    minWHg = Math.min(monPx[0][2], monPx[0][3]);
    glyphPx = U.clamp(minWHg * 0.02, 10, 44);
    tubeWpx = U.clamp(monPx[0][2] * 0.22, 120, 4000);   // short + wide, per the sketch
    tubeMaxY = monPx[0][3] * 0.13;
    taskbarPx = Math.max(24, monPx[0][3] * 0.045);      // physical floor ~ taskbar height
    pistonWpx = Math.max(80, minWHg * 0.18);            // wide ram
    pistonHpx = Math.max(26, minWHg * 0.11);            // short — text lands in a thin band
  }

  function alloc() {
    T = TIERS[tierIdx]; G = T.G;
    const fullW = Math.max(2, Math.round(window.innerWidth * dpr));
    const fullH = Math.max(2, Math.round(window.innerHeight * dpr));
    W = Math.max(2, Math.round(fullW * T.scale)); H = Math.max(2, Math.round(fullH * T.scale));
    canvas.width = W; canvas.height = H;
    ui.width = fullW; ui.height = fullH;
    // free old
    for (const pp of [pos, vel]) if (pp) { WE.GL.destroyTarget(gl, pp.a); WE.GL.destroyTarget(gl, pp.b); }
    for (const t of [par, meta, scene, bloomA, bloomB]) if (t) WE.GL.destroyTarget(gl, t);
    pos = WE.GL.pingpong(gl, G, G, 'rgba32f', { filter: gl.NEAREST });
    vel = WE.GL.pingpong(gl, G, G, 'rgba32f', { filter: gl.NEAREST });
    par = WE.GL.target(gl, G, G, 'rgba32f', { filter: gl.NEAREST });
    meta = WE.GL.target(gl, G, G, 'rgba32f', { filter: gl.NEAREST });
    scene = WE.GL.target(gl, W, H, 'rgba16f');
    const bw = Math.max(2, W >> 2), bh = Math.max(2, H >> 2);
    bloomA = WE.GL.target(gl, bw, bh, 'rgba16f');
    bloomB = WE.GL.target(gl, bw, bh, 'rgba16f');
    if (!simFB) simFB = gl.createFramebuffer();
    computeMonitors();
    buildFormation(true);
    WE.log(`alloc tier=${T.name} render=${W}x${H} glyphs=${G * G} monitors=${monPx.length}`);
  }
  gov.onChange = (t) => { tierIdx = t; alloc(); };
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(alloc, 250); });

  // ---------------- feed pool ----------------
  // Each entry is a whole line of activity, kept intact so it can be poured as
  // a readable string. { s: sourceId, g: [glyphIndex,...] }
  const pool = [];
  let poolChars = 0;
  const POOL_CAP = 60000;
  let lastFeedTs = 0;
  const TOKEN_RE = /\b([A-Za-z0-9+\/_-]{20,})\b/g;   // token/base64/hex-shaped
  function redact(text) {
    if (!props.redactView) return text;
    return text.replace(TOKEN_RE, m => '·'.repeat(Math.min(m.length, 8)));
  }
  function ingest(text, srcId) {
    const t = redact(String(text)).toUpperCase();
    const g = [];
    for (let i = 0; i < t.length; i++) { const gi = charToGlyph(t[i]); if (gi >= 0) g.push(gi); }
    if (g.length < 2) return;
    pool.push({ s: srcId, g }); poolChars += g.length;
    while (poolChars > POOL_CAP && pool.length > 1) poolChars -= pool.shift().g.length;
  }

  // synthetic feed (used with no host / feed, and to keep the scene alive)
  const FAKE = {
    file: ['C:/WINDOWS/SYSTEM32/KERNEL32.DLL', 'C:/USERS/~/APPDATA/LOCAL/TEMP/CHROME.TMP', 'D:/GAMES/STEAM/STEAMAPPS/COMMON', '/DEVICE/HARDDISK0/DR0', 'C:/PROGRAMDATA/NVIDIA/GLCACHE'],
    reg: ['HKLM/SYSTEM/CURRENTCONTROLSET/SERVICES/BAM', 'HKCU/SOFTWARE/MICROSOFT/WINDOWS/CURRENTVERSION/RUN', 'HKLM/SOFTWARE/CLASSES/CLSID'],
    dll: ['NTDLL.DLL+0X4A3C0', 'D3D12.DLL', 'KERNELBASE.DLL', 'USER32.DLL', 'NVWGF2UMX.DLL'],
    stack: ['NTDLL!NTWAITFORSINGLEOBJECT', 'D3D12!EXECUTECOMMANDLISTS', 'WIN32U!NTUSERGETMESSAGE', 'NTOSKRNL!KEWAITFORMULTIPLE'],
    net: ['TCP 140.82.113.25:443 ESTABLISHED', 'UDP 224.0.0.251:5353', 'TCP 10.0.0.14:51820'],
    dns: ['GITHUB.COM', 'STEAMCONTENT.COM', 'CLIENTS4.GOOGLE.COM', 'DISCORD.GG'],
    ps: ['GET-PROCESS | SORT CPU', 'GET-CIMINSTANCE WIN32_PROCESS', '$ENV:PATH -SPLIT ";"'],
    hist: ['GIT PUSH ORIGIN MAIN', 'NPM RUN BUILD', 'CD DESKTOP/WALLPAPER-ENGINE-CLONE', 'CARGO BUILD --RELEASE'],
    proc: ['CHROME.EXE --TYPE=RENDERER', 'ELECTRON.EXE', 'CODE.EXE', 'DWM.EXE', 'SVCHOST.EXE -K NETWORKSERVICE'],
  };
  function synthTick() {
    const keys = SRC_KEYS;
    for (let n = 0; n < 3; n++) {
      const k = keys[(Math.random() * keys.length) | 0];
      const arr = FAKE[k]; ingest(arr[(Math.random() * arr.length) | 0], SRCID[k]);
    }
  }

  async function pullHostFeed() {
    if (!(WE.hasHost && window.host.gcPull)) return false;
    try {
      const res = await window.host.gcPull(lastFeedTs);
      if (res && res.lines) { for (const ln of res.lines) ingest(ln.text || '', SRCID[ln.src] != null ? SRCID[ln.src] : 8); lastFeedTs = res.ts || lastFeedTs; }
      return true;
    } catch (e) { WE.log('gcPull failed', e && e.message); return false; }
  }

  // ---------------- mesh point clouds (objects formation) ----------------
  // Each returns array of vec3 in ~[-1,1]. Parametric Blender primitives + teapot + Suzanne approx.
  const MESH = {
    uvsphere(n) { const o = []; for (let i = 0; i < n; i++) { const y = 1 - 2 * (i + 0.5) / n; const r = Math.sqrt(Math.max(0, 1 - y * y)); const a = i * 2.399963; o.push([r * Math.cos(a), y, r * Math.sin(a)]); } return o; },
    icosphere(n) { return this.uvsphere(n); },
    cube(n) { const o = []; for (let i = 0; i < n; i++) { const f = (Math.random() * 6) | 0; let u = Math.random() * 2 - 1, v = Math.random() * 2 - 1; const c = [[1, u, v], [-1, u, v], [u, 1, v], [u, -1, v], [u, v, 1], [u, v, -1]][f]; o.push(c); } return o; },
    plane(n) { const o = []; for (let i = 0; i < n; i++) o.push([Math.random() * 2 - 1, 0, Math.random() * 2 - 1]); return o; },
    grid(n) { const o = []; const s = Math.ceil(Math.sqrt(n)); for (let i = 0; i < n; i++) { const gx = i % s, gy = (i / s) | 0; o.push([gx / (s - 1) * 2 - 1, 0, gy / (s - 1) * 2 - 1]); } return o; },
    circle(n) { const o = []; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; o.push([Math.cos(a), 0, Math.sin(a)]); } return o; },
    cylinder(n) { const o = []; for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2; const y = Math.random() * 2 - 1; o.push([Math.cos(a), y, Math.sin(a)]); } return o; },
    cone(n) { const o = []; for (let i = 0; i < n; i++) { const y = Math.random() * 2 - 1; const r = (1 - (y + 1) / 2); const a = Math.random() * Math.PI * 2; o.push([r * Math.cos(a), y, r * Math.sin(a)]); } return o; },
    torus(n) { const o = []; const R = 0.7, r = 0.32; for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI * 2; o.push([(R + r * Math.cos(b)) * Math.cos(a), r * Math.sin(b), (R + r * Math.cos(b)) * Math.sin(a)]); } return o; },
    teapot(n) { return teapotPoints(n); },
    suzanne(n) { return suzannePoints(n); },
  };
  const MESH_KEYS = ['uvsphere', 'icosphere', 'cube', 'cylinder', 'cone', 'torus', 'plane', 'circle', 'grid', 'teapot', 'suzanne'];

  // ---------------- formation state machine ----------------
  const FORMS = ['vortex', 'flow', 'objects'];
  const PHASE = { ASSEMBLE: 0, HOLD: 1, DIE: 2 };
  let form = 'vortex', death = 0, phase = PHASE.ASSEMBLE;
  let roundT = 0, phaseT = 0, activeCount = 0, meshKey = 'uvsphere';
  let formIdx = 0, externalFeedSeen = false;

  function pickForm() {
    const mode = props.formations;
    if (mode !== 'shuffle') return mode;
    formIdx = (formIdx + 1 + ((Math.random() * (FORMS.length - 1)) | 0)) % FORMS.length;
    return FORMS[formIdx];
  }

  // Newest whole entries until we have >= need characters (chronological order).
  // Pads by cycling existing entries if the pool is still thin (early boot).
  function takeEntries(need) {
    const out = []; let n = 0;
    for (let i = pool.length - 1; i >= 0 && n < need; i--) { out.unshift(pool[i]); n += pool[i].g.length; }
    if (n < need && pool.length) { let i = 0; while (n < need && i < need) { const e = pool[i % pool.length]; out.push(e); n += e.g.length; i++; } }
    if (!out.length) out.push({ s: 8, g: [(Math.random() * 36) | 0, (Math.random() * 36) | 0, (Math.random() * 36) | 0] });
    return out;
  }

  function buildFormation(initial) {
    form = initial ? (props.formations === 'shuffle' ? FORMS[0] : props.formations) : pickForm();
    death = 0;   // all formations fall onto the taskbar floor, then the piston sweeps them off
    if (form === 'objects') meshKey = MESH_KEYS[(Math.random() * MESH_KEYS.length) | 0];

    const budget = Math.floor(G * G * 0.94);
    const want = { vortex: 9500, flow: 8000, objects: 6000 }[form];
    activeCount = Math.min(budget, Math.floor(want * props.density * (G / 128) * (G / 128)));

    // flatten whole entries into glyphs, preserving word membership + char index
    const entries = takeEntries(activeCount);
    const flat = [];
    for (let w = 0; w < entries.length; w++) {
      const e = entries[w], wl = e.g.length;
      for (let ci = 0; ci < wl; ci++) { flat.push({ c: e.g[ci], s: e.s, word: w, ci, wl }); if (flat.length >= activeCount) break; }
      if (flat.length >= activeCount) break;
    }
    activeCount = flat.length;
    const totalWords = flat.length ? flat[flat.length - 1].word + 1 : 1;
    const monCount = monPx.length;

    const pd = new Float32Array(G * G * 4);   // par
    const md = new Float32Array(G * G * 4);   // meta
    const p0 = new Float32Array(G * G * 4);   // pos
    const v0 = new Float32Array(G * G * 4);   // vel

    let meshPts = null;
    if (form === 'objects') meshPts = MESH[meshKey](activeCount);

    const spacing = glyphPx * 0.66;

    for (let i = 0; i < G * G; i++) {
      const o = i * 4;
      if (i >= activeCount) { p0[o + 3] = 1; continue; } // off
      const f = flat[i];
      const mon = f.word % monCount;                 // whole word -> one monitor
      const R = monPx[mon];
      // meta: glyph, source, monitor, per-word pour delay (0..1)
      md[o] = f.c; md[o + 1] = f.s; md[o + 2] = mon; md[o + 3] = totalWords > 1 ? f.word / (totalWords - 1) : 0;
      // par: formation target (still scattered — words fall apart into the shape)
      if (form === 'vortex') {
        const r = 0.14 + 0.86 * Math.pow(Math.random(), 0.62);
        const arms = 5, armJit = 0.55;
        const ang = (Math.round(Math.random() * arms) / arms) * Math.PI * 2 + (Math.random() - 0.5) * armJit;
        pd[o] = ang; pd[o + 1] = r; pd[o + 2] = 2.7; pd[o + 3] = 1;
      } else if (form === 'flow') {
        pd[o] = Math.random(); pd[o + 1] = Math.random(); pd[o + 2] = Math.random() * 2 - 1; pd[o + 3] = 0;
      } else {
        const mp = meshPts[i]; pd[o] = mp[0]; pd[o + 1] = mp[1]; pd[o + 2] = mp[2]; pd[o + 3] = 0;
      }
      // initial pos: the whole word SQUISHED to fit inside the pipe, so long lines
      // don't clip the walls; it spreads out as it eases toward its formation spot.
      const usable = tubeWpx * 0.82;
      const sp = Math.min(spacing, usable / Math.max(1, f.wl));
      const ox = (f.ci - (f.wl - 1) / 2) * sp;
      if (DBG_DIE) {   // debug: start already scattered + active so the death can be captured
        p0[o] = R[0] + Math.random() * R[2]; p0[o + 1] = R[1] + Math.random() * R[3] * 0.6; p0[o + 2] = 0; p0[o + 3] = 0;
        v0[o] = 0; v0[o + 1] = 0; v0[o + 2] = 0; v0[o + 3] = 1;
      } else {
        p0[o] = R[0] + R[2] * 0.5 + ox;
        p0[o + 1] = R[1] + tubeMaxY * 0.5 + ((f.ci % 3) - 1) * 3;
        p0[o + 2] = -minWHg * 0.45; p0[o + 3] = 0;
        v0[o] = 0; v0[o + 1] = 0; v0[o + 2] = 0; v0[o + 3] = 0; // inactive until its word's delay
      }
    }
    upload(par.tex, pd); upload(meta.tex, md);
    upload(pos.a.tex, p0); upload(pos.b.tex, p0);
    upload(vel.a.tex, v0); upload(vel.b.tex, v0);

    phase = DBG_DIE ? PHASE.DIE : PHASE.ASSEMBLE; roundT = DBG_DIE ? assembleDur() + 4 : 0; phaseT = 0;
    WE.log(`formation=${form}${form === 'objects' ? '(' + meshKey + ')' : ''} glyphs=${activeCount} death=${death}`);
  }
  function upload(tex, data) { gl.bindTexture(gl.TEXTURE_2D, tex.t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, G, G, gl.RGBA, gl.FLOAT, data); }

  // timings
  const POUR_DUR = 5.0;
  function assembleDur() { return POUR_DUR + 3.5; }   // readable, slow settle
  function dieDur() { return uPistonStart + uPistonDur + 0.6; }   // fall + full piston sweep

  // ---------------- uniforms helpers ----------------
  function srcColors() {
    const out = new Float32Array(27);
    const uni = props.colorMode !== 'source';
    const keys = ['colFile', 'colReg', 'colDll', 'colStack', 'colNet', 'colDns', 'colPs', 'colHist', 'colProc'];
    for (let i = 0; i < 9; i++) { const c = U.hexToRgb(uni ? props.baseColor : props[keys[i]]); out.set(c, i * 3); }
    return out;
  }

  // ---------------- sim + render ----------------
  function simStep(dt, t) {
    const u = P.sim.u;
    gl.useProgram(P.sim.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, simFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pos.write.tex.t, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, vel.write.tex.t, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, G, G); gl.disable(gl.BLEND);
    WE.GL.tex(gl, 0, pos.read.tex, u.uPos);
    WE.GL.tex(gl, 1, vel.read.tex, u.uVel);
    WE.GL.tex(gl, 2, par.tex, u.uPar);
    WE.GL.tex(gl, 3, meta.tex, u.uMeta);
    gl.uniform4fv(u.uMon, uMonArr);
    gl.uniform1fv(u.uMonSide, new Float32Array(monSide.concat([1, 1, 1, 1, 1, 1]).slice(0, 6)));
    gl.uniform1i(u.uMode, FORMS.indexOf(form));
    gl.uniform1i(u.uPhase, phase);
    gl.uniform1i(u.uDeath, death);
    gl.uniform1f(u.uDt, dt); gl.uniform1f(u.uFormTime, roundT); gl.uniform1f(u.uPhaseT, phaseT);
    gl.uniform1f(u.uSpin, props.spin);
    gl.uniform1f(u.uPourDur, POUR_DUR); gl.uniform1f(u.uPourSpeed, minWHg * 0.28); gl.uniform1f(u.uPourDepth, -minWHg * 0.45); gl.uniform1f(u.uTubeW, tubeWpx); gl.uniform1f(u.uMouthY, tubeY);
    gl.uniform1f(u.uAssembleLock, 2.4); gl.uniform1f(u.uHoldLock, 13.0);
    gl.uniform1f(u.uVortexDepth, minWHg * 0.9); gl.uniform1f(u.uFlowDepth, minWHg * 0.15);
    gl.uniform1f(u.uFlowScale, 1.0 / (minWHg * 0.18)); gl.uniform1f(u.uFlowSpeed, minWHg * 0.10); gl.uniform1f(u.uFlowT, t * 0.22);
    gl.uniform1f(u.uGrav, minWHg * 1.5); gl.uniform1f(u.uTaskbar, taskbarPx); gl.uniform1f(u.uHeap, minWHg * 0.05);
    gl.uniform1f(u.uGravPour, minWHg * 0.12);
    gl.uniform1f(u.uPistonStart, uPistonStart); gl.uniform1f(u.uPistonDur, uPistonDur); gl.uniform1f(u.uPush, minWHg * 1.1); gl.uniform1f(u.uPistonW, pistonWpx);
    gl.uniform1f(u.uSwallow, minWHg * 1.1); gl.uniform1f(u.uExplode, minWHg * 3.2);
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3);
    pos.swap(); vel.swap();
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  }

  function renderGlyphs() {
    gl.useProgram(P.glyph.p);
    const u = P.glyph.u;
    WE.GL.bind(gl, scene); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    WE.GL.tex(gl, 0, pos.read.tex, u.uPos);
    WE.GL.tex(gl, 1, vel.read.tex, u.uVel);
    WE.GL.tex(gl, 2, meta.tex, u.uMeta);
    WE.GL.tex(gl, 3, atlasTex, u.uAtlas);
    gl.uniform4fv(u.uMon, uMonArr);
    gl.uniform3fv(u.uSrcCol, srcColors());
    gl.uniform2f(u.uRes, W, H);
    gl.uniform2f(u.uAtlasGrid, atlas.cols, atlas.rows);
    gl.uniform1f(u.uG, G);
    gl.uniform1f(u.uGlyphPx, glyphPx);
    gl.uniform1f(u.uCellAspect, atlas.cellW / atlas.cellH);
    gl.uniform1f(u.uFocal, minWHg * 1.7);
    gl.uniform1f(u.uGlyphScaleProp, props.glyphScale);
    gl.uniform1f(u.uGlow, props.glow);
    gl.bindVertexArray(cornerVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, G * G);
    gl.disable(gl.BLEND);
  }

  function bloom() {
    const bw = bloomA.w, bh = bloomA.h;
    gl.useProgram(P.down.p); WE.GL.bind(gl, bloomA);
    WE.GL.tex(gl, 0, scene.tex, P.down.u.uTex); gl.uniform2f(P.down.u.uTexel, 1 / W, 1 / H);
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(P.blur.p);
    WE.GL.bind(gl, bloomB); WE.GL.tex(gl, 0, bloomA.tex, P.blur.u.uTex); gl.uniform2f(P.blur.u.uDir, 1 / bw, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
    WE.GL.bind(gl, bloomA); WE.GL.tex(gl, 0, bloomB.tex, P.blur.u.uTex); gl.uniform2f(P.blur.u.uDir, 0, 1 / bh); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function final(t) {
    gl.useProgram(P.final.p);
    WE.GL.bind(gl, null, W, H);
    const u = P.final.u;
    WE.GL.tex(gl, 0, scene.tex, u.uScene);
    WE.GL.tex(gl, 1, bloomA.tex, u.uBloom);
    gl.uniform2f(u.uRes, W, H); gl.uniform1f(u.uTime, t); gl.uniform1f(u.uGlow, T.bloom * 0.7 + props.glow * 0.22);
    gl.uniform4fv(u.uMon, uMonArr); gl.uniform1i(u.uNumMon, monPx.length);
    gl.uniform3fv(u.uClockColor, U.hexToRgb(props.clockColor));
    gl.uniform3fv(u.uTubeCol, U.hexToRgb('#dfe8f2'));
    gl.uniform1fv(u.uTubeX, new Float32Array(tubeX.concat([0, 0, 0, 0, 0, 0]).slice(0, 6)));
    gl.uniform1f(u.uTubeY, tubeY); gl.uniform1f(u.uTubeVis, tubeVis); gl.uniform1f(u.uTubeW, tubeWpx);
    gl.uniform1fv(u.uPistonX, pistonXarr);
    gl.uniform1fv(u.uPistonSide, new Float32Array(monSide.concat([1, 1, 1, 1, 1, 1]).slice(0, 6)));
    gl.uniform1f(u.uPistonActive, pistonActive); gl.uniform1f(u.uPistonW, pistonWpx); gl.uniform1f(u.uPistonH, pistonHpx); gl.uniform1f(u.uTaskbar, taskbarPx);
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------------- clock overlay (2D, never dies) ----------------
  let clockAcc = 0, flipStart = -1, lastSec = -1, hgFlips = 0;
  function drawClock(dt) {
    clockAcc += dt; if (clockAcc < 0.05 && lastSec >= 0) return; clockAcc = 0;
    const mons = (ctx.monitors && ctx.monitors.length) ? ctx.monitors : [{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of mons) { minX = Math.min(minX, m.x); minY = Math.min(minY, m.y); maxX = Math.max(maxX, m.x + m.w); maxY = Math.max(maxY, m.y + m.h); }
    const totW = maxX - minX, totH = maxY - minY, sx = ui.width / totW, sy = ui.height / totH;
    uic.clearRect(0, 0, ui.width, ui.height);
    const now = WE.Clock.now({ hour24: props.hour24 });
    const sec = new Date().getSeconds();
    if (sec !== lastSec) { if (lastSec >= 0) hgFlips++; lastSec = sec; flipStart = performance.now(); }   // one 180° flip per second
    const flip = U.clamp((performance.now() - flipStart) / 380, 0, 1);
    const e = flip < 0.5 ? 2 * flip * flip : 1 - Math.pow(-2 * flip + 2, 2) / 2;   // ease in/out
    const hgAngle = Math.PI * ((hgFlips - 1) + e);   // 180° per second, animated at the boundary
    const hgInverted = (hgFlips % 2) === 1;          // orientation parity: keep sand draining downward
    const drain = (performance.now() % 1000) / 1000; // sand drains over the second, empties as it flips
    const col = props.clockColor;
    for (const m of mons) {
      const rx = (m.x - minX) * sx, ry = (m.y - minY) * sy, rw = m.w * sx, rh = m.h * sy;
      const scale = (rh / 1080) * props.clockScale * dpr;
      const cx = rx + rw * props.clockX, cy = ry + rh * props.clockY;
      drawAlarmClock(uic, cx, cy, scale, now, col, hgAngle, hgInverted, drain);
    }
  }

  // 7-seg + hourglass. cx,cy = left baseline anchor of the clock block.
  function drawAlarmClock(g, cx, cy, s, now, color, hgAngle, hgInverted, drain) {
    const dw = 56 * s, dh = 94 * s, gap = 16 * s, th = 15 * s; // digit metrics (thick, LED-style)
    g.save(); g.translate(cx, cy);
    // subtle backing plate for legibility over busy formations
    const plateW = now.time.length * (dw + gap) + 96 * s, plateH = dh + (props.showDate ? 52 * s : 16 * s);
    g.fillStyle = 'rgba(4,6,10,0.34)';
    if (g.roundRect) { g.beginPath(); g.roundRect(-16 * s, -14 * s, plateW, plateH, 12 * s); g.fill(); }
    // digits
    let x = 0;
    const chars = now.time.split('');   // "H:MM" or "HH:MM"
    for (const ch of chars) {
      if (ch === ':') { drawColon(g, x, dh, th, color); x += gap; continue; }
      drawSeg(g, x, dh, dw, th, ch, color); x += dw + gap;
    }
    // seconds column: AM/PM on top, hourglass below (no overlap)
    const colX = x + 6 * s;
    if (!props.hour24) { g.fillStyle = hexA(color, 0.9); g.font = `${Math.round(16 * s)}px "Consolas","Menlo",monospace`; g.textBaseline = 'top'; g.fillText(now.ampm, colX, 2 * s); }
    drawHourglass(g, colX + 15 * s, dh * 0.63, 15 * s, 22 * s, color, hgAngle, hgInverted, drain);
    // date line
    if (props.showDate) { g.fillStyle = hexA(color, 0.85); g.font = `${Math.round(26 * s)}px "Consolas","Menlo",monospace`; g.textBaseline = 'top'; g.fillText(`${now.day} · ${now.date}`, 0, dh + 12 * s); }
    g.restore();
  }
  // segment geometry a..g
  const SEG = {
    '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg',
    '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', ' ': ''
  };
  function poly(g, pts) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); g.fill(); }
  // classic angled 7-segment (hexagonal segments), faint unlit segments — LED-clock look
  function drawSeg(g, x, H, W, T, ch, color) {
    const on = SEG[ch] || '';
    const ht = T / 2, gp = T * 0.28, midY = H / 2;
    const H_ = (k, y, lx, rx) => { g.fillStyle = hexA(color, on.indexOf(k) >= 0 ? 1.0 : 0.07); poly(g, [[lx, y], [lx + ht, y - ht], [rx - ht, y - ht], [rx, y], [rx - ht, y + ht], [lx + ht, y + ht]]); };
    const V_ = (k, cxp, ty, by) => { g.fillStyle = hexA(color, on.indexOf(k) >= 0 ? 1.0 : 0.07); poly(g, [[cxp, ty], [cxp + ht, ty + ht], [cxp + ht, by - ht], [cxp, by], [cxp - ht, by - ht], [cxp - ht, ty + ht]]); };
    const lx = x + ht + gp, rx = x + W - ht - gp;
    H_('a', ht, lx, rx);
    H_('g', midY, lx, rx);
    H_('d', H - ht, lx, rx);
    V_('f', x + ht, ht + gp, midY - gp * 0.5);
    V_('b', x + W - ht, ht + gp, midY - gp * 0.5);
    V_('e', x + ht, midY + gp * 0.5, H - ht - gp);
    V_('c', x + W - ht, midY + gp * 0.5, H - ht - gp);
  }
  function drawColon(g, cx, h, t, color) { g.fillStyle = hexA(color, 0.95); const r = t * 0.42; g.beginPath(); g.arc(cx, h * 0.35, r, 0, 7); g.arc(cx, h * 0.65, r, 0, 7); g.fill(); }

  // pixel hourglass mask (1 = frame, 2 = top-chamber cell, 3 = bottom-chamber cell)
  const HG = buildHourglassMask();
  function buildHourglassMask() {
    const cols = 11, rows = 15;
    const m = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let x = 0; x < cols; x++) { m[0][x] = 1; m[rows - 1][x] = 1; }             // top/bottom bars
    for (let y = 1; y < rows - 1; y++) {
      const t = (y - 1) / (rows - 3);                 // 0..1 top->bottom
      const inset = Math.round(t < 0.5 ? t * (cols - 1) : (1 - t) * (cols - 1)) / 1; // narrow to neck
      const half = Math.max(0, Math.floor((cols - 1) / 2) - inset);
      const cxi = (cols - 1) / 2;
      for (let x = 0; x < cols; x++) {
        const d = Math.abs(x - cxi);
        if (Math.abs(d - (cols - 1) / 2 + inset) < 0.6 || x === Math.round(cxi - half) || x === Math.round(cxi + half)) m[y][x] = 1; // stepped walls
        else if (d < (cols - 1) / 2 - inset) m[y][x] = t < 0.5 ? 2 : 3;
      }
    }
    return { cols, rows, m };
  }
  function drawHourglass(g, cx, cy, hw, hh, color, angle, inverted, drain) {
    g.save(); g.translate(cx, cy);
    g.rotate(angle);   // 180° flip each second (accumulates; symmetric frame so it reads as a flip)
    const { cols, rows, m } = HG; const cw = (hw * 2) / cols, ch = (hh * 2) / rows;
    // count chamber cells for fill
    let topCells = [], botCells = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { if (m[y][x] === 2) topCells.push([x, y]); else if (m[y][x] === 3) botCells.push([x, y]); }
    // parity keeps the sand draining toward the visual bottom after each flip
    const topFrac = inverted ? drain : (1 - drain);
    const botFrac = inverted ? (1 - drain) : drain;
    const topLeft = Math.round(topCells.length * topFrac);  // sand remaining up top (drains as second progresses)
    const botFill = Math.round(botCells.length * botFrac);
    topCells.sort((a, b) => a[1] - b[1]);   // top-down: top sand sits high, drains from bottom of top chamber
    botCells.sort((a, b) => b[1] - a[1]);   // fill bottom chamber from the bottom up
    const litTop = new Set(topCells.slice(0, topLeft).map(c => c[0] + ',' + c[1]));
    const litBot = new Set(botCells.slice(0, botFill).map(c => c[0] + ',' + c[1]));
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const v = m[y][x]; if (!v) continue;
      const px = -hw + x * cw, py = -hh + y * ch;
      if (v === 1) g.fillStyle = hexA(color, 0.95);
      else { const key = x + ',' + y; const on = v === 2 ? litTop.has(key) : litBot.has(key); if (!on) continue; g.fillStyle = hexA(color, 0.8); }
      g.fillRect(px, py, Math.ceil(cw), Math.ceil(ch));
    }
    // falling grain in the neck
    g.fillStyle = hexA(color, 0.9); const nx = -cw * 0.5, ny = -hh + rows * 0.5 * ch; g.fillRect(nx, ny, Math.ceil(cw), Math.ceil(ch * 1.6));
    g.restore();
  }
  function hexA(hex, a) { const c = U.hexToRgb(hex); return `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`; }

  // ---------------- round clock (phase machine) ----------------
  function advance(dt) {
    roundT += dt; phaseT += dt;
    if (phase === PHASE.ASSEMBLE && phaseT >= assembleDur()) { phase = PHASE.HOLD; phaseT = 0; }
    else if (phase === PHASE.HOLD) {
      const hold = Math.max(3, props.roundSeconds - assembleDur() - dieDur());
      if (phaseT >= hold) { phase = PHASE.DIE; phaseT = 0; }
    } else if (phase === PHASE.DIE && phaseT >= dieDur()) { buildFormation(false); }
  }

  // ---------------- boot ----------------
  // seed the pool BEFORE the first formation so the first pour has material
  for (let i = 0; i < 120; i++) synthTick();
  alloc();
  if (WE.hasHost) { window.host.onProps && window.host.onProps((p) => { Object.assign(props, p); }); window.host.onSettings && window.host.onSettings((s) => { settings = s; gov.applySettings(s); }); }
  // feed polling
  setInterval(async () => { const ok = await pullHostFeed(); if (!ok) synthTick(); else if (poolChars < 3000) synthTick(); }, 250);

  WE.Loop.run({
    governor: gov,
    frame(dt, t) {
      const warp = +(WE.query.get('warp') || 1);
      advance(dt * warp);
      computeTube();
      computeDeath();
      simStep(Math.min(dt * warp, 1 / 30), t);
      renderGlyphs();
      if (props.glow > 0.01) bloom(); else { WE.GL.bind(gl, bloomA); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      final(t);
      drawClock(dt);
    },
    stats(fps) { return { fps, tier: T.name, form, phase, glyphs: activeCount, pool: pool.length }; },
  });

  // ================= teapot & suzanne point clouds =================
  // Procedural Utah-teapot silhouette (body + lid + knob + spout + handle).
  // Recognizable at glyph resolution; a real teapot.obj can replace this later.
  function teapotPoints(n) {
    const out = [];
    const add = (p) => { if (out.length < n) out.push(p); };
    const budget = { body: 0.5, lid: 0.14, knob: 0.03, spout: 0.16, handle: 0.17 };
    // body: slightly squashed sphere, flattened top/bottom
    for (let i = 0; i < n * budget.body; i++) { const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u); add([r * Math.cos(a), u * 0.72 - 0.05, r * Math.sin(a)]); }
    // lid: shallow dome cap
    for (let i = 0; i < n * budget.lid; i++) { const a = Math.random() * Math.PI * 2, rr = Math.random(); const r = 0.62 * Math.sqrt(rr); add([r * Math.cos(a), 0.66 + 0.16 * (1 - rr), r * Math.sin(a)]); }
    // knob
    for (let i = 0; i < n * budget.knob; i++) { const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u); add([0.12 * r * Math.cos(a), 0.86 + 0.09 * u, 0.12 * r * Math.sin(a)]); }
    // spout: tapered tube curving up on +x
    for (let i = 0; i < n * budget.spout; i++) { const t = Math.random(); const cx = 0.85 + t * 0.75, cy = -0.15 + t * t * 0.7, rad = 0.22 * (1 - t * 0.7); const a = Math.random() * Math.PI * 2; add([cx + rad * Math.cos(a) * 0.6, cy + rad * Math.sin(a), rad * Math.cos(a)]); }
    // handle: torus arc on -x
    for (let i = 0; i < n * budget.handle; i++) { const t = Math.PI * (0.15 + Math.random() * 0.7); const R = 0.55, r = 0.1; const b = Math.random() * Math.PI * 2; const bx = -0.95 - R * Math.sin(t) * 0.6, by = 0.15 + R * Math.cos(t); add([bx + r * Math.cos(b) * 0.6, by + r * Math.sin(b), r * Math.cos(b)]); }
    // normalize to [-1,1]
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const p of out) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); }
    const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    const sc = 2 / Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-3);
    return out.map(p => [(p[0] - c[0]) * sc, (p[1] - c[1]) * sc, (p[2] - c[2]) * sc]);
  }

  function suzannePoints(n) {
    // Recognizable monkey-head approximation from ellipsoids (head, muzzle, brow, ears, eyes).
    const parts = [
      { c: [0, 0, 0], r: [1.0, 0.9, 0.85], w: 6 },       // head
      { c: [0, -0.25, 0.75], r: [0.55, 0.4, 0.5], w: 3 }, // muzzle
      { c: [0, 0.5, 0.55], r: [0.7, 0.22, 0.35], w: 1.4 },// brow
      { c: [-1.05, 0.05, 0], r: [0.28, 0.5, 0.42], w: 1.6 }, // ear L
      { c: [1.05, 0.05, 0], r: [0.28, 0.5, 0.42], w: 1.6 },  // ear R
      { c: [-0.38, 0.12, 0.72], r: [0.2, 0.24, 0.2], w: 0.8 }, // eye L
      { c: [0.38, 0.12, 0.72], r: [0.2, 0.24, 0.2], w: 0.8 },  // eye R
    ];
    const total = parts.reduce((a, p) => a + p.w, 0); const out = [];
    for (const p of parts) {
      const cnt = Math.max(1, Math.round(n * p.w / total));
      for (let i = 0; i < cnt; i++) {
        // surface of ellipsoid
        const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
        out.push([p.c[0] + p.r[0] * r * Math.cos(a), p.c[1] + p.r[1] * u, p.c[2] + p.r[2] * r * Math.sin(a)]);
        if (out.length >= n) break;
      }
      if (out.length >= n) break;
    }
    return out.map(p => [p[0] * 0.8, p[1] * 0.8, p[2] * 0.8]);
  }
})();
