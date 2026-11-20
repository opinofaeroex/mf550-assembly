# Unit installation tutorial — technical implementation report (v2.0)

The v2.0 tutorial shows how the **complete Mist-Fit 550 unit** is installed, starting from the assembled and
painted main body. It covers 32 steps in 9 phases, with tool operations, silicone, tightening marks and decals.
It is an extension of the existing application. The original 69-step parts tutorial is unchanged; the header
switch (*Unit installation · Parts assembly*) or `?tutorial=parts` opens it.

Engineering data, open items and validation results: **[unit-engineering-report.md](unit-engineering-report.md)**.

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

Results: 200 checks, 198 clear. The 2 that are not clear are two screws whose insertion path runs through the
support-track flange in the CAD; they are flagged.

Paths found this way (not assumed):

* The **bellmouth mounting plate** enters through the front filter opening, rises slightly set back from the
  front wall, then slides forward into its slot.
* The **stage filters** slide in from the front.
* The **impeller / motor** and the **HEPA filter** are lowered from above.
* The **motor bracket** is lowered with its clip nuts on the supports.
* The **bellmouth flange nuts** go on before their bolts, because they sit under the impeller shroud.

## 5. Interface changes (v2.0)

* **Larger 3D view.** The side panel is 340 px wide (was 400 px). It can be **collapsed to a 36 px strip** with
  its toggle or the `[` key; the choice is remembered. On phones it remains the bottom sheet.
* **Steps by default.** The unit tutorial opens the panel on **Steps**, grouped by phase, with each step's
  hardware, tools and a *check* badge for open engineering items. BOM and Parts list stay one click away.
* **Step card.** Shows the phase, the instruction, and hardware lines in the
  `Name – size × length – Quantity: n` format with their status. It also lists the tools and the flags.
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

The trigger test checks:

* single frames and 0.13 s blips never fire;
* a long hold fires exactly once, with its latency measured at 15 Hz and at 8 Hz;
* the opposite gesture is ignored until neutral;
* a one-frame drop-out is tolerated and low-confidence frames are ignored.

## 7. Known limitations

* Items without supplied engineering data are shown with a visible *requires engineering confirmation* note:
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
