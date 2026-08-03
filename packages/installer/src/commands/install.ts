import kleur from "kleur";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fstatSync,
  readFileSync,
  readSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  unlinkSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  copyFileSync,
  renameSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { locateCodex, type CodexInstall } from "../platform.js";
import { ensureUserPaths, type UserPaths } from "../paths.js";
import { backupOnce, patchAsar, readFileInAsar, readHeaderHash } from "../asar.js";
import { setIntegrity, getIntegrity } from "../integrity.js";
import { writeFuse } from "../fuses.js";
import { clearQuarantine, isDeveloperIdSignedBackup, prepareCodeSigning, signCodexApp, signatureInfo, verifySignature } from "../codesign.js";
import { assertInternalStoragePath } from "../internal-storage.js";
import { fingerprintAppContents } from "../environment-profile.js";
import {
  assertPreparedPrebuiltCombinedCandidateEvidence,
  capturePrebuiltRollbackEvidence,
  capturePreparedPrebuiltCombinedCandidateEvidence,
  resolvePrebuiltCombinedCandidateCliInput,
  validatePrebuiltCombinedCandidate,
  type PrebuiltCombinedCandidateCliOptions,
  type PrebuiltCombinedCandidateInput,
  type PrebuiltCombinedCandidateAuthority,
} from "../prebuilt-combined-candidate.js";

// Re-export from its new home (codesign.ts) so existing importers keep working.
export { isDeveloperIdSignedBackup };
import { readPlist } from "../plist.js";
import { readState, writeState } from "../state.js";
import { installWatcher, type WatcherKind } from "../watcher.js";
import { TWEAKER_VERSION } from "../version.js";
import { formatCliShimResult } from "../cli-shim.js";
import { findSourceRoot } from "../source-root.js";
import {
  CODEX_WINDOW_SERVICES_KEY,
  describeCodexWindowServicesSource,
  patchCodexWindowServicesSource,
  type CodexWindowServicesSourceDiagnostics,
} from "../codex-window-services.js";
import { chownForTargetUser, targetUserHome, targetUserOwnership } from "../ownership.js";
import { getOpenReport, reportsMainProcessRunning, type OpenReport } from "./debug.js";
import { openCodex, quitCodex, showCodexUpdateDetectedNotification } from "../alerts.js";
import { terminateStaleHelperProcesses } from "../orphans.js";
import { assertLifecycleReceiptsIdle, lifecycleLockFile, withLifecycleLock } from "../lifecycle-lock.js";
import { runHeldPromotion } from "../watcher-held.js";
import { isSymlinkInto } from "../symlinks.js";
import { copyDirectoryPreservingModes, isMacOsJunkName } from "../fs-copy.js";
import {
  cloneAppTree,
  filesystemTransactionAdapters,
  HEALTH_TIMESTAMP_MAX_FUTURE_SKEW_MS,
  isValidProductionHealthExpectationV2,
  PROMOTION_SURFACE_NAMES,
  runInstallTransaction,
  readProductionHealthReceipt,
  type AppFingerprint,
  type NativeHealthProbeAdapter,
  type ProductionHealthExpectationV2,
  type TransactionResult,
} from "../transaction.js";
import { migrateAutomatically } from "./migrate.js";
import { readDevTweaksRoot } from "../config.js";
import { ensureManagedRuntime, reconcileManagedCliShims } from "../managed-runtime.js";
import { reconcileDock, reconcileLaunchServices } from "../macos-app-identity.js";
import { applyMacAppIdentity, type MacAppIdentity } from "../macos-variant.js";
import { parkedPayloadRoot } from "../mode-transition.js";
import { ensureModeCoordinatorConfigured, removeStandaloneSwitcher } from "../switcher-setup.js";
import { LEGACY_ASAR_META_KEY, LEGACY_DATA_DIR, LEGACY_DEV_SNAPSHOT_FILE, LEGACY_LOADER_FILE, LEGACY_WATCHER_ENV } from "../legacy-compat.js";
import { migrateLegacyTweakNamespaces } from "../tweak-namespace-migration.js";
import { fingerprintPromotionPolicyPath } from "../promotion-policy.js";
import {
  fingerprintPath,
  inspectUserQuestionsSource,
  LEGACY_USER_QUESTIONS_TWEAK_IDS,
  USER_QUESTIONS_FOLDER,
  USER_QUESTIONS_TWEAK_ID,
} from "../user-questions-source.js";
import {
  commitUserQuestionsRollout,
  defaultUserQuestionsRolloutOptions,
  planUserQuestionsRollout,
  prepareUserQuestionsRollout,
  readUserQuestionsRolloutReceipt,
  rollbackUserQuestionsRollout,
  sealUserQuestionsRollout,
  type UserQuestionsRolloutReceipt,
} from "../user-questions-transaction.js";

interface Opts {
  app?: string;
  fuse?: boolean; // sade --no-fuse → fuse: false
  resign?: boolean;
  localSigning?: boolean;
  watcher?: boolean;
  watcherKind?: WatcherKind;
  quiet?: boolean;
  verbose?: boolean;
  candidateOnly?: boolean;
  /** Internal: a validated candidate intentionally held for the coordinated refresh flow. */
  candidateOnlyReason?: "explicit" | "coordinated-refresh";
  /** Watcher-only: confirmed official-update drift; actively quit Codex to promote instead of waiting passively. */
  coordinatedQuit?: boolean;
  /** Internal native probe bridge; tests inject fakes and production hosts provide the real bridge. */
  nativeHealthProbe?: NativeHealthProbeAdapter;
  /** macOS-only identity and user-data isolation for a separate Tweakers app. */
  macAppIdentity?: MacAppIdentity;
  /** Internal only: patch/sign a disposable candidate without global side effects. */
  candidateContext?: {
    paths: UserPaths;
    finalUserRoot: string;
    bundledDerivedBackend?: BundledDerivedBackendArtifact;
  };
  /** Private receipt-bound prebuilt backend and reviewed-runtime candidate input. */
  prebuiltCombinedCandidate?: PrebuiltCombinedCandidateInput;
  /** Promotion action: consume the exact held candidate and never rebuild it. */
  requirePreparedCandidate?: boolean;
  /** Internal only: repair already reconciles shims before its fast paths. */
  reconcileCliShims?: boolean;
  /**
   * Internal only: set by `tweaker mode tweakers` so the deliberate mode
   * switch may patch the live app while state.mode is still "chatgpt".
   */
  modeTransition?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(here, "..", "..", "assets");
const sourceRoot = findSourceRoot(here);
export const STAGED_NATIVE_HOST_RELATIVE_PATH = join(
  "Contents",
  "Resources",
  "tweakers",
  "native",
  "tweaker_native_host.node",
);

export function stagedNativeHostPath(appRoot: string): string {
  return join(appRoot, STAGED_NATIVE_HOST_RELATIVE_PATH);
}

export function bundledDerivedBackendPath(appRoot: string): string {
  return join(appRoot, "Contents", "Resources", "codex");
}

export const BUNDLED_DERIVED_VERSION_PROBE_TIMEOUT_MS = 15_000;

/**
 * Copy a receipt-validated, desktop-bundled-derived backend into a disposable
 * app. Both source and destination must stay on the internal filesystem, and
 * the copied bytes/version are re-probed before the caller signs the app.
 */
export function stageBundledDerivedBackendInsideApp(
  appRoot: string,
  artifact: BundledDerivedBackendArtifact,
  deps: {
    fingerprint?: (file: string) => string;
    readVersion?: (file: string) => string | null;
    copy?: (source: string, destination: string) => void;
  } = {},
): string {
  requireInternalExactPath(appRoot, "Bundled-derived candidate app");
  requireInternalExactFile(artifact.binaryPath, "Bundled-derived backend");
  requireInternalExactFile(artifact.receiptPath, "Bundled-derived receipt");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifact.transactionId)) {
    throw new Error("Bundled-derived transaction ID is invalid");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(artifact.version)) {
    throw new Error("Bundled-derived backend version is invalid");
  }
  const expectedFingerprint = artifact.fingerprint.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new Error("Bundled-derived backend fingerprint is invalid");
  }
  const fingerprint = deps.fingerprint ?? sha256RegularFile;
  const readVersion = deps.readVersion ?? probeCodexCliVersion;
  if (fingerprint(artifact.binaryPath).toLowerCase() !== expectedFingerprint) {
    throw new Error("Bundled-derived backend fingerprint does not match its validated descriptor");
  }
  if (readVersion(artifact.binaryPath) !== artifact.version) {
    throw new Error("Bundled-derived backend version does not match its validated descriptor");
  }

  const destination = bundledDerivedBackendPath(appRoot);
  const temporary = `${destination}.bundled-derived-${process.pid}.tmp`;
  mkdirSync(dirname(destination), { recursive: true });
  try {
    (deps.copy ?? copyFileSync)(artifact.binaryPath, temporary);
    chmodSync(temporary, 0o755);
    if (fingerprint(temporary).toLowerCase() !== expectedFingerprint) {
      throw new Error("Staged bundled-derived backend fingerprint does not match its validated descriptor");
    }
    if (readVersion(temporary) !== artifact.version) {
      throw new Error("Staged bundled-derived backend version does not match its validated descriptor");
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (fingerprint(destination).toLowerCase() !== expectedFingerprint) {
    throw new Error("Embedded bundled-derived backend fingerprint failed final verification");
  }
  if (readVersion(destination) !== artifact.version) {
    throw new Error("Embedded bundled-derived backend version failed final verification");
  }
  return destination;
}

function requireInternalExactPath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} path must be exact and absolute`);
  }
  assertInternalStoragePath(path, label);
}

function requireInternalExactFile(path: string, label: string): void {
  requireInternalExactPath(path, label);
  if (!existsSync(path)) throw new Error(`${label} is missing at ${path}`);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
}

function sha256RegularFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function probeCodexCliVersion(file: string): string | null {
  const result = spawnSync(file, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: BUNDLED_DERIVED_VERSION_PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\s+/).at(-1) ?? null;
}

/** Copy the native host into the app before the app's final inside-out sign. */
export function stageNativeHostInsideApp(appRoot: string, runtimeRoot: string): string {
  const source = join(runtimeRoot, "native", "tweaker_native_host.node");
  if (!existsSync(source)) throw new Error(`Tweakers native host is missing from staged runtime at ${source}`);
  const destination = stagedNativeHostPath(appRoot);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return destination;
}

export function verifyStagedNativeHostForApp(
  appRoot: string,
  deps: {
    verify?: typeof verifySignature;
    signature?: typeof signatureInfo;
    designatedRequirement?: (path: string) => string;
  } = {},
): string {
  const host = stagedNativeHostPath(appRoot);
  if (!existsSync(host)) throw new Error(`Signed candidate is missing its staged native host at ${host}`);
  verifyNativeHostMatchesApp(appRoot, host, deps);
  return host;
}

export function verifyNativeHostMatchesApp(
  appRoot: string,
  host: string,
  deps: {
    verify?: typeof verifySignature;
    signature?: typeof signatureInfo;
    designatedRequirement?: (path: string) => string;
  } = {},
): void {
  if (!existsSync(host)) throw new Error(`Native host is missing at ${host}`);
  const verify = deps.verify ?? verifySignature;
  const signature = deps.signature ?? signatureInfo;
  const appStrict = verify(appRoot);
  const hostStrict = verify(host);
  if (!appStrict.ok) throw new Error(`Signed candidate failed strict verification: ${appStrict.output}`);
  if (!hostStrict.ok) throw new Error(`Staged native host failed strict verification: ${hostStrict.output}`);
  const appIdentity = signature(appRoot);
  const hostIdentity = signature(host);
  if (!appIdentity.ok || !hostIdentity.ok) throw new Error("Candidate or staged native-host signing identity is unreadable");
  if (appIdentity.teamIdentifier !== hostIdentity.teamIdentifier) {
    throw new Error(
      `Staged native host Team ID does not match its containing candidate (${hostIdentity.teamIdentifier ?? "none"} != ${appIdentity.teamIdentifier ?? "none"})`,
    );
  }
  if (appIdentity.teamIdentifier === null) {
    const appAuthorities = appIdentity.authority.join("\n");
    const hostAuthorities = hostIdentity.authority.join("\n");
    const appIsBareAdHoc = appIdentity.adHoc && appAuthorities.length === 0;
    const hostIsBareAdHoc = hostIdentity.adHoc && hostAuthorities.length === 0;
    if (appIsBareAdHoc || hostIsBareAdHoc) {
      if (!appIsBareAdHoc || !hostIsBareAdHoc) {
        throw new Error("Staged native host does not share the candidate's local signing identity");
      }
      // Strict verification above proves the host is sealed into this exact
      // candidate. Bare ad-hoc signatures intentionally have no certificate
      // authority or leaf hash to compare.
      return;
    }
    if (appIdentity.adHoc !== hostIdentity.adHoc
      || appAuthorities.length === 0
      || appAuthorities !== hostAuthorities) {
      throw new Error("Staged native host does not share the candidate's local signing identity");
    }
    const designatedRequirement = deps.designatedRequirement ?? readDesignatedRequirement;
    const appLeaf = certificateLeafHash(designatedRequirement(appRoot));
    const hostLeaf = certificateLeafHash(designatedRequirement(host));
    if (appLeaf === null || hostLeaf === null || appLeaf !== hostLeaf) {
      throw new Error("Staged native host does not share the candidate's exact local signing certificate");
    }
  }
}

function readDesignatedRequirement(path: string): string {
  const result = spawnSync("/usr/bin/codesign", ["-dr", "-", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`Could not read the designated requirement for ${path}`);
  return output;
}

function certificateLeafHash(requirement: string): string | null {
  return /certificate leaf = H"([a-f0-9]+)"/i.exec(requirement)?.[1]?.toLowerCase() ?? null;
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export interface SwapHostIdentityEvidence {
  digest: string;
  strict: boolean;
  designatedRequirement: string;
  teamIdentifier: string | null;
  authority: string[];
  certificateLeafHash: string | null;
}

export interface SwapHostVerificationDeps {
  verify?: typeof verifySignature;
  signature?: typeof signatureInfo;
  designatedRequirement?: (path: string) => string;
}

/**
 * Describe a native host on its own terms, without reference to a containing
 * app. A receipt-owned helper has no signing container, so its identity is
 * pinned by digest plus the exact signing facts recorded when it was staged.
 */
export function readSwapHostIdentity(
  hostPath: string,
  deps: SwapHostVerificationDeps = {},
): SwapHostIdentityEvidence {
  const entry = lstatSync(hostPath);
  if (!entry.isFile()) throw new Error(`Swap host must be a regular file: ${hostPath}`);
  const verify = deps.verify ?? verifySignature;
  const signature = deps.signature ?? signatureInfo;
  const designatedRequirement = deps.designatedRequirement ?? readDesignatedRequirement;
  const strict = verify(hostPath);
  if (!strict.ok) throw new Error(`Swap host failed strict verification: ${strict.output}`);
  const identity = signature(hostPath);
  if (!identity.ok) throw new Error(`Swap host signing identity is unreadable at ${hostPath}`);
  const requirement = designatedRequirement(hostPath);
  if (requirement.trim().length === 0) {
    throw new Error(`Swap host designated requirement is empty at ${hostPath}`);
  }
  return {
    digest: sha256Of(hostPath),
    strict: true,
    designatedRequirement: requirement,
    teamIdentifier: identity.teamIdentifier,
    authority: identity.authority,
    certificateLeafHash: certificateLeafHash(requirement),
  };
}

/**
 * Copy a signed native host out of a prepared app payload into the receipt's
 * own directory. The source is whichever prepared payload actually carries a
 * host — the Tweakers candidate on the way in, the Tweakers rollback clone on
 * the way out — and it is verified against its containing bundle before the
 * copy, so the receipt-owned file inherits proven provenance.
 */
export function stagePreparedSwapHost(
  candidateAppPaths: string[],
  destination: string,
  deps: SwapHostVerificationDeps = {},
): { sourceAppPath: string; identity: SwapHostIdentityEvidence } | null {
  for (const appRoot of candidateAppPaths) {
    const hostPath = stagedNativeHostPath(appRoot);
    if (!existsSync(hostPath)) continue;
    verifyNativeHostMatchesApp(appRoot, hostPath, deps);
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { force: true });
    copyFileSync(hostPath, destination);
    const identity = readSwapHostIdentity(destination, deps);
    if (identity.digest !== sha256Of(hostPath)) {
      throw new Error(`Swap host changed while it was being staged from ${hostPath}`);
    }
    return { sourceAppPath: appRoot, identity };
  }
  // A transition between two host-less payloads needs no bundle exchange, so
  // the absence of a host is not by itself an error. Callers that do need to
  // swap still fail closed when they try to load the missing evidence.
  return null;
}

/**
 * `require` caches by resolved path, so a single stable helper path per
 * process also guarantees the addon's Objective-C classes are registered once.
 */
export function loadVerifiedSwapHost(
  evidence: SwapHostIdentityEvidence & { path: string },
  deps: SwapHostVerificationDeps = {},
): (first: string, second: string) => void {
  if (process.platform !== "darwin") throw new Error("Atomic app bundle exchange is available only on macOS");
  const observed = readSwapHostIdentity(evidence.path, deps);
  if (observed.digest !== evidence.digest) {
    throw new Error(`Swap host digest does not match its prepared evidence at ${evidence.path}`);
  }
  if (observed.teamIdentifier !== evidence.teamIdentifier
    || observed.certificateLeafHash !== evidence.certificateLeafHash
    || observed.authority.join("\n") !== evidence.authority.join("\n")) {
    throw new Error(`Swap host signing identity does not match its prepared evidence at ${evidence.path}`);
  }
  const require = createRequire(import.meta.url);
  const nativeHost = require(evidence.path) as NativeAppIdentityHost;
  return (first, second) => nativeHost.swapDirectories(first, second);
}

const HEALTH_PROBE_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

const HEALTH_PROBE_PLATFORM_ENV_KEYS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ["HOME", "USER", "LOGNAME", "__CF_USER_TEXT_ENCODING"],
  linux: [
    "HOME",
    "USER",
    "LOGNAME",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ],
  win32: ["USERPROFILE", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"],
};

export const HEALTH_PROBE_TEMP_RELATIVE_PATH = "tmp";
export const HEALTH_PROBE_CODEX_HOME_RELATIVE_PATH = "codex-home";
export const HEALTH_PROBE_USER_DATA_RELATIVE_PATH = "electron-user-data";
export const HEALTH_PROBE_ROOT_PREFIX = "probe-";
export const HEALTH_PROBE_PROCESS_TIMEOUT_MS = 170_000;
export const HEALTH_PROBE_RECEIPT_TIMEOUT_MS = 170_000;

function requireRealDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

interface HealthProbeSandbox {
  root: string;
  tempRoot: string;
  codexHome: string;
  userDataRoot: string;
}

interface HealthProbeLaunchDependencies {
  spawn?: typeof spawnSync;
  /** Source-only Codex home. Its bounded config/policy files are copied into the fresh probe home. */
  candidateCodexHome?: string;
  /** Internal seam for proving that ambient authentication data is excluded. */
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Internal test seam; production always removes the exact disposable root recursively. */
  removeProbeRoot?: (probeRoot: string) => void;
}

function isStrictDescendant(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative.length > 0
    && !isAbsolute(childRelative)
    && !/^\.\.(?:[\\/]|$)/.test(childRelative);
}

function prepareHealthProbeSandbox(userRoot: string): HealthProbeSandbox {
  if (!isAbsolute(userRoot) || resolve(userRoot) !== userRoot) {
    throw new Error(`Health probe user root must be an exact absolute path: ${userRoot}`);
  }
  requireRealDirectory(userRoot, "Health probe user root");

  const healthRoot = join(userRoot, "health");
  if (!existsSync(healthRoot)) mkdirSync(healthRoot, { mode: 0o700 });
  requireRealDirectory(healthRoot, "Health probe receipt directory");
  const realUserRoot = realpathSync(userRoot);
  const realHealthRoot = realpathSync(healthRoot);
  if (!isStrictDescendant(realUserRoot, realHealthRoot)) {
    throw new Error(`Health probe receipt directory resolves outside its user root: ${healthRoot}`);
  }
  chmodSync(healthRoot, 0o700);

  const probeRoot = mkdtempSync(join(healthRoot, HEALTH_PROBE_ROOT_PREFIX));
  chmodSync(probeRoot, 0o700);
  requireRealDirectory(probeRoot, "Health probe disposable root");
  const realProbeRoot = realpathSync(probeRoot);
  if (!isStrictDescendant(realHealthRoot, realProbeRoot)) {
    rmSync(probeRoot, { recursive: true, force: true });
    throw new Error(`Health probe disposable root resolves outside its receipt directory: ${probeRoot}`);
  }

  const makeContainedDirectory = (name: string, label: string): string => {
    const path = join(probeRoot, name);
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    requireRealDirectory(path, label);
    const realPath = realpathSync(path);
    if (!isStrictDescendant(realProbeRoot, realPath)) {
      throw new Error(`${label} resolves outside its disposable root: ${path}`);
    }
    return path;
  };

  try {
    return {
      root: probeRoot,
      tempRoot: makeContainedDirectory(HEALTH_PROBE_TEMP_RELATIVE_PATH, "Health probe temp directory"),
      codexHome: makeContainedDirectory(HEALTH_PROBE_CODEX_HOME_RELATIVE_PATH, "Health probe Codex home"),
      userDataRoot: makeContainedDirectory(HEALTH_PROBE_USER_DATA_RELATIVE_PATH, "Health probe Electron user-data directory"),
    };
  } catch (error) {
    rmSync(probeRoot, { recursive: true, force: true });
    throw error;
  }
}

function cleanupHealthProbeSandbox(
  userRoot: string,
  sandbox: HealthProbeSandbox,
  removeProbeRoot?: (probeRoot: string) => void,
): void {
  const expectedHealthRoot = join(userRoot, "health");
  if (!isStrictDescendant(expectedHealthRoot, sandbox.root)) {
    throw new Error(`Refusing to clean non-contained health probe root: ${sandbox.root}`);
  }
  if (existsSync(sandbox.root)) {
    const stat = lstatSync(sandbox.root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      rmSync(sandbox.root, { force: true });
      throw new Error(`Health probe disposable root changed type before cleanup: ${sandbox.root}`);
    }
    const realHealthRoot = realpathSync(expectedHealthRoot);
    const realProbeRoot = realpathSync(sandbox.root);
    if (!isStrictDescendant(realHealthRoot, realProbeRoot)) {
      throw new Error(`Refusing to clean health probe root that resolves outside containment: ${sandbox.root}`);
    }
  }
  (removeProbeRoot ?? ((probeRoot) => rmSync(probeRoot, { recursive: true, force: true })))(sandbox.root);
  if (existsSync(sandbox.root)) {
    throw new Error(`Health probe disposable root could not be removed: ${sandbox.root}`);
  }
}

function withHealthProbeSandbox<T>(
  userRoot: string,
  deps: Pick<HealthProbeLaunchDependencies, "removeProbeRoot">,
  operation: (sandbox: HealthProbeSandbox) => T,
): T {
  const sandbox = prepareHealthProbeSandbox(userRoot);
  try {
    return operation(sandbox);
  } finally {
    cleanupHealthProbeSandbox(userRoot, sandbox, deps.removeProbeRoot);
  }
}

function requireCodexInputSource(path: string, label: string, containedBy?: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an exact absolute path: ${path}`);
  }
  requireRealDirectory(path, label);
  if (containedBy !== undefined) {
    if (!isStrictDescendant(containedBy, path)) {
      throw new Error(`${label} must be contained by its user root: ${path}`);
    }
    const realParent = realpathSync(containedBy);
    const realPath = realpathSync(path);
    if (!isStrictDescendant(realParent, realPath)) {
      throw new Error(`${label} resolves outside its user root: ${path}`);
    }
  }
}

