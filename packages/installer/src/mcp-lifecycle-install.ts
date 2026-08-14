/**
 * Hermetic installer for the canonical Codex MCP lifecycle package.
 *
 * A caller must provide a target HOME. This module never derives a live home
 * directory, and it only replaces immutable package assets. Reaper-owned
 * lifecycle state, status, and action receipts are explicitly out of scope.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME_TOKEN = "{{HOME}}";

export const MCP_LIFECYCLE_PACKAGE_NAME = "@therealityreport/tweakers-mcp-lifecycle";
export const MCP_LIFECYCLE_PACKAGE_VERSION = "0.5.0";
export const MCP_LIFECYCLE_MANIFEST_SCHEMA_VERSION = 1;
export const MCP_LIFECYCLE_SCHEMA_VERSION = 2;
export const MCP_LIFECYCLE_POLICY_VERSION = "strict-detached-v5";
export const MCP_LIFECYCLE_MATCHER_REGISTRY_VERSION = "mcp-family-descriptors-v5";
export const MCP_LIFECYCLE_LABELS = [
  "com.thomashulihan.codex-mcp-idle-reaper",
  "com.thomashulihan.codex-mcp-guard",
] as const;
export const MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES = [
  "tmp/codex-mcp-idle-reaper-state.json",
  "tmp/codex-mcp-lifecycle-state.json",
  "tmp/codex-mcp-lifecycle-status.json",
  "tmp/codex-mcp-lifecycle-actions.jsonl",
  "tmp/codex-mcp-guard-notify.json",
  "tmp/codex-mcp-guard-status.json",
] as const;

export type McpLifecycleAssetKind = "file" | "plist-template";

export interface McpLifecycleAsset {
  id: string;
  kind: McpLifecycleAssetKind;
  source: string;
  destination: string;
  mode: string;
  source_sha256: string;
  label?: string;
  template_sha256?: string;
  rendered_home?: string;
  rendered_sha256?: string;
}

export interface McpLifecycleManifest {
  schema_version: number;
  package: { name: string; version: string };
  lifecycle_schema_version: number;
  policy_version: string;
  matcher_registry_version: string;
  policy: {
    detached_stable_grace_seconds: number;
    termination_order: string;
    termination_sequence: string;
    term_grace_seconds: number;
    kill_scope: string;
    execution_plan: string;
    descendant_churn_adoption_cap: number;
    retry_attempt_cap: number;
    automatic_signal_owner: string;
    guard_mode: string;
    lane_modes: {
      detached_wrapper: string;
      exact_standalone_app_server: string;
      standalone_orphan: string;
      claude_idle: string;
    };
  };
  preserved_runtime_files: string[];
  assets: McpLifecycleAsset[];
  tests: { baseline_count: number; path: string; fixtures: string };
}

/** Small filesystem seam for hermetic temporary-root and failure tests. */
export interface McpLifecycleFilesystem {
  exists(path: string): boolean;
  read(path: string): Buffer;
  write(path: string, contents: Buffer, mode: number): void;
  mkdir(path: string): void;
  chmod(path: string, mode: number): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  mode(path: string): number;
  isFile(path: string): boolean;
  makeTempDir(prefix: string): string;
}

