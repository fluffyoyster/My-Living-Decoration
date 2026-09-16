// Headless render test: opens a wallpaper with a synthetic music signal in
// Chromium (SwiftShader WebGL2), logs console output, and saves screenshots.
//   node tools/render-test.js [wallpaperId] [width] [height] [monitors] [seconds]
'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const [,, id = 'mycelia', w = '1920', h = '540', monitors = '2', seconds = '6', quality = 'high'] = process.argv;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'out');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', m => { const s = `[${m.type()}] ${m.text()}`; logs.push(s); console.log(s); });
  page.on('pageerror', e => { logs.push('[pageerror] ' + e.message); console.log('[pageerror]', e.message); });
  const extra = process.env.EXTRA || ""; const url = `http://127.0.0.1:${port}/wallpapers/${id}/index.html?fakeaudio=1&monitors=${monitors}&quality=${quality}&debug=1${extra}`;
  await page.goto(url);
  const total = +seconds;
  const shots = [1.5, total * 0.5, total];
  let t0 = Date.now();
  for (const at of shots) {
    const wait = at * 1000 - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    const file = path.join(OUT, `${id}${process.env.TAG || ""}-${at.toFixed(1)}s.png`);
    await page.screenshot({ path: file, timeout: 180000 });
    console.log('saved', file);
  }
  const err = await page.evaluate(() => document.getElementById('err') && document.getElementById('err').textContent);
  if (err) console.log('PAGE ERROR BOX:', err);
  await browser.close();
  server.close();
  fs.writeFileSync(path.join(OUT, `${id}-log.txt`), logs.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
