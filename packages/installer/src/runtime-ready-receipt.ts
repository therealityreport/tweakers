import { basename, isAbsolute, resolve } from "node:path";
import { assertAcceptedRuntimeRepairReadyBindingContract, type AcceptedRuntimeRepairReadyBindingV1 } from "@therealityreport/tweakers-sdk";
import { TWEAKERS_VARIANT_BUNDLE_ID, REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS } from "./macos-variant.js";
import type { IndependentTweakersBrokerAuthorityExpectation } from "./account-router-status.js";
const REQUIRED_TWEAKERS_TWEAKS = new Set(REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS);

export const INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_FILE = "runtime-ready-expectation.json";
export const INDEPENDENT_TWEAKERS_RUNTIME_READY_RECEIPT_FILE = "runtime-ready.json";
export const INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION = 5 as const;
export const INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND = "tweakers-independent-runtime-ready" as const;
export const INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND = "tweakers-independent-runtime-ready-expectation" as const;

export interface IndependentTweakersRuntimeReadyExpectation {
  schemaVersion: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION | 6;
  /** Required only for schema6; schema5 explicitly rejects this key. */
  runtimeRepair?: AcceptedRuntimeRepairReadyBindingV1;
  kind: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND;
  operationId: string;
  promotionId: string;
  activePromotionReceiptSha256: string;
  appRoot: string;
  bundleId: typeof TWEAKERS_VARIANT_BUNDLE_ID;
  appAsarHeaderHash: string;
  runtimeFingerprint: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  brokerAuthorityExpectation: IndependentTweakersBrokerAuthorityExpectation;
  /**
   * The manager requires the independent window to have a verified Actual
   * Size observation before it can accept a startup receipt. This is a fixed
   * contract rather than a best-effort diagnostics field, so the runtime
   * receipt must bind it exactly.
   */
  appearanceExpectation: IndependentTweakersRuntimeReadyAppearanceBinding;
  expectedTweakIds: readonly string[];
  createdAt: string;
}

export interface IndependentTweakersRuntimeReadyAppearanceBinding {
  status: "normal";
  normalized: true;
}

export interface IndependentTweakersRuntimeReadyReceipt {
  schemaVersion: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION | 6;
  runtimeRepair?: AcceptedRuntimeRepairReadyBindingV1;
  kind: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND;
  operationId: string;
  promotionId: string;
  activePromotionReceiptSha256: string;
  pid: number;
  processStartToken: string;
  appRoot: string;
  bundleId: typeof TWEAKERS_VARIANT_BUNDLE_ID;
  appAsarHeaderHash: string;
  runtimeFingerprint: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  brokerAuthorityExpectation: IndependentTweakersBrokerAuthorityExpectation;
  appearance: IndependentTweakersRuntimeReadyAppearanceBinding;
  mainInitialized: true;
  preloadInitialized: true;
  settingsMounted: true;
  sharedHistoryBrokerState: "connected" | "blocked";
  initializedTweakIds: readonly string[];
  observedAt: string;
}

