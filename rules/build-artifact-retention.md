# Build artifact retention

Read before builds, refreshes, promotions, or artifact cleanup. These rules
extend the repository's `AGENTS.md`; they do not authorize deleting ambiguous
data or override its live-app and source-preservation requirements.

## Standing post-change workflow

- After changing Tweakers, complete implementation, synchronization, and required
  source-side verification. If applying the change requires a new build or app
  launch, rebuild and open the newest verified Tweakers version through the
  guarded refresh/promotion flow. The user has authorized this as a standing
  workflow; do not ask again for that Tweakers update.
- Verify the changed behavior in the updated installation. Then move eligible
  obsolete versions and build artifacts to the user's Trash using the reference,
  lock, identity, rollback, and evidence checks below. Do not empty Trash.
- Keep the current installation, verified rollback, and dependencies or evidence
  still required for recovery. Report artifacts retained for unresolved reasons.
- Documentation-only changes do not require rebuilding or reopening. Use the
  supported validated hot-sync path when it fully applies a tweak-only change.
- This authorization covers Tweakers updates after completed changes. It does
  not authorize mid-implementation restarts, interrupting native Codex/ChatGPT,
  publishing releases, or discarding unrelated work or account data.

## Before creating artifacts

- Inspect available disk space, existing candidates, and active references in
  app receipts, manager descriptors, runtime state, processes, locks, and
  unfinished transactions. Account for both Tweakers and legacy codex-plusplus
  storage, candidate caches, and temporary staging directories.
- Estimate peak additional build space, including staging and rollback needs.
  Require that estimate plus a 20 GiB free-space reserve. If the estimate is
  unknown or space is insufficient, resolve it or report the blocker before
  starting another large candidate.
- Reuse a verified compatible artifact when supported. Investigate unexpected
  bundle growth; do not package previous generated runtimes into new runtimes.

## What to retain

- Keep the active installation and one verified rollback per installation,
  including every referenced runtime, manager generation, and other dependency.
  Do not replace the retained rollback until its replacement is verified.
- Protect all artifacts referenced by running processes, active locks, or
  unfinished transactions. Unresolved investigations override age/count limits.
- Keep no more than two otherwise disposable failed candidates, for no longer
  than 72 hours. Preserve small diagnostic logs and receipts separately from
  large payloads; never discard unresolved recovery evidence to meet a limit.
- Preserve account data, conversation history, credentials, configuration,
  source checkouts, and unrelated dirty, generated, or untracked work.

## Cleanup after related work

- Remove successful disposable staging artifacts after promotion and relevant
  verification succeed. Remove obsolete, unreferenced generations after the
  related work, retaining the protected installation and rollback dependencies.
- Prepare an exact path-and-size manifest with eligibility reasons. Use the
  existing lifecycle locks where applicable, and revalidate references and
  filesystem identity immediately before each deletion. Do not follow symlinks
  outside the intended target; skip changed or ambiguous targets.
- Use permanent removal only within explicit cleanup authority or authorized
  disposal of the current task's reproducible staging artifacts. This rule is
  not blanket deletion permission. Local Trash does not reclaim disk space;
  never empty unrelated Trash as part of artifact cleanup.
- Do not remove legacy support roots wholesale. Establish that each payload
  is unreferenced and reproducible while preserving live and user-owned data.
- If cleanup cannot safely finish, list the retained paths and reasons. Do not
  interrupt running apps, clear locks, or rewrite recovery receipts to force it.

## Completion evidence

- Verify retained app/runtime paths and rollback dependencies remain intact.
  Compare running app identities before and after cleanup without restarting.
- Report removed and retained artifacts, unresolved cleanup, and actual free
  space before and after. Distinguish summed folder sizes from measured APFS
  free-space gains because shared blocks and concurrent work can affect results.
- This is an agent workflow requirement, not an installed automatic collector.