function healthProbeEnvironment(
  userRoot: string,
  sandbox: HealthProbeSandbox,
  platform: NodeJS.Platform,
  parentEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const permittedKeys = [
    ...HEALTH_PROBE_ENV_KEYS,
    ...(HEALTH_PROBE_PLATFORM_ENV_KEYS[platform] ?? []),
  ];
  for (const key of permittedKeys) {
    const value = parentEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }

  // Every health process gets contained home, Codex-home, temporary, and
  // Chromium-profile roots. This keeps fallback reads away from the real
  // account even when the original desktop bootstrap runs for renderer proof.
  if (platform === "win32") environment.USERPROFILE = sandbox.root;
  else environment.HOME = sandbox.root;

  if (platform === "win32") {
    environment.TEMP = sandbox.tempRoot;
    environment.TMP = sandbox.tempRoot;
  } else {
    environment.TMPDIR = sandbox.tempRoot;
  }

  environment.TWEAKERS_HEALTH_CHECK_ONLY = "1";
  environment.TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN = "1";
  environment.TWEAKERS_HEALTH_USER_ROOT = userRoot;
  environment.TWEAKERS_HEALTH_BACKGROUND = "1";
  environment.CODEX_HOME = sandbox.codexHome;
  environment.TWEAKERS_CANDIDATE_MCP_RECONCILIATION = "1";
  return environment;
}

function launchHealthProbe(
  executable: string,
  userRoot: string,
  sandbox: HealthProbeSandbox,
  deps: HealthProbeLaunchDependencies,
): ReturnType<typeof spawnSync> {
  const platform = deps.platform ?? process.platform;
  const chromiumArgs = [
    `--user-data-dir=${sandbox.userDataRoot}`,
    ...(platform === "darwin" ? ["--use-mock-keychain"] : []),
  ];
  return (deps.spawn ?? spawnSync)(executable, chromiumArgs, {
    env: healthProbeEnvironment(userRoot, sandbox, platform, deps.environment ?? process.env),
    stdio: "ignore",
    timeout: HEALTH_PROBE_PROCESS_TIMEOUT_MS,
  });
}

function stageBoundedCodexInputs(sourceCodexHome: string, containedCodexHome: string): void {
  for (const name of ["config.toml", ".codex-global-state.json"] as const) {
    const source = join(sourceCodexHome, name);
    if (!existsSync(source)) continue;
    const sourceStat = lstatSync(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size > 10 * 1024 * 1024) {
      throw new Error(`Health probe Codex input must be a bounded regular file: ${source}`);
    }
    copyCandidatePreimage(source, join(containedCodexHome, name));
  }
}

export function spawnHiddenHealthProbe(
  executable: string,
  userRoot: string,
  deps: HealthProbeLaunchDependencies = {},
): ReturnType<typeof spawnSync> {
  if (deps.candidateCodexHome !== undefined) {
    requireCodexInputSource(deps.candidateCodexHome, "Health probe candidate Codex home", userRoot);
  }
  return withHealthProbeSandbox(userRoot, deps, (sandbox) => {
    if (deps.candidateCodexHome !== undefined) {
      stageBoundedCodexInputs(deps.candidateCodexHome, sandbox.codexHome);
    }
    return launchHealthProbe(executable, userRoot, sandbox, deps);
  });
}

/**
 * Run one contained health process with a private, short-lived copy of the
 * durable Codex authentication proof. Candidate and post-promotion probes use
 * this same seam so neither can fall back to an ambient home or retain auth.
 */
export function spawnAuthenticatedHiddenHealthProbe(
  executable: string,
  userRoot: string,
  liveCodexHome: string,
  deps: HealthProbeLaunchDependencies = {},
): ReturnType<typeof spawnSync> {
  requireCodexInputSource(liveCodexHome, "Live Codex home");
  const sourceCodexHome = deps.candidateCodexHome ?? liveCodexHome;
  requireCodexInputSource(
    sourceCodexHome,
    deps.candidateCodexHome === undefined ? "Live Codex home" : "Health probe candidate Codex home",
    deps.candidateCodexHome === undefined ? undefined : userRoot,
  );
  return withHealthProbeSandbox(userRoot, deps, (sandbox) => {
    stageBoundedCodexInputs(sourceCodexHome, sandbox.codexHome);
    const removeAuth = stageCandidateCodexAuth(liveCodexHome, sandbox.codexHome);
    try {
      return launchHealthProbe(executable, userRoot, sandbox, deps);
    } finally {
      removeAuth();
      if (existsSync(join(sandbox.codexHome, "auth.json"))) {
        throw new Error("Contained Codex authentication proof was not removed after health probe");
      }
    }
  });
}

export async function install(opts: Opts = {}): Promise<void> {
  if (opts.candidateContext) return installCandidateInPlace(opts);
  const paths = ensureUserPaths();
  return withLifecycleLock(lifecycleLockFile(paths.root), "install or repair promotion", () => installWithLifecycle(opts, paths));
}

export async function prebuiltCombinedCandidate(
  action: string,
  cliOptions: PrebuiltCombinedCandidateCliOptions,
): Promise<void> {
  const resolved = resolvePrebuiltCombinedCandidateCliInput(action, cliOptions);
  await install({
    app: resolved.app,
    watcher: false,
    localSigning: true,
    candidateOnly: resolved.candidateOnly,
    candidateOnlyReason: "coordinated-refresh",
    prebuiltCombinedCandidate: resolved.input,
    requirePreparedCandidate: resolved.action === "promote",
    reconcileCliShims: false,
  });
}

