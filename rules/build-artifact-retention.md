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
- Verify the changed behavior in the updated installation. Before declaring the
  work complete, classify and clean up the old versions and build artifacts:
  keep active dependencies locally, archive older evidence to SHOWS DB, and move
  artifacts with no remaining purpose to Trash. This is a required post-change
  step, not an optional follow-up. Do not empty Trash.
- Keep the current installation and one verified rollback, with their required
  dependencies, locally. A historical reference alone does not justify leaving
  another large payload on the internal disk.
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

## Classify references by their current purpose

- Keep the active installation and one verified rollback per installation,
  including every referenced runtime, manager generation, and other dependency.
  Do not replace the retained rollback until its replacement is verified.
- An **active dependency** is needed at its exact local path by the installed
  app, current manager descriptor, running process, enabled launch configuration,
  live lock, active transaction, or the retained rollback. Trace its dependency
  closure and keep it locally. For an obsolete one-shot launch job, prove its
  transaction is terminal and it has no running process, then retire/archive
  its launch configuration during the same cleanup before moving its payload.
  Do not leave enabled jobs pointing to missing archived paths.
- A **historical reference** is a path or fingerprint in an old receipt, completed
  transaction, prior report, or dormant investigation. It identifies provenance;
  it does not, by itself, make the payload an active dependency. Archive older
  versions still needed for historical evidence or investigation to SHOWS DB.
- An old `recovery-required` label is not proof of an active operation. Check
  process/lock ownership, current transaction state and actual recovery needs.
  Preserve dormant recovery evidence in the external archive; retain a local
  payload only when an identified current consumer requires its original path.
- Record the exact consumer and reason for every local retention exception.
  Resolve ambiguous references rather than indefinitely preserving all versions
  that appear anywhere in a record. If the consumer cannot yet be established,
  report that specific uncertainty and the next check needed.
- Keep no more than two otherwise disposable failed candidates, for no longer
  than 72 hours. Preserve small diagnostic logs and receipts separately from
  large payloads. Archive still-needed older failure evidence instead of letting
  it accumulate locally; never discard unresolved evidence to meet a limit.
- Preserve account data, conversation history, credentials, configuration,
  source checkouts, and unrelated dirty, generated, or untracked work.

## SHOWS DB archive lifecycle

- Use `/Volumes/SHOWS DB/_Mac-Archive/Tweakers/` for older referenced versions.
  Verify the mounted volume's identity, writable state and available space before
  copying; never create a replacement local directory when the drive is absent.
- Package each artifact in a restorable archive that preserves file contents,
  executable modes, symlinks and required macOS metadata. SHOWS DB's filesystem
  may not preserve those properties in a loose directory copy. Verify the archive
  against a source inventory and checksum, and prove restoration on a suitable
  local filesystem before retiring the local original. Stop on I/O errors.
- Keep a small local archive index under
  `~/Library/Application Support/Tweakers/artifact-archives/` containing original
  path, archive path, volume identity, checksums, retention reason, related receipts/jobs and restoration
  instructions. Preserve original historical receipts; do not rewrite them or
  put symlinks in managed runtime paths to make archived payloads appear local.
  Restore required artifacts before resuming a path-dependent investigation.
- A verified cross-volume move may remove only its exact, unchanged local source
  after archive and restoration checks pass. Do not leave a duplicate large local
  copy solely because its historical receipt remains. Use lifecycle locks and
  immediate identity/reference checks for this final step.
- Reassess archived artifacts during subsequent post-change cleanup. Once their
  investigation/recovery purpose has ended and no retained version depends on
  them, move the archive to SHOWS DB's Trash and update the local index. Do not
  empty the drive's Trash. If SHOWS DB is unavailable, record the deferred archive
  or disposal step; do not silently treat cleanup as complete.

## Cleanup after related work

- Remove successful disposable staging artifacts after promotion and relevant
  verification succeed. Move obsolete, unneeded generations to Trash and archive
  historical-only generations as above, retaining active and rollback dependencies.
- Prepare an exact path-and-size manifest with eligibility reasons. Use the
  existing lifecycle locks where applicable, and revalidate references and
  filesystem identity immediately before each deletion. Do not follow symlinks
  outside the intended target; skip changed or ambiguous targets.
- Use permanent removal only as the verified local-source retirement step of an
  authorized cross-volume move, within explicit cleanup authority, or for
  authorized disposal of the current task's reproducible staging artifacts.
  This rule is not blanket deletion permission. Local Trash does not reclaim
  disk space; never empty unrelated Trash as part of artifact cleanup.
- Do not remove legacy support roots wholesale. Establish that each payload
  is unreferenced and reproducible while preserving live and user-owned data.
- If cleanup cannot safely finish, list the retained paths and reasons. Do not
  interrupt running apps, clear locks, or rewrite recovery receipts to force it.

## Completion evidence

- Verify retained app/runtime paths and rollback dependencies remain intact.
  Compare running app identities before and after cleanup without restarting.
- Report trashed, externally archived and locally retained artifacts, reasons
  for local exceptions, unresolved cleanup, and actual free
  space before and after. Distinguish summed folder sizes from measured APFS
  free-space gains because shared blocks and concurrent work can affect results.
- This is an agent workflow requirement, not an installed automatic collector.
