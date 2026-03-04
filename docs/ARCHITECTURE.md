# Architecture

## Product boundaries

- Extension executes browser runs using local `autoppia_operator` (`127.0.0.1:5060`).
- Local `automata` package remains separate (CLI/scripts).
- Cloud auth contract exists but is mocked for now.
- No cookie based web login.

## Components

- `service_worker` (background):
  - owns auth and token refresh logic
  - owns run state machine
  - captures page snapshot from active tab
  - calls local `/act` endpoint and executes returned actions via `chrome.scripting`
- `side_panel` (UI):
  - collects API key
  - sends prompt/start/cancel commands
  - renders run timeline and result

## Local run flow (implemented)

1. User submits prompt from side panel.
2. Background captures `url + snapshot_html` from active tab.
3. Background calls local `POST /act`.
4. Background executes returned actions in active tab.
5. Timeline/history update in side panel.

## Auth model (implemented with mocks for cloud)

1. User pastes `AUTOMATA_API_KEY` in side panel.
2. Background calls exchange endpoint (mock):
   - receives `access_token`, `refresh_token`, `expires_in`
3. Storage policy:
   - `refresh_token` in `chrome.storage.local`
   - `access_token` in memory and `chrome.storage.session` when available
4. On expired access token, refresh with `refresh_token`.
5. Logout revokes refresh token and clears local/session storage.

## Why no cookies

- extension auth is independent from web session cookies
- simpler for direct API usage
- avoids cookie lifetime/SameSite/browser state edge cases

## Future cloud endpoint contract

- `POST /v1/auth/exchange-api-key`
- `POST /v1/auth/refresh`
- `POST /v1/auth/revoke`
- `POST /v1/runs`
- `GET /v1/runs/{id}`
- `POST /v1/runs/{id}/cancel`
