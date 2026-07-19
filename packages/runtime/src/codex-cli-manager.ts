import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CodexCliLane,
  CodexFeatureStage,
  CodexInstallPhase,
  CodexInstallProgress,
  ParsedCodexFeature,
} from "./codex-version-types";

export type { CodexCliLane, CodexInstallPhase, CodexInstallProgress } from "./codex-version-types";

export interface CodexCliRelease {
  version: string;
  tag: string;
  assetName: string;
  assetUrl: string;
  digest: string;
  architecture: string;
}

export interface ManagedCodexCliReceipt {
  schemaVersion: 1;
  version: string;
  releaseTag: string;
  digest: string;
  binaryDigest: string;
  architecture: string;
  relativeDirectory: string;
  binaryRelativePath: string;
  verifiedAt: string;
}

export interface ManagedCodexCliState {
  schemaVersion: 1;
  current: ManagedCodexCliReceipt | null;
  previous: ManagedCodexCliReceipt | null;
  updatedAt: string;
}

export interface CodexCliPaths {
  root: string;
  releases: string;
  staging: string;
  state: string;
  lock: string;
}

export interface ArchiveEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "hardlink" | "device" | "fifo" | string;
  linkPath?: string;
}

export interface CodexCliManagerDependencies {
  now(): Date;
  operationId(): string;
  resolveRelease(): Promise<CodexCliRelease>;
  download(release: CodexCliRelease, destination: string, onBytes?: (bytes: number) => void): Promise<{ bytes: number; digest: string }>;
  listArchive(archive: string): Promise<ArchiveEntry[]>;
  extractArchive(archive: string, destination: string): Promise<void>;
  verifySignature(binary: string): Promise<boolean>;
  probeVersion(binary: string): Promise<string>;
  probeArchitecture(binary: string): Promise<string>;
  onCrashPoint?(point: "before-release-rename" | "after-release-rename" | "before-state-write" | "after-state-write"): void;
}

export interface CodexCliManager {
  installBeta(): Promise<ManagedCodexCliState>;
  rollbackBeta(): Promise<ManagedCodexCliState>;
  recover(): ManagedCodexCliState;
  getState(): ManagedCodexCliState;
  getProgress(): CodexInstallProgress;
  getSelectedBinary(): string | null;
  validateCurrent(): Promise<{ valid: boolean; binary: string | null; error?: string }>;
  listManagedVersions(): string[];
  listStagingOperations(): string[];
}

const EMPTY_STATE: ManagedCodexCliState = { schemaVersion: 1, current: null, previous: null, updatedAt: "" };
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const RECEIPT_FILE = "receipt.json";
const ALLOWED_ASSET = "codex-package-aarch64-apple-darwin.tar.gz";

export function deriveCodexCliPaths(home: string, activeUserRoot?: string): CodexCliPaths {
  const root = join(activeUserRoot ?? join(resolve(home), "Library", "Application Support", "Tweakers"), "codex-cli");
  return { root, releases: join(root, "releases"), staging: join(root, "staging"), state: join(root, "state.json"), lock: join(root, "operation.lock") };
}

export function validateArchiveEntries(entries: ArchiveEntry[]): void {
  if (entries.length === 0) throw new Error("Unsafe archive: no entries");
  for (const entry of entries) {
    const normalized = entry.path.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (!normalized || normalized.includes("\0") || isAbsolute(normalized) || segments.includes("..")) {
      throw new Error("Unsafe archive path");
    }
    if (!(["file", "directory"] as string[]).includes(entry.type)) throw new Error("Unsafe archive entry type");
    if (entry.linkPath) throw new Error("Unsafe archive link");
  }
}

