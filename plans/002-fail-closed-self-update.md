# Plan 002: Make self-update fail closed when release integrity assets are missing

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
> git status --porcelain > plans/artifacts/002-baseline-status.txt
> git diff -- packages/installer/src/commands/self-update.ts packages/installer/src/cli.ts update.sh packages/installer/test > plans/artifacts/002-before.diff
> ```
>
> **Drift check**: compare the "Current state" excerpts below against the live
> files. The excerpts are the authority (HEAD is `46a2fcc` and the working tree
> is ahead of it, so commit-range diffs prove nothing). On a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but must land before plan 006, which edits the same file)
- **Category**: security
- **Planned at**: commit `46a2fcc`, 2026-08-19 (dirty working tree); revised 2026-08-19 after external audit

## Why this matters

The self-update path (`tweaker update`, also run periodically by the launchd watcher) downloads a release, **builds it** (`npm run build` executes the fetched code's build scripts), and promotes it to the managed source root that the watcher then executes at login, hourly, and on every Codex update. When the release has a `SHA256SUMS` asset, the tarball is checksum-verified. When it does not, the code logs "unverified" and proceeds with **no integrity check at all** — download, extract, build, execute.

Be precise about what this fix buys. Making the missing-checksum case fail closed:

- prevents silent installation of a **missing, corrupted, or truncated** release asset,
- enforces the repository's own release contract — `.github/workflows/release.yml` states in a comment that "the SHA256SUMS asset is the mandatory integrity anchor", which the current code contradicts,
- removes a downgrade path where the absence of one asset silently disables all verification.

It does **not** defend against an actor who can publish releases for the configured repo: such an actor publishes both the tarball and a matching `SHA256SUMS`, since both live in the same GitHub release. Authenticity against a compromised publisher requires a detached signature (minisign/cosign/GPG) verified with a key anchored **outside** the release account — that is the explicit follow-up recorded in Maintenance notes, deliberately out of scope here.

Separately, `update.sh`'s fallback path (`exec bash -c "$(curl …)"`) swallows a failed download: `curl -fsSL` fails silently with empty output, command substitution does not trip `set -e` for `exec bash -c`, so the user gets a clean exit 0 while nothing was installed. Same theme — a distribution path that fails open.

## Current state

- `packages/installer/src/commands/self-update.ts` — the self-update command. The verified/unverified branch (lines ~188–202):

```ts
      const assetBase = `https://github.com/${repo}/releases/download/${encodeURIComponent(target.ref)}`;
      const sumsText = await fetchReleaseText(`${assetBase}/SHA256SUMS`);
      if (sumsText) {
        const assetName = `tweakers-${target.ref}.tar.gz`;
        log(opts, `Downloading verified release asset ${assetName} from ${assetBase}...`);
        await download(`${assetBase}/${encodeURIComponent(assetName)}`, archive);
        verifyChecksum(await sha256File(archive), parseSha256Sums(sumsText), assetName);
        mkdirSync(next, { recursive: true });
        await extractTar({ file: archive, cwd: next, strip: 1 });
      } else {
        log(opts, `No SHA256SUMS asset for ${target.ref}; falling back to source tarball (unverified).`);
        await download(`https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(target.ref)}`, archive);
        mkdirSync(next, { recursive: true });
        await extractTar({ file: archive, cwd: next, strip: 1 });
      }

      verifyDownloadedVersion(next, target);
      installDependencies(next, opts);
      run(npmCommand(), ["run", "build"], next, opts);
```

  After this, the tree is promoted (`renameSync(next, sourceRoot)`) and provenance is written.

- `packages/installer/src/cli.ts` — registers the `update` command (locate with `grep -n "\"update\"\|self-update" packages/installer/src/cli.ts`); this is where the new flag is declared.
- `.github/workflows/release.yml` — generates `SHA256SUMS` for every `v*` tag release ("Build release tarball + checksums" step) and comments: signing is optional, "the SHA256SUMS asset is the mandatory integrity anchor."
- `update.sh` — full current content of the fallback (lines 10–11):

```sh
echo "[!] tweaker is not installed in PATH; running the installer instead." >&2
exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/therealityreport/tweakers/main/install.sh)"
```

- `install.sh` — the exemplar that guards the same download correctly (lines ~77–79):

```sh
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$ARCHIVE" ||
  fail "Download failed from https://github.com/$REPO ($REF). Check the repo, branch, and network connection."
