# Unit installation tutorial — technical implementation report (v2.0, refined in v2.1)

The v2.0 tutorial shows how the **complete Mist-Fit 550 unit** is installed, starting from the assembled and
painted main body. It covers 32 steps in 9 phases, with tool operations, silicone, tightening marks and decals.
It is an extension of the existing application. The original 69-step parts tutorial is unchanged; the header
switch (*Unit installation · Parts assembly*) or `?tutorial=parts` opens it.

Engineering data, open items and validation results: **[unit-engineering-report.md](unit-engineering-report.md)**.

## v2.1 — camera, mechanical accuracy and sequence refinements

v2.1 refines the v2.0 tutorial in place (same pipeline, same runtime modules, same step data format plus
two optional fields). What changed and how:

**Automatic camera — per-operation shots (`build_unit.py` → `UnitCamera.js`).**

* At build time every operation records camera *shots* `[t, target, direction, radius]` in the model frame:
  * an opening **overview** of the step: the components at their starting points and where they go;
  * a **wide** view of every rigid placement (whole path), then a **close-up** of its mounting interface;
  * a **close-up** of every fastener as it is inserted;
  * a **tool** view of every drill / rivet-gun / wrench / marker / caulking operation;
  * a wider **result** view at the end.
* **Direction.** Candidates cover the sphere (elevations −55° … 70°, every 30° of azimuth) plus the step's
  preferred direction. Each is scored by:
  * closeness to the step's preferred view;
  * the insertion axis seen from the side (50°; 65° for tool views, so the tool and the joint are both seen);
  * a clear line of sight. A thin cylinder from the working point to the camera is collision-checked against
    the installed parts and, for tool views, against the tool body at its working pose. In x-ray steps only the
    step's own parts count, because the rest is ghosted.
  * a heavy penalty if the camera position is inside geometry (sphere test).
* **Zoom.** The radius is the framing sphere, with a minimum per kind: 62 mm for fasteners, 120 mm for tool
  operations and placements, the step's extent for overview and result. At run time
  `viewer.fitDistance(radius)` turns it into a distance, so the zoom adapts to the viewport and step card.
* **Run time.** `UnitCamera.update()` runs every frame (after the sequencer):
  * it blends target, direction and distance between consecutive shots on the step clock;
  * it smooths the result by orbiting about the target (direction slerp, log-distance), so it never cuts
    straight through the unit;
  * it pauses when the user orbits, zooms or pans, and never overrides them;
  * Refocus (or the next step) resumes at the current shot; a loop restart returns to the first shot.
  * The animation never depends on the camera.
* **Underside steps.** Base clip nuts, impeller lift and bellmouth set `camera.underside`, which hides the floor
  shadow. So does the components view, whose parts are staged below the base.

**Collision-aware motion (`build_unit.py`).** The main body is checked as its real parts (exact meshes in
FCL), not as a box, so access openings stay open.

* **Clip nuts.** They slide on with the mating sheet *not* tolerated. A small ride offset along the clip axis
  is searched (the spring legs over the sheet); only the final snap may touch the sheet (CAD clip/sheet
  interference). v2.0 tolerated the sheet for the whole slide.
* **Tools.**
  * The roll about the working axis must keep the whole straight retract along the axis clear (sampled up to
    130 mm), not only the working pose.
  * Hops between fasteners rise to a clearance height, or are routed around the unit (outside its box, via
    one or two vertical edges or over the top) when a straight hop would cross it.
  * Every segment of every tool track is sampled and recorded. Rivets are worked around the unit in angular
    order.
* **Wrench.** The roll must keep the whole stroke clear (engaged, swung, lifted off, approach).
  * One bracket bolt next to the front wall has only a 28° clear arc. It gets 25° strokes and is flagged.
  * The strain-relief locknut has no clear swing inside the chamber (233 mm wrench: a single ~10° gap). It is
    seated by hand and held, while the strain-relief hex is turned from outside. This is flagged.
