import { CameraManager } from './CameraManager.js';
import { HandTracker, physicalHand } from './HandTracker.js';
import { WorkerHandTracker } from './WorkerHandTracker.js';
import { classifyGesture } from './GestureClassifier.js';
import { GestureTrigger } from './GestureTrigger.js';

/**
 * GestureController — right-hand thumbs-up / thumbs-down → 'trigger' events.
 *
 *   camera frame ─► HandTracker (MediaPipe) ─► physicalHand() ─► right hand only
 *                ─► classifyGesture() ─► GestureTrigger (stable, once, cooldown, neutral)
 *                ─► 'trigger' {gesture: 'up' | 'down'}   → App.next() / App.prev()
 *
 * The controller never navigates by itself: the app maps triggers onto the same
 * NEXT / PREVIOUS functions as the buttons. Lifecycle:
 *   enable()  — explicit user action: camera permission → model download → tracking
 *   disable() — releases the camera and stops processing
 *   suspend(reason) / resume(reason) — e.g. 'ar' (WebXR owns the camera), 'hidden' (tab hidden)
 *
 * Events: 'status' (detail: snapshot), 'trigger' (detail: {gesture}), 'frame' (detail: {hands, frame})
 */
export class GestureController extends EventTarget {
  constructor(cfg, { video, createTracker } = {}) {
    super();
    this.cfg = cfg;
    this.camera = new CameraManager(video);
    // v1.5: inference in a Web Worker where possible (cfg.worker), main thread otherwise
    this.createTracker = createTracker || ((c) => (c.worker && WorkerHandTracker.supported() ? new WorkerHandTracker(c) : new HandTracker(c)));
    this.gen = 0;
    this.inflight = false;
    this.tracker = null;
    this.trigger = new GestureTrigger(cfg.trigger);
    this.swap = false;
    this.enabled = false;
    this.running = false;
    this.suspended = new Set();
    this.lastRun = 0;
    this.lastTs = 0;
    this.status = { phase: 'off', reason: null, hand: 'none', gesture: null, state: 'ready', progress: 0, delegate: null };
    this.loop = this.loop.bind(this);
  }

  static supported() {
    return CameraManager.supported() && typeof WebAssembly === 'object';
  }

  /** Explicit user action only: asks for the camera, loads the model, starts tracking. */
  async enable() {
    if (this.enabled) return true;
    this.enabled = true;
    this.trigger.reset();
    if (this.suspended.size) { this.#set({ phase: 'paused', reason: [...this.suspended][0] }); return true; }
    return this.#start();
  }

  disable() {
    this.enabled = false;
    this.#stopLoop();
    this.camera.stop();
    this.trigger.reset();
    this.#set({ phase: 'off', reason: null, hand: 'none', gesture: null, state: 'ready', progress: 0 });
  }

  /** Release the camera while another feature needs it (AR) or the page is hidden. */
  suspend(reason) {
    const was = this.suspended.size;
    this.suspended.add(reason);
    if (!was && this.enabled) {
      this.#stopLoop();
      this.camera.stop();
      this.trigger.reset();
      this.#set({ phase: 'paused', reason, hand: 'none', gesture: null, state: 'ready', progress: 0 });
    }
  }

  resume(reason) {
    if (!this.suspended.delete(reason) || this.suspended.size || !this.enabled) return;
    this.#start();
  }

  setSwap(v) {
    this.swap = !!v;
    this.trigger.reset();
  }

  async #start() {
    const token = (this.startToken = (this.startToken || 0) + 1);
    const stale = () => token !== this.startToken || !this.enabled || this.suspended.size > 0;
    try {
      this.#set({ phase: 'starting', reason: null });
      await this.camera.start(this.cfg.camera);
      if (stale()) { if (!this.enabled || this.suspended.size) this.camera.stop(); return false; }
      const track = this.camera.stream.getVideoTracks()[0];
      if (track) track.addEventListener('ended', () => { if (this.enabled && !this.suspended.size) this.#fail('busy'); }, { once: true });
      if (!this.tracker || !this.tracker.landmarker) {
        this.#set({ phase: 'loading' });
        this.tracker = this.tracker || this.createTracker(this.cfg);
        try {
          await this.tracker.init();
        } catch (e) {
          console.warn('[gestures] hand model could not be loaded:', e);
          this.tracker = null;
          this.#fail('model');
          return false;
        }
        if (stale()) { if (!this.enabled || this.suspended.size) this.camera.stop(); return false; }
      }
      this.#set({ phase: 'on', reason: null, delegate: this.tracker.delegate || null });
      this.running = true;
      this.lastRun = 0;
      this.#schedule();
      return true;
    } catch (e) {
      if (stale()) return false;
      console.warn('[gestures] camera unavailable:', e);
      this.#fail(e.reason || 'error');
      return false;
    }
  }

  #fail(reason) {
    this.enabled = false;
    this.#stopLoop();
    this.camera.stop();
    this.#set({ phase: 'error', reason, hand: 'none', gesture: null, state: 'ready', progress: 0 });
  }

  #schedule() {
    if (this.running) this.raf = requestAnimationFrame(this.loop);   // pauses by itself in background tabs
  }

