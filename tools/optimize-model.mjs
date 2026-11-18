#!/usr/bin/env node
/**
 * optimize-model.mjs — lighter copies of the assembly GLB for low-power GPUs (Raspberry Pi).
 *
 *   npm run model:tiers                                 # writes .balanced.glb and .low.glb + reports
 *   node tools/optimize-model.mjs --tiers balanced=0.2  # custom tier(s): name=max error in mm
 *
 * What changes: ONLY the triangle lists of the meshes. Every mesh is simplified with
 * meshoptimizer to a fixed ABSOLUTE error target (millimetres in model space), so small
 * hardware with dense tessellation (screws, rivets, nuts) loses invisible detail while large
 * flat sheet-metal parts are left almost untouched. Attribute seams (CAD face boundaries,
 * where vertices are split by normals) and open borders are preserved.
 *
 * What never changes (verified after writing, the tool fails otherwise):
 *   - the node tree: names, extras (nid used by assembly.json / BOM), TRS transforms,
 *     parent/child structure, which node instances which mesh;
 *   - materials and their assignment to primitives;
 *   - the vertex data format: gltfpack's KHR_mesh_quantization integers are kept exactly
 *     (kept vertices are a subset of the original vertices, so positions and normals are
 *     bit-identical to the source GLB); output is re-compressed with EXT_meshopt_compression.
 *
 * The source GLB itself is never modified (it stays the High-quality asset).
 *
 * The target is meshoptimizer's error metric (quadric-based), not a hard bound on how far a surface
 * can move: the tool therefore MEASURES how much every component's bounding box changed and
 * writes that (measuredBoundsMm) to model-tiers.json; the tests check against it.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = path.join(HERE, '..', 'public', 'assets', 'model');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const assembly = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'assembly.json'), 'utf8'));
const SRC = path.resolve(opt('in', path.join(MODEL_DIR, assembly.meta.glb)));
/** Error target per tier (mm, meshoptimizer metric). 0.2 mm ≈ 0.8 px at the closest automatic camera
 *  distance (≈ 0.3 m, 35° FOV, 800 px tall view). The result is measured (measuredBoundsMm). */
const TIERS = Object.fromEntries((opt('tiers', 'balanced=0.2,low=0.45')).split(',').map((s) => {
  const [k, v] = s.split('='); return [k, Number(v)];
}));

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

/** Structural fingerprint of the scene (everything the app and the BOM rely on). */
function fingerprint(doc) {
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  const mats = root.listMaterials();
  return JSON.stringify({
    nodes: root.listNodes().map((n) => ({
      name: n.getName(), extras: n.getExtras(), t: n.getTranslation(), r: n.getRotation(), s: n.getScale(),
      mesh: n.getMesh() ? meshes.indexOf(n.getMesh()) : null,
      children: n.listChildren().map((c) => root.listNodes().indexOf(c)),
    })),
    scenes: root.listScenes().map((s) => s.listChildren().map((c) => root.listNodes().indexOf(c))),
    meshes: meshes.map((m) => m.listPrimitives().map((p) => ({ material: mats.indexOf(p.getMaterial()), mode: p.getMode(),
      attrs: p.listSemantics().join(','), types: p.listAttributes().map((a) => `${a.getComponentType()}:${a.getNormalized()}`).join(',') }))),
    materials: mats.map((m) => [m.getName(), m.getBaseColorFactor(), m.getMetallicFactor(), m.getRoughnessFactor()]),
  });
}

/** World-space bounds of every component (node with extras.nid) from its meshes' accessor bounds. */
function componentBounds(doc) {
  const out = new Map();
  const corner = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
  for (const n of doc.getRoot().listNodes()) {
    const nid = n.getExtras() && n.getExtras().nid;
    if (!nid) continue;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const visit = (k) => {
      const mesh = k.getMesh();
      if (mesh) {
        const m = k.getWorldMatrix();
        for (const p of mesh.listPrimitives()) {
          const a = p.getAttribute('POSITION');
          const lo = a.getMin([]), hi = a.getMax([]);
          for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
            const c = corner(m, x, y, z);
            for (let i = 0; i < 3; i++) { b[i] = Math.min(b[i], c[i]); b[i + 3] = Math.max(b[i + 3], c[i]); }
          }
        }
      }
      k.listChildren().forEach(visit);
    };
    visit(n);
    out.set(nid, b);
  }
  return out;
}