* **Vertical first.**
  * Base clip nuts rise 40 mm straight up onto the bottom edge of the base flange.
  * The door clip nuts rise onto their flange.
  * The filter clamp bolt brackets come down from above, then in 40 mm.
  * The impeller rises from below (next point).

**Phase 3 order.** Position the motor mounting bracket → fasten it → lock washers → **impeller and drive motor**
→ motor bolts → tighten → mark.

* The bracket is now fitted first, with nothing in the way. Its overview shows it above its supports, then a
  close-up of the interface.
* The motor can then only come from below. The base is open (checked: the impeller assembly rises 640 mm
  straight up without touching anything).
  * Below the unit, the wheel slides up onto the motor shaft, then the inlet bellmouth rises under it. Both
    relative motions are checked mesh-to-mesh.
  * The assembly is then raised into the fitted bracket.
* The motor bolts thread into the motor, so inserting, tightening and marking them must follow it. They are
  the last three steps of the phase.

**Pre-installed rivets.**

* Closed-End Rivet (22), (23), (35), (24), (39), (37), (26), (27), (25), (36) join the back panel to the unit
  body. They are installed with the main body.
* They are visible at their CAD positions from step 1, listed as pre-installed hardware on step 1 and in the
  BOM, and never animated.
* *Rivet the back panel* now sets only the three back-panel/filter-base rivets. The rivet gun is still used in
  5 steps.

**Drill.**

* The drill travels to each fastener, aligns the socket and engages. Its body and socket then stay still.
* The fastener turns clockwise seen from the tool side, i.e. the right-hand tightening sense; v2.0 had the
  sign reversed for some.
* An orange curved arrow (`spinArrow` fx: 270° torus arc and cone, `MeshBasicMaterial` #ff7a1a, a few hundred
  triangles) around the fastener axis is visible only between engagement and seating. It fades in and out and
  turns slowly in the tightening sense.
* Hex parts end on a multiple of 60° instead of a whole turn (identical look), so wrench strokes and part
  rotation stay in step.

**Rivet gun materials (`UnitRig.js`).** The supplied model keeps its geometry and gets materials per solid:

* orange housing; the dark rubber grip is told apart from the housing by a per-vertex colour, because they are
  one solid;
* dark guard, battery and trigger;
* satin steel nose and screws.

No textures are needed or loaded (the model has no UVs), and roughness is ≥ 0.38 everywhere (not glossy).

**Exploded views ×2.**

* **Parts tutorial.** `explodeScale` goes from 3 to 6 (`config.js`). The 17 longest of 208 vectors (> 0.8 m
  at ×6) are soft-capped (`explodeSoftCap`, growth × 0.25 beyond 0.8 m, same direction), so the kit stays in
  the useful view; the other 191 are exactly 2× v2.0. The precomputed camera plans were regenerated.
* **Unit components view.** Staging offsets are doubled (`UnitRig.KIT_SCALE`), capped at 0.75 m
  (`KIT_MAX`, never shorter than v2.0). 111 of the 183 staged components are exactly 2×. The other 72 already
  start more than 0.375 m away on long approach paths (for example the impeller assembly from below, the HEPA
  filter and the stage filter modules) and are capped.

**Operator UI.**

* Yellow is gone: `--warn` is neutral grey, and the step note, *check* badges and conflict status are neutral.
* Open engineering items (`flags`) are no longer shown on the operator card. They stay in the step data and in
  the engineering report.
* Safety instructions are part of the step text (e.g. "with the unit de-energised").
* Decals fade with the ghosted body in x-ray steps.

## 1. Sources

| Input | Used for |
|---|---|
| `MF-550-210-B_GROUPED_ASSEMBLY.step` (AP242, Inventor) | Geometry, names, hierarchy, transforms and quantities. This is the primary reference. |
| `Drill_with_9-16_Deep_Socket.step` | Cordless drill, 1/4 in hex→square adapter and 9/16 in 6-point deep socket. |
| `RivetGun.stp` | ACCUBIRD cordless blind-rivet gun. |
| `Caulking_Dispenser_Complete.step` | Screw-driven cartridge dispenser with WEICON HT300 (red) silicone. |
| `Marker.STEP` | Sharpie Fine Point Retractable. |
| `Wrench.stp` | Adjustable wrench, about 233 mm. Not in the brief's list, but supplied, and used where it is the right tool. |
| `MISTFIT550_Decals.png` (photograph of the finished unit) | Front-panel decals and their positions. |

