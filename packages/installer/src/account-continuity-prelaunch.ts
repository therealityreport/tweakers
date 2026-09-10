import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  resolveSealedManagerManagedRuntimeAssets,
  verifySealedManagerManagedRuntimeAssets,
  type SealedManagerManagedRuntimeAssets,
} from "./manager-runtime-assets.js";

const RUNTIME_ACCOUNT_ROUTER_ROOT = join("packages", "installer", "assets", "runtime", "account-router");
const CONFIG_FILE = "account-router-config.json";
const SECRET_FILE = "control-secret.v1";
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const RECOVERY_INTENTS = [
  "config-materialization-intent.v1.json",
  "plugin-projection-intent.v1.json",
  "native-initial-capture-intent.v1.json",
] as const;

interface NativeAccountBinding {
  opaqueAccountId: string;
  codexHome: string;
  sqliteHome: string;
}

interface NativeBinding {
  source: { metadataAccountId: string };
  accounts: readonly NativeAccountBinding[];
}

interface NativeHistoryPort {
  readAndPreflightNativeHistorySourceStaticV1(
    stateRoot: string,
    config: object,
    secret: Buffer,
  ): { state: "ready"; binding: NativeBinding } | { state: "invalid" | "absent"; reason?: string };
  nativeHistoryBindingSafeV1(binding: NativeBinding): boolean;
  observeNativeAccountWritersV1(
    binding: NativeBinding,
    opaqueAccountId: string,
    ownedPids: readonly number[],
  ): { ok: boolean; reason: "ready" | "source_drift" | "writer_census_failed" | "foreign_writer"; foreignPids: readonly number[] };
}

interface ContinuityManifest { fingerprint: string }
interface ContinuityPort {
  DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1: object;
  loadSharedAccountBase(stateRoot: string): ContinuityManifest | null;
  loadSharedPluginsManifestV1(stateRoot: string): ContinuityManifest | null;
  loadAccountContinuitySharedSourceProvenanceV1(stateRoot: string): {
    state: "ready" | "blocked";
    reason?: string;
    sharedSourceOpaqueAccountId?: string;
  };
  rebaseAccountContinuitySharedSource(input: {
    stateRoot: string;
    primaryOpaqueAccountId: string;
    sharedSourceOpaqueAccountId: string;
    accounts: readonly { opaqueAccountId: string; codexHome: string }[];
    schema: object;
    priorShared: ContinuityManifest;
    priorPlugins: ContinuityManifest;
    accountWriteEvidence: Readonly<Record<string, {
      accountChildAbsent: true;
      nativeWriterCensus: () => "zero" | "running";
    }>>;
    apply: true;
  }): {
    state: "ready" | "blocked";
    reason?: string;
    shared?: ContinuityManifest;
    plugins?: ContinuityManifest;
  };
}

export interface AccountContinuityPrelaunchResultV1 {
  state: "ready" | "deferred";
  reason: "already-current" | "shared-source-rebased" | "shared-source-recovered" | "shared-native-ready" | "account-busy" | "source-changed";
}

export interface AccountContinuityPrelaunchDependencies {
  resolveManagedRuntime?: () => SealedManagerManagedRuntimeAssets | null;
  verifyManagedRuntime?: (assets: SealedManagerManagedRuntimeAssets) => unknown;
  requireModule?: (path: string) => unknown;
  /** Test-only recovery probe. Production checks the runtime-owned intent names. */
  recoveryPending?: (stateRoot: string, accountIds: readonly string[]) => boolean;
}

/**
 * Reconcile the historical shared-settings donor during a natural Tweakers
 * idle window. This never stops an app or starts a scanner. The signed native
 * binding supplies both the exact donor and every account home; the wrapper
 * PID is deliberately not accepted by this API and therefore cannot become a
 * native-account census exception.
 */
