#!/usr/bin/env bash
# Turn build/icon.png (1024x1024) into build/icon.icns for the app bundle.
set -euo pipefail
cd "$(dirname "$0")"

[ -f icon.png ] || { echo "icon.png missing — run: python3 build/make-icon.py"; exit 1; }

rm -rf icon.iconset && mkdir icon.iconset
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" icon.png --out "icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" icon.png --out "icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns
echo "✓ build/icon.icns ($(du -h icon.icns | cut -f1))"
