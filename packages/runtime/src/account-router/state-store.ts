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
  statSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
  ACCOUNT_ROUTER_SCHEMA_VERSION,
  ELIGIBILITY_STATES,
  type CorrelationRecord,
  type LedgerEntry,
  type RouterConfig,
  type RouterState,
  isFingerprint,
  isJsonRpcId,
  isOpaqueAccountId,
  isPlainRecord,
} from "./types";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_STATE_BYTES = 2 * 1024 * 1024;

export function createInitialRouterState(config: RouterConfig): RouterState {
  const ledger: Record<string, LedgerEntry> = {};
  const accountEligibility: RouterState["accountEligibility"] = {};
  for (const account of config.accounts) {
    ledger[account.opaqueAccountId] = {
      completedInputTokens: 0,
      completedOutputTokens: 0,
      reservedRequestCost: 0,
      weight: account.weight,
      assignedThreadCount: 0,
    };
    accountEligibility[account.opaqueAccountId] = account.included ? "validating" : "disabled";
  }
  return {
    schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    epoch: 1,
    threadOwners: {},
    pendingThreadOwners: {},
    ledger,
    reservations: [],
    accountEligibility,
    correlations: [],
    stagedDisable: null,
  };
}

/** Durable owner/ledger state with strict shape checking and private atomic writes. */
export class RouterStateStore {
  private state: RouterState;

  constructor(
    readonly root: string,
    readonly config: RouterConfig,
    readonly fileName = "router-state.json",
  ) {
    ensurePrivateDirectory(root);
    this.state = this.load();
  }

  get path(): string {
    return join(this.root, this.fileName);
  }

  snapshot(): RouterState {
    return structuredClone(this.state);
  }

  update(mutator: (state: RouterState) => void): RouterState {
    const next = structuredClone(this.state);
    mutator(next);
    if (!validateRouterState(next, this.config)) throw new Error("account-router refused an invalid durable state");
    writePrivateJsonAtomic(this.root, this.fileName, next);
    this.state = next;
    return this.snapshot();
  }

  private load(): RouterState {
    if (!existsSync(this.path)) {
      const initial = createInitialRouterState(this.config);
      writePrivateJsonAtomic(this.root, this.fileName, initial);
      return initial;
    }
    assertPrivateRegularFile(this.path, MAX_STATE_BYTES);
    const raw = readFileSync(this.path, "utf8");
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("account-router state exceeds its bounded size");
    const parsed = JSON.parse(raw) as unknown;
    if (!validateRouterState(parsed, this.config)) throw new Error("account-router state failed strict validation");
    return parsed;
  }
}

