import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PROFILES } from '../perf/Profiles.js';

/**
 * Viewer — renderer, camera, orbit controls, lighting and the render loop.
 *
 * Scene graph:
 *   scene
 *    ├─ lights
 *    ├─ stage (Group)          ← placed by WebXR in AR mode, identity in 3D mode
 *    │   ├─ contactShadow
 *    │   └─ modelRoot (Group)  ← keeps the product standing on y = 0
 *    │        └─ gltf scene    ← CAD coordinates, metres
 *
 * Performance (v1.5, see perf/Profiles.js — every item can be switched off for comparison):
 *  - demand rendering: a frame is drawn only when the camera, the parts, a highlight, the
 *    viewport or the floor lift changed (animations request every frame while they run);
 *    the loop itself keeps running, so nothing waits for a "wake-up";
 *  - frame-rate cap (maxFps): on a 60 Hz display a 30 fps cap gives an even cadence and
 *    leaves CPU/GPU time to the browser, the BOM panel and camera tracking;
 *  - resolution: devicePixelRatio is capped and can be scaled (renderScale);
 *  - static matrices: transforms are recomputed only for objects that actually moved;
 *  - analytic floor lift: computed from precomputed bounds instead of two bounding-box
 *    passes over the whole model per frame (liftProvider, see Explode.js).
 */
