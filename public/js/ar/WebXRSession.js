import * as THREE from 'three';

/**
 * Markerless WebXR AR session (immersive-ar + hit-test + dom-overlay).
 *
 *  1. Placement: a reticle follows the detected floor/table; tap places the model
 *     at real size (1:1), turned to face the user.
 *  2. Interaction (DOM overlay gestures):
 *       1 finger drag      → rotate about the vertical axis
 *       2 finger pinch     → scale (clamped 5 % – 300 %)
 *       2 finger drag      → move on the floor plane
 *       tap on a part      → select it (BOM data shown in the overlay)
 *       ⊕ button           → re-place with the reticle
 *  3. The same Sequencer drives the exploded view / assembly steps inside AR.
 */
export class WebXRSession {
  constructor({ viewer, overlay, picker, onSelect, onStart, onEnd, onScale }) {
    Object.assign(this, { viewer, overlay, picker, onSelect, onStart, onEnd, onScale });
    this.session = null;
    this.hitSource = null;
    this.placing = true;
    this.scale = 1;
    this.reticle = this.#makeReticle();
    this.gesture = null;
    this.lastGestureWasDrag = false;
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this.#bindGestures();
  }

  #makeReticle() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.09, 0.11, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
    );
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.018, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff7a1a, depthTest: false }),
    );
    const tick = new THREE.Mesh(
      new THREE.PlaneGeometry(0.02, 0.06).rotateX(-Math.PI / 2).translate(0, 0, -0.14),
      new THREE.MeshBasicMaterial({ color: 0xff7a1a, depthTest: false }),
    );
    g.add(ring, dot, tick);
    g.matrixAutoUpdate = false;
    g.visible = false;
    g.renderOrder = 10;
    return g;
  }

  async start() {
    const { renderer } = this.viewer;
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'light-estimation'],
      domOverlay: { root: this.overlay },
    });
    this.session = session;
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitSource = await session.requestHitTestSource({ space: viewerSpace });

    this.saved = {
      pos: this.viewer.stage.position.clone(),
      quat: this.viewer.stage.quaternion.clone(),
      scale: this.viewer.stage.scale.clone(),
    };
    this.viewer.stage.visible = false;
    this.viewer.scene.add(this.reticle);
    this.placing = true;
    this.hasDomOverlay = !!session.domOverlayState;
    this.overlay.hidden = false;
    this.overlay.classList.add('is-placing');

    this._onFrame = (dt, frame) => this.#onFrame(frame);
    this.viewer.onUpdate.push(this._onFrame);
    this._onSelect = (e) => this.#onSelect(e);
    session.addEventListener('select', this._onSelect);
    session.addEventListener('end', () => this.#cleanup(), { once: true });
    this.onStart && this.onStart(this);
  }

  end() { if (this.session) this.session.end(); }

  #cleanup() {
    const v = this.viewer;
    v.onUpdate = v.onUpdate.filter((f) => f !== this._onFrame);
    if (this.hitSource) { this.hitSource.cancel?.(); this.hitSource = null; }
    v.scene.remove(this.reticle);
    v.stage.position.copy(this.saved.pos);
    v.stage.quaternion.copy(this.saved.quat);
    v.stage.scale.copy(this.saved.scale);
    v.stage.visible = true;
    this.overlay.hidden = true;
    this.session = null;
    requestAnimationFrame(() => v.resize());
    this.onEnd && this.onEnd();
  }

  reposition() {
    this.placing = true;
    this.viewer.stage.visible = false;
    this.overlay.classList.add('is-placing');
  }

  setScale(s) {
    this.scale = THREE.MathUtils.clamp(s, 0.05, 3);
    this.viewer.stage.scale.setScalar(this.scale);
    this.onScale && this.onScale(this.scale);
  }

  #onFrame(frame) {
    if (!frame || !this.session) return;
    const refSpace = this.viewer.renderer.xr.getReferenceSpace();
    if (this.placing && this.hitSource) {
      const hits = frame.getHitTestResults(this.hitSource);
      if (hits.length) {
        const pose = hits[0].getPose(refSpace);
        this.reticle.matrix.fromArray(pose.transform.matrix);
        // keep the reticle flat and turned toward the user
        const p = this._v.setFromMatrixPosition(this.reticle.matrix);
        const cam = this.viewer.renderer.xr.getCamera();
        const yaw = Math.atan2(cam.position.x - p.x, cam.position.z - p.z);
        this.reticle.matrix.compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
        this.reticle.visible = true;
        this.reticleYaw = yaw;
      } else {
        this.reticle.visible = false;
      }
      this.overlay.dispatchEvent(new CustomEvent('ar-tracking', { detail: { found: this.reticle.visible } }));
    }
  }

  #place() {
    if (!this.reticle.visible) return;
    const stage = this.viewer.stage;
    stage.position.setFromMatrixPosition(this.reticle.matrix);
    stage.rotation.set(0, this.reticleYaw || 0, 0);
    stage.scale.setScalar(this.scale);
    stage.visible = true;
    this.placing = false;
    this.reticle.visible = false;
    this.overlay.classList.remove('is-placing');
    this.overlay.dispatchEvent(new CustomEvent('ar-placed'));
  }

  #onSelect(e) {
    if (this.placing) { this.#place(); return; }
    if (this.lastGestureWasDrag) return;
    // pick along the input ray (screen tap → transient input source)
    const refSpace = this.viewer.renderer.xr.getReferenceSpace();
    const pose = e.frame.getPose(e.inputSource.targetRaySpace, refSpace);
    if (!pose) return;
    this._m.fromArray(pose.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(this._m);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(this._m);
    const part = this.picker.pickRay(origin, dir);
    this.onSelect && this.onSelect(part);
  }

  // ---- DOM overlay gestures ------------------------------------------------
  #bindGestures() {
    const el = this.overlay;
    const isUI = (t) => t.closest && t.closest('button, .ar-info, select, input');
    // prevent UI taps from generating XR 'select' events
    el.addEventListener('beforexrselect', (e) => { if (isUI(e.target)) e.preventDefault(); });

    const pts = (ev) => [...ev.touches].map((t) => ({ x: t.clientX, y: t.clientY }));
    el.addEventListener('touchstart', (ev) => {
      if (isUI(ev.target)) return;
      const p = pts(ev);
      this.gesture = { start: p, last: p, moved: 0, n: p.length };
      this.lastGestureWasDrag = false;
    }, { passive: true });

    el.addEventListener('touchmove', (ev) => {
      if (!this.gesture || this.placing || !this.session) return;
      const p = pts(ev);
      const g = this.gesture;
      const stage = this.viewer.stage;
      if (p.length === 1 && g.last.length === 1) {
        const dx = p[0].x - g.last[0].x;
        stage.rotation.y += dx * 0.012;
        g.moved += Math.abs(dx) + Math.abs(p[0].y - g.last[0].y);
      } else if (p.length >= 2 && g.last.length >= 2) {
        const d0 = Math.hypot(g.last[0].x - g.last[1].x, g.last[0].y - g.last[1].y);
        const d1 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        if (d0 > 10) this.setScale(this.scale * (d1 / d0));
        const mx0 = (g.last[0].x + g.last[1].x) / 2, my0 = (g.last[0].y + g.last[1].y) / 2;
        const mx1 = (p[0].x + p[1].x) / 2, my1 = (p[0].y + p[1].y) / 2;
        this.#translate(mx1 - mx0, my1 - my0);
        g.moved += Math.abs(d1 - d0) + Math.abs(mx1 - mx0) + Math.abs(my1 - my0);
        g.n = 2;
      }
      g.last = p;
      if (g.moved > 12 || g.n > 1) this.lastGestureWasDrag = true;
    }, { passive: true });

    el.addEventListener('touchend', (ev) => {
      if (ev.touches.length === 0) {
        // keep the flag until the XR 'select' for this touch has been dispatched
        setTimeout(() => { this.gesture = null; }, 0);
      }
    }, { passive: true });
  }

  /** Move the stage on the floor plane following a 2-finger screen drag. */
  #translate(dx, dy) {
    const cam = this.viewer.renderer.xr.getCamera();
    const stage = this.viewer.stage;
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const dist = camPos.distanceTo(stage.position);
    const k = (dist * 1.6) / Math.max(320, window.innerHeight);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion); right.y = 0; right.normalize();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); fwd.y = 0; fwd.normalize();
    stage.position.addScaledVector(right, dx * k).addScaledVector(fwd, -dy * k);
  }
}
