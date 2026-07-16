# User Questions variation round

`variation-round.json` is a reusable question-round fixture covering:

- a multi-select question with five choices and conditional inline Other input;
- a single-select question with four choices and conditional inline Other input;
- an optional single-select question;
- a required multi-select question with a minimum while every available choice remains selectable.

The automated tests load this exact fixture, validate representative answers,
and verify that every available multi-select choice can be selected together.

## Non-UI protocol harness

Run the stdio protocol harness from the repository root with:

```sh
node tweaks/user-questions/examples/ask-variation-round.js
```

The harness starts the source `mcp-server.js` as a child process, negotiates MCP
`2025-11-25` with form elicitation, calls `ask`, and plays the role of a scripted
MCP client. It answers every one-at-a-time question request, selects Other in
one answer, supplies its inline Other text, and validates the final structured
result before printing it. It also verifies that a separate required Other form
remains available as a compatibility fallback when inline text is absent.

This is a protocol test only. It does not connect to Codex, launch a popup, or
verify the installed visual interface.

## Real visual testing

After validation and `dev-sync`, start a fresh Codex task so it receives the
newly installed MCP registration. In that task, ask Codex to call the installed
`ask` tool from the `co-tweakers-user-questions` server (exposed as
`mcp__co_tweakers_user_questions__ask`) with the contents of
`variation-round.json`.

Verify in Codex that questions appear one at a time, the current task remains
visible, multi-select markers are rounded squares, and the Other text field is
hidden until Other is selected and then appears directly beneath that choice.
