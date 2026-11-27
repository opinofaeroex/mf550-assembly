#!/usr/bin/env python3
"""
extract_stickers.py — filter labels from the supplied reference photograph (v2.2)
=================================================================================

No artwork file was supplied for the two filter labels (Part # MF55-F001 / MF55-F002);
engineering asked for the labels to be taken from the PaperStickersLayers photograph.
For each label the four edges are fitted (robust line fits on the white label outline,
corners excluded), the label is perspective-rectified to 102 x 34 mm at 12 px/mm and the
paper is cleaned: the photographed print (text and arrow, exact shapes and layout) is
kept, the paper behind it (lighting, stains, smudges) is replaced by uniform label stock,
and the rounded label corners (r 3 mm) become the alpha channel.

The print is NOT redrawn: every glyph and the arrow come from the photograph
(~3.6 px/mm, upsampled). A vector original would replace these files 1:1.

Output: <out>/sticker-mf55-f001.png (lower label, 1st stage)
        <out>/sticker-mf55-f002.png (upper label, 2nd stage)

Usage: python3 pipeline/unit/extract_stickers.py PaperStickersLayers.jpg public/assets/unit/decals
"""
import sys
from pathlib import Path

import cv2
import numpy as np

W, H = 1224, 408                     # 102 x 34 mm at 12 px/mm
CORNER_R_MM = 3.0
PAPER = np.array([241, 242, 242], np.float32)   # BGR, neutral white label stock
INK = np.array([28, 26, 26], np.float32)
# search windows (x0, y0, x1, y1) in the 1536 x 2048-class photograph, and output file
LABELS = (((790, 1880, 1230, 2060), "sticker-mf55-f002.png"),   # upper label: 2nd stage
          ((780, 2080, 1220, 2250), "sticker-mf55-f001.png"))   # lower label: 1st stage


def label_mask(g, win):
    x0, y0, x1, y1 = win
    c = g[y0:y1, x0:x1]
    b = cv2.GaussianBlur(c, (0, 0), 2)
    mu = cv2.GaussianBlur(c, (0, 0), 5)
    var = cv2.GaussianBlur((c - mu) ** 2, (0, 0), 5)
    m = ((b > 172) | ((var < 30) & (b > 140))).astype(np.uint8) * 255   # bright, flat paper
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))  # fill the print
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((21, 21), np.uint8))   # cut thin leaks
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    i = 1 + int(np.argmax(st[1:, 4]))
    return lab == i, st[i]


def fit_line(pts):
    vx, vy, x, y = cv2.fitLine(np.array(pts, np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    return np.array([x, y]), np.array([vx, vy])


def intersect(l1, l2):
    (p, d), (q, e) = l1, l2
    t = np.linalg.solve(np.array([d, -e]).T, q - p)
    return p + t[0] * d


def corners(g, win):
    m, (bx, by, bw, bh, _) = label_mask(g, win)
    top, bot, lef, rig = [], [], [], []
    for x in range(int(bx + 0.2 * bw), int(bx + 0.8 * bw)):     # middle of each edge only:
        ys = np.nonzero(m[:, x])[0]                               # rounded corners and leaks
        if len(ys):                                               # are left out of the fit
            top.append((x, ys[0])); bot.append((x, ys[-1]))
    for y in range(int(by + 0.25 * bh), int(by + 0.75 * bh)):
        xs = np.nonzero(m[y, :])[0]
        if len(xs):
            lef.append((xs[0], y)); rig.append((xs[-1], y))
    L = [fit_line(top), fit_line(rig), fit_line(bot), fit_line(lef)]
    q = np.array([intersect(L[3], L[0]), intersect(L[0], L[1]), intersect(L[1], L[2]), intersect(L[2], L[3])])
    q += [win[0], win[1]]
    c = q.mean(0)        # inset ~1.5 px so no metal edge enters the warp
    return c + (q - c) * np.array([1 - 3 / np.linalg.norm(q[1] - q[0]), 1 - 3 / np.linalg.norm(q[3] - q[0])])


def rounded_alpha(w, h, r):
    a = np.zeros((h, w), np.uint8)
    cv2.rectangle(a, (r, 0), (w - 1 - r, h - 1), 255, -1)
    cv2.rectangle(a, (0, r), (w - 1, h - 1 - r), 255, -1)
    for cx, cy in ((r, r), (w - 1 - r, r), (r, h - 1 - r), (w - 1 - r, h - 1 - r)):
        cv2.circle(a, (cx, cy), r, 255, -1, cv2.LINE_AA)
    return a


def extract(img, win):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    q = corners(g, win)
    M = cv2.getPerspectiveTransform(q.astype(np.float32), np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
    war = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
    # flatten the illumination (closing removes the dark print from the background estimate)
    bg = cv2.GaussianBlur(cv2.morphologyEx(war, cv2.MORPH_CLOSE, np.ones((41, 41), np.uint8)), (0, 0), 40)
    flat = np.clip(war / np.maximum(bg, 1) * 244.0, 0, 255)
    lum = flat.mean(2, keepdims=True)
    flat = lum + (flat - lum) * 0.35                      # neutralise the lilac cast
    bl = cv2.GaussianBlur(flat, (0, 0), 2.2)
    flat = np.clip(flat * 1.6 - bl * 0.6, 0, 255)         # recover the upsampled print edges
    alpha = rounded_alpha(W, H, int(CORNER_R_MM * W / 102.0))
    # keep the print, replace the paper by uniform stock
    L = cv2.cvtColor(flat.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    paper_l = float(np.median(L[alpha > 0]))
    core = (L < paper_l - 45).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(cv2.dilate(core, np.ones((5, 5), np.uint8)))
    keep = np.zeros_like(core)
    for i in range(1, n):
        if st[i, 4] >= 60:                                # print groups; drops specks and faint smudges
            keep[lab == i] = 1
    zone = cv2.GaussianBlur(cv2.dilate(keep, np.ones((5, 5), np.uint8)).astype(np.float32), (0, 0), 1.2)[..., None]
    l_min = float(np.percentile(L[keep > 0], 4))
    ink = np.clip((paper_l - 12 - L) / (paper_l - 12 - l_min), 0, 1)[..., None] * zone
    out = PAPER * (1 - ink) + INK * ink
    return np.dstack([np.clip(out, 0, 255).astype(np.uint8), alpha]), q


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    img = cv2.imread(sys.argv[1])
    if img is None:
        sys.exit(f"cannot read {sys.argv[1]}")
    out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    for win, fn in LABELS:
        rgba, q = extract(img, win)
        cv2.imwrite(str(out / fn), rgba, [cv2.IMWRITE_PNG_COMPRESSION, 9])
        w = np.linalg.norm(q[1] - q[0]); h = np.linalg.norm(q[3] - q[0])
        print(f"{fn}: corners {[[round(float(v), 1) for v in c] for c in q]}  ({w:.0f} x {h:.0f} px in the photo)")


if __name__ == "__main__":
    main()
