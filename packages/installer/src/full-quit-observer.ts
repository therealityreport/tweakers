import { createHash, randomUUID } from "node:crypto";

export const FULL_QUIT_OBSERVATION_SCHEMA_VERSION = 1 as const;

export type FullQuitObservationVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface ProcessKernelIdentity {
  pid: number;
  kernelStart: string;
  executablePath: string;
  executableSha256: string;
  parentPid: number | null;
}

/**
 * A prepare-only authority.  It observes a later normal app shutdown but
 * contains no kill/signal capability and therefore cannot become an attached
 * tree reaper.
 */
export interface FullQuitObservationAuthorityV1 {
  schemaVersion: typeof FULL_QUIT_OBSERVATION_SCHEMA_VERSION;
  kind: "full-quit-observation-authority";
  transactionId: string;
  nonce: string;
  expiresAt: string;
  desktop: ProcessKernelIdentity;
  expectedAppPath: string;
  expectedAppSha256: string;
  preparedAt: string;
}

export interface FullQuitObservationReceiptV1 {
  schemaVersion: typeof FULL_QUIT_OBSERVATION_SCHEMA_VERSION;
  kind: "full-quit-observation";
  authoritySha256: string;
  transactionId: string;
  verdict: FullQuitObservationVerdict;
  reason: string | null;
  initial: readonly ProcessKernelIdentity[];
  final: readonly ProcessKernelIdentity[];
  targetDirectExitObserved: boolean;
  childrenReparentedOrExited: boolean;
  attachedUiOwnedSignalCount: 0;
  observedAt: string;
  receiptSha256: string;
}

export function prepareFullQuitObservation(input: {
  transactionId: string;
  desktop: ProcessKernelIdentity;
  expectedAppPath: string;
  expectedAppSha256: string;
  preparedAt: string;
  expiresAt: string;
  nonce?: string;
}): FullQuitObservationAuthorityV1 {
  if (!validTransactionId(input.transactionId)) throw new Error("Full-quit transaction ID is invalid");
  assertProcessIdentity(input.desktop);
  assertExactPath(input.expectedAppPath, "Full-quit expected app path");
  assertSha(input.expectedAppSha256, "Full-quit expected app digest");
  assertIso(input.preparedAt, "Full-quit preparedAt");
  assertIso(input.expiresAt, "Full-quit expiresAt");
  if (Date.parse(input.expiresAt) <= Date.parse(input.preparedAt)) {
    throw new Error("Full-quit observation expires before or at preparation");
  }
  const nonce = input.nonce ?? randomUUID();
  if (!/^[A-Za-z0-9._-]{16,256}$/.test(nonce)) throw new Error("Full-quit observer nonce is invalid");
  return {
    schemaVersion: FULL_QUIT_OBSERVATION_SCHEMA_VERSION,
    kind: "full-quit-observation-authority",
    transactionId: input.transactionId,
    nonce,
    expiresAt: input.expiresAt,
    desktop: { ...input.desktop },
    expectedAppPath: input.expectedAppPath,
    expectedAppSha256: input.expectedAppSha256.toLowerCase(),
    preparedAt: input.preparedAt,
  };
}

/**
 * Verify an independently collected before/after process census.  The only
 * accepted evidence is disappearance of the exact PID/kernel-start pair and
 * absence or reparenting of its observed descendants.  It has no signal path.
 */
export function observeFullQuit(
  authority: FullQuitObservationAuthorityV1,
  input: {
    initial: readonly ProcessKernelIdentity[];
    final: readonly ProcessKernelIdentity[];
    observedAt: string;
    attachedUiOwnedSignalCount?: number;
  },
): FullQuitObservationReceiptV1 {
  assertAuthority(authority);
  assertIso(input.observedAt, "Full-quit observedAt");
  const initial = canonicalCensus(input.initial, "initial");
  const final = canonicalCensus(input.final, "final");
  const signalCount = input.attachedUiOwnedSignalCount ?? 0;
  if (!Number.isSafeInteger(signalCount) || signalCount < 0) throw new Error("Full-quit signal count is invalid");
  const authoritySha256 = digestAuthority(authority);
  const targetInitiallyPresent = initial.some((entry) => sameProcess(entry, authority.desktop));
  const targetStillPresent = final.some((entry) => sameProcess(entry, authority.desktop));
  const initialChildren = initial.filter((entry) => entry.parentPid === authority.desktop.pid);
  const finalByIdentity = new Map(final.map((entry) => [processKey(entry), entry]));
  const childrenReparentedOrExited = initialChildren.every((child) => {
    const later = finalByIdentity.get(processKey(child));
    return later === undefined || later.parentPid !== authority.desktop.pid;
  });
  const reasons: string[] = [];
  if (Date.parse(input.observedAt) > Date.parse(authority.expiresAt)) reasons.push("authority-expired");
  if (!targetInitiallyPresent) reasons.push("target-not-in-initial-census");
  if (targetStillPresent) reasons.push("target-still-running");
  if (!childrenReparentedOrExited) reasons.push("child-still-attached-to-exited-target");
  if (signalCount !== 0) reasons.push("attached-ui-owned-signal-observed");
  const verdict: FullQuitObservationVerdict = reasons.length === 0 ? "PASS" : "FAIL";
  const withoutDigest = {
    schemaVersion: FULL_QUIT_OBSERVATION_SCHEMA_VERSION,
    kind: "full-quit-observation" as const,
    authoritySha256,
    transactionId: authority.transactionId,
    verdict,
    reason: reasons.length === 0 ? null : reasons.join(","),
    initial,
    final,
    targetDirectExitObserved: targetInitiallyPresent && !targetStillPresent,
    childrenReparentedOrExited,
    attachedUiOwnedSignalCount: 0 as const,
    observedAt: input.observedAt,
  };
  return { ...withoutDigest, receiptSha256: digest(withoutDigest) };
}

