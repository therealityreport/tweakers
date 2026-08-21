# Plan 001: Make every verification gate actually run — in CI and on any checkout path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Baseline capture (run first)** — the working tree is intentionally dirty
> (73 pre-existing changed paths at planning time); these artifacts are how
> you prove you touched only what this plan owns:
>
> ```sh
> mkdir -p plans/artifacts
> git status --porcelain > plans/artifacts/001-baseline-status.txt
> git diff -- scripts/verify-release.mjs scripts/check-tweak-catalog.mjs .github/workflows/ci.yml > plans/artifacts/001-before.diff
> ```
>
> **Drift check**: compare the "Current state" excerpts below against the live
> files. The excerpts are the authority (HEAD is `46a2fcc` and the working tree
> is ahead of it, so commit-range diffs prove nothing). On a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `46a2fcc`, 2026-08-19 (dirty working tree); revised 2026-08-19 after external audit

## Why this matters

Three of this repo's verification gates can silently pass without checking anything.

1. `npm run check:tweak-catalog` (catalog↔source parity) is invoked in **neither** CI workflow, and `npm run sync:tweaks -- --check` (generated-asset drift) runs only in `release.yml` — never on pull requests. A malformed catalog or drifted tweak sync can merge and is discovered only at release time, or never.
2. Two verification scripts guard their CLI body with `if (import.meta.url === \`file://${process.argv[1]}\`)`. `import.meta.url` percent-encodes the path (a space becomes `%20`) while `process.argv[1]` is raw, so on any checkout path containing a space or non-ASCII character the guard is false and the script **exits 0 having checked nothing**. One of these scripts, `verify-release.mjs`, is the release gate itself.
3. The four user-facing shell installers (`install.sh`, `update.sh`, plus `scripts/*.sh` helpers) are never linted; a syntax error would ship straight to the `curl | bash` path.

All fixes are small, mechanical, and independently verifiable.

## Current state

Relevant files:

- `.github/workflows/ci.yml` — PR/push CI. Runs (on `macos-latest`, Node 20+22 matrix): `npm ci`, `bash scripts/check-no-bnnett.sh`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, then a `git diff --exit-code` on generated files. It does **not** run `check:tweak-catalog` or `sync:tweaks -- --check`, and has no shellcheck step.
- `.github/workflows/release.yml` — tag-triggered. Runs `node scripts/verify-release.mjs` and `npm run sync:tweaks -- --check` (so the release gate exists, but PRs never see it).
- `scripts/verify-release.mjs` — release-consistency checker. Line 25:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const tag = process.env.GITHUB_REF_NAME ?? args.find((a) => !a.startsWith("--")) ?? "";
```

- `scripts/check-tweak-catalog.mjs` — catalog validation. Line 112, same fragile guard:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) {
```

- `scripts/sync-tweaks.mjs` — the repo's own **correct** exemplar of this guard, lines 183–184:

```js
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
```

- Root `package.json` scripts (verified to exist): `"check:tweak-catalog": "node scripts/check-tweak-catalog.mjs store/index.json"`, `"sync:tweaks": "node scripts/sync-tweaks.mjs"`.

Repo conventions that apply:

- `store/index.json` and `packages/installer/assets/runtime/` are generated; never hand-edit them. `npm run sync:tweaks` is the only regeneration interface (see `AGENTS.md`).
- Do not quit, restart, or repair the live Codex/ChatGPT app as part of this work (`AGENTS.md`, "No mid-plan app restarts"). Nothing in this plan requires it.
- `shellcheck` is **not** installed locally and is not assumed present on GitHub macOS runners — the CI step installs it explicitly (step 4).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (warnings allowed) |
| Catalog check | `npm run check:tweak-catalog` | exit 0, prints a pass message |
| Sync check | `npm run sync:tweaks -- --check` | exit 0, "tweak synchronization current" |
| Script self-test | `node scripts/check-tweak-catalog.mjs --self-test` | prints "tweak catalog discovery self-test passed" |
| Shellcheck (local) | `command -v shellcheck || brew install shellcheck` then `shellcheck --severity=error install.sh update.sh scripts/*.sh` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `scripts/verify-release.mjs`
- `scripts/check-tweak-catalog.mjs`
- `.github/workflows/ci.yml`
- `plans/README.md` (status row update)
- `plans/artifacts/` (baseline/after evidence files)

**Out of scope** (do NOT touch):

- `scripts/sync-tweaks.mjs`, `packages/installer/scripts/copy-assets.mjs` — already use the robust guard.
- `.github/workflows/release.yml` — already runs the release gates; leave it alone.
- The shell scripts themselves (`install.sh`, `update.sh`, `scripts/*.sh`) — do not edit them in this plan, and do not add `# shellcheck disable=` comments to them. If shellcheck reports findings, record them in your report; fixing `update.sh` is plan 002's territory and the rest is follow-up work. The CI invocation uses `--severity=error` (step 4) precisely so this gate can land without a style-cleanup detour.
- `package.json` — no new scripts needed.
- Every pre-existing dirty path in `plans/artifacts/001-baseline-status.txt` that is not listed in scope.

## Version control protocol

- **No branches, no commits, no stash, no reset.** All work stays in the working tree; the operator decides what to commit later. (`AGENTS.md`: "Preserve unrelated staged, modified, and untracked work. Never reset, stash, commit, push, tag, publish, or overwrite it implicitly.")
- Your change evidence is the pair of artifacts from the baseline capture plus `git diff -- <in-scope paths> > plans/artifacts/001-after.diff` when done.

