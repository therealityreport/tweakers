import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_HISTORY_ADOPTION_INTENT_FILE,
  ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE,
  ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE,
  HISTORY_ADOPTION_MAX_ARTIFACT_BYTES,
  HISTORY_ADOPTION_MAX_OWNERS_BYTES,
  historyAdoptionIntentFingerprint,
  historyAdoptionPoolFingerprint,
  parseHistoryAdoptionIntent,
  parseHistoryAdoptionOwners,
  parseHistoryAdoptionReceipt,
  verifyHistoryAdoptionIntent,
  verifyHistoryAdoptionOwners,
  verifyHistoryAdoptionReceipt,
} from "./account-history-adoption.js";

const ACCOUNT_SWITCHER_TWEAK_ID = "co.tweakers.account-switcher";
const ACCOUNT_ROUTER_CONFIG_FILE = "account-router-config.json";
const ACCOUNT_ROUTER_CONTROL_SECRET_FILE = "control-secret.v1";
const ACCOUNT_ROUTER_CONTROL_SOCKET_FILE = "router-control.v1.sock";
const CONTROL_FRAME_LIMIT = 4 * 1024;
const CONTROL_TIMEOUT_MS = 2_000;
const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 100;
const ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT =
  "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10";
const REQUIRED_ACCOUNT_ROUTER_RUNTIME_FILES = [
  "main.js",
  "account-router/app-server-mux.js",
  "account-router/control-socket.js",
  "account-router/history-adoption.js",
  "account-router/quota.js",
  "tweaks/co.tweakers.account-switcher/index.js",
] as const;

export type EvidenceState = "present" | "missing" | "invalid";

export interface AccountRouterArtifactEvidence {
  state: EvidenceState;
  version: string | null;
}

/**
 * Source provenance is intentionally more specific than a bundled artifact:
 * it must come from the one checkout registered for development snapshots.
 */
export interface AccountRouterSourceEvidence {
  state: EvidenceState | "unavailable";
  version: string | null;
  unavailableReason?: "not_registered" | "registration_stale";
}

export interface AccountRouterConfigurationEvidence {
  state: "not_staged" | "manual" | "balanced" | "quota_aware" | "invalid" | "unsafe";
  pending: AccountRouterPendingConfiguration | null;
}

/** Kept out of the rendered evidence projection because it contains account IDs. */
interface V2HistoryAdoptionConfiguration {
  protocolFingerprint: `sha256:${string}`;
  accountOpaqueIds: [`ar_${string}`, `ar_${string}`];
}

const v2HistoryAdoptionConfigurations = new WeakMap<AccountRouterConfigurationEvidence, V2HistoryAdoptionConfiguration>();

/**
 * Readiness is intentionally a small finite projection of private signed
 * artifacts. It never exposes owner IDs, paths, HMACs, timestamps, or counts.
 */
export type AccountRouterHistoryAdoptionState =
  | "not_applicable"
  | "required"
  | "pending_offline_adoption"
  | "adopted"
  | "invalid"
  | "mismatch";

export interface AccountRouterHistoryAdoptionEvidence {
  state: AccountRouterHistoryAdoptionState;
}

/**
 * This is disk intent only. It is never evidence that a newly staged router
 * process is running; only the authenticated control socket can establish
 * active truth.
 */
export interface AccountRouterPendingConfiguration {
  schemaVersion: 1 | 2;
  mode: "manual" | "balanced" | "quota_aware";
  policy: "quota_aware_v1" | null;
  generation: number | null;
  fingerprint: string | null;
}

export interface AccountRouterLiveAccount {
  label: string;
  eligibility: "validating" | "eligible" | "reserved" | "active" | "cooldown" | "quota_depleted" | "reauth_required" | "plugin_blocked" | "protocol_blocked" | "disabled" | "unhealthy";
  plan: string | null;
  identifierMasked: string | null;
  weekly: AccountRouterWeeklyProjection | null;
  shortWindowPressure: number | null;
  /** Legacy v1 local token estimate; never provider quota. */
  normalizedSpend: number;
  assignedThreadCount: number;
}

export interface AccountRouterWeeklyProjection {
  remainingPercent: number | null;
  resetAt: string | null;
  freshness: "fresh" | "stale" | "unknown";
}