export function verifyRuntimeReadyReceiptBinding(
  expectation: IndependentTweakersRuntimeReadyExpectation,
  value: unknown,
  expectedPid: number,
  expectedProcessStartToken: string,
): asserts value is IndependentTweakersRuntimeReadyReceipt {
  assertIndependentTweakersRuntimeReadyExpectation(expectation);
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    throw new Error("Independent Tweakers runtime-ready verification requires an exact new main PID.");
  }
  if (!isProcessStartToken(expectedProcessStartToken)) {
    throw new Error("Independent Tweakers runtime-ready verification requires an exact process start token.");
  }
  assertIndependentTweakersRuntimeReadyReceipt(value);
  const receipt = value as IndependentTweakersRuntimeReadyReceipt;
  if (receipt.schemaVersion !== expectation.schemaVersion
    || !sameRuntimeRepairReadyBinding(receipt.runtimeRepair, expectation.runtimeRepair)
    || receipt.operationId !== expectation.operationId
    || receipt.promotionId !== expectation.promotionId
    || receipt.activePromotionReceiptSha256 !== expectation.activePromotionReceiptSha256
    || receipt.pid !== expectedPid
    || receipt.processStartToken !== expectedProcessStartToken
    || receipt.appRoot !== expectation.appRoot
    || receipt.bundleId !== expectation.bundleId
    || receipt.appAsarHeaderHash.toLowerCase() !== expectation.appAsarHeaderHash.toLowerCase()
    || receipt.runtimeFingerprint.toLowerCase() !== expectation.runtimeFingerprint.toLowerCase()
    || receipt.appUserDataRoot !== expectation.appUserDataRoot
    || receipt.codexHomeRoot !== expectation.codexHomeRoot
    || receipt.accountsBrokerRoot !== expectation.accountsBrokerRoot
    || !sameBrokerAuthorityExpectation(receipt.brokerAuthorityExpectation, expectation.brokerAuthorityExpectation)
    || !sameRuntimeReadyAppearanceBinding(receipt.appearance, expectation.appearanceExpectation)
    || receipt.mainInitialized !== true
    || receipt.preloadInitialized !== true
    || receipt.settingsMounted !== true
    || expectation.brokerAuthorityExpectation.globalRootState !== "valid-v3"
    || receipt.sharedHistoryBrokerState !== "connected"
    || !sameSortedStringSet(receipt.initializedTweakIds, expectation.expectedTweakIds)) {
    throw new Error("Independent Tweakers runtime-ready receipt does not match the prepared operation, broker authority, appearance requirement, derived-app identity, or complete tweak set.");
  }
}

export function assertIndependentTweakersRuntimeReadyExpectation(
  value: unknown,
): asserts value is IndependentTweakersRuntimeReadyExpectation {
  const repairKeys = runtimeRepairSchemaKeys(value);
  assertExactObjectKeys(value, [
    "schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint",
    "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "appearanceExpectation", "expectedTweakIds", "createdAt", ...repairKeys,
  ], "Independent Tweakers runtime-ready expectation");
  const expectation = value as Record<string, unknown>;
  if (![INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION, 6].includes(expectation.schemaVersion as number)
    || expectation.kind !== INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND
    || typeof expectation.operationId !== "string"
    || typeof expectation.promotionId !== "string"
    || !isSha256(expectation.activePromotionReceiptSha256)
    || !isCanonicalAbsolutePath(String(expectation.appRoot ?? ""))
    || expectation.bundleId !== TWEAKERS_VARIANT_BUNDLE_ID
    || !isSha256(expectation.appAsarHeaderHash)
    || !isSha256(expectation.runtimeFingerprint)
    || !isCanonicalAbsolutePath(String(expectation.appUserDataRoot ?? ""))
    || !isCanonicalAbsolutePath(String(expectation.codexHomeRoot ?? ""))
    || !isCanonicalAbsolutePath(String(expectation.accountsBrokerRoot ?? ""))
    || !isIndependentTweakersBrokerAuthorityExpectation(expectation.brokerAuthorityExpectation)
    || !isIndependentTweakersRuntimeReadyAppearanceBinding(expectation.appearanceExpectation)
    || !isSupportedEnabledTweakSet(expectation.expectedTweakIds)
    || !isValidRfc3339(expectation.createdAt)) {
    throw new Error("Independent Tweakers runtime-ready expectation has an invalid schema.");
  }
  assertVariantPromotionId(expectation.operationId);
  assertVariantPromotionId(expectation.promotionId);
}