  #stopLoop() {
    this.running = false;
    this.inflight = false;
    this.gen = (this.gen || 0) + 1;      // results of frames sent before this are dropped
    cancelAnimationFrame(this.raf);
  }

  /**
   * One camera frame: throttled to cfg.fps so the 3D view keeps its frame rate.
   * v1.5: trackers with detectAsync (WorkerHandTracker) run inference off the main thread;
   * at most one frame is in flight, so a slow device analyses fewer frames instead of queueing.
   */
  loop() {
    if (!this.running) return;
    const now = performance.now();
    const v = this.camera.video;
    if (!this.inflight && now - this.lastRun >= 1000 / this.cfg.fps && v.readyState >= 2 && v.videoWidth > 0) {
      this.lastRun = now;
      const ts = Math.max(Math.round(now), this.lastTs + 1);   // MediaPipe needs increasing timestamps
      this.lastTs = ts;
      const frame = { width: v.videoWidth, height: v.videoHeight };
      if (this.tracker.async && this.tracker.detectAsync) {
        this.inflight = true;
        const gen = this.gen;
        this.tracker.detectAsync(v, ts).then((res) => {
          if (gen !== this.gen) return;
          this.inflight = false;
          if (!this.running) return;
          this.#count();
          this.process(res, performance.now(), frame);
        }, (e) => {
          if (gen !== this.gen) return;
          this.inflight = false;
          console.warn('[gestures] tracking error:', e);
        });
      } else {
        let res = null;
        const t0 = performance.now();
        try {
          res = this.tracker.detect(v, ts);
        } catch (e) {
          console.warn('[gestures] tracking error:', e);
        }
        this.mainMs = performance.now() - t0;
        if (res) { this.#count(); this.process(res, now, frame); }
      }
    }
    this.#schedule();
  }

  /** Analysed frames per second and per-frame costs (performance dashboard). */
  #count() {
    const now = performance.now();
    this.rateWin = this.rateWin || { t: now, n: 0, hz: 0 };
    const w = this.rateWin;
    w.n++;
    if (now - w.t >= 1000) { w.hz = (w.n * 1000) / (now - w.t); w.t = now; w.n = 0; }
  }

  get perfStats() {
    const t = this.tracker;
    const s = (t && t.stats) || {};
    return {
      running: !!this.running, hz: this.rateWin ? this.rateWin.hz : 0,
      mode: s.mode || 'main', delegate: (t && t.delegate) || null,
      inferMs: s.inferMs ?? this.mainMs ?? 0, mainMs: s.mode === 'worker' ? s.mainMs : (this.mainMs ?? s.mainMs ?? 0),
      fps: this.cfg.fps, analysisWidth: this.cfg.analysisWidth || this.cfg.camera.width,
    };
  }

  /** Classify the user's right hand and feed the trigger. Exposed for tests. */
  process(res, now, frame) {
    const c = this.cfg;
    const hands = (res.hands || []).map((h) => ({
      ...h, hand: physicalHand(h.label, { inputMirrored: c.inputMirrored, swap: this.swap }),
    })).filter((h) => h.hand && h.score >= c.minHandScore);
    const area = (h) => {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of h.landmarks) { x0 = Math.min(x0, p.x ?? p[0]); y0 = Math.min(y0, p.y ?? p[1]); x1 = Math.max(x1, p.x ?? p[0]); y1 = Math.max(y1, p.y ?? p[1]); }
      return (x1 - x0) * (y1 - y0);
    };
    const right = hands.filter((h) => h.hand === 'Right').sort((a, b) => area(b) - area(a))[0] || null;
    const hasLeft = hands.some((h) => h.hand === 'Left');
    let cls = null;
    if (right) {
      cls = classifyGesture(right.landmarks, right.world, { aspect: frame.width / frame.height }, c.classifier);
      right.gesture = cls.gesture;
    }
    const r = this.trigger.update(right ? cls.gesture : null, now);
    this.dispatchEvent(new CustomEvent('frame', { detail: { hands, right, frame } }));
    this.#set({
      hand: right && hasLeft ? 'both' : right ? 'right' : hasLeft ? 'left' : 'none',
      gesture: right ? cls.gesture : null,
      reason: null,
      state: r.state,
      candidate: r.candidate,
      progress: r.progress,
    });
    if (r.fire) this.dispatchEvent(new CustomEvent('trigger', { detail: { gesture: r.fire } }));
    return r;
  }

  #set(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (this.status[k] !== v) { this.status[k] = v; changed = true; }
    }
    if (changed) this.dispatchEvent(new CustomEvent('status', { detail: { ...this.status } }));
  }

  dispose() {
    this.disable();
    if (this.tracker && this.tracker.close) this.tracker.close();
    this.tracker = null;
  }
}
