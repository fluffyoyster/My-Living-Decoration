// Wallpaper Engine clone — main process.
//
// Layouts:
//   * span         one window stretched across the whole virtual desktop; the
//                  wallpaper receives every monitor's rect so it can place a
//                  clock on each screen (default — one continuous scene).
//   * per-monitor  one window per monitor, each with its own wallpaper + props.
// Windows are parented behind the desktop icons (attach.js). System audio
// reaches wallpapers through Electron's WASAPI loopback — no drivers.
'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, session, desktopCapturer, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const W = require('./win32');
const attach = require('./attach');
const monitors = require('./monitors');
const fullscreen = require('./fullscreen');
const config = require('./config');
const library = require('./library');

const DEBUG = !!process.env.WE_DEBUG || process.argv.includes('--we-debug');
const log = (...a) => { if (DEBUG) console.log('[main]', ...a); };
const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = (n) => path.join(ROOT, 'src', 'preload', n);

// Chromium flags that matter for a never-focused, always-rendering window.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// slot = { id: 'span' | monitorIndex, key, native:{x,y,w,h}, dip:{x,y,width,height}, monitors:[...] }
let slots = [];
let displayPairs = [];
const wallWins = new Map();   // slot.id -> BrowserWindow
let panelWin = null;
let tray = null;
let heartbeat = null;
let rebuildTimer = null;
let quitting = false;
const coveredMonitors = new Set();

// ---------------------------------------------------------------- single instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openPanel());
}

// ---------------------------------------------------------------- helpers
function hwndOf(win) {
  try { return Number(win.getNativeWindowHandle().readBigUInt64LE(0)); } catch (_) { return 0; }
}

function slotById(id) { return slots.find(s => String(s.id) === String(id)); }

function unionRect(rects) {
  const l = Math.min(...rects.map(r => r.x)), t = Math.min(...rects.map(r => r.y));
  const r = Math.max(...rects.map(r => r.x + r.w)), b = Math.max(...rects.map(r => r.y + r.h));
  return { x: l, y: t, w: r - l, h: b - t };
}

function buildSlots() {
  displayPairs = monitors.pair(screen);
  const layout = config.get().settings.layout || 'span';
  const monInfo = (p, origin) => ({
    index: p.index, key: p.key, primary: p.index === 0,
    x: p.native.x - origin.x, y: p.native.y - origin.y, w: p.native.w, h: p.native.h,
    name: (p.display.label || '').trim() || `Display ${p.index + 1}`,
  });
  if (layout === 'span' || displayPairs.length === 1) {
    const native = unionRect(displayPairs.map(p => p.native));
    const dips = displayPairs.map(p => p.display.bounds);
    const dl = Math.min(...dips.map(b => b.x)), dt = Math.min(...dips.map(b => b.y));
    const dr = Math.max(...dips.map(b => b.x + b.width)), db = Math.max(...dips.map(b => b.y + b.height));
    slots = [{
      id: 'span', key: 'span', native,
      dip: { x: dl, y: dt, width: dr - dl, height: db - dt },
      monitors: displayPairs.map(p => monInfo(p, native)),
    }];
  } else {
    slots = displayPairs.map(p => ({
      id: p.index, key: p.key, native: p.native,
      dip: { x: p.display.bounds.x, y: p.display.bounds.y, width: p.display.bounds.width, height: p.display.bounds.height },
      monitors: [monInfo(p, p.native)],
    }));
  }
}

function wallpaperFor(slot) {
  const m = config.monitor(slot.key);
  return library.get(m.wallpaper) || library.get(config.get().defaultWallpaper) || library.scan()[0] || null;
}

function effectiveProps(slot) {
  const wp = wallpaperFor(slot);
  if (!wp) return {};
  const m = config.monitor(slot.key);
  return Object.assign(library.defaults(wp), (m.wallpaper === wp.id ? m.props : {}) || {});
}

