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

Usage:
  python3 pipeline/unit/merge_cad.py _03.step OLD.step cshm_06.stp OUT.step
then the usual chain (docs/unit-tutorial.md § 2): convert_step.py OUT.step, analyse_unit.py OUT.step, build.
"""
from __future__ import annotations

import sys

import numpy as np
from OCP.gp import gp_Trsf
from OCP.IFSelect import IFSelect_RetDone
from OCP.OCP.collections import Sequence_TDF_Label as Seq
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Reader, STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

CONNECTOR_NAME = "CSHM 06 Connector Insert"
# Placement of the insert (mm, model frame: Y up, front = +X, back panel outer face x = -378.6):
#   wire side (+Z of the supplied model, the six contact cavities) facing UP towards the L-connector
#   outlet, mating side (pins) facing down; its long side parallel to the back panel; centred under the
#   outlet axis in Z, 10 mm further from the panel than the outlet axis so it clears the panel; its wire
#   face 103 mm below the sealing nut. ASSUMED (not in the CAD) — flagged for engineering confirmation.
CONNECTOR = dict(centre_local=(57.3, 28.7, 0.6), centre=(-406.0, -125.6, 0.0),
                 R=((0, 1, 0), (0, 0, 1), (1, 0, 0)))      # rows: model x, y, z from the local x, y, z
CONNECTOR_RGB = (0.62, 0.64, 0.66)                         # grey thermoplastic insert


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


def main():
    p03, pold, pconn, out = sys.argv[1:5]
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
    ct.SetColor(lab, Quantity_Color(*CONNECTOR_RGB, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
    free = Seq(); st.GetFreeShapes(free)
    root = [free.Value(i) for i in range(1, free.Length() + 1) if XCAFDoc_ShapeTool.IsAssembly_s(free.Value(i))][0]
    comp = st.AddComponent(root, lab, TopLoc_Location(T))
    TDataStd_Name.Set_s(comp, TCollection_ExtendedString(CONNECTOR_NAME + ":1"))   # instance naming as in the STEP reader
    st.UpdateAssemblies()
    print(f"{CONNECTOR_NAME}: placed under the root assembly '{name(root)}'")

    w = STEPCAFControl_Writer(); w.SetNameMode(True); w.SetColorMode(True); w.SetLayerMode(False)
    w.Transfer(doc, STEPControl_AsIs)
    if w.Write(out) != IFSelect_RetDone: raise SystemExit("STEP write failed")
    print("written", out)


if __name__ == "__main__":
    main()