export interface AccountRouterLiveStatus {
  schemaVersion: 1 | 2;
  active: AccountRouterActiveConfiguration;
  pending: AccountRouterLivePendingConfiguration | null;
  protocolState: "supported" | "unsupported" | "drifted" | "unknown";
  accounts: AccountRouterLiveAccount[];
  restartRequired: boolean;
  poolRemainingPercent: number | null;
  degradedReason: AccountRouterDegradedReason | null;
}

export type AccountRouterDegradedReason =
  | "invalid_config"
  | "unsupported_protocol"
  | "startup_selfcheck_failed"
  | "pool_depleted"
  | "capability_mismatch"
  | "policy_stop"
  | "post_start_failure"
  | "account_unauthenticated"
  | "account_disabled"
  | "account_unhealthy"
  | "quota_depleted"
  | "quota_stale"
  | "quota_unknown";

export interface AccountRouterActiveConfiguration {
  mode: "manual" | "balanced" | "direct_fallback" | "quota_aware";
  policy: "quota_aware_v1" | null;
  generation: number | null;
  fingerprint: string | null;
  /** Present only for the legacy v1 local-token projection. */
  fairnessPrecision?: "projected" | "exact_completed_spend" | "estimated";
}

export interface AccountRouterLivePendingConfiguration {
  mode: "manual" | "quota_aware";
  policy: "quota_aware_v1" | null;
  generation: number;
  fingerprint: string;
}

export interface AccountRouterLiveEvidence {
  state: "active" | "not_running" | "unavailable" | "not_applicable";
  status: AccountRouterLiveStatus | null;
}

export interface AccountRouterEvidence {
  source: AccountRouterSourceEvidence;
  candidate: AccountRouterArtifactEvidence;
  installed: AccountRouterArtifactEvidence;
  configuration: AccountRouterConfigurationEvidence;
  historyAdoption: AccountRouterHistoryAdoptionEvidence;
  live: AccountRouterLiveEvidence;
}

export interface InspectAccountRouterOptions {
  userRoot: string;
  /** The one development checkout registered in config.json, if any. */
  registeredDevelopmentSourceRoot?: string | null;
  candidateRuntimeRoot?: string;
  installedRuntimeRoot?: string;
}

/**
 * Observes four intentionally separate layers. Source is a recorded checkout,
 * candidate is the runtime carried by this installer package, installed is the
 * user-dir runtime, pending is validated disk intent, and live is the
 * authenticated mux control response. Pending and active are intentionally
 * never inferred from each other.
 */
export async function inspectAccountRouter(options: InspectAccountRouterOptions): Promise<AccountRouterEvidence> {
  const routerRoot = accountRouterDataRoot(options.userRoot);
  const configuration = inspectRouterConfiguration(routerRoot);
  return {
    source: inspectRegisteredSourceManifest(options.registeredDevelopmentSourceRoot ?? null),
    candidate: inspectRuntimeArtifacts(options.candidateRuntimeRoot ?? bundledRuntimeRoot()),
    installed: inspectRuntimeArtifacts(options.installedRuntimeRoot ?? join(options.userRoot, "runtime")),
    configuration,
    historyAdoption: inspectHistoryAdoption(routerRoot, configuration),
    // A manual/directed disk rollback must not hide an already running mux.
    // The discoverable owner-private socket is the sole live oracle.
    live: await readLiveAccountRouterStatus(routerRoot),
  };
}

/**
 * Reads the single development-checkout registration without exposing its path
 * in Account Router evidence. Callers still validate the realpath before use.
 */
export function readRegisteredDevelopmentSourceRoot(config: unknown): string | null {
  if (!isRecord(config) || !isRecord(config.tweaker)) return null;
  const sourceRoot = config.tweaker.developmentSourceRoot;
  return typeof sourceRoot === "string" && sourceRoot.length > 0 ? sourceRoot : null;
}

export function accountRouterDataRoot(userRoot: string): string {
  return join(resolve(userRoot), "tweak-data", ACCOUNT_SWITCHER_TWEAK_ID);
}

