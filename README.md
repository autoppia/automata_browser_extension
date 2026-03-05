# automata_browser_extension

Chrome MV3 side panel extension for Automata Cloud.

Status: local-first beta with real local operator execution (`/act`) + optional mocked cloud auth bootstrap.

## Goals

- Side panel UX (no global UI injection into every page)
- Local execution loop against `autoppia_operator` endpoint (`http://127.0.0.1:5060/act`)
- Optional API key auth bootstrap flow (mocked cloud endpoints for now)
- Prompt -> run -> action timeline -> result flow
- Canonical IWA `/act` response support (`protocol_version`, `execution_mode`, `done`)
- Human-in-the-loop flow for `RequestUserInputAction` prompts
- Local workflow recording + replay
- Workflow-as-tool bridge via `RunWorkflowAction` with recovery-friendly logs

## Current implementation

- `extension/background/service_worker.js`: runtime orchestration and real `/act` loop
  - local workflow recording/replay store
  - workflow tool abstraction for planner (`RunWorkflowAction`)
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

## Record & Replay Workflows

In the sidepanel:

1. Go to **Automations**.
2. Click `Record`.
3. Perform your steps in the browser tab.
4. Click `Stop & Save`.
5. Replay anytime with `Run`.

Recorded automations are stored locally in extension storage and are exposed to planner prompts as local workflow tools. The planner can invoke them via `RunWorkflowAction`.

## Store Release Workflow

Run release preflight:

```bash
./scripts/preflight_store_release.sh
```

Run local operator integration smoke (detects unreachable local endpoint issues):

```bash
./scripts/integration_operator_smoke.sh
```

Include that smoke in preflight:

```bash
RUN_OPERATOR_INTEGRATION_SMOKE=1 ./scripts/preflight_store_release.sh
```

Build upload zip:

```bash
./scripts/package_extension.sh
```

Output:

- `dist/automata_browser_extension_v<version>.zip`

See:

- `docs/STORE_RELEASE_CHECKLIST.md`
- `docs/PRIVACY_POLICY.md`
- `docs/STORE_LISTING_COPY.md`
