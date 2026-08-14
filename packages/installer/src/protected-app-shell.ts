import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Source-only contracts for the fail-closed normal-protected desktop shell. */
export const PROTECTED_APP_SHELL_SCHEMA_VERSION = 1 as const;
export const PROTECTED_APP_SIGNATURE_RECEIPT_SCHEMA_VERSION = 1 as const;
export const PROTECTED_UI_OFF_ABSENCE_RECEIPT_SCHEMA_VERSION = 1 as const;

export type ProtectedShellUiFeatures = "off" | "on";
export type ProtectedShellVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface ProtectedArtifactInventoryEntry {
  path: string;
  sha256: string;
  kind: "file" | "directory" | "symlink";
}

export interface ProtectedRuntimeLoadEvent {
  sequence: number;
  kind: "module-load" | "browser-window" | "preload" | "ipc" | "renderer-injection" | "window-hook";
  originPath: string;
  target: string;
  sha256: string | null;
}

export interface ProtectedUiOffAbsenceReceiptV1 {
  schemaVersion: typeof PROTECTED_UI_OFF_ABSENCE_RECEIPT_SCHEMA_VERSION;
  kind: "protected-ui-off-absence";
  verdict: ProtectedShellVerdict;
  /** Receipt-owned launch binding; a static absence scan is not publishable by itself. */
  transactionId: string;
  attempt: number;
  grantNonce: string;
  appliedPendingLaunchGrantSha256: string;
  preflightReceiptSha256: string;
  preflightIdentitySha256: string;
  appAsarSha256: string;
  pristineInventorySha256: string;
  uiOffInventorySha256: string;
  uiOnInventorySha256: string;
  uiOffAllowedDelta: readonly string[];
  uiOnOnlyAdditions: readonly string[];
  forbiddenFindings: readonly string[];
  /** A real pre-main trace is mandatory for PASS; no trace is never absence proof. */
  loadTraceSha256: string;
  checkedAt: string;
  receiptSha256: string;
}

export interface ProtectedNestedCodeIdentity {
  path: string;
  sha256: string;
  architecture: string;
  signingIdentity: string;
  designatedRequirement: string;
  entitlementSha256: string;
}

export interface ProtectedAppSignatureReceiptV1 {
  schemaVersion: typeof PROTECTED_APP_SIGNATURE_RECEIPT_SCHEMA_VERSION;
  kind: "protected-app-signature";
  verdict: ProtectedShellVerdict;
  transactionId: string;
  attempt: number;
  grantNonce: string;
  appliedPendingLaunchGrantSha256: string;
  preflightReceiptSha256: string;
  preflightIdentitySha256: string;
  sourceContentsSha256: string;
  protectedContentsSha256: string;
  signingPosture: "contained";
  signingMode: "local-identity";
  signingIdentity: string;
  certificateSha256: string;
  identityCreated: boolean;
  keychainPath: string;
  keychainSha256: string;
  loginKeychainPreferencesUnchanged: true;
  designatedRequirement: string;
  designatedRequirementSha256: string;
  portableEntitlementsCanonical: string;
  portableEntitlementsSha256: string;
  removedEntitlementKeys: readonly [
    "application-identifier",
    "com.apple.developer.team-identifier",
    "com.apple.security.application-groups",
    "keychain-access-groups",
    "com.apple.developer.aps-environment",
  ];
  appAsarSha256: string;
  appAsarHeaderSha256: string;
  infoPlistAsarIntegrity: { algorithm: "SHA256"; path: "Resources/app.asar"; hash: string };
  nestedCode: readonly ProtectedNestedCodeIdentity[];
  insideOutSigned: true;
  strictVerifyOutput: string;
  displayReadbackOutput: string;
  gatekeeperOutput: string;
  createdAt: string;
  builderVersion: string;
  toolVersions: Readonly<Record<string, string>>;
  policyDigest: string;
  receiptSha256: string;
}

