import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defaultAccountRouterConfigPath, isQuotaAwareRouterConfig, readRouterLaunchSelection } from "./config";
import {
  ACCOUNT_HISTORY_ADOPTION_INTENT_FILE,
  ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE,
  ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE,
  HISTORY_ADOPTION_MAX_ARTIFACT_BYTES,
  HISTORY_ADOPTION_MAX_OWNERS_BYTES,
  validateHistoryAdoptionArtifacts,
  validateHistoryAdoptionEvidence,
  type HistoryAdoptionFailure,
} from "./history-adoption";
import { AccountRouterMux, type RouterChild, type RouterChildFactory } from "./mux";
import { readAndPreflightNativeHistorySourceStaticV1 } from "./native-history";
import { startRouterControlSocket, type RouterControlSocket } from "./control-socket";
import { parseJsonRpcLine } from "./protocol";
import { assertPrivateRegularFile, ensurePrivateDirectory, migrateIdleRouterStateV3, RouterStateStore, validateRouterState } from "./state-store";
import type { JsonRpcMessage, OpaqueAccountId, RouterConfig, RouterConfigV2, RouterConfigV3, RouterState } from "./types";
import { isPlainRecord } from "./types";

const CHILD_INITIALIZE_TIMEOUT_MS = 10_000;
const GRACEFUL_SHUTDOWN_MS = 2_000;
const FORCED_SHUTDOWN_OBSERVATION_MS = 1_000;
const MAX_AUTH_BYTES = 256 * 1024;
const MAX_CHILD_CONFIG_BYTES = 4 * 1024;
const MAX_SHARED_SKILL_FILES = 32_768;
const MAX_SHARED_SKILL_BYTES = 512 * 1024 * 1024;
const SHARED_SKILLS_DIRECTORY = "shared-skills";
const SHARED_SKILLS_MANIFEST_FILE = "shared-skills.v1.json";
const SHARED_PLUGINS_DIRECTORY = "shared-plugins";
const SHARED_PLUGINS_MANIFEST_FILE = "shared-plugins.v1.json";
const MAX_SHARED_PLUGIN_FILES = 250_000;
const MAX_SHARED_PLUGIN_BYTES = 4 * 1024 * 1024 * 1024;
const EMPTY_SHARED_PLUGIN_HASH = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as `sha256:${string}`;

interface SharedSkillsTreeEntryV1 {
  path: string;
  bytes: number;
  sha256: `sha256:${string}`;
}

interface SharedSkillsTrustedRootV1 {
  path: string;
  device: number;
  inode: number;
  uid: number;
  mode: number;
}

interface SharedSkillsManifestV1 {
  version: 1;
  kind: "account-router-shared-skills";
  directories: readonly string[];
  files: readonly SharedSkillsTreeEntryV1[];
  trustedRoots: readonly SharedSkillsTrustedRootV1[];
  trustedRootsFingerprint: `sha256:${string}`;
  fingerprint: `sha256:${string}`;
}

interface SharedPluginPackageV1 {
  pluginId: string;
  registry: string;
  name: string;
  version: string;
  fingerprint: `sha256:${string}`;
  exclusionsFingerprint: `sha256:${string}`;
  excludedFiles: readonly SharedPluginExcludedFileV1[];
  fileCount: number;
  bytes: number;
}

type SharedPluginExclusionReasonV1 = "credential" | "transient-lock";

interface SharedPluginExcludedFileV1 {
  path: string;
  bytes: number;
  sha256: `sha256:${string}`;
  reason: SharedPluginExclusionReasonV1;
}

interface SharedPluginsManifestV1 {
  version: 1;
  kind: "account-router-shared-plugins";
  inventoryFingerprint: `sha256:${string}`;
  exclusionsFingerprint: `sha256:${string}`;
  packages: readonly SharedPluginPackageV1[];
  fingerprint: `sha256:${string}`;
}

interface MuxCliArguments {
  configPath: string;
  stateRoot: string;
  sharedSqliteHome: string | null;
  command: string;
  args: string[];
}

interface MuxShutdownTarget {
  shutdown(): void;
}

/** Shared EOF/signal cleanup: idempotent and deliberately does not close stdin. */
export function createMuxCliShutdown(
  mux: MuxShutdownTarget,
  closeControl: () => void | Promise<void>,
  pauseInput: () => void,
  scheduleForceExit: () => void,
): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    mux.shutdown();
    void closeControl();
    pauseInput();
    scheduleForceExit();
  };
}