The STEP files carry **no part numbers, descriptions or BOM data**; only the material "Steel" is present.
So every hardware size is measured from the geometry and labelled with its verification status (see the report).

## 2. Pipeline (`pipeline/unit/`)

| Script | Output |
|---|---|
| `pipeline/convert_step.py` (existing, unchanged) | `public/assets/unit/MF-550-210-B_GROUPED_ASSEMBLY.glb` plus the converter `assembly.json`: 220 parts in 12 groups, node per component. |
| `analyse_unit.py` | `unit-analysis.json`. Per part: world bounding box. Per fastener: axis, head and tip points, cylinder diameters along the axis, hex widths across flats, length, and the parts it touches (exact B-rep distance < 0.25 mm). Also coarse meshes for the collision checks. |
| `build_tools.py` | `public/assets/unit/tools/*.glb` plus `tools.json`. Each tool keeps its geometry and proportions. It is re-framed so its working point (socket opening, rivet-gun nose, nozzle tip, marker tip, wrench jaw) is the origin and +Y points back into the tool. The moving components stay separate nodes, with their pivots and axes: socket, adapter and chuck; trigger and nose; knob screw, pressure plate and plunger; jaw and worm. |
| `rectify_decals.py` | `public/assets/unit/decals/*.png` plus `decals.json`. A homography is fitted to 8 points on the front face whose CAD positions are known: the 4 door bolts, the 2 top corners of the face and the 2 top corners of the door, with residuals under 3 px. The cream paint is removed and the result is split into the three decals. The artwork is not redrawn. |
| `unitlib.py`, `pathcheck.py` | Quaternion / delta-transform maths, and the collision world (python-fcl via trimesh) plus a ray-cast helper. |
| `steps_unit.py` | **The authored sequence**: phases, steps, operator text, spoken text, the components and hardware of each step, the tools and the flags. |
| `build_unit.py` | Resolves every action into time-keyed tracks, checks every motion and tool pose for collisions, and writes `public/assets/unit/assembly.json` and `docs/unit-engineering-report.md`. |

To rebuild after a CAD change:

```bash
python3 pipeline/convert_step.py MF-550-210-B_GROUPED_ASSEMBLY.step --out /tmp/unit
cp /tmp/unit/MF-550-210-B_GROUPED_ASSEMBLY.glb public/assets/unit/
python3 pipeline/unit/analyse_unit.py MF-550-210-B_GROUPED_ASSEMBLY.step
python3 pipeline/unit/build_tools.py <folder with the tool STEP files> public/assets/unit/tools
python3 pipeline/unit/rectify_decals.py MISTFIT550_Decals.png public/assets/unit/decals
python3 pipeline/unit/build_unit.py /tmp/unit/assembly.json
```

## 3. Step data and animation architecture

The animation logic lives in the data. The runtime only plays it back.

* **Step record** in `assembly.json → steps[]` has these fields:
  * `phase`, `phaseTitle`, `title`, `text` (operator instruction) and `speech`;
  * `nodes`: the components installed in the step;
  * `hardware[]`: name, quantity, type, size, length, drive, verification status and items to confirm;
  * `tools[]`, `flags[]`, `camera {dir, xray, close, wide}`, `focus`, `duration` and `checks[]`;
  * `tracks {parts, tools, fx}`.
* **Part track.** Keys are `[t, T(3), q(4), angle, ease]`. Each key is a rigid *delta* applied to the part's CAD
  pose: `D = Tr(T)·R(q)·Tr(P)·Rot(axis, angle)·Tr(−P)`. `axis` and `pivot` are the fastener axis and head point.
  * The last delta of every part is the identity, so parts end **exactly** at their CAD position and orientation
    (this is tested).
  * Total spins are whole turns.
  * A fastener started by hand in one step and tightened in the next carries its pose over between the steps.
