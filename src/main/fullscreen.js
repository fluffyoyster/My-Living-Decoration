// Detects when a fullscreen app (game, video) covers a monitor so that
// monitor's wallpaper can pause — same idea as Wallpaper Engine's
// "pause when another application is fullscreen".
//
// Driven by a WinEvent hook on foreground changes + a slow heartbeat that
// catches cases the hook misses (F11 in a browser, borderless toggles).
'use strict';

const { EventEmitter } = require('events');
const W = require('./win32');

const EVENT_SYSTEM_FOREGROUND = 0x0003;
const EVENT_SYSTEM_MOVESIZEEND = 0x000B;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const IGNORE_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow']);

const emitter = new EventEmitter();
let hook = 0, hookCb = null, timer = null, debounce = null;
let getMonitors = null;
const state = new Map(); // monitor index -> covered?

function className(w, hwnd) {
  const buf = Buffer.alloc(512);
  w.GetClassNameW(hwnd, buf, 255);
  return W.utf16z(buf);
}

function check() {
  const w = W.load();
  if (!w || !getMonitors) return;
  const monitors = getMonitors();
  const covered = new Map(monitors.map(m => [m.index, false]));

  const fg = W.num(w.GetForegroundWindow());
  if (fg) {
    const pidBuf = Buffer.alloc(4);
    w.GetWindowThreadProcessId(fg, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    const cls = className(w, fg);
    if (pid !== process.pid && !IGNORE_CLASSES.has(cls)) {
      const b = Buffer.alloc(16);
      w.GetWindowRect(fg, b);
      const r = W.readRect(b);
      for (const m of monitors) {
        const n = m.native;
        // Fullscreen = the foreground window fully covers the monitor.
        if (r.l <= n.x && r.t <= n.y && r.r >= n.x + n.w && r.b >= n.y + n.h) covered.set(m.index, true);
      }
    }
  }
  for (const [index, isCovered] of covered) {
    if (state.get(index) !== isCovered) {
      state.set(index, isCovered);
      emitter.emit('change', index, isCovered);
    }
  }
}

function onWinEvent(_hook, event) {
  if (event !== EVENT_SYSTEM_FOREGROUND && event !== EVENT_SYSTEM_MOVESIZEEND) return;
  clearTimeout(debounce);
  debounce = setTimeout(check, 250);
}

function start(monitorsFn, intervalMs = 5000) {
  const w = W.load();
  getMonitors = monitorsFn;
  if (!w) return;
  if (!hook) {
    hookCb = w.koffi.register(onWinEvent, w.koffi.pointer(w.WinEventProc));
    hook = W.num(w.SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MOVESIZEEND, 0, hookCb, 0, 0, WINEVENT_OUTOFCONTEXT));
  }
  clearInterval(timer);
  timer = setInterval(check, intervalMs);
  check();
}

function stop() {
  const w = W.load();
  clearInterval(timer); timer = null;
  clearTimeout(debounce);
  if (w && hook) { try { w.UnhookWinEvent(hook); } catch (_) {} hook = 0; }
  if (w && hookCb) { try { w.koffi.unregister(hookCb); } catch (_) {} hookCb = null; }
  for (const [index, covered] of state) if (covered) emitter.emit('change', index, false);
  state.clear();
}

module.exports = { start, stop, check, on: (...a) => emitter.on(...a) };
