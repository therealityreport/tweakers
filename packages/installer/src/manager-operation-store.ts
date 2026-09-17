import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import process from "node:process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  MANAGER_PROTOCOL_VERSION,
  MANAGER_REFRESH_TIMING_PHASES_V1,
  TWEAKERS_MANAGER_RECORDED_ACTION_IDS_V1,
  TWEAKERS_MANAGER_ID,
  type ManagerImpactV1,
  type ManagerOperationPhaseV1,
  type ManagerPreparedReceiptBindingV1,
  type ManagerRefreshTimingEvidenceV1,
  type ManagerRefreshTimingPhaseEvidenceV1,
  type ManagerRefreshTimingPhaseStateV1,
  type ManagerResolvedExecutableIdentityV1,
  type TweakersManagerRecordedActionIdV1,
  type TweakersManagerPreparedOperationV1,
} from "./manager-contract.js";
import {
  assertManagerExactObjectKeys,
  isManagerJsonObject,
  parseManagerStrictJsonObject,
} from "./manager-strict-json.js";

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RECORD_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_RECORD_BYTES = 64 * 1024;
const TIMING_REASON = /^[A-Za-z0-9 .,:;()_-]{1,160}$/;
const PREPARED_OPERATION_KEYS = [
  "schemaVersion", "kind", "managerId", "protocolVersion", "operationId", "preparedRequestId", "actionId", "moduleIdentity",
  "boundStateToken", "parameters", "parametersSha256", "impact", "createdAt", "expiresAt", "phase",
  "consumedAt", "cancelledAt", "completedAt", "failedAt", "recoveryRequiredAt", "stateTokenInputsSha256",
  "receiptChronologyRevision", "receiptSnapshot", "receiptRefs", "outcome", "error",
] as const;

export class ManagerOperationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerOperationStoreError";
  }
}

export interface ManagerOperationStorePaths {
  userRoot: string;
  root: string;
}

export function managerOperationStorePaths(userRoot: string): ManagerOperationStorePaths {
  if (!isAbsolute(userRoot) || resolve(userRoot) !== userRoot) {
    throw new ManagerOperationStoreError("manager operation user root must be an exact absolute path");
  }
  return { userRoot, root: join(userRoot, "transactions", "manager-operations") };
}

/**
 * Small owner-only record store. Locking is deliberately not hidden here: all
 * callers must hold the single shared lifecycle.lock before a read-modify-
 * write operation, so this never becomes a second coordinator authority.
 */
export class ManagerOperationStore {
  readonly paths: ManagerOperationStorePaths;

  constructor(userRoot: string) {
    this.paths = managerOperationStorePaths(userRoot);
  }

  /** Create the store only on a mutation path; status never calls this. */
  ensureRoot(): void {
    mkdirSync(this.paths.root, { recursive: true, mode: DIRECTORY_MODE });
    const stat = assertSafeDirectory(this.paths.root, "manager operation directory");
    if ((stat.mode & 0o7777) !== DIRECTORY_MODE) {
      chmodSync(this.paths.root, DIRECTORY_MODE);
      assertSafeDirectory(this.paths.root, "manager operation directory");
    }
    fsyncDirectory(this.paths.root);
  }

