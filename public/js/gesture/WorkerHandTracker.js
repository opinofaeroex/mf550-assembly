import { HandTracker } from './HandTracker.js';

/**
 * WorkerHandTracker — same contract as HandTracker, inference in a Web Worker (v1.5).
 *
 *   init()                       starts the worker and loads MediaPipe there; if anything is
 *                                missing (Worker, OffscreenCanvas, createImageBitmap) or fails,
 *                                it falls back to the main-thread HandTracker (v1.4 behaviour)
 *   detectAsync(video, ts)       → Promise<{hands}>; the frame is downscaled to
 *                                cfg.analysisWidth while it is copied (createImageBitmap), and at
 *                                most one frame is in flight (no queue builds up on slow devices)
 *   stats                        { mode: 'worker' | 'main', delegate, inferMs, mainMs }
 *
 * Landmarks are normalised (0..1), so the analysis size does not change the classifier's input.
 */
export class WorkerHandTracker {
  static supported() {
    return typeof Worker === 'function' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function';
  }

  constructor(cfg) {
    this.cfg = cfg;
    this.landmarker = null;      // truthy once ready (GestureController checks it)
    this.delegate = null;
    this.worker = null;
    this.fallback = null;
    this.pending = new Map();
    this.seq = 0;
    this.stats = { mode: 'worker', delegate: null, inferMs: 0, mainMs: 0 };
  }

  async init() {
    if (this.landmarker) return;
    if (!WorkerHandTracker.supported()) return this.#useMainThread('unsupported');
    try {
      this.worker = new Worker(new URL('./hand-worker.js', import.meta.url));   // classic worker (see hand-worker.js)
      const ready = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('worker start timeout')), 45000);
        this.worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'ready') { clearTimeout(t); resolve(m.delegate); return; }
          if (m.type === 'error') { clearTimeout(t); reject(new Error(m.message)); return; }
          if (m.type === 'result') this.#result(m);
        };
        this.worker.onerror = (ev) => { clearTimeout(t); reject(new Error(ev.message || 'worker error')); };
      });
      const c = this.cfg;
      this.worker.postMessage({ type: 'init', cfg: { visionBundle: c.visionBundle, wasmBase: c.wasmBase, model: c.model, delegate: c.delegate, detection: c.detection } });
      this.delegate = await ready;
      this.stats.delegate = this.delegate;
      this.landmarker = {};
    } catch (e) {
      console.warn('[gestures] worker tracking unavailable, using the main thread:', e);
      try { this.worker && this.worker.terminate(); } catch { /* gone */ }
      this.worker = null;
      await this.#useMainThread('worker-failed');
    }
  }

  async #useMainThread(reason) {
    this.fallback = new HandTracker(this.cfg);
    await this.fallback.init();
    this.landmarker = this.fallback.landmarker;
    this.delegate = this.fallback.delegate;
    this.stats = { mode: 'main', delegate: this.delegate, inferMs: 0, mainMs: 0, reason };
  }

  /** Synchronous API of HandTracker (main-thread fallback only). */
  detect(video, ts) {
    const t0 = performance.now();
    const r = this.fallback.detect(video, ts);
    this.stats.inferMs = this.stats.mainMs = performance.now() - t0;
    return r;
  }

  get async() { return !!this.worker; }

  async detectAsync(video, ts) {
    if (!this.worker) return this.detect(video, ts);
    const t0 = performance.now();
    const w = Math.min(this.cfg.analysisWidth || video.videoWidth, video.videoWidth);
    const h = Math.round((w * video.videoHeight) / video.videoWidth);
    const bitmap = await createImageBitmap(video, w === video.videoWidth ? undefined : { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage({ type: 'frame', id, bitmap, ts }, [bitmap]);
    this.stats.mainMs = performance.now() - t0;          // main-thread cost: frame copy + post
    return p;
  }

  #result(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    this.stats.inferMs = m.ms;
    if (m.error) p.reject(new Error(m.error)); else p.resolve({ hands: m.hands });
  }

  close() {
    if (this.worker) { try { this.worker.postMessage({ type: 'close' }); } catch { /* gone */ } this.worker = null; }
    if (this.fallback) this.fallback.close();
    for (const p of this.pending.values()) p.reject(new Error('closed'));
    this.pending.clear();
    this.landmarker = null;
  }
}