async function installWithLifecycle(opts: Opts, paths: UserPaths): Promise<void> {
  assertLifecycleReceiptsIdle(paths.root);
  if (opts.localSigning === false && opts.candidateOnly !== true) {
    throw new Error("Ad-hoc signing is allowed only with explicit --candidate-only and can never be promoted.");
  }

  // Mutation-site mode guard: while ChatGPT mode is active the official app
  // stays pristine, so no caller (CLI, watcher repair, held promotion re-entry)
  // may patch it without either the deliberate mode-switch flag or the exact
  // receipt-bound prepare/promote authority. This closes the watcher race —
  // every promotion path re-enters install() and re-reads the mode here.
  if (!installMayRunWhileChatgptMode(opts) && readState(paths.stateFile)?.mode === "chatgpt") {
    throw new Error(
      "Refusing to install while ChatGPT mode is active.\n" +
        "The app at the official path stays pristine in ChatGPT mode.\n" +
        `Run ${kleur.cyan("tweaker mode tweakers")} to switch back to the patched app.`,
    );
  }

  const codex = locateCodex(opts.app);
  const source = fingerprintCodex(codex);
  const basePayloadHash = installerPayloadHash();
  if (
    opts.prebuiltCombinedCandidate
    && (
      opts.localSigning === false
      || opts.watcher !== false
      || opts.candidateOnlyReason !== "coordinated-refresh"
    )
  ) {
    throw new Error(
      "Prebuilt combined candidates require local signing, no watcher, and coordinated-refresh intent",
    );
  }
  let prebuiltAuthority: PrebuiltCombinedCandidateAuthority | undefined =
    opts.prebuiltCombinedCandidate
      ? validatePrebuiltCombinedCandidate(opts.prebuiltCombinedCandidate, {
        installerPayloadHash: basePayloadHash,
        runtimeRoot: join(assetsDir, "runtime"),
        sourceAppRoot: codex.appRoot,
      })
      : undefined;
  const payloadHash = prebuiltAuthority?.payloadIdentity ?? basePayloadHash;
  const candidateUserRoot = join(paths.transactionRoot, "candidate-user");
  const candidatePaths = transactionUserPaths(candidateUserRoot);
  const liveCodexHome = join(targetUserHome(), ".codex");
  const candidateCodexHome = join(candidateUserRoot, "codex-home");
  // Rollout transaction IDs are capped at 128 chars; two full sha256 digests
  // plus the separator is 129, so bind the key to 128-bit prefixes of each.
  const rolloutKey = `${source.hash.slice(0, 32)}-${payloadHash.slice(0, 32)}`;
  const liveUserQuestionsReceiptFile = join(paths.transactionRoot, "user-questions", `${rolloutKey}.json`);
  const liveUserQuestionsArchiveRoot = join(paths.transactionRoot, "user-questions", rolloutKey);
  let candidateHealthExpectation: ProductionHealthExpectationV2 | null = null;
  let liveHealthExpectation: ProductionHealthExpectationV2 | null = null;
  let liveUserQuestionsReceipt: UserQuestionsRolloutReceipt | null = null;
  let liveMcpConflictCount: number | null = null;
  const candidateSignedBackup = join(candidatePaths.backup, "Codex.app");
  const liveSignedBackup = join(paths.backup, "Codex.app");
  const signedBackupSnapshot = join(paths.transactionRoot, "last-known-good-backup");
  const signedBackupSnapshotState = join(paths.transactionRoot, "last-known-good-backup.json");
  const signedBackupWiring = createSignedBackupTransactionWiring({
    candidateBackup: candidateSignedBackup,
    liveBackup: liveSignedBackup,
    snapshot: signedBackupSnapshot,
    marker: signedBackupSnapshotState,
  });
  const nonLiveAppRoots = [
    join(paths.transactionRoot, "candidate.app"),
    join(paths.transactionRoot, "pristine.app"),
    join(paths.transactionRoot, "last-known-good.app"),
    candidateSignedBackup,
    liveSignedBackup,
    join(targetUserHome(), "Library", "Application Support", "Tweakers", "pristine-backup", "ChatGPT.app"),
    "/Volumes/ChatGPT Installer/ChatGPT.app",
  ];
  const reconcileMacRegistrations = (options: { garbageCollect: boolean }): void => {
    if (codex.platform !== "darwin") return;
    const launchServices = reconcileLaunchServices({
      appRoot: codex.appRoot,
      bundleId: opts.macAppIdentity?.bundleId ?? codex.bundleId ?? "com.openai.codex",
      nonLiveAppRoots,
      garbageCollect: options.garbageCollect,
      mutate: !candidateOnly,
    });
    if (launchServices.failed.length > 0 && !opts.quiet) {
      console.warn(kleur.yellow(`LaunchServices cleanup was incomplete: ${launchServices.failed.map((failure) => failure.path).join(", ")}`));
    }
  };
  const reconcileMacIdentityAfterPromotion = (): void => {
    reconcileMacRegistrations({ garbageCollect: true });
    try {
      reconcileDock({
        appRoot: codex.appRoot,
        bundleId: opts.macAppIdentity?.bundleId ?? codex.bundleId ?? "com.openai.codex",
        backupDir: paths.backup,
      });
    } catch (error) {
      if (!opts.quiet) console.warn(kleur.yellow(`Dock cleanup was skipped: ${errorMessage(error)}`));
    }
  };
  const requiredPermissions = requiredMacPermissions(paths.configFile);
  const candidateOnly = opts.candidateOnly === true;
  const signingMode = opts.localSigning === false ? "adhoc" : "local-identity";
  const adapters = filesystemTransactionAdapters({
    validatePrebuiltCombinedCandidateAuthority: prebuiltAuthority
      ? (authority) => {
        const refreshed = validatePrebuiltCombinedCandidate(opts.prebuiltCombinedCandidate!, {
          installerPayloadHash: basePayloadHash,
          runtimeRoot: join(assetsDir, "runtime"),
          sourceAppRoot: codex.appRoot,
        });
        if (
          refreshed.payloadIdentity !== authority.payloadIdentity
          || refreshed.transactionId !== authority.transactionId
          || JSON.stringify(refreshed) !== JSON.stringify(authority)
        ) {
          throw new Error("Prebuilt combined candidate authority drifted before transaction entry");
        }
        prebuiltAuthority = refreshed;
      }
      : undefined,
    validatePrebuiltRollbackRoots: prebuiltAuthority
      ? (state) => {
        capturePrebuiltRollbackEvidence({
          lastKnownGoodRoot: state.lastKnownGoodRoot,
          lastKnownGoodRuntimeRoot: state.lastKnownGoodRuntimeRoot,
          signedBackupRoot: signedBackupSnapshot,
          signedBackupMarker: signedBackupSnapshotState,
        });
      }
      : undefined,
    removeSupersededPrebuiltCandidateArtifacts: prebuiltAuthority
      ? (state) => {
        const expectedCandidate = join(paths.transactionRoot, "candidate.app");
        const expectedPristine = join(paths.transactionRoot, "pristine.app");
        if (
          resolve(state.candidateRoot) !== expectedCandidate
          || resolve(state.pristineRoot) !== expectedPristine
        ) {
          throw new Error("Stale candidate artifact paths do not match the app-install transaction root");
        }
        rmSync(expectedCandidate, { recursive: true, force: true });
        rmSync(expectedPristine, { recursive: true, force: true });
        rmSync(candidateUserRoot, { recursive: true, force: true });
      }
      : undefined,
    capturePreparedPrebuiltCombinedCandidateEvidence: prebuiltAuthority
      ? (state) => capturePreparedPrebuiltCombinedCandidateEvidence(prebuiltAuthority!, {
        candidateRoot: state.candidateRoot,
        candidateRuntimeRoot: candidatePaths.runtime,
        lastKnownGoodRoot: state.lastKnownGoodRoot,
        lastKnownGoodRuntimeRoot: state.lastKnownGoodRuntimeRoot,
        signedBackupRoot: signedBackupSnapshot,
        signedBackupMarker: signedBackupSnapshotState,
      })
      : undefined,
    validatePreparedPrebuiltCombinedCandidateEvidence: prebuiltAuthority
      ? (state, context) => {
        const prepared = state.prebuiltCombinedCandidate?.prepared;
        if (!prepared) throw new Error("Prepared prebuilt combined candidate receipt evidence is missing");
        assertPreparedPrebuiltCombinedCandidateEvidence(prebuiltAuthority!, prepared, {
          candidateRoot: state.candidateRoot,
          candidateRuntimeRoot: candidatePaths.runtime,
          lastKnownGoodRoot: state.lastKnownGoodRoot,
          lastKnownGoodRuntimeRoot: state.lastKnownGoodRuntimeRoot,
          signedBackupRoot: signedBackupSnapshot,
          signedBackupMarker: signedBackupSnapshotState,
        });
        candidateHealthExpectation = readCandidatePromotionHealthExpectation(
          join(candidateUserRoot, "health", "request.json"),
          {
            transactionCreatedAt: state.createdAt,
            now: context.now,
            maxAgeMs: context.maxCandidateAgeMs,
          },
        );
        if (!candidateHealthExpectation) {
          throw new Error("Prepared candidate schema-v2 health expectation is unavailable");
        }
      }
      : undefined,
    isAppRunning: (appRoot) => reportsMainProcessRunning(getOpenReport(locateCodex(appRoot))),
    buildCandidate: async (_pristineRoot, candidateRoot) => {
      resetCandidateUserRootForBuild(candidateUserRoot);
      stageCandidateRolloutInputs({
        livePaths: paths,
        candidatePaths,
        liveCodexHome,
        candidateCodexHome,
      });
      await installCandidateInPlace({
        ...opts,
        app: candidateRoot,
        watcher: false,
        quiet: true,
        localSigning: signingMode === "local-identity",
        candidateContext: {
          paths: candidatePaths,
          finalUserRoot: paths.root,
          ...(prebuiltAuthority ? {
            bundledDerivedBackend: {
              binaryPath: prebuiltAuthority.backend.sourcePath,
              version: prebuiltAuthority.backend.version,
              fingerprint: prebuiltAuthority.backend.sha256,
              receiptPath: prebuiltAuthority.acceptedBuildReceipt.path,
              transactionId: prebuiltAuthority.transactionId,
            },
          } : {}),
        },
      });
      stageBundledTweaks(candidatePaths.tweaks, candidatePaths.runtime);
      const candidateRolloutOptions = defaultUserQuestionsRolloutOptions({
        userRoot: candidateUserRoot,
        liveTweaksRoot: candidatePaths.tweaks,
        tweakersConfigPath: candidatePaths.configFile,
        codexConfigPath: join(candidateCodexHome, "config.toml"),
        receiptFile: join(candidateUserRoot, "transactions", "user-questions-rollout.json"),
        archiveRoot: join(candidateUserRoot, "transactions", "user-questions-rollout"),
        transactionId: `candidate-${payloadHash}`,
      });
      const candidatePrepared = prepareUserQuestionsRollout(planUserQuestionsRollout(candidateRolloutOptions));
      if (candidatePrepared.phase !== "prepared") {
        throw new Error("Candidate User Questions rollout held before health validation");
      }
      const candidateMcpReceipt = reconcilePromotionMcpConfig({
        runtimeRoot: candidatePaths.runtime,
        tweaksRoot: candidatePaths.tweaks,
        userRoot: candidateUserRoot,
        tweakersConfigPath: candidatePaths.configFile,
        codexConfigPath: join(candidateCodexHome, "config.toml"),
        statePath: join(candidateUserRoot, "mcp-sync-state.json"),
      });
      sealUserQuestionsRollout(candidatePrepared, { mcpConflictCount: candidateMcpReceipt.conflictCount });
      assertPromotionMcpReceipt(candidateMcpReceipt, "candidate");
      const candidate = locateCodex(candidateRoot);
      candidateHealthExpectation = buildPromotionHealthExpectation({
        app: fingerprintCodex(candidate),
        before: promotionSurfaceRoots({
          appHash: source.hash,
          runtimeRoot: paths.runtime,
          tweaksRoot: paths.tweaks,
          userRoot: paths.root,
          tweakersConfigPath: paths.configFile,
          codexHome: liveCodexHome,
        }),
        after: promotionSurfaceRoots({
          appHash: fingerprintCodex(candidate).hash,
          runtimeRoot: candidatePaths.runtime,
          tweaksRoot: candidatePaths.tweaks,
          userRoot: candidateUserRoot,
          tweakersConfigPath: candidatePaths.configFile,
          codexHome: candidateCodexHome,
        }),
        requiredPermissions,
        userQuestionsRoot: join(candidatePaths.tweaks, USER_QUESTIONS_FOLDER),
      });
    },
    validateCandidate: (candidateRoot) => {
      try {
        const candidate = locateCodex(candidateRoot);
        if (candidate.platform === "darwin") {
          const signature = verifySignature(candidateRoot);
          if (!signature.ok) throw new Error(`candidate signature invalid: ${signature.output.trim().slice(0, 400)}`);
          if (!signedBackupWiring.validateCandidate()) throw new Error("candidate Developer-ID backup missing or unsigned");
        }
        const marker = readAsarMarker(candidate.asarPath);
        if (marker === "unreadable") throw new Error("candidate app.asar could not be read (corrupt or locked)");
        if (marker === "absent") throw new Error("patch marker absent from candidate app.asar (asar not patched)");
        validateMainRendererAsarEntrypoint(candidate.asarPath);
        return true;
      } finally {
        reconcileMacRegistrations({ garbageCollect: false });
      }
    },
    // A last-known-good snapshot may be a pristine app (taken right after an
    // official Codex update), so a restore is valid without the patch marker.
    validateRestoredApp: (appRoot) => {
      const restored = locateCodex(appRoot);
      // The candidate/LKG bytes were already deep-verified (codesign --verify
      // --deep --strict) before staging, and promotion is an atomic swap — so a
      // cheap identity check (codesign -dv) is sufficient here, not a second
      // full deep verify.
      return restored.platform === "darwin" ? signatureInfo(appRoot).ok : true;
    },
    probeCandidateHealth: ({ candidateRoot }) => {
      try {
        const candidate = locateCodex(candidateRoot);
        validateMainRendererAsarEntrypoint(candidate.asarPath);
        const expected = candidateHealthExpectation;
        if (!expected || !sameAppFingerprint(expected.app, fingerprintCodex(candidate))) {
          return unknownPromotionHealth(requiredPermissions);
        }
        const receiptFile = join(candidateUserRoot, "health", "promotion.json");
        writeHealthRequest(join(candidateUserRoot, "health", "request.json"), {
          ...expected,
          requestedAt: new Date().toISOString(),
        });
        const launched = spawnAuthenticatedHiddenHealthProbe(
          candidate.executable,
          candidateUserRoot,
          liveCodexHome,
          { candidateCodexHome },
        );
        if (launched.error || launched.status !== 0) {
          return unknownPromotionHealth(requiredPermissions);
        }
        return readProductionHealthReceipt(receiptFile, expected);
      } catch {
        return unknownPromotionHealth(requiredPermissions);
      } finally {
        reconcileMacRegistrations({ garbageCollect: false });
      }
    },
    fingerprintApp: (appRoot) => fingerprintCodex(locateCodex(appRoot)),
    snapshotRuntime: (runtimeRoot, destination) => {
      rmSync(destination, { recursive: true, force: true });
      if (existsSync(runtimeRoot)) {
        mkdirSync(dirname(destination), { recursive: true });
        copyDirectoryPreservingModes(runtimeRoot, destination);
      }
      signedBackupWiring.snapshotLive();
    },
    promoteCandidate: async (candidateRoot, appRoot) => {
      // dev-sync already owns the schema-v2 managed-tree transaction. Load its
      // public seam lazily to avoid an eager install.ts <-> dev-sync.ts cycle.
      const {
        prepareDevSnapshot,
        readDevSnapshotReceipt,
        rollbackDevSnapshot,
      } = await import("./dev-sync.js");
      try {
        prepareDevSnapshot(candidatePaths.tweaks, paths.tweaks);
        const existingRollout = readUserQuestionsRolloutReceipt(liveUserQuestionsReceiptFile);
        liveUserQuestionsReceipt = existingRollout ?? planUserQuestionsRollout(defaultUserQuestionsRolloutOptions({
          userRoot: paths.root,
          liveTweaksRoot: paths.tweaks,
          tweakersConfigPath: paths.configFile,
          codexConfigPath: join(liveCodexHome, "config.toml"),
          receiptFile: liveUserQuestionsReceiptFile,
          archiveRoot: liveUserQuestionsArchiveRoot,
          transactionId: rolloutKey,
        }));
        if (liveUserQuestionsReceipt.phase === "planned" || liveUserQuestionsReceipt.phase === "held") {
          liveUserQuestionsReceipt = prepareUserQuestionsRollout(liveUserQuestionsReceipt);
        }
        if (liveUserQuestionsReceipt.phase !== "prepared" && liveUserQuestionsReceipt.phase !== "sealed") {
          throw new Error(`User Questions promotion transaction is not preparable: ${liveUserQuestionsReceipt.phase}`);
        }
        const mcpReceipt = reconcilePromotionMcpConfig({
          runtimeRoot: candidatePaths.runtime,
          tweaksRoot: paths.tweaks,
          userRoot: paths.root,
          tweakersConfigPath: paths.configFile,
          codexConfigPath: join(liveCodexHome, "config.toml"),
          statePath: join(paths.root, "mcp-sync-state.json"),
        });
        liveMcpConflictCount = mcpReceipt.conflictCount;
        if (liveUserQuestionsReceipt.phase === "prepared") {
          liveUserQuestionsReceipt = sealUserQuestionsRollout(liveUserQuestionsReceipt, {
            mcpConflictCount: mcpReceipt.conflictCount,
          });
        }
        assertPromotionMcpReceipt(mcpReceipt, "live");

        // Verify and promote the pristine Developer-ID backup before mutating
        // the app. If a later app/runtime swap fails, restore backup continuity
        // immediately; the outer transaction owns app/runtime recovery.
        signedBackupWiring.promoteCandidate();
        replaceAppBundlePreservingIdentity(candidateRoot, appRoot, {
          validateDestination: (promotedRoot) => verifySignature(promotedRoot).ok,
          onCleanupFailure: (path, error) => {
            if (!opts.quiet) console.warn(kleur.yellow(`Old app payload cleanup will be retried on the next refresh (${path}): ${errorMessage(error)}`));
          },
        });
        replaceDirectory(candidatePaths.runtime, paths.runtime);
        reconcileMacIdentityAfterPromotion();
        const promoted = locateCodex(appRoot);
        if (!candidateHealthExpectation) throw new Error("Candidate promotion preimages are unavailable");
        liveHealthExpectation = buildPromotionHealthExpectation({
          app: fingerprintCodex(promoted),
          before: promotionPreimageHashes(candidateHealthExpectation),
          after: promotionSurfaceRoots({
            appHash: fingerprintCodex(promoted).hash,
            runtimeRoot: paths.runtime,
            tweaksRoot: paths.tweaks,
            userRoot: paths.root,
            tweakersConfigPath: paths.configFile,
            codexHome: liveCodexHome,
          }),
          requiredPermissions,
          userQuestionsRoot: join(paths.tweaks, USER_QUESTIONS_FOLDER),
        });
      } catch (error) {
        signedBackupWiring.restoreLive();
        if (liveUserQuestionsReceipt && !["planned", "held", "rolled_back"].includes(liveUserQuestionsReceipt.phase)) {
          try { liveUserQuestionsReceipt = rollbackUserQuestionsRollout(liveUserQuestionsReceipt); } catch { /* outer recovery reports any persistent drift */ }
        }
        const snapshotPath = join(paths.tweaks, ".tweaker-dev-snapshot.json");
        if (readDevSnapshotReceipt(snapshotPath)?.phase === "pending_acceptance") {
          try { rollbackDevSnapshot(paths.tweaks); } catch { /* outer recovery reports any persistent drift */ }
        }
        throw error;
      }
    },
    restoreApp: (lastKnownGoodRoot, appRoot) => {
      replaceAppBundlePreservingIdentity(lastKnownGoodRoot, appRoot, {
        validateDestination: (restoredRoot) => verifySignature(restoredRoot).ok,
        onCleanupFailure: (path, error) => {
          if (!opts.quiet) console.warn(kleur.yellow(`Old app payload cleanup will be retried on the next refresh (${path}): ${errorMessage(error)}`));
        },
      });
      reconcileMacIdentityAfterPromotion();
    },
    restoreRuntime: (lastKnownGoodRuntimeRoot, runtimeRoot) => {
      if (existsSync(lastKnownGoodRuntimeRoot)) replaceDirectory(lastKnownGoodRuntimeRoot, runtimeRoot);
      else rmSync(runtimeRoot, { recursive: true, force: true });
      signedBackupWiring.restoreLive();
    },
    probeHealth: async () => {
      const expected = liveHealthExpectation;
      if (!expected) return unknownPromotionHealth(requiredPermissions);
      try {
        validateMainRendererAsarEntrypoint(locateCodex(codex.appRoot).asarPath);
      } catch {
        return unknownPromotionHealth(requiredPermissions);
      }
      const receiptFile = join(paths.root, "health", "promotion.json");
      const deadline = Date.now() + HEALTH_PROBE_RECEIPT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const observed = readProductionHealthReceipt(receiptFile, expected);
        if (observed.host !== "unknown" || observed.session !== "unknown") return observed;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return readProductionHealthReceipt(receiptFile, expected);
    },
    acceptPromotion: async () => {
      if (!liveUserQuestionsReceipt || liveUserQuestionsReceipt.phase !== "sealed" || liveMcpConflictCount !== 0) {
        throw new Error("User Questions rollout is not sealed with zero MCP conflicts");
      }
      liveUserQuestionsReceipt = commitUserQuestionsRollout(liveUserQuestionsReceipt);
      const { acceptDevSnapshot, readDevSnapshotReceipt } = await import("./dev-sync.js");
      const snapshotPath = join(paths.tweaks, ".tweaker-dev-snapshot.json");
      if (readDevSnapshotReceipt(snapshotPath)?.phase === "pending_acceptance") {
        acceptDevSnapshot(paths.tweaks);
      }
    },
    rollbackPromotion: async () => {
      if (liveUserQuestionsReceipt && !["planned", "held", "rolled_back"].includes(liveUserQuestionsReceipt.phase)) {
        liveUserQuestionsReceipt = rollbackUserQuestionsRollout(liveUserQuestionsReceipt);
      }
      const { readDevSnapshotReceipt, rollbackDevSnapshot } = await import("./dev-sync.js");
      const snapshotPath = join(paths.tweaks, ".tweaker-dev-snapshot.json");
      if (readDevSnapshotReceipt(snapshotPath)?.phase === "pending_acceptance") {
        rollbackDevSnapshot(paths.tweaks);
      }
    },
    openApp: (appRoot) => {
      const expected = liveHealthExpectation;
      if (!expected) throw new Error("Schema-v2 live health expectation is unavailable");
      writeHealthRequest(join(paths.root, "health", "request.json"), {
        ...expected,
        requestedAt: new Date().toISOString(),
      });
      // Generate the promotion-health receipt with the hidden health-check
      // probe rather than a plain `open`. A normal launch of an app whose
      // instance is already running (a variant repaired while open, or the
      // official app relaunched mid-install) is forwarded to that instance and
      // never reaches our receipt path, leaving host health "unknown". The
      // health-check probe carries its own throwaway --user-data-dir, so it
      // gets a distinct singleton and always runs far enough to answer. The
      // user-visible relaunch is handled separately by the reopen-after-patch
      // path; this launch is only for the receipt.
      const launched = spawnAuthenticatedHiddenHealthProbe(
        locateCodex(appRoot).executable,
        paths.root,
        liveCodexHome,
      );
      if (launched.error || launched.status !== 0 || launched.signal !== null) {
        throw new Error("Post-promotion health process did not exit cleanly");
      }
    },
  });

  const result = await runInstallTransaction({
    appRoot: codex.appRoot,
    runtimeRoot: paths.runtime,
    workRoot: paths.transactionRoot,
    stateFile: paths.transactionStateFile,
    source,
    payloadHash,
    requiredPermissions,
    requirePromotionHealthV2: true,
    candidateOnly,
    candidateOnlyReason: opts.candidateOnlyReason ?? "explicit",
    signingMode,
    prebuiltCombinedCandidate: prebuiltAuthority,
    requirePreparedCandidate: opts.requirePreparedCandidate,
  }, adapters);

  if (shouldReconcileCliShims(result.status, candidateOnly, opts.reconcileCliShims)) {
    const cliShims = reconcileManagedCliShims(sourceRoot, paths.root, paths.binDir);
    if (!opts.quiet) console.log(formatCliStep(formatCliShimResult(cliShims)));
  }

  if (result.status === "promoted") {
    if (!reportsMainProcessRunning(getOpenReport(codex))) {
      migrateLegacyTweakNamespaces(paths.root, paths.configFile);
    } else if (!opts.quiet) {
      console.warn(kleur.yellow("Legacy tweak data migration is deferred until Codex is closed."));
    }
    // An older healthy transaction can predate full-app backup promotion. Its
    // validated candidate-user backup is still the authoritative repair source;
    // repair that continuity without touching or reopening the live app.
    if (codex.platform === "darwin" && !isDeveloperIdSignedBackup(liveSignedBackup)) {
      promoteVerifiedSignedBackup(candidateSignedBackup, liveSignedBackup);
    }
    // Every promotion refreshes the LIVE full backup (signedBackupWiring), so
    // the live-root partial backups must be refreshed with it — otherwise
    // uninstall's partial-restore fallback could one day write a years-old
    // asar/Info.plist into a current bundle (the exact Chromium-profile
    // downgrade the mode toggle refuses).
    if (codex.platform === "darwin" && isDeveloperIdSignedBackup(liveSignedBackup)) {
      try {
        refreshLivePartialBackups(codex, liveSignedBackup, paths.backup);
      } catch (error) {
        if (!opts.quiet) console.warn(kleur.yellow(`Live partial-backup refresh failed: ${errorMessage(error)}`));
      }
    }
    ensureManagedRuntime(sourceRoot, paths.root);
    const candidateState = readState(candidatePaths.stateFile);
    if (candidateState) {
      let watcher: WatcherKind = "none";
      if (opts.watcher !== false) {
        try {
          watcher = installWatcher(codex.appRoot);
        } catch (error) {
          if (!opts.quiet) console.warn(kleur.yellow(`Watcher install failed: ${errorMessage(error)}`));
        }
      }
      writeState(paths.stateFile, {
        ...candidateState,
        appRoot: codex.appRoot,
        watcher,
      });
    }
    // A promoted live app is by definition in Tweakers mode, and any parked
    // ChatGPT-mode payload predates this promotion (now stale) — discard it.
    finalizePromotedModeState(paths.stateFile, paths.root);
    // Mode controls live in the existing Menu Bar app. Refresh its durable CLI
    // coordinator metadata and retire the old second status item nonfatally.
    if (codex.platform === "darwin") {
      try {
        const coordinator = await ensureModeCoordinatorConfigured();
        if (!coordinator.configured && !opts.quiet) {
          console.warn(kleur.yellow(`Menu Bar restart coordinator setup skipped: ${coordinator.reason ?? "unknown reason"}`));
        }
        const standalone = await removeStandaloneSwitcher();
        if (standalone.removed && !opts.quiet) console.log(kleur.dim("Retired the standalone Tweakers status item."));
      } catch (error) {
        if (!opts.quiet) console.warn(kleur.yellow(`Menu Bar coordinator migration failed: ${errorMessage(error)}`));
      }
    }
    try {
      migrateAutomatically(paths.root, join(assetsDir, "runtime", "tweaks"));
    } catch (error) {
      // Migration never deletes or mutates its legacy input. Keep a successful
      // app promotion usable while reporting the isolated data item failure.
      if (!opts.quiet) console.warn(kleur.yellow(`Legacy Projects migration was skipped: ${errorMessage(error)}`));
    }
    try {
      // Candidate staging prunes the candidate root; the LIVE tweaks dir is
      // user data that promotion never replaces, so retired tweaks staged by
      // an older runtime survive there unless pruned here.
      pruneRetiredTweaks(paths.tweaks, { devTweaksRoot: readDevTweaksRoot(paths.configFile) });
    } catch (error) {
      if (!opts.quiet) console.warn(kleur.yellow(`Retired-tweak pruning was skipped: ${errorMessage(error)}`));
    }
  }

  // Every terminal status must produce one unambiguous final line. Failure
  // states throw so the CLI exits non-zero and `wrap` prints the reason —
  // never return silently (that was the "candidate-only exits quietly" bug).
  const liveAppRoot = codex.appRoot;
  switch (result.status) {
    case "promoted":
      if (!opts.quiet) {
        console.log(kleur.green().bold(`✓ Tweakers installed and promoted into ${liveAppRoot}.`));
        console.log(`  Launch Codex normally; the Tweaks tab appears in Settings.`);
        if (requiredPermissions.length === 0) {
          console.log(
            kleur.yellow(`  macOS permissions: not verified (requiredMacPermissions unset in config).`),
          );
        }
      }
      return;
    case "candidate-ready":
      if (!opts.quiet) {
        console.log(kleur.green().bold("✓ Candidate validated (candidate-only)."));
        console.log(`  The live app at ${kleur.cyan(liveAppRoot)} was not modified.`);
        console.log(`  Disposable candidate + backup live under ${kleur.cyan(paths.transactionRoot)}.`);
        console.log(`  To go live: rerun ${kleur.cyan("tweaker install")} without --candidate-only.`);
      }
      return;
    case "held":
      console.log(kleur.yellow().bold("• Candidate validated and held."));
      console.log(`  Codex is currently running, so the live app was not changed.`);
      if (process.env.TWEAKER_WATCHER === "1" || process.env[LEGACY_WATCHER_ENV] === "1") {
        return runHeldPromotion(
          {
            getReport: () => getOpenReport(locateCodex(liveAppRoot)),
            guardModeAllowsPromotion: () => {
              if (opts.modeTransition === true) return true;
              return readState(paths.stateFile)?.mode !== "chatgpt";
            },
            quitApp: () => quitCodex(liveAppRoot),
            cleanupOrphans: () => {},
            notifyUpdateQuit: () => showCodexUpdateDetectedNotification(),
            // Re-entry always drops coordinatedQuit so a relaunch race yields a
            // plain held + passive wait, never a second forced quit.
            reenter: () => install({ ...opts, coordinatedQuit: false }),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            log: (line) => console.log(`  ${line}`),
          },
          { coordinatedQuit: opts.coordinatedQuit === true },
        );
      }
      console.log(`  Quit Codex, then rerun ${kleur.cyan("tweaker install")} (or let the watcher promote it).`);
      return;
    case "rolled-back":
      throw new Error(
        `Promotion health check failed; rolled back to the last-known-good app and runtime ` +
          `(rollback ${result.state.rollbackResult ?? "attempted"}).\n` +
          `Reason: ${result.state.failure ?? "unknown"}\n` +
          `The live app at ${liveAppRoot} is the restored, working version.`,
      );
    case "blocked":
      throw new Error(
        `A previous promotion left the install in a degraded state and auto-recovery is blocked.\n` +
          `Reason: ${result.state.failure ?? "unknown"}\n` +
          `Quit Codex and run "tweaker repair --force", or restore from ${result.state.lastKnownGoodRoot}.`,
      );
    case "invalidated":
      throw new Error(formatInvalidatedInstallError(liveAppRoot, result.state.failure, result.state.pendingReason));
    default:
      throw new Error(`Install finished in an unexpected state: ${(result as { status: string }).status}`);
  }
}

