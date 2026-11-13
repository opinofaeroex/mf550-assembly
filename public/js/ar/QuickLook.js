import * as THREE from 'three';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';

/**
 * iOS fallback: AR Quick Look.
 *
 * Safari on iPhone/iPad has no WebXR, so the current model is exported to USDZ in
 * the browser. The USDZ contains the same exploded-view → assembly program as the
 * web app (time-sampled transforms), so Quick Look plays it on a detected surface.
 * Quick Look cannot show the interactive BOM; that stays in the web page.
 */
export class QuickLook {
  constructor({ viewer, appearance, model, explode, fileName, staticUrl }) {
    Object.assign(this, { viewer, appearance, model, explode, fileName, staticUrl });
    this.url = null;
  }

  /** Per-entry explode factor over the Quick Look program (seconds). */
  static programTiming(N) {
    return { hold0: 1.5, explodeSpan: 2.6, explodeDur: 0.9, hold1: 1.0, stepAnim: 0.9, stepPeriod: 1.3, holdEnd: 2.5, N };
  }

  #factorAt(entry, t, T) {
    const N = Math.max(1, T.N);
    const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
    const s = entry.step ?? 0;
    const e0 = T.hold0 + (1 - s / N) * (T.explodeSpan - T.explodeDur);
    const tStepsStart = T.hold0 + T.explodeSpan + T.hold1;
    const a0 = tStepsStart + s * T.stepPeriod;
    if (t <= e0) return 0;
    if (t < e0 + T.explodeDur) return ease((t - e0) / T.explodeDur);
    if (t <= a0) return 1;
    if (t < a0 + T.stepAnim) return 1 - ease((t - a0) / T.stepAnim);
    return 0;
  }

  #buildClip() {
    const T = QuickLook.programTiming(this.model.stepCount);
    const total = T.hold0 + T.explodeSpan + T.hold1 + T.N * T.stepPeriod + T.holdEnd;
    const tracks = [];
    const { entries } = this.explode;
    const keysFor = (e) => {
      const s = e.step ?? 0;
      const e0 = T.hold0 + (1 - s / Math.max(1, T.N)) * (T.explodeSpan - T.explodeDur);
      const a0 = T.hold0 + T.explodeSpan + T.hold1 + s * T.stepPeriod;
      const times = new Set([0, total]);
      for (let k = 0; k <= 6; k++) { times.add(e0 + (T.explodeDur * k) / 6); times.add(a0 + (T.stepAnim * k) / 6); }
      return [...times].filter((t) => t >= 0 && t <= total).sort((a, b) => a - b);
    };
    for (const e of entries) {
      const times = keysFor(e);
      const values = [];
      for (const t of times) {
        const f = this.#factorAt(e, t, T);
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
    for (let t = 0; t <= total + 1e-6; t += 0.5) {
      for (let i = 0; i < entries.length; i++) f[i] = this.#factorAt(entries[i], t, T);
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
    return new THREE.AnimationClip('assembly', total, tracks);
  }

  /**
   * USDZ URL: the pre-built file shipped next to the GLB (npm run build:usdz) when
   * present, otherwise generated in the browser from the loaded model.
   */
  async prepare(onStatus) {
    if (this.url) return this.url;
    if (this.staticUrl) {
      try {
        const res = await fetch(this.staticUrl, { method: 'HEAD' });
        const type = res.headers.get('content-type') || '';
        if (res.ok && !type.includes('text/html')) {
          this.url = this.staticUrl;
          this.size = Number(res.headers.get('content-length')) || 0;
          return this.url;
        }
      } catch { /* fall through to in-browser export */ }
    }
    onStatus && onStatus('Generating USDZ for AR Quick Look…');
    await new Promise((r) => setTimeout(r, 30));
    const clip = this.#buildClip();
    const exporter = new USDZExporter();
    const modelRoot = this.viewer.modelRoot;
    const savedY = modelRoot.position.y;
    modelRoot.position.y = 0;
    try {
      const buf = await this.appearance.withBaseMaterials(() =>
        exporter.parseAsync(modelRoot, { quickLookCompatible: true, animations: [clip], animationFrameRate: 30 }));
      const blob = new Blob([buf], { type: 'model/vnd.usdz+zip' });
      this.url = URL.createObjectURL(blob);
      this.size = blob.size;
      return this.url;
    } finally {
      modelRoot.position.y = savedY;
    }
  }

  /** Must be called from a user gesture (tap). */
  open() {
    if (!this.url) throw new Error('USDZ not prepared');
    const a = document.createElement('a');
    a.rel = 'ar';
    a.href = this.url;
    a.download = this.fileName;
    a.appendChild(document.createElement('img'));   // required by Safari for rel="ar"
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}
