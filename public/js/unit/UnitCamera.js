import * as THREE from 'three';

/**
 * UnitCamera — automatic camera of the unit-installation tutorial (v2.0).
 *
 * Same interface as scene/CameraController.js (modes 'auto' | 'paused' | 'off' | 'ar',
 * 'state' events, pauseByUser / refocus / setEnabled / setAR / onPosition / focus), so the
 * camera toggle, the "paused — Refocus" chip and AR hand-off work unchanged.
 *
 * Framing per step comes from the step data: `camera.dir` (direction from the target towards
 * the camera, model frame) and the step's focus components + every tool working point of the
 * step (so the whole operation stays in view). `close` frames tighter, `wide` shows the unit.
 * A user orbit / zoom / pan pauses the automatic camera until Refocus or the next step.
 */
export class UnitCamera extends EventTarget {
  constructor({ viewer, model, loaded, rig }) {
    super();
    Object.assign(this, { viewer, model, loaded, rig });
    this.mode = 'auto';
    this.enabled = true;
    this.pos = null;
    this.precomputed = null;
    this.plans = new Map();
  }

  setEnabled(on) {
    this.enabled = on;
    this.#setMode(on ? 'auto' : 'off');
    if (on && this.pos !== null) this.focus(this.pos);
  }

  pauseByUser() { if (this.mode === 'auto') this.#setMode('paused'); }

  refocus() {
    if (!this.enabled) this.enabled = true;
    this.#setMode('auto');
    if (this.pos !== null) this.focus(this.pos);
  }

  setAR(active) {
    this.#setMode(active ? 'ar' : (this.enabled ? 'auto' : 'off'));
  }

  invalidate() { this.plans.clear(); }
  usePrecomputed() { return false; }
  exportPlans() { return []; }

  onPosition(pos) {
    this.pos = pos;
    if (this.mode === 'ar' || !this.enabled) return;
    if (this.mode === 'paused') this.#setMode('auto');
    this.focus(pos);
  }

  /** Target + camera position (world) for a navigation position. */
  plan(pos) {
    const { viewer, model, loaded, rig } = this;
    const box = new THREE.Box3();
    const s = pos >= 0 ? model.steps[pos] : null;
    const cam = (s && s.camera) || {};
    viewer.scene.updateMatrixWorld();
    const partsBox = () => { for (const id of model.partIds) { const o = loaded.objects.get(id); if (o && this.#visible(o)) box.expandByObject(o); } };
    if (!s || cam.wide) {
      partsBox();
    } else {
      for (const id of s.focus) {
        const o = loaded.objects.get(id);
        if (o) box.expandByObject(o);
      }
      // starting poses + tool working points of this step (model frame -> world)
      for (const p of rig.focusPoints(pos)) box.expandByPoint(loaded.root.localToWorld(p.clone()));
      if (box.isEmpty()) partsBox();
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const minR = cam.close ? 0.11 : 0.2;
    const r = Math.max(sphere.radius, minR);
    const dir = new THREE.Vector3(...(cam.dir || [1, 0.55, 0.9]));
    // model frame -> world (the root is only translated by the viewer)
    dir.applyQuaternion(loaded.root.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const dist = viewer.fitDistance(r, cam.close ? 1.15 : 1.25);
    const target = sphere.center.clone();
    return { target, position: target.clone().addScaledVector(dir, dist) };
  }

  #visible(o) { let p = o; while (p) { if (p.visible === false) return false; p = p.parent; } return true; }

  focus(pos, { instant = false } = {}) {
    if (pos === null || pos === undefined) return;
    if (pos < 0) {                                // overview / parts kit: whole product, front 3/4 view
      const p = this.plan(-2);
      this.viewer.flyTo(p.target, p.position, !instant);
      return;
    }
    const p = this.plan(pos);
    this.viewer.flyTo(p.target, p.position, !instant, 1.1);
  }

  #setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    this.dispatchEvent(new CustomEvent('state', { detail: { mode: m } }));
  }
}
