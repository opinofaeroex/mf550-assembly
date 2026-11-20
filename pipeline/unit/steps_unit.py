"""
steps_unit.py — the authored installation sequence (v2.0)

Order = the manufacturing workflow of the v2.0 brief (phases 1–9), with the additions the
CAD requires (all hardware present in MF-550-210-B_GROUPED_ASSEMBLY is installed somewhere;
nothing is invented). Deviations / open items are recorded as `flag(...)` on the step.
Camera `dir` = direction from the target towards the camera (model frame, Y up, front = +X).
"""
from __future__ import annotations

import math

import numpy as np

from unitlib import delta_matrix, ID_Q, unit

FRONT, BACK, TOP = (1, 0, 0), (-1, 0, 0), (0, 1, 0)
NO_BIT = ("Driver bit not supplied: a placeholder 1/4 in hex bit (labelled) is shown in the drill — "
          "drive type of the pan-head screws is not modelled in the CAD")


def clip_dir(U, name, prefer=None, travel=30.0):
    """Slide-on direction of a clip nut: the first collision-free direction perpendicular to its bolt axis."""
    p = U.A[name]; a = unit(p["axis"]); head = np.asarray(p["head"])
    mates = set(p.get("contacts", []))
    cands = [np.array(v, float) for v in ((1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1), (0, 1, 0), (0, -1, 0))]
    cands = [c for c in cands if abs(c @ a) < 0.2]
    if prefer is not None:
        cands.sort(key=lambda c: -float(c @ unit(prefer)))
    mesh = U.world.mesh[name]
    best = None
    for d in cands:
        worst = 0.0
        for s in np.linspace(0, 0.85, 12):
            Mx = delta_matrix(d * travel * (1 - s), ID_Q, head, a, 0)
            al = mates if s > 0.6 else set()
            hit = U.world.hits(mesh, Mx, allow=al)
            worst = max([worst, *hit.values()]) if hit else worst
        if worst == 0.0: return d
        if best is None or worst < best[0]: best = (worst, d)
    return best[1]


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
            q = slerp(qs, ID_Q, min(1, s * 1.15)) if tilt else ID_Q
            T = o + P - quat_to_mat(q) @ P
            hit = U.world.hits(mesh, delta_matrix(T, q, P, (0, 1, 0), 0), allow=set(allow))
            if hit: worst += sum(hit.values())
        if worst == 0: return path, tilt
        if best is None or worst < best[0]: best = (worst, path, tilt)
    return best[1], best[2]


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
    gauge_screws = ["Pan Head Machine Screw (12)", "Pan Head Machine Screw (6)"]
    back_screws = ["Pan Head Machine Screw (10)", "Pan Head Machine Screw (11)"]
    rivets = sorted(n for n in top if n.startswith("Closed-End Rivet"))
    by_contact = lambda pair: [r for r in rivets if set(pair) <= set(U.A[r].get("contacts", []))]
    door_rivets = by_contact(("Access Door", "Door Frame"))
    back_rivets = by_contact(("Back Panel", "Unit Body")) + by_contact(("Back Panel", "Filter Base"))
    fb_rivets = [r for r in by_contact(("Filter Base", "Unit Body")) if r not in back_rivets]
    leg_rivets = by_contact(("Track Mount Leg", "Unit Body")) + by_contact(("Track Mount Leg (1)", "Unit Body"))
    gauge_rivets = by_contact(("Gauge Box Enclosure", "Unit Body"))
    used_rivets = set(door_rivets + back_rivets + fb_rivets + leg_rivets + gauge_rivets)
    assert used_rivets == set(rivets), f"rivets not assigned: {sorted(set(rivets) - used_rivets)}"

    P1, P2, P3, P4, P5, P6, P7, P8, P9 = (
        "Main body preparation", "Base hardware and cable strain relief", "Motor and impeller",
        "Impeller protection and bellmouth", "Mechanical filters", "Exterior identification and filter clamping",
        "Electrical connections and verification", "HEPA filter", "Final assembly")

    # ---------------------------------------------------------------- PHASE 1
    s = U.step(phase=1, phaseTitle=P1, title="Inspect the main body",
               text="Start with the fully assembled, painted main body. Check that every face is closed, no structural part is missing and the paint is complete.",
               speech="Start with the fully assembled and painted main body. Check that every face is closed, nothing is missing and the paint is complete.",
               camera=dict(dir=[1, 0.5, 0.85], wide=True))
    s.show(body)
    s.wait(3.5)

    # ---------------------------------------------------------------- PHASE 2
    s = U.step(phase=2, phaseTitle=P2, title="Install the base clip nuts",
               text="Press the eight clip nuts onto the base flanges at their mounting holes, threaded side facing out, until each one seats.",
               speech="Press the eight clip nuts onto the base flanges, one at each mounting hole, until each one seats.",
               camera=dict(dir=[1, -0.25, 0.9]))
    for k, n in enumerate(sorted(nuts_base, key=lambda n: math.atan2(U.A[n]["centre"][2], U.A[n]["centre"][0] + 189))):
        c = np.asarray(U.A[n]["centre"]) - np.array([-189.3, U.A[n]["centre"][1], 0])
        s.fastener(n, "clip", slide=clip_dir(U, n, prefer=c), dur=1.0 if k < 2 else 0.7)
    s.hw(nuts_base, "base flanges, 8 positions")

    s = U.step(phase=2, phaseTitle=P2, title="Seal and fit the cable strain relief",
               text="Apply a continuous silicone bead around the cable entry hole on the outside of the back panel, then push the cable strain relief through the hole into the bead.",
               speech="Apply a continuous bead of silicone around the cable entry hole on the back panel, then push the cable strain relief through the hole into the bead.",
               camera=dict(dir=[-1, 0.35, 0.55]))
    g = "1_Cable Strain Relief"; gp = U.A[g]
    face_x = U.A["Back Panel"]["bbox"][0]
    s.bead(centre=(face_x, gp["head"][1], gp["head"][2]), normal=(-1, 0, 0), radius=9.3, bead_d=3.0)
    s.fastener(g, "screw", engage=0.0, gap=40, dur=1.4)
    s.hw([g], "back panel, cable entry")
    s.flag("Silicone type and bead size are not specified in the supplied data — the dispenser model's WEICON HT300 cartridge is shown")

    s = U.step(phase=2, phaseTitle=P2, title="Tighten the strain relief nut",
               text="From inside the unit, thread the strain relief nut onto the strain relief and tighten it against the back panel with the adjustable wrench.",
               speech="From inside the unit, thread the locknut onto the strain relief and tighten it against the back panel with the adjustable wrench.",
               camera=dict(dir=[0.55, 0.45, 0.9], xray=True))
    n = "2_Strain Relief Nut"
    s.fastener(n, "nut", side=FRONT, gap=30, engage=3.0, hand_turns=2)
    s.wrench(n, side=FRONT, strokes=2)
    s.hw([n], "inside the back panel, on the strain relief thread")

    # ---------------------------------------------------------------- PHASE 3
    s = U.step(phase=3, phaseTitle=P3, title="Install the impeller and drive motor",
               text="Slide the impeller onto the motor shaft, keeping the inlet facing down. Lower the motor and impeller assembly into the impeller chamber, centred over the bellmouth support.",
               speech="Slide the impeller onto the motor shaft with the inlet facing down, then lower the motor and impeller into the chamber, centred over the bellmouth support.",
               camera=dict(dir=[0.9, 0.85, 0.75], xray=True))
    for n in wheel:
        s._track(n); s._key(n, 0, (0, 470, 0)); s._key(n, s.t, (0, 470, 0)); s._key(n, s.t + 1.4, (0, 560, 0), ease=1)
    s.t += 1.6
    s.place(imp, path=[(0, 560, 0), (0, 180, 0)], dur=3.2, label="impeller + motor lowered into the chamber")
    s.flag("Motor shaft fit and impeller retention are inside the CAD sub-assembly (no separate shaft hardware modelled)")

    s = U.step(phase=3, phaseTitle=P3, title="Position the motor mounting bracket",
               text="Press the four clip nuts onto the bracket supports, then guide the motor mounting bracket under the filter base lip and onto the motor, aligning its holes.",
               speech="Press four clip nuts onto the bracket supports, then guide the motor mounting bracket under the filter base lip and onto the motor.",
               camera=dict(dir=[0.85, 1.0, 0.6], xray=True))
    for n in brk_clips:
        s.fastener(n, "clip", slide=clip_dir(U, n), dur=0.8)
    path, tilt = choose_place(U, ["Motor Mounting Bracket"], [
        ([(0, 260, 0), (0, 40, 0)], None), ([(0, 260, 0), (0, 30, 0), (0, 8, 40)], None),
        ([(0, 260, 0), (0, 30, 0)], ((1, 0, 0), 14)), ([(0, 260, 0), (0, 25, 0)], ((0, 1, 0), 20)),
        ([(0, 260, 0), (0, 30, 0)], ((0, 0, 1), 10)), ([(0, 260, 0), (0, 30, 0)], ((0, 1, 0), 35))],
        allow=set(brk_clips))
    s.place(["Motor Mounting Bracket"], path=path, tilt=tilt, dur=3.0, final_allow=set(brk_clips) | {"Filter Base", "Impeller Bracket Support", "Impeller Bracket Support (1)"})
    s.hw(brk_clips, "impeller bracket supports, 4 positions")

    s = U.step(phase=3, phaseTitle=P3, title="Fasten the motor mounting bracket",
               text="Insert the four hex flange bolts through the bracket into the clip nuts and tighten them with the drill and a 3/8 in socket.",
               speech="Insert the four hex flange bolts through the bracket into the clip nuts, and tighten them with the drill.",
               camera=dict(dir=[0.8, 1.0, 0.55], xray=True))
    for n in brk_bolts: s.fastener(n, "bolt", dur=0.9)
    s.drill(brk_bolts)
    s.hw(brk_bolts, "bracket ends, into the clip nuts")

    s = U.step(phase=3, phaseTitle=P3, title="Install the external tooth lock washers",
               text="Place one external tooth lock washer over each of the four motor mounting holes in the bracket.",
               speech="Place an external tooth lock washer over each of the four motor mounting holes in the bracket.",
               camera=dict(dir=[0.7, 1.0, 0.45], xray=True, close=True))
    for n in washers: s.fastener(n, "washer", side=TOP, gap=25, dur=0.8)
    s.hw(washers, "motor mounting holes, under the bolt heads")

    s = U.step(phase=3, phaseTitle=P3, title="Insert the motor mounting bolts",
               text="Insert the four motor mounting hex bolts through the washers and bracket and start them by hand into the motor.",
               speech="Insert the four motor mounting bolts through the washers and the bracket, and start them by hand into the motor.",
               camera=dict(dir=[0.7, 1.0, 0.45], xray=True, close=True))
    for n in motor_bolts: s.fastener(n, "bolt", dur=1.0)
    s.hw(motor_bolts, "bracket into the drive motor")

    s = U.step(phase=3, phaseTitle=P3, title="Tighten the motor mounting bolts",
               text="Tighten the four motor mounting bolts with the drill and a 10 mm socket until each bolt seats on its lock washer.",
               speech="Tighten the four motor mounting bolts with the drill and a ten millimetre socket until each one seats on its lock washer.",
               camera=dict(dir=[0.7, 1.0, 0.45], xray=True, close=True))
    s.drill(motor_bolts)
    s.hw(motor_bolts, "bracket into the drive motor")
    s.flag("Tightening torque is not specified in the supplied data — engineering confirmation")

    s = U.step(phase=3, phaseTitle=P3, title="Mark the motor mounting bolts",
               text="After tightening, draw a tightening mark from each bolt head onto the bracket so that any loosening is visible.",
               speech="After tightening, draw a mark from each bolt head onto the bracket, so any loosening can be seen.",
               camera=dict(dir=[0.6, 1.0, 0.5], xray=True, close=True))
    s.mark(motor_bolts, dir_hint=(1, 0, 0))
    s.hw(motor_bolts, "tightening marks")
    s.flag("No reference photograph for the tightening mark was supplied: a straight line across the head onto the bracket is shown — confirm the marking convention")

    # ---------------------------------------------------------------- PHASE 4
    s = U.step(phase=4, phaseTitle=P4, title="Install the impeller guard",
               text="Lower the impeller guard onto its seat above the motor bracket and align it with the main body.",
               speech="Lower the impeller guard onto its seat above the motor bracket, and align it with the main body.",
               camera=dict(dir=[0.9, 1.0, 0.7], xray=True))
    s.place(["Impeller Guard"], path=[(0, 420, 0)], dur=2.4)
    s.flag("The CAD has no fasteners on the impeller guard (the brief asks for 4 machine screws): fastener type, size and locations require engineering confirmation — not animated")

    s = U.step(phase=4, phaseTitle=P4, title="Install the bellmouth mounting plate",
               text="Pass the bellmouth mounting plate in through the front filter opening, then raise it under the bellmouth support track, around the impeller inlet.",
               speech="Pass the bellmouth mounting plate in through the front filter opening, then raise it up under the bellmouth support track.",
               camera=dict(dir=[0.9, -0.55, 0.7], xray=True))
    opts = [([(460, dy, 0), (dx, dy, 0), (dx, 0, 0)], None) for dy in (-84, -80, -88) for dx in (-4, -7, -10, -14)]
    path, tilt = choose_place(U, ["Bellmouth Mounting Plate"], opts, allow={"Clip Nut (6)", "Clip Nut (7)"})
    s.place(["Bellmouth Mounting Plate"], path=path, tilt=tilt, dur=3.2, final_allow={"Bellmouth Support Track", "Clip Nut (6)", "Clip Nut (7)", "Impeller Inlet Bellmouth"})

    s = U.step(phase=4, phaseTitle=P4, title="Fasten the bellmouth mounting plate",
               text="Fasten the plate to the support track with the eight self-tapping pan head screws, driven from below.",
               speech="Fasten the plate to the support track with the eight self tapping screws, driven from below.",
               camera=dict(dir=[0.9, -0.6, 0.6], xray=True))
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

    s = U.step(phase=4, phaseTitle=P4, title="Install the bellmouth hardware",
               text="Set the six hex flange nuts on the plate over their holes (slide them in under the impeller shroud), then insert the six hex flange bolts from below through the bellmouth flange and plate into the nuts and tighten them.",
               speech="Set the six flange nuts on the plate over their holes, then insert the six bolts from below through the bellmouth flange into the nuts, and tighten them.",
               camera=dict(dir=[0.9, -0.5, 0.6], xray=True))
    for n in bm_nuts:
        c = np.asarray(U.A[n]["centre"]); r = unit([c[0] + 176.6, 0, c[2]])
        s.place([n], path=[r * 30 + np.array([0, 0.8, 0]), np.array([0, 0.8, 0])], dur=1.0, final_allow={"Bellmouth Mounting Plate"})
    for n in bm_bolts: s.fastener(n, "bolt", engage=5.0, dur=0.9)
    s.drill(bm_bolts, hints=((1, 0, 0), (0, 0, 1)))
    s.hw(bm_bolts + bm_nuts, "bellmouth flange to mounting plate")
    s.flag("The flange nuts sit under the impeller shroud (about 6 mm above the bolt tips), so they are placed on the plate first and the bolts are driven up into them from below")
    s.flag("Order check: with the motor bracket and guard already fitted, the nuts are reachable only from the side under the shroud — confirm whether the bellmouth plate and hardware should precede the motor bracket")

    # ---------------------------------------------------------------- PHASE 5
    for k, (g, label) in enumerate((("StageFilter1_MechanicalFilter", "Stage Filter 1"), ("StageFilter2_MechanicalFilter", "Stage Filter 2"))):
        s = U.step(phase=5, phaseTitle=P5, title=f"Install {label}",
                   text=(f"Slide {label} (mechanical filter module) into its track through the front opening, frame edges in the guides, and push it fully home." if k == 0 else
                         f"Slide {label} into the track above Stage Filter 1 through the front opening and push it fully home."),
                   speech=(f"Slide {label} into its track through the front opening and push it fully home."),
                   camera=dict(dir=[1, 0.25, 0.75]))
        fa = {"Filter Element Track", "Unit Body", "Spring Nut Angle", "Filter Base", "Bellmouth Support Track"}
        path, tilt = choose_place(U, U.group(g), [([(430, dy, 0), (dx, dy, 0)], None) for dy in (0, 3, 6, 9, 12, -3, -6) for dx in (60, 20)])
        s.place(U.group(g), path=path, tilt=tilt, dur=3.0, label=f"{label} module", final_allow=fa)
        s.hw([], "")

    s = U.step(phase=5, phaseTitle=P5, title="Install the filter cover",
               text="Press the two clip nuts onto the upper door flange, fit the filter cover (door frame and access door) over the filter opening, and rivet the access door to the door frame with six closed-end rivets.",
               speech="Press the two clip nuts onto the upper flange, fit the filter cover over the opening, and rivet the access door to the door frame with six closed end rivets.",
               camera=dict(dir=[1, 0.3, 0.55]))
    for n in door_clips: s.fastener(n, "clip", slide=clip_dir(U, n, prefer=FRONT), dur=0.9)
    s.place(["Door Frame", "Access Door"], path=[(260, 0, 0), (40, 0, 0)], dur=2.4, final_allow={"Unit Body", "Spring Nut Angle", "Clip Nut", "Clip Nut (1)", "Clip Nut (6)", "Clip Nut (7)", "Clip Nut (12)", "Clip Nut (5)"})
    s.rivet(door_rivets)
    s.hw(door_clips + door_rivets, "upper door flange / access door to door frame")
    s.flag("Clip Nut (12) / (5) overlap Clip Nut (6) / (7) of the main body at the same holes (duplicate in the CAD) — both are shown")

    s = U.step(phase=5, phaseTitle=P5, title="Fasten the filter cover",
               text="Fit a door bolt washer on each of the four hex flange bolts, insert them through the access door into the clip nuts and tighten with the drill and a 3/8 in socket.",
               speech="Fit a washer on each of the four door bolts, insert them through the access door into the clip nuts, and tighten them with the drill.",
               camera=dict(dir=[1, 0.25, 0.5]))
    pairs = []
    for b in door_bolts:
        w = min(door_washers, key=lambda w: np.linalg.norm(np.asarray(U.A[w]["centre"])[1:] - np.asarray(U.A[b]["centre"])[1:]))
        pairs.append((b, w))
    for b, w in pairs:
        s.fastener(w, "washer", side=FRONT, gap=22, dur=0.7)
        s.fastener(b, "bolt", dur=0.9)
    s.drill(door_bolts, hints=((0, -1, 0), (0, 0, 1)))
    s.hw(door_washers + door_bolts, "access door, 4 positions")
    s.flag("The brief lists the washers after the bolts; in the CAD each Door Bolt Washer sits under its bolt head, so it is fitted on the bolt first")

    # ---------------------------------------------------------------- PHASE 6
    s = U.step(phase=6, phaseTitle=P6, title="Apply the front panel decals",
               text="Clean the upper front panel. Apply the AEROEX logo with rule, then MIST-FIT, then MF-550 in the positions shown, pressing out any air.",
               speech="Clean the upper front panel, then apply the AEROEX logo, the MIST FIT name and the MF five fifty label in the positions shown.",
               camera=dict(dir=[1, 0.15, 0.0], decals=True))
    for d in ("aeroex-logo", "mist-fit", "mf-550"): s.decal(d, dur=2.0)
    s.flag("Decals are taken from the supplied photograph (perspective-rectified, ~0.6 px/mm source); replace with the vector artwork when available")

    s = U.step(phase=6, phaseTitle=P6, title="Install the filter clamp bolt brackets",
               text="Fit the two filter clamp bolt brackets at the top of the side panels and fasten each with two pan head machine screws. Insert the clamp bolts and lock each with its hex nut, tightened with the 9/16 in socket.",
               speech="Fit the two filter clamp bolt brackets at the top of the side panels and fasten each one with two pan head screws. Then insert the clamp bolts and lock them with their nuts.",
               camera=dict(dir=[0.6, 0.7, 1.0]))
    for b in fcb_brackets:
        zs = 1 if U.A[b]["centre"][2] > 0 else -1
        s.place([b], path=[(0, 0, zs * 120)], dur=1.4, final_allow={"Unit Body"})
    for n in fcb_screws: s.fastener(n, "screw", dur=0.7)
    s.drill(fcb_screws, af=6.35, depth=1.5, turns=4, hints=((0, -1, 0), (1, 0, 0)))
    s.toolTracks[-1]["bit"] = "placeholder-hex"
    for n in ("Filter Clamp Hex Bolt", "Filter Clamp Hex Bolt (1)"):
        s.fastener(n, "bolt", engage=0.0, gap=30, dur=1.0, allow={"Filter Clamp Bolt Bracket", "Filter Clamp Bolt Bracket (1)"})
    for n in ("Hex Nut", "Hex Nut (1)"):
        s.fastener(n, "nut", side=TOP, gap=28, engage=4.0)
    s.drill(["Hex Nut", "Hex Nut (1)"])
    s.hw(fcb_brackets + fcb_screws + ["Filter Clamp Hex Bolt", "Filter Clamp Hex Bolt (1)", "Hex Nut", "Hex Nut (1)"], "top of the side panels")
    s.flag(NO_BIT)

    # ---------------------------------------------------------------- PHASE 7
    s = U.step(phase=7, phaseTitle=P7, title="Electrical cable connections",
               text="Route the supply cable through the cable strain relief to the motor and make the connections according to the approved electrical drawing, with the unit de-energised.",
               speech="With the unit de-energised, route the supply cable through the strain relief to the motor, and connect it according to the approved electrical drawing.",
               camera=dict(dir=[-0.8, 0.6, 0.6], xray=True))
    s.wait(4.0)
    s.focus = ["1_Cable Strain Relief", "2_Strain Relief Nut", "Impeller Drive Motor"]
    s.flag("No cables, connectors or electrical drawings are in the supplied data: wiring routing and terminations require engineering confirmation — not animated")

    s = U.step(phase=7, phaseTitle=P7, title="Electrical system verification",
               text="Carry out the approved electrical test procedure. After the safety checks, run the motor briefly and confirm the impeller turns freely in the correct direction.",
               speech="Carry out the approved electrical test procedure. After the safety checks, run the motor briefly and confirm the impeller turns freely.",
               camera=dict(dir=[0.9, 0.9, 0.7], xray=True))
    mp = U.A["Impeller Drive Motor"]["centre"]
    s.spin(wheel, pivot=(mp[0], 0, mp[2]), axis=(0, 1, 0), turns=14, dur=6.0)
    s.focus = wheel + ["Impeller Drive Motor"]
    s.flag("No test procedure, supply voltage, current or acceptance criteria were supplied — engineering confirmation; rotation direction not modelled")

    # ---------------------------------------------------------------- PHASE 8
    s = U.step(phase=8, phaseTitle=P8, title="Install the HEPA filter",
               text="Lower the HEPA filter module, gasket down, into the top compartment and seat it evenly on the filter base.",
               speech="Lower the HEPA filter, gasket down, into the top compartment and seat it evenly on the filter base.",
               camera=dict(dir=[0.9, 1.0, 0.8]))
    s.place(U.group("HepaFilter"), path=[(0, 460, 0)], dur=3.0, label="HEPA filter module", final_allow={"Filter Base", "Unit Body"})

    # ---------------------------------------------------------------- PHASE 9
    s = U.step(phase=9, phaseTitle=P9, title="Install the filter clamp",
               text="Place the filter clamp across the HEPA filter over the two clamp bolts and screw down both knobs by hand to compress the filter gasket evenly.",
               speech="Place the filter clamp across the HEPA filter over the two clamp bolts, and screw both knobs down by hand to compress the gasket evenly.",
               camera=dict(dir=[0.8, 1.0, 0.9]))
    s.place(["Filter Clamp"], path=[(0, 200, 0)], dur=1.8, final_allow={"Filter Clamp Hex Bolt", "Filter Clamp Hex Bolt (1)"})
    for n in ("Filter Clamp Knob", "Filter Clamp Knob (1)"):
        s.fastener(n, "nut", side=TOP, gap=30, engage=6.0, hand_turns=1.5, allow={"Filter Clamp Hex Bolt", "Filter Clamp Hex Bolt (1)", "Filter Clamp"})
        s.drive_with_hand(n, turns=3, dur=1.0)
    s.hw(["Filter Clamp Knob", "Filter Clamp Knob (1)"], "clamp bolts, hand-tight")
    s.flag("Clamp knob tightening (gasket compression) is not specified — hand-tight shown")

    s = U.step(phase=9, phaseTitle=P9, title="Install the pressure gauge",
               text="Fit the pressure gauge into the gauge mounting panel from the front, then fasten the gauge box cover with its two pan head machine screws.",
               speech="Fit the pressure gauge into the gauge panel from the front, then fasten the gauge box cover with its two screws.",
               camera=dict(dir=[1, 0.2, -0.75]))
    s.place(["Pressure Gauge"], path=[(140, 0, 0)], dur=1.8, final_allow={"Gauge Mounting Panel", "Gauge Box Enclosure", "Unit Body"})
    for n in gauge_screws: s.fastener(n, "screw", dur=0.8)
    s.drill(gauge_screws, af=6.35, depth=1.5, turns=4, hints=((0, -1, 0), (1, 0, 0)))
    s.toolTracks[-1]["bit"] = "placeholder-hex"
    s.hw(gauge_screws, "gauge box cover")
    s.flag("Gauge tubing / pressure connection is not in the CAD — engineering confirmation"); s.flag(NO_BIT)

    s = U.step(phase=9, phaseTitle=P9, title="Install the back panel screws",
               text="Fit the two pan head machine screws in the upper back panel.",
               speech="Fit the two pan head screws in the upper back panel.",
               camera=dict(dir=[-1, 0.4, 0.4], close=True))
    for n in back_screws: s.fastener(n, "screw", dur=0.8)
    s.drill(back_screws, af=6.35, depth=1.5, turns=4, hints=((0, -1, 0), (0, 0, 1)))
    s.toolTracks[-1]["bit"] = "placeholder-hex"
    s.hw(back_screws, "upper back panel")
    s.flag("These two screws touch only the back panel in the CAD — their function (and any part they hold) requires engineering confirmation"); s.flag(NO_BIT)

    for title, group, where, cam in (
            ("Rivet the back panel", back_rivets, "back panel to unit body and filter base", [-1, 0.4, 0.6]),
            ("Rivet the filter base", fb_rivets, "filter base to unit body (side walls)", [0.4, 0.5, 1.0]),
            ("Rivet the track mount legs", leg_rivets, "track mount legs to unit body", [0.5, 0.0, 1.0]),
            ("Rivet the gauge box enclosure", gauge_rivets, "gauge box enclosure to unit body", [0.9, 0.2, -0.8])):
        s = U.step(phase=9, phaseTitle=P9, title=title,
                   text=f"Insert the {len(group)} closed-end rivets ({where}) and set each one with the rivet gun.",
                   speech=f"Insert the {len(group)} closed end rivets and set each one with the rivet gun.",
                   camera=dict(dir=cam))
        s.rivet(group)
        s.hw(group, where)
        s.flag("These rivets join main-body parts but sit outside the MAIN BODY group in the CAD; they are riveted here as agreed")

    s = U.step(phase=9, phaseTitle=P9, title="Final assembly overview",
               text="The Mist-Fit 550 is complete. Check that every component, fastener and tightening mark is in place and the filter cover and clamp are secure.",
               speech="The Mist Fit 550 is complete. Check that every component, fastener and tightening mark is in place, and that the filter cover and clamp are secure.",
               camera=dict(dir=[1, 0.5, 0.85], wide=True))
    s.wait(4.0)
    s.focus = list(U.A)
    return U
