"""
steps_unit.py — the authored installation sequence (v2.0, refined in v2.1, main-unit process update v2.2)

Order = the manufacturing workflow of the v2.0 brief (phases 1–9), with the additions the
CAD requires (all hardware present in MF-550-210-B_GROUPED_ASSEMBLY is installed somewhere;
nothing is invented). Deviations / open items are recorded as `flag(...)` on the step.
Camera `dir` = direction from the target towards the camera (model frame, Y up, front = +X).
v2.1: base clip nuts pushed up from below; the 10 back-panel rivets are pre-installed with the main
body (shown from step 1, no install operation); Phase 3 = bracket first, impeller + motor raised from
below into the fitted bracket, then the motor fastening that depends on it.
v2.2 (MF-550-210-B_GROUPED_ASSEMBLY_03): L-connector (NPTA12) instead of the cable strain relief; motor built
on its bracket on the bench, then lowered into the unit and fastened (drill + extension on all four bolts);
nine motor leads routed through the L-connector, ferrules crimped, connector insert wired (pending terms
left open, see WIRING); filter stickers; access-door clip nuts, gasket and silicone; tapping of the
clamp-bracket holes; wrench hold on the clamp bolts; connector engagement; rotation + airflow indicators;
fibre bed filter; gauge tightened with the wrench before its box cover. Back-panel screws and the back,
filter-base and leg rivets are part of the main body as delivered (shown from step 1).
"""
from __future__ import annotations

import math

import numpy as np

from unitlib import delta_matrix, ID_Q, unit
import standards as S

FRONT, BACK, TOP = (1, 0, 0), (-1, 0, 0), (0, 1, 0)
NO_BIT = ("Driver bit not supplied: a placeholder 1/4 in hex bit (labelled) is shown in the drill — "
          "drive type of the pan-head screws is not modelled in the CAD")


CLIP_CHECK = ("After installation, inspect each clip nut: it must be fully seated, aligned with its hole, tightly attached and firmly "
              "holding its position, with no looseness.")
CLIP_CHECK_SPEECH = "Then check each clip nut: fully seated, aligned with its hole, and firmly holding its position."

# v2.3: rotation arrow sticker on Motor Mounting Bracket-1 (Marks&Arrow photograph, rectified with the four motor bolts)
ARROW_STICKER = dict(centre=(-112.7, -2.3), w=26.0, h=77.0)


def worktable(y_top, z_c, x_c=-176.6, half=(260.0, 210.0), floor=-316.8):
    """Presentation worktable beside the unit (boxes, mm): top at y_top, centred at (x_c, z_c), legs to the floor."""
    hx, hz = half; t = 30.0; leg = 40.0
    top = dict(min=[x_c - hx, y_top - t, z_c - hz], max=[x_c + hx, y_top, z_c + hz], colour="#8c9298", rough=0.55, metal=0.35)
    legs = [dict(min=[x - leg / 2, floor, z - leg / 2], max=[x + leg / 2, y_top - t, z + leg / 2], colour="#3a3e44")
            for x in (x_c - hx + 30, x_c + hx - 30) for z in (z_c - hz + 30, z_c + hz - 30)]
    return [top] + legs


def bellmouth_supports(y_top, offset, pivot):
    """Two support blocks on the worktable under the long edges of the turned-over bellmouth plate (throat clear)."""
    y_plate = pivot[1] + offset[1] - 0.4; z0 = offset[2]; x0 = pivot[0] + offset[0]
    return [dict(min=[x0 - 100, y_top, z0 + z1], max=[x0 + 100, y_plate, z0 + z2], colour="#6d4a2c", rough=0.9, metal=0.0)
            for z1, z2 in ((125.0, 152.0), (-152.0, -125.0))]


def bracket_web_top(U, x, z):
    """Top surface of the bracket web at (x, z) (ray cast on the CAD mesh)."""
    import trimesh
    from trimesh.ray.ray_triangle import RayMeshIntersector
    m = U.world.mesh["Motor Mounting Bracket"]
    m = trimesh.Trimesh(m.vertices, m.faces, process=False)
    loc, _, _ = RayMeshIntersector(m).intersects_location([[x, 200.0, z]], [[0, -1.0, 0]], multiple_hits=True)
    return float(max(p[1] for p in loc)) if len(loc) else 102.0


# v2.3 back-panel labels (photo-measured, BackSticker photographs): id -> (z centre, y centre, width, height) mm
BACK_LABELS = {"motor-info": (-0.6, 171.4, 94.6, 33.5), "warning-disconnect": (-35.1, 136.6, 62.0, 36.0),
               "caution-disconnect": (27.6, 136.0, 62.5, 37.0)}


def quat_to_mat_(rot):
    from unitlib import quat_axis_angle, quat_to_mat
    return quat_to_mat(quat_axis_angle(unit(rot[0]), math.radians(rot[1])))


def strands_at(path, P, r=11.0):
    """Centres of the cable passes within r of P (one per pass) and the tangent of the first pass."""
    path = np.asarray(path, float); d = np.linalg.norm(path - P, axis=1)
    idx = np.nonzero(d < r)[0]
    passes = np.split(idx, np.nonzero(np.diff(idx) > 3)[0] + 1) if len(idx) else []
    cs = [path[g[np.argmin(d[g])]] for g in passes if len(g)]
    k = passes[0][np.argmin(d[passes[0]])]
    tg = unit(path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)])
    return cs, tg


def crimp_ring(r=38.0, drop=42.0):
    """Crimping positions of the six lead ends (singles + first lead of each pair) round the cable end."""
    keys = list(SINGLES) + [a for a, _ in SPLICES]
    out = {}
    for i, k in enumerate(keys):
        a = math.radians(-90 + 360.0 * i / len(keys))
        out[k] = J_WORK + np.array([r * math.cos(a), -drop, r * math.sin(a)])
    return out


def clip_dir(U, name, prefer=None, travel=S.CLIP.travel, allow=()):
    """Slide-on direction of a clip nut: the first direction perpendicular to its bolt axis along which it
    slides on collision-free WITHOUT the mating sheet allowed (v2.1: riding a small offset along its axis,
    as fastener(kind='clip') does), preferring vertical (from below first) then `prefer`."""
    p = U.A[name]; a = unit(p["axis"]); head = np.asarray(p["head"])
    cands = [np.array(v, float) for v in ((0, -1, 0), (0, 1, 0), (1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1))]
    cands = [c for c in cands if abs(c @ a) < 0.2]
    if prefer is not None:
        cands.sort(key=lambda c: (-float(c @ unit(prefer)) if abs(c[1]) < 0.5 else -2.0 - float(c @ unit(prefer))))
    mesh = U.world.mesh[name]
    best = None
    for d in cands:
        for trav in (travel, 22.0, 16.0):
            for o in S.CLIP.ride_offsets:
                worst = 0.0
                for s in np.linspace(0, 1, S.CLIP.slide_samples)[:-1]:
                    hit = U.world.hits(mesh, delta_matrix(d * trav * (1 - s) + a * o, ID_Q, head, a, 0), allow=set(allow))
                    worst = max([worst, *hit.values()]) if hit else worst
                if worst == 0.0: return dict(slide=d, travel=trav)
                if best is None or worst < best[0]: best = (worst, d, trav)
    return dict(slide=best[1], travel=best[2])


def choose_place(U, names, options, allow=(), pivot=None, tilt_rate=None):
    """First (path, tilt) option whose sampled motion is collision-free; else the least colliding one."""
    from build_unit import Step  # noqa
    import trimesh
    mesh = trimesh.util.concatenate([U.world.mesh[n] for n in names])
    A = U.A
    bb = np.array([A[n]["bbox"] for n in names]); P = (bb[:, :3].min(0) + bb[:, 3:].max(0)) / 2
    if pivot is not None: P = np.asarray(pivot, float)
    rate = tilt_rate or S.PLACE.tilt_removal_rate
    from build_unit import slerp  # noqa
    from unitlib import quat_axis_angle, quat_to_mat
    best = None
    for path, tilt in options:
        pts = [np.asarray(p, float) for p in path] + [np.zeros(3)]
        seg = [np.linalg.norm(pts[k + 1] - pts[k]) for k in range(len(pts) - 1)]; total = sum(seg)
        qs = quat_axis_angle(tilt[0], math.radians(tilt[1])) if tilt else ID_Q
        worst = 0.0
        for s in np.linspace(0, 1, 30)[:-4]:
            d = s * total; k = 0
            while k < len(seg) - 1 and d > seg[k]: d -= seg[k]; k += 1
            o = pts[k] + (pts[k + 1] - pts[k]) * (0 if seg[k] == 0 else min(1, d / seg[k]))
            q = slerp(qs, ID_Q, min(1, s * rate)) if tilt else ID_Q
            T = o + P - quat_to_mat(q) @ P
            hit = U.world.hits(mesh, delta_matrix(T, q, P, (0, 1, 0), 0), allow=set(allow))
            if hit: worst += sum(hit.values())
        if worst == 0: return path, tilt
        if best is None or worst < best[0]: best = (worst, path, tilt)
    return best[1], best[2]


def sub_assembly_checks(U, wheel, motor, bm):
    """Relative motions inside the impeller sub-assembly (wheel up onto the shaft, bellmouth up under the
    wheel) checked mesh-to-mesh; only the final seated contact (depth 0) is allowed."""
    import trimesh
    from trimesh.collision import CollisionManager
    out = []
    for moving, fixed, label, travel in ((wheel, motor, "impeller wheel onto the motor shaft", 95.0),
                                         (bm, wheel + motor, "inlet bellmouth under the impeller", 190.0)):
        cm = CollisionManager()
        for n in fixed: cm.add_object(n, U.world.mesh[n])
        mm = trimesh.util.concatenate([U.world.mesh[n] for n in moving])
        worst = {}
        for dy in np.linspace(-travel, -0.5, 30):
            T = np.eye(4); T[1, 3] = dy
            hit, names, data = cm.in_collision_single(mm, transform=T, return_names=True, return_data=True)
            if hit:
                d = max(c.depth for c in data)
                if d > 0.05:
                    for n in names: worst[n] = max(worst.get(n, 0), round(float(d), 2))
        out.append(dict(what=label, samples=30, clear=not worst, collisions=worst))
    return out


CONNECTOR = "CSHM 06 Connector Insert"
L_PARTS = ["NPTA12_L_body_with_seal", "NPTA12_o_ring", "NPTA12_sealing_nut", "NPTA12_locknut"]

# --------------------------------------------------------------------------- v2.2 wiring data
# Wiring reference: MF550_MF1050_MF1950_MF560_MF750 (1).pdf, "MIST COLLECTOR 3 PHASES WIRING" (Aeroex, rev A).
# Nine motor conductors are drawn: Black, Grey, Red, Blue, Orange, Brown (windings), GND (green) and two
# White (thermal switch). Their termination differs between the two supply variants of the drawing:
#   230/3/60: Black+Grey -> 1, Red+Blue -> 2, Orange+Brown -> 3, pin 4 not in use, White -> 5, White -> 6, GND -> PE
#   460/3/60: Black -> 1, Blue -> 2, Brown -> 3, Orange+Grey+Red joined -> 4, White -> 5, White -> 6, GND -> PE
# Engineering confirmed (v2.2 review): this unit is 230/3/60 and the paired winding leads are joined by a splice.
WIRING = "230/3/60"
LEAD_COLOUR = {"Black": "#1b1b1d", "Grey": "#8b8f95", "Red": "#c62a2a", "Blue": "#2059c4", "Orange": "#ee7d1c",
               "Brown": "#6a4128", "White 5": "#f3f3f0", "White 6": "#f3f3f0", "GND": "#2f9a3e"}
TERMINATED = {"GND": "PE", "White 5": "5", "White 6": "6",                 # identical in both diagrams
              "Black": "1", "Grey": "1", "Red": "2", "Blue": "2", "Orange": "3", "Brown": "3"}   # 230/3/60
