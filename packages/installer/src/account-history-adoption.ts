import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * This module deliberately owns only the one-shot, offline history adoption
 * transaction. It neither starts nor configures routing and it never has a
 * process-control capability.
 */

export const ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION = 1 as const;
export const ACCOUNT_HISTORY_ADOPTION_INTENT_FILE = "history-adoption-intent.v1.json" as const;
export const ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE = "history-adoption-receipt.v1.json" as const;
export const ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE = "history-adoption-owners.v1.json" as const;
export const ACCOUNT_HISTORY_ADOPTION_INTENT_KIND = "account-router-history-adoption-intent" as const;
export const ACCOUNT_HISTORY_ADOPTION_RECEIPT_KIND = "account-router-history-adoption-receipt" as const;
export const ACCOUNT_HISTORY_ADOPTION_OWNERS_KIND = "account-router-history-adoption-owners" as const;
export const HISTORY_ADOPTION_MAX_ARTIFACT_BYTES = 64 * 1024;
export const HISTORY_ADOPTION_MAX_OWNERS_BYTES = 2 * 1024 * 1024;
export const ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT =
  "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10" as const;

export const OFFICIAL_CODEX_DATABASES = [
  "goals_1.sqlite",
  "logs_2.sqlite",
  "memories_1.sqlite",
  "queue_1.sqlite",
  "state_5.sqlite",
  "thread_history_1.sqlite",
] as const;

export const CODEX_HISTORY_ARTIFACTS = [
  "archived_sessions",
  "session_index.jsonl",
  "sessions",
] as const;

export type OfficialCodexDatabase = typeof OFFICIAL_CODEX_DATABASES[number];
export type CodexHistoryArtifact = typeof CODEX_HISTORY_ARTIFACTS[number];
export type Sha256Fingerprint = `sha256:${string}`;
export type HmacSha256 = `hmac-sha256:${string}`;
export type OpaqueAccountId = `ar_${string}`;

const MAX_ARTIFACT_BYTES = HISTORY_ADOPTION_MAX_ARTIFACT_BYTES;
const MAX_HISTORY_FILE_COUNT = 250_000;
const MAX_HISTORY_SCAN_BYTES = 128 * 1024 * 1024 * 1024;
const MAX_ROLLOUT_FIRST_RECORD_BYTES = 128 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_ROUTER_STATE_BYTES = HISTORY_ADOPTION_MAX_OWNERS_BYTES;
const MAX_AUTH_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 4 * 1024;

export interface HistoryAdoptionIntentV1 {
  schemaVersion: typeof ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION;
  kind: "account-router-history-adoption-intent";
  protocolFingerprint: Sha256Fingerprint;
  poolFingerprint: Sha256Fingerprint;
  configGeneration: number;
  configFingerprint: Sha256Fingerprint;
  legacyOwnerOpaqueAccountId: OpaqueAccountId;
  createdAt: string;
  hmac: HmacSha256;
}

export interface HistoryAdoptionDatabaseEntry {
  name: OfficialCodexDatabase;
  present: boolean;
  sha256: Sha256Fingerprint | null;
  bytes: number;
  integrity: "ok" | null;
}

export interface HistoryAdoptionHistoryEntry {
  name: CodexHistoryArtifact;
  present: boolean;
  sha256: Sha256Fingerprint | null;
  bytes: number;
  fileCount: number;
}

export interface HistoryAdoptionReceiptV1 {
  schemaVersion: typeof ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION;
  kind: "account-router-history-adoption-receipt";
  protocolFingerprint: Sha256Fingerprint;
  poolFingerprint: Sha256Fingerprint;
  intentFingerprint: Sha256Fingerprint;
  legacyOwnerOpaqueAccountId: OpaqueAccountId;
  sourceFingerprint: Sha256Fingerprint;
  destinationFingerprint: Sha256Fingerprint;
  databases: readonly HistoryAdoptionDatabaseEntry[];
  histories: readonly HistoryAdoptionHistoryEntry[];
  importedThreadCount: number;
  threadOwnersFingerprint: Sha256Fingerprint;
  backupFingerprint: Sha256Fingerprint;
  adoptedAt: string;
  hmac: HmacSha256;
}

/**
 * Immutable imported-thread ownership evidence. It intentionally lives beside
 * normal router state so later ordinary routing growth does not change the
 * historical-adoption proof.
 */
export interface HistoryAdoptionOwnersV1 {
  schemaVersion: typeof ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION;
  kind: "account-router-history-adoption-owners";
  protocolFingerprint: Sha256Fingerprint;
  poolFingerprint: Sha256Fingerprint;
  legacyOwnerOpaqueAccountId: OpaqueAccountId;
  threadIds: readonly string[];
  threadOwnersFingerprint: Sha256Fingerprint;
  adoptedAt: string;
  hmac: HmacSha256;
}

export interface CreateHistoryAdoptionIntentInput {
  protocolFingerprint: Sha256Fingerprint;
  accountOpaqueIds: readonly OpaqueAccountId[];
  configGeneration: number;
  configFingerprint: Sha256Fingerprint;
  legacyOwnerOpaqueAccountId: OpaqueAccountId;
  createdAt: string;
}

export interface CreateHistoryAdoptionReceiptInput {
  protocolFingerprint: Sha256Fingerprint;
  poolFingerprint: Sha256Fingerprint;
  intentFingerprint: Sha256Fingerprint;
  legacyOwnerOpaqueAccountId: OpaqueAccountId;
  sourceFingerprint: Sha256Fingerprint;
  destinationFingerprint: Sha256Fingerprint;
  databases: readonly HistoryAdoptionDatabaseEntry[];
  histories: readonly HistoryAdoptionHistoryEntry[];
  importedThreadCount: number;
  threadOwnersFingerprint: Sha256Fingerprint;
  backupFingerprint: Sha256Fingerprint;
  adoptedAt: string;
}

export interface CreateHistoryAdoptionOwnersInput {
  protocolFingerprint: Sha256Fingerprint;
  poolFingerprint: Sha256Fingerprint;
  legacyOwnerOpaqueAccountId: OpaqueAccountId;
  threadIds: readonly string[];
  threadOwnersFingerprint: Sha256Fingerprint;
  adoptedAt: string;
}

/** Stable JSON serializer shared with the runtime-facing contract. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure("invalid-canonical-json");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!isRecord(value)) throw failure("invalid-canonical-json");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Fingerprint(value: string | Buffer): Sha256Fingerprint {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalSha256Fingerprint(value: unknown): Sha256Fingerprint {
  return sha256Fingerprint(canonicalJson(value));
}

export function isSha256Fingerprint(value: unknown): value is Sha256Fingerprint {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function isOpaqueAccountId(value: unknown): value is OpaqueAccountId {
  return typeof value === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value);
}

export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** The pool deliberately excludes labels, weights, and config generation. */
export function historyAdoptionPoolFingerprint(
  protocolFingerprint: Sha256Fingerprint,
  accountOpaqueIds: readonly OpaqueAccountId[],
): Sha256Fingerprint {
  assertProtocolFingerprint(protocolFingerprint);
  const sorted = canonicalPoolIds(accountOpaqueIds);
  return canonicalSha256Fingerprint({ protocolFingerprint, accountOpaqueIds: sorted });
}

export function historyAdoptionIntentFingerprint(intent: Omit<HistoryAdoptionIntentV1, "hmac"> | HistoryAdoptionIntentV1): Sha256Fingerprint {
  const payload = "hmac" in intent ? withoutHmac(intent) : intent;
  return canonicalSha256Fingerprint(payload);
}

export function createHistoryAdoptionIntent(
  input: CreateHistoryAdoptionIntentInput,
  controlSecret: Buffer,
): HistoryAdoptionIntentV1 {
  assertControlSecret(controlSecret);
  assertProtocolFingerprint(input.protocolFingerprint);
  const accountOpaqueIds = canonicalPoolIds(input.accountOpaqueIds);
  if (!accountOpaqueIds.includes(input.legacyOwnerOpaqueAccountId)) throw failure("intent-owner-not-in-pool");
  assertPositiveInteger(input.configGeneration, "invalid-intent-generation");
  assertFingerprint(input.configFingerprint, "invalid-intent-config-fingerprint");
  assertCanonicalTimestamp(input.createdAt, "invalid-intent-timestamp");
  const payload: Omit<HistoryAdoptionIntentV1, "hmac"> = {
    schemaVersion: ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION,
    kind: "account-router-history-adoption-intent",
    protocolFingerprint: input.protocolFingerprint,
    poolFingerprint: historyAdoptionPoolFingerprint(input.protocolFingerprint, accountOpaqueIds),
    configGeneration: input.configGeneration,
    configFingerprint: input.configFingerprint,
    legacyOwnerOpaqueAccountId: input.legacyOwnerOpaqueAccountId,
    createdAt: input.createdAt,
  };
  return { ...payload, hmac: hmacPayload(controlSecret, payload) };
}

export function parseHistoryAdoptionIntent(bytes: Buffer | string): HistoryAdoptionIntentV1 {
  const raw = boundedJson(bytes, "invalid-history-adoption-intent");
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "schemaVersion", "kind", "protocolFingerprint", "poolFingerprint", "configGeneration", "configFingerprint",
    "legacyOwnerOpaqueAccountId", "createdAt", "hmac",
  ])) throw failure("invalid-history-adoption-intent");
  const configGeneration = raw.configGeneration;
  if (raw.schemaVersion !== ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION
    || raw.kind !== "account-router-history-adoption-intent"
    || !isSha256Fingerprint(raw.protocolFingerprint)
    || !isSha256Fingerprint(raw.poolFingerprint)
    || typeof configGeneration !== "number" || !Number.isSafeInteger(configGeneration) || configGeneration < 1
    || !isSha256Fingerprint(raw.configFingerprint)
    || !isOpaqueAccountId(raw.legacyOwnerOpaqueAccountId)
    || !isCanonicalUtcTimestamp(raw.createdAt)
    || !isHmacSha256(raw.hmac)) throw failure("invalid-history-adoption-intent");
  const intent: HistoryAdoptionIntentV1 = {
    schemaVersion: ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION,
    kind: "account-router-history-adoption-intent",
    protocolFingerprint: raw.protocolFingerprint,
    poolFingerprint: raw.poolFingerprint,
    configGeneration: configGeneration as number,
    configFingerprint: raw.configFingerprint,
    legacyOwnerOpaqueAccountId: raw.legacyOwnerOpaqueAccountId,
    createdAt: raw.createdAt,
    hmac: raw.hmac,
  };
  assertProtocolFingerprint(intent.protocolFingerprint);
  return intent;
}

export function verifyHistoryAdoptionIntent(intent: HistoryAdoptionIntentV1, controlSecret: Buffer): boolean {
  try {
    assertControlSecret(controlSecret);
    parseHistoryAdoptionIntent(Buffer.from(JSON.stringify(intent)));
    return secureEqualHmac(intent.hmac, hmacPayload(controlSecret, withoutHmac(intent)));
  } catch {
    return false;
  }
}

export function createHistoryAdoptionReceipt(
  input: CreateHistoryAdoptionReceiptInput,
  controlSecret: Buffer,
): HistoryAdoptionReceiptV1 {
  assertControlSecret(controlSecret);
  assertReceiptPayload(input);
  const payload: Omit<HistoryAdoptionReceiptV1, "hmac"> = {
    schemaVersion: ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION,
    kind: "account-router-history-adoption-receipt",
    protocolFingerprint: input.protocolFingerprint,
    poolFingerprint: input.poolFingerprint,
    intentFingerprint: input.intentFingerprint,
    legacyOwnerOpaqueAccountId: input.legacyOwnerOpaqueAccountId,
    sourceFingerprint: input.sourceFingerprint,
    destinationFingerprint: input.destinationFingerprint,
    databases: cloneDatabaseEntries(input.databases),
    histories: cloneHistoryEntries(input.histories),
    importedThreadCount: input.importedThreadCount,
    threadOwnersFingerprint: input.threadOwnersFingerprint,
    backupFingerprint: input.backupFingerprint,
    adoptedAt: input.adoptedAt,
  };
  return { ...payload, hmac: hmacPayload(controlSecret, payload) };
}