export function createCodexCliManager(input: { home: string; userRoot?: string; deps: CodexCliManagerDependencies }): CodexCliManager {
  const paths = deriveCodexCliPaths(input.home, input.userRoot);
  const deps = input.deps;
  let busy = false;
  let state = readState(paths.state);
  let progress: CodexInstallProgress = emptyProgress();
  ensureDirectories(paths);

  const manager: CodexCliManager = {
    async installBeta() {
      return runExclusive("install", async (operationId) => {
        const operationDir = safeChild(paths.staging, operationId);
        const archive = join(operationDir, "download.tar.gz");
        const extracted = join(operationDir, "extracted");
        mkdirSync(operationDir, { recursive: false, mode: 0o700 });
        try {
          setProgress("resolving");
          const release = await deps.resolveRelease();
          validateRelease(release);
          progress.version = release.version;
          setProgress("downloading");
          const downloaded = await deps.download(release, archive, (bytes) => {
            if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_DOWNLOAD_BYTES) throw new Error("Download exceeds maximum size");
            progress.bytes = bytes;
          });
          progress.bytes = downloaded.bytes;
          if (downloaded.bytes < 1 || downloaded.bytes > MAX_DOWNLOAD_BYTES) throw new Error("Download length is invalid or exceeds maximum size");
          setProgress("verifying-digest");
          if (downloaded.digest.toLowerCase() !== release.digest.toLowerCase()) throw new Error("Digest verification failed");
          const entries = await deps.listArchive(archive);
          validateArchiveEntries(entries);
          setProgress("extracting");
          mkdirSync(extracted, { recursive: false, mode: 0o700 });
          await deps.extractArchive(archive, extracted);
          const binary = locateBinary(extracted);
          chmodSync(binary, 0o755);
          setProgress("verifying-signature");
          if (!(await deps.verifySignature(binary))) throw new Error("Signature verification failed");
          setProgress("probing");
          const [version, architecture] = await Promise.all([deps.probeVersion(binary), deps.probeArchitecture(binary)]);
          if (normalizeVersion(version) !== release.version) throw new Error(`Version validation failed (expected ${release.version})`);
          if (architecture !== release.architecture) throw new Error(`Architecture validation failed (expected ${release.architecture})`);

          const baseDirectoryName = `${release.version}-${release.architecture}`;
          // A reinstall must not replace a directory referenced by the durable
          // state. Promote into a unique sibling and commit by atomically
          // swapping the state pointer; pruning happens only after that commit.
          const directoryName = existsSync(safeChild(paths.releases, baseDirectoryName))
            ? `${baseDirectoryName}-incoming-${safeOperationId(operationId)}`
            : baseDirectoryName;
          const releaseDir = safeChild(paths.releases, directoryName);
          const binaryRelativePath = relative(extracted, binary);
          const receipt: ManagedCodexCliReceipt = {
            schemaVersion: 1,
            version: release.version,
            releaseTag: release.tag,
            digest: release.digest.toLowerCase(),
            binaryDigest: createHash("sha256").update(readFileSync(binary)).digest("hex"),
            architecture: release.architecture,
            relativeDirectory: directoryName,
            binaryRelativePath,
            verifiedAt: deps.now().toISOString(),
          };
          atomicJsonWrite(join(extracted, RECEIPT_FILE), receipt);
          syncTreeCritical(extracted, [binaryRelativePath, RECEIPT_FILE]);
          setProgress("promoting");
          if (existsSync(releaseDir)) throw new Error("Unique incoming release directory already exists");
          deps.onCrashPoint?.("before-release-rename");
          renameSync(extracted, releaseDir);
          fsyncDirectory(paths.releases);
          deps.onCrashPoint?.("after-release-rename");
          const next: ManagedCodexCliState = { schemaVersion: 1, current: receipt, previous: state.current, updatedAt: deps.now().toISOString() };
          deps.onCrashPoint?.("before-state-write");
          atomicJsonWrite(paths.state, next);
          state = next;
          deps.onCrashPoint?.("after-state-write");
          pruneUnreferencedReleases(paths, state);
          return clone(state);
        } finally {
          rmSync(operationDir, { recursive: true, force: true });
        }
      });
    },

    async rollbackBeta() {
      return runExclusive("rollback", async () => {
        setProgress("rolling-back");
        const previous = state.previous;
        if (!previous) throw new Error("No previous managed Beta is available");
        const validation = await validateReceiptAsync(paths, previous, deps);
        if (!validation.valid) throw new Error(validation.error ?? "Previous managed Beta is invalid");
        const next: ManagedCodexCliState = { schemaVersion: 1, current: previous, previous: state.current, updatedAt: deps.now().toISOString() };
        atomicJsonWrite(paths.state, next);
        state = next;
        return clone(state);
      });
    },

    recover() {
      ensureDirectories(paths);
      removeDirectoryChildrenWithoutFollowing(paths.staging);
      // Operations are in-process and bounded. Clear an abandoned lock only
      // after staging cleanup; never steal one owned by another live process.
      if (!lockBelongsToLiveOtherProcess(paths.lock)) rmSync(paths.lock, { force: true });
      state = readState(paths.state);
      state = reconcileStateSync(paths, state);
      atomicJsonWrite(paths.state, state);
      pruneUnreferencedReleases(paths, state);
      return clone(state);
    },

    getState: () => clone(state),
    getProgress: () => clone(progress),
    getSelectedBinary: () => state.current ? binaryForReceipt(paths, state.current) : null,
    async validateCurrent() {
      if (!state.current) return { valid: false, binary: null, error: "No managed Beta is installed" };
      const result = await validateReceiptAsync(paths, state.current, deps);
      return { ...result, binary: result.valid ? binaryForReceipt(paths, state.current) : null };
    },
    listManagedVersions: () => safeDirectoryNames(paths.releases).map((name) => readReceipt(join(paths.releases, name))?.version).filter((value): value is string => Boolean(value)),
    listStagingOperations: () => safeDirectoryNames(paths.staging),
  };

  function setProgress(phase: CodexInstallPhase): void { progress.phase = phase; }

  async function runExclusive(kind: "install" | "rollback", fn: (operationId: string) => Promise<ManagedCodexCliState>): Promise<ManagedCodexCliState> {
    if (busy) throw new Error("A Codex CLI operation is already in progress");
    busy = true;
    const operationId = deps.operationId();
    progress = { operationId, phase: kind === "install" ? "resolving" : "rolling-back", bytes: 0, version: null, error: null, startedAt: deps.now().toISOString(), completedAt: null };
    let lockFd: number | null = null;
    let ownsLock = false;
    try {
      try {
        lockFd = openSync(paths.lock, "wx", 0o600);
        ownsLock = true;
        writeFileSync(lockFd, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, operationId, kind, startedAt: progress.startedAt })}\n`);
        fsyncSync(lockFd);
      } catch (error) {
        if (lockFd !== null) closeSync(lockFd);
        lockFd = null;
        throw existsSync(paths.lock) ? new Error("A Codex CLI operation is already in progress") : error;
      }
      const result = await fn(operationId);
      progress.phase = "complete";
      progress.completedAt = deps.now().toISOString();
      return result;
    } catch (error) {
      progress.phase = "failed";
      progress.error = safeError(error);
      progress.completedAt = deps.now().toISOString();
      throw new Error(progress.error);
    } finally {
      if (lockFd !== null) closeSync(lockFd);
      if (ownsLock) rmSync(paths.lock, { force: true });
      busy = false;
    }
  }

  return manager;
}

export interface BootstrapLaneResult {
  requestedLane: CodexCliLane | null;
  effectiveLane: CodexCliLane;
  binary: string | null;
  userOverridePreserved: boolean;
  fallback: boolean;
  error: string | null;
}

export interface SelectedManagedCodexCli {
  binaryPath: string;
  version: string;
  fingerprint: string;
}

export function applyManagedCodexCliLaneAtBootstrap(input: {
  lane?: CodexCliLane | null;
  home: string;
  userRoot?: string;
  env?: NodeJS.ProcessEnv;
  selectedManagedCli?: SelectedManagedCodexCli | null;
  validateSelectedManagedBinary?: (selected: SelectedManagedCodexCli) => { valid: boolean; error?: string };
  validateManagedBinary?: (binary: string, receipt: ManagedCodexCliReceipt) => { valid: boolean; error?: string };
  persistFailure?: (safeMessage: string) => void;
}): BootstrapLaneResult {
  const env = input.env ?? process.env;
  if (input.lane == null) {
    const hasOverride = Boolean(env.CODEX_CLI_PATH);
    return { requestedLane: null, effectiveLane: hasOverride ? "beta" : "bundled", binary: hasOverride ? env.CODEX_CLI_PATH! : null, userOverridePreserved: hasOverride, fallback: false, error: null };
  }
  if (input.lane === "bundled") {
    delete env.CODEX_CLI_PATH;
    return { requestedLane: "bundled", effectiveLane: "bundled", binary: null, userOverridePreserved: false, fallback: false, error: null };
  }
  if (input.selectedManagedCli) {
    const selected = input.selectedManagedCli;
    const validation = (input.validateSelectedManagedBinary ?? validateSelectedManagedBinarySync)(selected);
    if (validation.valid) {
      env.CODEX_CLI_PATH = selected.binaryPath;
      return {
        requestedLane: "beta",
        effectiveLane: "beta",
        binary: selected.binaryPath,
        userOverridePreserved: false,
        fallback: false,
        error: null,
      };
    }
    delete env.CODEX_CLI_PATH;
    const error = safeError(validation.error ?? "Selected managed Alpha validation failed");
    input.persistFailure?.(error);
    return {
      requestedLane: "beta",
      effectiveLane: "bundled",
      binary: null,
      userOverridePreserved: false,
      fallback: true,
      error,
    };
  }
  const paths = deriveCodexCliPaths(input.home, input.userRoot);
  const state = readState(paths.state);
  const receipt = state.current;
  const binary = receipt ? binaryForReceipt(paths, receipt) : "";
  const validation = receipt
    ? (input.validateManagedBinary ?? ((candidate, current) => validateManagedBinarySync(paths, candidate, current)))(binary, receipt)
    : { valid: false, error: "No managed Beta is installed" };
  if (validation.valid) {
    env.CODEX_CLI_PATH = binary;
    return { requestedLane: "beta", effectiveLane: "beta", binary, userOverridePreserved: false, fallback: false, error: null };
  }
  delete env.CODEX_CLI_PATH;
  const error = safeError(validation.error ?? "Managed Beta validation failed");
  input.persistFailure?.(error);
  return { requestedLane: "beta", effectiveLane: "bundled", binary: null, userOverridePreserved: false, fallback: true, error };
}

function validateSelectedManagedBinarySync(
  selected: SelectedManagedCodexCli,
): { valid: boolean; error?: string } {
  try {
    if (!isAbsolute(selected.binaryPath) || resolve(selected.binaryPath) !== selected.binaryPath) {
      throw new Error("Selected managed Alpha path is not exact and absolute");
    }
    if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(selected.version)) {
      throw new Error("Selected managed Alpha version is invalid");
    }
    if (!/^[a-f0-9]{64}$/i.test(selected.fingerprint)) {
      throw new Error("Selected managed Alpha fingerprint is invalid");
    }
    const info = lstatSync(selected.binaryPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
      throw new Error("Selected managed Alpha binary is not a regular executable file");
    }
    const actualFingerprint = createHash("sha256").update(readFileSync(selected.binaryPath)).digest("hex");
    if (actualFingerprint !== selected.fingerprint.toLowerCase()) {
      throw new Error("Selected managed Alpha fingerprint does not match");
    }
    if (process.platform === "darwin") {
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", selected.binaryPath], {
        stdio: "pipe",
        timeout: 5_000,
      });
      execFileSync("/usr/bin/codesign", [
        "-R=identifier \"codex\" and anchor apple generic and certificate leaf[subject.OU] = \"2DC432GLL2\"",
        "--verify",
        selected.binaryPath,
      ], { stdio: "pipe", timeout: 5_000 });
      const architecture = execFileSync("/usr/bin/file", ["-b", selected.binaryPath], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (!/arm64|aarch64/i.test(architecture)) throw new Error("Selected managed Alpha architecture is invalid");
    }
    const version = execFileSync(selected.binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (normalizeVersion(version) !== selected.version) {
      throw new Error("Selected managed Alpha version does not match");
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: safeError(error) };
  }
}

export interface CodexFeatureInventoryEntry extends ParsedCodexFeature { stage: CodexFeatureStage }
export interface CodexFeatureMutationDependencies {
  inventory(lane: CodexCliLane): Promise<CodexFeatureInventoryEntry[]>;
  binaryPath?(lane: CodexCliLane): string;
  execFile(binary: string, args: string[], options: { timeout: number; shell: false }): Promise<void>;
}

export async function mutateCodexFeature(input: { lane: CodexCliLane; name: string; enabled: boolean }, deps: CodexFeatureMutationDependencies): Promise<CodexFeatureInventoryEntry[]> {
  if ((input.lane !== "bundled" && input.lane !== "beta") || typeof input.enabled !== "boolean" || !/^[A-Za-z0-9_-]+$/.test(input.name)) throw new Error("Invalid feature mutation request");
  const before = await deps.inventory(input.lane);
  const feature = before.find((entry) => entry.name === input.name);
  if (!feature) throw new Error("Feature is not reported by the selected CLI");
  if (feature.stage === "deprecated" || feature.stage === "removed") throw new Error("Feature is read-only in the selected CLI");
  await deps.execFile(deps.binaryPath?.(input.lane) ?? input.lane, ["features", input.enabled ? "enable" : "disable", input.name], { timeout: 5_000, shell: false });
  return deps.inventory(input.lane);
}

function ensureDirectories(paths: CodexCliPaths): void {
  mkdirSync(paths.releases, { recursive: true, mode: 0o700 });
  mkdirSync(paths.staging, { recursive: true, mode: 0o700 });
}

function validateRelease(release: CodexCliRelease): void {
  if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(release.version)) throw new Error("Resolved release is not an alpha prerelease");
  if (release.tag !== `rust-v${release.version}`) throw new Error("Release tag does not match version");
  if (release.assetName !== ALLOWED_ASSET || !release.assetUrl.startsWith("https://github.com/openai/codex/releases/")) throw new Error("Release asset is not allowlisted");
  if (!/^[a-fA-F0-9]{64}$/.test(release.digest)) throw new Error("Release digest is not SHA-256");
  if (release.architecture !== "aarch64-apple-darwin") throw new Error("Release architecture is not allowlisted");
}

function locateBinary(root: string): string {
  const matches: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Extracted package contains an unsafe link");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "codex") matches.push(path);
    }
  };
  visit(root);
  if (matches.length !== 1) throw new Error("Extracted package must contain exactly one codex binary");
  return matches[0];
}

async function validateReceiptAsync(paths: CodexCliPaths, receipt: ManagedCodexCliReceipt, deps: CodexCliManagerDependencies): Promise<{ valid: boolean; error?: string }> {
  try {
    const binary = binaryForReceipt(paths, receipt);
    validateReceiptFiles(paths, receipt, binary);
    if (!(await deps.verifySignature(binary))) throw new Error("Signature verification failed");
    const [version, architecture] = await Promise.all([deps.probeVersion(binary), deps.probeArchitecture(binary)]);
    if (normalizeVersion(version) !== receipt.version) throw new Error("Version validation failed");
    if (architecture !== receipt.architecture) throw new Error("Architecture validation failed");
    return { valid: true };
  } catch (error) { return { valid: false, error: safeError(error) }; }
}

function validateManagedBinarySync(paths: CodexCliPaths, binary: string, receipt: ManagedCodexCliReceipt): { valid: boolean; error?: string } {
  try {
    validateReceiptFiles(paths, receipt, binary);
    if (process.platform === "darwin") {
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", binary], { stdio: "pipe", timeout: 5_000 });
      execFileSync("/usr/bin/codesign", ["-R=identifier \"codex\" and anchor apple generic and certificate leaf[subject.OU] = \"2DC432GLL2\"", "--verify", binary], { stdio: "pipe", timeout: 5_000 });
      const architecture = execFileSync("/usr/bin/file", ["-b", binary], { encoding: "utf8", timeout: 5_000 });
      if (!/arm64|aarch64/i.test(architecture)) throw new Error("Architecture validation failed");
    }
    const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
    if (normalizeVersion(version) !== receipt.version) throw new Error("Version validation failed");
    return { valid: true };
  } catch (error) { return { valid: false, error: safeError(error) }; }
}

function validateReceiptFiles(paths: CodexCliPaths, receipt: ManagedCodexCliReceipt, binary: string): void {
  if (!validReceipt(receipt)) throw new Error("Managed Beta receipt is invalid");
  const releaseDir = safeChild(paths.releases, receipt.relativeDirectory);
  if (!isContained(releaseDir, binary)) throw new Error("Managed Beta binary escapes its release directory");
  const diskReceipt = readReceipt(releaseDir);
    if (!diskReceipt
      || diskReceipt.version !== receipt.version
      || diskReceipt.digest !== receipt.digest
      || diskReceipt.binaryDigest !== receipt.binaryDigest
      || diskReceipt.relativeDirectory !== receipt.relativeDirectory
      || diskReceipt.binaryRelativePath !== receipt.binaryRelativePath) {
      throw new Error("Managed Beta receipt or digest does not agree with state");
    }
  const info = lstatSync(binary);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) throw new Error("Managed Beta binary is not a regular executable file");
  const binaryDigest = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (binaryDigest !== receipt.binaryDigest) throw new Error("Managed Beta binary digest does not agree with its receipt");
}

function reconcileStateSync(paths: CodexCliPaths, value: ManagedCodexCliState): ManagedCodexCliState {
  const valid = (receipt: ManagedCodexCliReceipt | null): receipt is ManagedCodexCliReceipt => {
    if (!receipt) return false;
    try { validateReceiptFiles(paths, receipt, binaryForReceipt(paths, receipt)); return true; } catch { return false; }
  };
  const current = valid(value.current) ? value.current : null;
  const previous = valid(value.previous) && value.previous.relativeDirectory !== current?.relativeDirectory ? value.previous : null;
  return { schemaVersion: 1, current, previous, updatedAt: value.updatedAt };
}

function readState(path: string): ManagedCodexCliState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ManagedCodexCliState;
    if (parsed.schemaVersion !== 1) return clone(EMPTY_STATE);
    return { schemaVersion: 1, current: validReceipt(parsed.current) ? parsed.current : null, previous: validReceipt(parsed.previous) ? parsed.previous : null, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "" };
  } catch { return clone(EMPTY_STATE); }
}

function readReceipt(directory: string): ManagedCodexCliReceipt | null {
  try {
    const info = lstatSync(join(directory, RECEIPT_FILE));
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const value = JSON.parse(readFileSync(join(directory, RECEIPT_FILE), "utf8"));
    return validReceipt(value) ? value : null;
  } catch { return null; }
}

function validReceipt(value: unknown): value is ManagedCodexCliReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<ManagedCodexCliReceipt>;
  return receipt.schemaVersion === 1 && typeof receipt.version === "string" && typeof receipt.releaseTag === "string" && /^[a-f0-9]{64}$/i.test(receipt.digest ?? "") && /^[a-f0-9]{64}$/i.test(receipt.binaryDigest ?? "") && receipt.architecture === "aarch64-apple-darwin" && typeof receipt.relativeDirectory === "string" && basename(receipt.relativeDirectory) === receipt.relativeDirectory && typeof receipt.binaryRelativePath === "string" && !isAbsolute(receipt.binaryRelativePath) && !receipt.binaryRelativePath.split(/[\\/]/).includes("..") && typeof receipt.verifiedAt === "string";
}

function binaryForReceipt(paths: CodexCliPaths, receipt: ManagedCodexCliReceipt): string {
  return safeChild(safeChild(paths.releases, receipt.relativeDirectory), receipt.binaryRelativePath);
}

function pruneUnreferencedReleases(paths: CodexCliPaths, state: ManagedCodexCliState): void {
  const keep = new Set([state.current?.relativeDirectory, state.previous?.relativeDirectory].filter((value): value is string => Boolean(value)));
  for (const name of safeDirectoryNames(paths.releases)) if (!keep.has(name)) rmSync(safeChild(paths.releases, name), { recursive: true, force: true });
}

function safeDirectoryNames(root: string): string[] {
  try { return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name); } catch { return []; }
}

function removeDirectoryChildrenWithoutFollowing(root: string): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) rmSync(safeChild(root, name), { recursive: true, force: true });
}

function lockBelongsToLiveOtherProcess(path: string): boolean {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0 || value.pid === process.pid) return false;
    process.kill(value.pid as number, 0);
    return true;
  } catch { return false; }
}

function safeChild(root: string, child: string): string {
  const candidate = resolve(root, child);
  if (!isContained(resolve(root), candidate) || candidate === resolve(root)) throw new Error("Managed path escapes its root");
  return candidate;
}

function isContained(root: string, candidate: string): boolean { return candidate.startsWith(`${root}${sep}`); }

function atomicJsonWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function syncTreeCritical(root: string, paths: string[]): void {
  for (const relativePath of paths) {
    const fd = openSync(safeChild(root, relativePath), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  fsyncDirectory(root);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function normalizeVersion(output: string): string { return output.trim().replace(/^codex-cli\s+/, ""); }
function safeOperationId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  if (!safe) throw new Error("Operation id is invalid");
  return safe;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function emptyProgress(): CodexInstallProgress { return { operationId: null, phase: "idle", bytes: 0, version: null, error: null, startedAt: null, completedAt: null }; }
function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/(?:\/[\w .+@=-]+){2,}/g, "[managed path]").replace(/https?:\/\/\S+/g, "[release URL]").slice(0, 500) || "Codex CLI operation failed";
}

// Useful for injected download implementations that stream chunks.
export function sha256Buffer(chunks: Iterable<Uint8Array>): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}
