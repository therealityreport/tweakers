import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writePrivateJsonAtomicBounded } from "./state-store";
import { isFingerprint, isOpaqueAccountId, isPlainRecord, type OpaqueAccountId, type RouterConfig } from "./types";
import type { NativeHistoryAccountSourceV1, NativeHistoryDirectoryIdentityV1, NativeHistorySourceV1 } from "./native-history";

/** A separately signed companion for manager-local accounts added after native setup. */
export const NATIVE_HISTORY_EXTENSIONS_FILE_V1 = "native-history-extensions.v1.json";
export const NATIVE_HISTORY_EXTENSIONS_KIND_V1 = "account-router-native-history-extensions" as const;
export const NATIVE_HISTORY_EXTENSIONS_MAX_BYTES_V1 = 64 * 1024;

/** A signed proof that a particular manager-local enrollment home was materialized. */
export const NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_FILE_V1 = "native-history-enrollment-receipt.v1.json";
export const NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_KIND_V1 = "account-router-native-history-managed-enrollment-receipt" as const;
export const NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_MAX_BYTES_V1 = 16 * 1024;

type Sha256 = `sha256:${string}`;
type HmacSha256 = `hmac-sha256:${string}`;

/** Only credential-free, manager-local facts belong in an extension entry. */
export interface NativeHistoryManagedAccountV1 {
  opaqueAccountId: OpaqueAccountId;
  accountRootRelativePath: `accounts/${string}`;
  codexHomeIdentity: NativeHistoryDirectoryIdentityV1;
  sqliteHomeIdentity: NativeHistoryDirectoryIdentityV1;
  authIdentityHmac: HmacSha256;
  enrollmentReceiptFingerprint: Sha256;
}

export type NativeHistoryManagedAccountDraftV1 = Omit<NativeHistoryManagedAccountV1, "enrollmentReceiptFingerprint">;

export interface NativeHistoryExtensionsUnsignedV1 {
  version: 1;
  kind: typeof NATIVE_HISTORY_EXTENSIONS_KIND_V1;
  /** Exact digest of the original signed source bytes, including formatting. */
  baseSourceFingerprint: Sha256;
  generation: number;
  managedAccounts: readonly NativeHistoryManagedAccountV1[];
  /** The exact external-source plus manager-local opaque account-id union. */
  effectiveAccountSetFingerprint: Sha256;
  issuedAt: string;
}

export interface NativeHistoryExtensionsV1 extends NativeHistoryExtensionsUnsignedV1 {
  signature: HmacSha256;
}

/** Stored inside the account root. It deliberately has no self-fingerprint. */
export interface NativeHistoryManagedEnrollmentReceiptUnsignedV1 extends NativeHistoryManagedAccountDraftV1 {
  version: 1;
  kind: typeof NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_KIND_V1;
  issuedAt: string;
}

export interface NativeHistoryManagedEnrollmentReceiptV1 extends NativeHistoryManagedEnrollmentReceiptUnsignedV1 {
  signature: HmacSha256;
}

/** A manager-local account after its signed receipt and physical layout are revalidated. */
export interface NativeHistoryManagedAccountBindingV2 extends NativeHistoryManagedAccountV1 {
  readonly kind: "managed_adopted";
  readonly accountRoot: string;
  readonly codexHome: string;
  readonly sqliteHome: string;
}

interface ValidatedManagedAccountHomeV1 {
  readonly accountRoot: string;
  readonly codexHome: string;
  readonly sqliteHome: string;
}

/** A fixed external account after source parsing has proved its original identity. */
export interface NativeHistoryExternalAccountBindingV2 extends NativeHistoryAccountSourceV1 {
  readonly kind: "native_external";
}

export type NativeHistoryEffectiveAccountV2 = NativeHistoryExternalAccountBindingV2 | NativeHistoryManagedAccountBindingV2;

/** Runtime-only union used by native fanout. `source` always remains the original document. */
export interface NativeHistoryUnionBindingV2 {
  readonly version: 2;
  readonly stateRoot: string;
  readonly source: NativeHistorySourceV1;
  readonly sourceDocumentFingerprint: Sha256;
  readonly extensions: NativeHistoryExtensionsV1 | null;
  readonly extensionDocumentFingerprint: Sha256 | null;
  readonly externalAccounts: readonly NativeHistoryExternalAccountBindingV2[];
  readonly managedAccounts: readonly NativeHistoryManagedAccountBindingV2[];
  /** Validated external + manager-local union, sorted by opaque account id. */
  readonly accounts: readonly NativeHistoryEffectiveAccountV2[];
}

export type AccountStorageBindingV2 =
  | { kind: "native_external"; source: NativeHistoryAccountSourceV1 }
  | { kind: "managed_adopted"; accountRoot: string; enrollmentReceiptFingerprint: Sha256 };

export type NativeHistoryExtensionsFailureV1 =
  | "unsafe_state_root"
  | "unsafe_extensions_file"
  | "invalid_extensions"
  | "missing_extensions"
  | "base_source_mismatch"
  | "effective_account_set_mismatch"
  | "managed_account_drift"
  | "managed_receipt_invalid";

export type NativeHistoryExtensionsPreflightV1 =
  | {
    state: "ready";
    extensions: NativeHistoryExtensionsV1 | null;
    extensionDocumentFingerprint: Sha256 | null;
    managedAccounts: readonly NativeHistoryManagedAccountBindingV2[];
  }
  | { state: "invalid"; reason: NativeHistoryExtensionsFailureV1 };

export interface NativeHistoryExtensionsPreflightInputV1 {
  stateRoot: string;
  config: RouterConfig;
  secret: Buffer;
  baseSource: NativeHistorySourceV1;
  baseSourceDocumentFingerprint: Sha256;
}

export interface NativeHistoryExtensionDocumentProofV1 {
  readonly document: NativeHistoryExtensionsV1 | null;
  /** Null represents the durable absence of an extension document. */
  readonly documentFingerprint: Sha256 | null;
}

