#!/usr/bin/env bash
set -euo pipefail

CANDIDATES=("http://127.0.0.1:18060" "http://localhost:18060")
BASE=""

echo "[integration] probing local operator health"
for c in "${CANDIDATES[@]}"; do
  if curl -fsS "$c/health" >/dev/null 2>&1; then
    BASE="$c"
    break
  fi
done

if [[ -z "$BASE" ]]; then
  echo "[integration] FAIL: local operator unreachable on 127.0.0.1:18060 and localhost:18060"
  exit 1
fi

echo "[integration] operator reachable at $BASE"
EXT_ORIGIN="chrome-extension://abcdefghijklmnopabcdefghijklmnop"

echo "[integration] validating CORS preflight for extension origin"
PREFLIGHT_HEADERS="$(curl -sS -i -X OPTIONS "$BASE/act" \
  -H "Origin: $EXT_ORIGIN" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type')"
if ! printf '%s\n' "$PREFLIGHT_HEADERS" | rg -qi '^HTTP/.* 200'; then
  echo "[integration] FAIL: /act preflight did not return HTTP 200"
  exit 1
fi
if ! printf '%s\n' "$PREFLIGHT_HEADERS" | rg -qi "access-control-allow-origin: $EXT_ORIGIN"; then
  echo "[integration] FAIL: /act missing access-control-allow-origin for extension origin"
  exit 1
fi

echo "[integration] validating PNA preflight for extension origin"
PNA_PREFLIGHT_HEADERS="$(curl -sS -i -X OPTIONS "$BASE/act" \
  -H "Origin: $EXT_ORIGIN" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  -H 'Access-Control-Request-Private-Network: true')"
if ! printf '%s\n' "$PNA_PREFLIGHT_HEADERS" | rg -qi '^HTTP/.* 200'; then
  echo "[integration] FAIL: /act private-network preflight did not return HTTP 200"
  exit 1
fi
if ! printf '%s\n' "$PNA_PREFLIGHT_HEADERS" | rg -qi 'access-control-allow-private-network: true'; then
  echo "[integration] FAIL: /act missing access-control-allow-private-network: true"
  exit 1
fi

ACT_PAYLOAD='{
  "protocol_version":"1.0",
  "task_id":"integration_smoke",
  "prompt":"go to metahash73.com",
  "url":"https://example.com/",
  "snapshot_html":"<html><body><a href=\"https://metahash73.com\">home</a></body></html>",
  "step_index":0,
  "history":[],
  "state_in":{},
  "allowed_tools":[
    {"name":"browser.navigate","description":"Navigate browser","parameters":{"type":"object","properties":{"url":{"type":"string"}}}},
    {"name":"browser.click","description":"Click element","parameters":{"type":"object","properties":{"selector":{"type":"object"}}}},
    {"name":"user.request_input","description":"Ask user input","parameters":{"type":"object","properties":{"prompt":{"type":"string"}}}}
  ],
  "include_reasoning":true
}'

ACT_JSON="$(curl -fsS -X POST "$BASE/act" \
  -H "Origin: $EXT_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d "$ACT_PAYLOAD")"

echo "[integration] validating /act response"
python3 - "$ACT_JSON" <<'PY'
import json
import sys

raw = str(sys.argv[1] if len(sys.argv) > 1 else "").strip()
if not raw:
    raise SystemExit("empty /act response")

obj = json.loads(raw)

tool_calls = obj.get("tool_calls")
actions_alias = obj.get("actions")
if isinstance(tool_calls, list):
    calls = tool_calls
elif isinstance(actions_alias, list):
    calls = actions_alias
else:
    raise SystemExit("invalid /act response: missing tool_calls/actions list")

if calls:
    first = calls[0]
    if not isinstance(first, dict):
        raise SystemExit("invalid first call in /act response")
    if "name" in first:
        if not str(first.get("name") or "").strip():
            raise SystemExit("invalid tool call name")
    elif "type" in first:
        if not str(first.get("type") or "").strip():
            raise SystemExit("invalid action type")
    else:
        raise SystemExit("invalid first call shape")

print("act response ok")
PY

echo "[integration] PASS"
