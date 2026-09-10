# Codex accepted-build attestation

The receipt-bound injected candidate has two independent trust stages. A
successful compilation is not an accepted build.

1. `codex-source build`, `canary-pass`, and `freeze` create a schema-v2
   `codex-derived` receipt. The build records the exact OpenAI tag and commit,
   patched source tree, patch-series and canonical applied-diff hashes,
   `Cargo.lock`, Rust toolchain, locked build command, backend identity, Rust
   lifecycle results, and isolated managed-MCP integration canary.
2. `codex-build-attestation review` independently re-probes that evidence and
   creates an immutable owner-private review manifest.
3. `codex-build-attestation accept` requires the release owner to provide the
   exact review-manifest SHA-256. It re-runs every verification, copies the
   exact backend into the private acceptance directory, and only then issues
   the strict `tweakers-prebuilt-codex-build` receipt.

This is a local single-owner trust model. The trust anchor is the current macOS
user executing an explicit hash-bound acceptance inside a canonical directory
owned by that user. Directories are mode `0700`; receipts and manifests are
mode `0600`; the accepted backend is mode `0700`. Immutable publication uses a
same-directory temporary file plus an exclusive hard-link, so an existing
artifact with different bytes is never replaced. Exact replays are idempotent.
No signing key or external attestation service exists in this repository, so
the command does not claim cryptographic identity beyond the local owner and
the existing candidate/runtime code-signing checks.

## Review

Run this only after the source build has a `canary-passed` frozen receipt:

```sh
node packages/installer/dist/cli.js codex-build-attestation review \
  --transaction <transaction-id> \
  --derived-receipt '<user-root>/codex-source/receipts/<transaction-id>.json'
```

The command writes only beneath:

```text
<user-root>/codex-source/accepted/<transaction-id>/
```

New production artifacts belong under
`~/Library/Application Support/Tweakers`; the archived `codex-plusplus` data
root is rejected as an acceptance authority.

Its JSON result includes `reviewManifestPath`, `reviewManifestSha256`, and the
future owner-private backend path. Inspect the manifest before accepting it.

## Explicit acceptance

Copy the exact digest from the reviewed result; do not recalculate it after
editing the manifest:

```sh
node packages/installer/dist/cli.js codex-build-attestation accept \
  --review-manifest '<absolute-review-manifest-path>' \
  --accept-reviewed-manifest-sha256 <exact-reviewed-sha256>
```

There is deliberately no `--yes` or `--force` shortcut. The accepted receipt,
backend, and acceptance record remain private inputs to
`prebuilt-combined-candidate prepare`. Neither attestation action installs,
promotes, launches, quits, or restarts an application.

## Recovery and rollback

- If review or acceptance is interrupted before exclusive publication, rerun
  the identical command. Already-published identical evidence is reused.
- If any published file differs, stop and retain the whole transaction
  directory for diagnosis. The command will not overwrite it.
- Before live promotion, rollback means abandoning the disposable candidate
  and retaining or archiving its private evidence. No installed app has been
  changed at this stage.
- Live promotion remains the separate
  `prebuilt-combined-candidate promote` operation and requires its own explicit
  activation authorization.
