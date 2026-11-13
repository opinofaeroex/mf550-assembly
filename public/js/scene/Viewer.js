import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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
 */
export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    this.onUpdate = [];       // callbacks (dt, frame) before each render
    this.#camTween = null;
    this.#lift = 0;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop((t, frame) => this.#tick(frame));
  }

  #camTween;
  #lift;
  #box = new THREE.Box3();

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
    this.frame(undefined, false);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    if (this.renderer.xr.isPresenting) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Bounding box of an object (or the model) in world space. */
  boxOf(obj = this.model) {
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
      const dy = ((this.liftTarget ?? this.#lift) - this.#lift) * this.stage.scale.y;
      box = box.clone().translate(new THREE.Vector3(0, dy, 0));
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitH = sphere.radius / Math.sin(fov / 2);
    const fitW = sphere.radius / Math.sin(Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = Math.max(fitH, fitW) * padding;
    let dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-8) dir.set(1, 0.6, 1.3);
    dir.normalize();
    const target = sphere.center.clone();
    const pos = target.clone().addScaledVector(dir, dist);
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

  /** Keep the (possibly exploded) model standing on the floor. */
  #updateLift(dt) {
    if (!this.model) return;
    this.modelRoot.position.y = 0;
    this.modelRoot.updateMatrixWorld(true);
    const box = this.#box.setFromObject(this.model);
    const stageY = this.stage.position.y;
    const scale = this.stage.scale.y || 1;
    const minY = (box.min.y - stageY) / scale;   // in stage space
    this.liftTarget = Math.max(0, -minY);
    const k = 1 - Math.exp(-dt * 6);
    this.#lift += (this.liftTarget - this.#lift) * k;
    this.modelRoot.position.y = this.#lift;
  }

  #tick(frame) {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    for (const fn of this.onUpdate) fn(dt, frame);
    this.#updateLift(dt);
    if (this.#camTween && !this.renderer.xr.isPresenting) {
      const tw = this.#camTween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      this.camera.position.lerpVectors(tw.fromP, tw.toP, e);
      if (tw.t >= 1) this.#camTween = null;
    }
    if (!this.renderer.xr.isPresenting) this.controls.update();
    this.renderer.render(this.scene, this.camera);
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
