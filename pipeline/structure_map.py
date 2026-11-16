#!/usr/bin/env python3
"""
Structure map: recover the assembly structure for a re-named STEP export
=======================================================================

`MF-550-210-B_MIST_FIT_550_FINAL_NAMED.STEP` is a multi-body part whose 220 solid
bodies carry descriptive names ("Blind Rivet", "Filter Element Track", ...). The
previous export, `MF-550-210-B.STEP`, carries the SolidWorks component path in
each body name instead ("MF05-F002-A--2/M05SAF-0001-XD-1/099MHM-0001-18-solid1"),
which is where the sub-assembly hierarchy and the part numbers come from.

This tool proves that the two files describe the *same* CAD model and, only then,
writes a map  STEP entity id -> [descriptive name, component path, rank]  that
convert_step.py uses (--structure-map) to keep both: the new names and the
original hierarchy / part numbers.

Verification (all must hold, otherwise the tool exits with an error):
  * same set of entity ids;
  * every entity identical (whitespace-normalised) except MANIFOLD_SOLID_BREP;
  * for MANIFOLD_SOLID_BREP only the name differs, the referenced shell is the same.
i.e. geometry, topology, colours and placements are byte-for-byte the same model.

Usage
-----
    python3 pipeline/structure_map.py NEW.STEP --structure-from OLD.STEP \
        -o pipeline/structure-map.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

ENT_RE = re.compile(r"#(\d+)\s*=\s*(.*?);\s*(?:\n|$)", re.S)
BREP_RE = re.compile(r"^MANIFOLD_SOLID_BREP\s*\(\s*'((?:[^']|'')*)'\s*,\s*(#\d+)\s*\)$")


def entities(path: Path) -> dict[int, str]:
    text = path.read_bytes().decode("latin-1")
    body = text[text.index("DATA;"):]
    return {int(m.group(1)): re.sub(r"\s+", " ", m.group(2)).strip() for m in ENT_RE.finditer(body)}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", help="new STEP file (authoritative geometry and names)")
    ap.add_argument("--structure-from", required=True, help="earlier export of the same model with component paths")
    ap.add_argument("-o", "--out", default=str(Path(__file__).with_name("structure-map.json")))
    args = ap.parse_args()
    new_p, old_p = Path(args.step), Path(args.structure_from)

    new, old = entities(new_p), entities(old_p)
    if new.keys() != old.keys():
        print(f"ERROR: entity ids differ ({len(new)} vs {len(old)}): not the same model", file=sys.stderr)
        return 2
    rank = {eid: i for i, eid in enumerate(new, 1)}   # file order == OpenCascade model rank
    other, mapping = Counter(), {}
    for eid, nv in new.items():
        ov = old[eid]
        if nv == ov:
            continue
        mn, mo = BREP_RE.match(nv), BREP_RE.match(ov)
        if not (mn and mo and mn.group(2) == mo.group(2)):
            other[nv.split("(")[0].strip()] += 1
            continue
        mapping[eid] = (mn.group(1).replace("''", "'"), mo.group(1).replace("''", "'"), rank[eid])
    if other:
        print(f"ERROR: non-name differences found {dict(other)}: geometry is not identical", file=sys.stderr)
        return 3
    breps = sum(1 for v in new.values() if v.startswith("MANIFOLD_SOLID_BREP"))
    out = {
        "_comment": "STEP entity id -> [descriptive body name (new STEP), SolidWorks component path (earlier STEP), "
                    "entity rank in file order]. "
                    "Generated and verified by pipeline/structure_map.py: both files are identical except the "
                    "MANIFOLD_SOLID_BREP names.",
        "source": {"file": new_p.name, "bytes": new_p.stat().st_size, "sha256": sha256(new_p)},
        "structureFrom": {"file": old_p.name, "bytes": old_p.stat().st_size, "sha256": sha256(old_p)},
        "verification": {"entities": len(new), "solidBodies": breps, "renamedBodies": len(mapping),
                         "otherDifferences": 0},
        "bodies": {str(k): list(v) for k, v in sorted(mapping.items())},
    }
    bodies = out.pop("bodies")
    text = json.dumps(out, indent=1, ensure_ascii=False)[:-2]
    text += ',\n "bodies": {\n' + ",\n".join(
        f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in bodies.items()) + "\n }\n}\n"
    Path(args.out).write_text(text)
    names = Counter(v[0] for v in mapping.values())
    print(f"identical model: {len(new):,} entities, {breps} solid bodies, {len(mapping)} renamed, "
          f"{len(names)} distinct names -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