export function validateRouterState(value: unknown, config: RouterConfig): value is RouterState {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set([
    "schemaVersion", "protocolFingerprint", "epoch", "threadOwners", "pendingThreadOwners", "ledger",
    "reservations", "accountEligibility", "correlations", "stagedDisable",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  const epoch = value.epoch;
  if (value.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 1
    || !isPlainRecord(value.threadOwners) || !isPlainRecord(value.pendingThreadOwners)
    || !isPlainRecord(value.ledger) || !isPlainRecord(value.accountEligibility)
    || !Array.isArray(value.reservations) || !Array.isArray(value.correlations)) return false;
  const configured = new Set(config.accounts.map((account) => account.opaqueAccountId));
  if (!allOwnerValuesConfigured(value.threadOwners, configured) || !allOwnerValuesConfigured(value.pendingThreadOwners, configured)) return false;
  if (!validateLedger(value.ledger, config) || !validateEligibility(value.accountEligibility, configured)) return false;
  if (!value.reservations.every((reservation) => validateReservation(reservation, configured, epoch))) return false;
  if (!value.correlations.every((correlation) => validateCorrelation(correlation, configured))) return false;
  return value.stagedDisable === null || validateStagedDisable(value.stagedDisable);
}

function allOwnerValuesConfigured(value: Record<string, unknown>, configured: Set<string>): boolean {
  return Object.entries(value).every(([threadId, owner]) => threadId.length > 0 && isOpaqueAccountId(owner) && configured.has(owner));
}

function validateLedger(value: Record<string, unknown>, config: RouterConfig): boolean {
  const configured = new Map(config.accounts.map((account) => [account.opaqueAccountId, account]));
  if (Object.keys(value).length !== configured.size) return false;
  return Object.entries(value).every(([opaqueId, entry]) => {
    if (!isPlainRecord(entry)) return false;
    if (!isOpaqueAccountId(opaqueId)) return false;
    const account = configured.get(opaqueId);
    if (!account) return false;
    const allowed = new Set(["completedInputTokens", "completedOutputTokens", "reservedRequestCost", "weight", "assignedThreadCount"]);
    return Object.keys(entry).every((key) => allowed.has(key))
      && entry.weight === account.weight
      && [entry.completedInputTokens, entry.completedOutputTokens, entry.reservedRequestCost, entry.assignedThreadCount]
        .every((number) => Number.isInteger(number) && typeof number === "number" && number >= 0);
  });
}

function validateEligibility(value: Record<string, unknown>, configured: Set<string>): boolean {
  return Object.entries(value).every(([opaqueId, state]) => configured.has(opaqueId) && typeof state === "string" && ELIGIBILITY_STATES.has(state as never));
}

function validateReservation(value: unknown, configured: Set<string>, epoch: number): boolean {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(["reservationId", "opaqueAccountId", "estimatedCost", "state", "epoch"]);
  return Object.keys(value).every((key) => allowed.has(key))
    && typeof value.reservationId === "string" && /^rs_[A-Za-z0-9_-]{16,64}$/.test(value.reservationId)
    && isOpaqueAccountId(value.opaqueAccountId) && configured.has(value.opaqueAccountId)
    && typeof value.estimatedCost === "number" && Number.isInteger(value.estimatedCost)
    && value.estimatedCost >= 1 && value.estimatedCost <= 32_768
    && (value.state === "reserved" || value.state === "released_pre_dispatch" || value.state === "stranded_ambiguous" || value.state === "reconciled")
    && typeof value.epoch === "number" && Number.isInteger(value.epoch) && value.epoch >= 1 && value.epoch <= epoch;
}

function validateCorrelation(value: unknown, configured: Set<string>): value is CorrelationRecord {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(["schemaVersion", "direction", "childOpaqueAccountId", "muxNonce", "originalId", "method", "dispatchState"]);
  return Object.keys(value).every((key) => allowed.has(key))
    && value.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION
    && (value.direction === "client_to_child" || value.direction === "child_to_client")
    && isOpaqueAccountId(value.childOpaqueAccountId) && configured.has(value.childOpaqueAccountId)
    && typeof value.muxNonce === "string" && /^[1-9][0-9]{0,19}$/.test(value.muxNonce)
    && isJsonRpcId(value.originalId)
    && typeof value.method === "string" && value.method.length > 0 && value.method.length <= 256
    && (value.dispatchState === "prepared" || value.dispatchState === "written" || value.dispatchState === "acknowledged" || value.dispatchState === "terminal");
}

function validateStagedDisable(value: unknown): boolean {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => key !== "reasonCode" && key !== "stagedAt")) return false;
  return (value.reasonCode === "post_start_failure" || value.reasonCode === "protocol_drift" || value.reasonCode === "isolation_failure" || value.reasonCode === "policy_stop" || value.reasonCode === "operator_disable")
    && typeof value.stagedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?:\.\d+)?Z$/.test(value.stagedAt);
}

export function ensurePrivateDirectory(path: string): void {
  const resolved = resolve(path);
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("account-router refused an unsafe state directory");
  } else {
    mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  const stat = statSync(resolved);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("account-router state directory is not owner-private");
  }
  chmodSync(resolved, PRIVATE_DIRECTORY_MODE);
}

export function assertPrivateRegularFile(path: string, maxBytes: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > maxBytes || (stat.mode & 0o077) !== 0) {
    throw new Error("account-router refused an unsafe private file");
  }
}

export function writePrivateJsonAtomic(root: string, fileName: string, value: unknown): void {
  ensurePrivateDirectory(root);
  if (basename(fileName) !== fileName || fileName.includes("..")) throw new Error("unsafe account-router file name");
  const target = join(root, fileName);
  if (dirname(target) !== resolve(root)) throw new Error("account-router path escaped its state root");
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("account-router refused an oversized state write");
  const temporary = join(root, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, PRIVATE_FILE_MODE);
    assertPrivateRegularFile(temporary, MAX_STATE_BYTES);
    if (existsSync(target)) assertPrivateRegularFile(target, MAX_STATE_BYTES);
    renameSync(temporary, target);
    chmodSync(target, PRIVATE_FILE_MODE);
    assertPrivateRegularFile(target, MAX_STATE_BYTES);
    fsyncDirectory(root);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* exact private temporary only */ }
    }
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // APFS can decline directory fsync. The file fsync + rename remains the
    // conservative portable guarantee; never widen the target on failure.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
