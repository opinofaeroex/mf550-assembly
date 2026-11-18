# Performance audit and optimisation — version 1.5

Target: smooth, responsive operation on a **Raspberry Pi 5 (8 GB)** with Chromium (primary) and a usable
reduced-quality mode on a **Raspberry Pi 4 (8 GB)**, without removing functions.

## 1. Method — what was measured, and what was not

No Raspberry Pi was available while this work was done, so **no frame rate in this document is a Pi
number**. Everything below was measured in headless Chromium on an x86 server (2 cores) with the
SwiftShader software rasteriser, using three reproducible harnesses (`tools/perf/`):

| Harness | What it measures | Why it transfers to the Pi |
|---|---|---|
| `harness.cjs` — frames on a **virtual 30 fps clock**, WebGL draw calls counted and then skipped | per state (overview, parts kit, step entry, step loop, BOM selection, orbit): frames drawn, **main-thread JavaScript per frame**, draw calls, triangles; camera-planning work; start-up long tasks; memory over 3 × 71 positions | workload counts are hardware-independent; main-thread time scales with the CPU (a Pi core is several times slower than this server's) |
| `software-frames.cjs` — real frames, `render` + `readPixels` | time for the CPU rasteriser to draw one frame | a stand-in for GPU geometry/fill load, and the real situation if a Pi falls back to software rendering |
| `gestures.cjs` — real MediaPipe Hand Landmarker, Chromium's fake camera | analysis rate, inference time, main-thread cost, long tasks, frame cadence | main-thread blocking is what makes animations stutter on a Pi |

`?profile=legacy` reproduces version 1.4 inside version 1.5. In the harness it matched the real v1.4
within a few per cent (table §5), which validates using it for before/after runs **on the Pi itself**
with the built-in benchmark (`?bench&profile=legacy` vs `?bench&profile=balanced`, see
[raspberry-pi.md § 6](raspberry-pi.md#6-measure-on-your-pi-before--after)).

## 2. Audit of version 1.4

**Architecture.** Static site (no build step, no backend): `index.html` + ES modules, three.js r187 (vendored,
WebGL 2), OrbitControls, GLTFLoader with meshopt decoder. One-direction data flow: navigation →
`Sequencer` → `ExplodeController` / `Appearance` / BOM / step card / narration. AR: WebXR `immersive-ar`
(Android ARCore), AR Quick Look (iOS, USDZ generated in the browser), and a *camera overlay* fallback
(camera picture behind the transparent canvas, **no tracking**). The external camera is used for
**hand-gesture navigation** (MediaPipe Hand Landmarker); there is no marker/image tracking.

**Renderer.** `antialias: true`, `alpha: true`, pixel ratio `min(devicePixelRatio, 2)`, Neutral tone mapping,
PMREM environment (RoomEnvironment, generated once), 3 lights, **no shadow maps** (a textured contact-shadow
plane), **no post-processing**, `setAnimationLoop` → **render every display frame, always**.

**Model** (`MF-550-210-B.glb`, 850 kB, gltfpack: KHR_mesh_quantization + EXT_meshopt_compression):

| | |
|---|---|
| Components (part instances) | 220, one node each, `extras.nid` ↔ BOM |
| Unique meshes / mesh instances | 53 / 227 primitives drawn |
| Materials / textures | 16 plain colours / **none** |
| Triangles per frame | **468,766** (1.4 M vertices processed; 126 k uploaded) |
| Heaviest | fasteners: 14 × 4,614, 38 rivets × 1,482, 44 × 1,268, 18 × 2,644 triangles (≈ 220 k together) — dense CAD tessellation of small parts |

**Scene.** 932 objects: 227 meshes + 227 hidden x-ray overlays + 227 CAD edge line sets + contact shadow.
**455 draw calls per frame** (the edge lines double the mesh draws), 6 shader programs.

**Per frame (every frame, even when nothing moves):**

- full scene matrix update (932 objects);
- the floor lift: **two `Box3.setFromObject` passes over the whole model plus two forced matrix updates**;
- both callouts re-projected, with layout reads (`clientWidth/Height`) and style writes;
- background camera planning: sight-line ray casting against all triangles, nominal 4 ms slices.

**Start-up.** CAD edges (`EdgesGeometry` of all 53 geometries) in one blocking task (315 ms here);
camera planning for all 69 steps afterwards: **7.7 s of main-thread work over ~900 frames, peaks of
33 ms per frame**; on a step not yet planned, a 40 ms synchronous slice. After loading, the loader
stays in the page at opacity 0 with an endlessly spinning ring.

**Camera.** Overlay: 1280 × 720, no frame-rate limit. Gestures: 640 × 480 @ 15 Hz, inference with
`detectForVideo` **on the main thread** (46 ms per frame here).

**Memory.** Stable: heap 8.3 → 9.0 MB, geometries 114 → 114, DOM nodes ±1 over three passes through all
71 positions — no leak found (v1.5 behaves the same).

## 3. Bottlenecks, ranked for the Raspberry Pi

| # | Bottleneck | Evidence | Impact on a Pi |
|---|---|---|---|
| 1 | **Geometry load**: 469 k triangles, 1.4 M vertex-shader runs per frame | software frame 1,123 ms; halving the resolution saved only 22 % → geometry-bound | V3D 4.2 / 7.1 have modest vertex throughput: the main GPU limit |
| 2 | **Continuous rendering** at the display rate | 100 % of frames drawn, also while still / reading the BOM | GPU and CPU saturated permanently; heat → throttling; uneven cadence |
| 3 | **Camera planning on the device** | 7.7 s main thread, 33 ms peaks, after every load | tens of seconds of stutter on an ARM CPU after start |
| 4 | **Hand tracking on the main thread** | 46 ms per analysed frame, 22 long tasks / 8 s, frame p95 50 ms | inference several times slower on ARM, 15× per second, blocks animation and BOM |
| 5 | **Draw calls**: 455 (edges double them) | counted | per-call cost in Chromium's GPU process and the driver |
| 6 | **Per-frame JavaScript**: matrices of 932 objects, two model-wide bounding boxes, callout layout | 2–3 ms here | several times longer on a Pi core, on every frame |
| 7 | **Start-up long tasks** | 764 ms total, 425 ms longest | first seconds unresponsive |
| 8 | **Fill**: device pixels up to 2×, MSAA | resolution cost ≈ 22 % of a frame here | grows on 4K / high-DPI displays |
| 9 | Compositor: blur behind the step card, spinner after load | not measurable in software compositing | extra GPU passes every changed frame |

## 4. What was changed

| Bottleneck | Change (v1.5) | Where |
|---|---|---|
| 1 | Model tiers, simplified per mesh to a fixed absolute error target (0.2 / 0.45 mm); node tree verified identical; component bounds measured to move ≤ 0.15 / 0.54 mm | `tools/optimize-model.mjs`, `assets/model/*.balanced.glb`, `*.low.glb` |
| 2 | On-demand rendering (camera / parts / highlight / lift / viewport changes); 30 fps cap on Pi profiles | `scene/Viewer.js` |
| 3 | Camera plans precomputed (same planner, full model), looked up at run time; fingerprint + runtime fallback | `tools/precompute-camera.cjs`, `scene/CameraController.js` |
| 4 | Hand tracking in a Web Worker, ≤ 1 frame in flight, 15 / 12 / 8 Hz per profile | `gesture/WorkerHandTracker.js`, `gesture/hand-worker.js` |
| 5 | Edges limited to non-hardware parts (Balanced) or off (Low, can be switched on) | `scene/Appearance.js`, profiles |
| 6 | Transforms recomputed only for moved nodes (with a subtree flag so children never go stale); analytic floor lift; callouts only on drawn frames from cached sizes; no per-frame allocations in the camera controller | `Viewer.js`, `Explode.js`, `main.js`, `CameraController.js` |
| 7 | Edges built in idle slices; one redraw when done; loader removed after its fade | `Appearance.js`, `main.js` |
| 8 | Pixel ratio 1× (Balanced) / 0.75× and no MSAA (Low) | profiles |
| 9 | No backdrop blur on Pi profiles; loader `display: none` after loading | `css/app.css`, `main.js` |
| — | Profiles, automatic detection, software-rendering notice, dashboard, benchmark | `perf/` |

Not changed, on purpose: the WebAR stack (WebXR / Quick Look / camera overlay — nothing in it limits
the Pi); every component stays a separate mesh (selection, highlight, animation); no Draco (meshopt
decodes faster on ARM and the download is not the bottleneck); no runtime LOD switching (per-profile
model tiers give the same saving without duplicating meshes per component); three.js frustum culling
already applies (bounding spheres are computed at load); there are no textures, shadow maps or
post-processing to reduce.

## 5. Before / after (measured)

Headless Chromium, x86 server, 1280 × 800 window (canvas 880 × 651), virtual 30 fps clock.
"JS ms" = main-thread JavaScript per frame (median / 95th percentile), draws skipped. v1.4 = the
real version 1.4; the v1.5 columns are a repeat run on the final code. On this shared 2-core machine
timings vary by about ±10–30 % between runs; counts (triangles, draw calls, frames drawn) do not.

| Metric | v1.4 | v1.5 legacy | v1.5 High | v1.5 Balanced | v1.5 Low |
|---|---|---|---|---|---|
| Model file | 850 kB | 850 kB | 850 kB | 469 kB | 394 kB |
| Triangles per frame | 468,766 | 468,766 | 468,766 | 94,748 | 69,080 |
| Draw calls per frame (overview) | 455 | 455 | 455 | 281 | 228 |
| Scene objects | 932 | 932 | 912 (edges building) | 758 | 705 |
| Software-rasterised frame (GPU proxy) | 1,123 ms | — | 1,098 ms | 343 ms | 84 ms |
| Start-up long tasks (total / longest) | 764 / 425 ms | 790 / 404 ms | 433 / 187 ms | 365 / 155 ms | 421 / 146 ms |
| Camera planning, main thread (frames) | 7,724 ms (891) | 8,711 ms (971) | 22 ms (7) | 14 ms (7) | 30 ms (7) |
| Worst frame during planning | 32.8 ms | 21.8 ms | 6.4 ms | 5.0 ms | 9.0 ms |
| CAD edge computation | 315 ms (1 task) | 312 ms (1 task) | 345 ms (idle slices) | 91 ms (slices) | — (off) |
| **Overview, still** — frames drawn | 100 % | 100 % | 0 % | 0 % | 0 % |
| JS ms per frame | 2.0 / 3.7 | 2.0 / 3.2 | 0 / 0.1 | 0 / 0.1 | 0 / 0.1 |
| **Parts kit animation** — JS ms | 2.7 / 6.6 | 2.5 / 4.5 | 2.2 / 6.6 | 1.5 / 3.3 | 1.7 / 3.8 |
| **Step loop** (one 4.1 s cycle) — frames drawn | 100 % | 100 % | 53 % | 53 % | 53 % |
| JS total per cycle | 268 ms | 245 ms | 129 ms | 145 ms | 103 ms |
| **BOM selection** — frames drawn | 100 % | 100 % | 3 % | 3 % | 3 % |
| **Camera orbit** — JS ms | 2.8 / 6.5 | 3.1 / 6.0 | 2.9 / 5.5 | 1.9 / 3.8 | 1.3 / 2.7 |
| Heap over 3 × 71 positions | 8.3 → 9.0 MB | 8.4 → 9.1 | 8.2 → 8.8 | 7.9 → 8.6 | 7.7 → 8.4 |

Hand tracking (real MediaPipe, CPU, 15 Hz target, same machine, view at rest):

| | Main thread (v1.4) | Worker, 640 px | Worker, 320 px |
|---|---|---|---|
| Analysed frames / s | 13.2 | 13.3 | 13.1 |
| Inference per frame | 46 ms (main thread) | 42 ms (worker) | 40 ms (worker) |
| Main-thread cost per frame | **46 ms** | **1.8 ms** | 3.0 ms |
| Long tasks in 8 s | 22 (1,236 ms) | 0 | 0 |
| Display frame interval p95 / max | 50 / 67 ms | 16.7 / 17 ms | 16.7 / 17 ms |

The analysis resolution barely changes inference (MediaPipe resizes internally); the analysis
**rate** is what the Pi profiles reduce (12 Hz Pi 5, 8 Hz Pi 4).

## 6. Visual fidelity of the lighter models

Same camera, same resolution, edges off, compared with the full model (share of pixels whose colour
differs by more than 32 / 64 of 255):

| View | Balanced > 32 | Balanced > 64 | Low > 32 | Low > 64 |
|---|---|---|---|---|
| Overview | 0.03 % | 0.00 % | 0.22 % | 0.06 % |
| Step 3 (screws, close-up) | 0.00 % | 0.00 % | 0.00 % | 0.00 % |
| Step 35 (perforated baffle) | 0.01 % | 0.00 % | 0.24 % | 0.02 % |
| Step 41 (lock washers, close-up) | 0.00 % | 0.00 % | 0.01 % | 0.00 % |

(Low also renders without MSAA, which accounts for part of its differences.) The error targets are
meshoptimizer's (quadric) metric, not a hard bound, so the tool also measures the result: component
bounding boxes move by at most **0.145 mm** (Balanced) and **0.541 mm** (Low), recorded in
`model-tiers.json` and checked by the tests. On screen: 0.2 mm ≈ 0.8 px at the closest automatic-camera
distance (≈ 0.3 m, 35° field of view, 800 px tall view); 0.54 mm ≈ 2.2 px there and < 1 px from 0.75 m.

A regression found and fixed during this work: the first version of the static-transform optimisation
let `localToWorld` consume a moved node's update flag, so the model could be drawn at a stale floor
height. The fix (a subtree flag) is covered by a test that compares every world matrix at 6 poses with a
full recomputation.

## 7. Remaining limitations

- **Pi frame rates are not measured yet** — run the benchmark on the devices (raspberry-pi.md § 6).
  The 30 fps target for the Pi 5 is an engineering target.
- **Draw calls** remain 228–281 per frame on the Pi profiles (one mesh per component, needed for
  selection, highlight and animation). Instancing the ~170 identical fasteners would remove ~150 more but
  requires per-instance highlight and exploded-view animation (e.g. `BatchedMesh`) — a larger change,
  worth doing only if the Pi benchmark shows draw calls as the limit.
- **MSAA** stays on in Balanced (cheap on tile-based GPUs in principle); if the Pi 5 benchmark is below
  target, try Low or turn it off.
- On-demand rendering relies on every visual change requesting a frame (all current paths do; new code
  must call `viewer.requestRender()`); the camera is checked automatically every frame.
- AR on a Pi is the camera overlay (no anchoring); hand tracking needs MediaPipe from the network or a
  self-hosted copy (raspberry-pi.md § 5.2).