export interface CreateProtectedAppSignatureReceiptInput
  extends Omit<ProtectedAppSignatureReceiptV1, "schemaVersion" | "kind" | "verdict" | "receiptSha256"> {
  verdict?: ProtectedShellVerdict;
}

const SHA256_RE = /^[a-f0-9]{64}$/i;
const FORBIDDEN_UI_OFF_TOKENS = [
  "tweakers renderer",
  "tweakers preload",
  "settings injector",
  "renderer patch",
  "renderer storage",
  "browserwindow hook",
  "window-services hook",
  "executejavascript",
  "insertcss",
  "tweaker:",
] as const;

const UI_OFF_ASAR_ALLOWED_PATHS = new Set([
  "protected-loader.cjs",
  "package.json",
  "tweakers-protected.json",
]);

/**
 * Validates the static UI-off delta plus the recorded pre-main load trace.
 * The caller must provide a complete deterministic inventory; an unknown
 * inventory entry or load origin fails closed instead of being silently
 * treated as an OpenAI module.
 */
export function verifyProtectedUiOffAbsence(input: {
  transactionId: string;
  attempt: number;
  grantNonce: string;
  appliedPendingLaunchGrantSha256: string;
  preflightReceiptSha256: string;
  preflightIdentitySha256: string;
  appAsarSha256: string;
  pristine: readonly ProtectedArtifactInventoryEntry[];
  uiOff: readonly ProtectedArtifactInventoryEntry[];
  uiOn: readonly ProtectedArtifactInventoryEntry[];
  trace: readonly ProtectedRuntimeLoadEvent[];
  openAiMainPath: string;
  protectedLoaderPath: string;
  /** Exact parsed package manifests, needed to constrain the allowed rewrite semantically. */
  pristinePackageJson?: unknown;
  uiOffPackageJson?: unknown;
  checkedAt: string;
}): ProtectedUiOffAbsenceReceiptV1 {
  const forbidden: string[] = [];
  const pristine = canonicalInventory(input.pristine, "pristine");
  const uiOff = canonicalInventory(input.uiOff, "ui-off");
  const uiOn = canonicalInventory(input.uiOn, "ui-on");
  const uiOffDelta = inventoryDelta(pristine, uiOff);
  const uiOnDelta = inventoryDelta(uiOff, uiOn);

  for (const delta of uiOffDelta) {
    if (!UI_OFF_ASAR_ALLOWED_PATHS.has(delta.path)) {
      forbidden.push(`ui-off-static:${delta.path}`);
    }
  }
  verifyUiOffPackageSemanticDelta(input.pristinePackageJson, input.uiOffPackageJson, forbidden);
  for (const entry of uiOff.values()) {
    if (hasForbiddenUiToken(entry.path)) forbidden.push(`ui-off-payload:${entry.path}`);
  }
  for (const entry of uiOnDelta) {
    if (!hasTweakersMarker(entry.path)) {
      forbidden.push(`ui-on-unexpected-delta:${entry.path}`);
    }
  }
  traceForbiddenUiOffLoad(input.trace, input.openAiMainPath, input.protectedLoaderPath, forbidden);

  const loadTraceSha256 = digestTrace(input.trace);
  if (loadTraceSha256 === null) {
    // `traceForbiddenUiOffLoad` recorded the finding too; retain a usable
    // canonical receipt for diagnostics, but it can never validate as PASS.
    forbidden.push("ui-off-load-trace-digest-missing");
  }
  const verdict: ProtectedShellVerdict = forbidden.length === 0 ? "PASS" : "FAIL";
  const withoutDigest: Omit<ProtectedUiOffAbsenceReceiptV1, "receiptSha256"> = {
    schemaVersion: PROTECTED_UI_OFF_ABSENCE_RECEIPT_SCHEMA_VERSION,
    kind: "protected-ui-off-absence" as const,
    verdict,
    transactionId: input.transactionId,
    attempt: input.attempt,
    grantNonce: input.grantNonce,
    appliedPendingLaunchGrantSha256: input.appliedPendingLaunchGrantSha256.toLowerCase(),
    preflightReceiptSha256: input.preflightReceiptSha256.toLowerCase(),
    preflightIdentitySha256: input.preflightIdentitySha256.toLowerCase(),
    appAsarSha256: input.appAsarSha256.toLowerCase(),
    pristineInventorySha256: digestInventory(pristine),
    uiOffInventorySha256: digestInventory(uiOff),
    uiOnInventorySha256: digestInventory(uiOn),
    uiOffAllowedDelta: uiOffDelta.map((entry) => entry.path),
    uiOnOnlyAdditions: uiOnDelta.map((entry) => entry.path),
    forbiddenFindings: forbidden,
    loadTraceSha256: loadTraceSha256 ?? "0".repeat(64),
    checkedAt: requireIso(input.checkedAt, "UI-off absence checkedAt"),
  };
  assertProtectedUiOffAbsenceReceiptInput(withoutDigest);
  return { ...withoutDigest, receiptSha256: sha256Canonical(withoutDigest) };
}