export function assertIndependentTweakersRuntimeReadyReceipt(
  value: unknown,
): asserts value is IndependentTweakersRuntimeReadyReceipt {
  const repairKeys = runtimeRepairSchemaKeys(value);
  assertExactObjectKeys(value, [
    "schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "pid", "processStartToken", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint",
    "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "mainInitialized", "preloadInitialized",
    "appearance", "settingsMounted", "sharedHistoryBrokerState", "initializedTweakIds", "observedAt", ...repairKeys,
  ], "Independent Tweakers runtime-ready receipt");
  const receipt = value as Record<string, unknown>;
  if (![INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION, 6].includes(receipt.schemaVersion as number)
    || receipt.kind !== INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND
    || typeof receipt.operationId !== "string"
    || typeof receipt.promotionId !== "string"
    || !isSha256(receipt.activePromotionReceiptSha256)
    || !Number.isSafeInteger(receipt.pid) || (receipt.pid as number) <= 0
    || !isProcessStartToken(receipt.processStartToken)
    || !isCanonicalAbsolutePath(String(receipt.appRoot ?? ""))
    || receipt.bundleId !== TWEAKERS_VARIANT_BUNDLE_ID
    || !isSha256(receipt.appAsarHeaderHash)
    || !isSha256(receipt.runtimeFingerprint)
    || !isCanonicalAbsolutePath(String(receipt.appUserDataRoot ?? ""))
    || !isCanonicalAbsolutePath(String(receipt.codexHomeRoot ?? ""))
    || !isCanonicalAbsolutePath(String(receipt.accountsBrokerRoot ?? ""))
    || !isIndependentTweakersBrokerAuthorityExpectation(receipt.brokerAuthorityExpectation)
    || !isIndependentTweakersRuntimeReadyAppearanceBinding(receipt.appearance)
    || receipt.mainInitialized !== true
    || receipt.preloadInitialized !== true
    || receipt.settingsMounted !== true
    || !["connected", "blocked"].includes(String(receipt.sharedHistoryBrokerState ?? ""))
    || !isSupportedEnabledTweakSet(receipt.initializedTweakIds)
    || !isValidRfc3339(receipt.observedAt)) {
    throw new Error("Independent Tweakers runtime-ready receipt has an invalid schema.");
  }
  assertVariantPromotionId(receipt.operationId);
  assertVariantPromotionId(receipt.promotionId);
}

function runtimeRepairSchemaKeys(value: unknown): string[] {
  const object = value as { schemaVersion?: unknown; runtimeRepair?: unknown } | null;
  if (object?.schemaVersion === 6) {
    assertAcceptedRuntimeRepairReadyBindingContract(object.runtimeRepair);
    return ["runtimeRepair"];
  }
  return []; // Exact key checks reject schema5-with-binding, including undefined/null.
}

export function sameRuntimeRepairReadyBinding(left: AcceptedRuntimeRepairReadyBindingV1 | undefined,
  right: AcceptedRuntimeRepairReadyBindingV1 | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.repairId === right.repairId && left.headSha256 === right.headSha256
    && left.intentSha256 === right.intentSha256 && left.authorityReceiptSha256 === right.authorityReceiptSha256;
}

function isIndependentTweakersBrokerAuthorityExpectation(
  value: unknown,
): value is IndependentTweakersBrokerAuthorityExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const authority = value as Record<string, unknown>;
  return Object.keys(authority).sort().join("\0") === ["configSha256", "globalRootState"].join("\0")
    && ((authority.globalRootState === "absent" && authority.configSha256 === null)
      || (authority.globalRootState === "valid-v3" && isSha256(authority.configSha256)));
}

function isIndependentTweakersRuntimeReadyAppearanceBinding(
  value: unknown,
): value is IndependentTweakersRuntimeReadyAppearanceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const appearance = value as Record<string, unknown>;
  return Object.keys(appearance).sort().join("\0") === ["normalized", "status"].join("\0")
    && appearance.status === "normal"
    && appearance.normalized === true;
}

export function sameRuntimeReadyAppearanceBinding(
  left: IndependentTweakersRuntimeReadyAppearanceBinding,
  right: IndependentTweakersRuntimeReadyAppearanceBinding,
): boolean {
  return left.status === right.status && left.normalized === right.normalized;
}

export function sameBrokerAuthorityExpectation(
  left: IndependentTweakersBrokerAuthorityExpectation,
  right: IndependentTweakersBrokerAuthorityExpectation,
): boolean {
  return left.globalRootState === right.globalRootState && left.configSha256 === right.configSha256;
}

export function isProcessStartToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function sameSortedStringSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string")
    && value.length === expected.length
    && [...value].sort().every((entry, index) => entry === [...expected].sort()[index]);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function isValidRfc3339(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

function assertVariantPromotionId(id: unknown): asserts id is string {
  if (typeof id !== "string"
    || id === "active"
    || id === "."
    || id === ".."
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    || basename(id) !== id) {
    throw new Error("Variant promotion journal has an invalid transaction ID.");
  }
}

function assertExactObjectKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value as Record<string, unknown>).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} has an unexpected schema.`);
  }
}

function isSupportedEnabledTweakSet(value: unknown): boolean {
  return Array.isArray(value) && new Set(value).size === value.length
    && value.every(id => typeof id === "string" && (REQUIRED_TWEAKERS_TWEAKS as ReadonlySet<string>).has(id));
}

