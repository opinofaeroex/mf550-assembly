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


def choose_place(U, names, options, allow=()):
    """First (path, tilt) option whose sampled motion is collision-free; else the least colliding one."""
    from build_unit import Step  # noqa
    import trimesh
    mesh = trimesh.util.concatenate([U.world.mesh[n] for n in names])
    A = U.A
    bb = np.array([A[n]["bbox"] for n in names]); P = (bb[:, :3].min(0) + bb[:, 3:].max(0)) / 2
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
            q = slerp(qs, ID_Q, min(1, s * S.PLACE.tilt_removal_rate)) if tilt else ID_Q
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
CONN_W = np.array([0.0, -45.0, 0.0])   # work position of the insert while it is wired (below its seat)


def _cavity(pin):
    lx, ly = _LOCAL[pin]
    return np.array([ly - 434.7, -104.6, lx - 57.3])     # insulation end, 1 mm above the insert's wire face


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


def lead_paths(U):
    """The nine leads: 3 × 3 bundle from the motor's lead exit (nub on the motor housing facing the back panel)
    through the L-connector bore and elbow, out of the sealing nut, then each lead to its termination
    (contact cavity of the insert at its seat; the two leads of a spliced pair side by side)."""
    E = np.array([-261.08, 89.96, 0.0])                    # centre of the lead-exit face (CAD, Ø20 mm)
    centre = _smooth([E, E + (-14, 0, 0), (-318, 72, 0), (-349, 47.5, 0), (-363, 43.7, 0), (-384, 43.7, 0),
                      (-393.2, 40.8, 0), (-396.1, 32.0, 0), (-396.1, 8.0, 0), (-396.1, -6.0, 0), (-397.5, -30.0, 0)])
    C = np.asarray(centre)
    # parallel-transport frame along the centreline (offsets of the leads in the bundle)
    T = [None] * len(C)
    for i in range(len(C)): T[i] = unit(C[min(i + 1, len(C) - 1)] - C[max(i - 1, 0)])
    n0 = np.array([0.0, 1.0, 0.0]); n0 = unit(n0 - T[0] * (n0 @ T[0])); Nf = [n0]
    for i in range(1, len(C)):
        v = Nf[-1] - T[i] * (Nf[-1] @ T[i]); Nf.append(unit(v))
    Bf = [np.cross(t, n) for t, n in zip(T, Nf)]
    targets = {k: _lead_target(k) for k in LEAD_COLOUR}
    # bundle slots chosen so that the leads fan out to their targets without crossing (sorted by z, then x)
    slots = [(a, b) for a in (-1, 0, 1) for b in (-1, 0, 1)]
    end_frame = (Nf[-1], Bf[-1])
    def slot_pos(sl): return end_frame[0] * sl[0] + end_frame[1] * sl[1]
    order = sorted(LEAD_COLOUR, key=lambda k: (targets[k][2], targets[k][0]))
    slot_order = sorted(slots, key=lambda sl: (float(slot_pos(sl)[2]), float(slot_pos(sl)[0])))
    leads = {}
    for k, sl in zip(order, slot_order):
        off = [Nf[i] * sl[0] * S.CABLE.pitch + Bf[i] * sl[1] * S.CABLE.pitch for i in range(len(C))]
        body = [C[i] + off[i] for i in range(len(C))]
        tgt = targets[k]
        tail = _smooth([body[-1], body[-1] + np.array([0, -14, 0]) + (tgt - body[-1]) * np.array([0.25, 0, 0.25]),
                        tgt + np.array([0, 18, 0]), tgt], step=2.0)
        pts = body[:-1] + tail
        leads[k] = dict(colour=LEAD_COLOUR[k], points=pts, label=f"{k} lead", stagger=0.0)
    for i, k in enumerate(["GND", "White 5", "White 6", "Black", "Grey", "Red", "Blue", "Orange", "Brown"]):
        leads[k]["stagger"] = round(i * S.CABLE.stagger, 3)
    return leads


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