export interface McpLifecycleCommandResult {
  available: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Read-only command seam. It is used only for optional plist linting. */
export interface McpLifecycleCommandRunner {
  run(command: string, args: string[]): McpLifecycleCommandResult;
}

export interface ActiveMcpLifecycleTermination {
  treeKey?: string;
  detail?: string;
}

export type McpLifecycleInstallStep =
  | "before-stage"
  | "after-stage"
  | "before-backup"
  | "after-backup"
  | "before-promote"
  | "after-promote"
  | "before-verify";

export interface McpLifecycleInstallRequest {
  sourceRoot?: string;
  /**
   * Optional immutable proof captured by the caller before entering the
   * transaction. When supplied, staging and receipt derivation use these exact
   * bytes rather than opening the source package again.
   */
  verifiedCandidate?: McpLifecycleVerification;
  /** Required: no current-user HOME default is intentionally available. */
  targetHome: string;
  /** When given, must be exactly targetHome/.codex. */
  targetRoot?: string;
  /** When given, must be exactly targetHome/Library/LaunchAgents. */
  launchAgentsRoot?: string;
  /** Defaults to the caller-supplied targetHome, never a live global path. */
  temporaryRoot?: string;
  filesystem?: McpLifecycleFilesystem;
  commands?: McpLifecycleCommandRunner;
  /**
   * Zero means first install and one means the current registration. More
   * than one fails closed because exact-one label ownership cannot be proven.
   */
  labelInstances?(label: string): number | undefined;
  /** Defers before staging when the reaper has a live termination in flight. */
  activeTermination?(): ActiveMcpLifecycleTermination | null;
  /** Test seam for deterministic promotion and rollback failures. */
  beforeStep?(step: McpLifecycleInstallStep, asset: McpLifecycleResolvedAsset): void;
  /**
   * Optional activation seam invoked after every changed asset is verified but
   * before backups are discarded. Throwing here rolls every replacement back.
   * The callback must mark activation immediately before its first live
   * service mutation; failures before that mark never trigger a reload rollback.
   */
  afterPromotion?(
    assets: readonly McpLifecycleResolvedAsset[],
    markActivationAttempted: () => void,
  ): void;
  /** Final transaction hook for both changed and unchanged candidates. Throwing rolls files back. */
  finalize?(assets: readonly McpLifecycleResolvedAsset[], changed: readonly string[]): void;
  /** Restores finalizer-owned state after file rollback and before service rollback. */
  rollbackFinalization?(assets: readonly McpLifecycleResolvedAsset[], changed: readonly string[]): void;
  /** Best-effort activation rollback after file backups have been restored. */
  afterRollback?(assets: readonly McpLifecycleResolvedAsset[]): void;
}

export interface McpLifecycleResolvedAsset {
  asset: McpLifecycleAsset;
  sourcePath: string;
  destinationPath: string;
  content: Buffer;
  mode: number;
}

export interface McpLifecycleVerification {
  sourceRoot: string;
  targetHome: string;
  targetRoot: string;
  launchAgentsRoot: string;
  manifest: McpLifecycleManifest;
  assets: McpLifecycleResolvedAsset[];
}

export type McpLifecycleInstallResult =
  | {
    status: "installed" | "unchanged";
    sourceRoot: string;
    targetHome: string;
    targetRoot: string;
    changedAssetIds: string[];
    preservedRuntimeFiles: readonly string[];
  }
  | {
    status: "deferred";
    sourceRoot: string;
    targetHome: string;
    reason: string;
    label?: string;
  };

export class McpLifecycleInstallError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "McpLifecycleInstallError";
  }
}

