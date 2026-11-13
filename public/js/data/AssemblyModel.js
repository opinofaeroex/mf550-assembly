/**
 * AssemblyModel — read-only access to assembly.json produced by the STEP pipeline.
 *
 * Holds the component tree, the indented BOM, the flat parts list and the derived
 * assembly sequence, and answers the queries the UI and the animation need.
 * Nothing in here is invented: every value comes from assembly.json; values the
 * STEP file does not carry are reported as `null` and rendered as placeholders.
 */
export class AssemblyModel {
  /** @param {object} json parsed assembly.json */
  constructor(json) {
    this.meta = json.meta;
    this.rootId = json.root;
    this.nodes = new Map(json.nodes.map((n) => [n.id, n]));
    this.bom = json.bom;
    this.partsList = json.partsList;
    this.steps = json.steps;

    /** node id -> BOM row (the row that lists this instance) */
    this.rowByNode = new Map();
    for (const row of this.bom) for (const id of row.nodes) this.rowByNode.set(id, row);
    this.rowByItem = new Map(this.bom.map((r) => [r.item, r]));

    // depth + effective step (parts inside purchased units inherit the unit's step)
    for (const n of this.nodes.values()) {
      n.depth = 0;
      let p = n.parent ? this.nodes.get(n.parent) : null;
      while (p) { n.depth++; p = p.parent ? this.nodes.get(p.parent) : null; }
    }
    for (const n of this.nodes.values()) n.effectiveStep = this.#effectiveStep(n);

    this.partIds = [...this.nodes.values()].filter((n) => n.kind === 'part').map((n) => n.id);
    this.stepCount = this.steps.length;
  }

  #effectiveStep(n) {
    let cur = n;
    while (cur) {
      if (cur.step !== null && cur.step !== undefined) return cur.step;
      cur = cur.parent ? this.nodes.get(cur.parent) : null;
    }
    return null;
  }

  get root() { return this.nodes.get(this.rootId); }
  node(id) { return this.nodes.get(id); }
  parentOf(id) { const n = this.nodes.get(id); return n && n.parent ? this.nodes.get(n.parent) : null; }

  /** All part (mesh-bearing) descendants of a node, including itself. */
  partsUnder(id) {
    const out = [];
    const walk = (nid) => {
      const n = this.nodes.get(nid);
      if (!n) return;
      if (n.kind === 'part') out.push(nid);
      for (const c of n.children) walk(c);
    };
    walk(id);
    return out;
  }

  /** Display label for a component: part number if known, else the CAD name. */
  label(n) { return n.name; }

  /** Part number or null when the CAD name is not a part number (e.g. 'Pressure Gage New'). */
  partNumber(row) { return row.partNumber ?? null; }

  /** Human-readable path of assembly names from the product down to (excluding) the node. */
  assemblyPath(id) {
    const names = [];
    let p = this.parentOf(id);
    while (p) { names.unshift(p.name); p = this.parentOf(p.id); }
    return names;
  }

  /** Number of part instances installed before step k (0..N). */
  partsInstalledBefore(k) {
    let c = 0;
    for (const id of this.partIds) {
      const s = this.nodes.get(id).effectiveStep;
      if (s !== null && s < k) c++;
    }
    return c;
  }

  /** Short textual direction for a unit install-direction vector (model frame, Y up). */
  static directionText(dir) {
    if (!dir) return null;
    const [x, y, z] = dir;
    const ax = [Math.abs(x), Math.abs(y), Math.abs(z)];
    const k = ax.indexOf(Math.max(...ax));
    if (ax[k] < 0.9) return 'along its axis';
    // the part travels along `dir`, so it comes from the opposite side
    if (k === 1) return y < 0 ? 'from above (moving down)' : 'from below (moving up)';
    if (k === 0) return x < 0 ? 'from the +X side' : 'from the −X side';
    return z < 0 ? 'from the +Z side' : 'from the −Z side';
  }
}

/** Fetch + validate assembly.json. */
export async function loadAssembly(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const json = await res.json();
  for (const key of ['meta', 'root', 'nodes', 'bom', 'steps']) {
    if (!(key in json)) throw new Error(`assembly.json is missing "${key}" — re-run the conversion pipeline`);
  }
  return new AssemblyModel(json);
}
