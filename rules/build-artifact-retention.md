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
  keep active dependencies locally and move old versions and artifacts with no
  remaining purpose to Trash. This is a required post-change
  step, not an optional follow-up. Do not empty unrelated Trash. Permanent
  removal of exact listed retired artifacts requires explicit cleanup authority
  and the identity/reference checks below.
- Keep at most two local application copies, including partial staging: the current
  installation plus one verified rollback OR one candidate. No temporary third
  copy is permitted. Keep their required dependencies locally. A historical reference alone does not justify leaving
  another large payload on the internal disk.
- Documentation-only changes do not require rebuilding or reopening. Use the
  supported validated hot-sync path when it fully applies a tweak-only change.
- This authorization covers Tweakers updates after completed changes. It does
  not authorize mid-implementation restarts, interrupting native Codex/ChatGPT,
  publishing releases, or discarding unrelated work or account data.

## Dependency installation

Use `npm run deps:install` for dependency restoration. It holds the shared
operation lease and sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`. Tweakers uses the
verified host's Electron runtime; npm's Electron package is needed for its type
declarations, not another downloaded desktop. Inventory dependency directories
and registered development output as well as support-directory candidates.
Never modify a sealed Manager generation in place to remove its vendor payload;
publish a verified replacement, then move the obsolete generation to Trash.

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
  transaction is terminal and it has no running process, then retire its launch
  configuration during the same cleanup before moving its payload to Trash.
  Do not leave enabled jobs pointing to missing paths.
- A **historical reference** is a path or fingerprint in an old receipt, completed
  transaction, prior report, or dormant investigation. It identifies provenance;
  it does not, by itself, make the payload an active dependency. Move such older
  versions to Trash; keep the small receipts and logs that record provenance.
- An old `recovery-required` label is not proof of an active operation. Check
  process/lock ownership, current transaction state and actual recovery needs.
  Keep small recovery receipts and logs; move a dormant payload to Trash unless
  an identified current consumer requires its original path.
- Record the exact consumer and reason for every local retention exception.
  Resolve ambiguous references rather than indefinitely preserving all versions
  that appear anywhere in a record. If the consumer cannot yet be established,
  report that specific uncertainty and the next check needed.
- Failed candidates and previews consume the same two slots; there is no extra
  failure allowance. Preserve small diagnostic logs and receipts separately from
  payloads. Before staging, move the older rollback to Trash only when the
  current installation is a verified fallback. If neither copy can safely retire,
  block staging. Never discard unresolved recovery evidence to satisfy the limit.
- SHOWS DB is storage only, for items intended for reuse (see below). No app,
  helper, runtime dependency, or launch configuration may execute from it. Do not
  redirect managed paths to archives.
- Preserve account data, conversation history, credentials, configuration,
  source checkouts, and unrelated dirty, generated, or untracked work.

## Old versions go to Trash; archive only for planned reuse

- Move old versions directly to the user's Trash: superseded app copies,
  replaced rollbacks, failed candidates and previews, Doctor candidate payloads,
  old Manager and runtime generations, build outputs, and staging leftovers. Do
  not archive them to SHOWS DB, and do not build archive or restore proofs for them.
- Before each move, apply the active-reference and two-copy checks above and
  confirm the exact path is unchanged. Record a receipt with the original path,
  Trash destination and reason. Trash keeps the item recoverable.
- Archive to `/Volumes/SHOWS DB/_Mac-Archive/` only items the user intends to use
  again after the work: memories, outputs and deliverables, and evidence the user
  names. Verify the copy with checksums; do not build disk-image restore proofs.
  Never create a replacement local directory when the drive is absent.
- Never empty unrelated Trash. Moving to Trash frees an application slot but
  does not reclaim disk space. The user may explicitly authorize permanent
  removal of exact listed retired artifacts after the checks below.
- Installer code (`artifact-retirement.ts`, `generation-retention.ts`) reads
  `artifact-retention.json`: `retireTo` is `"trash"` (the default) or `"archive"`.
  Old settings without `retireTo` use Trash. Archive settings retain
  `archiveVolume`, `archiveVolumeUUID`, and `allowTrashFallback`. Invalid policy
  values fail before retirement. Trash policy does not probe SHOWS DB or create
  archive-restoration images. Do not add agent-side archive, restore-proof, or
  image-cleanup scripts. Existing archives and their index under
  `artifact-archives/` may move to the drive's Trash during later cleanup when no
  retained version needs them.

## Cleanup after related work

- Remove successful disposable staging artifacts after promotion and relevant
  verification succeed. Move obsolete and historical-only generations to Trash,
  retaining active and rollback dependencies.
- Prepare an exact path-and-size manifest with eligibility reasons. Use the
  existing lifecycle locks where applicable, and revalidate references and
  filesystem identity immediately before each deletion. Do not follow symlinks
  outside the intended target; skip changed or ambiguous targets.
- Use permanent removal only within explicit cleanup authority or for
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
- Report trashed and locally retained artifacts, any planned-reuse archives,
  reasons for local exceptions, unresolved cleanup, and actual free
  space before and after. Distinguish summed folder sizes from measured APFS
  free-space gains because shared blocks and concurrent work can affect results.
- This is an agent workflow requirement, not an installed automatic collector.