  read(operationId: string): TweakersManagerPreparedOperationV1 | null {
    assertOperationId(operationId);
    if (!existsSync(this.paths.root)) return null;
    assertSafeDirectory(this.paths.root, "manager operation directory");
    const file = this.file(operationId);
    if (!existsSync(file)) return null;
    assertSafeRecord(file);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      throw new ManagerOperationStoreError(`unable to read prepared operation ${operationId}: ${errorMessage(error)}`);
    }
    if (bytes.byteLength > MAX_RECORD_BYTES) throw new ManagerOperationStoreError(`prepared operation ${operationId} exceeds ${MAX_RECORD_BYTES} bytes`);
    const value = parseManagerStrictJsonObject(bytes, { maxBytes: MAX_RECORD_BYTES, label: `prepared operation ${operationId}` });
    return parsePreparedOperation(value, operationId);
  }

  create(record: TweakersManagerPreparedOperationV1): void {
    assertPreparedOperation(record, record.operationId);
    this.ensureRoot();
    const file = this.file(record.operationId);
    if (existsSync(file)) throw new ManagerOperationStoreError(`prepared operation ${record.operationId} already exists`);
    writeAtomic(file, serializeRecord(record), this.paths.root);
    assertSafeRecord(file);
  }

  replace(record: TweakersManagerPreparedOperationV1): void {
    assertPreparedOperation(record, record.operationId);
    this.ensureRoot();
    const file = this.file(record.operationId);
    if (!existsSync(file)) throw new ManagerOperationStoreError(`prepared operation ${record.operationId} is missing`);
    assertSafeRecord(file);
    writeAtomic(file, serializeRecord(record), this.paths.root);
    assertSafeRecord(file);
  }

  removeForFixture(operationId: string): void {
    assertOperationId(operationId);
    const file = this.file(operationId);
    if (existsSync(file)) {
      assertSafeRecord(file);
      unlinkSync(file);
      fsyncDirectory(this.paths.root);
    }
  }

  file(operationId: string): string {
    assertOperationId(operationId);
    return join(this.paths.root, `${operationId}.json`);
  }
}

export function isManagerOperationId(value: string): boolean {
  return LOWERCASE_UUID.test(value);
}

export function parsePreparedOperation(
  value: Record<string, unknown>,
  expectedOperationId?: string,
): TweakersManagerPreparedOperationV1 {
  const hasTiming = Object.hasOwn(value, "timing");
  assertManagerExactObjectKeys(
    value,
    hasTiming ? [...PREPARED_OPERATION_KEYS, "timing"] : PREPARED_OPERATION_KEYS,
    "prepared operation",
  );
  if (value.schemaVersion !== 1 || value.kind !== "tweakers-manager-operation"
    || value.managerId !== TWEAKERS_MANAGER_ID || value.protocolVersion !== MANAGER_PROTOCOL_VERSION) {
    throw new ManagerOperationStoreError("prepared operation has an unsupported identity or schema");
  }
  const operationId = string(value.operationId, "operationId");
  assertOperationId(operationId);
  if (expectedOperationId !== undefined && operationId !== expectedOperationId) {
    throw new ManagerOperationStoreError(`prepared operation identity mismatch: expected ${expectedOperationId}, found ${operationId}`);
  }
  const preparedRequestId = string(value.preparedRequestId, "preparedRequestId");
  assertOperationId(preparedRequestId);
  const actionId = string(value.actionId, "actionId") as TweakersManagerRecordedActionIdV1;
  if (!(TWEAKERS_MANAGER_RECORDED_ACTION_IDS_V1 as readonly string[]).includes(actionId)) {
    throw new ManagerOperationStoreError("prepared operation has an unsupported action");
  }
  const moduleIdentity = parseModuleIdentity(value.moduleIdentity);
  const boundStateToken = parseSha(value.boundStateToken, "boundStateToken");
  const parameters = parseEmptyParameters(value.parameters);
  const parametersSha256 = parseSha(value.parametersSha256, "parametersSha256");
  const impact = parseImpact(value.impact);
  const createdAt = parseTimestamp(value.createdAt, "createdAt");
  const expiresAt = parseTimestamp(value.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new ManagerOperationStoreError("prepared operation expiresAt must be after createdAt");
  }
  const phase = parsePhase(value.phase);
  const consumedAt = parseNullableTimestamp(value.consumedAt, "consumedAt");
  const cancelledAt = parseNullableTimestamp(value.cancelledAt, "cancelledAt");
  const completedAt = parseNullableTimestamp(value.completedAt, "completedAt");
  const failedAt = parseNullableTimestamp(value.failedAt, "failedAt");
  const recoveryRequiredAt = parseNullableTimestamp(value.recoveryRequiredAt, "recoveryRequiredAt");
  const stateTokenInputsSha256 = parseSha(value.stateTokenInputsSha256, "stateTokenInputsSha256");
  const receiptChronologyRevision = parseSha(value.receiptChronologyRevision, "receiptChronologyRevision");
  const receiptSnapshot = parseReceiptSnapshot(value.receiptSnapshot);
  const receiptRefs = parseReceiptRefs(value.receiptRefs);
  const timing = hasTiming ? parseRefreshTiming(value.timing) : undefined;
  if (timing !== undefined && actionId !== "refresh.injected" && actionId !== "refresh.independent") {
    throw new ManagerOperationStoreError("prepared operation timing is only valid for a manager refresh action");
  }
  const outcome = nullableString(value.outcome, "outcome");
  const error = nullableString(value.error, "error");
  assertPhaseTimestamps({ phase, consumedAt, cancelledAt, completedAt, failedAt, recoveryRequiredAt });
  return {
    schemaVersion: 1,
    kind: "tweakers-manager-operation",
    managerId: TWEAKERS_MANAGER_ID,
    protocolVersion: MANAGER_PROTOCOL_VERSION,
    operationId,
    preparedRequestId,
    actionId,
    moduleIdentity,
    boundStateToken,
    parameters,
    parametersSha256,
    impact,
    createdAt,
    expiresAt,
    phase,
    consumedAt,
    cancelledAt,
    completedAt,
    failedAt,
    recoveryRequiredAt,
    stateTokenInputsSha256,
    receiptChronologyRevision,
    receiptSnapshot,
    receiptRefs,
    ...(timing === undefined ? {} : { timing }),
    outcome,
    error,
  };
}

