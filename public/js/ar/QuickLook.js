import * as THREE from 'three';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';

/**
 * iOS fallback: AR Quick Look.
 *
 * Safari on iPhone/iPad has no WebXR, so the model is exported to USDZ in the
 * browser, using the same exploded-view vectors as the web app (CONFIG.explodeScale
 * included). Two programs are available:
 *   - 'step' : the current assembly step only (its parts move from exploded to the CAD
 *              position, then loop) — matches the manual, step-by-step navigation;
 *   - 'full' : exploded view followed by every assembly step (continuous animation).
 * Quick Look is a separate system viewer: it cannot show the BOM, the narration or the
 * NEXT / PREVIOUS buttons, which stay in the web page.
 */
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

export class QuickLook {
  constructor({ viewer, appearance, model, explode, fileName, staticUrl }) {
    Object.assign(this, { viewer, appearance, model, explode, fileName, staticUrl });
    this.cache = new Map();     // program key -> { url, size }
  }

  /** Timing of the full program (seconds). */
  static programTiming(N) {
    return { hold0: 1.5, explodeSpan: 2.6, explodeDur: 0.9, hold1: 1.0, stepAnim: 0.9, stepPeriod: 1.3, holdEnd: 2.5, N };
  }

  /** Program description: total duration, factor(entry, t), key times per entry. */
  #program(kind, pos) {
    const entries = this.explode.entries;
    if (kind === 'full') {
      const T = QuickLook.programTiming(this.model.stepCount);
      const N = Math.max(1, T.N);
      const total = T.hold0 + T.explodeSpan + T.hold1 + T.N * T.stepPeriod + T.holdEnd;
      const e0 = (e) => T.hold0 + (1 - (e.step ?? 0) / N) * (T.explodeSpan - T.explodeDur);
      const a0 = (e) => T.hold0 + T.explodeSpan + T.hold1 + (e.step ?? 0) * T.stepPeriod;
      return {
        total,
        factor: (e, t) => {
          if (t <= e0(e)) return 0;
          if (t < e0(e) + T.explodeDur) return ease((t - e0(e)) / T.explodeDur);
          if (t <= a0(e)) return 1;
          if (t < a0(e) + T.stepAnim) return 1 - ease((t - a0(e)) / T.stepAnim);
          return 0;
        },
        keys: (e) => {
          const ts = [0, total];
          for (let k = 0; k <= 6; k++) ts.push(e0(e) + (T.explodeDur * k) / 6, a0(e) + (T.stepAnim * k) / 6);
          return ts;
        },
      };
    }
    // a single position of the navigation track
    const hold = 0.6, anim = 1.5, total = 3.3;
    const isStep = pos >= 0;
    const rest = (e) => (pos === -1 ? 1 : pos === -2 || e.step === null || e.step === undefined ? 0 : e.step < pos ? 0 : 1);
    return {
      total: isStep ? total : 1,
      factor: (e, t) => {
        if (!isStep || e.step !== pos) return rest(e);
        if (t <= hold) return 1;
        if (t >= hold + anim) return 0;
        return 1 - ease((t - hold) / anim);
      },
      keys: (e) => {
        const ts = [0, isStep ? total : 1];
        if (isStep && e.step === pos) for (let k = 0; k <= 8; k++) ts.push(hold + (anim * k) / 8);
        return ts;
      },
    };
  }

  #buildClip(prog) {
    const tracks = [];
    const { entries } = this.explode;
    for (const e of entries) {
      const times = [...new Set(prog.keys(e))].filter((t) => t >= 0 && t <= prog.total).sort((a, b) => a - b);
      const values = [];
      for (const t of times) {
        const f = prog.factor(e, t);
        values.push(e.base.x + e.vec.x * f, e.base.y + e.vec.y * f, e.base.z + e.vec.z * f);
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${e.obj.name}.position`, times, values));
    }
    // keep the exploded product above the floor: sample the required lift
    const { f } = this.explode;
    const saved = Float32Array.from(f);
    const modelRoot = this.viewer.modelRoot;
    const savedY = modelRoot.position.y;
    modelRoot.position.y = 0;
    const liftTimes = [], liftValues = [];
    const box = new THREE.Box3();
    const dt = Math.min(0.5, prog.total / 6);
    for (let t = 0; t <= prog.total + 1e-6; t += dt) {
      for (let i = 0; i < entries.length; i++) f[i] = prog.factor(entries[i], t);
      this.explode.apply();
      modelRoot.updateMatrixWorld(true);
      box.setFromObject(this.viewer.model);
      liftTimes.push(t);
      liftValues.push(0, Math.max(0, -box.min.y), 0);
    }
    f.set(saved);
    this.explode.apply();
    modelRoot.position.y = savedY;
    modelRoot.name = 'modelRoot';
    tracks.push(new THREE.VectorKeyframeTrack('modelRoot.position', liftTimes, liftValues));
    return new THREE.AnimationClip('assembly', prog.total, tracks);
  }

  /**
   * USDZ URL for a program. 'full' may use a pre-built file shipped next to the GLB
   * (npm run build:usdz); everything else is generated in the browser.
   * @param {(s: string) => void} [onStatus]
   * @param {{kind?: 'full'|'step', pos?: number}} [opts]
   */
  async prepare(onStatus, { kind = 'full', pos = -2 } = {}) {
    const key = kind === 'full' ? 'full' : `pos:${pos}`;
    const hit = this.cache.get(key);
    if (hit) { this.url = hit.url; this.size = hit.size; return hit.url; }
    if (kind === 'full' && this.staticUrl) {
      try {
        const res = await fetch(this.staticUrl, { method: 'HEAD' });
        const type = res.headers.get('content-type') || '';
        if (res.ok && !type.includes('text/html')) {
          const size = Number(res.headers.get('content-length')) || 0;
          this.cache.set(key, { url: this.staticUrl, size });
          this.url = this.staticUrl; this.size = size;
          return this.url;
        }
      } catch { /* fall through to in-browser export */ }
    }
    onStatus && onStatus('Generating USDZ for AR Quick Look…');
    await new Promise((r) => setTimeout(r, 30));
    const clip = this.#buildClip(this.#program(kind, pos));
    const exporter = new USDZExporter();
    const modelRoot = this.viewer.modelRoot;
    const savedY = modelRoot.position.y;
    modelRoot.position.y = 0;
    try {
      const buf = await this.appearance.withBaseMaterials(() =>
        exporter.parseAsync(modelRoot, { quickLookCompatible: true, animations: [clip], animationFrameRate: 30 }));
      const blob = new Blob([buf], { type: 'model/vnd.usdz+zip' });
      const url = URL.createObjectURL(blob);
      this.cache.set(key, { url, size: blob.size });
      this.url = url; this.size = blob.size;
      return url;
    } finally {
      modelRoot.position.y = savedY;
    }
  }

  /** Must be called from a user gesture (tap). Opens the URL returned by prepare(). */
  open(url = this.url, fileName = this.fileName) {
    if (!url) throw new Error('USDZ not prepared');
    const a = document.createElement('a');
    a.rel = 'ar';
    a.href = url;
    a.download = fileName;
    a.appendChild(document.createElement('img'));   // required by Safari for rel="ar"
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}
