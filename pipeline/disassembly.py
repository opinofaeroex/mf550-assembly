"""
Geometric disassembly analysis (assembly-by-disassembly)
=======================================================

STEP files carry no assembly order and no mates.  To produce an exploded view
and an assembly sequence that respect the *actual* geometry, every assembly
level is analysed as follows:

1. Each child (part or rigid sub-assembly) is represented by its real
   tessellated geometry in CAD position.
2. For each child and each candidate direction (+/-X, +/-Y, +/-Z, plus the
   symmetry axis of axisymmetric parts such as screws) rays are cast from
   points sampled on the child surface (slightly inset) along the direction.
   Every *entering* hit on another child is recorded.  Rays that start inside
   an interfering part (threads, press-fits) are therefore not blocked by
   that part's exit surface.
3. A greedy disassembly removes, at each iteration, every child that has a
   collision-free direction with respect to the children still present
   (fasteners are preferred, then small parts).  If nothing is free (e.g.
   interference in the CAD model) the least-blocked child is removed and the
   step is flagged.
4. Assembly order = reverse of removal order.  Exploded offsets follow the
   chosen removal direction and are stacked so items leaving in the same
   direction do not overlap.

Requires trimesh (+ embreex for speed).  convert_step.py falls back to a radial
explode if trimesh is unavailable.
"""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

try:
    import trimesh
    try:
        from trimesh.ray.ray_pyembree import RayMeshIntersector as _Intersector
        ENGINE = "embree"
    except Exception:  # pragma: no cover
        from trimesh.ray.ray_triangle import RayMeshIntersector as _Intersector
        ENGINE = "python"
    AVAILABLE = True
except Exception:  # pragma: no cover
    AVAILABLE = False
    ENGINE = None

AXES = [np.array(v, float) for v in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]


def _sample(v: np.ndarray, n: np.ndarray, k: int, inset: float, rng) -> np.ndarray:
    if len(v) > k:
        idx = rng.choice(len(v), k, replace=False)
        v, n = v[idx], n[idx]
    return v - n * inset


class LevelAnalysis:
    """Ray-cast blocking information for the children of one assembly."""

    def __init__(self, items, meshes, cfg):
        """items: list of objects with .id ; meshes: {id: (V[mm], F, VN)}"""
        dc = cfg["disassembly"]
        self.items = items
        self.cfg = dc
        self.idx = {it.id: i for i, it in enumerate(items)}
        vs, fs, owner, off = [], [], [], 0
        for i, it in enumerate(items):
            V, F, _ = meshes[it.id]
            vs.append(V); fs.append(F + off); owner.append(np.full(len(F), i)); off += len(V)
        self.mesh = trimesh.Trimesh(np.vstack(vs), np.vstack(fs), process=False)
        self.owner = np.concatenate(owner)
        self.fn = self.mesh.face_normals
        self.ray = _Intersector(self.mesh)
        self.rng = np.random.default_rng(0)
        self.meshes = meshes
        self.hits = {}   # (item_index, dir_key) -> list[frozenset[item_index]] per ray

    def cast(self, i: int, d: np.ndarray):
        """Entering hits on other items for rays sampled on item i, cast along d.
        Returns (n_rays, ray_index[], item[], distance[])."""
        key = (i, tuple(np.round(d, 6)))
        if key in self.hits:
            return self.hits[key]
        V, _, VN = self.meshes[self.items[i].id]
        o = _sample(V, VN, self.cfg["raysPerItem"], self.cfg["insetMm"], self.rng)
        dirs = np.tile(d, (len(o), 1))
        locs, ray_i, tri_i = self.ray.intersects_location(o, dirs, multiple_hits=True)
        if len(tri_i):
            dist = np.einsum("ij,ij->i", locs - o[ray_i], dirs[ray_i])
            own = self.owner[tri_i]
            entering = (self.fn[tri_i] @ d) < 0
            ok = (own != i) & entering & (dist > self.cfg["contactEpsMm"])
            res = (len(o), ray_i[ok], own[ok], dist[ok])
        else:
            res = (len(o), np.zeros(0, int), np.zeros(0, int), np.zeros(0))
        self.hits[key] = res
        return res

    def blocked_fraction(self, i, d, present_mask: np.ndarray, max_dist=np.inf):
        """Fraction of rays blocked by items still present within max_dist (mm)."""
        n, ri, it, dist = self.cast(i, d)
        if n == 0 or len(ri) == 0:
            return 0.0
        m = present_mask[it] & (dist <= max_dist)
        return len(np.unique(ri[m])) / n


