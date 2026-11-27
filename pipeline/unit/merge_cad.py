#!/usr/bin/env python3
"""
merge_cad.py — the unit CAD used from v2.2 (one STEP for the regeneration chain)
=================================================================================

Inputs (supplied files, not tracked in git):
  MF-550-210-B_GROUPED_ASSEMBLY_03.step   the current grouped assembly: the cable strain relief and its nut
                                          are replaced by the L_Connector group (NPTA12 L body with seal,
                                          sealing nut, locknut, O-ring); every other part is unchanged
  MF-550-210-B_GROUPED_ASSEMBLY.step      previous revision: source of the Impeller Guard solid, whose
                                          geometry is EMPTY in _03 (0 solids, 0 faces — an export defect)
  cshm_06.stp                             the supplied electrical connector insert (6 poles + PE). It is
                                          NOT part of _03, so its position is not defined by the CAD:
                                          it is placed below the L-connector outlet (CONNECTOR below),
                                          a documented assumption flagged in the engineering report

Output: one STEP with the _03 structure + the guard solid + the connector insert as a top-level part
"CSHM 06 Connector Insert". The insert keeps its real geometry and dimensions (rigid placement only).

v2.3 (engineering refinement), placements and sizes in cad_extras.py:
  * the insert sits inside the connector hood at the lower left of the back panel (CableDisposition photos)
  * "Connector Hood": connector_cover_approx.step (APPROXIMATE faceted model, dimensions assumed), scaled to
    the photographed envelope so that it encloses the insert; its cable gland keeps a round section
  * "Data Tag": 0.8 mm plate with two holes under the back panel screws (10)/(11), size from the photos
  * the four L-connector parts are coloured black (face colours, so the converter keeps them)

Usage:
  python3 pipeline/unit/merge_cad.py _03.step OLD.step cshm_06.stp OUT.step [connector_cover_approx.step]
then the usual chain (docs/unit-tutorial.md § 2): convert_step.py OUT.step, analyse_unit.py OUT.step, build.
"""
from __future__ import annotations

import re
import sys

import numpy as np
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf
from OCP.TopoDS import TopoDS
from OCP.IFSelect import IFSelect_RetDone
from OCP.OCP.collections import Sequence_TDF_Label as Seq
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Reader, STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

CONNECTOR_NAME = "CSHM 06 Connector Insert"
# Placement of the insert, the hood and the data tag: cad_extras.py (shared with steps_unit.py)
import os as _os
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from cad_extras import (CONNECTOR, CONNECTOR_RGB, DATA_TAG, HOOD, L_CONNECTOR_PARTS, L_CONNECTOR_RGB,  # noqa: E402
                        BACK_FACE_X)


def read_doc(path):
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    r = STEPCAFControl_Reader(); r.SetNameMode(True); r.SetColorMode(True); r.SetLayerMode(False)
    if r.ReadFile(path) != IFSelect_RetDone: raise SystemExit(f"cannot read {path}")
    r.Transfer(doc)
    return doc, XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())


def name(lab):
    a = TDataStd_Name()
    return a.Get().ToExtString() if lab.FindAttribute(TDataStd_Name.GetID_s(), a) else ""


def labels(st):
    s = Seq(); st.GetShapes(s)
    return [s.Value(i) for i in range(1, s.Length() + 1)]


def nfaces(shape):
    e = TopExp_Explorer(shape, TopAbs_FACE); n = 0
    while e.More(): n += 1; e.Next()
    return n


def instances_of(st, proto_name):
    """(instance label, parent assembly label) of every component referring to a prototype name."""
    out = []
    for lab in labels(st):
        if not XCAFDoc_ShapeTool.IsAssembly_s(lab): continue
        kids = Seq(); XCAFDoc_ShapeTool.GetComponents_s(lab, kids)
        for i in range(1, kids.Length() + 1):
            k = kids.Value(i); ref = TDF_Label()
            if XCAFDoc_ShapeTool.GetReferredShape_s(k, ref) and name(ref) == proto_name: out.append((k, lab, ref))
    return out


def trsf_matrix(loc):
    t = loc.Transformation(); m = np.eye(4)
    for i in range(3):
        for j in range(4): m[i, j] = t.Value(i + 1, j + 1)
    return m


