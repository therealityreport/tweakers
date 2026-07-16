# Final review runtime diagnosis

The focused reproductions live beside each tweak under `test/`.

- UI Improvements previously mounted only ownership markers. The regression tests now require seven concrete DOM hooks, persisted enablement, and independent cleanup.
- Titlebar Controls previously applied only vertical translation. The layout fixture now verifies a two-axis measured transform and teardown restores the original inline state.
- Usage Limit Resets Tracker detected unknown stored schemas but rendered them like an empty history. The test now requires an explicit `Unknown` state without rewriting the stored value.
- Thread Summary Profiles only loaded newly-created mounts. Route and Projects-revision events now invalidate existing mount context and reload it.
- Shadcn Codex UI already used a deep `characterData` observer and bounded payloads; focused tests preserve those contracts.

## Source and runtime evidence

The concise root causes above are backed by the preserved diagnostic evidence,
reproduction commands, source digests, runtime limits, and fixed-test mappings:

- [Old Codex Chat UI root cause](diagnostics/codex-chat-ui-root-cause.md)
- [Thread Summary Profiles root cause](diagnostics/thread-summary-profiles-root-cause.md)