/** Largest scale factor of a 4x4 column-major matrix. */
const maxScale = (m) => Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));

async function build(tier, errorMm) {
  const doc = await io.read(SRC);
  const before = fingerprint(doc);
  const root = doc.getRoot();
  // world scale of each mesh (shared meshes: all instances have the same dequantisation scale)
  const meshScale = new Map();
  for (const n of root.listNodes()) {
    const m = n.getMesh();
    if (!m) continue;
    const s = maxScale(n.getWorldMatrix());
    meshScale.set(m, Math.max(meshScale.get(m) || 0, s));
  }
  const report = [];
  let triBefore = 0, triAfter = 0, renderedBefore = 0, renderedAfter = 0;
  const instances = new Map();
  for (const n of root.listNodes()) if (n.getMesh()) instances.set(n.getMesh(), (instances.get(n.getMesh()) || 0) + 1);

  for (const mesh of root.listMeshes()) {
    const scale = meshScale.get(mesh) || 1;
    const errLocal = (errorMm / 1000) / scale;        // absolute error in the mesh's own (quantised) units
    for (const prim of mesh.listPrimitives()) {
      const idxAcc = prim.getIndices();
      const posAcc = prim.getAttribute('POSITION');
      if (!idxAcc || !posAcc || prim.getMode() !== 4) continue;
      const indices = Uint32Array.from(idxAcc.getArray());
      const n = posAcc.getCount();
      const pos = new Float32Array(n * 3);
      const el = [0, 0, 0];
      for (let i = 0; i < n; i++) { posAcc.getElement(i, el); pos[i * 3] = el[0]; pos[i * 3 + 1] = el[1]; pos[i * 3 + 2] = el[2]; }
      const [simp, err] = MeshoptSimplifier.simplify(indices, pos, 3, 0, errLocal, ['ErrorAbsolute']);
      const tb = indices.length / 3, ta = simp.length / 3;
      const inst = instances.get(mesh) || 1;
      triBefore += tb; triAfter += ta; renderedBefore += tb * inst; renderedAfter += ta * inst;
      report.push({ mesh: root.listMeshes().indexOf(mesh), instances: inst, trianglesBefore: tb, trianglesAfter: ta,
        maxErrorMm: +(err * scale * 1000).toFixed(3) });
      if (ta === tb) continue;
      // vertex cache order + drop unused vertices; kept vertices are copied bit-for-bit.
      // NB: reorderMesh rewrites the index buffer in place (already in the new vertex numbering)
      // and returns the old → new vertex map (0xffffffff = vertex no longer used).
      const [remap, unique] = MeshoptEncoder.reorderMesh(simp, true, false);
      const newIdx = simp;
      for (const sem of prim.listSemantics()) {
        const acc = prim.getAttribute(sem);
        const src = acc.getArray();
        const k = acc.getElementSize();
        const dst = new src.constructor(unique * k);
        for (let v = 0; v < remap.length; v++) {
          const r = remap[v];
          if (r === 0xffffffff) continue;
          for (let c = 0; c < k; c++) dst[r * k + c] = src[v * k + c];
        }
        const out = doc.createAccessor().setType(acc.getType()).setArray(dst).setNormalized(acc.getNormalized()).setBuffer(acc.getBuffer());
        prim.setAttribute(sem, out);
      }
      const IdxArr = unique <= 65535 ? Uint16Array : Uint32Array;
      prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(IdxArr.from(newIdx)).setBuffer(idxAcc.getBuffer()));
    }
  }
  // drop the replaced accessors (no other change to the document)
  for (const a of root.listAccessors()) if (a.listParents().length <= 1) a.dispose();

  const ext = doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  void ext;
  const base = path.basename(SRC, '.glb');
  const out = path.join(path.dirname(SRC), `${base}.${tier}.glb`);
  await io.write(out, doc);

  // verification: re-read and compare the structure and the kept vertex data
  const check = await io.read(out);
  if (fingerprint(check) !== before) throw new Error(`${tier}: scene structure changed — refusing to keep ${out}`);
  const src = await io.read(SRC);
  const srcPos = new Set();
  for (const p of src.getRoot().listMeshes().flatMap((m) => m.listPrimitives())) {
    const a = p.getAttribute('POSITION').getArray();
    for (let i = 0; i < a.length; i += 3) srcPos.add(`${a[i]},${a[i + 1]},${a[i + 2]}`);
  }
  let foreign = 0;
  for (const p of check.getRoot().listMeshes().flatMap((m) => m.listPrimitives())) {
    const a = p.getAttribute('POSITION').getArray();
    for (let i = 0; i < a.length; i += 3) if (!srcPos.has(`${a[i]},${a[i + 1]},${a[i + 2]}`)) foreign++;
  }
  if (foreign) throw new Error(`${tier}: ${foreign} vertices are not original CAD vertices`);
  // measured change of every component's bounding box (what the tests and docs report)
  const boundsSrc = componentBounds(src), boundsOut = componentBounds(check);
  let boundsDev = 0;
  for (const [nid, b] of boundsSrc) {
    const a = boundsOut.get(nid);
    if (!a) throw new Error(`${tier}: component ${nid} missing`);
    for (let i = 0; i < 6; i++) if (Number.isFinite(b[i])) boundsDev = Math.max(boundsDev, Math.abs(a[i] - b[i]));
  }
  // every index must address a vertex of its primitive; every triangle's corners must be vertices of the
  // SAME source mesh (catches any index/vertex mix-up, which the checks above would not see)
  const srcMeshes = src.getRoot().listMeshes();
  check.getRoot().listMeshes().forEach((mesh, mi) => {
    mesh.listPrimitives().forEach((p, pi) => {
      const idx = p.getIndices().getArray();
      const pos = p.getAttribute('POSITION');
      const count = pos.getCount();
      const own = new Set();
      const sa = srcMeshes[mi].listPrimitives()[pi].getAttribute('POSITION').getArray();
      for (let i = 0; i < sa.length; i += 3) own.add(`${sa[i]},${sa[i + 1]},${sa[i + 2]}`);
      const a = pos.getArray();
      for (let i = 0; i < idx.length; i++) {
        const v = idx[i];
        if (v >= count) throw new Error(`${tier}: mesh ${mi} index ${v} out of range (${count} vertices)`);
        if (!own.has(`${a[v * 3]},${a[v * 3 + 1]},${a[v * 3 + 2]}`)) throw new Error(`${tier}: mesh ${mi} uses a vertex of another mesh`);
      }
    });
  });
  return {
    tier, maxErrorMm: errorMm, measuredBoundsMm: Math.round(boundsDev * 1e6) / 1e3,
    file: path.relative(path.join(HERE, '..'), out), bytes: fs.statSync(out).size,
    uniqueTriangles: [triBefore, triAfter], renderedTriangles: [renderedBefore, renderedAfter],
    reduction: `${Math.round((1 - renderedAfter / renderedBefore) * 100)} %`,
    structure: 'identical (nodes, names, extras/nid, transforms, hierarchy, mesh instancing, materials)',
    vertices: 'subset of the source vertices (bit-identical quantised positions and normals)',
    meshes: report,
  };
}