def colour_faces(st, ct, lab, rgb):
    """Colour every face of a prototype (sub-shape labels): the converter reads face colours."""
    col = Quantity_Color(*rgb, Quantity_TOC_RGB)
    ct.SetColor(lab, col, XCAFDoc_ColorSurf)
    e = TopExp_Explorer(XCAFDoc_ShapeTool.GetShape_s(lab), TopAbs_FACE); n = 0
    while e.More():
        sub = st.AddSubShape(lab, e.Current())
        if not sub.IsNull(): ct.SetColor(sub, col, XCAFDoc_ColorSurf); n += 1
        e.Next()
    return n


def faceted_step_meshes(path):
    """Triangles of a FACETED_BREP STEP (POLY_LOOP faces) per CLOSED_SHELL: [(name, (n, 3, 3) array)]."""
    txt = open(path).read()
    ent = {int(m.group(1)): (m.group(2), m.group(3)) for m in re.finditer(r"#(\d+)=([A-Z_]+)\((.*?)\);\s*\n", txt, re.S)}
    refs = lambda a: [int(x) for x in re.findall(r"#(\d+)", a)]
    pt = {k: np.array([float(x) for x in re.search(r"\(([^()]*)\)\s*$", a).group(1).split(",")]) for k, (t, a) in ent.items() if t == "CARTESIAN_POINT"}
    vp = {k: refs(a)[0] for k, (t, a) in ent.items() if t == "VERTEX_POINT"}
    out = []
    for k, (t, a) in ent.items():
        if t != "CLOSED_SHELL": continue
        tris = []
        for f in refs(a):
            fb = refs(ent[f][1])[0]; pl = refs(ent[fb][1])[0]
            P = [pt[vp.get(i, i)] for i in refs(ent[pl][1])]
            tris += [[P[0], P[j], P[j + 1]] for j in range(1, len(P) - 1)]
        out.append((re.search(r"'([^']*)'", a).group(1), np.array(tris)))
    return out


def hood_vertex_map(p):
    """Approximate cover frame -> model frame (cad_extras.HOOD): cover z (gland -> open end) runs down from
    y_top to y_open; body scaled to the photographed envelope, the gland kept round."""
    H = HOOD; z0, z1 = -9.0, 64.8
    u = min(1.0, max(0.0, (p[2] - H["gland_to"]) / (H["blend_to"] - H["gland_to"])))
    sx = H["gland_scale"] * (1 - u) + H["body_scale"][0] * u
    sz = H["gland_scale"] * (1 - u) + H["body_scale"][1] * u
    y = H["y_top"] - (p[2] - z0) / (z1 - z0) * (H["y_top"] - H["y_open"])
    return gp_Pnt(float(H["axis_x"] + p[0] * sx), float(y), float(H["axis_z"] + p[1] * sz))


def hood_solid(path):
    sew = BRepBuilderAPI_Sewing(1e-3); n = 0
    shells = faceted_step_meshes(path)
    # the cover body only: the two other shells are 18 x 0.7 mm raised lines on its face (would be separate parts)
    for name, T in [max(shells, key=lambda s: len(s[1]))]:
        for tri in T:
            P = [hood_vertex_map(v) for v in tri]
            if P[0].Distance(P[1]) < 1e-6 or P[1].Distance(P[2]) < 1e-6 or P[0].Distance(P[2]) < 1e-6: continue
            poly = BRepBuilderAPI_MakePolygon(P[0], P[1], P[2], True)
            f = BRepBuilderAPI_MakeFace(poly.Wire(), True)
            if f.IsDone(): sew.Add(f.Face()); n += 1
    sew.Perform(); sh = sew.SewedShape()
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound
    comp = TopoDS_Compound(); bb = BRep_Builder(); bb.MakeCompound(comp)
    e = TopExp_Explorer(sh, TopAbs_SHELL); k = 0
    while e.More():
        ms = BRepBuilderAPI_MakeSolid(TopoDS.Shell(e.Current()) if hasattr(TopoDS, "Shell") else TopoDS.Shell_s(e.Current()))
        bb.Add(comp, ms.Solid() if ms.IsDone() else e.Current()); k += 1; e.Next()
    print(f"Connector Hood: {n} facets sewn into {k} shell(s)")
    return comp


def data_tag_solid():
    D = DATA_TAG; t = D["thickness"]; zc, yc = D["centre"]
    box = BRepPrimAPI_MakeBox(gp_Pnt(BACK_FACE_X - t, yc - D["height"] / 2, zc - D["width"] / 2), t, D["height"], D["width"]).Shape()
    for z, y in D["holes"]:
        cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(BACK_FACE_X - t - 1, y, z), gp_Dir(1, 0, 0)), D["hole_d"] / 2, t + 2).Shape()
        box = BRepAlgoAPI_Cut(box, cyl).Shape()
    return box