export function parseHistoryAdoptionReceipt(bytes: Buffer | string): HistoryAdoptionReceiptV1 {
  const raw = boundedJson(bytes, "invalid-history-adoption-receipt");
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "schemaVersion", "kind", "protocolFingerprint", "poolFingerprint", "intentFingerprint", "legacyOwnerOpaqueAccountId",
    "sourceFingerprint", "destinationFingerprint", "databases", "histories", "importedThreadCount",
    "threadOwnersFingerprint", "backupFingerprint", "adoptedAt", "hmac",
  ])) throw failure("invalid-history-adoption-receipt");
  const payload: CreateHistoryAdoptionReceiptInput = {
    protocolFingerprint: raw.protocolFingerprint as Sha256Fingerprint,
    poolFingerprint: raw.poolFingerprint as Sha256Fingerprint,
    intentFingerprint: raw.intentFingerprint as Sha256Fingerprint,
    legacyOwnerOpaqueAccountId: raw.legacyOwnerOpaqueAccountId as OpaqueAccountId,
    sourceFingerprint: raw.sourceFingerprint as Sha256Fingerprint,
    destinationFingerprint: raw.destinationFingerprint as Sha256Fingerprint,
    databases: Array.isArray(raw.databases) ? raw.databases as HistoryAdoptionDatabaseEntry[] : [],
    histories: Array.isArray(raw.histories) ? raw.histories as HistoryAdoptionHistoryEntry[] : [],
    importedThreadCount: raw.importedThreadCount as number,
    threadOwnersFingerprint: raw.threadOwnersFingerprint as Sha256Fingerprint,
    backupFingerprint: raw.backupFingerprint as Sha256Fingerprint,
    adoptedAt: raw.adoptedAt as string,
  };
  if (raw.schemaVersion !== ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION
    || raw.kind !== "account-router-history-adoption-receipt"
    || !isHmacSha256(raw.hmac)) throw failure("invalid-history-adoption-receipt");
  assertReceiptPayload(payload);
  return {
    schemaVersion: ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION,
    kind: "account-router-history-adoption-receipt",
    ...payload,
    databases: cloneDatabaseEntries(payload.databases),
    histories: cloneHistoryEntries(payload.histories),
    hmac: raw.hmac,
  };
}

export function verifyHistoryAdoptionReceipt(receipt: HistoryAdoptionReceiptV1, controlSecret: Buffer): boolean {
  try {
    assertControlSecret(controlSecret);
    parseHistoryAdoptionReceipt(Buffer.from(JSON.stringify(receipt)));
    return secureEqualHmac(receipt.hmac, hmacPayload(controlSecret, withoutHmac(receipt)));
  } catch {
    return false;
  }
}

export function historyAdoptionThreadOwnersFingerprint(
  threadIds: readonly string[],
  legacyOwnerOpaqueAccountId: OpaqueAccountId,
): Sha256Fingerprint {
  const sorted = canonicalThreadIds(threadIds);
  if (!isOpaqueAccountId(legacyOwnerOpaqueAccountId)) throw failure("invalid-history-adoption-owner");
  return canonicalSha256Fingerprint(sorted.map((threadId) => ({ threadId, opaqueAccountId: legacyOwnerOpaqueAccountId })));
}

export function createHistoryAdoptionOwners(
  input: CreateHistoryAdoptionOwnersInput,
  controlSecret: Buffer,
): HistoryAdoptionOwnersV1 {
  assertControlSecret(controlSecret);
  assertProtocolFingerprint(input.protocolFingerprint);
  assertFingerprint(input.poolFingerprint, "invalid-owners-pool-fingerprint");
  if (!isOpaqueAccountId(input.legacyOwnerOpaqueAccountId)) throw failure("invalid-history-adoption-owner");
  const threadIds = canonicalThreadIds(input.threadIds);
  const threadOwnersFingerprint = historyAdoptionThreadOwnersFingerprint(threadIds, input.legacyOwnerOpaqueAccountId);
  if (input.threadOwnersFingerprint !== threadOwnersFingerprint) throw failure("owners-thread-fingerprint-mismatch");
  assertCanonicalTimestamp(input.adoptedAt, "invalid-owners-timestamp");
  const payload: Omit<HistoryAdoptionOwnersV1, "hmac"> = {
    schemaVersion: ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION,
    kind: "account-router-history-adoption-owners",
    protocolFingerprint: input.protocolFingerprint,
    poolFingerprint: input.poolFingerprint,
    legacyOwnerOpaqueAccountId: input.legacyOwnerOpaqueAccountId,
    threadIds,
    threadOwnersFingerprint,
    adoptedAt: input.adoptedAt,
  };
  const bytes = Buffer.byteLength(canonicalJson(payload), "utf8");
  if (bytes > MAX_ROUTER_STATE_BYTES) throw failure("history-adoption-owners-capacity-exceeded");
  return { ...payload, hmac: hmacPayload(controlSecret, payload) };
}

export function parseHistoryAdoptionOwners(bytes: Buffer | string): HistoryAdoptionOwnersV1 {
  const raw = boundedJson(bytes, "invalid-history-adoption-owners", MAX_ROUTER_STATE_BYTES);
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "schemaVersion", "kind", "protocolFingerprint", "poolFingerprint", "legacyOwnerOpaqueAccountId", "threadIds",
    "threadOwnersFingerprint", "adoptedAt", "hmac",
  ])) throw failure("invalid-history-adoption-owners");
  if (raw.schemaVersion !== ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION
    || raw.kind !== "account-router-history-adoption-owners"
    || !isSha256Fingerprint(raw.protocolFingerprint)
    || !isSha256Fingerprint(raw.poolFingerprint)
    || !isOpaqueAccountId(raw.legacyOwnerOpaqueAccountId)
    || !Array.isArray(raw.threadIds)
    || !isSha256Fingerprint(raw.threadOwnersFingerprint)
    || !isCanonicalUtcTimestamp(raw.adoptedAt)
    || !isHmacSha256(raw.hmac)) throw failure("invalid-history-adoption-owners");
  assertProtocolFingerprint(raw.protocolFingerprint);
  const threadIds = canonicalThreadIds(raw.threadIds);
  if (canonicalJson(threadIds) !== canonicalJson(raw.threadIds)) throw failure("invalid-history-adoption-owners");
  const expectedFingerprint = historyAdoptionThreadOwnersFingerprint(threadIds, raw.legacyOwnerOpaqueAccountId);
  if (raw.threadOwnersFingerprint !== expectedFingerprint) throw failure("invalid-history-adoption-owners");
  return {
    schemaVersion: ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION,
    kind: "account-router-history-adoption-owners",
    protocolFingerprint: raw.protocolFingerprint,
    poolFingerprint: raw.poolFingerprint,
    legacyOwnerOpaqueAccountId: raw.legacyOwnerOpaqueAccountId,
    threadIds,
    threadOwnersFingerprint: raw.threadOwnersFingerprint,
    adoptedAt: raw.adoptedAt,
    hmac: raw.hmac,
  };
}

export function verifyHistoryAdoptionOwners(owners: HistoryAdoptionOwnersV1, controlSecret: Buffer): boolean {
  try {
    assertControlSecret(controlSecret);
    parseHistoryAdoptionOwners(Buffer.from(JSON.stringify(owners)));
    return secureEqualHmac(owners.hmac, hmacPayload(controlSecret, withoutHmac(owners)));
  } catch {
    return false;
  }
}

export interface HistoryAdoptionCensus {
  app: "idle" | "running" | "unknown";
  main: "idle" | "running" | "unknown";
  appServer: "idle" | "running" | "unknown";
  openFileCount: number;
  observedAt: string;
}

export interface HistoryAdoptionProcessCensus {
  app: "idle" | "running";
  main: "idle" | "running";
  appServer: "idle" | "running";
}

/** Classify synthetic `ps -axo pid=,command=` output without observing the host. */
export function historyAdoptionProcessCensus(
  output: string,
  appPath: string,
  selfPid: number = process.pid,
): HistoryAdoptionProcessCensus {
  const processes = output
    .split(/\r?\n/)
    .map((line): { pid: number; command: string } | null => {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) return null;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid)) return null;
      return { pid, command: match[2]! };
    })
    .filter((entry): entry is { pid: number; command: string } => entry !== null)
    .filter((entry) => entry.pid !== selfPid);
  const app = processes.some((entry) => entry.command.includes(appPath));
  const main = processes.some((entry) => /(?:ChatGPT|Codex)(?:\.app)?(?:\s|$)/i.test(entry.command) && entry.command.includes(appPath));
  const appServer = processes.some((entry) => /(?:codex\s+app-server|app-server)/i.test(entry.command));
  return {
    app: app ? "running" : "idle",
    main: main ? "running" : "idle",
    appServer: appServer ? "running" : "idle",
  };
}

export interface HistoryAdoptionSqliteRow {
  id: string;
  rolloutPath: string | null;
}

export interface HistoryAdoptionSqliteAdapter {
  backup(source: string, destination: string): void;
  integrityCheck(path: string): "ok";
  readThreads(path: string): readonly HistoryAdoptionSqliteRow[];
  rewriteThreadRolloutPaths(path: string, updates: readonly HistoryAdoptionSqliteRow[]): void;
}

export type HistoryAdoptionPhase =
  | "after-first-census"
  | "after-second-census"
  | "after-candidate-created"
  | "after-owner-backup"
  | "after-owner-promoted"
  | "after-router-state-backup"
  | "after-router-state-promoted"
  | "after-owners-manifest-published"
  | "before-receipt-publication";

export interface HistoryAdoptionDependencies {
  sqlite: HistoryAdoptionSqliteAdapter;
  census(input: { appPath: string; protectedPaths: readonly string[] }): HistoryAdoptionCensus;
  now(): string;
  randomId(): string;
  beforePhase?(phase: HistoryAdoptionPhase): void;
  publishReceipt?(path: string, receipt: HistoryAdoptionReceiptV1): void;
}

export interface AdoptAccountHistoryInput {
  /** Exact existing legacy CODEX_HOME. */
  sourceCodexRoot: string;
  /** Exact existing legacy CODEX_SQLITE_HOME. */
  sourceSqliteRoot: string;
  /** Exact account-router private data root. */
  routerRoot: string;
  /** Exact desktop app path used only by the census adapter. */
  appPath: string;
  /** Omitted/false is a read-only dry run. */
  apply?: boolean;
}

export interface HistoryAdoptionResult {
  status: "dry-run" | "adopted" | "already-adopted";
  importedThreadCount: number;
  sourceFingerprint: Sha256Fingerprint;
  destinationFingerprint: Sha256Fingerprint | null;
  poolFingerprint: Sha256Fingerprint;
  intentFingerprint: Sha256Fingerprint;
  databasesPresent: number;
  historyFiles: number;
  nextAction: "review-and-apply" | "restart-remains-user-confirmed" | "none";
}

interface RouterAccountConfig {
  opaqueAccountId: OpaqueAccountId;
  included: true;
  weight: number;
  capabilityFingerprint: Sha256Fingerprint;
  label: string;
}

interface RouterConfigForAdoption {
  schemaVersion: 2;
  mode: "manual" | "quota_aware";
  policy: "quota_aware_v1" | null;
  generation: number;
  fingerprint: Sha256Fingerprint;
  protocolFingerprint: Sha256Fingerprint;
  primaryOpaqueAccountId: OpaqueAccountId;
  accounts: readonly [RouterAccountConfig, RouterAccountConfig];
  updatedAt: string;
}

