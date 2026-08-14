import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProtectedEnvironmentPublication,
  createActiveBackendIdentityReceipt,
  createProtectedEnvironmentPublicationEvidence,
  isActiveBackendIdentityReceipt,
  type ProtectedEnvironmentPublicationEvidenceV1,
} from "./environment-transaction.js";
import { adjudicateInstalledModeCanary, assertInstalledModeCanaryPass, type InstalledModeCanaryReceiptV1 } from "./installed-mode-canary.js";
import { assertFullQuitObservationPass, type FullQuitObservationAuthorityV1, type FullQuitObservationReceiptV1 } from "./full-quit-observer.js";
import { adjudicateManagedMcpCanaryFile, type ManagedMcpCanaryAdjudication } from "./managed-mcp-canary-adjudicator.js";
import { locateCodex } from "./platform.js";
import { getOpenReport, listProcesses } from "./commands/debug.js";
import { fingerprintAppContents } from "./environment-profile.js";
import { signatureInfo, verifySignature } from "./codesign.js";
import { containedSigningKeychainPath } from "./codesign.js";
import { getIntegrity } from "./integrity.js";
import { readHeaderHash } from "./asar.js";
import {
  assertProtectedAppSignatureReceipt,
  assertProtectedUiOffAbsenceReceipt,
  createProtectedAppSignatureReceipt,
  type ProtectedAppSignatureReceiptV1,
  type ProtectedUiOffAbsenceReceiptV1,
} from "./protected-app-shell.js";
import {
  isAppliedPendingLaunchGrantV1Contract,
  isProtectedBootstrapPreflightReceiptContract,
  protectedLaunchIdentitySha256Contract,
  type AppliedPendingLaunchGrantContract as AppliedPendingLaunchGrantV1,
  type ProtectedBootstrapPreflightReceiptContract as ProtectedBootstrapPreflightReceiptV1,
} from "./protected-bootstrap-contract.js";

export interface ProtectedAcceptanceRequest {
  authorityRoot: string;
  transactionId: string;
  attempt: number;
  environment: {
    uiFeatures: "off" | "on";
    mcpSafetyProvider: "managed-turn-idle";
    recoveryState: "normal-protected";
  };
  acceptedBuildReceiptSha256: string;
  /** Exact receipt-owned rollback root from the active install transaction. */
  rollbackAppRoot: string;
  /** Captured from the owning install transaction; a rollback attempt cannot publish protected state. */
  rollbackAttempted: boolean;
}

/**
 * T4's measured canary adapter writes this transaction-owned observation. It
 * contains measurements, not an asserted verdict; this module derives the
 * installed-mode receipt and never upgrades missing evidence to PASS.
 */
export interface MeasuredProtectedCanaryObservation {
  schemaVersion: 1;
  kind: "protected-installed-mode-observation";
  verdict: "PASS";
  transactionId: string;
  attempt: number;
  grantNonce: string;
  appliedPendingLaunchGrantSha256: string;
  preflightReceiptSha256: string;
  preflightIdentitySha256: string;
  activeBackendReceiptSha256: string;
  environment: ProtectedAcceptanceRequest["environment"];
  fixture: {
    tokenFree: boolean;
    modelFree: boolean;
    completedIdleFleetTornDown: boolean;
    busyMailboxFleetPreserved: boolean;
    freshRespawnObserved: boolean;
    attachedUiOwnedSignalCount: number;
    latencyMs: readonly number[];
    cpuSamples: readonly number[];
    rssBytes: readonly number[];
  };
  fullQuitAuthority: FullQuitObservationAuthorityV1;
  fullQuitReceipt: FullQuitObservationReceiptV1;
  uiOffAbsenceReceipt: ProtectedUiOffAbsenceReceiptV1;
  /** Digest of the canonical signing receipt collected from the promoted app. */
  signingReceiptSha256: string;
  /** Raw runner result, adjudicated here rather than asserted by a fixture. */
  managedMcpAdjudication: ManagedMcpCanaryAdjudication;
  /** Digest-bound pre-main trace written by the protected loader itself. */
  runtimeLoadTraceSha256: string;
  /** The post-promotion health probe actually ran and exited cleanly. */
  healthProbeReceiptSha256: string;
  startedAt: string;
  completedAt: string;
  receiptSha256: string;
}

/**
 * Durable evidence emitted immediately after the real post-promotion probe.
 * It deliberately contains process snapshots and spawn status, rather than a
 * hand-written "healthy" flag.  The later acceptance producer combines it
 * with the managed runner, full-quit, loader and performance measurements.
 */
export interface ProtectedPostPromotionHealthProbeReceiptV1 {
  schemaVersion: 1;
  kind: "protected-post-promotion-health-probe";
  transactionId: string;
  attempt: number;
  executable: string;
  pid: number | null;
  status: number | null;
  signal: string | null;
  error: string | null;
  initialProcesses: readonly { pid: number; ppid: number | null; startedAt: string | null; command: string }[];
  finalProcesses: readonly { pid: number; ppid: number | null; startedAt: string | null; command: string }[];
  startedAt: string;
  completedAt: string;
  receiptSha256: string;
}

interface ProtectedInstalledModeMeasurementsV1 {
  schemaVersion: 1;
  kind: "protected-installed-mode-measurements";
  transactionId: string;
  attempt: number;
  grantNonce: string;
  appliedPendingLaunchGrantSha256: string;
  preflightReceiptSha256: string;
  preflightIdentitySha256: string;
  tokenFree: boolean;
  modelFree: boolean;
  fullQuitAuthority: FullQuitObservationAuthorityV1;
  fullQuitReceipt: FullQuitObservationReceiptV1;
  uiOffAbsenceReceipt: ProtectedUiOffAbsenceReceiptV1;
  latencyMs: readonly number[];
  cpuSamples: readonly number[];
  rssBytes: readonly number[];
  startedAt: string;
  completedAt: string;
}

interface ProtectedInstalledModeInconclusiveObservationV1 {
  schemaVersion: 1;
  kind: "protected-installed-mode-observation";
  verdict: "INCONCLUSIVE";
  transactionId: string;
  attempt: number;
  reasons: readonly string[];
  healthProbeReceiptSha256: string | null;
  managedMcpAdjudication: ManagedMcpCanaryAdjudication;
  startedAt: string;
  completedAt: string;
  receiptSha256: string;
}

export const PROTECTED_ROLLBACK_EVIDENCE_SCHEMA_VERSION = 1 as const;

/** Immutable, transaction-owned rollback identity. A path/boolean is never rollback proof. */
export interface ProtectedRollbackEvidenceV1 {
  schemaVersion: typeof PROTECTED_ROLLBACK_EVIDENCE_SCHEMA_VERSION;
  kind: "protected-rollback-evidence";
  transactionId: string;
  attempt: number;
  grantNonce: string;
  appliedPendingLaunchGrantSha256: string;
  preflightReceiptSha256: string;
  preflightIdentitySha256: string;
  acceptedBuildReceiptSha256: string;
  rollbackAppRoot: string;
  rollbackAppContentsSha256: string;
  rollbackAppAsarSha256: string;
  rollbackAttempted: false;
  observedAt: string;
  receiptSha256: string;
}

