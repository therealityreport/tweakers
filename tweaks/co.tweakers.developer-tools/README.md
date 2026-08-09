# Developer Tools

Developer Tools is a read-mostly view of supported non-secret Codex tool
configuration, model catalog entries, runtime capability evidence, and an
optional local OpenAI Codex source checkout. CLI feature flags remain owned by
native Settings.

## Data and recovery

- The tweak reads `~/.codex/config.toml` and only offers edits for supported
  boolean `[tools…]` values. It never renders values whose keys look like
  credentials.
- Before every supported edit or restore, it writes a configuration backup in
  the tweak data directory. The backup directory is owner-only (`0700`) and
  files are owner-read/write (`0600`). The newest 10 backups are retained.
- Settings exposes backup history using opaque IDs, labels, and timestamps; a
  credential-redacted and size-bounded preview; restore; and delete. Restore
  and delete each require explicit confirmation. A restore first backs up the
  current configuration. Recovery history and preview responses expose no
  configuration or backup filesystem paths to the renderer.
- There is intentionally no “changed from default” filter: the tweak has no
  authoritative defaults contract for a user's external configuration.

## Source discovery

Choosing **Refresh source** is the only action that contacts the network. It
clones or updates the public `openai/codex` source into this tweak's local data
directory, then performs asynchronous, cancellable source evidence discovery.
Each job is limited to one repository, 120 directories, 2,000 total directory
entries, 300 eligible files, 64 KiB per file, 400 evidence results, 7.5
seconds of source scanning, and 30 seconds for the complete refresh job. The
scanner checks cancellation and its deadline throughout each directory and
periodically yields even when entries are skipped. Progress and partial
results remain visible while the job runs; budget exhaustion is reported as a
partial result rather than silently continuing. A cancelled or failed initial
clone removes only its validated temporary staging directory.

## Privileged boundary

The renderer only requests narrow actions through the sender-validated runtime
IPC service. Filesystem and network behavior is declared in the manifest. The
**Open Settings** control is a runtime-owned native application-menu command,
not a text search through host DOM buttons.