export function assertPreparedOperation(
  record: TweakersManagerPreparedOperationV1,
  expectedOperationId?: string,
): void {
  parsePreparedOperation(record as unknown as Record<string, unknown>, expectedOperationId);
}

function serializeRecord(record: TweakersManagerPreparedOperationV1): string {
  return `${JSON.stringify(record)}\n`;
}

function writeAtomic(file: string, text: string, root: string): void {
  const temporary = join(root, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", RECORD_MODE);
    chmodSync(temporary, RECORD_MODE);
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    fsyncDirectory(root);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort after a failing write */ }
    }
    try { unlinkSync(temporary); } catch { /* no partial record may survive */ }
    throw new ManagerOperationStoreError(`unable to atomically persist prepared operation: ${errorMessage(error)}`);
  }
}

function assertSafeDirectory(path: string, label: string) {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) { throw new ManagerOperationStoreError(`unable to inspect ${label}: ${errorMessage(error)}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ManagerOperationStoreError(`${label} is not a real directory`);
  assertCurrentUser(stat.uid, label);
  if ((stat.mode & 0o077) !== 0) throw new ManagerOperationStoreError(`${label} is group/world accessible`);
  return stat;
}

function assertSafeRecord(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) { throw new ManagerOperationStoreError(`unable to inspect prepared operation: ${errorMessage(error)}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new ManagerOperationStoreError("prepared operation is not a real single-link regular file");
  }
  assertCurrentUser(stat.uid, "prepared operation");
  if ((stat.mode & 0o7777) !== RECORD_MODE) throw new ManagerOperationStoreError("prepared operation must have mode 0600");
}

function assertCurrentUser(uid: number, label: string): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new ManagerOperationStoreError(`${label} has an unexpected owner`);
  }
}