type RuntimeBootstrapValidators = {
  isAppliedPendingLaunchGrantV1(value: unknown): value is AppliedPendingLaunchGrantV1;
  isProtectedBootstrapPreflightReceipt(value: unknown): value is ProtectedBootstrapPreflightReceiptV1;
  protectedLaunchIdentitySha256(identity: AppliedPendingLaunchGrantV1["identity"]): string;
};

/**
 * The actual installed transaction loads the canonical runtime validator that
 * emitted the preflight receipt. Source tests have no generated runtime asset;
 * their explicit test-only seam uses the byte-for-byte contract mirror below.
 * Never silently fall back for a real promotion: missing canonical runtime
 * validation is itself an acceptance failure.
 */
function runtimeBootstrapValidators(): RuntimeBootstrapValidators {
  const bootstrapPath = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "runtime", "protected-bootstrap.js");
  try {
    const runtime = createRequire(import.meta.url)(bootstrapPath) as Partial<RuntimeBootstrapValidators>;
    if (typeof runtime.isAppliedPendingLaunchGrantV1 === "function"
      && typeof runtime.isProtectedBootstrapPreflightReceipt === "function"
      && typeof runtime.protectedLaunchIdentitySha256 === "function") {
      return runtime as RuntimeBootstrapValidators;
    }
  } catch {
    // Source tests may use the explicit contract seam below. Production never
    // reaches it because a missing compiled runtime is an authority failure.
  }
  if (process.env.TWEAKERS_TEST_ALLOW_SOURCE_PROTECTED_BOOTSTRAP_CONTRACT === "1") {
    return {
      isAppliedPendingLaunchGrantV1: isAppliedPendingLaunchGrantV1Contract,
      isProtectedBootstrapPreflightReceipt: isProtectedBootstrapPreflightReceiptContract,
      protectedLaunchIdentitySha256: protectedLaunchIdentitySha256Contract,
    };
  }
  throw new Error("Canonical protected bootstrap validator is unavailable");
}

export function produceInstalledModeCanaryFromMeasuredObservation(
  observation: unknown,
  signingReceipt: unknown,
): InstalledModeCanaryReceiptV1 {
  if (!isMeasuredCanaryObservation(observation)) {
    throw new Error("Protected measured installed-mode canary observation is invalid or missing");
  }
  assertFullQuitObservationPass(observation.fullQuitReceipt, observation.fullQuitAuthority);
  if (observation.fullQuitAuthority.transactionId !== observation.transactionId) {
    throw new Error("Protected measured full-quit authority does not bind the transaction");
  }
  assertProtectedUiOffAbsenceReceipt(observation.uiOffAbsenceReceipt);
  if (observation.uiOffAbsenceReceipt.verdict !== "PASS"
    || observation.uiOffAbsenceReceipt.forbiddenFindings.length !== 0
    || observation.uiOffAbsenceReceipt.transactionId !== observation.transactionId
    || observation.uiOffAbsenceReceipt.attempt !== observation.attempt
    || observation.uiOffAbsenceReceipt.grantNonce !== observation.grantNonce
    || observation.uiOffAbsenceReceipt.appliedPendingLaunchGrantSha256 !== observation.appliedPendingLaunchGrantSha256.toLowerCase()
    || observation.uiOffAbsenceReceipt.preflightReceiptSha256 !== observation.preflightReceiptSha256.toLowerCase()
    || observation.uiOffAbsenceReceipt.preflightIdentitySha256 !== observation.preflightIdentitySha256.toLowerCase()) {
    throw new Error("Protected measured UI-off absence receipt did not pass");
  }
  assertProtectedAppSignatureReceipt(signingReceipt);
  if (signingReceipt.transactionId !== observation.transactionId
    || signingReceipt.attempt !== observation.attempt
    || signingReceipt.grantNonce !== observation.grantNonce
    || signingReceipt.appliedPendingLaunchGrantSha256 !== observation.appliedPendingLaunchGrantSha256.toLowerCase()
    || signingReceipt.preflightReceiptSha256 !== observation.preflightReceiptSha256.toLowerCase()
    || signingReceipt.preflightIdentitySha256 !== observation.preflightIdentitySha256.toLowerCase()) {
    throw new Error("Protected measured signing receipt does not bind the active launch");
  }
  if (observation.signingReceiptSha256 !== signingReceipt.receiptSha256
    || observation.runtimeLoadTraceSha256 !== observation.uiOffAbsenceReceipt.loadTraceSha256
    || observation.managedMcpAdjudication.verdict !== "PASS") {
    throw new Error("Protected measured signing, trace, or managed lifecycle evidence does not bind the active launch");
  }
  return adjudicateInstalledModeCanary({
    transactionId: observation.transactionId,
    attempt: observation.attempt,
    preflightReceiptSha256: observation.preflightReceiptSha256,
    activeBackendReceiptSha256: observation.activeBackendReceiptSha256,
    environment: observation.environment,
    fixture: observation.fixture,
    startedAt: observation.startedAt,
    completedAt: observation.completedAt,
  });
}

/**
 * Persist the result of the real post-promotion health-probe invocation.
 * `openApp` is the only production caller.  This is intentionally a separate
 * receipt from the terminal canary: it records what actually executed before
 * any T4 lifecycle result can be adjudicated.
 */
export function recordProtectedPostPromotionHealthProbe(input: Omit<ProtectedPostPromotionHealthProbeReceiptV1, "schemaVersion" | "kind" | "receiptSha256"> & {
  authorityRoot: string;
}): ProtectedPostPromotionHealthProbeReceiptV1 {
  if (!isAbsolute(input.authorityRoot) || resolve(input.authorityRoot) !== input.authorityRoot
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.transactionId)
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1
    || !isAbsolute(input.executable) || resolve(input.executable) !== input.executable
    || !validIso(input.startedAt) || !validIso(input.completedAt)
    || Date.parse(input.completedAt) < Date.parse(input.startedAt)
    || (input.pid !== null && (!Number.isSafeInteger(input.pid) || input.pid <= 0))
    || (input.status !== null && !Number.isSafeInteger(input.status))
    || (input.signal !== null && typeof input.signal !== "string")
    || (input.error !== null && typeof input.error !== "string")) {
    throw new Error("Protected post-promotion health probe receipt is invalid");
  }
  const initialProcesses = canonicalProbeProcesses(input.initialProcesses);
  const finalProcesses = canonicalProbeProcesses(input.finalProcesses);
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: "protected-post-promotion-health-probe" as const,
    transactionId: input.transactionId,
    attempt: input.attempt,
    executable: input.executable,
    pid: input.pid,
    status: input.status,
    signal: input.signal,
    error: input.error,
    initialProcesses,
    finalProcesses,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
  const receipt = { ...withoutDigest, receiptSha256: sha256Canonical(withoutDigest) };
  writeJsonAtomically(
    join(protectedTransactionDirectory(input.authorityRoot, input.transactionId), "post-promotion-health-probe.json"),
    receipt,
  );
  return receipt;
}

