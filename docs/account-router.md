# Accounts routing and native continuity

`co.tweakers.account-switcher` 0.10.2 revises the existing Accounts owner. It adds
quota-based routing, safe automatic failover, pooled profile activity, native
remote pairing, and shared settings with account-local overrides. See the
[Accounts guide](../tweaks/co.tweakers.account-switcher/README.md) for controls.

The functional reference is
[`braindead-dev/codex-subscription-router` at `3a907ab661349d3fdac53b2d2402e231b6570941`](https://github.com/braindead-dev/codex-subscription-router/tree/3a907ab661349d3fdac53b2d2402e231b6570941).
Accounts retains Tweakers' authenticated broker, isolated account homes, and
journaled ownership instead of adopting the fork's installation mechanism.
The visual reference is the original
[`b-nnett/codex-subscription-router` at `b30d97769f2b35facaf22c00365832b62f6b123e`](https://github.com/b-nnett/codex-subscription-router/tree/b30d97769f2b35facaf22c00365832b62f6b123e).
Its screenshots are unchanged in the pinned fork. Keep the fork's added
features, including account actions and remote pairing. Profile, usage, Apps,
Plugins, and MCP belong on their native pages; the Accounts tweak page contains
account management and diagnostics rather than copies of those pages.

Device-code sign-in opens `https://auth.openai.com/codex/device` through the
system's external browser. The Accounts button and legacy enrollment flow use
the same fixed main-process action, so embedded-browser link interception does
not capture the sign-in page. The device code remains in Accounts for the user
to enter; the browser action never accepts a renderer-selected destination.

## Accounts 0.10.0 acceptance checklist

This is the current implementation and acceptance checklist. “Focused verified”
means the relevant source checks passed; it does not establish final integrated,
candidate, installed, or visible acceptance. Final checks must bind the source
and runtime fingerprints produced after the remaining fixes.

### Two-subscription correction, September 9

Approved implementation: exactly two saved subscriptions, displayed by masked
email; native zero-turn bookkeeping must not claim missing history or a live peer.
Real failed/ambiguous turns remain visible. Ownership warnings require current
connected peer activity. Shared-source migration gains a sealed manager prelaunch
path, with two target-home writer checks before donor scanning, clean postponement
before writes, and fail-closed journal recovery after apply begins. Native Codex
stays running; no forced restart or periodic polling. Existing independent refresh
reuses that path and must retain validated transfer-recovery evidence.

The lead owns presentation, shared interface integration, packaging and acceptance.
Sol/medium lanes own history/ownership and manager/continuity respectively; an
Astra/medium reviewer checks the combined result. Earliest integration checks join
real native reads to renderer history status and authenticated prelaunch to a
busy-target/idle-target migration boundary. Extend existing tests only; no root or
whole-router suite rerun. Installed UI acceptance and actual migration completion
remain separate from source completion and candidate preparation.

Source verification for Accounts 0.10.1: renderer checks (116), focused history
and ownership checks, launch checks (14), and manager checks (32) passed. The
independent review caught and closed a refresh failure path that could reopen
Tweakers after unsafe account migration; such failures now keep it closed.

The reported Plugins `broker_unavailable` error was reproduced with a healthy
broker. Its native catalog returned 8,717,373 bytes, exceeding the previous 4 MiB
bridge bound. Plugins now permits bounded 16 MiB results; Apps remains 4 MiB,
Usage 2 MiB, and native HTTP responses 4 MiB. A real broker/socket/renderer test
passes a 9 MiB catalog, rejects 17 MiB, preserves the Apps limit, and proves the
connection remains usable after rejection (8 socket checks passed).

The signed Accounts 0.10.1 candidate is prepared with a verified source-bound
transfer recovery receipt. Manager generation `84789b5a…00da2393` is published
with runtime `1989b5ee…1bd0e5af`; its runtime and managed-runtime seals and
recovery evidence pass verification. The candidate carries the same complete
runtime fingerprint and exact recovery receipt bytes. Runtime/installer builds,
synchronization and catalog checks passed;
unchanged native transfer/retirement source hashes retain their earlier evidence.
The user-authorized Tweakers-only refresh completed through the signed manager
(operation `6f2e505a-6b46-4da4-8070-de0dfdb79b7e`). The app reopened and supplied
matching main/preload/settings runtime-ready evidence; active runtime and retained
recovery verification passed. Native Codex/ChatGPT retained the same process.
Plugin catalog reads now succeed for both subscriptions (9,683,796 and 8,731,940
bytes). Clean settings-migration postponement allows refresh to finish; thrown
migration/recovery errors still keep it closed. Three affected checks and the
installer typecheck passed for that final refresh gate correction.

The shared helper still holds the account, so shared-settings migration remains
pending until a later idle launch. Visual acceptance of the refreshed tabs could
not be completed because Computer Use timed out reading the new app; catalog
transport success is verified separately from UI rendering.

### Native plugin response correction, September 9

The catalog size correction alone did not resolve the visible error. The live
private broker returned complete catalogs for both subscriptions, but the renderer
adapter rejected native plugin IDs and metadata under the generic control-data
redactor. Native plugin IDs legitimately contain `@`; native settings can also
contain keys that the control redactor rejects.

The adapter now follows the broker's existing native-response contract: verify
the exact requested account and surface, enforce the native JSON size/shape
bounds, and redact the public control envelope while preserving native data.
Control commands and events retain their existing redaction. Existing adapter
tests cover real-shaped plugin/config responses, foreign account/surface
rejection, oversized payloads, and unchanged control redaction.

The first refresh rolled back because the prepared main bundle's native hook
inventory fingerprint was absent from the portable-desktop allowlist. Comparison
with the previously accepted bundle proved that this fingerprint literal was its
only change. The reviewed exact main fingerprint is now accepted; executable
changes still fail closed. Fourteen launch-handoff checks and the real-artifact
comparison passed. Installed/UI acceptance follows the guarded retry separately.

The guarded retry completed (`eefd4a13-f2e7-4d16-87de-e90346947f81`) with
manager `edf84457…8f10c80`, runtime `52b1631a…9c2213`, and active promotion
`b0b21afa-6486-4a53-a8ea-17d9c984c69f`. The reopened app supplied the matching
main/preload/Settings readiness receipt. Installed and published transfer-recovery
verification passed; native Codex retained its process and router configuration
was unchanged. Installed adapter reads for both subscriptions include 38 local
plugins and 3,843 `openai-curated-remote` entries. Computer Use still times out on
the exact refreshed app path, so visual page acceptance remains unverified.
Four additional obsolete build/archive directories (5.97 GiB by folder sizes)
were moved to Trash after reference/lock checks. The current installation,
verified rollback, two retained recovered candidates, and unresolved artifacts
remain protected; both app processes were unchanged by cleanup.

### Integration result, September 9

The current implementation preserves the cloned native desktop as the baseline.
Project/history/plugin continuity must not depend on whether the Accounts
presentation is enabled. The registered native source supplies shared defaults;
routing-primary selection remains independent and account-local overrides and
credentials remain local. Existing sign-ins, history, the completed requested
archive, and the user-repaired memory registrations are preserved.

The lead owns shared broker wiring, activation, package/recovery fingerprints,
live state changes and final acceptance. Two source lanes own native project
projection/hooks and account-continuity donor/receipt changes respectively. The
first integrated check joins the real native project shape to desktop startup
and create/delete behavior, and joins a donor distinct from routing primary to
existing continuity capture. No live update occurs before that integration and
the final source/candidate checks complete.

Verification is limited to changed project, continuity, native account-surface,
and package/launch behavior. Reuse the unchanged final transfer/retirement
evidence; do not rerun the root suite or entire router suite without a concrete
affected dependency or regression. Remaining installed acceptance covers project editing/reopening, account
management and detail actions, and the outstanding provider/remote/Browser/
Computer Use checks.
Busy account homes defer writes; native Codex is never interrupted to obtain an
idle window. Device enrollment remains a separate prerequisite; this installation has two subscriptions.

The September 9 source integration is now verified: 8 project projection cases,
4 actual-native integration cases, 24 continuity cases, the real broker project
read, runtime/installer compilation, tweak synchronization and catalog checks
passed. Independent review closed the recorded alias-persistence, serialized
write, nested-deletion, remote-project-shape and interrupted-rebase findings.
The compiled native-main contract is
`7db96727b0bb6c7f00de8bd9b569768e41e832fd29234e9a3af1859dd248a65b`;
the packaged runtime fingerprint is
`ac4f6255d14ea2cb6d1958d855a49368372b338746c7a25eda80f8f340038af7`.
The signed candidate was installed and committed in operation
`980c44c3-b45f-4704-a411-b810a7a2089e`, with Tweakers PID 16881 and
the original native Codex PID 81368 preserved. The manager-bundled equivalent
contract `bb7e895047c2b66416d18ee42faf80eedd117bde4397f39f4862b1e08e300a61`
was independently compared with the compiled helper and admitted explicitly;
the rebuilt manager was published through its descriptor interface. Its actual
launcher safely postponed busy-home writes. A preceding candidate built through
TSX was rejected by the exact contract guard and rolled back before the successful
plain-Node activation. No broader contract bypass was added.
The existing shared generation still needs an idle native-donor rebase; while
its provenance names the old donor, the broker serves existing homes and
reports continuity as deferred instead of publishing from the wrong account.

| Capability | Implementation and existing automated checks | Required installed or provider acceptance | Current status |
|---|---|---|---|
| Stable native popup | Accounts renderer; dynamic popup geometry, idempotent updates, disclosure/focus tests in `account-switcher.test.js` | 60 seconds open during updates, 20 open/close cycles, no duplicate rows, stable focus and scroll | Current installed popup passed a 79-second open/focus hold with two readable account rows and a 127% pooled total. Earlier 20-cycle evidence is retained. Native-menu detail-button activation remains unverified because AX activation returned stale-element errors |
| Account identity and management | Accounts native slot and broker enrollment/preferences; account-switcher/broker tests | Avatars, masked identity, copy email, add/reconnect/rename/disable/cancel with existing sign-ins | Implemented; focused verified; final integration and live pending |
| All-account quota | Broker coalescing and reason-coded per-account refresh; broker/pooled-quota tests | Cold unknown second account, partial failure/retry, 60-second visible refresh without request storms | Implemented; focused verified; final integration and live pending |
| Summed usage | Accounts pooled display and normalized native bars; account-switcher/pooled-quota tests | Summed display across enabled subscriptions; incomplete totals remain labeled | Current installed popup refreshed from unknown to 27% + 100% = 127%; combined Profile activity also loads |
| Native Profile | Installer native slots/query hooks, preload statistics projection; renderer/host-surface tests | Pooled and selected identity, native charts, actual provider activity | Installed native charts and selectors verified for account-2 (41.4B lifetime tokens), account-3 (98.3B), and restored combined view (139.6B). Display totals are rounded independently |
| Native Apps, Plugins, MCP | Captured surface selections, native query/cache/action hooks, exact broker RPC/HTTP schemas; renderer/broker-host tests | Read/action isolation, authorization callbacks, install/uninstall and enable/disable on the intended account | Installed native Plugins page loads account-specific connection/status rows. Plugins selector switching and Apps/MCP authorization or mutation isolation remain unverified; no credentials or provider state were changed |
| Usage and resets | Usage tracker, native reset queries/actions and pooled notice projection; usage-tracker/renderer tests | Selected reset credit list; redemption only by deliberate user action; no false depleted notice | Implemented; mixed depleted/unknown and depleted/stale regression verified (116 Accounts tests); final integration and live pending |
| Routing | Quota urgency, reset-credit weighting, sticky owner, safe failover and Ask first; quota/broker tests | Real depletion and fresh resume; no replay of uncertain delivery | Implemented; focused verified; final integration and live pending |
| Model eligibility | Account-local model cache and bounded discovery; broker/models cases | Different actual catalogs, unavailable catalogs and custom/proxy model behavior; no downgrade | Implemented; focused verified; final integration and live pending |
| Concurrent subscriptions | Enabled resident children, bounded startup and draining; broker-host/broker tests | Both simultaneous accounts, disable while active, continued interrupt/control, remote-pinned work | Implemented; focused verified; final integration and live pending |
| Thread lifecycle | Broker returned ownership and protocol routing; broker-host/protocol tests | Immediate continuation after fork/resume/unarchive; review, steer, interrupt, title, archive and unsubscribe | Implemented; focused verified; final integration and live pending |
| Projects and section order | Native project translation and broker section projection; native-projects/broker-host tests | Cross-account pin/reorder and project changes survive reopening | Current installed sidebar displays all five native project groups and their tasks. Focused projection/native integration checks cover edit/delete, aliases, remote metadata, serialized writes and reconnect guards. Live project mutation/reopen acceptance remains outstanding |
| Shared runtime features | Serialized broker broadcasts, exact-child acknowledgements and late-child retry; broker-host tests | Repeated toggles, partial failure, concurrent changes and a subsequently started child | Implemented; focused verified; final integration and live pending |
| Portable capabilities | Reviewed nonsecret configuration, AGENTS, agents, hooks, Skills and plugin packages; account-continuity tests | Real idle inheritance, custom provider definitions and retained local overrides/credentials | Live migration remains blocked by signed account identity drift and an interrupted plugin-generation publication. Native Chrome latest is valid; the variant loads an older regular bundled Chrome directory, with a surviving helper referencing its former latest path. The orphan Design Docs bridge was moved to Trash and the missing Impeccable marketplace record retired; valid Design Docs sources remain. Both-account inheritance and warning clearance are unverified |
| Remote control | Per-account native remote controller, recoverable source retirement and fresh absence gates; remote-controller/transfer tests | Pairing/expiry/MFA/device revoke, remote-created and resumed work, return to local control | Implemented; host hold/recovery, 70 focused transfer cases and final native A-B-A quarantine verified; integrated suite and live remote pending |
| Pinned task summary | Native thread-summary slot and committed owner projection; renderer/account-switcher tests | Owner label changes only after committed transfer | Implemented; focused verified; final integration and live pending |
| Same-ID transfer | Current-owner v2 journals, paginated streams/history, native writer lease and post-resume proof; native-transfer/history tests | Disposable native A → B → A with edits, pagination, contention, concurrent writers and crash recovery | Implemented; host hold/recovery, 70 focused transfer cases and final native A-B-A quarantine verified; integrated suite and live remote pending |
| Upgrade and recovery | v1 reader, preserved journals, minimum reader marker, retained recovery artifact; transfer/runtime-fingerprint tests | Recovery after interrupted upgrade; stale runtime and rollback paths refuse v2 state | Implemented; current retirement-reader gates and 12 focused fingerprint cases verified; retained artifact prepared and verified |
| Native integration lifecycle | Exact eight-asset receipt verified at build, startup and enable; renderer/host-surface tests | Light/dark/narrow layouts, keyboard use, remount, disable/re-enable and disabled-build-to-enable | Implemented; focused verified; final integration and live pending |
| Independent desktop | Existing Tweakers identity, signed helpers and installer transactions | Tweakers-only promotion, native Codex coexistence, Browser/Computer Use and update/recovery operation | Signed Tweakers-only update committed with Tweakers PID 16881; native Codex PID 81368 and original app hashes preserved. Computer Use read and operated the updated Tweakers app |
| Final source verification | Typecheck, full build, tweak synchronization/check, catalog, eight native asset syntax/bundle checks, full npm test and nested account-router suite | Source freeze and evidence tied to the final runtime fingerprint | Current affected checks passed: 8 project cases, 4 native integration cases, 24 continuity cases, real broker project read, typechecks/builds, sync and catalog. Full root/router suites were not rerun, following user direction. Earlier transfer evidence was reused only after source hashes matched |
| Retained recovery runtime | Both transfer readers, current retirement journals, validated source fingerprint and recovery dependency | Candidate and recovery fingerprints match their bound successful validation | Prepared and verified against the final candidate runtime and source fingerprints |
| Complete signed candidate | Packaged runtime/assets, native compatibility receipt, startup/enable guards and account-bound Apps/Plugins/MCP paths | Signature, package and recovery checks against the complete candidate | Current candidate passed actual packaged native contract, signature, compatibility, startup and recovery checks; plain-Node activation committed. Future manager-bundled emission was separately verified and the manager descriptor updated |
| Live acceptance and activation | Matrix above, including popup timing/cycles and Browser/Computer Use | Separately authorized Tweakers-only promotion; native Codex preserved; credit redemption and device enrollment remain explicit user actions | Current update committed as operation 980c44c3-b45f-4704-a411-b810a7a2089e. Native projects, popup hold and both Profile account views are visibly verified. Account mutations, Plugins selector, provider callbacks, two-account concurrency, remote enrollment and native Browser/Computer Use provider behavior remain outstanding. Shared-settings/plugin writes remain deferred while homes are busy |

After a committed paginated transfer, Accounts retains an independent recovery
copy of the old source projection outside the native account homes, then removes
that stale projection while its source child is stopped. Remote access requires
fresh checks that the selected source rows and rollout paths remain absent.
Interrupted retirement, unsupported history layouts, or changed evidence keep
remote access held. A return transfer imports the current owner's latest history;
it does not restore the old recovery snapshot as current data.

The reviewed native 0.153.4 remote transport uses the same
[request dispatcher](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/message_processor.rs#L1151)
as local app-server requests. Disposable native checks cover resume by ID and
absolute path, including recovery and destination paths, with the destination
stopped. Pairing, connectivity and visible remote operation remain separate
installed acceptance checks.

New transfer records require a separately retained recovery runtime that reads
both transfer formats and the current source-retirement journals. Every preparation
checks the complete pre-metadata source/recovery fingerprints, file counts, reader
module hashes and validation receipt. Recomputing a runtime fingerprint after an
unvalidated source change cannot reuse the older recovery evidence.
Once v2 state exists, promotion and rollback must retain a v2-capable reader;
restoring an old runtime or an old account snapshot is not a recovery procedure.

## Native history

Native registration binds existing account homes without moving their SQLite
databases or credentials. The broker reads native history through each account's
app-server. Public conversation IDs remain unchanged. A same-ID transfer requires
a verified native writer-lock protocol, source quiescence, catalog provenance,
and a proved destination resume before the broker changes ownership and sends
the pending turn. A missing or ambiguous proof never authorizes a segmented
fallback or replay. Actual thread conflicts block only the affected thread.

One desktop at a time is sufficient. Both broker clients may also connect;
active work remains assigned to its originating client. An unmodified official
app is an independent writer and participates in idle desktop continuity through
the managed launch action rather than the broker protocol.

## Routing and compatibility

New work chooses eligible accounts from fresh native quota, prioritizing weekly
capacity, then short-window capacity and reset timing. Manual routing keeps its
selected account. Old `balanced_tokens_v1` configurations migrate to
`quota_aware_v2`; their historical ledger is retained without adding new
fairness reservations. Automatic safe failover is the default; **Ask first** is
available in Accounts. No active or uncertain request is replayed.

## Shared settings and capability definitions

Tweakers shared native mode reads the registered native settings directory directly
and layers one manager-owned Tweakers overlay above it. Both account backends use
the same base and overlay paths. Settings writes, plugin installation/removal,
and marketplace changes target the overlay. Base plugin packages are read at
their original paths; removal markers hide inherited packages without deleting
them. Subsequent config, skill, and plugin reads reload shared content, and the
broker refreshes resident account runtimes after shared settings/plugin mutations.
Upstream session-static model and reasoning defaults retain their normal behavior.

The patched Codex 0.153.4 backend accepts paired `TWEAKERS_NATIVE_BASE_ROOT` and
`TWEAKERS_OVERLAY_ROOT` launch variables. Without that pair, native Codex keeps
its normal behavior. The broker enables the pair only for a signed
`shared-native-mode.v1.json` registration bound to the original source, canonical
root identities, and exact packaged backend hash. Its journaled transition
retires the old unpublished copy intent while preserving previous generations
and account data. In this mode startup bypasses config/plugin copying.

Authentication, databases, rollout paths, writer locks, and original
`CODEX_HOME` bindings remain account-specific. The second subscription uses a
separately signed authentication-home companion and native external authentication:
its history child receives the selected tokens privately, while refresh and
reconnect use the isolated credential home. No credential or history database is
copied into the shared overlay.

Build 8378 Accounts renderer/main mappings now have reviewed exact asset hashes,
including the installer's preceding transforms. Existing executable bundle tests
cover syntax, atomic rejection, idempotence, account selection, and installer
composition. The derived primary window uses the Tweakers title. Native backend
patches are maintained under `patches/codex/0.153.4-*`; full candidate and installed
acceptance remain separate from source verification.

## Remote controls and activity

Accounts uses the native remote API for enable/disable, pairing, device listing,
and revocation. An optional unified catalog uses native catalog projection and
shared writer locks. Remote ownership must settle before desktop writing resumes.
Profile activity reads one selected account or the enabled pool, aggregates
provider-reported statistics, and labels unavailable or partial results.

## Activation and desktop continuity

**Account setup is incomplete** means the manager-global registration is absent;
re-saving accounts is not a repair. Final activation prepares both candidates
before an authorized restart, publishes the registration while idle, prepares
native locks and shared settings, and verifies the desktops sequentially.
Interrupted activation retains its journal; use the
[journal-bound recovery procedure](native-history-activation-recovery.md).

Managed desktop launch merges supported sidebar and presentation state only after
repeated idle observations. It preserves proven native task IDs, records explicit
conflicts, and postpones when another app remains active. Source checks do not
constitute live activation or live acceptance.

## Canonical history compatibility mode

The remaining sections describe the older copied canonical-history mode and its
migration/recovery interfaces. Native mode uses same-ID history and native homes
instead of hidden per-account continuation threads.

## Canonical history authority

The manager-global v3 root contains an owner-private, append-oriented canonical
history. It records logical conversations, ordered segments and turns, account
attribution, safe portable transcript data, and operation receipts. It never
stores credentials, cookies, tokens, raw Electron data, or renderer-visible
provider IDs.

Normal v3 history lists and reads come from this canonical store. The broker
privately maps a public logical conversation to its current account segment
only when work is sent. Legacy account-database fan-out is not a normal v3
history path.

If part of an imported conversation cannot be proved portable, the available
history remains visible with a clear `partial` or `incomplete` state. Unproven
duplicates and divergent histories are quarantined rather than merged by title
or timestamp. A legitimate Account A to Account B continuation remains one
conversation because its segment provenance is explicit.

## Sending and switching subscriptions

- A conversation continues on its current eligible subscription.
- A switch can be proposed only between completed turns. Streaming, tools,
  approvals, interruptions, and uncertain deliveries hold the current segment.
- The unsent turn is held while the UI displays the proposed subscription. The
  user may confirm once, cancel, or choose another eligible subscription. The
  proposal expires after 60 seconds.
- Confirmation creates a fresh hidden provider thread under the destination
  account. The broker sends a bounded, digest-verified continuation package
  made from committed canonical history; it never gives one account another
  account's hidden thread ID.
- If essential context is not safely portable, the broker durably marks the
  source history `incomplete` and presents distinct manual guidance to start a
  separate continuation with the intended subscription, then restate or
  reattach the missing item there. It creates no destination segment or
  automatic link and does not transfer attachments.

One exclusive conversation lease covers both apps. A second simultaneous send
is reported as busy or queued by the broker; it is never dispatched as a
competing write. Each turn has durable phases `prepared`, `dispatching`,
`active`, and `committed`, plus terminal `aborted` and `ambiguous` outcomes.
Ambiguous work is never replayed automatically.

## Broker and desktop boundary

Independent Tweakers and ChatGPT Tweaker mode receive the same sealed broker
location before their app-server startup, while their application profiles and
account homes remain separate. Normal ChatGPT stays in its official mode and
uses its native updater; it is not a broker client. The broker socket and
control socket are owner-private and authenticated with a local capability.

Once v3 broker mode is selected, an unavailable broker, incompatible protocol,
invalid canonical store, or unsafe schema fails closed. The desktop may expose
read-only history, but it must not start a direct fallback writer.

After a committed change the broker emits only a content-free history-change
event. Each connected client refetches its current logical conversation; the
event never contains transcript text, provider IDs, paths, credentials, or
request bodies. Disconnected clients lose their sessions and leases.

Supported MCP OAuth may hand a validated HTTPS authorization URL back to the
originating app. Generic App or Plugin authorization remains visibly
unavailable because account credentials are not transferred or simulated.

## Shared Skills materialization

The offline v2-to-v3 migration takes the one exact legacy `CODEX_HOME/skills`
tree as its input. Regular entries stay beneath that tree. A linked entry is
flattened only when its fully resolved target is still beneath that source tree
or beneath an exact, canonical, owner-owned, non-group/world-writable root
explicitly repeated as `--shared-skills-root <absolute-path>`. Unlisted targets,
escaping link chains, cycles, unsafe owners or modes, credential-shaped names,
and source drift all fail closed. The materialized source contains no links.

The preview result, migration journal, and `shared-skills.v1.json` manifest
record the canonical trusted roots and their identity-bound provenance
fingerprint. They are evidence of the operator's bounded source decision, not
runtime search paths: runtime never follows or reopens those external roots.
It writes a sealed manager-global source beside broker state, then materializes
the same read-only tree into every included account `CODEX_HOME` before the v3
candidate can publish.

Every v3 startup and account-child spawn rechecks the source fingerprint and
each included account copy. Missing, altered, or symlinked trees fail closed;
the runtime does not overwrite an existing account tree to "repair" drift. A
new enrollment receives a fresh materialization in its temporary isolated home
before its login child starts, and the normal enrollment transaction later
renames that complete home atomically.

This shares static Skill definitions only. It does not copy or share auth,
cookies, provider IDs, SQLite state, Apps, Plugins, MCP OAuth credentials, or
mutable Skills configuration. `skills/config/write` and `skills/extraRoots/set`
remain capability mutations and are rejected by the active router.

## Shared plugin packages and enablement

The offline migration requires an exact owner-private
`--shared-plugin-inventory` file in an owner-controlled (not group- or
world-writable) directory for preview, apply, and recovery. Its strict
v1 document is `{version:1,plugins:[{pluginId,version}]}`: a sorted, unique
list of the current effective ID/version pairs from `codex plugin list --json`
where both `installed` and `enabled` are true. It does not read `config.toml`
as a selection authority. Each `name@registry` must resolve directly to its
exact legacy `plugins/cache/registry/name/version` directory—there is no
registry aliasing, fallback, obsolete-version traversal, package-root copy, or
`local` pointer traversal. The migration preserves that exact version layout
in one manager-global sanitized read-only cache.
Exact credential-container regular-file names are never copied: `.env` or
`.env.*`; exact `env`, `env_vars`, `auth`, `auth.json`,
`authorization.json`, `cookies`, `cookies.json`, `credentials`,
`credentials.json`, `oauth`, `oauth.json`, `token`, `token.json`, `tokens`,
`tokens.json`, `secret.json`, `secrets.json`, `client_secret.json`,
`api-key.json`, `api_key.json`, `.netrc`; and filenames ending `.sqlite`.
This is exact-name matching, not a substring filter: ordinary code, docs, and
assets such as `cookies.js`, `simpleClientCredentials.js`,
`generate_secret.js`, and `secret-redaction.md` remain in the package. Each
excluded file's relative path, byte count, and SHA-256 are retained only as
exclusion evidence, so a later source change fails closed without placing
credential bytes in any shared root. Credential-container directories and links
are rejected. The sole configuration
exception is a package-internal `.codex/config.toml` whose whole contents are
exactly `[features]` followed by `hooks = true` or `hooks = false`; every other
config is rejected.

The only non-credential exclusion is the exact relative `.venv/.lock` path
when it is owner-owned, zero-byte, regular, single-link, and not set-id. Its
receipt record has reason `transient-lock`; every other world-writable source
file remains a hard failure.

Source package directories must be owner-owned and non-group/world-writable.
Owner-owned marketplace files may be `0664`, but never world-writable or
set-id; each included and excluded source file is rechecked by device, inode,
timestamp, size, and SHA-256 before publication. The resulting cache is
stricter: every package file is `0400` and every package directory is `0500`.

`shared-plugins.v1.json` records inventory, package, and exclusion
fingerprints. Those fingerprints are also bound into the migration journal and
result, so selection and sanitization are receipt-bound rather than inferred at
runtime.

Each routed account keeps an empty `config.toml`. Its `plugins/cache` is one
read-only relative projection to that sealed cache, not a second physical cache
copy. Before every v3 startup and child spawn, runtime checks the manifest,
source tree, and every projection. Package drift, an extra package, writable
content, an altered projection, or a package symlink fails closed without
repairing an account home.

The child command removes inherited `plugins.*` enablement and, for a real
`app-server` launch, appends only manifest-derived
`plugins.<name@registry>.enabled=true` overrides. That makes the same static
plugin-contributed Apps, Skills, and MCP definitions available in each child
without copying arbitrary configuration. It never copies `config.toml`,
standalone MCP declarations, environment files, tokens, auth, cookies,
provider IDs, OAuth state, or SQLite files. Apps and Plugins remain
non-authorizable; MCP OAuth remains selected-account-local.

## Offline migration

Migration is an explicit installer operation and is never run automatically by
desktop/runtime startup. It requires the legacy v2 layout to be inactive and
uses the completed, receipt-backed account-history adoption proof.

The migration:

- takes immutable source snapshots and checksums;
- copies the opaque account identities, secret, account homes, ownership proof,
  and prepared-history receipts into a private global-v3 candidate;
- imports every proved legacy thread as its own logical conversation and one
  initial account-owned segment;
- recognizes a copied history as an alias only when signed provenance and
  content digests agree;
- journals every durable boundary, preflights the broker schema, and publishes
  the candidate exclusively and atomically; and
- retains interrupted or colliding candidates for inspection rather than
  overwriting an existing global root.

The `tweaker shared-history-migration` command exposes separate preview, apply,
recover, rollback-view, and export operations. Preview, apply, and recover
require every exact source path, one or more repeated
`--shared-skills-root` values, and one exact owner-private
`--shared-plugin-inventory` value; CLI inputs
have no inferred live-root default. Preview is read-only. Apply still does not
install, restart, launch, or activate either desktop app.

Rollback keeps canonical history available through a read-only viewer and a
portable export. It does not flatten multi-account conversations into one
legacy SQLite database and does not discard broker-era conversations.

## Operator evidence

`tweaker status` and `tweaker doctor` keep these facts separate:

| Layer | Meaning | Does not prove |
| --- | --- | --- |
| Source | Canonical tweak and runtime source in the registered checkout. | Generated parity, candidate, installation, or live activation. |
| Generated | Catalog and packaged runtime match canonical source. | That a disposable candidate or installed app contains them. |
| Candidate | A private disposable package passed source and package gates. | Installation, restart, or live behavior. |
| Installed | Runtime artifacts are present in the user directory. | That both desktops restarted into them. |
| Pending | Validated owner-private disk intent and migration evidence. | An active broker generation. |
| Live | Authenticated, redacted status from the running broker. | Provider authorization, a delivered turn, or end-to-end UI acceptance. |

Status output contains finite redacted facts only: configured labels,
eligibility, safe plan labels, masked identifiers, quota freshness, bounded
child/client counts, and ambiguity counts. Migration readiness is reported by
the explicit `shared-history-migration` preview/recovery interface, not inferred
by status or doctor. All of these surfaces reject raw provider IDs, email
addresses, credentials, local paths, thread IDs, request content, and provider
error bodies.

## Legacy v1 and v2 compatibility

Legacy configuration and status remain readable for diagnosis. V1 `balanced`
uses local projected spend. V2 `quota_aware_v1` routes only new threads and
keeps their account ownership sticky. Neither legacy mode provides the v3
shared-history guarantee.

Changing legacy saved configuration is disk intent for a later qualified startup. It
does not hot-switch an existing app-server session. Staging Manual is likewise
a rollback request for a later activation, not proof that a running broker has
stopped. The retired v3 Balance evenly control previously updated
the live routing policy for subsequent safe allocations, without switching an
active turn or changing account topology.

## Offline archive recovery

Before adoption, `prepare-account-history` creates a private history snapshot.
It resolves stale database paths by the conversation ID inside each rollout,
first from the existing history tree and then from the exact approved archive.
Recovered archive files are materialized under
`archived_sessions/recovered-by-tweakers-v1` in the snapshot. Only the cloned
SQLite database receives updated paths; source databases, archive files, and
existing symlinks remain unchanged.

Plain and gzip rollouts retain source and normalized-output fingerprints.
Gzip recovery must finish within the byte limits and pass complete decompression
validation. Recognized metadata is inventoried and excluded from history;
unknown entries, conflicting IDs, and changed inputs stop publication.
The command reports recovered paths, decompressed files/bytes, excluded metadata,
and genuinely missing paths separately. A successful preview does not apply the
snapshot or prove that either account is authenticated.

The apply operation requires the existing repeated zero-writer checks. When the
current desktop hosts the task, a visible Terminal may invoke the exact Node and
CLI from the same sealed manager generation during the approved offline window.
Normalization, adoption/global migration, and runtime activation retain their
separate receipts and acceptance checks.

## Capacity before global publication

`shared-history-migration prepare-adoption --apply` performs the existing
receipt-backed adoption and stops before creating a global migration candidate.
The next `preview` builds the exact canonical projection from that completed
proof. With `--projection-output`, it writes a private review snapshot and signed
capacity receipt outside the source roots. Global `apply` requires that receipt
through `--capacity-receipt` and recomputes its input and output fingerprints.
Changed sources, missing receipts, or exceeded limits stop before publication.

The supported ceilings are 16,384 conversations, 128 MiB for the canonical
snapshot, 128 MiB plus 1,024 bytes for its complete recovery record, and 16 MiB
for migration source evidence. Existing per-conversation and transcript bounds
still apply. These ceilings do not authorize dropping conversations to fit.
Preview reports the actual counts, byte sizes, and remaining capacity.

Before activation, measure the exported projection with the same packaged
runtime in a disposable private directory. The operational acceptance budget is
15 seconds each for load and journal recovery, 5 seconds for a representative
mutation, and 1 GiB peak resident memory. Fixture results establish the probe's
behavior; only the exact imported projection establishes migration readiness.

## Activation boundary

Source changes, passing tests, generated parity, a disposable candidate,
migration readiness, and a pending configuration do not authorize activation.
Installation, quitting or restarting either app, live promotion, authenticated
canary work, dev-sync, commit, push, tag, and publication retain their applicable
authorization boundaries. The project's standing post-change authorization
covers guarded Tweakers updates after source verification; it does not authorize
interrupting native Codex/ChatGPT or publishing a release. See
[build artifact retention](../rules/build-artifact-retention.md).

## Managed desktop handoff commands

Use `tweaker launch-tweakers` or `tweaker launch-official` to synchronize portable desktop settings at an idle handoff and open that desktop. The native Tweakers launcher also runs this check for normal Dock/Finder launches. Direct official-app launches cannot be intercepted. A running desktop postpones synchronization without a warning. Conflicting settings stay in both homes; the launch result identifies their fields, and the Tweakers launcher can open for review without choosing a winner. After the settings agree, retry the managed launch.