export function installMayRunWhileChatgptMode(
  opts: Pick<Opts, "modeTransition" | "prebuiltCombinedCandidate" | "candidateOnly" | "requirePreparedCandidate">,
): boolean {
  if (opts.modeTransition === true) return true;
  if (!opts.prebuiltCombinedCandidate) return false;
  return opts.candidateOnly === true || opts.requirePreparedCandidate === true;
}

export interface BuildPatchedCandidateOnlyInput {
  sourceApp: string;
  destinationApp: string;
  /** Durable receipt-owned copy of the runtime validated inside the candidate. */
  destinationRuntime: string;
  finalUserRoot: string;
  /**
   * Exact receipt-validated backend derived from the installed desktop's
   * bundled Codex tag. This remains the bundled lane; it is never exposed as a
   * managed Stable/Beta selection.
   */
  bundledDerivedBackend?: BundledDerivedBackendArtifact;
}

export interface BundledDerivedBackendArtifact {
  binaryPath: string;
  version: string;
  fingerprint: string;
  receiptPath: string;
  transactionId: string;
}

/**
 * Build and sign a Tweakers app payload entirely inside a disposable
 * destination. This is the environment coordinator's production candidate
 * builder: it never quits, opens, replaces, or mutates the source/live app.
 */
export async function buildPatchedCandidateOnly(input: BuildPatchedCandidateOnlyInput): Promise<void> {
  const sourceApp = resolve(input.sourceApp);
  const destinationApp = resolve(input.destinationApp);
  const destinationRuntime = resolve(input.destinationRuntime);
  const finalUserRoot = resolve(input.finalUserRoot);
  if (!isAbsolute(input.sourceApp) || sourceApp !== input.sourceApp) {
    throw new Error("Patched candidate source must be an exact absolute path");
  }
  if (!isAbsolute(input.destinationApp) || destinationApp !== input.destinationApp) {
    throw new Error("Patched candidate destination must be an exact absolute path");
  }
  if (!isAbsolute(input.destinationRuntime) || destinationRuntime !== input.destinationRuntime) {
    throw new Error("Patched candidate runtime destination must be an exact absolute path");
  }
  if (!isAbsolute(input.finalUserRoot) || finalUserRoot !== input.finalUserRoot) {
    throw new Error("Patched candidate user root must be an exact absolute path");
  }
  assertDisjointPatchedCandidatePaths([sourceApp, destinationApp, destinationRuntime]);
  const source = locateCodex(sourceApp);
  if (source.platform !== "darwin") throw new Error("Environment candidates are supported only for macOS app bundles");
  if (source.bundleId !== "com.openai.codex" && source.bundleId !== "com.openai.codex.beta") {
    throw new Error("Patched candidate source has an unsupported app bundle identifier");
  }
  const sourceSignature = verifySignature(sourceApp);
  const sourceIdentity = signatureInfo(sourceApp);
  if (!sourceSignature.ok || sourceIdentity.teamIdentifier !== "2DC432GLL2") {
    throw new Error("Patched candidate source is not a strict OpenAI Developer ID app");
  }
  if (readAsarMarker(source.asarPath) !== "absent") {
    throw new Error("Patched candidate source must be pristine");
  }

  const candidateUserRoot = `${destinationApp}.tweakers-build-user`;
  rmSync(destinationApp, { recursive: true, force: true });
  rmSync(candidateUserRoot, { recursive: true, force: true });
  try {
    cloneAppTree(sourceApp, destinationApp);
    await installCandidateInPlace({
      app: destinationApp,
      fuse: true,
      resign: true,
      localSigning: true,
      watcher: false,
      quiet: true,
      candidateContext: {
        paths: transactionUserPaths(candidateUserRoot),
        finalUserRoot,
        ...(input.bundledDerivedBackend ? { bundledDerivedBackend: input.bundledDerivedBackend } : {}),
      },
    });
    const candidate = locateCodex(destinationApp);
    if (candidate.bundleId !== source.bundleId) throw new Error("Patched candidate changed the app bundle identifier");
    if (readAsarMarker(candidate.asarPath) !== "present") throw new Error("Patched candidate marker is absent");
    const candidateSignature = verifySignature(destinationApp);
    if (!candidateSignature.ok) throw new Error(`Patched candidate signature is invalid: ${candidateSignature.output}`);
    stagePatchedCandidateRuntimeArtifact(join(candidateUserRoot, "runtime"), destinationRuntime);
  } catch (error) {
    rmSync(destinationApp, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(candidateUserRoot, { recursive: true, force: true });
  }
}

/**
 * Persist the runtime that was built and validated with a disposable app
 * candidate. The replacement is atomic at the destination boundary, so a
 * failed staged-copy never exposes partial runtime bytes to a later promotion.
 */
export function stagePatchedCandidateRuntimeArtifact(candidateRuntime: string, destinationRuntime: string): void {
  const source = resolve(candidateRuntime);
  const destination = resolve(destinationRuntime);
  if (!isAbsolute(candidateRuntime) || source !== candidateRuntime) {
    throw new Error("Patched candidate runtime source must be an exact absolute path");
  }
  if (!isAbsolute(destinationRuntime) || destination !== destinationRuntime) {
    throw new Error("Patched candidate runtime destination must be an exact absolute path");
  }
  assertDisjointPatchedCandidatePaths([source, destination]);
  if (!existsSync(source)) {
    throw new Error(`Patched candidate runtime is missing: ${source}`);
  }
  replaceDirectory(source, destination);
}

function assertDisjointPatchedCandidatePaths(paths: string[]): void {
  const contains = (value: string): boolean => value === "" || (!value.startsWith("../") && value !== "..");
  for (let index = 0; index < paths.length; index += 1) {
    for (let other = index + 1; other < paths.length; other += 1) {
      const first = paths[index]!;
      const second = paths[other]!;
      if (contains(relative(first, second)) || contains(relative(second, first))) {
        throw new Error("Patched candidate app and runtime destinations must be disjoint paths");
      }
    }
  }
}

export function shouldReconcileCliShims(
  status: TransactionResult["status"],
  candidateOnly: boolean,
  enabled = true,
): boolean {
  return enabled && !candidateOnly && (status === "promoted" || status === "held");
}

async function installCandidateInPlace(opts: Opts): Promise<void> {
  const wantsFuseFlip = opts.fuse !== false;
  const resign = opts.resign !== false;
  let localSigning = opts.localSigning !== false;
  const wantWatcher = opts.watcher !== false;

  const step = makeStepper({ quiet: opts.quiet === true, verbose: opts.verbose === true });
  const codex = locateCodex(opts.app);
  const fuseFlip = shouldFlipElectronFuse(codex, wantsFuseFlip);
  const codexVersion = readCodexVersion(codex.metaPath);
  step(`Codex: ${kleur.cyan(codex.appRoot)}${codexVersion ? ` (${kleur.cyan(codexVersion)}, ${codex.channel})` : ` (${codex.channel})`}`);
  if (wantsFuseFlip && !fuseFlip) {
    step.detail("Skipping Electron fuse flip; Electron Framework binary was not found");
  }
  preflightSystemTools(codex.platform, resign, codex.metaPath !== null);
  const reopenAfterPatch = opts.candidateContext ? false : preflightAppClosed(codex, step);

  // Pre-flight every app-bundle target we will mutate so permission failures
  // surface before we patch app.asar or touch backups.
  preflightWritableTargets(codex, { fuseFlip });
  step.detail("Bundle writable");

  let preparedSigning: ReturnType<typeof prepareCodeSigning> = null;
  if (resign && codex.platform === "darwin") {
    try {
      preparedSigning = prepareCodeSigning({ useLocalIdentity: localSigning });
    } catch (e) {
      throw new Error(`Tweakers Local Signing is required for promotable candidates.\n${(e as Error).message}`);
    }
  }

  const paths = opts.candidateContext?.paths ?? ensureUserPaths();
  step.detail(`User dir: ${kleur.cyan(paths.root)}`);
  const launcher = opts.candidateContext ? null : installWindowsManagedAppLauncher(codex);
  if (launcher) step(`Installed patched Tweakers launcher${launcher.shortcutPaths.length === 1 ? "" : "s"}: ${launcher.shortcutPaths.map((p) => kleur.cyan(p)).join(", ")}`);

  // 1. Backup originals.
  const pristineAppBackup = codex.platform === "darwin" ? join(paths.backup, "Codex.app") : null;
  const backupAsar = join(paths.backup, "app.asar");
  const backupAsarUnpacked = join(paths.backup, "app.asar.unpacked");
  const backupPlist = codex.metaPath ? join(paths.backup, "Info.plist") : null;
  const backupFramework = join(paths.backup, "Electron Framework");
  let appBackupRefreshed = false;
  let appBackupRefreshedFromLiveApp = false;
  let appBackupSeededFromPreserved = false;
  if (pristineAppBackup) {
    appBackupRefreshed = backupUnpatchedApp(codex.appRoot, pristineAppBackup, {
      hasPatchMarker: hasTweakerAsarMarker(codex.asarPath),
      step: step.detail,
    });
    appBackupRefreshedFromLiveApp = appBackupRefreshed;
    // When the live app is already patched (Tweakers re-signed it locally), it
    // can no longer serve as a Developer-ID backup source, so the candidate's
    // signed backup would be missing/unsigned and validation would fail — which
    // makes re-install on an already-patched app impossible. Seed it from the
    // preserved Developer-ID original in the real user dir instead.
    const finalUserRoot = opts.candidateContext?.finalUserRoot;
    if (!isDeveloperIdSignedBackup(pristineAppBackup) && finalUserRoot) {
      const preservedDevIdBackup = join(finalUserRoot, "backup", "Codex.app");
      if (isDeveloperIdSignedBackup(preservedDevIdBackup)) {
        cloneAppTree(preservedDevIdBackup, pristineAppBackup);
        appBackupRefreshed = true;
        appBackupSeededFromPreserved = true;
        step.detail("Seeded candidate signed backup from preserved Developer-ID original");
      }
    }
  }
  // A full-backup refresh must also refresh the copy-if-absent partial backups
  // (app.asar, Info.plist, Electron Framework) so partials can never be older
  // than the full backup. When the refresh came from the live pristine app the
  // partials re-copy from it below; a seed from the preserved Developer-ID
  // original refreshes them from that backup tree (the live app is patched).
  if (appBackupRefreshedFromLiveApp) {
    removePartialBackups({ backupAsar, backupAsarUnpacked, backupPlist, backupFramework });
  } else if (appBackupSeededFromPreserved && pristineAppBackup) {
    removePartialBackups({ backupAsar, backupAsarUnpacked, backupPlist, backupFramework });
    refreshPartialBackupsFromBackupApp(codex, pristineAppBackup, {
      backupAsar,
      backupAsarUnpacked,
      backupPlist,
      backupFramework,
    });
  }
  backupOnce(codex.asarPath, backupAsar);
  if (existsSync(`${codex.asarPath}.unpacked`)) {
    backupOnce(`${codex.asarPath}.unpacked`, backupAsarUnpacked);
  }
  if (codex.metaPath && backupPlist) backupOnce(codex.metaPath, backupPlist);
  if (fuseFlip) backupOnce(codex.electronBinary, backupFramework);
  step(appBackupRefreshed ? "Backup refreshed" : "Backup ready");

  const { headerHash: originalAsarHash } = readHeaderHash(codex.asarPath);

  // 2. Stage runtime + loader into the user dir.
  stageAssets(paths.runtime);
  if (codex.platform === "darwin") stageNativeHostInsideApp(codex.appRoot, paths.runtime);
  step("Runtime staged");

  // 3. Patch app.asar entry point to require our loader.
  const originalEntry = await injectLoader(
    codex.asarPath,
    opts.candidateContext?.finalUserRoot ?? paths.root,
    step.detail,
    opts.macAppIdentity?.appUserDataRoot,
    opts.macAppIdentity?.displayName,
  );
  const { headerHash: patchedAsarHash } = readHeaderHash(codex.asarPath);
  step.detail(`Patched app.asar (entry was ${kleur.dim(originalEntry)})`);

  // 4. Update Info.plist hash so Electron's integrity check passes.
  if (codex.metaPath) {
    setIntegrity(codex, patchedAsarHash);
    step.detail(`Updated ElectronAsarIntegrity → ${kleur.dim(patchedAsarHash.slice(0, 12))}…`);
  }
  if (codex.platform === "darwin" && opts.macAppIdentity) {
    const changed = applyMacAppIdentity(codex.appRoot, opts.macAppIdentity);
    step.detail(`Applied isolated macOS app identity (${changed.length} plist${changed.length === 1 ? "" : "s"})`);
  }

  // 5. Belt-and-suspenders: flip the integrity validation fuse off.
  let fuseFlipped = false;
  if (fuseFlip) {
    try {
      const r = writeFuse(
        codex.electronBinary,
        "EnableEmbeddedAsarIntegrityValidation",
        "off",
      );
      step.detail(`Fuse EnableEmbeddedAsarIntegrityValidation: ${r.from} → ${r.to}`);
      fuseFlipped = true;
    } catch (e) {
      console.warn(kleur.yellow(`Fuse flip failed: ${(e as Error).message}`));
    }
  }
  step("App patched");

  // The desktop-bundled-derived backend must be inside the disposable app
  // before the final inside-out signature. Staging it after this point would
  // invalidate the app signature and make the receipt proof meaningless.
  if (opts.candidateContext?.bundledDerivedBackend) {
    stageBundledDerivedBackendInsideApp(codex.appRoot, opts.candidateContext.bundledDerivedBackend);
    step.detail(`Staged desktop-bundled-derived Codex ${opts.candidateContext.bundledDerivedBackend.version}`);
  }

  // 6. Re-sign on macOS.
  let resigned = false;
  let signingMode: "local-identity" | "adhoc" | undefined;
  let signingIdentity: string | undefined;
  let signingIdentityHash: string | undefined;
  if (resign && codex.platform === "darwin") {
    clearQuarantine(codex.appRoot);
    const signing = signCodexApp(codex.appRoot, {
      useLocalIdentity: localSigning,
      preparedIdentity: preparedSigning,
    });
    resigned = true;
    signingMode = signing?.mode;
    signingIdentity = signing?.identity;
    signingIdentityHash = signing?.identityHash;
    if (signing?.mode === "local-identity") {
      step(
        `Signing: ${signing.createdIdentity ? "created local identity" : "local identity"} ${kleur.cyan(signing.identity)}`,
      );
    } else {
      step("Signing: ad-hoc");
    }
    verifyStagedNativeHostForApp(codex.appRoot);
  }

  // 7. Auto-repair watcher.
  let watcher: WatcherKind = opts.watcherKind ?? "none";
  if (wantWatcher && !opts.candidateContext) {
    try {
      watcher = installWatcher(codex.appRoot);
      step(`Watcher: ${watcher}`);
    } catch (e) {
      console.warn(kleur.yellow(`Watcher install failed: ${(e as Error).message}`));
    }
  }

  // 8. Persist state.
  writeState(paths.stateFile, {
    version: TWEAKER_VERSION,
    installedAt: new Date().toISOString(),
    appRoot: codex.appRoot,
    originalAsarHash,
    patchedAsarHash,
    codexVersion,
    codexChannel: codex.channel,
    codexBundleId: opts.macAppIdentity?.bundleId ?? codex.bundleId,
    fuseFlipped,
    resigned,
    signingMode,
    signingIdentity,
    signingIdentityHash,
    originalEntryPoint: originalEntry,
    watcher,
    sourceRoot,
  });
  if (!opts.candidateContext) chownForTargetUser(paths.root, { recursive: true });
  if (reopenAfterPatch) {
    openCodex(codex.appRoot, { detached: true, delayMs: 1_000 });
    step("Codex reopened");
  }

  if (!opts.quiet && !opts.candidateContext) {
    console.log();
    console.log(kleur.green().bold("✓ tweaker installed."));
    console.log(`  Tweaks: ${kleur.cyan(paths.tweaks)}`);
    console.log(`  Logs:   ${kleur.cyan(paths.logDir)}`);
    if (launcher) {
      console.log(`  Launch ${kleur.cyan("Tweakers")} from Start Menu or Desktop.`);
      console.log(`  Opening the Microsoft Store ${kleur.cyan("Codex")} app directly will launch the unpatched app.`);
    } else {
      console.log();
      console.log(`  Launch Codex normally; the Tweaks tab will appear in Settings.`);
      console.log();
    }
  }
}

interface PartialBackupTargets {
  backupAsar: string;
  backupAsarUnpacked: string;
  backupPlist: string | null;
  backupFramework: string;
}

function removePartialBackups(targets: PartialBackupTargets): void {
  rmSync(targets.backupAsar, { force: true });
  rmSync(targets.backupAsarUnpacked, { recursive: true, force: true });
  if (targets.backupPlist) rmSync(targets.backupPlist, { force: true });
  rmSync(targets.backupFramework, { recursive: true, force: true });
}

/**
 * Refresh the partial backups from a full pristine backup tree instead of the
 * (patched) live app, mapping each live-app path to its backup equivalent.
 */
function refreshPartialBackupsFromBackupApp(
  codex: Pick<CodexInstall, "appRoot" | "asarPath" | "metaPath" | "electronBinary">,
  backupApp: string,
  targets: PartialBackupTargets,
): void {
  const inBackup = (livePath: string) => join(backupApp, relative(codex.appRoot, livePath));
  const copyIfPresent = (from: string, to: string) => {
    if (!existsSync(from)) return;
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  };
  copyIfPresent(inBackup(codex.asarPath), targets.backupAsar);
  copyIfPresent(`${inBackup(codex.asarPath)}.unpacked`, targets.backupAsarUnpacked);
  if (codex.metaPath && targets.backupPlist) copyIfPresent(inBackup(codex.metaPath), targets.backupPlist);
  copyIfPresent(inBackup(codex.electronBinary), targets.backupFramework);
}

/**
 * Refresh the copy-if-absent partial backups (app.asar, Info.plist, Electron
 * Framework) sitting beside a full pristine backup, from that backup. Every
 * refresh of a root's FULL backup must run this for the same root: the
 * partials are consumed by uninstall's fallback restore, so they can never be
 * allowed to grow older than the full backup they sit next to.
 */
export function refreshLivePartialBackups(
  codex: Pick<CodexInstall, "appRoot" | "asarPath" | "metaPath" | "electronBinary">,
  backupApp: string,
  backupDir: string,
): void {
  const targets: PartialBackupTargets = {
    backupAsar: join(backupDir, "app.asar"),
    backupAsarUnpacked: join(backupDir, "app.asar.unpacked"),
    backupPlist: codex.metaPath ? join(backupDir, "Info.plist") : null,
    backupFramework: join(backupDir, "Electron Framework"),
  };
  // Removal first: an interruption leaves partials absent (restore then falls
  // back to the full backup), never stale.
  removePartialBackups(targets);
  refreshPartialBackupsFromBackupApp(codex, backupApp, targets);
}

function transactionUserPaths(root: string): UserPaths {
  return {
    root,
    runtime: join(root, "runtime"),
    tweaks: join(root, "tweaks"),
    backup: join(root, "backup"),
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    updateModeFile: join(root, "update-mode.json"),
    selfUpdateStateFile: join(root, "self-update-state.json"),
    binDir: join(root, "bin"),
    logDir: join(root, "log"),
    transactionRoot: join(root, "transactions", "app-install"),
    transactionStateFile: join(root, "transactions", "app-install.json"),
  };
}

interface PromotionSurfaceRoots {
  appHash: string;
  runtimeRoot: string;
  tweaksRoot: string;
  tweakersConfigPath: string;
  codexConfigPath: string;
  namespaceDataPath: string;
  mainStoragePath: string;
  policyPath: string;
}

type PromotionSurfaceHashes = Record<(typeof PROMOTION_SURFACE_NAMES)[number], string>;

export function promotionSurfaceRoots(input: {
  appHash: string;
  runtimeRoot: string;
  tweaksRoot: string;
  userRoot: string;
  tweakersConfigPath: string;
  codexHome: string;
}): PromotionSurfaceRoots {
  return {
    appHash: input.appHash,
    runtimeRoot: input.runtimeRoot,
    tweaksRoot: input.tweaksRoot,
    tweakersConfigPath: input.tweakersConfigPath,
    codexConfigPath: join(input.codexHome, "config.toml"),
    namespaceDataPath: join(input.userRoot, "tweak-data", USER_QUESTIONS_TWEAK_ID),
    mainStoragePath: join(input.userRoot, "storage", `${USER_QUESTIONS_TWEAK_ID}.json`),
    policyPath: join(input.codexHome, ".codex-global-state.json"),
  };
}

export function buildPromotionHealthExpectation(input: {
  app: AppFingerprint;
  before: PromotionSurfaceRoots | PromotionSurfaceHashes;
  after: PromotionSurfaceRoots | PromotionSurfaceHashes;
  requiredPermissions: string[];
  userQuestionsRoot: string;
}): ProductionHealthExpectationV2 {
  const before = "appHash" in input.before ? fingerprintPromotionSurfaces(input.before) : input.before;
  const after = "appHash" in input.after ? fingerprintPromotionSurfaces(input.after) : input.after;
  if (after.app !== input.app.hash) throw new Error("Promotion app surface does not match the app fingerprint");
  if (
    !/^[a-f0-9]{64}$/.test(before.policy)
    || !/^[a-f0-9]{64}$/.test(after.policy)
    || before.policy !== after.policy
  ) {
    throw new Error("Promotion policy surface must remain present and semantically unchanged");
  }
  const userQuestions = inspectUserQuestionsSource(input.userQuestionsRoot);
  return {
    schemaVersion: 2,
    app: { ...input.app },
    requiredPermissions: [...input.requiredPermissions],
    surfaces: Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name) => [name, {
      preimageHash: before[name],
      afterHash: after[name],
    }])) as ProductionHealthExpectationV2["surfaces"],
    userQuestions: {
      id: userQuestions.id,
      version: userQuestions.version,
      payloadHash: userQuestions.payloadHash,
    },
  };
}

