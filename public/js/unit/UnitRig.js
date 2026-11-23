import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { KIT_VIEW, RIVET_GUN_STYLE, SPIN_ARROW } from './standards.js';

/**
 * UnitRig — applies the unit-installation tracks (v2.0) to the scene.
 *
 * Everything works in the MODEL frame (the GLB root: metres, Y up, front = +X), exactly as
 * pipeline/unit/build_unit.py wrote the tracks:
 *   parts  keys [t, Tx,Ty,Tz, qx,qy,qz,qw, angle, ease]: delta D = Tr(T)·R(q)·Tr(P)·Rot(axis,angle)·Tr(−P)
 *          applied to the part's CAD pose (D = identity is the installed CAD position)
 *   tools  keys [t, px,py,pz, qx,qy,qz,qw]: pose of the tool's working frame (origin = working point,
 *          +Y into the tool); `sub` channels drive the tool's moving components
 *   fx     silicone bead, marker line, rivet mandrels, decals; v2.1: spinArrow = orange curved
 *          arrow around a fastener axis shown only while it is being tightened (the drill body and
 *          socket stay still — the CAD fastener geometry is never altered to fake a rotation)
 *
 * The rig only moves objects; visibility of not-yet-installed parts is the Appearance state
 * (main.js), so materials, x-ray and selection keep working as in the parts tutorial.
 */
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

/** Interpolate a keyed channel; returns [index, u] of the segment containing t. */
function seg(keys, t) {
  if (t <= keys[0][0]) return [0, 0];
  const n = keys.length;
  if (t >= keys[n - 1][0]) return [n - 2 < 0 ? 0 : n - 2, 1];
  let i = 0;
  while (i < n - 2 && t > keys[i + 1][0]) i++;
  const span = keys[i + 1][0] - keys[i][0];
  return [i, span > 0 ? (t - keys[i][0]) / span : 1];
}

/**
 * v2.1 rivet-gun materials (the supplied STEP has no colours): orange housing accents, satin steel
 * functional parts, dark contrasting grip / guard / battery. Original geometry untouched; the grip
 * is told apart from the housing by a per-vertex colour (tool frame x < −60 mm), so no texture
 * is needed (the model has no UVs) — nothing extra to download. Matte to satin, never glossy.
 */
function styleRivetGun(nodes) {
  const pbr = (color, metalness, roughness, extra = {}) => new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
  const { orange: ORANGE, rubber: RUBBER, gripBelowX, housing, parts } = RIVET_GUN_STYLE;   // standards.js
  const M = { s1: null };                                  // housing + grip: vertex colours below
  for (const [k, [c, me, ro]] of Object.entries(parts)) M[k] = pbr(c, me, ro);
  for (const [name, node] of Object.entries(nodes)) {
    const k = (name.match(/__(s\d+)$/) || [])[1];
    if (!k || !(k in M)) continue;
    node.traverse((o) => {
      if (!o.isMesh) return;
      if (M[k]) { o.material = M[k]; return; }
      const pos = o.geometry.attributes.position, n = pos.count;
      const col = new Float32Array(n * 3), a = new THREE.Color(ORANGE), b = new THREE.Color(RUBBER);
      // positions are quantised (gltfpack): take them to the tool frame with the mesh's own transform
      let root = o; while (root.parent) root = root.parent;
      root.updateMatrixWorld(true);
      const Mw = o.matrixWorld, v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(Mw);
        const c = v.x < gripBelowX ? b : a;                // metres, tool frame: grip behind the head housing
        col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
      }
      o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
      o.material = pbr(housing[0], housing[1], housing[2], { vertexColors: true });
    });
  }
}

