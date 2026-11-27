# Animation and Interaction Standards — Mist-Fit 550

**Status:** binding reference for all future work on the Mist-Fit 550 assembly viewer.
**Reference implementation:** v2.1, merged as `cc98332` (PR #9). Its animations, camera behaviour, collision rules,
tool interactions and operator interface are the **baseline**: every change must keep or exceed this quality.
**v2.2** (main-unit process update) extends it with the techniques marked *v2.2* below: bench sub-assemblies,
staged parts with holds, effects attached to parts, motor leads, new tools and indicators.
**v2.3** (main-unit refinement) adds the techniques marked *v2.3*: rotated bench sub-assemblies on a worktable,
cable ties, a jacketed cable with stripping and twisting, the torque wrench, the soft highlight, the outside step
label and the operator check line.

**Who reads this:**
- every developer, before changing an assembly step, an animation, a tool, the camera or the interface;
- every Claude Code session, before such changes. `CLAUDE.md` at the repository root makes this mandatory.

Everything below describes techniques that exist and work in the code today, with the file and function
that implement them. Nothing here is aspirational. When a new technique proves itself, add it (see § 12).

---

## Contents

1. [Architecture: where everything lives](#1-architecture-where-everything-lives)
2. [A. Animation philosophy](#2-a-animation-philosophy)
3. [B. Camera behaviour](#3-b-camera-behaviour)
4. [C. Mechanical accuracy and collisions](#4-c-mechanical-accuracy-and-collisions)
5. [D. Tool interaction](#5-d-tool-interaction)
6. [E. Assembly sequence](#6-e-assembly-sequence)
7. [F. User experience](#7-f-user-experience)
8. [Validation workflow (mandatory)](#8-validation-workflow-mandatory)
9. [Recipes](#9-recipes)
10. [Shared parameters](#10-shared-parameters)
11. [Publishing workflow](#11-publishing-workflow)
12. [Maintaining this standard](#12-maintaining-this-standard)

---

## 1. Architecture: where everything lives

The unit-installation tutorial is **data-driven**:
- Every motion, tool pose, effect and camera shot is computed **at build time** from the CAD and checked
  against it.
- The browser only **plays** the recorded tracks.

Do not add hand-animated motions in the browser; author them in the pipeline, where they are collision-checked.

```
STEP (grouped assembly) ─► pipeline/convert_step.py ─► GLB + converter assembly.json
                         └► pipeline/unit/analyse_unit.py ─► unit-analysis.json (axes, heads, sizes, contacts) + meshes
tool STEPs ─────────────► pipeline/unit/build_tools.py ─► public/assets/unit/tools/*.glb + tools.json
                                         │
pipeline/unit/steps_unit.py (the authored sequence)  ──►  pipeline/unit/build_unit.py (Step API, checks, camera shots)
pipeline/unit/standards.py  (shared parameters)      ──►       │
                                                              ▼
                     public/assets/unit/assembly.json  (steps + tracks + fx + camera shots + checks)
                     docs/unit-engineering-report.md   (generated: hardware, checks, camera table, open items)
                                                              │
public/js/unit/UnitSequencer.js  step clock, loop, manual navigation only
public/js/unit/UnitRig.js        applies part / tool tracks and effects (bead, line, mandrels, decals, spinArrow)
public/js/unit/UnitCamera.js     follows the camera shots on the step clock
public/js/unit/standards.js      shared run-time parameters
public/js/main.js                appearance (hidden / active / ghost), floor shadow, step card, UI wiring
```

**Data contract (`assembly.json → steps[i]`):**

| Field | Format | Meaning |
|---|---|---|
| `tracks.parts[]` | `{node, axis, pivot, keys:[[t, Tx,Ty,Tz, qx,qy,qz,qw, angle, ease]], hold?, kit?}` | Rigid **delta** on the CAD pose: `D = Tr(T)·R(q)·Tr(P)·Rot(axis, angle)·Tr(−P)`. The **last key is identity**, so every motion ends exactly at the CAD position. |
| `tracks.tools[]` | `{tool, keys:[[t, pos(3), quat(4)]], sub:{channel:[[t, value, ease]]}, socketScale, socketAF, bit, jaw}` | Pose of the tool's **working frame** (origin = working point, +Y into the tool). `sub` drives moving tool components: `trigger`, `nose`, `knob`, `plate`, `jaw`. |
| `tracks.fx[]` | `bead`, `line`, `mandrels`, `decal`, `spinArrow`; *v2.2:* `gasket`, `cable`, `dims`, `airflow` | Effects with their own timing (grow / draw / show / pull / press / `t:[t0,t1]`). *v2.2:* `attach` (node id) = the effect follows that part's rigid motion; `kit` = also shown in the components view; `group` = a later step's group supersedes the earlier one (motor leads). |
| `camera` | `{dir, xray, underside, wide, close, shots:[[t, tx,ty,tz, dx,dy,dz, radius]], shotKinds, shotBlocked, shotInside}` | Authored hints and the build-time camera shots (model frame, metres). |
| `checks[]` | `{what, samples, clear, collisions}` | Every collision check of the step (shown in the engineering report). |
| `hardware[]`, `tools[]`, `flags[]` | | Hardware lines with measured sizes and status; tools used; open engineering items (not shown to the operator, see § 7). |

The parts tutorial (69 steps, `scene/Sequencer.js`, `scene/Explode.js`, `scene/CameraController.js`) is a separate,
older system. Its exploded view uses `CONFIG.explodeScale = 6` with `CONFIG.explodeSoftCap` (`public/js/config.js`).

---

## 2. A. Animation philosophy

**Rule A1 — Every animation is a real mechanical operation.**
- A component moves the way a person installs it: along its fastener axis, along the guides of its track, or
  straight up / down through a real opening.
- Tools perform the operation they are used for (§ 5).
- Nothing moves for effect.

**Rule A2 — End exactly at the CAD, start from a staging pose.**
- Tracks are written from a staging offset to the CAD pose. The last key of every part track is the identity
  delta, so the assembled state is the exact CAD geometry.
- `tests/smoke.cjs` [14] asserts a maximum residual of 0 m.
- Rotations finish on a whole turn. For hex parts a multiple of 60° is enough, because it looks identical and
  keeps wrench strokes and part rotation in step (`Step.to_json`).

**Rule A3 — Physically plausible paths and orientations.**

| Motion | Technique (`build_unit.py`) |
|---|---|
| Fastener insertion | `fastener()`: along its own axis from `length + gap` out. Hand start: straight insertion (55 % of the time) to the thread engagement, then 1.5 hand turns. |
| Clip nut | `fastener(kind="clip")`: slides along `slide` **riding a small offset along its own axis** (the spring legs over the sheet), then snaps home along the axis. |
| Rigid component / module | `place()`: authored path of straight segments, intermediate keys every 40 mm. An optional start tilt is removed along the path. |
| Placement alternatives | `choose_place()` (`steps_unit.py`): picks the first collision-free option from an ordered list (vertical first). |
| Sub-assembly | Relative motions first (impeller wheel up onto the motor shaft, inlet bellmouth up under it), checked mesh-to-mesh by `sub_assembly_checks()`. Then the group moves as one. |
| Hand-off between steps | A fastener started by hand in one step continues from that pose in the next (`Unit._carry`, `Step._carried`). There is no jump. |
| *v2.2* Bench sub-assembly | `Unit.bench_begin(names)` / `bench_end()`: the named parts are worked on at CAD + `BENCH.offset` (0.7 m above the open top). Their facts and collision meshes move there, so every operation (`place`, `fastener`, `drill`, `mark` …) runs unchanged, checked against the bench parts **and** the unit; keys stay deltas on the CAD pose. Then the whole group moves into the unit with `place()` (Phase 3: motor on its bracket, lowered in). |
| *v2.2* Staged parts and holds | `Step.stage(names, offset, tilt, approach)`: parts appear at a work position off the unit (door laid face down, connector insert below the L-connector). `Unit.finalize_holds()` gives every later step a constant `hold` track until the part moves again (the runtime shows untracked parts at their CAD pose); holds are not active parts. |
| *v2.2* Components-view position | `Step.kit(names, offset)`: explicit kit translation (used as is) where the first key is not a good exploded position (bench parts, the door clear of the filter modules). |

**Rule A4 — Vertical first, no gratuitous lateral moves.**
- Prefer straight up / down where the mechanism allows it:
  - base clip nuts rise 40 mm from below;
  - door clips rise onto their flange;
  - filter-clamp bolt brackets come down from above and then in;
  - the impeller assembly rises from below through the open base;
  - the HEPA filter is lowered.
- Use lateral motion only where the geometry requires it, for example filter modules sliding in along their
  tracks from the front.
- `clip_dir()` and the `choose_place()` option lists encode this order.

**Rule A5 — Smooth, controlled, readable timing.**
- **Opening.** Every step opens with a 1.5 s hold (`STEP.opening_hold`) on the overview shot before anything
  moves.
- **Durations.** Placement time scales with path length: 0.9 s + length / 260 mm/s, clamped to 1.2–3.2 s.
- **Easing.** Part tracks ease into their final key with ease-in-out cubic (`ease = 1` on the key). Intermediate
  path keys, spins and screw turns are linear (`ease = 0`), so rotation speed is constant. Tool-track segments are
  always eased (`UnitRig.#toolPose`), so every tool approach, hop and retract starts and stops softly.
- **Loop.** A step plays, holds 1.6 s (`LOOP.hold`), then repeats from its starting poses with the same
  objects. The sequence **never advances on its own** (`UnitSequencer.update`).

**Rule A6 — Do not fake what the data does not contain.**
- If the CAD or the supplied data lacks something (a hole, a torque, a tool model, wiring), do not invent it.
  Show the closest honest representation and record a flag (`Step.flag`), which goes to the engineering report.
  - A resized socket is labelled.
  - A placeholder bit is orange and labelled.
  - An unreachable screw turns in without a tool.
  - *v2.2:* a socket extension and a resized tap are labelled; unconfirmed electrical terminations stay
    unterminated (the motor leads not identical in both wiring diagrams are routed and parked, not connected).

---

## 3. B. Camera behaviour

**Rule B1 — Every step has its own camera plan, derived from its operations.** The camera is planned at build
time as a list of **shots** `[t, target, direction, radius]`. Each operation adds its own (`Step._shot`):

| Shot kind | Added by | Purpose | Minimum radius |
|---|---|---|---|
| `overview` | `_frame_shots()` at t = 0 | Components **at their starting points** and where they go (staging offsets included) | 95 mm |
| `wide` | `place()` start, `spin()` | The whole insertion path of a component / module | 120 mm |
| `detail` | `fastener()`, clips, `place()` at 62 % of the motion, `decal()` | The fastener entering its hole, the mounting interface | 62 mm |
| `tool` | `drill()`, `rivet()`, `wrench()`, `bead()`, `mark()` | The tool-to-component interaction | 120 mm |
| `result` | `_frame_shots()` after the last motion | Wider view of the completed operation | 95 mm |

**Rule B2 — Angles are chosen from the geometry, not by hand.** `_view_dir()` scores candidate directions:
- **Candidates:** every 30° of azimuth at elevations −55° … 70°, plus the step's preferred direction
  `camera.dir`.
- **Closeness to the preferred view:** angle / 30°.
- **Insertion axis seen from the side:**
  - target 50° from the axis, so the fastener is seen entering its hole;
  - 65° for tool shots, so the tool and the joint are both visible;
  - penalty |angle − target| / 25°.
- **Clear line of sight:** a thin cylinder (r = 4 mm) from the working point to the camera is collision-checked
  against the installed parts, +4 per occluder.
  - For tool shots it is also checked against **the tool body at its working pose** (`_tool_sight`).
  - In x-ray steps only the step's own parts count, because the rest is ghosted.
- **Camera never inside geometry:** a 12 mm sphere at the camera position (`_inside`), +50.

The result per shot (`shotBlocked`, `shotInside`) is in the data and in the camera table of the engineering report.

**Rule B3 — Zoom follows the operation.**
- The radius is the framing sphere: small fasteners close (≥ 62 mm), tools and brackets medium (≥ 120 mm),
  modules and the unit wide (their extent).
- At run time `viewer.fitDistance(radius, 1.12)` converts it to a distance for the actual viewport and step-card
  insets.
- Never frame a small part so tightly that its surroundings disappear: the v2.1 review raised the minimum radii
  for exactly that reason.

**Rule B4 — Smooth, professional run-time behaviour** (`UnitCamera.update`, every frame after the sequencer):
- The camera follows the shots on the **step clock**. It starts moving to the next shot at most 0.9 s (or
  70 % of the interval) before it is due.
- It blends target, direction (slerp) and distance (log-space) with exponential smoothing (3.2 /s).
- It **orbits about the target**, so it never cuts straight through the unit.
- Shots closer than 0.35 s are merged at build time, which avoids nervous camera moves.
- The animation never depends on the camera.

**Rule B5 — The operator is in charge.**
- Any user orbit, zoom or pan pauses the automatic camera (`pauseByUser`), and it never overrides the user.
- **Refocus** (`C`, the chip) or the next step resumes at the current shot.
- A loop restart returns to the first shot.

**Rule B6 — Authoring hints per step** (`camera` dict in `steps_unit.py`):

| Hint | Effect |
|---|---|
| `dir` | Preferred direction (target → camera). |
| `xray` | Ghost the rest of the unit (inside operations). |
| `underside` | Hides the floor shadow for views from below. It is also hidden in the components view. |
| `wide` | Frame the whole unit. |
| `close` | v2.0 static fallback framing. |

---

## 4. C. Mechanical accuracy and collisions

**Rule C1 — Collide against the real parts, never a bounding box.**
- `unitlib.World` holds the exact meshes of every installed part in an FCL collision manager. A part becomes an
  obstacle when its own motion has been recorded (`Step._install`).
- Real openings stay open: the impeller rises through the open base, plates enter through the filter opening.
  The unit's bounding box is used **only** to route tool hops around the outside (`_route`).
- Query geometry is cached per mesh (`World._geom`), which keeps a full build at about 25 s.

**Rule C2 — Every motion is sampled and recorded.** Tolerances are in `pipeline/unit/standards.py`:

| What | Samples | Tolerated |
|---|---|---|
| `place()` path | 36 along the path | Listed seating contacts in the last 6 samples only. |
| `fastener()` insertion | 20 | Its mating parts once the tip is within length + 2 mm (threads / holes modelled at nominal size). |
| Clip-nut slide | 40 + 6 snap | The mating sheet is **not** tolerated during the slide; only the final snap may touch it. |
| Tool working pose and retract sweep | Up to 130 mm along the axis | Nothing (1.5 mm tool tolerance). |
| Every tool-track segment | 8 per segment | Nothing (`_check_tool_path`). |
| Wrench stroke | Engaged, half-swung, swung, lifted, approach | Nothing. |
| Sub-assembly relative motions | 30 | Final seated contact only. |

Part penetration tolerance is 0.6 mm (coarse tessellation), tools 1.5 mm, caulking nozzle 1.2 mm.

**Rule C3 — No silent pass-through.** If no collision-free path exists:
1. **Find another valid approach.** Try another direction, ride offset, travel or option list (`clip_dir`,
   `choose_place`), a clearance height, or a route around the unit.
2. **Use another supplied tool or technique** that a mechanic would use:
   - the wrench instead of the drill where the drill body cannot reach;
   - the strain-relief hex turned from outside when the locknut has no swing room;
   - shorter wrench strokes in a narrow arc.
3. **If it is a CAD issue,** for example a screw whose hole is not modelled, keep the motion, record the check
   as not clear and **flag** it.
4. **Never widen `allow` sets to hide a collision.** Allowed contacts are only the documented mates at seating.
   A known CAD duplicate (Clip Nut (12)/(5) over (6)/(7)) is the one exception, and it is flagged.

**Rule C4 — Respect access.**
- Tools and components reach their location only through openings that exist.
- Tightening sense is right-hand: clockwise seen from the tool side (`sgn` in `fastener()`, `drill()`,
  `wrench()`).

Current state (v2.2): 161 checks, 158 clear. 18 of 19 tool paths and all 16 clip slides are clear. The three
not-clear checks are flagged CAD issues (see the engineering report): two bellmouth-plate screws without a modelled
hole, and the tap grazing two side-wall clearance holes that are about 0.5 mm off the screw axes.

---

## 5. D. Tool interaction

**Rule D1 — Common tool life cycle** (`_tool_pose_free`, `_clear_height`, `_hop_height`, `_route`, `_hop`):

1. **Roll.** Choose the roll about the working axis (12 candidates per hint) so that the tool clears the
   installed parts at the working pose **and along the whole straight retract** (0–130 mm).
2. **Approach** along the working axis from a clearance height. The first fastener starts at the operation's
   `first_clear` height or higher.
3. **Engage.**
   - Drill: stop 6 mm short, then the socket goes over the head.
   - Rivet gun: the nose sits 0.5 mm off the flange, then on it.
   - Wrench: the jaw is set to the measured hex + 0.3 mm before it appears.
4. **Operate** (operation-specific, below).
5. **Hop between fasteners.**
   - First try a straight hop at a clearance height, raising it in steps (+0 / 80 / 180 / 320 mm).
   - If no height works, route **around the unit** through one or two vertical edges or over the top of its
     box (margins of 140 / 220 / 320 mm).
   - The tool orientation is slerped along the route.
6. **Retract** along the axis to a clear height.

Every segment of the resulting track is collision-checked (§ 4).

**Rule D2 — Operation-specific behaviour (keep it specific):**

| Tool | Operation (as implemented) |
|---|---|
| **Drill + socket** (`drill`) | Socket resized radially to the measured hex and labelled. Engage, then the fastener turns home (4 turns, 0.3 s/turn) while **the drill body and socket stay still**. The orange **rotation arrow** shows the tightening. If no roll keeps the drill clear, hex heads fall back to the wrench (flagged). |
| **Rivet gun** (`rivet`) | Rivet inserted by hand first. Gun nose onto the flange, trigger and nose stroke, mandrel pulled and broken (`mandrels` fx). Rivets are worked **around the unit in angular order** (no back-and-forth through it). First two at full pace, then 0.6×. |
| **Adjustable wrench** (`wrench`) | Roll chosen so the **whole stroke** (engaged, half, swung, lifted, approach) is clear. 60° strokes, otherwise 45 / 30 / 25° with more strokes (flagged). Lift off, swing back, re-engage. Part rotation stays in step with the wrench. |
| **Caulking dispenser** (`bead`) | Nozzle follows the joint (48 keys) with a trailing tilt. Knob turns and plunger advances (`sub`). The bead grows along its path (`bead` fx) and stays applied in later steps. |
| **Marker** (`mark`) | A straight line from the head centre across its edge onto the clamped surface (`line` fx draws on). |
| **By hand** (`drive_with_hand`) | Only where no supplied tool can reach (checked) or none is needed. |
| *v2.2* **Drill + extension** (`drill(extension=…)`) | Drill body set back on a socket extension (generic Ø12 mm bar, labelled) where the body cannot reach: the motor-bracket bolt next to the front wall. Collision mesh includes the bar. |
| *v2.2* **Ratchet + deep socket** (`ratchet`) | Supplied Husky 3/8 in ratchet with the supplied deep socket (resized radially): slid on along the axis, short strokes, the handle swings back without lifting, slid off. Used where an open wrench has no swing room (L-connector locknut). |
| *v2.2* **Adjustable wrench, sideways / hold** (`wrench(approach="handle", hold=True, total_deg=…)`) | Slid onto flats along its handle where the axis is blocked (gauge stem through the box side opening); `hold` engages and holds a bolt head while the drill drives its nut (`release_wrench()`); `total_deg` = exact total turn (gauge ends dial-upright). |
| *v2.2* **Crimper** (`crimp`) | Ferrule slid onto the lead end; the open crimper (lower jaw and handle on their pins, `sub` channels `jaw` / `handle`) comes in along its handles until the die nest surrounds the ferrule, closes, opens, backs out. Roll chosen collision-free. Spliced pairs (`splices={lead: offset}`): both leads held side by side, one larger splice sleeve (`SPLICE`) centred between them, one crimp per pair. |
| *v2.2* **Tap drill** (`tap`) | Drill with the supplied tap (resized radially to the hole, labelled): align on the hole axis, cut through the sheet (tap turns, arrow clockwise), reverse out (arrow counter-clockwise), hop, retract. |
| *v2.2* **Caulking, other sealants** (`bead`, `bead_path`) | Colour per material (`SEALANT`: HT200 grey, silicone white) and the cartridge contents recoloured; `bead_path` follows a polyline with rounded corners, also on a staged part (`attach`, `xform`). |

**Rule D3 — Indicators instead of unrealistic tool motion.** When moving the tool would misrepresent the
operation, show an indicator instead. The reference case:
- **Do not rotate the drill to show tightening.**
- The `spinArrow` fx is a 270° orange (#ff7a1a) torus arc with a cone head, about the fastener axis.
  - Its radius is the socket radius + 7 mm, and it sits 14 mm out from the head along the tool side.
  - It is visible **only between engagement and seating** (`t:[t0, t1]`), fading in and out over 0.15 s.
  - It turns slowly in the tightening sense (clockwise from the tool side).
- It is lightweight (MeshBasicMaterial, a few hundred triangles). It is oriented per fastener axis and never
  alters the CAD fastener geometry.
- New indicators follow the same pattern: an fx type built at build time, styled in `public/js/unit/standards.js`,
  timed to the operation, and hidden outside it.
- *v2.2* **Rotation of a running impeller**: the same orange arrow, large, about the shaft in the sense of rotation
  (backward-curved blades: counter-clockwise seen from above).
- *v2.2* **Airflow** (`airflow` fx): blue (#2f8fff) arrows travelling along the physical air path while the
  impeller runs (`spin(airflow=dict(paths, allow))`: in through the filters and the bellmouth into the eye, radially
  out of the wheel, then up around the motor — never through a solid part: each path is sphere-checked, only porous
  media / blade passages allowed) — never orange, so rotation and airflow cannot be confused.
- *v2.2* **Formed-in-place gaskets**: a sealant bead laid with the caulking gun (`bead_path`), in the colour engineering
  specifies for the animation (door gasket: black silicone, Ø = the CAD gap); the foam-strip `gasket` fx stays for
  strip gaskets.
- *v2.2* **Dimension call-outs** (`dims` fx, `Step.dims`): orange lines, arrowheads, a reference ring at the
  datum and inch labels, shown only while the decal / label they position is applied.

**Rule D4 — Realistic tool appearance.**
- Tools are the supplied CAD models with their original geometry; never replace them with generic shapes.
- Where the STEP has no colours, assign materials by **mechanical function**, as `styleRivetGun` does:
  - orange housing accents;
  - dark rubber grip and guard;
  - satin steel nose and screws;
  - dark battery.
- Keep them matte to satin (roughness ≥ 0.38). Avoid textures unless the model has UVs. Where one solid has
  regions of different function, split it with a per-vertex colour (the grip at tool-frame x < −60 mm).

---

## 6. E. Assembly sequence

**Rule E1 — Follow real dependencies.** A part can be installed only when:
- its mating parts exist;
- its access path is open;
- the parts it fastens into are present.

Example (Phase 3, v2.2 — engineering request; v2.1 had the bracket fastened first):
- The drive motor is mounted on the motor mounting bracket on the bench: motor up to the bracket, lock washers and
  bolts started by hand, impeller wheel onto the shaft, bolts tightened, tightening marks.
- The assembly is lowered into the unit onto the clip nuts of the bracket supports, then the bracket is fastened
  (drill with extension on all four bolts).
- The inlet bellmouth is not attached to the wheel: it goes in from below with its mounting-plate hardware (Phase 4).
- The motor leads are routed, crimped and terminated before Phase 4 (they pass through the L-connector).

**Rule E2 — One installation per part.**
- Every one of the 223 CAD components (v2.2: `MF-550-210-B_GROUPED_ASSEMBLY_03` + the connector insert) is
  installed in exactly one step. This is checked by the build (`parts never installed`) and by the tests.
- Parts that come pre-installed with the main body are shown with `show()` in step 1 (no motion) and listed as
  hardware there. Example: the ten back-panel closed-end rivets.
- They stay in the BOM.

**Rule E3 — Changing the order is an engineering change.** Before reordering:
1. List the dependencies: what each step fastens into, what blocks its path.
2. Rebuild and look at the checks.
3. Update texts, hardware lines and phase titles.

Animation, camera shots, visibility (hidden → active → installed), progress and navigation all follow the data
automatically. Do not change step titles without changing the operations.

**Rule E4 — Independent modules stay independent.** Stage Filter 1, Stage Filter 2 and the HEPA filter are each
installed as one module in their own step (tested).

---

## 7. F. User experience

**Rule F1 — Clarity for the operator.**
- **Step card:** phase, a concise instruction, hardware lines (`Name – size × length – Quantity: n` with their
  measured status) and the tools.
- **Spoken text** (`speech`): the same instruction in shorter, natural sentences.
- **Steps tab:** grouped by phase.

**Rule F2 — No warning clutter.**
- No yellow or other attention colour in the operator UI. `--warn` is neutral grey (`app.css`).
- Open engineering items (`flags`) are **not** shown on the card or as badges. They live in the step data and in
  `docs/unit-engineering-report.md`.
- Genuine safety requirements are written into the **instruction text** in neutral form, for example "with the
  unit de-energised".

**Rule F3 — Visibility communicates state.**
- Parts of later steps are hidden. The current step's parts are highlighted.
- Inside operations use x-ray: the rest is ghosted and decals fade to 18 %.
- Earlier effects (beads, marks, decals) stay applied.

**Rule F4 — Exploded and components views.**
- **Parts tutorial:** ×6 pipeline vectors (2× v2.0) with a soft cap on the ~8 % longest, so the kit stays in the
  useful view.
- **Unit components view:** staging offsets ×2, capped at 0.75 m.
- In both, directions and relationships are unchanged.

**Rule F5 — Preserve the existing interaction model:**
- manual navigation only;
- PREVIOUS / NEXT;
- narration;
- right-hand gestures;
- collapsible side panel;
- AR;
- BOM and Parts list synchronised with the 3D view.

---

## 8. Validation workflow (mandatory)

Run this for **every** change that touches steps, animation, tools, camera or the interface. Do not report a
change as done until it passes.

1. **Rebuild the step data:**
   ```bash
   npm run unit:build          # python3 pipeline/unit/build_unit.py — ≈ 25 s, needs only the repository
   ```
   - It prints `N steps, M checks (K not clear)`. K must not grow unless the new item is a flagged CAD issue.
   - Read the per-step table in `docs/unit-engineering-report.md` (checks and camera).
   - Inputs are all tracked in git:
     - `pipeline/unit/unit-analysis.json` (CAD facts);
     - `pipeline/unit/cache/*.npz` (collision meshes of the parts and tools);
     - `public/assets/unit/tools/tools.json`, `decals/decals.json`;
     - the published `public/assets/unit/assembly.json`, whose nodes and BOM are reused and whose steps are
       rebuilt (byte-identical when nothing changed).
   - The STEP files are needed only for a new CAD revision or new tools: `docs/unit-tutorial.md` § 2 lists the
     regeneration chain (convert, analyse, build tools, rectify decals, build).
2. **Run the automated tests:** `npm test` runs 157 checks (v2.2): sections [1]–[13] on the parts tutorial and [14] on
   the unit tutorial, including every v2.1 rule. `ONLY=unit npm test` runs section [14] alone. Add checks for
   new rules.
3. **Do the visual review:**
   ```bash
   npm run unit:review                              # all steps, 4 frames each → index.html contact sheet
   npm run unit:review -- --steps 5-11 --frames 6  # the steps you changed
   ```
   Look at every frame of every changed step. Answer each question:
   - Is the installation location visible?
   - Is the tool visible at its working point?
   - Is the movement understandable?
   - Is anything important hidden?
   - Is the camera not too close or too far, and never inside the unit?
   - Does nothing pass through anything?
4. **Prove a refactor changed nothing.** If a change is meant to leave the result as it was, capture a baseline
   **before** changing anything:
   ```bash
   npm run unit:review -- --out /tmp/base
   # … make the change …
   npm run unit:review -- --out /tmp/after --compare /tmp/base   # "scene state identical"
   ```
   The fingerprint covers every part, tool, effect and camera transform per frame. Pixels differ slightly between
   identical runs in software WebGL; fingerprints do not. Also compare the build output:
   `sha1sum public/assets/unit/assembly.json` before and after.
5. **Parts tutorial.** If the explode scale, model or camera settings change, run `npm run camera:plans`.
6. **Check the live site.** After deployment, compare live file hashes with the merged files and load the live
   app headless with no page errors (§ 11).

---

## 9. Recipes

**Add or change an installation step** (`pipeline/unit/steps_unit.py`):

```python
s = U.step(phase=3, phaseTitle=P3, title="Fasten the motor mounting bracket",
           text="Insert the four hex flange bolts … and tighten them with the drill and a 3/8 in socket.",
           speech="Insert the four hex flange bolts …, and tighten them with the drill.",
           camera=dict(dir=[0.8, 1.0, 0.55], xray=True))          # preferred view + hints (§ 3, B6)
for n in brk_bolts: s.fastener(n, "bolt", dur=0.9)                # along their axes, hand-started
s.drill(brk_bolts)                                                # roll, approach, engage, arrow, hop, retract
s.hw(brk_bolts, "bracket ends, into the clip nuts")               # hardware lines with measured sizes
```

Step API (`build_unit.py`, class `Step`):

| Category | Methods |
|---|---|
| Parts | `place`, `fastener` (`bolt` / `screw` / `nut` / `washer` / `rivet` / `clip`), `drive_with_hand`, `show`, `spin`; *v2.2:* `stage`, `kit`, `Unit.bench_begin` / `bench_end`; *v2.3:* `bench_begin(names, offset, rot, pivot)` (rotated bench work, e.g. a plate turned over) |
| Tools | `drill`, `rivet`, `wrench`, `bead`, `mark`; *v2.2:* `bead_path`, `ratchet`, `crimp`, `tap`, `release_wrench`; *v2.3:* `ratchet(..., tool="torquewrench", depth=)`, `bead_helix` (sealant wound on a thread) |
| Effects | `decal`; *v2.2:* `sticker`, `gasket`, `dims`, motor leads (`leads_begin`, `lead_keys`, `crimp`, `leads_fx`, `check_leads`); *v2.3:* `prop` (worktable, shown only while used), `ziptie` (wrap → tight → tail cut, attached), `cable` (jacket with `rigid` / `base` / `morph` / `trim` / `growFrom`; leads with `core` slug and `twist`), `gasket(width=, thickness=, closed=False)` tape strips |
| Step meta *(v2.3)* | `camera.highlight = "soft"` (labels on the active part stay readable), `camera.callout = "outside"` (step label beside the model), `meta["check"] = dict(icon="listen", text=…)` (operator check line with an icon in the step card) |
| Pacing and focus | `wait`, and the `focus` attribute (parts the step's camera frames when it has no motion of its own) |
| Records | `hw`, `flag` |

Use `clip_dir()` and `choose_place()` for direction choices. Rebuild and validate (§ 8).

**Add a tool:**
1. Convert its STEP with `build_tools.py`: working frame with origin at the working point and +Y into the tool;
   moving parts listed in `tools.json`.
2. Write a Step method that follows the § 5 D1 life cycle with `_tool_pose_free` / `_clear_height` / `_hop`
   / `_check_tool_path`, and adds a `tool` shot.
3. Add its parameters as a namespace in `pipeline/unit/standards.py`.

**Add an indicator** (like `spinArrow`):
1. Emit an fx with its timing at build time, converted to metres in `Step.to_json`.
2. Build and animate it in `UnitRig.#buildFx` / `#applyFx`.
3. Style it from `public/js/unit/standards.js`.
4. Make it visible only during the operation.

**Adjust a step's camera.** Prefer changing the authoring hints (`camera.dir`, `xray`, `underside`) or the shot
radii in `standards.py`. Do not hand-place camera positions. Review the frames (§ 8).

---

## 10. Shared parameters

Shared values live in two modules. Each holds exactly the v2.1 reference values; moving them there changed
nothing (byte-identical build output, identical scene fingerprints).

**`pipeline/unit/standards.py` (build time; mm, s):**

| Namespace | Contents |
|---|---|
| `STEP` | Opening hold 1.5 s, end hold 0.9 s. |
| `PLACE` | Duration law (0.9 + L/260, 1.2–3.2 s), key spacing 40 mm, tilt removal, samples, close-up timing and radius. |
| `FASTENER` | Gap 18 mm, engagement (≤ 6 mm or 45 % of length), insert / hand-turn shares, hand turns 1.5, samples, mate margin, close-up radius. |
| `CLIP` | Travel 30 mm, ride offsets, 41 slide + 6 snap samples, snap timing. |
| `COLLISION` | Tolerances: parts 0.6, tools 1.5, caulking 1.2 mm; tool-path samples. |
| `TOOL` | Roll steps, retract sweep, clearance-height steps, hop raises, route margins and slowdown. |
| `DRILL` | Clear heights, engage / spin timings, 0.3 s per turn, socket depth, socket radius. |
| `SPIN_ARROW` | Margin 7 mm, axial offset 14 mm, sense −1 (clockwise from the tool side). |
| `RIVET` | Pace, clear heights, nose / pull / release timings, shot radii. |
| `WRENCH` | Thickness, jaw play, 60° swing with fallbacks 45/30/25°, roll steps, stroke timings. |
| `CAULKING` | Segments, approach, nozzle tilt, knob / plunger. |
| `MARK` | Approach, segment timing, line width and colour. |
| `CAMERA` | Minimum radii per shot kind, candidate grid, scoring weights, line-of-sight and inside tests, merge window, overview / result framing. |
| *v2.3* `ZIPTIE`, `STRIP`, `SPLICE`, `GASKET.tape_w / tape_t`, `SEALANT.gasket_d / joint_d` | Cable tie band / head / tail; outer jacket Ø and colour, conductor and strip lengths (0.50 in), core Ø and colour, slug slide, twist turns; splice sleeve; door gasket tape section (1 in × .187 in); silicone bead sizes. |
| *v2.2* `BENCH`, `CABLE`, `FERRULE`, `SPLICE`, `CRIMP`, `TAP`, `RATCHET`, `GASKET`, `SEALANT`, `DIMS`, `AIRFLOW` | Bench offset and kit position; 22 AWG lead size, bundle pitch, feed rate, follow length; ferrule; splice sleeve; crimper opening and timing; tapping feed; ratchet stroke; gasket section (CAD door gap); sealant colours (incl. the black silicone door gasket); dimension call-out style; airflow arrows, path profile and stream angles. Also `DRILL.extension_mm`, `DRILL.ext_r`, `WRENCH.approach_side`. |

**`public/js/unit/standards.js` (run time; m, s, rad):**

| Constant | Contents |
|---|---|
| `CAMERA_FOLLOW` | Smoothing 3.2 /s, lead 0.9 s / 70 %, padding 1.12, frame-time cap. |
| `SPIN_ARROW` | Colour, arc, tube and head proportions, fade, opacity, turn rate, render order. |
| `KIT_VIEW` | ×2, cap 0.75 m. |
| `XRAY` | Decal alpha 0.18. |
| `RIVET_GUN_STYLE` | Palette, roughness and metalness per solid, grip split. |
| `LOOP` | Hold 1.6 s. |
| *v2.2* `DIMS`, `AIRFLOW`, `CABLE`, `GASKET` | Call-out colours / font, airflow arrow style, lead tube and ferrule materials, gasket material. |

Operation-specific geometry stays in its operation: marker line shape, decal press keys, socket length of the
drill collision mesh. **Do not force unrelated operations into one generic motion.** Shared values are for things
that must be consistent across operations: timing feel, clearances, tolerances, camera rules and indicator style.

---

## 11. Publishing workflow

The workflow used for v2.0 and v2.1:

1. **Branch.** Inspect `git status` and `git log` first. Create a feature branch from up-to-date `main`. Never
   overwrite or discard existing user changes.
2. **Implement** following this standard. Validate (§ 8). Commit with a descriptive message ending with the
   attribution lines required by the session.
3. **Push.** Where the session cannot push (cloud sessions without repository credentials):
   1. Create the branch on GitHub (Branches → New branch).
   2. Hand the user a zip of the changed files to drag onto the branch's upload page.
   3. Commit there.
   4. Verify the uploaded tree hash equals the local commit's tree (`git rev-parse <commit>^{tree}`).
4. **Merge.** Open a PR with summary, tests and known limitations. Squash-merge only after validation. Keep the
   commit trailers. Never force-push.
5. **Verify the deployment.** GitHub Pages deploys `main` (`pages-build-deployment`). Compare live file hashes with
   the merged files. Load https://opinofaeroex.github.io/mf550-assembly/public/ headless: check the version,
   step count and data, and that there are no page errors.

Never claim a test or a deployment that was not actually run and verified.

---

## 12. Maintaining this standard

When a new technique proves itself, update this document in the same branch:
1. Name the rule.
2. Say what it does and which function implements it.
3. Add its parameters to `standards.py` / `standards.js`.
4. Add a test that enforces it.

Examples of proven techniques: a new tool life-cycle variant, a new indicator, a better camera scoring term.

When a rule has to be broken (a real mechanical exception), keep the rule. Document the exception in the step
(`flag`) and in the PR.

| Version | Change |
|---|---|
| 2.1 (`cc98332`) | Reference implementation: per-operation camera shots, collision-free clips and tool paths, vertical-first motions, Phase 3 dependency order, pre-installed rivets, drill rotation arrow, rivet-gun materials, exploded views ×2, no yellow warnings. |
| Standards (after 2.1, app version unchanged) | This document; shared parameters moved to `standards.py` / `standards.js` (no visible change, verified); `tools/unit-review.cjs` (contact sheet + scene fingerprints); `CLAUDE.md`. |
| 2.3 | Main-unit refinement: rotated bench sub-assemblies on a worktable (`prop`), torque wrench (`build_torque_wrench.py`, CC-BY model + supplied socket), rotation-arrow sticker and back-panel labels (`extract_labels.py`), cable ties (`ziptie`), jacketed motor cable with hood, jacket / insulation stripping, twisted pairs and the 0.50 in minimum dimension, connector hood (approximate) and data tag in the CAD (`cad_extras.py`), door gasket tape + silicone, soft highlight (`Appearance.STATE.SOFT`), outside step label (`Callout`), operator check line with icon; tool visibility resolved active-track-last at run time. Unaffected steps keep identical part and tool tracks (compared against v2.2). |
| 2.2 | Main-unit process update: `_03` CAD (L-connector) + connector insert (`merge_cad.py`, `analyse_unit.py --keep`); bench sub-assembly, staging + holds, kit positions; effects attached to parts; motor leads (`cable` fx, group supersede, end follow), crimper, ratchet, tap drill, drill extension, wrench hold / sideways / exact turn; gasket, sealant colours, stickers, dimension call-outs, airflow indicator; removed operations shown with the main body. Engineering review: 230/3/60 wiring with spliced pairs, black silicone door gasket by caulking gun, filter labels extracted from the photograph (`extract_stickers.py`), airflow along the real air path. |
