# Wallpaper Engine Clone — Architecture & Design

Personal live-wallpaper engine for Windows, music-focused. Built September 2026.

## Decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| Host | Electron 44 (Chromium 152) | Wallpapers are HTML/WebGL2 bundles: hot-swappable, previewable in any browser, and Wallpaper Engine itself uses CEF for web wallpapers. |
| Win32 bridge | `koffi` (FFI, no compiler needed) | Reparent Chromium's HWND behind desktop icons, enumerate physical monitors, hook foreground changes. Same approach as the MIT-licensed `aerowidget` project. |
| Behind-icons trick | `SendMessageTimeout(Progman, 0x052C, 0xD, 0x1)` then `SetParent(hwnd, WorkerW)` | Wallpaper Engine / Lively method. **Win10/11 ≤23H2:** WorkerW is a *sibling* of the window holding `SHELLDLL_DefView`. **Win11 24H2+:** WorkerW and `SHELLDLL_DefView` are both *children* of Progman. `attach.js` detects both layouts. |
| System audio | Electron `session.setDisplayMediaRequestHandler(... audio: 'loopback')` + `getDisplayMedia({video:true,audio:true})` in the page (video track stopped immediately) | Windows-only WASAPI loopback built into Electron ≥39; no virtual cable / driver. Mic is the fallback source. |
| Rendering | Raw WebGL2 + GLSL ES 3.00, no framework | Full control of a GPGPU pipeline (ping-pong float textures), zero runtime dependencies, works in headless Chromium for automated screenshots. |
| Multi-monitor | One BrowserWindow per physical monitor, each with its own wallpaper id + props | User wants different wallpapers per monitor. Physical rects come from `EnumDisplayMonitors` (DPI-independent), paired with Electron displays by sort order. |
| Fullscreen pause | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` + 5 s heartbeat; a foreground window whose rect covers a monitor pauses that monitor's wallpaper | Same as Wallpaper Engine's "pause when another app is fullscreen". |
| Quality | Adaptive: frame-time governor scales internal resolution and particle tiers | Target machine may be Intel iGPU. |

## Folder layout

```
wallpaper-engine-clone/
  package.json            electron, koffi
  start.bat               npm install (first run) + npm start
  src/main/
    main.js               lifecycle, tray, per-monitor windows, IPC, control panel
    attach.js             WorkerW/Progman attach + detach + DPI fix-ups
    monitors.js           physical monitors <-> Electron displays
    fullscreen.js         foreground hook -> per-monitor pause
    config.js             %APPDATA%/wallpaper-engine-clone/config.json
    library.js            scans wallpapers/*/wallpaper.json
  src/preload/
    wallpaper.js          window.host API for wallpapers (props, pause, monitor)
    control.js            window.control API for the control panel
  src/control/            control panel UI
  src/sdk/wallpaper-sdk.js audio engine, clock, glyph SDF, GL helpers, quality governor
  wallpapers/<id>/        wallpaper.json + index.html + main.js + shaders
```

## Wallpaper package format (`wallpaper.json`)

```json
{
  "id": "mycelia", "name": "Mycelia", "version": 1,
  "description": "...", "entry": "index.html", "preview": "preview.png",
  "audio": true,
  "props": {
    "intensity": { "type": "slider", "label": "Music intensity", "min": 0, "max": 2, "step": 0.05, "default": 1 },
    "symmetry":  { "type": "slider", "label": "Kaleidoscope folds", "min": 1, "max": 12, "step": 1, "default": 6 },
    "clock24":   { "type": "toggle", "label": "24-hour clock", "default": false },
    "palette":   { "type": "select", "label": "Palette", "options": ["aurora","ember","spore"], "default": "aurora" }
  }
}
```

The host passes `props` to the page via `window.host.getProps()` and pushes live changes with `window.host.onProps(cb)`. `window.host.onPause(cb)` / `onResume(cb)` stop the render loop when a fullscreen app covers the monitor.

## Audio pipeline (SDK)

loopback/mic MediaStream → `AnalyserNode` (fftSize 4096, smoothing 0) → 24 log-spaced bands (35 Hz–16 kHz) → per-band slow AGC (so quiet sources still react) → attack/release smoothing → `bass / mid / treble / energy` → spectral-flux onset detector with adaptive median threshold → `beat` (decaying 1→0 pulse), `onset` (true on the frame of a hit), `bpm` (autocorrelation of the flux history). Also uploaded as a 1×24 texture for shaders. Silence → ambient mode (visuals keep evolving slowly).

## Wallpaper #1: Mycelia (living kaleidoscope + spore clock)

Inspirations: Electric Sheep (Draves' fractal flames), Physarum polycephalum simulations (Jones 2010), kaleidoscopic symmetry.

Pipeline per frame (WebGL2):

1. **Flame points** (RGBA32F ping-pong, 256² = 65k points): one chaos-game iteration per frame. Genome = 4 xforms × {affine, variation weights, color}. Two genomes interpolated by a slow `t`; onsets pick a new target genome (a "sheep" morphing into the next). Rotational symmetry xforms give kaleidoscope folds (`symmetry` prop, audio can raise it on drops). Bass adds spherical/swirl weight = the picture *breathes*.
2. **Flame histogram** (RGBA16F, additive blend, ×0.92 decay per frame → motion-blurred like Electric Sheep). Tone map: `log(1+α)/α`, gamma, palette by color coordinate.
3. **Clock attractor field** (R16F, regenerated when the displayed string changes): glyph SDFs (CPU 8SSEDT from a Canvas-rendered bold font) placed for `HH:MM`, `SS`, `TUE · SEP 15`. Old string fades out over ~1.2 s while the new one fades in → spores migrate.
4. **Physarum agents** (RGBA32F ping-pong, 512² = 262k): sense trail + attractor at 3 sensors, turn, step, deposit. Inside a glyph: deposit ×3, step slower → dense living digits. Beats kick step size; treble widens sensor angle (branchier).
5. **Trail map** (R16F ping-pong): 3×3 diffusion + decay.
6. **Composite**: flame (kaleidoscope-folded UVs + feedback warp) under mycelium trail (palette, glow), glyph SDF edge glow for legibility, bloom (2-pass downsample blur), beat chromatic aberration, vignette, grain.

Quality governor: measures rAF dt; if >20 ms for 2 s, drops a tier (render scale 1 → 0.75 → 0.5, agents 512² → 384² → 256²); if <12 ms for 10 s, raises a tier.

## Known Windows caveats

- Windows 11 **25H2 build 26200.9168** (Nov 2025) had a DWM regression where nothing rendered behind icons for *any* wallpaper app (Lively, Wallpaper Alive…). Microsoft patches these; if the wallpaper is invisible, check Windows Update. The app logs the detected layout mode (`workerw-sibling`, `workerw-child`, `progman`) on start.
- Explorer restart destroys WorkerW: the host re-attaches automatically (heartbeat checks `IsWindow(parent)`).
- Child-window DPI: after `SetParent`, Electron's DIP math is wrong; `attach.js` re-measures the physical rect and corrects.

## Roadmap

- [ ] Wallpaper #2 ideas: Lenia / MNCA continuous cellular automata ("cells" that pulse to music), GPU fluid ink, raymarched fractal tunnel.
- [ ] Per-monitor audio sensitivity, hotkey to open the control panel.
