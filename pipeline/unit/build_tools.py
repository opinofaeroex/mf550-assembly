#!/usr/bin/env python3
"""
build_tools.py — the supplied tool models as GLBs for the unit tutorial (v2.0)
=============================================================================

Each supplied tool STEP is tessellated without changing its geometry or proportions and
re-framed so the animation can place it with one alignment:

  origin  = the tool's working point (socket opening, rivet-gun nose, nozzle tip, marker
            tip, wrench jaw centre)
  +Y      = from the working point back into the tool (= the fastener axis, pointing out of
            the work, when the tool is engaged)

Movable components keep their own nodes (socket + adapter + chuck spin, rivet-gun trigger and
nose, dispenser knob screw / pressure plate / plunger, wrench jaw + worm). Pivots, axes and
strokes are written to tools.json. Output in metres (glTF), meshopt-compressed by gltfpack.

Tools (identified by geometry, not file name):
  drill     Drill_with_9-16_Deep_Socket.step   cordless drill, 1/4" hex→square adapter, 9/16" deep socket
  rivetgun  RivetGun.stp                        ACCUBIRD cordless blind-rivet gun
  caulking  Caulking_Dispenser_Complete.step    screw-driven cartridge dispenser, WEICON HT300 (red)
  marker    Marker.STEP                         Sharpie Fine Point Retractable
  wrench    Wrench.stp                          adjustable wrench (~233 mm)

Usage: python3 pipeline/unit/build_tools.py <dir with the tool STEP files> public/assets/unit/tools
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import trimesh
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.IFSelect import IFSelect_RetDone
from OCP.OCP.collections import Sequence_TDF_Label as Seq
from OCP.Quantity import Quantity_Color
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

FILES = {
    "drill": r"Drill_with_9-16_Deep_Socket\.step$",
    "rivetgun": r"RivetGun\.stp$",
    "caulking": r"Caulking_Dispenser_Complete\.step$",
    "marker": r"Marker\.STEP$",
    "wrench": r"Wrench\.stp$",
}
DEFLECTION = {"drill": 0.25, "rivetgun": 0.3, "caulking": 0.3, "marker": 0.12, "wrench": 0.3}


def read_parts(path, defl):
    """{node name: [trimesh, ...]} in the STEP frame (mm), with colours."""
    doc = TDocStd_Document(TCollection_ExtendedString("d"))
    r = STEPCAFControl_Reader(); r.SetNameMode(True); r.SetColorMode(True)
    assert r.ReadFile(str(path)) == IFSelect_RetDone, path
    r.Transfer(doc)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

    def nm(l):
        a = TDataStd_Name()
        return a.Get().ToExtString() if l.FindAttribute(TDataStd_Name.GetID_s(), a) else ""

    def colour(lab, shape):
        c = Quantity_Color()
        for t in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
            try:
                if XCAFDoc_ColorTool.GetColor_s(lab, t, c): return (c.Red(), c.Green(), c.Blue())
            except Exception: pass
            try:
                if ct.GetColor(shape, t, c): return (c.Red(), c.Green(), c.Blue())
            except Exception: pass
        return None

    out = {}

    def mesh(solid, loc):
        BRepMesh_IncrementalMesh(solid, defl, False, 0.35, True)
        V, F = [], []
        e = TopExp_Explorer(solid, TopAbs_FACE)
        while e.More():
            f = TopoDS.Face(e.Current()); e.Next()
            L = TopLoc_Location(); tri = BRep_Tool.Triangulation_s(f, L)
            if tri is None: continue
            tr = loc.Multiplied(L).Transformation(); base = len(V)
            for i in range(1, tri.NbNodes() + 1):
                p = tri.Node(i).Transformed(tr); V.append((p.X(), p.Y(), p.Z()))
            rev = f.Orientation() == TopAbs_REVERSED
            for i in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(i).Get()
                F.append((base + a - 1, base + c - 1, base + b - 1) if rev else (base + a - 1, base + b - 1, base + c - 1))
        return trimesh.Trimesh(np.array(V), np.array(F), process=True) if F else None

    def walk(l, loc, col):
        ref = TDF_Label(); p = l
        if XCAFDoc_ShapeTool.IsReference_s(l):
            XCAFDoc_ShapeTool.GetReferredShape_s(l, ref); p = ref
            loc = loc.Multiplied(XCAFDoc_ShapeTool.GetLocation_s(l))
        shape = XCAFDoc_ShapeTool.GetShape_s(p)
        name = re.sub(r":\d+$", "", nm(l) or nm(p)) or "part"
        col = colour(l, shape) or colour(p, shape) or col
        if XCAFDoc_ShapeTool.IsAssembly_s(p):
            s = Seq(); XCAFDoc_ShapeTool.GetComponents_s(p, s, False)
            for i in range(s.Length()): walk(s.Value(i + 1), loc, col)
            return
        e = TopExp_Explorer(shape, TopAbs_SOLID); k = 0; solids = []
        while e.More(): solids.append(e.Current()); e.Next()
        for so in solids:
            k += 1
            m = mesh(so, loc)
            if m is None: continue
            c = colour(p, so) or col or (0.55, 0.56, 0.58)
            m.visual = trimesh.visual.ColorVisuals(m, face_colors=np.tile([int(c[0] * 255), int(c[1] * 255), int(c[2] * 255), 255], (len(m.faces), 1)))
            key = name if len(solids) == 1 else f"{name}__s{k}"
            out.setdefault(key, []).append(m)

    roots = Seq(); st.GetFreeShapes(roots)
    for i in range(roots.Length()): walk(roots.Value(i + 1), TopLoc_Location(), None)
    return {k: trimesh.util.concatenate(v) for k, v in out.items()}


def frame(origin, y_axis, x_hint):
    """4x4 matrix taking STEP coordinates (mm) to the tool frame (origin at the working point)."""
    y = np.asarray(y_axis, float); y /= np.linalg.norm(y)
    x = np.asarray(x_hint, float); x = x - y * (x @ y); x /= np.linalg.norm(x)
    z = np.cross(x, y)
    R = np.vstack([x, y, z])          # rows: new axes in old coordinates
    M = np.eye(4); M[:3, :3] = R; M[:3, 3] = -R @ np.asarray(origin, float)
    return M


def ring_centre(m, axis_index, at_min=True, band=1.0):
    """Centre of the vertices within `band` mm of the min (or max) along an axis."""
    v = m.vertices; t = v[:, axis_index]
    sel = v[(t < t.min() + band)] if at_min else v[(t > t.max() - band)]
    c = (sel.min(axis=0) + sel.max(axis=0)) / 2
    c[axis_index] = t.min() if at_min else t.max()
    return c


def analyse(tool, parts):
    """Working point, frame and moving components of each tool (in STEP coordinates, mm)."""
    info = {"moving": {}}
    if tool == "drill":
        sock = parts["Deep_Socket_9-16in_1-4in_Drive_6pt"]
        tip = ring_centre(sock, 1, at_min=True, band=2.0)              # socket opening (axis vertical, opening down)
        info.update(origin=tip, y=(0, 1, 0), x=(1, 0, 0), note="cordless drill, 1/4in hex to 1/4in square adapter, 9/16in 6-point deep socket")
        chuck = parts["Drill_Part_06"]; cc = (chuck.bounds[0] + chuck.bounds[1]) / 2
        info["moving"] = {
            "socket": dict(nodes=["Deep_Socket_9-16in_1-4in_Drive_6pt"], kind="spin", axis=(0, 1, 0), pivot=tip.tolist(),
                           acrossFlatsMm=14.2875, note="radially scaled per fastener (measured hex) - supplied size 9/16in"),
            "adapter": dict(nodes=["Adapter_1-4in_Hex_to_1-4in_Square"], kind="spin", axis=(0, 1, 0), pivot=tip.tolist()),
            "chuck": dict(nodes=["Drill_Part_06"], kind="spin", axis=(0, 1, 0), pivot=[cc[0], cc[1], cc[2]]),
        }
        info["socketDepthMm"] = float(sock.bounds[1][1] - sock.bounds[0][1])
    elif tool == "rivetgun":
        nose = parts["ACCUBIRD_RivetGun__s3"]
        tip = ring_centre(nose, 0, at_min=True, band=1.0)               # nose piece points -X
        info.update(origin=tip, y=(1, 0, 0), x=(0, 1, 0), note="ACCUBIRD cordless blind-rivet gun")
        info["moving"] = {
            "nose": dict(nodes=["ACCUBIRD_RivetGun__s3"], kind="slide", axis=(1, 0, 0), strokeMm=2.5),
            "trigger": dict(nodes=["ACCUBIRD_RivetGun__s13"], kind="slide", axis=(1, 0, 0), strokeMm=4.0),
        }
    elif tool == "caulking":
        noz = parts["Cartridge_Nozzle"]
        tip = ring_centre(noz, 1, at_min=False, band=0.6)               # nozzle tip at the top
        info.update(origin=tip, y=(0, -1, 0), x=(1, 0, 0), note="screw-driven cartridge dispenser with WEICON HT300 (red) silicone - no trigger: the knob drives the screw")
        info["moving"] = {
            "knob": dict(nodes=["Screw_with_Knob"], kind="screw", axis=(0, 1, 0), pivot=[0, 0, 0], pitchMm=2.0),
            "plate": dict(nodes=["Pressure_Plate", "Screw_M5x16_DIN7991", "Cartridge_Plunger"], kind="slide", axis=(0, 1, 0)),
        }
        info["beadColour"] = "#c8281e"
    elif tool == "marker":
        m = parts[next(iter(parts))]
        tip = ring_centre(m, 1, at_min=True, band=0.4)
        info.update(origin=tip, y=(0, 1, 0), x=(1, 0, 0), note="Sharpie Fine Point Retractable (black)")
        info["inkColour"] = "#111111"
    elif tool == "wrench":
        fixed, jaw = parts["Part1"], parts["Part4"]
        # jaw faces are perpendicular to Z; the moving jaw (Part4) slides along Z on the worm (Part2/Part3)
        vj = jaw.vertices; head = vj[(vj[:, 1] > 82) & (vj[:, 1] < 106)]
        face_z = float(np.percentile(head[:, 2], 99.5))              # moving-jaw face (closed: touches the fixed jaw)
        x_mid = float((fixed.bounds[0][0] + fixed.bounds[1][0]) / 2)
        centre = np.array([x_mid, 94.0, face_z])
        info.update(origin=centre, y=(1, 0, 0), x=(0, -1, 0), note="adjustable wrench, jaws modelled closed - opened on the worm to the nut's measured width")
        info["jawFaceZ"] = face_z
        info["moving"] = {
            "jaw": dict(nodes=["Part4"], kind="slide", axis=(0, 0, -1)),
            "worm": dict(nodes=["Part2", "Part3"], kind="spin", axis=(0, 0, 1), pivot=[x_mid, 57.9, -14.0]),
        }
    return info


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    meta = {}
    for tool, pat in FILES.items():
        f = next((p for p in src.iterdir() if re.search(pat, p.name, re.I)), None)
        if f is None:
            print(f"[tools] {tool}: no file matching {pat} — skipped"); continue
        parts = read_parts(f, DEFLECTION[tool])
        info = analyse(tool, parts)
        M = frame(info["origin"], info["y"], info["x"])
        R = M[:3, :3]
        scene = trimesh.Scene(); framed = []
        for name, m in parts.items():
            m = m.copy(); m.apply_transform(M); framed.append(m.copy()); m.apply_scale(0.001)
            scene.add_geometry(m, node_name=name, geom_name=name)
        whole = trimesh.util.concatenate(framed)          # tool frame, mm: collision checks in build_unit.py
        cache = Path(__file__).resolve().parent / ".cache"; cache.mkdir(exist_ok=True)
        np.savez_compressed(cache / f"tool_{tool}.npz", V=whole.vertices.astype(np.float32), F=whole.faces.astype(np.int32))
        raw = out / f"{tool}.raw.glb"; scene.export(raw)
        dst = out / f"{tool}.glb"
        gp = shutil.which("gltfpack") or str(Path(__file__).resolve().parents[2] / "node_modules/.bin/gltfpack")
        try:
            subprocess.run([gp, "-i", str(raw), "-o", str(dst), "-cc", "-kn", "-km"], check=True, capture_output=True)
            raw.unlink()
        except Exception as e:  # pragma: no cover
            print(f"[tools] gltfpack failed ({e}); keeping uncompressed"); raw.rename(dst)
        def tf_point(p): return (M @ np.r_[np.asarray(p, float), 1])[:3] * 0.001
        def tf_dir(d): return R @ np.asarray(d, float)
        mv = {}
        for k, v in info["moving"].items():
            e = {kk: vv for kk, vv in v.items() if kk not in ("axis", "pivot")}
            e["axis"] = [round(float(x), 6) for x in tf_dir(v["axis"])]
            if "pivot" in v: e["pivot"] = [round(float(x), 6) for x in tf_point(v["pivot"])]
            mv[k] = e
        bb = np.array(scene.bounds)
        meta[tool] = dict(file=dst.name, source=f.name, note=info["note"], movingParts=mv,
                          boundsM=[[round(float(x), 4) for x in bb[0]], [round(float(x), 4) for x in bb[1]]],
                          **{k: info[k] for k in ("socketDepthMm", "beadColour", "inkColour") if k in info})
        if tool == "wrench":
            meta[tool]["jawClosedAtOrigin"] = True
        print(f"[tools] {tool}: {len(parts)} nodes, {dst.stat().st_size / 1024:.0f} kB")
    json.dump(dict(frame="origin = working point, +Y = from the working point into the tool; metres", tools=meta),
              open(out / "tools.json", "w"), indent=1)


if __name__ == "__main__":
    main()
