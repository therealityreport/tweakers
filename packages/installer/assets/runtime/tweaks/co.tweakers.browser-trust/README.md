# Browser Trust

Browser Trust makes exact browser inspection and built-in HTTP(S) browse
requests prompt-free only after the user reviews a read-only Preview,
explicitly selects Apply, and later restarts Codex.

It is a separate tweak from User Questions. User Questions stays installed and
available; Browser Trust does not change its delivery, approval, or form
behavior.

## Security boundary

Trust applies only to exact routes in the bundled registry that are classified
as pure inspection. The route identity and policy shape must still match the
registry when Apply runs.

Browser Trust does not remove prompts for:

- Chrome DevTools or plugin navigation tools;
- mixed read-and-write requests;
- writes or script execution;
- typing or other input;
- downloads or uploads; or
- raw Full CDP access.

The sole eligible navigation projection is the built-in Browser's normal
HTTP(S) browse/history route. It remains bounded by its exact registry identity
and action list.

Unknown or future routes and actions default to prompted. Browser Trust is not
blanket trust for a plugin, MCP server, website, browser profile, or process.
It never promotes a request merely because another request from the same tool
was trusted.

The current eligible projections are Chrome DevTools exactly `1.6.0` and the
built-in browse route, provided their registry identities and saved policy
still match. Infographic Playwright remains `unsupported_projection` because
its plugin transport uses `@latest`; it requires an exact version pin before it
can be approved for prompt-free inspection.

`unsupported_projection`, `policy_blocked`, `identity_drift`, `schema_drift`,
`profile_mismatch`, and `runtime_mismatch` route states all fail closed.
`target_drift` likewise blocks Restore when an owned field has changed. The
settings page reports these conditions without showing URLs, raw browser
profile paths, inspected content, saved policy content, secrets, or raw error
messages.

## Preview, Apply, and Restore

- **Preview** is read-only. It reports bounded route and field counts, safe
  route states, fingerprints, and a short-lived preview token.
- **Apply** accepts only the current preview token. It writes the exact
  previewed fields and records a reversible transaction. A stale token,
  registry mismatch, policy mismatch, or drift is refused.
- **Restore** uses that transaction to restore only Browser Trust fields. It
  preserves unrelated later edits and refuses when a targeted field has
  drifted.

Startup and shutdown only register or remove the settings page and contextual
IPC handlers. They never apply, restore, rewrite policy, or restart Codex.

A successful Apply or Restore requires a later Codex restart before the running
process reflects the saved policy. Browser Trust never quits, relaunches, or
restarts Codex automatically.

## Source, candidate, and live state

These states are intentionally separate:

1. **Source** is the tweak code and exact trust registry in the repository.
2. **Candidate** is the read-only Preview derived from the current saved policy,
   registry fingerprint, and source fingerprint.
3. **Saved state** exists only after an explicit Apply or Restore succeeds.
4. **Live state** is the policy already loaded by the running Codex process. It
   does not change until a later, separately chosen restart.

Editing source, generating package output, creating a Preview, or saving policy
does not by itself prove that the live process is using the new trust state.