function promotionPreimageHashes(expectation: ProductionHealthExpectationV2): PromotionSurfaceHashes {
  return Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name) => [
    name,
    expectation.surfaces[name].preimageHash,
  ])) as PromotionSurfaceHashes;
}

function fingerprintPromotionSurfaces(roots: PromotionSurfaceRoots): PromotionSurfaceHashes {
  return {
    app: roots.appHash,
    runtime: fingerprintPromotionPath(roots.runtimeRoot),
    tweakTree: fingerprintPromotionPath(roots.tweaksRoot),
    tweakersConfig: fingerprintPromotionPath(roots.tweakersConfigPath),
    codexConfig: fingerprintPromotionPath(roots.codexConfigPath),
    namespaceData: fingerprintPromotionPath(roots.namespaceDataPath),
    mainStorage: fingerprintPromotionPath(roots.mainStoragePath),
    policy: fingerprintPromotionPolicyPath(roots.policyPath),
  };
}

/** Mode- and link-aware deterministic fingerprint shared with the runtime responder. */
export function fingerprintPromotionPath(path: string): string {
  if (!existsSync(path)) return "missing";
  const digest = createHash("sha256");
  const visit = (entryPath: string, name: string): void => {
    const stat = lstatSync(entryPath);
    digest.update(name).update("\0").update(String(stat.mode & 0o777)).update("\0");
    if (stat.isDirectory()) {
      digest.update("directory\0");
      for (const child of readdirSync(entryPath).sort()) {
        visit(join(entryPath, child), name ? `${name}/${child}` : child);
      }
      return;
    }
    if (stat.isFile()) {
      digest.update("file\0").update(readFileSync(entryPath));
      return;
    }
    if (stat.isSymbolicLink()) {
      digest.update("symlink\0").update(readlinkSync(entryPath));
      return;
    }
    throw new Error(`Unsupported promotion surface entry: ${entryPath}`);
  };
  visit(path, "");
  return digest.digest("hex");
}

export function stageCandidateRolloutInputs(input: {
  livePaths: UserPaths;
  candidatePaths: UserPaths;
  liveCodexHome: string;
  candidateCodexHome: string;
}): void {
  mkdirSync(input.candidatePaths.root, { recursive: true, mode: 0o700 });
  mkdirSync(input.candidateCodexHome, { recursive: true, mode: 0o700 });
  const copies: Array<[string, string]> = [
    [input.livePaths.configFile, input.candidatePaths.configFile],
    [join(input.liveCodexHome, "config.toml"), join(input.candidateCodexHome, "config.toml")],
    [join(input.liveCodexHome, ".codex-global-state.json"), join(input.candidateCodexHome, ".codex-global-state.json")],
  ];
  for (const id of [USER_QUESTIONS_TWEAK_ID, ...LEGACY_USER_QUESTIONS_TWEAK_IDS]) {
    copies.push(
      [join(input.livePaths.root, "tweak-data", id), join(input.candidatePaths.root, "tweak-data", id)],
      [join(input.livePaths.root, "storage", `${id}.json`), join(input.candidatePaths.root, "storage", `${id}.json`)],
    );
  }
  for (const [source, destination] of copies) copyCandidatePreimage(source, destination);
}

/**
 * Stage only the durable Codex authentication proof into the contained
 * candidate home immediately before its synchronous one-shot probe. The
 * returned cleanup must run after the probe so credentials never persist in a
 * held candidate transaction.
 */
export function stageCandidateCodexAuth(liveCodexHome: string, candidateCodexHome: string): () => void {
  if (!isAbsolute(liveCodexHome) || resolve(liveCodexHome) !== liveCodexHome) {
    throw new Error("Live Codex home must be an exact absolute path");
  }
  if (!isAbsolute(candidateCodexHome) || resolve(candidateCodexHome) !== candidateCodexHome) {
    throw new Error("Candidate Codex home must be an exact absolute path");
  }
  const candidateHomeStat = lstatSync(candidateCodexHome);
  if (!candidateHomeStat.isDirectory() || candidateHomeStat.isSymbolicLink()) {
    throw new Error("Candidate Codex home must be a real directory");
  }

  const source = join(liveCodexHome, "auth.json");
  const destination = join(candidateCodexHome, "auth.json");
  const sourceFd = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fstatSync(sourceFd);
    const owner = targetUserOwnership();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.size <= 0
      || stat.size > 1024 * 1024
      || (owner !== null && stat.uid !== owner.uid)
    ) {
      throw new Error("Codex authentication proof must be a bounded owner-only regular file");
    }
    bytes = readFileSync(sourceFd);
    if (bytes.byteLength !== stat.size) throw new Error("Codex authentication proof changed while being read");
  } finally {
    closeSync(sourceFd);
  }

  const temporary = `${destination}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    chownForTargetUser(temporary);
    const staged = lstatSync(temporary);
    const owner = targetUserOwnership();
    if (
      !staged.isFile()
      || staged.isSymbolicLink()
      || (staged.mode & 0o777) !== 0o600
      || staged.size !== bytes.byteLength
      || (owner !== null && staged.uid !== owner.uid)
    ) {
      throw new Error("Contained Codex authentication proof failed verification");
    }
    renameSync(temporary, destination);
  } finally {
    bytes.fill(0);
    rmSync(temporary, { force: true });
  }
  return () => {
    rmSync(destination, { force: true });
  };
}

export function copyCandidatePreimage(source: string, destination: string): void {
  const before = fingerprintPath(source);
  if (before.kind === "missing") return;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (before.kind === "directory") {
    copyDirectoryPreservingModes(source, destination);
  } else {
    cpSync(source, destination, { verbatimSymlinks: true, preserveTimestamps: true });
  }
  const after = fingerprintPath(destination);
  if (before.kind !== after.kind || before.mode !== after.mode || before.hash !== after.hash) {
    throw new Error(`Candidate rollout preimage copy failed verification: ${source}`);
  }
}

interface PromotionMcpReceiptSummary {
  status: "updated" | "unchanged" | "conflict" | "error";
  conflictCount: number;
  userQuestionsStateConsistent: boolean;
}

export function reconcilePromotionMcpConfig(input: {
  runtimeRoot: string;
  tweaksRoot: string;
  userRoot: string;
  tweakersConfigPath: string;
  codexConfigPath: string;
  statePath: string;
}): PromotionMcpReceiptSummary {
  const runtimeModulePath = join(input.runtimeRoot, "mcp-reconciliation.js");
  const stat = lstatSync(runtimeModulePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Candidate MCP reconciler is not a regular runtime file");
  const runtime = createRequire(import.meta.url)(runtimeModulePath) as {
    reconcileMcpConfig(options: Record<string, unknown>): Record<string, unknown>;
    userQuestionsMcpReceiptMatchesEnabledState(receipt: Record<string, unknown>, enabled: boolean): boolean;
  };
  if (typeof runtime.reconcileMcpConfig !== "function") throw new Error("Candidate runtime does not expose MCP reconciliation");
  if (typeof runtime.userQuestionsMcpReceiptMatchesEnabledState !== "function") {
    throw new Error("Candidate runtime does not expose User Questions MCP state validation");
  }
  const config = readJsonRecord(input.tweakersConfigPath);
  const ownedTweaks = readdirSync(input.tweaksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      const dir = join(input.tweaksRoot, entry.name);
      const manifestPath = join(dir, "manifest.json");
      const manifestStat = lstatSync(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024) {
        throw new Error(`Promotion tweak manifest is unsafe: ${entry.name}`);
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (typeof manifest.id !== "string" || !manifest.mcp || typeof manifest.mcp !== "object") return null;
      return {
        dir,
        dataDir: join(input.userRoot, "tweak-data", manifest.id),
        manifest,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (!ownedTweaks.some((tweak) => tweak.manifest.id === USER_QUESTIONS_TWEAK_ID)) {
    throw new Error("Canonical User Questions MCP source is missing from the promotion tree");
  }
  const tweaks = ownedTweaks.filter((tweak) => tweakEnabledInConfig(config, String(tweak.manifest.id)));
  const userQuestionsEnabled = tweaks.some((tweak) => tweak.manifest.id === USER_QUESTIONS_TWEAK_ID);
  mkdirSync(dirname(input.codexConfigPath), { recursive: true, mode: 0o700 });
  const receipt = runtime.reconcileMcpConfig({
    configPath: input.codexConfigPath,
    statePath: input.statePath,
    tweaks,
    ownedTweaks,
    trigger: "startup",
  });
  const status = receipt.status;
  const conflicts = receipt.conflicts;
  const appliedNames = receipt.appliedNames;
  const approvalPolicy = receipt.approvalPolicy;
  if (
    !["updated", "unchanged", "conflict", "error"].includes(String(status))
    || !Array.isArray(conflicts)
    || !Array.isArray(appliedNames)
    || !approvalPolicy
    || typeof approvalPolicy !== "object"
  ) throw new Error("Candidate MCP reconciliation returned an invalid receipt");
  return {
    status: status as PromotionMcpReceiptSummary["status"],
    conflictCount: conflicts.length,
    userQuestionsStateConsistent: runtime.userQuestionsMcpReceiptMatchesEnabledState(receipt, userQuestionsEnabled),
  };
}

function assertPromotionMcpReceipt(receipt: PromotionMcpReceiptSummary, scope: string): void {
  if (receipt.status === "conflict" || receipt.status === "error" || receipt.conflictCount !== 0 || !receipt.userQuestionsStateConsistent) {
    throw new Error(`${scope} MCP reconciliation did not prove the expected User Questions enabled state`);
  }
}

function tweakEnabledInConfig(config: Record<string, unknown>, id: string): boolean {
  const tweaker = recordValue(config.tweaker);
  if (tweaker?.safeMode === true) return false;
  const health = recordValue(recordValue(config.tweakHealth)?.[id]);
  if (health?.status === "quarantined") return false;
  const tweak = recordValue(recordValue(config.tweaks)?.[id]);
  return tweak?.enabled !== false;
}

function readJsonRecord(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected a JSON object: ${path}`);
  return value as Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function unknownPromotionHealth(requiredPermissions: string[]) {
  return {
    host: "unknown" as const,
    session: "unknown" as const,
    permissions: Object.fromEntries(requiredPermissions.map((permission) => [permission, "unknown" as const])),
    promotionReady: "unknown" as const,
  };
}

