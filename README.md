# Wallpaper Engine Clone

A personal, music-reactive live-wallpaper engine for Windows. Wallpapers render
*behind* your desktop icons (the same Progman/WorkerW trick Wallpaper Engine and
Lively use), react to whatever is playing on the PC via Windows' built-in audio
loopback, pause when a game is fullscreen, and live in the tray.

## Run it

1. Double-click **`start.bat`**. The first run sets everything up once: if Node.js isn't
   installed it downloads a portable copy into `runtime\` (~30 MB, no installer, no admin),
   then downloads Electron (~120 MB). Later runs start in a second or two.
2. The control panel opens; the wallpaper is already on your desktop. Close the panel — the
   engine keeps running from the tray icon (right-click it to pause / quit / reopen the panel).

`start-debug.bat` runs it with a visible log window (useful if something looks wrong).
Both scripts just call `setup.ps1`; you can also run
`powershell -ExecutionPolicy Bypass -File setup.ps1 -DebugMode` yourself.

## Using it

* **Span all** (default): one continuous scene across both monitors, with a clock on each screen.
* **Per monitor**: pick a different wallpaper for each screen.
* Sliders on the right change the wallpaper live. **Engine settings** cover audio source (system audio / microphone), quality (auto-adapts by default), FPS cap, fullscreen pause, and start-with-Windows.
* **Live preview** in the panel is off by default because it costs GPU.

## Wallpapers

Each wallpaper is a folder in `wallpapers/` with a `wallpaper.json` manifest, an
`index.html` entry, and whatever scripts/shaders it needs. The engine passes the
manifest's `props` to the page and pushes changes live. Drop a new folder in and
hit **Reload wallpapers**.

### Mycelia (wallpaper #1)

* **Electric-Sheep layer** — a GPU fractal-flame renderer (Draves' chaos game with
  15 variation functions, log-density tone mapping, n-fold symmetry). Genomes
  morph into one another; onsets mutate them; bass breathes through the attractor.
* **Spore clock** — up to ~370k Physarum (slime-mold) agents. The time, date and
  weekday are rendered as signed-distance fields that attract the spores, so the
  digits are literally grown out of a living network and regrow when they change.
  Free spores treat the flame's density as food and grow along its filaments.
* **Post** — domain warp, optional kaleidoscope fold, feedback echo, bloom,
  beat-driven chromatic aberration.

Props worth playing with: `Flame symmetry`, `Palette`, `Spore density`, `Echo / tunnel feedback`, `Clock size`.

### Bulb (wallpaper #2)

* **Raymarched 3D fractal** — every iteration blends Mandelbulb, Mandelbox and
  kaleidoscopic-IFS formulas by weight, so genomes can morph into each other
  continuously. Orbit-trap colouring, ambient occlusion, fog, volumetric glow.
* **Electric-Sheep breeding** — a pool of genomes; offspring are crossovers plus
  mutations; the scene morphs from one to the next forever. **♥ Keep this look**,
  **⏭ Next sheep** and **✨ Fresh genome** live at the top of the wallpaper settings
  (keyboard `L` / `N` while the wallpaper has focus). The pool is saved in
  `%APPDATA%\wallpaper-engine-clone\data\bulb-pool.json`.
* **Music restructures it** — bass raises the bulb power and fold scales, beats snap
  the rotation matrices, strong onsets dive the camera and mutate the next genome,
  sustained energy deepens the iteration count.
* **One camera per monitor** orbiting the same fractal, keeping the surface at a
  chosen distance and creeping closer over each genome's life. Crowd clock on the left.
* Runs at half resolution by default with sub-pixel jitter + temporal accumulation
  (`Fractal render resolution` to change). Expect ~35-50% of an RTX 3070 at 60 fps,
  ~20-25% with the 30 fps cap.

## Performance

The quality governor watches frame time and moves between four tiers
(render scale 0.5–1.0, 83k–370k spores, 26k–102k flame points). It also drops to
the lowest tier while a fullscreen app covers one of the spanned monitors, and
stops rendering entirely when every screen is covered or when you pause it.
Set **Quality** to a fixed tier if you prefer.

## Troubleshooting

* **Wallpaper shows as a normal window / not behind icons** — Windows 11 25H2
  build 26200.9168 (Nov 2025) shipped a DWM bug that broke *every* wallpaper app;
  make sure Windows Update is current. `start-debug.bat` prints the detected
  desktop layout (`workerw-sibling`, `workerw-child`, or `progman`).
* **Not reacting to music** — the panel header shows `audio: system ok` when the
  loopback stream is live. Switch **Audio source** to Microphone as a fallback.
* **Explorer restarted** — the engine re-attaches itself within 5 s.

## Dev notes

* `node tools/render-test.js mycelia 1920 540 2 8` renders a wallpaper headlessly
  with a synthetic beat and saves screenshots to `tools/out/` (needs `playwright`).
  Add `?view=flame|trail|field`, `?seed=N`, `?p.<prop>=<value>` to the URL for tuning.
* `docs/ARCHITECTURE.md` explains every design decision.