export function prepareManagedAccountContinuityPrelaunch(
  stateRoot: string,
  dependencies: AccountContinuityPrelaunchDependencies = {},
): AccountContinuityPrelaunchResultV1 {
  const root = exactStateRoot(stateRoot);
  const assets = (dependencies.resolveManagedRuntime ?? resolveSealedManagerManagedRuntimeAssets)();
  if (assets === null) throw new Error("Account continuity requires the sealed manager managed runtime");
  (dependencies.verifyManagedRuntime ?? verifySealedManagerManagedRuntimeAssets)(assets);
  const requireModule = dependencies.requireModule ?? createRequire(import.meta.url);
  const history = requireModule(join(assets.root, RUNTIME_ACCOUNT_ROUTER_ROOT, "native-history.js")) as NativeHistoryPort;
  const continuity = requireModule(join(assets.root, RUNTIME_ACCOUNT_ROUTER_ROOT, "account-continuity.js")) as ContinuityPort;
  assertRuntimePorts(history, continuity);

  const secret = readPrivateFile(join(root, SECRET_FILE), 32, 32);
  let config: Record<string, unknown>;
  let preflight: ReturnType<NativeHistoryPort["readAndPreflightNativeHistorySourceStaticV1"]>;
  try {
    const configBytes = readPrivateFile(join(root, CONFIG_FILE), 1, MAX_CONFIG_BYTES);
    try {
      const parsed = JSON.parse(configBytes.toString("utf8")) as unknown;
      if (!isRecord(parsed)) throw new Error("Account continuity registration config is invalid");
      config = parsed;
    } finally {
      configBytes.fill(0);
    }
    preflight = history.readAndPreflightNativeHistorySourceStaticV1(root, config, secret);
  } finally {
    secret.fill(0);
  }
  const configuredAccountIds = configuredOpaqueAccountIds(config);
  if (preflight.state !== "ready") {
    if (preflight.reason === "source_drift" && configuredAccountIds !== null
      && !(dependencies.recoveryPending ?? hasRecoveryIntent)(root, configuredAccountIds)) {
      return { state: "deferred", reason: "source-changed" };
    }
    throw new Error(`Account continuity signed native registration is unavailable: ${preflight.reason ?? preflight.state}`);
  }
  if (!history.nativeHistoryBindingSafeV1(preflight.binding)) {
    if (configuredAccountIds !== null
      && !(dependencies.recoveryPending ?? hasRecoveryIntent)(root, configuredAccountIds)) {
      return { state: "deferred", reason: "source-changed" };
    }
    throw new Error("Account continuity signed native registration changed while it was verified");
  }
  const binding = preflight.binding;
  const primaryOpaqueAccountId = config.primaryOpaqueAccountId;
  if (typeof primaryOpaqueAccountId !== "string"
    || !binding.accounts.some((account) => account.opaqueAccountId === primaryOpaqueAccountId)) {
    throw new Error("Account continuity routing primary is not an exact signed account");
  }
  const donor = binding.source.metadataAccountId;
  if (!binding.accounts.some((account) => account.opaqueAccountId === donor)) {
    throw new Error("Account continuity donor is not an exact signed account");
  }
  if (presentNoFollow(join(root, "shared-native-mode.v1.json"))
    || presentNoFollow(join(root, "shared-native-mode-transition.v1.json"))) {
    const mode = requireModule(join(assets.root, RUNTIME_ACCOUNT_ROUTER_ROOT, "shared-native-mode.js")) as {
      readSharedNativeModeV1(context: { stateRoot: string; binding: NativeBinding; secret: Buffer }): { state: string; reason?: string };
    };
    if (typeof mode?.readSharedNativeModeV1 !== "function") throw new Error("Shared native mode runtime is unavailable");
    const modeSecret = readPrivateFile(join(root, SECRET_FILE), 32, 32);
    try {
      const result = mode.readSharedNativeModeV1({ stateRoot: root, binding, secret: modeSecret });
      if (result.state !== "ready") throw new Error(`Shared native mode is unavailable: ${result.reason ?? result.state}`);
      return { state: "ready", reason: "shared-native-ready" };
    } finally {
      modeSecret.fill(0);
    }
  }
  const priorShared = continuity.loadSharedAccountBase(root);
  const priorPlugins = continuity.loadSharedPluginsManifestV1(root);
  if (!priorShared || !priorPlugins) throw new Error("Account continuity shared manifests are not ready");
  const provenance = continuity.loadAccountContinuitySharedSourceProvenanceV1(root);
  if (provenance.state !== "ready" || typeof provenance.sharedSourceOpaqueAccountId !== "string") {
    throw new Error(provenance.reason ?? "Account continuity shared-source provenance is invalid");
  }
  const accountIds = binding.accounts.map((account) => account.opaqueAccountId);
  const recoveryPending = (dependencies.recoveryPending ?? hasRecoveryIntent)(root, accountIds);
  if (provenance.sharedSourceOpaqueAccountId === donor && !recoveryPending) {
    return { state: "ready", reason: "already-current" };
  }

  const nonDonors = binding.accounts.filter((account) => account.opaqueAccountId !== donor);
  // Finish each complete round across all non-donors before beginning the
  // second. The donor is not scanned until both rounds are clean.
  for (let round = 0; round < 2; round += 1) {
    for (const account of nonDonors) {
      const observed = history.observeNativeAccountWritersV1(binding, account.opaqueAccountId, []);
      if (observed.ok) continue;
      if (observed.reason === "foreign_writer" && !recoveryPending) {
        return { state: "deferred", reason: "account-busy" };
      }
      if (observed.reason === "source_drift" && !recoveryPending) {
        return { state: "deferred", reason: "source-changed" };
      }
      throw new Error(`Account continuity cannot enter its recovery window: ${observed.reason}`);
    }
  }

  const freshShared = continuity.loadSharedAccountBase(root);
  const freshPlugins = continuity.loadSharedPluginsManifestV1(root);
  if (!freshShared || !freshPlugins
    || freshShared.fingerprint !== priorShared.fingerprint
    || freshPlugins.fingerprint !== priorPlugins.fingerprint) {
    if (!recoveryPending) return { state: "deferred", reason: "source-changed" };
    throw new Error("Account continuity shared manifests changed before donor rebase");
  }
  const writeEvidence = Object.fromEntries(nonDonors.map((account) => [account.opaqueAccountId, {
    accountChildAbsent: true as const,
    nativeWriterCensus: (): "zero" | "running" => (
      history.observeNativeAccountWritersV1(binding, account.opaqueAccountId, []).ok ? "zero" : "running"
    ),
  }]));
  const rebaseInput = {
    stateRoot: root,
    primaryOpaqueAccountId,
    sharedSourceOpaqueAccountId: donor,
    accounts: binding.accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      codexHome: account.codexHome,
    })),
    schema: continuity.DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    priorShared: freshShared,
    priorPlugins: freshPlugins,
    accountWriteEvidence: writeEvidence,
    apply: true as const,
  };

  let recovered = recoveryPending;
  let result: ReturnType<ContinuityPort["rebaseAccountContinuitySharedSource"]>;
  try {
    result = continuity.rebaseAccountContinuitySharedSource(rebaseInput);
  } catch (firstError) {
    recovered = true;
    try {
      result = continuity.rebaseAccountContinuitySharedSource(rebaseInput);
    } catch (recoveryError) {
      throw new AggregateError([firstError, recoveryError], "Account continuity rebase and recovery both failed");
    }
  }
  if (result.state !== "ready") {
    recovered = true;
    const recovery = continuity.rebaseAccountContinuitySharedSource(rebaseInput);
    if (recovery.state !== "ready") {
      throw new Error(`Account continuity rebase requires recovery: ${recovery.reason ?? result.reason ?? "blocked"}`);
    }
    result = recovery;
  }
  assertCompletedRebase(root, donor, result, continuity, accountIds, dependencies.recoveryPending);
  return { state: "ready", reason: recovered ? "shared-source-recovered" : "shared-source-rebased" };
}

