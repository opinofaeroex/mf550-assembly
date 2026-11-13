import * as THREE from 'three';

/**
 * Appearance — visual state of every part instance without cloning geometry.
 *
 * Each original CAD material gets three shared variants:
 *   ghost    : translucent, for parts not yet installed
 *   active   : orange emissive, parts of the current step
 *   selected : blue emissive, user selection
 * Switching a mesh between states only swaps the material reference.
 */
export const STATE = { NORMAL: 0, GHOST: 1, ACTIVE: 2, SELECTED: 3, HIDDEN: 4 };

const ACTIVE_COLOR = new THREE.Color(0xff7a1a);
const SELECT_COLOR = new THREE.Color(0x3aa0ff);

export class Appearance {
  constructor(loaded) {
    this.meshesByPart = loaded.meshesByPart;
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
    return [base, ghost, active, selected];
  }

  /** Build CAD-style feature edges once per unique geometry (shared by instances). */
  buildEdges(thresholdDeg = 28) {
    const cache = new Map();
    for (const meshes of this.meshesByPart.values()) {
      for (const m of meshes) {
        let g = cache.get(m.geometry.uuid);
        if (!g) {
          g = new THREE.EdgesGeometry(m.geometry, thresholdDeg);
          cache.set(m.geometry.uuid, g);
        }
        const lines = new THREE.LineSegments(g, this.edgeMaterial);
        lines.raycast = () => {};       // never pickable
        lines.userData.isEdge = true;
        lines.renderOrder = 1;
        m.add(lines);
        m.userData.edges = lines;
        this.edges.push(lines);
      }
    }
  }

  setEdgesVisible(v) {
    for (const e of this.edges) e.visible = v && e.parent.visible && !e.userData.hiddenByState;
    this.edgesVisible = v;
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
      if (e) {
        e.material = state === STATE.GHOST ? this.edgeGhostMaterial : this.edgeMaterial;
        e.userData.hiddenByState = state === STATE.HIDDEN;
        e.visible = this.edgesVisible !== false && state !== STATE.HIDDEN;
      }
    }
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
    }
  }
}
