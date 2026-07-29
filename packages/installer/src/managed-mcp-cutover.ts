import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertInternalStoragePath } from "./internal-storage.js";
import {
  MANAGED_MCP_LIFECYCLE_FILE,
  assertManagedMcpPreparedRuntimeEvidence,
  readAndVerifyManagedMcpLifecycleOverlay,
  rebaseManagedMcpLifecycleOverlay,
  type ManagedMcpPreparedRuntimeEvidence,
} from "./managed-mcp-lifecycle.js";
import { readWatcherPromotionReceipt } from "./watcher-promotion.js";

export const MANAGED_MCP_CUTOVER_SCHEMA_VERSION = 1 as const;

export type ManagedMcpCutoverPhase = "staged" | "promoted" | "verified" | "rolled-back" | "failed";

export interface ManagedMcpCutoverReceipt {
  schemaVersion: typeof MANAGED_MCP_CUTOVER_SCHEMA_VERSION;
  kind: "managed-mcp-cutover";
  transactionId: string;
  phase: ManagedMcpCutoverPhase;
  preparedRuntimeRoot: string;
  activeRuntimeRoot: string;
  rollbackRuntimeRoot: string;
  displacedRuntimeRoot: string | null;
  preparedTreeSha256: string;
  activeTreeSha256: string | null;
  previousTreeSha256: string | null;
  fleetFingerprint: string;
  overlaySha256: string;
  configPlanSha256: string;
  watcherReceiptFile: string;
  watcherPausedReceiptSha256: string;
  watcherExpectedFingerprintUpdatePending: boolean;
  configApplied: boolean;
  installedVerificationSha256: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface PromoteManagedMcpRuntimeInput {
  transactionId: string;
  prepared: ManagedMcpPreparedRuntimeEvidence;
  activeRuntimeRoot: string;
  rollbackRuntimeRoot: string;
  receiptFile: string;
  watcherReceiptFile: string;
  artifactDestinationOverrides?: Readonly<Record<string, string>>;
  now?: () => string;
}

export interface ManagedMcpCutoverSequence {
  schemaVersion: 1;
  orderedSteps: readonly [
    "pause-watcher-and-prove-quiesced",
    "promote-app-and-managed-runtime",
    "apply-approved-config-reconciliation",
    "verify-app-runtime-config-and-fingerprints",
    "update-watcher-expected-fingerprint",
    "resume-watcher",
  ];
  configFeature: "features.mcp_on_demand=true";
  preparationMutatesLiveConfig: false;
}

export const MANAGED_MCP_CUTOVER_SEQUENCE: ManagedMcpCutoverSequence = {
  schemaVersion: 1,
  orderedSteps: [
    "pause-watcher-and-prove-quiesced",
    "promote-app-and-managed-runtime",
    "apply-approved-config-reconciliation",
    "verify-app-runtime-config-and-fingerprints",
    "update-watcher-expected-fingerprint",
    "resume-watcher",
  ],
  configFeature: "features.mcp_on_demand=true",
  preparationMutatesLiveConfig: false,
};

/**
 * Atomically swaps the prepared managed-runtime tree only after the existing
 * watcher promotion receipt proves triggers are paused. This helper does not
 * edit Codex config and deliberately leaves watcher re-arm pending.
 */
export function promoteManagedMcpRuntime(
  input: PromoteManagedMcpRuntimeInput,
): ManagedMcpCutoverReceipt {
  assertTransactionId(input.transactionId);
  assertManagedMcpPreparedRuntimeEvidence(input.prepared);
  const active = exactFuturePath(input.activeRuntimeRoot, "Managed MCP active runtime");
  const rollback = exactFuturePath(input.rollbackRuntimeRoot, "Managed MCP rollback runtime");
  const receiptFile = exactFuturePath(input.receiptFile, "Managed MCP cutover receipt");
  const watcherReceiptFile = exactFile(input.watcherReceiptFile, "Watcher promotion receipt");
  if (active === rollback || active === input.prepared.runtimeRoot || rollback === input.prepared.runtimeRoot) {
    throw new Error("Managed MCP cutover paths must be distinct");
  }
  mkdirSync(dirname(active), { recursive: true });
  mkdirSync(dirname(rollback), { recursive: true });
  assertSameDevice([input.prepared.runtimeRoot, dirname(active), dirname(rollback)]);
  const watcher = readWatcherPromotionReceipt(watcherReceiptFile);
  if (!watcher || watcher.transactionId !== input.transactionId || watcher.phase !== "paused") {
    throw new Error("Managed MCP promotion requires a matching paused watcher promotion receipt");
  }
  const watcherPausedReceiptSha256 = sha256(readFileSync(watcherReceiptFile));
  const configPlanFile = join(input.prepared.runtimeRoot, "config-reconciliation.v1.json");
  const configPlanSha256 = sha256(readFileSync(configPlanFile));
  const incoming = `${active}.incoming-${process.pid}-${randomUUID()}`;
  const now = input.now ?? (() => new Date().toISOString());
  const createdAt = now();
  if (existsSync(receiptFile)) {
    const existing = readManagedMcpCutoverReceipt(receiptFile);
    if (existing.transactionId === input.transactionId && existing.phase === "promoted") return existing;
    throw new Error(`Managed MCP cutover receipt already exists at ${receiptFile}`);
  }
  if (existsSync(rollback)) throw new Error(`Managed MCP rollback runtime already exists: ${rollback}`);

  let previousMoved = false;
  let receipt: ManagedMcpCutoverReceipt = {
    schemaVersion: MANAGED_MCP_CUTOVER_SCHEMA_VERSION,
    kind: "managed-mcp-cutover",
    transactionId: input.transactionId,
    phase: "staged",
    preparedRuntimeRoot: input.prepared.runtimeRoot,
    activeRuntimeRoot: active,
    rollbackRuntimeRoot: rollback,
    displacedRuntimeRoot: null,
    preparedTreeSha256: input.prepared.runtimeTreeSha256,
    activeTreeSha256: null,
    previousTreeSha256: existsSync(active) ? digestDirectory(active) : null,
    fleetFingerprint: input.prepared.fleetFingerprint,
    overlaySha256: input.prepared.overlaySha256,
    configPlanSha256,
    watcherReceiptFile,
    watcherPausedReceiptSha256,
    watcherExpectedFingerprintUpdatePending: true,
    configApplied: false,
    installedVerificationSha256: null,
    verifiedAt: null,
    createdAt,
    updatedAt: createdAt,
    error: null,
  };
  writeManagedMcpCutoverReceipt(receiptFile, receipt);
  try {
    cpSync(input.prepared.runtimeRoot, incoming, { recursive: true, verbatimSymlinks: true });
    const incomingOverlay = join(incoming, MANAGED_MCP_LIFECYCLE_FILE);
    const overlay = rebaseManagedMcpLifecycleOverlay(
      input.prepared.overlayFile,
      active,
      incomingOverlay,
      { artifactDestinationOverrides: input.artifactDestinationOverrides },
    );
    const targetOverlaySha256 = sha256(readFileSync(incomingOverlay));
    const targetTreeSha256 = digestDirectory(incoming);
    if (existsSync(active)) {
      renameSync(active, rollback);
      previousMoved = true;
    }
    renameSync(incoming, active);
    const activeOverlay = readAndVerifyManagedMcpLifecycleOverlay(join(active, MANAGED_MCP_LIFECYCLE_FILE));
    if (activeOverlay.fleetFingerprint !== overlay.fleetFingerprint) throw new Error("Managed MCP active fleet fingerprint drift");
    const activeDigest = digestDirectory(active);
    if (activeDigest !== targetTreeSha256) throw new Error("Managed MCP active runtime changed during promotion");
    receipt = {
      ...receipt,
      phase: "promoted",
      activeTreeSha256: activeDigest,
      fleetFingerprint: overlay.fleetFingerprint,
      overlaySha256: targetOverlaySha256,
      updatedAt: now(),
    };
    writeManagedMcpCutoverReceipt(receiptFile, receipt);
    return receipt;
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true });
    let displacedRuntimeRoot: string | null = null;
    if (existsSync(active)
      && (receipt.previousTreeSha256 === null || digestDirectory(active) !== receipt.previousTreeSha256)) {
      displacedRuntimeRoot = `${active}.failed-${input.transactionId}`;
      if (existsSync(displacedRuntimeRoot)) {
        throw new Error(`Managed MCP failed runtime evidence already exists: ${displacedRuntimeRoot}`);
      }
      renameSync(active, displacedRuntimeRoot);
    }
    if (previousMoved && !existsSync(active) && existsSync(rollback)) renameSync(rollback, active);
    receipt = {
      ...receipt,
      phase: "failed",
      displacedRuntimeRoot,
      activeTreeSha256: receipt.previousTreeSha256,
      updatedAt: now(),
      error: error instanceof Error ? error.message : String(error),
    };
    writeManagedMcpCutoverReceipt(receiptFile, receipt);
    throw error;
  }
}

