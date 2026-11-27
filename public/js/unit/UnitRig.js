import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AIRFLOW, CABLE, DIMS, GASKET, KIT_VIEW, RIVET_GUN_STYLE, SPIN_ARROW } from './standards.js';

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
 * v2.2: effects can be attached to a part (`attach`: node id) — stickers, the silicone door gasket,
 *       tightening marks made on the bench — and follow that part's rigid motion (translation + rotation
 *       of its track, not the spin about its own axis) in every step and in the components view;
 *       motor leads ('cable', group 'leads': the latest step's group is shown), dimension call-outs
 *       ('dims'), upward airflow ('airflow'); crimper / ratchet / tap-drill tools; drill socket extension.
 *
 * The rig only moves objects; visibility of not-yet-installed parts is the Appearance state
 * (main.js), so materials, x-ray and selection keep working as in the parts tutorial.
 */
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _Y = new THREE.Vector3(0, 1, 0);

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

/** Text label for the dimension call-outs: canvas texture on a plane (height h metres). */
function makeLabel(text, h) {
  const c = document.createElement('canvas'); const ctx = c.getContext('2d');
  ctx.font = DIMS.font; const w = Math.ceil(ctx.measureText(text).width) + 28;
  c.width = w; c.height = 88;
  ctx.font = DIMS.font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.lineJoin = 'round'; ctx.lineWidth = 12; ctx.strokeStyle = DIMS.halo; ctx.strokeText(text, w / 2, 46);
  ctx.fillStyle = DIMS.textColour; ctx.fillText(text, w / 2, 46);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(h * 1.6 * w / 88, h * 1.6), mat);
  m.raycast = () => {}; m.renderOrder = DIMS.renderOrder;
  return m;
}

/** Thin cylinder between two points (dimension lines). */
function segMesh(a, b, r, mat) {
  const A = new THREE.Vector3().fromArray(a), B = new THREE.Vector3().fromArray(b);
  const L = A.distanceTo(B); const g = new THREE.CylinderGeometry(r, r, L, 6, 1, true);
  const m = new THREE.Mesh(g, mat); m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  m.raycast = () => {}; m.renderOrder = DIMS.renderOrder;
  return m;
}

