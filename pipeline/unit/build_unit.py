#!/usr/bin/env python3
"""
build_unit.py — the Mist-Fit 550 unit-installation tutorial (v2.0)
==================================================================

Inputs
  pipeline/unit/unit-analysis.json      CAD facts (analyse_unit.py): axes, heads, sizes, contacts
  pipeline/unit/.cache/meshes.npz       part meshes (mm) for collision checks
  pipeline/unit/.cache/tool_*.npz       tool meshes in their working frame (build_tools.py)
  <converter assembly.json>             convert_step.py output for MF-550-210-B_GROUPED_ASSEMBLY
  public/assets/unit/tools/tools.json   tool pivots / moving parts
  public/assets/unit/decals/decals.json decal positions (rectify_decals.py)

Output
  public/assets/unit/assembly.json      converter output whose `steps` are the authored
                                        installation steps with their animation tracks
  docs/unit-engineering-report.md       hardware table + validation + open engineering items

Every motion ends exactly at the CAD position (delta = identity). Every part path and every
tool pose is checked against the parts already installed at that point (exact mesh collision,
python-fcl); the result is stored per step (`checks`) and summarised in the report.
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, OrderedDict
from pathlib import Path

import numpy as np
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parent))
from unitlib import (ID_Q, World, delta_matrix, frame_quat, perp_basis, quat_axis_angle, quat_mul,  # noqa: E402
                     quat_to_mat, tool_mesh, unit)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE / ".cache"
M = 0.001                                    # mm -> m
PITCH = {"1/4": 1.27, "3/8": 1.5875, "M6": 1.0, "#8": 0.79, "npt": 1.814}   # visual turn counts only
SOCKET_SUPPLIED_AF = 14.2875                 # 9/16 in

# ======================================================================= hardware facts

def base_name(n): return re.sub(r"\s*\(\d+\)$", "", n)


def fmt(x, nd=2): return f"{x:.{nd}f}".rstrip("0").rstrip(".")


def head_height(p):
    """Distance from the head end to the start of the shank (largest-area slender cylinder)."""
    cyl = p.get("cylinders", [])
    if not cyl: return 0.0
    body = max(cyl, key=lambda c: c["len"])
    return float(body["from_head"])


def spec_of(name, p):
    """Specification line + status from the measured geometry (never from assumptions)."""
    b = base_name(name); cyl = {c["d"]: c for c in p.get("cylinders", [])}
    af = p.get("across_flats", []); L = p.get("length", 0)
    hh = head_height(p)
    meas = "Measured from CAD geometry"
    if b == "Motor Mounting Hex Bolt":
        return dict(type="Hex head bolt", size="Ø6.00 mm shank (M6 class)", length=f"{fmt(L - hh)} mm under head",
                    drive=f"hex head {fmt(af[0])} mm A/F (10 mm socket)", status=meas,
                    confirm="thread designation (M6 × 1.0?), length 12 mm and grade not in CAD — engineering confirmation")
    if b == "Hex Flange Bolt":
        return dict(type="Hex flange bolt", size="Ø6.35 mm (1/4 in)", length=f"{fmt(L - 7.124)} mm under flange (3/4 in)",
                    drive=f"hex {fmt(af[0])} mm A/F (3/8 in socket), flange Ø13.97 mm", status=meas,
                    confirm="thread pitch (1/4-20 UNC?) and grade not in CAD")
    if b == "Hex Flange Nut":
        return dict(type="Hex flange nut", size="Ø6.35 mm bore (1/4 in)", length=f"{fmt(L)} mm high",
                    drive=f"{fmt(af[0])} mm A/F (7/16 in)", status=meas, confirm="thread pitch not in CAD")
    if b == "Hex Nut":
        return dict(type="Hex nut", size="Ø9.525 mm bore (3/8 in)", length=f"{fmt(L)} mm high",
                    drive=f"{fmt(af[0])} mm A/F (9/16 in)", status=meas, confirm="thread pitch not in CAD")
    if b == "Filter Clamp Hex Bolt":
        return dict(type="Hex head bolt", size="Ø9.525 mm (3/8 in)", length=f"{fmt(L - hh)} mm under head (1-1/2 in)",
                    drive=f"hex {fmt(af[0])} mm A/F (9/16 in socket — the supplied socket)", status=meas,
                    confirm="thread pitch and grade not in CAD")
    if b == "Pan Head Machine Screw":
        return dict(type="Pan head machine screw", size="Ø4.09 mm", length=f"{fmt(L - hh)} mm under head (1/4 in)",
                    drive="recessed head (drive type not modelled)", status=meas,
                    confirm="thread designation ambiguous: #8 (4.17 mm) or M4 (4.00 mm) — engineering confirmation")
    if b == "Self-Tapping Pan Head Screw":
        return dict(type="Self-tapping pan head screw", size="Ø4.09 mm", length=f"{fmt(L - hh)} mm under head (3/8 in)",
                    drive="recessed head (drive type not modelled)", status=meas,
                    confirm="screw size (#8?) and thread form not in CAD")
    if b in ("Closed-End Rivet", "Blind Rivet"):
        return dict(type=b, size="Ø3.97 mm body (5/32 in)", length="6.30 mm body, Ø6.26 mm flange",
                    drive="blind-rivet gun", status=meas, confirm="grip range and material not in CAD")
    if b == "Clip Nut":
        return dict(type="Clip nut (U-type)", size="hole Ø5.16 mm (1/4-20 tap size)", length="12.3 × 24.2 × 14.5 mm",
                    drive="pressed onto the panel edge", status=meas, confirm="thread (1/4-20?) inferred from hole size only")
    if b == "External Tooth Lock Washer":
        return dict(type="External tooth lock washer", size="ID Ø6.60 mm", length="OD Ø12.70 mm, 1.27 mm",
                    drive="—", status=meas, confirm="material / standard not in CAD")
    if b == "Door Bolt Washer":
        return dict(type="Stepped washer", size="ID Ø5.56 mm", length="OD Ø15.88 mm, 3.26 mm",
                    drive="—", status="Measured from CAD — CONFLICT",
                    confirm="bore Ø5.56 mm is smaller than the Ø6.35 mm bolt: probably a sealing washer modelled compressed — confirm part")
    if b == "1_Cable Strain Relief":
        return dict(type="Cable strain relief (gland)", size="thread OD Ø21.34 mm (1/2 in NPT)", length=f"{fmt(L)} mm overall",
                    drive="hex 23.9 mm A/F", status=meas, confirm="cable clamping range not in CAD")
    if b == "2_Strain Relief Nut":
        return dict(type="Strain relief locknut", size="1/2 in NPT (to suit gland)", length=f"{fmt(L)} mm",
                    drive=f"{fmt(af[0])} mm A/F (adjustable wrench)", status=meas, confirm="—")
    return dict(type=b, size="—", length="—", drive="—", status="Not measured", confirm="specification requires engineering confirmation")


# ======================================================================= the builder

class Unit:
    def __init__(self, analysis, assembly, tools, decals):
        self.A = analysis["parts"]
        self.asm = assembly
        self.tools = tools["tools"]
        self.decals = {d["id"]: d for d in decals["decals"]}
        self.ids = {n["name"]: n["id"] for n in assembly["nodes"] if n["kind"] == "part"}
        self.A_by_id = {v: k for k, v in self.ids.items()}
        self.world = World(CACHE / "meshes.npz", list(self.A))
        self.tmesh = {t: tool_mesh(CACHE, t) for t in self.tools}
        self.steps = []
        self.installed_by = {}                    # part name -> step index

    def group(self, g): return [n for n, p in self.A.items() if p["group"] == g]

    def step(self, **kw):
        if self.steps: self._carry(self.steps[-1])
        s = Step(self, len(self.steps), **kw); self.steps.append(s); return s

    carry = {}

    def _carry(self, st):
        """Parts whose last pose in a step is not the CAD pose start the next step from there."""
        for name, tr in st.parts.items():
            k = tr["keys"][-1]
            if any(abs(v) > 1e-3 for v in k[1:4]) or abs(k[8]) > 1e-3 and abs(k[8] % (2 * math.pi)) > 1e-3:
                self.carry[name] = (np.array(k[1:4]), np.array(k[4:8]), k[8], tr["axis"], tr["pivot"])
            else:
                self.carry.pop(name, None)


class Step:
    HOLD0 = 1.5                                   # v2.1: opening overview before the first motion

    def __init__(self, unit, index, phase, phaseTitle, title, text, speech=None, camera=None):
        self.u, self.i = unit, index
        self.meta = dict(phase=phase, phaseTitle=phaseTitle, title=title, text=text, speech=speech or f"{title}. {text}")
        self.camera = camera or {}
        self.t = self.HOLD0
        self.parts = OrderedDict()                # name -> track
        self.toolTracks, self.fx = [], []
        self.components, self.hardware, self.toolsUsed, self.flags, self.checks = [], [], [], [], []
        self.focus = []
        self.shots = []                            # camera shots (build-time), see _shot / to_json

    # ---------------------------------------------------------------- tracks
    def _track(self, name, axis=None, pivot=None):
        if name not in self.parts:
            self.parts[name] = dict(node=self.u.ids[name], name=name, axis=list(unit(axis)) if axis is not None else [0, 1, 0],
                                    pivot=list(np.asarray(pivot, float)) if pivot is not None else [0, 0, 0], keys=[])
        return self.parts[name]

    def _carried(self, name):
        """Track for a part installed in an earlier step that moves again here (e.g. tightened now)."""
        if name in self.parts: return self.parts[name]
        p = self.u.A[name]
        c = self.u.carry.get(name)
        tr = self._track(name, axis=c[3] if c else p.get("axis"), pivot=c[4] if c else p.get("head"))
        if c: self._key(name, 0, c[0], c[1], c[2])
        else: self._key(name, 0)
        return tr

    def _key(self, name, t, T=(0, 0, 0), q=ID_Q, ang=0.0, ease=1):
        tr = self.parts[name]
        tr["keys"].append([round(t, 3), *[round(float(v), 3) for v in T], *[round(float(v), 6) for v in q], round(float(ang), 4), ease])

    def _install(self, names):
        """Parts become obstacles for later motions once their own motion is recorded."""
        self.u.world.add(names)
        for n in names:
            if n not in self.u.installed_by:
                self.u.installed_by[n] = self.i
                self.components.append(n)

    # ---------------------------------------------------------------- validation
    def _check(self, label, mesh, mats, allow=(), final_allow=(), n_final=0, allow_at=None):
        worst = {}
        for k, Mx in enumerate(mats):
            al = set(allow) | (set(final_allow) if k >= len(mats) - n_final else set())
            if allow_at is not None: al |= allow_at[k]
            for n, d in self.u.world.hits(mesh, Mx, allow=al).items():
                worst[n] = max(worst.get(n, 0), d)
        self.checks.append(dict(what=label, samples=len(mats), clear=not worst,
                                collisions={n: round(d, 2) for n, d in sorted(worst.items(), key=lambda kv: -kv[1])[:4]}))
        return worst

    def _group_mesh(self, names):
        return trimesh.util.concatenate([self.u.world.mesh[n] for n in names])

    # ---------------------------------------------------------------- generic rigid placement
    def place(self, names, path, tilt=None, dur=None, label=None, allow=(), final_allow=(), ease_last=True, pivot=None):
        """Rigid group from path[0] (offset from CAD, mm) through path[...] to the CAD position.
        tilt=(axis, deg): extra rotation about the group centre at the start, removed along the path."""
        names = list(names)
        A = self.u.A
        bb = np.array([A[n]["bbox"] for n in names]); lo, hi = bb[:, :3].min(0), bb[:, 3:].max(0)
        P = (lo + hi) / 2 if pivot is None else np.asarray(pivot, float)
        pts = [np.asarray(p, float) for p in path] + [np.zeros(3)]
        seg = [np.linalg.norm(pts[k + 1] - pts[k]) for k in range(len(pts) - 1)]
        total = sum(seg) or 1.0
        dur = dur or float(np.clip(0.9 + total / 260, 1.2, 3.2))
        qs = quat_axis_angle(tilt[0], math.radians(tilt[1])) if tilt else ID_Q

        def pose(s):                                  # s in [0,1] along the path length
            d = s * total; k = 0
            while k < len(seg) - 1 and d > seg[k]: d -= seg[k]; k += 1
            f = 0 if seg[k] == 0 else min(1, d / seg[k])
            o = pts[k] + (pts[k + 1] - pts[k]) * f
            q = slerp(qs, ID_Q, min(1, s * 1.15)) if tilt else ID_Q
            T = o + P - quat_to_mat(q) @ P
            return T, q

        for n in names: self._track(n)
        T0, q0 = pose(0)
        size = float(np.linalg.norm(hi - lo))
        motion = pts[-2] - pts[-1] if len(pts) > 1 else np.zeros(3)
        mid = (lo + hi) / 2 + pts[0] / 2
        self._shot(self.t, mid, radius=float(np.linalg.norm(pts[0]) / 2 + size / 2), kind="wide",
                   axis=unit(motion) if np.linalg.norm(motion) > 1 else None, ignore=names)
        self._shot(self.t + dur * 0.62, (lo + hi) / 2, radius=max(45.0, size / 2 * 1.15), kind="detail",
                   axis=unit(motion) if np.linalg.norm(motion) > 1 else None, ignore=names)
        for n in names:
            if self.parts[n]["keys"]:                 # already moving (e.g. impeller onto the shaft first)
                self._key(n, self.t, T0, q0)
            else:
                self._key(n, 0, T0, q0); self._key(n, self.t, T0, q0)
        acc = 0.0
        for k, L in enumerate(seg):
            acc += L
            s = acc / total
            # intermediate keys every ~40 mm so tilt + bends interpolate smoothly
            nsub = max(1, int(L / 40))
            for j in range(1, nsub + 1):
                ss = (acc - L + L * j / nsub) / total
                T, q = pose(ss)
                for n in names: self._key(n, self.t + dur * ss, T, q, ease=0 if (k < len(seg) - 1 or j < nsub or not ease_last) else 1)
        mats = []
        for s in np.linspace(0, 1, 36)[:-1]:
            T, q = pose(s); mats.append(delta_matrix(T, q, P, (0, 1, 0), 0))
        self._check(label or f"place {', '.join(base_name(n) for n in names[:3])}{'…' if len(names) > 3 else ''}",
                    self._group_mesh(names), mats, allow=allow, final_allow=final_allow, n_final=6)
        self.t += dur
        self._install(names)
        return self

    # ---------------------------------------------------------------- fasteners
    def fastener(self, name, kind, side=None, gap=18.0, engage=None, hand_turns=1.5, dur=1.0, slide=None,
                 travel=None, allow=(), seat=True):
        """Bring one fastener to its hole along its axis (or a clip along `slide`).
        side: unit vector of the side it comes from (default: its head side)."""
        p = self.u.A[name]
        if "axis" not in p:                      # not an axisymmetric fastener (e.g. clamp knob): use the side given
            sd = unit(side); bb = np.asarray(p["bbox"]); c = (bb[:3] + bb[3:]) / 2
            ext = float(np.abs(sd) @ (bb[3:] - bb[:3]))
            p.update(axis=list(sd), head=list(c + sd * ext / 2), tip=list(c - sd * ext / 2), length=ext, cylinders=[], across_flats=[])
        a = unit(p["axis"]); side = unit(side) if side is not None else a
        head = np.asarray(p["head"]); L = p["length"]
        tr = self._track(name, axis=a, pivot=head)
        tr["sgn"] = -1.0 if float(a @ side) > 0 else 1.0     # tightening = clockwise seen from the outside
        mates = set(p.get("contacts", []))
        mesh = self.u.world.mesh[name]
        if kind == "clip":
            # v2.1: the clip slides along `slide` riding a small offset along its own axis (spring legs open
            # over the sheet), then snaps home along the axis. The slide is checked WITHOUT the mating sheet
            # allowed (no pass-through); only the final snap may touch it (CAD clip/sheet interference).
            sd = unit(slide); trav = travel or 30.0
            ride = None
            for o in (0.0, -0.5, -0.75, -1.0, -1.25, -1.5, -2.0, -2.5, 0.5, 1.0, 1.5, 2.5):
                if all(not self.u.world.hits(mesh, delta_matrix(sd * trav * (1 - s) + a * o, ID_Q, head, a, 0), allow=set(allow))
                       for s in np.linspace(0, 1, 41)[:-1]):
                    ride = a * o; break
            ride = ride if ride is not None else np.zeros(3)
            self._shot(self.t - 0.15, head, radius=40, axis=sd, kind="detail")
            start = sd * trav + ride
            self._key(name, 0, start); self._key(name, self.t, start)
            self._key(name, self.t + dur * 0.78, ride if np.linalg.norm(ride) > 0 else sd * 1.2, ease=1)
            self._key(name, self.t + dur, (0, 0, 0), ease=1)          # snap home
            slide_offs = [sd * trav * (1 - s) + ride for s in np.linspace(0, 1, 41)[:-1]]
            snap_offs = [ride * (1 - s) for s in np.linspace(0, 1, 6)] if np.linalg.norm(ride) > 0 else []
            mats = [delta_matrix(o, ID_Q, head, a, 0) for o in slide_offs + snap_offs]
            allow_at = [set()] * len(slide_offs) + [mates] * len(snap_offs)
            tr["ride"] = [round(float(x), 3) for x in ride]
            self._check(f"clip {name}", mesh, mats, allow=set(allow), allow_at=allow_at)
            self.t += dur; self._install([name]); return self
        if kind != "rivet":
            self._shot(self.t - 0.15, head, radius=max(28.0, L * 2.2), axis=side, kind="detail")
        clear = travel or (L + gap)
        e = engage if engage is not None else (min(6.0, 0.45 * L) if kind in ("bolt", "screw", "nut") else 0.0)
        start = side * clear
        self._key(name, 0, start); self._key(name, self.t, start)
        t1 = self.t + dur * (0.55 if e else 1.0)
        self._key(name, t1, side * e, ease=1)
        offs = [start + (side * e - start) * s for s in np.linspace(0, 1, 20)]
        mats = [delta_matrix(o, ID_Q, head, a, 0) for o in offs]
        allow_at = [mates if np.linalg.norm(o) < L + 2 else set() for o in offs]
        if e and seat:                                                 # hand start: a few turns, a little travel
            ang = tr["sgn"] * 2 * math.pi * hand_turns
            self._key(name, t1 + dur * 0.45, side * e * 0.7, ang=ang, ease=0)
            tr["handAngle"] = ang
            tr["engaged"] = list(side * e * 0.7)
        self._check(f"{kind} {name}", mesh, mats, allow=allow, allow_at=allow_at)
        self.t = t1 + (dur * 0.45 if e and seat else 0)
        self._install([name])
        return self

    def drive_with_hand(self, name, turns=3, dur=1.2):
        """Finish a fastener without a tool model (only where none is required)."""
        tr = self.parts[name]; last = tr["keys"][-1]
        self._key(name, self.t + dur, (0, 0, 0), ang=last[8] + tr.get("sgn", -1.0) * 2 * math.pi * turns, ease=0)
        self.t += dur

    # ---------------------------------------------------------------- tools
    def _drill_mesh(self, af):
        """Drill collision mesh with the socket (tool y 0..50.5 mm) scaled radially as on screen."""
        key = ("drill", round(af, 2))
        if key not in self.u.tmesh:
            m = self.u.tmesh["drill"].copy(); v = m.vertices.copy()
            sel = v[:, 1] < 50.6; k = af / SOCKET_SUPPLIED_AF
            v[sel, 0] *= k; v[sel, 2] *= k
            m.vertices = v; self.u.tmesh[key] = m
        return self.u.tmesh[key]

    SWEEP = (0.0, 8.0, 20.0, 40.0, 70.0, 100.0, 130.0)

    def _tool_pose_free(self, tool, origin, y_axis, allow, hints, extra=None, mesh=None, sweep=SWEEP):
        """Roll about the working axis so the tool clears the installed parts at the working point AND
        along the straight retract/approach along the working axis (v2.1: `sweep` heights, mm).
        Returns the first clear roll; else the least colliding one with its collisions at the working point."""
        mesh = mesh if mesh is not None else self.u.tmesh[tool]
        y_axis = unit(y_axis)
        tried = []
        for h in hints:
            for k in range(12):
                rot = quat_axis_angle(y_axis, k * math.pi / 6)
                xh = quat_to_mat(rot) @ unit(h)
                if np.linalg.norm(xh - y_axis * (xh @ y_axis)) < 1e-3: continue
                q = frame_quat(y_axis, xh)
                hit = self._pose_hits(mesh, origin, q, allow)
                worst = sum(hit.values())
                if not hit:
                    for hh in sweep[1:]:
                        sh = self._pose_hits(mesh, origin + y_axis * hh, q, allow)
                        if sh: worst = 0.01 + sum(sh.values()) * 0.1; break
                tried.append((worst, q, hit))
                if worst == 0: return q, {}
        best = min(tried, key=lambda x: x[0])
        return best[1], (best[2] or {"(retract path)": best[0]})

    def _tool_key(self, tr, t, pos, q):
        tr["keys"].append([round(t, 3), *[round(float(v), 3) for v in pos], *[round(float(v), 6) for v in q]])

    def _sub(self, tr, part, t, val, ease=1):
        tr.setdefault("sub", {}).setdefault(part, []).append([round(t, 3), round(float(val), 4), ease])

    def drill(self, names, af=None, hints=((0, -1, 0), (1, 0, 0), (0, 0, 1)), turns=4.0, label=None, depth=None, fallback=True):
        """Drill + socket sized to the measured hex: align, engage, turn the fastener home, retract.
        Fasteners the drill body cannot reach (no collision-free roll) are tightened with the
        supplied adjustable wrench instead (hex heads / nuts only) — recorded in the step flags."""
        if fallback:
            ok, blocked = [], []
            for name in names:
                self._carried(name)
                p = self.u.A[name]; a = unit(p["axis"])
                haf = af or (p["across_flats"][0] if p.get("across_flats") else SOCKET_SUPPLIED_AF)
                kind_nut = "Nut" in name
                hh = head_height(p) if not kind_nut else p["length"]
                k = self.parts[name]["keys"][-1]
                side = unit(k[1:4]) if np.linalg.norm(k[1:4]) > 0.05 else a
                outer = np.asarray(p["head"]) if not kind_nut else (np.asarray(p["tip"]) if np.dot(unit(np.asarray(p["tip"]) - np.asarray(p["head"])), side) > 0 else np.asarray(p["head"]))
                dep = depth if depth is not None else max(2.0, hh * 0.6)
                q, hit = self._tool_pose_free("drill", outer - side * dep, side, {name} | set(p.get("contacts", [])), hints, mesh=self._drill_mesh(haf))
                (blocked if hit and p.get("across_flats") and af is None else ok).append(name)
            if ok: self.drill(ok, af=af, hints=hints, turns=turns, label=label, depth=depth, fallback=False)
            for name in blocked:
                k = self.parts[name]["keys"][-1]; side = unit(k[1:4]) if np.linalg.norm(k[1:4]) > 0.05 else unit(self.u.A[name]["axis"])
                self.wrench(name, side=side, strokes=2, bolt="Nut" not in name)
            if blocked:
                self.flag(f"Drill body cannot reach {', '.join(blocked)} (wall clearance in the CAD): tightened with the adjustable wrench (supplied) instead")
            return self
        tool = "drill"; info = self.u.tools[tool]
        tr = dict(tool=tool, keys=[], label=label)
        for name in names:
            self._carried(name)
        poses = []                                      # (name, side, engaged point, quaternion, offset, angle0)
        for name in names:
            p = self.u.A[name]; a = unit(p["axis"]); head = np.asarray(p["head"])
            kind_nut = "Nut" in name
            last = self.parts[name]["keys"][-1]
            side = unit(last[1:4]) if np.linalg.norm(last[1:4]) > 0.05 else a
            haf = af or (p["across_flats"][0] if p.get("across_flats") else SOCKET_SUPPLIED_AF)
            tr["socketAF"] = haf
            hh = head_height(p) if not kind_nut else p["length"]
            dep = depth if depth is not None else max(2.0, hh * 0.6)
            # socket opening sits `dep` below the outer end of the head (bolts) / of the nut (far end)
            outer = head
            if kind_nut:
                outer = np.asarray(p["tip"]) if np.dot(unit(np.asarray(p["tip"]) - head), side) > 0 else head
            eng = outer - side * dep
            allow = {name} | set(p.get("contacts", []))
            q, hit = self._tool_pose_free(tool, eng, side, allow, hints, mesh=self._drill_mesh(haf))
            self.checks.append(dict(what=f"drill on {name}", samples=1, clear=not hit, collisions={k: round(v, 2) for k, v in hit.items()}))
            sgn = -1.0 if float(unit(self.parts[name]["axis"]) @ side) > 0 else 1.0
            poses.append((name, side, eng, q, np.array(last[1:4]), last[8], outer, sgn, allow))
        mesh = self._drill_mesh(tr["socketAF"])
        allow_all = set().union(*[x[8] for x in poses])
        first = True; prev = None
        for name, side, eng, q, off, ang0, outer, sgn, allow in poses:
            t0 = self.t
            if first:
                H = self._clear_height(tool, mesh, eng + off, q, side, allow_all, start=130)
                self._tool_key(tr, t0, eng + off + side * H, q)
                t0 += 0.25
            else:
                # hop: back out to a clearance height, move across at that height, then go in
                pn, ps, pe, pq, poff = prev
                H = max(self._clear_height(tool, mesh, pe, pq, ps, allow_all, start=70),
                        self._clear_height(tool, mesh, eng + off, q, side, allow_all, start=70))
                Hh = self._hop_height(tool, mesh, pe, pq, ps, eng + off, q, side, allow_all, H)
                if Hh is not None:
                    self._tool_key(tr, t0, pe + ps * Hh, pq)
                    self._tool_key(tr, t0 + 0.45, eng + off + side * Hh, q)
                    t0 += 0.45
                else:
                    self._tool_key(tr, t0, pe + ps * H, pq)
                    t0 += self._hop(tr, mesh, t0, 0.45, pe + ps * H, pq, eng + off + side * H, q, allow_all)
            self._tool_key(tr, t0 + 0.35, eng + off + side * 6, q)
            self._tool_key(tr, t0 + 0.6, eng + off, q)                                 # socket over the head
            spin_t0, spin_t1 = t0 + 0.65, t0 + 0.65 + 0.3 * turns
            self._tool_key(tr, spin_t0, eng + off, q)
            self._tool_key(tr, spin_t1, eng, q)                                        # follows the fastener home, body fixed
            self._key(name, spin_t0, off, ang=ang0, ease=0)
            self._key(name, spin_t1, (0, 0, 0), ang=ang0 + sgn * 2 * math.pi * turns, ease=0)
            r_sock = 10.9 * (tr["socketAF"] / SOCKET_SUPPLIED_AF) + 7.0
            self.fx.append(dict(type="spinArrow", centre=list(map(float, outer + side * 14.0)), axis=list(map(float, side)),
                                sense=-1.0, radius=float(r_sock), t=[round(spin_t0, 3), round(spin_t1, 3)], turns=turns))
            self._shot(spin_t0 - 0.9, outer, radius=55, axis=side, kind="tool", tool=(mesh, eng, q))
            self.t = spin_t1 + 0.15
            prev = (name, side, eng, q, np.zeros(3))
            first = False
        pn, ps, pe, pq, _ = prev
        H = self._clear_height(tool, mesh, pe, pq, ps, allow_all, start=110)
        self._tool_key(tr, self.t + 0.45, pe + ps * H, pq)
        self.t += 0.45
        self._check_tool_path(tr, mesh, allow_all)
        tr["socketScale"] = round(tr.get("socketAF", SOCKET_SUPPLIED_AF) / SOCKET_SUPPLIED_AF, 4)
        self.toolTracks.append(tr)
        self._use_tool("drill", f"Cordless drill + {socket_label(tr['socketAF'])} socket" + ("" if abs(tr["socketScale"] - 1) < 0.02 else " (socket resized from the supplied 9/16 in model)"))
        return self

    # ---------------------------------------------------------------- tool path helpers
    def _pose_hits(self, mesh, pos, q, allow):
        Mx = np.eye(4); Mx[:3, :3] = quat_to_mat(q); Mx[:3, 3] = pos
        return self.u.world.hits(mesh, Mx, allow=allow, tol=1.5)

    def _clear_height(self, tool, mesh, eng, q, side, allow, start=70, heights=(0, 50, 120, 220, 350)):
        """Smallest retract height along the working axis at which the tool is clear (min `start`)."""
        for extra in heights:
            H = start + extra
            if not self._pose_hits(mesh, eng + side * H, q, allow): return H
        return start + heights[-1]

    def _hop_height(self, tool, mesh, p0, q0, s0, p1, q1, s1, allow, H, n=10):
        """Raise the clearance height until the straight hop between two fasteners is collision-free."""
        for extra in (0, 80, 180, 320):
            h = H + extra; ok = True
            for u in np.linspace(0, 1, n):
                pos = (p0 + s0 * h) * (1 - u) + (p1 + s1 * h) * u
                if self._pose_hits(mesh, pos, slerp(q0, q1, u), allow): ok = False; break
            if ok: return h
        return None

    def _seg_clear(self, mesh, pa, qa, pb, qb, allow, step=30.0):
        n = max(3, int(np.linalg.norm(np.asarray(pb) - pa) / step) + 2)
        for u in np.linspace(0, 1, n):
            if self._pose_hits(mesh, np.asarray(pa) * (1 - u) + np.asarray(pb) * u, slerp(qa, qb, u), allow): return False
        return True

    def _route(self, mesh, pa, qa, pb, qb, allow):
        """Waypoints (pos, q) between two retracted tool poses that keep the tool out of the unit:
        straight, else around one or two vertical edges / over the top of the main body's box."""
        if self._seg_clear(mesh, pa, qa, pb, qb, allow): return []
        if not hasattr(self.u, "_box"):
            bb = np.array([self.u.A[n]["bbox"] for n in self.u.A]); self.u._box = (bb[:, :3].min(0), bb[:, 3:].max(0))
        lo, hi = self.u._box
        best = None
        for m in (140.0, 220.0, 320.0):
            L, Hh = lo - m, hi + m
            ym = (pa[1] + pb[1]) / 2
            edges = [np.array([x, ym, z]) for x in (L[0], Hh[0]) for z in (L[2], Hh[2])]
            tops = [np.array([pa[0], Hh[1], pa[2]]), np.array([pb[0], Hh[1], pb[2]])]
            cands = [[e] for e in edges] + [[e1, e2] for e1 in edges for e2 in edges if e1 is not e2 and
                                            (abs(e1[0] - e2[0]) < 1e-6 or abs(e1[2] - e2[2]) < 1e-6)] + [tops]
            for wps in cands:
                pts = [np.asarray(pa, float)] + wps + [np.asarray(pb, float)]
                Ls = np.cumsum([0] + [np.linalg.norm(pts[i + 1] - pts[i]) for i in range(len(pts) - 1)])
                qs_ = [slerp(qa, qb, l / Ls[-1]) for l in Ls]
                if best is not None and Ls[-1] >= best[0]: continue
                if all(self._seg_clear(mesh, pts[i], qs_[i], pts[i + 1], qs_[i + 1], allow) for i in range(len(pts) - 1)):
                    best = (Ls[-1], list(zip(pts[1:-1], qs_[1:-1])))
            if best: return best[1]
        return []

    def _hop(self, tr, mesh, t0, dur, pa, qa, pb, qb, allow):
        """Tool keys for a hop pa -> pb (both included), routed around the unit when needed."""
        wps = self._route(mesh, pa, qa, pb, qb, allow)
        pts = [np.asarray(pa, float)] + [w[0] for w in wps] + [np.asarray(pb, float)]
        qs_ = [qa] + [w[1] for w in wps] + [qb]
        Ls = np.cumsum([0] + [np.linalg.norm(pts[i + 1] - pts[i]) for i in range(len(pts) - 1)])
        total = dur * (1.0 + 0.35 * len(wps))
        for P, Q, l in zip(pts, qs_, Ls):
            self._tool_key(tr, t0 + total * (l / Ls[-1] if Ls[-1] > 0 else 1), P, Q)
        return total

    def _check_tool_path(self, tr, mesh, allow, n=8):
        """Sample every segment of a tool track against the installed parts (recorded in `checks`)."""
        worst = {}; samples = 0
        k = tr["keys"]
        for a, b in zip(k, k[1:]):
            pa, pb = np.array(a[1:4]), np.array(b[1:4]); qa, qb = np.array(a[4:8]), np.array(b[4:8])
            for u in np.linspace(0, 1, n):
                samples += 1
                for nm, d in self._pose_hits(mesh, pa * (1 - u) + pb * u, slerp(qa, qb, u), allow).items():
                    worst[nm] = max(worst.get(nm, 0), d)
        self.checks.append(dict(what=f"{tr['tool']} path ({len(k)} keys)", samples=samples, clear=not worst,
                                collisions={a: round(b, 2) for a, b in sorted(worst.items(), key=lambda kv: -kv[1])[:4]}))

    # ---------------------------------------------------------------- camera shots
    def _view_dir(self, target, radius, preferred, axis=None, occlude=True, axis_deg=50.0, ignore=frozenset()):
        """Camera direction for a shot: close to the step's preferred view, showing the insertion axis
        from the side (~50°), with a clear line of sight and the camera outside the geometry."""
        pref = unit(preferred)
        cands = [pref]
        for el in (-55, -30, -10, 10, 30, 50, 70):
            for az in range(0, 360, 30):
                e, z = math.radians(el), math.radians(az)
                cands.append(np.array([math.cos(e) * math.cos(z), math.sin(e), math.cos(e) * math.sin(z)]))
        dist = radius * 3.6 + 30                  # ~ viewer.fitDistance(radius, 1.1) at FOV 35
        xray = bool(self.camera.get("xray"))
        best = None
        for d in cands:
            score = math.degrees(math.acos(max(-1, min(1, float(d @ pref))))) / 30.0
            if axis is not None:
                ang = math.degrees(math.acos(min(1, abs(float(d @ unit(axis))))))
                score += abs(ang - axis_deg) / 25.0
            hits = {n: v for n, v in self._sight_hits(target, d, dist).items() if n not in ignore} if occlude else {}
            if getattr(self, "_tool_occluder", None) is not None and self._tool_sight(target, d, dist):
                hits = dict(hits, **{"(tool body)": 1.0})
            if xray:                              # the rest of the unit is ghosted: only this step's parts occlude
                hits = {n: v for n, v in hits.items() if n in self.parts}
            inside = self._inside(np.asarray(target) + d * dist)
            score += 4.0 * len(hits) + (50.0 if inside else 0.0)
            if best is None or score < best[0]: best = (score, d, hits, inside)
        if best[3]: best[2]["(camera inside geometry)"] = 1.0
        return best[1], best[2]

    def _tool_sight(self, target, d, dist, r=4.0):
        mesh, pos, q = self._tool_occluder
        cache = self.u.__dict__.setdefault("_toolcm", {})
        cm = cache.get(id(mesh))
        if cm is None or cm[0] is not mesh:
            c = trimesh.collision.CollisionManager(); c.add_object("tool", mesh); cm = (mesh, c); cache[id(mesh)] = cm
        Mt = np.eye(4); Mt[:3, :3] = quat_to_mat(q); Mt[:3, 3] = pos
        cm[1].set_transform("tool", Mt)
        start = max(18.0, min(60.0, dist * 0.25)); L = dist - start
        Lq = float(max(10, round(L / 10) * 10))
        cyl = self.u.__dict__.setdefault("_cyl", {}).get((Lq, r))
        if cyl is None:
            cyl = trimesh.creation.cylinder(radius=r, height=Lq, sections=8); self.u._cyl[(Lq, r)] = cyl
        z = np.array([0, 0, 1.0]); v = unit(d)
        ax = np.cross(z, v); s_ = np.linalg.norm(ax); c_ = float(z @ v)
        R = np.eye(3) if s_ < 1e-8 else quat_to_mat(quat_axis_angle(ax / s_, math.atan2(s_, c_)))
        Mx = np.eye(4); Mx[:3, :3] = R; Mx[:3, 3] = np.asarray(target) + v * (start + Lq / 2)
        return cm[1].in_collision_single(cyl, transform=Mx)

    def _inside(self, pos, r=12.0):
        """Camera position inside / touching solid geometry (small sphere test)."""
        sph = self.u.__dict__.get("_sph")
        if sph is None: sph = self.u._sph = trimesh.creation.icosphere(subdivisions=1, radius=r)
        Mx = np.eye(4); Mx[:3, 3] = pos
        if self.u.world.hits(sph, Mx, tol=0.0): return True
        # fully enclosed (sphere inside a closed box without touching): ray parity along +X
        return False

    def _sight_hits(self, target, d, dist, r=4.0):
        """Parts crossing the line of sight (thin cylinder from near the target to the camera)."""
        start = max(18.0, min(60.0, dist * 0.25))
        L = dist - start
        if L <= 1: return {}
        # fcl transforms are rigid: one cylinder mesh per (quantised) length instead of a scaled one
        Lq = float(max(10, round(L / 10) * 10))
        cache = self.u.__dict__.setdefault("_cyl", {})
        cyl = cache.get((Lq, r))
        if cyl is None:
            cyl = trimesh.creation.cylinder(radius=r, height=Lq, sections=8); cache[(Lq, r)] = cyl
        Mx = np.eye(4)
        z = np.array([0, 0, 1.0]); v = unit(d)
        ax = np.cross(z, v); s_ = np.linalg.norm(ax); c_ = float(z @ v)
        R = np.eye(3) if s_ < 1e-8 else quat_to_mat(quat_axis_angle(ax / s_, math.atan2(s_, c_)))
        Mx[:3, :3] = R; Mx[:3, 3] = np.asarray(target) + v * (start + Lq / 2)
        return self.u.world.hits(cyl, Mx, tol=0.0)

    # minimum framing radius (mm) per shot kind: close enough to read the operation, wide enough to
    # keep the surrounding structure in view (v2.1 review: tighter close-ups lost the context)
    MIN_R = {"detail": 62.0, "tool": 120.0, "wide": 120.0, "overview": 95.0, "result": 95.0}

    def _shot(self, t, target, radius, axis=None, kind="detail", preferred=None, tool=None, ignore=()):
        """tool = (mesh, position, quaternion) of the tool at work: its body must not hide the working point."""
        radius = max(float(radius), self.MIN_R.get(kind, 60.0))
        self._tool_occluder = tool
        pref = preferred if preferred is not None else self.camera.get("dir", [1, 0.5, 0.8])
        # overview / result frame the whole step from outside: the target is inside the framed parts
        # tool shots: from further to the side of the working axis, so the tool and the joint are both seen
        d, hits = self._view_dir(np.asarray(target, float), radius, pref, axis, occlude=kind not in ("overview", "result"),
                                 axis_deg=65.0 if kind == "tool" else 50.0, ignore=set(ignore))
        self.shots.append(dict(t=round(max(0.0, t), 3), target=[float(x) for x in target], dir=[float(x) for x in d],
                               radius=float(radius), kind=kind, blocked=sorted(hits)))

    def rivet(self, names, hints=((0, -1, 0), (0, 1, 0), (1, 0, 0))):
        """Insert each closed-end rivet by hand, then set it with the rivet gun (mandrel pulled and broken)."""
        tool = "rivetgun"; tr = dict(tool=tool, keys=[]); first = True
        mand = dict(type="mandrels", items=[])
        names = list(names)
        if len(names) > 2:                       # v2.1: work around the unit, not back and forth through it
            cx = (self.u.A["Unit Body"]["bbox"][0] + self.u.A["Unit Body"]["bbox"][3]) / 2
            ang = {n: math.atan2(self.u.A[n]["head"][2], self.u.A[n]["head"][0] - cx) for n in names}
            names.sort(key=lambda n: (ang[n], self.u.A[n]["head"][1]))
            gaps = [((ang[names[(i + 1) % len(names)]] - ang[names[i]]) % (2 * math.pi), i) for i in range(len(names))]
            k0 = (max(gaps)[1] + 1) % len(names)
            names = names[k0:] + names[:k0]
        mesh = self.u.tmesh[tool]
        allow_all = set(names).union(*[set(self.u.A[n].get("contacts", [])) for n in names])
        prev = None
        for k, name in enumerate(names):
            p = self.u.A[name]; a = unit(p["axis"]); head = np.asarray(p["head"])
            pace = 1.0 if k < 2 else 0.6
            t_shot = self.t - 0.3
            self.fastener(name, "rivet", gap=14, dur=0.55 * pace + 0.15)
            allow = {name} | set(p.get("contacts", []))
            q, hit = self._tool_pose_free(tool, head, a, allow, hints)
            self._shot(t_shot, head, radius=60 if k < 2 else 75, axis=a, kind="tool", tool=(mesh, head, q))
            self.checks.append(dict(what=f"rivet gun on {name}", samples=1, clear=not hit, collisions={k2: round(v, 2) for k2, v in hit.items()}))
            t0 = self.t
            if first:
                H = self._clear_height(tool, mesh, head, q, a, allow_all, start=140)
                self._tool_key(tr, t0 - 0.1, head + a * H, q)
            else:
                ph, pa_, pq = prev
                H = max(self._clear_height(tool, mesh, ph, pq, pa_, allow_all, start=45), self._clear_height(tool, mesh, head, q, a, allow_all, start=45))
                Hh = self._hop_height(tool, mesh, ph, pq, pa_, head, q, a, allow_all, H)
                if Hh is not None:
                    self._tool_key(tr, t0 - 0.1, ph + pa_ * Hh, pq)
                    self._tool_key(tr, t0 + 0.2 * pace, head + a * Hh, q)
                else:                                                     # around the unit (other face)
                    self._tool_key(tr, t0 - 0.1, ph + pa_ * H, pq)
                    extra = self._hop(tr, mesh, t0 - 0.1, 0.3 * pace + 0.6, ph + pa_ * H, pq, head + a * H, q, allow_all)
                    shift = extra - (0.3 * pace)
                    t0 += shift; self.t += shift
            self._tool_key(tr, t0 + 0.4 * pace, head + a * 0.5, q)
            self._tool_key(tr, t0 + 0.55 * pace, head, q)                             # nose on the flange
            pull0, pull1 = t0 + 0.6 * pace, t0 + 0.6 * pace + 0.45
            self._sub(tr, "trigger", pull0, 0); self._sub(tr, "trigger", pull1, 1); self._sub(tr, "trigger", pull1 + 0.25, 0)
            self._sub(tr, "nose", pull0, 0); self._sub(tr, "nose", pull1, 1); self._sub(tr, "nose", pull1 + 0.25, 0)
            self._tool_key(tr, pull1 + 0.05, head, q)
            mand["items"].append(dict(head=list(head), axis=list(a), show=round(self.t - (0.55 * pace + 0.15), 3),
                                      pull=[round(pull0, 3), round(pull1, 3)]))
            self.t = pull1 + 0.05
            prev = (head, a, q)
            first = False
        ph, pa_, pq = prev
        H = self._clear_height(tool, mesh, ph, pq, pa_, allow_all, start=120)
        self._tool_key(tr, self.t + 0.45, ph + pa_ * H, pq)
        self.t += 0.45
        self._check_tool_path(tr, mesh, allow_all)
        self.toolTracks.append(tr); self.fx.append(mand)
        self._use_tool("rivetgun", "Cordless blind-rivet gun")
        return self

    def wrench(self, name, side, hints=((0, -1, 0), (0, 0, 1), (0, 1, 0)), strokes=2, swing_deg=60, label=None, bolt=False):
        """Adjustable wrench: open the jaw to the measured hex width, engage, turn in strokes."""
        self._carried(name)
        p = self.u.A[name]; side = unit(side)
        if bolt:                                                       # hex head: centre of the head
            hh = head_height(p); C = np.asarray(p["head"]) - unit(p["axis"]) * hh / 2; thick = hh
        else:
            C = (np.asarray(p["head"]) + np.asarray(p["tip"])) / 2; thick = p["length"]
        w = p["across_flats"][0]
        C = C + side * max(0.0, (17.0 - thick) / 2 + 0.5)              # wrench 17 mm thick: keep its back face off the panel
        tool = "wrench"; tr = dict(tool=tool, keys=[], jawMm=round(w + 0.3, 2))
        allow = {name} | set(p.get("contacts", []))
        hits = None; best = None
        wm = self.u.tmesh[tool]
        # v2.1: the roll must keep the wrench clear over the whole stroke (engaged, swung, lifted off,
        # approach along the axis); a shorter swing (more strokes) is used where the full one does not fit
        total_deg = swing_deg * strokes
        req = swing_deg
        for sw in (swing_deg, 45, 30, 25):
            for h in hints:
                for k in range(72):
                    xh = quat_to_mat(quat_axis_angle(side, k * math.pi / 36)) @ unit(h)
                    if np.linalg.norm(xh - side * (xh @ side)) < 1e-3: continue
                    q = frame_quat(side, xh)
                    qs_ = quat_mul(quat_axis_angle(side, -math.radians(sw)), q)
                    o0 = C + quat_to_mat(q) @ np.array([0, 0, w / 2]); o1 = C + quat_to_mat(qs_) @ np.array([0, 0, w / 2])
                    hit = self._pose_hits(wm, o0, q, allow)
                    worst = sum(hit.values())
                    if not hit:
                        for pos, qq in [(o1, qs_), (o1 + side * 6, qs_), (o0 + side * 6, q), (o0 + side * 45, q), (o0 + side * 90, q),
                                        (C + quat_to_mat(slerp(q, qs_, 0.5)) @ np.array([0, 0, w / 2]), slerp(q, qs_, 0.5))]:
                            hh = self._pose_hits(wm, pos, qq, allow)
                            if hh: worst = 0.01 + sum(hh.values()) * 0.1; break
                    if best is None or worst < best[0]: best = (worst, q, hit, sw)
                    if worst == 0: break
                if best and best[0] == 0: break
            if best and best[0] == 0: break
        q = best[1]; hits = best[2] or ({"(stroke)": round(best[0], 2)} if best[0] else {})
        swing_deg = best[3]; strokes = int(math.ceil(total_deg / swing_deg - 1e-6))
        if swing_deg < req and not hits:
            self.flag(f"{name}: only a short collision-free wrench arc exists here ({swing_deg}° strokes instead of {req}°) — "
                      "a ratcheting or offset box wrench is recommended (not supplied); confirm")
        self.checks.append(dict(what=f"wrench on {name}", samples=1, clear=not hits, collisions={k: round(v, 2) for k, v in hits.items()}))

        def org(qq): return C + quat_to_mat(qq) @ np.array([0, 0, w / 2])
        t0 = self.t
        self._shot(t0, C, radius=70, axis=side, kind="tool", tool=(self.u.tmesh[tool], org(q), q))
        sgn = -1.0 if float(unit(self.parts[name]["axis"]) @ side) > 0 else 1.0
        self._sub(tr, "jaw", t0, 0, 0); self._sub(tr, "jaw", t0 + 0.01, w + 0.3, 0)      # opened before it appears
        self._tool_key(tr, t0, org(q) + side * 90, q)
        self._tool_key(tr, t0 + 0.6, org(q), q)
        ftr = self.parts[name]; last = ftr["keys"][-1]; off = np.array(last[1:4]); ang = last[8]
        t = t0 + 0.7
        for s in range(strokes):
            qs = quat_mul(quat_axis_angle(side, -math.radians(swing_deg)), q)      # clockwise seen from outside
            frac0, frac1 = s / strokes, (s + 1) / strokes
            self._tool_key(tr, t, org(q) + off * (1 - frac0), q)
            self._key(name, t, off * (1 - frac0), ang=ang, ease=0)
            ang += sgn * math.radians(swing_deg)
            self._tool_key(tr, t + 0.7, org(qs) + off * (1 - frac1), qs)
            self._key(name, t + 0.7, off * (1 - frac1), ang=ang, ease=1)
            if s < strokes - 1:                                                      # lift off, swing back, re-engage
                self._tool_key(tr, t + 0.9, org(qs) + side * 6, qs)
                self._tool_key(tr, t + 1.3, org(q) + side * 6, q)
                t += 1.45
            else:
                t += 0.75
        self._tool_key(tr, t + 0.5, org(qs) + side * 90, qs)
        self.t = t + 0.5
        self._check_tool_path(tr, self.u.tmesh[tool], allow)
        self.toolTracks.append(tr)
        self._use_tool("wrench", "Adjustable wrench (jaw set to the measured hex)")
        return self

    def bead(self, centre, normal, radius, start_deg=90, sweep=360, dur=3.2, bead_d=4.0, label="silicone bead"):
        """Caulking dispenser: nozzle follows the joint, the knob drives the plunger, the bead grows."""
        n = unit(normal); u, v = perp_basis(n); C = np.asarray(centre, float)
        k = 48
        angs = [math.radians(start_deg + sweep * i / k) for i in range(k + 1)]
        pts = [C + radius * (math.cos(t) * u + math.sin(t) * v) + n * (bead_d * 0.35) for t in angs]
        tr = dict(tool="caulking", keys=[])
        t0 = self.t
        tang0 = unit(-math.sin(angs[0]) * u + math.cos(angs[0]) * v)
        ax0 = unit(n * 1.0 - tang0 * 0.75)
        q0 = frame_quat(ax0, n)
        self._shot(t0, C, radius=radius + 45, axis=n, kind="tool", tool=(self.u.tmesh["caulking"], pts[0] + n * 1.0, q0))
        self._tool_key(tr, t0, pts[0] + ax0 * 160, q0)
        self._tool_key(tr, t0 + 0.6, pts[0] + n * 1.0, q0)
        worst = {}
        for i, (P, t) in enumerate(zip(pts, angs)):
            tang = unit(-math.sin(t) * u + math.cos(t) * v)
            ax = unit(n * 1.0 - tang * 0.75)
            q = frame_quat(ax, n)
            ti = t0 + 0.7 + dur * i / k
            self._tool_key(tr, ti, P + n * 1.0, q)
            if i % 8 == 0:
                Mx = np.eye(4); Mx[:3, :3] = quat_to_mat(q); Mx[:3, 3] = P + n * 1.0
                for nn, d in self.u.world.hits(self.u.tmesh["caulking"], Mx, tol=1.2).items(): worst[nn] = max(worst.get(nn, 0), d)
        self.checks.append(dict(what="caulking dispenser path", samples=k // 8 + 1, clear=not worst, collisions={a: round(b, 2) for a, b in worst.items()}))
        self._sub(tr, "knob", t0 + 0.6, 0, 0); self._sub(tr, "knob", t0 + 0.7 + dur, 2 * math.pi * 3, 0)
        self._sub(tr, "plate", t0 + 0.6, 0, 0); self._sub(tr, "plate", t0 + 0.7 + dur, 6.0, 0)
        self._tool_key(tr, t0 + 1.1 + dur, pts[-1] + ax * 160, q)
        self.fx.append(dict(type="bead", points=[list(map(float, p)) for p in pts], diameter=bead_d,
                            colour=self.u.tools["caulking"].get("beadColour", "#c8281e"), grow=[round(t0 + 0.7, 3), round(t0 + 0.7 + dur, 3)], label=label))
        self.toolTracks.append(tr)
        self.t = t0 + 1.1 + dur
        self._use_tool("caulking", "Caulking dispenser, WEICON HT300 silicone (red, as supplied)")
        return self

    def mark(self, names, hints=((0, 1, 0), (1, 0, 0)), dir_hint=(1, 0, 0)):
        """Marker: a straight line from the centre of the head across its edge onto the clamped surface."""
        tr = dict(tool="marker", keys=[]); first = True
        for name in names:
            p = self.u.A[name]; a = unit(p["axis"]); H = np.asarray(p["head"])
            u_ = np.asarray(dir_hint, float); u_ = unit(u_ - a * (u_ @ a))
            r = max(c["d"] for c in p["cylinders"]) / 2 if p.get("cylinders") else 5
            r = max(r, (p["across_flats"][0] / 2 * 1.15) if p.get("across_flats") else r)
            hh = head_height(p)
            pts = [H + a * 0.15, H + u_ * r + a * 0.15, H + u_ * (r + 0.2) - a * (hh - 0.1),
                   H + u_ * (r + 7) - a * (hh + 1.4)]
            ax = unit(a * 0.85 + u_ * 0.35)
            q = frame_quat(ax, u_)
            t0 = self.t
            self._shot(t0 - 0.2, H, radius=40, axis=a, kind="tool", tool=(self.u.tmesh["marker"], pts[0], q))
            if first: self._tool_key(tr, t0, pts[0] + ax * 120, q)
            self._tool_key(tr, t0 + 0.5, pts[0], q)
            ts = [t0 + 0.5 + 0.28 * i for i in range(len(pts))]
            for P, ti in zip(pts, ts): self._tool_key(tr, ti, P, q)
            self._tool_key(tr, ts[-1] + 0.4, pts[-1] + ax * 40, q)
            self.fx.append(dict(type="line", points=[list(map(float, x)) for x in pts], width=1.2, colour="#e2131a",
                                draw=[round(ts[0], 3), round(ts[-1], 3)], label=f"tightening mark on {name}"))
            self.t = ts[-1] + 0.4
            first = False
        self._check_tool_path(tr, self.u.tmesh["marker"], set(names).union(*[set(self.u.A[n].get("contacts", [])) for n in names]))
        self.toolTracks.append(tr)
        self._use_tool("marker", "Marker (Sharpie Fine Point)")
        return self

    def decal(self, did, dur=2.0):
        d = self.u.decals[did]
        zc = (d["zLeft"] + d["zRight"]) / 2; yc = (d["yTop"] + d["yBottom"]) / 2
        t0 = self.t
        self._shot(t0, (0, yc, zc), radius=max(60, d["widthMm"] / 2 + 25), kind="detail", preferred=(1, 0.12, 0.0))
        self.fx.append(dict(type="decal", id=did, file=d["file"], centre=[0.25, yc, zc], normal=[1, 0, 0], up=[0, 1, 0],
                            width=d["widthMm"], height=d["heightMm"],
                            keys=[[0, 150, 0], [round(t0, 3), 150, 0], [round(t0 + dur * 0.6, 3), 4, 0], [round(t0 + dur * 0.8, 3), 0, 0.5], [round(t0 + dur, 3), 0, 1]]))
        self.t = t0 + dur
        return self

    def spin(self, names, pivot, axis, turns, dur, ramp=0.8):
        bb = np.array([self.u.A[n]["bbox"] for n in names]); c = (bb[:, :3].min(0) + bb[:, 3:].max(0)) / 2
        self._shot(self.t, c, radius=float(np.linalg.norm(bb[:, 3:].max(0) - bb[:, :3].min(0)) / 2), kind="wide")
        for n in names:
            self._track(n, axis=axis, pivot=pivot)
            self._key(n, 0); self._key(n, self.t)
            self._key(n, self.t + ramp, ang=2 * math.pi * turns * ramp / (dur) * 0.5, ease=0)
            self._key(n, self.t + dur, ang=2 * math.pi * turns, ease=0)
        self.t += dur
        return self

    def wait(self, s): self.t += s; return self

    def flag(self, text): self.flags.append(text); return self

    def hw(self, names, where):
        """Hardware list entry (grouped by base name, quantity counted from the CAD)."""
        c = Counter(base_name(n) for n in names)
        for b, q in c.items():
            ex = next(n for n in names if base_name(n) == b)
            self.hardware.append(dict(name=b, qty=q, where=where, **spec_of(ex, self.u.A[ex])))
        return self

    def _use_tool(self, tid, label):
        if tid not in [t["id"] for t in self.toolsUsed]: self.toolsUsed.append(dict(id=tid, label=label))

    def show(self, names):
        """Components visible (installed) from this step on without a motion of their own."""
        for n in names:
            self._track(n); self._key(n, 0)
        self._install(names)
        return self

    # ---------------------------------------------------------------- output
    def _frame_shots(self):
        """Opening overview (components + where they go) and closing result view of the step."""
        names = list(self.focus or self.components or self.parts.keys())
        names = [n for n in names if n in self.u.A]
        if not names: return
        bb = np.array([self.u.A[n]["bbox"] for n in names]); lo, hi = bb[:, :3].min(0), bb[:, 3:].max(0)
        R = float(np.linalg.norm(hi - lo)) / 2
        # the opening overview also shows where the components start (staging offsets of their tracks)
        slo, shi = lo.copy(), hi.copy()
        for n in names:
            tr = self.parts.get(n)
            if not tr or not tr["keys"]: continue
            T0 = np.array(tr["keys"][0][1:4]); b0 = np.asarray(self.u.A[n]["bbox"])
            slo = np.minimum(slo, b0[:3] + T0); shi = np.maximum(shi, b0[3:] + T0)
        wide = self.camera.get("wide")
        if wide or len(names) > 30:
            body = np.array([p["bbox"] for p in self.u.A.values()])
            lo, hi = body[:, :3].min(0), body[:, 3:].max(0); R = float(np.linalg.norm(hi - lo)) / 2 * 0.9
        starts = [s for s in self.shots if s["t"] < 0.5]
        if not starts:
            Rs = float(np.linalg.norm(shi - slo)) / 2
            self._shot(0.0, (slo + shi) / 2, radius=max(Rs * 1.1, R * 1.25, 70.0), kind="overview")
        self._shot(self.t + 0.1, (lo + hi) / 2, radius=max(R * 1.15, 70.0), kind="result")
        self.shots.sort(key=lambda s: s["t"])
        # drop shots closer than 0.35 s to the next one (the later one wins): fewer, calmer moves
        out = []
        for s in self.shots:
            if out and s["t"] - out[-1]["t"] < 0.35: out[-1] = s
            else: out.append(s)
        self.shots = out

    def to_json(self):
        u = self.u
        self._frame_shots()
        dur = round(self.t + 0.9, 3)

        def m3(v): return [round(float(x) * M, 6) for x in v]
        parts = []
        for tr in self.parts.values():
            ks = tr["keys"]
            last = ks[-1]
            if math.hypot(*last[1:4]) < 1e-6 and abs(last[8]) > 1e-9:
                # seated: make the total spin a whole number of turns so the part ends exactly in its
                # CAD orientation (affine remap keeps the start angle = hand-off from the previous step)
                a0, a1 = ks[0][8], last[8]
                # hex parts look identical every 60°: keep wrench strokes and part rotation in step
                per = math.pi / 3 if u.A[tr["name"]].get("across_flats") else 2 * math.pi
                target = round(a1 / per) * per
                if abs(a1 - a0) > 1e-9 and abs(target - a1) > 1e-9:
                    for k in ks: k[8] = round(a0 + (k[8] - a0) * (target - a0) / (a1 - a0), 6)
            keys = [[k[0], *m3(k[1:4]), *k[4:8], k[8], k[9]] for k in tr["keys"]]
            parts.append(dict(node=tr["node"], axis=tr["axis"], pivot=m3(tr["pivot"]), keys=keys))
        tools = []
        for tr in self.toolTracks:
            o = {k: v for k, v in tr.items() if k not in ("keys",)}
            o["keys"] = [[k[0], *m3(k[1:4]), *k[4:8]] for k in tr["keys"]]
            if "jawMm" in o: o["jaw"] = round(o.pop("jawMm") * M, 5)
            if "sub" in o:
                o["sub"] = {p: [[k[0], (k[1] * M if p in ("plate", "jaw") else k[1]), k[2]] for k in ks] for p, ks in o["sub"].items()}
            tools.append(o)
        fx = []
        for f in self.fx:
            g = dict(f)
            if f["type"] in ("bead", "line"): g["points"] = [m3(p) for p in f["points"]]
            if f["type"] == "bead": g["diameter"] = f["diameter"] * M
            if f["type"] == "line": g["width"] = f["width"] * M
            if f["type"] == "mandrels": g["items"] = [dict(i, head=m3(i["head"])) for i in f["items"]]
            if f["type"] == "spinArrow": g["centre"] = m3(f["centre"]); g["radius"] = f["radius"] * M
            if f["type"] == "decal":
                g["centre"] = m3(f["centre"]); g["width"] = f["width"] * M; g["height"] = f["height"] * M
                g["keys"] = [[k[0], k[1] * M, k[2]] for k in f["keys"]]
            fx.append(g)
        return dict(
            kind="unit", name=self.meta["title"], **self.meta,
            nodes=[u.ids[n] for n in self.components], assembly=u.asm["root"], assemblyInstances=[u.asm["root"]],
            verb=None, set=None, direction=None, flag=("; ".join(self.flags) or None), qty=len(self.components),
            hardware=self.hardware, tools=self.toolsUsed, flags=self.flags,
            camera=dict(self.camera, shots=[[s["t"], *m3(s["target"]), *[round(x, 4) for x in s["dir"]], round(s["radius"] * M, 4)] for s in self.shots],
                        shotKinds=[s["kind"] for s in self.shots], shotBlocked=[len(s["blocked"]) for s in self.shots],
                        shotInside=[int("(camera inside geometry)" in s["blocked"]) for s in self.shots]),
            focus=[u.ids[n] for n in (self.focus or self.components)], duration=dur,
            checks=self.checks, tracks=dict(parts=parts, tools=tools, fx=fx),
        )


def slerp(a, b, t):
    a = np.asarray(a, float); b = np.asarray(b, float); d = float(a @ b)
    if d < 0: b, d = -b, -d
    if d > 0.9995: r = a + t * (b - a); return r / np.linalg.norm(r)
    th = math.acos(d); s = math.sin(th)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / s


def socket_label(af):
    table = [(9.525, "3/8 in"), (10.0, "10 mm"), (11.1125, "7/16 in"), (14.2875, "9/16 in"), (26.99, "1-1/16 in")]
    best = min(table, key=lambda kv: abs(kv[0] - af))
    return best[1] if abs(best[0] - af) < 0.45 else f"{fmt(af)} mm"


# ======================================================================= main

def report(U, out_md):
    """docs/unit-engineering-report.md: hardware table, validation results, open engineering items."""
    L = ["# Unit installation tutorial — engineering accuracy report (v2.1)", "",
         "*Generated by `pipeline/unit/build_unit.py` — do not edit by hand.*", "",
         "Source: `MF-550-210-B_GROUPED_ASSEMBLY.step` (AP242). The STEP carries **no part numbers, descriptions or BOM data**",
         "(only the material \"Steel\" on every part), so every size below is **measured from the modelled geometry**",
         "(`pipeline/unit/analyse_unit.py`: cylindrical faces along the fastener axis, hex flats, overall length) and",
         "inch / metric designations are the nearest standard size to the measurement. Nothing is marked *verified* because",
         "no drawing or BOM was supplied to verify against.", "",
         "## Hardware", "",
         "| Component | Fastener type | Size | Length | Qty | Installed in step | Drive / tool | Verification status |",
         "|---|---|---|---|---|---|---|---|"]
    seen = {}
    for s in U.steps:
        for h in s.hardware:
            key = (h["name"], s.i)
            if key in seen: continue
            seen[key] = 1
            L.append(f"| {h['name']} | {h['type']} | {h['size']} | {h['length']} | {h['qty']} | {s.i + 1}. {s.meta['title']} | {h['drive']} | {h['status']}; {h['confirm']} |")
    total = Counter(base_name(n) for n, p in U.A.items() if p["fastener"])
    L += ["", "Quantities counted in the CAD: " + ", ".join(f"{b} × {q}" for b, q in sorted(total.items())) + ".", "",
          "## Tools", "",
          "| Tool | Supplied model | Used in steps | Note |", "|---|---|---|---|"]
    uses = {}
    for s in U.steps:
        for t in s.toolsUsed: uses.setdefault(t["id"], []).append(str(s.i + 1))
    for tid, meta in U.tools.items():
        L.append(f"| {tid} | `{meta['source']}` | {', '.join(uses.get(tid, [])) or '—'} | {meta['note']} |")
    L += ["", "Missing tool models (identified, not substituted): 10 mm, 3/8 in and 7/16 in sockets (shown as the supplied 9/16 in",
          "socket resized radially to the measured hex — labelled on screen), a screwdriver bit for the pan-head screws (placeholder",
          "hex bit, labelled).", "", "## Path and tool validation", "",
          "Every part motion and tool pose is checked against the parts installed at that point (exact mesh collision, python-fcl,",
          "coarse tessellation; penetrations under 0.6 mm and contacts with the mating parts in the final seating are tolerated).", "",
          "v2.1 rules (stricter than v2.0):", "",
          "- **Clip nuts** slide on with the mating sheet NOT tolerated (a small ride offset along the clip axis is searched,",
          "  the spring legs over the sheet); only the final snap may touch it. Base clip nuts are pushed straight up from below.",
          "- **Tool paths**: every segment of every tool track (approach, hops between fasteners, retract) is sampled and",
          "  checked (1.5 mm tolerance for the coarse tool meshes). The roll of the drill / rivet gun about the working axis is",
          "  chosen so that the whole straight retract along the axis is clear; hops between fasteners rise to a clearance",
          "  height or are routed around the unit (outside its box) when the straight hop would pass through it.",
          "- **Wrench**: the roll is chosen so that the whole stroke (engaged, swung, lifted off, approach) is clear; where",
          "  only a shorter arc exists the strokes are shortened and the step is flagged.",
          "- **Impeller sub-assembly**: the wheel sliding up onto the motor shaft and the inlet bellmouth rising under it are",
          "  checked mesh-to-mesh before the assembly is raised straight up through the open base into the fitted bracket.",
          "- **Drill**: the drill body and socket do not rotate; the fastener turns (clockwise seen from the tool side) and an",
          "  orange curved arrow around its axis is shown only while it is tightened.", "",
          "| Step | Checks | Clear | Not clear (part: depth mm) |", "|---|---|---|---|"]
    for s in U.steps:
        bad = [c for c in s.checks if not c["clear"]]
        L.append(f"| {s.i + 1}. {s.meta['title']} | {len(s.checks)} | {len(s.checks) - len(bad)} | " +
                 ("; ".join(f"{c['what']} → " + ", ".join(f"{k}: {v}" for k, v in c['collisions'].items()) for c in bad[:4]) or "—") + " |")
    L += ["", "## Automatic camera (v2.1)", "",
          "Per-operation camera shots chosen at build time: an opening overview (components at their starting points and",
          "where they go), the approach / close-up of every fastener with its tool, wider views for modules and a result view.",
          "Each direction is scored for a clear line of sight to the working point (thin cylinder against the installed parts",
          "and against the tool body at its working pose; in x-ray steps only the step's own parts count), the insertion axis",
          "seen from the side and a camera position outside the geometry. Radius = framing sphere (zoom).", "",
          "| Step | Shots | Kinds | Radius mm (min–max) | Shots with an occluder |", "|---|---|---|---|---|"]
    for s in U.steps:
        if not s.shots: L.append(f"| {s.i + 1}. {s.meta['title']} | 0 | — | — | — |"); continue
        kinds = Counter(x["kind"] for x in s.shots)
        rs = [x["radius"] for x in s.shots]
        occl = [x for x in s.shots if x["blocked"]]
        L.append(f"| {s.i + 1}. {s.meta['title']} | {len(s.shots)} | " + ", ".join(f"{k} {v}" for k, v in kinds.items()) +
                 f" | {min(rs):.0f}–{max(rs):.0f} | " + ("; ".join(f"t={x['t']}: {', '.join(x['blocked'])}" for x in occl[:3]) or "—") + " |")
    L += ["", "## Items requiring engineering confirmation", ""]
    for s in U.steps:
        for f in s.flags: L.append(f"- **Step {s.i + 1} – {s.meta['title']}:** {f}")
    out_md.write_text("\n".join(L) + "\n")


def main():
    conv = Path(sys.argv[1])                              # converter assembly.json of the grouped STEP
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "public/assets/unit/assembly.json"
    analysis = json.load(open(HERE / "unit-analysis.json"))
    asm = json.load(open(conv))
    tools = json.load(open(ROOT / "public/assets/unit/tools/tools.json"))
    decals = json.load(open(ROOT / "public/assets/unit/decals/decals.json"))
    U = Unit(analysis, asm, tools, decals)
    import steps_unit
    steps_unit.define(U)
    missing = [n for n in U.A if n not in U.installed_by]
    if missing: raise SystemExit(f"parts never installed: {missing}")
    steps = [s.to_json() for s in U.steps]
    for n in asm["nodes"]:
        n["step"] = U.installed_by.get(n["name"]) if n["kind"] == "part" else None
        n["explode"] = [0.0, 0.0, 0.0]
    kids = {n["id"]: n for n in asm["nodes"]}
    def first_step(nid):
        n = kids[nid]
        if n["kind"] == "part": return n["step"]
        v = [first_step(c) for c in n["children"]]; v = [x for x in v if x is not None]
        return min(v) if v else None
    for row in asm["bom"]:
        row["steps"] = sorted({first_step(i) for i in row["nodes"]} - {None})
    asm["steps"] = steps
    asm["meta"].update(tutorial="unit", sequenceSource="authored installation sequence (pipeline/unit/steps_unit.py), validated against the CAD",
                       stepCount=len(steps), units="metres", productDisplay="Mist-Fit 550")
    json.dump(asm, open(out, "w"), separators=(",", ":"))
    report(U, ROOT / "docs/unit-engineering-report.md")
    bad = sum(1 for s in U.steps for c in s.checks if not c["clear"])
    print(f"{len(steps)} steps, {sum(len(s.checks) for s in U.steps)} checks ({bad} not clear), "
          f"{sum(len(s['tracks']['parts']) for s in steps)} part tracks -> {out} ({out.stat().st_size / 1024:.0f} kB)")


if __name__ == "__main__":
    main()