/** Validate the canonical UI-off absence receipt before it participates in publication. */
export function assertProtectedUiOffAbsenceReceipt(
  receipt: unknown,
): asserts receipt is ProtectedUiOffAbsenceReceiptV1 {
  if (!isProtectedUiOffAbsenceReceipt(receipt)) {
    throw new Error("Protected UI-off absence receipt is invalid or incomplete");
  }
}

export function isProtectedUiOffAbsenceReceipt(value: unknown): value is ProtectedUiOffAbsenceReceiptV1 {
  if (!isRecord(value) || typeof value.receiptSha256 !== "string") return false;
  try {
    const { receiptSha256, ...withoutDigest } = value as unknown as ProtectedUiOffAbsenceReceiptV1;
    assertProtectedUiOffAbsenceReceiptInput(withoutDigest);
    return receiptSha256.toLowerCase() === sha256Canonical(withoutDigest);
  } catch {
    return false;
  }
}

function assertProtectedUiOffAbsenceReceiptInput(
  value: Omit<ProtectedUiOffAbsenceReceiptV1, "receiptSha256">,
): void {
  if (value.schemaVersion !== PROTECTED_UI_OFF_ABSENCE_RECEIPT_SCHEMA_VERSION
    || value.kind !== "protected-ui-off-absence"
    || (value.verdict !== "PASS" && value.verdict !== "FAIL" && value.verdict !== "INCONCLUSIVE")
    || !validTransactionId(value.transactionId)
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || typeof value.grantNonce !== "string" || !/^[A-Za-z0-9._-]{16,256}$/.test(value.grantNonce)
    || !Array.isArray(value.uiOffAllowedDelta) || !Array.isArray(value.uiOnOnlyAdditions)
    || !Array.isArray(value.forbiddenFindings)) {
    throw new Error("Protected UI-off absence receipt fields are invalid");
  }
  for (const digest of [
    value.appliedPendingLaunchGrantSha256,
    value.preflightReceiptSha256,
    value.preflightIdentitySha256,
    value.appAsarSha256,
    value.pristineInventorySha256,
    value.uiOffInventorySha256,
    value.uiOnInventorySha256,
    value.loadTraceSha256,
  ]) assertSha256(digest, "Protected UI-off absence digest");
  for (const path of [...value.uiOffAllowedDelta, ...value.uiOnOnlyAdditions]) {
    if (!isInventoryPath(path)) throw new Error("Protected UI-off absence delta path is invalid");
  }
  for (const finding of value.forbiddenFindings) if (!isNonEmpty(finding)) {
    throw new Error("Protected UI-off absence finding is invalid");
  }
  if (value.verdict === "PASS" && value.forbiddenFindings.length !== 0) {
    throw new Error("Passing protected UI-off absence receipt contains forbidden findings");
  }
  requireIso(value.checkedAt, "UI-off absence checkedAt");
}

