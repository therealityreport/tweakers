# Plan 006: Unify the version comparators — precedence for ordering, identity for verification, caller-specific fail-safes

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
> git status --porcelain > plans/artifacts/006-baseline-status.txt
> git diff -- packages/installer/src/version.ts packages/installer/src/commands/self-update.ts packages/installer/src/commands/repair.ts packages/installer/src/codex-source-release.ts packages/runtime/src/main.ts packages/installer/test > plans/artifacts/006-before.diff
> ```
>
> **Drift check**: compare the "Current state" excerpts below against the live
> files. The excerpts are the authority (HEAD is `46a2fcc` and the working tree
> is ahead of it, so commit-range diffs prove nothing). On a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 002 (both edit `packages/installer/src/commands/self-update.ts` — land 002 first). If plan 005 has run, versions are `1.1.0` — irrelevant to this plan's logic.
- **Category**: bug / tech-debt
- **Planned at**: commit `46a2fcc`, 2026-08-19 (dirty working tree); revised 2026-08-19 after external audit

## Why this matters

The repo contains four independent version comparators with **different orderings**:

1. `packages/installer/src/version.ts:5` `compareSemver` — compares only major.minor.patch, ignores prerelease entirely (`1.0.0-alpha.9` == `1.0.0`), and returns an asymmetric `a === b ? 0 : 1` for unparseable input.
2. `packages/installer/src/codex-source-release.ts:126/149` `parseSemver` + `compareSemverPrecedence` — full SemVer-2.0 precedence (prerelease < release), BigInt-safe.
3. `packages/installer/src/commands/self-update.ts:313–345` `parsePrereleaseSemver` + `comparePrereleaseSemver` — a third, near-identical prerelease comparator in a file that **also imports the naive one**.
4. `packages/runtime/src/main.ts:4878` `compareVersions` — another naive core-only copy used for update-available checks and the store's `minRuntime` gate.

Concrete user-facing bug: `self-update.ts:397` gates updates with `compareSemver(targetVersion, currentVersion) > 0`. For a user on `1.0.0-alpha.9`, the stable `1.0.0` release compares **equal** (cores match, prerelease ignored) — the update is skipped. This project actively ships alpha builds, so the alpha→stable promotion path is real.

**Design principle the fix must honor — ordering and identity are different operations:**

- *Precedence* (SemVer §11, build metadata ignored) is correct for "is there something newer?" decisions.
- *Identity* (exact normalized equality, build metadata **included**) is required for "is this artifact exactly what the tag promised?" — `verifyDownloadedVersion` uses `!== 0` today; under pure precedence, `1.0.0+build-a` and `1.0.0+build-b` would compare equal and a mismatched artifact could pass verification.
- *Unparseable input* has no universal answer — each caller gets a fail-safe chosen for its own risk direction. In particular, `repair.ts:364` currently benefits from the naive comparator's `a === b ? 0 : 1`: corrupt `state.version` compares "different" and **triggers** repair. A lexical fallback could rank corrupt state above the current version and *skip* repair — the wrong direction. No blanket fallback; see the per-caller table.

## Current state

`packages/installer/src/version.ts` (entire comparator):

```ts
export const TWEAKER_VERSION = "1.0.0";

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function compareSemver(a: string, b: string): number {
  const av = SEMVER_RE.exec(a);
  const bv = SEMVER_RE.exec(b);
  if (!av || !bv) return a === b ? 0 : 1;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(av[i]) - Number(bv[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}
```

(The `TWEAKER_VERSION` value may be `1.1.0` if plan 005 ran — either is fine.)

Installer callers of the naive `compareSemver` (verified by grep):

- `packages/installer/src/commands/self-update.ts:397` — `return compareSemver(targetVersion, currentVersion) > 0;` (update gate; `if (!targetVersion) return true;` precedes it)
- `packages/installer/src/commands/self-update.ts:443` — `if (compareSemver(packageVersion, target.version) !== 0) {` (downloaded-version verification — this is the **identity** use)
- `packages/installer/src/commands/repair.ts:364` — `if (compareSemver(TWEAKER_VERSION, state.version) > 0 || !runtimeIsCurrent) {` (repair gate — corrupt input must fail toward repair)

The strict exemplar, `packages/installer/src/codex-source-release.ts` (~126–165): `parseSemver(value)` → `{ raw, normalized, major/minor/patch: BigInt, prerelease: string[], build: string[] }` (returns `null` on non-match); `compareSemverPrecedence(a, b)` — core compare, then "no prerelease > has prerelease", then per-identifier prerelease compare; **throws** on unparseable input. Note its `normalized` field includes prerelease and build.

The duplicate in `self-update.ts` (~313–345): `parsePrereleaseSemver` (strict anchored regex, BigInt core, prerelease identifiers; returns `null` for stable tags — that null-filtering is what restricts `selectRelease` to prereleases) + `comparePrereleaseSemver` — used by `selectRelease` for the prerelease channel.

The runtime copy, `packages/runtime/src/main.ts:4878`:

```ts
function compareVersions(a: string, b: string): number {
  const av = VERSION_RE.exec(a);
  const bv = VERSION_RE.exec(b);
  if (!av || !bv) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(av[i]) - Number(bv[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}
```

Runtime callers: `main.ts:4256` (`updateAvailable` for Tweaker itself), `main.ts:4290` (`updateAvailable` per tweak), `main.ts:4534` (store `minRuntime` gate). Its `return 0` on unparseable means "no update"/"compatible" — a fail-quiet direction those callers rely on; **keep it** and document why it differs from the installer's per-caller choices.

Also relevant, **not** to be touched: `packages/installer/src/desktop-version.ts` `compareDesktopVersionIdentity` — Sparkle build-number semantics, deliberately not SemVer.

Repo conventions:

- Installer is ESM TypeScript; intra-package imports use `.js` specifiers (see `self-update.ts:21`: `import { TWEAKER_VERSION, compareSemver } from "../version.js";`).
- Tests: Node runner + tsx under `packages/installer/test/` (`ls packages/installer/test | grep -i -E "release|version|update"` to find the structural model).
- `AGENTS.md`: installer work requires focused tests, typecheck/build, **and full suite**.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Focused tests | `node --import ./scripts/test-root-preload.mjs --import tsx --test packages/installer/test/semver-precedence.test.ts packages/installer/test/self-update*.test.ts` (adjust to real filenames) | all pass |
| Lint | `npm run lint` | exit 0 |
| Regenerate assets | `npm run build` | exit 0 |
| Full suite | `npm test` | all pass (unrelated pre-existing failures → STOP) |

## Scope

**In scope**:

- `packages/installer/src/version.ts` (the decomposed API)
- `packages/installer/src/commands/self-update.ts` (delete duplicate comparator; repoint gate/verify/selectRelease)
- `packages/installer/src/commands/repair.ts` (repoint with its fail-safe)
- `packages/installer/src/codex-source-release.ts` (only if the parser must move to break an import cycle; prefer importing in place)
- `packages/runtime/src/main.ts` — the body of `compareVersions` only
- Test files in `packages/installer/test/` (create `semver-precedence.test.ts`; extend self-update tests) and any test pinning old comparator behavior
- `plans/README.md` (status row), `plans/artifacts/` (evidence)
- Regenerated assets via `npm run build` only

**Out of scope**:

- `packages/installer/src/desktop-version.ts` — different, intentional semantics (Sparkle builds).
- `cleanMinRuntime`/`normalizeVersion`/`VERSION_RE` in the runtime beyond what `compareVersions`'s body needs (extend parsing *inside* the function with its own regex; the shared `VERSION_RE` is used elsewhere for validation).
- The SDK — do not host a shared comparator there (the runtime/SDK ESM-CJS boundary is why `promotion-policy` is vendored today).
- Changing which version *strings* are produced anywhere (comparison only).

## Version control protocol

- **No branches, no commits, no stash, no reset.** All work stays in the working tree; the operator decides commits later (`AGENTS.md`: preserve unrelated staged, modified, and untracked work).
- Final evidence: `git diff -- <in-scope paths> > plans/artifacts/006-after.diff`.

## Steps

### Step 1: Build the decomposed API in `version.ts`

First check for an import cycle: `grep -n 'from "./version.js"' packages/installer/src/codex-source-release.ts`. If `codex-source-release.ts` does **not** import `version.ts`, import `parseSemver`/`compareSemverPrecedence` from `./codex-source-release.js` into `version.ts`; if it does, move the parser+precedence functions into `version.ts` and re-export them from `codex-source-release.ts` so its callers keep working.

`version.ts` then exports:

- `parseSemver(value): ParsedCodexSemver | null` — strict; `null` on invalid (re-exported or imported, per above).
- `compareSemverPrecedence(a, b): number` — SemVer-2.0 precedence; **throws** on unparseable input (existing behavior of the strict implementation — never a silent ordering).
- `semverIdentityEquals(a, b): boolean` — new: parse both; if either is unparseable, fall back to exact raw string equality after trimming a leading `v`; otherwise compare the `normalized` forms, which include prerelease **and build metadata**. Two artifacts differing only in build metadata are NOT identical.
- Remove the old naive `compareSemver` export entirely (callers are repointed in steps 2–3; a transitional deprecated alias is not wanted — the compile errors are the migration checklist).

**Verify**: `npm run typecheck` (expect errors only at the three known call sites, which the next steps fix — run it to enumerate them, then proceed).

### Step 2: Repoint the installer callers with caller-specific fail-safes

| Caller | New logic | Fail-safe for unparseable input |
|---|---|---|
| `self-update.ts:397` update gate | both parseable → `compareSemverPrecedence(target, current) > 0` | unparseable **target** → `true` (existing `if (!targetVersion) return true` behavior extends); unparseable **current** → `true` (unknown current state → take the update) |
| `self-update.ts:443` verify | `if (!semverIdentityEquals(packageVersion, target.version)) { throw ... }` | identity's own raw-equality fallback covers it — mismatch rejects, which is the safe direction |
| `repair.ts:364` repair gate | both parseable → `compareSemverPrecedence(TWEAKER_VERSION, state.version) > 0` | unparseable `state.version` → treat as **needs repair** (`true` branch) — preserves today's fail-safe direction |
| `selectRelease` (self-update ~313) | delete `parsePrereleaseSemver`/`comparePrereleaseSemver`; filter with `const parsed = parseSemver(tag); if (!parsed || parsed.prerelease.length === 0) continue;` (reproduces the prerelease-only filtering), rank with `compareSemverPrecedence` | non-semver tags are skipped by the filter, as today |

Implement each as a small local wrapper where the try/catch around `compareSemverPrecedence` would otherwise clutter the call site (e.g. a private `isNewerVersion(target, current, { onUnparseable })` helper in `version.ts` is acceptable if it keeps the per-caller policies explicit at the call sites).

**Verify**: `npm run typecheck` → exit 0; `grep -rn "comparePrereleaseSemver\|parsePrereleaseSemver\|compareSemver\b" packages/installer/src` → no matches for the deleted names (`compareSemverPrecedence` remains).

### Step 3: Fix the runtime's `compareVersions` in place

Replace the body at `main.ts:4878` with a self-contained strict comparison (own local regex capturing prerelease; core numeric compare, then no-prerelease > has-prerelease, then identifier-by-identifier: numeric identifiers numerically, else lexically; numeric < alphanumeric — SemVer §11). **Keep the existing `return 0` on unparseable input** and add a comment: callers (`updateAvailable` checks, store `minRuntime` gate) treat 0 as "no update"/"compatible", a deliberate fail-quiet direction that differs from the installer's per-caller policies; reference `packages/installer/src/version.ts` as the reference implementation.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Tests, then full gates

Write the Test plan's tests; run focused tests; `npm run build`; full `npm test`.

## Test plan

`packages/installer/test/semver-precedence.test.ts` (create; model on any small installer test): table-driven —

- Precedence: `compareSemverPrecedence("1.0.0", "1.0.0-alpha.9") > 0` (the headline bug, inverted before the fix); `"1.0.0-alpha.2" < "1.0.0-alpha.10"` (numeric identifiers); `"1.0.0-alpha" < "1.0.0-alpha.1"`; `"1.0.0+build"` vs `"1.0.0"` → 0; `"v1.2.3"` vs `"1.2.3"` → 0; unparseable input → throws.
- Identity: `semverIdentityEquals("1.0.0+build-a", "1.0.0+build-b") === false` (the audit's case); `("v1.2.3", "1.2.3") === true`; `("1.0.0-alpha.1", "1.0.0-alpha.1") === true`; `("garbage", "garbage") === true`; `("garbage", "1.0.0") === false`.

Extend the self-update tests:

- Update gate returns `true` for current `1.0.0-alpha.9` → target `v1.0.0` (was `false`).
- Downloaded-version verification **rejects** a build-metadata mismatch.
- `selectRelease` still ignores stable tags and picks the highest prerelease (`1.0.0-alpha.10` over `1.0.0-alpha.9`).

Extend/create a repair-gate test:

- Corrupt `state.version` (e.g. `"not-a-version"`) still takes the repair branch.

Runtime: if an existing runtime test exercises `updateAvailable` or the store gate behaviorally, extend it; if the only coverage is source-text regex tests, put the comparator cases in the installer suite only and note the runtime gap in your report (do not add source-text tests).

## Done criteria

- [ ] `grep -rn "parsePrereleaseSemver" packages/installer/src` → no matches; `grep -rn "semverIdentityEquals" packages/installer/src` → definition + the verify call site.
- [ ] New semver test file passes, including the `1.0.0` vs `1.0.0-alpha.9`, build-metadata-mismatch, and corrupt-state-repair cases.
- [ ] `npm run typecheck`, `npm run lint` exit 0; focused installer tests all pass; `npm run build` exit 0; full `npm test` passes or unrelated pre-existing failures documented in `plans/artifacts/`.
- [ ] `desktop-version.ts` untouched.
- [ ] `git status --porcelain > plans/artifacts/006-after-status.txt`; diff vs baseline shows only in-scope paths, regenerated assets, `plans/artifacts/*`, and `plans/README.md`.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- An import cycle between `version.ts` and `codex-source-release.ts` that step 1's move-and-re-export fallback doesn't resolve cleanly.
- `selectRelease`'s filtering depends on `parsePrereleaseSemver` rejecting inputs that `parseSemver` accepts in a way the `prerelease.length === 0` filter doesn't reproduce — report the difference with concrete example tags.
- An existing test fails because it pinned the naive ordering (e.g. expected `1.0.0-alpha` == `1.0.0`). Confirm the test was asserting the buggy behavior (not some other contract) before updating it; if unclear, STOP.
- Any `minRuntime` value in `store/index.json` is a prerelease form (all are release-form `>=x.y.z` today) — the runtime gate's behavior for it would change; report it.
- Plan 002 is not yet DONE in `plans/README.md` (same-file dependency).

## Maintenance notes

- `version.ts` is now the canonical comparator module for Tweaker's own versions; `codex-source-release.ts` remains canonical for Codex source tags. Future comparator needs import, never copy — the runtime's local `compareVersions` is the one sanctioned exception (CJS boundary) and carries a pointer comment.
- Reviewer focus: the per-caller fail-safe table — each unparseable-input branch fails toward safety for *that* caller (update: take it; verify: reject; repair: repair; runtime: quiet). A future caller must choose its own, not inherit one.
- If the repo later adopts the `semver` npm package, the precedence/identity split maps onto `semver.compare` vs exact `semver.parse(...).format() === ...` plus raw build comparison; deliberately not adopted here to keep the update path dependency-free.
