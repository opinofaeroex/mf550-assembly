"""
standards.py — shared animation, camera and collision parameters of the unit tutorial
=====================================================================================

These are the values of the v2.1 reference implementation (main cc98332), gathered in one
place so that every operation in build_unit.py uses the same timing, clearances, tolerances and
camera rules. They are documented in docs/ANIMATION_AND_INTERACTION_STANDARDS.md (§ 10).

Rules
  * Units: millimetres and seconds (model frame, Y up, front = +X), angles in degrees unless named.
  * Changing a value changes the tutorial: rebuild, run `npm test`, and compare the frames with
    `npm run unit:review -- --compare <baseline>` before committing (standards § 8).
  * Operation-specific behaviour stays in its own namespace (DRILL, RIVET, WRENCH, …): do not merge
    unrelated operations into one generic motion just because two numbers happen to be equal.

Runtime counterparts (camera follow, rotation arrow style, kit view, materials) are in
public/js/unit/standards.js.
"""


class STEP:
    opening_hold = 1.5            # s before the first motion: the opening overview shot is on screen
    end_hold = 0.9                # s after the last motion (step duration = last motion + end_hold)


class PLACE:
    """Rigid placement of a component / module along an authored path (Step.place)."""
    dur_base = 0.9                # duration = clip(dur_base + path_length / mm_per_s, dur_min, dur_max)
    mm_per_s = 260
    dur_min = 1.2
    dur_max = 3.2
    key_spacing = 40              # mm between intermediate keys (smooth bends and tilt removal)
    tilt_removal_rate = 1.15      # optional start tilt is fully removed at 1 / 1.15 of the path
    samples = 36                  # collision samples along the path
    final_allow_samples = 6       # last samples where the listed seating contacts are tolerated
    detail_shot_at = 0.62         # share of the motion where the close-up of the interface is due
    detail_min_radius = 45.0
    detail_pad = 1.15             # close-up radius = max(detail_min_radius, half size × detail_pad)


class FASTENER:
    """Insertion of bolts, screws, nuts, washers and rivets along their own axis (Step.fastener)."""
    gap = 18.0                    # mm of clearance beyond the fastener length at the start
    engage_max = 6.0              # mm of thread engagement left for the tool …
    engage_share = 0.45           # … or this share of the length, whichever is smaller
    insert_share = 0.55           # share of `dur` for the straight insertion when it is hand-started
    hand_share = 0.45             # share of `dur` for the hand turns
    hand_travel = 0.7             # engagement left after the hand turns (share of `engage`)
    hand_turns = 1.5
    samples = 20                  # collision samples along the insertion
    mate_margin = 2.0             # mm: mating parts tolerated once the tip is within length + margin
    detail_min_radius = 28.0      # close-up radius: max(detail_min_radius, length × detail_per_length)
    detail_per_length = 2.2
    shot_lead = 0.15              # s: the close-up is due this long before the insertion starts


class CLIP:
    """Clip nuts: slide on along `slide` riding a small offset along their axis, then snap home."""
    travel = 30.0                 # mm (default; clip_dir() also tries 22 and 16 when 30 is blocked)
    ride_offsets = (0.0, -0.5, -0.75, -1.0, -1.25, -1.5, -2.0, -2.5, 0.5, 1.0, 1.5, 2.5)
    slide_samples = 41            # the mating sheet is NOT tolerated during the slide
    snap_samples = 6              # only the final snap may touch the sheet (CAD interference)
    snap_at = 0.78                # share of `dur` where the clip reaches its ride position
    overshoot = 1.2               # mm short of the seat when no ride offset was needed
    shot_radius = 40


class COLLISION:
    part_tol = 0.6                # mm penetration tolerated for parts (coarse tessellation)
    tool_tol = 1.5                # mm for the tool meshes
    caulking_tol = 1.2
    tool_path_samples = 8         # samples per tool-track segment (every segment is checked)


class TOOL:
    """Shared tool life cycle: approach at a clearance height, engage, operate, retract."""
    roll_steps = 12               # roll candidates about the working axis (every 30°)
    retract_sweep = (0.0, 8.0, 20.0, 40.0, 70.0, 100.0, 130.0)   # mm along the axis that must stay clear
    clear_height_steps = (0, 50, 120, 220, 350)   # extra retract tried above the requested minimum
    hop_raise = (0, 80, 180, 320)                 # extra height tried for a straight hop
    route_margins = (140.0, 220.0, 320.0)         # mm outside the unit box for routed hops
    route_seg_step = 30.0                         # mm between samples on a routed segment
    route_slowdown = 0.35                         # extra hop time per waypoint (share of the hop)
    hop_samples = 10


