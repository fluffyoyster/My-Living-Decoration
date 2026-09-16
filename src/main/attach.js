// Puts an Electron window *behind the desktop icons* — the Wallpaper Engine /
// Lively technique.
//
// How it works: the desktop is drawn by explorer's "Progman" window. Sending it
// the undocumented message 0x052C makes explorer split the wallpaper and the
// icon layer (SHELLDLL_DefView) into separate "WorkerW" windows. We then make
// our window a child of the WorkerW that sits *under* the icons.
//
// Two layouts exist:
//   * Windows 10 / 11 up to 23H2: the WorkerW we want is the *next sibling* of
//     the top-level window that contains SHELLDLL_DefView.
//   * Windows 11 24H2 and later: both WorkerW and SHELLDLL_DefView are
//     *children* of Progman. We parent to that child WorkerW.
// If neither is found we fall back to Progman itself and sit just below the
// icon layer in Z-order.
'use strict';

const W = require('./win32');

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;
const SW_HIDE = 0, SW_SHOW = 5, SW_SHOWNA = 8;

const attached = new Map(); // hwnd -> { parent, mode, savedStyle, rect }

function log(...a) { if (process.env.WE_DEBUG || process.argv.includes('--we-debug')) console.log('[attach]', ...a); }

function findTarget() {
  const w = W.load();
  if (!w) return null;
  const progman = W.num(w.FindWindowW('Progman', null));
  if (!progman) return null;

  // Ask explorer to spawn the WorkerW layers (wParam 0xD / lParam 0x1 is the
  // variant Lively uses; it also works on Windows 10).
  w.SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, 0x0, 1000, null);

  // Layout A (Win10 / Win11 <= 23H2): sibling WorkerW after the DefView owner.
  let sibling = 0;
  const cb = w.koffi.register((hwnd) => {
    const h = W.num(hwnd);
    const def = W.num(w.FindWindowExW(h, 0, 'SHELLDLL_DefView', null));
    if (def) {
      const next = W.num(w.FindWindowExW(0, h, 'WorkerW', null));
      if (next) sibling = next;
    }
    return true;
  }, w.koffi.pointer(w.EnumWindowsProc));
  try { w.EnumWindows(cb, 0); } finally { w.koffi.unregister(cb); }
  if (sibling) return { progman, parent: sibling, mode: 'workerw-sibling' };

  // Layout B (Win11 24H2+): WorkerW is a child of Progman.
  const defView = W.num(w.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null));
  const childWorker = W.num(w.FindWindowExW(progman, 0, 'WorkerW', null));
  if (childWorker) return { progman, parent: childWorker, mode: 'workerw-child', defView };

  return { progman, parent: progman, mode: 'progman', defView };
}

function virtualOrigin() {
  const w = W.load();
  return { x: w.GetSystemMetrics(SM_XVIRTUALSCREEN), y: w.GetSystemMetrics(SM_YVIRTUALSCREEN) };
}

function physicalRect(hwnd) {
  const w = W.load();
  const b = Buffer.alloc(16);
  w.GetWindowRect(hwnd, b);
  const r = W.readRect(b);
  return { x: r.l, y: r.t, w: r.r - r.l, h: r.b - r.t };
}

function makeChild(hwnd) {
  const w = W.load();
  const ex = W.num(w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  w.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW);
  const st = W.num(w.GetWindowLongPtrW(hwnd, GWL_STYLE));
  w.SetWindowLongPtrW(hwnd, GWL_STYLE, ((st | WS_CHILD) & ~WS_POPUP) >>> 0);
  return st;
}

// Child coordinates are relative to the virtual-screen origin, not (0,0).
function moveTo(hwnd, rect) {
  const w = W.load();
  const vo = virtualOrigin();
  w.MoveWindow(hwnd, rect.x - vo.x, rect.y - vo.y, rect.w, rect.h, true);
}

/** Attach `hwnd` behind the icons covering physical `rect` {x,y,w,h}. */
function attach(hwnd, rect) {
  const w = W.load();
  if (!w) return false;
  const target = findTarget();
  if (!target || !target.parent) return false;

  const prev = attached.get(hwnd);
  const savedStyle = prev ? prev.savedStyle : makeChild(hwnd);
  if (!prev) attached.set(hwnd, { savedStyle });

  w.SetParent(hwnd, target.parent);
  moveTo(hwnd, rect);
  if (target.mode === 'progman' && target.defView) {
    w.SetWindowPos(hwnd, target.defView, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  if (target.mode === 'workerw-child' && target.defView) {
    // 24H2 keeps a cached snapshot of the icon layer; poke it so it repaints
    // transparently over our window.
    w.ShowWindow(target.defView, SW_HIDE);
    w.ShowWindow(target.defView, SW_SHOW);
  }
  Object.assign(attached.get(hwnd), { parent: target.parent, mode: target.mode, rect });
  log('attached', hwnd.toString(16), 'mode=' + target.mode, rect);
  return true;
}

/** Re-assert position/visibility (Electron sometimes "fixes" child windows). */
function ensure(hwnd, rect) {
  const w = W.load();
  const st = attached.get(hwnd);
  if (!w || !st) return;
  if (rect) st.rect = rect;
  if (!st.rect) return;
  if (!w.IsWindowVisible(hwnd)) w.ShowWindow(hwnd, SW_SHOWNA);
  const r = physicalRect(hwnd);
  const t = st.rect;
  if (r.x !== t.x || r.y !== t.y || r.w !== t.w || r.h !== t.h) moveTo(hwnd, t);
}

function detach(hwnd) {
  const w = W.load();
  const st = attached.get(hwnd);
  if (!w || !st) return;
  w.SetParent(hwnd, 0);
  if (st.savedStyle != null) w.SetWindowLongPtrW(hwnd, GWL_STYLE, st.savedStyle);
  attached.delete(hwnd);
  refreshDesktop();
}

function isParentAlive(hwnd) {
  const w = W.load();
  const st = attached.get(hwnd);
  return !!(w && st && st.parent && w.IsWindow(st.parent));
}

function mode(hwnd) {
  const st = attached.get(hwnd);
  return st ? st.mode : null;
}

/** Re-apply the user's static wallpaper so the desktop repaints after we leave. */
function refreshDesktop() {
  const w = W.load();
  if (!w) return;
  try {
    const SPI_GETDESKWALLPAPER = 0x0073, SPI_SETDESKWALLPAPER = 0x0014;
    const buf = Buffer.alloc(2 * 512);
    w.SystemParametersInfoW(SPI_GETDESKWALLPAPER, 511, buf, 0);
    w.SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, buf, 0x01);
    const progman = W.num(w.FindWindowW('Progman', null));
    if (progman) w.InvalidateRect(progman, null, true);
  } catch (_) { /* best effort */ }
}

module.exports = { attach, ensure, detach, isParentAlive, mode, physicalRect, refreshDesktop, findTarget };
