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