function fsyncDirectory(root: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(root, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function assertOperationId(value: string): void {
  if (!isManagerOperationId(value)) throw new ManagerOperationStoreError("operationId must be a lowercase UUID");
}

function parseModuleIdentity(value: unknown): ManagerResolvedExecutableIdentityV1 {
  if (!isManagerJsonObject(value)
    || Object.keys(value).length !== 3
    || value.state !== "resolved"
    || typeof value.path !== "string"
    || !isAbsolute(value.path)
    || resolve(value.path) !== value.path
    || !SHA256.test(`sha256:${String(value.sha256 ?? "")}`)) {
    throw new ManagerOperationStoreError("prepared operation has an invalid module identity");
  }
  return { state: "resolved", path: value.path, sha256: value.sha256 as string };
}

function parseEmptyParameters(value: unknown): Record<string, never> {
  if (!isManagerJsonObject(value) || Object.keys(value).length !== 0) {
    throw new ManagerOperationStoreError("prepared operation parameters must be an exact empty object");
  }
  return {};
}

function parseSha(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !SHA256.test(value)) throw new ManagerOperationStoreError(`prepared operation ${label} is invalid`);
  return value as `sha256:${string}`;
}

function parseImpact(value: unknown): ManagerImpactV1 {
  if (value === "restart-app" || value === "update-runtime" || value === "repair-app") return value;
  throw new ManagerOperationStoreError("prepared operation impact is invalid");
}

function parsePhase(value: unknown): ManagerOperationPhaseV1 {
  if (value === "prepared" || value === "consumed" || value === "cancelled" || value === "completed"
    || value === "failed" || value === "recovery-required") return value;
  throw new ManagerOperationStoreError("prepared operation phase is invalid");
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ManagerOperationStoreError(`prepared operation ${label} is invalid`);
  }
  return value;
}

function parseNullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : parseTimestamp(value, label);
}

function parseReceiptSnapshot(value: unknown): readonly ManagerPreparedReceiptBindingV1[] {
  if (!Array.isArray(value) || value.length > 64) throw new ManagerOperationStoreError("prepared operation receipt snapshot is invalid");
  return value.map((entry) => {
    if (!isManagerJsonObject(entry)
      || Object.keys(entry).length !== 5
      || !["environment", "chatgpt-app-update", "desktop-update", "environment-mode-cache", "official-source", "codex-derived"].includes(String(entry.source))
      || !(entry.receiptId === null || typeof entry.receiptId === "string")
      || !(entry.phase === null || typeof entry.phase === "string")
      || typeof entry.revision !== "string"
      || typeof entry.active !== "boolean") {
      throw new ManagerOperationStoreError("prepared operation receipt snapshot entry is invalid");
    }
    return {
      source: entry.source as ManagerPreparedReceiptBindingV1["source"],
      receiptId: entry.receiptId as string | null,
      phase: entry.phase as string | null,
      revision: entry.revision,
      active: entry.active,
    };
  });
}

function parseReceiptRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new ManagerOperationStoreError("prepared operation receipt references are invalid");
  }
  return [...value] as string[];
}

function parseRefreshTiming(value: unknown): ManagerRefreshTimingEvidenceV1 {
  if (!isManagerJsonObject(value) || value.schemaVersion !== 1 || !isManagerJsonObject(value.phases)) {
    throw new ManagerOperationStoreError("prepared operation timing is invalid");
  }
  assertManagerExactObjectKeys(value, ["schemaVersion", "phases"], "prepared operation timing");
  assertManagerExactObjectKeys(value.phases, MANAGER_REFRESH_TIMING_PHASES_V1, "prepared operation timing phases");
  const phases = {} as Record<keyof typeof value.phases, ManagerRefreshTimingPhaseEvidenceV1>;
  for (const phase of MANAGER_REFRESH_TIMING_PHASES_V1) {
    phases[phase] = parseRefreshTimingPhase(value.phases[phase]);
  }
  return {
    schemaVersion: 1,
    phases: phases as Record<typeof MANAGER_REFRESH_TIMING_PHASES_V1[number], ManagerRefreshTimingPhaseEvidenceV1>,
  };
}

