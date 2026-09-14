"""Generate the bundled Material Symbols subset; Python is not needed at runtime or build time."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--tools-dir", type=Path)
args = parser.parse_args()
if args.tools_dir:
    sys.path.insert(0, str(args.tools_dir.resolve()))

import fontTools
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

root = Path(__file__).resolve().parent.parent
source = root / "node_modules/material-symbols/material-symbols-outlined.woff2"
font = TTFont(source, recalcTimestamp=False)
characters = {glyph: chr(code) for code, glyph in font.getBestCmap().items() if 32 <= code < 127}
symbols = {}
for lookup in font["GSUB"].table.LookupList.Lookup:
    for subtable in lookup.SubTable:
        if lookup.LookupType == 7:
            subtable = subtable.ExtSubTable
        for first, ligatures in getattr(subtable, "ligatures", {}).items():
            for ligature in ligatures:
                parts = [first, *ligature.Component]
                if all(part in characters for part in parts):
                    symbols["".join(characters[part] for part in parts)] = ligature.LigGlyph
if len(symbols) < 1000:
    raise RuntimeError("Unexpected source font ligature inventory")

used = set()
for file in (root / "src").rglob("*"):
    if file.suffix not in (".ts", ".vue") or file.name.endswith(".test.ts"):
        continue
    used.update(re.findall(r'''["']([a-z][a-z0-9_]*)["']''', file.read_text(encoding="utf-8")))
selected = sorted(used.intersection(symbols))
options = subset.Options()
options.layout_closure = False
options.recalc_timestamp = False
subsetter = subset.Subsetter(options=options)
subsetter.populate(glyphs=[symbols[name] for name in selected], unicodes=range(32, 127))
subsetter.subset(font)
axes = {"FILL": (0, 0, 1), "wght": 400, "GRAD": 0, "opsz": 24}
instantiateVariableFont(font, axes, inplace=True)
font.flavor = "woff2"
target = root / "public/fonts/monica-symbols.woff2"
font.save(target)
(root / "public/fonts/material-symbols-LICENSE.txt").write_bytes((source.parent / "LICENSE").read_bytes())
inventory = {
    "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "fontSha256": hashlib.sha256(target.read_bytes()).hexdigest(),
    "fontTools": fontTools.__version__,
    "axes": axes,
    "symbols": selected,
    "availableSymbols": sorted(symbols),
}
(root / "scripts/icon-font-inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Generated {len(selected)} icons: {source.stat().st_size:,} -> {target.stat().st_size:,} bytes")
