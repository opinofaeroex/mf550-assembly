import * as THREE from 'three';

/**
 * CameraController — automatic close-up of the components of the current step.
 *
 * Targets come from the data, never from guesses: step k of assembly.json lists the
 * nodes it installs (`steps[k].nodes`); their parts' meshes give the geometry.
 * For each step a plan is computed once (and cached) in the step's own scene state
 * (earlier steps assembled, later steps exploded, this step at its CAD position):
 *
 *   focus box   the step's components at their final position, plus the last part of
 *               their approach path (≤ CONFIG.camera.maxTravelShown), so the motion of
 *               the looping animation stays in view; never smaller than minRadius.
 *   direction   60 candidate view directions around the focus box are scored by
 *                 visibility  – sight lines from the components' surface (the point of each
 *                               sampled part facing the camera) to the camera, tested against
 *                               the triangles of every other solid (non-ghosted) part
 *                               — finds openings and avoids parts hiding the operation;
 *                 motion      – a view across the install direction shows the movement;
 *                 elevation   – a natural viewpoint slightly above the work;
 *                 continuity  – small rotations from the current view are preferred.
 *   distance    fits the focus sphere into the part of the viewport not covered by the
 *               step card (same maths as Viewer.frame).
 *
 * Sight lines are evaluated in slices of a few milliseconds per frame (current step first,
 * then its neighbours, then all steps), so the 3D view never stutters; if a step is entered
 * before its plan is complete, the camera starts with a provisional view and refines it.
 *
 * The goal is stored in model coordinates and re-evaluated every frame, so the camera
 * follows the model's floor lift while the parts move. Transitions orbit around the
 * target (direction slerp + distance log-lerp) instead of cutting through the model.
 *
 * v1.5: the plans are deterministic (geometry + ghosting option), so they are computed once by
 * tools/precompute-camera.cjs into assets/model/camera-plans.json and only looked up at run
 * time — no sight-line ray casting on the device. The file is used only if its fingerprint
 * matches this model and these camera settings; otherwise the runtime evaluation above runs
 * (in slices of perf.planningBudgetMs per frame).
 *
 * Modes: 'auto' (follows every step), 'paused' (the user moved the view: nothing is
 * forced until the next step or Refocus), 'off' (disabled by the user), 'ar' (WebXR).
 * Events: 'state' {mode}, 'arrived' {pos}.
 */
const ELEVATIONS = [-20, 10, 30, 50, 72];
const AZIMUTH_STEP = 30;