/** Matches the runtime's exported deterministic AF_UNIX endpoint derivation. */
export function routerControlSocketPath(routerRoot: string): string {
  const root = resolve(routerRoot);
  const rootHash = createHash("sha256").update(root, "utf8").digest("hex").slice(0, 24);
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "local";
  const path = join("/tmp", `arc-${uid}`, `${rootHash}-${ACCOUNT_ROUTER_CONTROL_SOCKET_FILE}`);
  if (Buffer.byteLength(path, "utf8") > MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("account-router control socket path exceeds platform bound");
  }
  return path;
}

export async function readLiveAccountRouterStatus(routerRoot: string): Promise<AccountRouterLiveEvidence> {
  const secret = readPrivateSecret(join(resolve(routerRoot), ACCOUNT_ROUTER_CONTROL_SECRET_FILE));
  if (!secret) return { state: "unavailable", status: null };
  const socketPath = routerControlSocketPath(routerRoot);
  if (!isPrivateSocket(socketPath)) {
    secret.fill(0);
    return { state: existsSync(socketPath) ? "unavailable" : "not_running", status: null };
  }
  try {
    return await requestLiveStatus(socketPath, secret);
  } finally {
    secret.fill(0);
  }
}

export function formatAccountRouterEvidence(evidence: AccountRouterEvidence): string[] {
  const live = evidence.live.state === "active" && evidence.live.status
    ? formatActive(evidence.live.status.active)
    : evidence.live.state.replaceAll("_", " ");
  const pending = evidence.configuration.pending
    ? formatPending(evidence.configuration.pending)
    : evidence.configuration.state.replaceAll("_", " ");
  const history = evidence.historyAdoption.state === "adopted"
    && evidence.configuration.pending?.schemaVersion === 2
    && evidence.configuration.pending.mode === "manual"
    ? "adopted; v2 Manual remains mux-backed for history; new threads use the primary account"
    : evidence.historyAdoption.state.replaceAll("_", " ");
  return [
    `  source:       ${formatArtifact(evidence.source)}`,
    `  candidate:    ${formatArtifact(evidence.candidate)}`,
    `  installed:    ${formatArtifact(evidence.installed)}`,
    `  pending:      ${pending}`,
    `  history:      ${history}`,
    `  live:         ${live}`,
  ];
}

function bundledRuntimeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "runtime");
}

function inspectRegisteredSourceManifest(registeredSourceRoot: string | null): AccountRouterSourceEvidence {
  if (!registeredSourceRoot) {
    return { state: "unavailable", version: null, unavailableReason: "not_registered" };
  }
  let sourceRoot: string;
  try {
    sourceRoot = realpathSync(resolve(registeredSourceRoot));
  } catch {
    return { state: "unavailable", version: null, unavailableReason: "registration_stale" };
  }
  const manifestPath = join(sourceRoot, "tweaks", ACCOUNT_SWITCHER_TWEAK_ID, "manifest.json");
  return inspectManifest(manifestPath);
}

function inspectRuntimeArtifacts(runtimeRoot: string): AccountRouterArtifactEvidence {
  const catalog = inspectCatalog(join(resolve(runtimeRoot), "catalog.json"));
  if (catalog.state !== "present") return catalog;
  return REQUIRED_ACCOUNT_ROUTER_RUNTIME_FILES.every((file) => isRegularFile(join(runtimeRoot, file)))
    ? catalog
    : { state: "missing", version: catalog.version };
}

function inspectManifest(path: string): AccountRouterArtifactEvidence {
  if (!existsSync(path)) return { state: "missing", version: null };
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(manifest) || manifest.id !== ACCOUNT_SWITCHER_TWEAK_ID || !isSemver(manifest.version)) {
      return { state: "invalid", version: null };
    }
    return { state: "present", version: manifest.version };
  } catch {
    return { state: "invalid", version: null };
  }
}

function inspectCatalog(path: string): AccountRouterArtifactEvidence {
  if (!existsSync(path)) return { state: "missing", version: null };
  try {
    const catalog = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(catalog) || !Array.isArray(catalog.entries)) return { state: "invalid", version: null };
    const entry = catalog.entries.find((candidate) => isRecord(candidate) && candidate.id === ACCOUNT_SWITCHER_TWEAK_ID);
    if (!isRecord(entry) || !isRecord(entry.manifest) || entry.manifest.id !== ACCOUNT_SWITCHER_TWEAK_ID || !isSemver(entry.manifest.version)) {
      return { state: "missing", version: null };
    }
    return { state: "present", version: entry.manifest.version };
  } catch {
    return { state: "invalid", version: null };
  }
}