const results = [];
for (const [tier, mm] of Object.entries(TIERS)) {
  const r = await build(tier, mm);
  results.push(r);
  console.log(`${tier}: ${r.renderedTriangles[0]} → ${r.renderedTriangles[1]} rendered triangles (${r.reduction}), ` +
    `target ${mm} mm, component bounds moved ≤ ${r.measuredBoundsMm} mm, ${(r.bytes / 1024).toFixed(0)} kB → ${r.file}`);
}
const reportFile = path.join(MODEL_DIR, 'model-tiers.json');
fs.writeFileSync(reportFile, JSON.stringify({
  source: path.basename(SRC), sourceBytes: fs.statSync(SRC).size,
  generatedBy: 'tools/optimize-model.mjs (meshoptimizer simplify, absolute error)',
  tiers: Object.fromEntries(results.map((r) => [r.tier, {
    file: path.basename(r.file), maxErrorMm: r.maxErrorMm, measuredBoundsMm: r.measuredBoundsMm, bytes: r.bytes,
    renderedTriangles: r.renderedTriangles[1], uniqueTriangles: r.uniqueTriangles[1],
  }])),
  high: { file: path.basename(SRC), renderedTriangles: results[0]?.renderedTriangles[0], uniqueTriangles: results[0]?.uniqueTriangles[0] },
}, null, 2) + '\n');
const detail = path.join(MODEL_DIR, 'model-tiers-report.json');
fs.writeFileSync(detail, JSON.stringify(results, null, 1) + '\n');
console.log(`report: ${path.relative(process.cwd(), reportFile)}, ${path.relative(process.cwd(), detail)}`);