class DRILL:
    first_clear = 130             # mm minimum approach height for the first fastener
    hop_clear = 70                # mm minimum height for hops between fasteners
    final_clear = 110             # mm retract after the last fastener
    first_lead = 0.25             # s
    hop_dur = 0.45                # s
    near_gap = 6                  # mm: socket stops just above the head …
    near_at = 0.35                # … at this time after the approach
    engage_at = 0.6               # socket over the head
    spin_at = 0.65                # tightening starts (rotation arrow appears)
    s_per_turn = 0.3              # tightening time per fastener turn
    turns = 4.0
    after = 0.15                  # pause after seating
    retract_dur = 0.45
    depth_share = 0.6             # socket depth over the head: max(depth_min, head height × share)
    depth_min = 2.0
    socket_r_supplied = 10.9      # mm outer radius of the supplied 9/16 in socket model
    shot_lead = 0.9               # s: tool close-up is due this long before tightening
    shot_radius = 55


class SPIN_ARROW:
    """Orange rotation arrow around a fastener while it is tightened (fx 'spinArrow')."""
    margin = 7.0                  # mm outside the (resized) socket
    axial_offset = 14.0           # mm out from the outer end of the head / nut, along the tool side
    sense = -1.0                  # clockwise seen from the tool side (right-hand tightening)


class RIVET:
    insert_gap = 14               # mm of the hand insertion
    insert_dur = 0.55             # × pace, + insert_extra
    insert_extra = 0.15
    pace_first = 1.0              # first two rivets at full pace, the rest faster
    pace_rest = 0.6
    first_clear = 140
    hop_clear = 45
    final_clear = 120
    hop_lead = 0.1                # s: the hop leaves the previous rivet this long before t0
    hop_window = 0.3              # × pace: time from leaving the previous rivet to the approach point
    approach_at = 0.2             # × pace
    near_at = 0.4                 # × pace, nose `near_gap` mm off the flange
    near_gap = 0.5
    nose_at = 0.55                # × pace, nose on the flange
    pull_at = 0.6                 # × pace
    pull_dur = 0.45               # trigger / nose stroke while the mandrel is pulled
    release = 0.25
    settle = 0.05
    hop_dur_extra = 0.6           # routed hop: (approach_at + 0.1) × pace + this
    retract_dur = 0.45
    shot_radius_first = 60
    shot_radius_rest = 75
    shot_lead = 0.3


class WRENCH:
    thickness = 17.0              # mm (model)
    back_clear = 0.5              # mm between its back face and the panel
    jaw_play = 0.3                # mm opened beyond the measured hex
    swing = 60                    # degrees per stroke …
    fallback_swings = (45, 30, 25)   # … shorter strokes where the full swing does not fit (flagged)
    roll_steps = 72               # every 5°
    approach = 90                 # mm out along the axis
    approach_check = 45           # mm, intermediate approach pose checked for the roll
    lift = 6                      # mm lift-off between strokes
    jaw_open_at = 0.01            # s: the jaw is set to the hex before the wrench appears
    engage_dur = 0.6
    first_stroke_at = 0.7
    stroke_dur = 0.7
    lift_at = 0.9
    back_at = 1.3
    stroke_cycle = 1.45
    last_stroke = 0.75
    retract_dur = 0.5
    shot_radius = 70


class CAULKING:
    segments = 48                 # nozzle keys around the joint
    check_every = 8
    approach = 160                # mm
    approach_dur = 0.6
    start_at = 0.7                # bead starts growing (s after the step time t0)
    retract_at = 1.1              # retract starts at t0 + retract_at + dur
    nozzle_tilt = 0.75            # trailing tilt of the nozzle along the joint
    knob_turns = 3
    plate_travel = 6.0            # mm plunger travel
    shot_margin = 45


class MARK:
    approach = 120
    retract = 40
    seg_dur = 0.28
    settle = 0.5
    end = 0.4
    width = 1.2
    colour = "#e2131a"
    shot_radius = 40
    shot_lead = 0.2