function sameAppFingerprint(left: AppFingerprint, right: AppFingerprint): boolean {
  return left.version === right.version && left.build === right.build && left.hash === right.hash;
}

function fingerprintCodex(codex: CodexInstall): AppFingerprint {
  const plist = codex.metaPath ? readPlist(codex.metaPath) : {};
  return {
    version: String(plist.CFBundleShortVersionString ?? readCodexVersion(codex.metaPath) ?? "unknown"),
    build: String(plist.CFBundleVersion ?? "unknown"),
    hash: readHeaderHash(codex.asarPath).headerHash,
  };
}

function requiredMacPermissions(configFile: string): string[] {
  try {
    const value = JSON.parse(readFileSync(configFile, "utf8")) as { requiredMacPermissions?: unknown };
    if (!Array.isArray(value.requiredMacPermissions)) return [];
    return [...new Set(value.requiredMacPermissions.filter((permission): permission is string => permission === "accessibility" || permission === "screen-recording"))].sort();
  } catch {
    return [];
  }
}

export function readCandidatePromotionHealthExpectation(
  requestFile: string,
  bounds: {
    transactionCreatedAt: string;
    now: Date;
    maxAgeMs: number;
  },
): ProductionHealthExpectationV2 | null {
  try {
    const status = lstatSync(requestFile);
    if (
      !status.isFile()
      || status.isSymbolicLink()
      || status.size <= 0
      || status.size > 128 * 1024
      || (status.mode & 0o777) !== 0o600
    ) return null;
    const value = recordValue(JSON.parse(readFileSync(requestFile, "utf8")) as unknown);
    if (!value) return null;
    const { requestedAt, ...expected } = value;
    const requestedAtMs = Date.parse(typeof requestedAt === "string" ? requestedAt : "");
    const transactionCreatedAtMs = Date.parse(bounds.transactionCreatedAt);
    const nowMs = bounds.now.getTime();
    const requestAgeMs = nowMs - requestedAtMs;
    if (
      typeof requestedAt !== "string"
      || !Number.isFinite(requestedAtMs)
      || !Number.isFinite(transactionCreatedAtMs)
      || !Number.isFinite(nowMs)
      || !Number.isFinite(requestAgeMs)
      || !Number.isFinite(bounds.maxAgeMs)
      || bounds.maxAgeMs < 0
      || requestedAtMs > nowMs + HEALTH_TIMESTAMP_MAX_FUTURE_SKEW_MS
      || requestedAtMs < transactionCreatedAtMs
      || requestAgeMs > bounds.maxAgeMs
      || !isValidProductionHealthExpectationV2(expected)
    ) return null;
    return expected;
  } catch {
    return null;
  }
}

function writeHealthRequest(path: string, request: object): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A receipt must prove this launch, never a previous launch of the same build.
  rmSync(join(dirname(path), "promotion.json"), { force: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function hashDirectoryTree(root: string): string {
  if (!existsSync(root)) return "missing";
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Finder junk must not perturb payload/runtime hashes.
      if (isMacOsJunkName(entry.name)) continue;
      const path = join(directory, entry.name);
      const name = relative(root, path);
      hash.update(name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
      else if (entry.isSymbolicLink()) hash.update("symlink");
    }
  };
  visit(root);
  return hash.digest("hex");
}

export function installerPayloadHash(): string {
  const hash = createHash("sha256");
  for (const root of [resolve(here, ".."), assetsDir]) {
    hash.update(root === assetsDir ? "assets" : "installer");
    hash.update(hashDirectoryTree(root));
  }
  return hash.digest("hex");
}

function replaceDirectory(source: string, destination: string): void {
  const temporary = `${destination}.tweakers-replacement-${process.pid}`;
  const previous = `${destination}.tweakers-previous-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  copyDirectoryPreservingModes(source, temporary);
  if (existsSync(destination)) renameDirectory(destination, previous);
  try {
    renameDirectory(temporary, destination);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    if (existsSync(previous)) renameDirectory(previous, destination);
    throw error;
  }
}

interface AppBundleReplacementAdapters {
  swapDirectories?: (first: string, second: string) => void;
  removeDirectory?: (path: string) => void;
  validateDestination?: (appRoot: string) => boolean;
  onCleanupFailure?: (path: string, error: unknown) => void;
  /**
   * The stable incoming Contents path was populated and verified before the
   * live app was stopped. Cutover must consume that exact staging copy rather
   * than opening a long copy window after shutdown.
   */
  preStagedIncoming?: boolean;
  /**
   * When set, the swapped-out Contents are renamed to this path instead of
   * being removed — but only after the promoted destination validated. A
   * failed validation still removes the incoming copy (it holds the rejected
   * bytes after the atomic rollback), and the rollback-failure path still
   * preserves the incoming copy as evidence exactly as before.
   */
  preserveOutgoing?: string;
}

interface AppBundleStagingAdapters {
  removeDirectory?: (path: string) => void;
  copyDirectory?: (source: string, destination: string) => void;
}

/**
 * Populate the stable incoming Contents path while the current app may still
 * be running. The later replacement then consists only of the atomic swap and
 * destination validation, so an automatic reopen cannot bind the outgoing
 * Contents during a multi-gigabyte copy.
 */
export function stageAppBundleReplacement(
  source: string,
  destination: string,
  adapters: AppBundleStagingAdapters = {},
): string {
  const sourceContents = join(source, "Contents");
  const destinationContents = join(destination, "Contents");
  if (!existsSync(sourceContents) || !existsSync(destinationContents)) {
    throw new Error("App bundle replacement requires source and destination Contents directories");
  }
  const incoming = `${destination}.tweakers-contents-swap`;
  const remove = adapters.removeDirectory ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const copy = adapters.copyDirectory
    ?? ((from: string, to: string) => copyDirectoryPreservingModes(from, to));
  remove(incoming);
  copy(sourceContents, incoming);
  if (!existsSync(incoming)) throw new Error("Prepared app Contents staging copy is missing");
  return incoming;
}

export function replaceAppBundlePreservingIdentity(
  source: string,
  destination: string,
  adapters: AppBundleReplacementAdapters = {},
): void {
  const sourceContents = join(source, "Contents");
  const destinationContents = join(destination, "Contents");
  if (!existsSync(destination)) {
    replaceDirectory(source, destination);
    if (adapters.validateDestination && !adapters.validateDestination(destination)) {
      rmSync(destination, { recursive: true, force: true });
      throw new Error("Promoted app signature verification failed");
    }
    return;
  }
  if (!existsSync(sourceContents) || !existsSync(destinationContents)) {
    throw new Error("App bundle replacement requires source and destination Contents directories");
  }

  // The incoming swap path below is a bare copied Contents directory, not a
  // signed app root. Resolve, verify, and load the native host from the actual
  // signed source/destination payloads before creating that copy so identity
  // provenance cannot be accidentally inferred from the live destination.
  const swap = adapters.swapDirectories
    ?? prepareAtomicSwapDirectories(sourceContents, destinationContents);
  const remove = adapters.removeDirectory ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  // A stable path makes cleanup debt recoverable: the next serialized
  // promotion removes any old payload left here before preparing its swap.
  const incoming = `${destination}.tweakers-contents-swap`;
  if (adapters.preStagedIncoming) {
    if (!existsSync(incoming)) throw new Error("Pre-staged app Contents are missing");
  } else {
    stageAppBundleReplacement(source, destination, { removeDirectory: remove });
  }
  let preserveIncoming = false;
  // Only true while `incoming` holds the swapped-out (previous) Contents; a
  // rolled-back validation failure flips it back so we never park rejected bytes.
  let incomingHoldsOutgoing = false;
  try {
    swap(incoming, destinationContents);
    incomingHoldsOutgoing = true;
    if (adapters.validateDestination && !adapters.validateDestination(destination)) {
      try {
        swap(incoming, destinationContents);
        incomingHoldsOutgoing = false;
      } catch (rollbackError) {
        preserveIncoming = true;
        throw new Error(`Promoted app signature verification failed and atomic rollback failed: ${errorMessage(rollbackError)}`);
      }
      throw new Error("Promoted app signature verification failed");
    }
  } finally {
    if (!preserveIncoming) {
      try {
        if (adapters.preserveOutgoing && incomingHoldsOutgoing) {
          moveDirectoryAcrossVolumes(incoming, adapters.preserveOutgoing);
        } else {
          remove(incoming);
        }
      } catch (error) {
        // The promoted app is already valid. Record the non-fatal cleanup debt;
        // the stable path above guarantees the next promotion retries it.
        adapters.onCleanupFailure?.(incoming, error);
      }
    }
  }
}

/**
 * A destination-validation failure whose atomic rollback SUCCEEDED: the live
 * bundle was restored byte-for-byte and no rejected bytes were parked. The
 * incoming payload is provably unusable (the identical bytes would fail every
 * retry), so callers may safely discard their copy of it.
 */
export function isSwapValidationRollback(error: unknown): boolean {
  return error instanceof Error && error.message === "Promoted app signature verification failed";
}

/**
 * A destination-validation failure whose atomic rollback ALSO failed: the live
 * bundle holds the rejected bytes and the outgoing Contents are preserved as
 * evidence at the stable swap path. Callers must leave recovery (journal,
 * remnant adoption) to reconcileModeTransition / the next promotion instead of
 * tidying up.
 */
export function isSwapRollbackFailure(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith("Promoted app signature verification failed and atomic rollback failed");
}

/** Rename with a copy fallback for cross-volume (EXDEV) destinations. */
function moveDirectoryAcrossVolumes(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  try {
    renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyDirectoryPreservingModes(source, destination);
    rmSync(source, { recursive: true, force: true });
  }
}

type NativeAppIdentityHost = { swapDirectories(first: string, second: string): void };

function prepareAtomicSwapDirectories(
  sourceContents: string,
  destinationContents: string,
): (first: string, second: string) => void {
  if (process.platform !== "darwin") throw new Error("Atomic app bundle exchange is available only on macOS");
  const require = createRequire(import.meta.url);
  const evidence = resolveStagedSwapNativeHostEvidence(sourceContents, destinationContents);
  verifyNativeHostMatchesApp(evidence.containingAppRoot, evidence.hostPath);
  const nativeHost = require(evidence.hostPath) as NativeAppIdentityHost;
  return (first, second) => nativeHost.swapDirectories(first, second);
}

export interface StagedSwapNativeHostEvidence {
  hostPath: string;
  containingAppRoot: string;
}

/**
 * Resolve a native host together with the signed app payload that contains it.
 * Callers must pass real App.app/Contents paths, never the bare incoming swap
 * copy, so host identity is checked against its actual signing container.
 */
export function resolveStagedSwapNativeHostEvidence(
  firstContents: string,
  secondContents: string,
): StagedSwapNativeHostEvidence {
  for (const contents of [firstContents, secondContents]) {
    const hostPath = join(contents, "Resources", "tweakers", "native", "tweaker_native_host.node");
    if (existsSync(hostPath)) {
      return {
        hostPath,
        containingAppRoot: dirname(contents),
      };
    }
  }
  throw new Error("No signed staged native host exists in either app payload; refusing repo/runtime dlopen fallback");
}

/** Resolve only a native host that was staged inside a signed app payload. */
export function resolveStagedSwapNativeHost(firstContents: string, secondContents: string): string {
  return resolveStagedSwapNativeHostEvidence(firstContents, secondContents).hostPath;
}

function renameDirectory(source: string, destination: string): void {
  renameSync(source, destination);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Candidate-user state is private build scratch space, not durable truth.
 * Clear it before every new candidate build so a still-valid Developer-ID
 * backup from an older desktop build cannot be promoted over the current
 * preserved pristine backup.
 */
export function resetCandidateUserRootForBuild(candidateUserRoot: string): void {
  rmSync(candidateUserRoot, { recursive: true, force: true });
}

export function readCodexVersion(metaPath: string | null): string | null {
  if (!metaPath || !existsSync(metaPath)) return null;
  try {
    const pl = readPlist(metaPath);
    return (pl["CFBundleShortVersionString"] as string) ?? null;
  } catch {
    return null;
  }
}

export function shouldFlipElectronFuse(
  codex: Pick<CodexInstall, "electronBinary">,
  requested: boolean,
): boolean {
  return requested && existsSync(codex.electronBinary);
}

export function shouldBackupUnpatchedApp(input: { hasPatchMarker: boolean; signature: ReturnType<typeof signatureInfo> }): boolean {
  if (input.hasPatchMarker) return false;
  return input.signature.ok;
}

export function backupUnpatchedApp(
  appRoot: string,
  backupPath: string,
  opts: { hasPatchMarker: boolean; step?: (msg: string) => void },
): boolean {
  const sig = signatureInfo(appRoot);
  if (!shouldBackupUnpatchedApp({ hasPatchMarker: opts.hasPatchMarker, signature: sig })) return false;

  cloneAppTree(appRoot, backupPath);
  opts.step?.(`Backed up unpatched Codex.app to ${kleur.cyan(backupPath)}`);
  return true;
}

interface SignedBackupPromotionAdapters {
  verifyDeveloperId?: (appRoot: string) => boolean;
  copyDirectory?: (source: string, destination: string) => void;
  renameDirectory?: (source: string, destination: string) => void;
  removeDirectory?: (path: string) => void;
}

export interface SignedBackupTransactionPaths {
  candidateBackup: string;
  liveBackup: string;
  snapshot: string;
  marker: string;
}

export interface SignedBackupTransactionWiring {
  validateCandidate(): boolean;
  snapshotLive(): void;
  promoteCandidate(): void;
  restoreLive(): void;
}

/** The exact backup lifecycle callbacks wired into the app install transaction. */
export function createSignedBackupTransactionWiring(
  paths: SignedBackupTransactionPaths,
  adapters: SignedBackupPromotionAdapters = {},
): SignedBackupTransactionWiring {
  const verify = adapters.verifyDeveloperId ?? isDeveloperIdSignedBackup;
  return {
    validateCandidate: () => verify(paths.candidateBackup),
    snapshotLive: () => snapshotSignedBackup(paths.liveBackup, paths.snapshot, paths.marker),
    promoteCandidate: () => promoteVerifiedSignedBackup(paths.candidateBackup, paths.liveBackup, adapters),
    restoreLive: () => restoreSignedBackupSnapshot(paths.liveBackup, paths.snapshot, paths.marker),
  };
}

/**
 * Promote the candidate context's pristine Codex.app into the live user root.
 * The candidate and staged copy are both verified before the old backup is
 * renamed, and every post-rename failure restores the old directory.
 */
export function promoteVerifiedSignedBackup(
  candidateBackup: string,
  liveBackup: string,
  adapters: SignedBackupPromotionAdapters = {},
): void {
  assertExactSignedBackupPath(candidateBackup);
  assertExactSignedBackupPath(liveBackup);
  const verify = adapters.verifyDeveloperId ?? isDeveloperIdSignedBackup;
  const copy = adapters.copyDirectory ?? ((source: string, destination: string) => {
    execFileSync("ditto", [source, destination], { stdio: "ignore" });
  });
  const rename = adapters.renameDirectory ?? renameDirectory;
  const remove = adapters.removeDirectory ?? ((path: string) => rmSync(path, { recursive: true, force: true }));

  if (!verify(candidateBackup)) {
    throw new Error("Candidate Codex.app backup is not Developer ID signed; live backup was not modified.");
  }

  mkdirSync(dirname(liveBackup), { recursive: true });
  const incoming = `${liveBackup}.tweakers-incoming-${process.pid}`;
  const previous = `${liveBackup}.tweakers-previous-${process.pid}`;
  remove(incoming);
  remove(previous);
  try {
    copy(candidateBackup, incoming);
    if (!verify(incoming)) {
      throw new Error("Staged Codex.app backup failed Developer ID verification.");
    }
    const hadPrevious = existsSync(liveBackup);
    if (hadPrevious) rename(liveBackup, previous);
    try {
      rename(incoming, liveBackup);
      if (!verify(liveBackup)) {
        throw new Error("Promoted Codex.app backup failed Developer ID verification.");
      }
      remove(previous);
    } catch (error) {
      remove(liveBackup);
      if (hadPrevious && existsSync(previous)) rename(previous, liveBackup);
      throw error;
    }
  } finally {
    remove(incoming);
    // A successful promotion removes this above; after a failed restoration,
    // retain the previous path as evidence instead of deleting the only copy.
    if (existsSync(liveBackup)) remove(previous);
  }
}

export function snapshotSignedBackup(liveBackup: string, snapshot: string, marker: string): void {
  assertExactSignedBackupPath(liveBackup);
  mkdirSync(dirname(marker), { recursive: true });
  rmSync(snapshot, { recursive: true, force: true });
  // Absence of a marker means "snapshot not committed". Remove an older
  // transaction's marker before copying so an interruption cannot replay it.
  rmSync(marker, { force: true });
  const existed = existsSync(liveBackup);
  if (existed) copyDirectoryPreservingModes(liveBackup, snapshot);
  const temporary = `${marker}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, existed })}\n`, { mode: 0o600 });
  renameSync(temporary, marker);
}

export function restoreSignedBackupSnapshot(liveBackup: string, snapshot: string, marker: string): void {
  assertExactSignedBackupPath(liveBackup);
  let state: { schemaVersion?: unknown; existed?: unknown };
  try {
    state = JSON.parse(readFileSync(marker, "utf8")) as typeof state;
  } catch {
    // An interrupted transaction that never completed its snapshot must not
    // infer absence and delete a valid live backup.
    return;
  }
  if (state.schemaVersion !== 1 || typeof state.existed !== "boolean") return;
  if (!state.existed) {
    rmSync(liveBackup, { recursive: true, force: true });
    return;
  }
  if (!existsSync(snapshot)) throw new Error("Signed backup rollback snapshot is missing.");
  replaceDirectory(snapshot, liveBackup);
}

function assertExactSignedBackupPath(path: string): void {
  const absolute = resolve(path);
  if (basename(absolute) !== "Codex.app" || basename(dirname(absolute)) !== "backup") {
    throw new Error("Signed Codex.app backup path must be the exact app root under a backup directory.");
  }
}

/**
 * Post-promotion mode bookkeeping: record that the live app is now the patched
 * Tweakers payload and drop the (now stale) parked ChatGPT-mode payload.
 */
export function finalizePromotedModeState(stateFile: string, userRoot: string): void {
  const state = readState(stateFile);
  if (state && state.mode !== "tweakers") {
    writeState(stateFile, { ...state, mode: "tweakers" });
  }
  rmSync(parkedPayloadRoot(userRoot), { recursive: true, force: true });
}

export function hasTweakerAsarMarker(asarPath: string): boolean {
  return readAsarMarker(asarPath) === "present";
}

export type AsarMarker = "present" | "absent" | "unreadable";
export type AsarPatchSchema = "current" | "legacy" | "absent" | "unreadable";

export function readAsarMarker(asarPath: string): AsarMarker {
  const schema = readAsarPatchSchema(asarPath);
  return schema === "current" || schema === "legacy" ? "present" : schema;
}

export function readAsarPatchSchema(asarPath: string): AsarPatchSchema {
  try {
    const pkg = JSON.parse(readFileInAsar(asarPath, "package.json").toString("utf8")) as {
      main?: unknown;
      __tweaker?: unknown;
      [LEGACY_ASAR_META_KEY]?: unknown;
    };
    if (pkg.main === "tweaker-loader.cjs" || typeof pkg.__tweaker === "object") return "current";
    if (pkg.main === LEGACY_LOADER_FILE || typeof pkg[LEGACY_ASAR_META_KEY] === "object") return "legacy";
    return "absent";
  } catch {
    return "unreadable";
  }
}

const MAIN_RENDERER_ASAR_ENTRY = "webview/index.html";
const MAX_ASAR_PACKAGE_BYTES = 1024 * 1024;
const MAX_MAIN_PROCESS_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_MAIN_RENDERER_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_MAIN_RENDERER_ASSET_BYTES = 128 * 1024 * 1024;

interface AsarFileEntry {
  files?: Record<string, unknown>;
  integrity?: unknown;
  link?: unknown;
  offset?: unknown;
  size?: unknown;
  unpacked?: unknown;
}

/**
 * Prove the patched archive still contains the real application bootstrap and
 * a complete main renderer document. The one-shot runtime health process does
 * not execute OpenAI's original main module, so its receipt cannot substitute
 * for this sealed-ASAR validation.
 */
export function validateMainRendererAsarEntrypoint(asarPath: string): void {
  const header = readHeaderHash(asarPath).header;
  const readEntry = (entryPath: string, maxBytes: number): Buffer => (
    readVerifiedInlineAsarEntry(asarPath, header, entryPath, maxBytes)
  );
  const packageBytes = readEntry("package.json", MAX_ASAR_PACKAGE_BYTES);
  let pkg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageBytes)) as unknown;
    const record = recordValue(parsed);
    if (!record) throw new Error("package root is not an object");
    pkg = record;
  } catch (error) {
    throw new Error(`candidate app.asar package.json is corrupt: ${errorMessage(error)}`);
  }

  const current = recordValue(pkg.__tweaker);
  const legacy = recordValue(pkg[LEGACY_ASAR_META_KEY]);
  const metadata = current ?? legacy;
  const loaderEntry = current ? "tweaker-loader.cjs" : legacy ? LEGACY_LOADER_FILE : null;
  const originalMain = metadata?.originalMain;
  if (!loaderEntry || pkg.main !== loaderEntry || typeof originalMain !== "string") {
    throw new Error("candidate app.asar loader metadata is incomplete");
  }
  const normalizedOriginalMain = normalizeContainedAsarPath(originalMain, "original main entry");
  readEntry(loaderEntry, MAX_ASAR_PACKAGE_BYTES);
  readEntry(normalizedOriginalMain, MAX_MAIN_PROCESS_ENTRY_BYTES);

  const rendererBytes = readEntry(MAIN_RENDERER_ASAR_ENTRY, MAX_MAIN_RENDERER_ENTRY_BYTES);
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(rendererBytes);
  } catch {
    throw new Error(`candidate main renderer entry ${MAIN_RENDERER_ASAR_ENTRY} is not valid UTF-8`);
  }
  if (!completeMainRendererDocument(html)) {
    throw new Error(`candidate main renderer entry ${MAIN_RENDERER_ASAR_ENTRY} is corrupt or truncated`);
  }

  const moduleEntries = moduleScriptSources(html).map((source) => {
    const withoutQuery = source.split(/[?#]/, 1)[0] ?? "";
    if (!withoutQuery || withoutQuery.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(withoutQuery)) {
      throw new Error(`candidate main renderer module source is not contained in app.asar: ${source}`);
    }
    const resolved = posix.normalize(posix.join(posix.dirname(MAIN_RENDERER_ASAR_ENTRY), withoutQuery));
    if (!resolved.startsWith("webview/") || resolved === "webview") {
      throw new Error(`candidate main renderer module source escapes its ASAR root: ${source}`);
    }
    return normalizeContainedAsarPath(resolved, "main renderer module entry");
  });
  if (moduleEntries.length === 0) {
    throw new Error(`candidate main renderer entry ${MAIN_RENDERER_ASAR_ENTRY} has no module bootstrap`);
  }
  for (const moduleEntry of new Set(moduleEntries)) {
    readEntry(moduleEntry, MAX_MAIN_RENDERER_ASSET_BYTES);
  }
}

function readVerifiedInlineAsarEntry(
  asarPath: string,
  header: unknown,
  entryPath: string,
  maxBytes: number,
): Buffer {
  const entry = asarHeaderFileEntry(header, entryPath);
  if (entry.files || entry.link !== undefined || entry.unpacked === true) {
    throw new Error(`candidate app.asar entry is not a sealed inline file: ${entryPath}`);
  }
  if (!Number.isSafeInteger(entry.size) || Number(entry.size) <= 0 || Number(entry.size) > maxBytes) {
    throw new Error(`candidate app.asar entry has an invalid size: ${entryPath}`);
  }
  if (typeof entry.offset !== "string" || !/^\d+$/.test(entry.offset)) {
    throw new Error(`candidate app.asar entry has an invalid offset: ${entryPath}`);
  }
  const bytes = readInlineAsarBytes(asarPath, entryPath, Number(entry.offset), Number(entry.size));
  if (bytes.length !== entry.size) {
    throw new Error(`candidate app.asar entry is truncated: ${entryPath}`);
  }
  const integrity = recordValue(entry.integrity);
  const expectedHash = integrity?.hash;
  if (integrity?.algorithm !== "SHA256" || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    throw new Error(`candidate app.asar entry has no valid SHA-256 integrity proof: ${entryPath}`);
  }
  const observedHash = createHash("sha256").update(bytes).digest("hex");
  if (observedHash !== expectedHash.toLowerCase()) {
    throw new Error(`candidate app.asar entry failed its SHA-256 integrity proof: ${entryPath}`);
  }
  return bytes;
}

function readInlineAsarBytes(
  asarPath: string,
  entryPath: string,
  entryOffset: number,
  entrySize: number,
): Buffer {
  const descriptor = openSync(asarPath, "r");
  try {
    const archiveStat = fstatSync(descriptor);
    const sizePickle = Buffer.alloc(8);
    if (!readExactly(descriptor, sizePickle, 0) || sizePickle.readUInt32LE(0) !== 4) {
      throw new Error(`candidate app.asar header is unreadable while reading: ${entryPath}`);
    }
    const headerSize = sizePickle.readUInt32LE(4);
    const position = 8 + headerSize + entryOffset;
    if (!Number.isSafeInteger(position) || position < 8 || position + entrySize > archiveStat.size) {
      throw new Error(`candidate app.asar entry exceeds the archive bounds: ${entryPath}`);
    }
    const bytes = Buffer.alloc(entrySize);
    if (!readExactly(descriptor, bytes, position)) {
      throw new Error(`candidate app.asar entry is truncated: ${entryPath}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readExactly(descriptor: number, buffer: Buffer, position: number): boolean {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead <= 0) return false;
    offset += bytesRead;
  }
  return true;
}

