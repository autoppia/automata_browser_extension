#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(python3 - <<'PY'
import json
from pathlib import Path
manifest = json.loads(Path("extension/manifest.json").read_text(encoding="utf-8"))
print(manifest.get("version", "0.0.0"))
PY
)"
OUT="$DIST_DIR/automata_browser_extension_v${VERSION}.zip"

mkdir -p "$DIST_DIR"
cd "$EXT_DIR"
rm -f "$OUT"
zip -r "$OUT" . -x "*.DS_Store"
echo "Packaged: $OUT"
