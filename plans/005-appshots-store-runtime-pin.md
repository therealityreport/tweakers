# Plan 005: Resolve the AppShots store dead end by bumping the trunk runtime version to 1.1.0

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Baseline capture (run first)** — the working tree is intentionally dirty
> (73 pre-existing changed paths at planning time):
>
> ```sh
> mkdir -p plans/artifacts
> git status --porcelain > plans/artifacts/005-baseline-status.txt
> git diff -- packages/installer/src/version.ts packages/runtime/src/main.ts package.json packages/*/package.json CHANGELOG.md > plans/artifacts/005-before.diff
> ```
>
> **Drift check**: compare the "Current state" excerpts below against the live
> files. The excerpts are the authority (HEAD is `46a2fcc` and the working tree
> is ahead of it, so commit-range diffs prove nothing). On a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED (a product-version bump touches update/repair gating semantics)
- **Depends on**: none
- **Category**: bug / release-governance
- **Planned at**: commit `46a2fcc`, 2026-08-19 (dirty working tree); rewritten 2026-08-19 after external audit

## Why this matters — and why the pin must NOT be lowered

The in-app tweak store lists AppShots as available, but its manifest pins `minRuntime: ">=1.1.0"` while every shipped component reports version `1.0.0`. The runtime's store gate hard-fails any install below the pin, so every user who clicks install on AppShots hits "AppShots requires Tweakers 1.1.0 or newer." — a guaranteed dead end in the product's own store.

An earlier draft of this plan proposed lowering the pin to `>=1.0.0`. **That is wrong and must not be done**: the released tag `v1.0.0` contains neither AppShots nor the `registerCaptureHotkey` API it depends on (verified: `git ls-tree v1.0.0 --name-only tweaks/` lists only `AGENTS.md`; `git grep registerCaptureHotkey v1.0.0 -- packages/runtime/src packages/sdk/src` finds nothing). The APIs arrived on trunk *after* v1.0.0 while the source version stayed `1.0.0`. Lowering the pin would falsely claim AppShots works on the released 1.0.0 runtime.

The correct fix is version governance (maintainer-approved): **bump the trunk product version to 1.1.0 and keep the pin**. The pin then tells the truth — AppShots needs the runtime that actually contains its APIs — and the store gate passes on trunk-built runtimes immediately; the next release tags v1.1.0.