export class CameraController extends EventTarget {
  /**
   * @param {object} o
   * @param {import('./Viewer.js').Viewer} o.viewer
   * @param {object} o.model                       AssemblyModel
   * @param {{objects: Map, meshesByPart: Map}} o.loaded
   * @param {import('./Explode.js').ExplodeController} o.explode
   * @param {(partId: string, pos: number) => boolean} o.isSolid  drawn opaque at that step
   * @param {object} [o.cfg]
   */
  constructor({ viewer, model, loaded, explode, isSolid, cfg = {}, variant = () => 'ghost' }) {
    super();
    Object.assign(this, { viewer, model, loaded, explode, isSolid, variant });
    this.precomputed = null;
    this.cfg = {
      padding: 1.3, minRadius: 0.07, maxTravelShown: 0.22, transition: [0.9, 1.6], syncBudgetMs: 40, frameBudgetMs: 4,
      weights: { visibility: 3, motion: 1, elevation: 0.6, continuity: 0.5 }, ...cfg,
    };
    this.mode = 'auto';
    this.enabled = true;
    this.plans = new Map();
    this.pos = null;
    this.goal = null;          // { target: Vector3 (model space), dir: Vector3, radius }
    this.tween = null;
    this.queue = [];
    this.raycaster = new THREE.Raycaster();
    this.parts = model.partIds;
    this.stepParts = model.steps.map((s) => new Set(s.nodes.flatMap((id) => model.partsUnder(id))));
    this.modelRadius = viewer.boxOf().getBoundingSphere(new THREE.Sphere()).radius || 1;
    this.reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    viewer.onCamera.push((dt) => this.#update(dt));
  }

  // ------------------------------------------------------------------ public
  setEnabled(on) {
    this.enabled = !!on;
    this.#setMode(on ? 'auto' : 'off');
    if (on && this.pos !== null) this.focus(this.pos);
  }

  /** The user took over the view (orbit / zoom / pan / frame / zoom-to-selection). */
  pauseByUser() {
    if (this.mode === 'auto') { this.tween = null; this.#setMode('paused'); }
  }

  /** Back to automatic focus on the current step (Refocus button, C key). */
  refocus() {
    if (!this.enabled) this.setEnabled(true);
    else { this.#setMode('auto'); if (this.pos !== null) this.focus(this.pos); }
  }

  setAR(active) {
    if (active) { this.tween = null; this.#setMode('ar'); }
    else this.#setMode(this.enabled ? 'auto' : 'off');
  }

  /** Forget cached plans (their sight lines depend on which parts are drawn solid). */
  invalidate() {
    this.plans.clear();
    this.queue = [];
    if (this.goal) this.goal.final = true;      // keep the current view; new plans apply from the next step
    if (this.pos !== null) this.#schedule(this.pos);
  }

  /** Fingerprint of everything a plan depends on (model, explode scale, camera settings). */
  static planKey(model, cfg, fov, explodeScale) {
    const m = model.meta;
    return JSON.stringify({ glb: m.glb, convertedAt: m.convertedAt, parts: m.partInstances, steps: model.stepCount,
      explodeScale, fov, padding: cfg.padding, minRadius: cfg.minRadius, maxTravelShown: cfg.maxTravelShown,
      elevations: ELEVATIONS, azimuthStep: AZIMUTH_STEP });
  }

  /** Use precomputed plans (assets/model/camera-plans.json) if they were made for this model. */
  usePrecomputed(data, key) {
    this.precomputed = data && data.key === key ? data : null;
    this.plans.clear();
    if (this.pos !== null) this.#schedule(this.pos);
    return !!this.precomputed;
  }

  /** Plans of every step for the current ghosting option (input of tools/precompute-camera.cjs). */
  exportPlans() {
    const r = (v) => Math.round(v * 1e6) / 1e6;
    const out = [];
    for (let k = 0; k < this.model.stepCount; k++) {
      const p = this.plan(k);
      out.push({ target: p.target.toArray().map(r), radius: r(p.radius), motion: p.motion ? p.motion.toArray().map(r) : null,
        partCount: p.partCount, travelShown: r(p.travelShown), vis: p.candidates.map((c) => Math.round(c.visibility * 1e4) / 1e4) });
    }
    return out;
  }

  /**
   * Called on every position change (all navigation inputs end in Sequencer 'change').
   * A new step ends a manual pause: the camera guides the user to the new operation.
   */
  onPosition(pos) {
    this.pos = pos;
    this.#schedule(pos);
    if (this.mode === 'ar' || !this.enabled) return;
    if (this.mode === 'paused') this.#setMode('auto');
    this.focus(pos);
  }

  /** Start a smooth move to the recommended view of `pos`. */
  focus(pos, { instant = false } = {}) {
    if (this.mode !== 'auto' || this.viewer.renderer.xr.isPresenting) return;
    const plan = this.#plan(pos);
    if (!plan.ready) this.#evaluate(plan, this.cfg.syncBudgetMs);   // usually enough to finish
    this.#moveTo(plan, { instant });
  }

  /** Complete plan for a position (computed synchronously if needed). */
  plan(pos) {
    const p = this.#plan(pos);
    if (!p.ready) this.#evaluate(p, Infinity);
    return p;
  }

  /** Review of the camera targets of every step (used by the tests and docs/camera-review.md). */
  review() {
    const out = [];
    for (let k = 0; k < this.model.stepCount; k++) {
      const p = this.plan(k);
      const dir = this.#chooseDirection(p, { continuity: false });
      const c = p.candidates.find((x) => x.dir.equals(dir));
      const flags = [];
      if (c.visibility < 0.5) flags.push(`enclosed: ${Math.round(c.visibility * 100)} % of sight lines clear from the best view — the x-ray highlight shows the parts through the housing`);
      if (this.model.steps[k].flag) flags.push('install path approximate (no collision-free path in the CAD geometry)');
      out.push({
        step: k + 1, parts: p.partCount, radiusMm: Math.round(p.radius * 1000), travelShownMm: Math.round(p.travelShown * 1000),
        visibility: +c.visibility.toFixed(2), elevationDeg: c.elev, azimuthDeg: c.azim, motionAngleDeg: p.motion ? Math.round(c.motionAngle) : null,
        source: 'steps[k].nodes', flags,
      });
    }
    return out;
  }

  // ----------------------------------------------------------------- planning
  /** Run fn with the scene in the end state of `pos` (synchronous, restored before return). */
  #withState(pos, fn) {
    const { entries, f } = this.explode;
    const saved = Float32Array.from(f);
    const N = this.model.stepCount;
    for (let i = 0; i < entries.length; i++) {
      const s = entries[i].step;
      f[i] = pos === -1 ? 1 : pos === -2 || pos >= N || s === null || s === undefined ? 0 : s <= pos ? 0 : 1;
    }
    this.explode.apply();
    this.viewer.modelRoot.updateMatrixWorld(true);
    try { return fn(f); } finally {
      f.set(saved);
      this.explode.apply();
      this.viewer.modelRoot.updateMatrixWorld(true);
    }
  }

  /** World offset of model space (the floor lift: modelRoot only translates in 3D mode). */
  #offset() { return this.viewer.modelRoot.localToWorld(new THREE.Vector3()); }

  #partBox(id, out = new THREE.Box3()) {
    out.makeEmpty();
    for (const m of this.loaded.meshesByPart.get(id) || []) out.expandByObject(m);
    return out;
  }

  /** ≤ 160 surface points of a part (model space): their extreme point toward a camera is on the visible side. */
  #surfacePoints(id, T) {
    const pts = [];
    const v = new THREE.Vector3();
    for (const m of this.loaded.meshesByPart.get(id) || []) {
      const pa = m.geometry.attributes.position;
      const stride = Math.max(1, Math.floor(pa.count / 80));
      for (let i = 0; i < pa.count; i += stride) pts.push(v.fromBufferAttribute(pa, i).applyMatrix4(m.matrixWorld).sub(T).clone());
    }
    return pts;
  }

  /** Geometry of a plan (cheap, synchronous); sight lines are evaluated later, in slices. */
  #plan(pos) {
    let plan = this.plans.get(pos);
    if (plan) return plan;
    const isStep = pos >= 0 && pos < this.model.stepCount;
    const pre = isStep && this.precomputed && this.precomputed.variants[this.variant()];
    if (pre && pre[pos]) {
      plan = this.#fromPrecomputed(pos, pre[pos]);
      this.plans.set(pos, plan);
      return plan;
    }
    plan = this.#withState(pos, (f) => {
      const T = this.#offset();
      if (!isStep) {
        const sphere = this.viewer.boxOf().getBoundingSphere(new THREE.Sphere());
        return { pos, target: sphere.center.sub(T), radius: sphere.radius, candidates: [], motion: null, partCount: this.parts.length, travelShown: 0, ready: true };
      }
      const ids = [...this.stepParts[pos]];
      const pb = new THREE.Box3();
      const finalBox = new THREE.Box3();
      const finals = ids.map((id) => { this.#partBox(id, pb); finalBox.union(pb); return pb.getCenter(new THREE.Vector3()); });
      const every = Math.max(1, Math.ceil(ids.length / 6));
      const sampleIds = ids.filter((_, i) => i % every === 0);
      const samples = sampleIds.map((id) => {
        const c = this.#partBox(id, pb).getCenter(new THREE.Vector3()).sub(T);
        return { center: c, points: this.#surfacePoints(id, T) };
      });

      // approach path: the step's own entries at f = 1 (where the loop starts from)
      const { entries } = this.explode;
      for (let i = 0; i < entries.length; i++) if (entries[i].step === pos) f[i] = 1;
      this.explode.apply();
      this.viewer.modelRoot.updateMatrixWorld(true);
      const starts = ids.map((id) => this.#partBox(id, pb).getCenter(new THREE.Vector3()));
      for (let i = 0; i < entries.length; i++) if (entries[i].step === pos) f[i] = 0;
      this.explode.apply();
      this.viewer.modelRoot.updateMatrixWorld(true);

      const motionSum = new THREE.Vector3();
      let travel = 0;
      const travelVecs = finals.map((c, i) => starts[i].clone().sub(c));
      for (const v of travelVecs) { travel += v.length(); if (v.lengthSq() > 1e-12) motionSum.add(v.clone().normalize()); }
      travel /= Math.max(1, finals.length);
      const motion = motionSum.length() > 0.3 * finals.length ? motionSum.normalize().negate() : null;   // install direction
      const size = finalBox.getSize(new THREE.Vector3()).length();
      const shown = Math.min(travel, Math.max(this.cfg.maxTravelShown, 1.2 * size));
      const focus = finalBox.clone();
      if (travel > 1e-6) {
        const k = shown / travel;
        travelVecs.forEach((v, i) => focus.union(this.#partBox(ids[i], pb).clone().translate(v.clone().multiplyScalar(k))));
      }
      const sphere = focus.getBoundingSphere(new THREE.Sphere());
      const radius = Math.max(sphere.radius, this.cfg.minRadius);
      const center = sphere.center.clone().sub(T);

      const target = new Set(ids);
      const occluders = [];
      for (const id of this.parts) {
        if (target.has(id) || !this.isSolid(id, pos)) continue;
        for (const m of this.loaded.meshesByPart.get(id) || []) {
          occluders.push({ mesh: m, box: new THREE.Box3().setFromObject(m).translate(T.clone().negate()) });
        }
      }
      const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.viewer.camera.fov) / 2) * this.cfg.padding;
      const candidates = this.#candidates(center, motion, dist);
      return {
        pos, target: center, radius, candidates, motion, partCount: ids.length, travelShown: shown,
        samples, occluders, next: 0, ready: false,
      };
    });
    this.plans.set(pos, plan);
    return plan;
  }

  /** A plan from camera-plans.json: no scene changes, no ray casting. */
  #fromPrecomputed(pos, d) {
    const center = new THREE.Vector3().fromArray(d.target);
    const motion = d.motion ? new THREE.Vector3().fromArray(d.motion) : null;
    const dist = d.radius / Math.sin(THREE.MathUtils.degToRad(this.viewer.camera.fov) / 2) * this.cfg.padding;
    const candidates = this.#candidates(center, motion, dist);
    candidates.forEach((c, i) => { c.visibility = d.vis[i]; });
    return { pos, target: center, radius: d.radius, candidates, motion, partCount: d.partCount, travelShown: d.travelShown,
      next: candidates.length, ready: true, precomputed: true };
  }

  #candidates(center, motion, dist) {
    const candidates = [];
    for (const elev of ELEVATIONS) {
      for (let azim = 0; azim < 360; azim += AZIMUTH_STEP) {
        const e = THREE.MathUtils.degToRad(elev), a = THREE.MathUtils.degToRad(azim);
        const dir = new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
        const motionAngle = motion ? THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(dir.dot(motion))))) : 90;
        candidates.push({ dir, elev, azim, visibility: null, motionAngle, cam: center.clone().addScaledVector(dir, dist) });
      }
    }
    return candidates;
  }

  /** Evaluate sight lines of a plan's candidates within a time budget (ms). */
  #evaluate(plan, budgetMs) {
    if (plan.ready) return true;
    const t0 = performance.now();
    this.#withState(plan.pos, () => {
      const T = this.#offset();
      const occ = plan.occluders.map((o) => ({ mesh: o.mesh, box: o.box.clone().translate(T) }));
      while (plan.next < plan.candidates.length) {
        const c = plan.candidates[plan.next++];
        const cam = c.cam.clone().add(T);
        let clear = 0;
        for (const s of plan.samples) {
          // the sample's extreme surface point toward the camera, nudged inwards
          let best = null, bd = -Infinity;
          for (const q of s.points) { const d = q.dot(c.dir); if (d > bd) { bd = d; best = q; } }
          const p = best.clone().lerp(s.center, 0.03).add(T);
          if (!this.#blocked(p, cam, occ)) clear++;
        }
        c.visibility = clear / plan.samples.length;
        if (performance.now() - t0 > budgetMs) break;
      }
    });
    if (plan.next >= plan.candidates.length) {
      plan.ready = true;
      plan.samples = plan.occluders = null;      // free memory
    }
    return plan.ready;
  }

  #schedule(pos) {
    const N = this.model.stepCount;
    const order = [pos, pos + 1, pos - 1, pos + 2];
    for (let k = 0; k < N; k++) order.push(k);
    this.queue = [...new Set(order.filter((k) => k >= -2 && k < N))];
  }

  /** Background planning: a few ms per frame, current step first, then its neighbours, then all. */
  #pump() {
    const budget = this.cfg.frameBudgetMs;
    const t0 = performance.now();
    while (this.queue && this.queue.length && performance.now() - t0 < budget) {
      const k = this.queue[0];
      const p = this.#plan(k);
      if (this.#evaluate(p, budget - (performance.now() - t0))) {
        this.queue.shift();
        if (this.goal && this.goal.pos === k && !this.goal.final) this.#refine(p);
      }
    }
  }

  /** A provisional view became final: move there only if it differs noticeably. */
  #refine(plan) {
    if (this.mode !== 'auto') return;
    const dir = this.#chooseDirection(plan);
    this.goal.final = true;
    if (dir.angleTo(this.goal.dir) < THREE.MathUtils.degToRad(12)) return;
    this.#moveTo(plan, { dir });
  }

  #moveTo(plan, { instant = false, dir = null } = {}) {
    dir = dir || this.#chooseDirection(plan);
    this.goal = { pos: plan.pos, target: plan.target.clone(), dir, radius: plan.radius, final: plan.ready };
    this.viewer.cancelCameraTween();
    const { target: toT, position: toP } = this.#goalWorld();
    const fromT = this.viewer.controls.target.clone();
    const fromP = this.viewer.camera.position.clone();
    const ang = fromP.clone().sub(fromT).normalize().angleTo(toP.clone().sub(toT).normalize());
    const [d0, d1] = this.cfg.transition;
    const dur = instant || this.reduceMotion ? 0 : d0 + (d1 - d0) * Math.min(1, ang / Math.PI);
    this.tween = dur > 0 ? { t: 0, dur, fromT, fromP } : null;
    if (!this.tween) this.#place(toT, toP);
  }

  /** Is the sight line from p to the camera position blocked by a solid part? */
  #blocked(p, cam, occluders) {
    const dir = cam.clone().sub(p);
    const far = dir.length();
    dir.normalize();
    const ray = new THREE.Ray(p, dir);
    const hit = new THREE.Vector3();
    const near = [];
    for (const o of occluders) {
      if (o.box.containsPoint(p)) { near.push([0, o]); continue; }
      const h = ray.intersectBox(o.box, hit);
      if (h) { const d = h.distanceTo(p); if (d < far) near.push([d, o]); }
    }
    if (!near.length) return false;
    near.sort((a, b) => a[0] - b[0]);
    const rc = this.raycaster;
    rc.set(p, dir);
    rc.near = 1e-4;
    rc.far = far;
    const hits = [];
    for (const [, o] of near) {
      hits.length = 0;
      o.mesh.raycast(rc, hits);
      if (hits.length) return true;
    }
    return false;
  }

  #chooseDirection(plan, { continuity = true } = {}) {
    if (!plan.candidates.length) {
      // overview / parts kit: keep the current direction, slightly above the model
      const d = this.viewer.camera.position.clone().sub(this.viewer.controls.target);
      if (d.lengthSq() < 1e-8) d.set(1, 0.6, 1.3);
      d.normalize();
      if (d.y < 0.15) { d.y = 0.35; d.normalize(); }
      return d;
    }
    const w = this.cfg.weights;
    const cur = this.viewer.camera.position.clone().sub(this.viewer.controls.target).normalize();
    let best = null, bestScore = -Infinity;
    for (const c of plan.candidates) {
      const sMotion = Math.sin(THREE.MathUtils.degToRad(c.motionAngle));       // 1 = across the motion
      const sElev = 1 - Math.min(1, Math.abs(c.elev - 30) / 60) - (c.elev < 0 ? 0.25 : 0);
      const sCont = continuity ? (1 + c.dir.dot(cur)) / 2 : 0.5;
      const vis = c.visibility === null ? 0.5 : c.visibility;    // not evaluated yet: neutral
      const score = w.visibility * vis + w.motion * sMotion + w.elevation * sElev + w.continuity * sCont;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best.dir.clone();
  }

  // ------------------------------------------------------------------ motion
  /** Goal in world space for the current viewport and model lift. */
  #goalWorld(out = { target: new THREE.Vector3(), position: new THREE.Vector3() }) {
    const g = this.goal;
    const v = this.viewer;
    const target = v.modelRoot.localToWorld(out.target.copy(g.target));
    const dist = v.fitDistance(g.radius, this.cfg.padding);
    out.position.copy(target).addScaledVector(g.dir, dist);
    return out;
  }

  #gw = { target: new THREE.Vector3(), position: new THREE.Vector3() };

  #place(target, position) {
    this.viewer.controls.target.copy(target);
    this.viewer.camera.position.copy(position);
  }

  #update(dt) {
    if (this.viewer.renderer.xr.isPresenting) return;
    this.#pump();
    if (this.mode !== 'auto' || !this.goal) return;
    const { target: gT, position: gP } = this.#goalWorld(this.#gw);
    const tw = this.tween;
    if (!tw) { this.#place(gT, gP); return; }
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
    const target = tw.fromT.clone().lerp(gT, e);
    const o0 = tw.fromP.clone().sub(tw.fromT), o1 = gP.clone().sub(gT);
    const d0 = o0.length() || 1e-3, d1 = o1.length() || 1e-3;
    const q = new THREE.Quaternion().setFromUnitVectors(o0.clone().normalize(), o1.clone().normalize());
    const dir = o0.clone().normalize().applyQuaternion(new THREE.Quaternion().slerp(q, e));
    const dist = Math.exp(Math.log(d0) + (Math.log(d1) - Math.log(d0)) * e);
    this.#place(target, target.clone().addScaledVector(dir, dist));
    if (tw.t >= 1) {
      this.tween = null;
      this.dispatchEvent(new CustomEvent('arrived', { detail: { pos: this.goal.pos } }));
    }
  }

  #setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    this.dispatchEvent(new CustomEvent('state', { detail: { mode: m } }));
  }
}
