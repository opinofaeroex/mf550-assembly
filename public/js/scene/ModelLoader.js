import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * Loads the optimised GLB and links every glTF node to its assembly.json node
 * through the `extras.nid` written by the pipeline (exposed as userData.nid).
 */
export async function loadModel(url, model, onProgress) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, (e) => {
    if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
  });
  const root = gltf.scene;

  /** nid -> Object3D */
  const objects = new Map();
  root.traverse((o) => {
    const nid = o.userData && o.userData.nid;
    if (nid) objects.set(nid, o);
  });

  const missing = [...model.nodes.keys()].filter((id) => !objects.has(id));
  if (missing.length) {
    throw new Error(`GLB and assembly.json do not match (${missing.length} nodes missing). Re-run the pipeline.`);
  }

  /** Mesh -> owning part node id; part id -> meshes */
  const meshesByPart = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    let p = o;
    while (p && !(p.userData && p.userData.nid)) p = p.parent;
    const nid = p.userData.nid;
    o.userData.part = nid;
    if (!meshesByPart.has(nid)) meshesByPart.set(nid, []);
    meshesByPart.get(nid).push(o);
    o.geometry.computeBoundingBox();
    o.geometry.computeBoundingSphere();
  });

  return { root, objects, meshesByPart };
}
