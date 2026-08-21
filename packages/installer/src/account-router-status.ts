import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ACCOUNT_SWITCHER_TWEAK_ID = "co.tweakers.account-switcher";
const ACCOUNT_ROUTER_CONFIG_FILE = "account-router-config.json";
const ACCOUNT_ROUTER_CONTROL_SECRET_FILE = "control-secret.v1";
const ACCOUNT_ROUTER_CONTROL_SOCKET_FILE = "router-control.v1.sock";
const CONTROL_FRAME_LIMIT = 4 * 1024;
const CONTROL_TIMEOUT_MS = 2_000;
const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 100;

export type EvidenceState = "present" | "missing" | "invalid" | "unobserved";

export interface AccountRouterArtifactEvidence {
  state: EvidenceState;
  version: string | null;
}

export interface AccountRouterConfigurationEvidence {
  state: "not_staged" | "manual" | "balanced" | "invalid" | "unsafe";
}

export interface AccountRouterLiveAccount {
  label: "Account A" | "Account B";
  eligibility: "validating" | "eligible" | "reserved" | "active" | "cooldown" | "quota_depleted" | "reauth_required" | "plugin_blocked" | "protocol_blocked" | "disabled" | "unhealthy";
  normalizedSpend: number;
  assignedThreadCount: number;
}

export interface AccountRouterLiveStatus {
  mode: "manual" | "balanced" | "direct_fallback";
  protocolState: "supported" | "unsupported" | "drifted" | "unknown";
  fairnessPrecision: "projected" | "exact_completed_spend" | "estimated";
  accounts: AccountRouterLiveAccount[];
  restartRequired: boolean;
  degradedReason: "invalid_config" | "unsupported_protocol" | "startup_selfcheck_failed" | "pool_depleted" | "capability_mismatch" | "policy_stop" | "post_start_failure" | null;
}

export interface AccountRouterLiveEvidence {
  state: "active" | "not_running" | "unavailable" | "not_applicable";
  status: AccountRouterLiveStatus | null;
}

export interface AccountRouterEvidence {
  source: AccountRouterArtifactEvidence;
  candidate: AccountRouterArtifactEvidence;
  installed: AccountRouterArtifactEvidence;
  configuration: AccountRouterConfigurationEvidence;
  live: AccountRouterLiveEvidence;
}

export interface InspectAccountRouterOptions {
  userRoot: string;
  sourceRoot?: string | null;
  candidateRuntimeRoot?: string;
  installedRuntimeRoot?: string;
}

/**
 * Observes four intentionally separate layers. Source is a recorded checkout,
 * candidate is the runtime carried by this installer package, installed is the
 * user-dir runtime, and live is the authenticated mux control response.
 */
export async function inspectAccountRouter(options: InspectAccountRouterOptions): Promise<AccountRouterEvidence> {
  const routerRoot = accountRouterDataRoot(options.userRoot);
  const configuration = inspectRouterConfiguration(routerRoot);
  return {
    source: inspectSourceManifest(options.sourceRoot ?? null),
    candidate: inspectRuntimeArtifacts(options.candidateRuntimeRoot ?? bundledRuntimeRoot()),
    installed: inspectRuntimeArtifacts(options.installedRuntimeRoot ?? join(options.userRoot, "runtime")),
    configuration,
    live: configuration.state === "balanced"
      ? await readLiveAccountRouterStatus(routerRoot)
      : { state: "not_applicable", status: null },
  };
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
    ? `${evidence.live.status.mode}, ${evidence.live.status.fairnessPrecision}`
    : evidence.live.state.replaceAll("_", " ");
  return [
    `  source:       ${formatArtifact(evidence.source)}`,
    `  candidate:    ${formatArtifact(evidence.candidate)}`,
    `  installed:    ${formatArtifact(evidence.installed)}`,
    `  configuration:${formatConfiguration(evidence.configuration)}`,
    `  live:         ${live}`,
  ];
}

function bundledRuntimeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "runtime");
}

