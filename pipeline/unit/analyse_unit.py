#!/usr/bin/env python3
"""
analyse_unit.py — CAD facts for the unit-installation tutorial (v2.0)
=====================================================================

Reads the grouped assembly STEP (MF-550-210-B_GROUPED_ASSEMBLY) and writes
pipeline/unit/unit-analysis.json with, for every leaf part (world frame, millimetres,
Y up, as in the STEP):

  name, group (top-level group or null), bbox, centre
  for fasteners (rivets, screws, bolts, nuts, washers, clip nuts, strain relief):
    axis       unit vector pointing from the tip towards the head (= the side it is
               inserted from); for nuts/washers: towards the side they are fitted from
    head, tip  points on the axis at both ends of the part
    measured   diameters of the cylindrical faces along the axis, length, widths across
               flats of the hex (planar faces parallel to the axis)
    contacts   parts within 0.25 mm (exact B-rep distance)

Nothing here is a specification: the STEP carries no part numbers or descriptions,
so every size is a measurement of the modelled geometry (see the engineering report).

Usage: python3 pipeline/unit/analyse_unit.py path/to/MF-550-210-B_GROUPED_ASSEMBLY.step
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.OCP.collections import Sequence_TDF_Label as Seq
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

HERE = Path(__file__).resolve().parent
FASTENER = re.compile(r"Rivet|Nut|Screw|Bolt|Washer|Clip Nut|Strain Relief", re.I)
CONTACT_TOL = 0.25


def clean(n: str) -> str:
    return re.sub(r":\d+$", "", n)


def load(path):
    doc = TDocStd_Document(TCollection_ExtendedString("d"))
    r = STEPCAFControl_Reader(); r.SetNameMode(True)
    if r.ReadFile(path) != IFSelect_RetDone:
        raise SystemExit(f"cannot read {path}")
    r.Transfer(doc)
    return XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()), doc


def label_name(l):
    a = TDataStd_Name()
    return a.Get().ToExtString() if l.FindAttribute(TDataStd_Name.GetID_s(), a) else ""


def leaves(st):
    """[(name, group, located shape)] for every leaf part; group = top-level sub-assembly."""
    out = []

    def walk(l, loc, group, depth):
        ref = TDF_Label(); p = l; n = label_name(l)
        if XCAFDoc_ShapeTool.IsReference_s(l):
            XCAFDoc_ShapeTool.GetReferredShape_s(l, ref); p = ref
            loc = loc.Multiplied(XCAFDoc_ShapeTool.GetLocation_s(l))
        n = clean(n or label_name(p))
        if XCAFDoc_ShapeTool.IsAssembly_s(p):
            s = Seq(); XCAFDoc_ShapeTool.GetComponents_s(p, s, False)
            for i in range(s.Length()):
                walk(s.Value(i + 1), loc, n if depth == 1 else group, depth + 1)
            return
        out.append((n, group, XCAFDoc_ShapeTool.GetShape_s(p).Located(loc)))

    roots = Seq(); st.GetFreeShapes(roots)
    for i in range(roots.Length()):
        walk(roots.Value(i + 1), TopLoc_Location(), None, 0)
    return out


def bbox(shape, gap=0.0):
    b = Bnd_Box(); BRepBndLib.Add_s(shape, b, True)
    if gap: b.Enlarge(gap)
    return b


def box_list(b):
    p1, p2 = b.CornerMin(), b.CornerMax()
    return [round(v, 3) for v in (p1.X(), p1.Y(), p1.Z(), p2.X(), p2.Y(), p2.Z())]


def faces(shape):
    e = TopExp_Explorer(shape, TopAbs_FACE)
    while e.More():
        yield TopoDS.Face(e.Current()); e.Next()


def measure(shape):
    """Axis, head/tip ends and measured sizes of an axisymmetric fastener (world frame)."""
    cyl, planes = [], []
    for f in faces(shape):
        s = BRepAdaptor_Surface(f)
        g = GProp_GProps(); BRepGProp.SurfaceProperties_s(f, g)
        b = bbox(f); p1, p2 = b.CornerMin(), b.CornerMax()
        corners = np.array([(x, y, z) for x in (p1.X(), p2.X()) for y in (p1.Y(), p2.Y()) for z in (p1.Z(), p2.Z())])
        if s.GetType() == GeomAbs_Cylinder:
            c = s.Cylinder(); ax = c.Axis(); d = ax.Direction(); o = ax.Location()
            cyl.append(dict(r=c.Radius(), d=np.array([d.X(), d.Y(), d.Z()]), o=np.array([o.X(), o.Y(), o.Z()]), area=g.Mass(), corners=corners))
        elif s.GetType() == GeomAbs_Plane:
            pl = s.Plane(); ax = pl.Axis(); d = ax.Direction(); o = ax.Location()
            planes.append(dict(n=np.array([d.X(), d.Y(), d.Z()]), o=np.array([o.X(), o.Y(), o.Z()]), area=g.Mass(), corners=corners))
    if not cyl:
        return None
    groups = []
    for c in cyl:
        for gr in groups:
            if abs(abs(gr["d"] @ c["d"]) - 1) < 1e-4:
                gr["area"] += c["area"]; break
        else:
            groups.append(dict(d=c["d"], o=c["o"], area=c["area"]))
    g = max(groups, key=lambda x: x["area"])
    A, O = g["d"] / np.linalg.norm(g["d"]), g["o"]
    allc = np.vstack([c["corners"] for c in cyl] + [p["corners"] for p in planes])
    t = (allc - O) @ A
    lo, hi = float(t.min()), float(t.max())
    # radial extent of the geometry near each end decides which end is the head
    def radial(c): q = c - O; return np.linalg.norm(q - np.outer(q @ A, A), axis=1)
    wide_lo = wide_hi = 0.0
    L = hi - lo
    for item in cyl + planes:
        ta = (item["corners"] - O) @ A
        r = float(np.max(radial(item["corners"]))) if "r" not in item else item["r"]
        if ta.min() < lo + 0.25 * L: wide_lo = max(wide_lo, r)
        if ta.max() > hi - 0.25 * L: wide_hi = max(wide_hi, r)
    head_hi = wide_hi >= wide_lo
    axis = A if head_hi else -A
    centre_line = O + A * ((lo + hi) / 2)
    # project the centre of the part onto the axis line through O
    head = O + A * (hi if head_hi else lo)
    tip = O + A * (lo if head_hi else hi)
    cyls = defaultdict(lambda: [1e9, -1e9, 0.0])
    for c in cyl:
        if abs(abs(c["d"] @ A) - 1) > 1e-3: continue
        k = round(2 * c["r"], 3); ta = (c["corners"] - O) @ A
        cyls[k][0] = min(cyls[k][0], ta.min()); cyls[k][1] = max(cyls[k][1], ta.max()); cyls[k][2] += c["area"]
    flats = defaultdict(float)
    for p in planes:
        if abs(p["n"] @ A) < 1e-3:
            flats[round(2 * abs((p["o"] - O) @ p["n"]), 2)] += p["area"]
    ends = sorted([(lo, hi)])
    return dict(
        axis=[round(float(v), 5) for v in axis],
        head=[round(float(v), 3) for v in head], tip=[round(float(v), 3) for v in tip],
        length=round(L, 3),
        cylinders=[dict(d=k, from_head=round((hi - v[1]) if head_hi else (v[0] - lo), 3), len=round(v[1] - v[0], 3))
                   for k, v in sorted(cyls.items())],
        across_flats=sorted(k for k, a in flats.items() if a > 0.5),
    )


def tessellate(shape, defl=0.4):
    BRepMesh_IncrementalMesh(shape, defl, False, 0.5, True)
    V, F = [], []
    for f in faces(shape):
        L = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(f, L)
        if tri is None: continue
        tr = L.Transformation(); base = len(V)
        for i in range(1, tri.NbNodes() + 1):
            p = tri.Node(i).Transformed(tr); V.append((p.X(), p.Y(), p.Z()))
        rev = f.Orientation() == TopAbs_REVERSED
        for i in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(i).Get()
            F.append((base + a - 1, base + c - 1, base + b - 1) if rev else (base + a - 1, base + b - 1, base + c - 1))
    return np.array(V, float), np.array(F, int)


def main():
    step = sys.argv[1]
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "unit-analysis.json"
    st, _doc = load(step)
    items = leaves(st)
    names = [n for n, _, _ in items]
    dup = {n for n in names if names.count(n) > 1}
    if dup: raise SystemExit(f"duplicate part names: {sorted(dup)}")
    parts = {}
    boxes = {}
    for n, g, shp in items:
        b = bbox(shp); bl = box_list(b)
        boxes[n] = (bbox(shp, CONTACT_TOL + 0.5), shp)
        parts[n] = dict(name=n, group=g, bbox=bl,
                        centre=[round((bl[i] + bl[i + 3]) / 2, 3) for i in range(3)],
                        fastener=bool(FASTENER.search(n)) and not n.startswith("Spring Nut Angle"))
    for n, p in parts.items():
        if not p["fastener"]: continue
        m = measure(boxes[n][1])
        if m: p.update(m)
        bx = boxes[n][0]; contacts = []
        for o, (ob, oshp) in boxes.items():
            if o == n or ob.IsOut(bx): continue
            d = BRepExtrema_DistShapeShape(boxes[n][1], oshp)
            if d.IsDone() and d.Value() < CONTACT_TOL: contacts.append(o)
        p["contacts"] = sorted(contacts)
    # coarse meshes for the path check (pipeline/unit/plan_paths.py)
    mesh_dir = HERE / ".cache"; mesh_dir.mkdir(exist_ok=True)
    arrays = {}
    for n, g, shp in items:
        V, F = tessellate(shp)
        arrays[f"V::{n}"] = V.astype(np.float32); arrays[f"F::{n}"] = F.astype(np.int32)
    np.savez_compressed(mesh_dir / "meshes.npz", **arrays)
    json.dump(dict(source=Path(step).name, units="mm", up="Y", front="+X (access door)",
                   parts=parts), open(out, "w"), indent=1)
    print(f"{len(parts)} parts, {sum(p['fastener'] for p in parts.values())} fasteners -> {out}")


if __name__ == "__main__":
    main()
