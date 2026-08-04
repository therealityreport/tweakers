import kleur from "kleur";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chownSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  MCP_LIFECYCLE_LABELS,
  defaultMcpLifecycleSourceRoot,
  installMcpLifecyclePackage,
  verifyMcpLifecyclePackage,
  type McpLifecycleInstallResult,
  type McpLifecycleInstallStep,
  type McpLifecycleResolvedAsset,
  type McpLifecycleVerification,
} from "../mcp-lifecycle-install.js";
import {
  inspectMcpLifecycleHealth,
  type McpLifecycleHealthReport,
} from "../mcp-lifecycle-health.js";
import { targetUserHome, targetUserOwnership } from "../ownership.js";
import { userPaths } from "../paths.js";
import { assertLifecycleReceiptsIdle, lifecycleLockFile, withLifecycleLock } from "../lifecycle-lock.js";

export type McpLifecycleAction = "status" | "preview" | "repair" | "adopt";

export interface McpLifecycleCommandOptions {
  apply?: boolean;
  deep?: boolean;
  json?: boolean;
  source?: string;
}

export interface McpLifecycleRepairDependencies {
  install?: typeof installMcpLifecyclePackage;
  inspect?: typeof inspectMcpLifecycleHealth;
  labelInstances?: (label: string) => number | undefined;
  reload?: (
    targetHome: string,
    labels: readonly string[],
    beforeEach?: (label: string) => void,
  ) => void;
  now?: () => Date;
  writeReceipt?: (path: string, value: object) => void;
  /** Test-only seam run immediately before the guarded package install step. */
  beforeInstallStep?: (step: McpLifecycleInstallStep, asset: McpLifecycleResolvedAsset) => void;
  lifecycleJob?: string | undefined;
}

export interface McpLifecycleRepairResult {
  status: "installed" | "unchanged" | "deferred" | "preview";
  report: McpLifecycleHealthReport;
  installResult?: McpLifecycleInstallResult;
  receiptPath?: string;
  reason?: string;
}

interface ManagedMcpLifecycleReceipt {
  schemaVersion: 1;
  packageVersion: string;
  lifecycleSchemaVersion: number;
  policyVersion: string;
  matcherRegistryVersion: string;
  labels: string[];
  assetDigests: Record<string, string>;
  adoptedAt: string;
  compatibility: "current labels and paths preserved; rename deferred";
}

/**
 * Explicitly named compatibility boundary for the only v2 receipt that may be
 * promoted by `mcp-lifecycle adopt --apply`.  This is deliberately not a
 * version range: an otherwise well-formed receipt must not confer mutation
 * authority unless it identifies the known predecessor package byte-for-byte.
 */