interface RouterStateForAdoption {
  schemaVersion: 1;
  protocolFingerprint: Sha256Fingerprint;
  epoch: number;
  threadOwners: Record<string, OpaqueAccountId>;
  pendingThreadOwners: Record<string, OpaqueAccountId>;
  ledger: Record<string, {
    completedInputTokens: number;
    completedOutputTokens: number;
    reservedRequestCost: number;
    weight: number;
    assignedThreadCount: number;
  }>;
  reservations: unknown[];
  accountEligibility: Record<string, string>;
  correlations: unknown[];
  stagedDisable: null | Record<string, unknown>;
}

interface DatabaseInspection {
  entries: readonly HistoryAdoptionDatabaseEntry[];
  paths: ReadonlyMap<OfficialCodexDatabase, string>;
}

interface TreeFile {
  relativePath: string;
  bytes: number;
  sha256: Sha256Fingerprint;
}

interface HistoryInspection {
  entries: readonly HistoryAdoptionHistoryEntry[];
  files: ReadonlyMap<"sessions" | "archived_sessions", readonly TreeFile[]>;
}

interface ImportPlan {
  threadIds: readonly string[];
  threadOwners: Readonly<Record<string, OpaqueAccountId>>;
  threadOwnersFingerprint: Sha256Fingerprint;
  updates: readonly HistoryAdoptionSqliteRow[];
}

interface PreAdoptionOwner {
  accountRoot: string;
  codexHome: string;
  sqliteHome: string;
  authFingerprint: Sha256Fingerprint;
  configFingerprint: Sha256Fingerprint;
  fingerprint: Sha256Fingerprint;
}

interface ActiveTransaction {
  ownerRoot: string;
  candidateRoot: string | null;
  ownerBackupRoot: string | null;
  ownerPromoted: boolean;
  routerStateBackup: string | null;
  routerStateNext: string | null;
  routerStatePromoted: boolean;
  ownersManifestPublished: boolean;
  receiptPath: string;
}

/**
 * Read-only by default. The only mutation path is guarded by two independent
 * idle censuses before the candidate directory is created.
 */
export function adoptAccountHistory(
  input: AdoptAccountHistoryInput,
  suppliedDependencies?: Partial<HistoryAdoptionDependencies>,
): HistoryAdoptionResult {
  const dependencies = { ...defaultDependencies(), ...suppliedDependencies } as HistoryAdoptionDependencies;
  const apply = input.apply === true;
  const paths = adoptionPaths(input);
  let controlSecret: Buffer | null = null;
  let transaction: ActiveTransaction | null = null;
  try {
    assertExactDirectory(paths.routerRoot, "router-root", true);
    assertExactDirectory(paths.accountsRoot, "accounts-root", true);
    assertExactDirectory(paths.sourceCodexRoot, "source-codex-root", false);
    assertExactDirectory(paths.sourceSqliteRoot, "source-sqlite-root", false);
    controlSecret = readPrivateRegularFile(paths.controlSecretFile, 64, false, "control-secret");
    if (controlSecret.byteLength !== 32) throw failure("invalid-control-secret");

    const config = readRouterConfig(paths.configFile);
    const intent = parseHistoryAdoptionIntent(readPrivateRegularFile(paths.intentFile, MAX_ARTIFACT_BYTES, false, "history-adoption-intent"));
    if (!verifyHistoryAdoptionIntent(intent, controlSecret)) throw failure("history-adoption-intent-hmac-invalid");
    assertIntentMatchesConfig(intent, config);

    const sourceDatabases = inspectDatabases(paths.sourceSqliteRoot, dependencies.sqlite);
    const sourceHistories = inspectHistories(paths.sourceCodexRoot);
    const sourceFingerprint = adoptionContentFingerprint(sourceDatabases.entries, sourceHistories.entries);
    const finalOwnerCodexHome = join(paths.accountsRoot, intent.legacyOwnerOpaqueAccountId, "codex-home");
    const sourcePlan = collectImportPlan({
      stateDatabasePath: sourceDatabases.paths.get("state_5.sqlite") ?? null,
      histories: sourceHistories,
      historyRoot: paths.sourceCodexRoot,
      rolloutPathSourceRoot: paths.sourceCodexRoot,
      finalOwnerCodexHome,
      owner: intent.legacyOwnerOpaqueAccountId,
      sqlite: dependencies.sqlite,
    });

    if (existsSync(paths.receiptFile)) {
      const receipt = parseHistoryAdoptionReceipt(readPrivateRegularFile(paths.receiptFile, MAX_ARTIFACT_BYTES, false, "history-adoption-receipt"));
      if (!verifyHistoryAdoptionReceipt(receipt, controlSecret)) throw failure("history-adoption-receipt-hmac-invalid");
      assertAlreadyAdopted({
        paths,
        config,
        intent,
        receipt,
        sourceDatabases,
        sourceHistories,
        sourceFingerprint,
        sourcePlan,
        sqlite: dependencies.sqlite,
      });
      return resultFor("already-adopted", sourceFingerprint, receipt.destinationFingerprint, intent, sourceDatabases, sourceHistories, sourcePlan);
    }
    if (existsSync(paths.ownersFile)) throw failure("history-adoption-owners-without-receipt");

    const owner = inspectPreAdoptionOwner(paths.accountsRoot, intent.legacyOwnerOpaqueAccountId);
    const routerState = readRouterState(paths.routerStateFile, config, true);
    assertNoThreadOwnerCollisions(routerState.value.threadOwners, sourcePlan.threadIds);

    if (!apply) {
      return resultFor("dry-run", sourceFingerprint, null, intent, sourceDatabases, sourceHistories, sourcePlan);
    }

    assertIdleCensus(dependencies.census({ appPath: paths.appPath, protectedPaths: protectedPaths(paths) }));
    dependencies.beforePhase?.("after-first-census");
    assertIdleCensus(dependencies.census({ appPath: paths.appPath, protectedPaths: protectedPaths(paths) }));
    dependencies.beforePhase?.("after-second-census");

    const candidateRoot = uniqueSibling(paths.accountsRoot, ".history-adoption-candidate", dependencies.randomId());
    transaction = {
      ownerRoot: owner.accountRoot,
      candidateRoot,
      ownerBackupRoot: null,
      ownerPromoted: false,
      routerStateBackup: null,
      routerStateNext: null,
      routerStatePromoted: false,
      ownersManifestPublished: false,
      receiptPath: paths.receiptFile,
    };
    createCandidateOwner(candidateRoot);
    clonePreAdoptionOwner(owner, candidateRoot);
    const candidateCodexHome = join(candidateRoot, "codex-home");
    const candidateSqliteHome = join(candidateRoot, "sqlite-home");
    copyHistories(paths.sourceCodexRoot, candidateCodexHome, sourceHistories);
    cloneDatabases(paths.sourceSqliteRoot, candidateSqliteHome, sourceDatabases, dependencies.sqlite);
    dependencies.beforePhase?.("after-candidate-created");

    const candidateBeforeRewriteDatabases = inspectDatabases(candidateSqliteHome, dependencies.sqlite);
    const candidateHistories = inspectHistories(candidateCodexHome);
    assertCanonicalEqual(sourceHistories.entries, candidateHistories.entries, "candidate-history-mismatch");
    assertDatabaseCloneShape(sourceDatabases.entries, candidateBeforeRewriteDatabases.entries);
    const candidatePlan = collectImportPlan({
      stateDatabasePath: candidateBeforeRewriteDatabases.paths.get("state_5.sqlite") ?? null,
      histories: candidateHistories,
      historyRoot: candidateCodexHome,
      rolloutPathSourceRoot: paths.sourceCodexRoot,
      finalOwnerCodexHome,
      owner: intent.legacyOwnerOpaqueAccountId,
      sqlite: dependencies.sqlite,
    });
    assertCanonicalEqual(sourcePlan.threadIds, candidatePlan.threadIds, "candidate-thread-mismatch");
    if (candidatePlan.updates.length > 0) {
      const candidateState = candidateBeforeRewriteDatabases.paths.get("state_5.sqlite");
      if (!candidateState) throw failure("candidate-state-database-missing");
      dependencies.sqlite.rewriteThreadRolloutPaths(candidateState, candidatePlan.updates);
      assertRewrittenThreadPaths(candidateState, candidatePlan.updates, dependencies.sqlite);
    }
    const candidateDatabases = inspectDatabases(candidateSqliteHome, dependencies.sqlite);
    const destinationFingerprint = adoptionContentFingerprint(candidateDatabases.entries, candidateHistories.entries);
    assertCandidateOwnerShape(candidateRoot, candidateDatabases, candidateHistories, owner);

    // Re-check the immutable source and the pre-adoption target immediately
    // before the first rename. A race now fails while the candidate is still
    // separately retained for diagnosis.
    const finalSourceDatabases = inspectDatabases(paths.sourceSqliteRoot, dependencies.sqlite);
    const finalSourceHistories = inspectHistories(paths.sourceCodexRoot);
    if (adoptionContentFingerprint(finalSourceDatabases.entries, finalSourceHistories.entries) !== sourceFingerprint) {
      throw failure("legacy-source-changed-during-adoption");
    }
    if (inspectPreAdoptionOwner(paths.accountsRoot, intent.legacyOwnerOpaqueAccountId).fingerprint !== owner.fingerprint) {
      throw failure("owner-home-changed-during-adoption");
    }
    const latestRouterState = readRouterState(paths.routerStateFile, config, true);
    if (!latestRouterState.bytes.equals(routerState.bytes)) throw failure("router-state-changed-during-adoption");
    assertNoThreadOwnerCollisions(latestRouterState.value.threadOwners, sourcePlan.threadIds);

    // Both durable publication payloads are fully materialized before the
    // first rename. Capacity failures therefore leave the owner untouched.
    const adoptedAt = canonicalNow(dependencies.now());
    const mergedState = mergeThreadOwners(latestRouterState.value, sourcePlan.threadOwners, intent.legacyOwnerOpaqueAccountId);
    const mergedStateBytes = Buffer.from(`${JSON.stringify(mergedState)}\n`, "utf8");
    if (mergedStateBytes.byteLength > MAX_ROUTER_STATE_BYTES) throw failure("router-state-capacity-exceeded");
    const ownersManifest = createHistoryAdoptionOwners({
      protocolFingerprint: intent.protocolFingerprint,
      poolFingerprint: intent.poolFingerprint,
      legacyOwnerOpaqueAccountId: intent.legacyOwnerOpaqueAccountId,
      threadIds: sourcePlan.threadIds,
      threadOwnersFingerprint: sourcePlan.threadOwnersFingerprint,
      adoptedAt,
    }, controlSecret);
    const ownersManifestBytes = Buffer.from(`${JSON.stringify(ownersManifest)}\n`, "utf8");
    if (ownersManifestBytes.byteLength > MAX_ROUTER_STATE_BYTES) throw failure("history-adoption-owners-capacity-exceeded");

    const backupRoot = uniqueSibling(paths.accountsRoot, ".history-adoption-backup", dependencies.randomId());
    transaction.ownerBackupRoot = backupRoot;
    renameExact(owner.accountRoot, backupRoot, "owner-backup");
    dependencies.beforePhase?.("after-owner-backup");
    if (fingerprintOwnerHome(backupRoot) !== owner.fingerprint) throw failure("owner-backup-fingerprint-mismatch");
    renameExact(candidateRoot, owner.accountRoot, "owner-promote");
    transaction.candidateRoot = null;
    transaction.ownerPromoted = true;
    dependencies.beforePhase?.("after-owner-promoted");
    assertCandidateOwnerShape(owner.accountRoot, candidateDatabases, candidateHistories, owner);

    const stateNext = uniqueSibling(dirname(paths.routerStateFile), ".history-adoption-router-state-next", dependencies.randomId(), ".json");
    transaction.routerStateNext = stateNext;
    writePrivateBytesNew(stateNext, mergedStateBytes);
    if (!readPrivateRegularFile(paths.routerStateFile, MAX_ROUTER_STATE_BYTES, false, "router-state").equals(latestRouterState.bytes)) {
      throw failure("router-state-changed-before-publication");
    }
    const stateBackup = uniqueSibling(dirname(paths.routerStateFile), ".history-adoption-router-state-backup", dependencies.randomId(), ".json");
    transaction.routerStateBackup = stateBackup;
    renameExact(paths.routerStateFile, stateBackup, "router-state-backup");
    dependencies.beforePhase?.("after-router-state-backup");
    renameExact(stateNext, paths.routerStateFile, "router-state-promote");
    transaction.routerStateNext = null;
    transaction.routerStatePromoted = true;
    dependencies.beforePhase?.("after-router-state-promoted");

    writePrivateBytesNew(paths.ownersFile, ownersManifestBytes);
    transaction.ownersManifestPublished = true;
    dependencies.beforePhase?.("after-owners-manifest-published");

    const receipt = createHistoryAdoptionReceipt({
      protocolFingerprint: intent.protocolFingerprint,
      poolFingerprint: intent.poolFingerprint,
      intentFingerprint: historyAdoptionIntentFingerprint(intent),
      legacyOwnerOpaqueAccountId: intent.legacyOwnerOpaqueAccountId,
      sourceFingerprint,
      destinationFingerprint,
      databases: candidateDatabases.entries,
      histories: candidateHistories.entries,
      importedThreadCount: sourcePlan.threadIds.length,
      threadOwnersFingerprint: sourcePlan.threadOwnersFingerprint,
      backupFingerprint: owner.fingerprint,
      adoptedAt,
    }, controlSecret);
    dependencies.beforePhase?.("before-receipt-publication");
    (dependencies.publishReceipt ?? writeHistoryAdoptionReceipt)(paths.receiptFile, receipt);
    transaction = null;
    return resultFor("adopted", sourceFingerprint, destinationFingerprint, intent, candidateDatabases, candidateHistories, sourcePlan);
  } catch (error) {
    if (transaction) rollbackAdoption(paths, transaction, dependencies);
    throw redactFailure(error);
  } finally {
    controlSecret?.fill(0);
  }
}

