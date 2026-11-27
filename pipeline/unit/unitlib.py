"""
unitlib.py — geometry, collision checks and track recording for build_unit.py (v2.0)

Frames and units
  * model frame = the STEP / GLB frame: Y up, front (+X) is the access-door face
  * everything here is in millimetres; build_unit.py converts to metres on output

A part track stores, at times t, a rigid DELTA applied to the part's CAD pose:
      D(t) = Tr(T) · R(q) · [Tr(P) · Rot(axis, angle) · Tr(-P)]
  T translation (mm), q rotation quaternion (x, y, z, w), angle = spin about the part's own
  axis through pivot P (lets a fastener turn many times without quaternion wrap-around).
D = identity is the installed CAD position, so the end of every animation is exactly the CAD.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import trimesh

from standards import COLLISION

PART_TOL = COLLISION.part_tol                # mm penetration tolerated for parts (standards § 10)

# ------------------------------------------------------------------ small math

def unit(v):
    v = np.asarray(v, float); n = np.linalg.norm(v)
    return v / n if n > 0 else v


def quat_axis_angle(axis, ang):
    a = unit(axis); s = math.sin(ang / 2)
    return np.array([a[0] * s, a[1] * s, a[2] * s, math.cos(ang / 2)])


def quat_mul(a, b):
    x1, y1, z1, w1 = a; x2, y2, z2, w2 = b
    return np.array([w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
                     w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2])


def quat_conj(q):
    x, y, z, w = q
    return np.array([-x, -y, -z, w])


def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def mat_to_quat(m):
    t = np.trace(m)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2; w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s; y = (m[0, 2] - m[2, 0]) / s; z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / s; x = 0.25 * s; y = (m[0, 1] + m[1, 0]) / s; z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / s; x = (m[0, 1] + m[1, 0]) / s; y = 0.25 * s; z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / s; x = (m[0, 2] + m[2, 0]) / s; y = (m[1, 2] + m[2, 1]) / s; z = 0.25 * s
    q = np.array([x, y, z, w]); return q / np.linalg.norm(q)


def frame_quat(y_axis, x_hint):
    """Rotation taking the tool frame (+Y working axis, +X hint) to the model frame."""
    y = unit(y_axis); x = np.asarray(x_hint, float); x = x - y * (x @ y)
    if np.linalg.norm(x) < 1e-6:
        x = np.cross(y, [0, 0, 1]) if abs(y[2]) < 0.9 else np.cross(y, [1, 0, 0])
    x = unit(x); z = np.cross(x, y)
    return mat_to_quat(np.column_stack([x, y, z]))


def perp_basis(a):
    a = unit(a); h = np.array([0, 1.0, 0]) if abs(a[1]) < 0.9 else np.array([1.0, 0, 0])
    u = unit(np.cross(a, h)); v = np.cross(a, u)
    return u, v


def delta_matrix(T, q, pivot, axis, angle):
    """4x4 of D = Tr(T)·R(q)·Tr(P)·Rot(axis,angle)·Tr(-P)."""
    M = np.eye(4); M[:3, :3] = quat_to_mat(q); M[:3, 3] = T
    if angle:
        S = np.eye(4); S[:3, :3] = quat_to_mat(quat_axis_angle(axis, angle))
        P = np.eye(4); P[:3, 3] = pivot; Pi = np.eye(4); Pi[:3, 3] = -np.asarray(pivot)
        M = M @ P @ S @ Pi
    return M


ID_Q = np.array([0.0, 0.0, 0.0, 1.0])

# ------------------------------------------------------------------ collision world

class World:
    """Static CAD meshes (mm) in a collision manager; parts are added as they get installed."""

    def __init__(self, npz_path: Path, names):
        z = np.load(npz_path)
        self.mesh = {n: trimesh.Trimesh(z[f"V::{n}"].astype(float), z[f"F::{n}"], process=False) for n in names}
        self.cm = trimesh.collision.CollisionManager()
        self.present = set()

    def add(self, names):
        for n in names:
            if n not in self.present:
                self.cm.add_object(n, self.mesh[n]); self.present.add(n)

    def remove(self, names):
        for n in names:
            if n in self.present:
                self.cm.remove_object(n); self.present.discard(n)

    _bvh = {}

    def _geom(self, mesh):
        """fcl geometry of a query mesh, built once per mesh object (trimesh rebuilds it on every query)."""
        k = id(mesh)
        g = self._bvh.get(k)
        if g is None or g[0] is not mesh:
            g = (mesh, self.cm._get_fcl_obj(mesh)); self._bvh[k] = g
        return g[1]

    def hits(self, mesh, M, allow=(), tol=PART_TOL):
        """Present parts the mesh (transformed by M) penetrates deeper than tol mm (ignoring `allow`)."""
        import fcl
        from trimesh.collision import _fcl_collision_data
        M = np.asarray(M, float)
        geom = self._geom(mesh)
        o = fcl.CollisionObject(geom, fcl.Transform(M[:3, :3], M[:3, 3]))
        cdata, callback = _fcl_collision_data(True, True)
        self.cm._manager.collide(o, cdata, callback)
        if not cdata.result.is_collision: return {}
        out = {}
        for c in cdata.result.contacts:
            cg = c.o2 if c.o1 == geom else c.o1
            n = self.cm._names.get(id(cg))
            if n is None or n in allow: continue
            out[n] = max(out.get(n, 0.0), float(c.penetration_depth))
        return {n: d for n, d in out.items() if d > tol}


def tool_mesh(cache: Path, tool: str):
    z = np.load(cache / f"tool_{tool}.npz")
    return trimesh.Trimesh(z["V"].astype(float), z["F"], process=False)