```

- Existing tests for this command live in `packages/installer/test/` (Node built-in test runner via tsx; naming pattern `*.test.ts`). Check for an existing `self-update` test file first (`ls packages/installer/test | grep -i update`) and extend it if present rather than creating a parallel one.

Repo conventions that apply:

- TypeScript, ESM, Node 20+. Error style in this file: `throw new Error("message")` with actionable text; the CLI wrapper in `packages/installer/src/cli.ts` formats and reports it.
- `AGENTS.md` change workflow, quoted: "**Runtime/installer:** run focused tests, typecheck/build, and full suite." The full `npm test` run is a required gate for this plan (prereqs: Xcode Command Line Tools and python3 — the suite compiles the native host and runs the mcp-lifecycle Python tests).
- Do not restart, repair, or touch the live Codex app or the installed watcher (`AGENTS.md`, "No mid-plan app restarts"). This plan changes source only. Do **not** run `tweaker update` against the live system to test.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Focused tests | `node --import ./scripts/test-root-preload.mjs --import tsx --test packages/installer/test/self-update*.test.ts` (adjust filename to what exists/you create) | all pass |
| Lint | `npm run lint` | exit 0 |
| Build | `npm run build` | exit 0 |
| Full suite | `npm test` | all pass (see STOP conditions for pre-existing failures) |
| Shell syntax | `bash -n update.sh` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `packages/installer/src/commands/self-update.ts`
- `packages/installer/src/cli.ts` (flag registration for `--allow-unverified`)
- `update.sh`
- One test file in `packages/installer/test/` (extend existing self-update test or create `self-update-verification.test.ts`)
- `plans/README.md` (status row update)
- `plans/artifacts/` (evidence files)
- `packages/installer/assets/runtime/**` — only as regenerated output of `npm run build`

**Out of scope** (do NOT touch):

- `install.sh`, `update.ps1`, `install.ps1` — `install.ps1`/`update.ps1` already propagate failures via `$ErrorActionPreference = "Stop"`; `install.sh` already guards its download.
- `.github/workflows/release.yml` — already produces `SHA256SUMS`.
- The watcher (`packages/installer/src/watcher.ts`, `watcher-cycle.ts`) — it calls the same updated command; no separate change needed.
- Signature verification (minisign/cosign) — the follow-up, not this plan.
- Every pre-existing dirty path in `plans/artifacts/002-baseline-status.txt` not listed in scope.

## Version control protocol

- **No branches, no commits, no stash, no reset.** All work stays in the working tree; the operator decides what to commit later (`AGENTS.md`: preserve unrelated staged, modified, and untracked work).
- Change evidence: `git diff -- <in-scope paths> > plans/artifacts/002-after.diff` when done.

## Steps

### Step 1: Make the missing-SHA256SUMS branch fail closed

In `self-update.ts`, replace the `else` branch above so the default behavior is an error:

```ts
      } else if (allowUnverified) {
        log(opts, `WARNING: no SHA256SUMS asset for ${target.ref}; proceeding UNVERIFIED because --allow-unverified was set.`);
        await download(`https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(target.ref)}`, archive);
        mkdirSync(next, { recursive: true });
        await extractTar({ file: archive, cwd: next, strip: 1 });
      } else {
        throw new Error(
          `Release ${target.ref} has no SHA256SUMS asset, so its integrity cannot be verified. ` +
          `Refusing to install. Re-run with --allow-unverified to override (not recommended), ` +
          `or wait for a release published with checksums.`,
        );
      }
```

`allowUnverified` comes from step 2. Match the surrounding code's exact naming and logging helpers — read the function you are editing first and adapt the snippet to its local variables (`opts`, `log`, `download`, `extractTar` are the names in the current code).

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Thread an `--allow-unverified` option through the command

In `packages/installer/src/cli.ts`, find the `update` command's sade registration and add a boolean `--allow-unverified` flag, default `false`, following the exact pattern of an existing boolean flag on the same command. Thread it into the options type consumed by `self-update.ts` as `allowUnverified`.

Important: the **watcher-driven** invocation must NOT set this flag — verify by grepping how the watcher invokes updates (`grep -rn "update" packages/installer/src/watcher-cycle.ts | head`) and confirming it passes no new flag.

**Verify**: `npm run typecheck` → exit 0. `grep -n "allow-unverified" packages/installer/src/cli.ts packages/installer/src/commands/self-update.ts` → both files match.

### Step 3: Add tests for the three branches

In the test file (see Scope), following the structure of an existing installer test (pick one that injects fetch/download functions if the command supports dependency injection; if `self-update.ts` fetch helpers are not injectable, refactor **minimally** by extracting the branch into an exported pure function like `resolveUpdateArtifactPlan({ sumsText, allowUnverified })` returning `{ mode: "verified" | "unverified" }` or throwing, and test that):

1. `SHA256SUMS` present → verified path chosen.
2. `SHA256SUMS` absent, no flag → throws with a message matching `/SHA256SUMS/`.
3. `SHA256SUMS` absent, `allowUnverified: true` → unverified path chosen.

**Verify**: the focused test command from "Commands you will need" → all pass, including the 3 new tests.

### Step 4: Guard the `update.sh` fallback download

Replace the last two lines of `update.sh` with:

```sh
echo "[!] tweaker is not installed in PATH; running the installer instead." >&2
installer_script="$(curl -fsSL https://raw.githubusercontent.com/therealityreport/tweakers/main/install.sh)" || {
  echo "[!] Could not download the installer. Check your network connection and try again." >&2
  exit 1
}
if [ -z "$installer_script" ]; then
  echo "[!] Installer download was empty. Check your network connection and try again." >&2
  exit 1
fi
exec bash -c "$installer_script"
```

**Verify**: `bash -n update.sh` → exit 0. `shellcheck update.sh` (install via `brew install shellcheck` if absent) → no errors.

### Step 5: Full gates

Run `npm run build`, then the full `npm test` suite (required by `AGENTS.md` for installer work).

**Verify**: build exit 0; full suite passes. If the suite fails in areas this plan did not touch, capture the output to `plans/artifacts/002-suite-failures.txt`, confirm the same failure exists without your changes is **not** possible without stashing (forbidden) — so instead match the failing test names against your diff scope; unrelated failures → report, don't fix.

## Test plan

- New tests (step 3): verified path, fail-closed path, explicit-override path — in `packages/installer/test/`, modeled on the existing installer test structure.
- Manual negative test for `update.sh` without touching the network: `bash -n` plus code review of the guard (documented in your report); a curl-stub harness is optional.
- Full gates per `AGENTS.md`: focused tests + `npm run typecheck` + `npm run lint` + `npm run build` + full `npm test`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "falling back to source tarball (unverified)" packages/installer/src/commands/self-update.ts` → no matches (old silent fallback gone).
- [ ] `grep -n "allow-unverified" packages/installer/src/cli.ts` → at least one match.
- [ ] Focused self-update tests pass, including 3 new cases.
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` exit 0; full `npm test` passes (or unrelated pre-existing failures documented in `plans/artifacts/`).
- [ ] `bash -n update.sh` exits 0 and `grep -c 'exec bash -c "\$(curl' update.sh` → 0.
- [ ] `git status --porcelain > plans/artifacts/002-after-status.txt`; diff vs the baseline shows only in-scope paths, regenerated assets, `plans/artifacts/*`, and `plans/README.md`.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The `if (sumsText)` / `else` structure in `self-update.ts` no longer matches the excerpt (drift).
- The watcher invocation path would inherit `allowUnverified: true` by construction and you cannot isolate it without touching `watcher-cycle.ts` (out of scope).
- Extracting a testable function requires restructuring more than ~30 lines of `self-update.ts`.
- You find that prerelease releases in this repo are published **without** `SHA256SUMS` (check the `selectRelease`/prerelease channel code and any release tooling under `scripts/author-managed-mcp-release.mjs` / docs/releases). If prerelease users would be hard-broken by fail-closed, report that tension — the maintainer must choose (likely answer: also attach checksums to prereleases). Do not weaken the default yourself.
- Full `npm test` cannot run because Xcode CLT or python3 is missing — report the missing prerequisite rather than skipping the gate silently.

## Maintenance notes

- **Follow-up that completes the security story**: detached signature verification (minisign/cosign) with a pinned public key anchored outside the GitHub release account. Until that lands, integrity rests on GitHub account security plus TLS; this plan's fail-closed default removes only the silent-downgrade and missing/corrupt-asset failure modes. The release workflow comment already anticipates signing.
- If a future release pipeline renames the tarball or sums asset, both `release.yml` and `self-update.ts` must move together — they are coupled by the asset names `tweakers-<tag>.tar.gz` and `SHA256SUMS`.
- Reviewers should scrutinize: that the watcher path cannot pass the override, and that the new error message reaches the user through the CLI failure wrapper in `cli.ts`.