SPLICES = (("Black", "Grey"), ("Red", "Blue"), ("Orange", "Brown"))       # one splice per pair (first lead carries it)
SINGLES = ("White 5", "White 6", "GND")                                    # wire-end ferrules
# the two leads of a pair arrive side by side (along the contact row, world z — seen side by side from the wiring
# side), touching: ±(od / 2 + 0.05) mm
PAIR_SIDE = {a: -1 for a, _ in SPLICES} | {b: 1 for _, b in SPLICES}
# contact cavities of the insert, model frame (CAD pose of the insert): numbering 1-2-3 / 4-5-6 (rows seen
# from the wire side) and the PE clamp position are ASSUMED — the supplied model carries no markings
_LOCAL = {"1": (50.6, 33.4), "2": (57.3, 33.4), "3": (64.0, 33.4), "4": (50.6, 23.9), "5": (57.3, 23.9), "6": (64.0, 23.9),
          "PE": (69.0, 28.7)}
import cad_extras as CX                  # v2.3: insert / hood / data tag placements (shared with merge_cad.py)

def _cavity(pin):
    """Contact cavity of the insert (final pose in the hood), 1 mm above its wire face (model frame)."""
    lx, ly = _LOCAL[pin]
    R = np.array(CX.CONNECTOR["R"], float); c = np.array(CX.CONNECTOR["centre"]) - R @ np.array(CX.CONNECTOR["centre_local"])
    return R @ np.array([lx, ly, 21.6]) + c


def _pair_offset(k):
    """Side offset of a spliced lead from the centre of its terminal (0 for single leads)."""
    return np.array([0.0, 0.0, PAIR_SIDE.get(k, 0) * (S.CABLE.od / 2 + 0.05)])


def _lead_target(k):
    return _cavity(TERMINATED[k]) + _pair_offset(k)


def _smooth(points, step=2.0):
    """Centripetal Catmull-Rom through the points, resampled every `step` mm (lead centrelines)."""
    P = [np.asarray(p, float) for p in points]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        t0 = 0; t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5; t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5; t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5
        n = max(2, int(np.linalg.norm(p2 - p1) / step))
        for t in np.linspace(t1, t2, n, endpoint=False):
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    out.append(P[-2])
    return out


# --------------------------------------------------------------------------- v2.3 motor cable (jacket + nine leads)
# The motor's own cable (black outer jacket, nine 22 AWG leads inside) runs from the lead-exit boss of the motor along
# the bracket (cable tie on the bracket tab — ZipTie photo), down to the L-connector, through it and out of the sealing
# nut; outside it is laid out to a work position behind the unit for the preparation (hood threaded on, jacket and
# insulation stripped, crimps, insert wired, hood fitted), then coiled on the back panel with two cable ties
# (CableDisposition photos) with the connector hanging at the lower left. Shapes: control points (mm), smoothed.
E_EXIT = np.array([-261.08, 89.96, 0.0])              # centre of the motor's lead-exit face (CAD)
TAB = np.array([-318.5, 96.3, 0.0])                    # cable on the bracket tab (T-tab, x -323…-314, z ±7; ZipTie photo)
NUT_EXIT = np.array([-397.5, -30.0, 0.0])
J_FINAL = np.array([CX.HOOD["axis_x"], CX.HOOD["y_top"] - 12.0, CX.HOOD["axis_z"]])   # jacket end, inside the hood gland
T_W = np.array([-148.0, -6.0, 17.6])                   # work pose = final pose + T_W (insert, hood, jacket end)
J_WORK = J_FINAL + T_W
HOOD_PARK = T_W + np.array([0.0, 150.0, 0.0])          # hood slid up the cable while the end is prepared
HOOD_START = T_W + np.array([0.0, -82.0, 0.0])         # hood offered up from below the cable end
PANEL_X = CX.BACK_FACE_X - S.STRIP.jacket_od / 2 - 1.0 # coil centreline against the back panel
_INSIDE = [E_EXIT, E_EXIT + (-14, 1, 0), (-300, 94.5, 0), TAB, (-331, 90, 0), (-336.5, 64, 0), (-346, 49.5, 0), (-358, 44.5, 0),
           (-366, 43.7, 0), (-384, 43.7, 0), (-393.2, 40.8, 0), (-396.1, 32.0, 0), (-396.1, 8.0, 0), (-396.1, -6.0, 0), NUT_EXIT]
_HANG = [(-399.5, -110, 0), (-424, -186, 0), (-470, -201, 0), (-500, -142, 0), (-510, -30, 0), (-526, 80, 0), (-548, 127, 0),
         (-565, 104, 0), (-565, 20, 0), (-565, -60, 0), J_WORK, J_WORK - (0, S.STRIP.conductor_len, 0)]
# coil on the panel (photo coordinates z, y — CableDisposition2, rectified): two turns, the second one inside
_COIL1 = [(-4.5, -40), (24, -13), (63, -6), (102, -20), (128, -62), (124, -96), (98, -128), (50, -143), (10, -128), (-10, -92), (-8, -58)]
_COIL2 = [(4, -34), (30, -22), (63, -15.5), (95, -29), (117, -62), (114.5, -96), (92, -120), (50, -134), (17, -121), (0, -95)]
TIE1 = (-4.5, -45.0); TIE2 = (119.5, -96.0)


def _panel(zy, dx=0.0): return np.array([PANEL_X - dx, zy[1], zy[0]])


def jacket_paths(n_out=320):
    """(route path ending at the cable end before stripping, coiled path ending inside the hood, index of the tab).
    Both share the inside part point for point; the outside parts have the same point count (morph)."""
    inside = _smooth([np.asarray(p, float) for p in _INSIDE], step=3.0)
    k_tab = int(np.argmin([np.linalg.norm(p - TAB) for p in inside]))
    hang = _smooth([NUT_EXIT] + [np.asarray(p, float) for p in _HANG], step=3.0)
    coil = [NUT_EXIT + (3, -10, -1.5), _panel((-3, -30), 6)] + [_panel(q) for q in _COIL1] + [_panel(q) for q in _COIL2] + \
           [(-392, -80, -6), (-410, -70, -15), J_FINAL + (0, 26, 0), J_FINAL + (0, 12, 0), J_FINAL, J_FINAL - (0, S.STRIP.conductor_len, 0)]
    loop = _smooth([NUT_EXIT] + [np.asarray(p, float) for p in coil], step=3.0)
    return inside + resample(hang, n_out)[1:], inside + resample(loop, n_out)[1:], k_tab


def bench_jacket():
    """Short piece shown on the worktable: motor exit -> bracket tab -> the rest of the cable hanging off the bracket."""
    return _smooth([E_EXIT, E_EXIT + (-14, 1, 0), (-300, 94.5, 0), TAB, (-336, 92, 0), (-352, 70, 0), (-357, 30, 0), (-358, -20, 0)], step=3.0)


def resample(P, n):
    P = np.asarray(P, float); L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
    return [np.array([np.interp(x, L, P[:, j]) for j in range(3)]) for x in np.linspace(0, L[-1], n)]


def lead_rest():
    """The nine leads at the cable end (work configuration): 3 x 3 bundle hanging straight from the jacket end."""
    slots = [(a, b) for a in (-1, 0, 1) for b in (-1, 0, 1)]
    out = {}
    for k, (a, b) in zip(LEAD_COLOUR, slots):
        o = np.array([a * S.CABLE.pitch, 0.0, b * S.CABLE.pitch])
        out[k] = [J_WORK + o + (0, 0.5, 0), J_WORK + o - (0, 20, 0), J_WORK + o - (0, 40, 0), J_WORK + o - (0, S.STRIP.conductor_len, 0)]
    return out


def check_path(s, label, pts, r, allow_fn=None, step=4.0):
    """Collision samples (spheres) along a cable centreline against the installed parts (standards § 5)."""
    import trimesh
    sph = trimesh.creation.icosphere(subdivisions=1, radius=r)
    P = np.asarray(pts, float); L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
    worst = {}; n = 0
    for x in np.arange(0, L[-1], step):
        q = np.array([np.interp(x, L, P[:, j]) for j in range(3)]); Mx = np.eye(4); Mx[:3, 3] = q; n += 1
        for nm, d in s.u.world.hits(sph, Mx, allow=set(allow_fn(q) if allow_fn else ()), tol=0.25).items(): worst[nm] = max(worst.get(nm, 0), d)
    s.checks.append(dict(what=f"motor cable ({label})", samples=n, clear=not worst, collisions={a: round(b, 2) for a, b in sorted(worst.items(), key=lambda kv: -kv[1])[:4]}))
    return worst


def _jacket_allow(q):
    al = set()
    if np.linalg.norm(q - E_EXIT) < 9: al.add("Impeller Drive Motor")                  # leaving the motor's lead exit
    if q[0] < -358 and -9 < q[1] < 62 and abs(q[2]) < 20: al |= set(L_PARTS) | {"Back Panel"}   # through the L-connector
    if np.linalg.norm(q[[0, 2]] - J_FINAL[[0, 2]]) < 12 and q[1] < J_FINAL[1] + 30: al.add(CX.HOOD["name"])   # into the hood gland
    return al


# parts the air passes through (porous media and perforated baffles) — the airflow paths may cross them
AIR_POROUS = {"Mesh Filter Media", "Perforated Filter Baffle", "Perforated Filter Baffle (1)", "Perforated Filter Baffle (2)",
              "Pleated Filter Element"}


def airflow_paths(mp):
    """Air streams about the impeller axis (through the motor centre), from the profile in standards.AIRFLOW."""
    c = np.array([mp[0], 0.0, mp[2]])
    out = []
    for a in S.AIRFLOW.angles:
        u = np.array([math.cos(math.radians(a)), 0.0, math.sin(math.radians(a))])
        out.append(_smooth([c + u * r + np.array([0.0, y, 0.0]) for r, y in S.AIRFLOW.profile], step=8.0))
    return out