function verifyUiOffPackageSemanticDelta(
  pristine: unknown,
  uiOff: unknown,
  forbidden: string[],
): void {
  if (!isRecord(pristine) || !isRecord(uiOff)) {
    forbidden.push("ui-off-package-semantic-proof-missing");
    return;
  }
  const allKeys = new Set([...Object.keys(pristine), ...Object.keys(uiOff)]);
  for (const key of allKeys) {
    if (key === "main" || key === "__tweakersProtected") continue;
    if (JSON.stringify(pristine[key]) !== JSON.stringify(uiOff[key])) {
      forbidden.push(`ui-off-package-semantic:${key}`);
    }
  }
  if (typeof pristine.main !== "string" || uiOff.main !== "protected-loader.cjs") {
    forbidden.push("ui-off-package-main-rewrite-invalid");
  }
  const metadata = uiOff.__tweakersProtected;
  if (!isRecord(metadata) || typeof metadata.originalMain !== "string"
    || metadata.originalMain !== pristine.main
    || metadata.uiFeatures !== "off") {
    forbidden.push("ui-off-package-protected-metadata-invalid");
  }
}

/** Creates a complete receipt only when every contained-signing oracle passes. */
export function createProtectedAppSignatureReceipt(
  input: CreateProtectedAppSignatureReceiptInput,
): ProtectedAppSignatureReceiptV1 {
  const verdict = input.verdict ?? "PASS";
  if (verdict !== "PASS") {
    throw new Error("Protected app signature receipts are emitted only from complete PASS evidence");
  }
  assertProtectedSignatureInput(input);
  const withoutDigest = {
    schemaVersion: PROTECTED_APP_SIGNATURE_RECEIPT_SCHEMA_VERSION,
    kind: "protected-app-signature" as const,
    verdict: "PASS" as const,
    ...input,
  };
  const receiptSha256 = sha256Canonical(withoutDigest);
  return { ...withoutDigest, receiptSha256 };
}

export function assertProtectedAppSignatureReceipt(receipt: unknown): asserts receipt is ProtectedAppSignatureReceiptV1 {
  if (!isProtectedAppSignatureReceipt(receipt)) {
    throw new Error("Protected app signature receipt is invalid or incomplete");
  }
}

export function isProtectedAppSignatureReceipt(value: unknown): value is ProtectedAppSignatureReceiptV1 {
  if (!isRecord(value)
    || value.schemaVersion !== PROTECTED_APP_SIGNATURE_RECEIPT_SCHEMA_VERSION
    || value.kind !== "protected-app-signature"
    || value.verdict !== "PASS") return false;
  try {
    const { schemaVersion: _schemaVersion, kind: _kind, verdict: _verdict, receiptSha256, ...input } = value as unknown as ProtectedAppSignatureReceiptV1;
    assertProtectedSignatureInput(input);
    return typeof receiptSha256 === "string" && receiptSha256 === sha256Canonical({
      schemaVersion: PROTECTED_APP_SIGNATURE_RECEIPT_SCHEMA_VERSION,
      kind: "protected-app-signature",
      verdict: "PASS",
      ...input,
    });
  } catch {
    return false;
  }
}

export function protectedUiOffForbiddenModule(path: string): boolean {
  return hasForbiddenUiToken(path);
}