export interface PreparedNativeHistoryExtensionUpdateV1 {
  readonly prior: NativeHistoryExtensionDocumentProofV1;
  readonly next: NativeHistoryExtensionDocumentProofV1 & { readonly document: NativeHistoryExtensionsV1; readonly documentFingerprint: Sha256 };
  /** Binds exactly the source, prior/next extension docs, and prior/next account sets. */
  readonly intentFingerprint: Sha256;
}

export interface PrepareNativeHistoryExtensionUpdateInputV1 {
  stateRoot: string;
  secret: Buffer;
  baseSource: NativeHistorySourceV1;
  baseSourceDocumentFingerprint: Sha256;
  priorConfig: RouterConfig;
  nextConfig: RouterConfig;
  managedAccount: NativeHistoryManagedAccountV1;
  issuedAt: string;
}

export type NativeHistoryExtensionRecoveryV1 =
  | { state: "prior"; preflight: Extract<NativeHistoryExtensionsPreflightV1, { state: "ready" }> }
  | { state: "next"; preflight: Extract<NativeHistoryExtensionsPreflightV1, { state: "ready" }> }
  | { state: "invalid"; reason: "invalid_proof" | NativeHistoryExtensionsFailureV1 };

export interface RecoverNativeHistoryExtensionUpdateInputV1 {
  stateRoot: string;
  secret: Buffer;
  baseSource: NativeHistorySourceV1;
  baseSourceDocumentFingerprint: Sha256;
  priorConfig: RouterConfig;
  nextConfig: RouterConfig;
  prior: NativeHistoryExtensionDocumentProofV1;
  next: NativeHistoryExtensionDocumentProofV1;
}

/** The receipt path is fixed below the validated manager-local account root. */
export function nativeHistoryManagedEnrollmentReceiptPathV1(stateRoot: string, opaqueAccountId: OpaqueAccountId): string {
  if (!isOpaqueAccountId(opaqueAccountId) || !canonicalPath(stateRoot)) throw new Error("invalid native history managed receipt path");
  return join(stateRoot, "accounts", opaqueAccountId, NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_FILE_V1);
}

