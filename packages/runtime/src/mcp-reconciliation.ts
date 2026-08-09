import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type {
  ApprovalPolicyReconciliation,
  McpConflict,
  McpReconciliationPlan,
  McpSyncTweak,
  PreservedApprovalPolicy,
  PreservedMcpOptionsByServerName,
} from "./mcp-sync";
import {
  MCP_MANAGED_END,
  MCP_MANAGED_START,
  USER_QUESTIONS_MCP_SERVER_NAME,
  hasStrayManagedMcpEndMarker,
  mcpServerNameFromTweakId,
  observeUserQuestionsApprovalPolicy,
  planManagedMcpReconciliation,
  sanitizePreservedApprovalPolicy,
  sanitizePreservedMcpOptions,
  stripManagedMcpBlock,
  withMcpConfigMutationLock,
} from "./mcp-sync";

export type McpSyncTrigger =
  | "startup"
  | "tweak-reload"
  | "enabled-state"
  | "config-change"
  | "manual-repair";

export interface McpSyncReceipt {
  schemaVersion: 2;
  phase: "prepared" | "complete";
  transactionId: string;
  trigger: McpSyncTrigger;
  startedAt: string;
  completedAt: string;
  status: "updated" | "unchanged" | "conflict" | "error";
  desiredNames: string[];
  appliedNames: string[];
  migrations: Array<{ from: string; to: string }>;
  conflicts: McpConflict[];
  preservedOptions: PreservedMcpOptionsByServerName;
  approvalPolicy: ApprovalPolicyReconciliation;
  preservedApprovalPolicy: PreservedApprovalPolicy | null;
  beforeFingerprint: string;
  afterFingerprint: string;
  /**
   * Raw-byte binding (afterFingerprint) breaks whenever the desktop app stamps
   * volatile bookkeeping (marketplace `last_updated`) into config.toml after a
   * reconcile. This canonical twin hashes the same content with those lines
   * stripped so health probes can bind the receipt across app boots.
   */
  afterFingerprintCanonical?: string;
  plannedAfterFingerprint?: string;
  restartRequired: boolean;
  /**
   * Completion time of the most recent reconciliation that changed the
   * Tweakers-owned MCP configuration. No-op/error receipts preserve it so a
   * required desktop restart cannot be forgotten by a later watcher pass.
   */
  managedConfigurationChangedAt?: string | null;
  error?: string;
}

export function userQuestionsMcpReceiptMatchesEnabledState(
  receipt: Pick<McpSyncReceipt, "status" | "desiredNames" | "appliedNames" | "conflicts" | "approvalPolicy">,
  enabled: boolean,
): boolean {
  if (
    receipt.status === "conflict"
    || receipt.status === "error"
    || receipt.conflicts.length !== 0
    || receipt.approvalPolicy.status !== "unchanged"
    || receipt.approvalPolicy.beforeRaw !== receipt.approvalPolicy.afterRaw
    || receipt.approvalPolicy.sandboxModeBeforeRaw !== receipt.approvalPolicy.sandboxModeAfterRaw
    || receipt.approvalPolicy.restartRequired
  ) return false;
  const desiredCount = receipt.desiredNames.filter((name) => name === USER_QUESTIONS_MCP_SERVER_NAME).length;
  const appliedCount = receipt.appliedNames.filter((name) => name === USER_QUESTIONS_MCP_SERVER_NAME).length;
  if (!enabled) return desiredCount === 0 && appliedCount === 0;
  return desiredCount === 1
    && appliedCount === 1;
}

export interface ReconcileMcpConfigOptions {
  configPath: string;
  statePath: string;
  /** Enabled MCP tweaks that should be present after reconciliation. */
  tweaks: McpSyncTweak[];
  /** All installed Tweakers-owned MCP tweaks, including disabled ones. */
  ownedTweaks?: McpSyncTweak[];
  trigger: McpSyncTrigger;
}

export interface ReconcileMcpConfigDependencies {
  beforeCommit?: (attempt: number, configPath: string) => void;
  beforeRename?: (attempt: number, configPath: string) => void;
  /** Runs after the old pathname is atomically captured but before exclusive promotion. */
  afterCapture?: (attempt: number, configPath: string) => void;
  /** Runs after promotion is checked but before the captured old inode is released. */
  beforeBackupRelease?: (attempt: number, configPath: string) => void;
  /** Runs after the last promotion check; the retired inode must remain reachable afterward. */
  afterFinalCheck?: (attempt: number, configPath: string) => void;
  /** Test/diagnostic hook after a verified config commit and before the final receipt. */
  afterCommit?: (configPath: string) => void;
  now?: () => Date;
  transactionId?: () => string;
}

export interface McpReconcilerOptions {
  configPath: string;
  statePath: string;
  getTweaks: () => McpSyncTweak[];
  getOwnedTweaks?: () => McpSyncTweak[];
  debounceMs?: number;
  watchConfig?: boolean;
  onReceipt?: (receipt: McpSyncReceipt) => void;
  onError?: (error: unknown) => void;
  reconcileDependencies?: ReconcileMcpConfigDependencies;
}

export interface McpConfigWatchHandle {
  close(): void | Promise<void>;
}

export interface CreateMcpReconcilerDependencies {
  watchConfig?: (
    configPath: string,
    onChange: (changedPath?: string) => void,
  ) => McpConfigWatchHandle;
  reconcileConfig?: (
    options: ReconcileMcpConfigOptions,
    dependencies?: ReconcileMcpConfigDependencies,
  ) => McpSyncReceipt | Promise<McpSyncReceipt>;
}

export interface McpReconciler {
  request(trigger: McpSyncTrigger): Promise<McpSyncReceipt>;
  reconcileNow(trigger: McpSyncTrigger): Promise<McpSyncReceipt>;
  readState(): McpSyncReceipt | null;
  close(): Promise<void>;
}

export const MCP_CANDIDATE_RECONCILIATION_ENV = "TWEAKERS_CANDIDATE_MCP_RECONCILIATION";
export const MCP_CANDIDATE_CODEX_HOME_ENV = "CODEX_HOME";