def add_top_part(st, ct, root, shape, name, rgb):
    lab = st.AddShape(shape, False)
    TDataStd_Name.Set_s(lab, TCollection_ExtendedString(name))
    nf = colour_faces(st, ct, lab, rgb)
    comp = st.AddComponent(root, lab, TopLoc_Location())
    TDataStd_Name.Set_s(comp, TCollection_ExtendedString(name + ":1"))
    print(f"{name}: added under the root assembly ({nf} faces coloured)")


def main():
    p03, pold, pconn, out = sys.argv[1:5]
    pcover = sys.argv[5] if len(sys.argv) > 5 else None
    doc, st = read_doc(p03)
    doc_old, st_old = read_doc(pold)          # keep the document alive: its shapes are used below

    # 1. Impeller Guard: geometry from the previous revision (same instance placement checked)
    new = instances_of(st, "Impeller Guard"); old = instances_of(st_old, "Impeller Guard")
    assert len(new) == 1 and len(old) == 1, (len(new), len(old))
    (ki, _, proto), (ko, _, proto_old) = new[0], old[0]
    assert nfaces(XCAFDoc_ShapeTool.GetShape_s(proto)) == 0, "Impeller Guard is not empty in _03 any more: no merge needed"
    mi, mo = trsf_matrix(XCAFDoc_ShapeTool.GetLocation_s(ki)), trsf_matrix(XCAFDoc_ShapeTool.GetLocation_s(ko))
    assert np.abs(mi - mo).max() < 1e-6, "guard instance placement differs between revisions"
    st.SetShape(proto, XCAFDoc_ShapeTool.GetShape_s(proto_old))
    print(f"Impeller Guard: {nfaces(XCAFDoc_ShapeTool.GetShape_s(proto))} faces from the previous revision")

    # 2. CSHM 06 connector insert: rigid placement (real geometry and dimensions)
    r = STEPControl_Reader()
    if r.ReadFile(pconn) != IFSelect_RetDone: raise SystemExit(f"cannot read {pconn}")
    r.TransferRoots(); shape = r.OneShape()
    R = np.array(CONNECTOR["R"], float); c = np.array(CONNECTOR["centre"]) - R @ np.array(CONNECTOR["centre_local"])
    assert abs(np.linalg.det(R) - 1) < 1e-9
    T = gp_Trsf(); T.SetValues(*map(float, R[0]), float(c[0]), *map(float, R[1]), float(c[1]), *map(float, R[2]), float(c[2]))
    lab = st.AddShape(shape, False)
    TDataStd_Name.Set_s(lab, TCollection_ExtendedString(CONNECTOR_NAME))
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    colour_faces(st, ct, lab, CONNECTOR_RGB)
    free = Seq(); st.GetFreeShapes(free)
    root = [free.Value(i) for i in range(1, free.Length() + 1) if XCAFDoc_ShapeTool.IsAssembly_s(free.Value(i))][0]
    comp = st.AddComponent(root, lab, TopLoc_Location(T))
    TDataStd_Name.Set_s(comp, TCollection_ExtendedString(CONNECTOR_NAME + ":1"))   # instance naming as in the STEP reader
    print(f"{CONNECTOR_NAME}: placed under the root assembly '{name(root)}'")

    # 3. v2.3: L-connector black; connector hood (approximate); data tag
    for pn in L_CONNECTOR_PARTS:
        protos = [ref for _, _, ref in instances_of(st, pn)]
        assert protos, f"{pn} not found"
        for ref in protos: print(f"{pn}: {colour_faces(st, ct, ref, L_CONNECTOR_RGB)} faces black")
    if pcover: add_top_part(st, ct, root, hood_solid(pcover), HOOD["name"], HOOD["rgb"])
    add_top_part(st, ct, root, data_tag_solid(), DATA_TAG["name"], DATA_TAG["rgb"])
    st.UpdateAssemblies()

    w = STEPCAFControl_Writer(); w.SetNameMode(True); w.SetColorMode(True); w.SetLayerMode(False)
    w.Transfer(doc, STEPControl_AsIs)
    if w.Write(out) != IFSelect_RetDone: raise SystemExit("STEP write failed")
    print("written", out)


if __name__ == "__main__":
    main()