const defaultFilesystem: McpLifecycleFilesystem = {
  exists: existsSync,
  read: (path) => readFileSync(path),
  write: (path, contents, mode) => writeFileSync(path, contents, { mode }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  chmod: chmodSync,
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  mode: (path) => statSync(path).mode & 0o777,
  isFile: (path) => statSync(path).isFile(),
  makeTempDir: mkdtempSync,
};

const defaultCommands: McpLifecycleCommandRunner = {
  run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    const code = result.error && (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { available: false, status: null, stdout: "", stderr: "" };
    if (result.error) throw result.error;
    return {
      available: true,
      status: result.status,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  },
};

export function defaultMcpLifecycleSourceRoot(): string {
  const bundled = resolve(HERE, "..", "assets", "mcp-lifecycle");
  if (existsSync(join(bundled, "manifest.json"))) return bundled;
  // Development checkout fallback from both installer src and dist.
  return resolve(HERE, "..", "..", "mcp-lifecycle");
}

export function readMcpLifecycleManifest(
  sourceRoot = defaultMcpLifecycleSourceRoot(),
  filesystem: McpLifecycleFilesystem = defaultFilesystem,
): McpLifecycleManifest {
  const root = requireAbsolutePath(sourceRoot, "MCP lifecycle source root");
  const manifestPath = safeChild(root, "manifest.json", "manifest path");
  if (!filesystem.exists(manifestPath) || !filesystem.isFile(manifestPath)) {
    throw new McpLifecycleInstallError("MCP lifecycle manifest is missing");
  }
  try {
    return validateManifest(JSON.parse(filesystem.read(manifestPath).toString("utf8")));
  } catch (error) {
    if (error instanceof McpLifecycleInstallError) throw error;
    throw new McpLifecycleInstallError("MCP lifecycle manifest is invalid JSON", error);
  }
}

/**
 * Verify source digests, modes, policy, portable destinations, and rendered
 * plist content. This function has no write or launchctl side effects.
 */
export function verifyMcpLifecyclePackage(input: {
  sourceRoot?: string;
  targetHome: string;
  targetRoot?: string;
  launchAgentsRoot?: string;
  filesystem?: McpLifecycleFilesystem;
}): McpLifecycleVerification {
  const filesystem = input.filesystem ?? defaultFilesystem;
  const sourceRoot = requireAbsolutePath(
    input.sourceRoot ?? defaultMcpLifecycleSourceRoot(),
    "MCP lifecycle source root",
  );
  const targetHome = requireAbsolutePath(input.targetHome, "MCP lifecycle target home");
  const targetRoot = resolveTargetRoot(targetHome, input.targetRoot);
  const launchAgentsRoot = resolveLaunchAgentsRoot(targetHome, input.launchAgentsRoot);
  const manifest = readMcpLifecycleManifest(sourceRoot, filesystem);
  validatePolicy(manifest);

  const ids = new Set<string>();
  const destinations = new Set<string>();
  const labels = new Set<string>();
  const assets = manifest.assets.map((asset) => {
    if (ids.has(asset.id)) throw new McpLifecycleInstallError("MCP lifecycle manifest duplicates an asset id");
    ids.add(asset.id);
    const sourcePath = safeChild(sourceRoot, asset.source, "asset source");
    if (!filesystem.exists(sourcePath) || !filesystem.isFile(sourcePath)) {
      throw new McpLifecycleInstallError("MCP lifecycle asset is missing: " + asset.id);
    }
    const mode = parseMode(asset.mode, asset.id);
    if (filesystem.mode(sourcePath) !== mode) {
      throw new McpLifecycleInstallError("MCP lifecycle asset mode mismatch: " + asset.id);
    }
    const source = filesystem.read(sourcePath);
    if (sha256(source) !== asset.source_sha256) {
      throw new McpLifecycleInstallError("MCP lifecycle asset digest mismatch: " + asset.id);
    }
    const content = renderAsset(asset, source, targetHome);
    const destinationPath = resolveAssetDestination(asset, targetHome, targetRoot, launchAgentsRoot);
    if (destinations.has(destinationPath)) {
      throw new McpLifecycleInstallError("MCP lifecycle manifest duplicates a destination");
    }
    destinations.add(destinationPath);
    if (asset.kind === "plist-template") {
      if (!asset.label || labels.has(asset.label)) {
        throw new McpLifecycleInstallError("MCP lifecycle launchd label is missing or duplicated");
      }
      labels.add(asset.label);
      validateRenderedPlist(asset, content);
    }
    assertNotPreservedRuntimePath(destinationPath, targetRoot);
    return { asset, sourcePath, destinationPath, content, mode };
  });

  const expectedLabels = new Set<string>(MCP_LIFECYCLE_LABELS);
  if (labels.size !== expectedLabels.size || [...labels].some((label) => !expectedLabels.has(label))) {
    throw new McpLifecycleInstallError("MCP lifecycle manifest does not contain the exact launchd labels");
  }
  return { sourceRoot, targetHome, targetRoot, launchAgentsRoot, manifest, assets };
}

function resolveVerifiedCandidate(
  request: Pick<McpLifecycleInstallRequest, "sourceRoot" | "verifiedCandidate" | "targetHome" | "targetRoot" | "launchAgentsRoot" | "filesystem">,
  targetHome: string,
  targetRoot: string,
  launchAgentsRoot: string,
): McpLifecycleVerification {
  const candidate = request.verifiedCandidate;
  if (!candidate) {
    return verifyMcpLifecyclePackage({
      sourceRoot: request.sourceRoot,
      targetHome,
      targetRoot,
      launchAgentsRoot,
      filesystem: request.filesystem,
    });
  }
  const requestedSource = request.sourceRoot
    ? requireAbsolutePath(request.sourceRoot, "MCP lifecycle source root")
    : candidate.sourceRoot;
  if (
    candidate.sourceRoot !== requestedSource
    || candidate.targetHome !== targetHome
    || candidate.targetRoot !== targetRoot
    || candidate.launchAgentsRoot !== launchAgentsRoot
  ) {
    throw new McpLifecycleInstallError("MCP lifecycle verified candidate does not match the requested source or target.");
  }
  return candidate;
}

/**
 * Public, side-effect-free preflight. Existing loaded labels may be zero or
 * one; duplicate labels and active termination actions defer promotion.
 */
export function preflightMcpLifecycleInstall(
  request: Pick<McpLifecycleInstallRequest, "sourceRoot" | "verifiedCandidate" | "targetHome" | "targetRoot" | "launchAgentsRoot" | "filesystem" | "labelInstances" | "activeTermination">,
): McpLifecycleInstallResult | null {
  const targetHome = requireAbsolutePath(request.targetHome, "MCP lifecycle target home");
  const targetRoot = resolveTargetRoot(targetHome, request.targetRoot);
  const launchAgentsRoot = resolveLaunchAgentsRoot(targetHome, request.launchAgentsRoot);
  const verified = resolveVerifiedCandidate(request, targetHome, targetRoot, launchAgentsRoot);
  const active = request.activeTermination?.();
  if (active) {
    const tree = active.treeKey ? " for " + active.treeKey : "";
    const detail = active.detail ? ": " + active.detail : "";
    return {
      status: "deferred",
      sourceRoot: verified.sourceRoot,
      targetHome,
      reason: "MCP lifecycle termination is active" + tree + detail,
    };
  }
  for (const label of MCP_LIFECYCLE_LABELS) {
    const count = request.labelInstances?.(label);
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new McpLifecycleInstallError("Invalid launchd label count for " + label);
    }
    if (count > 1) {
      return {
        status: "deferred",
        sourceRoot: verified.sourceRoot,
        targetHome,
        label,
        reason: "MCP lifecycle label " + label + " is registered more than once; exact-one ownership is required",
      };
    }
  }
  return null;
}

/**
 * Transactionally stage, verify, back up, promote, and roll back immutable
 * assets. It does not call launchctl or send signals; activation is a separate
 * final live-promotion step.
 */
export function installMcpLifecyclePackage(request: McpLifecycleInstallRequest): McpLifecycleInstallResult {
  const filesystem = request.filesystem ?? defaultFilesystem;
  const targetHome = requireAbsolutePath(request.targetHome, "MCP lifecycle target home");
  const targetRoot = resolveTargetRoot(targetHome, request.targetRoot);
  const deferred = preflightMcpLifecycleInstall(request);
  if (deferred) return deferred;
  const launchAgentsRoot = resolveLaunchAgentsRoot(targetHome, request.launchAgentsRoot);
  const verified = resolveVerifiedCandidate(request, targetHome, targetRoot, launchAgentsRoot);
  const temporaryRoot = requireAbsolutePath(
    request.temporaryRoot ?? targetHome,
    "MCP lifecycle temporary root",
  );
  if (!isWithin(targetHome, temporaryRoot)) {
    throw new McpLifecycleInstallError("MCP lifecycle temporary root must stay inside target home");
  }

  filesystem.mkdir(temporaryRoot);
  const transactionRoot = filesystem.makeTempDir(join(temporaryRoot, ".mcp-lifecycle-install-"));
  const stageRoot = join(transactionRoot, "stage");
  const backupRoot = join(transactionRoot, "backup");
  const replacements: Replacement[] = [];
  const changedAssetIds: string[] = [];
  let activationAttempted = false;
  let finalizationAttempted = false;
  try {
    filesystem.mkdir(stageRoot);
    filesystem.mkdir(backupRoot);
    const staged = stageAssets(verified.assets, stageRoot, filesystem, request.beforeStep);
    for (const stagedAsset of staged) verifyAssetAtPath(stagedAsset, stagedAsset.stagePath, filesystem, request.commands ?? defaultCommands);

    for (const stagedAsset of staged) {
      if (destinationMatches(stagedAsset, filesystem)) continue;
      const replacement: Replacement = {
        destinationPath: stagedAsset.destinationPath,
        backupPath: join(backupRoot, stagedAsset.asset.id + ".backup"),
        hadExisting: filesystem.exists(stagedAsset.destinationPath),
        promoted: false,
      };
      replacements.push(replacement);
      filesystem.mkdir(dirname(stagedAsset.destinationPath));
      request.beforeStep?.("before-backup", stagedAsset);
      if (replacement.hadExisting) filesystem.rename(stagedAsset.destinationPath, replacement.backupPath);
      request.beforeStep?.("after-backup", stagedAsset);
      request.beforeStep?.("before-promote", stagedAsset);
      filesystem.rename(stagedAsset.stagePath, stagedAsset.destinationPath);
      replacement.promoted = true;
      filesystem.chmod(stagedAsset.destinationPath, stagedAsset.mode);
      request.beforeStep?.("after-promote", stagedAsset);
      request.beforeStep?.("before-verify", stagedAsset);
      verifyAssetAtPath(stagedAsset, stagedAsset.destinationPath, filesystem, request.commands ?? defaultCommands);
      changedAssetIds.push(stagedAsset.asset.id);
    }
    if (changedAssetIds.length > 0 && request.afterPromotion) {
      request.afterPromotion(verified.assets, () => {
        activationAttempted = true;
      });
    }
    if (request.finalize) {
      finalizationAttempted = true;
      request.finalize(verified.assets, changedAssetIds);
    }
    return {
      status: changedAssetIds.length > 0 ? "installed" : "unchanged",
      sourceRoot: verified.sourceRoot,
      targetHome,
      targetRoot,
      changedAssetIds,
      preservedRuntimeFiles: MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES,
    };
  } catch (error) {
    const rollbackError = rollbackReplacements(replacements, filesystem);
    let finalizationRollbackError: unknown | null = null;
    if (finalizationAttempted && request.rollbackFinalization) {
      try {
        request.rollbackFinalization(verified.assets, changedAssetIds);
      } catch (hookError) {
        finalizationRollbackError = hookError;
      }
    }
    let activationRollbackError: unknown | null = null;
    if (activationAttempted && request.afterRollback) {
      try {
        request.afterRollback(verified.assets);
      } catch (hookError) {
        activationRollbackError = hookError;
      }
    }
    const suffix = [
      rollbackError ? "file rollback also failed: " + errorMessage(rollbackError) : null,
      finalizationRollbackError ? "finalization rollback also failed: " + errorMessage(finalizationRollbackError) : null,
      activationRollbackError ? "activation rollback also failed: " + errorMessage(activationRollbackError) : null,
    ].filter(Boolean).join("; ");
    throw new McpLifecycleInstallError(
      "MCP lifecycle install failed: " + errorMessage(error) + (suffix ? "; " + suffix : ""),
      error,
    );
  } finally {
    try {
      filesystem.remove(transactionRoot);
    } catch {
      // A temp cleanup failure must not mask a successful verified promotion.
    }
  }
}

interface StagedAsset extends McpLifecycleResolvedAsset {
  stagePath: string;
}

interface Replacement {
  destinationPath: string;
  backupPath: string;
  hadExisting: boolean;
  promoted: boolean;
}

function stageAssets(
  assets: McpLifecycleResolvedAsset[],
  stageRoot: string,
  filesystem: McpLifecycleFilesystem,
  beforeStep: McpLifecycleInstallRequest["beforeStep"],
): StagedAsset[] {
  return assets.map((asset) => {
    beforeStep?.("before-stage", asset);
    const stagePath = safeChild(stageRoot, asset.asset.id + ".stage", "staged asset path");
    filesystem.mkdir(dirname(stagePath));
    filesystem.write(stagePath, asset.content, asset.mode);
    filesystem.chmod(stagePath, asset.mode);
    beforeStep?.("after-stage", asset);
    return { ...asset, stagePath };
  });
}

function verifyAssetAtPath(
  asset: McpLifecycleResolvedAsset,
  path: string,
  filesystem: McpLifecycleFilesystem,
  commands: McpLifecycleCommandRunner,
): void {
  if (!filesystem.exists(path) || !filesystem.isFile(path)) {
    throw new McpLifecycleInstallError("MCP lifecycle staged asset is missing: " + asset.asset.id);
  }
  if (filesystem.mode(path) !== asset.mode) {
    throw new McpLifecycleInstallError("MCP lifecycle staged asset mode changed: " + asset.asset.id);
  }
  const contents = filesystem.read(path);
  if (!contents.equals(asset.content)) {
    throw new McpLifecycleInstallError("MCP lifecycle staged asset content changed: " + asset.asset.id);
  }
  if (asset.asset.kind === "plist-template") {
    validateRenderedPlist(asset.asset, contents);
    const lint = commands.run("plutil", ["-lint", path]);
    if (lint.available && lint.status !== 0) {
      throw new McpLifecycleInstallError("plutil rejected " + asset.asset.id + ": " + (lint.stderr || lint.stdout));
    }
  }
}

function destinationMatches(asset: McpLifecycleResolvedAsset, filesystem: McpLifecycleFilesystem): boolean {
  return filesystem.exists(asset.destinationPath)
    && filesystem.isFile(asset.destinationPath)
    && filesystem.mode(asset.destinationPath) === asset.mode
    && filesystem.read(asset.destinationPath).equals(asset.content);
}

function rollbackReplacements(replacements: Replacement[], filesystem: McpLifecycleFilesystem): unknown | null {
  let firstError: unknown | null = null;
  for (const replacement of [...replacements].reverse()) {
    try {
      if (replacement.promoted && filesystem.exists(replacement.destinationPath)) {
        filesystem.remove(replacement.destinationPath);
      }
      if (replacement.hadExisting && filesystem.exists(replacement.backupPath)) {
        filesystem.mkdir(dirname(replacement.destinationPath));
        filesystem.rename(replacement.backupPath, replacement.destinationPath);
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

function renderAsset(asset: McpLifecycleAsset, source: Buffer, targetHome: string): Buffer {
  if (asset.kind === "file") return source;
  const template = source.toString("utf8");
  if (!template.includes(HOME_TOKEN) || template.replaceAll(HOME_TOKEN, "").includes("{{")) {
    throw new McpLifecycleInstallError("MCP lifecycle template has unsafe tokens: " + asset.id);
  }
  if (asset.template_sha256 !== asset.source_sha256) {
    throw new McpLifecycleInstallError("MCP lifecycle template digest declaration is inconsistent: " + asset.id);
  }
  const rendered = Buffer.from(template.replaceAll(HOME_TOKEN, targetHome), "utf8");
  if (asset.rendered_home === targetHome && asset.rendered_sha256 && sha256(rendered) !== asset.rendered_sha256) {
    throw new McpLifecycleInstallError("MCP lifecycle template frozen rendering changed: " + asset.id);
  }
  return rendered;
}

function resolveAssetDestination(
  asset: McpLifecycleAsset,
  targetHome: string,
  targetRoot: string,
  launchAgentsRoot: string,
): string {
  if (!asset.destination.startsWith(HOME_TOKEN + "/")) {
    throw new McpLifecycleInstallError("MCP lifecycle asset destination lacks HOME token: " + asset.id);
  }
  const suffix = asset.destination.slice(HOME_TOKEN.length + 1);
  if (!isSafeRelative(suffix)) {
    throw new McpLifecycleInstallError("MCP lifecycle asset destination is unsafe: " + asset.id);
  }
  const destination = resolve(targetHome, suffix);
  const managedRoot = asset.kind === "plist-template" ? launchAgentsRoot : targetRoot;
  if (!isWithin(managedRoot, destination)) {
    throw new McpLifecycleInstallError("MCP lifecycle asset destination is outside its managed root: " + asset.id);
  }
  return destination;
}

function validateRenderedPlist(asset: McpLifecycleAsset, content: Buffer): void {
  const text = content.toString("utf8");
  if (!asset.label || !text.includes("<plist") || !text.includes("<string>" + asset.label + "</string>") || text.includes(HOME_TOKEN)) {
    throw new McpLifecycleInstallError("MCP lifecycle plist failed structural validation: " + asset.id);
  }
}

function validateManifest(raw: unknown): McpLifecycleManifest {
  if (!isRecord(raw)) throw new McpLifecycleInstallError("MCP lifecycle manifest root must be an object");
  const packageValue = raw.package;
  const policy = raw.policy;
  const tests = raw.tests;
  const preserved = raw.preserved_runtime_files;
  if (!isRecord(packageValue)
    || packageValue.name !== MCP_LIFECYCLE_PACKAGE_NAME
    || packageValue.version !== MCP_LIFECYCLE_PACKAGE_VERSION
    || raw.schema_version !== MCP_LIFECYCLE_MANIFEST_SCHEMA_VERSION
    || raw.lifecycle_schema_version !== MCP_LIFECYCLE_SCHEMA_VERSION
    || raw.policy_version !== MCP_LIFECYCLE_POLICY_VERSION
    || raw.matcher_registry_version !== MCP_LIFECYCLE_MATCHER_REGISTRY_VERSION) {
    throw new McpLifecycleInstallError("MCP lifecycle manifest identity or version is invalid");
  }
  if (!isRecord(policy)
    || typeof policy.detached_stable_grace_seconds !== "number"
    || typeof policy.termination_order !== "string"
    || typeof policy.termination_sequence !== "string"
    || typeof policy.term_grace_seconds !== "number"
    || typeof policy.kill_scope !== "string"
    || typeof policy.execution_plan !== "string"
    || typeof policy.descendant_churn_adoption_cap !== "number"
    || typeof policy.retry_attempt_cap !== "number"
    || typeof policy.automatic_signal_owner !== "string"
    || typeof policy.guard_mode !== "string"
    || !isRecord(policy.lane_modes)
    || typeof policy.lane_modes.detached_wrapper !== "string"
    || typeof policy.lane_modes.exact_standalone_app_server !== "string"
    || typeof policy.lane_modes.standalone_orphan !== "string"
    || typeof policy.lane_modes.claude_idle !== "string") {
    throw new McpLifecycleInstallError("MCP lifecycle manifest policy is invalid");
  }
  if (!Array.isArray(preserved)
    || !preserved.every((path): path is string => typeof path === "string")
    || preserved.length !== MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES.length
    || preserved.some((path, index) => path !== MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES[index])) {
    throw new McpLifecycleInstallError("MCP lifecycle manifest must preserve all lifecycle state, status, and action receipts");
  }
  if (!Array.isArray(raw.assets) || raw.assets.length !== 5) {
    throw new McpLifecycleInstallError("MCP lifecycle manifest must contain exactly five assets");
  }
  if (!isRecord(tests)
    || typeof tests.baseline_count !== "number"
    || typeof tests.path !== "string"
    || typeof tests.fixtures !== "string") {
    throw new McpLifecycleInstallError("MCP lifecycle manifest test metadata is invalid");
  }
  return {
    schema_version: raw.schema_version as number,
    package: { name: packageValue.name, version: packageValue.version },
    lifecycle_schema_version: raw.lifecycle_schema_version as number,
    policy_version: raw.policy_version as string,
    matcher_registry_version: raw.matcher_registry_version as string,
    policy: {
      detached_stable_grace_seconds: policy.detached_stable_grace_seconds,
      termination_order: policy.termination_order,
      termination_sequence: policy.termination_sequence,
      term_grace_seconds: policy.term_grace_seconds,
      kill_scope: policy.kill_scope,
      execution_plan: policy.execution_plan,
      descendant_churn_adoption_cap: policy.descendant_churn_adoption_cap,
      retry_attempt_cap: policy.retry_attempt_cap,
      automatic_signal_owner: policy.automatic_signal_owner,
      guard_mode: policy.guard_mode,
      lane_modes: {
        detached_wrapper: policy.lane_modes.detached_wrapper,
        exact_standalone_app_server: policy.lane_modes.exact_standalone_app_server,
        standalone_orphan: policy.lane_modes.standalone_orphan,
        claude_idle: policy.lane_modes.claude_idle,
      },
    },
    preserved_runtime_files: [...preserved],
    assets: raw.assets.map(parseAsset),
    tests: {
      baseline_count: tests.baseline_count,
      path: tests.path,
      fixtures: tests.fixtures,
    },
  };
}

function parseAsset(raw: unknown): McpLifecycleAsset {
  if (!isRecord(raw)
    || typeof raw.id !== "string"
    || !/^[a-z0-9-]+$/.test(raw.id)
    || (raw.kind !== "file" && raw.kind !== "plist-template")
    || typeof raw.source !== "string"
    || typeof raw.destination !== "string"
    || typeof raw.mode !== "string"
    || typeof raw.source_sha256 !== "string") {
    throw new McpLifecycleInstallError("MCP lifecycle manifest asset is invalid");
  }
  if (raw.kind === "plist-template"
    && (typeof raw.label !== "string"
      || typeof raw.template_sha256 !== "string"
      || typeof raw.rendered_home !== "string"
      || typeof raw.rendered_sha256 !== "string")) {
    throw new McpLifecycleInstallError("MCP lifecycle plist manifest asset is invalid");
  }
  return {
    id: raw.id,
    kind: raw.kind,
    source: raw.source,
    destination: raw.destination,
    mode: raw.mode,
    source_sha256: raw.source_sha256,
    label: typeof raw.label === "string" ? raw.label : undefined,
    template_sha256: typeof raw.template_sha256 === "string" ? raw.template_sha256 : undefined,
    rendered_home: typeof raw.rendered_home === "string" ? raw.rendered_home : undefined,
    rendered_sha256: typeof raw.rendered_sha256 === "string" ? raw.rendered_sha256 : undefined,
  };
}

function validatePolicy(manifest: McpLifecycleManifest): void {
  const policy = manifest.policy;
  if (policy.detached_stable_grace_seconds !== 600
    || policy.termination_order !== "children-first-term"
    || policy.termination_sequence !== "children-first-term-grace-kill-verify"
    || policy.term_grace_seconds !== 5
    || policy.kill_scope !== "same-identity-survivors"
    || policy.execution_plan !== "identity-frozen-bounded-descendant-adoption"
    || policy.descendant_churn_adoption_cap !== 32
    || policy.retry_attempt_cap !== 2
    || policy.automatic_signal_owner !== "reaper"
    || policy.guard_mode !== "notification-only"
    || policy.lane_modes.detached_wrapper !== "automatic"
    || policy.lane_modes.exact_standalone_app_server !== "automatic"
    || policy.lane_modes.standalone_orphan !== "observation_only"
    || policy.lane_modes.claude_idle !== "observation_only") {
    throw new McpLifecycleInstallError("MCP lifecycle manifest violates the frozen v5 safety policy");
  }
}

function parseMode(value: string, id: string): number {
  if (!/^0[0-7]{3}$/.test(value)) {
    throw new McpLifecycleInstallError("MCP lifecycle mode is invalid for " + id);
  }
  return Number.parseInt(value, 8);
}

function assertNotPreservedRuntimePath(destination: string, targetRoot: string): void {
  const path = relative(targetRoot, destination);
  if (MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES.includes(path as typeof MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES[number])) {
    throw new McpLifecycleInstallError("MCP lifecycle asset would replace preserved runtime data");
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function requireAbsolutePath(value: string, label: string): string {
  if (!value || !isAbsolute(value)) throw new McpLifecycleInstallError(label + " must be an absolute path");
  return resolve(value);
}

function resolveTargetRoot(targetHome: string, requested?: string): string {
  const expected = join(targetHome, ".codex");
  if (!requested) return expected;
  const root = requireAbsolutePath(requested, "MCP lifecycle target root");
  if (root !== expected) throw new McpLifecycleInstallError("MCP lifecycle target root must be targetHome/.codex");
  return root;
}

function resolveLaunchAgentsRoot(targetHome: string, requested?: string): string {
  const expected = join(targetHome, "Library", "LaunchAgents");
  if (!requested) return expected;
  const root = requireAbsolutePath(requested, "MCP lifecycle LaunchAgents root");
  if (root !== expected) throw new McpLifecycleInstallError("MCP lifecycle LaunchAgents root must be under targetHome");
  return root;
}

function safeChild(root: string, child: string, label: string): string {
  if (!isSafeRelative(child)) throw new McpLifecycleInstallError(label + " is not a safe relative path");
  const candidate = resolve(root, child);
  if (!isWithin(root, candidate)) throw new McpLifecycleInstallError(label + " escapes its root");
  return candidate;
}

function isSafeRelative(value: string): boolean {
  if (!value || value.includes("\0") || isAbsolute(value) || value.includes("\\")) return false;
  return !value.split("/").includes("..");
}

function isWithin(root: string, candidate: string): boolean {
  const base = resolve(root);
  const path = resolve(candidate);
  return path === base || path.startsWith(base + sep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