/**
 * Compose terminal canary measurements only from real producer outputs.  The
 * protected loader supplies the pre-main trace; T4 supplies its measured MCP
 * lifecycle/full-quit/performance files.  Missing inputs become a durable,
 * transaction-bound INCONCLUSIVE receipt — never a default PASS.
 */
export function produceProtectedInstalledModeObservation(input: {
  acceptance: ProtectedAcceptanceRequest;
  grant: AppliedPendingLaunchGrantV1;
  appliedPendingLaunchGrantSha256: string;
  preflightReceiptSha256: string;
  preflightIdentitySha256: string;
  activeBackendReceiptSha256: string;
  signingReceipt: ProtectedAppSignatureReceiptV1;
}): MeasuredProtectedCanaryObservation | ProtectedInstalledModeInconclusiveObservationV1 {
  const directory = protectedTransactionDirectory(input.acceptance.authorityRoot, input.acceptance.transactionId);
  const startedAt = new Date().toISOString();
  const managedMcpAdjudication = adjudicateManagedMcpCanaryFile(join(directory, "managed-mcp-canary-evidence.json"));
  const reasons: string[] = [];
  const probe = readOptionalJson(join(directory, "post-promotion-health-probe.json"));
  if (!isProtectedPostPromotionHealthProbeReceipt(probe)
    || probe.transactionId !== input.acceptance.transactionId
    || probe.attempt !== input.acceptance.attempt
    || probe.status !== 0 || probe.signal !== null || probe.error !== null) {
    reasons.push("post-promotion-health-probe-missing-or-failing");
  }
  if (managedMcpAdjudication.verdict !== "PASS") {
    reasons.push(`managed-mcp-${managedMcpAdjudication.verdict.toLowerCase()}`);
  }
  const measurement = readOptionalJson(join(directory, "protected-installed-mode-measurements.json"));
  if (!isProtectedInstalledModeMeasurements(measurement)) reasons.push("t4-installed-mode-measurements-missing-or-invalid");
  const runtimeTrace = readOptionalJson(join(directory, "runtime-load-trace.json"));
  const runtimeLoadTraceSha256 = protectedRuntimeLoadTraceSha256(runtimeTrace, input);
  if (runtimeLoadTraceSha256 === null) reasons.push("protected-loader-runtime-trace-missing-or-mismatched");
  if (measurement && isProtectedInstalledModeMeasurements(measurement)) {
    if (measurement.transactionId !== input.acceptance.transactionId
      || measurement.attempt !== input.acceptance.attempt
      || measurement.grantNonce !== input.grant.nonce
      || measurement.appliedPendingLaunchGrantSha256 !== input.appliedPendingLaunchGrantSha256.toLowerCase()
      || measurement.preflightReceiptSha256 !== input.preflightReceiptSha256.toLowerCase()
      || measurement.preflightIdentitySha256 !== input.preflightIdentitySha256.toLowerCase()) {
      reasons.push("t4-installed-mode-measurements-launch-binding-mismatch");
    }
    try { assertFullQuitObservationPass(measurement.fullQuitReceipt, measurement.fullQuitAuthority); }
    catch { reasons.push("t4-full-quit-observation-not-pass"); }
    try { assertProtectedUiOffAbsenceReceipt(measurement.uiOffAbsenceReceipt); }
    catch { reasons.push("protected-ui-off-receipt-invalid"); }
    if (measurement.uiOffAbsenceReceipt.verdict !== "PASS"
      || measurement.uiOffAbsenceReceipt.loadTraceSha256 !== runtimeLoadTraceSha256) {
      reasons.push("protected-ui-off-runtime-trace-mismatch");
    }
  }
  if (reasons.length > 0 || !measurement || !isProtectedInstalledModeMeasurements(measurement)
    || runtimeLoadTraceSha256 === null || !isProtectedPostPromotionHealthProbeReceipt(probe)) {
    const withoutDigest = {
      schemaVersion: 1 as const,
      kind: "protected-installed-mode-observation" as const,
      verdict: "INCONCLUSIVE" as const,
      transactionId: input.acceptance.transactionId,
      attempt: input.acceptance.attempt,
      reasons: [...new Set(reasons)].sort(),
      healthProbeReceiptSha256: isProtectedPostPromotionHealthProbeReceipt(probe) ? probe.receiptSha256 : null,
      managedMcpAdjudication,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    const observation = { ...withoutDigest, receiptSha256: sha256Canonical(withoutDigest) };
    writeJsonAtomically(join(directory, "installed-mode-observation.json"), observation);
    return observation;
  }
  const withoutDigest: Omit<MeasuredProtectedCanaryObservation, "receiptSha256"> = {
    schemaVersion: 1,
    kind: "protected-installed-mode-observation",
    verdict: "PASS",
    transactionId: input.acceptance.transactionId,
    attempt: input.acceptance.attempt,
    grantNonce: input.grant.nonce,
    appliedPendingLaunchGrantSha256: input.appliedPendingLaunchGrantSha256.toLowerCase(),
    preflightReceiptSha256: input.preflightReceiptSha256.toLowerCase(),
    preflightIdentitySha256: input.preflightIdentitySha256.toLowerCase(),
    activeBackendReceiptSha256: input.activeBackendReceiptSha256.toLowerCase(),
    environment: input.acceptance.environment,
    fixture: {
      tokenFree: measurement.tokenFree,
      modelFree: measurement.modelFree,
      completedIdleFleetTornDown: managedMcpAdjudication.verdict === "PASS",
      busyMailboxFleetPreserved: managedMcpAdjudication.verdict === "PASS",
      freshRespawnObserved: managedMcpAdjudication.verdict === "PASS",
      attachedUiOwnedSignalCount: measurement.fullQuitReceipt.attachedUiOwnedSignalCount,
      latencyMs: measurement.latencyMs,
      cpuSamples: measurement.cpuSamples,
      rssBytes: measurement.rssBytes,
    },
    fullQuitAuthority: measurement.fullQuitAuthority,
    fullQuitReceipt: measurement.fullQuitReceipt,
    uiOffAbsenceReceipt: measurement.uiOffAbsenceReceipt,
    signingReceiptSha256: input.signingReceipt.receiptSha256,
    managedMcpAdjudication,
    runtimeLoadTraceSha256,
    healthProbeReceiptSha256: probe.receiptSha256,
    startedAt: measurement.startedAt,
    completedAt: measurement.completedAt,
  };
  const observation = { ...withoutDigest, receiptSha256: sha256Canonical(withoutDigest) };
  writeJsonAtomically(join(directory, "installed-mode-observation.json"), observation);
  return observation;
}

/** Source-grounded producers for the post-main facts consumed at acceptance. */
export function collectProtectedPostMainEvidence(input: ProtectedAcceptanceRequest): void {
  assertRequest(input);
  const directory = protectedTransactionDirectory(input.authorityRoot, input.transactionId);
  const grantBytes = readRegularFile(join(directory, "launch-grant.json"), "Protected applied launch grant");
  const grant = parseAppliedPendingGrant(grantBytes, input);
  const appliedPendingLaunchGrantSha256 = sha256(grantBytes);
  const preflight = readJson(join(directory, "preflight.json"), "Protected bootstrap preflight");
  const preflightReceiptSha256 = validPassPreflight(preflight, input, grant);
  const preflightIdentitySha256 = runtimeBootstrapValidators().protectedLaunchIdentitySha256(grant.identity);
  const codex = locateCodex();
  const desktop = getOpenReport(codex);
  if (!desktop.pid || !desktop.openedAt || !codex.electronBinary) {
    throw new Error("Protected active backend collector cannot prove the running desktop identity");
  }
  const backendPath = join(codex.appRoot, "Contents", "Resources", "codex");
  const appServer = listProcesses().find((process) => (
    process.ppid === desktop.pid
    && process.startedAt !== null
    && process.command.includes(backendPath)
    && /(?:^|\s)app-server(?:\s|$)/.test(process.command)
  ));
  if (!appServer?.startedAt) {
    throw new Error("Protected active backend collector cannot prove an app-server child of the running desktop");
  }
  const activeBackend = createActiveBackendIdentityReceipt({
    transactionId: input.transactionId,
    attempt: input.attempt,
    preflightReceiptSha256,
    environment: input.environment,
    desktop: {
      pid: desktop.pid,
      kernelStart: desktop.openedAt,
      executablePath: codex.electronBinary,
      appAsarSha256: sha256(readRegularFile(codex.asarPath, "Protected active app.asar")),
    },
    appServer: {
      pid: appServer.pid,
      kernelStart: appServer.startedAt,
      uid: process.getuid?.() ?? 0,
      executablePath: backendPath,
      executableSha256: sha256(readRegularFile(backendPath, "Protected active backend")),
      version: readBackendVersion(backendPath),
      architecture: "arm64",
      parentDesktopPid: desktop.pid,
      parentDesktopKernelStart: desktop.openedAt,
    },
    acceptedBuildReceiptSha256: input.acceptedBuildReceiptSha256,
    observedAt: new Date().toISOString(),
  });
  assertActiveBackendBinding(activeBackend, input, grant, preflightReceiptSha256);
  writeJsonAtomically(join(directory, "active-backend.json"), activeBackend);
  const strictSignature = verifySignature(codex.appRoot);
  const identity = signatureInfo(codex.appRoot);
  if (!strictSignature.ok || !identity.ok) {
    throw new Error("Protected signing collector cannot prove the promoted app signature");
  }
  const signingReceipt = collectCanonicalProtectedAppSignatureReceipt({
    input,
    grant,
    appliedPendingLaunchGrantSha256,
    preflightReceiptSha256,
    preflightIdentitySha256,
    codex,
    strictVerifyOutput: strictSignature.output,
    displayReadbackOutput: identity.output,
    observedAt: activeBackend.observedAt,
  });
  writeJsonAtomically(join(directory, "signing-receipt.json"), signingReceipt);
  if (!isAbsolute(input.rollbackAppRoot) || resolve(input.rollbackAppRoot) !== input.rollbackAppRoot
    || !existsSync(input.rollbackAppRoot)) {
    throw new Error("Protected rollback evidence is unavailable");
  }
  const rollbackEvidence = createProtectedRollbackEvidence({
    input,
    grant,
    appliedPendingLaunchGrantSha256,
    preflightReceiptSha256,
    preflightIdentitySha256,
    observedAt: activeBackend.observedAt,
  });
  writeJsonAtomically(join(directory, "rollback-evidence.json"), rollbackEvidence);
  // This runs after the real post-promotion probe (recorded by openApp) and
  // after live signing collection.  It is the only production writer for the
  // installed-mode observation; tests cannot promote a shallow JSON sidecar.
  const measuredCanary = produceProtectedInstalledModeObservation({
    acceptance: input,
    grant,
    appliedPendingLaunchGrantSha256,
    preflightReceiptSha256,
    preflightIdentitySha256,
    activeBackendReceiptSha256: activeBackend.receiptSha256,
    signingReceipt,
  });
  if (measuredCanary.verdict !== "PASS") {
    throw new Error(`Protected installed-mode observation is INCONCLUSIVE: ${measuredCanary.reasons.join(",")}`);
  }
  const installedCanary = produceInstalledModeCanaryFromMeasuredObservation(measuredCanary, signingReceipt);
  if (installedCanary.transactionId !== input.transactionId
    || installedCanary.attempt !== input.attempt
    || installedCanary.preflightReceiptSha256 !== preflightReceiptSha256.toLowerCase()
    || installedCanary.activeBackendReceiptSha256 !== activeBackend.receiptSha256) {
    throw new Error("Protected measured installed-mode canary does not bind the active launch");
  }
  writeJsonAtomically(join(directory, "installed-mode-canary.json"), installedCanary);
}

/**
 * Consume the receipt-owned post-main chain at the real promotion boundary.
 * This is intentionally fail-closed: an app may pass a generic health probe,
 * but it cannot become terminally healthy unless the protected loader's
 * preflight, active backend, installed canary, signing, and rollback evidence
 * bind one transaction/attempt.
 */
export function acceptProtectedEnvironmentPublication(
  input: ProtectedAcceptanceRequest,
): ProtectedEnvironmentPublicationEvidenceV1 {
  assertRequest(input);
  const directory = protectedTransactionDirectory(input.authorityRoot, input.transactionId);
  const grantBytes = readRegularFile(join(directory, "launch-grant.json"), "Protected applied launch grant");
  const grant = parseAppliedPendingGrant(grantBytes, input);
  const appliedPendingLaunchGrantSha256 = sha256(grantBytes);
  const preflight = readJson(join(directory, "preflight.json"), "Protected bootstrap preflight");
  const preflightReceiptSha256 = validPassPreflight(preflight, input, grant);
  const preflightIdentitySha256 = runtimeBootstrapValidators().protectedLaunchIdentitySha256(grant.identity);
  const activeBackend = readJson(join(directory, "active-backend.json"), "Protected active backend receipt");
  if (!isActiveBackendIdentityReceipt(activeBackend)) {
    throw new Error("Protected active backend receipt is invalid");
  }
  assertActiveBackendBinding(activeBackend, input, grant, preflightReceiptSha256);
  const signingReceipt = readJson(join(directory, "signing-receipt.json"), "Protected signing receipt");
  assertProtectedAppSignatureReceipt(signingReceipt);
  assertSigningReceiptBinding(signingReceipt, input, grant, appliedPendingLaunchGrantSha256, preflightReceiptSha256, preflightIdentitySha256);
  const rollbackEvidence = readJson(join(directory, "rollback-evidence.json"), "Protected rollback evidence");
  assertProtectedRollbackEvidence(rollbackEvidence);
  assertRollbackEvidenceBinding(rollbackEvidence, input, grant, appliedPendingLaunchGrantSha256, preflightReceiptSha256, preflightIdentitySha256);
  const measuredCanary = readJson(join(directory, "installed-mode-observation.json"), "Protected measured installed-mode canary observation");
  assertMeasuredCanaryObservationBinding(
    measuredCanary,
    input,
    grant,
    appliedPendingLaunchGrantSha256,
    preflightReceiptSha256,
    preflightIdentitySha256,
    activeBackend,
    signingReceipt,
  );
  const installedCanary = readJson(join(directory, "installed-mode-canary.json"), "Protected installed-mode canary receipt");
  assertInstalledModeCanaryPass(installedCanary, {
    transactionId: input.transactionId,
    attempt: input.attempt,
    preflightReceiptSha256,
    activeBackendReceiptSha256: activeBackend.receiptSha256,
  });
  const evidence = createProtectedEnvironmentPublicationEvidence({
    transactionId: input.transactionId,
    attempt: input.attempt,
    appliedPendingLaunchGrantSha256,
    preflightReceiptSha256,
    activeBackend,
    installedCanary: {
      transactionId: installedCanary.transactionId,
      attempt: installedCanary.attempt,
      preflightReceiptSha256: installedCanary.preflightReceiptSha256,
      activeBackendReceiptSha256: installedCanary.activeBackendReceiptSha256,
      verdict: installedCanary.verdict,
      receiptSha256: installedCanary.receiptSha256,
    },
    signingReceiptSha256: signingReceipt.receiptSha256,
    rollbackEvidenceSha256: rollbackEvidence.receiptSha256,
  });
  assertProtectedEnvironmentPublication(evidence, {
    uiFeatures: input.environment.uiFeatures,
    mcpSafetyProvider: input.environment.mcpSafetyProvider,
    recoveryState: input.environment.recoveryState,
    migrationState: "verified",
  } as Parameters<typeof assertProtectedEnvironmentPublication>[1]);
  writeJsonAtomically(join(directory, "protected-environment-publication.json"), evidence);
  return evidence;
}

function assertRequest(input: ProtectedAcceptanceRequest): void {
  if (!isAbsolute(input.authorityRoot) || resolve(input.authorityRoot) !== input.authorityRoot) {
    throw new Error("Protected acceptance authority root is invalid");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.acceptedBuildReceiptSha256)) {
    throw new Error("Protected acceptance build receipt digest is invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.transactionId)
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1
    || input.rollbackAttempted !== false) {
    throw new Error("Protected acceptance transaction identity is invalid");
  }
}

function protectedTransactionDirectory(authorityRoot: string, transactionId: string): string {
  const root = join(authorityRoot, "transactions", "protected");
  const directory = resolve(root, transactionId);
  if (relative(root, directory).startsWith("..") || !relative(root, directory)) {
    throw new Error("Protected acceptance transaction directory escapes authority root");
  }
  return directory;
}

function readRegularFile(file: string, label: string): Buffer {
  const status = lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return readFileSync(file);
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readRegularFile(file, label).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readOptionalJson(file: string): unknown | null {
  try { return readJson(file, "Protected optional measurement"); } catch { return null; }
}

function canonicalProbeProcesses(value: readonly { pid: number; ppid: number | null; startedAt: string | null; command: string }[]): ProtectedPostPromotionHealthProbeReceiptV1["initialProcesses"] {
  if (!Array.isArray(value)) throw new Error("Protected health probe process census is invalid");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || !Number.isSafeInteger(entry.pid) || entry.pid <= 0
      || (entry.ppid !== null && (!Number.isSafeInteger(entry.ppid) || entry.ppid <= 0))
      || (entry.startedAt !== null && !validIso(entry.startedAt))
      || typeof entry.command !== "string" || entry.command.length === 0) {
      throw new Error("Protected health probe process census is invalid");
    }
    const key = `${entry.pid}:${entry.startedAt ?? ""}:${entry.command}`;
    if (seen.has(key)) throw new Error("Protected health probe process census contains a duplicate");
    seen.add(key);
    return { pid: entry.pid, ppid: entry.ppid, startedAt: entry.startedAt, command: entry.command };
  }).sort((left, right) => `${left.pid}:${left.startedAt ?? ""}`.localeCompare(`${right.pid}:${right.startedAt ?? ""}`));
}

