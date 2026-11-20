# Unit installation tutorial — engineering accuracy report (v2.0)

Source: `MF-550-210-B_GROUPED_ASSEMBLY.step` (AP242). The STEP carries **no part numbers, descriptions or BOM data**
(only the material "Steel" on every part), so every size below is **measured from the modelled geometry**
(`pipeline/unit/analyse_unit.py`: cylindrical faces along the fastener axis, hex flats, overall length) and
inch / metric designations are the nearest standard size to the measurement. Nothing is marked *verified* because
no drawing or BOM was supplied to verify against.

## Hardware

| Component | Fastener type | Size | Length | Qty | Installed in step | Drive / tool | Verification status |
|---|---|---|---|---|---|---|---|
| Clip Nut | Clip nut (U-type) | hole Ø5.16 mm (1/4-20 tap size) | 12.3 × 24.2 × 14.5 mm | 8 | 2. Install the base clip nuts | pressed onto the panel edge | Measured from CAD geometry; thread (1/4-20?) inferred from hole size only |
| 1_Cable Strain Relief | Cable strain relief (gland) | thread OD Ø21.34 mm (1/2 in NPT) | 43.66 mm overall | 1 | 3. Seal and fit the cable strain relief | hex 23.9 mm A/F | Measured from CAD geometry; cable clamping range not in CAD |
| 2_Strain Relief Nut | Strain relief locknut | 1/2 in NPT (to suit gland) | 6.67 mm | 1 | 4. Tighten the strain relief nut | 26.4 mm A/F (adjustable wrench) | Measured from CAD geometry; — |
| Clip Nut | Clip nut (U-type) | hole Ø5.16 mm (1/4-20 tap size) | 12.3 × 24.2 × 14.5 mm | 4 | 6. Position the motor mounting bracket | pressed onto the panel edge | Measured from CAD geometry; thread (1/4-20?) inferred from hole size only |
| Hex Flange Bolt | Hex flange bolt | Ø6.35 mm (1/4 in) | 19.05 mm under flange (3/4 in) | 4 | 7. Fasten the motor mounting bracket | hex 9.44 mm A/F (3/8 in socket), flange Ø13.97 mm | Measured from CAD geometry; thread pitch (1/4-20 UNC?) and grade not in CAD |
| External Tooth Lock Washer | External tooth lock washer | ID Ø6.60 mm | OD Ø12.70 mm, 1.27 mm | 4 | 8. Install the external tooth lock washers | — | Measured from CAD geometry; material / standard not in CAD |
| Motor Mounting Hex Bolt | Hex head bolt | Ø6.00 mm shank (M6 class) | 12 mm under head | 4 | 9. Insert the motor mounting bolts | hex head 9.86 mm A/F (10 mm socket) | Measured from CAD geometry; thread designation (M6 × 1.0?), length 12 mm and grade not in CAD — engineering confirmation |
| Motor Mounting Hex Bolt | Hex head bolt | Ø6.00 mm shank (M6 class) | 12 mm under head | 4 | 10. Tighten the motor mounting bolts | hex head 9.86 mm A/F (10 mm socket) | Measured from CAD geometry; thread designation (M6 × 1.0?), length 12 mm and grade not in CAD — engineering confirmation |
| Motor Mounting Hex Bolt | Hex head bolt | Ø6.00 mm shank (M6 class) | 12 mm under head | 4 | 11. Mark the motor mounting bolts | hex head 9.86 mm A/F (10 mm socket) | Measured from CAD geometry; thread designation (M6 × 1.0?), length 12 mm and grade not in CAD — engineering confirmation |
| Self-Tapping Pan Head Screw | Self-tapping pan head screw | Ø4.09 mm | 9.52 mm under head (3/8 in) | 8 | 14. Fasten the bellmouth mounting plate | recessed head (drive type not modelled) | Measured from CAD geometry; screw size (#8?) and thread form not in CAD |
| Hex Flange Bolt | Hex flange bolt | Ø6.35 mm (1/4 in) | 19.05 mm under flange (3/4 in) | 6 | 15. Install the bellmouth hardware | hex 9.44 mm A/F (3/8 in socket), flange Ø13.97 mm | Measured from CAD geometry; thread pitch (1/4-20 UNC?) and grade not in CAD |
| Hex Flange Nut | Hex flange nut | Ø6.35 mm bore (1/4 in) | 5.64 mm high | 6 | 15. Install the bellmouth hardware | 11 mm A/F (7/16 in) | Measured from CAD geometry; thread pitch not in CAD |
| Clip Nut | Clip nut (U-type) | hole Ø5.16 mm (1/4-20 tap size) | 12.3 × 24.2 × 14.5 mm | 2 | 18. Install the filter cover | pressed onto the panel edge | Measured from CAD geometry; thread (1/4-20?) inferred from hole size only |
| Closed-End Rivet | Closed-End Rivet | Ø3.97 mm body (5/32 in) | 6.30 mm body, Ø6.26 mm flange | 6 | 18. Install the filter cover | blind-rivet gun | Measured from CAD geometry; grip range and material not in CAD |
| Door Bolt Washer | Stepped washer | ID Ø5.56 mm | OD Ø15.88 mm, 3.26 mm | 4 | 19. Fasten the filter cover | — | Measured from CAD — CONFLICT; bore Ø5.56 mm is smaller than the Ø6.35 mm bolt: probably a sealing washer modelled compressed — confirm part |
| Hex Flange Bolt | Hex flange bolt | Ø6.35 mm (1/4 in) | 19.05 mm under flange (3/4 in) | 4 | 19. Fasten the filter cover | hex 9.44 mm A/F (3/8 in socket), flange Ø13.97 mm | Measured from CAD geometry; thread pitch (1/4-20 UNC?) and grade not in CAD |
| Filter Clamp Bolt Bracket | Filter Clamp Bolt Bracket | — | — | 2 | 21. Install the filter clamp bolt brackets | — | Not measured; specification requires engineering confirmation |
| Pan Head Machine Screw | Pan head machine screw | Ø4.09 mm | 6.35 mm under head (1/4 in) | 4 | 21. Install the filter clamp bolt brackets | recessed head (drive type not modelled) | Measured from CAD geometry; thread designation ambiguous: #8 (4.17 mm) or M4 (4.00 mm) — engineering confirmation |
| Filter Clamp Hex Bolt | Hex head bolt | Ø9.525 mm (3/8 in) | 38.1 mm under head (1-1/2 in) | 2 | 21. Install the filter clamp bolt brackets | hex 14.12 mm A/F (9/16 in socket — the supplied socket) | Measured from CAD geometry; thread pitch and grade not in CAD |
| Hex Nut | Hex nut | Ø9.525 mm bore (3/8 in) | 8.33 mm high | 2 | 21. Install the filter clamp bolt brackets | 14.2 mm A/F (9/16 in) | Measured from CAD geometry; thread pitch not in CAD |
| Filter Clamp Knob | Filter Clamp Knob | — | — | 2 | 25. Install the filter clamp | — | Not measured; specification requires engineering confirmation |
| Pan Head Machine Screw | Pan head machine screw | Ø4.09 mm | 6.35 mm under head (1/4 in) | 2 | 26. Install the pressure gauge | recessed head (drive type not modelled) | Measured from CAD geometry; thread designation ambiguous: #8 (4.17 mm) or M4 (4.00 mm) — engineering confirmation |
| Pan Head Machine Screw | Pan head machine screw | Ø4.09 mm | 6.35 mm under head (1/4 in) | 2 | 27. Install the back panel screws | recessed head (drive type not modelled) | Measured from CAD geometry; thread designation ambiguous: #8 (4.17 mm) or M4 (4.00 mm) — engineering confirmation |
| Closed-End Rivet | Closed-End Rivet | Ø3.97 mm body (5/32 in) | 6.30 mm body, Ø6.26 mm flange | 13 | 28. Rivet the back panel | blind-rivet gun | Measured from CAD geometry; grip range and material not in CAD |
| Closed-End Rivet | Closed-End Rivet | Ø3.97 mm body (5/32 in) | 6.30 mm body, Ø6.26 mm flange | 9 | 29. Rivet the filter base | blind-rivet gun | Measured from CAD geometry; grip range and material not in CAD |
| Closed-End Rivet | Closed-End Rivet | Ø3.97 mm body (5/32 in) | 6.30 mm body, Ø6.26 mm flange | 12 | 30. Rivet the track mount legs | blind-rivet gun | Measured from CAD geometry; grip range and material not in CAD |
| Closed-End Rivet | Closed-End Rivet | Ø3.97 mm body (5/32 in) | 6.30 mm body, Ø6.26 mm flange | 4 | 31. Rivet the gauge box enclosure | blind-rivet gun | Measured from CAD geometry; grip range and material not in CAD |

Quantities counted in the CAD: 1_Cable Strain Relief × 1, 2_Strain Relief Nut × 1, Blind Rivet × 38, Clip Nut × 18, Closed-End Rivet × 44, Door Bolt Washer × 4, External Tooth Lock Washer × 4, Filter Clamp Bolt Bracket × 2, Filter Clamp Hex Bolt × 2, Hex Flange Bolt × 14, Hex Flange Nut × 6, Hex Nut × 2, Motor Mounting Hex Bolt × 4, Pan Head Machine Screw × 14, Self-Tapping Pan Head Screw × 12.

## Tools

| Tool | Supplied model | Used in steps | Note |
|---|---|---|---|
| drill | `cc2672ec-Drill_with_9-16_Deep_Socket.step` | 7, 10, 15, 19, 21, 26, 27 | cordless drill, 1/4in hex to 1/4in square adapter, 9/16in 6-point deep socket |
| rivetgun | `8a47df54-RivetGun.stp` | 18, 28, 29, 30, 31 | ACCUBIRD cordless blind-rivet gun |
| caulking | `Caulking_Dispenser_Complete.step` | 3 | screw-driven cartridge dispenser with WEICON HT300 (red) silicone - no trigger: the knob drives the screw |
| marker | `27252c7a-Marker.STEP` | 11 | Sharpie Fine Point Retractable (black) |
| wrench | `7a13adc8-Wrench.stp` | 4, 7 | adjustable wrench, jaws modelled closed - opened on the worm to the nut's measured width |

Missing tool models (identified, not substituted): 10 mm, 3/8 in and 7/16 in sockets (shown as the supplied 9/16 in
socket resized radially to the measured hex — labelled on screen), a screwdriver bit for the pan-head screws (placeholder
hex bit, labelled).

## Path and tool validation

Every part motion and tool pose is checked against the parts installed at that point (exact mesh collision, python-fcl,
coarse tessellation; penetrations under 0.6 mm and contacts with the mating parts in the final seating are tolerated).

| Step | Checks | Clear | Not clear (part: depth mm) |
|---|---|---|---|
| 1. Inspect the main body | 0 | 0 | — |
| 2. Install the base clip nuts | 8 | 8 | — |
| 3. Seal and fit the cable strain relief | 2 | 2 | — |
| 4. Tighten the strain relief nut | 2 | 2 | — |
| 5. Install the impeller and drive motor | 1 | 1 | — |
| 6. Position the motor mounting bracket | 5 | 5 | — |
| 7. Fasten the motor mounting bracket | 8 | 8 | — |
| 8. Install the external tooth lock washers | 4 | 4 | — |
| 9. Insert the motor mounting bolts | 4 | 4 | — |
| 10. Tighten the motor mounting bolts | 4 | 4 | — |
| 11. Mark the motor mounting bolts | 0 | 0 | — |
| 12. Install the impeller guard | 1 | 1 | — |
| 13. Install the bellmouth mounting plate | 1 | 1 | — |
| 14. Fasten the bellmouth mounting plate | 8 | 6 | screw Self-Tapping Pan Head Screw (10) → Bellmouth Support Track: 8.76; screw Self-Tapping Pan Head Screw (6) → Bellmouth Support Track: 8.76 |
| 15. Install the bellmouth hardware | 18 | 18 | — |
| 16. Install Stage Filter 1 | 1 | 1 | — |
| 17. Install Stage Filter 2 | 1 | 1 | — |
| 18. Install the filter cover | 15 | 15 | — |
| 19. Fasten the filter cover | 12 | 12 | — |
| 20. Apply the front panel decals | 0 | 0 | — |
| 21. Install the filter clamp bolt brackets | 16 | 16 | — |
| 22. Electrical cable connections | 0 | 0 | — |
| 23. Electrical system verification | 0 | 0 | — |
| 24. Install the HEPA filter | 1 | 1 | — |
| 25. Install the filter clamp | 3 | 3 | — |
| 26. Install the pressure gauge | 5 | 5 | — |
| 27. Install the back panel screws | 4 | 4 | — |
| 28. Rivet the back panel | 26 | 26 | — |
| 29. Rivet the filter base | 18 | 18 | — |
| 30. Rivet the track mount legs | 24 | 24 | — |
| 31. Rivet the gauge box enclosure | 8 | 8 | — |
| 32. Final assembly overview | 0 | 0 | — |

## Items requiring engineering confirmation

- **Step 3 – Seal and fit the cable strain relief:** Silicone type and bead size are not specified in the supplied data — the dispenser model's WEICON HT300 cartridge is shown
- **Step 5 – Install the impeller and drive motor:** Motor shaft fit and impeller retention are inside the CAD sub-assembly (no separate shaft hardware modelled)
- **Step 7 – Fasten the motor mounting bracket:** Drill body cannot reach Hex Flange Bolt (wall clearance in the CAD): tightened with the adjustable wrench (supplied) instead
- **Step 10 – Tighten the motor mounting bolts:** Tightening torque is not specified in the supplied data — engineering confirmation
- **Step 11 – Mark the motor mounting bolts:** No reference photograph for the tightening mark was supplied: a straight line across the head onto the bracket is shown — confirm the marking convention
- **Step 12 – Install the impeller guard:** The CAD has no fasteners on the impeller guard (the brief asks for 4 machine screws): fastener type, size and locations require engineering confirmation — not animated
- **Step 14 – Fasten the bellmouth mounting plate:** No supplied tool can reach these screws: the drill body clashes with the filter element track or the walls at all 8 positions (collision-checked) — a stubby or right-angle screwdriver is required (not supplied); the screws are shown turning in without a tool
- **Step 14 – Fasten the bellmouth mounting plate:** Insertion path of Self-Tapping Pan Head Screw (10), Self-Tapping Pan Head Screw (6) passes through the support-track flange in the CAD (no access hole modelled) — confirm
- **Step 14 – Fasten the bellmouth mounting plate:** Self-Tapping Pan Head Screw (10), Self-Tapping Pan Head Screw (6) touch only the support track in the CAD, not the plate — confirm hole positions
- **Step 15 – Install the bellmouth hardware:** The flange nuts sit under the impeller shroud (about 6 mm above the bolt tips), so they are placed on the plate first and the bolts are driven up into them from below
- **Step 15 – Install the bellmouth hardware:** Order check: with the motor bracket and guard already fitted, the nuts are reachable only from the side under the shroud — confirm whether the bellmouth plate and hardware should precede the motor bracket
- **Step 18 – Install the filter cover:** Clip Nut (12) / (5) overlap Clip Nut (6) / (7) of the main body at the same holes (duplicate in the CAD) — both are shown
- **Step 19 – Fasten the filter cover:** The brief lists the washers after the bolts; in the CAD each Door Bolt Washer sits under its bolt head, so it is fitted on the bolt first
- **Step 20 – Apply the front panel decals:** Decals are taken from the supplied photograph (perspective-rectified, ~0.6 px/mm source); replace with the vector artwork when available
- **Step 21 – Install the filter clamp bolt brackets:** Driver bit not supplied: a placeholder 1/4 in hex bit (labelled) is shown in the drill — drive type of the pan-head screws is not modelled in the CAD
- **Step 22 – Electrical cable connections:** No cables, connectors or electrical drawings are in the supplied data: wiring routing and terminations require engineering confirmation — not animated
- **Step 23 – Electrical system verification:** No test procedure, supply voltage, current or acceptance criteria were supplied — engineering confirmation; rotation direction not modelled
- **Step 25 – Install the filter clamp:** Clamp knob tightening (gasket compression) is not specified — hand-tight shown
- **Step 26 – Install the pressure gauge:** Gauge tubing / pressure connection is not in the CAD — engineering confirmation
- **Step 26 – Install the pressure gauge:** Driver bit not supplied: a placeholder 1/4 in hex bit (labelled) is shown in the drill — drive type of the pan-head screws is not modelled in the CAD
- **Step 27 – Install the back panel screws:** These two screws touch only the back panel in the CAD — their function (and any part they hold) requires engineering confirmation
- **Step 27 – Install the back panel screws:** Driver bit not supplied: a placeholder 1/4 in hex bit (labelled) is shown in the drill — drive type of the pan-head screws is not modelled in the CAD
- **Step 28 – Rivet the back panel:** These rivets join main-body parts but sit outside the MAIN BODY group in the CAD; they are riveted here as agreed
- **Step 29 – Rivet the filter base:** These rivets join main-body parts but sit outside the MAIN BODY group in the CAD; they are riveted here as agreed
- **Step 30 – Rivet the track mount legs:** These rivets join main-body parts but sit outside the MAIN BODY group in the CAD; they are riveted here as agreed
- **Step 31 – Rivet the gauge box enclosure:** These rivets join main-body parts but sit outside the MAIN BODY group in the CAD; they are riveted here as agreed
