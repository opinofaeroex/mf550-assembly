import * as THREE from 'three';

/**
 * ExplodeController — moves components along their exploded-view vectors.
 *
 * Every movable node has a factor f in [0, 1]:
 *   position = CAD position + f * scale * explodeVector   (parent frame, metres)
 * f = 0 is the exact CAD position, so the assembled state is always the
 * original geometry; vectors come from the pipeline's disassembly analysis.
 * `scale` (CONFIG.explodeScale) lengthens every vector by the same factor —
 * hardware, parts and sub-assemblies — without changing any direction. v2.1: an optional
 * soft cap (CONFIG.explodeSoftCap) shortens only the few very long vectors beyond `from`
 * metres (growth × `rate` past it), direction unchanged.
 * Nested sub-assemblies inherit their parent's offset through the scene graph.
 *
 * v1.5: apply() only touches components whose factor changed and reports whether
 * anything moved (onChange → the viewer draws a frame). lowestPoint() gives the model's
 * lowest point for the floor lift from bounds measured once at the CAD position — exactly
 * what a bounding-box pass over the whole model returns, because components only translate.
 */
export class ExplodeController {
  constructor(model, objects, scale = 1, softCap = null) {
    this.scale = scale;
    this.softCap = softCap;
    this.entries = [];
    for (const n of model.nodes.values()) {
      const v = n.explode;
      if (!v || (v[0] === 0 && v[1] === 0 && v[2] === 0)) continue;
      const obj = objects.get(n.id);
      const baseVec = new THREE.Vector3(v[0], v[1], v[2]);   // as computed by the pipeline
      this.entries.push({
        id: n.id,
        obj,
        base: obj.position.clone(),                          // exact CAD position
        baseVec,
        vec: ExplodeController.displayed(baseVec, scale, softCap),   // displayed displacement
        step: n.step,
        depth: n.depth,
      });
    }
    this.f = new Float32Array(this.entries.length);
    this.applied = new Float32Array(this.entries.length).fill(NaN);
    this.index = new Map(this.entries.map((e, i) => [e.id, i]));
    this.onChange = null;
    this.version = 0;
  }

  /** Displayed displacement of a pipeline vector (scale, then the optional soft cap). */
  static displayed(baseVec, scale, softCap) {
    const v = baseVec.clone().multiplyScalar(scale);
    const L = v.length();
    if (softCap && L > softCap.from) v.multiplyScalar((softCap.from + (L - softCap.from) * softCap.rate) / L);
    return v;
  }

  /** Write the factors to the scene. Returns true if any component moved. */
  apply() {
    const { entries, f, applied } = this;
    let moved = false;
    for (let i = 0; i < entries.length; i++) {
      if (f[i] === applied[i]) continue;
      applied[i] = f[i];
      const e = entries[i];
      e.obj.position.copy(e.base).addScaledVector(e.vec, f[i]);
      moved = true;
    }
    if (moved) { this.version++; if (this.onChange) this.onChange(); }
    return moved;
  }

  /** max factor, used as a coarse "how exploded" indicator */
  amount() {
    let m = 0;
    for (const v of this.f) if (v > m) m = v;
    return m;
  }

  /**
   * Prepare lowestPoint(): per mesh, its lowest point at the CAD position (in `space`,
   * i.e. modelRoot coordinates) and the vertical component of every exploding ancestor's
   * displacement in that space. Call once, with all factors at 0 (CAD position).
   */
  prepareBounds(space, meshes) {
    space.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
    const rel = new THREE.Matrix4();
    const box = new THREE.Box3();
    const byObj = new Map(this.entries.map((e, i) => [e.obj, i]));
    const vy = new Float64Array(this.entries.length);
    const v = new THREE.Vector3();
    const m3 = new THREE.Matrix3();
    for (let i = 0; i < this.entries.length; i++) {
      const parent = this.entries[i].obj.parent;
      rel.multiplyMatrices(inv, parent.matrixWorld);
      vy[i] = v.copy(this.entries[i].vec).applyMatrix3(m3.setFromMatrix4(rel)).y;   // displacement in `space`
    }
    const restMin = [], anc = [];
    for (const m of meshes) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      rel.multiplyMatrices(inv, m.matrixWorld);
      box.copy(m.geometry.boundingBox).applyMatrix4(rel);
      restMin.push(box.min.y);
      const list = [];
      for (let p = m; p && p !== space; p = p.parent) if (byObj.has(p)) list.push(byObj.get(p));
      anc.push(Int32Array.from(list));
    }
    this.bounds = { restMin: Float64Array.from(restMin), anc, vy };
  }

  /** Lowest point of the model (space of prepareBounds) for the current factors. */
  lowestPoint() {
    const b = this.bounds;
    if (b.version === this.version) return b.min;
    const { restMin, anc, vy } = b;
    const f = this.applied;
    let min = Infinity;
    for (let k = 0; k < restMin.length; k++) {
      let y = restMin[k];
      const a = anc[k];
      for (let j = 0; j < a.length; j++) { const fi = f[a[j]]; if (fi) y += fi * vy[a[j]]; }
      if (y < min) min = y;
    }
    b.min = min;
    b.version = this.version;
    return min;
  }
}