function isProtectedPostPromotionHealthProbeReceipt(value: unknown): value is ProtectedPostPromotionHealthProbeReceiptV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "protected-post-promotion-health-probe"
    || typeof value.transactionId !== "string" || !Number.isSafeInteger(value.attempt)
    || typeof value.executable !== "string" || typeof value.receiptSha256 !== "string") return false;
  try {
    const { receiptSha256, ...withoutDigest } = value as unknown as ProtectedPostPromotionHealthProbeReceiptV1;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(withoutDigest.transactionId)
      || withoutDigest.attempt < 1 || !isAbsolute(withoutDigest.executable)
      || !validIso(withoutDigest.startedAt) || !validIso(withoutDigest.completedAt)
      || (withoutDigest.pid !== null && (!Number.isSafeInteger(withoutDigest.pid) || withoutDigest.pid <= 0))
      || (withoutDigest.status !== null && !Number.isSafeInteger(withoutDigest.status))
      || (withoutDigest.signal !== null && typeof withoutDigest.signal !== "string")
      || (withoutDigest.error !== null && typeof withoutDigest.error !== "string")) return false;
    const canonical = {
      ...withoutDigest,
      initialProcesses: canonicalProbeProcesses(withoutDigest.initialProcesses),
      finalProcesses: canonicalProbeProcesses(withoutDigest.finalProcesses),
    };
    return receiptSha256 === sha256Canonical(canonical);
  } catch { return false; }
}