function parseRefreshTimingPhase(value: unknown): ManagerRefreshTimingPhaseEvidenceV1 {
  if (!isManagerJsonObject(value)) throw new ManagerOperationStoreError("prepared operation timing phase is invalid");
  assertManagerExactObjectKeys(
    value,
    ["state", "startedAt", "completedAt", "durationMs", "reason"],
    "prepared operation timing phase",
  );
  const state = value.state;
  if (state !== "pending" && state !== "running" && state !== "completed"
    && state !== "failed" && state !== "skipped" && state !== "unavailable") {
    throw new ManagerOperationStoreError("prepared operation timing phase state is invalid");
  }
  const startedAt = value.startedAt === null ? null : parseTimestamp(value.startedAt, "timing startedAt");
  const completedAt = value.completedAt === null ? null : parseTimestamp(value.completedAt, "timing completedAt");
  const durationMs = value.durationMs;
  if (durationMs !== null && (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 0)) {
    throw new ManagerOperationStoreError("prepared operation timing phase duration is invalid");
  }
  const reason = value.reason;
  if (reason !== null && (typeof reason !== "string" || !TIMING_REASON.test(reason))) {
    throw new ManagerOperationStoreError("prepared operation timing phase reason is invalid");
  }
  assertTimingPhaseBoundaries(state, startedAt, completedAt, durationMs, reason);
  return { state, startedAt, completedAt, durationMs, reason };
}

function assertTimingPhaseBoundaries(
  state: ManagerRefreshTimingPhaseStateV1,
  startedAt: string | null,
  completedAt: string | null,
  durationMs: number | null,
  reason: string | null,
): void {
  if (state === "pending" && startedAt === null && completedAt === null && durationMs === null && reason === null) return;
  if (state === "running" && startedAt !== null && completedAt === null && durationMs === null && reason === null) return;
  if ((state === "completed" || state === "failed")
    && startedAt !== null && completedAt !== null && durationMs !== null && reason === null) return;
  if ((state === "skipped" || state === "unavailable")
    && startedAt === null && completedAt === null && durationMs === null && reason !== null) return;
  throw new ManagerOperationStoreError("prepared operation timing phase boundaries are inconsistent");
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new ManagerOperationStoreError(`prepared operation ${label} is invalid`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ManagerOperationStoreError(`prepared operation ${label} is invalid`);
  return value;
}

function assertPhaseTimestamps(value: {
  phase: ManagerOperationPhaseV1;
  consumedAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  recoveryRequiredAt: string | null;
}): void {
  const terminalCount = [value.cancelledAt, value.completedAt, value.failedAt, value.recoveryRequiredAt]
    .filter((timestamp) => timestamp !== null).length;
  if (value.phase === "prepared" && value.consumedAt === null && terminalCount === 0) return;
  if (value.phase === "consumed" && value.consumedAt !== null && terminalCount === 0) return;
  if (value.phase === "cancelled" && value.consumedAt === null && value.cancelledAt !== null && terminalCount === 1) return;
  if (value.phase === "completed" && value.consumedAt !== null && value.completedAt !== null && terminalCount === 1) return;
  if (value.phase === "failed" && value.consumedAt !== null && value.failedAt !== null && terminalCount === 1) return;
  if (value.phase === "recovery-required" && value.consumedAt !== null && value.recoveryRequiredAt !== null && terminalCount === 1) return;
  throw new ManagerOperationStoreError("prepared operation phase timestamps are inconsistent");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Copy validation failed before any quiesce, promotion or runtime-ready work. */
export function isCandidateCopyPrecutoverFailure(operation: TweakersManagerPreparedOperationV1 | null): boolean {
  if (!operation || operation.actionId !== "refresh.independent" || operation.phase !== "recovery-required"
    || !/^Copied candidate artifact changed(?:: (?:runtime|tweaks|state\.json|config\.json))?$/.test(operation.error ?? "")) return false;
  const phases = operation.timing?.phases;
  if (!phases || phases["patch-stage"]?.state !== "failed" || !phases["patch-stage"].startedAt || !phases["patch-stage"].completedAt) return false;
  return MANAGER_REFRESH_TIMING_PHASES_V1.filter(key => key !== "patch-stage").every(key => {
    const p = phases[key];
    return !!p && p.startedAt === null && p.completedAt === null
      && (key === "quiesce-promote" || key === "runtime-ready-wait" ? p.state === "skipped" : p.state === "unavailable" || p.state === "skipped");
  });
}