## Steps

### Step 1: Fix the main-guard in `scripts/check-tweak-catalog.mjs`

Replace the guard at line 112 with the `sync-tweaks.mjs` pattern. Ensure `resolve` (from `node:path`) and `fileURLToPath` (from `node:url`) are imported — check the file's existing imports first and extend them rather than duplicating.

Target shape:

```js
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
```

**Verify**: `node scripts/check-tweak-catalog.mjs --self-test` → prints "tweak catalog discovery self-test passed" (proves the guard now fires).
**Verify**: `npm run check:tweak-catalog` → exit 0.
**Verify** (the actual bug): run the script through a path containing a space via a symlinked checkout: `ln -s "$(pwd)" "/tmp/tweakers with space"` then from `$HOME` run `node "/tmp/tweakers with space/scripts/check-tweak-catalog.mjs" --self-test` → must print the self-test pass message (before the fix it prints nothing and exits 0). Remove the symlink afterwards.

### Step 2: Fix the main-guard in `scripts/verify-release.mjs`

Same change at line 25, same import requirements.

**Verify**: `node scripts/verify-release.mjs v0.0.0-selftest 2>&1; echo "exit=$?"` → must produce a **non-zero exit with an error message** (the tag doesn't match `package.json`), which proves the body executes. Confirm path-robustness with the space-path symlink technique from step 1.

### Step 3: Add the missing gates to `.github/workflows/ci.yml`

In the existing `test` job, after the `npm run build` step (build regenerates assets, so the checks must run after it) and before the "Verify deterministic generated files" step, add:

```yaml
      - run: npm run check:tweak-catalog
      - run: npm run sync:tweaks -- --check
```

**Verify** locally: `npm run check:tweak-catalog && npm run sync:tweaks -- --check` → both exit 0. (Verified passing on the planning baseline; if it now fails, see STOP conditions.)
**Verify** the YAML: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` → no exception. (If PyYAML is unavailable, a careful visual indentation check against the neighboring steps is acceptable.)

### Step 4: Add an install-and-run shellcheck step to `.github/workflows/ci.yml`

Add before the lint step:

```yaml
      - run: brew install shellcheck
      - run: shellcheck --severity=error install.sh update.sh scripts/*.sh
```

Do not assume shellcheck is preinstalled on the runner — the explicit `brew install` is the point. `--severity=error` keeps the gate meaningful (real breakage) without forcing a style cleanup of existing scripts in this plan.

**Verify** locally: `command -v shellcheck || brew install shellcheck`, then `shellcheck --severity=error install.sh update.sh scripts/*.sh; echo "exit=$?"` → exit 0. If Homebrew is unavailable locally, note that in your report and rely on the CI step.

## Test plan

- No new test files: the changed scripts are verification tooling with existing self-tests. The step-level verifications above (self-test firing, spaced-path execution, non-zero exit on bad tag) are the regression checks.
- Gates: `npm run typecheck && npm run lint` → both exit 0, plus `node --check scripts/verify-release.mjs && node --check scripts/check-tweak-catalog.mjs` → no syntax errors. (This plan touches no `packages/` source, so the full `npm test` suite is not triggered by `AGENTS.md`'s runtime/installer rule; running it anyway is harmless but optional.)

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n 'file://' scripts/verify-release.mjs scripts/check-tweak-catalog.mjs` returns no `import.meta.url === \`file://` matches (guard replaced in both).
- [ ] `node scripts/check-tweak-catalog.mjs --self-test` prints the pass message.
- [ ] `grep -c 'check:tweak-catalog' .github/workflows/ci.yml` ≥ 1, `grep -c 'sync:tweaks -- --check' .github/workflows/ci.yml` ≥ 1, `grep -c 'brew install shellcheck' .github/workflows/ci.yml` ≥ 1, and `grep -c 'shellcheck --severity=error' .github/workflows/ci.yml` ≥ 1.
- [ ] `npm run check:tweak-catalog` and `npm run sync:tweaks -- --check` exit 0.
- [ ] `git status --porcelain > plans/artifacts/001-after-status.txt`; `diff plans/artifacts/001-baseline-status.txt plans/artifacts/001-after-status.txt` shows only in-scope paths, `plans/artifacts/*`, and `plans/README.md` as new/changed entries.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The guards at `verify-release.mjs:25` / `check-tweak-catalog.mjs:112` no longer match the excerpts above (someone already fixed or moved them).
- `npm run sync:tweaks -- --check` fails on the untouched working tree. It passed at planning time; a new failure means the baseline moved. Report the failure output verbatim.
- `shellcheck --severity=error` reports errors in the existing scripts. Do not edit the shell scripts; report the findings so they can be triaged (an error-level finding in `install.sh` is itself a valuable audit result).
- Adding the CI steps requires restructuring the workflow (e.g. the build step has moved or been renamed).

## Maintenance notes

- Any future script in `scripts/` that self-executes should copy the `sync-tweaks.mjs` guard verbatim; consider extracting a tiny `scripts/lib/invoked.mjs` helper if a third copy appears.
- The shellcheck gate is `--severity=error` on purpose; tightening to warnings is a good follow-up once the existing scripts are cleaned. If `brew install shellcheck` proves slow in CI, pinning a prebuilt binary download is the optimization — do not silently drop the gate.
- `check:tweak-catalog` and `sync:tweaks -- --check` in CI depend on running **after** `npm run build` (build triggers asset copying). If the CI step order changes, keep that ordering.
