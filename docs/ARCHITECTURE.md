# Architecture

## Product boundaries

- Extension talks to Automata Cloud API.
- Local `automata` package is separate and not required by extension.
- No cookie based web login.

## Components

- `service_worker` (background):
  - owns auth and token refresh logic
  - owns run state machine
  - is the only place that would call cloud API
- `side_panel` (UI):
  - collects API key
  - sends prompt/start/cancel commands
  - renders run timeline and result

## Auth model (implemented with mocks)

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