/** Square-section strip swept along a closed path on a face (door gasket). */
function gasketGeometry(points, normal, section) {
  const P = points.map((p) => new THREE.Vector3().fromArray(p)); const n = new THREE.Vector3().fromArray(normal).normalize();
  const N = P.length, h = section / 2, pos = [], idx = [];
  for (let i = 0; i < N; i++) {
    const t = P[(i + 1) % N].clone().sub(P[(i - 1 + N) % N]).normalize();
    const b = new THREE.Vector3().crossVectors(t, n).normalize();
    for (const [u, v] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
      const q = P[i].clone().addScaledVector(n, u * h).addScaledVector(b, v * h); pos.push(q.x, q.y, q.z);
    }
  }
  for (let i = 0; i < N - 1; i++) for (let k = 0; k < 4; k++) {
    const a = i * 4 + k, b = i * 4 + ((k + 1) % 4), c = (i + 1) * 4 + k, d = (i + 1) * 4 + ((k + 1) % 4);
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  g.computeVertexNormals();
  return { g, segs: N - 1 };
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
    this.follow = new Map();                       // v2.2: nid -> rigid motion (Matrix4) of the part now
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
      this.tools[id] = { group, nodes, base, info, inner: gltf.scene };
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
      // v2.2: socket extension bar (not supplied: generic, labelled in the tools list), length set per track
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 12), new THREE.MeshStandardMaterial({ color: 0xb3b8bf, metalness: 0.85, roughness: 0.35 }));
      bar.raycast = () => {}; bar.visible = false; d.group.add(bar); d.extBar = bar;
    }
  }

  // ------------------------------------------------------------ parts
  #resetMoved() {
    for (const id of this.moved) this.#setLocal(this.parts.get(id), null);
    this.moved.clear();
    this.follow.clear();
  }

  /** v2.2: rigid motion of a part now (identity when it sits at its CAD pose) — attached effects follow it. */
  followOf(nid) { return this.follow.get(nid) || UnitRig.IDENTITY; }

  #setLocal(p, D) {
    const o = p.obj;
    if (D) _m.multiplyMatrices(p.Ainv, D).multiply(p.A).multiply(p.L0);
    else _m.copy(p.L0);
    _m.decompose(o.position, o.quaternion, o.scale);
    o.matrix.copy(_m);
    o.matrixWorldNeedsUpdate = true;
  }

  #delta(track, t, out, rigid = null) {
    const k = track.keys;
    const [i, u0] = seg(k, t);
    const a = k[i], b = k[Math.min(i + 1, k.length - 1)];
    const u = b[9] ? ease(u0) : u0;
    _v.set(a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u);
    _q.set(a[4], a[5], a[6], a[7]); _q2.set(b[4], b[5], b[6], b[7]); _q.slerp(_q2, u);
    const ang = a[8] + (b[8] - a[8]) * u;
    out.compose(_v, _q, _s);
    if (rigid) rigid.copy(out);
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
      const ext = tr.extension || 0;                       // v2.2: drill body set back on a socket extension
      tool.inner.position.y = ext; tool.inner.updateMatrix();
      if (tool.extBar) {
        tool.extBar.visible = ext > 0;
        if (ext > 0) { tool.extBar.scale.set(1, ext + 0.006, 1); tool.extBar.position.set(0, 0.0505 + ext / 2 - 0.003, 0); }
      }
    }
    if (id === 'caulking') {                               // v2.2: cartridge contents coloured as the sealant used
      const n = tool.nodes.Silicone_WEICON_HT300_Red;
      if (n) n.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.userData.mat0) o.userData.mat0 = o.material;
        if (tr.sealant) {
          o.userData.mats = o.userData.mats || {};
          o.material = o.userData.mats[tr.sealant] || (o.userData.mats[tr.sealant] = new THREE.MeshStandardMaterial({ color: new THREE.Color(tr.sealant), roughness: 0.5, metalness: 0 }));
        } else o.material = o.userData.mat0;
      });
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
      if (part === 'socket' && id === 'drill' && tr.extension) _m.premultiply(_m2.makeTranslation(0, -tr.extension, 0));   // socket stays on the fastener
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
        if (f.attach !== undefined) mesh.matrixAutoUpdate = false;
        out.push(mesh);
      } else if (f.type === 'gasket') {
        const { g, segs } = gasketGeometry(f.points, f.normal, f.section);
        const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(f.colour), roughness: GASKET.roughness, metalness: 0 }));
        mesh.raycast = () => {}; mesh.matrixAutoUpdate = false;
        mesh.userData = { fx: f, segs };
        out.push(mesh);
      } else if (f.type === 'cable') {
        out.push(this.#buildCable(f));
      } else if (f.type === 'dims') {
        const g = new THREE.Group(); g.userData = { fx: f };
        const mat = new THREE.MeshBasicMaterial({ color: DIMS.colour, transparent: true, opacity: 1, depthWrite: false });
        for (const [a, b] of f.segments) g.add(segMesh(a, b, f.width / 2, mat));
        for (const [p, v] of f.arrows) {
          const c = new THREE.Mesh(new THREE.ConeGeometry(f.arrow * 0.3, f.arrow, 10), mat);
          const dir = new THREE.Vector3().fromArray(v).normalize();
          c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
          c.position.fromArray(p).addScaledVector(dir, -f.arrow / 2); c.raycast = () => {}; c.renderOrder = DIMS.renderOrder; g.add(c);
        }
        for (const L of f.labels) {
          const m = makeLabel(L.text, f.textH);
          const n = new THREE.Vector3().fromArray(L.normal), up = new THREE.Vector3().fromArray(L.up), right = new THREE.Vector3().fromArray(L.right);
          m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
          m.position.fromArray(L.pos); g.add(m);
        }
        for (const r of f.refs) {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(DIMS.refRadius, f.width * 0.7, 6, 24), mat);
          ring.position.fromArray(r); ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
          const dot = new THREE.Mesh(new THREE.SphereGeometry(f.width * 1.6, 8, 6), mat); dot.position.fromArray(r);
          for (const o of [ring, dot]) { o.raycast = () => {}; o.renderOrder = DIMS.renderOrder; g.add(o); }
        }
        g.userData.mats = [mat, ...g.children.filter((o) => o.material && o.material.map).map((o) => o.material)];
        if (f.attach !== undefined) g.matrixAutoUpdate = false;
        out.push(g);
      } else if (f.type === 'airflow') {
        const g = new THREE.Group(); g.userData = { fx: f, arrows: [] };
        const mat = new THREE.MeshBasicMaterial({ color: AIRFLOW.colour, transparent: true, opacity: 0, depthWrite: false });
        const L = f.length, hs = AIRFLOW.headShare;
        const shaft = new THREE.CylinderGeometry(AIRFLOW.shaftRadius, AIRFLOW.shaftRadius, L * (1 - hs), 8); shaft.translate(0, L * (1 - hs) / 2, 0);
        const head = new THREE.ConeGeometry(AIRFLOW.headRadius, L * hs, 12); head.translate(0, L * (1 - hs) + L * hs / 2, 0);
        // one stream per path: polyline with cumulative arc length; the arrows travel along it, tangent-aligned
        f.paths.forEach((P, c) => {
          const pts = P.map((p) => new THREE.Vector3().fromArray(p)), cum = [0];
          for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
          const H = cum[cum.length - 1], path = { pts, cum, H };
          const per = Math.ceil(H / f.spacing);
          for (let j = 0; j < per; j++) {
            const a = new THREE.Group(); a.add(new THREE.Mesh(shaft, mat), new THREE.Mesh(head, mat));
            a.traverse((o) => { if (o.isMesh) { o.raycast = () => {}; o.renderOrder = AIRFLOW.renderOrder; } });
            a.userData = { path, s0: j * f.spacing + (c % 2) * f.spacing / 2 };
            g.add(a); g.userData.arrows.push(a);
          }
        });
        g.userData.mat = mat;
        out.push(g);
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
        if (f.attach !== undefined) { m.matrixAutoUpdate = false; m.userData.local = new THREE.Matrix4(); }
        out.push(m);
      }
    }
    for (const o of out) { o.visible = false; this.fxRoot.add(o); }
    this.fx.set(index, out);
    return out;
  }

  /** v2.2 motor lead: tube along the routed path; its free end follows end-offset keys or the part holding it. */
  #buildCable(f) {
    const pts = f.points.map((p) => new THREE.Vector3().fromArray(p));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const len = curve.getLength();
    const segs = Math.max(16, Math.round(len * 1000 / CABLE.segMm)), radial = CABLE.radial;
    const geo = new THREE.TubeGeometry(curve, segs, f.diameter / 2, radial, false);
    const base = geo.attributes.position.array.slice();
    const w = new Float32Array(segs + 1);                  // follow weight per ring (smoothstep over the last `follow` m)
    for (let j = 0; j <= segs; j++) { const x = Math.min(1, Math.max(0, (j / segs * len - (len - f.follow)) / f.follow)); w[j] = x * x * (3 - 2 * x); }
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(f.colour), roughness: CABLE.roughness, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat); mesh.raycast = () => {};
    mesh.userData = { fx: f, segs, radial, base, w, off: new THREE.Vector3(NaN, 0, 0), endDir: curve.getTangentAt(1).normalize(), end: pts[pts.length - 1].clone() };
    if (f.ferrule) {
      const fr = f.ferrule;
      const g = new THREE.CylinderGeometry(fr.od / 2, fr.od / 2, fr.length, 12); g.translate(0, fr.length / 2, 0);
      const fm = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(fr.colour), metalness: CABLE.ferrule.metalness, roughness: CABLE.ferrule.roughness }));
      fm.raycast = () => {}; fm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), mesh.userData.endDir);
      mesh.add(fm); mesh.userData.ferrule = fm;
      mesh.userData.fOff = new THREE.Vector3().fromArray(fr.offset ?? [0, 0, 0]);   // splice: centred between the pair
    }
    return mesh;
  }

  /** Current end offset of a lead: keys, or the rigid motion of the part holding its end. */
  #cableOffset(o, t) {
    const f = o.userData.fx;
    if (f.attach && (t === Infinity || t >= f.attach.t)) {
      const e = this.followOf(f.attach.node).elements; return _v2.set(e[12], e[13], e[14]);
    }
    const k = f.end;
    if (t === Infinity) { const l = k[k.length - 1]; return _v2.set(l[1], l[2], l[3]); }
    const [i, u0] = seg(k, t); const a = k[i], b = k[Math.min(i + 1, k.length - 1)]; const u = ease(u0);
    return _v2.set(a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u);
  }

  #cableTail(o, t = o.userData.t) {
    const off = this.#cableOffset(o, t ?? Infinity);
    const U = o.userData;
    if (U.off.equals(off)) return;
    U.off.copy(off);
    const pos = o.geometry.attributes.position, arr = pos.array, ring = U.radial + 1;
    for (let j = 0; j <= U.segs; j++) {
      const w = U.w[j]; if (w === 0 && !U.dirty) continue;
      for (let r = 0; r < ring; r++) {
        const i = (j * ring + r) * 3;
        arr[i] = U.base[i] + off.x * w; arr[i + 1] = U.base[i + 1] + off.y * w; arr[i + 2] = U.base[i + 2] + off.z * w;
      }
    }
    pos.needsUpdate = true; o.geometry.computeBoundingSphere();
    if (U.ferrule) U.ferrule.position.copy(U.end).add(off).add(U.fOff);
  }

  /** Effects of one step at time t (t = Infinity: completed state, for earlier steps / the overview). */
  #applyFx(index, t, pos = this.pos, kitOnly = false) {
    for (const o of this.#buildFx(index)) {
      const f = o.userData.fx;
      if (kitOnly) { if (!f.kit) { o.visible = false; continue; } }
      if (f.group && t === Infinity && this.#superseded(index, f.group, pos)) { o.visible = false; continue; }
      if (f.type === 'bead' || f.type === 'line') {
        const [t0, t1] = f.type === 'bead' ? f.grow : f.draw;
        const u = Math.max(0, Math.min(1, (t - t0) / Math.max(1e-6, t1 - t0)));
        o.visible = u > 0;
        o.geometry.setDrawRange(0, Math.ceil(u * o.userData.segs) * o.userData.radial * 6);
      } else if (f.type === 'gasket') {
        const [t0, t1] = f.grow;
        const u = Math.max(0, Math.min(1, (t - t0) / Math.max(1e-6, t1 - t0)));
        o.visible = u > 0;
        o.geometry.setDrawRange(0, Math.ceil(u * o.userData.segs) * 24);
      } else if (f.type === 'cable') {
        const g = f.grow;
        const u = !g || t === Infinity ? 1 : Math.max(0, Math.min(1, (t - g[0]) / Math.max(1e-6, g[1] - g[0])));
        o.visible = u > 0;
        o.geometry.setDrawRange(0, Math.ceil(u * o.userData.segs) * o.userData.radial * 6);
        o.userData.t = t;
        this.#cableTail(o, t);
        const fr = o.userData.ferrule;
        if (fr) {
          const F = f.ferrule;
          const shown = t === Infinity || F.show < 0 || t >= F.show;
          fr.visible = shown && u >= 1;
          if (fr.visible) {
            const slide = t === Infinity || F.show < 0 ? 0 : Math.max(0, 1 - (t - F.show) / F.slide);
            fr.position.copy(o.userData.end).add(o.userData.off).add(o.userData.fOff).addScaledVector(o.userData.endDir, 0.012 * slide);
            const crimped = F.crimp !== null && F.crimp !== undefined && (t === Infinity || F.crimp < 0 || t >= F.crimp);
            const k = crimped ? F.odCrimped / F.od : 1;
            fr.scale.set(k, 1, k);
          }
        }
      } else if (f.type === 'dims') {
        const [t0, t1] = f.t;
        const vis = t !== Infinity && t >= t0 && t <= t1;
        o.visible = vis;
        if (vis) { const a = Math.min(1, (t - t0) / DIMS.fade, (t1 - t) / DIMS.fade); for (const m of o.userData.mats) m.opacity = Math.max(0, a); }
      } else if (f.type === 'airflow') {
        const [t0, t1] = f.t;
        const vis = t !== Infinity && t >= t0 && t <= t1;
        o.visible = vis;
        if (vis) {
          const a = Math.min(1, (t - t0) / AIRFLOW.fade, (t1 - t) / AIRFLOW.fade);
          for (const ar of o.userData.arrows) {
            const { pts, cum, H } = ar.userData.path, s = (ar.userData.s0 + (t - t0) * f.speed) % H;
            let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
            const u = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
            ar.position.lerpVectors(pts[i - 1], pts[i], u);
            // aim along the path a little ahead (smooth turns at the eye and the wheel exit)
            const ahead = Math.min(H, s + f.length * 0.5); let k = i; while (k < cum.length - 1 && cum[k] < ahead) k++;
            const v = _v.subVectors(pts[k], ar.position); if (v.lengthSq() > 1e-12) ar.quaternion.setFromUnitVectors(_Y, v.normalize());
            ar.visible = s < H - f.length;
          }
          o.userData.mat.opacity = AIRFLOW.opacity * Math.max(0, a);
        }
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
        if (o.userData.local) o.userData.local.compose(o.position, o.quaternion, _s);
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
    if (pos === -1) this.#applyKit();
    for (let k = 0; k < N; k++) {
      const done = pos === -2 || (pos >= 0 && k < pos);
      if (done) this.#applyFx(k, Infinity, pos);
      else if (pos === -1) this.#applyFx(k, Infinity, pos, true);   // v2.2: stickers stay on their parts in the kit
      else this.#hideFx(k);
    }
    this.#updateFollowers(pos);
    this.viewer.requestRender();
  }

  /** v2.2: a later step that re-emits an fx group (the motor leads) supersedes the earlier ones. */
  #superseded(k, group, pos) {
    const cur = pos === -2 ? this.model.stepCount : pos;
    const steps = this.groups || (this.groups = this.#groupSteps());
    const list = steps[group] || [];
    return list.some((j) => j > k && j <= cur);
  }

  #groupSteps() {
    const out = {};
    this.model.steps.forEach((s, i) => { for (const f of s.tracks.fx) if (f.group) (out[f.group] = out[f.group] || []).includes(i) || out[f.group].push(i); });
    return out;
  }

  /** v2.2: attached effects (and lead ends held by a part) follow the current rigid motion of their part. */
  #updateFollowers(pos) {
    const N = this.model.stepCount;
    for (let k = 0; k < N; k++) {
      const list = this.fx.get(k); if (!list) continue;
      for (const o of list) {
        if (!o.visible) continue;
        const f = o.userData.fx;
        if (f.attach !== undefined && typeof f.attach !== 'object') {
          const F = this.followOf(f.attach);
          if (o.userData.local) o.matrix.multiplyMatrices(F, o.userData.local); else o.matrix.copy(F);
          o.matrixWorldNeedsUpdate = true;
        }
        if (f.type === 'cable') this.#cableTail(o);
      }
    }
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
        if (tr.kit) {                                     // v2.2: explicit components-view position (used as is)
          D.makeTranslation(tr.kit[0], tr.kit[1], tr.kit[2]);
        } else {
          this.#delta(tr, 0, D);
          const e = D.elements, len = Math.hypot(e[12], e[13], e[14]);
          const k = len > 1e-6 ? Math.max(1, Math.min(UnitRig.KIT_SCALE, UnitRig.KIT_MAX / len)) : 1;
          e[12] *= k; e[13] *= k; e[14] *= k;
        }
        this.#setLocal(p, D); this.moved.add(tr.node);
        this.follow.set(tr.node, D.clone());
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
      const F = this.follow.get(tr.node) || new THREE.Matrix4();
      this.#setLocal(p, this.#delta(tr, t, D, F)); this.moved.add(tr.node);
      this.follow.set(tr.node, F);
    }
    for (const tr of s.tracks.tools) this.#toolPose(tr.tool, tr, t);
    this.#applyFx(index, t);
    this.#updateFollowers(index);
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
UnitRig.IDENTITY = new THREE.Matrix4();
UnitRig.KIT_SCALE = KIT_VIEW.scale;       // v2.1: exploded (components) view displacement ×2 (standards.js)
UnitRig.KIT_MAX = KIT_VIEW.maxOffset;     // m