/** Mark the runtime cutover terminal only after config, installed state, and watcher re-arm are proven. */
export function finalizeManagedMcpRuntimeCutover(
  receiptFileInput: string,
  input: {
    installedVerificationFile: string;
    now?: () => string;
  },
): ManagedMcpCutoverReceipt {
  const receiptFile = exactFile(receiptFileInput, "Managed MCP cutover receipt");
  let receipt = readManagedMcpCutoverReceipt(receiptFile);
  if (receipt.phase === "verified") return receipt;
  if (receipt.phase !== "promoted") throw new Error(`Managed MCP cutover cannot finalize from ${receipt.phase}`);
  const watcher = readWatcherPromotionReceipt(exactFile(receipt.watcherReceiptFile, "Watcher promotion receipt"));
  if (!watcher || watcher.transactionId !== receipt.transactionId || watcher.phase !== "resumed") {
    throw new Error("Managed MCP cutover cannot finalize before watcher expected-fingerprint update and resume");
  }
  const verificationFile = exactFile(input.installedVerificationFile, "Managed MCP installed verification");
  const verificationSha256 = sha256(readFileSync(verificationFile));
  const now = input.now ?? (() => new Date().toISOString());
  receipt = {
    ...receipt,
    phase: "verified",
    configApplied: true,
    watcherExpectedFingerprintUpdatePending: false,
    installedVerificationSha256: verificationSha256,
    verifiedAt: now(),
    updatedAt: now(),
    error: null,
  };
  writeManagedMcpCutoverReceipt(receiptFile, receipt);
  return receipt;
}