function defaultDependencies(): HistoryAdoptionDependencies {
  return {
    sqlite: defaultSqliteAdapter(),
    census: defaultCensus,
    now: () => new Date().toISOString(),
    randomId: () => randomUUID(),
  };
}

function adoptionPaths(input: AdoptAccountHistoryInput): {
  routerRoot: string;
  accountsRoot: string;
  configFile: string;
  controlSecretFile: string;
  intentFile: string;
  receiptFile: string;
  ownersFile: string;
  routerStateFile: string;
  sourceCodexRoot: string;
  sourceSqliteRoot: string;
  appPath: string;
} {
  const routerRoot = exactAbsoluteInput(input.routerRoot, "invalid-router-root");
  const sourceCodexRoot = exactAbsoluteInput(input.sourceCodexRoot, "invalid-source-codex-root");
  const sourceSqliteRoot = exactAbsoluteInput(input.sourceSqliteRoot, "invalid-source-sqlite-root");
  return {
    routerRoot,
    accountsRoot: join(routerRoot, "accounts"),
    configFile: join(routerRoot, "account-router-config.json"),
    controlSecretFile: join(routerRoot, "control-secret.v1"),
    intentFile: join(routerRoot, ACCOUNT_HISTORY_ADOPTION_INTENT_FILE),
    receiptFile: join(routerRoot, ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE),
    ownersFile: join(routerRoot, ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE),
    routerStateFile: join(routerRoot, "router-state.json"),
    sourceCodexRoot,
    sourceSqliteRoot,
    appPath: exactAbsoluteInput(input.appPath, "invalid-app-path"),
  };
}

function exactAbsoluteInput(value: string, code: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) throw failure(code);
  return value;
}

function readRouterConfig(path: string): RouterConfigForAdoption {
  const raw = boundedJson(readPrivateRegularFile(path, MAX_ARTIFACT_BYTES, false, "router-config"), "invalid-router-config");
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "schemaVersion", "mode", "policy", "generation", "fingerprint", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
  ])) throw failure("invalid-router-config");
  const mode = raw.mode;
  const policy = raw.policy;
  const generation = raw.generation;
  const fingerprint = raw.fingerprint;
  const protocolFingerprint = raw.protocolFingerprint;
  const primaryOpaqueAccountId = raw.primaryOpaqueAccountId;
  const updatedAt = raw.updatedAt;
  if (raw.schemaVersion !== 2
    || (mode !== "manual" && mode !== "quota_aware")
    || (mode === "quota_aware" ? policy !== "quota_aware_v1" : policy !== null)
    || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1
    || !isSha256Fingerprint(fingerprint)
    || protocolFingerprint !== ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT
    || !isOpaqueAccountId(primaryOpaqueAccountId)
    || !Array.isArray(raw.accounts) || raw.accounts.length !== 2
    || !isCanonicalUtcTimestamp(updatedAt)) throw failure("invalid-router-config");
  const accounts = raw.accounts.map(parseRouterAccount);
  if (accounts.some((account) => account === null)) throw failure("invalid-router-config");
  const parsedAccounts = accounts as [RouterAccountConfig, RouterAccountConfig];
  if (parsedAccounts[0].opaqueAccountId === parsedAccounts[1].opaqueAccountId
    || !parsedAccounts.some((account) => account.opaqueAccountId === primaryOpaqueAccountId)) throw failure("invalid-router-config");
  const config: RouterConfigForAdoption = {
    schemaVersion: 2,
    mode: mode as "manual" | "quota_aware",
    policy: policy as "quota_aware_v1" | null,
    generation: generation as number,
    fingerprint,
    protocolFingerprint,
    primaryOpaqueAccountId,
    accounts: parsedAccounts,
    updatedAt,
  };
  if (routerConfigFingerprint(config) !== config.fingerprint) throw failure("router-config-fingerprint-mismatch");
  return config;
}

function parseRouterAccount(value: unknown): RouterAccountConfig | null {
  if (!isRecord(value) || !hasExactKeys(value, ["opaqueAccountId", "included", "weight", "capabilityFingerprint", "label"])) return null;
  const opaqueAccountId = value.opaqueAccountId;
  const weight = value.weight;
  const capabilityFingerprint = value.capabilityFingerprint;
  const label = value.label;
  if (!isOpaqueAccountId(opaqueAccountId) || value.included !== true
    || typeof weight !== "number" || !Number.isSafeInteger(weight) || weight < 1 || weight > 100
    || !isSha256Fingerprint(capabilityFingerprint)
    || !isSafeAccountLabel(label)) return null;
  return {
    opaqueAccountId,
    included: true,
    weight: weight as number,
    capabilityFingerprint,
    label,
  };
}

function isSafeAccountLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\s+/g, " ");
  return value === normalized && value.length > 0 && value.length <= 80
    && !/[@/\\]/.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Mirrors the v2 router config writer without importing runtime source. */
export function routerConfigFingerprint(config: Pick<RouterConfigForAdoption,
  "mode" | "policy" | "generation" | "protocolFingerprint" | "primaryOpaqueAccountId" | "accounts">): Sha256Fingerprint {
  return canonicalSha256Fingerprint({
    schemaVersion: 2,
    mode: config.mode,
    policy: config.policy,
    generation: config.generation,
    protocolFingerprint: config.protocolFingerprint,
    primaryOpaqueAccountId: config.primaryOpaqueAccountId,
    accounts: config.accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      included: account.included,
      weight: account.weight,
      capabilityFingerprint: account.capabilityFingerprint,
      label: account.label,
    })),
  });
}

function assertIntentMatchesConfig(intent: HistoryAdoptionIntentV1, config: RouterConfigForAdoption): void {
  const accountIds = config.accounts.map((account) => account.opaqueAccountId);
  if (intent.protocolFingerprint !== config.protocolFingerprint
    || intent.poolFingerprint !== historyAdoptionPoolFingerprint(config.protocolFingerprint, accountIds)
    || intent.configGeneration !== config.generation
    || intent.configFingerprint !== config.fingerprint
    || !accountIds.includes(intent.legacyOwnerOpaqueAccountId)) {
    throw failure("history-adoption-intent-does-not-match-current-pool");
  }
}

function readRouterState(
  path: string,
  config: RouterConfigForAdoption,
  requireIdle: boolean,
): { value: RouterStateForAdoption; bytes: Buffer } {
  const bytes = readPrivateRegularFile(path, MAX_ROUTER_STATE_BYTES, false, "router-state");
  const raw = boundedJson(bytes, "invalid-router-state", MAX_ROUTER_STATE_BYTES);
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "schemaVersion", "protocolFingerprint", "epoch", "threadOwners", "pendingThreadOwners", "ledger",
    "reservations", "accountEligibility", "correlations", "stagedDisable",
  ])) throw failure("invalid-router-state");
  const epoch = raw.epoch;
  if (raw.schemaVersion !== 1 || raw.protocolFingerprint !== config.protocolFingerprint
    || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1
    || !isRecord(raw.threadOwners) || !isRecord(raw.pendingThreadOwners) || !isRecord(raw.ledger)
    || !isRecord(raw.accountEligibility) || !Array.isArray(raw.reservations) || !Array.isArray(raw.correlations)
    || !(raw.stagedDisable === null || isRecord(raw.stagedDisable))) throw failure("invalid-router-state");
  const configured = new Map(config.accounts.map((account) => [account.opaqueAccountId, account]));
  if (!allValidThreadOwners(raw.threadOwners, configured) || !allValidThreadOwners(raw.pendingThreadOwners, configured)
    || !validRouterLedger(raw.ledger, configured) || !validEligibility(raw.accountEligibility, configured)) {
    throw failure("invalid-router-state");
  }
  const state: RouterStateForAdoption = {
    schemaVersion: 1,
    protocolFingerprint: config.protocolFingerprint,
    epoch: epoch as number,
    threadOwners: raw.threadOwners as Record<string, OpaqueAccountId>,
    pendingThreadOwners: raw.pendingThreadOwners as Record<string, OpaqueAccountId>,
    ledger: raw.ledger as RouterStateForAdoption["ledger"],
    reservations: raw.reservations,
    accountEligibility: raw.accountEligibility as Record<string, string>,
    correlations: raw.correlations,
    stagedDisable: raw.stagedDisable as RouterStateForAdoption["stagedDisable"],
  };
  if (requireIdle && (Object.keys(state.pendingThreadOwners).length !== 0
    || state.reservations.length !== 0 || state.correlations.length !== 0 || state.stagedDisable !== null)) {
    throw failure("router-state-not-idle");
  }
  return { value: state, bytes };
}

function allValidThreadOwners(
  value: Record<string, unknown>,
  configured: ReadonlyMap<OpaqueAccountId, RouterAccountConfig>,
): boolean {
  return Object.entries(value).every(([threadId, owner]) => isCanonicalThreadId(threadId)
    && isOpaqueAccountId(owner) && configured.has(owner));
}

function validRouterLedger(
  value: Record<string, unknown>,
  configured: ReadonlyMap<OpaqueAccountId, RouterAccountConfig>,
): boolean {
  if (Object.keys(value).length !== configured.size) return false;
  return Object.entries(value).every(([owner, entry]) => {
    const account = configured.get(owner as OpaqueAccountId);
    if (!account || !isRecord(entry) || !hasExactKeys(entry, [
      "completedInputTokens", "completedOutputTokens", "reservedRequestCost", "weight", "assignedThreadCount",
    ])) return false;
    return entry.weight === account.weight
      && [entry.completedInputTokens, entry.completedOutputTokens, entry.reservedRequestCost, entry.assignedThreadCount]
        .every((number) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0);
  });
}