function asarHeaderFileEntry(header: unknown, entryPath: string): AsarFileEntry {
  let node = recordValue(header);
  for (const segment of entryPath.split("/")) {
    const files = recordValue(node?.files);
    if (!files || !Object.prototype.hasOwnProperty.call(files, segment)) {
      throw new Error(`candidate app.asar is missing required entry: ${entryPath}`);
    }
    node = recordValue(files[segment]);
    if (!node) throw new Error(`candidate app.asar has an invalid header entry: ${entryPath}`);
  }
  return node as AsarFileEntry;
}

function normalizeContainedAsarPath(entryPath: string, label: string): string {
  if (!entryPath || entryPath.includes("\\") || entryPath.startsWith("/") || entryPath.includes("\0")) {
    throw new Error(`candidate app.asar ${label} is unsafe`);
  }
  const normalized = posix.normalize(entryPath.replace(/^\.\//, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`candidate app.asar ${label} escapes the archive root`);
  }
  return normalized;
}

function completeMainRendererDocument(html: string): boolean {
  const document = html.trim();
  return /^<!doctype\s+html\b/i.test(document)
    && /<html\b/i.test(document)
    && /<head\b/i.test(document)
    && /<\/head\s*>/i.test(document)
    && /<body\b/i.test(document)
    && /<\/body\s*>/i.test(document)
    && /<\/html\s*>\s*$/i.test(document);
}

function moduleScriptSources(html: string): string[] {
  const sources: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const source = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (source) sources.push(source);
  }
  return sources;
}

export function formatInvalidatedInstallError(liveAppRoot: string, failure?: string, pendingReason?: string): string {
  return `Candidate validation failed; the live app at ${liveAppRoot} was NOT modified.\n` +
    `Reason: ${failure ?? pendingReason ?? "candidate validation failed"}`;
}

/**
 * Replace app.asar's package.json `main` with our loader, copying the
 * loader.cjs into the asar so it can resolve. Returns the original entry path.
 */
async function injectLoader(
  asarPath: string,
  userRoot: string,
  step: (msg: string) => void = () => {},
  appUserDataRoot?: string,
  appDisplayName?: string,
): Promise<string> {
  let originalMain = "";
  await patchAsar(asarPath, (dir) => {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) {
      throw new Error("app.asar has no package.json — Codex layout changed?");
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    originalMain = String(pkg.main ?? "");
    if (!originalMain) throw new Error("app.asar package.json has no `main` field");

    // Preserve the original entry across repairs while refreshing isolated paths.
    if (pkg["__tweaker"]) originalMain = String(pkg["__tweaker"].originalMain);
    if (pkg[LEGACY_ASAR_META_KEY]) originalMain = String(pkg[LEGACY_ASAR_META_KEY].originalMain);
    pkg["__tweaker"] = {
      originalMain,
      userRoot,
      loader: "tweaker-loader.cjs",
      ...(appUserDataRoot ? { appUserDataRoot } : {}),
    };
    delete pkg[LEGACY_ASAR_META_KEY];
    // The owl Electron fork resolves userData/singleton paths natively from
    // the asar's productName BEFORE any JS runs and ignores a later
    // app.setPath("userData"). A variant must therefore carry its own
    // product identity here, or it shares (and races) the official app's
    // profile at the Chromium layer no matter what the loader does.
    if (appDisplayName) {
      pkg.productName = appDisplayName;
    }
    pkg.main = "tweaker-loader.cjs";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    // Copy our loader stub into the asar root.
    const loaderSrc = join(assetsDir, "loader.cjs");
    if (!existsSync(loaderSrc)) {
      // Fall back to the in-repo path during development.
      const devLoader = resolve(here, "..", "..", "..", "..", "loader", "loader.cjs");
      if (!existsSync(devLoader)) {
        throw new Error(`loader.cjs not found at ${loaderSrc} or ${devLoader}`);
      }
      cpSync(devLoader, join(dir, "tweaker-loader.cjs"));
    } else {
      cpSync(loaderSrc, join(dir, "tweaker-loader.cjs"));
    }

    patchCodexWindowServices(dir, originalMain, step);
  });
  return originalMain;
}

interface CodexWindowServicesCandidateDiagnostic {
  relativePath: string;
  bytes: number;
  diagnostics: CodexWindowServicesSourceDiagnostics;
  parserError?: string;
}

function patchCodexWindowServices(
  appDir: string,
  originalMain: string,
  step: (msg: string) => void = () => {},
): void {
  const candidates = findCodexMainCandidates(appDir, originalMain);
  const candidateNames = candidates.map((p) => relative(appDir, p) || basename(p));
  step(
    `Scanning Codex window services hook candidates (${candidates.length}): ${
      candidateNames.length ? candidateNames.map((p) => kleur.dim(p)).join(", ") : kleur.yellow("none")
    }`,
  );
  const diagnostics: CodexWindowServicesCandidateDiagnostic[] = [];

  for (const mainPath of candidates) {
    const source = readFileSync(mainPath, "utf8");
    const relativePath = relative(appDir, mainPath) || basename(mainPath);
    const candidateDiagnostic: CodexWindowServicesCandidateDiagnostic = {
      relativePath,
      bytes: source.length,
      diagnostics: describeCodexWindowServicesSource(source, CODEX_WINDOW_SERVICES_KEY),
    };
    diagnostics.push(candidateDiagnostic);

    let patched: ReturnType<typeof patchCodexWindowServicesSource> = null;
    try {
      patched = patchCodexWindowServicesSource(source, CODEX_WINDOW_SERVICES_KEY);
    } catch (e) {
      candidateDiagnostic.parserError = (e as Error).message;
      continue;
    }

    if (patched) {
      if (patched.changed) writeFileSync(mainPath, patched.source);
      step(
        `Exposed Codex window services from ${kleur.dim(relativePath)} using ${kleur.cyan(patched.strategy)}${
          patched.serviceVar ? ` (${patched.serviceVar})` : ""
        }`,
      );
      return;
    }
  }

  throw new Error(formatWindowServicesHookFailure(originalMain, diagnostics));
}

export function findCodexMainCandidates(appDir: string, originalMain: string): string[] {
  const originalPath = resolve(appDir, originalMain);
  const out = existsSync(originalPath) ? [originalPath] : [];
  const buildDir = resolve(appDir, ".vite", "build");
  const roots: Array<{ dir: string; recursive: boolean }> = [
    { dir: appDir, recursive: false },
    { dir: buildDir, recursive: true },
  ];
  const originalDir = dirname(originalPath);
  if (originalDir !== appDir && !isSameOrInside(originalDir, buildDir)) {
    roots.push({ dir: originalDir, recursive: true });
  }

  const discovered = roots
    .flatMap((root) => collectJavaScriptFiles(root.dir, root.recursive))
    .sort((a, b) => {
      const rank = candidateRank(basename(a)) - candidateRank(basename(b));
      if (rank !== 0) return rank;
      const name = basename(a).localeCompare(basename(b));
      if (name !== 0) return name;
      return relative(appDir, a).localeCompare(relative(appDir, b));
    });

  const seen = new Set(out);
  for (const candidate of discovered) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

function candidateRank(name: string): number {
  if (/^main(?:[-.].*)?\.js$/.test(name)) return 0;
  if (/^bootstrap(?:[-.].*)?\.js$/.test(name)) return 1;
  if (/^(app|desktop|src)(?:[-.].*)?\.js$/.test(name)) return 2;
  if (/preload|worker|service/i.test(name)) return 4;
  return 3;
}

function collectJavaScriptFiles(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const target = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) out.push(...collectJavaScriptFiles(target, true));
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        out.push(target);
      }
    }
  } catch {}
  return out;
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

