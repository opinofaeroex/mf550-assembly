#!/usr/bin/env python3
"""
STEP -> GLB + assembly metadata conversion pipeline
====================================================

Converts a CAD STEP file (AP203/AP214/AP242) into:

  * <out>/<product>.glb      glTF 2.0 binary, metres, Y-up, one node per CAD component
  * <out>/assembly.json      hierarchy, BOM, geometric properties, exploded-view
                             vectors and a derived assembly sequence

Engine: OpenCascade Technology (OCCT) through the `cadquery-ocp` Python bindings.
The browser never parses STEP; it only loads the GLB + JSON produced here.

Hierarchy recovery
------------------
STEP files can carry an assembly in two ways:
  1. a true product structure (PRODUCT / NEXT_ASSEMBLY_USAGE_OCCURRENCE), or
  2. a single multi-body part whose solid bodies are named by the CAD system.
SolidWorks "Save Assembly as Part" produces (2) and encodes the component path
into each body name, e.g.

    M05SAB-2101-XB-1/M05SBB-0022-XC-1/099MHM-0012-3-solid1
    |_ sub-assembly  |_ sub-sub-asm   |_ part file + instance no. + body no.

This script supports both: it walks the XCAF tree for real assemblies and
parses body-name paths for multi-body parts (the case of MF-550-210-B.STEP).

Usage
-----
    python3 pipeline/convert_step.py path/to/model.STEP --out public/assets/model
    python3 pipeline/convert_step.py model.STEP --out public/assets/model --no-compress
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import struct
import subprocess
import sys
import time
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.BRepLib import BRepLib_ToolTriangulatedShape
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.OCP.collections import (
    IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as ShapeIndexedMap,
    Sequence_TDF_Label as LabelSequence,
)
from OCP.Quantity import Quantity_Color
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_DocumentTool

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
DEFAULT_COLOR = (0.6, 0.6, 0.6)  # linear RGB, only used if the STEP has no colour


def log(msg: str) -> None:
    print(f"[convert] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 1. STEP loading
# ---------------------------------------------------------------------------
@dataclass
class Body:
    raw_name: str
    solid: object
    face_colors: list            # linear RGB per face (TopExp_Explorer order)
    # filled later
    path: list = field(default_factory=list)       # [(segment, base, instance)]
    volume: float = 0.0          # mm^3
    centroid: np.ndarray = None  # mm
    bbox_min: np.ndarray = None
    bbox_max: np.ndarray = None
    moments: tuple = None
    axes: np.ndarray = None      # 3x3 rows = principal axes
    brep_vertices: np.ndarray = None
    n_faces: int = 0


def load_step(path: str):
    t0 = time.time()
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetLayerMode(False)
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise RuntimeError(f"OpenCascade could not read STEP file: {path}")
    if not reader.Transfer(doc):
        raise RuntimeError("STEP transfer to XCAF document failed")
    log(f"STEP read + transfer in {time.time() - t0:.1f}s")

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    transfer = reader.Reader().WS().TransferReader()

    def entity_name(shape):
        ent = transfer.EntityFromShapeResult(shape, 1)
        if ent is None:
            return None
        try:
            return ent.Name().ToCString()
        except Exception:
            return None

    free = LabelSequence()
    shape_tool.GetFreeShapes(free)
    if free.Length() == 0:
        raise RuntimeError("STEP file contains no shapes")

    bodies: list[Body] = []
    assembly_mode = any(shape_tool.IsAssembly_s(free.Value(i)) for i in range(1, free.Length() + 1))
    if assembly_mode:
        # Real product structure (NAUO). Flatten to bodies with a component path.
        bodies = _bodies_from_xcaf_assembly(shape_tool, free, entity_name)
    else:
        bodies = _bodies_from_multibody_part(shape_tool, free, entity_name)
    product = getattr(_bodies_from_xcaf_assembly, "root_name", None) if assembly_mode else None
    for i in range(1, free.Length() + 1):
        product = product or entity_name(shape_tool.GetShape_s(free.Value(i)))
    return doc, bodies, assembly_mode, (product or Path(path).stem)


def _face_color_map(shape_tool, label):
    """Collect face/solid colours stored on sub-shape labels."""
    subs = LabelSequence()
    shape_tool.GetSubShapes_s(label, subs)
    fmap, fcols, smap, scols = ShapeIndexedMap(), [None], ShapeIndexedMap(), [None]
    col = Quantity_Color()
    for i in range(1, subs.Length() + 1):
        lab = subs.Value(i)
        shp = shape_tool.GetShape_s(lab)
        if not XCAFDoc_ColorTool.GetColor_s(lab, XCAFDoc_ColorType.XCAFDoc_ColorSurf, col) and \
           not XCAFDoc_ColorTool.GetColor_s(lab, XCAFDoc_ColorType.XCAFDoc_ColorGen, col):
            continue
        rgb = (col.Red(), col.Green(), col.Blue())   # OCCT stores linear RGB
        if shp.ShapeType() == TopAbs_FACE:
            fmap.Add(shp); fcols.append(rgb)
        elif shp.ShapeType() == TopAbs_SOLID:
            smap.Add(shp); scols.append(rgb)
    return fmap, fcols, smap, scols


def _solid_face_colors(solid, fmap, fcols, solid_rgb):
    out = []
    ex = TopExp_Explorer(solid, TopAbs_FACE)
    while ex.More():
        idx = fmap.FindIndex(ex.Current())
        out.append(fcols[idx] if idx > 0 else solid_rgb)
        ex.Next()
    return out


def _bodies_from_multibody_part(shape_tool, free, entity_name):
    bodies = []
    for i in range(1, free.Length() + 1):
        label = free.Value(i)
        root = shape_tool.GetShape_s(label)
        fmap, fcols, smap, scols = _face_color_map(shape_tool, label)
        ex = TopExp_Explorer(root, TopAbs_SOLID)
        k = 0
        while ex.More():
            solid = ex.Current()
            k += 1
            name = entity_name(solid) or f"Body-{k}-solid1"
            sidx = smap.FindIndex(solid)
            srgb = scols[sidx] if sidx > 0 else DEFAULT_COLOR
            bodies.append(Body(name, solid, _solid_face_colors(solid, fmap, fcols, srgb)))
            ex.Next()
    return bodies


def _bodies_from_xcaf_assembly(shape_tool, free, entity_name):
    """Generic path for STEP files with a real assembly structure.
    Produces body names of the form 'Comp-1/SubComp-2/Part-3-solid1' so the
    rest of the pipeline treats both cases identically."""
    from OCP.TDF import TDF_Label
    from OCP.TDataStd import TDataStd_Name
    from OCP.TCollection import TCollection_AsciiString
    bodies = []

    def label_name(lab):
        # product / component names are stored as TDataStd_Name on definition labels
        attr = TDataStd_Name()
        if lab.FindAttribute(TDataStd_Name.GetID_s(), attr):
            return TCollection_AsciiString(attr.Get()).ToCString() or None
        return None

    def walk(label, prefix, loc):
        shape = shape_tool.GetShape_s(label)
        comps = LabelSequence()
        if shape_tool.IsAssembly_s(label):
            shape_tool.GetComponents_s(label, comps, False)
            counters = defaultdict(int)
            for j in range(1, comps.Length() + 1):
                comp = comps.Value(j)
                ref = TDF_Label()
                shape_tool.GetReferredShape_s(comp, ref)
                cname = label_name(ref) or entity_name(shape_tool.GetShape_s(ref)) or f"Component{j}"
                counters[cname] += 1
                seg = f"{cname}-{counters[cname]}"
                walk(ref, prefix + [seg], loc.Multiplied(shape_tool.GetLocation_s(comp)))
        else:
            fmap, fcols, smap, scols = _face_color_map(shape_tool, label)
            ex = TopExp_Explorer(shape, TopAbs_SOLID)
            n = 0
            while ex.More():
                n += 1
                solid = ex.Current().Moved(loc)
                srgb = DEFAULT_COLOR
                body_name = "/".join(prefix) + f"-solid{n}"
                bodies.append(Body(body_name, solid,
                                   _solid_face_colors(ex.Current(), fmap, fcols, srgb)))
                ex.Next()

    for i in range(1, free.Length() + 1):
        walk(free.Value(i), [], TopLoc_Location())
    _bodies_from_xcaf_assembly.root_name = label_name(free.Value(1))
    return bodies


# ---------------------------------------------------------------------------
# 2. Name parsing -> component paths
# ---------------------------------------------------------------------------
SEG_RE = re.compile(r"^(.*)-(\d+)$")


def parse_body_name(name: str):
    """'A-1/B-2/part-3-solid1' -> [('A-1','A',1), ('B-2','B',2), ('part-3','part',3)]"""
    name = re.sub(r"-solid\d+$", "", name.strip())
    out = []
    for seg in name.split("/"):
        m = SEG_RE.match(seg)
        if m and m.group(1):
            out.append((seg, m.group(1), int(m.group(2))))
        else:
            out.append((seg, seg, None))
    return out


# ---------------------------------------------------------------------------
# 3. Geometric properties
# ---------------------------------------------------------------------------
def analyse_body(b: Body):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(b.solid, props)
    b.volume = abs(props.Mass())
    c = props.CentreOfMass()
    b.centroid = np.array([c.X(), c.Y(), c.Z()])
    pp = props.PrincipalProperties()
    m = pp.Moments()
    b.moments = tuple(abs(x) for x in m)
    axes = []
    for ax in (pp.FirstAxisOfInertia(), pp.SecondAxisOfInertia(), pp.ThirdAxisOfInertia()):
        axes.append([ax.X(), ax.Y(), ax.Z()])
    b.axes = np.array(axes)

    bb = Bnd_Box()
    BRepBndLib.AddOptimal_s(b.solid, bb, False, False)
    p1, p2 = bb.CornerMin(), bb.CornerMax()
    b.bbox_min = np.array([p1.X(), p1.Y(), p1.Z()])
    b.bbox_max = np.array([p2.X(), p2.Y(), p2.Z()])

    vmap = ShapeIndexedMap()
    TopExp.MapShapes_s(b.solid, TopAbs_VERTEX, vmap)
    pts = np.empty((vmap.Extent(), 3))
    for i in range(1, vmap.Extent() + 1):
        p = BRep_Tool.Pnt_s(TopoDS.Vertex(vmap.FindKey(i)))
        pts[i - 1] = (p.X(), p.Y(), p.Z())
    b.brep_vertices = pts
    n = 0
    ex = TopExp_Explorer(b.solid, TopAbs_FACE)
    while ex.More():
        n += 1
        ex.Next()
    b.n_faces = n


def kabsch(a: np.ndarray, b: np.ndarray):
    """Rigid transform (R, t) minimising |R a + t - b|. Returns (R, t, maxdev) or None if reflection."""
    ca, cb = a.mean(0), b.mean(0)
    h = (a - ca).T @ (b - cb)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    if d == 0:
        d = 1.0
    r = vt.T @ np.diag([1.0, 1.0, d]) @ u.T
    if np.linalg.det(r) < 0:
        return None
    t = cb - r @ ca
    dev = np.abs((a @ r.T + t) - b).max()
    return r, t, dev


def rot_to_quat(r: np.ndarray):
    """3x3 rotation -> glTF quaternion [x, y, z, w]."""
    m = r
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w])
    return (q / np.linalg.norm(q)).tolist()


# ---------------------------------------------------------------------------
# 4. Tessellation
# ---------------------------------------------------------------------------
def tessellate(b: Body, cfg) -> dict:
    """Mesh a solid; return {rgb: (positions[N,3] mm, normals[N,3], indices[M,3])}."""
    tc = cfg["tessellation"]
    diag = float(np.linalg.norm(b.bbox_max - b.bbox_min))
    lin = min(max(diag * tc["relativeDeflection"], tc["minLinearDeflection"]), tc["maxLinearDeflection"])
    BRepMesh_IncrementalMesh(b.solid, lin, False, math.radians(tc["angularDeflectionDeg"]), True)

    groups: dict = OrderedDict()
    ex = TopExp_Explorer(b.solid, TopAbs_FACE)
    fi = 0
    while ex.More():
        face = TopoDS.Face(ex.Current())
        rgb = b.face_colors[fi] if fi < len(b.face_colors) else DEFAULT_COLOR
        fi += 1
        ex.Next()
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            continue
        if not tri.HasNormals():
            BRepLib_ToolTriangulatedShape.ComputeNormals_s(face, tri)
        trsf = loc.Transformation()
        identity = loc.IsIdentity()
        nn = tri.NbNodes()
        pos = np.empty((nn, 3))
        nor = np.empty((nn, 3))
        for i in range(1, nn + 1):
            p = tri.Node(i)
            if not identity:
                p = p.Transformed(trsf)
            pos[i - 1] = (p.X(), p.Y(), p.Z())
            d = tri.Normal(i)
            if not identity:
                d = d.Transformed(trsf)
            nor[i - 1] = (d.X(), d.Y(), d.Z())
        reversed_ = face.Orientation() == TopAbs_REVERSED
        if reversed_:
            nor = -nor
        nt = tri.NbTriangles()
        idx = np.empty((nt, 3), dtype=np.int64)
        for i in range(1, nt + 1):
            n1, n2, n3 = tri.Triangle(i).Get()
            idx[i - 1] = (n1 - 1, n3 - 1, n2 - 1) if reversed_ else (n1 - 1, n2 - 1, n3 - 1)
        key = tuple(round(c, 4) for c in rgb)
        g = groups.setdefault(key, [[], [], [], 0])
        g[0].append(pos); g[1].append(nor); g[2].append(idx + g[3]); g[3] += nn
    out = OrderedDict()
    for key, (ps, ns, ids, _) in groups.items():
        out[key] = (np.vstack(ps), np.vstack(ns), np.vstack(ids))
    return out


# ---------------------------------------------------------------------------
# 5. Component tree, BOM, explode vectors, assembly sequence
# ---------------------------------------------------------------------------
@dataclass
class Node:
    id: str
    segment: str            # raw CAD component instance name, e.g. 'M05SAB-2101-XB-1'
    name: str               # CAD component (file) name, e.g. 'M05SAB-2101-XB'
    instance: int | None
    kind: str               # 'assembly' | 'part'
    parent: "Node | None" = None
    children: list = field(default_factory=list)
    body: Body | None = None
    unit: bool = False      # purchased/imported sub-assembly handled as one unit
    inside_unit: bool = False
    # derived
    volume: float = 0.0
    centroid: np.ndarray = None
    bbox_min: np.ndarray = None
    bbox_max: np.ndarray = None
    explode: np.ndarray = None   # mm, in parent frame (== model frame)
    axial: dict | None = None
    mesh_index: int | None = None
    trs: dict | None = None
    step: int | None = None
    item: str | None = None
    flag: str | None = None
    batches: list | None = None

    @property
    def path(self):
        segs, n = [], self
        while n and n.parent is not None:
            segs.append(n.segment); n = n.parent
        return "/".join(reversed(segs))

    def iter(self):
        yield self
        for c in self.children:
            yield from c.iter()


def build_tree(product: str, bodies: list[Body], cfg) -> Node:
    ids = iter(f"n{i}" for i in range(100000))
    root = Node(next(ids), product, product, None, "assembly")
    index = {(): root}
    unit_res = [re.compile(p) for p in cfg["treatAsUnit"]["patterns"]]
    for b in bodies:
        b.path = parse_body_name(b.raw_name)
        parent = root
        for depth, (seg, base, inst) in enumerate(b.path):
            key = tuple(s for s, _, _ in b.path[: depth + 1])
            is_leaf = depth == len(b.path) - 1
            node = index.get(key)
            if node is None:
                node = Node(next(ids), seg, base, inst, "part" if is_leaf else "assembly", parent)
                if not is_leaf and any(r.search(base) for r in unit_res):
                    node.unit = True
                node.inside_unit = parent.unit or parent.inside_unit
                parent.children.append(node)
                index[key] = node
            if is_leaf:
                if node.body is not None:  # multiple bodies of one part -> keep as sibling body
                    extra = Node(next(ids), seg, base, inst, "part", parent)
                    extra.inside_unit = node.inside_unit
                    parent.children.append(extra)
                    node = extra
                node.body = b
            parent = node
    # aggregate geometry bottom-up
    def agg(n: Node):
        if n.kind == "part":
            b = n.body
            n.volume, n.centroid = b.volume, b.centroid
            n.bbox_min, n.bbox_max = b.bbox_min, b.bbox_max
            return
        for c in n.children:
            agg(c)
        vols = np.array([c.volume for c in n.children])
        n.volume = float(vols.sum())
        n.centroid = (np.array([c.centroid for c in n.children]) * vols[:, None]).sum(0) / max(n.volume, 1e-12)
        n.bbox_min = np.min([c.bbox_min for c in n.children], axis=0)
        n.bbox_max = np.max([c.bbox_max for c in n.children], axis=0)
    agg(root)
    return root


def part_number_of(name: str, cfg):
    return name if re.match(cfg["partNumberPattern"], name) else None


def axial_info(n: Node, parent: Node, cfg):
    """Detect axisymmetric (fastener-like) parts from principal moments of inertia."""
    if n.kind != "part":
        return None
    b = n.body
    pdiag = float(np.linalg.norm(parent.bbox_max - parent.bbox_min))
    diag = float(np.linalg.norm(b.bbox_max - b.bbox_min))
    if diag > cfg["explode"]["fastenerMaxSizeFraction"] * pdiag:
        return None
    m = np.array(b.moments)
    pairs = [(0, 1, 2), (0, 2, 1), (1, 2, 0)]
    for i, j, k in pairs:
        if abs(m[i] - m[j]) <= 0.03 * max(m[i], m[j]) and abs(m[k] - m[i]) > 0.08 * max(m[k], m[i]):
            axis = b.axes[k] / np.linalg.norm(b.axes[k])
            proj = b.brep_vertices @ axis
            lo, hi = float(proj.min()), float(proj.max())
            length = hi - lo
            mid = 0.5 * (lo + hi)
            head = float(b.centroid @ axis - mid)
            radial = b.brep_vertices - np.outer(proj, axis)
            dia = 2 * float(np.linalg.norm(radial - (b.centroid - (b.centroid @ axis) * axis), axis=1).max())
            return {"axis": axis, "length": length, "diameter": dia, "headOffset": head}
    return None


def snap_direction(v: np.ndarray, cos_snap: float):
    v = v / np.linalg.norm(v)
    k = int(np.argmax(np.abs(v)))
    if abs(v[k]) >= cos_snap:
        s = np.zeros(3); s[k] = math.copysign(1.0, v[k])
        return s
    return v


def envelope(n: Node) -> float:
    return float(np.prod(np.maximum(n.bbox_max - n.bbox_min, 1e-6)))


def base_child(asm: Node) -> Node:
    """Base component = the child with the largest bounding envelope (housing/frame),
    tie-broken by solid volume. It stays fixed in the exploded view."""
    return max(asm.children, key=lambda c: (round(envelope(c), -2), c.volume))


def fastener_rank(n: Node):
    """Order fastener groups: long (screws/bolts) -> thin (washers) -> nuts."""
    a = n.axial
    ratio = a["length"] / max(a["diameter"], 1e-6)
    if ratio >= 1.0:
        return 0
    if ratio < 0.25:
        return 1
    return 2


def _radial_plan(asm: Node, base: Node, cfg, depth: int):
    """Fallback when ray casting is unavailable: radial explode from the parent centre,
    snapped to the dominant axis; fasteners pulled along their symmetry axis."""
    ec = cfg["explode"]
    center = 0.5 * (asm.bbox_min + asm.bbox_max)
    pdiag = float(np.linalg.norm(asm.bbox_max - asm.bbox_min))
    rf = ec["radialFactor"] if depth == 0 else ec["nestedRadialFactor"]
    for c in asm.children:
        if c is base:
            c.explode = np.zeros(3); continue
        radial = 0.5 * (c.bbox_min + c.bbox_max) - center
        if c.axial:
            ax = c.axial["axis"]
            if abs(c.axial["headOffset"]) > 0.04 * c.axial["length"]:
                d = ax * math.copysign(1.0, c.axial["headOffset"])
            else:
                d = ax * (1.0 if radial @ ax >= 0 else -1.0)
            c.explode = d * (ec["fastenerPullFactor"] * c.axial["length"] + ec["fastenerExtraFraction"] * pdiag)
        else:
            r = float(np.linalg.norm(radial))
            d = np.array([0.0, 1.0, 0.0]) if r < 1e-3 * pdiag else snap_direction(radial, ec["axisSnapCosine"])
            c.explode = d * (r * rf + ec["minDistanceFraction"] * pdiag)
    groups = OrderedDict()
    for c in asm.children:
        groups.setdefault(c.name, []).append(c)

    def key(g):
        if base in g:
            return (0, 0, 0)
        if g[0].axial:
            return (2, fastener_rank(g[0]), -g[0].volume)
        return (1, 0, -max(x.volume for x in g))
    batches = sorted(groups.values(), key=key)
    if len(batches[0]) > 1:  # base shares its name with siblings: split it out
        batches[0] = [x for x in batches[0] if x is not base]
        batches.insert(0, [base])
    return batches


def plan_assemblies(root: Node, world_meshes: dict, cfg, stats: dict):
    """For every assembly level: removal directions, exploded offsets, install batches."""
    import disassembly as dis
    use_rays = cfg["disassembly"]["enabled"] and dis.AVAILABLE
    stats.update({"method": "ray-cast disassembly analysis" if use_rays else "radial (fallback)",
                  "engine": dis.ENGINE if use_rays else None, "rays": 0, "flagged": {}})

    def item_mesh(n: Node):
        if n.id in world_meshes:
            return world_meshes[n.id]
        parts = [world_meshes[p.id] for p in n.iter() if p.kind == "part"]
        V, F, N, off = [], [], [], 0
        for v, f, nn in parts:
            V.append(v); F.append(f + off); N.append(nn); off += len(v)
        world_meshes[n.id] = (np.vstack(V), np.vstack(F), np.vstack(N))
        return world_meshes[n.id]

    def visit(asm: Node, depth: int):
        for c in asm.children:
            c.axial = axial_info(c, asm, cfg)
        if asm.unit or asm.inside_unit:
            for c in asm.children:
                c.explode = np.zeros(3)
            asm.batches = None
        else:
            base = base_child(asm)
            if use_rays and len(asm.children) > 1:
                for c in asm.children:
                    item_mesh(c)
                info = {}
                batches, dirs, flags = dis.plan_level(asm, asm.children, base, world_meshes, cfg, info)
                offs = dis.explode_offsets(asm, batches, dirs, cfg, info.get("modes"))
                for c in asm.children:
                    c.explode = offs[c.id]
                    if c.id in flags:
                        c.flag = flags[c.id]
                        stats["flagged"][c.path] = flags[c.id]
                stats["rays"] += info.get("rays", 0)
                asm.batches = batches
            else:
                asm.batches = _radial_plan(asm, base, cfg, depth)
        for c in asm.children:
            if c.kind == "assembly":
                visit(c, depth + 1)

    root.explode = np.zeros(3)
    visit(root, 0)


def _signature(asm: Node):
    if asm.kind != "assembly":
        return (asm.name,)
    order = [c for b in asm.batches for c in b] if asm.batches else list(asm.children)
    return (asm.name, tuple(tuple(c.name for c in b) for b in (asm.batches or [])),
            tuple(_signature(c) for c in order if c.kind == "assembly"))


def build_sequence(root: Node, cfg):
    """Bottom-up assembly sequence: each sub-assembly is built (in the order it will
    be installed) before the parent's own install batches.  Identical sub-assemblies
    (same CAD name and structure) are then merged so they are built in shared steps."""
    steps, bom_rows = [], []
    row_index = {}
    by_id = {n.id: n for n in root.iter()}

    def visit(asm: Node, item_prefix: str, level: int):
        order = [c for b in asm.batches for c in b] if asm.batches else list(asm.children)
        rows = OrderedDict()
        for c in order:
            rows.setdefault((c.name, c.kind), []).append(c)
        for k, (key, members) in enumerate(rows.items(), 1):
            item = f"{item_prefix}{k}"
            for n in members:
                n.item = item
            first = members[0]
            if item in row_index:
                # another instance of an identical sub-assembly under the same parent:
                # one BOM line (qty per sub-assembly), all instances linked to it
                row_index[item]["nodes"] += [n.id for n in members]
                continue
            row_index[item] = {
                "item": item, "level": level, "name": first.name,
                "partNumber": part_number_of(first.name, cfg), "qty": len(members),
                "kind": "sub-assembly" if first.kind == "assembly" else "part",
                "unit": bool(first.unit), "insideUnit": bool(first.inside_unit),
                "parent": asm.id, "nodes": [n.id for n in members], "steps": [],
            }
            bom_rows.append(row_index[item])
        for c in order:
            if c.kind == "assembly":
                visit(c, f"{c.item}.", level + 1)
        if not asm.batches:
            return
        name_batches = defaultdict(int)
        for b in asm.batches:
            name_batches[b[0].name] += 1
        seen = defaultdict(int)
        for bi, b in enumerate(asm.batches):
            first = b[0]
            seen[first.name] += 1
            if bi == 0:
                verb, kind = "Position base component", "base"
            elif first.kind == "assembly":
                verb, kind = "Install sub-assembly", "subassembly"
            elif getattr(first, "hardware", False):
                verb, kind = "Fit hardware", "fasten"
            else:
                verb, kind = "Install component", "install"
            d = first.explode if first.explode is not None else np.zeros(3)
            dn = float(np.linalg.norm(d))
            steps.append({
                "kind": kind, "assembly": asm.id, "assemblyInstances": [asm.id], "_batch": bi,
                "item": first.item, "name": first.name, "partNumber": part_number_of(first.name, cfg),
                "nodes": [n.id for n in b], "verb": verb,
                "set": [seen[first.name], name_batches[first.name]] if name_batches[first.name] > 1 else None,
                "direction": r3(-d / dn, 4) if dn > 0 else None,   # install direction (model frame)
                "flag": next((n.flag for n in b if n.flag), None),
            })

    visit(root, "", 0)

    # ---- merge identical sub-assemblies (outermost first) ----
    groups = defaultdict(list)
    for n in root.iter():
        if n.kind == "assembly" and n.parent is not None and n.batches:
            groups[(n.name, _signature(n))].append(n)
    def depth(n):
        k = 0
        while n.parent is not None:
            n, k = n.parent, k + 1
        return k
    def rel(a: Node, top: Node):
        segs = []
        while a is not top:
            segs.append(a.segment); a = a.parent
        return tuple(reversed(segs))
    def subtree_ids(n):
        return {x.id for x in n.iter()}
    step_at = {}
    for st in steps:
        step_at[(st["assembly"], st["_batch"])] = st
    removed = set()
    for key, inst in sorted(groups.items(), key=lambda kv: min(depth(x) for x in kv[1])):
        if len(inst) < 2:
            continue
        pos = {id(st): k for k, st in enumerate(steps)}
        def first_step(a):
            ids = subtree_ids(a)
            return min((pos[id(st)] for st in steps if st["assembly"] in ids and id(st) not in removed),
                       default=len(steps))
        inst = sorted(inst, key=first_step)     # template = the instance built first
        tpl = inst[0]
        tpl_index = {rel(a, tpl): a for a in tpl.iter() if a.kind == "assembly"}
        for dup in inst[1:]:
            ids = subtree_ids(dup)
            for st in steps:
                if id(st) in removed or st["assembly"] not in ids:
                    continue
                a = by_id[st["assembly"]]
                ta = tpl_index.get(rel(a, dup))
                target = step_at.get((ta.id, st["_batch"])) if ta else None
                while target is not None and id(target) in removed:
                    target = target.get("_mergedInto")
                if target is None:
                    continue
                target["nodes"] += st["nodes"]
                target["assemblyInstances"] += st["assemblyInstances"]
                if not target["flag"]:
                    target["flag"] = st["flag"]
                st["_mergedInto"] = target
                removed.add(id(st))
    steps = [s for s in steps if id(s) not in removed]
    for i, st in enumerate(steps):
        st["index"] = i
        st["qty"] = len(st["nodes"])
        st.pop("_batch", None); st.pop("_mergedInto", None)
        for nid in st["nodes"]:
            by_id[nid].step = i
    for r in bom_rows:
        r["steps"] = sorted({by_id[nid].step for nid in r["nodes"] if by_id[nid].step is not None})
    bom_rows.sort(key=lambda r: [int(x) for x in r["item"].split(".")])
    return steps, bom_rows


# ---------------------------------------------------------------------------
# 6. GLB writer
# ---------------------------------------------------------------------------
class GlbWriter:
    def __init__(self):
        self.bin = bytearray()
        self.buffer_views, self.accessors = [], []

    def _view(self, data: bytes, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin.extend(data)
        bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            bv["target"] = target
        self.buffer_views.append(bv)
        return len(self.buffer_views) - 1

    def add_vec3(self, arr: np.ndarray, with_bounds: bool):
        a = np.ascontiguousarray(arr, dtype=np.float32)
        bv = self._view(a.tobytes(), 34962)
        acc = {"bufferView": bv, "componentType": 5126, "count": int(a.shape[0]), "type": "VEC3"}
        if with_bounds:
            acc["min"] = a.min(0).tolist(); acc["max"] = a.max(0).tolist()
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def add_indices(self, idx: np.ndarray, nverts: int):
        flat = idx.reshape(-1)
        if nverts < 65536:
            a = flat.astype(np.uint16); ct = 5123
        else:
            a = flat.astype(np.uint32); ct = 5125
        bv = self._view(a.tobytes(), 34963)
        self.accessors.append({"bufferView": bv, "componentType": ct, "count": int(a.size), "type": "SCALAR"})
        return len(self.accessors) - 1

    def write(self, path: Path, gltf: dict):
        gltf["buffers"] = [{"byteLength": len(self.bin)}]
        gltf["bufferViews"] = self.buffer_views
        gltf["accessors"] = self.accessors
        js = json.dumps(gltf, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        while len(self.bin) % 4:
            self.bin.append(0)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942)); f.write(self.bin)


# ---------------------------------------------------------------------------
# 7. Main
# ---------------------------------------------------------------------------
def load_bom_csv(path: str) -> dict:
    """Read an ERP/PDM BOM export. Only columns that exist are used; nothing is invented."""
    import csv
    cols = {"description": "description", "material": "material", "revision": "revision", "rev": "revision"}
    out = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            norm = {k.strip().lower().replace(" ", "").replace("_", ""): (v or "").strip() for k, v in row.items() if k}
            pn = norm.get("partnumber") or norm.get("pn") or norm.get("partno") or norm.get("itemnumber")
            if not pn:
                continue
            out[pn] = {dst: norm[src] for src, dst in cols.items() if norm.get(src)}
    return out


def lin_to_srgb(c: float) -> float:
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def r3(v, k=6):
    return [round(float(x), k) for x in v]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", help="input .STEP/.STP file")
    ap.add_argument("--out", default=str(HERE.parent / "public" / "assets" / "model"))
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--no-compress", action="store_true", help="skip gltfpack (meshopt) optimisation")
    ap.add_argument("--bom-csv", help="optional ERP/PDM BOM export (CSV with a 'PartNumber' column and any of "
                                      "'Description', 'Material', 'Revision') merged by part number")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text())
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    T0 = time.time()

    doc, bodies, assembly_mode, product = load_step(args.step)
    product = cfg.get("productName") or product
    log(f"product '{product}': {len(bodies)} solid bodies "
        f"({'XCAF assembly structure' if assembly_mode else 'multi-body part, hierarchy from body names'})")

    t = time.time()
    for b in bodies:
        analyse_body(b)
    log(f"mass properties for {len(bodies)} bodies in {time.time() - t:.1f}s")

    root = build_tree(product, bodies, cfg)
    parts = [n for n in root.iter() if n.kind == "part"]
    asms = [n for n in root.iter() if n.kind == "assembly"]
    log(f"tree: {len(asms)} assemblies, {len(parts)} part instances")

    # ---- instancing: identical geometry under the same CAD component name ----
    meshes = []          # list of dict(local=..., prims=..., canonical=node)
    by_name = defaultdict(list)
    for n in parts:
        by_name[n.name].append(n)
    tol = cfg["instancing"]["maxVertexDeviationMm"]
    t = time.time()
    shared, variants = 0, 0
    for name, nodes in by_name.items():
        canon_list = []   # [(canonical node, mesh index)]
        for n in nodes:
            b = n.body
            match = None
            if cfg["instancing"]["enabled"]:
                for cn, mi in canon_list:
                    cb = cn.body
                    if cb.n_faces != b.n_faces or len(cb.brep_vertices) != len(b.brep_vertices) or len(b.brep_vertices) < 3:
                        continue
                    if abs(cb.volume - b.volume) > 1e-5 * max(cb.volume, 1e-9):
                        continue
                    k = kabsch(cb.brep_vertices, b.brep_vertices)
                    if k and k[2] <= tol:
                        match = (cn, mi, k[0], k[1]); break
            if match:
                cn, mi, R, tt = match
                c0 = meshes[mi]["c0"]
                n.mesh_index = mi
                n.trs = {"R": R, "T": R @ c0 + tt}
                shared += 1
            else:
                prims = tessellate(b, cfg)
                c0 = 0.5 * (b.bbox_min + b.bbox_max)
                meshes.append({"prims": prims, "c0": c0, "name": name})
                n.mesh_index = len(meshes) - 1
                n.trs = {"R": np.eye(3), "T": c0}
                if canon_list:
                    variants += 1
                canon_list.append((n, n.mesh_index))
    ntri = sum(p[2].shape[0] for m in meshes for p in m["prims"].values())
    ntri_scene = sum(sum(p[2].shape[0] for p in meshes[n.mesh_index]["prims"].values()) for n in parts)
    log(f"tessellated {len(meshes)} unique meshes ({ntri:,} tris; {ntri_scene:,} rendered) "
        f"in {time.time() - t:.1f}s; {shared} instances reuse geometry; {variants} same-name geometry variants")

    # world-space meshes (mm) for the geometric disassembly analysis
    world = {}
    for n in parts:
        m = meshes[n.mesh_index]
        R, T = n.trs["R"], n.trs["T"]
        V, F, N, off = [], [], [], 0
        for pos, nor, idx in m["prims"].values():
            V.append((pos - m["c0"]) @ R.T + T); N.append(nor @ R.T); F.append(idx + off); off += len(pos)
        world[n.id] = (np.vstack(V), np.vstack(F), np.vstack(N))
    t = time.time()
    plan_stats = {}
    plan_assemblies(root, world, cfg, plan_stats)
    log(f"explode/sequence planning: {plan_stats['method']} ({plan_stats['engine']}, "
        f"{plan_stats['rays']:,} rays) in {time.time() - t:.1f}s; flagged: {len(plan_stats['flagged'])}")
    for k, v in plan_stats["flagged"].items():
        log(f"   ! {k}: {v}")
    steps, bom_rows = build_sequence(root, cfg)
    log(f"sequence: {len(steps)} steps; indented BOM rows: {len(bom_rows)}")

    # ---- glTF assembly ----
    S = 0.001  # mm -> m
    w = GlbWriter()
    materials, mat_index = [], {}
    mc = cfg["materials"]

    def material(rgb):
        if rgb not in mat_index:
            mat_index[rgb] = len(materials)
            materials.append({
                "name": "srgb_%02x%02x%02x" % tuple(int(round(lin_to_srgb(c) * 255)) for c in rgb),
                "pbrMetallicRoughness": {"baseColorFactor": [*rgb, 1.0],
                                         "metallicFactor": mc["metallic"], "roughnessFactor": mc["roughness"]},
                "doubleSided": False,
            })
        return mat_index[rgb]

    gl_meshes = []
    for m in meshes:
        prims = []
        for rgb, (pos, nor, idx) in m["prims"].items():
            local = (pos - m["c0"]) * S
            nrm = nor / np.maximum(np.linalg.norm(nor, axis=1, keepdims=True), 1e-12)
            prims.append({
                "attributes": {"POSITION": w.add_vec3(local, True), "NORMAL": w.add_vec3(nrm, False)},
                "indices": w.add_indices(idx, local.shape[0]),
                "material": material(rgb),
            })
        gl_meshes.append({"name": m["name"], "primitives": prims})

    gl_nodes = []
    node_index = {}

    def emit(n: Node):
        gi = len(gl_nodes)
        node_index[n.id] = gi
        g = {"name": n.id, "extras": {"nid": n.id, "cad": n.segment}}
        gl_nodes.append(g)
        if n.kind == "part":
            g["mesh"] = n.mesh_index
            q = rot_to_quat(n.trs["R"])
            if max(abs(q[0]), abs(q[1]), abs(q[2])) > 1e-9:
                g["rotation"] = q
            g["translation"] = r3(n.trs["T"] * S, 7)
        else:
            g["children"] = [emit(c) for c in n.children]
        return gi

    root_idx = emit(root)
    gltf = {
        "asset": {"version": "2.0", "generator": "MF-550 WebAR STEP pipeline (OpenCascade/OCP)"},
        "scene": 0,
        "scenes": [{"name": product, "nodes": [root_idx]}],
        "nodes": gl_nodes,
        "meshes": gl_meshes,
        "materials": materials,
    }
    raw = out / f"{product}.raw.glb"
    w.write(raw, gltf)
    log(f"raw GLB {raw.stat().st_size / 1e6:.1f} MB")

    final = out / f"{product}.glb"
    compressed = False
    if not args.no_compress:
        gp = shutil.which("gltfpack")
        cmd = [gp] if gp else ["npx", "--yes", "gltfpack@1.3.0"]
        # -kn keep named nodes (needed for animation), -ke keep extras, -cc meshopt compression,
        # -vp 16 high position precision (CAD tolerance), -noq off by default (quantise).
        cmd += ["-i", str(raw), "-o", str(final), "-kn", "-km", "-ke", "-cc", "-vp", "16", "-vn", "10"]
        log("optimising with gltfpack: " + " ".join(cmd[-11:]))
        try:
            subprocess.run(cmd, check=True)
            compressed = True
            raw.unlink()
        except Exception as e:  # keep the raw file as the deliverable
            log(f"gltfpack failed ({e}); shipping uncompressed GLB")
    if not compressed:
        raw.replace(final)
    log(f"final GLB {final.stat().st_size / 1e6:.2f} MB ({'meshopt-compressed' if compressed else 'uncompressed'})")

    # ---- assembly.json ----
    def node_json(n: Node):
        d = {
            "id": n.id,
            "cad": n.segment,
            "name": n.name,
            "instance": n.instance,
            "kind": n.kind,
            "parent": n.parent.id if n.parent else None,
            "children": [c.id for c in n.children],
            "path": n.path,
            "item": n.item,
            "step": n.step,
            "unit": n.unit,
            "insideUnit": n.inside_unit,
            "volumeMm3": round(n.volume, 3),
            "centroid": r3(n.centroid * S),
            "bboxMin": r3(n.bbox_min * S),
            "bboxMax": r3(n.bbox_max * S),
            "explode": r3((n.explode if n.explode is not None else np.zeros(3)) * S),
        }
        if n.flag:
            d["flag"] = n.flag
        if n.kind == "part":
            d["mesh"] = n.mesh_index
            d["faces"] = n.body.n_faces
        if n.axial:
            d["axial"] = {"axis": r3(n.axial["axis"]), "lengthMm": round(n.axial["length"], 3),
                          "diameterMm": round(n.axial["diameter"], 3)}
        return d

    for r in bom_rows:
        first = next(x for x in root.iter() if x.id == r["nodes"][0])
        r["envelopeMm"] = r3(first.bbox_max - first.bbox_min, 2)
        r["volumeMm3"] = round(first.volume, 2)
    flat = OrderedDict()
    for n in parts:
        f = flat.setdefault(n.name, {"name": n.name, "partNumber": part_number_of(n.name, cfg), "qty": 0,
                                    "nodes": [], "insideUnit": False})
        f["qty"] += 1; f["nodes"].append(n.id); f["insideUnit"] |= n.inside_unit

    bom_source = None
    if args.bom_csv:
        extra = load_bom_csv(args.bom_csv)
        hits = 0
        for r in bom_rows + list(flat.values()):
            info = extra.get(r.get("partNumber") or r["name"])
            if info:
                r.update(info); hits += 1
        bom_source = Path(args.bom_csv).name
        log(f"BOM CSV {bom_source}: {len(extra)} records, matched {hits} BOM/parts-list lines")

    meta = {
        "product": product,
        "bomSource": bom_source,
        "sourceFile": Path(args.step).name,
        "convertedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "converter": "OpenCascade (cadquery-ocp) via pipeline/convert_step.py",
        "structure": "xcaf-assembly" if assembly_mode else "multibody-part-named-bodies",
        "units": "metres (converted from STEP)",
        "upAxis": "Y",
        "bodies": len(bodies),
        "assemblies": len(asms),
        "partInstances": len(parts),
        "uniqueMeshes": len(meshes),
        "trianglesUnique": ntri,
        "trianglesRendered": ntri_scene,
        "glb": final.name,
        "glbCompressed": compressed,
        "sequenceSource": "derived: hierarchy from body names + " + plan_stats["method"] + "; STEP carries no assembly order",
        "planning": {"method": plan_stats["method"], "engine": plan_stats["engine"], "rays": plan_stats["rays"],
                     "flagged": plan_stats["flagged"]},
        "unavailable": ["description", "material", "revision", "mates/constraints", "assembly order"],
    }
    data = {
        "meta": meta,
        "root": root.id,
        "nodes": [node_json(n) for n in root.iter()],
        "bom": bom_rows,
        "partsList": list(flat.values()),
        "steps": steps,
    }
    (out / "assembly.json").write_text(json.dumps(data, indent=1))
    log(f"assembly.json written; total {time.time() - T0:.1f}s")


if __name__ == "__main__":
    main()