def define(U):
    body = U.group("MAIN BODY")
    imp = U.group("Impeller")
    wheel = [n for n in imp if n.startswith(("Impeller Blade", "Impeller Shroud", "Impeller Back Plate"))]
    motor_side = [n for n in imp if n not in wheel]
    nuts_base = U.group("Nuts_Base")
    mb_hw = U.group("Hardware_M_mountingBracket")
    washers = [n for n in mb_hw if "Washer" in n]
    motor_bolts = [n for n in mb_hw if "Bolt" in n]
    bm_hw = U.group("Hardware_BellmouthMountingPlate")
    bm_bolts = sorted(n for n in bm_hw if "Bolt" in n); bm_nuts = sorted(n for n in bm_hw if "Nut" in n)
    door_hw = U.group("HardwareDoor_Filters")
    door_bolts = sorted(n for n in door_hw if "Bolt" in n and "Washer" not in n); door_washers = sorted(n for n in door_hw if "Washer" in n)
    fcb_hw = U.group("FilterClampBoltBracket_Hardware")
    fcb_brackets = [n for n in fcb_hw if "Bracket" in n]; fcb_screws = [n for n in fcb_hw if "Screw" in n]
    top = [n for n, p in U.A.items() if p["group"] is None]
    brk_bolts = ["Hex Flange Bolt", "Hex Flange Bolt (1)", "Hex Flange Bolt (2)", "Hex Flange Bolt (5)"]
    brk_clips = ["Clip Nut (13)", "Clip Nut (14)", "Clip Nut (16)", "Clip Nut (17)"]
    plate_screws = sorted(n for n in top if n.startswith("Self-Tapping"))
    door_clips = ["Clip Nut (12)", "Clip Nut (5)"]
    door_clips_low = ["Clip Nut", "Clip Nut (1)"]                 # v2.3: pre-installed with the main body (engineering)
    gauge_screws = ["Pan Head Machine Screw (12)", "Pan Head Machine Screw (6)"]
    back_screws = ["Pan Head Machine Screw (10)", "Pan Head Machine Screw (11)"]
    rivets = sorted(n for n in top if n.startswith("Closed-End Rivet"))
    by_contact = lambda pair: [r for r in rivets if set(pair) <= set(U.A[r].get("contacts", []))]
    door_rivets = by_contact(("Access Door", "Door Frame"))
    back_rivets = by_contact(("Back Panel", "Unit Body")) + by_contact(("Back Panel", "Filter Base"))
    fb_rivets = [r for r in by_contact(("Filter Base", "Unit Body")) if r not in back_rivets]
    leg_rivets = by_contact(("Track Mount Leg", "Unit Body")) + by_contact(("Track Mount Leg (1)", "Unit Body"))
    gauge_rivets = by_contact(("Gauge Box Enclosure", "Unit Body"))
    pre_rivets = [f"Closed-End Rivet ({k})" for k in (22, 23, 35, 24, 39, 37, 26, 27, 25, 36)]
    assert all(r in rivets for r in pre_rivets), "pre-installed rivet missing from the CAD"
    back_rivets = [r for r in back_rivets if r not in pre_rivets]
    used_rivets = set(pre_rivets + door_rivets + back_rivets + fb_rivets + leg_rivets + gauge_rivets)
    assert used_rivets == set(rivets), f"rivets not assigned: {sorted(set(rivets) - used_rivets)}"
    # v2.2: delivered with the main body (their install steps are removed): visible from step 1, no motion
    delivered = back_rivets + fb_rivets + leg_rivets                 # v2.3: the two back panel screws now fix the data tag
    body_now = [n for n in body if n not in door_clips_low + ["Gauge Box Cover"]]
    door = ["Door Frame", "Access Door"] + door_rivets               # v2.2: door rivets already set (door sub-assembly)

    U.labels.update({"HepaFilter": "Fibre Bed Filter", CONNECTOR: CONNECTOR})
    for w in door_washers: U.labels[w] = "Bonded Sealed Washer"
    for b_ in bm_bolts: U.labels[b_] = "Machine Screw"                 # v2.3 engineering terminology (CAD: hex flange head)

    P1, P2, P3, P4, P5, P6, P7, P8, P9 = (
        "Main body preparation", "Base hardware and cable entry", "Motor, impeller and motor cable",
        "Impeller protection and bellmouth", "Mechanical filters and filter cover", "Exterior identification and filter clamping",
        "Cable, gauge and electrical verification", "Fibre bed filter", "Final assembly")

    # ---------------------------------------------------------------- PHASE 1
    s = U.step(phase=1, phaseTitle=P1, title="Inspect the main body",
               text="Start with the fully assembled, painted main body. Check that every face is closed, no structural part is missing and the paint is complete. All closed-end rivets of the main body and the two lower clip nuts of the filter opening are already installed.",
               speech="Start with the fully assembled and painted main body. Check that every face is closed, nothing is missing and the paint is complete. All the rivets of the main body and the two lower clip nuts of the filter opening are already installed.",
               camera=dict(dir=[1, 0.5, 0.85], wide=True))
    s.show(body_now + pre_rivets + delivered + door_clips_low)
    s.hw(pre_rivets + back_rivets + fb_rivets + leg_rivets, "main body — installed with the main body")
    s.hw(door_clips_low, "lower door flange — installed with the main body")
    s.wait(3.5)

    # ---------------------------------------------------------------- PHASE 2
    s = U.step(phase=2, phaseTitle=P2, title="Install the base clip nuts",
               text="From below, push each of the eight clip nuts straight up onto the bottom edge of the base flange at its mounting hole, threaded side facing out, until it snaps into the hole. " + CLIP_CHECK,
               speech="From below, push each of the eight clip nuts straight up onto the bottom edge of the base flange, one at each mounting hole, until it snaps in. " + CLIP_CHECK_SPEECH,
               camera=dict(dir=[0.55, -0.75, 0.55], underside=True))
    for k, n in enumerate(sorted(nuts_base, key=lambda n: math.atan2(U.A[n]["centre"][2], U.A[n]["centre"][0] + 189))):
        s.fastener(n, "clip", slide=(0, -1, 0), travel=40.0, dur=1.1 if k < 2 else 0.8)
    s.wait(1.2)
    s.hw(nuts_base, "base flanges, 8 positions")

    LC = ["NPTA12_L_body_with_seal", "NPTA12_o_ring", "NPTA12_sealing_nut"]
    s = U.step(phase=2, phaseTitle=P2, title="Seal and fit the L-connector",
               text="Hold the black L-connector (O-ring and sealing nut already on it, as supplied) outside the back panel. Apply HT200 sealant around the thread of the L-connector, just behind the O-ring, with the caulking gun — not in the hole of the unit. Then push the connector through the cable entry hole with its outlet pointing down, and leave the sealing nut loose on the outlet.",
               speech="Hold the L-connector outside the back panel, with its O-ring and sealing nut already on it. Apply H T two hundred sealant around its thread, just behind the O-ring, with the caulking gun, not in the hole of the unit. Then push it through the cable entry hole with the outlet pointing down, and leave the sealing nut loose.",
               camera=dict(dir=[-1, 0.35, 0.55]))
    L_OFF = np.array([-130.0, 0.0, 0.0])
    s.stage(LC, offset=L_OFF, approach=(-60, 0, 90), dur=1.4, label="L-connector held outside the back panel")
    Tq = s._group_pose(LC, L_OFF, None)[:2]
    face_x = U.A["Back Panel"]["bbox"][0]
    s.bead_helix(p0=(face_x + 1.8, 43.701, 0.0), axis=(1, 0, 0), radius=10.7, length=7.0, turns=1.3, dur=3.6, bead_d=S.SEALANT.ht200_d,
                 label="HT200 on the L-connector thread", colour=S.SEALANT.ht200, sealant=S.SEALANT.ht200,
                 product="Caulking dispenser with WEICON Flex 310 M HT 200 (grey MS-polymer sealant, silicone-free)",
                 attach="NPTA12_L_body_with_seal", xform=Tq, start=(0, 1, 0), shot=((face_x + 5, 43.7, 0.0), 95, (0, 0.5, 1)))
    s.place(LC, path=[L_OFF], dur=1.8, final_allow={"Back Panel"}, label="L-connector through the cable entry hole")
    s.hw(LC, "back panel, cable entry")
    s.flag("HT200 is taken as WEICON Flex 310 M HT 200 (grey, silicone-free MS polymer); applied round the L-connector thread as the work "
           "instruction says (grey caulking to the thread) — bead size not specified: 3 mm, 1.3 turns behind the O-ring")
    s.flag("The O-ring and the sealing nut come fitted on the L-connector body (supplied configuration): no separate O-ring operation (engineering v2.3). "
           "Thread designation, sealing range and tightening torque are not in the CAD")

    s = U.step(phase=2, phaseTitle=P2, title="Tighten the L-connector locknut",
               text="From inside the unit, run the locknut onto the L-connector thread by hand until it seats against the back panel, then tighten it with the socket wrench (ratchet) while the L-connector outlet stays pointing down.",
               speech="From inside the unit, run the locknut onto the L-connector thread by hand until it seats. Then tighten it with the socket wrench, keeping the outlet pointing down.",
               camera=dict(dir=[-0.85, 0.45, 0.6], xray=True))
    n = "NPTA12_locknut"
    s.fastener(n, "nut", side=FRONT, gap=30, engage=3.0, hand_turns=2)
    s.drive_with_hand(n, turns=1, dur=0.8)
    s.ratchet(n, side=(1, 0, 0), total_deg=120)
    s.hw([n], "inside the back panel, on the L-connector thread")

    # ---------------------------------------------------------------- PHASE 3 — motorized impeller into its bracket (worktable)
    # v2.3 (engineering): the drive motor comes fitted to the impeller wheel by the manufacturer (TMK 250-2-34 motorized
    # impeller): it is NOT assembled here. It stands on a worktable beside the unit; Motor Mounting Bracket-1 is set
    # on it and bolted (torque wrench), marked, labelled (rotation arrow) and the motor cable is tied to the bracket
    # tab; then the assembly is lifted into the unit.
    bm = [n for n in imp if n == "Impeller Inlet Bellmouth"]
    motor_only = [n for n in motor_side if n not in bm]
    mot_imp = motor_only + wheel
    bench = ["Motor Mounting Bracket"] + mot_imp + washers + motor_bolts
    TBL = np.array([0.0, 40.0, 600.0])                       # worktable beside the unit (right side seen from the front)
    SHROUD_Y = U.A["Impeller Shroud"]["bbox"][1]             # impeller inlet rim stands on the worktable
    table = worktable(SHROUD_Y + TBL[1], TBL[2])
    ax, az = ARROW_STICKER["centre"]; wy = bracket_web_top(U, ax, az)
    U.bench_begin(bench, offset=TBL)
    s = U.step(phase=3, phaseTitle=P3, title="Set the motorized impeller on the worktable",
               text="The drive motor comes fitted in the impeller by the manufacturer (motorized impeller TMK 250-2-34) — do not take it apart. Set the motorized impeller on the worktable beside the unit, inlet down, motor flange up.",
               speech="The drive motor comes fitted in the impeller by the manufacturer, so do not take it apart. Set the motorized impeller on the worktable beside the unit, inlet down, motor flange up.",
               camera=dict(dir=[0.85, 0.5, 0.75]))
    s.prop(table)
    s.place(mot_imp, path=[(0, 110, 0)], dur=1.8, label="motorized impeller set on the worktable")
    s.focus = mot_imp
    KX = S.BENCH.kit_x
    s.kit(mot_imp, (KX, 120, 0))
    s.flag("The worktable is a presentation element (not part of the unit); its size and height are generic")

    s = U.step(phase=3, phaseTitle=P3, title="Install the motorized impeller in the motor mounting bracket",
               text="Lower Motor Mounting Bracket-1 onto the motor flange with its four centre holes over the four threaded holes of the motor. Place an external tooth lock washer over each hole and start the four M6 motor mounting bolts by hand.",
               speech="Lower the motor mounting bracket onto the motor flange, with its four centre holes over the threaded holes of the motor. Place a lock washer over each hole and start the four motor mounting bolts by hand.",
               camera=dict(dir=[0.75, 1.0, 0.5]))
    s.prop(table)
    s.place(["Motor Mounting Bracket"], path=[(0, 150, 0)], dur=1.8, final_allow=set(motor_only), label="bracket onto the motor flange")
    for n in washers: s.fastener(n, "washer", side=TOP, gap=25, dur=0.7)
    for n in motor_bolts: s.fastener(n, "bolt", dur=0.9)
    s.hw(["Motor Mounting Bracket"], "on the motor flange"); s.hw(washers, "motor mounting holes, under the bolt heads"); s.hw(motor_bolts, "bracket into the drive motor")
    s.kit(["Motor Mounting Bracket"], (KX, 330, 0)); s.kit(washers, (KX, 385, 0)); s.kit(motor_bolts, (KX, 440, 0))
    s.flag("Motor bolts M6 x 1.0 x 12 mm with star lock washers per the work instruction (Mistfit 550 230_460.xlsx); the CAD models hex bolts with external tooth lock washers")

    s = U.step(phase=3, phaseTitle=P3, title="Tighten the motor mounting bolts",
               text="Tighten each motor mounting bolt with the torque wrench to the approved torque specification, one bolt at a time, then check that every bolt is secure and its lock washer is seated.",
               speech="Tighten each motor mounting bolt with the torque wrench to the approved torque specification, one at a time. Then check that every bolt is secure and its lock washer is seated.",
               camera=dict(dir=[0.7, 1.0, 0.45], close=True))
    s.prop(table)
    for n in motor_bolts:
        s.ratchet(n, side=(0, 1, 0), total_deg=90, swing=30, tool="torquewrench", hints=((1, 0, 0), (0, 0, 1), (-1, 0, 0), (0, 0, -1)), depth=3.5,
                  label="Torque wrench (Sketchfab model, CC-BY-4.0 — not a supplied engineering model) + 10 mm deep socket (resized from the supplied 9/16 in model)")
        s.wait(0.25)
    s.hw(motor_bolts, "bracket into the drive motor")
    s.flag("Tightening torque is not specified in the supplied data: the instruction refers to the approved torque specification — engineering to supply the value")

    s = U.step(phase=3, phaseTitle=P3, title="Mark the motor mounting bolts",
               text="After tightening, draw a red tightening mark from each bolt across its lock washer onto the bracket, so that any loosening is visible.",
               speech="After tightening, draw a red mark from each bolt across its lock washer onto the bracket, so any loosening can be seen.",
               camera=dict(dir=[0.6, 1.0, 0.5], close=True))
    s.prop(table)
    s.mark(motor_bolts, dir_hint=(1, 0, 0))
    s.hw(motor_bolts, "tightening marks")
    s.flag("Tightening marks as in the Marks&Arrow / ImpellerMountingPlate photographs (red line across the bolt and washer onto the bracket)")

    s = U.step(phase=3, phaseTitle=P3, title="Apply the rotation arrow sticker",
               text="Apply the yellow rotation arrow sticker on the bracket next to the motor, on the side opposite the motor cable, arrow pointing in the direction of rotation (counter-clockwise seen from above). Press it flat.",
               speech="Apply the yellow rotation arrow sticker on the bracket next to the motor, on the side opposite the cable, with the arrow pointing in the direction of rotation. Press it flat.",
               camera=dict(dir=[0.35, 1.0, 0.2], close=True))
    s.prop(table)
    s._shot(0.0, np.array([ax, wy, az]) + TBL, radius=200, kind="overview", preferred=(0.35, 1.0, 0.2))
    s._shot(s.t, np.array([ax, wy, az]) + TBL, radius=110, kind="detail", preferred=(0.3, 1.0, 0.15))
    s.sticker("rotation-arrow", "rotation-arrow.png", (ax, wy + 0.15, az), (0, 1, 0), (0, 0, 1), ARROW_STICKER["w"], ARROW_STICKER["h"],
              attach="Motor Mounting Bracket", dur=2.0)
    s._shot(s.t, np.array([ax, wy, az]) + TBL, radius=160, kind="result", preferred=(0.35, 1.0, 0.25))
    s.flag("Rotation arrow sticker: artwork extracted from the Marks&Arrow photograph (extract_labels.py); size 26 x 77 mm and position "
           "(x -112.7, z -2.3 on the bracket web, beside the motor, opposite the cable) measured on that photograph with the four motor bolts as "
           "references (±2 mm); it points in the impeller's rotation sense (counter-clockwise seen from above)")

    s = U.step(phase=3, phaseTitle=P3, title="Tie the motor cable to the bracket tab",
               text="Lay the motor cable from the motor's cable gland along the bracket into the tab of the bracket cut-out. Wrap a small cable tie round the cable and the tab, pull it tight so the cable is held firmly, and cut off the tail of the tie.",
               speech="Lay the motor cable from the motor along the bracket to the tab in the bracket cut-out. Wrap a small cable tie round the cable and the tab, pull it tight, and cut off the tail.",
               camera=dict(dir=[0.15, 1.0, 0.75], close=True))
    s.prop(table)
    bj = bench_jacket(); t0 = s.t
    s.cable("motor cable", bj, S.STRIP.jacket_od, S.STRIP.jacket_colour, "jacket", "motor cable (outer jacket, nine leads inside)",
            grow=[round(t0, 3), round(t0 + 1.6, 3)], rigid=True, attach=dict(node=U.ids["Motor Mounting Bracket"], t=0.0, base=[0.0, 0.0, 0.0]))
    s._shot(t0, TAB + TBL, radius=95, kind="detail", preferred=(0.2, 1.0, 0.6))
    s.t = t0 + 1.9
    tab_pts = [TAB + (-4.0, 4.5, -2.5), TAB + (-4.0, 4.5, 2.5), TAB + (4.0, 4.5, -3.5), TAB + (4.0, 4.5, 3.5)]   # tab section (web plane)
    s.ziptie([TAB], [S.STRIP.jacket_od / 2], tangent=(1, 0, 0), up=(0, 1, 0), extra=tab_pts, label="cable tie: motor cable to the bracket tab",
             attach="Motor Mounting Bracket", head_dir=(0, -1, 0))
    s._shot(s.t, TAB + TBL, radius=150, kind="result", preferred=(0.25, 1.0, 0.7))
    s.flag("Motor cable tie at the bracket tab as in the ZipTie and ElectricalConnection photographs and the work instruction (\"use small tie strap "
           "to secure wire to tab on bracket and cut end of tie strap off\"); tie size not specified — generic 2.5 mm nylon tie")
    U.bench_end()

    s = U.step(phase=3, phaseTitle=P3, title="Install the motor assembly in the unit",
               text="Press the four clip nuts onto the two impeller bracket supports. Lift the motor assembly from the worktable and lower it straight down through the filter base opening, impeller first, until the bracket ends rest on the supports over the clip nuts. " + CLIP_CHECK,
               speech="Press four clip nuts onto the bracket supports. Then lift the motor assembly from the worktable and lower it straight down through the filter base opening until the bracket rests on the supports. " + CLIP_CHECK_SPEECH,
               camera=dict(dir=[0.85, 1.0, 0.75], xray=True))
    s.prop(table)
    for n in brk_clips:
        s.fastener(n, "clip", dur=0.8, **clip_dir(U, n))
    s.wait(0.8)
    path, tilt = choose_place(U, bench, [([TBL, TBL + (0, 470, 0), (0, 470, 0)], None), ([TBL, TBL + (0, 520, 0), (0, 520, 0)], None),
                                         ([TBL, TBL + (0, 470, 0), (0, 470, 0), (0, 30, 0)], None)], allow=set(brk_clips))
    s.place(bench, path=path, tilt=tilt, dur=4.2, label="motor assembly lifted from the worktable into the unit",
            final_allow=set(brk_clips) | {"Filter Base", "Impeller Bracket Support", "Impeller Bracket Support (1)"})
    s.hw(brk_clips, "impeller bracket supports, 4 positions")
    s.focus = bench + brk_clips

    # v2.3 order (engineering): the motor cable is routed before the bracket is fastened
    route, loop, k_tab = jacket_paths()
    Lr = float(np.sum(np.linalg.norm(np.diff(np.asarray(route), axis=0), axis=1)))
    L_tab = float(np.sum(np.linalg.norm(np.diff(np.asarray(route[:k_tab + 1]), axis=0), axis=1)))
    s = U.step(phase=3, phaseTitle=P3, title="Route the motor cable through the L-connector",
               text="From the bracket tab, feed the motor cable (black outer jacket with the nine motor leads inside) down to the L-connector, through its bore and elbow and out of the sealing nut below it, and lay the cable end out behind the unit. Then hand-tighten the sealing nut around the cable.",
               speech="From the bracket tab, feed the motor cable down to the L-connector, through its elbow and out of the sealing nut, and lay the cable end out behind the unit. Then hand-tighten the sealing nut around the cable.",
               camera=dict(dir=[-0.75, 0.45, 0.75], xray=True))
    t0 = s.t; dur = (Lr - L_tab) / S.CABLE.feed_mm_per_s
    s.cable("motor cable", route, S.STRIP.jacket_od, S.STRIP.jacket_colour, "jacket", "motor cable (outer jacket, nine leads inside)",
            grow=[round(t0, 3), round(t0 + dur, 3)], growFrom=round(L_tab / Lr, 4))
    s._shot(t0, (-330, 70, 0), radius=110, kind="wide", axis=(1, 0, 0))
    s._shot(t0 + dur * 0.25, (-385, 30, 0), radius=85, kind="detail", axis=(0, 1, 0))
    s._shot(t0 + dur * 0.6, (-470, -40, 0), radius=190, kind="wide", axis=(1, 0, 0))
    s.t = t0 + dur + 0.3
    check_path(s, "routed", route, S.STRIP.jacket_od / 2 - 0.25, _jacket_allow)
    s._carried("NPTA12_sealing_nut"); s.drive_with_hand("NPTA12_sealing_nut", turns=1, dur=1.0)
    s.focus = ["Impeller Drive Motor"] + L_PARTS
    s.flag(f"Motor cable: outer jacket Ø{S.STRIP.jacket_od:.0f} mm assumed (contains the nine Ø1.6 mm leads with a 1 mm wall; cable type not "
           "specified); routing from the motor's lead exit over the bracket tab to the L-connector as in the ElectricalConnection photograph, "
           "collision-checked; the cable end is laid out behind the unit for its preparation")

    s = U.step(phase=3, phaseTitle=P3, title="Fasten the motor mounting bracket",
               text="Insert the four hex flange bolts through the bracket into the clip nuts and tighten each one with the drill, a 3/8 in socket and an extension.",
               speech="Insert the four hex flange bolts through the bracket into the clip nuts, and tighten each one with the drill and an extension.",
               camera=dict(dir=[0.8, 1.0, 0.55], xray=True))
    for n in brk_bolts: s.fastener(n, "bolt", dur=0.9)
    s.drill(brk_bolts, extension=S.DRILL.extension_mm)
    s.hw(brk_bolts, "bracket ends, into the clip nuts")
    s.flag(f"The drill reaches the bolt next to the front wall only with a socket extension (about {S.DRILL.extension_mm / 25.4:.0f} in): "
           "not in the supplied tools — a generic bar is shown (labelled)")

    # ---- motor cable end: hood, jacket and insulation stripped, pairs twisted (work position behind the unit)
    HOOD = CX.HOOD["name"]
    s = U.step(phase=3, phaseTitle=P3, title="Fit the connector hood on the cable and strip the outer jacket",
               text="Slide the connector hood, cable gland first, onto the motor cable from its end and push it up the cable out of the way. Then cut the black outer jacket around and pull it off the last 60 mm, exposing the nine motor leads.",
               speech="Slide the connector hood onto the motor cable from its end, gland first, and push it up the cable out of the way. Then cut the outer jacket around and pull it off the last sixty millimetres, exposing the nine motor leads.",
               camera=dict(dir=[-0.85, 0.25, 0.6]))
    s.stage([HOOD], offset=HOOD_PARK, approach=HOOD_START - HOOD_PARK, dur=2.4, label="connector hood threaded onto the cable")
    s.kit([HOOD], (-720.0, -60.0, 120.0))
    t_trim = s.t + 0.3
    s.cable("motor cable", route, S.STRIP.jacket_od, S.STRIP.jacket_colour, "jacket", "motor cable (outer jacket, nine leads inside)",
            trim=[[0.0, 0.0], [round(t_trim, 3), 0.0], [round(t_trim + 1.4, 3), S.STRIP.conductor_len]])
    s._shot(t_trim, J_WORK - (0, 30, 0), radius=70, kind="detail", axis=(1, 0, 0))
    rest = lead_rest()
    s.leads_begin({k: dict(colour=LEAD_COLOUR[k], points=rest[k], label=f"{k} lead", stagger=0.0,
                           extra=dict(show=round(t_trim + 0.1, 3), follow=55.0)) for k in LEAD_COLOUR})
    s.t = t_trim + 1.8
    s.leads_fx()
    s.focus = [HOOD]
    s.flag("Connector hood: APPROXIMATE model (connector_cover_approx.step, reconstructed from a photograph with assumed dimensions), scaled to "
           "enclose the CSHM 06 insert and to the photographed size, as instructed by engineering — replace with the manufacturer's hood")
    s.flag(f"Outer jacket strip length {S.STRIP.conductor_len:.0f} mm chosen so the leads reach the insert inside the hood (not specified)")

    s = U.step(phase=3, phaseTitle=P3, title="Strip the motor leads and twist the winding pairs",
               text="Strip the insulation from each of the nine leads, at least 0.50 in (1/2 in) of bare conductor. Then lay the winding leads together in pairs for 230/3/60 — Black with Grey, Red with Blue, Orange with Brown — and twist the bare conductors of each pair together.",
               speech="Strip the insulation from each of the nine leads, leaving at least half an inch of bare conductor. Then lay the winding leads together in pairs, black with grey, red with blue, orange with brown, and twist the bare conductors of each pair together.",
               camera=dict(dir=[-0.85, 0.2, 0.55], close=True))
    s.leads_reset_time()
    t0 = s.t
    s._shot(t0, J_WORK - (0, 55, 0), radius=48, kind="detail", axis=(1, 0, 0))
    order = ["White 5", "White 6", "GND", "Black", "Grey", "Red", "Blue", "Orange", "Brown"]
    for i, k in enumerate(order):
        U.leads[k]["extra"]["core"] = dict(show=round(t0 + 0.3 + 0.45 * i, 3), length=S.STRIP.strip_len, d=S.STRIP.core_d,
                                           colour=S.STRIP.core_colour, slide=S.STRIP.slug_slide)
    t1 = t0 + 0.3 + 0.45 * len(order) + 0.6
    tip_w = rest["White 5"][-1]; dn = np.array([0, -1.0, 0])
    s.dims([dict(a=tip_w, b=tip_w + dn * S.STRIP.strip_len, line=tip_w + (-7.0, 0, 0), normal=(-1, 0, 0), up=(0, 1, 0), text="0.50 in min")],
           t0 + 0.6 + 0.45 * 0, t1 + 0.6)
    # pairs side by side (the second lead comes next to the first), then the bare conductors twisted
    pair_off = {}
    for a_, b_ in SPLICES:
        side = np.array([0, 0, S.CABLE.od + 0.1])
        tgt_b = rest[a_][-1] + side
        pair_off[b_] = tgt_b - rest[b_][-1]; pair_off[a_] = np.zeros(3)
        s.lead_keys(b_, [(t1, np.zeros(3)), (t1 + 1.0, pair_off[b_])])
        c = side / 2
        U.leads[a_]["extra"]["twist"] = dict(t=[round(t1 + 1.2, 3), round(t1 + 2.6, 3)], c=list(c), turns=S.STRIP.twist_turns)
        U.leads[b_]["extra"]["twist"] = dict(t=[round(t1 + 1.2, 3), round(t1 + 2.6, 3)], c=list(-c), turns=S.STRIP.twist_turns)
    s._shot(t1 + 0.4, J_WORK - (0, 62, 0), radius=40, kind="detail", axis=(1, 0, 0))
    s.t = t1 + 3.0
    s.leads_fx()
    s.flag("Stripped length: 0.50 in is the MINIMUM given by engineering (shown with the dimension); follow the terminal manufacturer's "
           "strip length where it is longer. Stripping tool not supplied: the insulation is shown pulled off by hand")
    s.flag("Pair conductors twisted before they go into one splice (twin entry) — electrically appropriate for a crimp splice; the work "
           "instruction does not give the twist (engineering request) — confirm with the splice manufacturer's instructions")

    s = U.step(phase=3, phaseTitle=P3, title="Crimp ferrules and splices on the motor leads",
               text="Slide a wire-end ferrule onto the GND lead and onto each white thermal-switch lead and crimp it with the crimping pliers. Slide one splice over each twisted pair (Black + Grey, Red + Blue, Orange + Brown) and crimp it. Pull each crimp gently to check it holds.",
               speech="Slide a ferrule onto the ground lead and onto each white lead and crimp it. Slide one splice over each twisted pair, black and grey, red and blue, orange and brown, and crimp it. Pull each crimp gently to check it holds.",
               camera=dict(dir=[-0.9, 0.3, 0.6]))
    s.leads_reset_time()
    ring = crimp_ring()
    work = {}
    for k, pos in ring.items():
        if k in SINGLES: work[k] = pos - rest[k][-1]
    for a_, b_ in SPLICES:
        work[a_] = ring[a_] - rest[a_][-1]; work[b_] = work[a_] + pair_off[b_]
    for k in LEAD_COLOUR: s.lead_keys(k, [(s.t, pair_off.get(k, np.zeros(3))), (s.t + 1.0, work[k])])
    s.t += 1.2
    s.crimp(list(SINGLES) + [a for a, _ in SPLICES], work, splices={a: np.array([0, 0, (S.CABLE.od + 0.1) / 2]) for a, _ in SPLICES},
            hints=((-1, 0, 0), (0, 0, 1), (0, 0, -1), (1, 0, 0)))
    for k in LEAD_COLOUR: s.lead_keys(k, [(s.t, work[k]), (s.t + 0.8, pair_off.get(k, np.zeros(3)))])
    s.t += 1.0
    s.check_leads("crimped, at the cable end", offsets={k: pair_off.get(k, np.zeros(3)) for k in LEAD_COLOUR})
    s.leads_fx()
    s.flag("Ferrule type and size are not specified: a generic 0.34 mm² (22 AWG) sleeve as long as the 0.50 in strip is shown; crimper die nest chosen by size")
    s.flag(f"Splice type and size are not specified (engineering: paired leads joined by splice): a generic uninsulated crimp splice for "
           f"2 × 22 AWG ({S.SPLICE.length:.1f} mm, Ø{S.SPLICE.od} mm) over the twisted pair is shown, crimped with the same pliers; its crimped "
           "end is pushed into the terminal like a ferrule — confirm the splice part and whether a jumper lead runs from the splice to the terminal")

    s = U.step(phase=3, phaseTitle=P3, title="Wire the impeller connector insert",
               text="Hold the connector insert below the cable end, wire side up. Press the release of each terminal and push the ends fully in: the Black + Grey splice to terminal 1, Red + Blue to 2, Orange + Brown to 3, the white leads to 5 and 6 and GND to the PE terminal. Terminal 4 stays empty (230/3/60). Release and pull each lead gently to check it is held.",
               speech="Hold the connector insert below the cable end, wire side up. Push the black and grey splice into terminal one, red and blue into two, orange and brown into three, the white leads into five and six, and ground into P E. Terminal four stays empty. Pull each lead gently to check it is held.",
               camera=dict(dir=[-0.9, 0.35, 0.55], callout="outside"))
    s.leads_reset_time()
    s.stage([CONNECTOR], offset=T_W, approach=(-60, -70, 0), dur=1.4, label="connector insert to its work position")
    s.kit([CONNECTOR], (-720.0, -200.0, 120.0))
    for grp in [(a, b) for a, b in SPLICES] + [(k,) for k in ("White 5", "White 6", "GND")]:
        t = s.t
        for k in grp:
            tgt = _cavity(TERMINATED[k]) + T_W + _pair_offset(k) - rest[k][-1]
            w0 = U.leads[k]["end"][-1][1:4]
            s.lead_keys(k, [(t, w0), (t + 0.9, tgt + np.array([0, 14.0, 0])), (t + 1.6, tgt)])
        s._shot(t + 0.2, _cavity(TERMINATED[grp[0]]) + T_W, radius=62, kind="detail", axis=(0, 1, 0))
        s.t = t + 1.9
    s.leads_fx()
    s.hw([CONNECTOR], "in the connector hood at the cable end (motor leads)")
    s.focus = [CONNECTOR]
    s.flag("CSHM 06 connector insert (ILME, supplied model, one solid): contact numbering (1-2-3 / 4-5-6 rows), the PE terminal position "
           "and the SQUICH push-release spring terminals are assumptions accepted by engineering — the model has no markings")
    s.flag("PENDING: the separate-body connector model (Electrical_Connector_cshm_06) was not supplied — the connector locking animation "
           "is not shown (the supplied cshm_06.stp is a single solid)")
    s.flag("Wiring per the 230/3/60 diagram of the supplied drawing (supply variant confirmed by engineering): Black+Grey → 1, Red+Blue → 2, "
           "Orange+Brown → 3 (spliced pairs), 4 not used, White → 5, White → 6, GND → PE")

    s = U.step(phase=3, phaseTitle=P3, title="Fit the connector hood over the insert",
               text="Slide the connector hood down the cable over the wired insert until the insert sits fully in the hood, leads inside, then tighten the hood's cable gland on the jacket.",
               speech="Slide the connector hood down the cable over the wired insert until the insert sits fully in the hood, then tighten the cable gland on the jacket.",
               camera=dict(dir=[-0.85, 0.2, 0.6]))
    s.leads_reset_time()
    s.stage([HOOD], offset=T_W, approach=HOOD_PARK - T_W, dur=2.2, label="connector hood down over the insert", allow={CONNECTOR})
    s.leads_fx()
    s.hw([HOOD], "over the connector insert, on the cable end")
    s.flag("Insert fixing screws in the hood and the gland's tightening torque are not in the supplied data (approximate hood model)")

    # ---------------------------------------------------------------- PHASE 4
    s = U.step(phase=4, phaseTitle=P4, title="Install the impeller guard",
               text="Lower the impeller guard onto its seat above the motor bracket and align it with the main body.",
               speech="Lower the impeller guard onto its seat above the motor bracket, and align it with the main body.",
               camera=dict(dir=[0.9, 1.0, 0.7], xray=True))
    s.place(["Impeller Guard"], path=[(0, 420, 0)], dur=2.4)
    s.flag("The CAD has no fasteners on the impeller guard (the brief asks for 4 machine screws): fastener type, size and locations require engineering confirmation — not animated")

    # v2.3 (engineering): the inlet bellmouth is first fitted to its mounting plate (worktable, plate turned over, machine
    # screws from the flange side), then the plate assembly goes into the unit and is fastened
    bmg = ["Bellmouth Mounting Plate"] + bm + bm_bolts + bm_nuts
    P_bm = np.array(U.A["Bellmouth Mounting Plate"]["centre"], float)
    TBL_B = np.array([0.0, 123.4, 600.0])
    U.bench_begin(bmg, offset=TBL_B, rot=((1, 0, 0), 180.0), pivot=P_bm)
    s = U.step(phase=4, phaseTitle=P4, title="Assemble the inlet bellmouth on its mounting plate",
               text="On the worktable, lay the bellmouth mounting plate upside down on two supports. Set the inlet bellmouth into it from above, throat down through the plate, flange on the plate. Insert the six machine screws through the flange and the plate, run on the six flange nuts from below and tighten the screws. Check that the bellmouth is centred and seated flat.",
               speech="On the worktable, lay the bellmouth mounting plate upside down on two supports. Set the inlet bellmouth into it from above, throat down through the plate. Insert the six machine screws through the flange and the plate, run on the nuts from below and tighten the screws. Check that the bellmouth is centred and seated flat.",
               camera=dict(dir=[0.7, 1.0, 0.6]))
    s.prop(table + bellmouth_supports(SHROUD_Y + TBL[1], TBL_B, P_bm))
    s.place(["Bellmouth Mounting Plate"], path=[(0, 120, 0)], dur=1.6, label="plate laid upside down on the supports")
    s.place(bm, path=[(0, 150, 0)], dur=1.8, final_allow={"Bellmouth Mounting Plate"}, label="bellmouth set into the plate")
    Rbm = quat_to_mat_(((1, 0, 0), 180.0))
    for n in bm_nuts:                                       # nuts slid in under the plate (as in the unit: radially)
        c = np.asarray(U.bench["A0"][n]["centre"]); r = unit([c[0] + 176.6, 0, c[2]])
        s.place([n], path=[Rbm @ (r * 30 + np.array([0, 0.8, 0])), Rbm @ np.array([0, 0.8, 0])], dur=0.8, final_allow={"Bellmouth Mounting Plate"})
    for n in bm_bolts: s.fastener(n, "bolt", engage=5.0, dur=0.7)
    s.drill(bm_bolts, hints=((1, 0, 0), (0, 0, 1)))
    s.hw(bm + bm_bolts + bm_nuts, "bellmouth flange to mounting plate (on the worktable)")
    s.kit(["Bellmouth Mounting Plate"], (0, -470, 0)); s.kit(bm, (0, -600, 0)); s.kit(bm_bolts, (0, -690, 0)); s.kit(bm_nuts, (0, -380, 0))
    s.flag("Machine screws as instructed by engineering (\"blunt machine screws\" in the work instruction); the CAD models these six fasteners "
           "with a hex flange head (Hex Flange Bolt (7)…(13)), so they are driven with a socket — confirm the screw part")
    U.bench_end()

    s = U.step(phase=4, phaseTitle=P4, title="Install the bellmouth plate assembly",
               text="Turn the plate assembly bellmouth-up, pass it in through the front filter opening and raise it up under the bellmouth support track, bellmouth into the impeller inlet.",
               speech="Turn the plate assembly bellmouth up, pass it in through the front filter opening and raise it up under the bellmouth support track, with the bellmouth into the impeller inlet.",
               camera=dict(dir=[0.9, -0.55, 0.7], xray=True, underside=True))
    s.prop(table)
    opts = [([TBL_B, (480, TBL_B[1], TBL_B[2]), (480, dy, 0), (dx, dy, 0), (dx, 0, 0)], ((1, 0, 0), 180.0)) for dy in (-84, -80, -76, -88) for dx in (-4, -7, -10, -14)]
    path, tilt = choose_place(U, bmg, opts, allow={"Clip Nut (6)", "Clip Nut (7)"}, pivot=P_bm, tilt_rate=1.6)
    s.place(bmg, path=path, tilt=tilt, tilt_rate=1.6, pivot=P_bm, dur=4.4, label="bellmouth plate assembly into the unit",
            final_allow={"Bellmouth Support Track", "Clip Nut (6)", "Clip Nut (7)"} | set(wheel))
    s.focus = bmg

    s = U.step(phase=4, phaseTitle=P4, title="Fasten the bellmouth mounting plate",
               text="Fasten the plate to the support track with the eight self-tapping pan head screws, driven from below.",
               speech="Fasten the plate to the support track with the eight self tapping screws, driven from below.",
               camera=dict(dir=[0.9, -0.6, 0.6], xray=True, underside=True))
    for n in plate_screws:
        s.fastener(n, "screw", dur=0.8)
        s.drive_with_hand(n, turns=5, dur=0.9)
    s.hw(plate_screws, "plate to bellmouth support track")
    s.flag("No supplied tool can reach these screws: the drill body clashes with the filter element track or the walls at all 8 positions "
           "(collision-checked) — a stubby or right-angle screwdriver is required (not supplied); the screws are shown turning in without a tool")
    blocked = []
    for n in plate_screws:
        c = [x for x in s.checks if x["what"] == f"screw {n}" and not x["clear"]]
        if c: blocked.append(n)
    if blocked: s.flag(f"Insertion path of {', '.join(blocked)} passes through the support-track flange in the CAD (no access hole modelled) — confirm")
    only_track = [n for n in plate_screws if "Bellmouth Mounting Plate" not in U.A[n].get("contacts", [])]
    if only_track: s.flag(f"{', '.join(only_track)} touch only the support track in the CAD, not the plate — confirm hole positions")

    # ---------------------------------------------------------------- PHASE 5
    for k, (g, label, sid, part) in enumerate((("StageFilter1_MechanicalFilter", "Stage Filter 1", "sticker-mf55-f001", "Filter Frame Half (1)"),
                                               ("StageFilter2_MechanicalFilter", "Stage Filter 2", "sticker-mf55-f002", "Filter Frame Half (3)"))):
        s = U.step(phase=5, phaseTitle=P5, title=f"Install {label}",
                   text=(f"Apply the {'1st' if k == 0 else '2nd'} stage filter label (Part # MF55-F00{k + 1}) centred on the front face of {label}, arrow pointing up. "
                         + (f"Slide {label} (mechanical filter module) into its track through the front opening, frame edges in the guides, and push it fully home." if k == 0 else
                            f"Slide {label} into the track above Stage Filter 1 through the front opening and push it fully home.")),
                   speech=(f"Apply the {'first' if k == 0 else 'second'} stage filter label, centred on the front, arrow up. Then slide {label} into its track through the front opening and push it fully home."),
                   camera=dict(dir=[1, 0.25, 0.75], highlight="soft"))     # v2.3: labels readable on the active module
        fa = {"Filter Element Track", "Unit Body", "Spring Nut Angle", "Filter Base", "Bellmouth Support Track"}
        path, tilt = choose_place(U, U.group(g), [([(430, dy, 0), (dx, dy, 0)], None) for dy in (0, 3, 6, 9, 12, -3, -6) for dx in (60, 20)])
        # the label is applied with the module at its starting point, then the module slides in (the label moves with it)
        fb = U.A[part]["bbox"]; face_x = fb[3]; yc = (fb[1] + fb[4]) / 2; T0 = np.asarray(path[0], float)
        s._shot(s.t, np.array([face_x, yc, 0]) + T0, radius=95, kind="detail", preferred=(1, 0.15, 0.1))
        for n in U.group(g): s._track(n); s._key(n, 0, T0); s._key(n, s.t + 2.6, T0)
        s.dims(sticker_dims(face_x, fb), s.t, s.t + 2.6, attach=part, ref=None)
        s.sticker(sid, f"{sid}.png", (face_x + 0.25, yc, 0.0), (1, 0, 0), (0, 1, 0), STICKER_W, STICKER_H, attach=part, dur=2.0)
        s.t += 0.6
        s.place(U.group(g), path=path, tilt=tilt, dur=3.0, label=f"{label} module", final_allow=fa)
        s.hw([], "")
        if k == 0:
            s.flag("Filter labels: artwork extracted from the PaperStickersLayers photograph as instructed by engineering (perspective-rectified, "
                   "print kept, paper cleaned — pipeline/unit/extract_stickers.py); size 102 × 34 mm and the centred position measured from that "
                   "photograph (±3 mm) — no drawing values supplied")

    s = U.step(phase=5, phaseTitle=P5, title="Install the access door clip nuts",
               text="Press the two clip nuts onto the upper door flange at the two upper door bolt holes, threaded side facing out (the two lower ones come installed with the main body). " + CLIP_CHECK,
               speech="Press the two clip nuts onto the upper door flange at the two upper bolt holes. The two lower ones are already installed. " + CLIP_CHECK_SPEECH,
               camera=dict(dir=[1, 0.3, 0.55]))
    dup = {"Clip Nut (12)": "Clip Nut (6)", "Clip Nut (5)": "Clip Nut (7)"}     # duplicated in the CAD (flagged)
    for n in door_clips: s.fastener(n, "clip", dur=0.9, allow={dup[n]}, **clip_dir(U, n, prefer=FRONT, allow={dup[n]}))
    s.wait(1.0)
    s.hw(door_clips, "upper door flange, 2 positions")
    s.flag("Clip Nut (12) / (5) overlap Clip Nut (6) / (7) of the main body at the same holes (duplicate in the CAD) — both are shown")
    s.flag("Clip Nut and Clip Nut (1) (lower door flange) are installed with the main body (engineering v2.3): shown from step 1, not animated")

    door_off = np.array([360.0, 0.0, 0.0]); flip = ((0, 1, 0), 180.0)
    s = U.step(phase=5, phaseTitle=P5, title="Apply the door gasket tape and silicone",
               text="Lay the filter cover face down. Apply the 1 in wide rubber gasket tape to its inner face around the filter opening outline — first both long sides, then both short sides butted firmly against them — peeling the liner as you go, and pierce it at the four bolt holes. Then run a continuous bead of black silicone with the caulking gun along the inner edge of the tape and over its corner joints.",
               speech="Lay the filter cover face down. Apply the rubber gasket tape around the filter opening, first both long sides, then both short sides butted firmly against them, peeling the liner as you go, and pierce it at the four bolt holes. Then run a bead of black silicone along the inner edge of the tape and over its corners.",
               camera=dict(dir=[1, 0.6, 0.5]))
    s.stage(door, offset=door_off, tilt=flip, approach=(0, 160, 0), dur=1.6, label="filter cover laid face down")
    Tq = s._group_pose(door, door_off, flip)[:2]
    for k, (p0, p1) in enumerate(door_tape_strips()):
        s.gasket([p0, p1], normal=(-1, 0, 0), attach="Access Door", xform=Tq, label=f"gasket tape {k + 1}", width=S.GASKET.tape_w,
                 thickness=S.GASKET.tape_t, closed=False, shot=(k == 0), dur=1.3)
    inner = door_tape_inner_edge()
    s.bead_path(inner, normal=(-1, 0, 0), dur=5.0, bead_d=S.SEALANT.joint_d, label="black silicone along the tape's inner edge",
                colour=S.SEALANT.gasket, sealant=S.SEALANT.gasket, product="Caulking gun (supplied model) with black silicone sealant (type not specified)",
                attach="Access Door", xform=Tq, corner=4.0, shot=(np.mean(inner, axis=0), 230, (-1, 0, 0)))
    s.kit(door, (880.0, 230.0, 0.0))                     # components view: in front of and above the filter modules (their labels stay visible)
    s.hw(door_rivets, "access door to door frame — already set")
    s.flag("Rubber gasket tape .187 in x 1 in (4.76 x 25.4 mm) per the work instruction (Mistfit 550 230_460.xlsx), applied long sides first, "
           "then short sides butted against them; the CAD door gap is 7.2 mm (thicker than the tape) and the short sides leave only 16 mm of "
           "door beside the opening, so the tape overlaps the opening outline there — confirm the tape position")
    s.flag("Silicone after the tape (engineering): black bead along the tape's inner edge and over the corner joints; silicone product and "
           f"bead size not specified (Ø{S.SEALANT.joint_d:.1f} mm shown); piercing the tape at the bolt holes is in the text only (no tool supplied)")

    s = U.step(phase=5, phaseTitle=P5, title="Install and fasten the filter cover",
               text="Turn the filter cover over and fit it over the filter opening, gasket against the body. Fit a bonded sealed washer on each of the four hex flange bolts, insert them through the access door into the clip nuts and tighten with the drill and a 3/8 in socket.",
               speech="Turn the filter cover over and fit it over the filter opening, gasket against the body. Fit a bonded sealed washer on each of the four door bolts, insert them into the clip nuts, and tighten them with the drill.",
               camera=dict(dir=[1, 0.3, 0.55]))
    s.place(door, path=[door_off, (300, 0, 0), (60, 0, 0)], tilt=flip, tilt_rate=2.2, dur=3.2, label="filter cover over the opening",
            final_allow={"Unit Body", "Spring Nut Angle", "Clip Nut", "Clip Nut (1)", "Clip Nut (6)", "Clip Nut (7)", "Clip Nut (12)", "Clip Nut (5)"})
    pairs = []
    for b in door_bolts:
        w = min(door_washers, key=lambda w: np.linalg.norm(np.asarray(U.A[w]["centre"])[1:] - np.asarray(U.A[b]["centre"])[1:]))
        pairs.append((b, w))
    for b, w in pairs:
        s.fastener(w, "washer", side=FRONT, gap=22, dur=0.7)
        s.fastener(b, "bolt", dur=0.9)
    s.drill(door_bolts, hints=((0, -1, 0), (0, 0, 1)))
    s.hw(door_washers + door_bolts, "access door, 4 positions")
    s.flag("Each Bonded Sealed Washer sits under its bolt head in the CAD, so it is fitted on the bolt first; its Ø5.56 mm bore (smaller than "
           "the Ø6.35 mm bolt) is the bonded rubber sealing lip")

    # ---------------------------------------------------------------- PHASE 6
    s = U.step(phase=6, phaseTitle=P6, title="Apply the front panel decals",
               text="Clean the upper front panel. Apply the AEROEX logo with rule, then MIST-FIT, then MF-550 at the dimensions shown, measured from the top left corner of the front panel, pressing out any air.",
               speech="Clean the upper front panel, then apply the AEROEX logo, the MIST FIT name and the MF five fifty label at the dimensions shown, measured from the top left corner of the front panel.",
               camera=dict(dir=[1, 0.15, 0.0], decals=True))
    s._shot(0.0, (0, 245, 15), radius=205, kind="overview", preferred=(1, 0.15, 0.0))     # the upper front panel and its datum
    for d in ("aeroex-logo", "mist-fit", "mf-550"):
        t = s.t
        s.dims(decal_dims(U, d), t, t + 2.0 + S.DIMS.lead + 0.8, ref=DATUM)
        s.t += S.DIMS.lead
        dd = U.decals[d]; lo = np.array([0, dd["yBottom"], dd["zRight"]]); hi = np.array([0, DATUM[1], DATUM[2]])
        s.decal(d, dur=2.0, frame=((lo + hi) / 2, float(np.linalg.norm(hi - lo)) / 2 + 22))
        s.t += 0.8
    s.flag("Decal positions are measured on the supplied photograph (perspective-rectified, ~0.6 px/mm, ±2 mm ≈ ±0.08 in): the inch "
           "dimensions shown are those measurements, not drawing values — supply the decal drawing to confirm")

    s = U.step(phase=6, phaseTitle=P6, title="Fit the data tag and the back-panel labels",
               text="On the back panel, fit the Aeroex data tag over the two screw holes and fasten it with the two pan head machine screws. Place the motor information sticker under the data tag, then the orange WARNING sticker (left) and the yellow CAUTION sticker (right) under it, pressing out any air.",
               speech="On the back panel, fit the Aeroex data tag over the two screw holes and fasten it with the two screws. Place the motor information sticker under the data tag, then the orange warning sticker on the left and the yellow caution sticker on the right under it.",
               camera=dict(dir=[-1, 0.15, 0.05], highlight="soft"))           # v2.3: tag artwork readable while active
    TAG = CX.DATA_TAG["name"]
    s._shot(0.0, (CX.BACK_FACE_X, 180.0, 0.0), radius=120, kind="overview", preferred=(-1, 0.15, 0.05))
    s.place([TAG], path=[(-70, 0, 0)], dur=1.4, final_allow={"Back Panel"}, label="data tag onto the back panel")
    s.fx.append(dict(type="decal", id="data-tag", file="data-tag.png", centre=[CX.BACK_FACE_X - CX.DATA_TAG["thickness"] - 0.05, CX.DATA_TAG["centre"][1], CX.DATA_TAG["centre"][0]],
                     normal=[-1.0, 0.0, 0.0], up=[0.0, 1.0, 0.0], width=CX.DATA_TAG["width"], height=CX.DATA_TAG["height"], attach=U.ids[TAG], kit=True, keys=[[0, 0, 1]]))
    for n in back_screws: s.fastener(n, "screw", dur=0.8, allow={TAG})
    s.drill(back_screws, af=6.35, depth=1.5, turns=4, hints=((0, -1, 0), (0, 0, 1)))
    s.toolTracks[-1]["bit"] = "placeholder-hex"
    for sid, (zc, yc, w, h) in BACK_LABELS.items():
        s.sticker(sid, f"{sid}.png", (CX.BACK_FACE_X - 0.25, yc, zc), (-1, 0, 0), (0, 1, 0), w, h, attach="Back Panel", dur=1.6)
    s.hw([TAG] + back_screws, "back panel, above the cable entry")
    s.focus = [TAG] + back_screws
    s.flag("Data tag, motor information sticker, WARNING and CAUTION stickers: artwork extracted from the BackSticker photographs "
           "(extract_labels.py; the unit-specific serial number is left blank); sizes and positions measured on those photographs with the back "
           "panel rivets and the two screws as references (±1.5 mm) — supply the label drawings to confirm")
    s.flag("Data tag fixing: the CAD's two back panel pan head machine screws (10)/(11) sit exactly at the tag ends in the photographs, so they "
           "fix the tag (the work instruction says \"rivet data tag to unit\" — confirm screws or rivets); tag thickness 0.8 mm assumed "
           "(the CAD screw heads seat on the panel, 0.8 mm into the tag)")
    s.flag(NO_BIT)

    # v2.3 (engineering): the bracket holes are tapped on the worktable, NOT on the main body; then the brackets are fitted
    TBL_Y = SHROUD_Y + TBL[1]                                                # worktable top
    s = U.step(phase=6, phaseTitle=P6, title="Tap the filter clamp bolt brackets",
               text="On the worktable, lay each filter clamp bolt bracket with its leg flat, screw holes up. Tap the two screw holes of each bracket with the drill and the tap, keeping the tap square to the leg, then reverse it out. Blow the chips off the prepared threads.",
               speech="On the worktable, lay each filter clamp bolt bracket with its leg flat, screw holes up. Tap the two holes of each bracket with the drill and the tap, keeping the tap square, then reverse it out.",
               camera=dict(dir=[0.5, 1.0, 0.65]))
    s.prop(table)
    brk_place = {}
    for i, b in enumerate(fcb_brackets):
        scr = [n for n in fcb_screws if b in U.A[n].get("contacts", [])]
        a_ = unit(U.A[scr[0]]["axis"]); rot = ((1, 0, 0), -90.0 if a_[2] > 0 else 90.0)
        C = np.array(U.A[b]["centre"], float)
        Rb = quat_to_mat_(rot); ext = np.ptp(np.array(U.A[b]["bbox"]).reshape(2, 3), axis=0)
        h = float(np.abs(Rb @ ext)[1])
        O = np.array([-176.6 + (i - 0.5) * 150.0, TBL_Y + h / 2 + 0.5, TBL[2]]) - C
        holes_cad = [(tap_entry(U, n, b), -unit(U.A[n]["axis"])) for n in scr]
        U.bench_begin([b], offset=O, rot=rot, pivot=C)
        tb = C + O - Rb @ C
        s.place([b], path=[(0, 120, 0)], dur=1.2, label=f"{b} laid on the worktable")
        holes = [dict(part=b, entry=Rb @ e + tb, axis=Rb @ ax, depth=d, through=[]) for (e, d), ax in holes_cad]
        s.tap(holes, hints=((0, 0, 1), (1, 0, 0), (0, 0, -1)), diameter=4.09)
        U.bench_end()
        brk_place[b] = (O, rot, C)
    s.kit(fcb_brackets, (0, 420, 0))
    s.flag("Thread tapping per the assumptions confirmed by engineering: bracket holes Ø3.30 mm (tap drill of M4 × 0.7, or #8-32 at high "
           "engagement) tapped for the Ø4.09 mm screw shanks, through the bracket leg — the supplied tap model (M20 × 1.0) is shown resized "
           "radially to Ø4.09 mm; tapped on the worktable before the brackets go on the main body (engineering v2.3)")

    s = U.step(phase=6, phaseTitle=P6, title="Position the filter clamp bolt brackets",
               text="Fit the two tapped filter clamp bolt brackets at the top of the side panels, leg inside the side panel, threaded holes over the side panel holes.",
               speech="Fit the two tapped filter clamp bolt brackets at the top of the side panels, leg inside the side panel, with the threaded holes over the side panel holes.",
               camera=dict(dir=[0.6, 0.7, 1.0]))
    s.prop(table)
    for b in fcb_brackets:
        O, rot, C = brk_place[b]; zs = 1 if U.A[b]["centre"][2] > 0 else -1
        opts = [([O, O + (0, 420, 0), (0, 420, 0), (0, 140, 0)], rot), ([O, O + (0, 420, 0), (0, 420, zs * 40), (0, 140, zs * 40), (0, 0, zs * 40)], rot)]
        path, tilt = choose_place(U, [b], opts, pivot=C, tilt_rate=1.4)
        s.place([b], path=path, tilt=tilt, tilt_rate=1.4, pivot=C, dur=2.6, final_allow={"Unit Body"})
    s.hw(fcb_brackets, "top of the side panels")
    s.flag("Left side wall: the clearance holes of Pan Head Machine Screw (8) / (9) are about 0.5 mm off the screw axes in the CAD — confirm the hole positions")

    s = U.step(phase=6, phaseTitle=P6, title="Fasten the filter clamp bolt brackets",
               text="Fasten each bracket with two pan head machine screws through the side panel. Insert the two clamp bolts from below the bracket flange and run on their hex nuts; hold each bolt head with the wrench and tighten its nut with the drill and the 9/16 in deep socket over the bolt.",
               speech="Fasten each bracket with two pan head screws. Insert the clamp bolts from below the bracket flange and run on their nuts. Hold each bolt head with the wrench and tighten the nut with the drill.",
               camera=dict(dir=[0.6, 0.7, 1.0]))
    for n in fcb_screws: s.fastener(n, "screw", dur=0.7)
    s.drill(fcb_screws, af=6.35, depth=1.5, turns=4, hints=((0, -1, 0), (1, 0, 0)))
    s.toolTracks[-1]["bit"] = "placeholder-hex"
    for n in ("Filter Clamp Hex Bolt", "Filter Clamp Hex Bolt (1)"):
        s.fastener(n, "bolt", engage=0.0, gap=30, dur=1.0, allow={"Filter Clamp Bolt Bracket", "Filter Clamp Bolt Bracket (1)"})
    for n in ("Hex Nut", "Hex Nut (1)"):
        s.fastener(n, "nut", side=TOP, gap=28, engage=4.0)
    for bolt, nut in (("Filter Clamp Hex Bolt", "Hex Nut (1)"), ("Filter Clamp Hex Bolt (1)", "Hex Nut")):
        s.wrench(bolt, side=(0, -1, 0), bolt=True, hold=True, approach="handle", hints=((0, 0, -1), (0, 0, 1), (1, 0, 0), (-1, 0, 0)))
        s.drill([nut])
        s.release_wrench()
    s.hw(fcb_screws + ["Filter Clamp Hex Bolt", "Filter Clamp Hex Bolt (1)", "Hex Nut", "Hex Nut (1)"], "filter clamp bolt brackets")
    s.flag(NO_BIT)

    # ---------------------------------------------------------------- PHASE 7
    s = U.step(phase=7, phaseTitle=P7, title="Coil the motor cable and secure it with two cable ties",
               text="Bring the wired connector to the lower left of the back panel and coil the spare motor cable on the back panel in two turns as shown. Tie the turns together with two cable ties — one just below the L-connector, one on the right of the coil — pull them tight and cut the tails.",
               speech="Bring the wired connector to the lower left of the back panel and coil the spare motor cable in two turns. Tie the turns together with two cable ties, one just below the L-connector and one on the right of the coil, pull them tight and cut the tails.",
               camera=dict(dir=[-1, 0.2, 0.25]))
    s.leads_reset_time()
    t0 = s.t; D = 3.6
    s.place([HOOD, CONNECTOR], path=[T_W], dur=D, label="wired connector to the lower left of the back panel", final_allow={"Back Panel"})
    s.cable("motor cable", route, S.STRIP.jacket_od, S.STRIP.jacket_colour, "jacket", "motor cable (outer jacket, nine leads inside)",
            trim=[[0.0, S.STRIP.conductor_len]], morph=dict(points=[list(map(float, p)) for p in loop], t=[round(t0, 3), round(t0 + D, 3)]))
    for k in LEAD_COLOUR:
        U.leads[k]["extra"]["base"] = [[round(t0, 3), 0.0, 0.0, 0.0], [round(t0 + D, 3), *map(float, -T_W)]]
    s.leads_fx()
    s._shot(t0, (CX.BACK_FACE_X - 40, -60.0, 40.0), radius=170, kind="wide", preferred=(-1, 0.2, 0.25))
    s.t = t0 + D + 0.4
    check_path(s, "coiled on the back panel", loop, S.STRIP.jacket_od / 2 - 0.25, _jacket_allow)
    for tie, lab in ((TIE1, "cable tie 1: below the L-connector"), (TIE2, "cable tie 2: right of the coil")):
        cs, tg = strands_at(loop, _panel(tie))
        s.ziptie(cs, [S.STRIP.jacket_od / 2] * len(cs), tangent=tg, up=(-1, 0, 0), label=lab, head_dir=(-1, 0, 0),
                 shot=(70, (-1, 0.2, 0.1)))
    s.hw([HOOD, CONNECTOR], "cable end, lower left of the back panel")
    s.focus = [HOOD]
    s.flag("Cable coil (two turns), the two cable tie positions and the connector position measured on the CableDisposition photographs "
           "(rectified on the back panel, ±5 mm); tie size not specified — generic 2.5 mm nylon ties")
    s.flag("The mating supply-side connector housing (with the locking lever) is not in the supplied data: the connection to the supply and "
           "the lock are not animated (separate-body connector model pending)")

    gauge = "Pressure Gauge"; GZ, GY = -138.478, -32.499
    s = U.step(phase=7, phaseTitle=P7, title="Tap the gauge mounting hole",
               text="Through the front of the gauge box, tap the gauge mounting hole in the gauge mounting panel with the drill and the tap for the gauge's thread, keeping the tap square to the panel, then reverse it out and clear the chips.",
               speech="Through the front of the gauge box, tap the gauge mounting hole with the drill and the tap, keeping the tap square to the panel. Then reverse it out and clear the chips.",
               camera=dict(dir=[0.9, 0.25, -0.9]))
    s.tap([dict(part="Gauge Mounting Panel", entry=np.array([-38.74, GY, GZ]), axis=np.array([-1.0, 0.0, 0.0]), depth=0.91, through=[])],
          hints=((0, 1, 0), (0, 0, -1), (0, -1, 0)), diameter=13.5)
    s.focus = ["Gauge Mounting Panel"]
    s.flag("Gauge thread not specified: measured gauge stem Ø13.5 mm and mounting hole Ø11.1 mm (7/16 in — the tap drill of a 1/4-18 NPT "
           "thread) — the supplied tap model is shown resized to Ø13.5 mm; confirm the thread and tap")

    s = U.step(phase=7, phaseTitle=P7, title="Install the pressure gauge and its box cover",
               text="Fit the pressure gauge into the tapped gauge mounting hole from the front. Through the side opening of the gauge box, put the wrench on the flats of the gauge stem and tighten the gauge, dial upright. Then fit the gauge box cover over the side opening and fasten it with its two pan head machine screws.",
               speech="Fit the pressure gauge into the tapped hole from the front. Through the side opening of the gauge box, tighten it with the wrench on the flats of its stem, dial upright. Then fit the gauge box cover and fasten it with its two screws.",
               camera=dict(dir=[0.9, 0.25, -0.9]))
    U.A[gauge].update(axis=[1.0, 0.0, 0.0], head=[-26.0, GY, GZ], tip=[-38.0, GY, GZ], length=12.0, across_flats=[13.56], contacts=["Gauge Mounting Panel", "Gauge Box Enclosure", "Unit Body"])
    TOT = 90.0
    tr = s._track(gauge, axis=(1, 0, 0), pivot=(0.0, GY, GZ))
    s._key(gauge, 0, (140, 0, 0), ang=math.radians(TOT)); s._key(gauge, s.t, (140, 0, 0), ang=math.radians(TOT))
    s._shot(s.t, (-10, GY, GZ), radius=90, kind="wide", axis=(1, 0, 0))
    s._key(gauge, s.t + 1.8, (0, 0, 0), ang=math.radians(TOT), ease=1)
    s._check("place Pressure Gauge", s.u.world.mesh[gauge], [delta_matrix((140 * (1 - u), 0, 0), ID_Q, (0, GY, GZ), (1, 0, 0), math.radians(TOT)) for u in np.linspace(0, 1, 30)],
             final_allow={"Gauge Mounting Panel", "Gauge Box Enclosure", "Unit Body"}, n_final=6)
    s.t += 1.8; s._install([gauge])
    s.wrench(gauge, side=(1, 0, 0), total_deg=TOT, swing_deg=45, approach="handle", centre=(-32.0, GY, GZ),
             hints=((0, 0, -1), (0, -1, 0), (0, 1, 0)))
    s.place(["Gauge Box Cover"], path=[(0, 0, -120)], dur=1.6, final_allow={"Unit Body", "Gauge Box Enclosure"})
    for n in gauge_screws: s.fastener(n, "screw", dur=0.8)
    s.drill(gauge_screws, af=6.35, depth=1.5, turns=4, hints=((0, -1, 0), (1, 0, 0)))
    s.toolTracks[-1]["bit"] = "placeholder-hex"
    s.hw(["Gauge Box Cover"] + gauge_screws, "gauge box side opening")
    s.flag("Gauge tubing / pressure connection is not in the CAD — engineering confirmation; the gauge is turned 90° by its stem flats "
           "(13.6 mm across, measured) to finish dial-upright — tightening torque not specified"); s.flag(NO_BIT)
    s.flag("v2.3 (engineering): gauge installation moved before the electrical verification, right after the cable is secured")

    s = U.step(phase=7, phaseTitle=P7, title="Electrical system verification",
               text="Carry out the approved electrical test procedure. After the safety checks, run the motor briefly and confirm the impeller turns freely in the direction of the arrow (counter-clockwise seen from above) and the air is drawn in through the inlet below the impeller and moves up through the unit. Listen carefully while the impeller runs: it should rotate smoothly without abnormal friction or rubbing noise.",
               speech="Carry out the approved electrical test procedure. After the safety checks, run the motor briefly and confirm the impeller turns freely in the direction of the arrow, counter-clockwise seen from above, and the air is drawn in below the impeller and moves up through the unit. Listen carefully while it runs: it should turn smoothly, without any rubbing or friction noise.",
               camera=dict(dir=[0.9, 0.9, 0.7], xray=True))
    s.meta["check"] = dict(icon="listen", text="Listen while the impeller runs: smooth rotation, no abnormal friction or rubbing noise.")
    mp = U.A["Impeller Drive Motor"]["centre"]
    s._shot(s.t + 2.6, (mp[0], 20.0, mp[2]), radius=330, kind="wide")     # the whole air path, filters to the top
    s.spin(wheel, pivot=(mp[0], 0, mp[2]), axis=(0, 1, 0), turns=14, dur=6.0,
           arrow=dict(centre=(mp[0], -40.0, mp[2]), radius=150.0),
           airflow=dict(paths=airflow_paths(mp), allow=AIR_POROUS | set(wheel)))
    s.focus = wheel + ["Impeller Drive Motor"]
    s.flag("Impeller rotation: backward-curved centrifugal wheel (8 blades, tips trailing) — it turns counter-clockwise seen from above "
           "(positive about the vertical axis), the sense that gives its rated flow. Air enters from below through the stage filters and the "
           "inlet bellmouth into the eye, leaves the wheel radially and rises around the motor through the impeller guard to the Fibre Bed "
           "Filter (engineering: the air must flow up). Confirm against the motor's direction arrow; no test procedure, current or "
           "acceptance criteria were supplied")

    # ---------------------------------------------------------------- PHASE 8
    s = U.step(phase=8, phaseTitle=P8, title="Install the Fibre Bed Filter",
               text="Lower the Fibre Bed Filter module, gasket down, into the top compartment and seat it evenly on the filter base.",
               speech="Lower the fibre bed filter, gasket down, into the top compartment and seat it evenly on the filter base.",
               camera=dict(dir=[0.9, 1.0, 0.8]))
    s.place(U.group("HepaFilter"), path=[(0, 460, 0)], dur=3.0, label="Fibre Bed Filter module", final_allow={"Filter Base", "Unit Body"})

    # ---------------------------------------------------------------- PHASE 9
    s = U.step(phase=9, phaseTitle=P9, title="Install the filter clamp",
               text="Place the filter clamp across the Fibre Bed Filter over the two clamp bolts and screw down both knobs by hand to compress the filter gasket evenly.",
               speech="Place the filter clamp across the fibre bed filter over the two clamp bolts, and screw both knobs down by hand to compress the gasket evenly.",
               camera=dict(dir=[0.8, 1.0, 0.9]))
    s.place(["Filter Clamp"], path=[(0, 200, 0)], dur=1.8, final_allow={"Filter Clamp Hex Bolt", "Filter Clamp Hex Bolt (1)"})
    for n in ("Filter Clamp Knob", "Filter Clamp Knob (1)"):
        s.fastener(n, "nut", side=TOP, gap=30, engage=6.0, hand_turns=1.5, allow={"Filter Clamp Hex Bolt", "Filter Clamp Hex Bolt (1)", "Filter Clamp"})
        s.drive_with_hand(n, turns=3, dur=1.0)
    s.hw(["Filter Clamp Knob", "Filter Clamp Knob (1)"], "clamp bolts, hand-tight")
    s.flag("Clamp knob tightening (gasket compression) is not specified — hand-tight shown")

    s = U.step(phase=9, phaseTitle=P9, title="Rivet the gauge box enclosure",
               text=f"Insert the {len(gauge_rivets)} closed-end rivets (gauge box enclosure to unit body) and set each one with the rivet gun.",
               speech=f"Insert the {len(gauge_rivets)} closed end rivets and set each one with the rivet gun.",
               camera=dict(dir=[0.9, 0.2, -0.8]))
    s.rivet(gauge_rivets)
    s.hw(gauge_rivets, "gauge box enclosure to unit body")
    s.flag("These rivets join main-body parts but sit outside the MAIN BODY group in the CAD; they are riveted here as agreed")

    s = U.step(phase=9, phaseTitle=P9, title="Final assembly overview",
               text="The Mist-Fit 550 is complete. Check that every component, fastener, tightening mark, gasket and label is in place and the filter cover and clamp are secure.",
               speech="The Mist Fit 550 is complete. Check that every component, fastener, tightening mark, gasket and label is in place, and that the filter cover and clamp are secure.",
               camera=dict(dir=[1, 0.5, 0.85], wide=True))
    s.wait(4.0)
    s.focus = list(U.A)
    return U


