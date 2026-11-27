#!/usr/bin/env python3
"""
build_unit.py — the Mist-Fit 550 unit-installation tutorial (v2.0, refined in v2.1)
==================================================================

Inputs
  pipeline/unit/unit-analysis.json      CAD facts (analyse_unit.py): axes, heads, sizes, contacts
  pipeline/unit/cache/meshes.npz        part meshes (mm) for collision checks (analyse_unit.py)
  pipeline/unit/cache/tool_*.npz        tool meshes in their working frame (build_tools.py)
  [assembly.json]                       node / BOM source: the convert_step.py output for
                                        MF-550-210-B_GROUPED_ASSEMBLY — or, by default, the published
                                        public/assets/unit/assembly.json itself (its steps are rebuilt;
                                        the result is byte-identical), so a rebuild needs only the repo
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
from unitlib import (ID_Q, World, delta_matrix, frame_quat, mat_to_quat, perp_basis, quat_axis_angle, quat_conj, quat_mul,  # noqa: E402
                     quat_to_mat, tool_mesh, unit)
import standards as S  # noqa: E402  shared animation / camera / collision parameters (standards § 10)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE / "cache"                       # tracked in git: rebuilds need no STEP files
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
    if b == "Door Bolt Washer":                       # v2.2: identified as a bonded sealed washer (engineering)
        return dict(type="Bonded sealed washer", size="sealing lip ID Ø5.56 mm (for the Ø6.35 mm bolt)", length="OD Ø15.88 mm, 3.26 mm",
                    drive="—", status="Measured from CAD",
                    confirm="rubber / metal grade and the bolt size it seals are not in the CAD")
    if b == "NPTA12_L_body_with_seal":
        return dict(type="L-connector body (90° elbow) with seal", size="thread OD Ø21.2 mm (1/2 in NPT class)", length="48.9 × 53.2 × 34.6 mm",
                    drive="pushed through the Ø21.4 mm cable entry hole", status=meas, confirm="thread designation and cable sealing range not in CAD")
    if b == "NPTA12_locknut":
        return dict(type="Locknut", size="to suit the L-connector thread", length="6.0 mm thick",
                    drive=f"{fmt(af[0])} mm A/F (1-1/16 in socket, ratchet)", status=meas, confirm="tightening torque not specified")
    if b == "NPTA12_o_ring":
        return dict(type="O-ring", size="OD Ø28.1 mm", length="2.0 mm section", drive="—", status=meas, confirm="material not in CAD")
    if b == "NPTA12_sealing_nut":
        return dict(type="Sealing nut (cable gland)", size="cable bore Ø13.4 mm", length=f"{fmt(L)} mm", drive="hand-tight on the leads",
                    status=meas, confirm="sealing insert range for nine single leads not specified")
    if b == "CSHM 06 Connector Insert":
        return dict(type="Connector insert, 6 poles + PE (supplied cshm_06.stp)", size="50 × 34 × 40 mm", length="push-release terminals (ferrules / splices)",
                    drive="—", status="Supplied model (real geometry); wired for 230/3/60",
                    confirm="position, contact numbering and PE terminal: assumptions accepted by engineering; mating housing / plug not supplied")
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
        self.bench = None                         # v2.2: active bench sub-assembly (bench_begin / bench_end)
        self.bench_parts = {}                     # name -> bench offset (mm) while it is on the bench
        self.held = set()                         # v2.2: parts kept at their staged pose across steps (holds)
        self.labels = {}                          # v2.2: display labels for CAD names (node.label)

    def group(self, g): return [n for n, p in self.A.items() if p["group"] == g]

    # ---------------------------------------------------------------- v2.2 bench sub-assembly
    def bench_begin(self, names, offset=S.BENCH.offset, rot=None, pivot=None):
        """Build a sub-assembly on the bench: the named parts are worked on at CAD + offset. Their facts and
        collision meshes are moved there, so every Step operation (place, fastener, drill, mark …) runs at the
        bench unchanged and is checked against the parts already on the bench AND the unit; part keys are
        written as deltas on the CAD pose (offset included). bench_end() puts them back for the move into
        the unit."""
        O = np.asarray(offset, float); self.bench = dict(O=O, A0={}, M0={})
        # v2.3: optional rotation of the whole sub-assembly about `pivot` (default: centre of the named parts),
        # e.g. the bellmouth plate turned over on the worktable: x_bench = R x_cad + tb
        qb = ID_Q if rot is None else quat_axis_angle(unit(rot[0]), math.radians(rot[1]))
        Rb = quat_to_mat(qb)
        if pivot is None:
            bb = np.array([self.A[n]["bbox"] for n in names]); pivot = (bb[:, :3].min(0) + bb[:, 3:].max(0)) / 2
        tb = np.asarray(pivot, float) + O - Rb @ np.asarray(pivot, float)
        for n in names:
            p = self.A[n]; self.bench["A0"][n] = json.loads(json.dumps(p)); self.bench["M0"][n] = self.world.mesh[n]
            b = np.asarray(p["bbox"], float); C = np.array([[b[i + 3] if (k >> i) & 1 else b[i] for i in range(3)] for k in range(8)])
            C = C @ Rb.T + tb; p["bbox"] = [*map(float, C.min(0)), *map(float, C.max(0))]
            for k in ("centre", "head", "tip"):
                if k in p: p[k] = list(Rb @ np.asarray(p[k], float) + tb)
            if "axis" in p: p["axis"] = list(Rb @ np.asarray(p["axis"], float))
            m = self.world.mesh[n].copy(); m.vertices = m.vertices @ Rb.T + tb; self.world.mesh[n] = m
            self.bench_parts[n] = (qb, tb)
            self.held.add(n)

    def bench_end(self):
        """Back to the CAD frame: bench parts leave the collision world (they move as one group next)."""
        names = list(self.bench["A0"])
        self.world.remove(names)
        for n in names:
            self.A[n].clear(); self.A[n].update(self.bench["A0"][n]); self.world.mesh[n] = self.bench["M0"][n]
            self.bench_parts.pop(n, None)
        self.bench = None
        return names

    def finalize_holds(self):
        """v2.2: a part staged away from its CAD pose (bench, door on the bench …) keeps that pose in every
        step until it moves again: the runtime shows parts without a track at their CAD pose, so such steps
        get a constant `hold` track (excluded from the step's active parts)."""
        last = {}
        for s in self.steps:
            for n in sorted(self.held):
                if n in s.parts:
                    tr = s.parts[n]; last[n] = (tr["keys"][-1], tr["axis"], tr["pivot"]); continue
                if n not in last or self.installed_by.get(n, 1e9) >= s.i: continue
                k, axis, pivot = last[n]
                if max(abs(v) for v in k[1:4]) < 1e-6 and abs(math.remainder(k[8], 2 * math.pi)) < 1e-4 and abs(k[7] - 1) < 1e-9: continue   # whole turns = CAD pose
                s.parts[n] = dict(node=self.ids[n], name=n, axis=axis, pivot=pivot, hold=True,
                                  keys=[[0.0, *k[1:8], k[8], 1]])

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
    HOLD0 = S.STEP.opening_hold                   # v2.1: opening overview before the first motion

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
            B = self.u.bench_parts.get(name)
            if B is not None:                                              # pivots / spin axes live in the CAD frame
                Rb = quat_to_mat(B[0])
                if pivot is not None: pivot = Rb.T @ (np.asarray(pivot, float) - B[1])
                if axis is not None: axis = Rb.T @ np.asarray(axis, float)
            self.parts[name] = dict(node=self.u.ids[name], name=name, axis=list(unit(axis)) if axis is not None else [0, 1, 0],
                                    pivot=list(np.asarray(pivot, float)) if pivot is not None else [0, 0, 0], keys=[])
        return self.parts[name]

    def _last(self, name):
        """Last key of a part as a LOCAL offset (bench offset removed) — what the operations reason with."""
        k = list(self.parts[name]["keys"][-1]); B = self.u.bench_parts.get(name)
        if B is not None:
            ql = quat_mul(k[4:8], quat_conj(B[0]))
            k[1:4] = list(np.asarray(k[1:4]) - quat_to_mat(ql) @ B[1]); k[4:8] = list(ql)
        return k

    def _carried(self, name):
        """Track for a part installed in an earlier step that moves again here (e.g. tightened now)."""
        if name in self.parts: return self.parts[name]
        p = self.u.A[name]
        c = self.u.carry.get(name)
        if c:
            tr = self._track(name, axis=c[3]); tr["pivot"] = list(c[4])                  # carried pivot: CAD frame already
            self._key(name, 0, c[0], c[1], c[2], raw=True)
        else:
            tr = self._track(name, axis=p.get("axis"), pivot=p.get("head")); self._key(name, 0)
        return tr

    def _key(self, name, t, T=(0, 0, 0), q=ID_Q, ang=0.0, ease=1, raw=False):
        tr = self.parts[name]
        B = None if raw else self.u.bench_parts.get(name)
        if B is not None:                                                    # bench: delta on the CAD pose
            T = np.asarray(T, float) + quat_to_mat(q) @ B[1]; q = quat_mul(q, B[0])
        tr["keys"].append([round(t, 3), *[round(float(v), 3) for v in T], *[round(float(v), 6) for v in q], round(float(ang), 4), ease])

    def _install(self, names):
        """Parts become obstacles for later motions once their own motion is recorded."""
        self.u.world.add(names)
        self._appear(names)

    def _appear(self, names):
        """Parts are part of the product from this step on (visible, listed) — v2.2: also when only staged."""
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
    def place(self, names, path, tilt=None, dur=None, label=None, allow=(), final_allow=(), ease_last=True, pivot=None, tilt_rate=None):
        """Rigid group from path[0] (offset from CAD, mm) through path[...] to the CAD position.
        tilt=(axis, deg): extra rotation about the group centre at the start, removed along the path."""
        names = list(names)
        A = self.u.A
        bb = np.array([A[n]["bbox"] for n in names]); lo, hi = bb[:, :3].min(0), bb[:, 3:].max(0)
        P = (lo + hi) / 2 if pivot is None else np.asarray(pivot, float)
        pts = [np.asarray(p, float) for p in path] + [np.zeros(3)]
        seg = [np.linalg.norm(pts[k + 1] - pts[k]) for k in range(len(pts) - 1)]
        total = sum(seg) or 1.0
        dur = dur or float(np.clip(S.PLACE.dur_base + total / S.PLACE.mm_per_s, S.PLACE.dur_min, S.PLACE.dur_max))
        qs = quat_axis_angle(tilt[0], math.radians(tilt[1])) if tilt else ID_Q

        def pose(s):                                  # s in [0,1] along the path length
            d = s * total; k = 0
            while k < len(seg) - 1 and d > seg[k]: d -= seg[k]; k += 1
            f = 0 if seg[k] == 0 else min(1, d / seg[k])
            o = pts[k] + (pts[k + 1] - pts[k]) * f
            q = slerp(qs, ID_Q, min(1, s * (tilt_rate or S.PLACE.tilt_removal_rate))) if tilt else ID_Q
            T = o + P - quat_to_mat(q) @ P
            return T, q

        for n in names: self._track(n)
        T0, q0 = pose(0)
        size = float(np.linalg.norm(hi - lo))
        motion = pts[-2] - pts[-1] if len(pts) > 1 else np.zeros(3)
        mid = (lo + hi) / 2 + pts[0] / 2
        self._shot(self.t, mid, radius=float(np.linalg.norm(pts[0]) / 2 + size / 2), kind="wide",
                   axis=unit(motion) if np.linalg.norm(motion) > 1 else None, ignore=names)
        self._shot(self.t + dur * S.PLACE.detail_shot_at, (lo + hi) / 2, radius=max(S.PLACE.detail_min_radius, size / 2 * S.PLACE.detail_pad), kind="detail",
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
            nsub = max(1, int(L / S.PLACE.key_spacing))
            for j in range(1, nsub + 1):
                ss = (acc - L + L * j / nsub) / total
                T, q = pose(ss)
                for n in names: self._key(n, self.t + dur * ss, T, q, ease=0 if (k < len(seg) - 1 or j < nsub or not ease_last) else 1)
        mats = []
        for s in np.linspace(0, 1, S.PLACE.samples)[:-1]:
            T, q = pose(s); mats.append(delta_matrix(T, q, P, (0, 1, 0), 0))
        self._check(label or f"place {', '.join(base_name(n) for n in names[:3])}{'…' if len(names) > 3 else ''}",
                    self._group_mesh(names), mats, allow=allow, final_allow=final_allow, n_final=S.PLACE.final_allow_samples)
        self.t += dur
        self._install(names)
        return self

    # ---------------------------------------------------------------- fasteners
    def fastener(self, name, kind, side=None, gap=S.FASTENER.gap, engage=None, hand_turns=S.FASTENER.hand_turns, dur=1.0, slide=None,
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
            sd = unit(slide); trav = travel or S.CLIP.travel
            ride = None
            for o in S.CLIP.ride_offsets:
                if all(not self.u.world.hits(mesh, delta_matrix(sd * trav * (1 - s) + a * o, ID_Q, head, a, 0), allow=set(allow))
                       for s in np.linspace(0, 1, S.CLIP.slide_samples)[:-1]):
                    ride = a * o; break
            ride = ride if ride is not None else np.zeros(3)
            self._shot(self.t - S.FASTENER.shot_lead, head, radius=S.CLIP.shot_radius, axis=sd, kind="detail")
            start = sd * trav + ride
            self._key(name, 0, start); self._key(name, self.t, start)
            self._key(name, self.t + dur * S.CLIP.snap_at, ride if np.linalg.norm(ride) > 0 else sd * S.CLIP.overshoot, ease=1)
            self._key(name, self.t + dur, (0, 0, 0), ease=1)          # snap home
            slide_offs = [sd * trav * (1 - s) + ride for s in np.linspace(0, 1, S.CLIP.slide_samples)[:-1]]
            snap_offs = [ride * (1 - s) for s in np.linspace(0, 1, S.CLIP.snap_samples)] if np.linalg.norm(ride) > 0 else []
            mats = [delta_matrix(o, ID_Q, head, a, 0) for o in slide_offs + snap_offs]
            allow_at = [set()] * len(slide_offs) + [mates] * len(snap_offs)
            tr["ride"] = [round(float(x), 3) for x in ride]
            self._check(f"clip {name}", mesh, mats, allow=set(allow), allow_at=allow_at)
            self.t += dur; self._install([name]); return self
        if kind != "rivet":
            self._shot(self.t - S.FASTENER.shot_lead, head, radius=max(S.FASTENER.detail_min_radius, L * S.FASTENER.detail_per_length), axis=side, kind="detail")
        clear = travel or (L + gap)
        e = engage if engage is not None else (min(S.FASTENER.engage_max, S.FASTENER.engage_share * L) if kind in ("bolt", "screw", "nut") else 0.0)
        start = side * clear
        self._key(name, 0, start); self._key(name, self.t, start)
        t1 = self.t + dur * (S.FASTENER.insert_share if e else 1.0)
        self._key(name, t1, side * e, ease=1)
        offs = [start + (side * e - start) * s for s in np.linspace(0, 1, S.FASTENER.samples)]
        mats = [delta_matrix(o, ID_Q, head, a, 0) for o in offs]
        allow_at = [mates if np.linalg.norm(o) < L + S.FASTENER.mate_margin else set() for o in offs]
        if e and seat:                                                 # hand start: a few turns, a little travel
            ang = tr["sgn"] * 2 * math.pi * hand_turns
            self._key(name, t1 + dur * S.FASTENER.hand_share, side * e * S.FASTENER.hand_travel, ang=ang, ease=0)
            tr["handAngle"] = ang
            tr["engaged"] = list(side * e * S.FASTENER.hand_travel)
        self._check(f"{kind} {name}", mesh, mats, allow=allow, allow_at=allow_at)
        self.t = t1 + (dur * S.FASTENER.hand_share if e and seat else 0)
        self._install([name])
        return self

    def drive_with_hand(self, name, turns=3, dur=1.2):
        """Finish a fastener without a tool model (only where none is required)."""
        tr = self.parts[name]; last = tr["keys"][-1]
        self._key(name, self.t + dur, (0, 0, 0), ang=last[8] + tr.get("sgn", -1.0) * 2 * math.pi * turns, ease=0)
        self.t += dur

    # ---------------------------------------------------------------- tools
    def _drill_mesh(self, af, ext=0.0):
        """Drill collision mesh with the socket (tool y 0..50.5 mm) scaled radially as on screen.
        v2.2: ext = socket extension bar (mm): the drill body sits ext further back, a Ø12 mm bar between."""
        key = ("drill", round(af, 2)) if not ext else ("drill", round(af, 2), round(ext, 1))
        if key not in self.u.tmesh:
            m = self.u.tmesh["drill"].copy(); v = m.vertices.copy()
            sel = v[:, 1] < 50.6; k = af / SOCKET_SUPPLIED_AF
            v[sel, 0] *= k; v[sel, 2] *= k
            if ext: v[~sel, 1] += ext
            m.vertices = v
            if ext:
                bar = trimesh.creation.cylinder(radius=S.DRILL.ext_r, height=ext + 6, sections=12)
                bar.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, (1, 0, 0)))
                bar.apply_translation((0, 50.5 + (ext + 6) / 2 - 3, 0))
                m = trimesh.util.concatenate([m, bar])
            self.u.tmesh[key] = m
        return self.u.tmesh[key]

    SWEEP = S.TOOL.retract_sweep

    def _tool_pose_free(self, tool, origin, y_axis, allow, hints, extra=None, mesh=None, sweep=SWEEP):
        """Roll about the working axis so the tool clears the installed parts at the working point AND
        along the straight retract/approach along the working axis (v2.1: `sweep` heights, mm).
        Returns the first clear roll; else the least colliding one with its collisions at the working point."""
        mesh = mesh if mesh is not None else self.u.tmesh[tool]
        y_axis = unit(y_axis)
        tried = []
        for h in hints:
            for k in range(S.TOOL.roll_steps):
                rot = quat_axis_angle(y_axis, k * math.pi / (S.TOOL.roll_steps / 2))
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

    def drill(self, names, af=None, hints=((0, -1, 0), (1, 0, 0), (0, 0, 1)), turns=S.DRILL.turns, label=None, depth=None, fallback=True,
              extension=0.0):
        """Drill + socket sized to the measured hex: align, engage, turn the fastener home, retract.
        Fasteners the drill body cannot reach (no collision-free roll) are tightened with the
        supplied adjustable wrench instead (hex heads / nuts only) — recorded in the step flags."""
        if fallback and not extension:
            ok, blocked = [], []
            for name in names:
                self._carried(name)
                p = self.u.A[name]; a = unit(p["axis"])
                haf = af or (p["across_flats"][0] if p.get("across_flats") else SOCKET_SUPPLIED_AF)
                kind_nut = "Nut" in name
                hh = head_height(p) if not kind_nut else p["length"]
                k = self._last(name)
                side = unit(k[1:4]) if np.linalg.norm(k[1:4]) > 0.05 else a
                outer = np.asarray(p["head"]) if not kind_nut else (np.asarray(p["tip"]) if np.dot(unit(np.asarray(p["tip"]) - np.asarray(p["head"])), side) > 0 else np.asarray(p["head"]))
                dep = depth if depth is not None else max(S.DRILL.depth_min, hh * S.DRILL.depth_share)
                q, hit = self._tool_pose_free("drill", outer - side * dep, side, {name} | set(p.get("contacts", [])), hints, mesh=self._drill_mesh(haf))
                (blocked if hit and p.get("across_flats") and af is None else ok).append(name)
            if ok: self.drill(ok, af=af, hints=hints, turns=turns, label=label, depth=depth, fallback=False)
            for name in blocked:
                k = self._last(name); side = unit(k[1:4]) if np.linalg.norm(k[1:4]) > 0.05 else unit(self.u.A[name]["axis"])
                self.wrench(name, side=side, strokes=2, bolt="Nut" not in name)
            if blocked:
                self.flag(f"Drill body cannot reach {', '.join(blocked)} (wall clearance in the CAD): tightened with the adjustable wrench (supplied) instead")
            return self
        tool = "drill"; info = self.u.tools[tool]
        tr = dict(tool=tool, keys=[], label=label)
        if extension: tr["extension"] = float(extension)
        for name in names:
            self._carried(name)
        poses = []                                      # (name, side, engaged point, quaternion, offset, angle0)
        for name in names:
            p = self.u.A[name]; a = unit(p["axis"]); head = np.asarray(p["head"])
            kind_nut = "Nut" in name
            last = self._last(name)
            side = unit(last[1:4]) if np.linalg.norm(last[1:4]) > 0.05 else a
            haf = af or (p["across_flats"][0] if p.get("across_flats") else SOCKET_SUPPLIED_AF)
            tr["socketAF"] = haf
            hh = head_height(p) if not kind_nut else p["length"]
            dep = depth if depth is not None else max(S.DRILL.depth_min, hh * S.DRILL.depth_share)
            # socket opening sits `dep` below the outer end of the head (bolts) / of the nut (far end)
            outer = head
            if kind_nut:
                outer = np.asarray(p["tip"]) if np.dot(unit(np.asarray(p["tip"]) - head), side) > 0 else head
            eng = outer - side * dep
            allow = {name} | set(p.get("contacts", []))
            q, hit = self._tool_pose_free(tool, eng, side, allow, hints, mesh=self._drill_mesh(haf, extension))
            self.checks.append(dict(what=f"drill on {name}", samples=1, clear=not hit, collisions={k: round(v, 2) for k, v in hit.items()}))
            sgn = -1.0 if float(unit(self.parts[name]["axis"]) @ side) > 0 else 1.0
            poses.append((name, side, eng, q, np.array(last[1:4]), last[8], outer, sgn, allow))
        mesh = self._drill_mesh(tr["socketAF"], extension)
        allow_all = set().union(*[x[8] for x in poses])
        first = True; prev = None
        for name, side, eng, q, off, ang0, outer, sgn, allow in poses:
            t0 = self.t
            if first:
                H = self._clear_height(tool, mesh, eng + off, q, side, allow_all, start=S.DRILL.first_clear)
                self._tool_key(tr, t0, eng + off + side * H, q)
                t0 += S.DRILL.first_lead
            else:
                # hop: back out to a clearance height, move across at that height, then go in
                pn, ps, pe, pq, poff = prev
                H = max(self._clear_height(tool, mesh, pe, pq, ps, allow_all, start=S.DRILL.hop_clear),
                        self._clear_height(tool, mesh, eng + off, q, side, allow_all, start=S.DRILL.hop_clear))
                Hh = self._hop_height(tool, mesh, pe, pq, ps, eng + off, q, side, allow_all, H)
                if Hh is not None:
                    self._tool_key(tr, t0, pe + ps * Hh, pq)
                    self._tool_key(tr, t0 + S.DRILL.hop_dur, eng + off + side * Hh, q)
                    t0 += S.DRILL.hop_dur
                else:
                    self._tool_key(tr, t0, pe + ps * H, pq)
                    t0 += self._hop(tr, mesh, t0, S.DRILL.hop_dur, pe + ps * H, pq, eng + off + side * H, q, allow_all)
            self._tool_key(tr, t0 + S.DRILL.near_at, eng + off + side * S.DRILL.near_gap, q)
            self._tool_key(tr, t0 + S.DRILL.engage_at, eng + off, q)                   # socket over the head
            spin_t0, spin_t1 = t0 + S.DRILL.spin_at, t0 + S.DRILL.spin_at + S.DRILL.s_per_turn * turns
            self._tool_key(tr, spin_t0, eng + off, q)
            self._tool_key(tr, spin_t1, eng, q)                                        # follows the fastener home, body fixed
            self._key(name, spin_t0, off, ang=ang0, ease=0)
            self._key(name, spin_t1, (0, 0, 0), ang=ang0 + sgn * 2 * math.pi * turns, ease=0)
            r_sock = S.DRILL.socket_r_supplied * (tr["socketAF"] / SOCKET_SUPPLIED_AF) + S.SPIN_ARROW.margin
            self.fx.append(dict(type="spinArrow", centre=list(map(float, outer + side * S.SPIN_ARROW.axial_offset)), axis=list(map(float, side)),
                                sense=S.SPIN_ARROW.sense, radius=float(r_sock), t=[round(spin_t0, 3), round(spin_t1, 3)], turns=turns))
            self._shot(spin_t0 - S.DRILL.shot_lead, outer, radius=S.DRILL.shot_radius, axis=side, kind="tool", tool=(mesh, eng, q))
            self.t = spin_t1 + S.DRILL.after
            prev = (name, side, eng, q, np.zeros(3))
            first = False
        pn, ps, pe, pq, _ = prev
        H = self._clear_height(tool, mesh, pe, pq, ps, allow_all, start=S.DRILL.final_clear)
        self._tool_key(tr, self.t + S.DRILL.retract_dur, pe + ps * H, pq)
        self.t += S.DRILL.retract_dur
        self._check_tool_path(tr, mesh, allow_all)
        tr["socketScale"] = round(tr.get("socketAF", SOCKET_SUPPLIED_AF) / SOCKET_SUPPLIED_AF, 4)
        self.toolTracks.append(tr)
        self._use_tool("drill", f"Cordless drill + {socket_label(tr['socketAF'])} socket" + ("" if abs(tr["socketScale"] - 1) < 0.02 else " (socket resized from the supplied 9/16 in model)")
                       + (f" + {fmt(extension / 25.4, 1)} in extension (not supplied: generic bar)" if extension else ""))
        if getattr(self, "_held_wrench", None):               # v2.2: drill turns the fastener while a wrench holds its mate
            self._held_wrench["end"] = self.t
        return self

    # ---------------------------------------------------------------- tool path helpers
    def _pose_hits(self, mesh, pos, q, allow):
        Mx = np.eye(4); Mx[:3, :3] = quat_to_mat(q); Mx[:3, 3] = pos
        return self.u.world.hits(mesh, Mx, allow=allow, tol=S.COLLISION.tool_tol)

    def _clear_height(self, tool, mesh, eng, q, side, allow, start=70, heights=S.TOOL.clear_height_steps):
        """Smallest retract height along the working axis at which the tool is clear (min `start`)."""
        for extra in heights:
            H = start + extra
            if not self._pose_hits(mesh, eng + side * H, q, allow): return H
        return start + heights[-1]

    def _hop_height(self, tool, mesh, p0, q0, s0, p1, q1, s1, allow, H, n=S.TOOL.hop_samples):
        """Raise the clearance height until the straight hop between two fasteners is collision-free."""
        for extra in S.TOOL.hop_raise:
            h = H + extra; ok = True
            for u in np.linspace(0, 1, n):
                pos = (p0 + s0 * h) * (1 - u) + (p1 + s1 * h) * u
                if self._pose_hits(mesh, pos, slerp(q0, q1, u), allow): ok = False; break
            if ok: return h
        return None

    def _seg_clear(self, mesh, pa, qa, pb, qb, allow, step=S.TOOL.route_seg_step):
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
        for m in S.TOOL.route_margins:
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
        total = dur * (1.0 + S.TOOL.route_slowdown * len(wps))
        for P, Q, l in zip(pts, qs_, Ls):
            self._tool_key(tr, t0 + total * (l / Ls[-1] if Ls[-1] > 0 else 1), P, Q)
        return total

    def _check_tool_path(self, tr, mesh, allow, n=S.COLLISION.tool_path_samples):
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
    def _view_dir(self, target, radius, preferred, axis=None, occlude=True, axis_deg=S.CAMERA.axis_deg, ignore=frozenset()):
        """Camera direction for a shot: close to the step's preferred view, showing the insertion axis
        from the side (~50°), with a clear line of sight and the camera outside the geometry."""
        pref = unit(preferred)
        cands = [pref]
        for el in S.CAMERA.elevations:
            for az in range(0, 360, S.CAMERA.azimuth_step):
                e, z = math.radians(el), math.radians(az)
                cands.append(np.array([math.cos(e) * math.cos(z), math.sin(e), math.cos(e) * math.sin(z)]))
        dist = radius * S.CAMERA.dist_per_radius + S.CAMERA.dist_offset   # ~ viewer.fitDistance(radius, 1.1) at FOV 35
        xray = bool(self.camera.get("xray"))
        best = None
        for d in cands:
            score = math.degrees(math.acos(max(-1, min(1, float(d @ pref))))) / S.CAMERA.pref_scale_deg
            if axis is not None:
                ang = math.degrees(math.acos(min(1, abs(float(d @ unit(axis))))))
                score += abs(ang - axis_deg) / S.CAMERA.axis_scale_deg
            hits = {n: v for n, v in self._sight_hits(target, d, dist).items() if n not in ignore} if occlude else {}
            if getattr(self, "_tool_occluder", None) is not None and self._tool_sight(target, d, dist):
                hits = dict(hits, **{"(tool body)": 1.0})
            if xray:                              # the rest of the unit is ghosted: only this step's parts occlude
                hits = {n: v for n, v in hits.items() if n in self.parts}
            inside = self._inside(np.asarray(target) + d * dist)
            score += S.CAMERA.occluder_penalty * len(hits) + (S.CAMERA.inside_penalty if inside else 0.0)
            if best is None or score < best[0]: best = (score, d, hits, inside)
        if best[3]: best[2]["(camera inside geometry)"] = 1.0
        return best[1], best[2]

    def _tool_sight(self, target, d, dist, r=S.CAMERA.sight_radius):
        mesh, pos, q = self._tool_occluder
        cache = self.u.__dict__.setdefault("_toolcm", {})
        cm = cache.get(id(mesh))
        if cm is None or cm[0] is not mesh:
            c = trimesh.collision.CollisionManager(); c.add_object("tool", mesh); cm = (mesh, c); cache[id(mesh)] = cm
        Mt = np.eye(4); Mt[:3, :3] = quat_to_mat(q); Mt[:3, 3] = pos
        cm[1].set_transform("tool", Mt)
        start = max(S.CAMERA.sight_start_min, min(S.CAMERA.sight_start_max, dist * S.CAMERA.sight_start_share)); L = dist - start
        Lq = float(max(10, round(L / 10) * 10))
        cyl = self.u.__dict__.setdefault("_cyl", {}).get((Lq, r))
        if cyl is None:
            cyl = trimesh.creation.cylinder(radius=r, height=Lq, sections=8); self.u._cyl[(Lq, r)] = cyl
        z = np.array([0, 0, 1.0]); v = unit(d)
        ax = np.cross(z, v); s_ = np.linalg.norm(ax); c_ = float(z @ v)
        R = np.eye(3) if s_ < 1e-8 else quat_to_mat(quat_axis_angle(ax / s_, math.atan2(s_, c_)))
        Mx = np.eye(4); Mx[:3, :3] = R; Mx[:3, 3] = np.asarray(target) + v * (start + Lq / 2)
        return cm[1].in_collision_single(cyl, transform=Mx)

    def _inside(self, pos, r=S.CAMERA.inside_radius):
        """Camera position inside / touching solid geometry (small sphere test)."""
        sph = self.u.__dict__.get("_sph")
        if sph is None: sph = self.u._sph = trimesh.creation.icosphere(subdivisions=1, radius=r)
        Mx = np.eye(4); Mx[:3, 3] = pos
        if self.u.world.hits(sph, Mx, tol=0.0): return True
        # fully enclosed (sphere inside a closed box without touching): ray parity along +X
        return False

    def _sight_hits(self, target, d, dist, r=S.CAMERA.sight_radius):
        """Parts crossing the line of sight (thin cylinder from near the target to the camera)."""
        start = max(S.CAMERA.sight_start_min, min(S.CAMERA.sight_start_max, dist * S.CAMERA.sight_start_share))
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
    MIN_R = S.CAMERA.min_radius

    def _shot(self, t, target, radius, axis=None, kind="detail", preferred=None, tool=None, ignore=()):
        """tool = (mesh, position, quaternion) of the tool at work: its body must not hide the working point."""
        radius = max(float(radius), self.MIN_R.get(kind, S.CAMERA.min_radius_other))
        self._tool_occluder = tool
        pref = preferred if preferred is not None else self.camera.get("dir", [1, 0.5, 0.8])
        # overview / result frame the whole step from outside: the target is inside the framed parts
        # tool shots: from further to the side of the working axis, so the tool and the joint are both seen
        d, hits = self._view_dir(np.asarray(target, float), radius, pref, axis, occlude=kind not in ("overview", "result"),
                                 axis_deg=S.CAMERA.tool_axis_deg if kind == "tool" else S.CAMERA.axis_deg, ignore=set(ignore))
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
            pace = S.RIVET.pace_first if k < 2 else S.RIVET.pace_rest
            t_shot = self.t - S.RIVET.shot_lead
            self.fastener(name, "rivet", gap=S.RIVET.insert_gap, dur=S.RIVET.insert_dur * pace + S.RIVET.insert_extra)
            allow = {name} | set(p.get("contacts", []))
            q, hit = self._tool_pose_free(tool, head, a, allow, hints)
            self._shot(t_shot, head, radius=S.RIVET.shot_radius_first if k < 2 else S.RIVET.shot_radius_rest, axis=a, kind="tool", tool=(mesh, head, q))
            self.checks.append(dict(what=f"rivet gun on {name}", samples=1, clear=not hit, collisions={k2: round(v, 2) for k2, v in hit.items()}))
            t0 = self.t
            if first:
                H = self._clear_height(tool, mesh, head, q, a, allow_all, start=S.RIVET.first_clear)
                self._tool_key(tr, t0 - S.RIVET.hop_lead, head + a * H, q)
            else:
                ph, pa_, pq = prev
                H = max(self._clear_height(tool, mesh, ph, pq, pa_, allow_all, start=S.RIVET.hop_clear), self._clear_height(tool, mesh, head, q, a, allow_all, start=S.RIVET.hop_clear))
                Hh = self._hop_height(tool, mesh, ph, pq, pa_, head, q, a, allow_all, H)
                if Hh is not None:
                    self._tool_key(tr, t0 - S.RIVET.hop_lead, ph + pa_ * Hh, pq)
                    self._tool_key(tr, t0 + S.RIVET.approach_at * pace, head + a * Hh, q)
                else:                                                     # around the unit (other face)
                    self._tool_key(tr, t0 - S.RIVET.hop_lead, ph + pa_ * H, pq)
                    extra = self._hop(tr, mesh, t0 - S.RIVET.hop_lead, S.RIVET.hop_window * pace + S.RIVET.hop_dur_extra, ph + pa_ * H, pq, head + a * H, q, allow_all)
                    shift = extra - (S.RIVET.hop_window * pace)
                    t0 += shift; self.t += shift
            self._tool_key(tr, t0 + S.RIVET.near_at * pace, head + a * S.RIVET.near_gap, q)
            self._tool_key(tr, t0 + S.RIVET.nose_at * pace, head, q)                  # nose on the flange
            pull0, pull1 = t0 + S.RIVET.pull_at * pace, t0 + S.RIVET.pull_at * pace + S.RIVET.pull_dur
            self._sub(tr, "trigger", pull0, 0); self._sub(tr, "trigger", pull1, 1); self._sub(tr, "trigger", pull1 + S.RIVET.release, 0)
            self._sub(tr, "nose", pull0, 0); self._sub(tr, "nose", pull1, 1); self._sub(tr, "nose", pull1 + S.RIVET.release, 0)
            self._tool_key(tr, pull1 + S.RIVET.settle, head, q)
            mand["items"].append(dict(head=list(head), axis=list(a), show=round(self.t - (S.RIVET.insert_dur * pace + S.RIVET.insert_extra), 3),
                                      pull=[round(pull0, 3), round(pull1, 3)]))
            self.t = pull1 + S.RIVET.settle
            prev = (head, a, q)
            first = False
        ph, pa_, pq = prev
        H = self._clear_height(tool, mesh, ph, pq, pa_, allow_all, start=S.RIVET.final_clear)
        self._tool_key(tr, self.t + S.RIVET.retract_dur, ph + pa_ * H, pq)
        self.t += S.RIVET.retract_dur
        self._check_tool_path(tr, mesh, allow_all)
        self.toolTracks.append(tr); self.fx.append(mand)
        self._use_tool("rivetgun", "Cordless blind-rivet gun")
        return self

    def wrench(self, name, side, hints=((0, -1, 0), (0, 0, 1), (0, 1, 0)), strokes=2, swing_deg=S.WRENCH.swing, label=None, bolt=False,
               total_deg=None, approach="axis", hold=False, centre=None):
        """Adjustable wrench: open the jaw to the measured hex width, engage, turn in strokes.
        v2.2: total_deg = exact total turn (strokes of ≤ swing_deg that add up to it);
        approach = "axis" (along the fastener axis, v2.1) or "handle" (slid on sideways onto the flats, along
        the handle — where there is no room along the axis); hold = engage and hold the part still (no strokes)
        until release_wrench() — e.g. holding a bolt head while the drill turns its nut."""
        self._carried(name)
        p = self.u.A[name]; side = unit(side)
        if centre is not None:
            C = np.asarray(centre, float); thick = p["length"]
        elif bolt:                                                     # hex head: centre of the head
            hh = head_height(p); C = np.asarray(p["head"]) - unit(p["axis"]) * hh / 2; thick = hh
        else:
            C = (np.asarray(p["head"]) + np.asarray(p["tip"])) / 2; thick = p["length"]
        w = p["across_flats"][0]
        C = C + side * max(0.0, (S.WRENCH.thickness - thick) / 2 + S.WRENCH.back_clear)   # keep its back face off the panel
        tool = "wrench"; tr = dict(tool=tool, keys=[], jawMm=round(w + S.WRENCH.jaw_play, 2))
        allow = {name} | set(p.get("contacts", []))
        hits = None; best = None
        wm = self.u.tmesh[tool]

        def app_vec(q):
            return side * S.WRENCH.approach if approach == "axis" else quat_to_mat(q) @ np.array([1.0, 0, 0]) * S.WRENCH.approach_side

        # v2.1: the roll must keep the wrench clear over the whole stroke (engaged, swung, lifted off,
        # approach along the axis); a shorter swing (more strokes) is used where the full one does not fit
        total_deg_ = total_deg if total_deg is not None else swing_deg * strokes
        req = swing_deg
        swings = (0,) if hold else (swing_deg, *S.WRENCH.fallback_swings)
        for sw in swings:
            for h in hints:
                for k in range(S.WRENCH.roll_steps):
                    xh = quat_to_mat(quat_axis_angle(side, k * math.pi / (S.WRENCH.roll_steps / 2))) @ unit(h)
                    if np.linalg.norm(xh - side * (xh @ side)) < 1e-3: continue
                    q = frame_quat(side, xh)
                    qs_ = quat_mul(quat_axis_angle(side, -math.radians(sw)), q)
                    o0 = C + quat_to_mat(q) @ np.array([0, 0, w / 2]); o1 = C + quat_to_mat(qs_) @ np.array([0, 0, w / 2])
                    hit = self._pose_hits(wm, o0, q, allow)
                    worst = sum(hit.values())
                    if not hit:
                        if hold or approach != "axis":
                            av = app_vec(q)
                            poses = [(o0 + av * f, q) for f in (0.15, 0.35, 0.6, 1.0)]
                            if not hold:
                                poses += [(o1, qs_), (o1 + side * S.WRENCH.lift, qs_), (o0 + side * S.WRENCH.lift, q),
                                          (C + quat_to_mat(slerp(q, qs_, 0.5)) @ np.array([0, 0, w / 2]), slerp(q, qs_, 0.5)),
                                          (o0 + side * S.WRENCH.lift + av * 0.5, q), (o0 + side * S.WRENCH.lift + av, q)]
                        else:
                            poses = [(o1, qs_), (o1 + side * S.WRENCH.lift, qs_), (o0 + side * S.WRENCH.lift, q), (o0 + side * S.WRENCH.approach_check, q), (o0 + side * S.WRENCH.approach, q),
                                     (C + quat_to_mat(slerp(q, qs_, 0.5)) @ np.array([0, 0, w / 2]), slerp(q, qs_, 0.5))]
                        for pos, qq in poses:
                            hh = self._pose_hits(wm, pos, qq, allow)
                            if hh: worst = 0.01 + sum(hh.values()) * 0.1; break
                    if best is None or worst < best[0]: best = (worst, q, hit, sw)
                    if worst == 0: break
                if best and best[0] == 0: break
            if best and best[0] == 0: break
        q = best[1]; hits = best[2] or ({"(stroke)": round(best[0], 2)} if best[0] else {})
        swing_deg = best[3]
        if not hold:
            strokes = int(math.ceil(total_deg_ / swing_deg - 1e-6))
            if total_deg is not None: swing_deg = total_deg / strokes
            if best[3] < req and not hits:
                self.flag(f"{name}: only a short collision-free wrench arc exists here ({best[3]}° strokes instead of {req}°) — "
                          "a ratcheting or offset box wrench is recommended (not supplied); confirm")
        self.checks.append(dict(what=f"wrench {'holding' if hold else 'on'} {name}", samples=1, clear=not hits, collisions={k: round(v, 2) for k, v in hits.items()}))

        def org(qq): return C + quat_to_mat(qq) @ np.array([0, 0, w / 2])
        t0 = self.t
        self._shot(t0, C, radius=S.WRENCH.shot_radius, axis=side, kind="tool", tool=(self.u.tmesh[tool], org(q), q))
        sgn = -1.0 if float(unit(self.parts[name]["axis"]) @ side) > 0 else 1.0
        self._sub(tr, "jaw", t0, 0, 0); self._sub(tr, "jaw", t0 + S.WRENCH.jaw_open_at, w + S.WRENCH.jaw_play, 0)   # opened before it appears
        self._tool_key(tr, t0, org(q) + app_vec(q), q)
        self._tool_key(tr, t0 + S.WRENCH.engage_dur, org(q), q)
        if hold:
            self._held_wrench = dict(tr=tr, pos=org(q), q=q, av=app_vec(q), allow=allow, end=None)
            self.t = t0 + S.WRENCH.engage_dur + 0.15
            self._use_tool("wrench", "Adjustable wrench (jaw set to the measured hex)")
            return self
        last = self._last(name); off = np.array(last[1:4]); ang = last[8]
        t = t0 + S.WRENCH.first_stroke_at
        for s in range(strokes):
            qs = quat_mul(quat_axis_angle(side, -math.radians(swing_deg)), q)      # clockwise seen from outside
            frac0, frac1 = s / strokes, (s + 1) / strokes
            self._tool_key(tr, t, org(q) + off * (1 - frac0), q)
            self._key(name, t, off * (1 - frac0), ang=ang, ease=0)
            ang += sgn * math.radians(swing_deg)
            self._tool_key(tr, t + S.WRENCH.stroke_dur, org(qs) + off * (1 - frac1), qs)
            self._key(name, t + S.WRENCH.stroke_dur, off * (1 - frac1), ang=ang, ease=1)
            if s < strokes - 1:                                                      # lift off, swing back, re-engage
                self._tool_key(tr, t + S.WRENCH.lift_at, org(qs) + side * S.WRENCH.lift, qs)
                self._tool_key(tr, t + S.WRENCH.back_at, org(q) + side * S.WRENCH.lift, q)
                t += S.WRENCH.stroke_cycle
            else:
                t += S.WRENCH.last_stroke
        if approach == "axis":
            self._tool_key(tr, t + S.WRENCH.retract_dur, org(qs) + app_vec(qs), qs)
        else:                                # v2.2: lift off the flats, swing back, slide out the way it came in
            self._tool_key(tr, t + 0.25, org(qs) + side * S.WRENCH.lift, qs)
            self._tool_key(tr, t + 0.65, org(q) + side * S.WRENCH.lift, q)
            t += 0.65
            self._tool_key(tr, t + S.WRENCH.retract_dur, org(q) + side * S.WRENCH.lift + app_vec(q), q)
        self.t = t + S.WRENCH.retract_dur
        self._check_tool_path(tr, self.u.tmesh[tool], allow)
        self.toolTracks.append(tr)
        self._use_tool("wrench", "Adjustable wrench (jaw set to the measured hex)")
        return self

    def release_wrench(self):
        """v2.2: end of a wrench hold (see wrench(hold=True)): stays engaged until now, then slides off."""
        h = self._held_wrench; tr = h["tr"]
        self._tool_key(tr, self.t, h["pos"], h["q"])
        self._tool_key(tr, self.t + S.WRENCH.retract_dur, h["pos"] + h["av"], h["q"])
        self.t += S.WRENCH.retract_dur
        self._check_tool_path(tr, self.u.tmesh["wrench"], h["allow"])
        self.toolTracks.append(tr); self._held_wrench = None
        return self

    def bead(self, centre, normal, radius, start_deg=90, sweep=360, dur=3.2, bead_d=4.0, label="silicone bead",
             colour=None, product="Caulking dispenser, WEICON HT300 silicone (red, as supplied)", sealant=None):
        """Caulking dispenser: nozzle follows the joint, the knob drives the plunger, the bead grows.
        v2.2: colour / product / sealant (cartridge contents colour) per operation."""
        n = unit(normal); u, v = perp_basis(n); C = np.asarray(centre, float)
        k = S.CAULKING.segments
        angs = [math.radians(start_deg + sweep * i / k) for i in range(k + 1)]
        pts = [C + radius * (math.cos(t) * u + math.sin(t) * v) for t in angs]
        tangs = [unit(-math.sin(t) * u + math.cos(t) * v) for t in angs]
        return self._bead_run(pts, [n] * (k + 1), tangs, dur, bead_d, label, colour, product, sealant,
                              shot=(C, radius + S.CAULKING.shot_margin, n))

    def bead_path(self, points, normal, dur, bead_d, label, colour, product, sealant=None, attach=None, xform=None, closed=True,
                  corner=6.0, shot=None):
        """v2.2: bead along a polyline on a face (rounded corners). points / normal in the CAD frame of `attach`
        (the bead fx moves with that part); xform = (T, q) = the part's current delta (staged pose) for the tool path."""
        sm = rounded_polyline(points, corner, closed)
        Ls = np.cumsum([0] + [np.linalg.norm(sm[i + 1] - sm[i]) for i in range(len(sm) - 1)])
        k = max(S.CAULKING.segments, int(Ls[-1] / 12))
        res = [np.array([np.interp(l, Ls, [p[j] for p in sm]) for j in range(3)]) for l in np.linspace(0, Ls[-1], k + 1)]
        tangs = [unit(res[min(i + 1, k)] - res[max(i - 1, 0)]) for i in range(k + 1)]
        n = unit(normal)
        return self._bead_run(res, [n] * (k + 1), tangs, dur, bead_d, label, colour, product, sealant, attach=attach, xform=xform,
                              shot=shot)

    def _bead_run(self, surf, normals, tangs, dur, bead_d, label, colour, product, sealant, attach=None, xform=None, shot=None):
        k = len(surf) - 1
        R = quat_to_mat(xform[1]) if xform else np.eye(3); T = np.asarray(xform[0], float) if xform else np.zeros(3)
        W = lambda p: R @ np.asarray(p, float) + T                     # CAD frame of the part -> world (tool path)
        pts = [p + n * (bead_d * 0.35) for p, n in zip(surf, normals)]  # fx (part frame)
        tr = dict(tool="caulking", keys=[])
        if sealant: tr["sealant"] = sealant
        t0 = self.t
        nw = [R @ n for n in normals]; tw = [R @ tg for tg in tangs]; pw = [W(p) for p in pts]
        ax0 = unit(nw[0] * 1.0 - tw[0] * S.CAULKING.nozzle_tilt)
        q0 = frame_quat(ax0, nw[0])
        if shot is not None:
            C, rad, sax = shot
            self._shot(t0, W(C) if xform else C, radius=rad, axis=R @ np.asarray(sax, float), kind="tool", tool=(self.u.tmesh["caulking"], pw[0] + nw[0] * 1.0, q0))
        self._tool_key(tr, t0, pw[0] + ax0 * S.CAULKING.approach, q0)
        self._tool_key(tr, t0 + S.CAULKING.approach_dur, pw[0] + nw[0] * 1.0, q0)
        worst = {}
        ax = ax0; q = q0
        for i in range(k + 1):
            ax = unit(nw[i] * 1.0 - tw[i] * S.CAULKING.nozzle_tilt)
            q = frame_quat(ax, nw[i])
            ti = t0 + S.CAULKING.start_at + dur * i / k
            self._tool_key(tr, ti, pw[i] + nw[i] * 1.0, q)
            if i % S.CAULKING.check_every == 0:
                Mx = np.eye(4); Mx[:3, :3] = quat_to_mat(q); Mx[:3, 3] = pw[i] + nw[i] * 1.0
                for nn, d in self.u.world.hits(self.u.tmesh["caulking"], Mx, tol=S.COLLISION.caulking_tol).items(): worst[nn] = max(worst.get(nn, 0), d)
        self.checks.append(dict(what=f"caulking dispenser path ({label})", samples=k // S.CAULKING.check_every + 1, clear=not worst, collisions={a: round(b, 2) for a, b in worst.items()}))
        self._sub(tr, "knob", t0 + S.CAULKING.approach_dur, 0, 0); self._sub(tr, "knob", t0 + S.CAULKING.start_at + dur, 2 * math.pi * S.CAULKING.knob_turns, 0)
        self._sub(tr, "plate", t0 + S.CAULKING.approach_dur, 0, 0); self._sub(tr, "plate", t0 + S.CAULKING.start_at + dur, S.CAULKING.plate_travel, 0)
        self._tool_key(tr, t0 + S.CAULKING.retract_at + dur, pw[-1] + ax * S.CAULKING.approach, q)
        fx = dict(type="bead", points=[list(map(float, p)) for p in pts], diameter=bead_d,
                  colour=colour or self.u.tools["caulking"].get("beadColour", "#c8281e"), grow=[round(t0 + S.CAULKING.start_at, 3), round(t0 + S.CAULKING.start_at + dur, 3)], label=label)
        if attach: fx["attach"] = self.u.ids[attach]
        self.fx.append(fx)
        self.toolTracks.append(tr)
        self.t = t0 + S.CAULKING.retract_at + dur
        self._use_tool("caulking", product)
        return self

    # ---------------------------------------------------------------- v2.2 gasket, decals on parts, dimensions
    def gasket(self, points, normal, attach, xform, label="door gasket", corner=4.0, width=None, thickness=None, closed=True,
               shot=True, dur=None):
        """Square foam strip pressed by hand along a closed path on a face of `attach` (fx 'gasket', moves with the
        part): laid progressively from its start point as the release liner is peeled off. points / normal in
        the CAD frame on the face; xform = the part's current (staged) delta, for the camera."""
        sec = thickness or S.GASKET.section; n = unit(normal)
        path = rounded_polyline(points, corner, True, samples=3) if closed else [np.asarray(p, float) for p in points]
        Ls = np.cumsum([0] + [np.linalg.norm(path[i + 1] - path[i]) for i in range(len(path) - 1)])
        dur = dur or float(Ls[-1] / S.GASKET.lay_mm_per_s)
        R = quat_to_mat(xform[1]); T = np.asarray(xform[0], float)
        c = np.mean(points, axis=0); ext = float(np.max(np.ptp(np.asarray(points), axis=0)))
        if shot: self._shot(self.t, R @ c + T, radius=ext / 2 + 30, kind="wide", axis=R @ n)
        t0 = self.t + 0.3
        f = dict(type="gasket", points=[list(map(float, p + n * sec / 2)) for p in path], normal=list(map(float, n)),
                 section=sec, colour=S.GASKET.colour, liner=S.GASKET.liner, grow=[round(t0, 3), round(t0 + dur, 3)],
                 attach=self.u.ids[attach], label=label)
        if width: f["width"] = width
        if not closed: f["closed"] = False
        self.fx.append(f)
        self.t = t0 + dur + 0.3
        return self

    def sticker(self, sid, file, centre, normal, up, width, height, attach, dur=1.8):
        """Paper sticker pressed onto a part face (fx 'decal' attached to the part: it stays on in every view)."""
        t0 = self.t
        self.fx.append(dict(type="decal", id=sid, file=file, centre=list(map(float, centre)), normal=list(map(float, unit(normal))),
                            up=list(map(float, unit(up))), width=width, height=height, attach=self.u.ids[attach], kit=True,
                            keys=[[0, 120, 0], [round(t0, 3), 120, 0], [round(t0 + dur * 0.6, 3), 3, 0], [round(t0 + dur * 0.8, 3), 0, 0.5], [round(t0 + dur, 3), 0, 1]]))
        self.t = t0 + dur
        return self

    def dims(self, items, t0, t1, attach=None, ref=None):
        """Orange dimension call-outs (inches) shown from t0 to t1 (fx 'dims'). items: dict(a, b, line (point on the
        dimension line), normal, text, up) in mm; extension lines from a and b to the dimension line, arrowheads,
        the label at its middle; ref = reference point (datum) marked with a ring."""
        segs, arrows, labels = [], [], []
        for it in items:
            a, b, L = (np.asarray(it[k], float) for k in ("a", "b", "line"))
            d = unit(b - a); n = unit(it["normal"])
            off = (L - a) - d * float((L - a) @ d)                   # perpendicular offset of the dimension line
            pa, pb = a + off, b + off
            ou = unit(off) if np.linalg.norm(off) > 1e-6 else np.zeros(3)
            for e0, e1 in ((a, pa), (b, pb)):                        # extension lines (gap at the feature, 2 mm overrun)
                if np.linalg.norm(e1 - e0) > S.DIMS.gap + 0.5: segs.append([e0 + ou * S.DIMS.gap, e1 + ou * 2.0])
            segs.append([pa, pb])
            arrows += [[pa, d * -1.0], [pb, d]]
            up = unit(it.get("up", np.cross(n, d)))
            side = -1.0 if it.get("below") else 1.0
            labels.append(dict(pos=list(map(float, (pa + pb) / 2 + up * side * (S.DIMS.text_h * 0.85) + n * 0.4)), text=it["text"],
                               right=list(map(float, unit(np.cross(up, n)))), up=list(map(float, up)), normal=list(map(float, n))))
        f = dict(type="dims", colour=S.DIMS.colour, width=S.DIMS.line_w, arrow=S.DIMS.arrow, textH=S.DIMS.text_h,
                 segments=[[list(map(float, p)) for p in sg] for sg in segs], arrows=[[list(map(float, p)), list(map(float, v))] for p, v in arrows],
                 labels=labels, refs=[list(map(float, ref))] if ref is not None else [], t=[round(t0, 3), round(t1, 3)])
        if attach: f["attach"] = self.u.ids[attach]
        self.fx.append(f)
        return self

    # ---------------------------------------------------------------- v2.2 motor leads (fx 'cable', group "leads")
    def leads_begin(self, leads):
        """Register the routed motor leads (dict id -> dict colour, points (mm, world; motor exit first, last =
        end of the insulation at the final termination / park point), terminal (None = pending)).
        Checks every lead against the installed parts."""
        self.u.leads = {k: dict(v, end=[[0.0, 0.0, 0.0, 0.0]], attach=None, ferrule=None) for k, v in leads.items()}
        return self

    def _lead_samples(self, pts, off=None):
        """Points along a lead (every CABLE.check_step mm), the free end displaced by `off` (follow weight)."""
        P = np.asarray(pts, float); Ls = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
        ss = np.arange(0, Ls[-1], S.CABLE.check_step)
        Q = np.array([[np.interp(x, Ls, P[:, j]) for j in range(3)] for x in ss])
        if off is not None:
            w = np.clip((ss - (Ls[-1] - S.CABLE.follow_len)) / S.CABLE.follow_len, 0, 1); w = w * w * (3 - 2 * w)
            Q = Q + np.outer(w, off)
        return Q, ss, Ls[-1]

    def check_leads(self, label, offsets=None, allow_end=(), allow_zone=None):
        """Collision samples (spheres) along every lead; allow_zone(point) -> extra allowed parts there."""
        sph = self.u.__dict__.get("_lsph")
        if sph is None: sph = self.u._lsph = trimesh.creation.icosphere(subdivisions=1, radius=S.CABLE.check_r)
        worst = {}; n = 0
        for lid, L in self.u.leads.items():
            Q, ss, tot = self._lead_samples(L["points"], None if offsets is None else offsets.get(lid))
            for P, x in zip(Q, ss):
                al = set(allow_zone(P, x, tot) if allow_zone else ())
                if tot - x < 14: al |= set(allow_end)
                Mx = np.eye(4); Mx[:3, 3] = P; n += 1
                for nm, d in self.u.world.hits(sph, Mx, allow=al, tol=0.25).items(): worst[f"{lid}: {nm}"] = max(worst.get(f"{lid}: {nm}", 0), d)
        self.checks.append(dict(what=f"motor leads ({label})", samples=n, clear=not worst,
                                collisions={a: round(b, 2) for a, b in sorted(worst.items(), key=lambda kv: -kv[1])[:4]}))
        return worst

    def leads_fx(self, grow=None):
        """Emit the whole lead group for this step with its current end keys, attachments and ferrules."""
        for lid, L in self.u.leads.items():
            f = dict(type="cable", group="leads", id=lid, colour=L["colour"], diameter=S.CABLE.od, points=[list(map(float, p)) for p in L["points"]],
                     follow=S.CABLE.follow_len, end=[[round(k[0], 3), *map(float, k[1:4])] for k in L["end"]], label=L.get("label", lid))
            if grow is not None: f["grow"] = [round(grow[0] + L.get("stagger", 0.0), 3), round(grow[1] + L.get("stagger", 0.0), 3)]
            if L["attach"]: f["attach"] = dict(node=self.u.ids[L["attach"][0]], t=round(L["attach"][1], 3), base=list(map(float, L["attach"][2])))
            if L["ferrule"]:
                C = S.SPLICE if L["ferrule"].get("kind") == "splice" else S.FERRULE
                f["ferrule"] = dict(L["ferrule"], length=C.length, od=C.od, odCrimped=C.od_crimped, colour=C.colour)
            f.update(L.get("extra", {}))                       # v2.3: show / core / twist / base / follow / rigid
            self.fx.append(f)
        return self

    def _lead_end(self, lid, off):
        """World position and direction of a lead's insulation end with the free end displaced by `off`."""
        Q, ss, tot = self._lead_samples(self.u.leads[lid]["points"], off)
        P = np.asarray(self.u.leads[lid]["points"], float)
        w = 1.0; end = P[-1] + np.asarray(off, float) * w
        d = unit(P[-1] - P[-2])
        return end, d

    def lead_keys(self, lid, keys):
        """Append end-offset keys [[t, (dx, dy, dz)]] (mm, relative to the routed end) for one lead."""
        L = self.u.leads[lid]
        for t, off in keys: L["end"].append([t, *map(float, off)])
        return self

    def leads_reset_time(self):
        """A new step starts: every lead keeps its last end offset from t = 0 (ferrule already on, already shown)."""
        for L in self.u.leads.values():
            last = L["end"][-1]; L["end"] = [[0.0, *last[1:4]]]
            X = L.get("extra", {})
            if "core" in X: X["core"] = dict(X["core"], show=-1.0)
            if "twist" in X: X["twist"] = dict(X["twist"], t=[-1.0, -1.0])
            X.pop("show", None)
            if "base" in X: X["base"] = [[0.0, *X["base"][-1][1:4]]]
            if L["ferrule"]: L["ferrule"] = dict(L["ferrule"], show=-1.0, crimp=-1.0 if L["ferrule"]["crimp"] is not None else None)
            if L["attach"]: L["attach"] = (L["attach"][0], -1.0, L["attach"][2])
        return self

    def crimp(self, lids, work, hints=((-1, 0, 0), (0, 0, 1), (0, 0, -1), (0, -1, 0)), splices=None):
        """Crimper (supplied model) on each lead end at its work position: the ferrule is slid onto the stripped end,
        the open crimper comes in along its handles until the die nest surrounds the ferrule, the handles close
        (crimp), open again and the crimper backs out. work: lid -> end offset (mm) where the end is held.
        splices: lid -> offset (mm) from that lead's end to the centre of its pair — a splice sleeve (SPLICE) holding
        both stripped ends is crimped there instead of a ferrule (carried by this lead's fx)."""
        splices = splices or {}
        tool = "crimper"; mesh = self.u.tmesh[tool]; tr = dict(tool=tool, keys=[])
        jaw_o, hd_o = math.radians(S.CRIMP.open_jaw_deg), -math.radians(S.CRIMP.open_handle_deg)
        prev = None
        for k, lid in enumerate(lids):
            L = self.u.leads[lid]; off = np.asarray(work[lid], float)
            end, d = self._lead_end(lid, off)
            sp = splices.get(lid)
            C = S.SPLICE if sp is not None else S.FERRULE
            side = np.zeros(3) if sp is None else np.asarray(sp, float)
            fc = end + side + d * C.length / 2                        # sleeve centre (die nest)
            t0 = self.t
            L["ferrule"] = dict(show=round(t0, 3), slide=S.CRIMP.slide_on, crimp=None)
            if sp is not None: L["ferrule"] |= dict(kind="splice", offset=[float(v) for v in side])
            # roll: handles (+Y) perpendicular to the lead, the whole tool clear at the nest and along the approach
            best = None
            for h in hints:
                for r in range(12):
                    Y = quat_to_mat(quat_axis_angle(d, r * math.pi / 6)) @ unit(h); Y = Y - d * (Y @ d)
                    if np.linalg.norm(Y) < 1e-3: continue
                    Y = unit(Y); q = frame_quat(Y, np.cross(Y, d))
                    hit = self._pose_hits(mesh, fc, q, set())
                    worst = sum(hit.values())
                    if not hit:
                        for f in (0.3, 0.6, 1.0):
                            hh = self._pose_hits(mesh, fc + Y * S.CRIMP.approach * f, q, set())
                            if hh: worst = 0.01 + sum(hh.values()) * 0.1; break
                    if best is None or worst < best[0]: best = (worst, q, Y, hit)
                    if worst == 0: break
                if best[0] == 0: break
            _, q, Y, hit = best
            self.checks.append(dict(what=f"crimper on {lid}" + (" (splice)" if sp is not None else ""), samples=1, clear=best[0] == 0,
                                    collisions={a: round(b, 2) for a, b in hit.items()}))
            ts = t0 + S.CRIMP.slide_on + 0.1
            if prev is None: self._tool_key(tr, ts, fc + Y * S.CRIMP.approach, q)
            else:
                self._tool_key(tr, ts - 0.05, prev[0] + prev[1] * S.CRIMP.approach, prev[2])
                self._tool_key(tr, ts + 0.3, fc + Y * S.CRIMP.approach, q); ts += 0.3
            for ch, v in (("jaw", jaw_o), ("handle", hd_o)): self._sub(tr, ch, ts, v, 0)
            self._shot(ts - 0.2, fc, radius=S.CRIMP.shot_radius, axis=d, kind="tool", tool=(mesh, fc, q))
            te = ts + S.CRIMP.approach_dur
            self._tool_key(tr, te, fc, q)                                   # nest around the ferrule
            tc0 = te + S.CRIMP.close_at; tc1 = tc0 + S.CRIMP.close_dur
            for ch, v in (("jaw", jaw_o), ("handle", hd_o)):
                self._sub(tr, ch, tc0, v, 1); self._sub(tr, ch, tc1, 0, 1)                    # crimp
                self._sub(tr, ch, tc1 + S.CRIMP.hold, 0, 1); self._sub(tr, ch, tc1 + S.CRIMP.hold + S.CRIMP.open_dur, v, 1)
            L["ferrule"]["crimp"] = round(tc1, 3)
            tr_ = tc1 + S.CRIMP.hold + S.CRIMP.open_dur
            self._tool_key(tr, tr_, fc, q)
            self._tool_key(tr, tr_ + S.CRIMP.retract_dur, fc + Y * S.CRIMP.approach, q)
            self.t = tr_ + S.CRIMP.retract_dur
            prev = (fc, Y, q)
        self._check_tool_path(tr, mesh, set())
        self.toolTracks.append(tr)
        self._use_tool("crimper", "Ratchet crimping pliers (supplied model) — wire-end ferrules" + (" and splices" if splices else ""))
        return self

    # ---------------------------------------------------------------- v2.2 thread tapping
    def tap(self, holes, hints=((0, -1, 0), (1, 0, 0), (0, 1, 0)), diameter=None):
        """Drill with the (resized) supplied tap: align on the hole axis, engage, cut through the sheet (the tap
        turns, orange arrow clockwise from the tool side), reverse out (arrow counter-clockwise), hop, retract.
        holes: list of dict(part=<sheet being tapped>, entry=(mm, where the tap meets the sheet), axis=(into the
        hole), depth=(sheet thickness, mm), through=(parts the tap passes on its way, e.g. a clearance hole))."""
        tool = "tapdrill"; mesh = self.u.tmesh[tool]; tr = dict(tool=tool, keys=[])
        prev = None
        r_arrow = (diameter or 4.0) / 2 + S.SPIN_ARROW.margin
        for k, h in enumerate(holes):
            ax = unit(h["axis"]); side = -ax; E = np.asarray(h["entry"], float)
            allow = {h["part"]} | set(h.get("through", ()))
            q, hit = self._tool_pose_free(tool, E - ax * 0.0, side, allow, hints, mesh=mesh)
            self.checks.append(dict(what=f"tap drill on {h['part']} hole {k + 1}", samples=1, clear=not hit, collisions={a: round(b, 2) for a, b in hit.items()}))
            t0 = self.t
            if prev is None:
                H = self._clear_height(tool, mesh, E, q, side, allow, start=S.TAP.first_clear)
                self._tool_key(tr, t0, E + side * H, q); t0 += S.DRILL.first_lead
            else:
                pE, ps, pq = prev
                H = max(self._clear_height(tool, mesh, pE, pq, ps, allow, start=S.TAP.hop_clear), self._clear_height(tool, mesh, E, q, side, allow, start=S.TAP.hop_clear))
                Hh = self._hop_height(tool, mesh, pE, pq, ps, E, q, side, allow, H)
                if Hh is not None:
                    self._tool_key(tr, t0, pE + ps * Hh, pq); self._tool_key(tr, t0 + S.DRILL.hop_dur, E + side * Hh, q); t0 += S.DRILL.hop_dur
                else:
                    self._tool_key(tr, t0, pE + ps * H, pq)
                    t0 += self._hop(tr, mesh, t0, S.DRILL.hop_dur, pE + ps * H, pq, E + side * H, q, allow)
            self._shot(t0 - 0.4, E, radius=S.TAP.shot_radius, axis=side, kind="tool", tool=(mesh, E, q))
            self._tool_key(tr, t0 + S.DRILL.near_at, E + side * S.TAP.near_gap, q)
            te = t0 + S.DRILL.engage_at; self._tool_key(tr, te, E, q)
            cut = h["depth"] + S.TAP.lead
            tc = te + cut * S.TAP.s_per_mm; self._tool_key(tr, tc, E + ax * cut, q)
            turns = cut / S.TAP.visual_pitch
            self._sub(tr, "tap", te, 0, 0); self._sub(tr, "tap", tc, -2 * math.pi * turns, 0)
            tb0 = tc + S.TAP.dwell; tb1 = tb0 + cut * S.TAP.reverse_s_per_mm
            self._tool_key(tr, tb0, E + ax * cut, q); self._tool_key(tr, tb1, E, q)
            self._sub(tr, "tap", tb0, -2 * math.pi * turns, 0); self._sub(tr, "tap", tb1, 0, 0)
            c_arrow = E + side * S.SPIN_ARROW.axial_offset
            self.fx.append(dict(type="spinArrow", centre=list(map(float, c_arrow)), axis=list(map(float, side)), sense=-1.0, radius=float(r_arrow), t=[round(te, 3), round(tc, 3)], turns=turns))
            self.fx.append(dict(type="spinArrow", centre=list(map(float, c_arrow)), axis=list(map(float, side)), sense=1.0, radius=float(r_arrow), t=[round(tb0, 3), round(tb1, 3)], turns=turns))
            self.t = tb1 + S.DRILL.after
            prev = (E, side, q)
        pE, ps, pq = prev
        H = self._clear_height(tool, mesh, pE, pq, ps, set(), start=S.TAP.final_clear)
        self._tool_key(tr, self.t + S.DRILL.retract_dur, pE + ps * H, pq); self.t += S.DRILL.retract_dur
        self._check_tool_path(tr, mesh, set().union(*[{h["part"]} | set(h.get("through", ())) for h in holes]))
        tr["tapDiameter"] = diameter
        self.toolTracks.append(tr)
        self._use_tool("tapdrill", f"Cordless drill + tap (supplied tap model resized to Ø{fmt(diameter or 0)} mm — thread to confirm)")
        return self

    # ---------------------------------------------------------------- v2.2 ratchet with deep socket
    def ratchet(self, name, side, total_deg=120, hints=((0, -1, 0), (0, 0, 1), (0, 0, -1), (0, 1, 0)), swing=S.RATCHET.swing, af=None,
                tool="ratchet", label=None, depth=None):
        """Socket wrench (supplied 3/8 in ratchet + the supplied deep socket, resized to the nut): slid onto the nut
        along its axis, short strokes (the handle swings back without lifting: ratchet), slid off."""
        self._carried(name)
        p = self.u.A[name]; side = unit(side); a = unit(p["axis"])
        af = af or p["across_flats"][0]
        outer = np.asarray(p["tip"]) if float(unit(np.asarray(p["tip"]) - np.asarray(p["head"])) @ side) > 0 else np.asarray(p["head"])
        eng = outer - side * (depth if depth is not None else max(S.DRILL.depth_min, p["length"] * S.DRILL.depth_share))
        mesh = self._ratchet_mesh(af, tool)
        allow = {name} | set(p.get("contacts", []))
        best = None
        for h in hints:
            for k in range(36):
                xh = quat_to_mat(quat_axis_angle(side, k * math.pi / 18)) @ unit(h)
                if np.linalg.norm(xh - side * (xh @ side)) < 1e-3: continue
                q = frame_quat(side, xh); qs_ = quat_mul(quat_axis_angle(side, -math.radians(swing)), q)
                hit = self._pose_hits(mesh, eng, q, allow); worst = sum(hit.values())
                if not hit:
                    for pos, qq in [(eng, qs_), (eng, slerp(q, qs_, 0.5)), (eng + side * S.RATCHET.approach * 0.5, q), (eng + side * S.RATCHET.approach, q), (eng + side * S.RATCHET.approach, qs_)]:
                        hh = self._pose_hits(mesh, pos, qq, allow)
                        if hh: worst = 0.01 + sum(hh.values()) * 0.1; break
                if best is None or worst < best[0]: best = (worst, q, hit)
                if worst == 0: break
            if best[0] == 0: break
        q = best[1]; hits = best[2] or ({"(stroke)": round(best[0], 2)} if best[0] else {})
        self.checks.append(dict(what=f"{tool} on {name}", samples=1, clear=not hits, collisions={k: round(v, 2) for k, v in hits.items()}))
        tr = dict(tool=tool, keys=[], socketAF=af, socketScale=round(af / SOCKET_SUPPLIED_AF, 4))
        t0 = self.t
        self._shot(t0, outer, radius=S.RATCHET.shot_radius, axis=side, kind="tool", tool=(mesh, eng, q))
        self._tool_key(tr, t0, eng + side * S.RATCHET.approach, q)
        self._tool_key(tr, t0 + S.RATCHET.engage_dur, eng, q)
        strokes = int(math.ceil(total_deg / swing - 1e-6)); sw = total_deg / strokes
        last = self._last(name); off = np.array(last[1:4]); ang = last[8]
        sgn = -1.0 if float(unit(self.parts[name]["axis"]) @ side) > 0 else 1.0
        t = t0 + S.RATCHET.engage_dur + 0.1
        for s_ in range(strokes):
            qs = quat_mul(quat_axis_angle(side, -math.radians(sw)), q)
            f0, f1 = s_ / strokes, (s_ + 1) / strokes
            self._tool_key(tr, t, eng + off * (1 - f0), q); self._key(name, t, off * (1 - f0), ang=ang, ease=0)
            ang += sgn * math.radians(sw)
            self._tool_key(tr, t + S.RATCHET.stroke_dur, eng + off * (1 - f1), qs); self._key(name, t + S.RATCHET.stroke_dur, off * (1 - f1), ang=ang, ease=1)
            t += S.RATCHET.stroke_dur
            if s_ < strokes - 1:                                   # handle swings back, the nut stays (ratchet)
                self._tool_key(tr, t + S.RATCHET.back_dur, eng + off * (1 - f1), q); t += S.RATCHET.back_dur
        self._tool_key(tr, t + S.RATCHET.retract_dur, eng + side * S.RATCHET.approach, qs)
        self.t = t + S.RATCHET.retract_dur
        self._check_tool_path(tr, mesh, allow)
        self.toolTracks.append(tr)
        self._use_tool(tool, label or f"3/8 in ratchet (supplied) + {socket_label(af)} deep socket (resized from the supplied 9/16 in model)")
        return self

    def _ratchet_mesh(self, af, tool="ratchet"):
        key = (tool, round(af, 2))
        if key not in self.u.tmesh:
            m = self.u.tmesh[tool].copy(); v = m.vertices.copy()
            sel = v[:, 1] < 50.6; k = af / SOCKET_SUPPLIED_AF; v[sel, 0] *= k; v[sel, 2] *= k
            m.vertices = v; self.u.tmesh[key] = m
        return self.u.tmesh[key]

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
            self._shot(t0 - S.MARK.shot_lead, H, radius=S.MARK.shot_radius, axis=a, kind="tool", tool=(self.u.tmesh["marker"], pts[0], q))
            if first: self._tool_key(tr, t0, pts[0] + ax * S.MARK.approach, q)
            self._tool_key(tr, t0 + S.MARK.settle, pts[0], q)
            ts = [t0 + S.MARK.settle + S.MARK.seg_dur * i for i in range(len(pts))]
            for P, ti in zip(pts, ts): self._tool_key(tr, ti, P, q)
            self._tool_key(tr, ts[-1] + S.MARK.end, pts[-1] + ax * S.MARK.retract, q)
            fx = dict(type="line", points=[list(map(float, x)) for x in pts], width=S.MARK.width, colour=S.MARK.colour,
                      draw=[round(ts[0], 3), round(ts[-1], 3)], label=f"tightening mark on {name}")
            B = self.u.bench_parts.get(name)
            if B is not None:                         # v2.2: marked on the bench — the mark moves with the bolt
                Rb = quat_to_mat(B[0])
                fx["points"] = [list(map(float, Rb.T @ (np.asarray(x) - B[1]))) for x in pts]; fx["attach"] = self.u.ids[name]
            self.fx.append(fx)
            self.t = ts[-1] + S.MARK.end
            first = False
        self._check_tool_path(tr, self.u.tmesh["marker"], set(names).union(*[set(self.u.A[n].get("contacts", [])) for n in names]))
        self.toolTracks.append(tr)
        self._use_tool("marker", "Marker (Sharpie Fine Point)")
        return self

    def decal(self, did, dur=2.0, frame=None):
        """frame = (target, radius) to frame more than the decal itself (v2.2: its dimension call-outs)."""
        d = self.u.decals[did]
        zc = (d["zLeft"] + d["zRight"]) / 2; yc = (d["yTop"] + d["yBottom"]) / 2
        t0 = self.t
        if frame: self._shot(t0, frame[0], radius=frame[1], kind="detail", preferred=(1, 0.12, 0.0))
        else: self._shot(t0, (0, yc, zc), radius=max(60, d["widthMm"] / 2 + 25), kind="detail", preferred=(1, 0.12, 0.0))
        self.fx.append(dict(type="decal", id=did, file=d["file"], centre=[0.25, yc, zc], normal=[1, 0, 0], up=[0, 1, 0],
                            width=d["widthMm"], height=d["heightMm"],
                            keys=[[0, 150, 0], [round(t0, 3), 150, 0], [round(t0 + dur * 0.6, 3), 4, 0], [round(t0 + dur * 0.8, 3), 0, 0.5], [round(t0 + dur, 3), 0, 1]]))
        self.t = t0 + dur
        return self

    def spin(self, names, pivot, axis, turns, dur, ramp=0.8, arrow=None, airflow=None):
        """v2.2: arrow = dict(centre, radius) — orange rotation arrow about `axis` in the sense of rotation while it
        runs; airflow = dict(paths, allow) — blue arrows travelling along the air paths (polylines, mm, world: in
        through the inlet, out of the wheel, up through the unit; distinct indicator). Each path is checked with a
        small sphere against the installed parts; `allow` = porous parts the air passes through (filter media,
        blade passages)."""
        bb = np.array([self.u.A[n]["bbox"] for n in names]); c = (bb[:, :3].min(0) + bb[:, 3:].max(0)) / 2
        self._shot(self.t, c, radius=float(np.linalg.norm(bb[:, 3:].max(0) - bb[:, :3].min(0)) / 2), kind="wide")
        if arrow:
            self.fx.append(dict(type="spinArrow", centre=list(map(float, arrow["centre"])), axis=list(map(float, unit(axis))),
                                sense=1.0 if turns > 0 else -1.0, radius=float(arrow["radius"]), t=[round(self.t + 0.2, 3), round(self.t + dur, 3)],
                                turns=abs(turns), big=True))
        if airflow:
            sph = trimesh.creation.icosphere(subdivisions=1, radius=S.AIRFLOW.check_r)
            worst = {}; n = 0
            allow = set(airflow.get("allow", ()))
            for P in airflow["paths"]:
                Q, _, _ = self._lead_samples(P)
                for q in Q:
                    Mx = np.eye(4); Mx[:3, 3] = q; n += 1
                    for nm, d in self.u.world.hits(sph, Mx, allow=allow, tol=0.25).items(): worst[nm] = max(worst.get(nm, 0), d)
            self.checks.append(dict(what="airflow paths (inlet, wheel, up through the unit)", samples=n, clear=not worst,
                                    collisions={a: round(b, 2) for a, b in worst.items()}))
            self.fx.append(dict(type="airflow", paths=[[list(map(float, p)) for p in P] for P in airflow["paths"]], colour=S.AIRFLOW.colour,
                                speed=S.AIRFLOW.speed, length=S.AIRFLOW.arrow_len, spacing=S.AIRFLOW.spacing,
                                t=[round(self.t + ramp, 3), round(self.t + dur, 3)]))
        for n in names:
            self._track(n, axis=axis, pivot=pivot)
            self._key(n, 0); self._key(n, self.t)
            self._key(n, self.t + ramp, ang=2 * math.pi * turns * ramp / (dur) * 0.5, ease=0)
            self._key(n, self.t + dur, ang=2 * math.pi * turns, ease=0)
        self.t += dur
        return self

    def wait(self, s): self.t += s; return self

    def flag(self, text): self.flags.append(text); return self

    # ---------------------------------------------------------------- v2.3 presentation props, cable ties, jacket
    def prop(self, boxes, label="worktable"):
        """Presentation element (fx 'prop': boxes, mm in, metres out) shown while this step plays — never part
        of the assembled machine nor of the components view."""
        self.fx.append(dict(_si=True, type="prop", label=label,
                            boxes=[dict(b, min=[round(v * M, 6) for v in b["min"]], max=[round(v * M, 6) for v in b["max"]]) for b in boxes]))
        return self

    def ziptie(self, centres, radii, tangent, up, extra=(), label="cable tie", attach=None, xform=None, head_dir=None,
               wrap=0.7, tight=0.5, cut=0.45, shot=None):
        """Cable tie (fx 'ziptie'): a band wrapped round the cable(s) (circles centres/radii, all crossing the tie
        plane ⟂ tangent) and any support points (`extra`), pulled tight, tail cut. Points in the CAD frame of
        `attach` (xform = its current delta, for the camera); times from self.t."""
        band = S.ZIPTIE.band; d = unit(tangent); e1 = unit(np.asarray(up, float) - d * (np.asarray(up, float) @ d)); e2 = np.cross(d, e1)
        O = np.mean(np.asarray(centres, float), axis=0)
        P2 = []
        for c, r in zip(centres, radii):
            c2 = np.array([(np.asarray(c) - O) @ e1, (np.asarray(c) - O) @ e2]); rr = r + band / 2 + 0.15
            P2 += [c2 + rr * np.array([math.cos(a), math.sin(a)]) for a in np.linspace(0, 2 * math.pi, 24, endpoint=False)]
        for x in extra:
            x2 = np.array([(np.asarray(x) - O) @ e1, (np.asarray(x) - O) @ e2]); P2.append(x2)
        P2 = np.array(P2); hull = P2[ConvexHull2D(P2)]
        # resample the hull evenly (smooth loop)
        cyc = np.vstack([hull, hull[:1]]); L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(cyc, axis=0), axis=1))]
        ss = np.linspace(0, L[-1], 40, endpoint=False)
        tight2 = np.array([[np.interp(x, L, cyc[:, 0]), np.interp(x, L, cyc[:, 1])] for x in ss])
        cen = tight2.mean(0); loose2 = cen + (tight2 - cen) * 1.35
        to3 = lambda q: O + e1 * q[0] + e2 * q[1]
        hd = unit(np.asarray(head_dir if head_dir is not None else e1, float)); hd2 = np.array([hd @ e1, hd @ e2])
        k = int(np.argmax(tight2 @ hd2)); hp = to3(tight2[k]); tan = unit(to3(tight2[(k + 1) % len(tight2)]) - to3(tight2[k - 1]))
        out_n = unit(hp - to3(cen)); hq = mat_to_quat(np.column_stack([tan, out_n, np.cross(tan, out_n)]))
        head = hp + out_n * S.ZIPTIE.head[1] * 0.35
        t0 = self.t
        f = dict(_si=True, type="ziptie", label=label, colour=S.ZIPTIE.colour, band=round(band * M, 6), segs=40,
                 loose=[[round(v * M, 6) for v in to3(q)] for q in loose2], tight=[[round(v * M, 6) for v in to3(q)] for q in tight2],
                 head=[round(v * M, 6) for v in head], headQ=[round(float(v), 6) for v in hq], headSize=[round(v * M, 6) for v in S.ZIPTIE.head],
                 tail=[[round(v * M, 6) for v in head + tan * S.ZIPTIE.head[0] * 0.5], [round(float(v), 6) for v in tan],
                       round(S.ZIPTIE.tail * M, 6), round(S.ZIPTIE.tail_cut * M, 6)],
                 t=[round(t0, 3), round(t0 + wrap, 3), round(t0 + wrap + tight, 3), round(t0 + wrap + tight + cut, 3)])
        if attach: f["attach"] = self.u.ids[attach]
        self.fx.append(f)
        if shot is not None:
            R = quat_to_mat(xform[1]) if xform else np.eye(3); T = np.asarray(xform[0], float) if xform else np.zeros(3)
            self._shot(t0, R @ O + T, radius=shot[0], axis=R @ np.asarray(shot[1], float), kind="detail")
        self.t = t0 + wrap + tight + cut + 0.25
        self._use_tool("cutter", "Small cable ties (natural nylon) + side cutter for the tail — not supplied: generic")
        return self

    def cable(self, cid, points, diameter, colour, group, label, **extra):
        """Generic cable fx (jacket, conductor tails): mm in; keys converted by to_json (cable branch)."""
        f = dict(type="cable", group=group, id=cid, colour=colour, diameter=diameter, points=[list(map(float, p)) for p in points],
                 follow=extra.pop("follow", S.CABLE.follow_len), end=extra.pop("end", [[0.0, 0.0, 0.0, 0.0]]), label=label)
        f.update(extra)
        self.fx.append(f)
        return f

    def bead_helix(self, p0, axis, radius, length, turns, dur, bead_d, label, colour, product, sealant=None, attach=None, xform=None,
                   start=(0, 1, 0), shot=None):
        """Sealant bead wound round a thread (helix on the cylinder p0 + axis·s, radius) — e.g. HT200 on the
        L-connector thread; the nozzle follows the thread surface (normals radial)."""
        a = unit(axis); e1 = unit(np.asarray(start, float) - a * (np.asarray(start, float) @ a)); e2 = np.cross(a, e1)
        n = max(24, int(turns * 36)); surf, nor, tg = [], [], []
        for i in range(n + 1):
            u = i / n; ang = 2 * math.pi * turns * u
            r = e1 * math.cos(ang) + e2 * math.sin(ang)
            surf.append(np.asarray(p0, float) + a * length * u + r * radius); nor.append(r)
            tg.append(unit(np.cross(a, r) * 2 * math.pi * radius * turns + a * length))
        return self._bead_run(surf, nor, tg, dur, bead_d, label, colour, product, sealant, attach=attach, xform=xform, shot=shot)

    def hw(self, names, where):
        """Hardware list entry (grouped by base name, quantity counted from the CAD)."""
        c = Counter(base_name(n) for n in names)
        for b, q in c.items():
            ex = next(n for n in names if base_name(n) == b)
            self.hardware.append(dict(name=self.u.labels.get(ex, b), qty=q, where=where, **spec_of(ex, self.u.A[ex])))
        return self

    def _use_tool(self, tid, label):
        if tid not in [t["id"] for t in self.toolsUsed]: self.toolsUsed.append(dict(id=tid, label=label))

    def show(self, names):
        """Components visible (installed) from this step on without a motion of their own."""
        for n in names:
            self._track(n); self._key(n, 0)
        self._install(names)
        return self

    # ---------------------------------------------------------------- v2.2 staging, kit view
    def _group_pose(self, names, offset, tilt, pivot=None):
        bb = np.array([self.u.A[n]["bbox"] for n in names]); P = (bb[:, :3].min(0) + bb[:, 3:].max(0)) / 2 if pivot is None else np.asarray(pivot, float)
        q = quat_axis_angle(tilt[0], math.radians(tilt[1])) if tilt else ID_Q
        return np.asarray(offset, float) + P - quat_to_mat(q) @ P, q, P

    def stage(self, names, offset, tilt=None, approach=None, dur=1.6, label=None, pivot=None, allow=()):
        """v2.2: bring parts to a staging pose OFF the unit (offset from CAD, optional tilt about the group centre)
        and leave them there: they are part of the product from this step (visible, listed) and keep the pose in
        the following steps (holds) until an operation moves them — e.g. place(path=[offset, …], tilt=tilt).
        approach: start offset relative to the staging pose (mm), checked against the unit."""
        names = list(names)
        T, q, P = self._group_pose(names, offset, tilt, pivot)
        for n in names: self._track(n)
        if approach is not None:
            A0 = np.asarray(approach, float)
            for n in names: self._key(n, 0, T + A0, q); self._key(n, self.t, T + A0, q)
            mats = []
            for u in np.linspace(0, 1, S.PLACE.samples):
                Mx = np.eye(4); Mx[:3, :3] = quat_to_mat(q); Mx[:3, 3] = T + A0 * (1 - u); mats.append(Mx)
            self._check(label or f"stage {', '.join(base_name(n) for n in names[:3])}", self._group_mesh(names), mats, allow=allow)
            bb = np.array([self.u.A[n]["bbox"] for n in names]); c = (bb[:, :3].min(0) + bb[:, 3:].max(0)) / 2
            self._shot(self.t, quat_to_mat(q) @ (c - P) + P + np.asarray(offset, float), radius=float(np.linalg.norm(bb[:, 3:].max(0) - bb[:, :3].min(0))) / 2 + 30, kind="wide", ignore=names)
            for n in names: self._key(n, self.t + dur, T, q, ease=1)
            self.t += dur
        else:
            for n in names: self._key(n, 0, T, q)
        self._appear(names); self.u.held.update(names)
        return self

    def kit(self, names, offset):
        """v2.2: explicit position in the components view (mm, translation from CAD), used as is (no ×2 / cap):
        for parts whose first key is not a good exploded position (bench, staged door)."""
        for n in names:
            assert n in self.parts and self.u.installed_by.get(n) == self.i, f"kit(): {n} is not installed in this step"
            self.parts[n]["kit"] = [float(v) for v in offset]
        return self

    # ---------------------------------------------------------------- output
    def _frame_shots(self):
        """Opening overview (components + where they go) and closing result view of the step."""
        names = list(self.focus or self.components or [n for n, tr in self.parts.items() if not tr.get("hold")])
        names = [n for n in names if n in self.u.A]
        if not names: return

        def end_box(n):                               # v2.2: staged / bench parts are framed where they are
            b = np.asarray(self.u.A[n]["bbox"], float); tr = self.parts.get(n)
            if n in self.u.held and tr and tr["keys"]:
                T = np.asarray(tr["keys"][-1][1:4], float); return np.r_[b[:3] + T, b[3:] + T]
            return b
        bb = np.array([end_box(n) for n in names]); lo, hi = bb[:, :3].min(0), bb[:, 3:].max(0)
        R = float(np.linalg.norm(hi - lo)) / 2
        # the opening overview also shows where the components start (staging offsets of their tracks)
        slo, shi = lo.copy(), hi.copy()
        for n in names:
            tr = self.parts.get(n)
            if not tr or not tr["keys"]: continue
            T0 = np.array(tr["keys"][0][1:4]); b0 = np.asarray(self.u.A[n]["bbox"])
            slo = np.minimum(slo, b0[:3] + T0); shi = np.maximum(shi, b0[3:] + T0)
        wide = self.camera.get("wide")
        if wide or len(names) > S.CAMERA.wide_parts:
            body = np.array([p["bbox"] for p in self.u.A.values()])
            lo, hi = body[:, :3].min(0), body[:, 3:].max(0); R = float(np.linalg.norm(hi - lo)) / 2 * S.CAMERA.wide_body_share
        starts = [s for s in self.shots if s["t"] < S.CAMERA.overview_starts_before]
        if not starts:
            Rs = float(np.linalg.norm(shi - slo)) / 2
            self._shot(0.0, (slo + shi) / 2, radius=max(Rs * S.CAMERA.overview_pad, R * S.CAMERA.overview_pad_final, S.CAMERA.overview_min), kind="overview")
        self._shot(self.t + S.CAMERA.result_at, (lo + hi) / 2, radius=max(R * S.CAMERA.result_pad, S.CAMERA.result_min), kind="result")
        self.shots.sort(key=lambda s: s["t"])
        # drop shots closer than 0.35 s to the next one (the later one wins): fewer, calmer moves
        out = []
        for s in self.shots:
            if out and s["t"] - out[-1]["t"] < S.CAMERA.merge: out[-1] = s
            else: out.append(s)
        self.shots = out

    def to_json(self):
        u = self.u
        self._frame_shots()
        dur = round(self.t + S.STEP.end_hold, 3)

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
            extra = {}
            if tr.get("hold"): extra["hold"] = True
            if tr.get("kit") is not None: extra["kit"] = m3(tr["kit"])
            parts.append(dict(node=tr["node"], axis=tr["axis"], pivot=m3(tr["pivot"]), keys=keys, **extra))
        tools = []
        for tr in self.toolTracks:
            o = {k: v for k, v in tr.items() if k not in ("keys",)}
            o["keys"] = [[k[0], *m3(k[1:4]), *k[4:8]] for k in tr["keys"]]
            if "jawMm" in o: o["jaw"] = round(o.pop("jawMm") * M, 5)
            if "extension" in o: o["extension"] = round(o["extension"] * M, 5)
            if "sub" in o:
                o["sub"] = {p: [[k[0], (k[1] * M if p in ("plate", "jaw") else k[1]), k[2]] for k in ks] for p, ks in o["sub"].items()}
            tools.append(o)
        fx = []
        for f in self.fx:
            if f.get("_si"):                                   # v2.3 helpers emit metres already
                fx.append({k: v for k, v in f.items() if k != "_si"}); continue
            g = dict(f)
            if f["type"] in ("bead", "line"): g["points"] = [m3(p) for p in f["points"]]
            if f["type"] == "bead": g["diameter"] = f["diameter"] * M
            if f["type"] == "line": g["width"] = f["width"] * M
            if f["type"] == "mandrels": g["items"] = [dict(i, head=m3(i["head"])) for i in f["items"]]
            if f["type"] == "spinArrow": g["centre"] = m3(f["centre"]); g["radius"] = f["radius"] * M
            if f["type"] == "gasket":
                g["points"] = [m3(p) for p in f["points"]]; g["section"] = f["section"] * M
                if "width" in f: g["width"] = f["width"] * M
            if f["type"] == "cable":
                g["points"] = [m3(p) for p in f["points"]]; g["diameter"] = f["diameter"] * M; g["follow"] = f["follow"] * M
                g["end"] = [[k[0], *m3(k[1:4])] for k in f["end"]]
                if "attach" in f: g["attach"] = dict(f["attach"], base=m3(f["attach"]["base"]))
                if "base" in f: g["base"] = [[k[0], *m3(k[1:4])] for k in f["base"]]
                if "trim" in f: g["trim"] = [[k[0], round(k[1] * M, 6)] for k in f["trim"]]
                if "morph" in f: g["morph"] = dict(f["morph"], points=[m3(p) for p in f["morph"]["points"]])
                if "core" in f: g["core"] = dict(f["core"], length=f["core"]["length"] * M, d=f["core"]["d"] * M)
                if "twist" in f: g["twist"] = dict(f["twist"], c=m3(f["twist"]["c"]))
                if "ferrule" in f:
                    g["ferrule"] = dict(f["ferrule"], length=f["ferrule"]["length"] * M, od=f["ferrule"]["od"] * M, odCrimped=f["ferrule"]["odCrimped"] * M)
                    if "offset" in f["ferrule"]: g["ferrule"]["offset"] = m3(f["ferrule"]["offset"])
            if f["type"] == "dims":
                g["segments"] = [[m3(p) for p in sg] for sg in f["segments"]]; g["arrows"] = [[m3(p), v] for p, v in f["arrows"]]
                g["labels"] = [dict(l, pos=m3(l["pos"])) for l in f["labels"]]; g["refs"] = [m3(r) for r in f["refs"]]
                g["width"] = f["width"] * M; g["arrow"] = f["arrow"] * M; g["textH"] = f["textH"] * M
            if f["type"] == "airflow":
                g["paths"] = [[m3(p) for p in P] for P in f["paths"]]; g["speed"] = f["speed"] * M
                g["length"] = f["length"] * M; g["spacing"] = f["spacing"] * M
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


