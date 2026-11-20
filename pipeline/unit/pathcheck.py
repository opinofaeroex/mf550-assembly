"""Ray-cast path checks for the unit tutorial (shared by build_unit.py and ad-hoc checks).

PathChecker(analysis, meshes).blocked(moving, present, d) -> fraction of rays cast from the
surfaces of the `moving` parts along unit direction d that enter a `present` part.
Uses pipeline/disassembly.py (same method as the converter's disassembly analysis).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import disassembly as dis  # noqa: E402

AXES = {"+X": (1, 0, 0), "-X": (-1, 0, 0), "+Y": (0, 1, 0), "-Y": (0, -1, 0), "+Z": (0, 0, 1), "-Z": (0, 0, -1)}


class _Item:
    def __init__(self, i): self.id = i


class PathChecker:
    def __init__(self, names, npz_path, rays=220):
        z = np.load(npz_path)
        self.names = list(names)
        meshes = {}
        for i, n in enumerate(self.names):
            V = z[f"V::{n}"].astype(float); F = z[f"F::{n}"]
            import trimesh
            vn = trimesh.Trimesh(V, F, process=False).vertex_normals
            meshes[i] = (V, F, vn)
        cfg = {"disassembly": {"raysPerItem": rays, "insetMm": 0.2, "contactEpsMm": 0.05}}
        self.la = dis.LevelAnalysis([_Item(i) for i in range(len(self.names))], meshes, cfg)
        self.idx = {n: i for i, n in enumerate(self.names)}

    def blocked(self, moving, present, d, max_dist=np.inf):
        d = np.asarray(d, float); d = d / np.linalg.norm(d)
        mv = {self.idx[n] for n in moving}
        mask = np.zeros(len(self.names), bool)
        for n in present:
            if self.idx[n] not in mv: mask[self.idx[n]] = True
        tot = blk = 0
        for i in mv:
            n, ri, it, dist = self.la.cast(i, d)
            m = mask[it] & (dist <= max_dist)
            tot += n; blk += len(np.unique(ri[m]))
        return blk / max(1, tot)

    def free_axes(self, moving, present, tol=0.01):
        return {k: round(self.blocked(moving, present, v), 3) for k, v in AXES.items()}
