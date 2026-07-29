# User Questions rich decision round

`variation-round.json` is a reusable question-round fixture covering:

- explicit boolean recommendations, longer details, and pros/cons/give-up tradeoffs;
- a multi-select question with five listed choices plus conditional Other text;
- a single-select question with four choices plus conditional Other text;
- an optional question answered with explicit Skip; and
- a required multi-select question whose minimum and maximum are validated.

The automated tests load this exact fixture, validate representative answers,
and verify that the enhanced and generic result contracts stay aligned.

## Non-UI protocol harness

Run the stdio protocol harness from the repository root with:

```sh
node tweaks/user-questions/examples/ask-variation-round.js
```

The harness starts the source `mcp-server.js` as a child process, negotiates MCP
`2025-11-25` with form elicitation, calls `ask`, and plays the role of a scripted
generic MCP client. It answers each real question in its own fallback form,
selects Other in one answer, explicitly skips the optional question, validates
rich details in the first form description, and checks the final preference
result before printing it.

This is a source-only protocol test. It does not connect to Codex, show the
enhanced card, create a resumable task-bound draft, change policy, or prove the
installed visual interface.

## Disposable candidate testing

After source validation and generated synchronization, use a disposable
candidate with isolated Tweakers and Codex data roots. In a fresh candidate
task, call `mcp__co_tweakers_user_questions__ask` with the contents of
`variation-round.json`.

Verify the one-question-at-a-time enhanced card, details disclosure, Recommended
badge, Back restoration, rounded-square multi-select, Other, explicit Skip,
Resume and Start over, review/submit, generic fallback parity, and visible
`display_failed` retry recovery. Check keyboard/focus behavior, screen-reader
labels, light/dark appearance, narrow layout, and 200% zoom.

Do not apply the optional policy change or restart the live app as part of this
example. Preview is read-only; Apply, Restore, and any later restart each require
their own explicit user action.
