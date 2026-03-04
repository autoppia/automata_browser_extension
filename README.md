# automata_browser_extension

Chrome MV3 side panel extension for Automata Cloud.

Status: MVP foundation with mocked cloud calls.

## Goals

- Side panel UX (no global UI injection into every page)
- API key based auth flow for extension users
- Token lifecycle in extension (`access_token` + `refresh_token`), no cookies
- Prompt -> run -> timeline -> result flow

## Current implementation

- `extension/background/service_worker.js`: runtime orchestration and run simulation
- `extension/background/token_manager.js`: auth token lifecycle
- `extension/background/mock_cloud_api.js`: mocked cloud endpoints
- `extension/sidepanel/`: UI (connect, run, timeline)

## Load in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `automata_browser_extension/extension`
5. Pin extension and click the extension icon to open side panel

## Notes

- Cloud calls are mocked on purpose for now.
- This repo does not depend on local `automata` package runtime.
