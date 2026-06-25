#!/bin/bash
# Genera build/icon.icns desde src/public/icon-muxlyve.svg usando sips + iconutil (macOS built-in).
set -e

SVG="src/public/icon-muxlyve.svg"
OUT="build/icon.icns"
TMP="build/tmp.iconset"

if [ -f "$OUT" ]; then
  echo "✓ build/icon.icns ya existe — saltando."
  exit 0
fi

if [ ! -f "$SVG" ]; then
  echo "✗ No se encontró $SVG" >&2; exit 1
fi

mkdir -p "$TMP"

for size in 16 32 128 256 512; do
  sips -s format png "$SVG" --out "$TMP/icon_${size}x${size}.png"        --resampleHeightWidth $size $((size)) 2>/dev/null
  sips -s format png "$SVG" --out "$TMP/icon_${size}x${size}@2x.png"     --resampleHeightWidth $((size*2)) $((size*2)) 2>/dev/null
done

iconutil -c icns "$TMP" -o "$OUT"
rm -rf "$TMP"
echo "✓ build/icon.icns generado"