function inspectRouterConfiguration(routerRoot: string): AccountRouterConfigurationEvidence {
  const path = join(routerRoot, ACCOUNT_ROUTER_CONFIG_FILE);
  if (!existsSync(path)) return { state: "not_staged", pending: null };
  if (!isPrivateRegularFile(path, 256 * 1024)) return { state: "unsafe", pending: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsePendingConfiguration(value) ?? { state: "invalid", pending: null };
  } catch {
    return { state: "invalid", pending: null };
  }
}

/**
 * This observer deliberately uses the authoritative artifact parsers and HMAC
 * verifiers. Its output is only a readiness state; private proof material
 * remains local to this function and is released before return.
 */
function inspectHistoryAdoption(
  routerRoot: string,
  configuration: AccountRouterConfigurationEvidence,
): AccountRouterHistoryAdoptionEvidence {
  const pending = configuration.pending;
  if (configuration.state === "invalid" || configuration.state === "unsafe") return { state: "invalid" };
  if (!pending || pending.schemaVersion !== 2) return { state: "not_applicable" };
  const v2Configuration = v2HistoryAdoptionConfigurations.get(configuration);
  if (!v2Configuration) return { state: "invalid" };

  const intentPath = join(routerRoot, ACCOUNT_HISTORY_ADOPTION_INTENT_FILE);
  const receiptPath = join(routerRoot, ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE);
  const ownersPath = join(routerRoot, ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE);
  const intentBytes = readPrivateArtifact(intentPath, HISTORY_ADOPTION_MAX_ARTIFACT_BYTES);
  const receiptBytes = readPrivateArtifact(receiptPath, HISTORY_ADOPTION_MAX_ARTIFACT_BYTES);
  const ownersBytes = readPrivateArtifact(ownersPath, HISTORY_ADOPTION_MAX_OWNERS_BYTES);

  if (intentBytes === null && receiptBytes === null && ownersBytes === null) return { state: "required" };
  if (!intentBytes || (receiptBytes === null) !== (ownersBytes === null)) return { state: "invalid" };

  const secret = readPrivateSecret(join(routerRoot, ACCOUNT_ROUTER_CONTROL_SECRET_FILE));
  if (!secret) {
    intentBytes.fill(0);
    receiptBytes?.fill(0);
    ownersBytes?.fill(0);
    return { state: "invalid" };
  }
  try {
    const intent = parseHistoryAdoptionIntent(intentBytes);
    if (!verifyHistoryAdoptionIntent(intent, secret)) return { state: "invalid" };
    const poolFingerprint = historyAdoptionPoolFingerprint(
      v2Configuration.protocolFingerprint,
      v2Configuration.accountOpaqueIds,
    );
    if (intent.protocolFingerprint !== v2Configuration.protocolFingerprint
      || intent.poolFingerprint !== poolFingerprint
      || !v2Configuration.accountOpaqueIds.includes(intent.legacyOwnerOpaqueAccountId)) {
      return { state: "mismatch" };
    }
    if (receiptBytes === null && ownersBytes === null) {
      return intent.configGeneration === pending.generation && intent.configFingerprint === pending.fingerprint
        ? { state: "pending_offline_adoption" }
        : { state: "mismatch" };
    }

    const receipt = parseHistoryAdoptionReceipt(receiptBytes!);
    const owners = parseHistoryAdoptionOwners(ownersBytes!);
    if (!verifyHistoryAdoptionReceipt(receipt, secret) || !verifyHistoryAdoptionOwners(owners, secret)) return { state: "invalid" };
    if (receipt.protocolFingerprint !== intent.protocolFingerprint
      || receipt.poolFingerprint !== intent.poolFingerprint
      || receipt.legacyOwnerOpaqueAccountId !== intent.legacyOwnerOpaqueAccountId
      || receipt.intentFingerprint !== historyAdoptionIntentFingerprint(intent)
      || owners.protocolFingerprint !== intent.protocolFingerprint
      || owners.poolFingerprint !== intent.poolFingerprint
      || owners.legacyOwnerOpaqueAccountId !== intent.legacyOwnerOpaqueAccountId
      || receipt.adoptedAt !== owners.adoptedAt
      || receipt.importedThreadCount !== owners.threadIds.length
      || owners.threadOwnersFingerprint !== receipt.threadOwnersFingerprint) return { state: "mismatch" };
    return { state: "adopted" };
  } catch {
    return { state: "invalid" };
  } finally {
    secret.fill(0);
    intentBytes.fill(0);
    receiptBytes?.fill(0);
    ownersBytes?.fill(0);
  }
}