function contextFor(slot) {
  const wp = wallpaperFor(slot);
  return {
    wallpaperId: wp ? wp.id : null,
    layout: slot.id === 'span' ? 'span' : 'per-monitor',
    slot: { id: slot.id, key: slot.key, width: slot.native.w, height: slot.native.h },
    monitors: slot.monitors,
    covered: slot.monitors.filter(m => coveredMonitors.has(m.index)).map(m => m.index),
    props: effectiveProps(slot),
    settings: config.get().settings,
    debug: DEBUG,
  };
}

function broadcast(channel, ...args) {
  for (const win of wallWins.values()) if (!win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------- wallpaper windows
function createWallWindow(slot) {
  const b = slot.dip;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, resizable: true, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    closable: false, skipTaskbar: true, focusable: false, show: false,
    hasShadow: false, roundedCorners: false, thickFrame: false,
    backgroundColor: '#000000',
    title: `Wallpaper ${slot.id}`,
    webPreferences: {
      preload: PRELOAD('wallpaper.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  wallWins.set(slot.id, win);

  win.webContents.on('console-message', (ev) => {
    if (DEBUG || ev.level === 'error') console.log(`[wall:${slot.id}] ${ev.message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn(`[wall:${slot.id}] renderer gone: ${details.reason}`);
    try { win.destroy(); } catch (_) {}
    wallWins.delete(slot.id);
    if (!quitting) setTimeout(rebuildWallWindows, 1500);
  });

  loadWallpaper(win, slot);

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    attachWall(slot.id);
  });
  return win;
}

function loadWallpaper(win, slot) {
  const wp = wallpaperFor(slot);
  if (!wp) {
    win.loadURL('data:text/html,<body style="background:#000;color:#888;font:16px sans-serif;display:grid;place-items:center;height:100vh;margin:0">No wallpapers found in the wallpapers/ folder</body>');
    return;
  }
  win.loadFile(wp.entry, { query: { slot: String(slot.id) } });
}

// After SetParent the window lives in explorer's DPI context and Electron's
// DIP bookkeeping no longer matches physical pixels. Measure and correct.
function fixAttachedSize(win, hwnd, target) {
  if (!W.isWin) return;
  try {
    const r = attach.physicalRect(hwnd);
    const b = win.getBounds();
    if (r.w !== target.w || r.h !== target.h) {
      const rw = (r.w / b.width) || 1, rh = (r.h / b.height) || 1;
      win.setBounds({ width: Math.round(target.w / rw), height: Math.round(target.h / rh) });
    }
    attach.ensure(hwnd, target);
  } catch (e) { log('fixAttachedSize', e.message); }
}

function attachWall(id) {
  const win = wallWins.get(id);
  const slot = slotById(id);
  if (!win || win.isDestroyed() || !slot || !W.isWin) return;
  const hwnd = hwndOf(win);
  const ok = attach.attach(hwnd, slot.native);
  if (!ok) console.warn(`[wall:${id}] could not find the desktop WorkerW — running as a normal window`);
  else log(`slot ${id} attached (${attach.mode(hwnd)}) at`, slot.native);
  fixAttachedSize(win, hwnd, slot.native);
  for (const ms of [250, 1000, 3000]) setTimeout(() => { if (!win.isDestroyed()) fixAttachedSize(win, hwnd, slot.native); }, ms);
}

function rebuildWallWindows() {
  buildSlots();
  log('slots:', slots.map(s => `${s.id}:${s.native.w}x${s.native.h}@${s.native.x},${s.native.y} [${s.monitors.map(m => m.index).join(',')}]`).join(' | '));
  for (const [id, win] of [...wallWins]) {
    if (!slotById(id) || win.isDestroyed()) {
      try { attach.detach(hwndOf(win)); } catch (_) {}
      try { win.destroy(); } catch (_) {}
      wallWins.delete(id);
    }
  }
  for (const slot of slots) {
    const win = wallWins.get(slot.id);
    if (!win) createWallWindow(slot);
    else {
      if (W.isWin) {
        const r = attach.physicalRect(hwndOf(win));
        if (r.w !== slot.native.w || r.h !== slot.native.h) { win.setBounds(slot.dip); attachWall(slot.id); }
        else attach.ensure(hwndOf(win), slot.native);
      } else win.setBounds(slot.dip);
      win.webContents.send('host:context', contextFor(slot));
    }
  }
  applyPauseState();
}

function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildWallWindows, 800);
}

function startHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    if (!W.isWin) return;
    for (const [id, win] of wallWins) {
      if (win.isDestroyed()) continue;
      const slot = slotById(id);
      if (!slot) continue;
      const hwnd = hwndOf(win);
      if (!attach.isParentAlive(hwnd)) {
        // explorer.exe restarted (or WorkerW got recycled) — re-attach.
        log(`slot ${id}: desktop parent gone, re-attaching`);
        attach.attach(hwnd, slot.native);
        fixAttachedSize(win, hwnd, slot.native);
      } else {
        attach.ensure(hwnd, slot.native);
      }
    }
  }, 5000);
}

// ---------------------------------------------------------------- pause logic
function applyPauseState() {
  const s = config.get().settings;
  for (const [id, win] of wallWins) {
    if (win.isDestroyed()) continue;
    const slot = slotById(id);
    if (!slot) continue;
    const covered = slot.monitors.filter(m => coveredMonitors.has(m.index)).map(m => m.index);
    const allCovered = covered.length > 0 && covered.length === slot.monitors.length;
    const paused = !!s.paused || (s.pauseOnFullscreen && allCovered);
    win.webContents.send('host:pause', paused);
    // Spanned window with only some screens covered: keep rendering but let the
    // wallpaper drop its quality tier for the hidden area.
    win.webContents.send('host:covered', s.pauseOnFullscreen ? covered : []);
  }
  updateTray();
}

fullscreen.on('change', (index, covered) => {
  if (covered) coveredMonitors.add(index); else coveredMonitors.delete(index);
  log(`monitor ${index} ${covered ? 'covered by a fullscreen app' : 'visible again'}`);
  applyPauseState();
});

function syncFullscreenWatcher() {
  if (config.get().settings.pauseOnFullscreen) fullscreen.start(() => displayPairs);
  else { fullscreen.stop(); coveredMonitors.clear(); applyPauseState(); }
}

// ---------------------------------------------------------------- control panel
function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return; }
  panelWin = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600,
    title: 'Wallpaper Engine Clone',
    backgroundColor: '#0d0f14',
    autoHideMenuBar: true,
    icon: trayIcon(),
    webPreferences: { preload: PRELOAD('control.js'), contextIsolation: true, nodeIntegration: false },
  });
  panelWin.loadFile(path.join(ROOT, 'src', 'control', 'index.html'));
  panelWin.webContents.on('console-message', (ev) => { if (DEBUG || ev.level === 'error') console.log(`[panel] ${ev.message}`); });
  panelWin.on('closed', () => { panelWin = null; });
}

function panelState() {
  const cfg = config.get();
  const fileUrl = p => 'file:///' + p.replace(/\\/g, '/');
  return {
    wallpapers: library.scan().map(w => ({
      id: w.id, name: w.name, description: w.description, author: w.author, audio: w.audio,
      preview: w.preview ? fileUrl(w.preview) : null,
      entry: fileUrl(w.entry),
      props: w.props,
      actions: w.actions || [],
    })),
    slots: slots.map(s => ({
      id: s.id, key: s.key, width: s.native.w, height: s.native.h,
      label: s.id === 'span' ? (s.monitors.length > 1 ? `All monitors (spanned, ${s.native.w}×${s.native.h})` : `${s.monitors[0].name} (${s.native.w}×${s.native.h})`) : `${s.monitors[0].name} (${s.native.w}×${s.native.h})${s.monitors[0].primary ? ' · main' : ''}`,
      monitors: s.monitors,
      wallpaper: wallpaperFor(s) ? wallpaperFor(s).id : null,
      props: effectiveProps(s),
      attachMode: W.isWin && wallWins.get(s.id) ? (attach.mode(hwndOf(wallWins.get(s.id))) || 'detached') : 'n/a',
    })),
    monitorCount: displayPairs.length,
    settings: cfg.settings,
    platform: process.platform,
    version: app.getVersion(),
    wallpapersDir: library.ROOT,
  };
}

function reloadSlot(slot) {
  const win = wallWins.get(slot.id);
  if (!win || win.isDestroyed()) return;
  loadWallpaper(win, slot);
  win.webContents.once('did-finish-load', () => { if (W.isWin) fixAttachedSize(win, hwndOf(win), slot.native); applyPauseState(); });
}

ipcMain.handle('panel:state', () => panelState());

ipcMain.handle('panel:set-wallpaper', (_e, key, id) => {
  const wp = library.get(id);
  if (!wp) return panelState();
  config.update(c => { c.monitors[key] = { wallpaper: id, props: (c.monitors[key] && c.monitors[key].wallpaper === id) ? c.monitors[key].props : {} }; });
  const slot = slots.find(s => s.key === key);
  if (slot) reloadSlot(slot);
  return panelState();
});

ipcMain.handle('panel:set-prop', (_e, key, name, value) => {
  config.update(c => { const m = config.monitor(key); m.props = m.props || {}; m.props[name] = value; });
  const slot = slots.find(s => s.key === key);
  const win = slot && wallWins.get(slot.id);
  if (win && !win.isDestroyed()) win.webContents.send('host:props', effectiveProps(slot));
  return true;
});

ipcMain.handle('panel:reset-props', (_e, key) => {
  config.update(c => { const m = config.monitor(key); m.props = {}; });
  const slot = slots.find(s => s.key === key);
  const win = slot && wallWins.get(slot.id);
  if (win && !win.isDestroyed()) win.webContents.send('host:props', effectiveProps(slot));
  return panelState();
});

ipcMain.handle('panel:set-setting', (_e, name, value) => {
  config.update(c => { c.settings[name] = value; });
  applySettings(name);
  return panelState();
});

ipcMain.handle('panel:reload', () => { for (const slot of slots) reloadSlot(slot); return true; });
ipcMain.handle('panel:open-folder', () => shell.openPath(library.ROOT));
ipcMain.handle('panel:identify', () => { broadcast('host:identify'); return true; });
ipcMain.handle('panel:action', (_e, key, name) => {
  const slot = slots.find(s => s.key === key);
  const win = slot && wallWins.get(slot.id);
  if (win && !win.isDestroyed()) win.webContents.send('host:action', String(name));
  return true;
});
ipcMain.handle('panel:open-external', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.handle('panel:quit', () => { quitting = true; app.quit(); });

function applySettings(name) {
  const s = config.get().settings;
  switch (name) {
    case 'startWithWindows':
      if (W.isWin) app.setLoginItemSettings({ openAtLogin: !!s.startWithWindows, path: process.execPath, args: [path.resolve(ROOT)] });
      break;
    case 'pauseOnFullscreen': syncFullscreenWatcher(); break;
    case 'paused': applyPauseState(); break;
    case 'layout': rebuildWallWindows(); break;
    default: broadcast('host:settings', s);
  }
  updateTray();
}

// ---------------------------------------------------------------- wallpaper page IPC
ipcMain.handle('wp:context', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  for (const [id, w] of wallWins) if (w === win) { const slot = slotById(id); if (slot) return contextFor(slot); }
  // Preview iframe inside the control panel: give it the first slot's context.
  const first = slots[0];
  return first ? { ...contextFor(first), preview: true } : null;
});
ipcMain.on('wp:log', (_e, msg) => log('[wp]', msg));

// per-wallpaper persistent data (e.g. Bulb's breeding pool): userData/data/<key>.json
function dataPath(key) { return path.join(app.getPath('userData'), 'data', String(key).replace(/[^a-z0-9_.-]/gi, '_') + '.json'); }
ipcMain.handle('wp:get-data', (_e, key) => { try { return JSON.parse(fs.readFileSync(dataPath(key), 'utf8')); } catch (_) { return null; } });
ipcMain.handle('wp:set-data', (_e, key, value) => { try { fs.mkdirSync(path.dirname(dataPath(key)), { recursive: true }); fs.writeFileSync(dataPath(key), JSON.stringify(value)); return true; } catch (e) { console.warn('set-data failed', e.message); return false; } });
ipcMain.on('wp:stats', (_e, stats) => { if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('panel:stats', stats); });

// ---------------------------------------------------------------- tray
function trayIcon() {
  const p = path.join(ROOT, 'assets', 'icon.png');
  if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  return nativeImage.createEmpty();
}

function updateTray() {
  if (!tray) return;
  const s = config.get().settings;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open control panel', click: openPanel },
    { type: 'separator' },
    { label: s.paused ? 'Resume wallpapers' : 'Pause wallpapers', click: () => { config.update(c => { c.settings.paused = !c.settings.paused; }); applyPauseState(); } },
    { label: 'Reload wallpapers', click: () => { for (const slot of slots) reloadSlot(slot); } },
    { label: 'Pause when an app is fullscreen', type: 'checkbox', checked: !!s.pauseOnFullscreen, click: (mi) => { config.update(c => { c.settings.pauseOnFullscreen = mi.checked; }); syncFullscreenWatcher(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: !!s.startWithWindows, click: (mi) => { config.update(c => { c.settings.startWithWindows = mi.checked; }); applySettings('startWithWindows'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(`Wallpaper Engine Clone${s.paused ? ' (paused)' : ''}`);
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.on('click', openPanel);
    tray.on('double-click', openPanel);
    updateTray();
  } catch (e) { console.warn('tray failed:', e.message); }
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(() => {
  const firstRun = !fs.existsSync(path.join(app.getPath('userData'), 'config.json'));
  config.load();

  // Audio capture permissions + Windows system-audio loopback.
  const ALLOWED = new Set(['media', 'display-capture', 'audioCapture', 'local-fonts']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .then(sources => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });

  createTray();
  rebuildWallWindows();
  startHeartbeat();
  syncFullscreenWatcher();

  screen.on('display-added', scheduleRebuild);
  screen.on('display-removed', scheduleRebuild);
  screen.on('display-metrics-changed', scheduleRebuild);

  if (firstRun || process.argv.includes('--panel') || !W.isWin) openPanel();
  log('ready. userData =', app.getPath('userData'));

  // WE_SHOT=<dir>: capture every window after 6 s (used by the headless test)
  if (process.env.WE_SHOT) {
    setTimeout(async () => {
      try {
        fs.mkdirSync(process.env.WE_SHOT, { recursive: true });
        for (const [id, win] of wallWins) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(process.env.WE_SHOT, `wall-${id}.png`), img.toPNG()); }
        if (panelWin) { const img = await panelWin.webContents.capturePage(); fs.writeFileSync(path.join(process.env.WE_SHOT, 'panel.png'), img.toPNG()); }
        log('screenshots written to', process.env.WE_SHOT);
      } catch (e) { console.error('screenshot failed', e); }
    }, 6000);
  }
});

app.on('window-all-closed', () => { /* keep running in the tray */ });

app.on('before-quit', () => {
  quitting = true;
  clearInterval(heartbeat);
  fullscreen.stop();
  for (const win of wallWins.values()) {
    if (win.isDestroyed()) continue;
    try { attach.detach(hwndOf(win)); } catch (_) {}
    try { win.destroy(); } catch (_) {}
  }
  wallWins.clear();
});

process.on('uncaughtException', (e) => {
  console.error('uncaught:', e);
  if (!app.isReady()) { dialog.showErrorBox('Wallpaper Engine Clone', String(e && e.stack || e)); }
});