const ADOPTABLE_PREDECESSOR_RECEIPTS = [{
  packageVersion: "0.2.1",
  lifecycleSchemaVersion: 2,
  policyVersion: "strict-detached-v2",
  matcherRegistryVersion: "mcp-family-descriptors-v1",
  labels: [...MCP_LIFECYCLE_LABELS],
  assetDigests: {
    "lifecycle-module": "ea11134783f411b3a88880f2eec61e4012cfa7c378ebf1f81f89d233c82ab81b",
    "idle-reaper": "2bbb4ce35ff8b7687a6c4d35f9014c4d8dcfcfeac27943955f5b1c28681ce107",
    guard: "4d152c788759395bde1296e8197fb91a8187d480e0192fa3aa7f0f155e3185ed",
    "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
    "guard-launch-agent": "56c8127ff1b2adf539b2bff14df5c5dee2ae92481306c808366498353ddbb43c",
  },
  compatibility: "current labels and paths preserved; rename deferred",
}, {
  packageVersion: "0.3.0",
  lifecycleSchemaVersion: 2,
  policyVersion: "strict-detached-v3",
  matcherRegistryVersion: "mcp-family-descriptors-v2",
  labels: [...MCP_LIFECYCLE_LABELS],
  assetDigests: {
    "lifecycle-module": "6e3f830ffda5d476bebf4900f6d9add274d2a2893c0e1cf6b02c0f3f4b2eadb3",
    "idle-reaper": "963cf893e0832706662ad04d1d297c15ccc4e03358c70e1ca4522892e3f73999",
    guard: "b32d7583b43ef1c1119bba2dc3cc6a2a42c79e8a6cd404a5c26592f4d8f98c58",
    "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
    "guard-launch-agent": "56c8127ff1b2adf539b2bff14df5c5dee2ae92481306c808366498353ddbb43c",
  },
  compatibility: "current labels and paths preserved; rename deferred",
}, {
  packageVersion: "0.3.1",
  lifecycleSchemaVersion: 2,
  policyVersion: "strict-detached-v3",
  matcherRegistryVersion: "mcp-family-descriptors-v3",
  labels: [...MCP_LIFECYCLE_LABELS],
  assetDigests: {
    "lifecycle-module": "90669677b9d694290c33ce4b18d6547a50afd464bce1d95367dbb28b3a7ba946",
    "idle-reaper": "963cf893e0832706662ad04d1d297c15ccc4e03358c70e1ca4522892e3f73999",
    guard: "59b0c1d7e78fe978f74734f0f231a4b4c80f1366dfcafd637e07abffc14617bb",
    "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
    "guard-launch-agent": "56c8127ff1b2adf539b2bff14df5c5dee2ae92481306c808366498353ddbb43c",
  },
  compatibility: "current labels and paths preserved; rename deferred",
}] as const;

export async function mcpLifecycle(
  action: string,
  options: McpLifecycleCommandOptions = {},
): Promise<void> {
  if (!["status", "preview", "repair", "adopt"].includes(action)) {
    throw new Error("Usage: tweaker mcp-lifecycle <status|preview|repair|adopt>");
  }
  const paths = userPaths();
  const targetHome = targetUserHome();
  const sourceRoot = options.source ?? defaultMcpLifecycleSourceRoot();
  const report = inspectMcpLifecycleHealth({
    targetHome,
    sourceRoot,
    backupRoot: join(paths.backup, "mcp-lifecycle"),
    managedReceiptPath: join(paths.root, "mcp-lifecycle-managed.json"),
    deep: options.deep === true || action !== "status",
  });

  if (action === "status") {
    printResult({ status: report.status === "error" ? "deferred" : "unchanged", report }, options.json, action);
    return;
  }
  if (action === "preview" || options.apply !== true) {
    if (action === "adopt") assertAdoptableManagedReceipt(readManagedReceipt(join(paths.root, "mcp-lifecycle-managed.json")));
    printResult({ status: "preview", report }, options.json, action);
    return;
  }

  if (action === "adopt") {
    const result = await withLifecycleLock(lifecycleLockFile(paths.root), "MCP lifecycle adoption", async () => {
      assertLifecycleReceiptsIdle(paths.root);
      return adoptMcpLifecycle({ targetHome, userRoot: paths.root, sourceRoot, report });
    });
    printResult(result, options.json, action);
    return;
  }
  const result = repairMcpLifecycle({
    targetHome,
    userRoot: paths.root,
    sourceRoot,
    report,
  });
  printResult(result, options.json, action);
}

