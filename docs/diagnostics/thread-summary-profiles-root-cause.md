# Thread Summary Profiles root-cause evidence

## Diagnosed source and data boundary

The old runtime source is the generated ShadGPT asset at:

`../shadgpt-source/packages/installer/assets/default-tweaks/co.tweakers.thread-summary-profiles/index.js`

Its SHA-256 during the 2026-07-10 diagnosis was
`44928b698030414b88582a8284deab39520595333284a6e3593b4acce8b388d5`.
The installed Profiles file and this asset had the same digest, so the diagnosis
applied to the installed copy. Installed Projects did not match either the
packaged Projects asset or the new v4 source, which separately demonstrated
source/runtime drift.

The old Profiles tweak never consumed current Projects state. It invoked its own
`getThreadProfileSummary` handler, keyed its cache by inferred `projectPath`,
read legacy path-keyed storage, and probed local Git, Modal, Supabase, Google,
and Railway configuration. Current Projects stored normalized nodes in
`projects-v1.json`; ordinary tweak IPC was namespaced, so Profiles could not
call a Projects handler through its own `api.ipc` namespace.

## Executable evidence

The source diagnostic includes a synthetic current Projects fixture with GitHub,
Modal, and Supabase connections. Its compatibility test demonstrates that:

1. the project/workspace identity must survive normalization;
2. old Profiles returns no rows when assignments exist only in current Projects
   state;
3. Projects must expose the narrow read-only `profiles.read` operation.

From the enclosing `revi` directory, run:

```sh
node --test diagnostics/thread-summary-profiles/thread-summary-profiles.compat.test.cjs
```

The response contract and fixture are retained at:

- `diagnostics/thread-summary-profiles/projects-read-api.contract.json`
- `diagnostics/thread-summary-profiles/fixtures/current-project-with-profiles.json`

The diagnosis also recorded lifecycle failures: hidden empty state, errors
collapsed into empty results, shallow route observation, retained detached
panel observers, style leakage, and a five-second cache without Projects
revision invalidation.

## Runtime evidence and limits

Logs showed Profiles and Projects loaded together, but the old code intentionally
converted IPC/data failures to empty rows, so the absence of an error log was
not evidence of success. Only standard ChatGPT was running during diagnosis;
ShadGPT was not restarted and a live summary DOM snapshot was not captured.
That DOM verification remains distinct from the source-proven data disconnect.

## Mapping to the fixed contract

The current renderer is
`tweaks/co.tweakers.thread-summary-profiles/index.js`. Its focused test
`test/profiles-contract.test.cjs` maps directly to the diagnosed failures:

- read-only, redacted Projects projection;
- distinct visible Loading, Empty, Error, and Ready states;
- Projects `revision` included in the render signature;
- deep route observation and cleanup of mounts, listeners, observer, and style;
- existing mount invalidation on project route and
  `codexpp:projects-revision` changes.

Run the current regression suite from this repository:

```sh
node --test tweaks/co.tweakers.thread-summary-profiles/test/profiles-contract.test.cjs
```

