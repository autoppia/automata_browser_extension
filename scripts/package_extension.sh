#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
OUT="$ROOT_DIR/automata_browser_extension.zip"

cd "$EXT_DIR"
rm -f "$OUT"
zip -r "$OUT" . -x "*.DS_Store"
echo "Packaged: $OUT"