function validEligibility(
  value: Record<string, unknown>,
  configured: ReadonlyMap<OpaqueAccountId, RouterAccountConfig>,
): boolean {
  const allowed = new Set([
    "validating", "eligible", "reserved", "active", "cooldown", "quota_depleted", "reauth_required",
    "plugin_blocked", "protocol_blocked", "disabled", "unhealthy",
  ]);
  return Object.entries(value).every(([owner, state]) => configured.has(owner as OpaqueAccountId)
    && typeof state === "string" && allowed.has(state));
}

function inspectPreAdoptionOwner(accountsRoot: string, owner: OpaqueAccountId): PreAdoptionOwner {
  const accountRoot = containedChild(accountsRoot, owner, "owner-home");
  return inspectPreAdoptionOwnerAt(accountRoot);
}

function inspectPreAdoptionOwnerAt(accountRoot: string): PreAdoptionOwner {
  assertExactDirectory(accountRoot, "owner-home", true);
  if (!sameNames(listDirectoryNames(accountRoot), ["codex-home", "sqlite-home"])) throw failure("owner-home-not-empty");
  const codexHome = join(accountRoot, "codex-home");
  const sqliteHome = join(accountRoot, "sqlite-home");
  assertExactDirectory(codexHome, "owner-codex-home", true);
  assertExactDirectory(sqliteHome, "owner-sqlite-home", true);
  if (!sameNames(listDirectoryNames(codexHome), ["auth.json", "config.toml"]) || listDirectoryNames(sqliteHome).length !== 0) {
    throw failure("owner-home-not-empty");
  }
  const auth = readPrivateRegularFile(join(codexHome, "auth.json"), MAX_AUTH_BYTES, false, "owner-auth");
  const config = readPrivateRegularFile(join(codexHome, "config.toml"), MAX_CONFIG_BYTES, true, "owner-config");
  try {
    if (auth.byteLength === 0 || config.byteLength !== 0) throw failure("owner-home-not-hardened");
    return {
      accountRoot,
      codexHome,
      sqliteHome,
      authFingerprint: sha256Fingerprint(auth),
      configFingerprint: sha256Fingerprint(config),
      fingerprint: fingerprintOwnerHome(accountRoot),
    };
  } finally {
    auth.fill(0);
    config.fill(0);
  }
}

function fingerprintOwnerHome(accountRoot: string): Sha256Fingerprint {
  const owner = inspectOwnerTree(accountRoot, false);
  return canonicalSha256Fingerprint(owner);
}

function inspectOwnerTree(accountRoot: string, adopted: boolean): unknown {
  assertExactDirectory(accountRoot, "owner-home", true);
  const expectedRoot = ["codex-home", "sqlite-home"];
  if (!sameNames(listDirectoryNames(accountRoot), expectedRoot)) throw failure("owner-home-shape-invalid");
  const codexHome = join(accountRoot, "codex-home");
  const sqliteHome = join(accountRoot, "sqlite-home");
  assertExactDirectory(codexHome, "owner-codex-home", true);
  assertExactDirectory(sqliteHome, "owner-sqlite-home", true);
  const codexEntries = listDirectoryNames(codexHome);
  const allowedCodex = adopted
    ? ["archived_sessions", "auth.json", "config.toml", "session_index.jsonl", "sessions"]
    : ["auth.json", "config.toml"];
  if (!sameNames(codexEntries, allowedCodex)) throw failure("owner-home-shape-invalid");
  const auth = readPrivateRegularFile(join(codexHome, "auth.json"), MAX_AUTH_BYTES, false, "owner-auth");
  const config = readPrivateRegularFile(join(codexHome, "config.toml"), MAX_CONFIG_BYTES, true, "owner-config");
  const authFingerprint = sha256Fingerprint(auth);
  const configFingerprint = sha256Fingerprint(config);
  auth.fill(0);
  config.fill(0);
  if (adopted) {
    for (const tree of ["sessions", "archived_sessions"] as const) {
      if (existsSync(join(codexHome, tree))) scanHistoryTree(join(codexHome, tree), `owner-${tree}`);
    }
    if (existsSync(join(codexHome, "session_index.jsonl"))) assertRegularFile(join(codexHome, "session_index.jsonl"), "owner-session-index", false, false);
  } else if (listDirectoryNames(sqliteHome).length !== 0) {
    throw failure("owner-home-shape-invalid");
  }
  return {
    authFingerprint,
    configFingerprint,
    codexEntries,
    sqliteEntries: listDirectoryNames(sqliteHome),
  };
}

function inspectDatabases(root: string, sqlite: HistoryAdoptionSqliteAdapter): DatabaseInspection {
  assertExactDirectory(root, "sqlite-root", false);
  const paths = new Map<OfficialCodexDatabase, string>();
  const entries = OFFICIAL_CODEX_DATABASES.map((name): HistoryAdoptionDatabaseEntry => {
    const path = join(root, name);
    if (!existsSync(path)) return { name, present: false, sha256: null, bytes: 0, integrity: null };
    const stat = assertRegularFile(path, `database-${name}`, false, false);
    let integrity: "ok";
    try {
      integrity = sqlite.integrityCheck(path);
    } catch {
      throw failure("database-integrity-check-failed");
    }
    if (integrity !== "ok") throw failure("database-integrity-check-failed");
    paths.set(name, path);
    return { name, present: true, sha256: sha256File(path), bytes: stat.size, integrity: "ok" };
  });
  return { entries, paths };
}

function inspectHistories(codexRoot: string): HistoryInspection {
  assertExactDirectory(codexRoot, "codex-root", false);
  const files = new Map<"sessions" | "archived_sessions", readonly TreeFile[]>();
  const entries = CODEX_HISTORY_ARTIFACTS.map((name): HistoryAdoptionHistoryEntry => {
    const path = join(codexRoot, name);
    if (!existsSync(path)) {
      if (name !== "session_index.jsonl") files.set(name, []);
      return { name, present: false, sha256: null, bytes: 0, fileCount: 0 };
    }
    if (name === "session_index.jsonl") {
      const stat = assertRegularFile(path, "session-index", false, false);
      return { name, present: true, sha256: sha256File(path), bytes: stat.size, fileCount: 1 };
    }
    const tree = scanHistoryTree(path, name);
    files.set(name, tree);
    return {
      name,
      present: true,
      sha256: canonicalSha256Fingerprint(tree.map((entry) => ({ path: entry.relativePath, sha256: entry.sha256, bytes: entry.bytes }))),
      bytes: tree.reduce((sum, entry) => sum + entry.bytes, 0),
      fileCount: tree.length,
    };
  });
  return { entries, files };
}

