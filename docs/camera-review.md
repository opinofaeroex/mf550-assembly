# Automatic camera — review of all 69 steps

Generated from the running app (`app.cameraCtl.review()`, `scene/CameraController.js`). Every target is
computed from the components that `assembly.json` lists for the step (`steps[k].nodes`); nothing is
hand-placed or guessed. The view direction is chosen from 60 candidates by sight-line tests against the
real triangles of the parts that are drawn solid at that step (ghosted parts do not block), the install
direction (view across the motion), a natural elevation and the smallest turn from the current view.

Columns: focus radius = size of the framed region; travel shown = part of the approach path kept in
view; clear = share of sight lines from the components to the camera that are not blocked;
azimuth is measured around the vertical axis (0° = +Z side of the model, 90° = +X side).

| Step | Operation | Parts | Focus radius | Travel shown | View (elevation / azimuth) | Clear | Review |
|---:|---|---:|---:|---:|---|---:|---|
| 1 | Position the Gauge Box Enclosure | 1 | 76 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 2 | Install the Gauge Mounting Panel | 1 | 171 mm | 220 mm | 30° (slightly above) / 90° | 100 % | — |
| 3 | Fit the Pan Head Machine Screws | 6 | 152 mm | 93 mm | 10° (level) / 240° | 83 % | path approx. |
| 4 | Position the Unit Body | 1 | 415 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 5 | Install the Back Panel | 1 | 503 mm | 299 mm | 30° (slightly above) / 90° | 100 % | — |
| 6 | Install the Track Mount Legs | 2 | 289 mm | 299 mm | 72° (above) / 0° | 50 % | — |
| 7 | Install the Filter Element Track | 1 | 419 mm | 611 mm | 30° (slightly above) / 90° | 100 % | — |
| 8 | Install the Bellmouth Support Track | 1 | 412 mm | 616 mm | 72° (above) / 180° | 100 % | — |
| 9 | Fit the Clip Nuts (1/2) | 2 | 200 mm | 293 mm | -20° (from below) / 30° | 100 % | — |
| 10 | Install the Filter Base | 1 | 428 mm | 637 mm | 30° (slightly above) / 0° | 0 % | enclosed — x-ray |
| 11 | Install the Gauge Box Enclosure sub-assembly | 8 | 171 mm | 220 mm | 50° (from above) / 300° | 100 % | — |
| 12 | Install the Spring Nut Angle | 1 | 247 mm | 299 mm | 30° (slightly above) / 60° | 100 % | — |
| 13 | Fit the Self-Tapping Pan Head Screws | 4 | 183 mm | 218 mm | -20° (from below) / 270° | 100 % | path approx. |
| 14 | Fit the Clip Nuts (2/2) | 2 | 187 mm | 293 mm | 30° (slightly above) / 90° | 100 % | — |
| 15 | Install the Impeller Bracket Supports | 2 | 470 mm | 484 mm | 30° (slightly above) / 0° | 0 % | enclosed — x-ray |
| 16 | Install the Gauge Box Cover | 1 | 121 mm | 220 mm | 30° (slightly above) / 90° | 100 % | — |
| 17 | Position the Door Frame | 1 | 172 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 18 | Install the Access Door | 1 | 221 mm | 149 mm | 30° (slightly above) / 0° | 100 % | — |
| 19 | Fit the Closed-End Rivets | 6 | 169 mm | 118 mm | 30° (slightly above) / 0° | 100 % | path approx. |
| 20 | Position the Unit Body sub-assembly | 27 | 415 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 21 | Install the Filter Clamp Bolt Bracket (1/2) | 1 | 124 mm | 220 mm | 30° (slightly above) / 90° | 100 % | path approx. |
| 22 | Install the Access Door sub-assembly | 8 | 266 mm | 317 mm | 30° (slightly above) / 0° | 100 % | — |
| 23 | Install the Impeller Guard | 1 | 355 mm | 539 mm | 10° (level) / 300° | 100 % | — |
| 24 | Install the Filter Clamp | 1 | 271 mm | 317 mm | 30° (slightly above) / 0° | 100 % | — |
| 25 | Install the Filter Clamp Bolt Bracket (2/2) | 1 | 124 mm | 220 mm | 30° (slightly above) / 180° | 100 % | — |
| 26 | Position the Filter Frame Half | 2 | 551 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 27 | Install the Filter Frame Half (2/2) | 2 | 1052 mm | 1129 mm | 50° (from above) / 120° | 100 % | — |
| 28 | Fit the Blind Rivets (1/2) | 8 | 676 mm | 132 mm | 30° (slightly above) / 60° | 100 % | path approx. |
| 29 | Install the Filter Retaining Bars | 8 | 1210 mm | 682 mm | 30° (slightly above) / 0° | 25 % | enclosed — x-ray |
| 30 | Fit the Blind Rivets (2/2) | 16 | 541 mm | 132 mm | 30° (slightly above) / 0° | 100 % | path approx. |
| 31 | Position the Filter Frame Half sub-assembly | 18 | 254 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 32 | Fit the Blind Rivets | 4 | 359 mm | 132 mm | 30° (slightly above) / 30° | 100 % | path approx. |
| 33 | Install the Mesh Filter Media | 1 | 324 mm | 183 mm | 50° (from above) / 120° | 100 % | path approx. |
| 34 | Position the Filter Frame Half sub-assembly | 18 | 254 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 35 | Install the Perforated Filter Baffle (1/3) | 1 | 321 mm | 183 mm | 50° (from above) / 270° | 100 % | path approx. |
| 36 | Install the Perforated Filter Baffle (2/3) | 1 | 321 mm | 183 mm | 72° (above) / 330° | 100 % | path approx. |
| 37 | Install the Perforated Filter Baffle (3/3) | 1 | 321 mm | 183 mm | 50° (from above) / 150° | 100 % | path approx. |
| 38 | Position the Impeller Drive Motor unit | 12 | 227 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 39 | Install the Motor Mounting Bracket | 1 | 212 mm | 191 mm | 30° (slightly above) / 0° | 100 % | — |
| 40 | Fit the Motor Mounting Hex Bolts | 4 | 128 mm | 201 mm | 30° (slightly above) / 0° | 100 % | — |
| 41 | Fit the External Tooth Lock Washers | 4 | 83 mm | 89 mm | 30° (slightly above) / 0° | 100 % | — |
| 42 | Install the Bellmouth Mounting Plate | 1 | 369 mm | 567 mm | 30° (slightly above) / 0° | 100 % | — |
| 43 | Fit the Hex Flange Bolts | 6 | 237 mm | 274 mm | 30° (slightly above) / 30° | 83 % | — |
| 44 | Fit the Hex Flange Nuts | 6 | 194 mm | 122 mm | 10° (level) / 30° | 83 % | — |
| 45 | Position the Pleated Filter Housing Half | 1 | 275 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 46 | Install the Pleated Filter Housing Half (2/2) | 1 | 551 mm | 660 mm | 30° (slightly above) / 90° | 100 % | — |
| 47 | Fit the Blind Rivets | 10 | 378 mm | 139 mm | 30° (slightly above) / 30° | 100 % | path approx. |
| 48 | Position the Pleated Filter Housing Half sub-assembly | 12 | 276 mm | 0 mm | 30° (slightly above) / 0° | 100 % | — |
| 49 | Install the Pleated Filter Element | 1 | 344 mm | 200 mm | 50° (from above) / 300° | 100 % | path approx. |
| 50 | Install the Filter Gasket | 1 | 276 mm | 200 mm | -20° (from below) / 0° | 100 % | — |
| 51 | Position the Unit Body assembly | 39 | 441 mm | 0 mm | 10° (level) / 300° | 100 % | — |
| 52 | Fit the Cable Strain Relief | 1 | 133 mm | 220 mm | 30° (slightly above) / 0° | 100 % | — |
| 53 | Fit the Hex Flange Bolts (1/2) | 5 | 429 mm | 334 mm | -20° (from below) / 0° | 80 % | path approx. |
| 54 | Fit the Self-Tapping Pan Head Screws | 8 | 265 mm | 233 mm | 30° (slightly above) / 0° | 0 % | enclosed — x-ray, path approx. |
| 55 | Fit the Filter Clamp Hex Bolts | 2 | 332 mm | 471 mm | 30° (slightly above) / 30° | 100 % | — |
| 56 | Fit the Closed-End Rivets | 38 | 620 mm | 195 mm | 30° (slightly above) / 300° | 67 % | path approx. |
| 57 | Fit the Pan Head Machine Screws | 8 | 525 mm | 209 mm | 50° (from above) / 240° | 100 % | path approx. |
| 58 | Fit the Strain Relief Nut | 1 | 100 mm | 189 mm | 10° (level) / 270° | 100 % | — |
| 59 | Fit the Door Bolt Washers | 4 | 170 mm | 164 mm | -20° (from below) / 0° | 75 % | — |
| 60 | Fit the Pressure Gauge | 1 | 150 mm | 220 mm | 30° (slightly above) / 0° | 100 % | path approx. |
| 61 | Fit the Hex Nuts | 2 | 236 mm | 202 mm | -20° (from below) / 0° | 50 % | path approx. |
| 62 | Fit the Filter Clamp Knobs | 2 | 295 mm | 360 mm | 30° (slightly above) / 30° | 100 % | — |
| 63 | Fit the Clip Nuts (1/2) | 10 | 567 mm | 321 mm | -20° (from below) / 0° | 80 % | path approx. |
| 64 | Install the Mesh Filter Media sub-assembly | 23 | 393 mm | 334 mm | 30° (slightly above) / 0° | 0 % | enclosed — x-ray, path approx. |
| 65 | Install the Perforated Filter Baffle sub-assembly | 21 | 393 mm | 334 mm | 30° (slightly above) / 0° | 0 % | enclosed — x-ray, path approx. |
| 66 | Install the Impeller Drive Motor assembly | 34 | 372 mm | 334 mm | 72° (above) / 240° | 83 % | path approx. |
| 67 | Fit the Hex Flange Bolts (2/2) | 3 | 258 mm | 334 mm | 72° (above) / 150° | 67 % | path approx. |
| 68 | Fit the Clip Nuts (2/2) | 4 | 442 mm | 322 mm | 50° (from above) / 90° | 50 % | path approx. |
| 69 | Install the Pleated Filter Element sub-assembly | 14 | 507 mm | 665 mm | 30° (slightly above) / 0° | 80 % | — |

## Steps flagged for manual review

All 69 steps have a camera target derived from their own components. 6 steps install parts that are
enclosed by already-installed parts, so no outside viewpoint has a clear line of sight (0–25 % of sight
lines clear). The camera still frames them, and the orange **x-ray highlight** shows the parts through the
housing. If a different presentation is wanted (e.g. a cut-away or hiding a panel), add it for:

* **Step 10 — Install the Filter Base** (1 part, 0 % clear)
* **Step 15 — Install the Impeller Bracket Supports** (2 parts, 0 % clear)
* **Step 29 — Install the Filter Retaining Bars** (8 parts, 25 % clear)
* **Step 54 — Fit the Self-Tapping Pan Head Screws** (8 parts, 0 % clear)
* **Step 64 — Install the Mesh Filter Media sub-assembly** (23 parts, 0 % clear)
* **Step 65 — Install the Perforated Filter Baffle sub-assembly** (21 parts, 0 % clear)

Steps marked *path approx.* use an install path that the CAD geometry does not leave free (rivets,
threaded or captive hardware); the camera is correct, the motion is indicative (see README § 5).
