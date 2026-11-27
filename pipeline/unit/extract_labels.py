#!/usr/bin/env python3
"""
extract_labels.py — back-panel labels and the motor-bracket rotation arrow from the supplied photographs (v2.3)
==============================================================================================================

No artwork files were supplied; engineering asked for the labels to be taken from the photographs:

  BackSticker1.jpg   Aeroex data tag (nameplate) and the CFM motor information sticker under it
  BackSticker2.jpg   orange WARNING and yellow CAUTION stickers under the information sticker
  MarksArrow.jpg     yellow rotation-arrow sticker on Motor Mounting Bracket-1 (next to the motor)

Each label is perspective-rectified from its four corners (picked on the photographs, listed below) to its
measured size at 10 px/mm, lightly flattened and sharpened. The print is NOT redrawn. The data tag's serial
number belongs to one unit, so its value box is blanked (engineering decision); the "Serial No:" field stays.
Sizes (mm) were measured with homographies fitted to parts whose CAD positions are known (back panel
rivets / data-tag screws for the back labels, the four motor bolts for the arrow; residuals < 1 mm).

Output: public/assets/unit/decals/{data-tag,motor-info,warning-disconnect,caution-disconnect,rotation-arrow}.png

Usage: python3 pipeline/unit/extract_labels.py BackSticker1.jpg BackSticker2.jpg MarksArrow.jpg OUT_DIR
"""
import sys
from pathlib import Path

import cv2
import numpy as np

PX_PER_MM = 10
# (photo index, file, corners TL TR BL BR in photo pixels, size mm (w, h))
LABELS = (
    (0, "data-tag.png", ((854, 478), (1285, 497), (851, 706), (1272, 721)), (100.4, 50.4)),
    (0, "motor-info.png", ((860, 712), (1257, 723), (860, 862), (1252, 869)), (94.6, 33.5)),
    (1, "warning-disconnect.png", ((665, 985), (842.5, 997.5), (662.5, 1090), (840, 1097.5)), (62.0, 36.0)),
    (1, "caution-disconnect.png", ((844, 997.5), (1015, 1005), (841, 1100), (1012.5, 1109)), (62.5, 37.0)),
    (2, "rotation-arrow.png", ((514, 1273), (596, 1273), (519, 1509), (596, 1509)), (26.0, 77.0)),
)
SERIAL_BOX = ((962, 563), (1040, 597))      # data tag: serial value box (photo 0 pixels) — blanked


def rectify(img, quad, size_mm):
    w, h = int(round(size_mm[0] * PX_PER_MM)), int(round(size_mm[1] * PX_PER_MM))
    src = np.float32(quad); dst = np.float32([[0, 0], [w, 0], [0, h], [w, h]])
    M = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return out, M


def finish(img, dark=False):
    f = img.astype(np.float32)
    lum = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    bg = cv2.GaussianBlur(lum, (0, 0), 60)                                # slow lighting gradient only,
    f = f * (float(np.median(bg)) / np.maximum(bg, 1))[..., None]         # same factor on every channel (hue kept)
    lo, hi = np.percentile(f, 1.5), np.percentile(f, 99.5)                # contrast stretch (photo haze)
    f = (f - lo) / max(hi - lo, 1) * 255
    if dark:                                                              # nameplate: deepen the black
        f = (f - 10) * 1.1
    bl = cv2.GaussianBlur(f, (0, 0), 1.6)
    return np.clip(f * 1.5 - bl * 0.5, 0, 255).astype(np.uint8)


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    photos = [cv2.imread(p) for p in sys.argv[1:4]]
    out = Path(sys.argv[4]); out.mkdir(parents=True, exist_ok=True)
    for idx, fn, quad, size in LABELS:
        im, M = rectify(photos[idx], quad, size)
        if fn == "data-tag.png":
            (x0, y0), (x1, y1) = SERIAL_BOX
            box = cv2.perspectiveTransform(np.float32([[(x0, y0), (x1, y0), (x0, y1), (x1, y1)]]), M)[0]
            a, b = box.min(0).astype(int) + 4, box.max(0).astype(int) - 4
            plate = np.median(im[a[1]:b[1], a[0]:b[0]].reshape(-1, 3), axis=0) * 0 + np.median(im[5:40, 5:40].reshape(-1, 3), axis=0)
            im[a[1]:b[1], a[0]:b[0]] = plate.astype(np.uint8)
        im = finish(im, dark=fn == "data-tag.png")
        cv2.imwrite(str(out / fn), im, [cv2.IMWRITE_PNG_COMPRESSION, 9])
        print(f"{fn}: {im.shape[1]} x {im.shape[0]} px ({size[0]} x {size[1]} mm)")


if __name__ == "__main__":
    main()