* **Tool track.** Keys are `[t, position(3), quaternion(4)]`, the pose of the tool's working frame.
  * `sub` channels drive the moving components: socket, adapter and chuck rotation; trigger and nose stroke;
    knob rotation with plate travel; jaw opening and worm rotation.
  * The drill track also carries `socketScale` (the measured hex divided by 9/16 in) or
    `bit: "placeholder-hex"`.
  * A tool is visible only between its first and last key.
* **Effects:**
  * `bead`: a tube that grows along the joint path, in the cartridge's red;
  * `line`: the tightening mark;
  * `mandrels`: rivet mandrels that are pulled and break off;
  * `decal`: a textured plane that approaches and is pressed onto the panel.
* **Order of operations used by the tracks:**
  * washers before their bolts; bolts and screws approach along their own axis from the head side; nuts approach
    from the free end;
  * hand start (a few turns), then tool engagement, the drive turns, and retraction;
  * the tightening mark only after tightening.

Runtime (`public/js/unit/`):

| Module | Role |
|---|---|
| `UnitRig.js` | Applies part, tool and effect tracks in the model frame (the GLB root), loads the tool GLBs and decal textures, keeps completed work (beads, marks, decals) visible in later steps, and lays out the components at their starting points (the "components" position). |
| `UnitSequencer.js` | Same interface and events as `scene/Sequencer.js` (`change`, `stepstart`, `animstate`, `idle`, `loop`). Each step plays once and then loops after a hold. It never advances by itself and never duplicates objects. |
| `UnitCamera.js` | Same interface as `scene/CameraController.js`. It frames the step's components, their starting poses and every tool working point from the authored view direction. A user orbit pauses it until *Refocus* or the next step. |

Reused unchanged:

* the viewer, appearance states (installed / active / hidden / x-ray ghost), callouts, BOM and parts list;
* narration (browser voice; no recordings exist yet for the new texts), the gesture pipeline and AR;
* performance profiles, the dashboard and the benchmark.

`main.js` selects the tutorial (`?tutorial=` > saved choice > default `unit`) and swaps only the
sequencer, the camera controller and the appearance rule.

## 4. Path and tool validation

`build_unit.py` adds each part to an FCL collision world when its own motion has been recorded. Every later
motion is then sampled along its whole path against what is already installed:

* contacts with mating parts are allowed once a fastener's tip reaches them;
* clip nuts may straddle the flange they slide onto;
* tolerance is 0.6 mm for parts and 1.5 mm for tools.

Tools are checked at their working pose. The roll about the working axis is chosen so that the tool body clears
the unit. Where no roll clears, the fastener is tightened with the supplied adjustable wrench instead
(hex heads only); otherwise the case is flagged.

Results (v2.1, stricter rules above): 198 checks, 196 clear; every tool path (16) and every clip-nut slide
(14) is clear. The 2 that are not clear are two self-tapping screws whose insertion path runs through the
support-track flange in the CAD (no access hole modelled); they are flagged.

Paths found this way (not assumed):

* The **bellmouth mounting plate** enters through the front filter opening, rises slightly set back from the
  front wall, then slides forward into its slot.
* The **stage filters** slide in from the front.
* The **HEPA filter** is lowered from above; the **impeller / motor** rises from below into the fitted
  bracket (v2.1).
* The **motor bracket** is lowered with its clip nuts on the supports.
* The **bellmouth flange nuts** go on before their bolts, because they sit under the impeller shroud.

## 5. Interface changes (v2.0)

* **Larger 3D view.** The side panel is 340 px wide (was 400 px). It can be **collapsed to a 36 px strip** with
  its toggle or the `[` key; the choice is remembered. On phones it remains the bottom sheet.
* **Steps by default.** The unit tutorial opens the panel on **Steps**, grouped by phase, with each step's
  hardware and tools (v2.1: no *check* badge). BOM and Parts list stay one click away.
