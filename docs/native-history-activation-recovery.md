# Native account activation recovery

This procedure applies only to the private `native-history-activation-run-v1`
operation. It does not authorize a new activation or an app restart. Complete
source checks and candidate validation first; obtain the final activation
window separately. No recovery step copies or restores account history.

The explicitly approved one-shot activation uses launchd’s Interactive process class: reopening the app depends on completion, and background throttling can exhaust the bounded native probes and rollback censuses. Each native capability probe binds both `CODEX_HOME` and `CODEX_SQLITE_HOME` to its disposable directory.

## Read the operation evidence

The canonical manager root is `~/Library/Application Support/Tweakers`. Each
operation has a UUID directory under `transactions/native-history-activation/`
containing `context.v1.json` and `journal.v1.json`. The context binds the exact
manager generation, source generation, app identities, history roots and
registration fingerprint. The environment transaction uses the same UUID.

1. Retain the entire operation directory, environment receipt and independent
   variant promotion journal. Treat these as private: they contain local paths
   and account configuration references. Do not paste secrets or raw account
   files into logs.
2. Read the recorded error and phase. Verify the context and journal schemas,
   matching operation ID and registration fingerprint. A committed record needs
   its registration and broker evidence; a partial record is not success.
3. Inspect the exact bound paths with no-follow filesystem checks. Record the
   current directory device/inode identities, file fingerprints, process start
   identities and socket owner. Do not infer absence from an unreadable path,
   dangling link, missing process name, or a failed inspection command.

The launch agent is one-shot (`KeepAlive` is false). Any existing nonterminal
journal refuses replay. Do not delete the journal, rerun its private command,
create a new operation, or edit its phase to bypass this protection. An
interrupted operation needs an explicit, journal-bound recovery decision.

## Cancellation before publication

A final writer check can reject the operation after the original ChatGPT main
process closes but before either candidate is promoted. The environment can
then reopen its untouched source and finish as `cancelled` with attempt zero,
no applied evidence, and no new candidate PID. This differs from a partially
applied transaction and does not require replacing the source app.

The coordinator accepts this path only after the independent candidate reports
that its pre-promotion hook was cancelled and staging recovery completed without
errors. It then proves that registration and reservation are absent, the sealed
environment selection is unchanged, and the original ChatGPT app still matches
the prepared rollback fingerprint. An applied transaction still requires the
ordinary rollback proof. A failed candidate archive remains `recovery-required`.

New journals capture the previous Tweakers PID and start token before shutdown.
An explicit null means the app was observed absent; a missing field in an older
journal means its prior running state is unknown. Do not invent a reopen
obligation from that unknown value. The activation-specific shutdown stops only
captured, identity-bound app helpers after main-process shutdown. Newly opened
apps and external history writers still block the final census, which records
the obstruction category and bounded PID list without commands or history paths.

For an older operation stranded in `recovery-required` by cancellation
classification, retain its original journal. Record a separate operation-bound
recovery decision only after proving unchanged app/state bindings, matching
source bytes, absent registration/reservation, and no unfinished independent
promotion. Preserve the original environment receipt and failed candidate.
A fresh operation may then use the existing final activation authorization when
that authorization still covers the same apps and scope; it must prepare a new
context and revalidate candidates before any interruption.

Recheck the latest user constraint before preparing that operation. An earlier
two-app approval does not cover native Codex after the user withdraws its restart
authority. A newly sealed context with `activationScope: "tweakers-only"`
prepares and promotes only the independent app. Initial registration publishes
broker-private metadata without changing native homes; the secondary account
must be idle before its lock projection or configuration can change. The native
primary's existing lock directory is reused without modification. While that
account is busy, its existing settings remain in use and inheritance is deferred;
its intervening edits must be captured before later idle materialization.
Native config and SQLite roots may be the same directory within one account. Signed native homes and writer-lock directories accept owner-owned `0700` or `0755` without chmod; broker-private metadata still requires `0700`. Aliases between different accounts remain invalid.
Portable handoff likewise accepts existing native home and tweak-container modes `0700`/`0755` and native global-state JSON modes `0600`/`0644`. Private continuity records retain their stricter permissions. A proven running desktop postpones preference merging after fixed-root, bundle and pending-recovery checks, without traversing mutable capability content. Prelaunch still requires the exact wrapper/manager process ancestry; the system process with parent PID zero is a valid census entry.
Broker observation also accepts the system process's parent PID zero. For
Tweakers-only activation, the running broker and bridge must use the exact
installed variant runtime paths. The complete installed runtime and those
entrypoint bytes must match the sealed manager runtime. Offline preparation
checks the sealed runtime before promotion, when the installed runtime may still
be the previous generation.
The independent promotion still requires a valid shared account registration.
Rollback in this scope stops only Tweakers and the identity-proven broker. Preserve a
rolled-back operation and its archive rather than restoring its authority by
copying metadata into place.