# --------------------------------------------------------------------------- v2.2 geometry helpers
STICKER_W, STICKER_H = 102.0, 34.0
DATUM = (0.3, 316.8, 189.3)        # top-left corner of the front panel seen from the front (x = 0 face)


def _inch(mm): return f"{mm / 25.4:.2f} in"


def decal_dims(U, did):
    """Vertical: front-panel top edge to the decal's top edge; horizontal: the panel's left edge (z = +189.3) to the
    decal's left edge — the decal's measured position (decals.json)."""
    d = U.decals[did]; x = 0.3
    zl, yt = d["zLeft"], d["yTop"]
    zv = DATUM[2] - 13.0                                  # vertical dimension lines along the left margin
    return [dict(a=(x, DATUM[1], zl), b=(x, yt, zl), line=(x, 0, zv), normal=(1, 0, 0), up=(0, 0, 1), text=_inch(DATUM[1] - yt)),
            dict(a=(x, yt, DATUM[2]), b=(x, yt, zl), line=(x, yt + 4.5, 0), normal=(1, 0, 0), up=(0, 1, 0), text=_inch(DATUM[2] - zl), below=True)]


def sticker_dims(face_x, fb):
    """Same convention on the filter front face (CAD frame, attached to the filter): datum = its top-left corner seen
    from the front."""
    x = face_x + 0.3; top = fb[4]; left = 171.45; zl = STICKER_W / 2; yt = (fb[1] + fb[4]) / 2 + STICKER_H / 2
    return [dict(a=(x, top, zl), b=(x, yt, zl), line=(x, 0, zl + 10), normal=(1, 0, 0), up=(0, 0, 1), text=_inch(top - yt)),
            dict(a=(x, yt, left), b=(x, yt, zl), line=(x, top + 7, 0), normal=(1, 0, 0), up=(0, 1, 0), text=_inch(left - zl))]


