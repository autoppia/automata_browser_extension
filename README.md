# automata_browser_extension

Chrome MV3 side panel extension for Automata Cloud.

Status: MVP with real local operator execution (`/act`) + mocked cloud auth endpoints.

## Goals

- Side panel UX (no global UI injection into every page)
- Local execution loop against `autoppia_operator` endpoint (`http://127.0.0.1:5060/act`)
- Optional API key auth bootstrap flow (mocked cloud endpoints for now)
- Prompt -> run -> action timeline -> result flow

## Current implementation

- `extension/background/service_worker.js`: runtime orchestration and real `/act` loop
- `extension/background/token_manager.js`: auth token lifecycle
- `extension/background/mock_cloud_api.js`: mocked cloud endpoints
- `extension/sidepanel/`: UI (connect, run, timeline)

## Load in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `automata_browser_extension/extension`
5. Pin extension and click the extension icon to open side panel

## Run Local Operator

Before using the extension run flow, start the local operator endpoint:

```bash
cd /home/usuario1/autoppia/operator/autoppia_operator
python -m uvicorn main:app --host 127.0.0.1 --port 5060
```

Health check:

```bash
curl -sS http://127.0.0.1:5060/health
```

## Notes

- Cloud auth calls are mocked on purpose for now.
- This repo does not depend on local `automata` package runtime.
