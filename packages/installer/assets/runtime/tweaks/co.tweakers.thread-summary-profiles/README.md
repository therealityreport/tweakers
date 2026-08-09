# Thread Summary Profiles

This renderer tweak reads the existing `profiles.read` projection and displays
only the sanitized, read-only profile rows for the active thread project. It
does not write profile, project, account, browser, or session state.

## Identity and privacy contract

A usable project identity has a project ID or workspace path. A name-only host
context is not an identity and falls back to the nearest project-marked summary
panel. The selected ID, workspace path, and route are kept in private per-mount
memory. The DOM exposes only the tweak owner marker and an opaque monotonic
generation number; it contains no route, workspace path, request payload, or
profile cache signature.

The Projects provider remains the owner of friendly account descriptions. This
tweak renders only its bounded, redacted label/value projection and does not
look up or expose raw provider references.

## Cache and verification contract

The private profile signature includes the Projects revision and sanitized rows.
It avoids repainting an unchanged completed projection after a revision refresh;
an identity change resets it and starts a new generation. Late IPC responses are
ignored unless their generation still owns the mounted panel.

The focused suite uses fake DOM and IPC behavior tests for start/stop, partial
host contexts, revision reloads, stale races, and cleanup. It does not prove a
fresh Codex host selector or visible Electron rendering.
