// Physical monitor enumeration paired with Electron's display list.
// The wallpaper windows must be positioned in *physical pixels* (they become
// children of an explorer window, so DPI scaling no longer applies), while the
// control panel needs Electron's DIP-based display objects.
'use strict';

const W = require('./win32');

function listPhysical() {
  const w = W.load();
  if (!w) return [];
  const handles = [];
  const cb = w.koffi.register((hmon) => { handles.push(W.num(hmon)); return true; }, w.koffi.pointer(w.MonitorEnumProc));
  try { w.EnumDisplayMonitors(0, null, cb, 0); } finally { w.koffi.unregister(cb); }
  const out = [];
  for (const h of handles) {
    const buf = Buffer.alloc(40);          // MONITORINFO
    buf.writeUInt32LE(40, 0);
    if (!w.GetMonitorInfoW(h, buf)) continue;
    const l = buf.readInt32LE(4), t = buf.readInt32LE(8), r = buf.readInt32LE(12), b = buf.readInt32LE(16);
    out.push({ x: l, y: t, w: r - l, h: b - t, primary: (buf.readUInt32LE(36) & 1) === 1 });
  }
  return out;
}

/**
 * Returns [{ index, key, display, native }] — index 0 is the primary monitor,
 * others ordered left-to-right, top-to-bottom. `key` is stable across reboots
 * (display.id is not) so the config can remember which wallpaper goes where.
 */
function pair(screen) {
  const prim = screen.getPrimaryDisplay();
  const rest = screen.getAllDisplays()
    .filter(d => d.id !== prim.id)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);

  let native = listPhysical();
  let nPrim, nRest;
  if (native.length) {
    nPrim = native.find(m => m.primary) || native[0];
    nRest = native.filter(m => m !== nPrim).sort((a, b) => a.x - b.x || a.y - b.y);
  } else {
    // Non-Windows dev mode: approximate physical rect from DIP * scale.
    const toNative = d => ({ x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor),
      w: Math.round(d.bounds.width * d.scaleFactor), h: Math.round(d.bounds.height * d.scaleFactor), primary: d.id === prim.id });
    nPrim = toNative(prim);
    nRest = rest.map(toNative);
  }

  const list = [{ index: 0, display: prim, native: nPrim }]
    .concat(rest.map((d, i) => ({ index: i + 1, display: d, native: nRest[i] || nPrim })));

  const seen = new Map();
  for (const p of list) {
    const name = (p.display.label || '').trim();
    const base = `${name || 'display'}|${p.display.size.width}x${p.display.size.height}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    p.key = n > 1 ? `${base}#${n}` : base;
  }
  return list;
}

function describe(screen) {
  return pair(screen).map(p => ({
    index: p.index,
    key: p.key,
    name: (p.display.label || '').trim() || `Display ${p.index + 1}`,
    width: p.native.w, height: p.native.h,
    primary: p.index === 0,
  }));
}

module.exports = { listPhysical, pair, describe };