def plan_level(asm, items, base, meshes, cfg, info):
    """Plan one assembly level.

    Phase 1 - structural parts (everything except fasteners): greedy disassembly.
      Fasteners are ignored as obstacles (they are removed before the parts they
      join), so a panel held by screws is still found to be removable.
    Phase 2 - fasteners (axisymmetric small parts): each one is pulled along its
      axis (head first when free, otherwise the free end, otherwise head first and
      flagged as captive/press-fit) and is installed right after the last of the
      structural items it touches (detected from hole-edge geometry).

    Returns (assembly_batches, directions, flags) with batches in ASSEMBLY order.
    """
    dc = cfg["disassembly"]
    ec = cfg["explode"]
    la = LevelAnalysis(items, meshes, cfg)
    n = len(items)
    bi = la.idx[base.id]
    pdiag = float(np.linalg.norm(asm.bbox_max - asm.bbox_min))
    center = 0.5 * (asm.bbox_min + asm.bbox_max)
    tol = dc["freeTolerance"]
    def is_hardware(i, it):
        if i == bi or it.kind != "part":
            return False
        size = float(np.linalg.norm(it.bbox_max - it.bbox_min))
        return it.axial is not None or size < dc["hardwareMaxSizeFraction"] * pdiag
    is_fast = np.array([is_hardware(i, it) for i, it in enumerate(items)])
    structural = [i for i in range(n) if not is_fast[i]]
    directions, flags, modes = {}, {}, {}

    def score(it, d):
        c = 0.5 * (it.bbox_min + it.bbox_max) - center
        r = np.linalg.norm(c)
        s = float(d @ (c / r)) if r > 1e-9 else 0.0
        return s + dc["upBias"] * float(d[1])

    # ---- phase 1: structural parts -------------------------------------------------
    present = set(structural)
    local_lim = ec["minDistanceFraction"] * pdiag
    removal = []
    while len(present) > 1:
        mask = np.zeros(n, bool)
        mask[list(present)] = True
        free = {}
        for i in present - {bi}:
            it = items[i]
            mask[i] = False
            best = None
            for mode, lim in (("escape", np.inf), ("local", local_lim)):
                for d in AXES:
                    if la.blocked_fraction(i, d, mask, lim) <= tol:
                        sc = score(it, d)
                        if best is None or sc > best[0]:
                            best = (sc, d, mode)
                if best:
                    break
            mask[i] = True
            if best:
                free[i] = (best[1], best[2])
        if not free:
            worst = None
            for i in present - {bi}:
                mask[i] = False
                for d in AXES:
                    f = la.blocked_fraction(i, d, mask, local_lim)
                    key = (f, -score(items[i], d))
                    if worst is None or key < worst[0]:
                        worst = (key, i, d)
                mask[i] = True
            (f, _), i, d = worst
            free = {i: (d, "blocked")}
            flags[items[i].id] = (f"enclosed: no collision-free path in the CAD geometry "
                                  f"({f:.0%} of sampled rays blocked); shown along the most open direction")
        groups = defaultdict(list)
        for i in free:
            groups[items[i].name].append(i)
        name = min(groups, key=lambda k: max(items[j].volume for j in groups[k]))
        for i in groups[name]:
            directions[items[i].id], modes[items[i].id] = free[i]
            present.discard(i)
        removal.append([items[i] for i in groups[name]])
    removal.append([base])
    directions[base.id] = np.zeros(3)
    batches = list(reversed(removal))          # assembly order of structural items
    order_of = {it.id: k for k, b in enumerate(batches) for it in b}

    # ---- phase 2: fasteners --------------------------------------------------------
    struct_mask = np.zeros(n, bool)
    struct_mask[structural] = True
    verts = {i: meshes[items[i].id][0] for i in structural}
    after = defaultdict(lambda: defaultdict(list))   # batch index -> name -> [items]
    for i in np.nonzero(is_fast)[0]:
        it = items[i]
        c = 0.5 * (it.bbox_min + it.bbox_max)
        if it.axial is not None:
            ax = np.asarray(it.axial["axis"], float)
            head = it.axial["headOffset"]
            if abs(head) > 0.04 * it.axial["length"]:
                first = ax * math.copysign(1.0, head)
            else:
                first = ax * (1.0 if (c - center) @ ax >= 0 else -1.0)
            cands, size = [first, -first], it.axial["length"]
        else:
            cands = sorted(AXES, key=lambda d: -score(it, d))
            first, size = cands[0], float(np.max(it.bbox_max - it.bbox_min))
        lim = ec["fastenerPullFactor"] * size + ec["fastenerExtraFraction"] * pdiag
        chosen = None
        for d in cands:
            if la.blocked_fraction(i, d, struct_mask, lim) <= tol:
                chosen = d
                break
        if chosen is None:
            if it.axial is None:
                chosen = min(cands, key=lambda d: la.blocked_fraction(i, d, struct_mask, lim))
            else:
                chosen = first
            if it.axial is not None:
                flags[it.id] = ("no collision-free axial path in the CAD geometry (typical for rivets, clinch "
                                "studs/nuts or threaded parts modelled with interference); shown head-first along its axis")
            else:
                flags[it.id] = ("no collision-free path in the CAD geometry (typical for clips or captive "
                                "hardware); shown along the most open direction")
        directions[it.id] = chosen
        modes[it.id] = "hardware"
        it.hw_size = size
        it.hardware = True
        # joined items: structural items with geometry inside the fastener envelope (hole edges)
        pad = 0.5
        lo, hi = it.bbox_min - pad, it.bbox_max + pad
        joined = []
        for j, v in verts.items():
            if np.any(np.all((v >= lo) & (v <= hi), axis=1)):
                joined.append(order_of[items[j].id])
        k = max(joined) if joined else 0
        after[k][it.name].append(it)

    def frank(group):
        a = group[0].axial
        if a is None:
            return 3
        ratio = a["length"] / max(a["diameter"], 1e-6)
        return 0 if ratio >= 1.0 else (1 if ratio < 0.25 else 2)

    out = []
    for k, b in enumerate(batches):
        out.append(b)
        for group in sorted(after.get(k, {}).values(), key=frank):
            out.append(group)
    info["engine"] = ENGINE
    info["rays"] = sum(v[0] for v in la.hits.values())
    info["modes"] = modes
    return out, directions, flags