Rejected alternative (recorded so it isn't re-proposed): gate AppShots with `available: false` in `store/index.json` until 1.1.0 ships — viable because `scripts/sync-tweaks.mjs:48` preserves `available: previous.available ?? true` across syncs, but it hides the tweak instead of fixing the version drift, and the maintainer chose the bump.

## Current state

- `packages/installer/src/version.ts:1` — `export const TWEAKER_VERSION = "1.0.0";` (the installer-side product version).
- `packages/runtime/src/main.ts:351` — `const TWEAKER_VERSION = "1.0.0";` (the runtime keeps its **own** copy — both must move).
- Workspace manifest versions, all `"version": "1.0.0"` (verified by grep): root `package.json`, `packages/installer/package.json:3`, `packages/runtime/package.json:3`, `packages/sdk/package.json:3`, `packages/loader/package.json:6`, `packages/native-host/package.json:3`, `packages/switcher/package.json:3`. (`packages/mcp-lifecycle/package.json:3` is `0.5.0` — independently versioned, do NOT touch.)
- `tweaks/co.tweakers.appshots/manifest.json:14` — `"minRuntime": ">=1.1.0"` (correct; stays).
- `store/index.json:58` — the generated catalog copy of the pin (regenerates via sync; do not hand-edit).
- The store gate, `packages/runtime/src/main.ts` (~4532–4550):

```ts
function storeEntryRuntimeCompatibility(entry: TweakStoreEntry): StoreEntryRuntimeCompatibility {
  const required = cleanMinRuntime(entry.manifest.minRuntime);
  const compatible = !required || compareVersions(TWEAKER_VERSION, required) >= 0;
  ...
      : `${entry.manifest.name} requires Tweakers ${required} or newer.`,
```

- Update/repair gating that reads the version: `packages/installer/src/commands/repair.ts:364` — `if (compareSemver(TWEAKER_VERSION, state.version) > 0 || !runtimeIsCurrent) {` — after the bump, a 1.1.0 CLI against 1.0.0 installed state takes the repair path on its next run. That is the **intended** behavior of that gate (version moved forward), not a regression; it is noted here so nobody "fixes" it.
- `CHANGELOG.md` — has an `## Unreleased` section (top of file) to carry the bump note.
- `scripts/verify-release.mjs` — at release time compares the pushed tag against `package.json`; nothing to change now, but the next tag must be `v1.1.0`.

Repo conventions:

- `tweaks/` canonical, `store/index.json` + `packages/installer/assets/runtime/**` generated via `npm run sync:tweaks` / `npm run build` only.
- `AGENTS.md` release workflow: "update versions and changelog, run synchronization in check mode, history checks, build, and tests. A pushed semver tag is publication approval. Never push a tag or publish a release without explicit user authorization." This plan is the "update versions and changelog" part **only** — no tag, no release, no publication.
- `AGENTS.md` runtime/installer gate: focused tests, typecheck/build, **and full suite**.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Enumerate version sites | `grep -rn '"1\.0\.0"' package.json packages/*/package.json packages/installer/src/version.ts packages/runtime/src/main.ts` | exactly the sites listed in Current state |
| Typecheck | `npm run typecheck` | exit 0 |
| Regenerate | `npm run sync:tweaks && npm run build` | exit 0 |
| Sync check | `npm run sync:tweaks -- --check` | "current" |
| Catalog check | `npm run check:tweak-catalog` | exit 0 |
| Lockfile refresh | `npm install --package-lock-only --ignore-scripts` | exit 0; lock diff shows only version fields |
| Full suite | `npm test` | all pass (unrelated pre-existing failures → STOP) |

## Scope

**In scope**:

- `packages/installer/src/version.ts` (the constant)
- `packages/runtime/src/main.ts` (line 351 constant only — nothing else in that file)
- Root `package.json` + the six workspace `package.json` files listed above (`version` field only)
- `package-lock.json` (via `npm install --package-lock-only --ignore-scripts` only)
- `CHANGELOG.md` (Unreleased note)
- Any test that pins the literal product version `1.0.0` (update the expectation; list each in your report)
- `plans/README.md` (status row), `plans/artifacts/` (evidence)
- Regenerated output (`store/index.json`, `packages/installer/assets/runtime/**`) via sync/build only

**Out of scope** (do NOT touch):

- `tweaks/co.tweakers.appshots/manifest.json` — the pin is correct and stays `">=1.1.0"`.
- `packages/mcp-lifecycle/package.json` — independently versioned (0.5.0).
- The store gate logic (`storeEntryRuntimeCompatibility`) and repair gating (`repair.ts:364`) — correct as designed.
- Tags, releases, publication of any kind.
- Version-like strings inside receipts, fingerprints, or fixtures whose role you cannot determine — STOP instead (see STOP conditions).

## Version control protocol

- **No branches, no commits, no stash, no reset.** All work stays in the working tree; the operator decides commits later (`AGENTS.md`: preserve unrelated staged, modified, and untracked work). A pushed `v1.1.0` tag later is the operator's release act, never yours.
- Final evidence: `git diff -- <in-scope paths> > plans/artifacts/005-after.diff`.

## Steps

### Step 1: Enumerate and classify every `1.0.0` version site

Run the enumeration grep from "Commands you will need", plus a broader sweep: `grep -rn '"1\.0\.0"\|= "1\.0\.0"' packages/*/src --include='*.ts' | grep -v assets/runtime`. Classify each hit: (a) product version → bump; (b) test expectation of the product version → update with the code; (c) unrelated/ambiguous (receipt, fixture, foreign version) → leave, and if its role is unclear, STOP.

**Verify**: your report lists every hit with its classification.

### Step 2: Bump the constants and manifests

- `packages/installer/src/version.ts:1` → `"1.1.0"`.
- `packages/runtime/src/main.ts:351` → `"1.1.0"`.
- `version` field → `"1.1.0"` in root `package.json` and the six workspace manifests (installer, runtime, sdk, loader, native-host, switcher).
- `npm install --package-lock-only --ignore-scripts` to refresh `package-lock.json`.

**Verify**: enumeration grep from step 1 now returns zero product-version `"1.0.0"` hits; `git diff -- package-lock.json` shows only version-field churn (anything else → STOP).

### Step 3: CHANGELOG

Add to the `## Unreleased` section (create a `### Changed` subsection if absent): a line stating the product version moved to 1.1.0 because the post-v1.0.0 trunk carries the AppShots tweak and the capture/hotkey runtime APIs, and store entries pin `minRuntime >= 1.1.0` accordingly.

**Verify**: `grep -n "1.1.0" CHANGELOG.md` → the new note.

### Step 4: Regenerate and gate

`npm run sync:tweaks` → `npm run build` → `npm run sync:tweaks -- --check` → `npm run check:tweak-catalog` → `npm run typecheck` → full `npm test`.

**Verify**: all exit 0 (suite: unrelated pre-existing failures documented in `plans/artifacts/005-suite-failures.txt`). Tests that pinned `1.0.0` (step 1 class b) updated and passing.

### Step 5: Prove the store gate now passes

`node -e` is not enough (the gate lives in the runtime); instead check statically: `grep -n 'TWEAKER_VERSION = "1.1.0"' packages/runtime/src/main.ts` and `grep -n '">=1.1.0"' store/index.json` both match — `compareVersions("1.1.0", "1.1.0") >= 0` holds by the gate excerpt above. If a runtime test exercises `storeEntryRuntimeCompatibility`, extend it with the AppShots case (compatible at 1.1.0, incompatible at 1.0.0).

## Test plan

- Extend (or create, following the nearest runtime test's structure) coverage for `storeEntryRuntimeCompatibility` if a test seam exists: `minRuntime ">=1.1.0"` vs runtime `1.1.0` → compatible; vs `1.0.0` → incompatible with the exact message. If the function is not importable without booting Electron, note the gap — the static checks in step 5 are the fallback.
- Update every test that pinned the literal `1.0.0` product version (step 1 class b); each is listed in the report.
- Full gates as in step 4.

## Done criteria

- [ ] `grep -n 'TWEAKER_VERSION = "1.1.0"' packages/installer/src/version.ts packages/runtime/src/main.ts` → 2 matches.
- [ ] Root + six workspace `package.json` files at `"version": "1.1.0"`; `packages/mcp-lifecycle/package.json` untouched at `0.5.0`.
- [ ] `tweaks/co.tweakers.appshots/manifest.json` still `">=1.1.0"` (unchanged).
- [ ] CHANGELOG Unreleased carries the bump note.
- [ ] `npm run sync:tweaks -- --check`, `npm run check:tweak-catalog`, `npm run typecheck` exit 0; `npm run build` exit 0; full `npm test` passes or unrelated failures documented.
- [ ] `git status --porcelain > plans/artifacts/005-after-status.txt`; diff vs baseline shows only in-scope paths, regenerated assets, `plans/artifacts/*`, and `plans/README.md`.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 finds a `1.0.0` version string whose role is ambiguous — e.g. baked into a receipt, fingerprint, accepted-build descriptor, or migration whose semantics you cannot determine from its immediate context. Do not guess whether it is the product version.
- `git diff -- package-lock.json` after the lockfile refresh shows anything beyond version fields (dependency churn means the lockfile was stale — report, don't absorb).
- The full suite fails on a version-related assertion you cannot confidently classify as "pinned the old product version".
- Anything asks you to tag, publish, or release — never; a pushed semver tag is the operator's act alone (`AGENTS.md`).

## Maintenance notes

- The next release must tag `v1.1.0` (with `SHA256SUMS`, per plan 002); `scripts/verify-release.mjs` will enforce tag↔package.json agreement at that point.
- `repair.ts:364` will see `1.1.0 > 1.0.0` against existing installed state and take the repair path on the next watcher/CLI run after this build is promoted — expected; reviewers should not "fix" it.
- Two `TWEAKER_VERSION` constants exist (installer `version.ts`, runtime `main.ts:351`) and moved together here. A guard test asserting they stay equal (read both files or import both values) is a worthwhile follow-up — same shape as the audit's MCP-lifecycle version-constant finding (README table row 22).
- Worthwhile follow-up recorded in the original audit: a sync-time validation that every `available: true` bundled entry has a satisfiable `minRuntime`, so this class of dead end can't regress silently (`scripts/check-tweak-catalog.mjs` is the natural home).