def _lead_allow(P, x, tot):
    al = set()
    if x < 6: al.add("Impeller Drive Motor")                       # leaving the motor's lead exit
    if P[0] < -358 and P[1] > -9: al |= set(L_PARTS) | {"Back Panel"}   # inside the L-connector bore
    return al


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
    door_clips_low = ["Clip Nut", "Clip Nut (1)"]                 # v2.2: animated (were shown with the body)
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
    delivered = back_screws + back_rivets + fb_rivets + leg_rivets
    body_now = [n for n in body if n not in door_clips_low + ["Gauge Box Cover"]]
    door = ["Door Frame", "Access Door"] + door_rivets               # v2.2: door rivets already set (door sub-assembly)

    U.labels.update({"HepaFilter": "Fibre Bed Filter", CONNECTOR: CONNECTOR})
    for w in door_washers: U.labels[w] = "Bonded Sealed Washer"

    P1, P2, P3, P4, P5, P6, P7, P8, P9 = (
        "Main body preparation", "Base hardware and cable entry", "Motor, impeller and motor leads",
        "Impeller protection and bellmouth", "Mechanical filters and filter cover", "Exterior identification and filter clamping",
        "Electrical connections and verification", "Fibre bed filter", "Final assembly")

    # ---------------------------------------------------------------- PHASE 1
    s = U.step(phase=1, phaseTitle=P1, title="Inspect the main body",
               text="Start with the fully assembled, painted main body. Check that every face is closed, no structural part is missing and the paint is complete. All closed-end rivets of the main body and the two back panel screws are already installed.",
               speech="Start with the fully assembled and painted main body. Check that every face is closed, nothing is missing and the paint is complete. All the rivets of the main body and the two back panel screws are already installed.",
               camera=dict(dir=[1, 0.5, 0.85], wide=True))
    s.show(body_now + pre_rivets + delivered)
    s.hw(pre_rivets + back_rivets + fb_rivets + leg_rivets, "main body — installed with the main body")
    s.hw(back_screws, "upper back panel — installed with the main body")
    s.wait(3.5)

    # ---------------------------------------------------------------- PHASE 2
    s = U.step(phase=2, phaseTitle=P2, title="Install the base clip nuts",
               text="From below, push each of the eight clip nuts straight up onto the bottom edge of the base flange at its mounting hole, threaded side facing out, until it snaps into the hole.",
               speech="From below, push each of the eight clip nuts straight up onto the bottom edge of the base flange, one at each mounting hole, until it snaps in.",
               camera=dict(dir=[0.55, -0.75, 0.55], underside=True))
    for k, n in enumerate(sorted(nuts_base, key=lambda n: math.atan2(U.A[n]["centre"][2], U.A[n]["centre"][0] + 189))):
        s.fastener(n, "clip", slide=(0, -1, 0), travel=40.0, dur=1.1 if k < 2 else 0.8)
    s.hw(nuts_base, "base flanges, 8 positions")

    s = U.step(phase=2, phaseTitle=P2, title="Seal and fit the L-connector",
               text="Apply a continuous bead of HT200 sealant around the cable entry hole on the outside of the back panel. Fit the O-ring on the L-connector body, push the body through the hole into the bead with its outlet pointing down, and leave the sealing nut loose on the outlet.",
               speech="Apply a continuous bead of H T two hundred sealant around the cable entry hole on the back panel. Fit the O-ring on the L-connector, push it through the hole into the bead with the outlet pointing down, and leave the sealing nut loose.",
               camera=dict(dir=[-1, 0.35, 0.55]))
    face_x = U.A["Back Panel"]["bbox"][0]
    gc = np.array([face_x, 43.701, 0.0])                             # L-connector thread axis on the panel face
    s.bead(centre=gc, normal=(-1, 0, 0), radius=12.6, bead_d=S.SEALANT.ht200_d, label="HT200 bead", colour=S.SEALANT.ht200,
           sealant=S.SEALANT.ht200, product="Caulking dispenser with WEICON Flex 310 M HT 200 (grey MS-polymer sealant, silicone-free)")
    s.place(["NPTA12_o_ring"], path=[(-60, 0, 0)], dur=1.1, final_allow={"NPTA12_L_body_with_seal", "Back Panel"}, label="O-ring onto the L-connector body")
    s.place(["NPTA12_L_body_with_seal", "NPTA12_sealing_nut"], path=[(-95, 0, 0)], dur=1.6, final_allow={"Back Panel", "NPTA12_o_ring"},
            label="L-connector through the cable entry hole")
    s.hw(["NPTA12_L_body_with_seal", "NPTA12_o_ring", "NPTA12_sealing_nut"], "back panel, cable entry")
    s.flag("HT200 is taken as WEICON Flex 310 M HT 200 (grey, silicone-free MS polymer); bead size not specified — 3 mm shown around the Ø21.4 mm hole")
    s.flag("The L-connector (NPTA12 L body with seal, O-ring, sealing nut, locknut) replaces 1_Cable Strain Relief + 2_Strain Relief Nut "
           "(MF-550-210-B_GROUPED_ASSEMBLY_03); thread designation, sealing range and tightening torque are not in the CAD")

    s = U.step(phase=2, phaseTitle=P2, title="Tighten the L-connector locknut",
               text="From inside the unit, run the locknut onto the L-connector thread by hand until it seats against the back panel, then tighten it with the socket wrench (ratchet) while the L-connector outlet stays pointing down.",
               speech="From inside the unit, run the locknut onto the L-connector thread by hand until it seats. Then tighten it with the socket wrench, keeping the outlet pointing down.",
               camera=dict(dir=[-0.85, 0.45, 0.6], xray=True))
    n = "NPTA12_locknut"
    s.fastener(n, "nut", side=FRONT, gap=30, engage=3.0, hand_turns=2)
    s.drive_with_hand(n, turns=1, dur=0.8)
    s.ratchet(n, side=(1, 0, 0), total_deg=120)
    s.hw([n], "inside the back panel, on the L-connector thread")

    # ---------------------------------------------------------------- PHASE 3 — motor on its bracket (bench)
    # v2.2 order (engineering request): the drive motor is mounted on Motor Mounting Bracket-1 first, on the bench
    # (lock washers, motor bolts, impeller wheel, tightening, marks), then the assembly is lowered into the unit
    # onto the clip nuts of the bracket supports and the bracket is fastened. The inlet bellmouth is not
    # attached to the wheel: it is fitted from below with its mounting plate hardware (Phase 4).
    bm = [n for n in imp if n == "Impeller Inlet Bellmouth"]
    motor_only = [n for n in motor_side if n not in bm]
    bench = ["Motor Mounting Bracket"] + motor_only + wheel + washers + motor_bolts
    U.bench_begin(bench)
    s = U.step(phase=3, phaseTitle=P3, title="Position the drive motor on the motor mounting bracket",
               text="On the bench, set the motor mounting bracket with its four centre holes over the work area. Offer the drive motor up from below, shaft down, until its top face meets the bracket with its four threaded holes aligned with the bracket holes. Hold it in place.",
               speech="On the bench, set out the motor mounting bracket. Offer the drive motor up from below, shaft down, until it meets the bracket with its four threaded holes aligned. Hold it in place.",
               camera=dict(dir=[0.85, 0.35, 0.75]))
    s.place(["Motor Mounting Bracket"], path=[(0, 160, 0)], dur=1.6, label="bracket set out on the bench")
    s.place(motor_only, path=[(0, -150, 0)], dur=2.2, final_allow={"Motor Mounting Bracket"}, label="drive motor up to the bracket")
    s.focus = ["Motor Mounting Bracket"] + motor_only
    KX = S.BENCH.kit_x                                          # components view: the motor kit beside the back panel
    s.kit(["Motor Mounting Bracket"], (KX, 330, 0)); s.kit(motor_only, (KX, 190, 0))

    s = U.step(phase=3, phaseTitle=P3, title="Install the lock washers and motor mounting bolts",
               text="Place an external tooth lock washer over each of the four motor mounting holes in the bracket, then insert the four motor mounting hex bolts through the washers and the bracket and start them by hand into the motor.",
               speech="Place an external tooth lock washer over each of the four motor mounting holes. Then insert the four motor mounting bolts through the washers and the bracket, and start them by hand into the motor.",
               camera=dict(dir=[0.7, 1.0, 0.45], close=True))
    for n in washers: s.fastener(n, "washer", side=TOP, gap=25, dur=0.8)
    for n in motor_bolts: s.fastener(n, "bolt", dur=1.0)
    s.hw(washers, "motor mounting holes, under the bolt heads"); s.hw(motor_bolts, "bracket into the drive motor")
    s.kit(washers, (KX, 385, 0)); s.kit(motor_bolts, (KX, 440, 0))

    s = U.step(phase=3, phaseTitle=P3, title="Install the impeller on the motor shaft",
               text="Slide the impeller up onto the motor shaft from below, inlet facing down, until it seats on the shaft.",
               speech="Slide the impeller up onto the motor shaft from below, with the inlet facing down, until it seats.",
               camera=dict(dir=[0.85, -0.45, 0.7], underside=True))
    s.place(wheel, path=[(0, -95, 0)], dur=1.8, final_allow={"Impeller Drive Motor"}, label="impeller wheel onto the motor shaft")
    s.kit(wheel, (KX, -120, 0))
    s.flag("Motor shaft fit and impeller retention are inside the CAD sub-assembly (no separate shaft hardware modelled)")

    s = U.step(phase=3, phaseTitle=P3, title="Tighten the motor mounting bolts",
               text="Tighten the four motor mounting bolts with the drill and a 10 mm socket until each bolt seats on its lock washer.",
               speech="Tighten the four motor mounting bolts with the drill and a ten millimetre socket until each one seats on its lock washer.",
               camera=dict(dir=[0.7, 1.0, 0.45], close=True))
    s.drill(motor_bolts)
    s.hw(motor_bolts, "bracket into the drive motor")
    s.flag("Tightening torque is not specified in the supplied data — engineering confirmation")

    s = U.step(phase=3, phaseTitle=P3, title="Mark the motor mounting bolts",
               text="After tightening, draw a tightening mark from each bolt head onto the bracket so that any loosening is visible.",
               speech="After tightening, draw a mark from each bolt head onto the bracket, so any loosening can be seen.",
               camera=dict(dir=[0.6, 1.0, 0.5], close=True))
    s.mark(motor_bolts, dir_hint=(1, 0, 0))
    s.hw(motor_bolts, "tightening marks")
    s.flag("No reference photograph for the tightening mark was supplied: a straight line across the head onto the bracket is shown — confirm the marking convention")

    U.bench_end()
    s = U.step(phase=3, phaseTitle=P3, title="Install the motor assembly in the unit",
               text="Press the four clip nuts onto the two impeller bracket supports. Lower the motor assembly straight down through the filter base opening, impeller first, until the bracket ends rest on the supports over the clip nuts.",
               speech="Press four clip nuts onto the bracket supports. Then lower the motor assembly straight down through the filter base opening, impeller first, until the bracket rests on the supports.",
               camera=dict(dir=[0.85, 1.0, 0.6], xray=True))
    for n in brk_clips:
        s.fastener(n, "clip", dur=0.8, **clip_dir(U, n))
    O = np.asarray(S.BENCH.offset)
    path, tilt = choose_place(U, bench, [([O], None), ([O, (0, 40, 0)], None), ([O, (0, 30, 0), (0, 8, 30)], None),
                                         ([O, (0, 30, 0)], ((1, 0, 0), 6)), ([O, (0, 30, 0)], ((0, 0, 1), 6))], allow=set(brk_clips))
    s.place(bench, path=path, tilt=tilt, dur=3.2, label="motor assembly lowered into the unit",
            final_allow=set(brk_clips) | {"Filter Base", "Impeller Bracket Support", "Impeller Bracket Support (1)"})
    s.hw(brk_clips, "impeller bracket supports, 4 positions")
    s.focus = bench + brk_clips

    s = U.step(phase=3, phaseTitle=P3, title="Fasten the motor mounting bracket",
               text="Insert the four hex flange bolts through the bracket into the clip nuts and tighten each one with the drill, a 3/8 in socket and an extension.",
               speech="Insert the four hex flange bolts through the bracket into the clip nuts, and tighten each one with the drill and an extension.",
               camera=dict(dir=[0.8, 1.0, 0.55], xray=True))
    for n in brk_bolts: s.fastener(n, "bolt", dur=0.9)
    s.drill(brk_bolts, extension=S.DRILL.extension_mm)
    s.hw(brk_bolts, "bracket ends, into the clip nuts")
    s.flag(f"The drill reaches the bolt next to the front wall only with a socket extension (about {S.DRILL.extension_mm / 25.4:.0f} in): "
           "not in the supplied tools — a generic bar is shown (labelled)")

    # ---------------------------------------------------------------- PHASE 3 — motor leads (before Phase 4)
    leads = lead_paths(U)
    s = U.step(phase=3, phaseTitle=P3, title="Route the motor leads through the L-connector",
               text="Feed the nine motor leads from the motor's lead exit along the back of the chamber into the L-connector, through the elbow and out of the sealing nut below it. Keep the leads together without twisting, then hand-tighten the sealing nut around them.",
               speech="Feed the nine motor leads from the motor along the back of the chamber into the L-connector, through the elbow and out of the sealing nut. Keep them together, then hand-tighten the sealing nut.",
               camera=dict(dir=[-0.75, 0.45, 0.75], xray=True))
    s.leads_begin(leads)
    t0 = s.t; tot = max(np.sum(np.linalg.norm(np.diff(np.asarray(L["points"]), axis=0), axis=1)) for L in leads.values())
    dur = tot / S.CABLE.feed_mm_per_s
    s._shot(t0, (-330, 60, 0), radius=110, kind="wide", axis=(1, 0, 0))
    s._shot(t0 + dur * 0.45, (-385, 30, 0), radius=80, kind="detail", axis=(0, 1, 0))
    s._shot(t0 + dur * 0.8, (-400, -50, 0), radius=85, kind="detail", axis=(0, 1, 0))
    s.t = t0 + dur + S.CABLE.stagger * 9 + 0.3
    s.check_leads("routed", allow_end={CONNECTOR}, allow_zone=_lead_allow)
    s._carried("NPTA12_sealing_nut"); s.drive_with_hand("NPTA12_sealing_nut", turns=1, dur=1.0)
    s.leads_fx(grow=(t0, t0 + dur))
    s.focus = ["Impeller Drive Motor"] + L_PARTS
    s.flag("Lead lengths, routing clamps and the lead exit of the motor are not specified: the leads follow the shortest clear path "
           "from the motor's lead-exit boss to the L-connector (collision-checked); 22 AWG, Ø1.6 mm insulation assumed (UL 1007 type)")

    s = U.step(phase=3, phaseTitle=P3, title="Crimp ferrules and splices on the motor leads",
               text="Strip the nine motor leads. Slide a wire-end ferrule onto the GND lead and onto each white thermal-switch lead and crimp it with the crimping pliers. "
                    "Then join the winding leads in pairs for 230/3/60 — Black with Grey, Red with Blue, Orange with Brown: insert both stripped ends of a pair into one splice and crimp it.",
               speech="Strip the nine motor leads. Crimp a ferrule onto the ground lead and onto each white lead. Then join the winding leads in pairs, black with grey, red with blue, orange with brown, each pair in one splice, and crimp it.",
               camera=dict(dir=[-0.9, 0.3, 0.6]))
    s.leads_reset_time()
    # work positions behind the back panel: ferrules on one side of the L-connector, splices on the other
    W_AT = {k: np.array([-438.0, -62.0, 40.0 + 34.0 * i]) for i, k in enumerate(SINGLES)}
    W_AT |= {a: np.array([-438.0, -62.0, -40.0 - 34.0 * i]) for i, (a, _) in enumerate(SPLICES)}
    work = {}
    for k in SINGLES: work[k] = W_AT[k] - _cavity(TERMINATED[k])
    for a, b in SPLICES: work[a] = work[b] = W_AT[a] - _cavity(TERMINATED[a])    # the pair moves together, side by side
    for k in LEAD_COLOUR: s.lead_keys(k, [(s.t, work[k] * 0.0), (s.t + 1.0, work[k])])
    s.t += 1.2
    s.crimp(list(SINGLES) + [a for a, _ in SPLICES], work, splices={a: -_pair_offset(a) for a, _ in SPLICES})
    s.check_leads("ends at the crimping positions", offsets=work, allow_end={CONNECTOR}, allow_zone=_lead_allow)
    s.leads_fx()
    s.focus = L_PARTS
    s.flag("Ferrule type and size are not specified: a generic 0.34 mm² (22 AWG) sleeve, 6 mm long, is shown; crimper die nest chosen by size")
    s.flag(f"Splice type and size are not specified (engineering: paired leads joined by splice): a generic uninsulated crimp splice for "
           f"2 × 22 AWG ({S.SPLICE.length:.0f} mm long, Ø{S.SPLICE.od} mm) holding both stripped ends is shown, crimped with the same pliers, and its "
           "crimped end is pushed into the terminal like a ferrule — confirm the splice part and whether a jumper lead runs from the splice to the terminal")

    s = U.step(phase=3, phaseTitle=P3, title="Wire the impeller connector insert",
               text="Hold the connector insert below the L-connector, wire side up. Press the release of each terminal and push the ends fully in: the Black + Grey splice to terminal 1, Red + Blue to 2, "
                    "Orange + Brown to 3, the white leads to 5 and 6 and GND to the PE terminal. Terminal 4 stays empty (230/3/60). Release and pull each lead gently to check it is held.",
               speech="Hold the connector insert below the L-connector, wire side up. Push the black and grey splice into terminal one, red and blue into two, orange and brown into three, "
                      "the white leads into five and six, and ground into P E. Terminal four stays empty. Pull each lead gently to check it is held.",
               camera=dict(dir=[-0.9, 0.35, 0.55]))
    s.leads_reset_time()
    s.stage([CONNECTOR], offset=CONN_W, approach=(-70, -40, 0), dur=1.4, label="connector insert to its work position")
    for grp in [(a, b) for a, b in SPLICES] + [(k,) for k in ("White 5", "White 6", "GND")]:
        t = s.t
        for k in grp:
            w = U.leads[k]["end"][-1][1:4]
            s.lead_keys(k, [(t, w), (t + 0.9, CONN_W + np.array([0, 14.0, 0])), (t + 1.6, CONN_W)])
            U.leads[k]["attach"] = (CONNECTOR, t + 1.6, CONN_W)
        s._shot(t + 0.2, _cavity(TERMINATED[grp[0]]) + CONN_W, radius=62, kind="detail", axis=(0, 1, 0))
        s.t = t + 1.9
    s.check_leads("terminated, insert at its work position", offsets={k: CONN_W for k in LEAD_COLOUR}, allow_end={CONNECTOR}, allow_zone=_lead_allow)
    s.leads_fx()
    s.hw([CONNECTOR], "below the L-connector outlet (motor leads)")
    s.focus = [CONNECTOR] + L_PARTS
    s.flag("CSHM 06 connector insert: not part of MF-550-210-B_GROUPED_ASSEMBLY_03 — placed below the L-connector outlet, wire side up "
           "(see merge_cad.py); its position, the contact numbering (1-2-3 / 4-5-6 rows), the PE terminal position and the push-release spring "
           "terminals (orange release buttons in the wiring-drawing photographs) are assumptions accepted by engineering for now — the supplied "
           "model has no markings; revisit when the connector drawing is available")
    s.flag("Wiring per the 230/3/60 diagram of the supplied drawing (supply variant confirmed by engineering): Black+Grey → 1, Red+Blue → 2, "
           "Orange+Brown → 3 (spliced pairs), 4 not used, White → 5, White → 6, GND → PE")

    # ---------------------------------------------------------------- PHASE 4
    s = U.step(phase=4, phaseTitle=P4, title="Install the impeller guard",
               text="Lower the impeller guard onto its seat above the motor bracket and align it with the main body.",
               speech="Lower the impeller guard onto its seat above the motor bracket, and align it with the main body.",
               camera=dict(dir=[0.9, 1.0, 0.7], xray=True))
    s.place(["Impeller Guard"], path=[(0, 420, 0)], dur=2.4)
    s.flag("The CAD has no fasteners on the impeller guard (the brief asks for 4 machine screws): fastener type, size and locations require engineering confirmation — not animated")

    s = U.step(phase=4, phaseTitle=P4, title="Install the bellmouth mounting plate",
               text="Pass the bellmouth mounting plate in through the front filter opening, then raise it up under the bellmouth support track, around the impeller inlet.",
               speech="Pass the bellmouth mounting plate in through the front filter opening, then raise it up under the bellmouth support track.",
               camera=dict(dir=[0.9, -0.55, 0.7], xray=True, underside=True))
    opts = [([(460, dy, 0), (dx, dy, 0), (dx, 0, 0)], None) for dy in (-84, -80, -88) for dx in (-4, -7, -10, -14)]
    path, tilt = choose_place(U, ["Bellmouth Mounting Plate"], opts, allow={"Clip Nut (6)", "Clip Nut (7)"})
    s.place(["Bellmouth Mounting Plate"], path=path, tilt=tilt, dur=3.2, final_allow={"Bellmouth Support Track", "Clip Nut (6)", "Clip Nut (7)"})

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

    s = U.step(phase=4, phaseTitle=P4, title="Install the inlet bellmouth",
               text="Set the six hex flange nuts on the plate over their holes (slide them in under the impeller shroud). Raise the inlet bellmouth from below through the open base until its flange meets the plate, then insert the six hex flange bolts from below through the flange and plate into the nuts and tighten them.",
               speech="Set the six flange nuts on the plate over their holes. Raise the inlet bellmouth from below until its flange meets the plate, then insert the six bolts from below into the nuts, and tighten them.",
               camera=dict(dir=[0.9, -0.5, 0.6], xray=True, underside=True))
    for n in bm_nuts:
        c = np.asarray(U.A[n]["centre"]); r = unit([c[0] + 176.6, 0, c[2]])
        s.place([n], path=[r * 30 + np.array([0, 0.8, 0]), np.array([0, 0.8, 0])], dur=1.0, final_allow={"Bellmouth Mounting Plate"})
    s.place(bm, path=[(0, -420, 0)], dur=2.6, final_allow={"Bellmouth Mounting Plate"} | set(wheel), label="inlet bellmouth raised under the plate")
    for n in bm_bolts: s.fastener(n, "bolt", engage=5.0, dur=0.9)
    s.drill(bm_bolts, hints=((1, 0, 0), (0, 0, 1)))
    s.hw(bm + bm_bolts + bm_nuts, "bellmouth flange to mounting plate")
    s.flag("The flange nuts sit under the impeller shroud (about 6 mm above the bolt tips), so they are placed on the plate first and the bolts are driven up into them from below")
    s.flag("v2.2: the inlet bellmouth is not attached to the impeller in the CAD (it is held by these six bolts) — it is fitted here, from below, "
           "instead of being carried on the motor assembly (its Ø280 flange does not pass between the bracket supports)")

    # ---------------------------------------------------------------- PHASE 5
    for k, (g, label, sid, part) in enumerate((("StageFilter1_MechanicalFilter", "Stage Filter 1", "sticker-mf55-f001", "Filter Frame Half (1)"),
                                               ("StageFilter2_MechanicalFilter", "Stage Filter 2", "sticker-mf55-f002", "Filter Frame Half (3)"))):
        s = U.step(phase=5, phaseTitle=P5, title=f"Install {label}",
                   text=(f"Apply the {'1st' if k == 0 else '2nd'} stage filter label (Part # MF55-F00{k + 1}) centred on the front face of {label}, arrow pointing up. "
                         + (f"Slide {label} (mechanical filter module) into its track through the front opening, frame edges in the guides, and push it fully home." if k == 0 else
                            f"Slide {label} into the track above Stage Filter 1 through the front opening and push it fully home.")),
                   speech=(f"Apply the {'first' if k == 0 else 'second'} stage filter label, centred on the front, arrow up. Then slide {label} into its track through the front opening and push it fully home."),
                   camera=dict(dir=[1, 0.25, 0.75]))
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
               text="Press the four clip nuts onto the door flanges at the four door bolt holes: two on the upper flange and two on the lower flange, threaded side facing out.",
               speech="Press the four clip nuts onto the door flanges at the four bolt holes, two at the top and two at the bottom.",
               camera=dict(dir=[1, 0.3, 0.55]))
    dup = {"Clip Nut (12)": "Clip Nut (6)", "Clip Nut (5)": "Clip Nut (7)"}     # duplicated in the CAD (flagged)
    for n in door_clips: s.fastener(n, "clip", dur=0.9, allow={dup[n]}, **clip_dir(U, n, prefer=FRONT, allow={dup[n]}))
    for n in door_clips_low: s.fastener(n, "clip", dur=0.9, **clip_dir(U, n, prefer=FRONT))
    s.hw(door_clips + door_clips_low, "door flanges, 4 positions")
    s.flag("Clip Nut (12) / (5) overlap Clip Nut (6) / (7) of the main body at the same holes (duplicate in the CAD) — both are shown")

    door_off = np.array([360.0, 0.0, 0.0]); flip = ((0, 1, 0), 180.0)
    s = U.step(phase=5, phaseTitle=P5, title="Apply the silicone door gasket",
               text="Lay the filter cover face down. With the caulking gun, run one continuous bead of black silicone on its inner face all around the filter opening outline, "
                    "joining the end of the bead to its start. This bead forms the door gasket.",
               speech="Lay the filter cover face down. With the caulking gun, run one continuous bead of black silicone all around the filter opening outline on its inner face, joining the end to the start. This bead is the door gasket.",
               camera=dict(dir=[1, 0.6, 0.5]))
    s.stage(door, offset=door_off, tilt=flip, approach=(0, 160, 0), dur=1.6, label="filter cover laid face down")
    Tq = s._group_pose(door, door_off, flip)[:2]
    g_rect = door_gasket_rect()
    s.bead_path(g_rect, normal=(-1, 0, 0), dur=S.SEALANT.gasket_dur, bead_d=S.SEALANT.gasket_d, label="silicone door gasket",
                colour=S.SEALANT.gasket, sealant=S.SEALANT.gasket, product="Caulking gun (supplied model) with black silicone sealant (type not specified)",
                attach="Access Door", xform=Tq, corner=10.0, shot=(np.mean(g_rect, axis=0), 230, (-1, 0, 0)))
    s.kit(door, (880.0, 230.0, 0.0))                     # components view: in front of and above the filter modules (their labels stay visible)
    s.hw(door_rivets, "access door to door frame — already set")
    s.flag(f"Door gasket formed in place with silicone applied with the supplied caulking gun (engineering); black is used for the animation. "
           f"Silicone product not specified; bead Ø{S.SEALANT.gasket_d:.1f} mm = the gap between the door and the body face in the CAD, along the "
           "filter opening outline 0.5 mm outside its edge (opening 120 × 346 mm measured on the body)")

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

    s = U.step(phase=6, phaseTitle=P6, title="Position the filter clamp bolt brackets and tap the screw holes",
               text="Fit the two filter clamp bolt brackets at the top of the side panels, leg inside the side panel. From outside, tap the two screw holes of each bracket through the side panel holes with the drill and the tap, keeping the tap square to the panel.",
               speech="Fit the two filter clamp bolt brackets at the top of the side panels. Then, from outside, tap the two screw holes of each bracket through the side panel with the drill and the tap.",
               camera=dict(dir=[0.6, 0.7, 1.0]))
    for b in fcb_brackets:
        zs = 1 if U.A[b]["centre"][2] > 0 else -1
        path, tilt = choose_place(U, [b], [([(0, 140, 0)], None), ([(0, 140, zs * 40), (0, 0, zs * 40)], None), ([(0, 0, zs * 120)], None)])
        s.place([b], path=path, tilt=tilt, dur=1.4, final_allow={"Unit Body"})
    holes = []
    for n in sorted(fcb_screws, key=lambda n: (U.A[n]["head"][2], U.A[n]["head"][1])):
        p = U.A[n]; a = unit(p["axis"]); br = next(c for c in p["contacts"] if "Bracket" in c)
        entry, depth = tap_entry(U, n, br)
        holes.append(dict(part=br, entry=entry, axis=-a, depth=depth, through=[]))
    for side_z in (-1, 1):                                   # one bracket at a time (the drill does not cross the unit)
        s.tap([h for h in holes if np.sign(h["entry"][2]) == side_z], hints=((0, -1, 0), (1, 0, 0), (0, 1, 0)), diameter=4.09)
    s.hw(fcb_brackets, "top of the side panels")
    s.flag("Left side wall: the clearance holes of Pan Head Machine Screw (8) / (9) are about 0.5 mm off the screw axes in the CAD — "
           "the Ø4.09 mm tap grazes their edge (the tap-drill path check is not clear there); confirm the hole positions")
    s.flag("Thread tapping per the assumptions confirmed by engineering: bracket holes Ø3.30 mm (tap drill of M4 × 0.7, or #8-32 at high "
           "engagement) tapped for the Ø4.09 mm screw shanks, through the bracket leg — the supplied tap model (M20 × 1.0) is shown resized "
           "radially to Ø4.09 mm")

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
    s = U.step(phase=7, phaseTitle=P7, title="Connect the impeller connector",
               text="With the unit de-energised, push the wired connector insert up into its position below the L-connector until it is fully engaged, leads relaxed. Check the PE connection before connecting the supply plug.",
               speech="With the unit de-energised, push the wired connector insert up into its position below the L-connector until it is fully engaged. Check the ground connection before connecting the supply.",
               camera=dict(dir=[-0.9, 0.3, 0.6]))
    s.leads_reset_time()
    s.place([CONNECTOR], path=[CONN_W], dur=2.0, label="connector insert engaged in its position")
    s.leads_fx()
    s.hw([CONNECTOR], "below the L-connector outlet")
    s.focus = [CONNECTOR] + L_PARTS
    s.flag("The mating supply plug / housing of the connector is not in the supplied data: the engagement is shown as the insert moving "
           "into its (assumed) seat; supply connection and test procedure require the approved electrical drawing")

    s = U.step(phase=7, phaseTitle=P7, title="Electrical system verification",
               text="Carry out the approved electrical test procedure. After the safety checks, run the motor briefly and confirm the impeller turns freely in the direction of the arrow (counter-clockwise seen from above) and the air is drawn in through the inlet below the impeller and moves up through the unit.",
               speech="Carry out the approved electrical test procedure. After the safety checks, run the motor briefly and confirm the impeller turns freely in the direction of the arrow, counter-clockwise seen from above, and the air is drawn in below the impeller and moves up through the unit.",
               camera=dict(dir=[0.9, 0.9, 0.7], xray=True))
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

    s = U.step(phase=9, phaseTitle=P9, title="Install the pressure gauge and its box cover",
               text="Fit the pressure gauge into the gauge mounting panel from the front. Through the side opening of the gauge box, put the wrench on the flats of the gauge stem and tighten the gauge, dial upright. Then fit the gauge box cover over the side opening and fasten it with its two pan head machine screws.",
               speech="Fit the pressure gauge into the gauge panel from the front. Through the side opening of the gauge box, tighten it with the wrench on the flats of its stem, dial upright. Then fit the gauge box cover and fasten it with its two screws.",
               camera=dict(dir=[0.9, 0.25, -0.9]))
    gauge = "Pressure Gauge"; GZ, GY = -138.478, -32.499
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