function formatWindowServicesHookFailure(
  originalMain: string,
  diagnostics: CodexWindowServicesCandidateDiagnostic[],
): string {
  const lines = [
    "Codex window services hook point not found.",
    "",
    "Tweakers could not identify Codex's main-process window services factory.",
    "This usually means Codex changed its bundled main-process layout or renamed the service object properties.",
    "",
    `Original entry point: ${originalMain}`,
    `Candidate files scanned: ${diagnostics.length}`,
  ];

  if (diagnostics.length === 0) {
    lines.push("No candidate files existed inside app.asar.");
    return lines.join("\n");
  }

  for (const candidate of diagnostics) {
    const fingerprints = candidate.diagnostics.matchedFingerprints;
    lines.push(
      "",
      `Candidate: ${candidate.relativePath}`,
      `  Bytes: ${candidate.bytes}`,
      `  Marker already present: ${candidate.diagnostics.hasMarker ? "yes" : "no"}`,
      `  Object factory calls: ${candidate.diagnostics.objectCalls}`,
      `  buildFlavor properties: ${candidate.diagnostics.buildFlavorProperties}`,
      `  Window-service fingerprints: ${fingerprints.length ? fingerprints.join(", ") : "none"}`,
    );
    if (candidate.parserError) {
      lines.push(`  Parser error: ${candidate.parserError}`);
    }
    if (candidate.diagnostics.snippet) {
      lines.push(`  Nearby source: ${candidate.diagnostics.snippet}`);
    }
  }

  return lines.join("\n");
}

export function stageAssets(runtimeDir: string): void {
  const src = join(assetsDir, "runtime");
  if (existsSync(src)) {
    replaceDirectory(src, runtimeDir);
    chownForTargetUser(runtimeDir, { recursive: true });
    return;
  }
  // Dev fallback: copy from the in-tree built runtime.
  const devSrc = resolve(here, "..", "..", "..", "..", "runtime", "dist");
  if (existsSync(devSrc)) {
    replaceDirectory(devSrc, runtimeDir);
    chownForTargetUser(runtimeDir, { recursive: true });
    return;
  }
  throw new Error(
    `Runtime assets not found. Expected at ${src} (built package) or ${devSrc} (dev).\n` +
      `Run \`npm run build\` from the workspace root.`,
  );
}

/**
 * Bundled tweaks retired from the catalog. The staging loop below only ever
 * ADDS folders, so without an explicit prune an upgraded install would keep
 * loading a retired tweak's staged copy forever (mode-switcher's stale copy
 * even rendered a second, non-functional App Mode control). Dev-mode symlinks
 * are the developer's live checkout and are left to dev-sync's sweep.
 */
const RETIRED_BUNDLED_TWEAKS = ["mode-switcher", "co.tweakers.mode-switcher"];

export function stageBundledTweaks(
  tweaksDir: string,
  runtimeDir: string,
  opts: { devTweaksRoot?: string | null; log?: (message: string) => void } = {},
): void {
  const catalog = JSON.parse(readFileSync(join(runtimeDir, "catalog.json"), "utf8")) as {
    entries?: Array<{ id?: unknown; source?: { kind?: unknown; path?: unknown } }>;
  };
  const devRoot = opts.devTweaksRoot ?? null;
  const devSnapshotFolders = readDevSnapshotFolders(
    join(tweaksDir, ".tweaker-dev-snapshot.json"),
    join(tweaksDir, LEGACY_DEV_SNAPSHOT_FILE),
  );
  const bundledFolders = new Set<string>();
  for (const entry of catalog.entries ?? []) {
    if (entry.source?.kind !== "bundled" || typeof entry.id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(entry.id)) continue;
    if (typeof entry.source.path !== "string" || !/^tweaks\/[a-zA-Z0-9._-]+$/.test(entry.source.path)) {
      throw new Error(`Bundled tweak path is invalid: ${entry.id}`);
    }
    const source = join(runtimeDir, entry.source.path);
    if (!existsSync(source)) throw new Error(`Bundled tweak source is missing: ${entry.id}`);
    const folder = basename(entry.source.path);
    bundledFolders.add(folder);
    const dest = join(tweaksDir, folder);
    // Dev-mode links into the configured source checkout are the live copies —
    // never replace them with the bundled snapshot. Arbitrary symlinks (any
    // other target) are still replaced, unchanged security posture.
    if (isRealDevSnapshotDirectory(dest, folder, devSnapshotFolders)) {
      opts.log?.(`kept validated dev snapshot for ${folder}`);
    } else if (devRoot !== null && isSymlinkInto(dest, devRoot)) {
      opts.log?.(`kept dev link for ${folder}`);
    } else {
      replaceDirectory(source, dest);
    }
    if (entry.id !== folder) {
      const idPath = join(tweaksDir, entry.id);
      if (devRoot === null || !isSymlinkInto(idPath, devRoot)) {
        rmSync(idPath, { recursive: true, force: true });
      }
    }
  }
  pruneSupersededProjectTweaks(tweaksDir, bundledFolders, { devTweaksRoot: devRoot, log: opts.log });
  pruneRetiredTweaks(tweaksDir, { devTweaksRoot: devRoot, log: opts.log });
  chownForTargetUser(tweaksDir, { recursive: true });
}

function pruneSupersededProjectTweaks(
  tweaksDir: string,
  currentFolders: ReadonlySet<string>,
  opts: { devTweaksRoot?: string | null; log?: (message: string) => void } = {},
): void {
  const devRoot = opts.devTweaksRoot ?? null;
  for (const entry of readdirSync(tweaksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || currentFolders.has(entry.name)) continue;
    const folder = join(tweaksDir, entry.name);
    if (devRoot !== null && isSymlinkInto(folder, devRoot)) continue;
    try {
      const manifestFile = join(folder, "manifest.json");
      const stat = lstatSync(manifestFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) continue;
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { githubRepo?: unknown };
      if (manifest.githubRepo !== "therealityreport/tweakers") continue;
    } catch {
      continue;
    }
    opts.log?.(`pruned superseded Tweakers folder ${entry.name}`);
    rmSync(folder, { recursive: true, force: true });
  }
}

export function pruneRetiredTweaks(
  tweaksDir: string,
  opts: { devTweaksRoot?: string | null; log?: (message: string) => void } = {},
): void {
  const devRoot = opts.devTweaksRoot ?? null;
  for (const retired of RETIRED_BUNDLED_TWEAKS) {
    const stale = join(tweaksDir, retired);
    if (devRoot !== null && isSymlinkInto(stale, devRoot)) {
      opts.log?.(`kept dev link for retired tweak ${retired}`);
      continue;
    }
    if (existsSync(stale)) opts.log?.(`pruned retired bundled tweak ${retired}`);
    rmSync(stale, { recursive: true, force: true });
  }
  // A dev-snapshot record naming a retired folder would make a later staging
  // pass keep whatever reappears at that path — scrub retired ids from it.
  const snapshotFile = join(tweaksDir, ".tweaker-dev-snapshot.json");
  const legacySnapshotFile = join(tweaksDir, LEGACY_DEV_SNAPSHOT_FILE);
  for (const sourceFile of [snapshotFile, legacySnapshotFile]) try {
    const parsed = JSON.parse(readFileSync(sourceFile, "utf8")) as { folders?: unknown };
    if (Array.isArray(parsed.folders)) {
      const kept = parsed.folders.filter(
        (value) => typeof value === "string" && !RETIRED_BUNDLED_TWEAKS.includes(value),
      );
      if (kept.length !== parsed.folders.length) {
        writeFileSync(snapshotFile, `${JSON.stringify({ ...parsed, folders: kept }, null, 2)}\n`, "utf8");
      }
    }
  } catch {
    // No snapshot record (or unreadable) — nothing to scrub.
  }
  if (existsSync(snapshotFile)) rmSync(legacySnapshotFile, { force: true });
}

function readDevSnapshotFolders(...paths: string[]): Set<string> {
  const folders = new Set<string>();
  for (const path of paths) try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { folders?: unknown };
    if (!Array.isArray(parsed.folders)) continue;
    for (const value of parsed.folders) {
      if (typeof value === "string" && /^[a-zA-Z0-9._-]+$/.test(value)) folders.add(value);
    }
  } catch {
    // Missing or unreadable compatibility manifest.
  }
  return folders;
}

function isRealDevSnapshotDirectory(dest: string, folder: string, snapshotFolders: Set<string>): boolean {
  if (!snapshotFolders.has(folder)) return false;
  try {
    const stat = lstatSync(dest);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function runtimeAssetsMatch(runtimeDir: string): boolean {
  const packaged = join(assetsDir, "runtime");
  const source = existsSync(packaged)
    ? packaged
    : resolve(here, "..", "..", "..", "..", "runtime", "dist");
  return existsSync(source) && hashDirectoryTree(source) === hashDirectoryTree(runtimeDir);
}

interface Stepper {
  (msg: string): void;
  detail(msg: string): void;
}

function makeStepper(opts: { quiet?: boolean; verbose?: boolean } = {}): Stepper {
  let n = 1;
  const emit = (msg: string) => {
    if (!opts.quiet) console.log(`${kleur.dim(`[${n++}]`)} ${msg}`);
  };
  const step = emit as Stepper;
  step.detail = (msg: string) => {
    if (opts.verbose) emit(msg);
  };
  return step;
}

function formatCliStep(message: string): string {
  return message.replace(/^Installed CLI(?::)?/, "CLI");
}

export function preflightWritableTargets(
  codex: Pick<CodexInstall, "resourcesDir" | "asarPath" | "metaPath" | "electronBinary" | "platform">,
  opts: { fuseFlip: boolean },
): void {
  preflightWritableDirectory(codex.resourcesDir, codex.platform);
  preflightWritableFile(codex.asarPath, codex.platform);
  if (codex.metaPath) preflightWritableFile(codex.metaPath, codex.platform);
  if (opts.fuseFlip) preflightWritableFile(codex.electronBinary, codex.platform);
}

/**
 * Touch a probe file inside the app bundle to surface (and trigger) macOS
 * App Management TCC denials before we begin destructive work.
 */
function preflightWritableDirectory(targetDir: string, platform: string): void {
  const probe = join(targetDir, ".tweaker-write-probe");
  const copyProbe = join(targetDir, ".tweaker-copy-probe");
  try {
    const fd = openSync(probe, "w");
    closeSync(fd);
    copyFileSync(probe, copyProbe);
    unlinkSync(probe);
    unlinkSync(copyProbe);
  } catch (e) {
    try {
      unlinkSync(probe);
    } catch {}
    try {
      unlinkSync(copyProbe);
    } catch {}
    throw writableError(e, targetDir, platform);
  }
}

function preflightWritableFile(targetFile: string, platform: string): void {
  try {
    const fd = openSync(targetFile, "r+");
    closeSync(fd);
  } catch (e) {
    throw writableError(e, targetFile, platform);
  }
}

function writableError(e: unknown, target: string, platform: string): unknown {
  const err = e as NodeJS.ErrnoException;
  if (err.code !== "EPERM" && err.code !== "EACCES") return e;

  const isMac = platform === "darwin";
  const inWindowsApps =
    platform === "win32" && /\\WindowsApps\\/i.test(`${target}\\`);
  const msg =
    `Cannot write to ${target}.\n\n` +
    (isMac
      ? macAppManagementFix(target, err.code)
      : inWindowsApps
        ? `Windows Store installs live under WindowsApps and Windows is blocking the patch write.\n` +
          `Fix:\n` +
          `  1. Quit Codex completely\n` +
          `  2. Re-open PowerShell as Administrator\n` +
          `  3. Re-run this command.\n\n` +
          `If Administrator still cannot write here, this Store install is locked by Windows package protections.\n` +
          `Use a writable Codex install folder and rerun with --app pointing at it.\n`
        : `Check filesystem permissions for the Codex install folder.\n`) +
    `\nOriginal error: ${err.message}`;
  return new Error(msg);
}

function macAppManagementFix(target: string, code: string | undefined): string {
  const permissionSteps =
    `macOS App Management is blocking modification of ${target}.\n` +
    `Run "tweaker repair" in your terminal.\n`;
  const sudoFallback =
    code === "EACCES"
      ? `If Codex.app is root-owned and repair still cannot write to it, run "sudo tweaker repair".\n`
      : "";

  return permissionSteps + sudoFallback;
}

export function assertCodexNotRunning(
  codex: CodexInstall,
  open: OpenReport = getOpenReport(codex),
): void {
  if (!reportsMainProcessRunning(open)) return;

  throw new Error(formatCodexRunningError(codex, open));
}

export interface PrepareCodexForPatchingController {
  getOpenReport?: (codex: CodexInstall) => OpenReport;
  step?: (msg: string) => void;
}

export function prepareCodexForPatching(
  codex: CodexInstall,
  controller: PrepareCodexForPatchingController = {},
): boolean {
  const readOpenReport = controller.getOpenReport ?? getOpenReport;
  const open = readOpenReport(codex);
  if (!reportsMainProcessRunning(open)) return false;

  controller.step?.("Codex is running; live in-place patching is blocked");
  throw new Error(formatCodexRunningError(codex, open));
}

function formatCodexRunningError(codex: CodexInstall, open: OpenReport): string {
  const status = open.status === "unknown" ? "running" : open.status;
  const pid = open.pid === null ? "" : `\n  PID: ${open.pid}`;
  const openedAt = open.openedAt ?? open.openedAtRaw;
  const opened = openedAt ? `\n  Opened at: ${openedAt}` : "";
  const related = formatRelatedPids(open.relatedPids);
  const stuckCommand =
    codex.platform === "win32" && open.pid !== null
      ? `\nIf it is stuck, run:\n  Stop-Process -Id ${open.pid}\n`
      : "";

  return (
    `[!] Close Codex before patching\n\n` +
    `Codex is currently ${status}:\n` +
    `  ${codex.appName}\n` +
    `  ${codex.appRoot}${pid}${opened}${related}\n\n` +
    `Tweakers cannot safely patch app.asar while Codex is running. ` +
    `Changing the bundle underneath an active process can make lazy-loaded Codex surfaces crash until restart.\n\n` +
    `Quit Codex completely, then rerun this command from Terminal.\n` +
    stuckCommand
  );
}

function formatRelatedPids(pids: number[]): string {
  if (pids.length === 0) return "";
  const shown = pids.slice(0, 12).join(", ");
  const more = pids.length > 12 ? `, +${pids.length - 12} more` : "";
  return `\n  Related PIDs: ${shown}${more}`;
}

function preflightAppClosed(codex: CodexInstall, step: (msg: string) => void): boolean {
  return prepareCodexForPatching(codex, { step });
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

function installWindowsManagedAppLauncher(codex: CodexInstall): { shortcutPaths: string[] } | null {
  if (codex.platform !== "win32") return null;
  const normalizedRoot = `${codex.appRoot.replace(/\//g, "\\")}\\`;
  if (!/\\tweaker\\store-apps\\/i.test(normalizedRoot)
    && !normalizedRoot.toLowerCase().includes(`\\${LEGACY_DATA_DIR}\\store-apps\\`)) {
    return null;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;

  const shimDir = join(localAppData, "Microsoft", "WindowsApps");
  mkdirSync(shimDir, { recursive: true });
  const commandPath = join(shimDir, "tweaker-codex.cmd");
  writeFileSync(
    commandPath,
    `@echo off\r\nstart "" "${codex.executable}" %*\r\n`,
    "utf8",
  );
  const shortcutPaths = [commandPath];

  const startMenuRoot = process.env.APPDATA
    ? join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")
    : null;
  if (!startMenuRoot) return { shortcutPaths };

  const startMenuShortcut = join(startMenuRoot, "Tweakers.lnk");
  if (createWindowsCodexShortcut(startMenuShortcut, codex.executable)) {
    shortcutPaths.push(startMenuShortcut);
  }
  const desktopShortcut = join(homedir(), "Desktop", "Tweakers.lnk");
  if (createWindowsCodexShortcut(desktopShortcut, codex.executable)) {
    shortcutPaths.push(desktopShortcut);
  }

  return { shortcutPaths };
}

function createWindowsCodexShortcut(shortcutPath: string, targetPath: string): boolean {
  try {
    mkdirSync(dirname(shortcutPath), { recursive: true });
    const script = [
      `$shortcutPath = '${escapePowerShellSingleQuotedString(shortcutPath)}'`,
      `$targetPath = '${escapePowerShellSingleQuotedString(targetPath)}'`,
      `$workingDirectory = '${escapePowerShellSingleQuotedString(dirname(targetPath))}'`,
      "$shell = New-Object -ComObject WScript.Shell",
      "$shortcut = $shell.CreateShortcut($shortcutPath)",
      "$shortcut.TargetPath = $targetPath",
      "$shortcut.WorkingDirectory = $workingDirectory",
      "$shortcut.IconLocation = \"$targetPath,0\"",
      "$shortcut.Save()",
    ].join("; ");
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function preflightSystemTools(platform: string, resign: boolean, hasPlist: boolean): void {
  if (platform !== "darwin") return;
  if (resign) requireCommand("codesign", "macOS codesign is required to re-sign Codex.app after patching.");
  if (hasPlist) requireCommand("plutil", "macOS plutil is required to update Codex.app's Info.plist.");
}

function requireCommand(command: string, message: string): void {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`[!] ${command} not installed\n\n${message}\nPaste this error into Codex if you need help.`);
  }
}