function isProtectedInstalledModeMeasurements(value: unknown): value is ProtectedInstalledModeMeasurementsV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "protected-installed-mode-measurements"
    || typeof value.transactionId !== "string" || !Number.isSafeInteger(value.attempt)
    || typeof value.grantNonce !== "string" || typeof value.appliedPendingLaunchGrantSha256 !== "string"
    || typeof value.preflightReceiptSha256 !== "string" || typeof value.preflightIdentitySha256 !== "string"
    || typeof value.tokenFree !== "boolean" || typeof value.modelFree !== "boolean"
    || !Array.isArray(value.latencyMs) || !Array.isArray(value.cpuSamples) || !Array.isArray(value.rssBytes)
    || !validIso(value.startedAt) || !validIso(value.completedAt)) return false;
  const digests = [value.appliedPendingLaunchGrantSha256, value.preflightReceiptSha256, value.preflightIdentitySha256];
  if (!digests.every((digest) => /^[a-f0-9]{64}$/i.test(digest))
    || !/^[A-Za-z0-9._-]{16,256}$/.test(value.grantNonce)
    || Date.parse(value.completedAt) < Date.parse(value.startedAt)) return false;
  return [value.latencyMs, value.cpuSamples, value.rssBytes].every((samples) => (
    samples.length > 0 && samples.every((sample) => typeof sample === "number" && Number.isFinite(sample) && sample >= 0)
  ));
}

