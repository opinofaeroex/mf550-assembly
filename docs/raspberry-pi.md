# Mist-Fit 550 on Raspberry Pi — deployment and tuning (v1.5)

This guide covers running the assembly instructions on a **Raspberry Pi 5 (8 GB)**, the primary
target, and a **Raspberry Pi 4 (8 GB)**, the secondary one, with Chromium on Raspberry Pi OS
(64-bit), an external monitor and a USB camera.

> **Measured vs. expected.** The improvements in [`performance-audit.md`](performance-audit.md) were
> measured in headless Chromium on an x86 server (see the method there). No Raspberry Pi was
> available during development, so **frame rates on the Pi have not been measured yet**: run the
> built-in benchmark (step 6) to get them for your hardware, before and after.

---

## 1. Hardware checklist

| | Raspberry Pi 5 (primary) | Raspberry Pi 4 (secondary) |
|---|---|---|
| Power supply | Official 27 W USB-C (5 V 5 A) | Official 15 W USB-C |
| Cooling | Active Cooler (or case with fan) | Heatsink + fan |
| Display | 1920 × 1080 @ 60 Hz recommended | 1920 × 1080 @ 60 Hz, or 1280 × 720 |
| Camera | USB (UVC) webcam | USB (UVC) webcam |
| Storage | A2 microSD or NVMe SSD | A2 microSD or USB SSD |

Why: under sustained load an uncooled Pi lowers its clock (thermal throttling) and the frame rate
drops after a few minutes; an under-sized power supply has the same effect. Check both with
`vcgencmd measure_temp` and `vcgencmd get_throttled` (`throttled=0x0` = no throttling so far).
A 4K monitor makes the GPU fill four times as many pixels: run the desktop at 1080p
(*Raspberry Pi Configuration → Screen*, or `wlr-randr`).

USB webcams (UVC) work in Chromium without extra software. Camera Module (CSI) cameras use
libcamera and are not exposed to Chromium as a webcam by default; prefer a USB webcam for this
application.

## 2. Operating system

Use the current **Raspberry Pi OS (64-bit) with desktop** (Debian 13 "Trixie", released October
2025; Mesa 25 graphics stack with the V3D OpenGL ES 3.1 driver — WebGL 2 is available on both Pi 4
and Pi 5). Update before installing:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y chromium      # usually pre-installed; the binary is `chromium`
```

## 3. Verify that Chromium uses the GPU (do not skip)

That the 3D view appears does **not** mean the GPU draws it: without acceleration Chromium falls
back to a software rasteriser (SwiftShader or llvmpipe), which is 10–20× slower.

1. Open `chrome://gpu` in Chromium. Under *Graphics Feature Status* you should see
   **WebGL: Hardware accelerated** and **WebGL2: Hardware accelerated**. Under *Driver Information*
   the GL renderer should mention **V3D 7.x** (Pi 5) or **V3D 4.2** (Pi 4).
   If it says *Software only*, *SwiftShader* or *llvmpipe*, acceleration is off.
2. In the app: **Help (?) → Display quality** shows the renderer and the profile that was chosen.
   The app also shows a notice when it detects software rendering, and the performance
   dashboard (Ctrl + Shift + P) shows *Acceleration: hardware · WebGL 2* or *SOFTWARE rendering*.

If acceleration is off:

- make sure you run the **desktop** image with the default compositor (labwc on Wayland) and the
  `vc4-kms-v3d` overlay (default in `/boot/firmware/config.txt`: `dtoverlay=vc4-kms-v3d`);
- update the system (`sudo apt full-upgrade`) — old Mesa versions are block-listed by Chromium;
- as a last resort start Chromium with `--ignore-gpu-blocklist` and check `chrome://gpu` again.
  Use this flag only if the page above shows that the GPU was block-listed: it does not fix a
  missing driver.

## 4. Choose the performance profile

The app picks a profile automatically from the WebGL renderer string, and you can override it:

| Profile | Chosen automatically for | Model | Resolution | MSAA | Frame cap | CAD edges | Gesture analysis |
|---|---|---|---|---|---|---|---|
| **High quality** | desktop / laptop GPUs | full CAD tessellation (469 k triangles) | device pixels (≤ 2×) | on | display rate | all | 15 Hz, worker |
| **Balanced** | **Raspberry Pi 5** (V3D 7), mobile GPUs | simplified, 0.2 mm target (95 k) | 1× | on | 30 fps | parts (no fasteners) | 12 Hz, worker, CPU |
| **Low performance** | **Raspberry Pi 4** (V3D 4), software rendering | simplified, 0.45 mm target (69 k) | 0.75× | off | 30 fps | off (toggle on: parts) | 8 Hz, worker, CPU |

All three keep every component, its name, its BOM row, the assembly steps, the selection /
highlight and the exploded-view animation; only the triangle count, the resolution and the
number of edge lines change. Ways to choose:

- **Help (?) → Display quality** (remembered on that device; the page reloads);
- the address: `…/?profile=balanced` (or `high`, `low`) — best for a kiosk, see below.

## 5. Kiosk mode (Chromium starts full-screen at login)

### 5.1 Run from the published site

Create `~/.config/labwc/autostart` (Raspberry Pi OS uses the labwc compositor):