/** Restore the exact previous managed runtime without deleting failed evidence. */
export function rollbackManagedMcpRuntime(
  receiptFileInput: string,
  now: () => string = () => new Date().toISOString(),
): ManagedMcpCutoverReceipt {
  const receiptFile = exactFile(receiptFileInput, "Managed MCP cutover receipt");
  let receipt = readManagedMcpCutoverReceipt(receiptFile);
  if (receipt.phase === "rolled-back") return receipt;
  if (receipt.phase !== "promoted" && receipt.phase !== "verified" && receipt.phase !== "failed") {
    throw new Error(`Managed MCP cutover cannot roll back from ${receipt.phase}`);
  }
  const active = receipt.activeRuntimeRoot;
  const rollback = receipt.rollbackRuntimeRoot;
  if (!existsSync(active)) throw new Error("Managed MCP active runtime is missing during rollback");
  if (receipt.activeTreeSha256 && digestDirectory(active) !== receipt.activeTreeSha256) {
    throw new Error("Managed MCP active runtime drifted after promotion; refusing implicit deletion");
  }
  const displaced = `${active}.rolled-back-${receipt.transactionId}`;
  if (existsSync(displaced)) throw new Error(`Managed MCP displaced runtime already exists: ${displaced}`);
  renameSync(active, displaced);
  try {
    if (receipt.previousTreeSha256 !== null) {
      if (!existsSync(rollback) || digestDirectory(rollback) !== receipt.previousTreeSha256) {
        throw new Error("Managed MCP rollback runtime is missing or drifted");
      }
      renameSync(rollback, active);
    }
    receipt = {
      ...receipt,
      phase: "rolled-back",
      displacedRuntimeRoot: displaced,
      activeTreeSha256: receipt.previousTreeSha256,
      configApplied: false,
      watcherExpectedFingerprintUpdatePending: true,
      installedVerificationSha256: null,
      verifiedAt: null,
      updatedAt: now(),
      error: null,
    };
    writeManagedMcpCutoverReceipt(receiptFile, receipt);
    return receipt;
  } catch (error) {
    if (!existsSync(active) && existsSync(displaced)) renameSync(displaced, active);
    throw error;
  }
}

