/**
 * hand-worker.js — MediaPipe Hand Landmarker in a Web Worker (v1.5).
 *
 * A CLASSIC worker on purpose: MediaPipe loads its WebAssembly glue with importScripts();
 * in a module worker that falls back to import() and the glue's global ModuleFactory is never
 * defined ("ModuleFactory not set"). The CommonJS build of the bundle (vision_bundle.cjs, same
 * version as the .mjs the main thread uses) only assigns to `exports`; it is fetched and evaluated
 * (CDNs serve .cjs as application/node, which importScripts refuses), while MediaPipe's own
 * WebAssembly glue is still loaded by importScripts as it expects.
 *
 * The main thread only grabs a (downscaled) camera frame as an ImageBitmap and transfers it
 * here; inference runs on this thread, so the 3D view, the BOM panel and the UI never wait
 * for it. Messages:
 *   → { type: 'init', cfg }              ← { type: 'ready', delegate } | { type: 'error', message }
 *   → { type: 'frame', id, bitmap, ts }  ← { type: 'result', id, hands, ms } (bitmap is closed here)
 */
let landmarker = null;
let delegate = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const c = m.cfg;
      const cjs = c.visionBundle.replace(/\.mjs(\?.*)?$/, '.cjs$1');
      const res = await fetch(cjs);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${cjs}`);
      const module = { exports: {} };
      // eslint-disable-next-line no-new-func
      new Function('exports', 'module', 'self', await res.text())(module.exports, module, self);
      const vision = module.exports;
      const fileset = await vision.FilesetResolver.forVisionTasks(c.wasmBase);
      const opts = (d) => ({
        baseOptions: { modelAssetPath: c.model, delegate: d },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: c.detection.minHandDetectionConfidence,
        minHandPresenceConfidence: c.detection.minHandPresenceConfidence,
        minTrackingConfidence: c.detection.minTrackingConfidence,
      });
      const want = c.delegate || 'GPU';
      try {
        landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts(want));
        delegate = want;
      } catch (err) {
        if (want === 'CPU') throw err;
        landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('CPU'));
        delegate = 'CPU';
      }
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
    return;
  }
  if (m.type === 'frame') {
    const t0 = performance.now();
    let hands = [];
    let error = null;
    try {
      const r = landmarker.detectForVideo(m.bitmap, m.ts);
      const hd = r.handedness || r.handednesses || [];
      hands = (r.landmarks || []).map((lm, k) => ({
        label: hd[k] && hd[k][0] ? hd[k][0].categoryName : null,
        score: hd[k] && hd[k][0] ? hd[k][0].score : 0,
        landmarks: lm.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        world: r.worldLandmarks && r.worldLandmarks[k] ? r.worldLandmarks[k].map((p) => ({ x: p.x, y: p.y, z: p.z })) : null,
      }));
    } catch (err) {
      error = String((err && err.message) || err);
    } finally {
      try { m.bitmap.close(); } catch { /* already closed */ }
    }
    self.postMessage({ type: 'result', id: m.id, hands, error, ms: performance.now() - t0 });
    return;
  }
  if (m.type === 'close') {
    try { landmarker && landmarker.close(); } catch { /* already closed */ }
    landmarker = null;
    self.close();
  }
};
