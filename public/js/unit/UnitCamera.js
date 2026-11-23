import * as THREE from 'three';
import { CAMERA_FOLLOW } from './standards.js';

/**
 * UnitCamera — automatic camera of the unit-installation tutorial (v2.0, per-operation shots in v2.1).
 *
 * Same interface as scene/CameraController.js (modes 'auto' | 'paused' | 'off' | 'ar',
 * 'state' events, pauseByUser / refocus / setEnabled / setAR / onPosition / focus), so the
 * camera toggle, the "paused — Refocus" chip and AR hand-off work unchanged.
 *
 * v2.1 — every step carries build-time camera SHOTS (pipeline/unit/build_unit.py):
 *   camera.shots = [[t, tx,ty,tz, dx,dy,dz, radius], …]   (model frame, metres)
 * chosen per operation from the CAD: an overview of the step (components + where they go),
 * the approach / close-up of each fastener with its tool, and a wider result view. Directions
 * are scored for a clear line of sight (collision-checked), the insertion axis seen from the
 * side and a camera position outside the geometry; the radius sets the zoom (small fasteners
 * close, brackets medium, modules wide). At run time the camera follows the step clock:
 * target, direction and distance are blended between consecutive shots and smoothed (orbiting
 * about the target, never cutting straight through the unit). The animation never depends on
 * the camera. A user orbit / zoom / pan pauses the automatic camera (manual control is never
 * overridden); Refocus resumes it at the current shot; a loop restart returns to the first shot.
 * Steps without shots fall back to the v2.0 static framing (plan()).
 */
const smooth = (u) => u * u * (3 - 2 * u);

export class UnitCamera extends EventTarget {
  constructor({ viewer, model, loaded, rig, clock = null }) {
    super();
    Object.assign(this, { viewer, model, loaded, rig });
    this.clock = clock;                 // () => current step time (s); set by main.js
    this.mode = 'auto';
    this.enabled = true;
    this.pos = null;
    this.precomputed = null;
    this.plans = new Map();
    this.shotCache = new Map();
    this.padding = CAMERA_FOLLOW.padding;
    this.follow = false;                // true while the shots drive the camera
    this.cur = null;                    // smoothed { target, dir, dist }
    this._q = new THREE.Quaternion();
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

  invalidate() { this.plans.clear(); this.shotCache.clear(); }
  usePrecomputed() { return false; }
  exportPlans() { return []; }

  onPosition(pos) {
    this.pos = pos;
    if (this.mode === 'ar' || !this.enabled) return;
    if (this.mode === 'paused') this.#setMode('auto');
    this.focus(pos);
  }

  /** Shots of a step converted to world space: [{ t, target, dir, radius }]. */
  shots(pos) {
    if (pos === null || pos < 0) return null;
    if (this.shotCache.has(pos)) return this.shotCache.get(pos);
    const s = this.model.steps[pos];
    const raw = s && s.camera && s.camera.shots;
    let out = null;
    if (raw && raw.length) {
      const root = this.loaded.root;
      root.updateWorldMatrix(true, false);
      const q = root.getWorldQuaternion(new THREE.Quaternion());
      const sc = root.getWorldScale(new THREE.Vector3()).x || 1;
      out = raw.map((r) => ({
        t: r[0],
        target: root.localToWorld(new THREE.Vector3(r[1], r[2], r[3])),
        dir: new THREE.Vector3(r[4], r[5], r[6]).applyQuaternion(q).normalize(),
        radius: r[7] * sc,
      }));
    }
    this.shotCache.set(pos, out);
    return out;
  }

  /** Desired camera state of a step at time t: blend of the surrounding shots. */
  shotState(pos, t) {
    const S = this.shots(pos);
    if (!S) return null;
    let i = 0;
    while (i < S.length - 1 && t >= S[i + 1].t) i++;
    const a = S[i], b = S[Math.min(i + 1, S.length - 1)];
    let u = 0;
    if (b !== a) {
      // move towards the next shot during the last part of the interval (at most 0.9 s)
      const lead = Math.min(CAMERA_FOLLOW.maxLead, (b.t - a.t) * CAMERA_FOLLOW.leadShare);
      u = smooth(Math.max(0, Math.min(1, (t - (b.t - lead)) / Math.max(1e-6, lead))));
    }
    const target = a.target.clone().lerp(b.target, u);
    const dir = a.dir.clone().lerp(b.dir, u);
    if (dir.lengthSq() < 1e-6) dir.copy(u < 0.5 ? a.dir : b.dir);
    dir.normalize();
    const radius = Math.exp(Math.log(a.radius) * (1 - u) + Math.log(b.radius) * u);
    return { target, dir, dist: this.viewer.fitDistance(radius, this.padding), index: i, u };
  }

  /** Per frame (viewer.onCamera): follow the shots of the current step while in auto mode. */
  update(dt) {
    if (!this.follow || this.mode !== 'auto' || !this.enabled || this.pos === null || this.pos < 0) return;
    const t = this.clock ? this.clock() : 0;
    const want = this.shotState(this.pos, t);
    if (!want) return;
    const v = this.viewer;
    if (!this.cur) {
      const target = v.controls.target.clone();
      const off = v.camera.position.clone().sub(target);
      this.cur = { target, dir: off.clone().normalize(), dist: off.length() || want.dist };
    }
    const c = this.cur;
    const k = 1 - Math.exp(-Math.min(dt, CAMERA_FOLLOW.maxFrameDt) * CAMERA_FOLLOW.smoothing);
    c.target.lerp(want.target, k);
    // rotate the view direction towards the wanted one (orbit about the target)
    const q = this._q.setFromUnitVectors(c.dir, want.dir);
    const qk = new THREE.Quaternion().slerp(q, k);
    c.dir.applyQuaternion(qk).normalize();
    c.dist = Math.exp(Math.log(c.dist) + (Math.log(want.dist) - Math.log(c.dist)) * k);
    v.controls.target.copy(c.target);
    v.camera.position.copy(c.target).addScaledVector(c.dir, c.dist);
    v.requestRender();
  }

  /** Target + camera position (world) for a navigation position (static v2.0 framing). */
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
    this.follow = false;
    this.cur = null;
    if (pos < 0) {                                // overview / parts kit: whole product, front 3/4 view
      const p = this.plan(-2);
      this.viewer.flyTo(p.target, p.position, !instant);
      return;
    }
    const st = this.shotState(pos, this.clock ? this.clock() : 0);
    if (st) {
      // shots drive the camera from now on (smoothly from the current view, or at once)
      this.viewer.cancelCameraTween();
      this.follow = true;
      if (instant) {
        this.cur = { target: st.target.clone(), dir: st.dir.clone(), dist: st.dist };
        this.viewer.flyTo(st.target, st.target.clone().addScaledVector(st.dir, st.dist), false);
      }
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
