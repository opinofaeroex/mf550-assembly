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
    HOLD0 = 0.8

    def __init__(self, unit, index, phase, phaseTitle, title, text, speech=None, camera=None):
        self.u, self.i = unit, index
        self.meta = dict(phase=phase, phaseTitle=phaseTitle, title=title, text=text, speech=speech or f"{title}. {text}")
        self.camera = camera or {}
        self.t = self.HOLD0
        self.parts = OrderedDict()                # name -> track
        self.toolTracks, self.fx = [], []
        self.components, self.hardware, self.toolsUsed, self.flags, self.checks = [], [], [], [], []
        self.focus = []

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
        for n in names:
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
        mates = set(p.get("contacts", []))
        mesh = self.u.world.mesh[name]
        if kind == "clip":
            sd = unit(slide)
            start = sd * (travel or 30.0)
            self._key(name, 0, start); self._key(name, self.t, start)
            self._key(name, self.t + dur * 0.75, sd * 1.2, ease=1)
            self._key(name, self.t + dur, (0, 0, 0), ease=1)          # snap home
            mats = [delta_matrix(start * (1 - s), ID_Q, head, a, 0) for s in np.linspace(0, 1, 24)[:-1]]
            self._check(f"clip {name}", mesh, mats, allow=set(allow) | mates)
            self.t += dur; self._install([name]); return self
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
            ang = 2 * math.pi * hand_turns * (1 if kind != "nut" else 1)
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
        self._key(name, self.t + dur, (0, 0, 0), ang=last[8] + 2 * math.pi * turns, ease=0)
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

    def _tool_pose_free(self, tool, origin, y_axis, allow, hints, extra=None, mesh=None):
        """Roll about the working axis so the tool clears the installed parts (first clear hint wins)."""
        mesh = mesh if mesh is not None else self.u.tmesh[tool]
        tried = []
        for h in hints:
            for k in range(12):
                rot = quat_axis_angle(y_axis, k * math.pi / 6)
                xh = quat_to_mat(rot) @ unit(h)
                q = frame_quat(y_axis, xh)
                Mx = np.eye(4); Mx[:3, :3] = quat_to_mat(q); Mx[:3, 3] = origin
                hit = self.u.world.hits(mesh, Mx, allow=allow, tol=1.5)
                tried.append((sum(hit.values()), q, hit))
                if not hit: return q, {}
        best = min(tried, key=lambda x: x[0])
        return best[1], best[2]

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
        if tool not in [t["id"] for t in self.toolsUsed]:
            pass
        first = True
        for name in names:
            self._carried(name)
        for name in names:
            p = self.u.A[name]; a = unit(p["axis"]); head = np.asarray(p["head"])
            kind_nut = "Nut" in name
            side = unit(self.parts[name]["keys"][-1][1:4]) if np.linalg.norm(self.parts[name]["keys"][-1][1:4]) > 0.05 else a
            haf = af or (p["across_flats"][0] if p.get("across_flats") else SOCKET_SUPPLIED_AF)
            tr["socketAF"] = haf
            hh = head_height(p) if not kind_nut else p["length"]
            dep = depth if depth is not None else max(2.0, (hh if not kind_nut else p["length"]) * 0.6)
            # socket opening sits `dep` below the outer end of the head / nut (outer end = head for bolts,
            # far end of the nut for nuts)
            outer = head if not kind_nut else head + side * p["length"] if np.dot(side, a) < 0 else head
            if kind_nut:
                outer = np.asarray(p["tip"]) if np.dot(unit(np.asarray(p["tip"]) - head), side) > 0 else head
            eng_seated = outer - side * dep
            ftr = self.parts[name]
            last = ftr["keys"][-1]; off = np.array(last[1:4]); ang0 = last[8]
            allow = {name} | set(p.get("contacts", []))
            q, hit = self._tool_pose_free(tool, eng_seated, side, allow, hints, mesh=self._drill_mesh(haf))
            self.checks.append(dict(what=f"drill on {name}", samples=1, clear=not hit,
                                    collisions={k: round(v, 2) for k, v in hit.items()}))
            appr = 70.0
            t0 = self.t
            if first:
                self._tool_key(tr, t0, eng_seated + off + side * (appr + 60), q)
            self._tool_key(tr, t0 + 0.45, eng_seated + off + side * appr * 0.3, q)
            self._tool_key(tr, t0 + 0.7, eng_seated + off, q)                         # socket over the head
            spin_t0, spin_t1 = t0 + 0.75, t0 + 0.75 + 0.35 * turns
            for part in ("socket", "adapter", "chuck"):
                self._sub(tr, part, spin_t0, 0, 0); self._sub(tr, part, spin_t1, 2 * math.pi * turns, 0)
            self._tool_key(tr, spin_t0, eng_seated + off, q)
            self._tool_key(tr, spin_t1, eng_seated, q)                                # follows the fastener home
            self._key(name, spin_t0, off, ang=ang0, ease=0)
            self._key(name, spin_t1, (0, 0, 0), ang=ang0 + 2 * math.pi * turns, ease=0)
            self._tool_key(tr, spin_t1 + 0.45, eng_seated + side * appr, q)
            self.t = spin_t1 + 0.45
            first = False
        self._tool_key(tr, self.t + 0.35, np.array(tr["keys"][-1][1:4]) + np.array(tr["keys"][-1][1:4]) * 0 + side * 60, q)
        self.t += 0.35
        tr["socketScale"] = round(tr.get("socketAF", SOCKET_SUPPLIED_AF) / SOCKET_SUPPLIED_AF, 4)
        self.toolTracks.append(tr)
        self._use_tool("drill", f"Cordless drill + {socket_label(tr['socketAF'])} socket" + ("" if abs(tr["socketScale"] - 1) < 0.02 else " (socket resized from the supplied 9/16 in model)"))
        return self

    def rivet(self, names, hints=((0, -1, 0), (0, 1, 0), (1, 0, 0))):
        """Insert each closed-end rivet by hand, then set it with the rivet gun (mandrel pulled and broken)."""
        tool = "rivetgun"; tr = dict(tool=tool, keys=[]); first = True
        mand = dict(type="mandrels", items=[])
        for k, name in enumerate(names):
            p = self.u.A[name]; a = unit(p["axis"]); head = np.asarray(p["head"])
            pace = 1.0 if k < 2 else 0.6
            self.fastener(name, "rivet", gap=14, dur=0.55 * pace + 0.15)
            allow = {name} | set(p.get("contacts", []))
            q, hit = self._tool_pose_free(tool, head, a, allow, hints)
            self.checks.append(dict(what=f"rivet gun on {name}", samples=1, clear=not hit, collisions={k2: round(v, 2) for k2, v in hit.items()}))
            t0 = self.t
            if first: self._tool_key(tr, t0 - 0.1, head + a * 140, q)
            self._tool_key(tr, t0 + 0.4 * pace, head + a * 0.5, q)
            self._tool_key(tr, t0 + 0.55 * pace, head, q)                             # nose on the flange
            pull0, pull1 = t0 + 0.6 * pace, t0 + 0.6 * pace + 0.45
            self._sub(tr, "trigger", pull0, 0); self._sub(tr, "trigger", pull1, 1); self._sub(tr, "trigger", pull1 + 0.25, 0)
            self._sub(tr, "nose", pull0, 0); self._sub(tr, "nose", pull1, 1); self._sub(tr, "nose", pull1 + 0.25, 0)
            self._tool_key(tr, pull1 + 0.05, head, q)
            self._tool_key(tr, pull1 + 0.35, head + a * 45, q)
            mand["items"].append(dict(head=list(head), axis=list(a), show=round(self.t - (0.55 * pace + 0.15), 3),
                                      pull=[round(pull0, 3), round(pull1, 3)]))
            self.t = pull1 + 0.35
            first = False
        self._tool_key(tr, self.t + 0.3, np.array(tr["keys"][-1][1:4]) + unit(self.u.A[names[-1]]["axis"]) * 120, tr["keys"][-1][4:8])
        self.t += 0.3
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
        for h in hints:
            for k in range(12):
                xh = quat_to_mat(quat_axis_angle(side, k * math.pi / 6)) @ unit(h)
                q = frame_quat(side, xh)
                origin = C + quat_to_mat(q) @ np.array([0, 0, w / 2])
                Mx = np.eye(4); Mx[:3, :3] = quat_to_mat(q); Mx[:3, 3] = origin
                hit = self.u.world.hits(self.u.tmesh[tool], Mx, allow=allow, tol=1.5)
                if best is None or sum(hit.values()) < best[0]: best = (sum(hit.values()), q, hit)
                if not hit: break
            if best and not best[2]: break
        q = best[1]; hits = best[2]
        self.checks.append(dict(what=f"wrench on {name}", samples=1, clear=not hits, collisions={k: round(v, 2) for k, v in hits.items()}))

        def org(qq): return C + quat_to_mat(qq) @ np.array([0, 0, w / 2])
        t0 = self.t
        self._sub(tr, "jaw", t0, 0, 0); self._sub(tr, "jaw", t0 + 0.01, w + 0.3, 0)      # opened before it appears
        self._tool_key(tr, t0, org(q) + side * 90, q)
        self._tool_key(tr, t0 + 0.6, org(q), q)
        ftr = self.parts[name]; last = ftr["keys"][-1]; off = np.array(last[1:4]); ang = last[8]
        t = t0 + 0.7
        for s in range(strokes):
            qs = quat_mul(quat_axis_angle(side, math.radians(swing_deg)), q)
            frac0, frac1 = s / strokes, (s + 1) / strokes
            self._tool_key(tr, t, org(q) + off * (1 - frac0), q)
            self._key(name, t, off * (1 - frac0), ang=ang, ease=0)
            ang += math.radians(swing_deg)
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
            if first: self._tool_key(tr, t0, pts[0] + ax * 120, q)
            self._tool_key(tr, t0 + 0.5, pts[0], q)
            ts = [t0 + 0.5 + 0.28 * i for i in range(len(pts))]
            for P, ti in zip(pts, ts): self._tool_key(tr, ti, P, q)
            self._tool_key(tr, ts[-1] + 0.4, pts[-1] + ax * 40, q)
            self.fx.append(dict(type="line", points=[list(map(float, x)) for x in pts], width=1.2, colour="#e2131a",
                                draw=[round(ts[0], 3), round(ts[-1], 3)], label=f"tightening mark on {name}"))
            self.t = ts[-1] + 0.4
            first = False
        self.toolTracks.append(tr)
        self._use_tool("marker", "Marker (Sharpie Fine Point)")
        return self

    def decal(self, did, dur=2.0):
        d = self.u.decals[did]
        zc = (d["zLeft"] + d["zRight"]) / 2; yc = (d["yTop"] + d["yBottom"]) / 2
        t0 = self.t
        self.fx.append(dict(type="decal", id=did, file=d["file"], centre=[0.25, yc, zc], normal=[1, 0, 0], up=[0, 1, 0],
                            width=d["widthMm"], height=d["heightMm"],
                            keys=[[0, 150, 0], [round(t0, 3), 150, 0], [round(t0 + dur * 0.6, 3), 4, 0], [round(t0 + dur * 0.8, 3), 0, 0.5], [round(t0 + dur, 3), 0, 1]]))
        self.t = t0 + dur
        return self

    def spin(self, names, pivot, axis, turns, dur, ramp=0.8):
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
    def to_json(self):
        u = self.u
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
                target = round(a1 / (2 * math.pi)) * 2 * math.pi
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
            if f["type"] == "decal":
                g["centre"] = m3(f["centre"]); g["width"] = f["width"] * M; g["height"] = f["height"] * M
                g["keys"] = [[k[0], k[1] * M, k[2]] for k in f["keys"]]
            fx.append(g)
        return dict(
            kind="unit", name=self.meta["title"], **self.meta,
            nodes=[u.ids[n] for n in self.components], assembly=u.asm["root"], assemblyInstances=[u.asm["root"]],
            verb=None, set=None, direction=None, flag=("; ".join(self.flags) or None), qty=len(self.components),
            hardware=self.hardware, tools=self.toolsUsed, flags=self.flags, camera=self.camera,
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
    L = ["# Unit installation tutorial — engineering accuracy report (v2.0)", "",
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
          "| Step | Checks | Clear | Not clear (part: depth mm) |", "|---|---|---|---|"]
    for s in U.steps:
        bad = [c for c in s.checks if not c["clear"]]
        L.append(f"| {s.i + 1}. {s.meta['title']} | {len(s.checks)} | {len(s.checks) - len(bad)} | " +
                 ("; ".join(f"{c['what']} → " + ", ".join(f"{k}: {v}" for k, v in c['collisions'].items()) for c in bad[:4]) or "—") + " |")
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