class CAMERA:
    """Build-time camera shots (Step._shot / _view_dir) — followed at run time by UnitCamera.js."""
    min_radius = {"detail": 62.0, "tool": 120.0, "wide": 120.0, "overview": 95.0, "result": 95.0}
    min_radius_other = 60.0
    elevations = (-55, -30, -10, 10, 30, 50, 70)   # candidate directions (degrees) …
    azimuth_step = 30                              # … plus the step's preferred direction
    dist_per_radius = 3.6         # build-time camera distance ≈ viewer.fitDistance(radius, 1.1), FOV 35
    dist_offset = 30
    axis_deg = 50.0               # insertion axis seen from the side at this angle …
    tool_axis_deg = 65.0          # … and further to the side for tool shots (tool and joint both seen)
    pref_scale_deg = 30.0         # score: angle to the preferred direction / this
    axis_scale_deg = 25.0         # score: |angle to the axis − axis_deg| / this
    occluder_penalty = 4.0        # score per part (or the tool body) on the line of sight
    inside_penalty = 50.0         # camera position inside geometry
    sight_radius = 4.0            # mm, thin line-of-sight cylinder
    sight_start_min = 18.0        # mm from the target where the sight line starts …
    sight_start_max = 60.0
    sight_start_share = 0.25      # … share of the distance, clamped to [min, max]
    inside_radius = 12.0          # mm sphere around the camera position
    merge = 0.35                  # s: shots closer than this are merged (the later one wins)
    overview_starts_before = 0.5  # s: an opening overview is added unless a shot already starts here
    overview_pad = 1.1            # overview radius: max(staging extent × pad, extent × pad_final, min)
    overview_pad_final = 1.25
    overview_min = 70.0
    result_pad = 1.15
    result_min = 70.0
    result_at = 0.1               # s after the last motion
    wide_body_share = 0.9         # `wide` steps / > wide_parts components frame the whole unit
    wide_parts = 30


# ============================================================================ v2.2 operations
# (main-unit process update: bench sub-assembly, wiring, gaskets, tapping, dimension call-outs)

class BENCH:
    """Motor-on-bracket sub-assembly built on the bench before it goes into the unit (Unit.bench_begin)."""
    offset = (0.0, 700.0, 0.0)    # mm above the CAD position: every bench motion stays clear of the open top
    clip_lead = 0.2


class HOLD:
    """Parts staged away from their CAD pose across several steps keep that pose (Unit.finalize_holds)."""


class CABLE:
    """Nine 22 AWG motor leads (fx 'cable'): routed bundle through the L-connector to the connector insert."""
    od = 1.6                      # mm: 22 AWG conductor Ø0.64 + typical PVC insulation (UL 1007) — type not specified
    pitch = 1.75                  # mm between neighbouring leads in the bundle (3 × 3)
    radial = 8                    # tube sides
    seg_mm = 3.0                  # tube segment length
    feed_mm_per_s = 95            # the free ends are fed through the L-connector at this rate
    stagger = 0.06                # s between leads
    follow_len = 85.0             # mm of the free end that follows an end offset (smooth weight)
    check_step = 4.0              # mm between collision samples along each lead
    check_r = 0.75                # mm sphere radius for the samples (insulation, 0.05 mm under the radius)
    strip = 7.0                   # mm insulation stripped for the ferrule (visual)


class FERRULE:
    """Wire-end ferrule crimped on a lead (type / size not in the supplied data: generic 0.34 mm² sleeve)."""
    length = 6.0
    od = 1.5
    od_crimped = 1.25
    colour = "#c9ccd1"


class SPLICE:
    """Crimp splice joining a pair of winding leads (230/3/60; type / size not in the supplied data:
    generic uninsulated splice for 2 x 22 AWG, both stripped ends entering from the wire side)."""
    length = 8.0
    od = 2.4
    od_crimped = 2.0
    colour = "#c9ccd1"


class CRIMP:
    open_jaw_deg = 7.0            # lower jaw opening about the main pivot
    open_handle_deg = 14.0        # lower handle opening about its pin
    approach = 70.0               # mm out along the tool's +Y (handles) before engaging the ferrule
    approach_dur = 0.55
    slide_on = 0.45               # s: ferrule slid onto the stripped end by hand
    close_at = 0.25               # s after engagement
    close_dur = 0.55              # handles squeezed to the ratchet release
    hold = 0.2
    open_dur = 0.35
    retract_dur = 0.45
    shot_radius = 55