function assertCompletedRebase(
  stateRoot: string,
  donor: string,
  result: ReturnType<ContinuityPort["rebaseAccountContinuitySharedSource"]>,
  continuity: ContinuityPort,
  accountIds: readonly string[],
  recoveryProbe?: AccountContinuityPrelaunchDependencies["recoveryPending"],
): void {
  const shared = continuity.loadSharedAccountBase(stateRoot);
  const plugins = continuity.loadSharedPluginsManifestV1(stateRoot);
  const provenance = continuity.loadAccountContinuitySharedSourceProvenanceV1(stateRoot);
  if (result.state !== "ready" || !result.shared || !result.plugins || !shared || !plugins
    || shared.fingerprint !== result.shared.fingerprint || plugins.fingerprint !== result.plugins.fingerprint
    || provenance.state !== "ready" || provenance.sharedSourceOpaqueAccountId !== donor
    || (recoveryProbe ?? hasRecoveryIntent)(stateRoot, accountIds)) {
    throw new Error("Account continuity donor rebase did not leave verified ready manifests and provenance");
  }
}

function assertRuntimePorts(history: NativeHistoryPort, continuity: ContinuityPort): void {
  if (!history || typeof history.readAndPreflightNativeHistorySourceStaticV1 !== "function"
    || typeof history.nativeHistoryBindingSafeV1 !== "function"
    || typeof history.observeNativeAccountWritersV1 !== "function"
    || !continuity || typeof continuity.loadSharedAccountBase !== "function"
    || typeof continuity.loadSharedPluginsManifestV1 !== "function"
    || typeof continuity.loadAccountContinuitySharedSourceProvenanceV1 !== "function"
    || typeof continuity.rebaseAccountContinuitySharedSource !== "function") {
    throw new Error("Account continuity sealed runtime ports are unavailable");
  }
}

function hasRecoveryIntent(stateRoot: string, accountIds: readonly string[]): boolean {
  if (presentNoFollow(join(stateRoot, "shared-native-mode-transition.v1.json"))) return true;
  if (presentNoFollow(join(stateRoot, "shared-account-config", "shared-source-rebase-intent.v1.json"))) return true;
  return accountIds.some((accountId) => RECOVERY_INTENTS.some((name) => (
    presentNoFollow(join(stateRoot, "accounts", accountId, name))
  )));
}

function presentNoFollow(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Account continuity recovery artifact is unsafe");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function exactStateRoot(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error("Account continuity state root is not exact and canonical");
  }
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error("Account continuity state root is not a private owned directory");
  }
  return path;
}

function readPrivateFile(path: string, minimumBytes: number, maximumBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (!before.isFile() || before.nlink !== 1 || (uid !== undefined && before.uid !== uid)
      || (before.mode & 0o077) !== 0 || before.size < minimumBytes || before.size > maximumBytes) {
      throw new Error("Account continuity registration file is unsafe");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("Account continuity registration file was truncated");
      offset += count;
    }
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) {
      bytes.fill(0);
      throw new Error("Account continuity registration file changed during read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredOpaqueAccountIds(config: Record<string, unknown>): readonly string[] | null {
  if (!Array.isArray(config.accounts)) return null;
  const ids = config.accounts.map((account) => isRecord(account) ? account.opaqueAccountId : null);
  return ids.length > 0 && ids.every((id): id is string => typeof id === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(id))
    && new Set(ids).size === ids.length ? ids : null;
}