function scanHistoryTree(root: string, label: string): TreeFile[] {
  assertExactDirectory(root, label, false);
  const output: TreeFile[] = [];
  const visit = (directory: string, localRoot: string): void => {
    const entries = listDirectoryNames(directory);
    for (const name of entries) {
      const path = join(directory, name);
      const local = localRoot ? `${localRoot}/${name}` : name;
      const stat = safeLstat(path, label);
      if (stat.isSymbolicLink()) throw failure("history-symlink-refused");
      if (stat.isDirectory()) {
        visit(path, local);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) throw failure("history-file-not-private-regular");
      output.push({ relativePath: local, bytes: stat.size, sha256: sha256File(path) });
      if (output.length > MAX_HISTORY_FILE_COUNT) throw failure("history-file-count-exceeded");
      const total = output.reduce((sum, entry) => sum + entry.bytes, 0);
      if (total > MAX_HISTORY_SCAN_BYTES || !Number.isSafeInteger(total)) throw failure("history-size-exceeded");
    }
  };
  visit(root, "");
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function copyHistories(sourceCodexRoot: string, candidateCodexHome: string, source: HistoryInspection): void {
  for (const name of ["sessions", "archived_sessions"] as const) {
    const entry = source.entries.find((candidate) => candidate.name === name);
    const files = source.files.get(name) ?? [];
    if (!entry?.present) continue;
    const sourceRoot = join(sourceCodexRoot, name);
    const destinationRoot = join(candidateCodexHome, name);
    mkdirPrivateDirectoryNew(destinationRoot);
    for (const file of files) {
      const target = containedChild(destinationRoot, file.relativePath, "candidate-history");
      ensurePrivateParentDirectory(destinationRoot, dirname(target));
      copyPrivateRegularFile(join(sourceRoot, file.relativePath), target, false);
      if (sha256File(target) !== file.sha256) throw failure("candidate-history-copy-mismatch");
    }
  }
  const index = source.entries.find((entry) => entry.name === "session_index.jsonl");
  if (index?.present) {
    const target = join(candidateCodexHome, "session_index.jsonl");
    copyPrivateRegularFile(join(sourceCodexRoot, "session_index.jsonl"), target, false);
    if (sha256File(target) !== index.sha256) throw failure("candidate-history-copy-mismatch");
  }
}

function cloneDatabases(
  sourceSqliteRoot: string,
  candidateSqliteRoot: string,
  source: DatabaseInspection,
  sqlite: HistoryAdoptionSqliteAdapter,
): void {
  for (const entry of source.entries) {
    if (!entry.present) continue;
    const sourcePath = source.paths.get(entry.name);
    if (!sourcePath) throw failure("database-source-missing");
    const target = join(candidateSqliteRoot, entry.name);
    if (existsSync(target)) throw failure("candidate-database-already-exists");
    try {
      sqlite.backup(sourcePath, target);
    } catch {
      throw failure("database-backup-failed");
    }
    try { chmodSync(target, PRIVATE_FILE_MODE); }
    catch { throw failure("candidate-database-permissions-failed"); }
    assertRegularFile(target, `candidate-database-${entry.name}`, true, false);
  }
  // The source root is intentionally not otherwise copied: .wal/.shm files,
  // auth/config, logs, locks, caches, plugins, and arbitrary roots stay put.
  void sourceSqliteRoot;
}

function collectImportPlan(input: {
  stateDatabasePath: string | null;
  histories: HistoryInspection;
  historyRoot: string;
  rolloutPathSourceRoot: string;
  finalOwnerCodexHome: string;
  owner: OpaqueAccountId;
  sqlite: HistoryAdoptionSqliteAdapter;
}): ImportPlan {
  const records = new Map<string, string>();
  for (const name of ["sessions", "archived_sessions"] as const) {
    const files = input.histories.files.get(name) ?? [];
    const root = join(input.historyRoot, name);
    for (const file of files) {
      const id = rolloutFirstRecordThreadId(join(root, file.relativePath));
      if (records.has(id)) throw failure("duplicate-rollout-thread-id");
      records.set(id, `${name}/${file.relativePath}`);
    }
  }

  const stateRows = input.stateDatabasePath === null ? [] : readThreadRows(input.sqlite, input.stateDatabasePath);
  const databaseIds = new Set<string>();
  const updates: HistoryAdoptionSqliteRow[] = [];
  for (const row of stateRows) {
    if (!isCanonicalThreadId(row.id) || databaseIds.has(row.id)) throw failure("invalid-or-duplicate-database-thread-id");
    databaseIds.add(row.id);
    if (row.rolloutPath === null || row.rolloutPath === "") continue;
    const resolved = resolveLegacyRolloutPath(input.rolloutPathSourceRoot, row.rolloutPath);
    const expectedLocal = `${resolved.kind}/${resolved.relativePath}`;
    const recordId = [...records.entries()].find(([, local]) => local === expectedLocal)?.[0];
    if (!recordId || recordId !== row.id) throw failure("rollout-database-disagreement");
    updates.push({
      id: row.id,
      rolloutPath: join(input.finalOwnerCodexHome, resolved.kind, resolved.relativePath),
    });
  }
  // A state row and its rollout metadata describe the same thread. Duplicates
  // within either source are rejected above; this is the intentional union.
  const threadIds = canonicalThreadIds([...new Set([...databaseIds, ...records.keys()])]);
  const threadOwners = Object.fromEntries(threadIds.map((threadId) => [threadId, input.owner])) as Record<string, OpaqueAccountId>;
  return {
    threadIds,
    threadOwners,
    threadOwnersFingerprint: historyAdoptionThreadOwnersFingerprint(threadIds, input.owner),
    updates: updates.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function readThreadRows(sqlite: HistoryAdoptionSqliteAdapter, path: string): readonly HistoryAdoptionSqliteRow[] {
  let rows: readonly HistoryAdoptionSqliteRow[];
  try {
    rows = sqlite.readThreads(path);
  } catch {
    throw failure("state-thread-read-failed");
  }
  if (!Array.isArray(rows)) throw failure("state-thread-read-failed");
  return rows.map((row) => {
    if (!isRecord(row) || !hasExactKeys(row, ["id", "rolloutPath"])
      || typeof row.id !== "string" || !(typeof row.rolloutPath === "string" || row.rolloutPath === null)) {
      throw failure("state-thread-read-failed");
    }
    return { id: row.id, rolloutPath: row.rolloutPath };
  });
}

function resolveLegacyRolloutPath(historyRoot: string, rolloutPath: string): { kind: "sessions" | "archived_sessions"; relativePath: string } {
  if (!isAbsolute(rolloutPath) || resolve(rolloutPath) !== rolloutPath) throw failure("rollout-path-escape-refused");
  for (const kind of ["sessions", "archived_sessions"] as const) {
    const root = join(historyRoot, kind);
    if (isContainedPath(root, rolloutPath)) {
      const local = relative(root, rolloutPath).split(sep).join("/");
      if (!local || local.split("/").some((part) => part === ".." || part.length === 0)) throw failure("rollout-path-escape-refused");
      const stat = assertRegularFile(rolloutPath, "rollout-path", false, false);
      if (stat.size < 0) throw failure("rollout-path-escape-refused");
      return { kind, relativePath: local };
    }
  }
  throw failure("rollout-path-escape-refused");
}

function rolloutFirstRecordThreadId(path: string): string {
  const line = readFirstLine(path, MAX_ROLLOUT_FIRST_RECORD_BYTES, "rollout-first-record");
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw failure("invalid-rollout-first-record");
  }
  let id: unknown = null;
  if (isRecord(value) && value.type === "session_meta" && isRecord(value.payload)) id = value.payload.id;
  if (id === null && isRecord(value) && isRecord(value.session_meta) && isRecord(value.session_meta.payload)) id = value.session_meta.payload.id;
  if (!isCanonicalThreadId(id)) throw failure("invalid-rollout-thread-id");
  return id;
}

function assertRewrittenThreadPaths(
  statePath: string,
  updates: readonly HistoryAdoptionSqliteRow[],
  sqlite: HistoryAdoptionSqliteAdapter,
): void {
  const actual = new Map(readThreadRows(sqlite, statePath).map((row) => [row.id, row.rolloutPath]));
  for (const update of updates) {
    if (actual.get(update.id) !== update.rolloutPath) throw failure("rollout-path-rewrite-mismatch");
  }
}

function assertDatabaseCloneShape(
  source: readonly HistoryAdoptionDatabaseEntry[],
  candidate: readonly HistoryAdoptionDatabaseEntry[],
): void {
  for (const sourceEntry of source) {
    const candidateEntry = candidate.find((entry) => entry.name === sourceEntry.name);
    if (!candidateEntry || candidateEntry.present !== sourceEntry.present || candidateEntry.integrity !== sourceEntry.integrity) {
      throw failure("candidate-database-clone-mismatch");
    }
    if (sourceEntry.present && (candidateEntry.bytes !== sourceEntry.bytes || candidateEntry.sha256 !== sourceEntry.sha256)) {
      throw failure("candidate-database-clone-mismatch");
    }
  }
}

function assertCandidateOwnerShape(
  accountRoot: string,
  databases: DatabaseInspection,
  histories: HistoryInspection,
  expectedPreAdoptionOwner?: Pick<PreAdoptionOwner, "authFingerprint" | "configFingerprint">,
): void {
  assertExactDirectory(accountRoot, "candidate-owner", true);
  if (!sameNames(listDirectoryNames(accountRoot), ["codex-home", "sqlite-home"])) throw failure("candidate-owner-shape-invalid");
  const codexHome = join(accountRoot, "codex-home");
  const sqliteHome = join(accountRoot, "sqlite-home");
  assertExactDirectory(codexHome, "candidate-codex-home", true);
  assertExactDirectory(sqliteHome, "candidate-sqlite-home", true);
  const expectedCodex = ["auth.json", "config.toml"];
  for (const entry of histories.entries) if (entry.present) expectedCodex.push(entry.name);
  if (!sameNames(listDirectoryNames(codexHome), expectedCodex)) throw failure("candidate-owner-shape-invalid");
  const expectedSqlite = databases.entries.filter((entry) => entry.present).map((entry) => entry.name);
  if (!sameNames(listDirectoryNames(sqliteHome), expectedSqlite)) throw failure("candidate-owner-shape-invalid");
  for (const entry of databases.entries) {
    if (entry.present) assertRegularFile(join(sqliteHome, entry.name), "candidate-database", true, false);
  }
  const auth = readPrivateRegularFile(join(codexHome, "auth.json"), MAX_AUTH_BYTES, false, "candidate-auth");
  const config = readPrivateRegularFile(join(codexHome, "config.toml"), MAX_CONFIG_BYTES, true, "candidate-config");
  try {
    if (config.byteLength !== 0
      || (expectedPreAdoptionOwner && (sha256Fingerprint(auth) !== expectedPreAdoptionOwner.authFingerprint
        || sha256Fingerprint(config) !== expectedPreAdoptionOwner.configFingerprint))) {
      throw failure("candidate-owner-shape-invalid");
    }
  } finally {
    auth.fill(0);
    config.fill(0);
  }
}

function assertAlreadyAdopted(input: {
  paths: ReturnType<typeof adoptionPaths>;
  config: RouterConfigForAdoption;
  intent: HistoryAdoptionIntentV1;
  receipt: HistoryAdoptionReceiptV1;
  sourceDatabases: DatabaseInspection;
  sourceHistories: HistoryInspection;
  sourceFingerprint: Sha256Fingerprint;
  sourcePlan: ImportPlan;
  sqlite: HistoryAdoptionSqliteAdapter;
}): void {
  const { paths, config, intent, receipt, sourceDatabases, sourceHistories, sourceFingerprint, sourcePlan, sqlite } = input;
  if (receipt.protocolFingerprint !== config.protocolFingerprint
    || receipt.poolFingerprint !== intent.poolFingerprint
    || receipt.intentFingerprint !== historyAdoptionIntentFingerprint(intent)
    || receipt.legacyOwnerOpaqueAccountId !== intent.legacyOwnerOpaqueAccountId
    || receipt.sourceFingerprint !== sourceFingerprint
    || receipt.importedThreadCount !== sourcePlan.threadIds.length
    || receipt.threadOwnersFingerprint !== sourcePlan.threadOwnersFingerprint) {
    throw failure("history-adoption-receipt-conflicts-with-current-state");
  }
  const owners = parseHistoryAdoptionOwners(readPrivateRegularFile(paths.ownersFile, MAX_ROUTER_STATE_BYTES, false, "history-adoption-owners"));
  const secret = readPrivateRegularFile(paths.controlSecretFile, 64, false, "control-secret");
  try {
    if (!verifyHistoryAdoptionOwners(owners, secret)
      || owners.protocolFingerprint !== receipt.protocolFingerprint
      || owners.poolFingerprint !== receipt.poolFingerprint
      || owners.legacyOwnerOpaqueAccountId !== receipt.legacyOwnerOpaqueAccountId
      || owners.threadOwnersFingerprint !== receipt.threadOwnersFingerprint
      || owners.adoptedAt !== receipt.adoptedAt
      || canonicalJson(owners.threadIds) !== canonicalJson(sourcePlan.threadIds)) {
      throw failure("history-adoption-owners-conflict");
    }
  } finally {
    secret.fill(0);
  }
  const ownerRoot = containedChild(paths.accountsRoot, intent.legacyOwnerOpaqueAccountId, "owner-home");
  const ownerCodex = join(ownerRoot, "codex-home");
  const ownerSqlite = join(ownerRoot, "sqlite-home");
  const destinationDatabases = inspectDatabases(ownerSqlite, sqlite);
  const destinationHistories = inspectHistories(ownerCodex);
  if (adoptionContentFingerprint(destinationDatabases.entries, destinationHistories.entries) !== receipt.destinationFingerprint
    || !canonicalEqual(destinationDatabases.entries, receipt.databases)
    || !canonicalEqual(destinationHistories.entries, receipt.histories)) {
    throw failure("history-adoption-destination-conflict");
  }
  const backupPaths = matchingBackups(paths.accountsRoot, receipt.backupFingerprint);
  if (backupPaths.length !== 1) throw failure("history-adoption-backup-conflict");
  assertCandidateOwnerShape(ownerRoot, destinationDatabases, destinationHistories, inspectPreAdoptionOwnerAt(backupPaths[0]!));
  const state = readRouterState(paths.routerStateFile, config, false).value;
  for (const id of owners.threadIds) {
    if (state.threadOwners[id] !== intent.legacyOwnerOpaqueAccountId) throw failure("history-adoption-thread-owner-conflict");
  }
  // Keep all source evidence referenced so a future reviewer can see that the
  // receipt was checked against the current allowed source set, not filenames.
  void sourceDatabases;
  void sourceHistories;
}

function matchingBackups(accountsRoot: string, fingerprint: Sha256Fingerprint): string[] {
  const matches: string[] = [];
  for (const name of listDirectoryNames(accountsRoot)) {
    if (!name.startsWith(".history-adoption-backup-")) continue;
    const candidate = join(accountsRoot, name);
    try {
      if (fingerprintOwnerHome(candidate) === fingerprint) matches.push(candidate);
    } catch {
      // A malformed preserved diagnostic is not ignored as a valid backup.
    }
  }
  return matches;
}

function mergeThreadOwners(
  state: RouterStateForAdoption,
  imported: Readonly<Record<string, OpaqueAccountId>>,
  owner: OpaqueAccountId,
): RouterStateForAdoption {
  const threadOwners = { ...state.threadOwners };
  for (const [threadId, expectedOwner] of Object.entries(imported)) {
    if (expectedOwner !== owner || Object.prototype.hasOwnProperty.call(threadOwners, threadId)) {
      throw failure("history-adoption-thread-owner-collision");
    }
    threadOwners[threadId] = owner;
  }
  return { ...state, threadOwners };
}

function assertNoThreadOwnerCollisions(existing: Record<string, OpaqueAccountId>, importedThreadIds: readonly string[]): void {
  if (importedThreadIds.some((threadId) => Object.prototype.hasOwnProperty.call(existing, threadId))) {
    throw failure("history-adoption-thread-owner-collision");
  }
}

function createCandidateOwner(candidate: string): void {
  mkdirPrivateDirectoryNew(candidate);
  mkdirPrivateDirectoryNew(join(candidate, "codex-home"));
  mkdirPrivateDirectoryNew(join(candidate, "sqlite-home"));
}

function clonePreAdoptionOwner(owner: PreAdoptionOwner, candidateRoot: string): void {
  copyPrivateRegularFile(join(owner.codexHome, "auth.json"), join(candidateRoot, "codex-home", "auth.json"), true);
  copyPrivateRegularFile(join(owner.codexHome, "config.toml"), join(candidateRoot, "codex-home", "config.toml"), true);
  const auth = readPrivateRegularFile(join(candidateRoot, "codex-home", "auth.json"), MAX_AUTH_BYTES, false, "candidate-auth");
  const config = readPrivateRegularFile(join(candidateRoot, "codex-home", "config.toml"), MAX_CONFIG_BYTES, true, "candidate-config");
  try {
    if (config.byteLength !== 0 || sha256Fingerprint(auth) !== owner.authFingerprint
      || sha256Fingerprint(config) !== owner.configFingerprint) {
      throw failure("candidate-owner-clone-mismatch");
    }
  } finally {
    auth.fill(0);
    config.fill(0);
  }
}

function renameExact(source: string, destination: string, label: string): void {
  const sourceStat = safeLstat(source, label);
  const destinationParent = safeLstat(dirname(destination), label);
  if (sourceStat.dev !== destinationParent.dev || existsSync(destination)) throw failure("unsafe-adoption-rename");
  try {
    renameSync(source, destination);
  } catch {
    throw failure("adoption-rename-failed");
  }
}

function rollbackAdoption(
  paths: ReturnType<typeof adoptionPaths>,
  transaction: ActiveTransaction,
  dependencies: HistoryAdoptionDependencies,
): void {
  const rollbackFailures: string[] = [];
  const preserve = (path: string, prefix: string, suffix = ""): void => {
    if (!existsSync(path)) return;
    try { renameExact(path, uniqueSibling(dirname(path), prefix, dependencies.randomId(), suffix), "failed-adoption-preserve"); }
    catch { rollbackFailures.push("preserve"); }
  };
  // Receipt is normally absent on a throwing publication. If a faulty writer
  // left one behind, retain it under a diagnostic name before restoring state.
  preserve(transaction.receiptPath, ".history-adoption-failed-receipt", ".json");
  if (transaction.ownersManifestPublished || existsSync(paths.ownersFile)) {
    preserve(paths.ownersFile, ".history-adoption-failed-owners", ".json");
  }
  if (transaction.routerStatePromoted) {
    preserve(paths.routerStateFile, ".history-adoption-failed-router-state", ".json");
    if (transaction.routerStateBackup && existsSync(transaction.routerStateBackup)) {
      try { renameExact(transaction.routerStateBackup, paths.routerStateFile, "router-state-rollback"); }
      catch { rollbackFailures.push("router-state"); }
    }
  } else if (transaction.routerStateBackup && existsSync(transaction.routerStateBackup) && !existsSync(paths.routerStateFile)) {
    try { renameExact(transaction.routerStateBackup, paths.routerStateFile, "router-state-rollback"); }
    catch { rollbackFailures.push("router-state"); }
  }
  if (transaction.routerStateNext) preserve(transaction.routerStateNext, ".history-adoption-failed-router-state-next", ".json");

  // Preserve the promoted candidate first, then restore the exact retained
  // pre-adoption sibling to its recorded original account root.
  if (transaction.ownerPromoted && transaction.ownerBackupRoot) {
    preserve(transaction.ownerRoot, ".history-adoption-failed-candidate");
    if (existsSync(transaction.ownerBackupRoot) && !existsSync(transaction.ownerRoot)) {
      try { renameExact(transaction.ownerBackupRoot, transaction.ownerRoot, "owner-rollback"); }
      catch { rollbackFailures.push("owner"); }
    }
  } else if (transaction.ownerBackupRoot) {
    if (existsSync(transaction.ownerBackupRoot) && !existsSync(transaction.ownerRoot)) {
      try { renameExact(transaction.ownerBackupRoot, transaction.ownerRoot, "owner-rollback"); }
      catch { rollbackFailures.push("owner"); }
    }
  }
  if (transaction.candidateRoot) preserve(transaction.candidateRoot, ".history-adoption-failed-candidate");
  if (rollbackFailures.length > 0) throw failure("history-adoption-rollback-incomplete");
}

function writeHistoryAdoptionReceipt(path: string, receipt: HistoryAdoptionReceiptV1): void {
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw failure("history-adoption-receipt-capacity-exceeded");
  writePrivateBytesNew(path, bytes);
}

function resultFor(
  status: HistoryAdoptionResult["status"],
  sourceFingerprint: Sha256Fingerprint,
  destinationFingerprint: Sha256Fingerprint | null,
  intent: HistoryAdoptionIntentV1,
  databases: DatabaseInspection,
  histories: HistoryInspection,
  plan: ImportPlan,
): HistoryAdoptionResult {
  return {
    status,
    importedThreadCount: plan.threadIds.length,
    sourceFingerprint,
    destinationFingerprint,
    poolFingerprint: intent.poolFingerprint,
    intentFingerprint: historyAdoptionIntentFingerprint(intent),
    databasesPresent: databases.entries.filter((entry) => entry.present).length,
    historyFiles: histories.entries.reduce((count, entry) => count + entry.fileCount, 0),
    nextAction: status === "dry-run"
      ? "review-and-apply"
      : status === "adopted"
        ? "restart-remains-user-confirmed"
        : "none",
  };
}

function protectedPaths(paths: ReturnType<typeof adoptionPaths>): readonly string[] {
  return [paths.sourceCodexRoot, paths.sourceSqliteRoot, paths.accountsRoot, paths.routerRoot];
}

function assertIdleCensus(census: HistoryAdoptionCensus): void {
  if (!isRecord(census) || census.app !== "idle" || census.main !== "idle" || census.appServer !== "idle"
    || !Number.isSafeInteger(census.openFileCount) || census.openFileCount !== 0
    || !isCanonicalUtcTimestamp(census.observedAt)) {
    throw failure("app-or-router-not-idle");
  }
}

function defaultSqliteAdapter(): HistoryAdoptionSqliteAdapter {
  const invoke = (path: string, args: readonly string[], input?: string): string => {
    const result = spawnSync("/usr/bin/sqlite3", [...args, path], {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") throw failure("sqlite-command-failed");
    return result.stdout;
  };
  return {
    backup(source, destination) {
      if (existsSync(destination)) throw failure("candidate-database-already-exists");
      const backupCommand = `.backup ${sqliteStringLiteral(destination)}`;
      const result = spawnSync("/usr/bin/sqlite3", [source, backupCommand], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error || result.status !== 0) throw failure("database-backup-failed");
    },
    integrityCheck(path) {
      const result = invoke(path, [], "PRAGMA integrity_check;\n").trim();
      if (result !== "ok") throw failure("database-integrity-check-failed");
      return "ok";
    },
    readThreads(path) {
      const output = invoke(path, ["-json"], "SELECT id AS id, rollout_path AS rolloutPath FROM threads ORDER BY id;\n");
      let parsed: unknown;
      try { parsed = JSON.parse(output) as unknown; }
      catch { throw failure("state-thread-read-failed"); }
      if (!Array.isArray(parsed)) throw failure("state-thread-read-failed");
      return parsed.map((row) => {
        if (!isRecord(row) || !hasExactKeys(row, ["id", "rolloutPath"])
          || typeof row.id !== "string" || !(typeof row.rolloutPath === "string" || row.rolloutPath === null)) {
          throw failure("state-thread-read-failed");
        }
        return { id: row.id, rolloutPath: row.rolloutPath };
      });
    },
    rewriteThreadRolloutPaths(path, updates) {
      const statements = ["BEGIN IMMEDIATE;"];
      for (const update of updates) {
        if (update.rolloutPath === null) throw failure("invalid-rollout-rewrite");
        statements.push(`UPDATE threads SET rollout_path=${sqliteStringLiteral(update.rolloutPath)} WHERE id=${sqliteStringLiteral(update.id)};`);
      }
      statements.push("COMMIT;");
      invoke(path, [], `${statements.join("\n")}\n`);
    },
  };
}

/**
 * An observation-only default. It never signals, starts, stops, or restarts
 * anything. If either census source is unavailable it reports unknown and the
 * caller fails closed before a candidate write.
 */
function defaultCensus(input: { appPath: string; protectedPaths: readonly string[] }): HistoryAdoptionCensus {
  const observedAt = new Date().toISOString();
  try {
    const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (ps.error || ps.status !== 0 || typeof ps.stdout !== "string") return unknownCensus(observedAt);
    const processCensus = historyAdoptionProcessCensus(ps.stdout, input.appPath);
    let openFileCount = 0;
    for (const path of input.protectedPaths) {
      const lsof = spawnSync("/usr/sbin/lsof", ["-nP", "+D", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      // lsof exits 1 when it found no matches. Any other failure is unknown.
      if (lsof.error || (lsof.status !== 0 && lsof.status !== 1)) return unknownCensus(observedAt);
      if (typeof lsof.stdout === "string") {
        openFileCount += lsof.stdout.split("\n").filter((line) => line.trim().length > 0).length;
      }
    }
    return {
      app: processCensus.app,
      main: processCensus.main,
      appServer: processCensus.appServer,
      openFileCount,
      observedAt,
    };
  } catch {
    return unknownCensus(observedAt);
  }
}

function unknownCensus(observedAt: string): HistoryAdoptionCensus {
  return { app: "unknown", main: "unknown", appServer: "unknown", openFileCount: -1, observedAt };
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertExactDirectory(path: string, label: string, ownerPrivate: boolean): void {
  const stat = safeLstat(path, label);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(`${label}-unsafe`);
  let real: string;
  try { real = realpathSync(path); }
  catch { throw failure(`${label}-unsafe`); }
  if (real !== path) throw failure(`${label}-symlink-refused`);
  if (ownerPrivate && !isOwnerPrivate(stat)) throw failure(`${label}-not-private`);
}

function assertRegularFile(path: string, label: string, ownerPrivate: boolean, allowEmpty: boolean): Stats {
  const stat = safeLstat(path, label);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (!allowEmpty && stat.size <= 0)) {
    throw failure(`${label}-unsafe`);
  }
  if (ownerPrivate && !isOwnerPrivate(stat)) throw failure(`${label}-not-private`);
  return stat;
}

function readPrivateRegularFile(path: string, maxBytes: number, allowEmpty: boolean, label: string): Buffer {
  const stat = assertRegularFile(path, label, true, allowEmpty);
  if (stat.size > maxBytes) throw failure(`${label}-capacity-exceeded`);
  let descriptor: number | undefined;
  let value: Buffer | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = statSync(path);
    if (!before.isFile() || before.nlink !== 1 || !isOwnerPrivate(before) || before.size !== stat.size) throw failure(`${label}-unsafe`);
    value = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < value.byteLength) {
      const count = readSync(descriptor, value, offset, value.byteLength - offset, offset);
      if (count <= 0) throw failure(`${label}-read-failed`);
      offset += count;
    }
    const after = safeLstat(path, label);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw failure(`${label}-changed-during-read`);
    }
    return value;
  } catch (error) {
    value?.fill(0);
    throw error instanceof AdoptionFailure ? error : failure(`${label}-read-failed`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function copyPrivateRegularFile(source: string, destination: string, ownerPrivate: boolean): void {
  const sourceStat = assertRegularFile(source, "copy-source", ownerPrivate, true);
  if (existsSync(destination)) throw failure("copy-destination-exists");
  const bytes = readFileSync(source);
  const after = safeLstat(source, "copy-source");
  if (after.dev !== sourceStat.dev || after.ino !== sourceStat.ino || after.size !== sourceStat.size || after.mtimeMs !== sourceStat.mtimeMs) {
    bytes.fill(0);
    throw failure("copy-source-changed");
  }
  try {
    writePrivateBytesNew(destination, bytes);
  } finally {
    bytes.fill(0);
  }
}

function writePrivateJsonNew(path: string, value: unknown): void {
  writePrivateBytesNew(path, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

function writePrivateBytesNew(path: string, bytes: Buffer): void {
  if (bytes.byteLength > MAX_ROUTER_STATE_BYTES && basename(path) === ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE) {
    throw failure("history-adoption-owners-capacity-exceeded");
  }
  if (existsSync(path)) throw failure("private-file-already-exists");
  assertExactDirectory(dirname(path), "private-write-parent", true);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(path, PRIVATE_FILE_MODE);
    assertRegularFile(path, "private-written-file", true, true);
    fsyncDirectory(dirname(path));
  } catch (error) {
    throw error instanceof AdoptionFailure ? error : failure("private-write-failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function mkdirPrivateDirectoryNew(path: string): void {
  if (existsSync(path)) throw failure("private-directory-already-exists");
  assertExactDirectory(dirname(path), "private-directory-parent", true);
  try { mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE }); }
  catch { throw failure("private-directory-create-failed"); }
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  assertExactDirectory(path, "private-directory", true);
}

function ensurePrivateParentDirectory(root: string, targetDirectory: string): void {
  if (targetDirectory !== root && !isContainedPath(root, targetDirectory)) throw failure("candidate-history-path-escape");
  let cursor = root;
  const local = relative(root, targetDirectory);
  if (!local) return;
  for (const part of local.split(sep)) {
    if (!part || part === "." || part === "..") throw failure("candidate-history-path-escape");
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirPrivateDirectoryNew(cursor);
    else assertExactDirectory(cursor, "candidate-history-parent", true);
  }
}

function listDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path).sort((left, right) => left.localeCompare(right));
  } catch {
    throw failure("directory-read-failed");
  }
}

function safeLstat(path: string, label: string): Stats {
  try { return lstatSync(path); }
  catch { throw failure(`${label}-missing-or-unsafe`); }
}

function isOwnerPrivate(stat: Stats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return (uid === null || stat.uid === uid) && (stat.mode & 0o077) === 0;
}

function sha256File(path: string): Sha256Fingerprint {
  const stat = assertRegularFile(path, "hash-source", false, true);
  const bytes = readFileSync(path);
  try {
    const after = safeLstat(path, "hash-source");
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw failure("hash-source-changed");
    }
    return sha256Fingerprint(bytes);
  } finally {
    bytes.fill(0);
  }
}

function readFirstLine(path: string, maxBytes: number, label: string): string {
  const stat = assertRegularFile(path, label, false, false);
  const bytesToRead = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    const newline = buffer.subarray(0, offset).indexOf(0x0a);
    if (newline < 0) throw failure(`${label}-too-large-or-missing-newline`);
    return buffer.subarray(0, newline).toString("utf8");
  } catch (error) {
    throw error instanceof AdoptionFailure ? error : failure(`${label}-read-failed`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    buffer.fill(0);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // APFS can reject directory fsync. The file fsync plus same-directory
    // rename still provides the bounded, non-destructive transaction path.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function boundedJson(bytes: Buffer | string, code: string, limit = MAX_ARTIFACT_BYTES): unknown {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  if (buffer.byteLength > limit) throw failure(`${code}-capacity-exceeded`);
  try { return JSON.parse(buffer.toString("utf8")) as unknown; }
  catch { throw failure(code); }
}

function assertReceiptPayload(input: CreateHistoryAdoptionReceiptInput): void {
  assertProtocolFingerprint(input.protocolFingerprint);
  for (const value of [
    input.poolFingerprint,
    input.intentFingerprint,
    input.sourceFingerprint,
    input.destinationFingerprint,
    input.threadOwnersFingerprint,
    input.backupFingerprint,
  ]) assertFingerprint(value, "invalid-history-adoption-receipt");
  if (!isOpaqueAccountId(input.legacyOwnerOpaqueAccountId)) throw failure("invalid-history-adoption-receipt");
  assertDatabaseEntries(input.databases);
  assertHistoryEntries(input.histories);
  if (!Number.isSafeInteger(input.importedThreadCount) || input.importedThreadCount < 0) {
    throw failure("invalid-history-adoption-receipt");
  }
  assertCanonicalTimestamp(input.adoptedAt, "invalid-history-adoption-receipt");
  const candidate: Omit<HistoryAdoptionReceiptV1, "hmac"> = {
    schemaVersion: ACCOUNT_HISTORY_ADOPTION_SCHEMA_VERSION,
    kind: "account-router-history-adoption-receipt",
    protocolFingerprint: input.protocolFingerprint,
    poolFingerprint: input.poolFingerprint,
    intentFingerprint: input.intentFingerprint,
    legacyOwnerOpaqueAccountId: input.legacyOwnerOpaqueAccountId,
    sourceFingerprint: input.sourceFingerprint,
    destinationFingerprint: input.destinationFingerprint,
    databases: cloneDatabaseEntries(input.databases),
    histories: cloneHistoryEntries(input.histories),
    importedThreadCount: input.importedThreadCount,
    threadOwnersFingerprint: input.threadOwnersFingerprint,
    backupFingerprint: input.backupFingerprint,
    adoptedAt: input.adoptedAt,
  };
  if (Buffer.byteLength(canonicalJson(candidate), "utf8") > MAX_ARTIFACT_BYTES) {
    throw failure("history-adoption-receipt-capacity-exceeded");
  }
}

function assertDatabaseEntries(entries: readonly HistoryAdoptionDatabaseEntry[]): void {
  if (!Array.isArray(entries) || entries.length !== OFFICIAL_CODEX_DATABASES.length) throw failure("invalid-history-adoption-databases");
  for (let index = 0; index < OFFICIAL_CODEX_DATABASES.length; index += 1) {
    const entry = entries[index];
    const bytes = entry.bytes;
    if (!isRecord(entry) || !hasExactKeys(entry, ["name", "present", "sha256", "bytes", "integrity"])
      || entry.name !== OFFICIAL_CODEX_DATABASES[index] || typeof entry.present !== "boolean"
      || !Number.isSafeInteger(bytes) || bytes < 0) throw failure("invalid-history-adoption-databases");
    if (entry.present) {
      if (!isSha256Fingerprint(entry.sha256) || bytes <= 0 || entry.integrity !== "ok") throw failure("invalid-history-adoption-databases");
    } else if (entry.sha256 !== null || bytes !== 0 || entry.integrity !== null) {
      throw failure("invalid-history-adoption-databases");
    }
  }
}

function assertHistoryEntries(entries: readonly HistoryAdoptionHistoryEntry[]): void {
  if (!Array.isArray(entries) || entries.length !== CODEX_HISTORY_ARTIFACTS.length) throw failure("invalid-history-adoption-histories");
  for (let index = 0; index < CODEX_HISTORY_ARTIFACTS.length; index += 1) {
    const entry = entries[index];
    const bytes = entry.bytes;
    const fileCount = entry.fileCount;
    if (!isRecord(entry) || !hasExactKeys(entry, ["name", "present", "sha256", "bytes", "fileCount"])
      || entry.name !== CODEX_HISTORY_ARTIFACTS[index] || typeof entry.present !== "boolean"
      || !Number.isSafeInteger(bytes) || bytes < 0
      || !Number.isSafeInteger(fileCount) || fileCount < 0) throw failure("invalid-history-adoption-histories");
    if (entry.present) {
      if (!isSha256Fingerprint(entry.sha256)) throw failure("invalid-history-adoption-histories");
    } else if (entry.sha256 !== null || bytes !== 0 || fileCount !== 0) {
      throw failure("invalid-history-adoption-histories");
    }
  }
}

function cloneDatabaseEntries(entries: readonly HistoryAdoptionDatabaseEntry[]): HistoryAdoptionDatabaseEntry[] {
  assertDatabaseEntries(entries);
  return entries.map((entry) => ({ ...entry }));
}

function cloneHistoryEntries(entries: readonly HistoryAdoptionHistoryEntry[]): HistoryAdoptionHistoryEntry[] {
  assertHistoryEntries(entries);
  return entries.map((entry) => ({ ...entry }));
}

function adoptionContentFingerprint(
  databases: readonly HistoryAdoptionDatabaseEntry[],
  histories: readonly HistoryAdoptionHistoryEntry[],
): Sha256Fingerprint {
  assertDatabaseEntries(databases);
  assertHistoryEntries(histories);
  return canonicalSha256Fingerprint({ databases: cloneDatabaseEntries(databases), histories: cloneHistoryEntries(histories) });
}

function canonicalPoolIds(ids: readonly OpaqueAccountId[]): OpaqueAccountId[] {
  if (!Array.isArray(ids) || ids.length !== 2 || ids.some((id) => !isOpaqueAccountId(id))) throw failure("invalid-account-pool");
  // Use code-unit ordering, matching the runtime verifier rather than the
  // host locale, so HMAC-bound fingerprints are portable.
  const sorted = [...ids].sort();
  if (sorted[0] === sorted[1]) throw failure("invalid-account-pool");
  return sorted;
}

function canonicalThreadIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.some((id) => !isCanonicalThreadId(id))) throw failure("invalid-history-adoption-thread-id");
  const sorted = [...ids].sort();
  if (sorted.some((id, index) => index > 0 && sorted[index - 1] === id)) throw failure("duplicate-history-adoption-thread-id");
  return sorted;
}

function isCanonicalThreadId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function assertProtocolFingerprint(value: unknown): asserts value is Sha256Fingerprint {
  if (value !== ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT) throw failure("unsupported-history-adoption-protocol");
}

function assertFingerprint(value: unknown, code: string): asserts value is Sha256Fingerprint {
  if (!isSha256Fingerprint(value)) throw failure(code);
}

function assertPositiveInteger(value: unknown, code: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw failure(code);
}

function assertCanonicalTimestamp(value: unknown, code: string): asserts value is string {
  if (!isCanonicalUtcTimestamp(value)) throw failure(code);
}

function canonicalNow(value: string): string {
  if (!isCanonicalUtcTimestamp(value)) throw failure("invalid-adoption-clock");
  return value;
}

function hmacPayload(secret: Buffer, payload: unknown): HmacSha256 {
  assertControlSecret(secret);
  return `hmac-sha256:${createHmac("sha256", secret).update(canonicalJson(payload), "utf8").digest("hex")}`;
}

function assertControlSecret(value: Buffer): void {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) throw failure("invalid-control-secret");
}

function isHmacSha256(value: unknown): value is HmacSha256 {
  return typeof value === "string" && /^hmac-sha256:[a-f0-9]{64}$/.test(value);
}

function secureEqualHmac(left: HmacSha256, right: HmacSha256): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try { return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes); }
  finally { leftBytes.fill(0); rightBytes.fill(0); }
}

