import * as THREE from 'three';

/**
 * Appearance — visual state of every part instance without cloning geometry.
 *
 * Each original CAD material gets three shared variants:
 *   ghost    : translucent, for parts not yet installed
 *   active   : orange emissive, parts of the current step
 *   selected : blue emissive, user selection
 * Switching a mesh between states only swaps the material reference.
 *
 * v1.5: every visible change calls `onChange` (the viewer then draws a frame — rendering is
 * on demand); helper objects are frozen (`freeze`: their transform never changes); CAD edges
 * can be limited to non-hardware parts and are built in small slices between frames.
 */
export const STATE = { NORMAL: 0, GHOST: 1, ACTIVE: 2, SELECTED: 3, HIDDEN: 4, SOFT: 5 };   // v2.3: SOFT = light active tint, no x-ray

const ACTIVE_COLOR = new THREE.Color(0xff7a1a);
const SELECT_COLOR = new THREE.Color(0x3aa0ff);

export class Appearance {
  constructor(loaded, { onChange = null, freeze = null, isHardware = null } = {}) {
    this.meshesByPart = loaded.meshesByPart;
    this.onChange = onChange || (() => {});
    this.freeze = freeze || (() => {});
    this.isHardware = isHardware || (() => false);
    this.edgeScope = null;        // 'all' | 'parts' once built
    this.variants = new Map();      // base material uuid -> [normal, ghost, active, selected]
    this.state = new Map();         // part id -> STATE
    this.edges = [];
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: 0x1b232c, transparent: true, opacity: 0.38, depthWrite: false });
    this.edgeGhostMaterial = new THREE.LineBasicMaterial({ color: 0x55606c, transparent: true, opacity: 0.08, depthWrite: false });

    // X-ray overlay: active/selected parts stay visible through the parts that enclose them
    const xray = (color) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.xrayMaterials = { [STATE.ACTIVE]: xray(ACTIVE_COLOR), [STATE.SELECTED]: xray(SELECT_COLOR) };
    for (const meshes of this.meshesByPart.values()) {
      for (const m of meshes) {
        const base = m.material;
        if (!this.variants.has(base.uuid)) this.variants.set(base.uuid, this.#makeVariants(base));
        m.userData.baseMaterial = base;
        const xr = new THREE.Mesh(m.geometry, this.xrayMaterials[STATE.ACTIVE]);
        xr.visible = false;
        xr.renderOrder = 5;
        xr.raycast = () => {};
        xr.userData.isXray = true;
        m.add(xr);
        this.freeze(xr);
        m.userData.xray = xr;
      }
    }
    for (const id of this.meshesByPart.keys()) this.state.set(id, STATE.NORMAL);
  }

  #makeVariants(base) {
    base.polygonOffset = true;          // keeps edge lines crisp on top of faces
    base.polygonOffsetFactor = 1;
    base.polygonOffsetUnits = 1;
    const ghost = base.clone();
    ghost.transparent = true;
    ghost.opacity = 0.14;
    ghost.depthWrite = false;
    ghost.color = base.color.clone().lerp(new THREE.Color(0xc8d2dc), 0.55);
    const active = base.clone();
    active.color = base.color.clone().lerp(ACTIVE_COLOR, 0.6);
    active.emissive = ACTIVE_COLOR.clone();
    active.emissiveIntensity = 0.28;
    const selected = base.clone();
    selected.color = base.color.clone().lerp(SELECT_COLOR, 0.6);
    selected.emissive = SELECT_COLOR.clone();
    selected.emissiveIntensity = 0.3;
    const soft = base.clone();             // v2.3: active, but its labels must stay readable
    soft.color = base.color.clone().lerp(ACTIVE_COLOR, 0.22);
    soft.emissive = ACTIVE_COLOR.clone();
    soft.emissiveIntensity = 0.07;
    return [base, ghost, active, selected, null, soft];
  }

  /**
   * Build CAD-style feature edges once per unique geometry (shared by instances).
   * scope 'all' = every part, 'parts' = no hardware (fasteners: many small draw calls).
   * mode 'sync' builds in one pass (v1.4); 'idle' spreads the work over idle time in slices
   * of ~sliceMs so the first frames and the UI stay responsive. Resolves when done.
   */
  buildEdges(thresholdDeg = 28, { scope = 'all', mode = 'sync', sliceMs = 6 } = {}) {
    if (this.edgeBuild && this.edgeScope === scope) return this.edgeBuild;
    this.edgeScope = scope;
    const work = [];
    const byGeo = new Map();
    for (const [part, meshes] of this.meshesByPart) {
      if (scope === 'parts' && this.isHardware(part)) continue;
      for (const m of meshes) {
        if (m.userData.edges) continue;
        let list = byGeo.get(m.geometry.uuid);
        if (!list) { list = []; byGeo.set(m.geometry.uuid, list); work.push(list); }
        list.push([part, m]);
      }
    }
    const cache = this.edgeGeometries || (this.edgeGeometries = new Map());
    const one = (list) => {
      const geo = list[0][1].geometry;
      let g = cache.get(geo.uuid);
      if (!g) { g = new THREE.EdgesGeometry(geo, thresholdDeg); cache.set(geo.uuid, g); }
      for (const [part, m] of list) {
        const lines = new THREE.LineSegments(g, this.edgeMaterial);
        lines.raycast = () => {};       // never pickable
        lines.userData.isEdge = true;
        lines.renderOrder = 1;
        m.add(lines);
        this.freeze(lines);
        m.userData.edges = lines;
        this.edges.push(lines);
        this.#applyEdgeState(lines, this.state.get(part));
      }
    };
    if (mode === 'sync') {
      work.forEach(one);
      this.onChange();
      this.edgeBuild = Promise.resolve();
      return this.edgeBuild;
    }
    const idle = (fn) => (typeof requestIdleCallback === 'function'
      ? requestIdleCallback(fn, { timeout: 200 }) : setTimeout(() => fn({ timeRemaining: () => sliceMs }), 16));
    this.edgeBuild = new Promise((resolve) => {
      let i = 0;
      const slice = (deadline) => {
        const t0 = performance.now();
        const budget = Math.min(sliceMs, Math.max(2, deadline && deadline.timeRemaining ? deadline.timeRemaining() : sliceMs));
        while (i < work.length && performance.now() - t0 < budget) one(work[i++]);
        if (i < work.length) idle(slice);
        else { this.onChange(); resolve(); }      // one redraw when all edges exist (not one per slice)
      };
      idle(slice);
    });
    return this.edgeBuild;
  }

  #applyEdgeState(e, state) {
    e.material = state === STATE.GHOST ? this.edgeGhostMaterial : this.edgeMaterial;
    e.userData.hiddenByState = state === STATE.HIDDEN;
    e.visible = this.edgesVisible !== false && state !== STATE.HIDDEN;
  }

  setEdgesVisible(v) {
    for (const e of this.edges) e.visible = v && e.parent.visible && !e.userData.hiddenByState;
    this.edgesVisible = v;
    this.onChange();
  }

  /** Apply a state to all meshes of a part instance. */
  set(partId, state) {
    if (this.state.get(partId) === state) return;
    this.state.set(partId, state);
    const meshes = this.meshesByPart.get(partId);
    if (!meshes) return;
    for (const m of meshes) {
      const v = this.variants.get(m.userData.baseMaterial.uuid);
      m.visible = state !== STATE.HIDDEN;
      if (state !== STATE.HIDDEN) m.material = v[state];
      const xr = m.userData.xray;
      if (xr) {
        xr.visible = this.xrayEnabled !== false && (state === STATE.ACTIVE || state === STATE.SELECTED);
        if (xr.visible) xr.material = this.xrayMaterials[state];
      }
      const e = m.userData.edges;
      if (e) this.#applyEdgeState(e, state);
    }
    this.onChange();
  }

  get(partId) { return this.state.get(partId); }

  /** Temporarily force original materials (used for USDZ export). */
  async withBaseMaterials(fn) {
    const saved = [];
    for (const meshes of this.meshesByPart.values()) {
      for (const m of meshes) {
        saved.push([m, m.material, m.visible, m.userData.xray && m.userData.xray.visible]);
        m.material = m.userData.baseMaterial;
        m.visible = true;
        if (m.userData.xray) m.userData.xray.visible = false;
      }
    }
    for (const e of this.edges) { e.userData.wasVisible = e.visible; e.visible = false; }
    try { return await fn(); } finally {
      for (const [m, mat, vis, xv] of saved) {
        m.material = mat; m.visible = vis;
        if (m.userData.xray) m.userData.xray.visible = !!xv;
      }
      for (const e of this.edges) e.visible = e.userData.wasVisible;
      this.onChange();
    }
  }
}