* **Step card.** Shows the phase, the instruction, and hardware lines in the
  `Name – size × length – Quantity: n` format with their status. It also lists the tools (v2.1: open
  engineering items are no longer shown on the card).
* **Gestures** (`gesture/GestureTrigger.js`). Time-based and smoothed:
  * evidence is an exponential average (τ = 110 ms), weighted by confidence (handedness score × thumb
    verticality);
  * a gesture fires after leading for 120 ms in at least 2 frames: about 0.27 s at 15 Hz and 0.25 s at 8 Hz,
    against 0.33 s and 0.63 s before;
  * re-arming needs 0.25 s of neutral, plus a 0.6 s cooldown;
  * thumbs-up and thumbs-down must lead each other by a margin;
  * low-confidence frames are ignored;
  * still right hand only; manual navigation is unchanged.

## 6. Tests performed

`npm test` runs sections [1]–[13] (the parts tutorial, pinned with `mf550.tutorial = parts`) and the new
section [14], which checks:

* the tutorial loads; Steps is the default tab; the switch is present;
* every one of the 220 components is installed in exactly one step;
* every part ends exactly at its CAD pose, and hand-offs between steps are continuous;
* the three filter modules are independent;
* hardware quantities equal the CAD counts, and every hardware line has a status;
* ≥ 97 % of the collision checks are clear and the rest are flagged;
* all five supplied tools are animated, with three socket sizes;
* the drill is visible only while used and its socket sits on the bolt head while turning;
* the silicone bead grows and persists;
* steps loop with no duplicated objects and never advance on their own;
* the decals are applied and kept;
* the side panel collapses (the 3D view widens);
* the camera pauses on user input and resumes on the next step;
* there are no page errors.

v2.1 adds:

* the base clip nuts start 40 mm straight below their seats, with an underside camera;
* the 10 pre-installed rivets are installed at step 1, never animated and get no rivet-gun operation, while the
  gun is still used in 5 steps;
* the Phase 3 order;
* no drill rotation channel, the drill body fixed during tightening, and the orange arrow visible only during
  tightening;
* every tool path and clip slide is collision-free;
* every step has its own shot plan, no camera is inside geometry, and the zoom range is checked;
* at run time the camera follows the shots, is never overridden while paused, returns on Refocus and on a loop
  restart;
* the rivet-gun materials;
* the unit components view at ×2;
* no yellow warning colour, note or badge.

Section [2] checks the parts-tutorial ×6 vectors and the soft cap.

The trigger test checks:

* single frames and 0.13 s blips never fire;
* a long hold fires exactly once, with its latency measured at 15 Hz and at 8 Hz;
* the opposite gesture is ignored until neutral;
* a one-frame drop-out is tolerated and low-confidence frames are ignored.

## 7. Known limitations

* Items without supplied engineering data are recorded as *requires engineering confirmation* (v2.1: in the
  hardware status lines and the engineering report, no longer as a warning note on the card):
  * torque values;
  * thread designations and grades;
  * guard fasteners;
  * wiring and the electrical test procedure;
  * the marking convention;
  * silicone specification;
  * the gauge connection.
  They are listed per step in the report.
* **No cables in the CAD.** The electrical steps show the cable entry and the motor; they do not invent wiring.
* **Missing tool models.** No 10 mm, 3/8 in or 7/16 in socket models were supplied: the supplied 9/16 in socket
  is resized radially to each measured hex and labelled. No screwdriver bit was supplied: an orange placeholder
  1/4 in hex bit is shown and labelled. The eight bellmouth-plate screws cannot be reached by the supplied drill
  (checked), so they are shown turning in without a tool and flagged.
* **Decal resolution.** The decals come from a photograph at about 0.6 px/mm. A vector original can replace the
  three PNGs one for one.
* **Paint colour.** The CAD colours are used for the model (grey); the photo shows a cream finish.
* **Pi profiles.** Lighter model tiers (Raspberry Pi profiles) are built for the parts tutorial only; the unit
  tutorial loads the full model.
* **Narration.** Uses the browser voice; natural-voice recordings for the new texts can be generated with the
  existing `tools/narration` workflow.