/** Executable entry point run under ChatGPT's bundled signed Node parent. */
export async function runAccountRouterMuxCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(argv);
  if (!parsed) {
    process.exitCode = 1;
    return;
  }
  const selection = readRouterLaunchSelection(parsed.configPath);
  if (selection.mode !== "mux" || !selection.config || !preflightRouterHomes(selection.config, parsed.stateRoot)) {
    process.exitCode = 1;
    return;
  }
  const secret = readControlSecret(parsed.stateRoot);
  if (!secret) {
    process.exitCode = 1;
    return;
  }
  // A v3 native companion is broker-only. The legacy direct mux has no
  // writer fence or external-home routing proof, so it must never become an
  // availability fallback merely because the broker socket is unavailable.
  if (selection.config.schemaVersion === 3
    && readAndPreflightNativeHistorySourceStaticV1(parsed.stateRoot, selection.config, secret).state === "ready") {
    secret.fill(0);
    process.exitCode = 1;
    return;
  }
  const childArgs = selection.config.schemaVersion === 3 ? sharedPluginChildArgs(parsed.stateRoot, parsed.args) : parsed.args;
  if (!childArgs) {
    secret.fill(0);
    process.exitCode = 1;
    return;
  }
  const store = new RouterStateStore(parsed.stateRoot, selection.config);
  let input: ReturnType<typeof createInterface> | null = null;
  let control: RouterControlSocket | null = null;
  let fatalExitScheduled = false;
  const scheduleFatalExit = () => {
    if (fatalExitScheduled) return;
    fatalExitScheduled = true;
    process.exitCode = 1;
    input?.close();
    process.stdin.pause();
    void control?.close();
    const force = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS + FORCED_SHUTDOWN_OBSERVATION_MS);
    force.unref();
  };
  const mux = new AccountRouterMux({
    config: selection.config,
    store,
    controlSecret: secret,
    childFactory: new ProcessRouterChildFactory(
      parsed.command,
      childArgs,
      parsed.stateRoot,
      parsed.sharedSqliteHome,
    ),
    writeDesktop: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    // A later v2 config is pending intent only. The running mux keeps the
    // startup config as active truth and never changes its route mid-session.
    readPendingConfig: () => readRouterLaunchSelection(parsed.configPath).config,
    onFatal: scheduleFatalExit,
    onShutdown: () => { void control?.close(); },
  });
  try {
    control = await startRouterControlSocket({
      root: parsed.stateRoot,
      secret,
      status: () => mux.status(),
    });
  } catch {
    process.exitCode = 1;
    return;
  }
  if (!mux.start()) {
    await control.close();
    process.exitCode = 1;
    return;
  }
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => mux.receiveDesktopLine(line));
  const shutdown = createMuxCliShutdown(
    mux,
    () => control?.close(),
    () => process.stdin.pause(),
    () => {
      const force = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS + FORCED_SHUTDOWN_OBSERVATION_MS);
      force.unref();
    },
  );
  // `close` is also raised on stdin EOF. This shared callback must not call
  // input.close(), otherwise EOF recursively re-enters readline shutdown.
  input.once("close", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export function preflightRouterHomes(config: RouterConfig, stateRoot: string): boolean {
  return preflightRouterHomesDetail(config, stateRoot).ok;
}

/**
 * Non-secret startup evidence for the parent/direct-fallback decision. File
 * names, homes, identities, and provider data deliberately never escape it.
 */
export function preflightRouterHomesDetail(
  config: RouterConfig,
  stateRoot: string,
): { ok: true } | { ok: false; reason: HistoryAdoptionFailure | "startup_selfcheck_failed" } {
  if (!isQuotaAwareRouterConfig(config)) return { ok: false, reason: "history_adoption_required" };
  const secret = readControlSecret(stateRoot);
  if (!secret) return { ok: false, reason: "startup_selfcheck_failed" };
  let intentBytes: Buffer | null = null;
  let receiptBytes: Buffer | null = null;
  let ownersBytes: Buffer | null = null;
  try {
    ensurePrivateDirectory(stateRoot);
    // A signed in-place source is an explicit v3 alternative to the old
    // adopted-home receipt. This parent/bridge check is deliberately static:
    // it must not classify an already-running broker-owned child as a foreign
    // writer while a second desktop is only selecting its broker transport.
    if (config.schemaVersion === 3) {
      const native = readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret);
      if (native.state === "ready") return { ok: true };
      if (native.state === "invalid") return { ok: false, reason: "startup_selfcheck_failed" };
    }
    const state = stateAllowsBalancedStartup(config, stateRoot);
    if (!state) return { ok: false, reason: "startup_selfcheck_failed" };
    intentBytes = readOwnerPrivateRegularFile(join(stateRoot, ACCOUNT_HISTORY_ADOPTION_INTENT_FILE), HISTORY_ADOPTION_MAX_ARTIFACT_BYTES, false);
    receiptBytes = readOwnerPrivateRegularFile(join(stateRoot, ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE), HISTORY_ADOPTION_MAX_ARTIFACT_BYTES, false);
    ownersBytes = readOwnerPrivateRegularFile(join(stateRoot, ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE), HISTORY_ADOPTION_MAX_OWNERS_BYTES, false);
    if (!intentBytes || !receiptBytes || !ownersBytes) return { ok: false, reason: "history_adoption_required" };
    const adoption = validateHistoryAdoptionEvidence(config, state, secret, {
      intent: intentBytes, receipt: receiptBytes, owners: ownersBytes,
    });
    if (!adoption.ok) return adoption;
    const owner = adoption.evidence.receipt.legacyOwnerOpaqueAccountId;
    if (!validateHistoryAdoptionArtifacts(
      adoption.evidence.receipt,
      join(stateRoot, "accounts", owner, "codex-home"),
      join(stateRoot, "accounts", owner, "sqlite-home"),
    )) return { ok: false, reason: "history_adoption_artifact_mismatch" };
    for (const account of config.accounts) {
      if (!account.included) continue;
      for (const directory of [
        join(stateRoot, "accounts", account.opaqueAccountId),
        join(stateRoot, "accounts", account.opaqueAccountId, "codex-home"),
        join(stateRoot, "accounts", account.opaqueAccountId, "sqlite-home"),
      ]) {
        if (!existsSync(directory)) return { ok: false, reason: "startup_selfcheck_failed" };
        ensurePrivateDirectory(directory);
      }
      if (!validateIsolatedAccountHome(account.opaqueAccountId, stateRoot, secret)) return { ok: false, reason: "startup_selfcheck_failed" };
    }
    // V3 replaces the legacy per-home Skills state with one sealed
    // manager-global source plus byte-identical, read-only materializations in
    // every included account home. A list response alone is not proof that a
    // selected child can read the same definitions, so check the filesystem
    // boundary before the parent can spawn any child.
    if (config.schemaVersion === 3 && !preflightSharedSkills(stateRoot, config.accounts
      .filter((account) => account.included)
      .map((account) => join(stateRoot, "accounts", account.opaqueAccountId, "codex-home")))) {
      return { ok: false, reason: "startup_selfcheck_failed" };
    }
    if (config.schemaVersion === 3 && !preflightSharedPlugins(stateRoot, config.accounts
      .filter((account) => account.included)
      .map((account) => join(stateRoot, "accounts", account.opaqueAccountId, "codex-home")))) {
      return { ok: false, reason: "startup_selfcheck_failed" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "startup_selfcheck_failed" };
  } finally {
    intentBytes?.fill(0);
    receiptBytes?.fill(0);
    ownersBytes?.fill(0);
    secret.fill(0);
  }
}

/**
 * Materialize the sealed manager-global Skills source into a brand-new,
 * isolated account CODEX_HOME. This is intentionally limited to enrollment
 * staging: an existing account tree is never repaired or overwritten at
 * runtime because a mismatch is evidence of untrusted drift.
 */
export function materializeSharedSkillsIntoAccount(stateRoot: string, codexHome: string): boolean {
  try {
    const manifest = readSharedSkillsManifest(stateRoot);
    if (!manifest) return false;
    const source = join(stateRoot, SHARED_SKILLS_DIRECTORY);
    if (!treeMatchesSharedSkills(source, manifest, true)) return false;
    assertPrivateDirectoryForSkills(codexHome);
    const destination = join(codexHome, "skills");
    if (existsSync(destination)) return false;
    copySharedSkillsTree(source, destination, manifest);
    return treeMatchesSharedSkills(destination, manifest, true);
  } catch {
    return false;
  }
}

/** Confirms one account home is an exact read-only materialization of the manager source. */
export function sharedSkillsHomeMatches(stateRoot: string, codexHome: string): boolean {
  const manifest = readSharedSkillsManifest(stateRoot);
  return manifest !== null
    && treeMatchesSharedSkills(join(stateRoot, SHARED_SKILLS_DIRECTORY), manifest, true)
    && treeMatchesSharedSkills(join(codexHome, "skills"), manifest, true);
}

/** Creates the deterministic, non-secret manifest used by migration fixtures and runtime preflight. */
export function sharedSkillsManifestForSource(source: string, trustedRoots: readonly SharedSkillsTrustedRootV1[] = []): SharedSkillsManifestV1 | null {
  try {
    return scanSharedSkillsTree(source, false, trustedRoots);
  } catch {
    return null;
  }
}

export const ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY = SHARED_SKILLS_DIRECTORY;
export const ACCOUNT_ROUTER_SHARED_SKILLS_MANIFEST_FILE = SHARED_SKILLS_MANIFEST_FILE;

function preflightSharedSkills(stateRoot: string, codexHomes: readonly string[]): boolean {
  const manifest = readSharedSkillsManifest(stateRoot);
  if (!manifest) return false;
  const source = join(stateRoot, SHARED_SKILLS_DIRECTORY);
  if (!treeMatchesSharedSkills(source, manifest, true)) return false;
  return codexHomes.every((codexHome) => treeMatchesSharedSkills(join(codexHome, "skills"), manifest, true));
}

function readSharedSkillsManifest(stateRoot: string): SharedSkillsManifestV1 | null {
  const bytes = readOwnerPrivateRegularFile(join(stateRoot, SHARED_SKILLS_MANIFEST_FILE), 4 * 1024 * 1024, false);
  try {
    if (!bytes) return null;
    return parseSharedSkillsManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    return null;
  } finally {
    bytes?.fill(0);
  }
}

function parseSharedSkillsManifest(value: unknown): SharedSkillsManifestV1 | null {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["directories", "files", "fingerprint", "kind", "trustedRoots", "trustedRootsFingerprint", "version"].join("\0")
    || value.version !== 1 || value.kind !== "account-router-shared-skills" || !Array.isArray(value.directories)
    || !Array.isArray(value.files) || !Array.isArray(value.trustedRoots)
    || !isSharedSkillsFingerprint(value.trustedRootsFingerprint) || !isSharedSkillsFingerprint(value.fingerprint)) return null;
  const directories = value.directories.map((entry) => typeof entry === "string" && isSharedSkillsRelativePath(entry) ? entry : null);
  const files = value.files.map((entry) => {
    if (!isPlainRecord(entry) || Object.keys(entry).sort().join("\0") !== ["bytes", "path", "sha256"].join("\0")
      || typeof entry.path !== "string" || !isSharedSkillsRelativePath(entry.path)
      || typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !isSharedSkillsFingerprint(entry.sha256)) return null;
    return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 } as SharedSkillsTreeEntryV1;
  });
  const trustedRoots = value.trustedRoots.map((entry) => {
    if (!isPlainRecord(entry) || Object.keys(entry).sort().join("\0") !== ["device", "inode", "mode", "path", "uid"].join("\0")
      || typeof entry.path !== "string" || !isSharedSkillsCanonicalPath(entry.path)
      || !isSharedSkillsNonNegativeInteger(entry.device) || !isSharedSkillsNonNegativeInteger(entry.inode)
      || !isSharedSkillsNonNegativeInteger(entry.uid) || !isSharedSkillsNonNegativeInteger(entry.mode)
      || entry.mode > 0o777 || (entry.mode & 0o022) !== 0) return null;
    return { path: entry.path, device: entry.device, inode: entry.inode, uid: entry.uid, mode: entry.mode } as SharedSkillsTrustedRootV1;
  });
  if (directories.some((entry) => entry === null) || files.some((entry) => entry === null) || trustedRoots.some((entry) => entry === null)
    || directories.length > MAX_SHARED_SKILL_FILES || files.length > MAX_SHARED_SKILL_FILES || trustedRoots.length > 128) return null;
  const normalized = {
    directories: [...directories as string[]].sort(),
    files: [...files as SharedSkillsTreeEntryV1[]].sort((left, right) => left.path.localeCompare(right.path)),
    trustedRoots: [...trustedRoots as SharedSkillsTrustedRootV1[]].sort((left, right) => left.path.localeCompare(right.path)),
  };
  if (new Set(normalized.directories).size !== normalized.directories.length
    || new Set(normalized.files.map((entry) => entry.path)).size !== normalized.files.length
    || new Set(normalized.trustedRoots.map((entry) => entry.path)).size !== normalized.trustedRoots.length)
    return null;
  if (sharedSkillsFingerprint(normalized.trustedRoots) !== value.trustedRootsFingerprint
    || sharedSkillsFingerprint({ ...normalized, trustedRootsFingerprint: value.trustedRootsFingerprint }) !== value.fingerprint) return null;
  return {
    version: 1,
    kind: "account-router-shared-skills",
    ...normalized,
    trustedRootsFingerprint: value.trustedRootsFingerprint,
    fingerprint: value.fingerprint,
  };
}

