// Scans the wallpapers/ folder. Each wallpaper is a folder with wallpaper.json.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'wallpapers');

function scan() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()); } catch (_) { return out; }
  for (const d of dirs) {
    const dir = path.join(ROOT, d.name);
    const manifestPath = path.join(dir, 'wallpaper.json');
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const id = m.id || d.name;
      const entry = path.join(dir, m.entry || 'index.html');
      if (!fs.existsSync(entry)) continue;
      const preview = m.preview ? path.join(dir, m.preview) : null;
      out.push({
        id, name: m.name || id, description: m.description || '', author: m.author || '',
        version: m.version || 1, audio: m.audio !== false,
        dir, entry, preview: preview && fs.existsSync(preview) ? preview : null,
        props: m.props || {},
        actions: Array.isArray(m.actions) ? m.actions : [],
      });
    } catch (e) {
      console.warn(`[library] skipping ${d.name}: ${e.message}`);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function get(id) {
  return scan().find(w => w.id === id) || null;
}

/** Default prop values from a manifest's props schema. */
function defaults(wallpaper) {
  const out = {};
  for (const [k, p] of Object.entries(wallpaper.props || {})) out[k] = p.default;
  return out;
}

module.exports = { ROOT, scan, get, defaults };
