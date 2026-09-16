// Persistent settings: %APPDATA%/wallpaper-engine-clone/config.json
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  version: 1,
  settings: {
    layout: 'span',            // 'span' (one scene across all monitors) | 'per-monitor'
    audioSource: 'system',     // 'system' | 'mic'
    pauseOnFullscreen: true,
    startWithWindows: false,
    quality: 'auto',           // 'auto' | 'low' | 'medium' | 'high'
    fpsCap: 60,
    paused: false,
  },
  defaultWallpaper: 'mycelia',
  monitors: {},                // key -> { wallpaper: id, props: { ...overrides } }
};

let file = null;
let data = null;

function load() {
  file = path.join(app.getPath('userData'), 'config.json');
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    data = null;
  }
  data = merge(structuredClone(DEFAULTS), data || {});
  return data;
}

function merge(base, over) {
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') merge(base[k], over[k]);
    else base[k] = over[k];
  }
  return base;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('config save failed:', e.message);
  }
}

function get() { return data || load(); }

function update(fn) {
  fn(get());
  save();
  return data;
}

function monitor(key) {
  const d = get();
  if (!d.monitors[key]) d.monitors[key] = { wallpaper: d.defaultWallpaper, props: {} };
  return d.monitors[key];
}

module.exports = { load, get, update, save, monitor, DEFAULTS };
