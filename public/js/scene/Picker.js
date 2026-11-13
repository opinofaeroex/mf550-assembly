import * as THREE from 'three';
import { STATE } from './Appearance.js';

/**
 * Picker — screen point (3D viewer) or XR input ray (AR) → part instance id.
 * Opaque parts win over ghosted ones so you can click "through" the ghost shell.
 */
export class Picker {
  constructor(viewer, appearance) {
    this.viewer = viewer;
    this.appearance = appearance;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
  }

  /** @param {number} x client X  @param {number} y client Y  @param {DOMRect} rect */
  pick(x, y, rect) {
    this.ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.viewer.activeCamera());
    return this.#resolve();
  }

  pickRay(origin, dir) {
    this.raycaster.set(origin, dir);
    return this.#resolve();
  }

  #resolve() {
    if (!this.viewer.model) return null;
    const hits = this.raycaster.intersectObject(this.viewer.model, true);
    let ghostHit = null;
    for (const h of hits) {
      const part = h.object.userData.part;
      if (!part || !h.object.visible) continue;
      const st = this.appearance.get(part);
      if (st === STATE.GHOST) { ghostHit = ghostHit || part; continue; }
      if (st === STATE.HIDDEN) continue;
      return part;
    }
    return ghostHit;
  }
}