export function assertFullQuitObservationPass(
  receipt: unknown,
  authority: FullQuitObservationAuthorityV1,
): asserts receipt is FullQuitObservationReceiptV1 {
  if (!isFullQuitObservationReceipt(receipt) || receipt.authoritySha256 !== digestAuthority(authority)) {
    throw new Error("Full-quit observation receipt is invalid or bound to a different authority");
  }
  if (receipt.verdict !== "PASS") throw new Error(`Full-quit observation did not pass: ${receipt.reason ?? "inconclusive"}`);
}

export function isFullQuitObservationReceipt(value: unknown): value is FullQuitObservationReceiptV1 {
  if (!isRecord(value) || value.schemaVersion !== FULL_QUIT_OBSERVATION_SCHEMA_VERSION
    || value.kind !== "full-quit-observation"
    || (value.verdict !== "PASS" && value.verdict !== "FAIL" && value.verdict !== "INCONCLUSIVE")
    || value.attachedUiOwnedSignalCount !== 0
    || (value.reason !== null && typeof value.reason !== "string")) return false;
  try {
    if (!validTransactionId(value.transactionId) || !isSha(value.authoritySha256)
      || !Array.isArray(value.initial) || !Array.isArray(value.final)
      || typeof value.targetDirectExitObserved !== "boolean"
      || typeof value.childrenReparentedOrExited !== "boolean"
      || typeof value.receiptSha256 !== "string") return false;
    canonicalCensus(value.initial as ProcessKernelIdentity[], "initial");
    canonicalCensus(value.final as ProcessKernelIdentity[], "final");
    assertIso(value.observedAt, "Full-quit observedAt");
    const { receiptSha256, ...withoutDigest } = value as unknown as FullQuitObservationReceiptV1;
    return receiptSha256 === digest(withoutDigest);
  } catch {
    return false;
  }
}

export function digestFullQuitObservationAuthority(authority: FullQuitObservationAuthorityV1): string {
  assertAuthority(authority);
  return digestAuthority(authority);
}

function assertAuthority(authority: FullQuitObservationAuthorityV1): void {
  if (!isRecord(authority) || authority.schemaVersion !== FULL_QUIT_OBSERVATION_SCHEMA_VERSION
    || authority.kind !== "full-quit-observation-authority") {
    throw new Error("Full-quit observation authority is invalid");
  }
  if (!validTransactionId(authority.transactionId) || !/^[A-Za-z0-9._-]{16,256}$/.test(authority.nonce)) {
    throw new Error("Full-quit observation authority identity is invalid");
  }
  assertProcessIdentity(authority.desktop);
  assertExactPath(authority.expectedAppPath, "Full-quit expected app path");
  assertSha(authority.expectedAppSha256, "Full-quit expected app digest");
  assertIso(authority.preparedAt, "Full-quit preparedAt");
  assertIso(authority.expiresAt, "Full-quit expiresAt");
}

function canonicalCensus(entries: readonly ProcessKernelIdentity[], label: string): ProcessKernelIdentity[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    assertProcessIdentity(entry);
    const key = processKey(entry);
    if (seen.has(key)) throw new Error(`Full-quit ${label} census has duplicate process identity`);
    seen.add(key);
    return { ...entry, executableSha256: entry.executableSha256.toLowerCase() };
  }).sort((left, right) => processKey(left).localeCompare(processKey(right)));
}

function assertProcessIdentity(value: ProcessKernelIdentity): void {
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !isNonEmpty(value.kernelStart)
    || !isExactPath(value.executablePath) || !isSha(value.executableSha256)
    || (value.parentPid !== null && (!Number.isSafeInteger(value.parentPid) || value.parentPid <= 0))) {
    throw new Error("Full-quit process identity is invalid");
  }
}

function processKey(value: Pick<ProcessKernelIdentity, "pid" | "kernelStart">): string {
  return `${value.pid}:${value.kernelStart}`;
}

function sameProcess(left: ProcessKernelIdentity, right: ProcessKernelIdentity): boolean {
  return left.pid === right.pid && left.kernelStart === right.kernelStart;
}

function digestAuthority(authority: FullQuitObservationAuthorityV1): string {
  return digest({
    schemaVersion: authority.schemaVersion,
    kind: authority.kind,
    transactionId: authority.transactionId,
    nonce: authority.nonce,
    expiresAt: authority.expiresAt,
    desktop: authority.desktop,
    expectedAppPath: authority.expectedAppPath,
    expectedAppSha256: authority.expectedAppSha256.toLowerCase(),
    preparedAt: authority.preparedAt,
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validTransactionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isExactPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length > 1 && !value.includes("/../");
}

function assertExactPath(value: string, label: string): void {
  if (!isExactPath(value)) throw new Error(`${label} is invalid`);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function assertSha(value: string, label: string): void {
  if (!isSha(value)) throw new Error(`${label} is invalid`);
}

function assertIso(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