export interface ResolveMcpRuntimePathsOptions {
  /** Exact Tweakers user root selected by the loader for this runtime. */
  userRoot: string;
  /** Ordinary OS home. Candidate mode never substitutes this implicitly. */
  homeDirectory: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface McpRuntimePaths {
  codexHome: string;
  configPath: string;
  statePath: string;
  candidateIsolated: boolean;
}

/**
 * Resolve the only MCP config and receipt paths the desktop reconciler may use.
 *
 * Ordinary launches intentionally retain the historical ~/.codex/config.toml
 * behavior, even when CODEX_HOME happens to be present. A disposable candidate
 * must explicitly opt in and supply an exact CODEX_HOME below its exact,
 * non-symlink Tweakers user root. Existing symlink components, the real
 * ~/.codex tree, and paths outside the candidate root fail closed before a
 * watcher or reconciler can be created.
 */
export function resolveMcpRuntimePaths(
  options: ResolveMcpRuntimePathsOptions,
): McpRuntimePaths {
  const env = options.env ?? process.env;
  const statePath = join(options.userRoot, "mcp-sync-state.json");
  const ordinaryCodexHome = join(options.homeDirectory, ".codex");
  const candidateOptIn = env[MCP_CANDIDATE_RECONCILIATION_ENV];
  if (candidateOptIn === undefined || candidateOptIn === "") {
    return {
      codexHome: ordinaryCodexHome,
      configPath: join(ordinaryCodexHome, "config.toml"),
      statePath,
      candidateIsolated: false,
    };
  }
  if (candidateOptIn !== "1") {
    throw new Error(`${MCP_CANDIDATE_RECONCILIATION_ENV} must be exactly 1`);
  }

  const candidateCodexHome = env[MCP_CANDIDATE_CODEX_HOME_ENV];
  if (!candidateCodexHome) {
    throw new Error(
      `${MCP_CANDIDATE_CODEX_HOME_ENV} is required for candidate MCP reconciliation`,
    );
  }
  assertExactAbsolutePath(options.userRoot, "Tweakers candidate user root");
  assertExactAbsolutePath(candidateCodexHome, "Candidate CODEX_HOME");
  assertExistingDirectoryWithoutSymlinks(options.userRoot, "Tweakers candidate user root");
  assertPathHasNoExistingSymlink(candidateCodexHome, "Candidate CODEX_HOME");
  if (!isStrictDescendant(options.userRoot, candidateCodexHome)) {
    throw new Error("Candidate CODEX_HOME must be contained under the Tweakers candidate user root");
  }

  const resolvedCandidateHome = resolveThroughExistingAncestor(candidateCodexHome);
  const resolvedOrdinaryHome = resolveThroughExistingAncestor(ordinaryCodexHome);
  if (
    resolvedCandidateHome === resolvedOrdinaryHome
    || isStrictDescendant(resolvedOrdinaryHome, resolvedCandidateHome)
    || isStrictDescendant(resolvedCandidateHome, resolvedOrdinaryHome)
  ) {
    throw new Error("Candidate CODEX_HOME must not resolve to or contain the real ~/.codex directory");
  }

  if (existsSync(candidateCodexHome) && !lstatSync(candidateCodexHome).isDirectory()) {
    throw new Error("Candidate CODEX_HOME must be a directory when it already exists");
  }
  const configPath = join(candidateCodexHome, "config.toml");
  assertPathHasNoExistingSymlink(configPath, "Candidate Codex config");
  assertPathHasNoExistingSymlink(statePath, "Candidate MCP receipt");
  assertRegularFileWhenPresent(configPath, "Candidate Codex config");
  assertRegularFileWhenPresent(statePath, "Candidate MCP receipt");

  return {
    codexHome: candidateCodexHome,
    configPath,
    statePath,
    candidateIsolated: true,
  };
}

function assertExactAbsolutePath(path: string, label: string): void {
  if (!path || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an exact normalized absolute path`);
  }
}

function assertExistingDirectoryWithoutSymlinks(path: string, label: string): void {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    throw new Error(`${label} must already exist as a directory`);
  }
  if (lstatSync(path).isSymbolicLink() || resolveThroughExistingAncestor(path) !== path) {
    throw new Error(`${label} must not contain symbolic-link components`);
  }
}

function assertPathHasNoExistingSymlink(path: string, label: string): void {
  const pathStat = lstatIfPresent(path);
  if (
    pathStat?.isSymbolicLink()
    || resolveThroughExistingAncestor(path) !== path
  ) {
    throw new Error(`${label} must not contain symbolic-link components`);
  }
}

function assertRegularFileWhenPresent(path: string, label: string): void {
  const pathStat = lstatIfPresent(path);
  if (pathStat && !pathStat.isFile()) {
    throw new Error(`${label} must be a regular file when it already exists`);
  }
  if (pathStat && pathStat.nlink !== 1) {
    throw new Error(`${label} must not be hard-linked`);
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveThroughExistingAncestor(path: string): string {
  let ancestor = path;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder.length > 0
    && remainder !== ".."
    && !remainder.startsWith(`..${sep}`)
    && !isAbsolute(remainder);
}

interface PendingRequest {
  trigger: McpSyncTrigger;
  resolve: (receipt: McpSyncReceipt) => void;
  reject: (error: unknown) => void;
}

export function reconcileMcpConfig(
  options: ReconcileMcpConfigOptions,
  dependencies: ReconcileMcpConfigDependencies = {},
): McpSyncReceipt {
  return withMcpConfigMutationLock(
    options.configPath,
    () => reconcileMcpConfigWithLock(options, dependencies),
  );
}

function reconcileMcpConfigWithLock(
  options: ReconcileMcpConfigOptions,
  dependencies: ReconcileMcpConfigDependencies,
): McpSyncReceipt {
  const ownedTweaks = options.ownedTweaks ?? options.tweaks;
  const previousManagedConfigurationChangedAt = readMcpSyncState(
    options.statePath,
  )?.managedConfigurationChangedAt ?? null;
  let preservedOptions = readPreservedOptions(options.statePath, ownedTweaks);
  const durablePreservedApprovalPolicy = readPreservedApprovalPolicy(options.statePath, options.configPath);
  recoverInterruptedCas(options.configPath);
  const recoveredRetiredEdit = recoverRetiredConfigEdits(
    options.configPath,
    options.tweaks,
    ownedTweaks,
    preservedOptions,
    durablePreservedApprovalPolicy,
  );
  const now = dependencies.now ?? (() => new Date());
  const transactionId = dependencies.transactionId?.() ?? randomUUID();
  const startedAt = now().toISOString();
  let beforeBytes = readBytesIfExists(options.configPath);
  let beforeFingerprint = fingerprint(beforeBytes);
  let plan = emptyReconciliationPlan();
  let appliedPlanChange = false;

  try {
    let before = decodeToml(beforeBytes);
    plan = planMcpConfigReconciliation(options.tweaks, before, {
      ownedTweaks,
      preservedOptions,
      preservedApprovalPolicy: durablePreservedApprovalPolicy,
    });
    preservedOptions = plan.preservedOptions;
    // A conflict means ownership could not be proven for the complete desired
    // transition. Do not apply a safe-looking subset and leave the process in
    // a mixed mode; the caller must resolve the conflict first.
    if (plan.changed && !hasPlanConflict(plan)) {
      attempts:
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (!durablePreservedApprovalPolicy && plan.preservedApprovalPolicy) {
          writeReceipt(options.statePath, {
            schemaVersion: 2,
            phase: "prepared",
            transactionId,
            trigger: options.trigger,
            startedAt,
            completedAt: now().toISOString(),
            status: "unchanged",
            desiredNames: plan.desiredNames,
            appliedNames: plan.appliedNames,
            migrations: plan.migrations,
            conflicts: plan.conflicts,
            preservedOptions: plan.preservedOptions,
            approvalPolicy: plan.approvalPolicy,
            preservedApprovalPolicy: plan.preservedApprovalPolicy,
            beforeFingerprint,
            afterFingerprint: beforeFingerprint,
            afterFingerprintCanonical: canonicalConfigFingerprint(beforeBytes),
            plannedAfterFingerprint: fingerprint(plan.nextToml),
            restartRequired: false,
            managedConfigurationChangedAt: previousManagedConfigurationChangedAt,
          });
        }
        const mode = existsSync(options.configPath)
          ? statSync(options.configPath).mode & 0o777
          : 0o600;
        const tempPath = writeDurableTemp(options.configPath, plan.nextToml, mode);
        try {
          dependencies.beforeCommit?.(attempt, options.configPath);
          const observedBeforeCommit = readBytesIfExists(options.configPath);
          if (fingerprint(observedBeforeCommit) !== beforeFingerprint) {
            ({ beforeBytes, before, beforeFingerprint, plan } = replanAfterConcurrentEdit({
              attempt,
              observed: observedBeforeCommit,
              tweaks: options.tweaks,
              ownedTweaks,
              preservedOptions,
              preservedApprovalPolicy: durablePreservedApprovalPolicy,
            }));
            preservedOptions = plan.preservedOptions;
            if (hasPlanConflict(plan) || !plan.changed) break attempts;
            continue;
          }

          // This hook models an edit in the narrow interval after preparation.
          // The read immediately following it is the last operation before the
          // atomic rename, closing the previously untested check/rename window.
          dependencies.beforeRename?.(attempt, options.configPath);
          const observedBeforeRename = readBytesIfExists(options.configPath);
          if (fingerprint(observedBeforeRename) !== beforeFingerprint) {
            ({ beforeBytes, before, beforeFingerprint, plan } = replanAfterConcurrentEdit({
              attempt,
              observed: observedBeforeRename,
              tweaks: options.tweaks,
              ownedTweaks,
              preservedOptions,
              preservedApprovalPolicy: durablePreservedApprovalPolicy,
            }));
            preservedOptions = plan.preservedOptions;
            if (hasPlanConflict(plan) || !plan.changed) break attempts;
            continue;
          }
          const promoted = promoteConfigWithCas(
            options.configPath,
            tempPath,
            beforeFingerprint,
            () => dependencies.afterCapture?.(attempt, options.configPath),
            () => dependencies.beforeBackupRelease?.(attempt, options.configPath),
            () => dependencies.afterFinalCheck?.(attempt, options.configPath),
          );
          if (!promoted) {
            const observed = readBytesIfExists(options.configPath);
            ({ beforeBytes, before, beforeFingerprint, plan } = replanAfterConcurrentEdit({
              attempt,
              observed,
              tweaks: options.tweaks,
              ownedTweaks,
              preservedOptions,
              preservedApprovalPolicy: durablePreservedApprovalPolicy,
            }));
            preservedOptions = plan.preservedOptions;
            if (hasPlanConflict(plan) || !plan.changed) break attempts;
            continue;
          }
          const verified = readBytesIfExists(options.configPath);
          if (fingerprint(verified) !== fingerprint(plan.nextToml)) {
            throw new Error("MCP config verification failed after atomic replacement");
          }
          appliedPlanChange = true;
          dependencies.afterCommit?.(options.configPath);
          break;
        } finally {
          rmSync(tempPath, { force: true });
        }
      }
    }

    const after = readBytesIfExists(options.configPath);
    const policyTransitionAccepted = !hasPlanConflict(plan) && (appliedPlanChange || !plan.changed);
    const completedAt = now().toISOString();
    const managedConfigurationChangedAt = appliedPlanChange || recoveredRetiredEdit
      ? completedAt
      : previousManagedConfigurationChangedAt;
    const receipt: McpSyncReceipt = {
      schemaVersion: 2,
      phase: "complete",
      transactionId,
      trigger: options.trigger,
      startedAt,
      completedAt,
      status: hasPlanConflict(plan)
        ? "conflict"
        : appliedPlanChange || recoveredRetiredEdit
          ? "updated"
          : "unchanged",
      desiredNames: plan.desiredNames,
      appliedNames: plan.appliedNames,
      migrations: plan.migrations,
      conflicts: plan.conflicts,
      preservedOptions: plan.preservedOptions,
      approvalPolicy: plan.approvalPolicy,
      preservedApprovalPolicy: policyTransitionAccepted
        ? plan.preservedApprovalPolicy
        : durablePreservedApprovalPolicy,
      beforeFingerprint,
      afterFingerprint: fingerprint(after),
      afterFingerprintCanonical: canonicalConfigFingerprint(after),
      restartRequired: appliedPlanChange || recoveredRetiredEdit,
      managedConfigurationChangedAt,
    };
    writeReceipt(options.statePath, receipt);
    return receipt;
  } catch (error) {
    const completedAt = now().toISOString();
    const errorConfigBytes = readBytesIfExists(options.configPath);
    const receipt: McpSyncReceipt = {
      schemaVersion: 2,
      phase: "complete",
      transactionId,
      trigger: options.trigger,
      startedAt,
      completedAt,
      status: "error",
      desiredNames: plan.desiredNames,
      appliedNames: plan.appliedNames,
      migrations: plan.migrations,
      conflicts: plan.conflicts,
      preservedOptions,
      approvalPolicy: plan.approvalPolicy,
      preservedApprovalPolicy: appliedPlanChange
        ? plan.preservedApprovalPolicy
        : durablePreservedApprovalPolicy,
      beforeFingerprint,
      afterFingerprint: fingerprint(errorConfigBytes),
      afterFingerprintCanonical: canonicalConfigFingerprint(errorConfigBytes),
      restartRequired: false,
      managedConfigurationChangedAt: appliedPlanChange || recoveredRetiredEdit
        ? completedAt
        : previousManagedConfigurationChangedAt,
      error: error instanceof Error ? error.message : String(error),
    };
    writeReceipt(options.statePath, receipt);
    throw error;
  }
}

function casBackupPath(configPath: string): string {
  return join(dirname(configPath), `.${basename(configPath)}.tweakers-cas-backup`);
}

interface RetiredConfig {
  path: string;
  id: string;
  expectedFingerprint: string;
  currentFingerprint: string;
  mtimeMs: number;
}

function retiredConfigPrefix(configPath: string): string {
  return `.${basename(configPath)}.tweakers-cas-retired.`;
}

function retiredConfigPath(
  configPath: string,
  id: string,
  expectedFingerprint: string,
): string {
  return join(dirname(configPath), `${retiredConfigPrefix(configPath)}${id}.${expectedFingerprint}`);
}

function retiredBaselinePath(retiredPath: string): string {
  return `${retiredPath}.baseline`;
}

function listRetiredConfigs(configPath: string): RetiredConfig[] {
  const directory = dirname(configPath);
  const prefix = retiredConfigPrefix(configPath);
  if (!existsSync(directory)) return [];
  const retired: RetiredConfig[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue;
    const remainder = name.slice(prefix.length);
    const separator = remainder.lastIndexOf(".");
    if (separator <= 0) continue;
    const id = remainder.slice(0, separator);
    const expectedFingerprint = remainder.slice(separator + 1);
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) continue;
    const path = join(directory, name);
    try {
      retired.push({
        path,
        id,
        expectedFingerprint,
        currentFingerprint: fingerprint(readFileSync(path)),
        mtimeMs: statSync(path).mtimeMs,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return retired;
}

function sameInode(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function retireCurrentConfig(configPath: string, expectedFingerprint: string): string {
  const existingLink = listRetiredConfigs(configPath)
    .find((retired) => sameInode(retired.path, configPath));
  if (existingLink) {
    const retiredPath = existingLink.expectedFingerprint === expectedFingerprint
      ? existingLink.path
      : markRetiredConfigObserved(configPath, existingLink);
    ensureRetiredBaseline(retiredPath, expectedFingerprint);
    rmSync(configPath, { force: true });
    fsyncDirectory(dirname(configPath));
    return retiredPath;
  }
  const retiredPath = retiredConfigPath(configPath, randomUUID(), expectedFingerprint);
  const baseline = readFileSync(configPath);
  if (fingerprint(baseline) !== expectedFingerprint) {
    throw new Error("MCP config changed while its retained-inode baseline was captured");
  }
  renameSync(configPath, retiredPath);
  writeRetiredBaseline(retiredPath, baseline);
  fsyncDirectory(dirname(configPath));
  return retiredPath;
}

function ensureRetiredBaseline(retiredPath: string, expectedFingerprint: string): void {
  const baselinePath = retiredBaselinePath(retiredPath);
  if (existsSync(baselinePath)) return;
  const current = readFileSync(retiredPath);
  if (fingerprint(current) !== expectedFingerprint) {
    throw new Error(
      `Cannot safely recover retained MCP config edit without its baseline: ${retiredPath}`,
    );
  }
  writeRetiredBaseline(retiredPath, current);
}

function writeRetiredBaseline(retiredPath: string, content: Buffer): void {
  const baselinePath = retiredBaselinePath(retiredPath);
  const tempPath = writeDurableTemp(baselinePath, content, 0o600);
  try {
    renameSync(tempPath, baselinePath);
    fsyncDirectory(dirname(baselinePath));
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function captureActiveConfig(configPath: string): void {
  const activePath = casBackupPath(configPath);
  rmSync(activePath, { force: true });
  linkSync(configPath, activePath);
  fsyncDirectory(dirname(configPath));
}

function releaseActiveConfig(configPath: string): void {
  rmSync(casBackupPath(configPath), { force: true });
  fsyncDirectory(dirname(configPath));
}

function markRetiredConfigObserved(configPath: string, retired: RetiredConfig): string {
  const observed = readBytesIfExists(retired.path);
  const observedFingerprint = fingerprint(observed);
  const observedPath = retiredConfigPath(configPath, retired.id, observedFingerprint);
  const previousBaselinePath = retiredBaselinePath(retired.path);
  if (observedPath !== retired.path) renameSync(retired.path, observedPath);
  writeRetiredBaseline(observedPath, observed);
  if (previousBaselinePath !== retiredBaselinePath(observedPath)) {
    rmSync(previousBaselinePath, { force: true });
  }
  return observedPath;
}

function recoverRetiredConfigEdits(
  configPath: string,
  tweaks: McpSyncTweak[],
  ownedTweaks: McpSyncTweak[],
  preservedOptions: Readonly<PreservedMcpOptionsByServerName>,
  preservedApprovalPolicy: Readonly<PreservedApprovalPolicy> | null,
): boolean {
  let retired = listRetiredConfigs(configPath);
  if (!existsSync(configPath) && retired.length > 0) {
    const latest = [...retired].sort((left, right) =>
      right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
    )[0];
    linkSync(latest.path, configPath);
    fsyncDirectory(dirname(configPath));
  }

  retired = listRetiredConfigs(configPath);
  const changed = retired
    .filter((entry) => entry.currentFingerprint !== entry.expectedFingerprint)
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  for (const entry of changed) {
    if (!existsSync(entry.path)) continue;
    let mergedRetiredFingerprint: string | undefined;
    if (!sameInode(entry.path, configPath)) {
      if (existsSync(configPath)) {
        mergedRetiredFingerprint = mergeRetiredConfigEdit(
          configPath,
          entry,
          tweaks,
          ownedTweaks,
          preservedOptions,
          preservedApprovalPolicy,
        );
      } else {
        linkSync(entry.path, configPath);
      }
    }
    if (
      mergedRetiredFingerprint
      && fingerprint(readBytesIfExists(entry.path)) !== mergedRetiredFingerprint
    ) {
      // The retained editor wrote again while its prior save was being merged.
      // Leave the old expected fingerprint in place so the watcher imports the
      // newer save on its next pass rather than marking unseen bytes observed.
      continue;
    }
    markRetiredConfigObserved(configPath, entry);
    fsyncDirectory(dirname(configPath));
  }
  return changed.length > 0;
}

function mergeRetiredConfigEdit(
  configPath: string,
  retired: RetiredConfig,
  tweaks: McpSyncTweak[],
  ownedTweaks: McpSyncTweak[],
  preservedOptions: Readonly<PreservedMcpOptionsByServerName>,
  preservedApprovalPolicy: Readonly<PreservedApprovalPolicy> | null,
): string {
  const baselinePath = retiredBaselinePath(retired.path);
  if (!existsSync(baselinePath)) {
    throw new Error(
      `Cannot safely merge retained MCP config edit without its baseline: ${retired.path}`,
    );
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const currentBytes = readBytesIfExists(configPath);
    const currentFingerprint = fingerprint(currentBytes);
    const retiredBytes = readBytesIfExists(retired.path);
    const baselineBytes = readBytesIfExists(baselinePath);
    if (fingerprint(baselineBytes) !== retired.expectedFingerprint) {
      throw new Error(`Retained MCP config baseline does not match its receipt: ${retired.path}`);
    }

    const baselineManual = managedBlockFreeDocument(baselineBytes);
    const currentManual = managedBlockFreeDocument(currentBytes);
    const retiredManual = managedBlockFreeDocument(retiredBytes);
    const mergedManual = mergeTextDocuments(baselineManual, currentManual, retiredManual);
    const next = planMcpConfigReconciliation(tweaks, mergedManual, {
      ownedTweaks,
      preservedOptions,
      preservedApprovalPolicy,
    }).nextToml;
    const mode = statSync(configPath).mode & 0o777;
    const tempPath = writeDurableTemp(configPath, next, mode);
    try {
      if (promoteConfigWithCas(
        configPath,
        tempPath,
        currentFingerprint,
        () => undefined,
        () => undefined,
        () => undefined,
      )) {
        return fingerprint(retiredBytes);
      }
    } finally {
      rmSync(tempPath, { force: true });
    }
    if (attempt === 2) {
      throw new Error(
        "Codex config changed during retained MCP edit recovery twice; no recovery was applied",
      );
    }
  }
  throw new Error("Retained MCP config recovery ended without a merge result");
}

function recoverInterruptedCas(configPath: string): void {
  const backup = casBackupPath(configPath);
  if (!existsSync(backup)) return;
  if (!existsSync(configPath)) {
    try {
      linkSync(backup, configPath);
      fsyncDirectory(dirname(configPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  rmSync(backup, { force: true });
}

/**
 * Capture the exact old pathname, then publish with an exclusive hard link.
 * An external writer in the former read/rename window either becomes the new
 * pathname (and is replanned) or makes the link fail; it is never overwritten.
 */
function promoteConfigWithCas(
  configPath: string,
  tempPath: string,
  expectedFingerprint: string,
  afterCapture: () => void,
  beforeBackupRelease: () => void,
  afterFinalCheck: () => void,
): boolean {
  let backup: string | undefined;
  let captured = false;
  try {
    if (existsSync(configPath)) {
      captureActiveConfig(configPath);
      backup = retireCurrentConfig(configPath, expectedFingerprint);
      captured = true;
      afterCapture();
      if (fingerprint(readBytesIfExists(backup)) !== expectedFingerprint) {
        restoreCapturedConfig(backup, configPath);
        return false;
      }
    } else {
      afterCapture();
    }

    try {
      linkSync(tempPath, configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A writer recreated the path after capture. Its bytes win and the next
      // bounded attempt replans from them. The captured inode remains reachable
      // so a writer that still holds it can never write into an unlinked file.
      releaseActiveConfig(configPath);
      return false;
    }
    if (captured && backup) {
      if (restoreCapturedEditIfChanged(backup, configPath, tempPath, expectedFingerprint)) {
        return false;
      }
      beforeBackupRelease();
      if (restoreCapturedEditIfChanged(backup, configPath, tempPath, expectedFingerprint)) {
        return false;
      }
      afterFinalCheck();
    }
    // Successful captures intentionally remain as hidden hard-link recovery
    // paths. A later write through an old descriptor is watched and imported
    // on the next reconciliation instead of being discarded on an unlinked inode.
    releaseActiveConfig(configPath);
    return true;
  } catch (error) {
    if (captured && backup) {
      if (
        existsSync(configPath)
        && fingerprint(readBytesIfExists(configPath)) === fingerprint(readBytesIfExists(tempPath))
      ) {
        rmSync(configPath, { force: true });
      }
      if (!existsSync(configPath)) restoreCapturedConfig(backup, configPath);
    }
    releaseActiveConfig(configPath);
    throw error;
  }
}

function restoreCapturedEditIfChanged(
  backup: string,
  configPath: string,
  tempPath: string,
  expectedFingerprint: string,
): boolean {
  if (fingerprint(readBytesIfExists(backup)) === expectedFingerprint) return false;
  // A writer held the old inode open and changed it after pathname capture.
  // Remove only our just-linked candidate, restore/preserve external bytes,
  // and replan instead of silently discarding that edit.
  if (fingerprint(readBytesIfExists(configPath)) === fingerprint(readBytesIfExists(tempPath))) {
    rmSync(configPath, { force: true });
  }
  restoreCapturedConfig(backup, configPath);
  return true;
}

function restoreCapturedConfig(backup: string, configPath: string): void {
  let restored = false;
  try {
    linkSync(backup, configPath);
    restored = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    restored = sameInode(backup, configPath);
  } finally {
    if (restored) rmSync(backup, { force: true });
    releaseActiveConfig(configPath);
    fsyncDirectory(dirname(configPath));
  }
}

export function createMcpReconciler(
  options: McpReconcilerOptions,
  dependencies: CreateMcpReconcilerDependencies = {},
): McpReconciler {
  const debounceMs = options.debounceMs ?? 250;
  const reconcile = dependencies.reconcileConfig ?? reconcileMcpConfig;
  const pending: PendingRequest[] = [];
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let closed = false;
  let lastAppliedFingerprint: string | undefined;

  const schedule = (immediate = false): void => {
    if (closed || running || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      // Start on the next microtask so `running` is visible to requests that
      // arrive from synchronous reconciliation hooks.
      running = Promise.resolve().then(runPending).finally(() => {
        running = undefined;
        if (pending.length > 0) schedule();
      });
    }, immediate ? 0 : debounceMs);
  };

  const runPending = async (): Promise<void> => {
    // One initial pass and one rerun for events that arrive while that pass is active.
    for (let pass = 0; pass < 2 && pending.length > 0; pass += 1) {
      const batch = pending.splice(0);
      const trigger = batch[batch.length - 1]?.trigger ?? "config-change";
      try {
        const tweaks = options.getTweaks();
        const ownedTweaks = options.getOwnedTweaks?.() ?? tweaks;
        const receipt = await reconcile({
          configPath: options.configPath,
          statePath: options.statePath,
          tweaks,
          ownedTweaks,
          trigger,
        }, options.reconcileDependencies);
        lastAppliedFingerprint = receipt.afterFingerprint;
        options.onReceipt?.(receipt);
        for (const request of batch) request.resolve(receipt);
      } catch (error) {
        options.onError?.(error);
        for (const request of batch) request.reject(error);
      }
    }
  };

  const enqueue = (trigger: McpSyncTrigger, immediate: boolean): Promise<McpSyncReceipt> => {
    if (closed) return Promise.reject(new Error("MCP reconciler is closed"));
    const promise = new Promise<McpSyncReceipt>((resolve, reject) => {
      pending.push({ trigger, resolve, reject });
    });
    if (immediate && timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    schedule(immediate);
    return promise;
  };

  const onConfigChange = (changedPath?: string): void => {
    if (closed) return;
    if (changedPath && changedPath !== options.configPath) {
      void enqueue("config-change", false).catch((error) => options.onError?.(error));
      return;
    }
    const observedFingerprint = fingerprint(readBytesIfExists(options.configPath));
    if (observedFingerprint === lastAppliedFingerprint) return;
    void enqueue("config-change", false).catch((error) => options.onError?.(error));
  };

  const watchFactory = dependencies.watchConfig ?? defaultConfigWatcher;
  const watcher = options.watchConfig === false
    ? undefined
    : watchFactory(options.configPath, onConfigChange);

  return {
    request(trigger) {
      return enqueue(trigger, false);
    },
    reconcileNow(trigger) {
      return enqueue(trigger, true);
    },
    readState() {
      return readMcpSyncState(options.statePath);
    },
    async close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await watcher?.close();
      await running;
      const error = new Error("MCP reconciler closed before pending work ran");
      for (const request of pending.splice(0)) request.reject(error);
    },
  };
}

export function readMcpSyncState(statePath: string): McpSyncReceipt | null {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as McpSyncReceipt | (Omit<McpSyncReceipt, "schemaVersion" | "approvalPolicy" | "preservedApprovalPolicy"> & { schemaVersion: 1 });
    if (parsed?.schemaVersion !== 1 && parsed?.schemaVersion !== 2) return null;
    const rawOptions = (parsed as { preservedOptions?: unknown }).preservedOptions;
    const optionNames = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
      ? Object.keys(rawOptions)
      : [];
    const managedConfigurationChangedAt = normalizedTimestamp(
      (parsed as { managedConfigurationChangedAt?: unknown }).managedConfigurationChangedAt,
    ) ?? (
      parsed.restartRequired === true
        ? normalizedTimestamp(parsed.completedAt)
        : null
    );
    return {
      ...parsed,
      schemaVersion: 2,
      phase: parsed.schemaVersion === 2 && parsed.phase === "prepared" ? "prepared" : "complete",
      preservedOptions: sanitizePreservedMcpOptions(rawOptions, optionNames),
      approvalPolicy: parsed.schemaVersion === 2
        ? {
            ...emptyApprovalPolicyReconciliation(),
            ...parsed.approvalPolicy,
            sandboxModeBeforeRaw: typeof parsed.approvalPolicy?.sandboxModeBeforeRaw === "string"
              ? parsed.approvalPolicy.sandboxModeBeforeRaw
              : null,
            sandboxModeAfterRaw: typeof parsed.approvalPolicy?.sandboxModeAfterRaw === "string"
              ? parsed.approvalPolicy.sandboxModeAfterRaw
              : null,
          }
        : emptyApprovalPolicyReconciliation(),
      preservedApprovalPolicy: parsed.schemaVersion === 2
        ? sanitizePreservedApprovalPolicy(parsed.preservedApprovalPolicy)
        : null,
      managedConfigurationChangedAt,
    };
  } catch {
    return null;
  }
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readPreservedApprovalPolicy(statePath: string, configPath: string): PreservedApprovalPolicy | null {
  const state = readMcpSyncState(statePath);
  const preserved = sanitizePreservedApprovalPolicy(state?.preservedApprovalPolicy);
  if (!state || state.phase !== "prepared" || !preserved) return preserved;
  const currentFingerprint = fingerprint(readBytesIfExists(configPath));
  if (state.plannedAfterFingerprint && currentFingerprint === state.plannedAfterFingerprint) {
    return preserved;
  }
  // A prepared receipt is written before the first commit check. If the old
  // bytes are still live, or another writer produced different bytes, no
  // authoritative policy transition is proven. Replan from the current file
  // and capture its policy instead of making the tentative snapshot durable.
  return null;
}

function readPreservedOptions(
  statePath: string,
  ownedTweaks: McpSyncTweak[],
): PreservedMcpOptionsByServerName {
  const receipt = readMcpSyncState(statePath);
  return sanitizePreservedMcpOptions(
    receipt?.preservedOptions,
    ownedTweaks.map((tweak) => mcpServerNameFromTweakId(tweak.manifest.id)),
  );
}

export function fingerprint(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Stamp-immune fingerprint of a Codex config: identical to `fingerprint`
 * except app-stamped volatile `last_updated` lines are removed first. Used
 * only for the receipt's `afterFingerprintCanonical` binding; CAS/retired
 * inode naming keeps raw `fingerprint` semantics.
 */
export function canonicalConfigFingerprint(value: string | Buffer): string {
  const canonical = (typeof value === "string" ? value : value.toString("utf8"))
    .split("\n")
    .filter((line) => !/^\s*last_updated\s*=/.test(line))
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export interface PlanMcpConfigReconciliationOptions {
  ownedTweaks?: McpSyncTweak[];
  preservedOptions?: Readonly<PreservedMcpOptionsByServerName>;
  preservedApprovalPolicy?: Readonly<PreservedApprovalPolicy> | null;
}

export function planMcpConfigReconciliation(
  tweaks: McpSyncTweak[],
  currentToml: string,
  options: PlanMcpConfigReconciliationOptions = {},
): McpReconciliationPlan {
  const mcpPlan = planManagedMcpReconciliation(tweaks, currentToml, options);
  const ownedTweaks = options.ownedTweaks ?? tweaks;
  const preservedApprovalPolicy = sanitizePreservedApprovalPolicy(options.preservedApprovalPolicy);
  const approvalPolicy = ownedTweaks.some((tweak) => tweak.manifest.id === "co.tweakers.user-questions")
    ? observeUserQuestionsApprovalPolicy(currentToml, preservedApprovalPolicy)
    : mcpPlan.approvalPolicy;
  const plan: McpReconciliationPlan = {
    ...mcpPlan,
    approvalPolicy,
    preservedApprovalPolicy,
  };
  if (!mcpPlan.changed || !managedBlocksDifferOnlyByLiveRoot(currentToml, mcpPlan.nextToml, tweaks)) {
    return plan;
  }
  return {
    ...plan,
    nextToml: currentToml,
    changed: false,
    restartRequired: false,
  };
}

/**
 * Two supported Tweakers roots can be live briefly during promotion. Their MCP
 * manifests are identical, but resolved script paths differ by root. Preserve
 * the first still-live managed block instead of allowing both watchers to
 * rewrite the shared config forever. Manual TOML must remain byte-identical,
 * and every differing path must resolve beneath an existing alternate tweak
 * directory for the same canonical server.
 */
function managedBlocksDifferOnlyByLiveRoot(
  currentToml: string,
  plannedToml: string,
  tweaks: McpSyncTweak[],
): boolean {
  // stripManagedMcpBlock heals stray END markers, so a heal-only difference
  // passes the stripped comparison below. Such a document is corrupt, not a
  // live-root twin — suppressing its rewrite would plan the heal and discard
  // it forever while prove reports healthy.
  if (hasStrayManagedMcpEndMarker(currentToml)) return false;
  if (stripManagedMcpBlock(currentToml) !== stripManagedMcpBlock(plannedToml)) return false;
  const currentBlock = extractManagedBlock(currentToml);
  const plannedBlock = extractManagedBlock(plannedToml);
  if (!currentBlock || !plannedBlock) return false;

  const tweaksByServerName = new Map(
    tweaks.map((tweak) => [mcpServerNameFromTweakId(tweak.manifest.id), tweak]),
  );
  const currentLines = currentBlock.trimEnd().split(/\r?\n/);
  const plannedLines = plannedBlock.trimEnd().split(/\r?\n/);
  if (currentLines.length !== plannedLines.length) return false;

  let activeTweak: McpSyncTweak | undefined;
  let alternateTweakDir: string | undefined;
  for (let index = 0; index < plannedLines.length; index += 1) {
    const expected = plannedLines[index] ?? "";
    const observed = currentLines[index] ?? "";
    const table = /^\[mcp_servers\.([^\]]+)\]$/.exec(expected);
    if (table) {
      activeTweak = tweaksByServerName.get(table[1] ?? "");
      alternateTweakDir = undefined;
      if (!activeTweak || observed !== expected) return false;
      continue;
    }
    if (observed === expected) continue;
    if (
      !activeTweak
      || !/^(?:command|args)\s*=/.test(expected)
      || !rootAwareGeneratedLineMatches(observed, expected, activeTweak, (alternate) => {
        if (alternateTweakDir && alternateTweakDir !== alternate) return false;
        if (!alternateTweakMatches(activeTweak!, alternate)) return false;
        alternateTweakDir = alternate;
        return true;
      })
    ) {
      return false;
    }
  }
  return true;
}

function rootAwareGeneratedLineMatches(
  observedLine: string,
  expectedLine: string,
  expectedTweak: McpSyncTweak,
  acceptAlternateDir: (path: string) => boolean,
): boolean {
  const expectedTweakDir = expectedTweak.dir;
  const observed = splitJsonStringTokens(observedLine);
  const expected = splitJsonStringTokens(expectedLine);
  if (
    observed.literals.length !== expected.literals.length
    || observed.values.length !== expected.values.length
    || observed.literals.some((literal, index) => literal !== expected.literals[index])
  ) {
    return false;
  }

  for (let index = 0; index < expected.values.length; index += 1) {
    const expectedValue = expected.values[index] ?? "";
    const observedValue = observed.values[index] ?? "";
    if (expectedValue === observedValue) continue;
    if (
      !expectedValue.startsWith(`${expectedTweakDir}/`)
      || !isAbsolute(observedValue)
    ) {
      return false;
    }
    const suffix = expectedValue.slice(expectedTweakDir.length);
    if (!observedValue.endsWith(suffix)) return false;
    const alternateDir = observedValue.slice(0, -suffix.length);
    if (
      !isAbsolute(alternateDir)
      || !existsSync(alternateDir)
      || !existsSync(expectedValue)
      || !existsSync(observedValue)
      || !exactFileContentsMatch(expectedValue, observedValue)
      || !acceptAlternateDir(alternateDir)
    ) {
      return false;
    }
  }
  return true;
}

function alternateTweakMatches(expected: McpSyncTweak, alternateDir: string): boolean {
  try {
    const expectedManifestBytes = readFileSync(join(expected.dir, "manifest.json"));
    const alternateManifestBytes = readFileSync(join(alternateDir, "manifest.json"));
    if (!expectedManifestBytes.equals(alternateManifestBytes)) return false;
    const manifest = JSON.parse(alternateManifestBytes.toString("utf8")) as unknown;
    if (!isRecord(manifest) || manifest.id !== expected.manifest.id) return false;
    const expectedMcp = normalizeManifestMcp(expected.manifest.mcp);
    const alternateMcp = normalizeManifestMcp(manifest.mcp);
    return expectedMcp !== null
      && alternateMcp !== null
      && expectedMcp.command === alternateMcp.command
      && stringArraysEqual(expectedMcp.args, alternateMcp.args)
      && stringRecordsEqual(expectedMcp.env, alternateMcp.env);
  } catch {
    return false;
  }
}

function exactFileContentsMatch(expectedPath: string, observedPath: string): boolean {
  try {
    const expectedStat = statSync(expectedPath);
    const observedStat = statSync(observedPath);
    return expectedStat.isFile()
      && observedStat.isFile()
      && expectedStat.size === observedStat.size
      && readFileSync(expectedPath).equals(readFileSync(observedPath));
  } catch {
    return false;
  }
}

function normalizeManifestMcp(value: unknown): {
  command: string;
  args: string[];
  env: Record<string, string>;
} | null {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.length === 0) return null;
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))) {
    return null;
  }
  if (value.env !== undefined && (
    !isRecord(value.env)
    || Object.values(value.env).some((envValue) => typeof envValue !== "string")
  )) {
    return null;
  }
  return {
    command: value.command,
    args: value.args === undefined ? [] : value.args as string[],
    env: value.env === undefined ? {} : value.env as Record<string, string>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringRecordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => (
      key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1]
    ));
}

function splitJsonStringTokens(line: string): { literals: string[]; values: string[] } {
  const literals: string[] = [];
  const values: string[] = [];
  const pattern = /"(?:\\.|[^"\\])*"/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    literals.push(line.slice(cursor, index));
    try {
      values.push(JSON.parse(match[0]) as string);
    } catch {
      return { literals: [line], values: [] };
    }
    cursor = index + match[0].length;
  }
  literals.push(line.slice(cursor));
  return { literals, values };
}

function extractManagedBlock(document: string): string | null {
  let start: number | undefined;
  for (const line of classifyStructuralLines(document)) {
    if (!line.structural) continue;
    const marker = line.text.trim();
    if (marker === MCP_MANAGED_START) {
      if (start !== undefined) return null;
      start = line.start;
    } else if (marker === MCP_MANAGED_END) {
      if (start === undefined) return null;
      return document.slice(start, line.end);
    }
  }
  return null;
}

interface StructuralLine {
  start: number;
  end: number;
  text: string;
  structural: boolean;
}

function classifyStructuralLines(document: string): StructuralLine[] {
  const lines: StructuralLine[] = [];
  let lineStart = 0;
  let multiline: "basic" | "literal" | null = null;
  let quote: "basic" | "literal" | null = null;
  let escaped = false;
  let comment = false;
  const push = (end: number): void => {
    lines.push({
      start: lineStart,
      end,
      text: document.slice(lineStart, end).replace(/[\r\n]+$/, ""),
      structural: multiline === null,
    });
    lineStart = end;
  };

  for (let index = 0; index < document.length; index += 1) {
    const character = document[index] ?? "";
    const triple = document.slice(index, index + 3);
    if (multiline) {
      const delimiter = multiline === "basic" ? '\"\"\"' : "'''";
      if (!escaped && triple === delimiter) {
        multiline = null;
        index += 2;
        continue;
      }
      if (character === "\n" || character === "\r") {
        if (character === "\r" && document[index + 1] === "\n") index += 1;
        push(index + 1);
      }
      if (multiline === "basic") {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
      }
      continue;
    }
    if (comment) {
      if (character === "\n" || character === "\r") {
        if (character === "\r" && document[index + 1] === "\n") index += 1;
        push(index + 1);
        comment = false;
      }
      continue;
    }
    if (quote) {
      if (quote === "basic") {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '\"') quote = null;
      } else if (character === "'") quote = null;
      continue;
    }
    if (character === "#") {
      comment = true;
      continue;
    }
    if (triple === '\"\"\"' || triple === "'''") {
      multiline = triple === '\"\"\"' ? "basic" : "literal";
      escaped = false;
      index += 2;
      continue;
    }
    if (character === '\"' || character === "'") {
      quote = character === '\"' ? "basic" : "literal";
      escaped = false;
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && document[index + 1] === "\n") index += 1;
      push(index + 1);
    }
  }
  if (lineStart < document.length || document.length === 0) push(document.length);
  return lines;
}

function managedBlockFreeDocument(value: Buffer): string {
  const document = decodeToml(value);
  return planManagedMcpReconciliation([], document).nextToml;
}

interface TextChange {
  start: number;
  end: number;
  replacement: string[];
  source: "current" | "retired";
}

function mergeTextDocuments(baseline: string, current: string, retired: string): string {
  if (retired === baseline || retired === current) return current;
  if (current === baseline) return retired;
  const baseLines = splitLines(baseline);
  const currentChanges = diffLineChanges(baseLines, splitLines(current), "current");
  const retiredChanges = diffLineChanges(baseLines, splitLines(retired), "retired");

  for (const left of currentChanges) {
    for (const right of retiredChanges) {
      const same = left.start === right.start
        && left.end === right.end
        && arraysEqual(left.replacement, right.replacement);
      if (same) continue;
      const bothInsert = left.start === left.end
        && right.start === right.end
        && left.start === right.start;
      if (bothInsert) continue;
      if (!(left.end <= right.start || right.end <= left.start)) {
        throw new Error(
          "Retained MCP config edit conflicts with a newer current edit; both files were preserved",
        );
      }
    }
  }

  const combined = [...currentChanges, ...retiredChanges]
    .filter((change, index, all) => !all.slice(0, index).some((previous) => (
      previous.start === change.start
      && previous.end === change.end
      && arraysEqual(previous.replacement, change.replacement)
    )))
    .sort((left, right) => (
      left.start - right.start
      || left.end - right.end
      || (left.source === right.source ? 0 : left.source === "current" ? -1 : 1)
    ));
  const result: string[] = [];
  let cursor = 0;
  for (const change of combined) {
    result.push(...baseLines.slice(cursor, change.start), ...change.replacement);
    cursor = Math.max(cursor, change.end);
  }
  result.push(...baseLines.slice(cursor));
  return result.join("");
}

function splitLines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function diffLineChanges(
  baseline: string[],
  variant: string[],
  source: TextChange["source"],
): TextChange[] {
  const cells = (baseline.length + 1) * (variant.length + 1);
  if (cells > 4_000_000) {
    throw new Error("Retained MCP config edit is too large to merge safely; both files were preserved");
  }
  const width = variant.length + 1;
  const lcs = new Uint32Array(cells);
  for (let left = baseline.length - 1; left >= 0; left -= 1) {
    for (let right = variant.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      lcs[index] = baseline[left] === variant[right]
        ? 1 + lcs[(left + 1) * width + right + 1]!
        : Math.max(lcs[(left + 1) * width + right]!, lcs[left * width + right + 1]!);
    }
  }

  const changes: TextChange[] = [];
  let left = 0;
  let right = 0;
  while (left < baseline.length || right < variant.length) {
    if (left < baseline.length && right < variant.length && baseline[left] === variant[right]) {
      left += 1;
      right += 1;
      continue;
    }
    const start = left;
    const replacement: string[] = [];
    while (
      left < baseline.length || right < variant.length
    ) {
      if (left < baseline.length && right < variant.length && baseline[left] === variant[right]) break;
      const insertScore = right < variant.length ? lcs[left * width + right + 1]! : -1;
      const deleteScore = left < baseline.length ? lcs[(left + 1) * width + right]! : -1;
      if (right < variant.length && insertScore >= deleteScore) {
        replacement.push(variant[right]!);
        right += 1;
      } else {
        left += 1;
      }
    }
    changes.push({ start, end: left, replacement, source });
  }
  return changes;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function emptyReconciliationPlan(): McpReconciliationPlan {
  return {
    nextToml: "",
    desiredNames: [],
    appliedNames: [],
    migrations: [],
    conflicts: [],
    preservedOptions: {},
    approvalPolicy: emptyApprovalPolicyReconciliation(),
    preservedApprovalPolicy: null,
    changed: false,
    restartRequired: false,
  };
}

function replanAfterConcurrentEdit({
  attempt,
  observed,
  tweaks,
  ownedTweaks,
  preservedOptions,
  preservedApprovalPolicy,
}: {
  attempt: number;
  observed: Buffer;
  tweaks: McpSyncTweak[];
  ownedTweaks: McpSyncTweak[];
  preservedOptions: Readonly<PreservedMcpOptionsByServerName>;
  preservedApprovalPolicy: Readonly<PreservedApprovalPolicy> | null;
}): {
  beforeBytes: Buffer;
  before: string;
  beforeFingerprint: string;
  plan: McpReconciliationPlan;
} {
  if (attempt === 2) {
    throw new Error("Codex config changed during MCP reconciliation twice; no changes were applied");
  }
  const before = decodeToml(observed);
  return {
    beforeBytes: observed,
    before,
    beforeFingerprint: fingerprint(observed),
    plan: planMcpConfigReconciliation(tweaks, before, {
      ownedTweaks,
      preservedOptions,
      preservedApprovalPolicy,
    }),
  };
}

function emptyApprovalPolicyReconciliation(): ApprovalPolicyReconciliation {
  return {
    status: "unchanged",
    beforeRaw: null,
    afterRaw: null,
    preservedOriginalRaw: null,
    preservedOriginalPresent: false,
    sandboxModeBeforeRaw: null,
    sandboxModeAfterRaw: null,
    restartRequired: false,
  };
}

function hasPlanConflict(plan: McpReconciliationPlan): boolean {
  return plan.conflicts.length > 0 || plan.approvalPolicy.status === "conflict";
}

function readBytesIfExists(path: string): Buffer {
  return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
}

function decodeToml(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("Malformed TOML: config.toml is not valid UTF-8");
  }
}

function writeReceipt(statePath: string, receipt: McpSyncReceipt): void {
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  const tempPath = writeDurableTemp(statePath, content, 0o600);
  try {
    renameSync(tempPath, statePath);
    fsyncDirectory(dirname(statePath));
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function writeDurableTemp(destination: string, content: string | Buffer, mode: number): string {
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = openSync(tempPath, "wx", mode);
  let completed = false;
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    completed = true;
  } finally {
    closeSync(descriptor);
    if (!completed) rmSync(tempPath, { force: true });
  }
  return tempPath;
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some supported filesystems do not allow directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function defaultConfigWatcher(
  configPath: string,
  onChange: (changedPath?: string) => void,
): McpConfigWatchHandle {
  // Keep reconciliation importable by the headless environment transaction
  // helper without loading the watcher dependency. The desktop reconciler is
  // the only caller that reaches this branch.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const chokidar = require("chokidar") as typeof import("chokidar").default;
  const watcher = chokidar.watch(dirname(configPath), {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 25,
    },
  });
  const handlePath = (changedPath: string): void => {
    if (changedPath === configPath) {
      onChange(changedPath);
      return;
    }
    const retired = listRetiredConfigs(configPath).find((entry) => entry.path === changedPath);
    if (retired && retired.currentFingerprint !== retired.expectedFingerprint) {
      onChange(changedPath);
    }
  };
  watcher.on("add", handlePath);
  watcher.on("change", handlePath);
  watcher.on("unlink", handlePath);
  return watcher;
}