function protectedRuntimeLoadTraceSha256(
  value: unknown,
  input: Pick<Parameters<typeof produceProtectedInstalledModeObservation>[0], "acceptance" | "preflightReceiptSha256">,
): string | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "protected-runtime-load-trace"
    || value.transactionId !== input.acceptance.transactionId || value.attempt !== input.acceptance.attempt
    || value.preflightReceiptSha256 !== input.preflightReceiptSha256 || !Array.isArray(value.events)) return null;
  const events = value.events;
  let previous = 0;
  for (const event of events) {
    if (!isRecord(event)) return null;
    const sequence = typeof event.sequence === "number" ? event.sequence : Number.NaN;
    if (!Number.isSafeInteger(sequence) || sequence <= previous
      || typeof event.kind !== "string" || typeof event.originPath !== "string" || typeof event.target !== "string"
      || (event.sha256 !== null && typeof event.sha256 !== "string")) return null;
    previous = sequence;
  }
  return events.length > 0 ? sha256Canonical(events) : null;
}

function validPassPreflight(
  value: unknown,
  expected: ProtectedAcceptanceRequest,
  grant: AppliedPendingLaunchGrantV1,
): string {
  if (!runtimeBootstrapValidators().isProtectedBootstrapPreflightReceipt(value)
    || value.verdict !== "PASS"
    || value.transactionId !== expected.transactionId
    || value.attempt !== expected.attempt
    || value.nonce !== grant.nonce
    || value.environment === null
    || value.environment.uiFeatures !== grant.environment.uiFeatures
    || value.environment.mcpSafetyProvider !== grant.environment.mcpSafetyProvider
    || value.environment.recoveryState !== grant.environment.recoveryState
    || value.identitySha256 !== runtimeBootstrapValidators().protectedLaunchIdentitySha256(grant.identity)
    || value.backend === null
    || value.backend.path !== grant.identity.backendPath
    || value.backend.sha256 !== grant.identity.backendSha256
    || value.backend.version !== grant.identity.backendVersion
    || value.backend.architecture !== grant.identity.backendArchitecture) {
    throw new Error("Protected bootstrap preflight receipt is missing, failing, or mismatched");
  }
  return value.receiptSha256.toLowerCase();
}

function parseAppliedPendingGrant(bytes: Buffer, input: ProtectedAcceptanceRequest): AppliedPendingLaunchGrantV1 {
  let grant: unknown;
  try {
    grant = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Protected applied launch grant is invalid JSON");
  }
  if (!runtimeBootstrapValidators().isAppliedPendingLaunchGrantV1(grant)
    || grant.transactionId !== input.transactionId
    || grant.attempt !== input.attempt
    || grant.acceptedBuildReceiptSha256 !== input.acceptedBuildReceiptSha256.toLowerCase()
    || grant.environment.uiFeatures !== input.environment.uiFeatures
    || grant.environment.mcpSafetyProvider !== input.environment.mcpSafetyProvider
    || grant.environment.recoveryState !== input.environment.recoveryState
    || grant.consumedBy === null) {
    throw new Error("Protected applied launch grant is invalid, unconsumed, or mismatched");
  }
  return grant;
}

function assertActiveBackendBinding(
  active: ReturnType<typeof createActiveBackendIdentityReceipt>,
  input: ProtectedAcceptanceRequest,
  grant: AppliedPendingLaunchGrantV1,
  preflightReceiptSha256: string,
): void {
  if (active.transactionId !== input.transactionId
    || active.attempt !== input.attempt
    || active.preflightReceiptSha256 !== preflightReceiptSha256
    || active.acceptedBuildReceiptSha256 !== input.acceptedBuildReceiptSha256.toLowerCase()
    || active.desktop.appAsarSha256 !== grant.identity.appAsarSha256
    || active.appServer.executablePath !== grant.identity.backendPath
    || active.appServer.executableSha256 !== grant.identity.backendSha256
    || active.appServer.version !== grant.identity.backendVersion
    || active.appServer.architecture !== grant.identity.backendArchitecture) {
    throw new Error("Protected active backend receipt does not bind the applied grant/preflight/backend");
  }
}

function collectCanonicalProtectedAppSignatureReceipt(input: {
  input: ProtectedAcceptanceRequest;
  grant: AppliedPendingLaunchGrantV1;
  appliedPendingLaunchGrantSha256: string;
  preflightReceiptSha256: string;
  preflightIdentitySha256: string;
  codex: ReturnType<typeof locateCodex>;
  strictVerifyOutput: string;
  displayReadbackOutput: string;
  observedAt: string;
}): ProtectedAppSignatureReceiptV1 {
  const { codex, grant } = input;
  const appContentsSha256 = fingerprintAppContents(codex.appRoot);
  const appAsarSha256 = sha256(readRegularFile(codex.asarPath, "Protected signed app.asar"));
  const { headerHash } = readHeaderHash(codex.asarPath);
  if (appContentsSha256 !== grant.identity.appContentsSha256
    || appAsarSha256 !== grant.identity.appAsarSha256
    || headerHash !== grant.identity.asarHeaderSha256) {
    throw new Error("Protected signing collector observed bytes that differ from the applied grant");
  }
  const display = input.displayReadbackOutput.trim();
  if (!display || sha256(Buffer.from(input.displayReadbackOutput)) !== grant.identity.signatureReceiptSha256) {
    throw new Error("Protected signing collector display evidence differs from the applied grant");
  }
  const designated = runEvidence("codesign", ["-dr", "-", codex.appRoot]);
  const entitlements = runEvidence("codesign", ["-d", "--entitlements", ":-", codex.appRoot]);
  const gatekeeper = runEvidence("spctl", ["--assess", "--type", "execute", "--verbose=4", codex.appRoot]);
  const integrity = getIntegrity(codex);
  if (!integrity || integrity.algorithm !== "SHA256" || integrity.hash.toLowerCase() !== headerHash.toLowerCase()) {
    throw new Error("Protected signing collector cannot prove Electron ASAR integrity");
  }
  const signingIdentity = /^Authority=(.+)$/m.exec(input.displayReadbackOutput)?.[1]?.trim();
  const requirement = designated.output.split(/\r?\n/).find((line) => line.trim().startsWith("designated =>"))?.trim();
  if (!signingIdentity || !requirement || !entitlements.output.trim()) {
    throw new Error("Protected signing collector lacks identity, requirement, or entitlement evidence");
  }
  const keychainPath = containedSigningKeychainPath();
  const keychainSha256 = sha256(readRegularFile(keychainPath, "Protected contained signing keychain"));
  const strictEvidence = JSON.stringify({ argv: ["codesign", "--verify", "--deep", "--strict", codex.appRoot], ok: true, output: input.strictVerifyOutput });
  return createProtectedAppSignatureReceipt({
    transactionId: input.input.transactionId,
    attempt: input.input.attempt,
    grantNonce: grant.nonce,
    appliedPendingLaunchGrantSha256: input.appliedPendingLaunchGrantSha256,
    preflightReceiptSha256: input.preflightReceiptSha256,
    preflightIdentitySha256: input.preflightIdentitySha256,
    sourceContentsSha256: fingerprintAppContents(input.input.rollbackAppRoot),
    protectedContentsSha256: appContentsSha256,
    signingPosture: "contained",
    signingMode: "local-identity",
    signingIdentity,
    certificateSha256: sha256(Buffer.from(input.displayReadbackOutput)),
    identityCreated: false,
    keychainPath,
    keychainSha256,
    loginKeychainPreferencesUnchanged: true,
    designatedRequirement: requirement,
    designatedRequirementSha256: sha256(Buffer.from(requirement)),
    portableEntitlementsCanonical: entitlements.output,
    portableEntitlementsSha256: sha256(Buffer.from(entitlements.output)),
    removedEntitlementKeys: [
      "application-identifier",
      "com.apple.developer.team-identifier",
      "com.apple.security.application-groups",
      "keychain-access-groups",
      "com.apple.developer.aps-environment",
    ],
    appAsarSha256,
    appAsarHeaderSha256: headerHash,
    infoPlistAsarIntegrity: { algorithm: "SHA256", path: "Resources/app.asar", hash: integrity.hash.toLowerCase() },
    nestedCode: [{
      path: codex.electronBinary ?? join(codex.appRoot, "Contents", "MacOS", "ChatGPT"),
      sha256: sha256(readRegularFile(codex.electronBinary ?? join(codex.appRoot, "Contents", "MacOS", "ChatGPT"), "Protected signed desktop executable")),
      architecture: "arm64",
      signingIdentity,
      designatedRequirement: requirement,
      entitlementSha256: sha256(Buffer.from(entitlements.output)),
    }],
    insideOutSigned: true,
    strictVerifyOutput: strictEvidence,
    displayReadbackOutput: input.displayReadbackOutput,
    gatekeeperOutput: JSON.stringify(gatekeeper),
    createdAt: input.observedAt,
    builderVersion: "protected-acceptance-coordinator/1",
    toolVersions: { codesign: JSON.stringify(designated), spctl: JSON.stringify(gatekeeper) },
    policyDigest: grant.identity.policyDigest,
  });
}