/** Orange curved arrow (270° arc + head) about +Z of its group, radius r (m). sense: -1 = clockwise seen from +Z. */
function makeSpinArrow(r, sense) {
  const A = SPIN_ARROW;                                    // standards.js
  const mat = new THREE.MeshBasicMaterial({ color: A.colour, transparent: true, opacity: 0, depthWrite: false });
  const tube = Math.max(A.minTube, r * A.tubeShare);
  const arc = A.arc;
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, tube, A.radialSegments, A.tubularSegments, arc), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(tube * A.headRadius, tube * A.headLength, A.headSegments), mat);
  // the head points along the direction of motion: at angle 0 towards −θ (clockwise) or at the arc end towards +θ
  const th = sense < 0 ? 0 : arc;
  head.position.set(r * Math.cos(th), r * Math.sin(th), 0);
  const tang = new THREE.Vector3(-Math.sin(th), Math.cos(th), 0).multiplyScalar(sense < 0 ? -1 : 1);
  head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tang);
  head.position.addScaledVector(tang, tube * A.headOffset);
  for (const m of [ring, head]) { m.raycast = () => {}; m.renderOrder = A.renderOrder; g.add(m); }
  g.userData.mat = mat;
  return g;
}

export class UnitRig {
  constructor({ viewer, model, loaded, base = 'assets/unit/' }) {
    this.viewer = viewer; this.model = model; this.loaded = loaded; this.base = base;
    this.root = loaded.root;                       // model frame
    this.fxRoot = new THREE.Group(); this.fxRoot.name = 'unit-fx';
    this.root.add(this.fxRoot);
    this.tools = {};                               // id -> { group, nodes:{name:Object3D}, base:{name:Matrix4}, info }
    this.parts = new Map();                        // nid -> { obj, L0, A, Ainv }
    this.moved = new Set();
    this.fx = new Map();                           // step index -> [fx objects]
    this.decalAlpha = 1;
    this.ready = this.#loadTools();
    this.#indexParts();
  }

