#!/usr/bin/env python3
"""
build_torque_wrench.py — torque wrench tool for the unit tutorial (v2.3)
=======================================================================

No torque wrench was among the supplied tool models; engineering chose the "Torque Wrench" model found in
the Downloads folder (Sketchfab, by Pollymeowth, CC-BY-4.0 — credit kept in tools.json and the README):

  This work is based on "Torque Wrench" (https://sketchfab.com/3d-models/torque-wrench-6c03d41877604eeba06f316666728f3c)
  by Pollymeowth (https://sketchfab.com/pollymeowth42) licensed under CC-BY-4.0
  (http://creativecommons.org/licenses/by/4.0/)

The wrench (glTF, metres, 379 mm long) carries the same deep socket as the ratchet tool (the deep socket of the supplied drill STEP,
resized radially per nut at run time), mounted on its square drive. Tool frame as every tool
(tools.json): origin = socket opening on the fastener, +Y = into the tool (up the socket to the wrench head),
+X = along the handle.

Usage: python3 pipeline/unit/build_torque_wrench.py torque_wrench/scene.gltf public/assets/unit/tools Drill_with_9-16_Deep_Socket.step
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import trimesh

CREDIT = ('"Torque Wrench" (https://sketchfab.com/3d-models/torque-wrench-6c03d41877604eeba06f316666728f3c) by '
          'Pollymeowth (https://sketchfab.com/pollymeowth42), CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)')
DRIVE = np.array([0.121, 0.2945, 0.0])      # square drive face centre in the model (m); drive axis = model +X
R = np.array([[0, -1, 0], [-1, 0, 0], [0, 0, -1]], float)   # rows: tool X, Y, Z from the model axes


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    sc = trimesh.load(src)
    wrench = sc.to_geometry() if hasattr(sc, "to_geometry") else sc.dump(concatenate=True)
    # the deep socket of the supplied drill STEP, in the drill tool frame (opening at the origin, +Y into the tool)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import build_tools as BT
    drill = BT.read_parts(Path(sys.argv[3]), BT.DEFLECTION["drill"]); di = BT.analyse("drill", drill)
    sock = drill["Deep_Socket_9-16in_1-4in_Drive_6pt"].copy(); sock.apply_transform(BT.frame(di["origin"], di["y"], di["x"]))
    sock.apply_scale(0.001)
    y_drive = float(sock.bounds[1][1])                              # socket drive end (top of the socket)
    T = np.eye(4); T[:3, :3] = R; T[:3, 3] = -R @ DRIVE + np.array([0, y_drive, 0])
    wrench.apply_transform(T)
    wrench.visual = trimesh.visual.ColorVisuals(wrench, face_colors=np.tile([62, 64, 68, 255], (len(wrench.faces), 1)))
    scene = trimesh.Scene()
    scene.add_geometry(wrench, node_name="TorqueWrench", geom_name="TorqueWrench")
    scene.add_geometry(sock, node_name="Deep_Socket", geom_name="Deep_Socket")
    whole = trimesh.util.concatenate([wrench.copy(), sock.copy()]); whole.apply_scale(1000.0)   # mm, collision mesh
    cache = Path(__file__).resolve().parent / "cache"
    np.savez_compressed(cache / "tool_torquewrench.npz", V=whole.vertices.astype(np.float32), F=whole.faces.astype(np.int32))
    raw = out / "torquewrench.raw.glb"; scene.export(raw)
    dst = out / "torquewrench.glb"
    gp = shutil.which("gltfpack") or str(Path(__file__).resolve().parents[2] / "node_modules/.bin/gltfpack")
    try:
        subprocess.run([gp, "-i", str(raw), "-o", str(dst), "-cc", "-kn", "-km"], check=True, capture_output=True); raw.unlink()
    except Exception as e:  # pragma: no cover
        print(f"gltfpack failed ({e}); keeping uncompressed"); raw.rename(dst)
    meta = json.load(open(out / "tools.json"))
    bb = np.array(scene.bounds)
    meta["tools"]["torquewrench"] = dict(
        file=dst.name, source="torque_wrench/scene.gltf (Sketchfab)", credit=CREDIT,
        note="Torque wrench (Sketchfab model, CC-BY-4.0, not a supplied engineering model) with the deep socket of the supplied drill model, resized radially to the bolt",
        movingParts={"socket": {"nodes": ["Deep_Socket"], "kind": "spin", "axis": [0.0, 1.0, 0.0], "pivot": [0.0, 0.0, 0.0]}},
        boundsM=[[round(float(x), 4) for x in bb[0]], [round(float(x), 4) for x in bb[1]]])
    json.dump(meta, open(out / "tools.json", "w"), indent=1)
    print(f"torquewrench: {dst.stat().st_size / 1024:.0f} kB, bounds {np.round(bb, 3).tolist()}, socket drive end y {y_drive * 1000:.1f} mm")


if __name__ == "__main__":
    main()
