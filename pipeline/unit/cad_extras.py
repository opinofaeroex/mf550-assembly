"""
cad_extras.py — placements and sizes of the parts added to the unit CAD by merge_cad.py (v2.3)
=============================================================================================

Plain data shared by merge_cad.py (geometry) and steps_unit.py (animation). Model frame: mm, Y up,
front = +X, back panel outer face x = -378.6; seen from behind the unit, the viewer's left is -Z.

Measured on the supplied photographs (perspective-rectified with homographies fitted to parts whose CAD
positions are known — back panel rivets, the data-tag screws, the motor mounting bolts; residuals < 1 mm),
NOT drawing values — every value below is flagged in the engineering report.
"""

BACK_FACE_X = -378.6

# ---- CSHM 06 connector insert (ILME, supplied cshm_06.stp, one solid) — v2.3: inside the connector hood.
# CableDisposition photographs: the hood hangs at the lower left of the back panel at the end of the cable
# loop. Insert long side (50 mm) perpendicular to the back panel, wire side (+Z of the supplied model, the
# six SQUICH cavities) UP towards the hood's cable gland, mating side down at the hood's open end.
CONNECTOR = dict(centre_local=(57.3, 28.7, 0.6), centre=(-417.0, -184.0, -17.6),
                 R=((1, 0, 0), (0, 0, 1), (0, -1, 0)))     # rows: model x, y, z from the local x, y, z
CONNECTOR_RGB = (0.62, 0.64, 0.66)                         # grey thermoplastic insert

# ---- Connector hood: connector_cover_approx.step (supplied in the Downloads folder; its header: "approximate
# faceted 3D model reconstructed from user photograph; dimensions assumed"), used as instructed by engineering.
# Its 43 x 23 mm body cannot hold the 50 x 34 mm insert, so it is scaled to the photographed envelope
# (48.7 mm wide seen from behind, gland top y -92, open end y -204) and to enclose the insert; the cable
# gland keeps a round section. APPROXIMATE — replace with the manufacturer's hood model when available.
HOOD = dict(name="Connector Hood", axis_x=-417.0, axis_z=-17.6, y_top=-92.0, y_open=-204.0,
            body_scale=(1.30, 2.10),                       # cover x -> model x (depth), cover y -> model z (width)
            gland_scale=1.40, gland_to=2.0, blend_to=9.0,  # cover z < gland_to: round gland, blended until blend_to
            rgb=(0.20, 0.21, 0.22))                        # grey hood (linear RGB)

# ---- Data tag (Aeroex nameplate): BackSticker photographs + work instruction ("rivet data tag to unit") —
# held by the CAD's two back panel pan head machine screws (10)/(11) at z ±46.4, y 215.2, which the
# photographs show at the tag ends (measured -46.5 / +45.2, 215.4). Size measured 100.4 x 50.4 mm.
DATA_TAG = dict(name="Data Tag", centre=(-0.7, 214.4), width=100.4, height=50.4, thickness=0.8,
                hole_d=4.5, holes=((46.434, 215.151), (-46.434, 215.151)), rgb=(0.012, 0.012, 0.013))

# ---- L-connector group: black (engineering v2.3), industrial satin black (linear RGB)
L_CONNECTOR_PARTS = ("NPTA12_L_body_with_seal", "NPTA12_o_ring", "NPTA12_sealing_nut", "NPTA12_locknut")
L_CONNECTOR_RGB = (0.010, 0.010, 0.011)