def door_tape_strips():
    """Gasket tape strips on the door's back face (x = 7.188), centrelines: the two long (top / bottom) strips across the door,
    then the two short ones between them (filter opening y -259 … -139, z ±173; door y -283.7 … -113.8, z ±188.9)."""
    w = S.GASKET.tape_w; x = 7.188; zf = 188.9 - 1.0
    yt = -139.0 + w / 2; yb = -258.3 - w / 2; zs = zf - w / 2
    return [((x, yt, zf), (x, yt, -zf)), ((x, yb, -zf), (x, yb, zf)),
            ((x, -139.0 - 0.3, zs), (x, -258.3 + 0.3, zs)), ((x, -258.3 + 0.3, -zs), (x, -139.0 - 0.3, -zs))]


def door_tape_inner_edge():
    """Path of the silicone bead along the inner edge of the tape (on the door face, 1.5 mm inside the tape edge)."""
    w = S.GASKET.tape_w; x = 7.188; e = S.SEALANT.joint_d / 2 + 0.3
    y1, y0, z0 = -139.0 - e, -258.3 + e, 188.9 - 1.0 - w + 0.0 - e
    return [np.array(p) for p in ((x, y1, z0), (x, y1, -z0), (x, y0, -z0), (x, y0, z0))]


def door_gasket_rect():
    """Gasket centreline on the access door's back face (x = 7.2): 0.5 mm outside the filter opening of the body
    (y -259 … -139, z ±173, measured by ray casts on the body's front face), section centred 3.6 mm in."""
    s = S.GASKET.section; e = 0.5 + s / 2; x = 7.188
    y0, y1, z0 = -259.0 - e, -139.0 + e, 173.0 + e
    return [np.array(p) for p in ((x, y1, z0), (x, y1, -z0), (x, y0, -z0), (x, y0, z0))]