class TAP:
    """Thread tapping with the drill and the supplied tap (resized radially, labelled)."""
    first_clear = 120
    hop_clear = 60
    final_clear = 110
    near_gap = 4.0
    lead = 1.5                    # mm of the tap's lead past the far face of the sheet
    s_per_mm = 0.32               # cutting feed (visual)
    reverse_s_per_mm = 0.18       # backing out
    dwell = 0.15
    shot_radius = 60


class RATCHET:
    swing = 30                    # degrees per stroke (ratchet: no lift-off, the handle swings back)
    back_dur = 0.45
    stroke_dur = 0.55
    approach = 70
    engage_dur = 0.55
    retract_dur = 0.5
    shot_radius = 70


class GASKET:
    """Door gasket geometry. The access door gasket is formed in place with silicone (SEALANT.gasket, engineering
    v2.2 review); the square foam strip (fx 'gasket') stays available as a technique for strip gaskets."""
    section = 7.2                 # mm: the gap between the door back face and the body front face (CAD)
    colour = "#1c1d1f"
    liner = "#e0b23a"             # yellow release liner, peeled off as the strip is laid
    lay_mm_per_s = 300
    outside_frame = 1.0           # mm clear of the door frame (the frame passes through the opening)


class SEALANT:
    """Caulking materials (fx 'bead'): distinct colours so the two operations are never confused."""
    ht200 = "#8f9397"             # WEICON Flex 310 M HT 200 — grey MS polymer, silicone-free (manufacturer TDS)
    ht200_d = 3.0
    gasket = "#19191b"            # silicone door gasket, formed in place with the caulking gun — black (engineering
                                  # v2.2 review: black for the animation); product not specified
    gasket_d = GASKET.section     # bead Ø = the CAD gap between the door and the body face
    gasket_dur = 6.0              # s along the whole opening outline (one continuous bead)


class DIMS:
    """Orange dimension call-outs (fx 'dims') for decal / sticker positions, in inches."""
    colour = "#ff7a1a"
    line_w = 0.9                  # mm
    arrow = 6.0                   # mm arrowhead length
    text_h = 13.0                 # mm label height (readable in the panel-wide decal view)
    gap = 2.0                     # mm extension-line gap
    lead = 0.6                    # s the call-outs appear before the decal is pressed on


class AIRFLOW:
    """Airflow indicator while the impeller runs (fx 'airflow'), distinct from the rotation arrow: arrows travel
    along the physical air path — up through the stage filters and the inlet bellmouth into the eye, radially out
    of the wheel between shroud and back plate, then up around the motor through the impeller guard openings."""
    colour = "#2f8fff"
    speed = 180.0                 # mm/s along the path
    arrow_len = 34.0
    spacing = 95.0
    check_r = 2.0                 # mm sphere along each path (collision check)
    # air path profile in (radius from the impeller axis, height y) mm — from the CAD: stage filters y -258…-147,
    # bellmouth throat r 77 (y -100…-65), shroud r 84→126 (y -91…-35), motor r ≤ 61 below y 0 / ≤ 84 above,
    # wheel tip r 126; Catmull-Rom smoothed
    profile = ((110, -290), (110, -200), (92, -150), (62, -118), (54, -92), (58, -62), (76, -36), (100, -16), (126, -2),
               (146, 8), (150, 40), (150, 330))
    # stream angles (deg, about the impeller axis from +X towards +Z): through the openings of the impeller guard and
    # clear of the motor-bracket beam (|z| < 73) — ray-checked on the CAD, then sphere-checked at build time
    angles = (45, 90, 130, 230, 270, 315)


DRILL.ext_r = 6.0                 # v2.2: Ø12 mm socket extension bar (collision mesh and on screen)
WRENCH.approach_side = 70         # v2.2: mm, slid on sideways along the handle (wrench(approach="handle"))
TAP.visual_pitch = 0.8            # mm per turn of the tap on screen (thread not specified)
DRILL.extension_mm = 152.4        # v2.2: 6 in socket extension where the drill body cannot reach (not supplied: generic)
BENCH.kit_x = -470.0              # v2.2: components view — the motor kit stands beside the back panel (mm)
