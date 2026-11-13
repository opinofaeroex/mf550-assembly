import * as THREE from 'three';

/**
 * ExplodeController — moves components along their exploded-view vectors.
 *
 * Every movable node has a factor f in [0, 1]:
 *   position = CAD position + f * explodeVector   (parent frame, metres)
 * f = 0 is the exact CAD position, so the assembled state is always the
 * original geometry; vectors come from the pipeline's disassembly analysis.
 * Nested sub-assemblies inherit their parent's offset through the scene graph.
 */
export class ExplodeController {
  constructor(model, objects) {
    this.entries = [];
    for (const n of model.nodes.values()) {
      const v = n.explode;
      if (!v || (v[0] === 0 && v[1] === 0 && v[2] === 0)) continue;
      const obj = objects.get(n.id);
      this.entries.push({
        id: n.id,
        obj,
        base: obj.position.clone(),
        vec: new THREE.Vector3(v[0], v[1], v[2]),
        step: n.step,
        depth: n.depth,
      });
    }
    this.f = new Float32Array(this.entries.length);
    this.index = new Map(this.entries.map((e, i) => [e.id, i]));
  }

  apply() {
    const { entries, f } = this;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      e.obj.position.copy(e.base).addScaledVector(e.vec, f[i]);
    }
  }

  /** max factor, used as a coarse "how exploded" indicator */
  amount() {
    let m = 0;
    for (const v of this.f) if (v > m) m = v;
    return m;
  }
}