function assertProtectedSignatureInput(input: Omit<ProtectedAppSignatureReceiptV1, "schemaVersion" | "kind" | "verdict" | "receiptSha256">): void {
  if (!validTransactionId(input.transactionId)) throw new Error("Protected signature transaction ID is invalid");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1
    || !/^[A-Za-z0-9._-]{16,256}$/.test(input.grantNonce)) {
    throw new Error("Protected signature launch binding is invalid");
  }
  for (const digest of [
    input.appliedPendingLaunchGrantSha256,
    input.preflightReceiptSha256,
    input.preflightIdentitySha256,
    input.sourceContentsSha256,
    input.protectedContentsSha256,
    input.certificateSha256,
    input.keychainSha256,
    input.designatedRequirementSha256,
    input.portableEntitlementsSha256,
    input.appAsarSha256,
    input.appAsarHeaderSha256,
    input.policyDigest,
  ]) assertSha256(digest, "Protected signature digest");
  if (input.signingPosture !== "contained" || input.signingMode !== "local-identity") {
    throw new Error("Normal protected signing must use contained local identity posture");
  }
  if (!isAbsolute(input.keychainPath) || resolve(input.keychainPath) !== input.keychainPath
    || /(?:^|\/)login\.keychain(?:-db)?$/i.test(input.keychainPath)) {
    throw new Error("Contained signing must use a dedicated non-login keychain");
  }
  if (input.loginKeychainPreferencesUnchanged !== true) {
    throw new Error("Contained signing changed the user login keychain preferences");
  }
  if (!isNonEmpty(input.signingIdentity) || !isNonEmpty(input.designatedRequirement)
    || !isNonEmpty(input.portableEntitlementsCanonical)) {
    throw new Error("Protected signature identity/requirement/entitlements are incomplete");
  }
  const canonical = input.portableEntitlementsCanonical;
  if (!canonical.includes("com.apple.security.cs.disable-library-validation")
    || !/(?:true|<true\/>)/i.test(canonical)) {
    throw new Error("Contained signing must retain disable-library-validation=true");
  }
  const expectedRemoved: ProtectedAppSignatureReceiptV1["removedEntitlementKeys"] = [
    "application-identifier",
    "com.apple.developer.team-identifier",
    "com.apple.security.application-groups",
    "keychain-access-groups",
    "com.apple.developer.aps-environment",
  ];
  if (JSON.stringify(input.removedEntitlementKeys) !== JSON.stringify(expectedRemoved)) {
    throw new Error("Protected signature receipt must bind exactly the removed non-portable entitlements");
  }
  if (input.infoPlistAsarIntegrity.algorithm !== "SHA256"
    || input.infoPlistAsarIntegrity.path !== "Resources/app.asar"
    || input.infoPlistAsarIntegrity.hash.toLowerCase() !== input.appAsarHeaderSha256.toLowerCase()) {
    throw new Error("Info.plist Electron ASAR integrity does not match the recomputed header hash");
  }
  if (!Array.isArray(input.nestedCode) || input.nestedCode.length === 0) {
    throw new Error("Protected signature receipt lacks nested-code inventory");
  }
  const paths = new Set<string>();
  for (const entry of input.nestedCode) {
    if (!isNonEmpty(entry.path) || paths.has(entry.path)) throw new Error("Nested-code inventory path is invalid or duplicated");
    paths.add(entry.path);
    for (const digest of [entry.sha256, entry.entitlementSha256]) assertSha256(digest, "Nested-code digest");
    if (!isNonEmpty(entry.architecture) || !isNonEmpty(entry.signingIdentity) || !isNonEmpty(entry.designatedRequirement)) {
      throw new Error("Nested-code signing inventory is incomplete");
    }
  }
  if (input.insideOutSigned !== true || !isNonEmpty(input.strictVerifyOutput)
    || !isNonEmpty(input.displayReadbackOutput) || !isNonEmpty(input.gatekeeperOutput)) {
    throw new Error("Strict codesign/Gatekeeper evidence is incomplete");
  }
  requireIso(input.createdAt, "Protected signature createdAt");
  if (!isNonEmpty(input.builderVersion) || !isRecord(input.toolVersions) || Object.keys(input.toolVersions).length === 0) {
    throw new Error("Protected signature builder/tool evidence is incomplete");
  }
  for (const version of Object.values(input.toolVersions)) if (!isNonEmpty(version)) {
    throw new Error("Protected signature tool version is invalid");
  }
}

