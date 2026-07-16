# Thread Summary Profiles diagnostic and current fix

This normalizes the July 10 workspace diagnosis at
`diagnostics/thread-summary-profiles`. The shipped legacy Profiles tweak read
path-keyed files and local CLI probes instead of current Projects state. It
could not address the Projects IPC namespace, collapsed transport errors into
an empty result, cached without a Projects revision, observed too shallowly,
and retained detached observers/styles.

The current implementation splits ownership deliberately:

- `co.tweakers.projects` owns project identity, assignments, redaction,
  revision changes, and the read-only `profiles.read` response.
- `co.tweakers.thread-summary-profiles` owns only summary discovery,
  presentation, and lifecycle cleanup.
- the runtime allows exactly one cross-tweak route: versioned Profiles to
  Projects `profiles.read`; writes and all other caller/target combinations are
  rejected.

## Reproduction and regression commands

The original data-disconnect fixture remains archived outside this repo at
`diagnostics/thread-summary-profiles/thread-summary-profiles.compat.test.cjs`.
Run the current contracts with:

```sh
node --test tweaks/co.tweakers.projects/test/projects.test.js
node --test tweaks/co.tweakers.thread-summary-profiles/test/profiles-contract.test.cjs
node --import tsx --test packages/runtime/test/cross-tweak-read.test.ts
```

## Current fix mapping

| Diagnosed gap | Current owner/proof |
|---|---|
| Profiles could not read current Projects | The runtime `dispatchCrossTweakRead` allowlists the versioned read route. |
| State lacked stable project resolution | Projects owns normalized IDs/workspace identity and the projection request. |
| Paths/secrets leaked through raw state | Profiles normalization and runtime response validation reject path/secret-shaped output. |
| Empty and error were indistinguishable | Profiles renders explicit loading, empty, error, and ready states. |
| Cache ignored assignment changes | The render signature includes the Projects revision. |
| Nested navigation and cleanup were incomplete | The source contract requires deep observation, route listeners, disconnect, and owned-node/style removal. |
| Installed/source copies could drift | The catalog/package parity gate hashes the canonical and generated source trees. |

The remaining live validation is a read-only snapshot from an already-running
app containing a real thread summary; it is not required to prove the source,
IPC, migration, and package contracts recorded here.
