import { createHash } from "node:crypto";

export const INSTALLED_MODE_CANARY_SCHEMA_VERSION = 1 as const;

export type InstalledModeCanaryVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface InstalledModeCanaryReceiptV1 {
  schemaVersion: typeof INSTALLED_MODE_CANARY_SCHEMA_VERSION;
  kind: "installed-mode-canary";
  transactionId: string;
  attempt: number;
  preflightReceiptSha256: string;
  activeBackendReceiptSha256: string;
  environment: {
    uiFeatures: "off" | "on";
    mcpSafetyProvider: "managed-turn-idle" | "official-bundled-degraded";
    recoveryState: "normal-protected" | "pristine-openai-recovery";
  };
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
  verdict: InstalledModeCanaryVerdict;
  reason: string | null;
  startedAt: string;
  completedAt: string;
  receiptSha256: string;
}

export type InstalledModeCanaryInput = Omit<InstalledModeCanaryReceiptV1, "schemaVersion" | "kind" | "verdict" | "reason" | "receiptSha256">;

/**
 * Adjudicate recorded observations only.  The lifecycle owner runs a fixture;
 * this function neither launches an app nor creates a model/paid workload.
 */
export function adjudicateInstalledModeCanary(input: InstalledModeCanaryInput): InstalledModeCanaryReceiptV1 {
  validateBase(input);
  const failures: string[] = [];
  if (input.environment.recoveryState !== "normal-protected"
    || input.environment.mcpSafetyProvider !== "managed-turn-idle") {
    failures.push("normal-protected-managed-provider-required");
  }
  if (!input.fixture.tokenFree) failures.push("fixture-requires-token");
  if (!input.fixture.modelFree) failures.push("fixture-requires-model");
  if (!input.fixture.completedIdleFleetTornDown) failures.push("completed-idle-teardown-not-observed");
  if (!input.fixture.busyMailboxFleetPreserved) failures.push("busy-mailbox-preservation-not-observed");
  if (!input.fixture.freshRespawnObserved) failures.push("fresh-respawn-not-observed");
  if (input.fixture.attachedUiOwnedSignalCount !== 0) failures.push("attached-ui-owned-signal-observed");
  if (input.fixture.latencyMs.length === 0 || input.fixture.cpuSamples.length === 0 || input.fixture.rssBytes.length === 0) {
    failures.push("performance-samples-missing");
  }
  const verdict: InstalledModeCanaryVerdict = failures.length === 0 ? "PASS" : "FAIL";
  const withoutDigest = {
    schemaVersion: INSTALLED_MODE_CANARY_SCHEMA_VERSION,
    kind: "installed-mode-canary" as const,
    ...input,
    verdict,
    reason: failures.length === 0 ? null : failures.join(","),
  };
  return { ...withoutDigest, receiptSha256: digest(withoutDigest) };
}

export function assertInstalledModeCanaryPass(receipt: unknown, expected: {
  transactionId: string;
  attempt: number;
  preflightReceiptSha256: string;
  activeBackendReceiptSha256: string;
}): asserts receipt is InstalledModeCanaryReceiptV1 {
  if (!isInstalledModeCanaryReceipt(receipt)) {
    throw new Error("Installed mode canary receipt is invalid");
  }
  if (receipt.transactionId !== expected.transactionId || receipt.attempt !== expected.attempt
    || receipt.preflightReceiptSha256 !== expected.preflightReceiptSha256.toLowerCase()
    || receipt.activeBackendReceiptSha256 !== expected.activeBackendReceiptSha256.toLowerCase()) {
    throw new Error("Installed mode canary receipt does not bind the active transaction/preflight/backend");
  }
  if (receipt.verdict !== "PASS") {
    throw new Error(`Installed mode canary did not pass: ${receipt.reason ?? "inconclusive"}`);
  }
}

export function isInstalledModeCanaryReceipt(value: unknown): value is InstalledModeCanaryReceiptV1 {
  if (!isRecord(value) || value.schemaVersion !== INSTALLED_MODE_CANARY_SCHEMA_VERSION
    || value.kind !== "installed-mode-canary"
    || (value.verdict !== "PASS" && value.verdict !== "FAIL" && value.verdict !== "INCONCLUSIVE")
    || (value.reason !== null && typeof value.reason !== "string")) return false;
  try {
    const { schemaVersion: _schemaVersion, kind: _kind, verdict, reason, receiptSha256, ...input } = value as unknown as InstalledModeCanaryReceiptV1;
    validateBase(input);
    const canonical = {
      schemaVersion: INSTALLED_MODE_CANARY_SCHEMA_VERSION,
      kind: "installed-mode-canary",
      ...input,
      verdict,
      reason,
    };
    return typeof receiptSha256 === "string" && receiptSha256 === digest(canonical);
  } catch {
    return false;
  }
}

function validateBase(input: InstalledModeCanaryInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.transactionId)
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Installed mode canary transaction identity is invalid");
  }
  for (const digestValue of [input.preflightReceiptSha256, input.activeBackendReceiptSha256]) {
    if (!/^[a-f0-9]{64}$/i.test(digestValue)) throw new Error("Installed mode canary receipt digest is invalid");
  }
  if (!isRecord(input.environment)
    || (input.environment.uiFeatures !== "off" && input.environment.uiFeatures !== "on")
    || (input.environment.mcpSafetyProvider !== "managed-turn-idle" && input.environment.mcpSafetyProvider !== "official-bundled-degraded")
    || (input.environment.recoveryState !== "normal-protected" && input.environment.recoveryState !== "pristine-openai-recovery")) {
    throw new Error("Installed mode canary environment is invalid");
  }
  const fixture = input.fixture;
  if (!isRecord(fixture) || !Number.isSafeInteger(fixture.attachedUiOwnedSignalCount)
    || fixture.attachedUiOwnedSignalCount < 0
    || !Array.isArray(fixture.latencyMs) || !Array.isArray(fixture.cpuSamples) || !Array.isArray(fixture.rssBytes)) {
    throw new Error("Installed mode canary fixture is invalid");
  }
  for (const values of [fixture.latencyMs, fixture.cpuSamples, fixture.rssBytes]) {
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error("Installed mode canary samples are invalid");
    }
  }
  for (const flag of [
    fixture.tokenFree,
    fixture.modelFree,
    fixture.completedIdleFleetTornDown,
    fixture.busyMailboxFleetPreserved,
    fixture.freshRespawnObserved,
  ]) if (typeof flag !== "boolean") throw new Error("Installed mode canary fixture flags are invalid");
  assertIso(input.startedAt, "Installed mode canary startedAt");
  assertIso(input.completedAt, "Installed mode canary completedAt");
  if (Date.parse(input.completedAt) < Date.parse(input.startedAt)) {
    throw new Error("Installed mode canary completed before it started");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertIso(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
}
