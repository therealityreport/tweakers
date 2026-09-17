import { matchesPersistentDirectoryIdentity, readPersistentIdentityGeneration } from "./persistent-directory-identity";
import { readNativeAuthBindingV1 } from "./native-auth-binding";
import { execFile, spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { RouterConfig } from "./types";
import { isFingerprint, isOpaqueAccountId, isPlainRecord, type OpaqueAccountId } from "./types";
import {
  createNativeHistoryUnionBindingV2,
  nativeHistoryDocumentFingerprintV1,
  nativeHistoryExtensionsBindingSafeV1,
  preflightNativeHistoryExtensionsV1,
  type NativeHistoryUnionBindingV2,
} from "./native-history-extensions";

export {
  accountStorageBindingV2,
  nativeHistoryDocumentFingerprintV1,
  nativeHistoryEffectiveAccountSetFingerprintV1,
  nativeHistoryExtensionsDocumentBytes,
  nativeHistoryManagedEnrollmentReceiptPathV1,
  parseNativeHistoryExtensionsV1,
  publishPreparedNativeHistoryExtensionUpdateV1,
  recoverNativeHistoryExtensionUpdateV1,
  signNativeHistoryExtensionsV1,
  validateNativeHistoryManagedEnrollmentReceiptV1,
  writeNativeHistoryManagedEnrollmentReceiptV1,
  prepareNativeHistoryExtensionUpdateV1,
} from "./native-history-extensions";
export type {
  AccountStorageBindingV2,
  NativeHistoryEffectiveAccountV2,
  NativeHistoryExtensionsV1,
  NativeHistoryManagedAccountV1,
  NativeHistoryManagedAccountBindingV2,
  NativeHistoryManagedAccountDraftV1,
  NativeHistoryManagedEnrollmentReceiptV1,
  NativeHistoryUnionBindingV2,
  PreparedNativeHistoryExtensionUpdateV1,
} from "./native-history-extensions";

/** Signed companion that opts a v3 broker into existing account-home history. */
export const NATIVE_HISTORY_SOURCE_FILE_V1 = "native-history-source.v1.json";
export const NATIVE_HISTORY_SOURCE_KIND_V1 = "account-router-native-history-source" as const;
export const NATIVE_HISTORY_SOURCE_MODE_V1 = "in_place" as const;
export const NATIVE_HISTORY_SOURCE_MAX_BYTES_V1 = 64 * 1024;
export const NATIVE_HISTORY_AUTH_MAX_BYTES_V1 = 256 * 1024;

export interface NativeHistoryDirectoryIdentityV1 {
  device: number;
  inode: number;
  uid: number;
  /** POSIX mode bits, including sticky/set-id bits when present. */
  mode: number;
}

export interface NativeHistoryAccountSourceV1 {
  opaqueAccountId: OpaqueAccountId;
  codexHome: string;
  sqliteHome: string;
  codexHomeIdentity: NativeHistoryDirectoryIdentityV1;
  sqliteHomeIdentity: NativeHistoryDirectoryIdentityV1;
  /** HMAC of the account identity in the account-local auth file. */
  authIdentityHmac: string;
}

export interface NativeHistorySourceUnsignedV1 {
  version: 1;
  kind: typeof NATIVE_HISTORY_SOURCE_KIND_V1;
  mode: typeof NATIVE_HISTORY_SOURCE_MODE_V1;
  protocolFingerprint: `sha256:${string}`;
  accountSetFingerprint: `sha256:${string}`;
  /** The one bound native account that owns projects/sections metadata. */
  metadataAccountId: OpaqueAccountId;
  accounts: readonly NativeHistoryAccountSourceV1[];
  issuedAt: string;
}

export interface NativeHistorySourceV1 extends NativeHistorySourceUnsignedV1 {
  signature: string;
}

/**
 * The source document remains v1, while its runtime binding is the validated
 * v2 effective account union. Keep the old export name for existing callers.
 */
export interface NativeHistorySourceBindingV1 extends NativeHistoryUnionBindingV2 {}

export type NativeHistorySourcePreflightV1 =
  | { state: "absent" }
  | { state: "invalid"; reason: NativeHistorySourceFailureV1 }
  | { state: "ready"; binding: NativeHistorySourceBindingV1 };

/** Source-only proof for recovery before an extension/config union is coherent. */
export type NativeHistoryBaseSourcePreflightV1 =
  | { state: "absent" }
  | { state: "invalid"; reason: Exclude<NativeHistorySourceFailureV1, "invalid_extensions"> }
  | { state: "ready"; stateRoot: string; source: NativeHistorySourceV1; sourceDocumentFingerprint: `sha256:${string}` };

export type NativeHistorySourceFailureV1 =
  | "unsafe_state_root"
  | "unsafe_source_file"
  | "invalid_source"
  | "authentication_binding_invalid"
  | "identity_repair_incomplete"
  | "invalid_extensions"
  | "source_drift"
  | "writer_census_failed"
  | "foreign_writer";

export interface NativeHistoryWriterObservationV1 {
  ok: boolean;
  reason: "ready" | "source_drift" | "writer_census_failed" | "foreign_writer";
  /** PIDs are owner-private diagnostics; callers must not emit them to a renderer. */
  foreignPids: readonly number[];
}

/** Test seam for the host-only writer census; production always reads ps/lsof. */
export interface NativeHistoryWriterCensusDependenciesV1 {
  spawn?: typeof spawnSync;
  uid?: () => number | undefined;
}

export interface NativeHistoryAsyncWriterCensusDependenciesV1 {
  run?: (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  uid?: () => number | undefined;
}

/** Secrets stay in a module-private weak side table, never in the public binding shape. */
const bindingConfigurations = new WeakMap<NativeHistorySourceBindingV1, RouterConfig>();
const bindingSecrets = new WeakMap<NativeHistorySourceBindingV1, Buffer>();
const bindingPersistentFingerprints = new WeakMap<NativeHistorySourceBindingV1, string | null>();
const bindingAuthFingerprints = new WeakMap<NativeHistorySourceBindingV1, string | null>();

/** Authentication-only override; history and settings keep their signed original paths. */
export function nativeHistoryEffectiveAuthHomeV1(binding: NativeHistorySourceBindingV1, account: OpaqueAccountId): string | null {
  const secret = bindingSecrets.get(binding);
  if (!secret || !nativeHistoryBindingSafeV1(binding)) return null;
  try { return readNativeAuthBindingV1(binding.stateRoot, binding.source, secret)?.document.accounts.find((entry) => entry.opaqueAccountId === account)?.authHome
    ?? binding.accounts.find((entry) => entry.opaqueAccountId === account)?.codexHome ?? null; } catch { return null; }
}

export interface NativeHistoryPortableItemV1 {
  nativeItemId: string;
  kind: "user" | "assistant" | "plan" | "tool";
  text?: string;
  name?: string;
  result?: string;
}

export interface NativeHistoryPortableTurnV1 {
  nativeTurnId: string;
  items: readonly NativeHistoryPortableItemV1[];
}

export type NativeHistoryThreadReadContextV1 =
  | { state: "ready"; turns: readonly NativeHistoryPortableTurnV1[]; nativeIds: ReadonlySet<string> }
  | { state: "unsafe" };

/** The account-id proof deliberately stays separate from routing configuration. */
export function nativeHistoryAuthIdentityHmacV1(rawAccountId: string, secret: Buffer): string {
  if (!validRawAccountId(rawAccountId) || secret.byteLength !== 32) throw new Error("invalid native history account identity");
  return `hmac-sha256:${createHmac("sha256", secret)
    .update(`account-router:native-history-auth:v1\0${rawAccountId}`, "utf8")
    .digest("hex")}`;
}

/** Stable companion binding: balance, labels, primary, and generation do not alter account storage. */
export function nativeHistoryAccountSetFingerprintV1(accounts: readonly OpaqueAccountId[]): `sha256:${string}` {
  if (accounts.length < 1 || accounts.some((account) => !isOpaqueAccountId(account))) {
    throw new Error("invalid native history account set");
  }
  const sorted = [...accounts].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error("duplicate native history account");
  return `sha256:${createHash("sha256").update(canonicalJson(sorted), "utf8").digest("hex")}`;
}

export function signNativeHistorySourceV1(
  unsigned: NativeHistorySourceUnsignedV1,
  secret: Buffer,
): NativeHistorySourceV1 {
  if (secret.byteLength !== 32 || !isNativeHistoryUnsigned(unsigned)) throw new Error("invalid native history source");
  const normalized = cloneUnsigned(unsigned);
  return {
    ...normalized,
    signature: sourceSignature(normalized, secret),
  };
}

/** Pure companion/schema/signature/config check. Filesystem identity is checked by preflight. */
export function parseNativeHistorySourceV1(
  value: unknown,
  config: RouterConfig,
  secret: Buffer,
): NativeHistorySourceV1 | null {
  const parsed = parseNativeHistorySourceAgainstProtocolV1(value, config.protocolFingerprint, secret);
  if (!parsed) return null;
  let expectedAccountSet: `sha256:${string}`;
  try { expectedAccountSet = nativeHistoryAccountSetFingerprintV1(config.accounts.map((account) => account.opaqueAccountId)); }
  catch { return null; }
  if (parsed.accountSetFingerprint !== expectedAccountSet) return null;
  const accounts = parsed.accounts.map((account) => account.opaqueAccountId);
  const configured = config.accounts.map((account) => account.opaqueAccountId).sort();
  if (accounts.length !== configured.length || accounts.some((account, index) => account !== configured[index])) return null;
  return parsed;
}

/**
 * Static-only preflight for parent bridge selection. It intentionally does
 * not perform lsof/ps, because an already-running broker child is expected
 * while a second desktop bridge is deciding whether it may connect.
 */
export function readAndPreflightNativeHistorySourceStaticV1(
  stateRoot: string,
  config: RouterConfig,
  secret: Buffer,
): NativeHistorySourcePreflightV1 {
  // Preserve the v3 route exactly when no companion exists.  A legacy caller
  // may spell a temporary root through macOS's /var alias; that is harmless
  // only while native in-place mode is absent.  Once a companion is present,
  // require the signed state root itself to be canonical.
  const candidatePath = join(stateRoot, NATIVE_HISTORY_SOURCE_FILE_V1);
  if (!existsSync(candidatePath)) return { state: "absent" };
  const base = readAndPreflightNativeHistoryBaseSourceStaticV1(stateRoot, config.protocolFingerprint, secret);
  if (base.state !== "ready") return base;
  try {
    const extensions = preflightNativeHistoryExtensionsV1({
      stateRoot: base.stateRoot,
      config,
      secret,
      baseSource: base.source,
      baseSourceDocumentFingerprint: base.sourceDocumentFingerprint,
    });
    if (extensions.state !== "ready") return { state: "invalid", reason: "invalid_extensions" };
    const binding: NativeHistorySourceBindingV1 = createNativeHistoryUnionBindingV2({
      stateRoot: base.stateRoot,
      source: base.source,
      sourceDocumentFingerprint: base.sourceDocumentFingerprint,
      extensionsPreflight: extensions,
    });
    bindingPersistentFingerprints.set(binding, readPersistentIdentityGeneration(binding.stateRoot, secret)?.fingerprint ?? null);
    bindingAuthFingerprints.set(binding, readNativeAuthBindingV1(binding.stateRoot, binding.source, secret)?.fingerprint ?? null);
    if (!bindingPathsAndIdentitiesMatchWithSecret(binding, secret)) return { state: "invalid", reason: "source_drift" };
    bindingSecrets.set(binding, Buffer.from(secret));
    bindingConfigurations.set(binding, structuredClone(config));
    return { state: "ready", binding };
  } catch {
    return { state: "invalid", reason: "invalid_source" };
  }
}

/**
 * Validates only the immutable signed source and its external homes. Recovery
 * calls this before deciding whether the extension/config journal is prior or
 * next, so a temporary mixed union cannot weaken the source proof.
 */
export function readAndPreflightNativeHistoryBaseSourceStaticV1(
  stateRoot: string,
  protocolFingerprint: `sha256:${string}`,
  secret: Buffer,
): NativeHistoryBaseSourcePreflightV1 {
  const candidatePath = join(stateRoot, NATIVE_HISTORY_SOURCE_FILE_V1);
  if (!existsSync(candidatePath)) return { state: "absent" };
  const root = privateCanonicalDirectory(stateRoot);
  if (!root) return { state: "invalid", reason: "unsafe_state_root" };
  const bytes = readPrivateRegularFile(join(root, NATIVE_HISTORY_SOURCE_FILE_V1), NATIVE_HISTORY_SOURCE_MAX_BYTES_V1, false);
  if (!bytes) return { state: "invalid", reason: "unsafe_source_file" };
  try {
    const source = parseNativeHistorySourceAgainstProtocolV1(JSON.parse(bytes.toString("utf8")) as unknown, protocolFingerprint, secret);
    if (!source) return { state: "invalid", reason: "invalid_source" };
    const failure = sourcePathsAndIdentitiesFailure(root, source, secret);
    if (failure) return { state: "invalid", reason: failure };
    return { state: "ready", stateRoot: root, source, sourceDocumentFingerprint: nativeHistoryDocumentFingerprintV1(bytes) };
  } catch {
    return { state: "invalid", reason: "invalid_source" };
  } finally {
    bytes.fill(0);
  }
}

/** Full broker-owner preflight: static binding plus an exclusive writer census. */
export function readAndPreflightNativeHistorySourceV1(
  stateRoot: string,
  config: RouterConfig,
  secret: Buffer,
  ownedPids: readonly number[] = [],
): NativeHistorySourcePreflightV1 {
  const preflight = readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret);
  if (preflight.state !== "ready") return preflight;
  const writers = observeNativeHistoryWritersV1(preflight.binding, ownedPids);
  if (writers.ok) return preflight;
  return {
    state: "invalid",
    reason: writers.reason === "source_drift" ? "source_drift"
      : writers.reason === "foreign_writer" ? "foreign_writer"
        : "writer_census_failed",
  };
}

/** Revalidate the sealed paths/auth identity and reject every foreign open writer. */
export function observeNativeHistoryWritersV1(
  binding: NativeHistorySourceBindingV1,
  ownedPids: readonly number[] = [],
  dependencies: NativeHistoryWriterCensusDependenciesV1 = {},
): NativeHistoryWriterObservationV1 {
  // Manager-local extension homes are protected by the account-child lease.
  // The global native census deliberately guards only immutable external roots.
  return observeNativeHistoryWriterScopeV1(
    binding,
    [...new Set(binding.externalAccounts.flatMap((account) => [account.codexHome, account.sqliteHome]))],
    ownedPids,
    dependencies,
    "global_external",
  );
}

/**
 * Fences one account without treating an app that has another account open as
 * a writer for this one. `ownedPids` must name only the selected account's
 * direct broker child roots. Manager-local homes require an absent child: they
 * have no native-source writer exception while their inherited config changes.
 */
export function observeNativeAccountWritersV1(
  binding: NativeHistorySourceBindingV1,
  opaqueAccountId: OpaqueAccountId,
  ownedPids: readonly number[] = [],
  dependencies: NativeHistoryWriterCensusDependenciesV1 = {},
): NativeHistoryWriterObservationV1 {
  const secret = bindingSecrets.get(binding);
  if (!secret || !bindingPathsAndIdentitiesMatchWithSecret(binding, secret)) {
    return { ok: false, reason: "source_drift", foreignPids: [] };
  }
  const account = binding.accounts.find((entry) => entry.opaqueAccountId === opaqueAccountId);
  if (!account) return { ok: false, reason: "writer_census_failed", foreignPids: [] };
  // A selected managed child must be fully absent before its manager-owned
  // configuration can be inspected or materialized. Callers pass only that
  // account's child roots, so another account's child does not falsely block.
  if (account.kind === "managed_adopted" && ownedPids.some(validPid)) {
    return { ok: false, reason: "writer_census_failed", foreignPids: [] };
  }
  return observeNativeHistoryWriterScopeV1(
    binding,
    account.kind === "native_external"
      ? [account.codexHome, account.sqliteHome]
      : [account.accountRoot],
    account.kind === "native_external" ? ownedPids : [],
    dependencies,
    account.kind === "native_external" ? "account_external" : "managed",
    true,
  );
}

/** Native operations run in the selected broker child, without an external materialization write. */
export function observeNativeAccountOperationWritersV1(
  binding: NativeHistorySourceBindingV1,
  opaqueAccountId: OpaqueAccountId,
  nativeChildPid: number,
  dependencies: NativeHistoryWriterCensusDependenciesV1 = {},
): NativeHistoryWriterObservationV1 {
  const secret = bindingSecrets.get(binding);
  if (!secret || !bindingPathsAndIdentitiesMatchWithSecret(binding, secret)) return { ok: false, reason: "source_drift", foreignPids: [] };
  const account = binding.accounts.find((entry) => entry.opaqueAccountId === opaqueAccountId);
  if (!account || !validPid(nativeChildPid)) return { ok: false, reason: "writer_census_failed", foreignPids: [] };
  return observeNativeHistoryWriterScopeV1(binding,
    account.kind === "native_external" ? [account.codexHome, account.sqliteHome] : [account.accountRoot],
    [nativeChildPid], dependencies, account.kind === "native_external" ? "account_external" : "managed", true);
}

/** Full static proof precedes every scoped census; never clone the binding. */
function observeNativeHistoryWriterScopeV1(
  binding: NativeHistorySourceBindingV1,
  roots: readonly string[],
  ownedPids: readonly number[],
  dependencies: NativeHistoryWriterCensusDependenciesV1,
  scope: "global_external" | "account_external" | "managed",
  bindingAlreadyValidated = false,
): NativeHistoryWriterObservationV1 {
  const secret = bindingSecrets.get(binding);
  if (!bindingAlreadyValidated && (!secret || !bindingPathsAndIdentitiesMatchWithSecret(binding, secret))) {
    return { ok: false, reason: "source_drift", foreignPids: [] };
  }
  if (roots.length === 0) return { ok: false, reason: "writer_census_failed", foreignPids: [] };
  // The broker process itself is allowed to read its sealed companion.  Its
  // descendants are deliberately *not* blanket-allowed: the desktop bridge
  // is also a descendant and must never become an implicit native-home
  // writer.  Only the direct, tracked source child roots carry their own
  // descendant tree (for their plugin/MCP helpers).
  const childRoots = new Set<number>(ownedPids.filter(validPid));
  const spawn = dependencies.spawn ?? spawnSync;
  const ps = spawn("/bin/ps", ["-axo", "pid=,ppid=,comm=,command="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (ps.error || ps.signal || ps.status !== 0 || typeof ps.stdout !== "string" || (ps.stderr && ps.stderr.trim())) {
    return { ok: false, reason: "writer_census_failed", foreignPids: [] };
  }
  const psRows = parsePsRows(ps.stdout);
  if (!psRows) return { ok: false, reason: "writer_census_failed", foreignPids: [] };
  // Child app-server processes legitimately create short-lived plugin/MCP
  // descendants which hold files below CODEX_HOME. Permit only the validated
  // descendant tree of the exact broker child PIDs; never inherit arbitrary
  // desktop/bridge descendants merely because they mention app-server.
  const permitted = descendantPids(psRows, childRoots);
  permitted.add(process.pid);
  // `ps` establishes executable identity and the precise allowed descendant
  // tree. It cannot establish which CODEX_HOME an unrelated same-UID Codex
  // process uses, so it must not by itself turn a disjoint app-server into a
  // native-history conflict. Attribution happens only after the lsof path
  // inventory proves an open file below one of the signed roots.
  const sourceBackendPids = new Set(psRows.filter((row) => isCodexAppServerCommand(row.comm, row.command)).map((row) => row.pid));
  const observedPids = new Set(psRows.map((row) => row.pid));
  const foreign = new Set<number>();
  // `+D` walks every directory before reporting its open files.  Native
  // CODEX_HOME can contain a large history tree, which makes an otherwise
  // healthy broker miss its own connection timeout.  One owner-only,
  // machine-readable inventory is both bounded in practice and catches every
  // path below the sealed roots without a recursive traversal.
  const uid = dependencies.uid?.() ?? process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    return { ok: false, reason: "writer_census_failed", foreignPids: [] };
  }
  const observed = spawn("/usr/sbin/lsof", ["-nP", "-u", String(uid), "-Fpafn"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (observed.error || observed.signal || observed.status !== 0
    || typeof observed.stdout !== "string" || (observed.stderr && observed.stderr.trim())) {
    return { ok: false, reason: "writer_census_failed", foreignPids: [] };
  }
  const opens = parseLsofOpenPaths(observed.stdout);
  if (!opens) return { ok: false, reason: "writer_census_failed", foreignPids: [] };
  for (const entry of opens) {
    const underBoundRoot = roots.some((root) => lsofPathBelowRoot(entry.path, root));
    if (!underBoundRoot) continue;
    // A PID seen only in lsof raced the executable census. It cannot be
    // classified as a permitted descendant or a non-backend metadata reader.
    if (!observedPids.has(entry.pid)) return { ok: false, reason: "writer_census_failed", foreignPids: [] };
    if (permitted.has(entry.pid)) continue;
    // The global history fence stays narrow: another backend may read ordinary
    // metadata below an external home while keeping its history elsewhere.
    // Per-account materialization instead needs exclusive selected-home proof,
    // so any selected external or manager-local path is material there.
    if ((scope !== "global_external" || nativeHistoryProtectedPath(entry.path, roots))
      && (sourceBackendPids.has(entry.pid)
        || entry.access === "w" || entry.access === "u"
        || (entry.access === "" && numericLsofDescriptor(entry.descriptor)))) foreign.add(entry.pid);
  }
  const foreignPids = [...foreign].sort((left, right) => left - right);
  return foreignPids.length === 0
    ? { ok: true, reason: "ready", foreignPids }
    : { ok: false, reason: "foreign_writer", foreignPids };
}

export function nativeHistoryAccountSourceForV1(
  binding: NativeHistorySourceBindingV1,
  opaqueAccountId: OpaqueAccountId,
): NativeHistoryAccountSourceV1 | null {
  return binding.externalAccounts.find((account) => account.opaqueAccountId === opaqueAccountId) ?? null;
}

/**
 * Converts one native `thread/read {includeTurns:true}` result into bounded,
 * credential-free portable records. It accepts only completed, full item
 * snapshots and deliberately refuses attachments, images, active tools, and
 * unknown item kinds.
 */
export function nativeHistoryThreadReadContextV1(value: unknown, expectedThreadId: string): NativeHistoryThreadReadContextV1 {
  if (!validNativeId(expectedThreadId) || !isPlainRecord(value) || !isPlainRecord(value.thread)
    || value.thread.id !== expectedThreadId || !Array.isArray(value.thread.turns) || value.thread.turns.length > 256) {
    return { state: "unsafe" };
  }
  const nativeIds = new Set<string>();
  const turns: NativeHistoryPortableTurnV1[] = [];
  let bytes = 0;
  for (const turn of value.thread.turns) {
    if (!isPlainRecord(turn) || !validNativeId(turn.id) || turn.status !== "completed" || (turn.itemsView !== undefined && turn.itemsView !== "full") || !Array.isArray(turn.items)
      || turn.items.length > 256 || nativeIds.has(turn.id)) return { state: "unsafe" };
    const items: NativeHistoryPortableItemV1[] = [];
    nativeIds.add(turn.id);
    for (const item of turn.items) {
      if (!isPlainRecord(item) || !validNativeId(item.id) || nativeIds.has(item.id)) return { state: "unsafe" };
      const portable = portableNativeItem(item);
      if (!portable) return { state: "unsafe" };
      nativeIds.add(item.id);
      const withId: NativeHistoryPortableItemV1 = { nativeItemId: item.id, ...portable };
      bytes += Buffer.byteLength(JSON.stringify(withId), "utf8");
      if (bytes > 96 * 1024) return { state: "unsafe" };
      items.push(withId);
    }
    turns.push({ nativeTurnId: turn.id, items });
  }
  return { state: "ready", turns, nativeIds };
}

/** A deterministic bounded context for one immediately-forwarded handoff. */
export function renderNativeHistoryContextV1(turns: readonly NativeHistoryPortableTurnV1[]): { text: string; digest: `sha256:${string}` } | null {
  const fragments: string[] = [];
  let itemCount = 0;
  let used = 0;
  for (const turn of turns) {
    for (const item of turn.items) {
      itemCount += 1;
      if (itemCount > 256) return null;
      const role = item.kind === "tool" ? `tool:${item.name}` : item.kind;
      const value = item.kind === "tool" ? item.result : item.text;
      if (typeof value !== "string") return null;
      const fragment = `[${role}]\n${value}`;
      const bytes = Buffer.byteLength(fragment, "utf8");
      if (bytes > 32 * 1024 || used + bytes > 32 * 1024) return null;
      fragments.push(fragment);
      used += bytes;
    }
  }
  if (fragments.length === 0) return null;
  const text = `Native account history continuation. The completed blocks below are bounded portable context; do not assume access to the source account history.\n\n${fragments.join("\n\n")}`;
  if (Buffer.byteLength(text, "utf8") > 32 * 1024) return null;
  return { text, digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}` };
}

function bindingPathsAndIdentitiesMatchWithSecret(binding: NativeHistorySourceBindingV1, secret: Buffer): boolean {
  const root = privateCanonicalDirectory(binding.stateRoot);
  if (!root || root !== binding.stateRoot || secret.byteLength !== 32) return false;
  const sourceBytes = readPrivateRegularFile(join(root, NATIVE_HISTORY_SOURCE_FILE_V1), NATIVE_HISTORY_SOURCE_MAX_BYTES_V1, false);
  if (!sourceBytes) return false;
  try {
    if (!sameSecretString(nativeHistoryDocumentFingerprintV1(sourceBytes), binding.sourceDocumentFingerprint)) return false;
    const source = parseNativeHistorySourceAgainstProtocolV1(JSON.parse(sourceBytes.toString("utf8")) as unknown, binding.source.protocolFingerprint, secret);
    if (!source || !sameNativeHistorySource(source, binding.source)) return false;
  } catch {
    return false;
  } finally {
    sourceBytes.fill(0);
  }
  try { if (bindingPersistentFingerprints.has(binding) && bindingPersistentFingerprints.get(binding) !== (readPersistentIdentityGeneration(root, secret)?.fingerprint ?? null)) return false; } catch { return false; }
  try { if (bindingAuthFingerprints.has(binding) && bindingAuthFingerprints.get(binding) !== (readNativeAuthBindingV1(root, binding.source, secret)?.fingerprint ?? null)) return false; } catch { return false; }
  return sourcePathsAndIdentitiesMatchWithSecret(root, binding.source, secret)
    && nativeHistoryExtensionsBindingSafeV1(binding, secret);
}

/** Revalidates immutable external homes before any extension state is considered. */
function sourcePathsAndIdentitiesFailure(
  stateRoot: string,
  source: NativeHistorySourceV1,
  secret: Buffer,
  authorityOnly = false,
): "source_drift" | "authentication_binding_invalid" | null {
  if (secret.byteLength !== 32 || !privateCanonicalDirectory(stateRoot)) return "source_drift";
  const roots: Array<{ path: string; account: OpaqueAccountId }> = [];
  for (const account of source.accounts) {
    if (!matchesPersistentDirectoryIdentity({ stateRoot, secret, path: account.codexHome, expected: account.codexHomeIdentity, authorityFile: NATIVE_HISTORY_SOURCE_FILE_V1, accountId: account.opaqueAccountId })
      || !matchesPersistentDirectoryIdentity({ stateRoot, secret, path: account.sqliteHome, expected: account.sqliteHomeIdentity, authorityFile: NATIVE_HISTORY_SOURCE_FILE_V1, accountId: account.opaqueAccountId })) return "source_drift";
    roots.push(
      { path: account.codexHome, account: account.opaqueAccountId },
      { path: account.sqliteHome, account: account.opaqueAccountId },
    );
  }
  const pathsSafe = roots.every((entry) => !pathsOverlap(entry.path, stateRoot))
    && roots.every((left, index) => roots.slice(index + 1).every((right) => left.account === right.account
      ? left.path === right.path || !pathsOverlap(left.path, right.path)
      : !pathsOverlap(left.path, right.path)));
  if (!pathsSafe) return "source_drift";
  if (authorityOnly) return null;
  let authBinding: ReturnType<typeof readNativeAuthBindingV1>;
  try { authBinding = readNativeAuthBindingV1(stateRoot, source, secret); } catch { return "authentication_binding_invalid"; }
  for (const account of source.accounts) {
    const rawAccountId = readAuthAccountId(authBinding?.document.accounts.find(entry => entry.opaqueAccountId === account.opaqueAccountId)?.authHome ?? account.codexHome);
    if (!rawAccountId || !sameSecretString(nativeHistoryAuthIdentityHmacV1(rawAccountId, secret), account.authIdentityHmac)
      || !sameOpaqueAccountId(rawAccountId, secret, account.opaqueAccountId)) return "authentication_binding_invalid";
  }
  return null;
}

function sourcePathsAndIdentitiesMatchWithSecret(stateRoot: string, source: NativeHistorySourceV1, secret: Buffer): boolean {
  return sourcePathsAndIdentitiesFailure(stateRoot, source, secret) === null;
}

/** Source parsing without router-account equality: the extension proves the effective union. */
function parseNativeHistorySourceAgainstProtocolV1(
  value: unknown,
  protocolFingerprint: `sha256:${string}`,
  secret: Buffer,
): NativeHistorySourceV1 | null {
  if (secret.byteLength !== 32 || !isNativeHistorySource(value) || value.protocolFingerprint !== protocolFingerprint) return null;
  const unsigned: NativeHistorySourceUnsignedV1 = {
    version: value.version,
    kind: value.kind,
    mode: value.mode,
    protocolFingerprint: value.protocolFingerprint,
    accountSetFingerprint: value.accountSetFingerprint,
    metadataAccountId: value.metadataAccountId,
    accounts: value.accounts,
    issuedAt: value.issuedAt,
  };
  const expected = sourceSignature(unsigned, secret);
  return sameSecretString(expected, value.signature) ? { ...cloneUnsigned(unsigned), signature: value.signature } : null;
}

function sameNativeHistorySource(left: NativeHistorySourceV1, right: NativeHistorySourceV1): boolean {
  return sameSecretString(canonicalJson(left), canonicalJson(right));
}

function sourceSignature(unsigned: NativeHistorySourceUnsignedV1, secret: Buffer): string {
  return `hmac-sha256:${createHmac("sha256", secret)
    .update(`account-router:native-history-source:v1\0${canonicalJson(unsigned)}`, "utf8")
    .digest("hex")}`;
}

function isNativeHistorySource(value: unknown): value is NativeHistorySourceV1 {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["accountSetFingerprint", "accounts", "issuedAt", "kind", "metadataAccountId", "mode", "protocolFingerprint", "signature", "version"].join("\0")) return false;
  if (typeof value.signature !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(value.signature)) return false;
  return isNativeHistoryUnsigned({
    version: value.version,
    kind: value.kind,
    mode: value.mode,
    protocolFingerprint: value.protocolFingerprint,
    accountSetFingerprint: value.accountSetFingerprint,
    metadataAccountId: value.metadataAccountId,
    accounts: value.accounts,
    issuedAt: value.issuedAt,
  });
}

function isNativeHistoryUnsigned(value: unknown): value is NativeHistorySourceUnsignedV1 {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["accountSetFingerprint", "accounts", "issuedAt", "kind", "metadataAccountId", "mode", "protocolFingerprint", "version"].includes(key))
    || value.version !== 1 || value.kind !== NATIVE_HISTORY_SOURCE_KIND_V1 || value.mode !== NATIVE_HISTORY_SOURCE_MODE_V1
    || !isFingerprint(value.protocolFingerprint) || !isFingerprint(value.accountSetFingerprint) || !isOpaqueAccountId(value.metadataAccountId) || !isIsoTimestamp(value.issuedAt)
    || !Array.isArray(value.accounts) || value.accounts.length < 1) return false;
  const accounts = value.accounts.map(parseAccount);
  if (accounts.some((account) => account === null)) return false;
  const ids = (accounts as NativeHistoryAccountSourceV1[]).map((account) => account.opaqueAccountId);
  if (new Set(ids).size !== ids.length || ids.join("\0") !== [...ids].sort().join("\0") || !ids.includes(value.metadataAccountId)) return false;
  try {
    return value.accountSetFingerprint === nativeHistoryAccountSetFingerprintV1(ids);
  } catch {
    return false;
  }
}

function parseAccount(value: unknown): NativeHistoryAccountSourceV1 | null {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["authIdentityHmac", "codexHome", "codexHomeIdentity", "opaqueAccountId", "sqliteHome", "sqliteHomeIdentity"].join("\0")
    || !isOpaqueAccountId(value.opaqueAccountId) || !canonicalPath(value.codexHome) || !canonicalPath(value.sqliteHome)
    || !isDirectoryIdentity(value.codexHomeIdentity) || !isDirectoryIdentity(value.sqliteHomeIdentity)
    || typeof value.authIdentityHmac !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(value.authIdentityHmac)) return null;
  return {
    opaqueAccountId: value.opaqueAccountId,
    codexHome: value.codexHome,
    sqliteHome: value.sqliteHome,
    codexHomeIdentity: { ...value.codexHomeIdentity },
    sqliteHomeIdentity: { ...value.sqliteHomeIdentity },
    authIdentityHmac: value.authIdentityHmac,
  };
}

function cloneUnsigned(unsigned: NativeHistorySourceUnsignedV1): NativeHistorySourceUnsignedV1 {
  return {
    version: 1,
    kind: NATIVE_HISTORY_SOURCE_KIND_V1,
    mode: NATIVE_HISTORY_SOURCE_MODE_V1,
    protocolFingerprint: unsigned.protocolFingerprint,
    accountSetFingerprint: unsigned.accountSetFingerprint,
    metadataAccountId: unsigned.metadataAccountId,
    accounts: unsigned.accounts.map((account) => ({
      ...account,
      codexHomeIdentity: { ...account.codexHomeIdentity },
      sqliteHomeIdentity: { ...account.sqliteHomeIdentity },
    })),
    issuedAt: unsigned.issuedAt,
  };
}

function privateCanonicalDirectory(path: string): string | null {
  try {
    if (!canonicalPath(path) || realpathSync(path) !== path) return null;
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 ? path : null;
  } catch {
    return null;
  }
}


function readAuthAccountId(codexHome: string): string | null {
  const bytes = readPrivateRegularFile(join(codexHome, "auth.json"), NATIVE_HISTORY_AUTH_MAX_BYTES_V1, false);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    return isPlainRecord(parsed) && isPlainRecord(parsed.tokens) && validRawAccountId(parsed.tokens.account_id)
      ? parsed.tokens.account_id
      : null;
  } catch {
    return null;
  } finally {
    bytes.fill(0);
  }
}

function readPrivateRegularFile(path: string, maxBytes: number, allowEmpty: boolean): Buffer | null {
  let descriptor: number | undefined;
  let bytes: Buffer | null = null;
  let accepted = false;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0
      || before.size > maxBytes || (!allowEmpty && before.size < 1)) return null;
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (!count) return null;
      offset += count;
    }
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) return null;
    accepted = true;
    return bytes;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (bytes && !accepted) bytes.fill(0);
  }
}

function sameOpaqueAccountId(rawAccountId: string, secret: Buffer, opaqueAccountId: OpaqueAccountId): boolean {
  const expected = `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}`;
  return sameSecretString(expected, opaqueAccountId);
}

function sameSecretString(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0")
    && isAbsolute(value) && resolve(value) === value;
}

function pathsOverlap(left: string, right: string): boolean {
  const below = (parent: string, child: string): boolean => {
    const value = relative(parent, child);
    return value === "" || (!value.startsWith("..") && !isAbsolute(value));
  };
  return below(left, right) || below(right, left);
}

function isDirectoryIdentity(value: unknown): value is NativeHistoryDirectoryIdentityV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["device", "inode", "mode", "uid"].join("\0")
    && [value.device, value.inode, value.uid, value.mode].every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)
    && typeof value.mode === "number" && value.mode <= 0o7777;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function validRawAccountId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validNativeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parsePsRows(value: string): Array<{ pid: number; ppid: number; comm: string; command: string }> | null {
  const rows: Array<{ pid: number; ppid: number; comm: string; command: string }> = [];
  const seen = new Set<number>();
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s+(\d+)\s+/.exec(line);
    if (!fields) return null;
    // Darwin's `comm` column has a fixed MAXCOMLEN width and may contain a
    // space. Splitting it would shift command and miss a bundled Codex path.
    const remainder = line.slice(fields[0].length);
    const separator = remainder.slice(16);
    const commandMatch = /^\s+(.+)$/.exec(separator);
    const comm = remainder.slice(0, 16).trimEnd();
    const pid = Number(fields[1]);
    const ppid = Number(fields[2]);
    if (!commandMatch || !validPid(pid) || !Number.isSafeInteger(ppid) || ppid < 0 || !comm || !commandMatch[1] || seen.has(pid)) return null;
    seen.add(pid);
    rows.push({ pid, ppid, comm, command: commandMatch[1] });
  }
  return rows.length > 0 ? rows : null;
}

function descendantPids(rows: readonly { pid: number; ppid: number }[], roots: ReadonlySet<number>): Set<number> {
  const allowed = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!allowed.has(row.pid) && allowed.has(row.ppid)) {
        allowed.add(row.pid);
        changed = true;
      }
    }
  }
  return allowed;
}

function isCodexAppServerCommand(comm: string, command: string): boolean {
  // The broker client bridge is a Node script named broker-app-server.js and
  // its signed parent is a Node `-e` wrapper. Neither is a source backend.
  // Match an actual `codex` executable plus an exact argv subcommand. A Node
  // bridge whose *argument* happens to name codex is not a source backend.
  const value = command.trim();
  const firstSpace = value.search(/\s/);
  if (firstSpace > 0 && basename(value.slice(0, firstSpace)) === "codex") {
    return hasExactArgument(value.slice(firstSpace).trimStart(), "app-server");
  }
  const commIsCodex = basename(comm) === "codex";
  // A long Darwin `comm` value is truncated to 16 characters. The command
  // begins with that non-whitespace prefix only for the actual executable,
  // never a later Node-wrapper argument which merely names codex.
  const truncatedCommPrefix = Boolean(comm) && value.startsWith(comm) && !/\s/.test(value[comm.length] ?? "");
  if (!commIsCodex && !truncatedCommPrefix) return false;
  const executableMatch = /\/codex(?=\s)/.exec(value);
  if (!executableMatch || executableMatch.index <= 0) return false;
  // A long Node executable path can be truncated in `comm`, which otherwise
  // makes its later `/tmp/codex app-server` argument look like an executable.
  // An actual Node executable terminator before the candidate is decisive.
  const nodeExecutable = /\/(?:node|nodejs)(?=\s)/.exec(value);
  if (nodeExecutable && nodeExecutable.index < executableMatch.index) return false;
  const executableEnd = executableMatch.index + "/codex".length;
  return basename(value.slice(0, executableEnd)) === "codex" && hasExactArgument(value.slice(executableEnd).trimStart(), "app-server");
}

function hasExactArgument(value: string, expected: string): boolean {
  return value.split(/\s+/).includes(expected);
}

function parseLsofOpenPaths(value: string): Array<{ pid: number; descriptor: string; path: string; access: "" | "r" | "w" | "u" }> | null {
  // Require p -> f -> a -> n association. Darwin emits an `a ` (blank) field
  // for unknown access, which remains distinguishable from read-only `r`.
  // An unexpected field or malformed association is an incomplete census.
  const result: Array<{ pid: number; descriptor: string; path: string; access: "" | "r" | "w" | "u" }> = [];
  let currentPid: number | null = null;
  let haveFile = false;
  let descriptor = "";
  let access: "" | "r" | "w" | "u" | null = null;
  let haveName = false;
  for (const line of value.split("\n")) {
    if (line === "") continue;
    const field = line[0]!;
    const payload = line.slice(1);
    if (field === "p") {
      const pid = Number(payload);
      if (!validPid(pid) || (haveFile && (access === null || !haveName))) return null;
      currentPid = pid;
      haveFile = false;
      descriptor = "";
      access = null;
      haveName = false;
      continue;
    }
    if (field === "f") {
      if (currentPid === null || payload.length === 0 || (haveFile && (access === null || !haveName))) return null;
      haveFile = true;
      descriptor = payload;
      access = null;
      haveName = false;
      continue;
    }
    if (field === "a") {
      if (currentPid === null || !haveFile || access !== null) return null;
      const normalized = payload.trim();
      if (normalized !== "" && normalized !== "r" && normalized !== "w" && normalized !== "u") return null;
      access = normalized;
      continue;
    }
    if (field === "n") {
      if (currentPid === null || !haveFile || access === null || haveName) return null;
      haveName = true;
      // Darwin emits a bare `n` for anonymous descriptors (for example a
      // protected analytics handle).  It has no pathname and therefore cannot
      // name a file below one of our absolute sealed roots.  A nonempty name
      // still receives exact boundary filtering below.
      if (payload.length === 0) continue;
      if (payload.startsWith("/")) result.push({ pid: currentPid, descriptor, path: payload, access });
      continue;
    }
    return null;
  }
  return currentPid === null || !haveFile || access === null || !haveName ? null : result;
}

function numericLsofDescriptor(value: string): boolean {
  // `cwd`, `txt`, and `mem` are non-regular observations. Numeric file
  // descriptors may include an lsof mode marker, such as `12u`.
  return /^\d+[a-z]*$/i.test(value);
}

function lsofPathBelowRoot(value: string, root: string): boolean {
  // Darwin appends this exact marker for an already-unlinked handle.  It is
  // still a relevant open file; remove only the suffix lsof owns, then use a
  // component boundary so `/home/a` never captures `/home/ab`.
  const path = value.endsWith(" (deleted)") ? value.slice(0, -" (deleted)".length) : value;
  return path === root || path.startsWith(`${root}/`);
}

function nativeHistoryProtectedPath(value: string, roots: readonly string[]): boolean {
  const path = value.endsWith(" (deleted)") ? value.slice(0, -" (deleted)".length) : value;
  for (const root of roots) {
    if (!lsofPathBelowRoot(path, root)) continue;
    const relative = path === root ? "" : path.slice(root.length + 1);
    const base = relative.split("/").at(-1) ?? "";
    if (/^state[^/]*\.sqlite(?:-(?:wal|shm))?$/i.test(base)) return true;
    if (/(?:^|\/)(?:sessions|archived_sessions)(?:\/|$)/.test(relative)) return true;
    if (/(?:^|\/)(?:history|rollout)[^/]*(?:\.jsonl)?$/i.test(relative)) return true;
  }
  return false;
}

function portableNativeItem(value: Record<string, unknown>): Omit<NativeHistoryPortableItemV1, "nativeItemId"> | null {
  if (value.type === "userMessage") {
    if (!Array.isArray(value.content) || value.content.length > 32) return null;
    const text = value.content.map((entry) => isPlainRecord(entry) && entry.type === "text" && safePortableText(entry.text) ? entry.text : null);
    return text.every((entry) => entry !== null) ? { kind: "user", text: text.join("\n") } : null;
  }
  if (value.type === "agentMessage" && safePortableText(value.text)) return { kind: "assistant", text: value.text };
  if (value.type === "plan" && safePortableText(value.text)) return { kind: "plan", text: value.text };
  if (value.type === "functionCallOutput" && typeof value.name === "string" && safePortableText(value.name)) {
    const output = portableOutput(value.output);
    return output === null ? null : { kind: "tool", name: value.name, result: output };
  }
  return null;
}

function portableOutput(value: unknown): string | null {
  const output = typeof value === "string" ? value
    : Array.isArray(value) && value.length <= 32
      ? value.map((entry) => isPlainRecord(entry) && entry.type === "input_text" && typeof entry.text === "string" ? entry.text : null).every((entry) => entry !== null)
        ? (value as Array<{ text: string }>).map((entry) => entry.text).join("\n")
        : null
      : null;
  if (output === null || !safePortableText(output) || Buffer.byteLength(output, "utf8") > 16 * 1024
    || /(?:^|[\s"'])(?:\/|~\/|file:|data:|blob:|https?:\/\/)/i.test(output)) return null;
  return output;
}

function safePortableText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 96 * 1024 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && !/(?:\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|cookie|authorization)\b\s*[:=]|\bsk-[A-Za-z0-9_-]{12,}|BEGIN [A-Z ]+PRIVATE KEY)/i.test(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/* This must never run: it protects accidental use of secretless binding validation. */

/** Static native identity remains valid while unrelated apps read or write other threads. */
/** The publishing writer may acquire a new fully validated binding; the old one remains stale. */
export function refreshNativeHistoryBindingAfterIdentityPublication(binding: NativeHistorySourceBindingV1, expectedGeneration: string): NativeHistorySourceBindingV1 {
  const secret = bindingSecrets.get(binding), config = bindingConfigurations.get(binding);
  if (!secret || !config || readPersistentIdentityGeneration(binding.stateRoot, secret)?.fingerprint !== expectedGeneration) throw new Error("Published identity generation changed");
  const fresh = readAndPreflightNativeHistorySourceStaticV1(binding.stateRoot, config, secret);
  if (fresh.state !== "ready" || fresh.binding.sourceDocumentFingerprint !== binding.sourceDocumentFingerprint
    || fresh.binding.extensionDocumentFingerprint !== binding.extensionDocumentFingerprint
    || JSON.stringify(fresh.binding.accounts) !== JSON.stringify(binding.accounts)
    || bindingAuthFingerprints.get(fresh.binding) !== bindingAuthFingerprints.get(binding)
    || bindingPersistentFingerprints.get(fresh.binding) !== expectedGeneration) throw new Error("Native source changed during identity publication");
  return fresh.binding;
}

export function nativeHistoryBindingSafeV1(binding: NativeHistorySourceBindingV1): boolean {
  const secret = bindingSecrets.get(binding);
  return !!secret && bindingPathsAndIdentitiesMatchWithSecret(binding, secret);
}

/** Only a competing writer to this exact conversation can block its dispatch. */
export function observeNativeThreadWriterV1(
  binding: NativeHistorySourceBindingV1,
  threadId: string,
  ownedPids: readonly number[] = [],
  dependencies: NativeHistoryWriterCensusDependenciesV1 = {},
): { state: "clear" | "conflict" | "unknown"; foreignPids: readonly number[] } {
  if (!nativeHistoryBindingSafeV1(binding) || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) return { state: "unknown", foreignPids: [] };
  const spawn = dependencies.spawn ?? spawnSync;
  const options = { encoding: "utf8" as const, timeout: 5_000, maxBuffer: 32 * 1024 * 1024 };
  const ps = spawn("/bin/ps", ["-axo", "pid=,ppid=,comm=,command="], options);
  if (ps.error || ps.signal || ps.status !== 0 || typeof ps.stdout !== "string" || ps.stderr?.trim()) return { state: "unknown", foreignPids: [] };
  const rows = parsePsRows(ps.stdout);
  const uid = dependencies.uid?.() ?? process.getuid?.();
  if (!rows || typeof uid !== "number" || uid < 0) return { state: "unknown", foreignPids: [] };
  const observed = spawn("/usr/sbin/lsof", ["-nP", "-u", String(uid), "-Fpafn"], options);
  if (observed.error || observed.signal || observed.status !== 0 || typeof observed.stdout !== "string" || observed.stderr?.trim()) return { state: "unknown", foreignPids: [] };
  const opens = parseLsofOpenPaths(observed.stdout);
  if (!opens) return { state: "unknown", foreignPids: [] };
  return nativeThreadWriterObservations(binding, [threadId], ownedPids, rows, opens).get(threadId)!;
}

/** Observation-only catalog scans share one asynchronous census, never a write authorization. */
export async function observeNativeThreadWritersV1(
  binding: NativeHistorySourceBindingV1,
  threadIds: readonly string[],
  ownedPids: readonly number[] = [],
  dependencies: NativeHistoryAsyncWriterCensusDependenciesV1 = {},
): Promise<ReadonlyMap<string, { state: "clear" | "conflict" | "unknown"; foreignPids: readonly number[] }>> {
  const ids = [...new Set(threadIds)];
  const unknown = () => new Map(ids.map((id) => [id, { state: "unknown" as const, foreignPids: [] }]));
  if (!nativeHistoryBindingSafeV1(binding) || ids.length > 16_384
    || ids.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) return unknown();
  if (ids.length === 0) return new Map();
  const uid = dependencies.uid?.() ?? process.getuid?.();
  if (typeof uid !== "number" || uid < 0) return unknown();
  const run = dependencies.run ?? ((command: string, args: readonly string[]) => new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error); else resolvePromise({ stdout, stderr });
    });
  }));
  try {
    const ps = await run("/bin/ps", ["-axo", "pid=,ppid=,comm=,command="]);
    const rows = parsePsRows(ps.stdout);
    if (!rows || ps.stderr.trim()) return unknown();
    const observed = await run("/usr/sbin/lsof", ["-nP", "-u", String(uid), "-Fpafn"]);
    const opens = parseLsofOpenPaths(observed.stdout);
    // Awaiting the OS permits account state to change; revalidate the sealed
    // binding before using this batch even for catalog diagnostics.
    if (!opens || observed.stderr.trim() || !nativeHistoryBindingSafeV1(binding)) return unknown();
    return nativeThreadWriterObservations(binding, ids, ownedPids, rows, opens);
  } catch { return unknown(); }
}

function nativeThreadWriterObservations(
  binding: NativeHistorySourceBindingV1,
  threadIds: readonly string[],
  ownedPids: readonly number[],
  rows: NonNullable<ReturnType<typeof parsePsRows>>,
  opens: NonNullable<ReturnType<typeof parseLsofOpenPaths>>,
): Map<string, { state: "clear" | "conflict" | "unknown"; foreignPids: readonly number[] }> {
  const permitted = descendantPids(rows, new Set(ownedPids.filter(validPid)));
  permitted.add(process.pid);
  const known = new Set(rows.map((row) => row.pid));
  // Thread mutations may originate in any effective account home. External
  // roots remain identity-sealed; manager-local roots are covered by the same
  // full binding proof plus the broker's selected-account lease.
  const roots = [...new Set(binding.accounts.map((account) => account.codexHome))];
  const relevant = opens.filter((entry) => !permitted.has(entry.pid) && roots.some((root) => lsofPathBelowRoot(entry.path, root)));
  const results = new Map<string, { state: "clear" | "conflict" | "unknown"; foreignPids: readonly number[] }>();
  for (const threadId of threadIds) {
    const foreign = new Set<number>();
    let unknown = false;
    for (const entry of relevant) {
      const name = basename(entry.path);
      const exact = (name === `${threadId}.lock` && entry.path.includes("/thread-writer-locks/"))
        || (entry.path.includes("/sessions/") || entry.path.includes("/archived_sessions/"))
          && (name === `${threadId}.jsonl` || name === `${threadId}.jsonl.zst`
            || name.endsWith(`-${threadId}.jsonl`) || name.endsWith(`-${threadId}.jsonl.zst`)
            || new RegExp(`^(?:rollout-.*-)?${threadId}_[a-f0-9-]{36}\\.jsonl(?:\\.zst)?$`).test(name));
      if (!exact) continue;
      if (!known.has(entry.pid)) { unknown = true; break; }
      if (entry.access === "w" || entry.access === "u" || entry.access === "" && numericLsofDescriptor(entry.descriptor)) foreign.add(entry.pid);
    }
    results.set(threadId, unknown ? { state: "unknown", foreignPids: [] }
      : { state: foreign.size ? "conflict" : "clear", foreignPids: [...foreign].sort((a, b) => a - b) });
  }
  return results;
}

/** Recovery-only signed source validation. Does not produce a runnable history binding. */
export function readNativeHistoryRecoveryAuthorityV1(stateRoot: string, config: RouterConfig, secret: Buffer): NativeHistorySourceV1 {
  const root = privateCanonicalDirectory(stateRoot);
  if (!root) throw new Error("Unsafe recovery root");
  const bytes = readPrivateRegularFile(join(root, NATIVE_HISTORY_SOURCE_FILE_V1), NATIVE_HISTORY_SOURCE_MAX_BYTES_V1, false);
  if (!bytes) throw new Error("Unsafe recovery source");
  try {
    const source = parseNativeHistorySourceV1(JSON.parse(bytes.toString("utf8")), config, secret);
    if (!source || sourcePathsAndIdentitiesFailure(root, source, secret, true)) throw new Error("Recovery authority unavailable");
    return source;
  } finally { bytes.fill(0); }
}
