#!/usr/bin/env python3
"""
rectify_decals.py — front-panel decals from the supplied reference photograph (v2.0)
====================================================================================

No separate artwork file was supplied, so the decals are taken from the photo of the
finished unit (MISTFIT550_Decals.png): the front face is rectified with a homography
fitted to 8 points whose CAD positions are known (4 access-door bolt heads, the 2 top
corners of the front face, the 2 top corners of the access door; residuals < 3 px),
the cream paint is removed (alpha from colour distance) and the result is split into
the three decals visible in the photo:

  1. AEROEX logo with rule      2. MIST-FIT      3. MF-550

Output: public/assets/unit/decals/<id>.png (RGBA) + decals.json (position and size of
each decal on the front face in CAD millimetres: z (left = +Z), y (up)).
The artwork is NOT redrawn: pixels come from the photograph (resolution ~0.6 px/mm,
upsampled to 4 px/mm). A vector original would replace these files 1:1.

Usage: python3 pipeline/unit/rectify_decals.py photo.png public/assets/unit/decals
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# (z, y) on the front face  ->  pixel (x, y) in the photo
CAD = [(114.3, -124.1), (-114.3, -124.1), (114.3, -273.3), (-114.3, -273.3),
       (189.3, 316.75), (-189.3, 316.75), (188.9, -113.8), (-188.9, -113.8)]
PIX = [(86.0, 437.5), (226.0, 473.5), (86.5, 548.0), (225.5, 602.5),
       (50, 107.5), (280, 67.5), (51, 420), (285, 475)]
REGION = dict(z0=178.0, z1=-160.0, y0=135.0, y1=305.0)   # generous area around the decals
PX_PER_MM = 4


def fit(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u]); A.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vt = np.linalg.svd(np.array(A, float))
    H = vt[-1].reshape(3, 3)
    return H / H[2, 2]


def main():
    photo, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    H = fit(CAD, PIX)
    img = Image.open(photo).convert("RGB")
    big = img.resize((img.width * 4, img.height * 4), Image.LANCZOS)   # sample a smooth upscaled photo
    src = np.asarray(big).astype(float)
    R = REGION
    W = int(round(abs(R["z1"] - R["z0"]) * PX_PER_MM)); Hh = int(round((R["y1"] - R["y0"]) * PX_PER_MM))
    zz = R["z0"] + (R["z1"] - R["z0"]) * (np.arange(W) + 0.5) / W
    yy = R["y1"] - (R["y1"] - R["y0"]) * (np.arange(Hh) + 0.5) / Hh
    Z, Y = np.meshgrid(zz, yy)
    P = H @ np.stack([Z.ravel(), Y.ravel(), np.ones(Z.size)])
    px = (P[0] / P[2]) * 4 - 0.5; py = (P[1] / P[2]) * 4 - 0.5
    x0 = np.clip(np.floor(px).astype(int), 0, src.shape[1] - 2); y0 = np.clip(np.floor(py).astype(int), 0, src.shape[0] - 2)
    fx = (px - x0)[:, None]; fy = (py - y0)[:, None]
    rgb = (src[y0, x0] * (1 - fx) * (1 - fy) + src[y0, x0 + 1] * fx * (1 - fy)
           + src[y0 + 1, x0] * (1 - fx) * fy + src[y0 + 1, x0 + 1] * fx * fy).reshape(Hh, W, 3)
    # local paint colour (shading varies across the face): heavy blur of the light pixels
    lum = rgb.mean(axis=2)
    light = np.where(lum[..., None] > np.percentile(lum, 40), rgb, np.nan)
    bg = np.empty_like(rgb)
    for c in range(3):
        ch = light[..., c]; fill = np.nanmedian(ch)
        im = Image.fromarray(np.clip(np.nan_to_num(ch, nan=fill), 0, 255).astype(np.uint8), mode="L").filter(ImageFilter.GaussianBlur(40))
        bg[..., c] = np.asarray(im).astype(float)
    dist = np.linalg.norm(rgb - bg, axis=2)
    alpha = np.clip((dist - 28) / (90 - 28), 0, 1)
    a3 = np.maximum(alpha, 1e-3)[..., None]
    col = np.clip((rgb - (1 - a3) * bg) / a3, 0, 255)
    rgba = np.dstack([col, alpha * 255]).astype(np.uint8)
    # split into decals by empty rows between bands of content
    rows = (alpha > 0.5).sum(axis=1) > 2
    bands, inside = [], False
    for i, r in enumerate(rows):
        if r and not inside: start, inside = i, True
        if not r and inside:
            if i - start > 6: bands.append((start, i))
            inside = False
    if inside: bands.append((start, len(rows)))
    names = ["aeroex-logo", "mist-fit", "mf-550"]
    if len(bands) != 3:
        raise SystemExit(f"expected 3 decal bands, found {len(bands)}: {bands}")
    meta = []
    for nm, (r0, r1) in zip(names, bands):
        cols = np.nonzero((alpha[r0:r1] > 0.5).sum(axis=0) > 0)[0]
        c0, c1 = max(0, cols.min() - 8), min(W, cols.max() + 9)
        r0m, r1m = max(0, r0 - 8), min(Hh, r1 + 8)
        Image.fromarray(rgba[r0m:r1m, c0:c1]).save(out / f"{nm}.png", optimize=True)
        z_left = R["z0"] + (R["z1"] - R["z0"]) * c0 / W; z_right = R["z0"] + (R["z1"] - R["z0"]) * c1 / W
        y_top = R["y1"] - (R["y1"] - R["y0"]) * r0m / Hh; y_bot = R["y1"] - (R["y1"] - R["y0"]) * r1m / Hh
        meta.append(dict(id=nm, file=f"{nm}.png", zLeft=round(z_left, 1), zRight=round(z_right, 1),
                         yTop=round(y_top, 1), yBottom=round(y_bot, 1),
                         widthMm=round(abs(z_right - z_left), 1), heightMm=round(y_top - y_bot, 1)))
    json.dump(dict(source=photo.name, method="homography rectification of the reference photograph (8 CAD-located points)",
                   face="front (+X), x = 0 mm", decals=meta), open(out / "decals.json", "w"), indent=1)
    for m in meta: print(m)


if __name__ == "__main__":
    main()