def explode_offsets(asm, batches, directions, cfg, modes=None):
    """Distance along each removal direction, stacked so that items leaving in the
    same direction with overlapping footprints keep their order and do not overlap."""
    ec = cfg["explode"]
    pdiag = float(np.linalg.norm(asm.bbox_max - asm.bbox_min))
    gap = ec["stackGapFraction"] * pdiag
    offsets = {}
    placed = []  # (dir, bmin_exploded, bmax_exploded)
    order = [it for b in batches for it in b]  # assembly order; inner items are installed first
    for it in order:
        d = directions[it.id]
        if not np.any(d):
            offsets[it.id] = np.zeros(3)
            continue
        if modes and modes.get(it.id) == "hardware":
            dist = ec["fastenerPullFactor"] * getattr(it, "hw_size", 0.0) + ec["fastenerExtraFraction"] * pdiag
            offsets[it.id] = d * dist
            continue
        lo, hi = it.bbox_min, it.bbox_max
        proj_lo = _support_min(lo, hi, d)
        if modes and modes.get(it.id) != "escape":
            # only locally free: short, collision-checked move
            dist = ec["minDistanceFraction"] * pdiag
        else:
            # clear the parent envelope along d
            env_hi = _support_max(asm.bbox_min, asm.bbox_max, d)
            dist = max(env_hi - proj_lo + gap, ec["minDistanceFraction"] * pdiag)
        # stack against earlier items exploded the same way with overlapping footprint
        for pd, pmin, pmax in placed:
            if float(pd @ d) < 0.99:
                continue
            if _footprint_overlap(lo, hi, pmin, pmax, d):
                dist = max(dist, _support_max(pmin, pmax, d) - proj_lo + gap)
        offsets[it.id] = d * dist
        placed.append((d, lo + d * dist, hi + d * dist))
    return offsets


def _support_max(bmin, bmax, d):
    return float(np.maximum(bmin * d, bmax * d).sum())


def _support_min(bmin, bmax, d):
    return float(np.minimum(bmin * d, bmax * d).sum())


def _footprint_overlap(amin, amax, bmin, bmax, d):
    """Do two boxes overlap when projected on the plane perpendicular to (axis-aligned) d?"""
    k = int(np.argmax(np.abs(d)))
    for j in range(3):
        if j == k:
            continue
        if amax[j] < bmin[j] or bmax[j] < amin[j]:
            return False
    return True