```bash
chromium "https://opinofaeroex.github.io/mf550-assembly/public/?profile=balanced" \
  --kiosk --noerrdialogs --disable-infobars --no-first-run \
  --autoplay-policy=no-user-gesture-required \
  --enable-features=OverlayScrollbar &
```

- `?profile=balanced` for a Pi 5, `?profile=low` for a Pi 4 (or omit it: automatic).
- `--autoplay-policy=no-user-gesture-required` lets the voice narration start without a first tap.

Camera permission without a prompt (gesture control / camera overlay) — a Chromium policy:

```bash
sudo mkdir -p /etc/chromium/policies/managed
sudo tee /etc/chromium/policies/managed/mf550.json >/dev/null <<'EOF'
{
  "VideoCaptureAllowedUrls": ["https://opinofaeroex.github.io", "http://localhost:8080"],
  "AudioCaptureAllowed": false
}
EOF
```

Check it under `chrome://policy`.

### 5.2 Run locally (no internet on the shop floor)

```bash
sudo apt install -y nodejs git
git clone https://github.com/opinofaeroex/mf550-assembly.git ~/mf550-assembly
cd ~/mf550-assembly && node tools/serve.mjs --port 8080      # serves public/ on http://localhost:8080
```

`localhost` is a secure context, so the camera works without HTTPS. Start the server at boot with a
systemd user service and point the autostart line at `http://localhost:8080/?profile=balanced`:

```ini
# ~/.config/systemd/user/mf550.service
[Unit]
Description=Mist-Fit 550 assembly instructions
[Service]
WorkingDirectory=%h/mf550-assembly
ExecStart=/usr/bin/node tools/serve.mjs --port 8080 --host 127.0.0.1
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now mf550.service
sudo loginctl enable-linger $USER
```

Gesture control loads MediaPipe (≈ 9 MB) from jsDelivr and Google the first time it is enabled. For a
machine without internet, download the pinned files once and point `CONFIG.gestures` in
`public/js/config.js` at them:

```bash
cd ~/mf550-assembly/public/vendor && mkdir -p mediapipe/wasm && cd mediapipe
V=https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3
curl -fLO $V/vision_bundle.mjs && curl -fLO $V/vision_bundle.cjs
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_module_internal.js vision_wasm_module_internal.wasm; do curl -fL -o wasm/$f $V/wasm/$f; done
curl -fLO https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
```

```js
// public/js/config.js → gestures
visionBundle: new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href,
wasmBase: new URL('../vendor/mediapipe/wasm', import.meta.url).href,
model: new URL('../vendor/mediapipe/hand_landmarker.task', import.meta.url).href,
```

(`vision_bundle.cjs` is needed because hand tracking runs in a Web Worker since v1.5.)

## 6. Measure on your Pi (before / after)

The benchmark runs a fixed, real-time sequence — overview at rest, exploded parts kit, a looping
step, six step changes, a camera orbit and six BOM selections — and reports, per phase, the drawn
frame rate, the frame-time median and 95th percentile, stalls (frames ≥ 50 ms) and long main-thread
tasks. Narration is muted while it runs.

| Run | Address |
|---|---|
| **Before** (version 1.4 behaviour, same device) | `…/public/?bench&profile=legacy` |
| After — Pi 5 | `…/public/?bench&profile=balanced` |
| After — Pi 4 | `…/public/?bench&profile=low` |

`legacy` reproduces version 1.4 (continuous rendering, full model, per-frame bounding boxes,
runtime camera planning, gesture tracking on the main thread); in the headless measurements it
matched the real v1.4 within a few per cent. At the end, **Copy results** or **Download JSON**.
Let the Pi warm up for a few minutes first and close other applications.

Reading the numbers: with on-demand rendering a still view draws ~0 frames per second by design —
judge the animated phases (*parts kit*, *step 30 loop*, *navigation*, *camera orbit*). The
engineering target is ≥ 30 drawn fps on a Pi 5 in those phases and stalls ≈ 0.

The **performance dashboard** (Ctrl + Shift + P, or `?perf=1`; never shown unless you open it)
shows the live values: loop and drawn frames per second, frame time, draw calls, triangles,
meshes, JS heap, gesture analysis rate and cost (worker / main thread), camera resolution, model
tier and load time, long tasks, canvas size and the WebGL renderer.

## 7. If it is still too slow

In this order (each step is reversible):

1. Check §3 (hardware acceleration) and throttling (`vcgencmd get_throttled`).
2. Lower the display resolution to 1920 × 1080 (or 1280 × 720 on a Pi 4).
3. Pi 5: switch to **Low performance** (`?profile=low`).
4. Turn CAD edges off (edges button in the view tools) — fewer draw calls.
5. Gesture control off when not needed: hand tracking uses one CPU core while it runs.
6. Camera overlay: it shows the camera picture behind the model (no tracking); on a Pi 4 it runs at
   640 × 480 @ 24 fps in the Low profile.

## 8. What "AR" means on a Raspberry Pi

Chromium on Linux has no WebXR `immersive-ar` (that needs ARCore on Android). On a Pi the AR button
offers the **camera overlay**: the camera picture behind the 3D model, which is *not anchored* to
the workpiece. The external camera is otherwise used for **hand-gesture navigation**
(MediaPipe hand landmarks). The application has no marker or image tracking; anchoring the model
to the physical unit would need a marker-tracking module (a new feature, not part of v1.5).