export function readManagedMcpCutoverReceipt(file: string): ManagedMcpCutoverReceipt {
  const exact = exactFile(file, "Managed MCP cutover receipt");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(exact, "utf8"));
  } catch (error) {
    throw new Error(`Managed MCP cutover receipt is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isManagedMcpCutoverReceipt(value)) throw new Error(`Invalid managed MCP cutover receipt at ${exact}`);
  return value;
}

function isManagedMcpCutoverReceipt(value: unknown): value is ManagedMcpCutoverReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<ManagedMcpCutoverReceipt>;
  return receipt.schemaVersion === MANAGED_MCP_CUTOVER_SCHEMA_VERSION
    && receipt.kind === "managed-mcp-cutover"
    && typeof receipt.transactionId === "string"
    && ["staged", "promoted", "verified", "rolled-back", "failed"].includes(receipt.phase ?? "")
    && typeof receipt.preparedRuntimeRoot === "string"
    && typeof receipt.activeRuntimeRoot === "string"
    && typeof receipt.rollbackRuntimeRoot === "string"
    && (receipt.displacedRuntimeRoot === null || typeof receipt.displacedRuntimeRoot === "string")
    && validSha(receipt.preparedTreeSha256)
    && (receipt.activeTreeSha256 === null || validSha(receipt.activeTreeSha256))
    && (receipt.previousTreeSha256 === null || validSha(receipt.previousTreeSha256))
    && validMcpSha(receipt.fleetFingerprint)
    && validSha(receipt.overlaySha256)
    && validSha(receipt.configPlanSha256)
    && typeof receipt.watcherReceiptFile === "string"
    && validSha(receipt.watcherPausedReceiptSha256)
    && typeof receipt.watcherExpectedFingerprintUpdatePending === "boolean"
    && typeof receipt.configApplied === "boolean"
    && (receipt.installedVerificationSha256 === null || validSha(receipt.installedVerificationSha256))
    && (receipt.verifiedAt === null || typeof receipt.verifiedAt === "string")
    && (receipt.phase === "verified"
      ? receipt.configApplied === true
        && receipt.watcherExpectedFingerprintUpdatePending === false
        && validSha(receipt.installedVerificationSha256)
        && typeof receipt.verifiedAt === "string"
      : receipt.configApplied === false
        && receipt.installedVerificationSha256 === null
        && receipt.verifiedAt === null)
    && typeof receipt.createdAt === "string"
    && typeof receipt.updatedAt === "string"
    && (receipt.error === null || typeof receipt.error === "string");
}

function writeManagedMcpCutoverReceipt(file: string, receipt: ManagedMcpCutoverReceipt): void {
  if (!isManagedMcpCutoverReceipt(receipt)) throw new Error("Refusing invalid managed MCP cutover receipt");
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function digestDirectory(root: string): string {
  const records: Array<Record<string, string | number>> = [];
  const collect = (path: string): void => {
    const stat = lstatSync(path);
    const local = relative(root, path).split(sep).join("/");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) collect(join(path, name));
    } else if (stat.isFile()) {
      records.push({ path: local, type: "file", mode: stat.mode & 0o7777, sha256: sha256(readFileSync(path)) });
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolved = resolve(dirname(path), target);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
        throw new Error(`Managed MCP cutover tree symlink ${local} escapes its root`);
      }
      records.push({ path: local, type: "symlink", mode: stat.mode & 0o7777, target });
    } else {
      throw new Error(`Managed MCP cutover tree contains unsupported entry ${local}`);
    }
  };
  collect(root);
  return sha256(Buffer.from(JSON.stringify(records)));
}

function assertSameDevice(paths: readonly string[]): void {
  const devices = paths.map((path) => statSync(path).dev);
  if (new Set(devices).size !== 1) throw new Error("Managed MCP atomic cutover paths must share one filesystem");
}

function exactFile(path: string, label: string): string {
  const exact = exactExistingPath(path, label);
  const stat = lstatSync(exact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return exact;
}

function exactExistingPath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || !existsSync(path)) throw new Error(`${label} path must be exact, absolute, and present`);
  assertInternalStoragePath(path, label);
  return path;
}

function exactFuturePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} path must be exact and absolute`);
  assertInternalStoragePath(path, label);
  return path;
}

function assertTransactionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("Invalid managed MCP transaction ID");
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validMcpSha(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
