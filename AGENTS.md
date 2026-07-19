# AGENTS.md — Tweakers repository workflow

This file governs repository-wide work. For implementation details inside
`tweaks/`, also follow `tweaks/AGENTS.md`.

## Start from current truth

- Inspect the current request, Git branch/status, canonical tweak sources,
  catalog, relevant runtime/installer interfaces, tests, and live installed
  state before editing.
- Preserve unrelated staged, modified, and untracked work. Never reset, stash,
  commit, push, tag, publish, or overwrite it implicitly.
- Treat `tweaks/` as canonical source, `store/index.json` as synchronized
  catalog data, and `packages/installer/assets/runtime/` as generated output.
- The managed runtime owns launchd repair and stable updates. Development work
  must never make the watcher depend on a clean Git checkout.

## No mid-plan app restarts

- Never quit, restart, relaunch, replace, or otherwise interrupt Codex/ChatGPT
  while planning, implementation, generated-state synchronization, testing, or
  verification is incomplete.
- Never create a plan that places an app restart in the middle of
  implementation.
- Treat restart or live promotion as a separate final step. It may occur only
  after the repository is complete and source-verified, and only with explicit
  user confirmation.
- If an early restart appears necessary, leave the live app running, complete
  all safe source-side work, then stop and report the blocker and remaining
  work. Never restart Codex/ChatGPT into partial or broken code.

## Route every feature request first

When the user says to add a feature, inspect existing tweak manifests, catalog
ownership, runtime/installer interfaces, live installed state when relevant,
tests, permissions, lifecycle hooks, settings pages, and UI ownership. Before
editing, state exactly one route and a one-sentence rationale:

1. **Add to an existing tweak** when the capability shares the same user-facing
   responsibility, settings/UI surface, permissions, process scope, and
   lifecycle. Keep its ID and data namespace; bump its version.
2. **Revise an existing tweak** when changing, replacing, repairing, or removing
   behavior it already owns. Preserve compatible config/data unless migration
   is explicitly required; update behavior tests and add regression coverage.
3. **Create a new tweak** when responsibility, toggleability, permissions,
   process scope, lifecycle, or UI ownership is independent. Create a
   reverse-DNS ID, manifest, lifecycle, tests, catalog/package output, and start
   at `0.1.0`.

Prefer the existing owner when cohesive. Prefer a new tweak when users may want
either capability without the other. Do not create a tweak to avoid learning an
existing owner, and do not enlarge an unrelated tweak to avoid catalog work. If
two routes remain equally valid and materially change toggle behavior,
permissions, settings ownership, or maintenance, ask one structured question.

## Change workflow

- **Tweak-only:** follow `tweaks/AGENTS.md`; validate manifest, entry, lifecycle
  cleanup, permissions, and tests; apply a semantic-version bump; run
  `npm run sync:tweaks`; run focused tests, catalog check, build, and full suite;
  then run one safe `tweaker dev-sync` snapshot and verify the live app.
- **Runtime/installer:** run focused tests, typecheck/build, and full suite. Do
  not quit or replace the live app automatically; leave full promotion to the
  user-confirmed title-bar refresh flow.
- **Release:** update versions and changelog, run synchronization in check mode,
  history checks, build, and tests. A pushed semver tag is publication approval.
  Never push a tag or publish a release without explicit user authorization.

## Synchronization and live safety

- `npm run sync:tweaks` is the only interface for catalog/package regeneration.
  It discovers manifest-bearing tweak folders, ignores non-tweak fixtures,
  rejects invalid/duplicate/unsafe declarations, adds or updates bundled
  catalog entries, removes stale bundled output, and produces deterministic
  generated assets. `npm run sync:tweaks -- --check` must be clean in CI.
- Tweak-only changes hot-sync only after validation and tests. A failed sync or
  build must leave the last working live snapshot untouched.
- Full refresh uses the registered development checkout when it has unapplied
  changes; otherwise it uses the latest stable GitHub release. It must never
  fetch, merge, reset, or switch branches in the development checkout.
- The refresh flow validates a disposable candidate before quitting ChatGPT,
  promotes or rolls back atomically, and reopens the app after either outcome.

## Chrome plugin profile

- For [@Chrome](plugin://chrome@openai-bundled), use the friendly Chrome profile `codex` for this project.
- Require exactly one extension backend whose `metadata.profileName` is `codex`; stop on zero or multiple matches instead of falling back to another profile.

## Completion

- Report the selected feature route, files/behavior changed, focused and full
  verification, generated-state status, live sync/promotion result, remaining
  restart requirement, and any unrelated work deliberately left untouched.