export function repairMcpLifecycle(
  input: {
    targetHome: string;
    userRoot: string;
    sourceRoot?: string;
    report?: McpLifecycleHealthReport;
    /** Automatic reconciliation must retain its proven managed receipt through every live mutation. */
    requireManagedProof?: boolean;
    /** Explicit human-requested upgrade from a valid schema-1 prior receipt only. */
    allowPriorManagedReceipt?: boolean;
  },
  dependencies: McpLifecycleRepairDependencies = {},
): McpLifecycleRepairResult {
  const lifecycleJob = dependencies.lifecycleJob ?? process.env.TWEAKERS_MCP_LIFECYCLE_JOB;
  if (lifecycleJob) {
    throw new Error(`Refusing to reload MCP lifecycle jobs from inside ${lifecycleJob}.`);
  }
  const inspect = dependencies.inspect ?? inspectMcpLifecycleHealth;
  const sourceRoot = input.sourceRoot ?? defaultMcpLifecycleSourceRoot();
  const report = input.report ?? inspect({
    targetHome: input.targetHome,
    sourceRoot,
    backupRoot: join(input.userRoot, "backup", "mcp-lifecycle"),
    managedReceiptPath: join(input.userRoot, "mcp-lifecycle-managed.json"),
    deep: true,
  });
  const managedProofReason = managedProofDeferral(report, input.requireManagedProof === true, input.allowPriorManagedReceipt === true);
  if (managedProofReason) {
    return {
      status: "deferred",
      report,
      reason: managedProofReason,
    };
  }
  if (!report.preview.reloadEligible) {
    return {
      status: "deferred",
      report,
      reason: report.preview.reloadDeferredReason ?? "lifecycle reload precondition failed",
    };
  }

  const labelInstances = dependencies.labelInstances ?? launchdLabelInstances;
  const reload = dependencies.reload ?? reloadLifecycleLabels;
  const install = dependencies.install ?? installMcpLifecyclePackage;
  const receiptPath = join(input.userRoot, "mcp-lifecycle-managed.json");
  // Freeze the verified package once.  Every live-mutation gate compares the
  // source again to this proof, but the receipt is always derived from these
  // already verified bytes rather than a later manifest read.
  const candidate = freezeMcpLifecycleCandidate(sourceRoot, input.targetHome);
  // Keep an identity-bound copy of the prior proof.  Matching bytes alone are
  // not enough: a replacement file can retain the same JSON while changing
  // ownership or traversing a symlink between validation and activation.
  let priorReceipt = existsSync(receiptPath) ? captureManagedReceipt(receiptPath) : null;
  let receiptRollbackPath: string | null = null;
  if (priorReceipt !== null) readManagedReceipt(receiptPath);
  const assertPriorReceiptUnchanged = (): void => {
    if (priorReceipt === null) {
      try {
        lstatSync(receiptPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("MCP lifecycle managed receipt changed during promotion.");
      }
      throw new Error("MCP lifecycle managed receipt changed during promotion.");
    }
    let current: ManagedReceiptSnapshot;
    try {
      current = captureManagedReceipt(receiptPath);
    } catch {
      throw new Error("MCP lifecycle managed receipt changed during promotion.");
    }
    if (
      current.dev !== priorReceipt.dev
      || current.ino !== priorReceipt.ino
      || current.uid !== priorReceipt.uid
      || current.gid !== priorReceipt.gid
      || current.nlink !== priorReceipt.nlink
      || current.mode !== priorReceipt.mode
      || !current.bytes.equals(priorReceipt.bytes)
    ) {
      throw new Error("MCP lifecycle managed receipt changed during promotion.");
    }
  };
  const restorePriorReceipt = (): void => {
    if (priorReceipt === null) {
      try {
        unlinkSync(receiptPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    if (receiptRollbackPath !== null) {
      try {
        unlinkSync(receiptPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      renameSync(receiptRollbackPath, receiptPath);
      receiptRollbackPath = null;
      priorReceipt = captureManagedReceipt(receiptPath);
      assertPriorReceiptUnchanged();
      return;
    }
    restoreManagedReceipt(receiptPath, priorReceipt);
    priorReceipt = captureManagedReceipt(receiptPath);
    assertPriorReceiptUnchanged();
  };
  const writeReceipt = dependencies.writeReceipt ?? writePrivateJsonAtomically;
  const writeCurrentReceipt = (): void => {
    assertPriorReceiptUnchanged();
    assertMcpLifecycleCandidateUnchanged(candidate);
    const installed = inspectLatest();
    if (installed.checks.some((check) => check.id.startsWith("asset:") && check.status !== "ok")) {
      throw new Error("MCP lifecycle installed-asset proof failed before receipt publication.");
    }
    if (!installed.preview.reloadEligible) {
      throw new Error(`MCP lifecycle receipt publication deferred: ${installed.preview.reloadDeferredReason ?? "reload is not eligible"}`);
    }
    for (const label of MCP_LIFECYCLE_LABELS) {
      if (labelInstances(label) !== 1) throw new Error(`Expected exactly one loaded ${label} before receipt publication.`);
    }
    // Re-prove both the canonical package and installed destinations at the
    // final commit point.  This closes source/destination swaps that occur
    // after reload verification but before the new receipt is published.
    assertInstalledAssetsMatch(candidate);
    assertPriorReceiptUnchanged();
    // Preserve the original inode until the new receipt has been committed.
    // That lets a writer which commits and then throws be rolled back exactly,
    // not merely reconstructed with equivalent JSON bytes.
    if (priorReceipt !== null) {
      receiptRollbackPath = `${receiptPath}.rollback-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      renameSync(receiptPath, receiptRollbackPath);
    }
    writeReceipt(receiptPath, {
      schemaVersion: 1, packageVersion: candidate.verification.manifest.package.version,
      lifecycleSchemaVersion: candidate.verification.manifest.lifecycle_schema_version,
      policyVersion: candidate.verification.manifest.policy_version,
      matcherRegistryVersion: candidate.verification.manifest.matcher_registry_version,
      labels: MCP_LIFECYCLE_LABELS,
      assetDigests: Object.fromEntries(candidate.verification.manifest.assets.map((asset) => [asset.id, asset.source_sha256])),
      adoptedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      compatibility: "current labels and paths preserved; rename deferred",
    });
    // A callback that claims to publish the receipt must leave a fresh safe
    // receipt behind.  This also prevents us from discarding the rollback
    // inode if a custom writer returns without committing anything.
    readManagedReceipt(receiptPath);
    if (receiptRollbackPath !== null) {
      unlinkSync(receiptRollbackPath);
      receiptRollbackPath = null;
    }
  };
  const inspectLatest = (): McpLifecycleHealthReport => inspect({
    targetHome: input.targetHome,
    sourceRoot,
    backupRoot: join(input.userRoot, "backup", "mcp-lifecycle"),
    managedReceiptPath: join(input.userRoot, "mcp-lifecycle-managed.json"),
    deep: true,
  });
  const assertReloadStillEligible = (): void => {
    assertPriorReceiptUnchanged();
    assertMcpLifecycleCandidateUnchanged(candidate);
    if (input.allowPriorManagedReceipt) readManagedReceipt(join(input.userRoot, "mcp-lifecycle-managed.json"));
    const latest = inspectLatest();
    const latestProofReason = managedProofDeferral(latest, input.requireManagedProof === true, input.allowPriorManagedReceipt === true);
    if (latestProofReason) {
      throw new Error(`MCP lifecycle reload deferred: ${latestProofReason}`);
    }
    if (!latest.preview.reloadEligible) {
      throw new Error(
        `MCP lifecycle reload deferred: ${latest.preview.reloadDeferredReason ?? "status is not safely reloadable"}`,
      );
    }
  };
  const reloadAndVerify = (markActivationAttempted?: () => void): void => {
    assertReloadStillEligible();
    let activationMarked = false;
    reload(input.targetHome, MCP_LIFECYCLE_LABELS, () => {
      assertReloadStillEligible();
      if (!activationMarked) {
        markActivationAttempted?.();
        activationMarked = true;
      }
    });
    for (const label of MCP_LIFECYCLE_LABELS) {
      const count = labelInstances(label);
      if (count !== 1) throw new Error(`Expected exactly one loaded ${label}; observed ${String(count)}.`);
    }
  };
  const installResult = install({
    sourceRoot,
    verifiedCandidate: candidate.verification,
    targetHome: input.targetHome,
    temporaryRoot: join(input.targetHome, ".codex", "tmp"),
    labelInstances,
    beforeStep: (step, asset) => {
      dependencies.beforeInstallStep?.(step, asset);
      // Adoption is explicit, but never grants a stale or replaced receipt or
      // canonical package permission to mutate the managed paths.
      assertPriorReceiptUnchanged();
      if (input.allowPriorManagedReceipt) readManagedReceipt(receiptPath);
      assertMcpLifecycleCandidateUnchanged(candidate);
    },
    finalize: () => writeCurrentReceipt(),
    rollbackFinalization: () => restorePriorReceipt(),
    activeTermination: () => {
      assertMcpLifecycleCandidateUnchanged(candidate);
      const latest = inspectLatest();
      const latestProofReason = managedProofDeferral(latest, input.requireManagedProof === true, input.allowPriorManagedReceipt === true);
      if (latestProofReason) return { detail: latestProofReason };
      return latest.preview.reloadEligible
        ? lifecycleTermination(latest)
        : {
            detail: latest.preview.reloadDeferredReason
              ?? "lifecycle status is not safely reloadable",
          };
    },
    afterPromotion: (_assets, markActivationAttempted) => {
      reloadAndVerify(markActivationAttempted);
    },
    afterRollback: () => {
      reloadAndVerify();
    },
  });
  if (installResult.status === "deferred") {
    return { status: "deferred", report, installResult, reason: installResult.reason };
  }
  if (installResult.status === "unchanged") {
    const missingJob = MCP_LIFECYCLE_LABELS.some((label) => labelInstances(label) !== 1);
    if (missingJob) reloadAndVerify();
  }
  return {
    status: installResult.status,
    report,
    installResult,
    receiptPath,
  };
}

export function adoptMcpLifecycle(
  input: { targetHome: string; userRoot: string; sourceRoot?: string; report?: McpLifecycleHealthReport },
  dependencies: McpLifecycleRepairDependencies = {},
): McpLifecycleRepairResult {
  // A readable schema-1 receipt is the explicit adoption boundary; malformed
  // or absent receipts never receive the managed-proof exception.
  const receiptPath = join(input.userRoot, "mcp-lifecycle-managed.json");
  assertAdoptableManagedReceipt(readManagedReceipt(receiptPath));
  return repairMcpLifecycle({ ...input, allowPriorManagedReceipt: true }, dependencies);
}

export function reconcileAdoptedMcpLifecycle(
  input: {
    targetHome: string;
    userRoot: string;
  },
  dependencies: McpLifecycleRepairDependencies = {},
): McpLifecycleRepairResult | null {
  const receiptPath = join(input.userRoot, "mcp-lifecycle-managed.json");
  const receipt = readManagedReceipt(receiptPath);
  if (!receipt) return null;
  if (
    receipt.labels.length !== MCP_LIFECYCLE_LABELS.length
    || receipt.labels.some((label, index) => label !== MCP_LIFECYCLE_LABELS[index])
  ) {
    throw new Error("Managed MCP lifecycle receipt has unexpected launchd labels.");
  }
  const inspect = dependencies.inspect ?? inspectMcpLifecycleHealth;
  const report = inspect({
    targetHome: input.targetHome,
    backupRoot: join(input.userRoot, "backup", "mcp-lifecycle"),
    managedReceiptPath: receiptPath,
    deep: true,
  });
  const managedProof = report.checks.find((item) => item.id === "managed-proof");
  if (managedProof?.status !== "ok") {
    return {
      status: "deferred",
      report,
      reason: managedProof?.detail ?? "managed artifact proof is unavailable",
    };
  }
  return repairMcpLifecycle({ ...input, report, requireManagedProof: true }, dependencies);
}

function managedProofDeferral(
  report: McpLifecycleHealthReport,
  requireManagedProof: boolean,
  allowPriorManagedReceipt = false,
): string | null {
  const proof = report.checks.find((item) => item.id === "managed-proof");
  if (proof?.status === "error" && !allowPriorManagedReceipt) return proof.detail;
  if (requireManagedProof && proof?.status !== "ok") {
    return proof?.detail ?? "managed artifact proof is unavailable";
  }
  return null;
}

function matchesAdoptablePredecessor(
  receipt: ManagedMcpLifecycleReceipt,
  contract: typeof ADOPTABLE_PREDECESSOR_RECEIPTS[number],
): boolean {
  if (
    receipt.packageVersion !== contract.packageVersion
    || receipt.lifecycleSchemaVersion !== contract.lifecycleSchemaVersion
    || receipt.policyVersion !== contract.policyVersion
    || receipt.matcherRegistryVersion !== contract.matcherRegistryVersion
    || receipt.compatibility !== contract.compatibility
    || receipt.labels.length !== contract.labels.length
    || receipt.labels.some((label, index) => label !== contract.labels[index])
  ) return false;
  const digestEntries = Object.entries(receipt.assetDigests);
  return digestEntries.length === Object.keys(contract.assetDigests).length
    && digestEntries.every(([id, digest]) => contract.assetDigests[id as keyof typeof contract.assetDigests] === digest);
}

function assertAdoptableManagedReceipt(receipt: ManagedMcpLifecycleReceipt | null): asserts receipt is ManagedMcpLifecycleReceipt {
  if (!receipt) throw new Error("Managed MCP lifecycle receipt is required for adoption.");
  if (receipt.labels.length !== MCP_LIFECYCLE_LABELS.length
    || receipt.labels.some((label, index) => label !== MCP_LIFECYCLE_LABELS[index])) {
    throw new Error("Managed MCP lifecycle receipt has unexpected launchd labels.");
  }
  if (!ADOPTABLE_PREDECESSOR_RECEIPTS.some((contract) => matchesAdoptablePredecessor(receipt, contract))) {
    throw new Error("Managed MCP lifecycle receipt is not an exact recognized predecessor.");
  }
}

function lifecycleTermination(
  report: McpLifecycleHealthReport,
): { detail: string } | null {
  if (report.preview.reloadDeferredReason?.includes("terminating")) {
    return { detail: report.preview.reloadDeferredReason };
  }
  return null;
}

function launchdLabelInstances(label: string): number | undefined {
  if (process.platform !== "darwin") return undefined;
  const owner = targetUserOwnership();
  const uid = owner?.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (uid === null) return undefined;
  const result = spawnSync("launchctl", ["print", `gui/${uid}/${label}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  return result.status === 0 ? 1 : 0;
}

function reloadLifecycleLabels(
  targetHome: string,
  labels: readonly string[],
  beforeEach?: (label: string) => void,
): void {
  if (process.platform !== "darwin") throw new Error("MCP lifecycle service reload is currently supported only on macOS.");
  const owner = targetUserOwnership();
  const uid = owner?.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (uid === null) throw new Error("Could not resolve the target launchd user.");
  const domain = `gui/${uid}`;
  for (const label of labels) {
    beforeEach?.(label);
    try {
      execFileSync("launchctl", ["bootout", `${domain}/${label}`], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {
      // First install has no loaded job to boot out.
    }
    execFileSync(
      "launchctl",
      ["bootstrap", domain, join(targetHome, "Library", "LaunchAgents", `${label}.plist`)],
      { stdio: "ignore", timeout: 10_000 },
    );
  }
}

function writePrivateJsonAtomically(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

interface ManagedReceiptSnapshot {
  bytes: Buffer;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  nlink: number;
  mode: number;
}

function captureManagedReceipt(path: string): ManagedReceiptSnapshot {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    assertSafeReceiptStat(before);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    assertSafeReceiptStat(after);
    if (
      Number(before.dev) !== Number(after.dev) || Number(before.ino) !== Number(after.ino)
      || Number(before.uid) !== Number(after.uid) || Number(before.gid) !== Number(after.gid)
      || Number(before.nlink) !== Number(after.nlink) || Number(before.size) !== Number(after.size)
      || (Number(before.mode) & 0o777) !== (Number(after.mode) & 0o777)
      || bytes.length !== Number(after.size)
    ) {
      throw new Error("receipt changed while it was being read");
    }
    return {
      bytes,
      dev: Number(after.dev),
      ino: Number(after.ino),
      uid: Number(after.uid),
      gid: Number(after.gid),
      nlink: Number(after.nlink),
      mode: Number(after.mode) & 0o777,
    };
  } finally {
    closeSync(fd);
  }
}

function assertSafeReceiptStat(stat: ReturnType<typeof fstatSync>): void {
  const owner = targetUserOwnership();
  if (
    !stat.isFile()
    || Number(stat.nlink) !== 1
    || Number(stat.size) > 64 * 1024
    || (Number(stat.mode) & 0o777) !== 0o600
    || (owner !== null && (Number(stat.uid) !== owner.uid || Number(stat.gid) !== owner.gid))
  ) {
    throw new Error("receipt is not a private regular file");
  }
}

interface McpLifecycleCandidate {
  verification: McpLifecycleVerification;
  fingerprint: string;
  targetHome: string;
}

function freezeMcpLifecycleCandidate(sourceRoot: string, targetHome: string): McpLifecycleCandidate {
  const verification = verifyMcpLifecyclePackage({ sourceRoot, targetHome });
  return { verification, fingerprint: mcpLifecycleCandidateFingerprint(verification), targetHome };
}

function assertMcpLifecycleCandidateUnchanged(candidate: McpLifecycleCandidate): void {
  const observed = verifyMcpLifecyclePackage({
    sourceRoot: candidate.verification.sourceRoot,
    targetHome: candidate.targetHome,
  });
  if (mcpLifecycleCandidateFingerprint(observed) !== candidate.fingerprint) {
    throw new Error("MCP lifecycle canonical package changed during promotion.");
  }
}

function mcpLifecycleCandidateFingerprint(verification: McpLifecycleVerification): string {
  const digest = createHash("sha256");
  digest.update(JSON.stringify(verification.manifest));
  for (const asset of verification.assets) {
    digest.update("\0");
    digest.update(asset.asset.id);
    digest.update("\0");
    digest.update(asset.destinationPath);
    digest.update("\0");
    digest.update(String(asset.mode));
    digest.update("\0");
    digest.update(asset.content);
  }
  return digest.digest("hex");
}

function assertInstalledAssetsMatch(candidate: McpLifecycleCandidate): void {
  for (const asset of candidate.verification.assets) {
    let fd: number | null = null;
    try {
      fd = openSync(asset.destinationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(fd);
      assertSafeInstalledAssetStat(before, asset.mode);
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      assertSafeInstalledAssetStat(after, asset.mode);
      if (
        Number(before.dev) !== Number(after.dev) || Number(before.ino) !== Number(after.ino)
        || Number(before.uid) !== Number(after.uid) || Number(before.gid) !== Number(after.gid)
        || Number(before.nlink) !== Number(after.nlink) || Number(before.size) !== Number(after.size)
        || (Number(before.mode) & 0o777) !== (Number(after.mode) & 0o777)
        || bytes.length !== Number(after.size) || !bytes.equals(asset.content)
      ) throw new Error("installed asset changed while it was being read");
    } catch {
      throw new Error(`MCP lifecycle installed-asset proof failed before receipt publication: ${asset.asset.id}.`);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}

function assertSafeInstalledAssetStat(stat: ReturnType<typeof fstatSync>, expectedMode: number): void {
  const owner = targetUserOwnership();
  if (
    !stat.isFile()
    || Number(stat.nlink) !== 1
    || (Number(stat.mode) & 0o777) !== expectedMode
    || (owner !== null && (Number(stat.uid) !== owner.uid || Number(stat.gid) !== owner.gid))
  ) throw new Error("installed asset is not a private regular file");
}

function restoreManagedReceipt(path: string, snapshot: ManagedReceiptSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.restore-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temporary, "wx", snapshot.mode);
  try {
    writeFileSync(fd, snapshot.bytes);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(temporary, snapshot.mode);
    chownSync(temporary, snapshot.uid, snapshot.gid);
    renameSync(temporary, path);
    const restored = captureManagedReceipt(path);
    if (
      restored.uid !== snapshot.uid
      || restored.gid !== snapshot.gid
      || restored.mode !== snapshot.mode
      || !restored.bytes.equals(snapshot.bytes)
    ) {
      throw new Error("restored managed receipt does not match the prior proof");
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* cleanup only */ }
    throw error;
  }
}

function readManagedReceipt(path: string): ManagedMcpLifecycleReceipt | null {
  if (!existsSync(path)) return null;
  try {
    const snapshot = captureManagedReceipt(path);
    const value = JSON.parse(snapshot.bytes.toString("utf8")) as Partial<ManagedMcpLifecycleReceipt>;
    if (
      value.schemaVersion !== 1
      || typeof value.packageVersion !== "string"
      || typeof value.lifecycleSchemaVersion !== "number"
      || typeof value.policyVersion !== "string"
      || typeof value.matcherRegistryVersion !== "string"
      || !Array.isArray(value.labels)
      || !value.labels.every((label) => typeof label === "string")
      || !value.assetDigests
      || typeof value.assetDigests !== "object"
      || Array.isArray(value.assetDigests)
      || !Object.values(value.assetDigests).every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))
      || Object.keys(value.assetDigests).length !== 5
      || typeof value.adoptedAt !== "string"
      || !Number.isFinite(Date.parse(value.adoptedAt))
      || value.compatibility !== "current labels and paths preserved; rename deferred"
    ) {
      throw new Error("invalid receipt");
    }
    return value as ManagedMcpLifecycleReceipt;
  } catch (error) {
    throw new Error(`Managed MCP lifecycle receipt is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printResult(result: McpLifecycleRepairResult, json = false, action?: string): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(kleur.bold("Tweakers MCP lifecycle\n"));
  console.log(`  Status: ${result.status}`);
  console.log(`  Health: ${result.report.title}`);
  for (const item of result.report.checks) {
    const mark = item.status === "ok" ? kleur.green("✓") : item.status === "warn" ? kleur.yellow("!") : kleur.red("✗");
    console.log(`  ${mark} ${item.name}: ${kleur.dim(item.detail)}`);
  }
  console.log();
  console.log(kleur.bold("Repair preview"));
  for (const asset of result.report.preview.changedAssets) {
    console.log(`  ${asset.id}: ${asset.destination}`);
    console.log(kleur.dim(`    backup: ${asset.backup}`));
  }
  if (result.report.preview.changedAssets.length === 0) console.log("  No asset changes required.");
  console.log(`  Reload: ${result.report.preview.reloadEligible ? "eligible" : "deferred"}`);
  if (result.reason) console.log(kleur.yellow(`  Reason: ${result.reason}`));
  console.log(kleur.dim("  Current labels and paths are preserved; rename deferred."));
  if (result.status === "preview") {
    console.log();
    const next = action === "adopt"
      ? "Run `tweaker mcp-lifecycle adopt --apply` during the confirmed promotion step."
      : action === "repair"
        ? "Run `tweaker mcp-lifecycle repair --apply` during the confirmed promotion step."
        : "Choose `repair --apply` for an already managed current receipt, or `adopt --apply` for the exact recognized predecessor.";
    console.log(kleur.yellow(`Preview only. ${next}`));
  }
}