function scanSharedSkillsTree(
  root: string,
  requireReadOnly: boolean,
  trustedRoots: readonly SharedSkillsTrustedRootV1[],
): SharedSkillsManifestV1 {
  const rootStat = lstatSync(root);
  assertSharedSkillsDirectory(rootStat, requireReadOnly);
  const directories: string[] = [];
  const files: SharedSkillsTreeEntryV1[] = [];
  let totalBytes = 0;
  const visit = (directory: string, relativeDirectory: string): void => {
    const names = readdirSync(directory).sort();
    for (const name of names) {
      if (!isSharedSkillsName(name)) throw new Error("unsafe shared Skills path");
      const path = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("shared Skills symlink refused");
      if (stat.isDirectory()) {
        assertSharedSkillsDirectory(stat, requireReadOnly);
        directories.push(relativePath);
        if (directories.length + files.length > MAX_SHARED_SKILL_FILES) throw new Error("shared Skills file count exceeded");
        visit(path, relativePath);
        continue;
      }
      assertSharedSkillsFile(stat, requireReadOnly);
      totalBytes += stat.size;
      if (totalBytes > MAX_SHARED_SKILL_BYTES || directories.length + files.length >= MAX_SHARED_SKILL_FILES) {
        throw new Error("shared Skills capacity exceeded");
      }
      const bytes = readSharedSkillsFile(path, stat);
      try {
        files.push({ path: relativePath, bytes: bytes.byteLength, sha256: sharedSkillsHash(bytes) });
      } finally {
        bytes.fill(0);
      }
    }
  };
  visit(root, "");
  const normalized = {
    directories: directories.sort(),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    trustedRoots: [...trustedRoots].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const trustedRootsFingerprint = sharedSkillsFingerprint(normalized.trustedRoots);
  return {
    version: 1,
    kind: "account-router-shared-skills",
    ...normalized,
    trustedRootsFingerprint,
    fingerprint: sharedSkillsFingerprint({ ...normalized, trustedRootsFingerprint }),
  };
}

function treeMatchesSharedSkills(root: string, expected: SharedSkillsManifestV1, requireReadOnly: boolean): boolean {
  try {
    const actual = scanSharedSkillsTree(root, requireReadOnly, expected.trustedRoots);
    return stableSharedSkillsJson(actual) === stableSharedSkillsJson(expected);
  } catch {
    return false;
  }
}

function copySharedSkillsTree(source: string, destination: string, manifest: SharedSkillsManifestV1): void {
  mkdirSync(destination, { mode: 0o700 });
  for (const directory of manifest.directories) mkdirSync(sharedSkillsChild(destination, directory), { mode: 0o700 });
  for (const file of manifest.files) {
    const sourcePath = sharedSkillsChild(source, file.path);
    const destinationPath = sharedSkillsChild(destination, file.path);
    const stat = lstatSync(sourcePath);
    assertSharedSkillsFile(stat, true);
    if (stat.size !== file.bytes) throw new Error("shared Skills source drift");
    const bytes = readSharedSkillsFile(sourcePath, stat);
    try {
      if (sharedSkillsHash(bytes) !== file.sha256) throw new Error("shared Skills source drift");
      writeFileSync(destinationPath, bytes, { mode: 0o400, flag: "wx" });
      chmodSync(destinationPath, 0o400);
    } finally {
      bytes.fill(0);
    }
  }
  for (const directory of [...manifest.directories].sort((left, right) => right.length - left.length)) {
    chmodSync(sharedSkillsChild(destination, directory), 0o500);
  }
  chmodSync(destination, 0o500);
  if (!treeMatchesSharedSkills(source, manifest, true) || !treeMatchesSharedSkills(destination, manifest, true)) {
    throw new Error("shared Skills copy mismatch");
  }
}

function readSharedSkillsFile(path: string, expected: { dev: number; ino: number; size: number; mtimeMs: number }): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) {
      throw new Error("shared Skills source changed");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (!count) throw new Error("shared Skills short read");
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      bytes.fill(0);
      throw new Error("shared Skills source changed");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertSharedSkillsDirectory(stat: Stats, requireReadOnly: boolean): void {
  const owner = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (owner !== undefined && stat.uid !== owner)
    || (stat.mode & 0o022) !== 0 || (requireReadOnly && (stat.mode & 0o200) !== 0)) {
    throw new Error("unsafe shared Skills directory");
  }
}

