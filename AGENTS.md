# AGENTS.md — Tweakers repository workflow

This file governs repository-wide work. For implementation details inside
`tweaks/`, also follow `tweaks/AGENTS.md`.

## Project rules

- Review the applicable files in `rules/` before starting related work.
- Before builds, refreshes, promotions, or artifact cleanup, read and follow
  [Build artifact retention and post-change updates](rules/build-artifact-retention.md).
  The user gives standing authorization to rebuild and open the newest verified
  Tweakers version when a change requires it, then archive older historical
  versions to SHOWS DB and move unneeded artifacts to Trash under that rule.
  Keep active dependencies and one verified rollback locally. Do not ask for
  duplicate confirmation.

## Shared user-level workflow

- For Codex, inherit the applicable user-level `~/.codex/AGENTS.md` rules for autonomy, saved context, helper routing and settings, question delivery and answer ownership, documentation lookup, debugging, completion, and simple non-coding chat explanations. Keep these shared rules there rather than maintaining competing copies here.
- Preserve maximum supported capabilities and standing authorizations. Apply this project's account, environment, release, and live-app requirements where relevant; do not request duplicate confirmation when the current request already supplies the required explicit authorization.

## Start from current truth

- Inspect the current request, Git branch/status, canonical tweak sources,
  catalog, relevant runtime/installer interfaces, tests, and live installed
  state when relevant to the requested change before editing.
- Preserve unrelated staged, modified, and untracked work. Never reset, stash,
  commit, push, tag, publish, or overwrite it implicitly.
- Treat `tweaks/` as canonical source, `store/index.json` as synchronized
  catalog data, and `packages/installer/assets/runtime/` as generated output.
- The managed runtime owns launchd repair and stable updates. Development work
  must never make the watcher depend on a clean Git checkout.

## No mid-plan app restarts

- Never quit, restart, relaunch, replace, or otherwise interrupt Codex/ChatGPT
  while planning, implementation, generated-state synchronization, or
  required source-side checks are incomplete.
- Never create a plan that places an app restart in the middle of
  implementation.
- Treat restart or live promotion as a separate final step. It may occur only
  after the requested implementation is complete and source-verified, with explicit
  user authorization. The standing post-change authorization above covers
  Tweakers; restarting native Codex/ChatGPT still needs separate authorization.
  Perform checks that require the updated live app after this authorized step;
  do not require those checks to pass before the app can be updated.
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
  `npm run sync:tweaks`; run focused tests, catalog check, and build. Broaden to
  the full suite for shared runtime/lifecycle changes, cross-tweak effects, or
  evidence of wider risk; then run one safe `tweaker dev-sync` snapshot and verify
  the live app. Documentation-only changes require instruction/reference review,
  not version bumps, regeneration, or live sync.
- **Runtime/installer:** run focused tests, typecheck/build, and full suite.
  When needed to apply the completed change, use the guarded refresh flow to
  rebuild and open the newest verified Tweakers version under the standing
  authorization, then perform live verification and the required SHOWS DB
  archival and eligible Trash cleanup.
- **Release:** update versions and changelog, run synchronization in check mode,
  history checks, build, and tests. A semver tag push can trigger publication;
  the existence of a tag is not evidence of user approval.
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
- Use any suitable supported browser tool and its profile-verification method. Verify `codex` on first use in a session and after a profile switch, reconnection, or evidence of an account change. Pause account-specific work on a missing or ambiguous match; continue independent work.

## Portless browser host

- Use `https://tweakers.localhost/` as the only operator- and browser-facing URL for experimental browser host mode. The app-owned backend remains internal on `127.0.0.1:8765`.
- Start the source checkout with `npm run browser -- --port 8765`. This command may restart Codex, so follow the no-mid-plan-restarts rule and require explicit user authorization before running it; do not ask again if that authorization is already present.
- Never open the raw loopback URL in browser automation and never use `portless alias --force`; a conflicting route must fail before Codex is interrupted.

## Completion

- State the practical result, relevant verification, and anything unfinished. Scale detail to the task.
- For feature work, include the selected owner/route. Include generated-state, live-sync, promotion, or restart status only when the task touches those surfaces. Explain skipped required checks.
- For documentation-only work, report the instruction/reference checks; omit unrelated build, release, and live-app checklists.
<!-- project-manager:graphify:start -->
## Project knowledge

- Follow [Memory and project knowledge](/Users/thomashulihan/.codex/instructions/RULES/memory-and-project-knowledge.md). It owns Engram repository history and checkout-scoped, on-demand Graphify retrieval.
- Keep only repository-specific code-corpus exclusions in `.graphifyignore`; Project Manager treats nested Git repositories as independent source roots.
<!-- project-manager:graphify:end -->
