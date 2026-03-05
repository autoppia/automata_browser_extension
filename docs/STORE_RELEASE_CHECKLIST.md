# Chrome Web Store Release Checklist

## 1) Product metadata

- Name: `Automata Browser Extension`
- Short description (<= 132 chars)
- Full description (value proposition + permissions explanation)
- Category: Productivity / Developer Tools
- Support email set in publisher profile

## 2) Images and promotional assets

- Extension icon in package: 16, 48, 128 px
- Store icon: 128 px
- Small promo tile: 440x280
- Marquee promo tile: 1400x560 (optional but recommended)
- At least 1 screenshot (recommended 3-5)

## 3) Privacy and compliance

- Privacy policy URL published and reachable over HTTPS
- Data usage statement completed in Web Store dashboard
- Permission rationale written for:
  - `tabs`
  - `scripting`
  - host permissions (`http://*/*`, `https://*/*`)
- Verify no hidden/remote code loading

## 4) Technical preflight

Run:

```bash
./scripts/preflight_store_release.sh
./scripts/integration_operator_smoke.sh
./scripts/package_extension.sh
```

Artifacts:

- `dist/automata_browser_extension_v<version>.zip`

## 5) Functional QA

- Start operator locally (`127.0.0.1:5060`)
- Run a prompt on an http/https website
- Verify action execution + timeline + result
- Verify cancel flow
- Verify user input flow (`RequestUserInputAction`)
- Verify history load + clear
- Verify side panel opens from action icon

## 6) Release notes

Include in CWS submission:

- New UI polish and responsive layout
- Improved run event visibility
- Better local operator status signaling
- History management controls
- Stability improvements for local operator connectivity