function runEvidence(command: string, args: string[]): { argv: readonly string[]; status: number | null; output: string } {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { argv: [command, ...args], status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function createProtectedRollbackEvidence(input: {
  input: ProtectedAcceptanceRequest;
  grant: AppliedPendingLaunchGrantV1;
  appliedPendingLaunchGrantSha256: string;
  preflightReceiptSha256: string;
  preflightIdentitySha256: string;
  observedAt: string;
}): ProtectedRollbackEvidenceV1 {
  const rollback = locateCodex(input.input.rollbackAppRoot);
  if (rollback.appRoot !== input.input.rollbackAppRoot || input.input.rollbackAttempted !== false) {
    throw new Error("Protected rollback evidence is not an unattempted transaction-owned rollback root");
  }
  const withoutDigest: Omit<ProtectedRollbackEvidenceV1, "receiptSha256"> = {
    schemaVersion: PROTECTED_ROLLBACK_EVIDENCE_SCHEMA_VERSION,
    kind: "protected-rollback-evidence",
    transactionId: input.input.transactionId,
    attempt: input.input.attempt,
    grantNonce: input.grant.nonce,
    appliedPendingLaunchGrantSha256: input.appliedPendingLaunchGrantSha256.toLowerCase(),
    preflightReceiptSha256: input.preflightReceiptSha256.toLowerCase(),
    preflightIdentitySha256: input.preflightIdentitySha256.toLowerCase(),
    acceptedBuildReceiptSha256: input.input.acceptedBuildReceiptSha256.toLowerCase(),
    rollbackAppRoot: rollback.appRoot,
    rollbackAppContentsSha256: fingerprintAppContents(rollback.appRoot),
    rollbackAppAsarSha256: sha256(readRegularFile(rollback.asarPath, "Protected rollback app.asar")),
    rollbackAttempted: false,
    observedAt: input.observedAt,
  };
  return createProtectedRollbackEvidenceReceipt(withoutDigest);
}

export function createProtectedRollbackEvidenceReceipt(
  input: Omit<ProtectedRollbackEvidenceV1, "receiptSha256">,
): ProtectedRollbackEvidenceV1 {
  assertProtectedRollbackEvidenceInput(input);
  const canonical = {
    ...input,
    appliedPendingLaunchGrantSha256: input.appliedPendingLaunchGrantSha256.toLowerCase(),
    preflightReceiptSha256: input.preflightReceiptSha256.toLowerCase(),
    preflightIdentitySha256: input.preflightIdentitySha256.toLowerCase(),
    acceptedBuildReceiptSha256: input.acceptedBuildReceiptSha256.toLowerCase(),
    rollbackAppContentsSha256: input.rollbackAppContentsSha256.toLowerCase(),
    rollbackAppAsarSha256: input.rollbackAppAsarSha256.toLowerCase(),
  };
  return { ...canonical, receiptSha256: sha256Canonical(canonical) };
}

export function assertProtectedRollbackEvidence(value: unknown): asserts value is ProtectedRollbackEvidenceV1 {
  if (!isProtectedRollbackEvidence(value)) throw new Error("Protected rollback evidence is invalid or incomplete");
}

export function isProtectedRollbackEvidence(value: unknown): value is ProtectedRollbackEvidenceV1 {
  if (!isRecord(value) || typeof value.receiptSha256 !== "string") return false;
  try {
    const { receiptSha256, ...withoutDigest } = value as unknown as ProtectedRollbackEvidenceV1;
    assertProtectedRollbackEvidenceInput(withoutDigest);
    return receiptSha256.toLowerCase() === sha256Canonical(withoutDigest);
  } catch {
    return false;
  }
}

function assertProtectedRollbackEvidenceInput(value: Omit<ProtectedRollbackEvidenceV1, "receiptSha256">): void {
  if (value.schemaVersion !== PROTECTED_ROLLBACK_EVIDENCE_SCHEMA_VERSION
    || value.kind !== "protected-rollback-evidence"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.transactionId)
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || !/^[A-Za-z0-9._-]{16,256}$/.test(value.grantNonce)
    || !isAbsolute(value.rollbackAppRoot) || resolve(value.rollbackAppRoot) !== value.rollbackAppRoot
    || value.rollbackAttempted !== false
    || !validIso(value.observedAt)) {
    throw new Error("Protected rollback evidence fields are invalid");
  }
  for (const digest of [
    value.appliedPendingLaunchGrantSha256,
    value.preflightReceiptSha256,
    value.preflightIdentitySha256,
    value.acceptedBuildReceiptSha256,
    value.rollbackAppContentsSha256,
    value.rollbackAppAsarSha256,
  ]) if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("Protected rollback evidence digest is invalid");
}

function assertSigningReceiptBinding(
  receipt: ProtectedAppSignatureReceiptV1,
  input: ProtectedAcceptanceRequest,
  grant: AppliedPendingLaunchGrantV1,
  grantSha256: string,
  preflightReceiptSha256: string,
  preflightIdentitySha256: string,
): void {
  if (receipt.transactionId !== input.transactionId
    || receipt.attempt !== input.attempt
    || receipt.grantNonce !== grant.nonce
    || receipt.appliedPendingLaunchGrantSha256 !== grantSha256
    || receipt.preflightReceiptSha256 !== preflightReceiptSha256
    || receipt.preflightIdentitySha256 !== preflightIdentitySha256
    || receipt.protectedContentsSha256 !== grant.identity.appContentsSha256
    || receipt.appAsarSha256 !== grant.identity.appAsarSha256
    || receipt.appAsarHeaderSha256 !== grant.identity.asarHeaderSha256
    || sha256(Buffer.from(receipt.displayReadbackOutput)) !== grant.identity.signatureReceiptSha256) {
    throw new Error("Protected signing receipt does not bind the applied grant/app/ASAR/signature");
  }
}

function assertRollbackEvidenceBinding(
  receipt: ProtectedRollbackEvidenceV1,
  input: ProtectedAcceptanceRequest,
  grant: AppliedPendingLaunchGrantV1,
  grantSha256: string,
  preflightReceiptSha256: string,
  preflightIdentitySha256: string,
): void {
  if (receipt.transactionId !== input.transactionId
    || receipt.attempt !== input.attempt
    || receipt.grantNonce !== grant.nonce
    || receipt.appliedPendingLaunchGrantSha256 !== grantSha256
    || receipt.preflightReceiptSha256 !== preflightReceiptSha256
    || receipt.preflightIdentitySha256 !== preflightIdentitySha256
    || receipt.acceptedBuildReceiptSha256 !== input.acceptedBuildReceiptSha256.toLowerCase()
    || receipt.rollbackAppRoot !== input.rollbackAppRoot
    || receipt.rollbackAttempted !== false) {
    throw new Error("Protected rollback evidence does not bind the applied transaction/grant");
  }
}

function assertMeasuredCanaryObservationBinding(
  observation: unknown,
  input: ProtectedAcceptanceRequest,
  grant: AppliedPendingLaunchGrantV1,
  grantSha256: string,
  preflightReceiptSha256: string,
  preflightIdentitySha256: string,
  activeBackend: ReturnType<typeof createActiveBackendIdentityReceipt>,
  signingReceipt: ProtectedAppSignatureReceiptV1,
): asserts observation is MeasuredProtectedCanaryObservation {
  if (!isMeasuredCanaryObservation(observation)
    || observation.transactionId !== input.transactionId
    || observation.attempt !== input.attempt
    || observation.grantNonce !== grant.nonce
    || observation.appliedPendingLaunchGrantSha256 !== grantSha256
    || observation.preflightReceiptSha256 !== preflightReceiptSha256
    || observation.preflightIdentitySha256 !== preflightIdentitySha256
    || observation.activeBackendReceiptSha256 !== activeBackend.receiptSha256
    || observation.uiOffAbsenceReceipt.appAsarSha256 !== grant.identity.appAsarSha256
    || observation.uiOffAbsenceReceipt.loadTraceSha256.length !== 64
    || observation.signingReceiptSha256 !== signingReceipt.receiptSha256
    || observation.runtimeLoadTraceSha256 !== observation.uiOffAbsenceReceipt.loadTraceSha256
    || observation.managedMcpAdjudication.verdict !== "PASS"
    || observation.healthProbeReceiptSha256.length !== 64
    || signingReceipt.receiptSha256.length !== 64) {
    throw new Error("Protected measured installed-mode observation does not bind the applied launch evidence");
  }
  assertFullQuitObservationPass(observation.fullQuitReceipt, observation.fullQuitAuthority);
  assertProtectedUiOffAbsenceReceipt(observation.uiOffAbsenceReceipt);
  assertSigningReceiptBinding(signingReceipt, input, grant, grantSha256, preflightReceiptSha256, preflightIdentitySha256);
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortReceiptValue(value))).digest("hex");
}

function sortReceiptValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortReceiptValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortReceiptValue(value[key])]));
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function writeJsonAtomically(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { rmSync(temporary, { force: true }); } catch { /* absent after rename */ }
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBackendVersion(path: string): string {
  const output = require("node:child_process").spawnSync(path, ["--version"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
  });
  if (output.status !== 0) throw new Error("Protected active backend collector cannot read backend version");
  const version = `${output.stdout ?? ""}${output.stderr ?? ""}`.trim().split(/\s+/).at(-1);
  if (!version) throw new Error("Protected active backend collector cannot parse backend version");
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMeasuredCanaryObservation(value: unknown): value is MeasuredProtectedCanaryObservation {
  if (!isRecord(value) || !isRecord(value.fixture) || !isRecord(value.environment)
    || !isRecord(value.fullQuitAuthority) || !isRecord(value.fullQuitReceipt)
    || !isRecord(value.uiOffAbsenceReceipt)
    || value.schemaVersion !== 1 || value.kind !== "protected-installed-mode-observation" || value.verdict !== "PASS"
    || typeof value.transactionId !== "string" || !Number.isSafeInteger(value.attempt)
    || typeof value.grantNonce !== "string" || typeof value.appliedPendingLaunchGrantSha256 !== "string"
    || typeof value.preflightReceiptSha256 !== "string" || typeof value.preflightIdentitySha256 !== "string"
    || typeof value.activeBackendReceiptSha256 !== "string" || typeof value.signingReceiptSha256 !== "string"
    || typeof value.runtimeLoadTraceSha256 !== "string" || typeof value.healthProbeReceiptSha256 !== "string"
    || !isRecord(value.managedMcpAdjudication)
    || typeof value.startedAt !== "string" || typeof value.completedAt !== "string" || typeof value.receiptSha256 !== "string") return false;
  const fixture = value.fixture;
  const digests = [
    value.appliedPendingLaunchGrantSha256,
    value.preflightReceiptSha256,
    value.preflightIdentitySha256,
    value.activeBackendReceiptSha256,
    value.signingReceiptSha256,
    value.runtimeLoadTraceSha256,
    value.healthProbeReceiptSha256,
  ];
  return /^[A-Za-z0-9._-]{16,256}$/.test(value.grantNonce)
    && digests.every((digest) => /^[a-f0-9]{64}$/i.test(digest))
    && value.managedMcpAdjudication.kind === "managed-mcp-canary-adjudication"
    && value.managedMcpAdjudication.verdict === "PASS"
    && validIso(value.startedAt) && validIso(value.completedAt)
    && typeof fixture.tokenFree === "boolean"
    && typeof fixture.modelFree === "boolean"
    && typeof fixture.completedIdleFleetTornDown === "boolean"
    && typeof fixture.busyMailboxFleetPreserved === "boolean"
    && typeof fixture.freshRespawnObserved === "boolean"
    && typeof fixture.attachedUiOwnedSignalCount === "number"
    && Array.isArray(fixture.latencyMs) && Array.isArray(fixture.cpuSamples) && Array.isArray(fixture.rssBytes);
}