  #indexParts() {
    this.root.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    for (const id of this.model.partIds) {
      const o = this.loaded.objects.get(id);
      const A = new THREE.Matrix4().multiplyMatrices(rootInv, o.parent.matrixWorld);   // parent in model frame
      o.updateMatrix();
      this.parts.set(id, { obj: o, L0: o.matrix.clone(), A, Ainv: A.clone().invert() });
    }
  }

  async #loadTools() {
    const res = await fetch(this.base + 'tools/tools.json');
    if (!res.ok) throw new Error('tools.json missing');
    this.toolInfo = (await res.json()).tools;
    const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
    await Promise.all(Object.entries(this.toolInfo).map(async ([id, info]) => {
      const gltf = await loader.loadAsync(this.base + 'tools/' + info.file);
      const group = new THREE.Group(); group.name = `tool-${id}`; group.visible = false;
      group.add(gltf.scene);
      const nodes = {}, base = {};
      gltf.scene.traverse((o) => {
        if (o.isMesh) {
          o.raycast = () => {};                    // tools are never picked
          o.castShadow = false;
        }
        if (o.name) { nodes[o.name] = o; o.updateMatrix(); base[o.name] = o.matrix.clone(); o.matrixAutoUpdate = false; }
      });
      if (id === 'rivetgun') styleRivetGun(nodes);      // before the group joins the scene: tool frame = world
      this.fxRoot.add(group);
      this.tools[id] = { group, nodes, base, info };
    }));
    // placeholder driver bit for the drill (no bit model was supplied): 1/4 in hex, labelled orange
    const d = this.tools.drill;
    if (d) {
      const g = new THREE.CylinderGeometry(0.00367, 0.00367, 0.11, 6); g.translate(0, 0.055, 0);
      const tip = new THREE.ConeGeometry(0.0034, 0.008, 6); tip.rotateX(Math.PI); tip.translate(0, -0.004 + 0.008, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0xff8a00, metalness: 0.4, roughness: 0.4 });
      const bit = new THREE.Group(); bit.add(new THREE.Mesh(g, mat), new THREE.Mesh(tip, mat));
      bit.traverse((o) => { if (o.isMesh) o.raycast = () => {}; });
      bit.name = 'placeholder-bit'; bit.visible = false;
      d.group.add(bit); d.bit = bit;
    }
  }

  // ------------------------------------------------------------ parts
  #resetMoved() {
    for (const id of this.moved) this.#setLocal(this.parts.get(id), null);
    this.moved.clear();
  }

  #setLocal(p, D) {
    const o = p.obj;
    if (D) _m.multiplyMatrices(p.Ainv, D).multiply(p.A).multiply(p.L0);
    else _m.copy(p.L0);
    _m.decompose(o.position, o.quaternion, o.scale);
    o.matrix.copy(_m);
    o.matrixWorldNeedsUpdate = true;
  }

  #delta(track, t, out) {
    const k = track.keys;
    const [i, u0] = seg(k, t);
    const a = k[i], b = k[Math.min(i + 1, k.length - 1)];
    const u = b[9] ? ease(u0) : u0;
    _v.set(a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u);
    _q.set(a[4], a[5], a[6], a[7]); _q2.set(b[4], b[5], b[6], b[7]); _q.slerp(_q2, u);
    const ang = a[8] + (b[8] - a[8]) * u;
    out.compose(_v, _q, _s);
    if (ang) {
      const P = track._pivot || (track._pivot = new THREE.Vector3().fromArray(track.pivot));
      const ax = track._axis || (track._axis = new THREE.Vector3().fromArray(track.axis).normalize());
      _m2.makeTranslation(P.x, P.y, P.z);
      out.multiply(_m2);
      out.multiply(_m2.makeRotationAxis(ax, ang));
      out.multiply(_m2.makeTranslation(-P.x, -P.y, -P.z));
    }
    return out;
  }

  // ------------------------------------------------------------ tools
  #toolPose(id, tr, t) {
    const tool = this.tools[id]; if (!tool) return;
    const k = tr.keys;
    const vis = t >= k[0][0] - 1e-6 && t <= k[k.length - 1][0] + 1e-6;
    tool.group.visible = vis;
    if (!vis) return;
    const [i, u0] = seg(k, t);
    const a = k[i], b = k[Math.min(i + 1, k.length - 1)];
    const u = ease(u0);
    tool.group.position.set(a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u);
    _q.set(a[4], a[5], a[6], a[7]); _q2.set(b[4], b[5], b[6], b[7]);
    tool.group.quaternion.copy(_q.slerp(_q2, u));
    const mp = tool.info.movingParts || {};
    const sub = tr.sub || {};
    // socket size / placeholder bit (drill)
    if (id === 'drill') {
      const bit = tr.bit === 'placeholder-hex';
      if (tool.bit) tool.bit.visible = bit;
      for (const n of ['Deep_Socket_9-16in_1-4in_Drive_6pt', 'Adapter_1-4in_Hex_to_1-4in_Square']) if (tool.nodes[n]) tool.nodes[n].visible = !bit;
    }
    for (const [part, def] of Object.entries(mp)) {
      const ch = sub[part];
      let val = 0;
      if (ch) {
        const [j, w0] = seg(ch, t);
        const c0 = ch[j], c1 = ch[Math.min(j + 1, ch.length - 1)];
        const w = c1[2] ? ease(w0) : w0;
        val = c0[1] + (c1[1] - c0[1]) * w;
      }
      const ax = _v.fromArray(def.axis).normalize();
      _m.identity();
      if (def.kind === 'spin' || def.kind === 'screw') {
        const P = _v2.fromArray(def.pivot || [0, 0, 0]);
        _m.makeTranslation(P.x, P.y, P.z).multiply(_m2.makeRotationAxis(ax, val)).multiply(_m2.makeTranslation(-P.x, -P.y, -P.z));
        if (def.kind === 'screw' && def.pitchMm) _m.premultiply(_m2.makeTranslation(...ax.clone().multiplyScalar(-val / (2 * Math.PI) * def.pitchMm * 0.001).toArray()));
      } else if (def.kind === 'slide') {
        const d = def.strokeMm ? val * def.strokeMm * 0.001 : val;
        _m.makeTranslation(ax.x * d, ax.y * d, ax.z * d);
      }
      if (part === 'socket' && tr.socketScale && Math.abs(tr.socketScale - 1) > 1e-3) _m.multiply(_m2.makeScale(tr.socketScale, 1, tr.socketScale));
      for (const n of def.nodes) {
        const node = tool.nodes[n]; if (!node) continue;
        node.matrix.multiplyMatrices(_m, tool.base[n]);
        node.matrixWorldNeedsUpdate = true;
      }
    }
  }

  // ------------------------------------------------------------ effects
  #buildFx(index) {
    if (this.fx.has(index)) return this.fx.get(index);
    const step = this.model.steps[index];
    const out = [];
    for (const f of step.tracks.fx) {
      if (f.type === 'bead' || f.type === 'line') {
        const pts = f.points.map((p) => new THREE.Vector3().fromArray(p));
        const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
        const segs = Math.max(8, pts.length * (f.type === 'bead' ? 3 : 6));
        const radial = f.type === 'bead' ? 10 : 6;
        const r = (f.type === 'bead' ? f.diameter : f.width) / 2;
        const geo = new THREE.TubeGeometry(curve, segs, r, radial, false);
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(f.colour), roughness: f.type === 'bead' ? 0.35 : 0.6, metalness: 0 });
        const mesh = new THREE.Mesh(geo, mat); mesh.raycast = () => {};
        mesh.userData = { fx: f, segs, radial };
        out.push(mesh);
      } else if (f.type === 'mandrels') {
        for (const it of f.items) {
          const g = new THREE.CylinderGeometry(0.00095, 0.00095, 0.024, 8); g.translate(0, 0.012, 0);
          const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.8, roughness: 0.3 }));
          m.raycast = () => {};
          m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().fromArray(it.axis).normalize());
          m.userData = { fx: { type: 'mandrel', ...it } };
          out.push(m);
        }
      } else if (f.type === 'spinArrow') {
        const g = makeSpinArrow(f.radius, f.sense ?? -1);
        const ax = new THREE.Vector3().fromArray(f.axis).normalize();
        g.position.fromArray(f.centre);
        g.userData.baseQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), ax);
        g.quaternion.copy(g.userData.baseQ);
        g.userData.fx = f; g.userData.axis = ax;
        out.push(g);
      } else if (f.type === 'decal') {
        const tex = new THREE.TextureLoader().load(this.base + 'decals/' + f.file, () => this.viewer.requestRender());
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
        const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.55, metalness: 0,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(f.width, f.height), mat);
        m.raycast = () => {};
        const n = new THREE.Vector3().fromArray(f.normal).normalize(), up = new THREE.Vector3().fromArray(f.up).normalize();
        const right = new THREE.Vector3().crossVectors(up, n);
        m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
        m.userData = { fx: f, normal: n, centre: new THREE.Vector3().fromArray(f.centre) };
        out.push(m);
      }
    }
    for (const o of out) { o.visible = false; this.fxRoot.add(o); }
    this.fx.set(index, out);
    return out;
  }

  /** Effects of one step at time t (t = Infinity: completed state, for earlier steps / the overview). */
  #applyFx(index, t) {
    for (const o of this.#buildFx(index)) {
      const f = o.userData.fx;
      if (f.type === 'bead' || f.type === 'line') {
        const [t0, t1] = f.type === 'bead' ? f.grow : f.draw;
        const u = Math.max(0, Math.min(1, (t - t0) / Math.max(1e-6, t1 - t0)));
        o.visible = u > 0;
        o.geometry.setDrawRange(0, Math.ceil(u * o.userData.segs) * o.userData.radial * 6);
      } else if (f.type === 'mandrel') {
        const vis = t >= f.show && t < f.pull[1] && t !== Infinity;
        o.visible = vis;
        if (vis) {
          const pull = Math.max(0, Math.min(1, (t - f.pull[0]) / (f.pull[1] - f.pull[0])));
          o.position.fromArray(f.head).addScaledVector(new THREE.Vector3().fromArray(f.axis), 0.0025 * pull);
        }
      } else if (f.type === 'spinArrow') {
        const [t0, t1] = f.t;
        const vis = t !== Infinity && t >= t0 && t <= t1;          // only while the fastener is tightened
        o.visible = vis;
        if (vis) {
          const fade = Math.min(1, (t - t0) / SPIN_ARROW.fade, (t1 - t) / SPIN_ARROW.fade);
          o.userData.mat.opacity = SPIN_ARROW.opacity * Math.max(0, fade);
          // the arrow turns slowly in the tightening sense (motion cue; the drill itself stays still)
          const turn = (f.sense ?? -1) * (t - t0) * Math.PI * SPIN_ARROW.turnRatePi;
          o.quaternion.copy(o.userData.baseQ).multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), turn));
        }
      } else if (f.type === 'decal') {
        const k = f.keys;
        let off = 0, press = 1;
        if (t !== Infinity) {
          const [i, u0] = seg(k, t); const a = k[i], b = k[Math.min(i + 1, k.length - 1)]; const u = ease(u0);
          off = a[1] + (b[1] - a[1]) * u; press = a[2] + (b[2] - a[2]) * u;
        }
        o.visible = true;
        o.position.copy(o.userData.centre).addScaledVector(o.userData.normal, off);
        o.userData.alpha = 0.8 + 0.2 * press;
        o.material.opacity = o.userData.alpha * this.decalAlpha;
      }
    }
  }

  /** v2.1: decals fade with the ghosted main body in x-ray steps (they would hide the parts inside). */
  setDecalAlpha(a) {
    if (a === this.decalAlpha) return;
    this.decalAlpha = a;
    for (const list of this.fx.values()) for (const o of list) {
      if (o.userData.fx && o.userData.fx.type === 'decal') o.material.opacity = (o.userData.alpha ?? 1) * a;
    }
    this.viewer.requestRender();
  }

  #hideFx(index) { for (const o of this.fx.get(index) || []) o.visible = false; }

  // ------------------------------------------------------------ public
  /** Set the static context of a navigation position (completed earlier work, hidden tools). */
  setPosition(pos) {
    this.pos = pos;
    this.#resetMoved();
    for (const t of Object.values(this.tools)) t.group.visible = false;
    const N = this.model.stepCount;
    for (let k = 0; k < N; k++) {
      const done = pos === -2 || (pos >= 0 && k < pos);
      if (done) this.#applyFx(k, Infinity); else this.#hideFx(k);
    }
    if (pos === -1) this.#applyKit();
    this.viewer.requestRender();
  }

  /**
   * Parts kit: every component at its starting point (first key of its installation track),
   * v2.1: offsets doubled for a clearer exploded view (KIT_SCALE), capped at KIT_MAX metres so
   * long approach paths (e.g. the impeller raised from below) do not dwarf the unit.
   */
  #applyKit() {
    const D = new THREE.Matrix4();
    for (const s of this.model.steps) {
      for (const tr of s.tracks.parts) {
        const n = this.model.node(tr.node);
        if (!n || this.model.steps.indexOf(s) !== n.step) continue;
        const p = this.parts.get(tr.node);
        this.#delta(tr, 0, D);
        const e = D.elements, len = Math.hypot(e[12], e[13], e[14]);
        const k = len > 1e-6 ? Math.max(1, Math.min(UnitRig.KIT_SCALE, UnitRig.KIT_MAX / len)) : 1;
        e[12] *= k; e[13] *= k; e[14] *= k;
        this.#setLocal(p, D); this.moved.add(tr.node);
      }
    }
  }

  /** Pose of everything animated in step `index` at time t (seconds from the start of the step). */
  apply(index, t) {
    const s = this.model.steps[index];
    if (!s) return;
    const D = new THREE.Matrix4();
    for (const tr of s.tracks.parts) {
      const p = this.parts.get(tr.node); if (!p) continue;
      this.#setLocal(p, this.#delta(tr, t, D)); this.moved.add(tr.node);
    }
    for (const tr of s.tracks.tools) this.#toolPose(tr.tool, tr, t);
    this.#applyFx(index, t);
    this.viewer.requestRender();
  }

  /** Model-frame points the camera should keep in view for a step (tool working points included). */
  focusPoints(index) {
    const s = this.model.steps[index]; const pts = [];
    if (!s) return pts;
    for (const tr of s.tracks.tools) for (const k of tr.keys) pts.push(new THREE.Vector3(k[1], k[2], k[3]));
    return pts;
  }
}
UnitRig.KIT_SCALE = KIT_VIEW.scale;       // v2.1: exploded (components) view displacement ×2 (standards.js)
UnitRig.KIT_MAX = KIT_VIEW.maxOffset;     // m
