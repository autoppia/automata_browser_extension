#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"

echo "[preflight] validating manifest JSON"
python3 - <<'PY'
import json
from pathlib import Path

manifest = json.loads(Path("extension/manifest.json").read_text(encoding="utf-8"))
required = ["manifest_version", "name", "version", "description", "permissions", "host_permissions", "action"]
missing = [k for k in required if k not in manifest]
if missing:
    raise SystemExit(f"Missing required manifest fields: {missing}")
if manifest.get("manifest_version") != 3:
    raise SystemExit("manifest_version must be 3")
print(f"manifest ok: {manifest.get('name')} v{manifest.get('version')}")
PY

echo "[preflight] checking javascript syntax"
node --check "$EXT_DIR/background/service_worker.js"
node --check "$EXT_DIR/background/token_manager.js"
node --check "$EXT_DIR/background/mock_cloud_api.js"
node --check "$EXT_DIR/sidepanel/app.js"

echo "[preflight] checking icons"
for size in 16 48 128; do
  test -f "$EXT_DIR/assets/icons/autoppia-${size}.png"
done

echo "[preflight] checking required docs"
test -f "$ROOT_DIR/docs/STORE_RELEASE_CHECKLIST.md"
test -f "$ROOT_DIR/docs/PRIVACY_POLICY.md"

if [[ "${RUN_OPERATOR_INTEGRATION_SMOKE:-0}" == "1" ]]; then
  echo "[preflight] running local operator integration smoke"
  "$ROOT_DIR/scripts/integration_operator_smoke.sh"
fi

echo "[preflight] done"