/** Exact raw-document digest; extensions bind the source's bytes, not a reserialization. */
export function nativeHistoryDocumentFingerprintV1(value: Buffer | Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Deterministic effective-id binding shared by extension preparation and preflight. */
export function nativeHistoryEffectiveAccountSetFingerprintV1(accounts: readonly OpaqueAccountId[]): Sha256 {
  if (accounts.length < 1 || accounts.some((account) => !isOpaqueAccountId(account))) throw new Error("invalid native history effective account set");
  const sorted = [...accounts].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error("duplicate native history effective account");
  return `sha256:${createHash("sha256").update(canonicalJson(sorted), "utf8").digest("hex")}`;
}

export function signNativeHistoryExtensionsV1(unsigned: NativeHistoryExtensionsUnsignedV1, secret: Buffer): NativeHistoryExtensionsV1 {
  if (secret.byteLength !== 32 || !isNativeHistoryExtensionsUnsigned(unsigned)) throw new Error("invalid native history extensions");
  const normalized = cloneExtensionsUnsigned(unsigned);
  return { ...normalized, signature: extensionsSignature(normalized, secret) };
}

/** Strict schema and signature check. Union/config/home proof belongs to preflight. */
export function parseNativeHistoryExtensionsV1(value: unknown, secret: Buffer): NativeHistoryExtensionsV1 | null {
  if (secret.byteLength !== 32 || !isNativeHistoryExtensions(value)) return null;
  const unsigned: NativeHistoryExtensionsUnsignedV1 = {
    version: value.version,
    kind: value.kind,
    baseSourceFingerprint: value.baseSourceFingerprint,
    generation: value.generation,
    managedAccounts: value.managedAccounts,
    effectiveAccountSetFingerprint: value.effectiveAccountSetFingerprint,
    issuedAt: value.issuedAt,
  };
  const expected = extensionsSignature(unsigned, secret);
  if (!sameSecretString(expected, value.signature)) return null;
  return { ...cloneExtensionsUnsigned(unsigned), signature: value.signature };
}

export function signNativeHistoryManagedEnrollmentReceiptV1(
  unsigned: NativeHistoryManagedEnrollmentReceiptUnsignedV1,
  secret: Buffer,
): NativeHistoryManagedEnrollmentReceiptV1 {
  if (secret.byteLength !== 32 || !isManagedReceiptUnsigned(unsigned)) throw new Error("invalid native history managed enrollment receipt");
  const normalized = cloneManagedReceiptUnsigned(unsigned);
  return { ...normalized, signature: managedReceiptSignature(normalized, secret) };
}

export function parseNativeHistoryManagedEnrollmentReceiptV1(value: unknown, secret: Buffer): NativeHistoryManagedEnrollmentReceiptV1 | null {
  if (secret.byteLength !== 32 || !isManagedReceipt(value)) return null;
  const unsigned: NativeHistoryManagedEnrollmentReceiptUnsignedV1 = {
    version: value.version,
    kind: value.kind,
    opaqueAccountId: value.opaqueAccountId,
    accountRootRelativePath: value.accountRootRelativePath,
    codexHomeIdentity: value.codexHomeIdentity,
    sqliteHomeIdentity: value.sqliteHomeIdentity,
    authIdentityHmac: value.authIdentityHmac,
    issuedAt: value.issuedAt,
  };
  const expected = managedReceiptSignature(unsigned, secret);
  if (!sameSecretString(expected, value.signature)) return null;
  return { ...cloneManagedReceiptUnsigned(unsigned), signature: value.signature };
}

/**
 * Writes the one receipt needed by a newly materialized manager-local home.
 * Existing bytes are never overwritten unless they already prove the exact
 * same account facts, making repeated recovery calls idempotent but drift-safe.
 */
export function writeNativeHistoryManagedEnrollmentReceiptV1(input: {
  stateRoot: string;
  secret: Buffer;
  account: NativeHistoryManagedAccountDraftV1;
  issuedAt: string;
}): { receipt: NativeHistoryManagedEnrollmentReceiptV1; enrollmentReceiptFingerprint: Sha256 } {
  if (input.secret.byteLength !== 32 || !isManagedAccountDraft(input.account) || !isIsoTimestamp(input.issuedAt)) {
    throw new Error("invalid native history managed enrollment receipt input");
  }
  const account = cloneManagedAccountDraft(input.account);
  const home = validateManagedAccountHome(input.stateRoot, account, input.secret);
  if (!home) throw new Error("native history managed enrollment home failed preflight");
  const unsigned: NativeHistoryManagedEnrollmentReceiptUnsignedV1 = {
    version: 1,
    kind: NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_KIND_V1,
    ...account,
    issuedAt: input.issuedAt,
  };
  const receipt = signNativeHistoryManagedEnrollmentReceiptV1(unsigned, input.secret);
  const receiptPath = nativeHistoryManagedEnrollmentReceiptPathV1(input.stateRoot, account.opaqueAccountId);
  if (existsSync(receiptPath)) {
    const current = readManagedReceipt(input.stateRoot, account.opaqueAccountId, input.secret);
    if (!current || !sameManagedReceipt(current.receipt, receipt)) {
      throw new Error("native history managed enrollment receipt already differs");
    }
    if (!validateManagedAccountHome(input.stateRoot, account, input.secret)) throw new Error("native history managed enrollment home drifted");
    return { receipt: current.receipt, enrollmentReceiptFingerprint: current.fingerprint };
  }
  // `accountRoot` was just proved owner-private and is the only write target.
  writePrivateJsonAtomicBounded(home.accountRoot, NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_FILE_V1, receipt, NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_MAX_BYTES_V1);
  const persisted = readManagedReceipt(input.stateRoot, account.opaqueAccountId, input.secret);
  if (!persisted || !sameManagedReceipt(persisted.receipt, receipt)
    || !validateManagedAccountHome(input.stateRoot, account, input.secret)) {
    throw new Error("native history managed enrollment receipt postcondition failed");
  }
  return { receipt: persisted.receipt, enrollmentReceiptFingerprint: persisted.fingerprint };
}

/** Reopens and validates receipt bytes, signed fields, physical homes, and auth binding. */
export function validateNativeHistoryManagedEnrollmentReceiptV1(input: {
  stateRoot: string;
  secret: Buffer;
  account: NativeHistoryManagedAccountV1;
}): NativeHistoryManagedAccountBindingV2 | null {
  if (input.secret.byteLength !== 32 || !isManagedAccountDraft(input.account)
    || !isFingerprint(input.account.enrollmentReceiptFingerprint)) return null;
  const receipt = readManagedReceipt(input.stateRoot, input.account.opaqueAccountId, input.secret);
  if (!receipt || !sameSecretString(receipt.fingerprint, input.account.enrollmentReceiptFingerprint)) return null;
  const expected: NativeHistoryManagedEnrollmentReceiptUnsignedV1 = {
    version: 1,
    kind: NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_KIND_V1,
    opaqueAccountId: input.account.opaqueAccountId,
    accountRootRelativePath: input.account.accountRootRelativePath,
    codexHomeIdentity: input.account.codexHomeIdentity,
    sqliteHomeIdentity: input.account.sqliteHomeIdentity,
    authIdentityHmac: input.account.authIdentityHmac,
    issuedAt: receipt.receipt.issuedAt,
  };
  if (!sameManagedReceipt(receipt.receipt, signNativeHistoryManagedEnrollmentReceiptV1(expected, input.secret))) return null;
  const home = validateManagedAccountHome(input.stateRoot, input.account, input.secret);
  return home ? { ...cloneManagedAccount(input.account), kind: "managed_adopted", ...home } : null;
}

/**
 * Validates the signed extension and every extension account against the
 * manager-local receipt/home proof. This function performs no writes.
 */
export function preflightNativeHistoryExtensionsV1(input: NativeHistoryExtensionsPreflightInputV1): NativeHistoryExtensionsPreflightV1 {
  if (input.secret.byteLength !== 32) return { state: "invalid", reason: "invalid_extensions" };
  const root = privateCanonicalDirectory(input.stateRoot);
  if (!root || root !== input.stateRoot || !isFingerprint(input.baseSourceDocumentFingerprint)) {
    return { state: "invalid", reason: "unsafe_state_root" };
  }
  if (input.baseSource.protocolFingerprint !== input.config.protocolFingerprint
    || !input.baseSource.accounts.some((account) => account.opaqueAccountId === input.baseSource.metadataAccountId)) {
    return { state: "invalid", reason: "base_source_mismatch" };
  }
  const baseIds = input.baseSource.accounts.map((account) => account.opaqueAccountId);
  if (!uniqueSortedOpaqueIds(baseIds)) return { state: "invalid", reason: "base_source_mismatch" };
  const loaded = readExtensionsDocument(root, input.secret);
  if (loaded.state === "invalid") return { state: "invalid", reason: loaded.reason };
  if (loaded.state === "absent") {
    return sameAccountSet(baseIds, input.config.accounts.map((account) => account.opaqueAccountId))
      ? { state: "ready", extensions: null, extensionDocumentFingerprint: null, managedAccounts: [] }
      : { state: "invalid", reason: "missing_extensions" };
  }
  const extensions = loaded.document;
  if (!sameSecretString(extensions.baseSourceFingerprint, input.baseSourceDocumentFingerprint)) {
    return { state: "invalid", reason: "base_source_mismatch" };
  }
  const managedIds = extensions.managedAccounts.map((account) => account.opaqueAccountId);
  if (!uniqueSortedOpaqueIds(managedIds) || managedIds.some((account) => baseIds.includes(account))) {
    return { state: "invalid", reason: "effective_account_set_mismatch" };
  }
  let effectiveFingerprint: Sha256;
  try { effectiveFingerprint = nativeHistoryEffectiveAccountSetFingerprintV1([...baseIds, ...managedIds]); }
  catch { return { state: "invalid", reason: "effective_account_set_mismatch" }; }
  if (!sameSecretString(extensions.effectiveAccountSetFingerprint, effectiveFingerprint)
    || !sameAccountSet([...baseIds, ...managedIds], input.config.accounts.map((account) => account.opaqueAccountId))) {
    return { state: "invalid", reason: "effective_account_set_mismatch" };
  }
  const managedAccounts: NativeHistoryManagedAccountBindingV2[] = [];
  for (const account of extensions.managedAccounts) {
    const binding = validateNativeHistoryManagedEnrollmentReceiptV1({ stateRoot: root, secret: input.secret, account });
    if (!binding) return { state: "invalid", reason: "managed_receipt_invalid" };
    managedAccounts.push(binding);
  }
  return {
    state: "ready",
    extensions,
    extensionDocumentFingerprint: loaded.fingerprint,
    managedAccounts,
  };
}

export function createNativeHistoryUnionBindingV2(input: {
  stateRoot: string;
  source: NativeHistorySourceV1;
  sourceDocumentFingerprint: Sha256;
  extensionsPreflight: Extract<NativeHistoryExtensionsPreflightV1, { state: "ready" }>;
}): NativeHistoryUnionBindingV2 {
  const externalAccounts: NativeHistoryExternalAccountBindingV2[] = input.source.accounts.map((account) => ({
    ...cloneExternalAccount(account),
    kind: "native_external",
  }));
  const managedAccounts = input.extensionsPreflight.managedAccounts.map(cloneManagedBinding);
  const accounts = [...externalAccounts, ...managedAccounts].sort((left, right) => left.opaqueAccountId < right.opaqueAccountId ? -1 : left.opaqueAccountId > right.opaqueAccountId ? 1 : 0);
  if (!uniqueSortedOpaqueIds(accounts.map((account) => account.opaqueAccountId))) throw new Error("invalid native history union binding");
  return {
    version: 2,
    stateRoot: input.stateRoot,
    source: cloneSource(input.source),
    sourceDocumentFingerprint: input.sourceDocumentFingerprint,
    extensions: input.extensionsPreflight.extensions ? cloneExtensions(input.extensionsPreflight.extensions) : null,
    extensionDocumentFingerprint: input.extensionsPreflight.extensionDocumentFingerprint,
    externalAccounts,
    managedAccounts,
    accounts,
  };
}

/** Discriminated account lookup for code that needs to distinguish external writer fences. */
export function accountStorageBindingV2(binding: NativeHistoryUnionBindingV2, account: OpaqueAccountId): AccountStorageBindingV2 | null {
  const entry = binding.accounts.find((candidate) => candidate.opaqueAccountId === account);
  if (!entry) return null;
  if (entry.kind === "native_external") {
    const { kind: _kind, ...source } = entry;
    return { kind: "native_external", source: cloneExternalAccount(source) };
  }
  return {
    kind: "managed_adopted",
    accountRoot: entry.accountRoot,
    enrollmentReceiptFingerprint: entry.enrollmentReceiptFingerprint,
  };
}

/** Rechecks an already-created union binding without accepting a rewritten source or extension. */
export function nativeHistoryExtensionsBindingSafeV1(binding: NativeHistoryUnionBindingV2, secret: Buffer): boolean {
  if (secret.byteLength !== 32 || !privateCanonicalDirectory(binding.stateRoot)) return false;
  const loaded = readExtensionsDocument(binding.stateRoot, secret);
  if (binding.extensions === null) {
    if (loaded.state !== "absent") return false;
  } else {
    if (loaded.state !== "ready" || binding.extensionDocumentFingerprint === null
      || !sameSecretString(loaded.fingerprint, binding.extensionDocumentFingerprint)
      || !sameExtensions(loaded.document, binding.extensions)) return false;
  }
  const managed = binding.managedAccounts;
  if (managed.length !== (binding.extensions?.managedAccounts.length ?? 0)) return false;
  return managed.every((account) => validateNativeHistoryManagedEnrollmentReceiptV1({ stateRoot: binding.stateRoot, secret, account }) !== null)
    && sameAccountSet(binding.accounts.map((account) => account.opaqueAccountId), [
      ...binding.externalAccounts.map((account) => account.opaqueAccountId),
      ...binding.managedAccounts.map((account) => account.opaqueAccountId),
    ]);
}

/**
 * Creates a signed next document without publishing it. Both configs are
 * required, so the old and next union are separately proved before a journal
 * can describe the transaction.
 */
export function prepareNativeHistoryExtensionUpdateV1(input: PrepareNativeHistoryExtensionUpdateInputV1): PreparedNativeHistoryExtensionUpdateV1 {
  if (input.secret.byteLength !== 32 || !isIsoTimestamp(input.issuedAt) || !isNativeHistoryManagedAccount(input.managedAccount)) {
    throw new Error("invalid native history extension preparation input");
  }
  const priorPreflight = preflightNativeHistoryExtensionsV1({
    stateRoot: input.stateRoot,
    config: input.priorConfig,
    secret: input.secret,
    baseSource: input.baseSource,
    baseSourceDocumentFingerprint: input.baseSourceDocumentFingerprint,
  });
  if (priorPreflight.state !== "ready") throw new Error(`native history extension prior preflight failed: ${priorPreflight.reason}`);
  if (!validateNativeHistoryManagedEnrollmentReceiptV1({ stateRoot: input.stateRoot, secret: input.secret, account: input.managedAccount })) {
    throw new Error("native history extension managed receipt preflight failed");
  }
  const baseIds = input.baseSource.accounts.map((account) => account.opaqueAccountId);
  const priorManaged = priorPreflight.extensions?.managedAccounts ?? [];
  if (baseIds.includes(input.managedAccount.opaqueAccountId)
    || priorManaged.some((account) => account.opaqueAccountId === input.managedAccount.opaqueAccountId)) {
    throw new Error("native history extension account already exists");
  }
  const managedAccounts = [...priorManaged.map(cloneManagedAccount), cloneManagedAccount(input.managedAccount)]
    .sort((left, right) => left.opaqueAccountId < right.opaqueAccountId ? -1 : left.opaqueAccountId > right.opaqueAccountId ? 1 : 0);
  const effectiveIds = [...baseIds, ...managedAccounts.map((account) => account.opaqueAccountId)];
  if (!sameAccountSet(effectiveIds, input.nextConfig.accounts.map((account) => account.opaqueAccountId))) {
    throw new Error("native history extension next config does not match effective accounts");
  }
  const unsigned: NativeHistoryExtensionsUnsignedV1 = {
    version: 1,
    kind: NATIVE_HISTORY_EXTENSIONS_KIND_V1,
    baseSourceFingerprint: input.baseSourceDocumentFingerprint,
    generation: (priorPreflight.extensions?.generation ?? 0) + 1,
    managedAccounts,
    effectiveAccountSetFingerprint: nativeHistoryEffectiveAccountSetFingerprintV1(effectiveIds),
    issuedAt: input.issuedAt,
  };
  const nextDocument = signNativeHistoryExtensionsV1(unsigned, input.secret);
  const nextFingerprint = nativeHistoryDocumentFingerprintV1(nativeHistoryExtensionsDocumentBytes(nextDocument));
  const nextPreflight = preflightExtensionsDocumentV1({
    stateRoot: input.stateRoot,
    config: input.nextConfig,
    secret: input.secret,
    baseSource: input.baseSource,
    baseSourceDocumentFingerprint: input.baseSourceDocumentFingerprint,
    document: nextDocument,
    documentFingerprint: nextFingerprint,
  });
  if (nextPreflight.state !== "ready") throw new Error(`native history extension next preflight failed: ${nextPreflight.reason}`);
  const prior: NativeHistoryExtensionDocumentProofV1 = {
    document: priorPreflight.extensions,
    documentFingerprint: priorPreflight.extensionDocumentFingerprint,
  };
  const next: PreparedNativeHistoryExtensionUpdateV1["next"] = { document: nextDocument, documentFingerprint: nextFingerprint };
  return {
    prior,
    next,
    intentFingerprint: `sha256:${createHash("sha256").update(canonicalJson({
      baseSourceFingerprint: input.baseSourceDocumentFingerprint,
      prior: prior.documentFingerprint,
      next: next.documentFingerprint,
      priorAccountSet: input.priorConfig.accounts.map((account) => account.opaqueAccountId).sort(),
      nextAccountSet: input.nextConfig.accounts.map((account) => account.opaqueAccountId).sort(),
    }), "utf8").digest("hex")}`,
  };
}

/**
 * Publishes only the prepared signed next extension after the owner has
 * journaled its expected prior raw fingerprint. It never rewrites the source
 * document and refuses drift between preparation and publication.
 */
export function publishPreparedNativeHistoryExtensionUpdateV1(input: {
  stateRoot: string;
  secret: Buffer;
  prior: NativeHistoryExtensionDocumentProofV1;
  next: PreparedNativeHistoryExtensionUpdateV1["next"];
}): Sha256 {
  if (input.secret.byteLength !== 32 || !validProof(input.prior, input.secret) || !validProof(input.next, input.secret, true)) {
    throw new Error("invalid native history extension publish input");
  }
  const current = readExtensionsDocument(input.stateRoot, input.secret);
  if (!documentProofMatches(current, input.prior)) throw new Error("native history extension changed before publication");
  const root = privateCanonicalDirectory(input.stateRoot);
  if (!root) throw new Error("unsafe native history extension state root");
  const expectedNextFingerprint = nativeHistoryDocumentFingerprintV1(nativeHistoryExtensionsDocumentBytes(input.next.document));
  if (!sameSecretString(expectedNextFingerprint, input.next.documentFingerprint)) throw new Error("invalid prepared native history extension fingerprint");
  writePrivateJsonAtomicBounded(root, NATIVE_HISTORY_EXTENSIONS_FILE_V1, input.next.document, NATIVE_HISTORY_EXTENSIONS_MAX_BYTES_V1);
  const persisted = readExtensionsDocument(root, input.secret);
  if (persisted.state !== "ready" || !sameSecretString(persisted.fingerprint, input.next.documentFingerprint)
    || !sameExtensions(persisted.document, input.next.document)) {
    throw new Error("native history extension publication postcondition failed");
  }
  return persisted.fingerprint;
}

/**
 * Read-only deterministic recovery classifier. The caller decides whether it
 * must finish the matching prior or next router state/config generation.
 */
export function recoverNativeHistoryExtensionUpdateV1(input: RecoverNativeHistoryExtensionUpdateInputV1): NativeHistoryExtensionRecoveryV1 {
  if (input.secret.byteLength !== 32 || !validProof(input.prior, input.secret) || !validProof(input.next, input.secret, true)
    || sameProof(input.prior, input.next)) return { state: "invalid", reason: "invalid_proof" };
  const current = readExtensionsDocument(input.stateRoot, input.secret);
  const choose = documentProofMatches(current, input.prior) ? "prior"
    : documentProofMatches(current, input.next) ? "next" : null;
  if (!choose) return { state: "invalid", reason: current.state === "invalid" ? current.reason : "invalid_proof" };
  const preflight = preflightNativeHistoryExtensionsV1({
    stateRoot: input.stateRoot,
    config: choose === "prior" ? input.priorConfig : input.nextConfig,
    secret: input.secret,
    baseSource: input.baseSource,
    baseSourceDocumentFingerprint: input.baseSourceDocumentFingerprint,
  });
  if (preflight.state !== "ready") return { state: "invalid", reason: preflight.reason };
  const expected = choose === "prior" ? input.prior : input.next;
  if (!sameSecretString(preflight.extensionDocumentFingerprint ?? "", expected.documentFingerprint ?? "")) {
    return { state: "invalid", reason: "invalid_proof" };
  }
  return { state: choose, preflight };
}

/** Exact bytes used by the private atomic writer and journaled digest. */
export function nativeHistoryExtensionsDocumentBytes(next: NativeHistoryExtensionsV1): Buffer {
  if (!isNativeHistoryExtensions(next)) throw new Error("invalid native history extension document");
  const bytes = Buffer.from(`${JSON.stringify(next)}\n`, "utf8");
  if (bytes.byteLength > NATIVE_HISTORY_EXTENSIONS_MAX_BYTES_V1) throw new Error("native history extension document exceeds bound");
  return bytes;
}

function preflightExtensionsDocumentV1(input: NativeHistoryExtensionsPreflightInputV1 & {
  document: NativeHistoryExtensionsV1;
  documentFingerprint: Sha256;
}): NativeHistoryExtensionsPreflightV1 {
  if (input.secret.byteLength !== 32 || !privateCanonicalDirectory(input.stateRoot)) return { state: "invalid", reason: "unsafe_state_root" };
  const document = parseNativeHistoryExtensionsV1(input.document, input.secret);
  if (!document || !sameSecretString(nativeHistoryDocumentFingerprintV1(nativeHistoryExtensionsDocumentBytes(document)), input.documentFingerprint)) {
    return { state: "invalid", reason: "invalid_extensions" };
  }
  if (!sameSecretString(document.baseSourceFingerprint, input.baseSourceDocumentFingerprint)) return { state: "invalid", reason: "base_source_mismatch" };
  const baseIds = input.baseSource.accounts.map((account) => account.opaqueAccountId);
  const managedIds = document.managedAccounts.map((account) => account.opaqueAccountId);
  if (!uniqueSortedOpaqueIds(baseIds) || !uniqueSortedOpaqueIds(managedIds) || managedIds.some((account) => baseIds.includes(account))) {
    return { state: "invalid", reason: "effective_account_set_mismatch" };
  }
  let expected: Sha256;
  try { expected = nativeHistoryEffectiveAccountSetFingerprintV1([...baseIds, ...managedIds]); }
  catch { return { state: "invalid", reason: "effective_account_set_mismatch" }; }
  if (!sameSecretString(expected, document.effectiveAccountSetFingerprint)
    || !sameAccountSet([...baseIds, ...managedIds], input.config.accounts.map((account) => account.opaqueAccountId))) {
    return { state: "invalid", reason: "effective_account_set_mismatch" };
  }
  const managedAccounts: NativeHistoryManagedAccountBindingV2[] = [];
  for (const account of document.managedAccounts) {
    const binding = validateNativeHistoryManagedEnrollmentReceiptV1({ stateRoot: input.stateRoot, secret: input.secret, account });
    if (!binding) return { state: "invalid", reason: "managed_receipt_invalid" };
    managedAccounts.push(binding);
  }
  return { state: "ready", extensions: document, extensionDocumentFingerprint: input.documentFingerprint, managedAccounts };
}

function readExtensionsDocument(stateRoot: string, secret: Buffer):
  | { state: "absent" }
  | { state: "ready"; document: NativeHistoryExtensionsV1; fingerprint: Sha256 }
  | { state: "invalid"; reason: "unsafe_state_root" | "unsafe_extensions_file" | "invalid_extensions" } {
  const root = privateCanonicalDirectory(stateRoot);
  if (!root) return { state: "invalid", reason: "unsafe_state_root" };
  const path = join(root, NATIVE_HISTORY_EXTENSIONS_FILE_V1);
  if (!existsSync(path)) return { state: "absent" };
  const bytes = readPrivateRegularFile(path, NATIVE_HISTORY_EXTENSIONS_MAX_BYTES_V1, false);
  if (!bytes) return { state: "invalid", reason: "unsafe_extensions_file" };
  try {
    const document = parseNativeHistoryExtensionsV1(JSON.parse(bytes.toString("utf8")) as unknown, secret);
    return document ? { state: "ready", document, fingerprint: nativeHistoryDocumentFingerprintV1(bytes) }
      : { state: "invalid", reason: "invalid_extensions" };
  } catch {
    return { state: "invalid", reason: "invalid_extensions" };
  } finally {
    bytes.fill(0);
  }
}

function readManagedReceipt(stateRoot: string, account: OpaqueAccountId, secret: Buffer):
  | { receipt: NativeHistoryManagedEnrollmentReceiptV1; fingerprint: Sha256 }
  | null {
  const root = managedAccountRoot(stateRoot, account);
  if (!root) return null;
  const bytes = readPrivateRegularFile(join(root, NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_FILE_V1), NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_MAX_BYTES_V1, false);
  if (!bytes) return null;
  try {
    const receipt = parseNativeHistoryManagedEnrollmentReceiptV1(JSON.parse(bytes.toString("utf8")) as unknown, secret);
    return receipt ? { receipt, fingerprint: nativeHistoryDocumentFingerprintV1(bytes) } : null;
  } catch {
    return null;
  } finally {
    bytes.fill(0);
  }
}

function validateManagedAccountHome(
  stateRoot: string,
  account: NativeHistoryManagedAccountDraftV1 | NativeHistoryManagedAccountV1,
  secret: Buffer,
): ValidatedManagedAccountHomeV1 | null {
  if (secret.byteLength !== 32 || !isManagedAccountDraft(account)) return null;
  const root = privateCanonicalDirectory(stateRoot);
  if (!root || account.accountRootRelativePath !== `accounts/${account.opaqueAccountId}`) return null;
  const accountRoot = managedAccountRoot(root, account.opaqueAccountId);
  if (!accountRoot || relative(root, accountRoot) !== account.accountRootRelativePath) return null;
  const codexHome = join(accountRoot, "codex-home");
  const sqliteHome = join(accountRoot, "sqlite-home");
  if (!managerPathMatchesIdentity(codexHome, account.codexHomeIdentity)
    || !managerPathMatchesIdentity(sqliteHome, account.sqliteHomeIdentity)) return null;
  const rawAccountId = readAuthAccountId(codexHome);
  if (!rawAccountId || !sameSecretString(nativeHistoryAuthIdentityHmac(rawAccountId, secret), account.authIdentityHmac)
    || !sameSecretString(nativeHistoryOpaqueAccountId(rawAccountId, secret), account.opaqueAccountId)) return null;
  return {
    accountRoot,
    codexHome,
    sqliteHome,
  };
}

function managedAccountRoot(stateRoot: string, account: OpaqueAccountId): string | null {
  const root = privateCanonicalDirectory(stateRoot);
  if (!root || !isOpaqueAccountId(account)) return null;
  const accountsRoot = join(root, "accounts");
  if (!privateCanonicalDirectory(accountsRoot)) return null;
  const accountRoot = join(accountsRoot, account);
  return privateCanonicalDirectory(accountRoot) ? accountRoot : null;
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

function managerPathMatchesIdentity(path: string, expected: NativeHistoryDirectoryIdentityV1): boolean {
  try {
    if (!canonicalPath(path) || realpathSync(path) !== path) return false;
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0
      && stat.dev === expected.device && stat.ino === expected.inode && stat.uid === expected.uid && (stat.mode & 0o7777) === expected.mode;
  } catch {
    return false;
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

function readAuthAccountId(codexHome: string): string | null {
  const bytes = readPrivateRegularFile(join(codexHome, "auth.json"), 256 * 1024, false);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    return isPlainRecord(parsed) && isPlainRecord(parsed.tokens) && validRawAccountId(parsed.tokens.account_id)
      ? parsed.tokens.account_id : null;
  } catch {
    return null;
  } finally {
    bytes.fill(0);
  }
}

function nativeHistoryAuthIdentityHmac(rawAccountId: string, secret: Buffer): HmacSha256 {
  return `hmac-sha256:${createHmac("sha256", secret).update(`account-router:native-history-auth:v1\0${rawAccountId}`, "utf8").digest("hex")}`;
}

function nativeHistoryOpaqueAccountId(rawAccountId: string, secret: Buffer): OpaqueAccountId {
  return `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}` as OpaqueAccountId;
}

function extensionsSignature(unsigned: NativeHistoryExtensionsUnsignedV1, secret: Buffer): HmacSha256 {
  return `hmac-sha256:${createHmac("sha256", secret)
    .update(`account-router:native-history-extensions:v1\0${canonicalJson(unsigned)}`, "utf8").digest("hex")}`;
}

function managedReceiptSignature(unsigned: NativeHistoryManagedEnrollmentReceiptUnsignedV1, secret: Buffer): HmacSha256 {
  return `hmac-sha256:${createHmac("sha256", secret)
    .update(`account-router:native-history-managed-enrollment-receipt:v1\0${canonicalJson(unsigned)}`, "utf8").digest("hex")}`;
}

function isNativeHistoryExtensions(value: unknown): value is NativeHistoryExtensionsV1 {
  if (!isPlainRecord(value) || sortedKeys(value) !== [
    "baseSourceFingerprint", "effectiveAccountSetFingerprint", "generation", "issuedAt", "kind", "managedAccounts", "signature", "version",
  ].join("\0") || !validHmac(value.signature)) return false;
  return isNativeHistoryExtensionsUnsigned({
    version: value.version,
    kind: value.kind,
    baseSourceFingerprint: value.baseSourceFingerprint,
    generation: value.generation,
    managedAccounts: value.managedAccounts,
    effectiveAccountSetFingerprint: value.effectiveAccountSetFingerprint,
    issuedAt: value.issuedAt,
  });
}

function isNativeHistoryExtensionsUnsigned(value: unknown): value is NativeHistoryExtensionsUnsignedV1 {
  if (!isPlainRecord(value) || sortedKeys(value) !== [
    "baseSourceFingerprint", "effectiveAccountSetFingerprint", "generation", "issuedAt", "kind", "managedAccounts", "version",
  ].join("\0") || value.version !== 1 || value.kind !== NATIVE_HISTORY_EXTENSIONS_KIND_V1
    || !isFingerprint(value.baseSourceFingerprint) || !isFingerprint(value.effectiveAccountSetFingerprint)
    || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1 || !isIsoTimestamp(value.issuedAt)
    || !Array.isArray(value.managedAccounts)) return false;
  const accounts = value.managedAccounts.map(parseManagedAccount);
  return !accounts.some((account) => account === null)
    && uniqueSortedOpaqueIds((accounts as NativeHistoryManagedAccountV1[]).map((account) => account.opaqueAccountId));
}

function isManagedReceipt(value: unknown): value is NativeHistoryManagedEnrollmentReceiptV1 {
  if (!isPlainRecord(value) || sortedKeys(value) !== [
    "accountRootRelativePath", "authIdentityHmac", "codexHomeIdentity", "issuedAt", "kind", "opaqueAccountId", "signature", "sqliteHomeIdentity", "version",
  ].join("\0") || !validHmac(value.signature)) return false;
  return isManagedReceiptUnsigned({
    version: value.version,
    kind: value.kind,
    opaqueAccountId: value.opaqueAccountId,
    accountRootRelativePath: value.accountRootRelativePath,
    codexHomeIdentity: value.codexHomeIdentity,
    sqliteHomeIdentity: value.sqliteHomeIdentity,
    authIdentityHmac: value.authIdentityHmac,
    issuedAt: value.issuedAt,
  });
}

function isManagedReceiptUnsigned(value: unknown): value is NativeHistoryManagedEnrollmentReceiptUnsignedV1 {
  if (!isPlainRecord(value) || sortedKeys(value) !== [
    "accountRootRelativePath", "authIdentityHmac", "codexHomeIdentity", "issuedAt", "kind", "opaqueAccountId", "sqliteHomeIdentity", "version",
  ].join("\0") || value.version !== 1 || value.kind !== NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_KIND_V1
    || !isIsoTimestamp(value.issuedAt)) return false;
  return isManagedAccountDraft(value);
}

function parseManagedAccount(value: unknown): NativeHistoryManagedAccountV1 | null {
  if (!isPlainRecord(value) || sortedKeys(value) !== [
    "accountRootRelativePath", "authIdentityHmac", "codexHomeIdentity", "enrollmentReceiptFingerprint", "opaqueAccountId", "sqliteHomeIdentity",
  ].join("\0")) return null;
  const enrollmentReceiptFingerprint = value.enrollmentReceiptFingerprint;
  if (!isManagedAccountDraft(value) || !isFingerprint(enrollmentReceiptFingerprint)) return null;
  return {
    ...cloneManagedAccountDraft(value),
    enrollmentReceiptFingerprint,
  };
}

function isNativeHistoryManagedAccount(value: unknown): value is NativeHistoryManagedAccountV1 {
  return parseManagedAccount(value) !== null;
}

function isManagedAccountDraft(value: unknown): value is NativeHistoryManagedAccountDraftV1 {
  return isPlainRecord(value) && isOpaqueAccountId(value.opaqueAccountId)
    && typeof value.accountRootRelativePath === "string" && value.accountRootRelativePath === `accounts/${value.opaqueAccountId}`
    && isDirectoryIdentity(value.codexHomeIdentity) && isDirectoryIdentity(value.sqliteHomeIdentity)
    && validHmac(value.authIdentityHmac);
}

function cloneExtensionsUnsigned(value: NativeHistoryExtensionsUnsignedV1): NativeHistoryExtensionsUnsignedV1 {
  return {
    version: 1,
    kind: NATIVE_HISTORY_EXTENSIONS_KIND_V1,
    baseSourceFingerprint: value.baseSourceFingerprint,
    generation: value.generation,
    managedAccounts: value.managedAccounts.map(cloneManagedAccount),
    effectiveAccountSetFingerprint: value.effectiveAccountSetFingerprint,
    issuedAt: value.issuedAt,
  };
}

function cloneExtensions(value: NativeHistoryExtensionsV1): NativeHistoryExtensionsV1 {
  return { ...cloneExtensionsUnsigned(value), signature: value.signature };
}

function cloneManagedReceiptUnsigned(value: NativeHistoryManagedEnrollmentReceiptUnsignedV1): NativeHistoryManagedEnrollmentReceiptUnsignedV1 {
  return {
    version: 1,
    kind: NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_KIND_V1,
    ...cloneManagedAccountDraft(value),
    issuedAt: value.issuedAt,
  };
}

function cloneManagedAccount(value: NativeHistoryManagedAccountV1): NativeHistoryManagedAccountV1 {
  return { ...cloneManagedAccountDraft(value), enrollmentReceiptFingerprint: value.enrollmentReceiptFingerprint };
}

function cloneManagedAccountDraft(value: NativeHistoryManagedAccountDraftV1): NativeHistoryManagedAccountDraftV1 {
  return {
    opaqueAccountId: value.opaqueAccountId,
    accountRootRelativePath: value.accountRootRelativePath,
    codexHomeIdentity: { ...value.codexHomeIdentity },
    sqliteHomeIdentity: { ...value.sqliteHomeIdentity },
    authIdentityHmac: value.authIdentityHmac,
  };
}

function cloneManagedBinding(value: NativeHistoryManagedAccountBindingV2): NativeHistoryManagedAccountBindingV2 {
  return { ...cloneManagedAccount(value), kind: "managed_adopted", accountRoot: value.accountRoot, codexHome: value.codexHome, sqliteHome: value.sqliteHome };
}

function cloneExternalAccount(value: NativeHistoryAccountSourceV1): NativeHistoryAccountSourceV1 {
  return {
    opaqueAccountId: value.opaqueAccountId,
    codexHome: value.codexHome,
    sqliteHome: value.sqliteHome,
    codexHomeIdentity: { ...value.codexHomeIdentity },
    sqliteHomeIdentity: { ...value.sqliteHomeIdentity },
    authIdentityHmac: value.authIdentityHmac,
  };
}

function cloneSource(value: NativeHistorySourceV1): NativeHistorySourceV1 {
  return {
    version: 1,
    kind: value.kind,
    mode: value.mode,
    protocolFingerprint: value.protocolFingerprint,
    accountSetFingerprint: value.accountSetFingerprint,
    metadataAccountId: value.metadataAccountId,
    accounts: value.accounts.map(cloneExternalAccount),
    issuedAt: value.issuedAt,
    signature: value.signature,
  };
}

function sameManagedReceipt(left: NativeHistoryManagedEnrollmentReceiptV1, right: NativeHistoryManagedEnrollmentReceiptV1): boolean {
  return sameSecretString(canonicalJson(left), canonicalJson(right));
}

function sameExtensions(left: NativeHistoryExtensionsV1, right: NativeHistoryExtensionsV1): boolean {
  return sameSecretString(canonicalJson(left), canonicalJson(right));
}

function documentProofMatches(
  current: ReturnType<typeof readExtensionsDocument>,
  proof: NativeHistoryExtensionDocumentProofV1,
): boolean {
  if (proof.document === null || proof.documentFingerprint === null) return current.state === "absent" && proof.document === null && proof.documentFingerprint === null;
  return current.state === "ready" && sameSecretString(current.fingerprint, proof.documentFingerprint)
    && sameExtensions(current.document, proof.document);
}

function validProof(value: NativeHistoryExtensionDocumentProofV1, secret: Buffer, requirePreparedBytes = false): boolean {
  if ((value.document === null) !== (value.documentFingerprint === null)) return false;
  if (value.document === null || value.documentFingerprint === null) return value.document === null && value.documentFingerprint === null;
  if (!isFingerprint(value.documentFingerprint)) return false;
  const parsed = parseNativeHistoryExtensionsV1(value.document, secret);
  if (!parsed || !sameExtensions(parsed, value.document)) return false;
  if (!requirePreparedBytes) return true;
  try { return sameSecretString(nativeHistoryDocumentFingerprintV1(nativeHistoryExtensionsDocumentBytes(parsed)), value.documentFingerprint); }
  catch { return false; }
}

function sameProof(left: NativeHistoryExtensionDocumentProofV1, right: NativeHistoryExtensionDocumentProofV1): boolean {
  return left.document === null && right.document === null
    || left.documentFingerprint !== null && right.documentFingerprint !== null && sameSecretString(left.documentFingerprint, right.documentFingerprint);
}

function sameAccountSet(left: readonly OpaqueAccountId[], right: readonly OpaqueAccountId[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((account, index) => account === rightSorted[index]);
}

function uniqueSortedOpaqueIds(accounts: readonly OpaqueAccountId[]): boolean {
  return accounts.length > 0 && accounts.every(isOpaqueAccountId) && new Set(accounts).size === accounts.length
    && accounts.every((account, index) => index === 0 || accounts[index - 1]! < account);
}

function isDirectoryIdentity(value: unknown): value is NativeHistoryDirectoryIdentityV1 {
  return isPlainRecord(value) && sortedKeys(value) === ["device", "inode", "mode", "uid"].join("\0")
    && [value.device, value.inode, value.uid, value.mode].every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)
    && typeof value.mode === "number" && value.mode <= 0o7777;
}

function validHmac(value: unknown): value is HmacSha256 {
  return typeof value === "string" && /^hmac-sha256:[a-f0-9]{64}$/.test(value);
}

function validRawAccountId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function canonicalPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0")
    && isAbsolute(value) && resolve(value) === value;
}

function sortedKeys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join("\0");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sameSecretString(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
