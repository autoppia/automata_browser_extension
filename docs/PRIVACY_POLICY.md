# Privacy Policy (Template)

Last updated: 2026-03-04

This policy describes how the Automata Browser Extension handles data.

## What the extension does

The extension provides a side panel to run browser automation tasks using a local operator endpoint (by default `http://127.0.0.1:5060`).

## Data we process

- Prompt text entered by the user
- Active page URL and page HTML snapshot required to execute automation
- Run history and run events stored locally in browser extension storage
- Optional API key/tokens for cloud auth bootstrap flows (when enabled)

## Storage

- `chrome.storage.local`: run history, refresh token, token metadata, local session metadata
- `chrome.storage.session` (when available): short-lived access token

Data is stored locally on the user's browser profile unless a future cloud feature is explicitly used.

## Network calls

The extension can send data to:

- Local operator endpoint (default `http://127.0.0.1:5060`)
- Optional cloud API endpoint (`https://api.automata.cloud`)

## Data sharing

We do not sell personal data. Data is only transmitted to endpoints required by the extension's automation features.

## Security

- Access tokens are kept in memory/session storage with expiration handling.
- Refresh tokens are stored in local extension storage and can be revoked by logout.

## Your controls

- You can clear run history in the extension UI.
- You can disconnect/logout to remove stored tokens.
- You can uninstall the extension to remove extension data.

## Contact

For privacy questions: `support@autoppia.com`