def ConvexHull2D(P):
    """Indices of the convex hull of 2-D points, counter-clockwise (monotone chain)."""
    idx = sorted(range(len(P)), key=lambda i: (P[i][0], P[i][1]))
    cross = lambda o, a, b: (P[a][0] - P[o][0]) * (P[b][1] - P[o][1]) - (P[a][1] - P[o][1]) * (P[b][0] - P[o][0])
    lo, hi = [], []
    for i in idx:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], i) <= 0: lo.pop()
        lo.append(i)
    for i in reversed(idx):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], i) <= 0: hi.pop()
        hi.append(i)
    return lo[:-1] + hi[:-1]


def rounded_polyline(points, r, closed=True, samples=4):
    """Polyline through `points` with every corner replaced by a quadratic arc of size r (mm)."""
    P = [np.asarray(p, float) for p in points]; n = len(P)
    out = []
    idx = range(n) if closed else range(1, n - 1)
    if not closed: out.append(P[0])
    for i in idx:
        a, c, b = P[i - 1], P[i], P[(i + 1) % n]
        din, dout = unit(c - a), unit(b - c)
        rr = min(r, np.linalg.norm(c - a) / 2.2, np.linalg.norm(b - c) / 2.2)
        s0, s1 = c - din * rr, c + dout * rr
        for f in np.linspace(0, 1, samples + 2):
            out.append((1 - f) ** 2 * s0 + 2 * (1 - f) * f * c + f * f * s1)
    if closed: out.append(out[0])
    else: out.append(P[-1])
    return out


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
    L = ["# Unit installation tutorial — engineering accuracy report (v2.2)", "",
         "*Generated by `pipeline/unit/build_unit.py` — do not edit by hand.*", "",
         "Source (v2.2): `MF-550-210-B_GROUPED_ASSEMBLY_03.step` merged by `pipeline/unit/merge_cad.py` with the Impeller Guard",
         "solid of the previous revision (empty in _03) and the supplied `cshm_06.stp` connector insert (not in _03, position",
         "assumed). The L-connector group (NPTA12 body with seal, O-ring, sealing nut, locknut) replaces the cable strain relief.",
         "Wiring reference: `MF550_MF1050_MF1950_MF560_MF750 (1).pdf` (3-phase wiring, 230/3/60 and 460/3/60); this unit: 230/3/60",
         "(confirmed by engineering), paired winding leads joined by splice.", "",
         "The STEP carries **no part numbers, descriptions or BOM data**",
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
    # node / BOM source: converter assembly.json of the grouped STEP, or (default) the published file itself
    conv = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "public/assets/unit/assembly.json"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "public/assets/unit/assembly.json"
    analysis = json.load(open(HERE / "unit-analysis.json"))
    asm = json.load(open(conv))
    tools = json.load(open(ROOT / "public/assets/unit/tools/tools.json"))
    decals = json.load(open(ROOT / "public/assets/unit/decals/decals.json"))
    U = Unit(analysis, asm, tools, decals)
    import steps_unit
    steps_unit.define(U)
    U.finalize_holds()
    missing = [n for n in U.A if n not in U.installed_by]
    if missing: raise SystemExit(f"parts never installed: {missing}")
    steps = [s.to_json() for s in U.steps]
    for n in asm["nodes"]:
        n["step"] = U.installed_by.get(n["name"]) if n["kind"] == "part" else None
        n["explode"] = [0.0, 0.0, 0.0]
        if n["name"] in U.labels: n["label"] = U.labels[n["name"]]          # v2.2 display names (CAD names unchanged)
    kids = {n["id"]: n for n in asm["nodes"]}
    def first_step(nid):
        n = kids[nid]
        if n["kind"] == "part": return n["step"]
        v = [first_step(c) for c in n["children"]]; v = [x for x in v if x is not None]
        return min(v) if v else None
    for row in asm["bom"]:
        row["steps"] = sorted({first_step(i) for i in row["nodes"]} - {None})
        if row["name"] in U.labels: row["label"] = U.labels[row["name"]]
    for row in asm.get("partsList", []):
        if row["name"] in U.labels: row["label"] = U.labels[row["name"]]
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