function inspectSourceManifest(sourceRoot: string | null): AccountRouterArtifactEvidence {
  if (!sourceRoot) return { state: "unobserved", version: null };
  const manifestPath = join(resolve(sourceRoot), "tweaks", ACCOUNT_SWITCHER_TWEAK_ID, "manifest.json");
  return inspectManifest(manifestPath);
}

function inspectRuntimeArtifacts(runtimeRoot: string): AccountRouterArtifactEvidence {
  const catalog = inspectCatalog(join(resolve(runtimeRoot), "catalog.json"));
  if (catalog.state !== "present") return catalog;
  const files = [
    join(runtimeRoot, "account-router", "app-server-mux.js"),
    join(runtimeRoot, "account-router", "control-socket.js"),
  ];
  return files.every(isRegularFile) ? catalog : { state: "missing", version: catalog.version };
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
  if (!existsSync(path)) return { state: "not_staged" };
  if (!isPrivateRegularFile(path, 256 * 1024)) return { state: "unsafe" };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value) || Object.keys(value).some((key) => ![
      "schemaVersion", "mode", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
    ].includes(key))) return { state: "invalid" };
    if (value.mode === "manual") return { state: "manual" };
    if (value.mode === "balanced") return { state: "balanced" };
    return { state: "invalid" };
  } catch {
    return { state: "invalid" };
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
    const status = raw.status;
    const allowed = ["accounts", "degradedReason", "fairnessPrecision", "mode", "protocolState", "restartRequired", "schemaVersion"];
    if (Object.keys(status).some((key) => !allowed.includes(key)) || status.schemaVersion !== 1
      || !isRouterMode(status.mode)
      || !isProtocolState(status.protocolState)
      || !isFairnessPrecision(status.fairnessPrecision)
      || typeof status.restartRequired !== "boolean"
      || !isDegradedReason(status.degradedReason)
      || !Array.isArray(status.accounts) || status.accounts.length > 2) return null;
    const accounts: AccountRouterLiveAccount[] = [];
    for (const account of status.accounts) {
      if (!isRecord(account) || Object.keys(account).sort().join("\0") !== ["assignedThreadCount", "eligibility", "label", "normalizedSpend", "opaqueAccountId"].join("\0")
        || typeof account.opaqueAccountId !== "string" || !/^ar_[A-Za-z0-9_-]{43}$/.test(account.opaqueAccountId)
        || (account.label !== "Account A" && account.label !== "Account B")
        || !isEligibility(account.eligibility)
        || typeof account.normalizedSpend !== "number" || !Number.isFinite(account.normalizedSpend) || account.normalizedSpend < 0
        || typeof account.assignedThreadCount !== "number" || !Number.isInteger(account.assignedThreadCount) || account.assignedThreadCount < 0) return null;
      accounts.push({
        label: account.label,
        eligibility: account.eligibility,
        normalizedSpend: account.normalizedSpend,
        assignedThreadCount: account.assignedThreadCount,
      });
    }
    return {
      mode: status.mode,
      protocolState: status.protocolState,
      fairnessPrecision: status.fairnessPrecision,
      accounts,
      restartRequired: status.restartRequired,
      degradedReason: status.degradedReason,
    };
  } catch {
    return null;
  }
}

function formatArtifact(artifact: AccountRouterArtifactEvidence): string {
  if (artifact.state === "present") return artifact.version ? `present (${artifact.version})` : "present";
  return artifact.state.replaceAll("_", " ");
}

function formatConfiguration(configuration: AccountRouterConfigurationEvidence): string {
  return ` ${configuration.state.replaceAll("_", " ")}`;
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function isSemver(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function isRouterMode(value: unknown): value is AccountRouterLiveStatus["mode"] {
  return value === "manual" || value === "balanced" || value === "direct_fallback";
}

function isProtocolState(value: unknown): value is AccountRouterLiveStatus["protocolState"] {
  return value === "supported" || value === "unsupported" || value === "drifted" || value === "unknown";
}

function isFairnessPrecision(value: unknown): value is AccountRouterLiveStatus["fairnessPrecision"] {
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
    || value === "policy_stop" || value === "post_start_failure";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