function assertSharedSkillsFile(stat: Stats, requireReadOnly: boolean): void {
  const owner = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (owner !== undefined && stat.uid !== owner)
    || (stat.mode & 0o022) !== 0 || (requireReadOnly && (stat.mode & 0o200) !== 0)) {
    throw new Error("unsafe shared Skills file");
  }
}

function assertPrivateDirectoryForSkills(path: string): void {
  const stat = lstatSync(path);
  const owner = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (owner !== undefined && stat.uid !== owner) || (stat.mode & 0o077) !== 0) {
    throw new Error("isolated account home is unsafe");
  }
}

function sharedSkillsChild(root: string, path: string): string {
  if (!isSharedSkillsRelativePath(path)) throw new Error("unsafe shared Skills path");
  const target = resolve(root, path);
  if (relative(root, target) !== path || target === root || !target.startsWith(`${root}${sep}`)) throw new Error("shared Skills path escape");
  return target;
}

function isSharedSkillsName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\0]/.test(value)
    && !isSharedSkillsCredentialFileName(value);
}

function isSharedSkillsCredentialFileName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.") || [
    "auth.json", "authorization.json", "cookies.json", "credentials.json", "oauth.json",
    "token.json", "tokens.json", "client_secret.json", ".netrc", ".npmrc",
  ].includes(normalized);
}

function isSharedSkillsRelativePath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.startsWith("/")
    && value.split("/").every(isSharedSkillsName);
}

function isSharedSkillsFingerprint(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isSharedSkillsCanonicalPath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && !value.includes("\0");
}

function isSharedSkillsNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sharedSkillsHash(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sharedSkillsFingerprint(value: unknown): `sha256:${string}` {
  return sharedSkillsHash(Buffer.from(stableSharedSkillsJson(value), "utf8"));
}

function stableSharedSkillsJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSharedSkillsJson).join(",")}]`;
  if (isPlainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSharedSkillsJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** The manager-global plugin cache is immutable; account homes only hold this exact cache link. */
export function materializeSharedPluginsIntoAccount(stateRoot: string, codexHome: string): boolean {
  try {
    const manifest = readSharedPluginsManifest(stateRoot);
    if (!manifest || !sharedPluginSourceMatches(stateRoot, manifest)) return false;
    assertPrivateDirectoryForSkills(codexHome);
    const plugins = join(codexHome, "plugins");
    if (existsSync(plugins)) return false;
    mkdirSync(plugins, { mode: 0o700 });
    symlinkSync(relative(plugins, join(stateRoot, SHARED_PLUGINS_DIRECTORY, "cache")), join(plugins, "cache"));
    return sharedPluginsHomeMatches(stateRoot, codexHome);
  } catch {
    return false;
  }
}

/** Verifies both the sealed manager source and an account's one-link projection. */
export function sharedPluginsHomeMatches(stateRoot: string, codexHome: string): boolean {
  try {
    const manifest = readSharedPluginsManifest(stateRoot);
    if (!manifest || !sharedPluginSourceMatches(stateRoot, manifest)) return false;
    const plugins = join(codexHome, "plugins");
    assertPrivateDirectoryForSkills(plugins);
    const cache = join(plugins, "cache");
    if (!lstatSync(cache).isSymbolicLink() || realpathSync.native(cache) !== realpathSync.native(join(stateRoot, SHARED_PLUGINS_DIRECTORY, "cache"))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes inherited plugin enablement and adds only the IDs bound in the
 * sealed manifest. The caller still owns the rest of the app-server command.
 */
export function sharedPluginChildArgs(stateRoot: string, args: readonly string[]): string[] | null {
  const manifest = readSharedPluginsManifest(stateRoot);
  if (!manifest || !sharedPluginSourceMatches(stateRoot, manifest)) return null;
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "-c") {
      const config = args[index + 1];
      if (typeof config !== "string") return null;
      const key = config.slice(0, config.indexOf("=")).trim();
      if (key.startsWith("plugins.")) { index += 1; continue; }
      output.push(value, config); index += 1; continue;
    }
    output.push(value);
  }
  const appServer = output.reduce<number[]>((matches, value, index) => value === "app-server" ? [...matches, index] : matches, []);
  // Test/development transport shims can be a direct executable rather than
  // an app-server command. They receive no generated plugin override; every
  // real app-server launch has exactly one explicit insertion point.
  if (appServer.length === 0) return output;
  if (appServer.length !== 1) return null;
  const generated = manifest.packages.flatMap((entry) => ["-c", `plugins.${entry.pluginId}.enabled=true`]);
  output.splice(appServer[0]!, 0, ...generated);
  return output;
}

export const ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY = SHARED_PLUGINS_DIRECTORY;
export const ACCOUNT_ROUTER_SHARED_PLUGINS_MANIFEST_FILE = SHARED_PLUGINS_MANIFEST_FILE;

/** Creates a deterministic non-secret fixture manifest before its cache is sealed read-only. */
export function sharedPluginsManifestForSource(source: string): SharedPluginsManifestV1 | null {
  try {
    const cache = join(source, "cache");
    assertSharedPluginDirectory(lstatSync(source), false);
    assertSharedPluginDirectory(lstatSync(cache), false);
    const packages: SharedPluginPackageV1[] = [];
    for (const registry of readdirSync(cache).sort()) {
      if (!isSharedPluginName(registry)) return null;
      const registryRoot = join(cache, registry); assertSharedPluginDirectory(lstatSync(registryRoot), false);
      for (const name of readdirSync(registryRoot).sort()) {
        if (!isSharedPluginName(name)) return null;
        const nameRoot = join(registryRoot, name); assertSharedPluginDirectory(lstatSync(nameRoot), false);
        for (const version of readdirSync(nameRoot).sort()) {
          if (!isSharedPluginVersion(version)) return null;
          const tree = scanSealedSharedPluginPackage(join(nameRoot, version), false);
          const excludedFiles: SharedPluginExcludedFileV1[] = [];
          packages.push({
            pluginId: `${name}@${registry}`,
            registry,
            name,
            version,
            fingerprint: sharedSkillsFingerprint(tree),
            exclusionsFingerprint: sharedSkillsFingerprint(excludedFiles),
            excludedFiles,
            fileCount: tree.files.length,
            bytes: tree.files.reduce((sum, file) => sum + file.bytes, 0),
          });
        }
      }
    }
    const normalized = packages.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    if (!normalized.length || new Set(normalized.map((entry) => entry.pluginId)).size !== normalized.length) return null;
    const inventoryFingerprint = sharedSkillsFingerprint({ version: 1, plugins: normalized.map(({ pluginId, version }) => ({ pluginId, version })) });
    const exclusionsFingerprint = sharedPluginExclusionsFingerprint(normalized);
    return {
      version: 1,
      kind: "account-router-shared-plugins",
      inventoryFingerprint,
      exclusionsFingerprint,
      packages: normalized,
      fingerprint: sharedSkillsFingerprint({ inventoryFingerprint, exclusionsFingerprint, packages: normalized }),
    };
  } catch {
    return null;
  }
}

function preflightSharedPlugins(stateRoot: string, homes: readonly string[]): boolean {
  const manifest = readSharedPluginsManifest(stateRoot);
  return manifest !== null && sharedPluginSourceMatches(stateRoot, manifest)
    && homes.every((home) => sharedPluginsHomeMatches(stateRoot, home));
}

function readSharedPluginsManifest(stateRoot: string): SharedPluginsManifestV1 | null {
  const bytes = readOwnerPrivateRegularFile(join(stateRoot, SHARED_PLUGINS_MANIFEST_FILE), 32 * 1024 * 1024, false);
  try {
    return bytes ? parseSharedPluginsManifest(JSON.parse(bytes.toString("utf8")) as unknown) : null;
  } catch {
    return null;
  } finally {
    bytes?.fill(0);
  }
}

function parseSharedPluginsManifest(value: unknown): SharedPluginsManifestV1 | null {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["exclusionsFingerprint", "fingerprint", "inventoryFingerprint", "kind", "packages", "version"].join("\0")
    || value.version !== 1 || value.kind !== "account-router-shared-plugins" || !isSharedSkillsFingerprint(value.inventoryFingerprint)
    || !isSharedSkillsFingerprint(value.exclusionsFingerprint)
    || !Array.isArray(value.packages) || !isSharedSkillsFingerprint(value.fingerprint)
    || value.packages.length === 0 || value.packages.length > 512) return null;
  const packages = value.packages.map((entry) => {
    if (!isPlainRecord(entry) || Object.keys(entry).sort().join("\0") !== ["bytes", "excludedFiles", "exclusionsFingerprint", "fileCount", "fingerprint", "name", "pluginId", "registry", "version"].join("\0")
      || typeof entry.pluginId !== "string" || !isSharedPluginId(entry.pluginId) || typeof entry.registry !== "string" || typeof entry.name !== "string"
      || entry.pluginId !== `${entry.name}@${entry.registry}` || !isSharedPluginName(entry.registry) || !isSharedPluginName(entry.name)
      || typeof entry.version !== "string" || !isSharedPluginVersion(entry.version)
      || !isSharedSkillsFingerprint(entry.fingerprint) || !isSharedSkillsFingerprint(entry.exclusionsFingerprint)
      || !Array.isArray(entry.excludedFiles) || !isSharedSkillsNonNegativeInteger(entry.fileCount) || !isSharedSkillsNonNegativeInteger(entry.bytes)) return null;
    const excludedFiles = entry.excludedFiles.map((file) => {
      if (!isPlainRecord(file) || Object.keys(file).sort().join("\0") !== ["bytes", "path", "reason", "sha256"].join("\0")
        || typeof file.path !== "string" || !isSharedSkillsNonNegativeInteger(file.bytes)
        || !isSharedSkillsFingerprint(file.sha256) || !isSharedPluginExclusionReason(file.reason)
        || !isValidSharedPluginExclusion(file as { path: string; bytes: number; sha256: `sha256:${string}`; reason: SharedPluginExclusionReasonV1 })) return null;
      return file as unknown as SharedPluginExcludedFileV1;
    });
    if (excludedFiles.some((file) => file === null)) return null;
    const normalizedExcluded = [...excludedFiles as SharedPluginExcludedFileV1[]].sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(normalizedExcluded.map((file) => file.path)).size !== normalizedExcluded.length
      || sharedSkillsFingerprint(normalizedExcluded) !== entry.exclusionsFingerprint) return null;
    return { ...entry, excludedFiles: normalizedExcluded } as unknown as SharedPluginPackageV1;
  });
  if (packages.some((entry) => entry === null)) return null;
  const normalized = [...packages as SharedPluginPackageV1[]].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  if (new Set(normalized.map((entry) => entry.pluginId)).size !== normalized.length
    || sharedPluginExclusionsFingerprint(normalized) !== value.exclusionsFingerprint
    || sharedSkillsFingerprint({ inventoryFingerprint: value.inventoryFingerprint, exclusionsFingerprint: value.exclusionsFingerprint, packages: normalized }) !== value.fingerprint) return null;
  return {
    version: 1,
    kind: "account-router-shared-plugins",
    inventoryFingerprint: value.inventoryFingerprint,
    exclusionsFingerprint: value.exclusionsFingerprint,
    packages: normalized,
    fingerprint: value.fingerprint,
  };
}

function sharedPluginSourceMatches(stateRoot: string, manifest: SharedPluginsManifestV1): boolean {
  try {
    const root = join(stateRoot, SHARED_PLUGINS_DIRECTORY);
    const cache = join(root, "cache");
    assertSharedPluginDirectory(lstatSync(root), true);
    assertSharedPluginDirectory(lstatSync(cache), true);
    const registries = new Map<string, Map<string, SharedPluginPackageV1>>();
    for (const entry of manifest.packages) {
      const names = registries.get(entry.registry) ?? new Map<string, SharedPluginPackageV1>();
      if (names.has(entry.name)) return false;
      names.set(entry.name, entry); registries.set(entry.registry, names);
    }
    if (!sameNames(readdirSync(cache), [...registries.keys()])) return false;
    const packages: SharedPluginPackageV1[] = [];
    for (const [registry, names] of registries) {
      const registryRoot = join(cache, registry); assertSharedPluginDirectory(lstatSync(registryRoot), true);
      if (!sameNames(readdirSync(registryRoot), [...names.keys()])) return false;
      for (const [name, expected] of names) {
        const nameRoot = join(registryRoot, name); assertSharedPluginDirectory(lstatSync(nameRoot), true);
        if (!sameNames(readdirSync(nameRoot), [expected.version])) return false;
        const tree = scanSealedSharedPluginPackage(join(nameRoot, expected.version));
        const actual = { ...expected, fingerprint: sharedSkillsFingerprint(tree), fileCount: tree.files.length, bytes: tree.files.reduce((sum, file) => sum + file.bytes, 0) };
        if (actual.fingerprint !== expected.fingerprint || actual.fileCount !== expected.fileCount || actual.bytes !== expected.bytes) return false;
        packages.push(actual);
      }
    }
    const normalized = packages.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    return sharedSkillsFingerprint({ inventoryFingerprint: manifest.inventoryFingerprint, exclusionsFingerprint: manifest.exclusionsFingerprint, packages: normalized }) === manifest.fingerprint;
  } catch {
    return false;
  }
}

function scanSealedSharedPluginPackage(root: string, requireReadOnly = true): { directories: string[]; files: SharedSkillsTreeEntryV1[] } {
  assertSharedPluginDirectory(lstatSync(root), requireReadOnly);
  const directories: string[] = []; const files: SharedSkillsTreeEntryV1[] = []; let totalBytes = 0;
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (!isSharedPluginName(name)) throw new Error("unsafe shared plugin path");
      const path = join(directory, name); const relativePath = prefix ? `${prefix}/${name}` : name; const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (isSharedPluginCredentialDirectoryName(name)) throw new Error("credential-shaped shared plugin directory");
        assertSharedPluginDirectory(stat, requireReadOnly); directories.push(relativePath); if (directories.length + files.length > MAX_SHARED_PLUGIN_FILES) throw new Error("shared plugin capacity"); visit(path, relativePath); continue;
      }
      assertSharedPluginFile(stat, requireReadOnly); totalBytes += stat.size;
      if (totalBytes > MAX_SHARED_PLUGIN_BYTES || directories.length + files.length >= MAX_SHARED_PLUGIN_FILES) throw new Error("shared plugin capacity");
      if (name !== "config.toml" && isSharedPluginCredentialName(name)) throw new Error("credential-shaped shared plugin file");
      const bytes = readSharedSkillsFile(path, stat);
      try {
        if (name === "config.toml" && !isApprovedSharedPluginConfig(relativePath, bytes)) throw new Error("unapproved shared plugin config");
        files.push({ path: relativePath, bytes: bytes.byteLength, sha256: sharedSkillsHash(bytes) });
      } finally { bytes.fill(0); }
    }
  };
  visit(root, "");
  return { directories: directories.sort(), files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && [...actual].sort().every((entry, index) => entry === [...expected].sort()[index]);
}

function isSharedPluginId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

function isSharedPluginName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

function isSharedPluginVersion(value: string): boolean { return isSharedPluginName(value); }

// Keep this exact protected-container policy in parity with migration. Names
// that merely contain credential, secret, or cookie are ordinary package data.
function isSharedPluginCredentialName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.")
    || ["env", "env_vars", "auth", "auth.json", "authorization.json", "cookies", "cookies.json", "credentials", "credentials.json", "oauth", "oauth.json", "token", "token.json", "tokens", "tokens.json", "secret.json", "secrets.json", "client_secret.json", "api-key.json", "api_key.json", ".netrc", "config.toml"].includes(normalized)
    || normalized.endsWith(".sqlite");
}

function isSharedPluginCredentialDirectoryName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.")
    || ["env", "env_vars", "credentials", "secrets", "auth.json", "authorization.json", "cookies.json", "credentials.json", "oauth.json", "token.json", "tokens.json", "secret.json", "secrets.json", "client_secret.json", "api-key.json", "api_key.json", ".netrc", "config.toml"].includes(normalized)
    || normalized.endsWith(".sqlite");
}

function isApprovedSharedPluginConfig(relativePath: string, bytes: Buffer): boolean {
  const components = relativePath.split("/");
  if (components.length < 2 || components.at(-1) !== "config.toml" || components.at(-2) !== ".codex") return false;
  const value = bytes.toString("utf8");
  return value === "[features]\nhooks = true\n" || value === "[features]\nhooks = false\n";
}

function isSharedPluginExcludedPath(value: string): boolean {
  const components = value.split("/");
  return components.length > 0 && components.every(isSharedPluginName)
    && components.at(-1) !== "config.toml" && isSharedPluginCredentialName(components.at(-1)!);
}

function isExactSharedPluginTransientLock(value: string): boolean { return value === ".venv/.lock"; }

function isSharedPluginExclusionReason(value: unknown): value is SharedPluginExclusionReasonV1 {
  return value === "credential" || value === "transient-lock";
}

function isValidSharedPluginExclusion(value: SharedPluginExcludedFileV1): boolean {
  return value.reason === "credential" ? isSharedPluginExcludedPath(value.path)
    : isExactSharedPluginTransientLock(value.path) && value.bytes === 0 && value.sha256 === EMPTY_SHARED_PLUGIN_HASH;
}

function sharedPluginExclusionsFingerprint(packages: readonly SharedPluginPackageV1[]): `sha256:${string}` {
  const exclusions = packages.flatMap((entry) => entry.excludedFiles.map((file) => ({ pluginId: entry.pluginId, ...file })))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId) || left.path.localeCompare(right.path));
  return sharedSkillsFingerprint(exclusions);
}

function assertSharedPluginDirectory(stat: Stats, requireReadOnly: boolean): void {
  const owner = process.getuid?.();
  const mode = stat.mode & 0o7777;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (owner !== undefined && stat.uid !== owner)
    || (stat.mode & 0o022) !== 0 || (requireReadOnly && mode !== 0o500)) throw new Error("unsafe shared plugin directory");
}

function assertSharedPluginFile(stat: Stats, requireReadOnly: boolean): void {
  const owner = process.getuid?.();
  const mode = stat.mode & 0o7777;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (owner !== undefined && stat.uid !== owner)
    || (!requireReadOnly && ((mode & 0o002) !== 0 || (mode & 0o6000) !== 0))
    || (requireReadOnly && mode !== 0o400)) throw new Error("unsafe shared plugin file");
}

/**
 * Stage-time hardening is rechecked immediately before the parent chooses the
 * mux. No source auth, symlink, custom config, or post-stage swap is trusted.
 */
function validateIsolatedAccountHome(account: OpaqueAccountId, stateRoot: string, secret: Buffer): boolean {
  const codexHome = join(stateRoot, "accounts", account, "codex-home");
  const authBytes = readOwnerPrivateRegularFile(join(codexHome, "auth.json"), MAX_AUTH_BYTES, false);
  const configBytes = readOwnerPrivateRegularFile(join(codexHome, "config.toml"), MAX_CHILD_CONFIG_BYTES, true);
  try {
    if (!authBytes || !configBytes || configBytes.byteLength !== 0) return false;
    const parsed = JSON.parse(authBytes.toString("utf8")) as unknown;
    const rawAccountId = authAccountId(parsed);
    if (!rawAccountId) return false;
    const expected = `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}`;
    return expected.length === account.length
      && timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(account, "utf8"));
  } catch {
    return false;
  } finally {
    authBytes?.fill(0);
    configBytes?.fill(0);
  }
}

/**
 * Owner-private enrollment helper only. It uses the same no-follow, bounded
 * auth parser as startup preflight and clears the byte buffer before return.
 * The returned provider account id must remain inside the broker host.
 */
export function readOwnerPrivateAuthAccountId(codexHome: string): string | null {
  const authBytes = readOwnerPrivateRegularFile(join(codexHome, "auth.json"), MAX_AUTH_BYTES, false);
  try {
    if (!authBytes) return null;
    return authAccountId(JSON.parse(authBytes.toString("utf8")) as unknown);
  } catch {
    return null;
  } finally {
    authBytes?.fill(0);
  }
}

/** Read a bounded, owner-private, single-link regular file without following symlinks. */
function readOwnerPrivateRegularFile(path: string, maxBytes: number, allowEmpty: boolean): Buffer | null {
  let descriptor: number | undefined;
  let bytes: Buffer | null = null;
  let succeeded = false;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || (before.mode & 0o077) !== 0 || before.size > maxBytes || (!allowEmpty && before.size <= 0)) return null;
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (!count) return null;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    succeeded = true;
    return bytes;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    // Ownership transfers only after every validation succeeds. Callers clear
    // the returned byte buffer promptly; failed reads never retain auth data.
    if (bytes && !succeeded) bytes.fill(0);
  }
}

function authAccountId(value: unknown): string | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.tokens)) return null;
  const accountId = value.tokens.account_id;
  return typeof accountId === "string" && accountId.length > 0 && accountId.length <= 1_024 ? accountId : null;
}

/** A staged disable or uncertain dispatch is never reopened by a restart. */
function stateAllowsBalancedStartup(config: RouterConfigV2 | RouterConfigV3, stateRoot: string): RouterState | null {
  const stateFile = join(stateRoot, "router-state.json");
  // A receipt proves a particular imported owner subset. A missing state
  // cannot prove that subset, so v2 falls back before any child process exists.
  if (!existsSync(stateFile)) return null;
  try {
    assertPrivateRegularFile(stateFile, 2 * 1024 * 1024);
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as unknown;
    // The store constructor is intentionally strict about configured accounts
    // and ledger weights. Check the entire candidate here so the signed parent
    // retains its direct app-server fallback instead of selecting a mux that
    // will fail moments later on a v1-to-v2 (or pair/order/weight) mismatch.
    const accepted = validateRouterState(state, config) ? state : migrateIdleRouterStateV3(state, config);
    if (!accepted) return null;
    return accepted.stagedDisable === null
      && accepted.correlations.length === 0
      && Object.keys(accepted.pendingThreadOwners).length === 0
      // A persisted reservation is ambiguous after a process crash: without
      // an atomic reservation-to-thread recovery proof, start direct/manual.
      && accepted.reservations.every((reservation) => reservation.state !== "reserved" && reservation.state !== "stranded_ambiguous")
      ? accepted
      : null;
  } catch {
    return null;
  }
}

function readControlSecret(stateRoot: string): Buffer | null {
  const path = join(stateRoot, "control-secret.v1");
  try {
    if (!existsSync(path)) return null;
    assertPrivateRegularFile(path, 512);
    const secret = Buffer.from(readFileSync(path));
    return secret.byteLength === 32 ? secret : null;
  } catch {
    return null;
  }
}

class ProcessRouterChildFactory implements RouterChildFactory {
  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly stateRoot: string,
    private readonly sharedSqliteHome: string | null,
  ) {}

  create(account: OpaqueAccountId, handlers: { onMessage(message: JsonRpcMessage): void; onFailure(): void }): RouterChild {
    const accountRoot = join(this.stateRoot, "accounts", account);
    const codexHome = join(accountRoot, "codex-home");
    const sqliteHome = routerChildSqliteHome(accountRoot, this.sharedSqliteHome);
    const child = spawn(this.command, [...this.args], {
      cwd: process.cwd(),
      env: sanitizedChildEnvironment(codexHome, sqliteHome),
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (!child.stdin || !child.stdout) throw new Error("account-router child lacks JSONL stdio");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = parseJsonRpcLine(line);
      if (message) handlers.onMessage(message);
      else handlers.onFailure();
    });
    child.once("error", () => handlers.onFailure());
    child.once("exit", () => handlers.onFailure());
    const initializeTimeout = setTimeout(() => handlers.onFailure(), CHILD_INITIALIZE_TIMEOUT_MS);
    initializeTimeout.unref();
    return new ProcessRouterChild(account, child, () => clearTimeout(initializeTimeout));
  }
}

class ProcessRouterChild implements RouterChild {
  constructor(
    readonly opaqueAccountId: OpaqueAccountId,
    private readonly child: ChildProcess,
    private readonly clearInitializeTimeout: () => void,
  ) {}

  send(message: JsonRpcMessage): void {
    if (!this.child.stdin || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("account-router child is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  terminate(signal: NodeJS.Signals): void {
    this.clearInitializeTimeout();
    this.child.kill(signal);
    const force = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, GRACEFUL_SHUTDOWN_MS);
    force.unref();
  }

  markInitialized(): void {
    this.clearInitializeTimeout();
  }
}

export function sanitizedChildEnvironment(codexHome: string, sqliteHome: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The child receives only operating-system launch values. In particular, no
  // arbitrary parent env, headers, OAuth state, or provider token is copied
  // into an account home through process inheritance.
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  if (source.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED === "1") {
    environment.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  }
  return { ...environment, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome };
}

export function routerChildSqliteHome(accountRoot: string, sharedSqliteHome: string | null): string {
  return sharedSqliteHome ?? join(accountRoot, "sqlite-home");
}

function parseArguments(argv: string[]): MuxCliArguments | null {
  const separator = argv.indexOf("--");
  if (separator < 0) return null;
  const flags = argv.slice(0, separator);
  const command = argv[separator + 1];
  const args = argv.slice(separator + 2);
  const configPath = flagValue(flags, "--config");
  const stateRoot = flagValue(flags, "--state-root");
  const sharedSqliteHomeValue = flagValue(flags, "--shared-sqlite-home");
  const sharedSqliteHome = sharedSqliteHomeValue && isAbsolute(sharedSqliteHomeValue)
    && resolve(sharedSqliteHomeValue) === sharedSqliteHomeValue
    ? sharedSqliteHomeValue
    : null;
  if (!configPath || !stateRoot || !command || (sharedSqliteHomeValue && !sharedSqliteHome)) return null;
  return { configPath, stateRoot, sharedSqliteHome, command, args };
}

function flagValue(flags: string[], name: string): string | null {
  const index = flags.indexOf(name);
  return index >= 0 && typeof flags[index + 1] === "string" ? flags[index + 1] : null;
}

export function defaultMuxPaths(userRoot = process.env.TWEAKERS_USER_ROOT ?? process.env.TWEAKER_USER_ROOT): { configPath: string; stateRoot: string } | null {
  const configPath = defaultAccountRouterConfigPath(userRoot);
  return configPath ? { configPath, stateRoot: dirname(configPath) } : null;
}

if (require.main === module) {
  void runAccountRouterMuxCli().catch(() => { process.exitCode = 1; });
}