Once independent commit begins, a later outer-journal failure retains registration
and records `recovery-required`. Inspect the independent promotion's durable
journal before deciding the outcome; do not archive registration or invoke an
already-finalized compensating rollback.

If the environment commit returns a failed receipt, the coordinator retains its
bounded error detail before rollback replaces that receipt. Offline continuity
also records the census obstruction category and bounded PID list. Nested error causes and aggregate errors are retained within a bounded journal message. Passing a
later static preflight or isolated native-backend probe is retrospective evidence,
not proof of the original time-dependent failure.

## Restore only after removing shared registration authority

The coordinator normally performs this ordering itself. If it reports
`recovery-required` with published or ambiguous registration, keep only the
participating apps closed and preserve its artifacts. In Tweakers-only scope,
native Codex remains running and protected. An operator must prove
each remaining boundary before continuing:

1. Match any surviving broker to the context's runtime bytes and scope-specific host path, exact argv,
   configuration hash, socket path, PID and process start token. The socket is
   derived by `routerControlSocketPath`, under `/tmp/arc-<uid>/`, not inside the
   account root. Capture ownership before stopping app parents. A reused PID,
   changed socket owner, unexpected ancestry or unprovable executable blocks
   signaling; do not kill by name or PID alone.
   A dead broker with stale sockets is not a successful normal shutdown. An
   explicit recovery procedure must retain the earlier verified identity and
   freshly prove PID absence, no matching broker process, no socket owner, and
   refused connections. After participating apps stop, recheck the exact private
   socket and parent inodes before moving those sockets to a private recovery
   archive. A timeout, permission error, reused PID or changed inode is a stop.
2. Stop the exact participating apps and proven broker, then establish that
   enrolled history writers and the broker socket listener are absent. The
   post-publication census allows the registration directory to exist.
3. Verify the complete published registration against the signed context and
   recorded directory identities. Move the whole global registration root
   first, then its sibling `.native-setup-reservation`, into the operation's
   private `registration-archive` directory using same-device durable renames.
   Preserve runtime-created metadata with the root. Never delete or republish it
   as a shortcut. No native account home or conversation database is moved.
4. Persist both archive paths in `journal.archive` before restoring either app.
   If only one rename completed, reconcile its recorded inode at the original
   and archive paths. Preserve both locations and stop if ownership or durability
   cannot be proved. A reservation-only or otherwise ambiguous publication is
   also a recovery stop; absence of a full registration receipt does not permit
   reopening the original client.
5. Restore the independent Tweakers promotion transaction first. Only after it
   succeeds may the exact injected environment transaction roll back and reopen
   ChatGPT. An untouched, proven source can finish as `cancelled`; an applied
   candidate must finish as `rolled-back`. A failed or uncertain restoration
   does not satisfy either result.
6. Reopen the previous Tweakers app only after both restoration checks succeed
   and its original app/state identity is verified. Retain the archive paths if
   any later step fails. Do not reset history databases, replay submitted turns,
   or restore credential snapshots.

There is deliberately no generic automatic crash-recovery command. If the
recorded evidence cannot prove this sequence, retain `recovery-required` and
prepare a specific recovery procedure from the current files and processes.
After successful restoration, a fresh activation requires a new preview,
complete candidates, and an explicitly authorized final window.