function canonicalInventory(entries: readonly ProtectedArtifactInventoryEntry[], label: string): Map<string, ProtectedArtifactInventoryEntry> {
  const inventory = new Map<string, ProtectedArtifactInventoryEntry>();
  for (const entry of entries) {
    if (!isInventoryPath(entry.path) || !SHA256_RE.test(entry.sha256) || !["file", "directory", "symlink"].includes(entry.kind)) {
      throw new Error(`${label} inventory entry is invalid`);
    }
    if (inventory.has(entry.path)) throw new Error(`${label} inventory contains duplicate path ${entry.path}`);
    inventory.set(entry.path, { ...entry, sha256: entry.sha256.toLowerCase() });
  }
  return inventory;
}

function inventoryDelta(
  before: ReadonlyMap<string, ProtectedArtifactInventoryEntry>,
  after: ReadonlyMap<string, ProtectedArtifactInventoryEntry>,
): ProtectedArtifactInventoryEntry[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().flatMap((path) => {
    const left = before.get(path);
    const right = after.get(path);
    if (!right || !left || left.sha256 !== right.sha256 || left.kind !== right.kind) {
      return right ? [right] : [{ path, sha256: "removed", kind: "file" as const }];
    }
    return [];
  });
}

function traceForbiddenUiOffLoad(
  trace: readonly ProtectedRuntimeLoadEvent[],
  openAiMainPath: string,
  protectedLoaderPath: string,
  forbidden: string[],
): void {
  if (trace.length === 0) {
    forbidden.push("ui-off-load-trace-missing");
    return;
  }
  let previous = -1;
  let loaderSeen = false;
  let mainSeen = false;
  for (const event of trace) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous) {
      forbidden.push("ui-off-load-trace-nonmonotonic");
      continue;
    }
    previous = event.sequence;
    if (!isNonEmpty(event.originPath) || !isNonEmpty(event.target) || (event.sha256 !== null && !SHA256_RE.test(event.sha256))) {
      forbidden.push(`ui-off-load-trace-invalid:${event.sequence}`);
      continue;
    }
    if (event.originPath === protectedLoaderPath) loaderSeen = true;
    if (event.target === openAiMainPath) {
      mainSeen = true;
      if (!loaderSeen) forbidden.push("ui-off-openai-main-before-protected-loader");
    }
    if (hasForbiddenUiToken(event.originPath) || hasForbiddenUiToken(event.target)
      || ["browser-window", "preload", "ipc", "renderer-injection", "window-hook"].includes(event.kind)) {
      forbidden.push(`ui-off-runtime:${event.kind}:${event.target}`);
    }
  }
  if (!loaderSeen) forbidden.push("ui-off-protected-loader-not-observed");
  if (!mainSeen) forbidden.push("ui-off-openai-main-not-observed");
}

function digestInventory(inventory: ReadonlyMap<string, ProtectedArtifactInventoryEntry>): string {
  return sha256Canonical([...inventory.values()].sort((left, right) => left.path.localeCompare(right.path)));
}

function digestTrace(trace: readonly ProtectedRuntimeLoadEvent[]): string | null {
  return trace.length === 0 ? null : sha256Canonical(trace.map((entry) => ({ ...entry })));
}

function hasForbiddenUiToken(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return FORBIDDEN_UI_OFF_TOKENS.some((token) => normalized.includes(token));
}

function hasTweakersMarker(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("tweakers") || normalized.includes("tweaker") || normalized.includes("runtime/");
}

function isInventoryPath(value: string): boolean {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.split(/[\\/]+/).includes("..")
    && value === relative(".", value).split(sep).join("/");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_RE.test(value)) throw new Error(`${label} is invalid`);
}

function validTransactionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function requireIso(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