/** `null` means absent; `undefined` means present but unsafe/unreadable. */
function readPrivateArtifact(path: string, maxBytes: number): Buffer | null | undefined {
  if (!existsSync(path)) return null;
  if (!isPrivateRegularFile(path, maxBytes)) return undefined;
  try {
    return Buffer.from(readFileSync(path));
  } catch {
    return undefined;
  }
}

function readPrivateSecret(path: string): Buffer | null {
  if (!isPrivateRegularFile(path, 512)) return null;
  try {
    const secret = Buffer.from(readFileSync(path));
    if (secret.byteLength !== 32) {
      secret.fill(0);
      return null;
    }
    return secret;
  } catch {
    return null;
  }
}

function isPrivateRegularFile(path: string, maxBytes: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile()
      && !stat.isSymbolicLink()
      && stat.nlink === 1
      && stat.uid === process.getuid?.()
      && stat.size <= maxBytes
      && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function isPrivateSocket(path: string): boolean {
  try {
    const stat = lstatSync(path);
    const parent = lstatSync(dirname(path));
    return stat.isSocket()
      && !stat.isSymbolicLink()
      && stat.uid === process.getuid?.()
      && (stat.mode & 0o077) === 0
      && parent.isDirectory()
      && !parent.isSymbolicLink()
      && parent.uid === process.getuid?.()
      && (parent.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function requestLiveStatus(path: string, secret: Buffer): Promise<AccountRouterLiveEvidence> {
  return new Promise((resolveResult) => {
    const requestId = "tweaker-cli-status-v1";
    const request = Buffer.from(`${JSON.stringify({
      version: 1,
      requestId,
      method: "status",
      secret: secret.toString("base64url"),
    })}\n`);
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (result: AccountRouterLiveEvidence) => {
      if (settled) return;
      settled = true;
      request.fill(0);
      response.fill(0);
      socket.destroy();
      resolveResult(result);
    };
    const socket = createConnection(path);
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => finish({ state: "unavailable", status: null }));
    socket.once("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => {
      if (response.byteLength + chunk.byteLength > CONTROL_FRAME_LIMIT) {
        finish({ state: "unavailable", status: null });
        return;
      }
      response = Buffer.concat([response, chunk]);
    });
    socket.once("end", () => {
      const parsed = parseLiveResponse(response, requestId);
      finish(parsed ? { state: "active", status: parsed } : { state: "unavailable", status: null });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish({ state: error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "not_running" : "unavailable", status: null });
    });
  });
}

function parseLiveResponse(bytes: Buffer, requestId: string): AccountRouterLiveStatus | null {
  try {
    const raw = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isRecord(raw) || Object.keys(raw).sort().join("\0") !== ["requestId", "status", "version"].join("\0")
      || raw.version !== 1 || raw.requestId !== requestId || !isRecord(raw.status)) return null;
    return parseV1LiveStatus(raw.status) ?? parseV2LiveStatus(raw.status);
  } catch {
    return null;
  }
}

function formatArtifact(artifact: AccountRouterArtifactEvidence | AccountRouterSourceEvidence): string {
  if (artifact.state === "present") return artifact.version ? `present (${artifact.version})` : "present";
  if (artifact.state === "unavailable") {
    return artifact.unavailableReason === "registration_stale"
      ? "unavailable (registered checkout is stale)"
      : "unavailable (no registered checkout)";
  }
  return artifact.state.replaceAll("_", " ");
}

function parsePendingConfiguration(value: unknown): AccountRouterConfigurationEvidence | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion === 1) {
    if (!hasExactKeys(value, ["schemaVersion", "mode", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt"])
      || (value.mode !== "manual" && value.mode !== "balanced")
      || !isFingerprint(value.protocolFingerprint) || !isOpaqueAccountId(value.primaryOpaqueAccountId)
      || !Array.isArray(value.accounts) || !isIsoDate(value.updatedAt)) return null;
    return {
      state: value.mode,
      pending: { schemaVersion: 1, mode: value.mode, policy: null, generation: null, fingerprint: null },
    };
  }
  if (value.schemaVersion !== 2
    || !hasExactKeys(value, ["schemaVersion", "mode", "policy", "generation", "fingerprint", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt"])
    || (value.mode !== "manual" && value.mode !== "quota_aware")
    || value.policy !== (value.mode === "quota_aware" ? "quota_aware_v1" : null)
    || !isPositiveSafeInteger(value.generation) || !isFingerprint(value.fingerprint)
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT || !isOpaqueAccountId(value.primaryOpaqueAccountId)
    || !isV2ConfigAccounts(value.accounts) || !isPrimaryAccount(value.primaryOpaqueAccountId, value.accounts)
    || !isIsoUtcTimestamp(value.updatedAt)
    || v2ConfigFingerprint(value) !== value.fingerprint) return null;
  const configuration: AccountRouterConfigurationEvidence = {
    state: value.mode,
    pending: {
      schemaVersion: 2,
      mode: value.mode,
      policy: value.mode === "quota_aware" ? "quota_aware_v1" : null,
      generation: value.generation,
      fingerprint: value.fingerprint,
    },
  };
  const accounts = value.accounts as Array<Record<string, unknown>>;
  v2HistoryAdoptionConfigurations.set(configuration, {
    protocolFingerprint: value.protocolFingerprint as `sha256:${string}`,
    accountOpaqueIds: [
      accounts[0]!.opaqueAccountId as `ar_${string}`,
      accounts[1]!.opaqueAccountId as `ar_${string}`,
    ],
  });
  return configuration;
}

function parseV1LiveStatus(status: unknown): AccountRouterLiveStatus | null {
  if (!isRecord(status)
    || !hasExactKeys(status, ["accounts", "degradedReason", "fairnessPrecision", "mode", "protocolState", "restartRequired", "schemaVersion"])
    || status.schemaVersion !== 1 || !isV1RouterMode(status.mode) || !isProtocolState(status.protocolState)
    || !isFairnessPrecision(status.fairnessPrecision) || typeof status.restartRequired !== "boolean"
    || !isDegradedReason(status.degradedReason) || !Array.isArray(status.accounts) || status.accounts.length > 2) return null;
  const accounts = parseV1LiveAccounts(status.accounts);
  if (!accounts) return null;
  return {
    schemaVersion: 1,
    active: { mode: status.mode, policy: null, generation: null, fingerprint: null, fairnessPrecision: status.fairnessPrecision },
    pending: null,
    protocolState: status.protocolState,
    accounts,
    restartRequired: status.restartRequired,
    poolRemainingPercent: null,
    degradedReason: status.degradedReason,
  };
}

function parseV2LiveStatus(status: unknown): AccountRouterLiveStatus | null {
  if (!isRecord(status)
    || !hasExactKeys(status, ["active", "pending", "protocolState", "restartRequired", "accounts", "poolRemainingPercent", "degradedReason", "schemaVersion"])
    || status.schemaVersion !== 2 || !isProtocolState(status.protocolState)
    || typeof status.restartRequired !== "boolean" || !isDegradedReason(status.degradedReason)
    || !isV2Active(status.active) || !isV2LivePending(status.pending)
    || !Array.isArray(status.accounts) || status.accounts.length !== 2
    || !isPoolRemaining(status.poolRemainingPercent)) return null;
  const accounts = parseV2LiveAccounts(status.accounts);
  if (!accounts) return null;
  return {
    schemaVersion: 2,
    active: status.active,
    pending: status.pending,
    protocolState: status.protocolState,
    accounts,
    restartRequired: status.restartRequired,
    poolRemainingPercent: status.poolRemainingPercent,
    degradedReason: status.degradedReason,
  };
}

function parseV1LiveAccounts(accounts: unknown[]): AccountRouterLiveAccount[] | null {
  const result: AccountRouterLiveAccount[] = [];
  for (const account of accounts) {
    if (!isRecord(account) || !hasExactKeys(account, ["assignedThreadCount", "eligibility", "label", "normalizedSpend", "opaqueAccountId"])
      || !isOpaqueAccountId(account.opaqueAccountId) || !isLegacyLabel(account.label) || !isEligibility(account.eligibility)
      || !isFiniteNonnegative(account.normalizedSpend) || !isNonnegativeInteger(account.assignedThreadCount)) return null;
    result.push({
      label: account.label, eligibility: account.eligibility, plan: null, identifierMasked: null,
      weekly: null, shortWindowPressure: null, normalizedSpend: account.normalizedSpend,
      assignedThreadCount: account.assignedThreadCount,
    });
  }
  return result;
}

function parseV2LiveAccounts(accounts: unknown[]): AccountRouterLiveAccount[] | null {
  const result: AccountRouterLiveAccount[] = [];
  for (const account of accounts) {
    if (!isRecord(account) || !hasExactKeys(account, ["opaqueAccountId", "label", "eligibility", "plan", "identifierMasked", "weekly", "shortWindowPressure", "assignedThreadCount"])
      || !isOpaqueAccountId(account.opaqueAccountId) || !isSafeLabel(account.label)
      || !isEligibility(account.eligibility) || !isSafePlan(account.plan) || !isMaskedIdentifier(account.identifierMasked)
      || !isWeeklyProjection(account.weekly) || !isPercentageOrNull(account.shortWindowPressure)
      || !isNonnegativeInteger(account.assignedThreadCount)) return null;
    result.push({
      label: account.label, eligibility: account.eligibility, plan: account.plan, identifierMasked: account.identifierMasked,
      weekly: account.weekly, shortWindowPressure: account.shortWindowPressure, normalizedSpend: 0,
      assignedThreadCount: account.assignedThreadCount,
    });
  }
  return result;
}

function formatActive(active: AccountRouterActiveConfiguration): string {
  const identity = active.generation === null || active.fingerprint === null
    ? active.fairnessPrecision ?? "legacy"
    : `generation ${active.generation}; ${shortFingerprint(active.fingerprint)}`;
  return `${active.mode.replaceAll("_", " ")}${active.policy ? ` (${active.policy})` : ""}; ${identity}`;
}

function formatPending(pending: AccountRouterPendingConfiguration): string {
  const identity = pending.generation === null || pending.fingerprint === null
    ? "legacy v1"
    : `generation ${pending.generation}; ${shortFingerprint(pending.fingerprint)}`;
  return `${pending.mode.replaceAll("_", " ")}${pending.policy ? ` (${pending.policy})` : ""}; ${identity}`;
}

function shortFingerprint(fingerprint: string): string {
  return `${fingerprint.slice(0, 15)}…`;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isOpaqueAccountId(value: unknown): value is string {
  return typeof value === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPercentageOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
}

function isPoolRemaining(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 200);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function isLegacyLabel(value: unknown): value is "Account A" | "Account B" {
  return value === "Account A" || value === "Account B";
}

function isSafeLabel(value: unknown): value is string {
  return isSafeLocalLabel(value);
}

function isSafePlan(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length >= 1 && value.length <= 80 && /^[A-Za-z0-9 .+_-]+$/.test(value));
}

function isMaskedIdentifier(value: unknown): value is string {
  // A display-only partial identifier may not be an email, a raw provider ID,
  // a path, or an opaque router/account identifier.
  return typeof value === "string" && value.length >= 3 && value.length <= 80
    && !/[\/@:]/.test(value) && /[•*]/.test(value) && /^[A-Za-z0-9 .+_\-*•]+$/.test(value);
}

function isWeeklyProjection(value: unknown): value is AccountRouterWeeklyProjection {
  return isRecord(value) && hasExactKeys(value, ["remainingPercent", "resetAt", "freshness"])
    && isPercentageOrNull(value.remainingPercent)
    && (value.resetAt === null || isIsoDate(value.resetAt))
    && (value.freshness === "fresh" || value.freshness === "stale" || value.freshness === "unknown");
}

function isV2ConfigAccounts(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const ids = new Set<string>();
  for (const account of value) {
    if (!isRecord(account) || !hasExactKeys(account, ["opaqueAccountId", "included", "weight", "capabilityFingerprint", "label"])
      || !isOpaqueAccountId(account.opaqueAccountId) || ids.has(account.opaqueAccountId)
      || account.included !== true || !isFinitePositiveWeight(account.weight)
      || !isFingerprint(account.capabilityFingerprint) || !isSafeLocalLabel(account.label)) return false;
    ids.add(account.opaqueAccountId);
  }
  return true;
}

/**
 * Mirrors runtime/routerConfigFingerprint exactly. Every record level is
 * sorted so writers in different languages cannot alter a generation's digest
 * merely by choosing a different object insertion order.
 */
function v2ConfigFingerprint(value: Record<string, unknown>): string {
  const accounts = value.accounts as Array<Record<string, unknown>>;
  const canonical = {
    schemaVersion: 2,
    mode: value.mode,
    policy: value.policy,
    generation: value.generation,
    protocolFingerprint: value.protocolFingerprint,
    primaryOpaqueAccountId: value.primaryOpaqueAccountId,
    accounts: accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      included: account.included,
      weight: account.weight,
      capabilityFingerprint: account.capabilityFingerprint,
      label: account.label,
    })),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

function isFinitePositiveWeight(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100;
}

function isPrimaryAccount(primaryOpaqueAccountId: unknown, accounts: unknown): boolean {
  return isOpaqueAccountId(primaryOpaqueAccountId) && Array.isArray(accounts)
    && accounts.some((account) => isRecord(account) && account.opaqueAccountId === primaryOpaqueAccountId);
}

function isSafeLocalLabel(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 80);
  return value === normalized
    && !/[@/\\]/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:\bBearer\s+\S+|\b(?:sk-(?:proj-)?|gh[oprsu]_|xox[baprs]-)[A-Za-z0-9_-]{8,}|(?:^|[\s;])(?:authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[:=]|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/i.test(value);
}

function isIsoUtcTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isV1RouterMode(value: unknown): value is "manual" | "balanced" | "direct_fallback" {
  return value === "manual" || value === "balanced" || value === "direct_fallback";
}

function isV2Active(value: unknown): value is AccountRouterActiveConfiguration {
  return isRecord(value) && hasExactKeys(value, ["mode", "policy", "generation", "fingerprint"])
    && (value.mode === "manual" || value.mode === "quota_aware")
    && value.policy === (value.mode === "quota_aware" ? "quota_aware_v1" : null)
    && isPositiveSafeInteger(value.generation) && isFingerprint(value.fingerprint);
}

function isV2LivePending(value: unknown): value is AccountRouterLivePendingConfiguration | null {
  return value === null || (isRecord(value) && hasExactKeys(value, ["mode", "policy", "generation", "fingerprint"])
    && (value.mode === "manual" || value.mode === "quota_aware")
    && value.policy === (value.mode === "quota_aware" ? "quota_aware_v1" : null)
    && isPositiveSafeInteger(value.generation) && isFingerprint(value.fingerprint));
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function isSemver(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function isProtocolState(value: unknown): value is AccountRouterLiveStatus["protocolState"] {
  return value === "supported" || value === "unsupported" || value === "drifted" || value === "unknown";
}

function isFairnessPrecision(value: unknown): value is NonNullable<AccountRouterActiveConfiguration["fairnessPrecision"]> {
  return value === "projected" || value === "exact_completed_spend" || value === "estimated";
}

function isEligibility(value: unknown): value is AccountRouterLiveAccount["eligibility"] {
  return value === "validating" || value === "eligible" || value === "reserved" || value === "active"
    || value === "cooldown" || value === "quota_depleted" || value === "reauth_required"
    || value === "plugin_blocked" || value === "protocol_blocked" || value === "disabled" || value === "unhealthy";
}

function isDegradedReason(value: unknown): value is AccountRouterLiveStatus["degradedReason"] {
  return value === null || value === "invalid_config" || value === "unsupported_protocol"
    || value === "startup_selfcheck_failed" || value === "pool_depleted" || value === "capability_mismatch"
    || value === "policy_stop" || value === "post_start_failure" || value === "account_unauthenticated"
    || value === "account_disabled" || value === "account_unhealthy" || value === "quota_depleted"
    || value === "quota_stale" || value === "quota_unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