export class Viewer {
  constructor(container, perf = PROFILES.high) {
    this.container = container;
    this.perf = perf;
    this.renderer = new THREE.WebGLRenderer({ antialias: !!perf.antialias, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.xr.enabled = true;
    container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a96a3, 0.6);
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(1.5, 3, 2);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.35);
    fill.position.set(-2, 1, -1.5);
    this.scene.add(hemi, key, fill);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
    this.camera.position.set(1.6, 1.2, 2.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.05;
    this.controls.maxDistance = 20;

    this.stage = new THREE.Group();
    this.stage.name = 'stage';
    this.modelRoot = new THREE.Group();
    this.modelRoot.name = 'modelRoot';
    this.stage.add(this.modelRoot);
    this.scene.add(this.stage);

    this.contactShadow = this.#makeContactShadow();
    this.stage.add(this.contactShadow);

    this.timer = new THREE.Timer();
    this.onUpdate = [];       // callbacks (dt, frame) before each frame
    this.onCamera = [];       // camera drivers (dt), after the floor lift, before the orbit controls
    this.onRender = [];       // callbacks right before a frame is drawn (callouts: they follow the view)
    this.liftProvider = null; // () => lowest point of the model (model space), see Explode.js
    this.#camTween = null;
    this.#lift = 0;
    this.#needs = 2;

    /** Live counters for the performance dashboard / benchmark (cheap, no allocation per frame). */
    this.stats = {
      ticks: 0, renders: 0, lastRenderMs: 0, calls: 0, triangles: 0,
      frameTimes: new Float32Array(240), frameIdx: 0, renderStamps: new Float32Array(240), renderIdx: 0,
    };

    if (perf.staticMatrices) {
      for (const o of [this.scene, this.stage, this.modelRoot, hemi, key, fill, this.contactShadow]) smartMatrix(o);
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop((t, frame) => this.#tick(t, frame));
  }

  #camTween;
  #lift;
  #needs;
  #lastTick = -1e9;
  #wasXR = false;
  #lastCam = new THREE.Matrix4();
  #lastProj = new THREE.Matrix4();
  #box = new THREE.Box3();

  pixelRatio() {
    const p = this.perf;
    return Math.min(window.devicePixelRatio || 1, p.pixelRatioMax || 2) * (p.renderScale || 1);
  }

  /** Draw the next frame(s) even if the camera did not move (parts, highlights, edges...). */
  requestRender(frames = 1) { this.#needs = Math.max(this.#needs, frames); }

  #makeContactShadow() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    grd.addColorStop(0, 'rgba(0,0,0,0.42)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.18)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.0005;
    m.renderOrder = -1;
    m.name = 'contactShadow';
    return m;
  }

  /** Add the loaded glTF scene; centre it on X/Z and stand it on y = 0. */
  setModel(object3d) {
    this.model = object3d;
    this.modelRoot.add(object3d);
    object3d.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object3d);
    const c = box.getCenter(new THREE.Vector3());
    object3d.position.set(-c.x, -box.min.y, -c.z);
    this.modelSize = box.getSize(new THREE.Vector3());
    const s = Math.max(this.modelSize.x, this.modelSize.z) * 1.6;
    this.contactShadow.scale.set(s, s, 1);
    this.controls.target.set(0, this.modelSize.y * 0.5, 0);
    if (this.perf.staticMatrices) {
      // nodes that can move (components, sub-assemblies, the glTF root) check their TRS;
      // pure geometry holders never move relative to their parent
      object3d.traverse((o) => {
        if (o.isMesh || o.isLine || o.isPoints) { o.updateMatrix(); o.matrixAutoUpdate = false; }
        else smartMatrix(o);
      });
    }
    this.modelRoot.updateMatrixWorld(true);
    this.frame(undefined, false);
    this.requestRender(2);
  }

  /** Mark helper objects added under the model later (edges, x-ray overlays) as static. */
  freeze(o) {
    if (!this.perf.staticMatrices) return;
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  }

  /**
   * Screen areas covered by overlay UI (px from the left / top of the viewport).
   * The projection is shifted with a view offset so the model is centred, and
   * framed, in the part of the viewport that is not covered by the step card.
   */
  setInsets({ left = 0, top = 0 } = {}) {
    left = Math.round(left); top = Math.round(top);
    if (this.insets && this.insets.left === left && this.insets.top === top) return;
    this.insets = { left, top };
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.width = w;
    this.height = h;
    if (this.renderer.xr.isPresenting) return;
    const pr = this.pixelRatio();
    if (this.renderer.getPixelRatio() !== pr) this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    const { left, top } = this.insets || { left: 0, top: 0 };
    if (left > 0 || top > 0) {
      this.camera.aspect = (w + left) / (h + top);
      this.camera.setViewOffset(w + left, h + top, 0, 0, w, h);
    } else {
      this.camera.clearViewOffset();
      this.camera.aspect = w / h;
    }
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** Bounding box of an object (or the model) in world space. */
  boxOf(obj = this.model) {
    this.scene.updateMatrixWorld();      // static meshes rely on the scene-wide pass (see smartMatrix)
    return this.#box.setFromObject(obj).clone();
  }

  /**
   * Fit the camera to a box (world space). Keeps the current viewing direction.
   * @param {THREE.Box3} [box]
   * @param {boolean} [animate]
   */
  frame(box, animate = true, padding = 1.15) {
    if (!this.model) return;
    box = box ?? this.boxOf(this.model);
    if (box.isEmpty()) return;
    // the model is lifted smoothly to stay on the floor: aim at where it will settle
    if (!this.renderer.xr.isPresenting) {
      this.modelRoot.updateMatrixWorld(true);
      const dy = (this.#measureLift() - this.#lift) * this.stage.scale.y;
      box = box.clone().translate(new THREE.Vector3(0, dy, 0));
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = this.fitDistance(sphere.radius, padding);
    let dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-8) dir.set(1, 0.6, 1.3);
    dir.normalize();
    const target = sphere.center.clone();
    const pos = target.clone().addScaledVector(dir, dist);
    this.requestRender();
    if (!animate) {
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
      this.controls.update();
      return;
    }
    this.#camTween = {
      t: 0, dur: 0.9,
      fromT: this.controls.target.clone(), toT: target,
      fromP: this.camera.position.clone(), toP: pos,
    };
  }

  /**
   * Camera distance that fits a sphere of `radius` into the part of the viewport
   * that is not covered by the step card (see setInsets).
   */
  fitDistance(radius, padding = 1.15) {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const { left, top } = this.insets || { left: 0, top: 0 };
    const fullH = h + top;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const avail = Math.max(80, Math.min(w - left, h - top));
    return (radius / Math.sin(Math.atan(tanV * avail / fullH))) * padding;
  }

  /** Lift needed (stage space) so that the current pose of the model stands on y = 0. */
  #measureLift() {
    if (this.perf.analyticLift && this.liftProvider) return Math.max(0, -this.liftProvider());
    const y = this.modelRoot.position.y;
    this.modelRoot.position.y = 0;
    this.modelRoot.updateMatrixWorld(true);
    const box = this.#box.setFromObject(this.model);
    const stageY = this.stage.position.y;
    const scale = this.stage.scale.y || 1;
    const minY = (box.min.y - stageY) / scale;   // in stage space
    this.modelRoot.position.y = y;
    this.modelRoot.updateMatrixWorld(true);
    return Math.max(0, -minY);
  }

  /** Keep the (possibly exploded) model standing on the floor. */
  #updateLift(dt) {
    if (!this.model) return;
    this.liftTarget = this.#measureLift();
    const k = 1 - Math.exp(-dt * 6);
    const before = this.#lift;
    this.#lift += (this.liftTarget - this.#lift) * k;
    if (Math.abs(this.liftTarget - this.#lift) < 1e-6) this.#lift = this.liftTarget;   // settle exactly: stops redraws
    if (this.#lift !== before || this.modelRoot.position.y !== this.#lift) {
      this.modelRoot.position.y = this.#lift;
      this.requestRender();
    }
  }

  #tick(time, frame) {
    const xr = this.renderer.xr.isPresenting;
    const cap = this.perf.maxFps;
    if (cap && !xr && time - this.#lastTick < 1000 / cap - 4) return;   // frame-rate cap (−4 ms jitter margin)
    this.#lastTick = time;
    const st = this.stats;
    st.ticks++;
    st.frameTimes[st.frameIdx++ % st.frameTimes.length] = time;

    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    for (const fn of this.onUpdate) fn(dt, frame);
    this.#updateLift(dt);
    for (const fn of this.onCamera) fn(dt);
    if (this.#camTween && !xr) {
      const tw = this.#camTween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      this.camera.position.lerpVectors(tw.fromP, tw.toP, e);
      if (tw.t >= 1) this.#camTween = null;
    }
    if (!xr) this.controls.update();

    if (xr !== this.#wasXR) { this.#wasXR = xr; this.#needs = Math.max(this.#needs, 2); }
    let draw = !this.perf.demandRendering || xr || this.#needs > 0;
    if (!draw) {
      this.camera.updateMatrixWorld();
      draw = !this.camera.matrixWorld.equals(this.#lastCam) || !this.camera.projectionMatrix.equals(this.#lastProj);
    }
    if (!draw) return;
    if (this.#needs > 0) this.#needs--;
    if (this.onRender.length) this.scene.updateMatrixWorld();   // callouts measure the current pose
    for (const fn of this.onRender) fn();
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    st.lastRenderMs = performance.now() - t0;
    st.renders++;
    st.renderStamps[st.renderIdx++ % st.renderStamps.length] = time;
    st.calls = this.renderer.info.render.calls;
    st.triangles = this.renderer.info.render.triangles;
    this.#lastCam.copy(this.camera.matrixWorld);
    this.#lastProj.copy(this.camera.projectionMatrix);
  }

  cancelCameraTween() { this.#camTween = null; }

  /** Active camera for picking/projection (XR camera when presenting). */
  activeCamera() {
    if (this.renderer.xr.isPresenting) {
      const xrCam = this.renderer.xr.getCamera();
      return xrCam.cameras && xrCam.cameras.length ? xrCam.cameras[0] : xrCam;
    }
    return this.camera;
  }
}

/**
 * Recompute an object's local matrix only when its position / rotation / scale changed.
 * three.js recomputes every object's matrix on every frame and then, because the matrix
 * was "updated", every world matrix below it as well. With this, unchanged branches of the
 * scene graph cost nothing; any code that moves an object is still picked up automatically.
 *
 * Subtree flag: three.js also updates single world matrices outside the scene-wide pass
 * (localToWorld, getWorldPosition, Box3.setFromObject call updateWorldMatrix(…, false), which
 * does not touch the children). That consumes `matrixWorldNeedsUpdate`; the separate
 * `__subtreeDirty` flag survives it, so the next updateMatrixWorld still refreshes everything
 * below a moved node (children of moved nodes are never left with stale world matrices).
 */
export function smartMatrix(o) {
  if (o.__smart) return;
  o.__smart = true;
  const last = new Float64Array(10).fill(NaN);
  o.updateMatrix = function updateMatrixIfChanged() {
    const p = this.position, q = this.quaternion, s = this.scale;
    if (p.x === last[0] && p.y === last[1] && p.z === last[2] && q.x === last[3] && q.y === last[4]
      && q.z === last[5] && q.w === last[6] && s.x === last[7] && s.y === last[8] && s.z === last[9]) return;
    last[0] = p.x; last[1] = p.y; last[2] = p.z; last[3] = q.x; last[4] = q.y; last[5] = q.z; last[6] = q.w;
    last[7] = s.x; last[8] = s.y; last[9] = s.z;
    THREE.Object3D.prototype.updateMatrix.call(this);
    this.__subtreeDirty = true;
  };
  o.updateMatrixWorld = function updateMatrixWorldSmart(force) {
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.__subtreeDirty) { this.__subtreeDirty = false; this.matrixWorldNeedsUpdate = true; }
    return THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
  };
}