function withoutHmac<T extends { hmac: unknown }>(value: T): Omit<T, "hmac"> {
  const { hmac: _hmac, ...payload } = value;
  return payload;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return canonicalJson([...actual].sort()) === canonicalJson([...expected].sort());
}

function isContainedPath(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath.length > 0 && !relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath);
}

function containedChild(root: string, local: string, code: string): string {
  if (!local || isAbsolute(local) || local.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw failure(`${code}-path-escape`);
  const candidate = resolve(root, local);
  if (!isContainedPath(root, candidate)) throw failure(`${code}-path-escape`);
  return candidate;
}

function uniqueSibling(parent: string, prefix: string, random: string, suffix = ""): string {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(random)) throw failure("invalid-adoption-random-id");
  assertExactDirectory(parent, "adoption-parent", true);
  const candidate = join(parent, `${prefix}-${random}${suffix}`);
  if (!isContainedPath(parent, candidate) || existsSync(candidate)) throw failure("adoption-sibling-conflict");
  return candidate;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); }
  catch { return false; }
}

function assertCanonicalEqual(left: unknown, right: unknown, code: string): void {
  if (!canonicalEqual(left, right)) throw failure(code);
}

class AdoptionFailure extends Error {
  constructor(readonly code: string) {
    super(`History adoption stopped safely: ${code}`);
    this.name = "AdoptionFailure";
  }
}

function failure(code: string): AdoptionFailure {
  return new AdoptionFailure(code);
}

function redactFailure(error: unknown): Error {
  if (error instanceof AdoptionFailure) return error;
  return failure("unexpected-history-adoption-failure");
}