def tap_entry(U, screw, bracket):
    """Where the tap meets the bracket leg (ray along the screw axis) and the leg thickness (mm)."""
    import trimesh
    from trimesh.ray.ray_triangle import RayMeshIntersector
    p = U.A[screw]; a = unit(p["axis"]); head = np.asarray(p["head"], float)
    m = trimesh.Trimesh(U.world.mesh[bracket].vertices, U.world.mesh[bracket].faces, process=False)
    I = RayMeshIntersector(m)
    hits = []
    for off in ((0, 0), (1.0, 0), (-1.0, 0), (0, 1.0), (0, -1.0)):        # just outside the Ø3.3 hole wall
        u, v = (np.array([1.0, 0, 0]), np.array([0, 1.0, 0])) if abs(a[2]) > 0.5 else (np.array([0, 0, 1.0]), np.array([0, 1.0, 0]))
        o = head + a * 30 + (u * off[0] + v * off[1]) * 2.2
        loc, ri, ti = I.intersects_location([o], [-a], multiple_hits=True)
        if len(loc): hits.append(sorted(float((L - head) @ -a) for L in loc))
    ds = [h for h in hits if len(h) >= 2]
    near, far = (min(h[0] for h in ds), max(h[-1] for h in ds)) if ds else (0.0, 2.0)
    return head - a * near, round(far - near, 2)
