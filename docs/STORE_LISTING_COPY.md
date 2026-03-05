# Chrome Web Store Listing Copy

## Short Description

Automate browser tasks from a side panel using your local Automata Operator.

## Full Description

Automata Browser Extension gives you a clean side panel to run web automation prompts while you browse.

How it works:

- You type a task prompt in the side panel.
- The extension sends page context to your local Automata Operator endpoint.
- Returned actions are executed in your browser tab.
- You can follow run events in real time and review recent runs.

Built for local-first operation:

- Connects to a local operator endpoint (default `127.0.0.1:5060`)
- Includes run history and event timeline
- Supports human-in-the-loop input requests when an automation flow needs clarification

## Permission Rationale

- `tabs`: Required to read current tab context and navigate during automation runs.
- `scripting`: Required to execute action steps on the active webpage.
- `storage`: Required to persist run history, local session state, and optional auth tokens.
- Host permissions (`http://*/*`, `https://*/*`): Required to automate normal web pages selected by the user.
