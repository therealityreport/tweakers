import kleur from "kleur";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
  MCP_LIFECYCLE_GUARD_LABEL,
  MCP_LIFECYCLE_LABELS,
  MCP_LIFECYCLE_REAPER_LABEL,
  assertMcpLifecycleLabelStates,
  defaultMcpLifecycleSourceRoot,
  expectedMcpLifecycleLabelStates,
  intendedMcpLifecycleLabelStates,
  installMcpLifecyclePackage,
  verifyMcpLifecyclePackage,
  type McpLifecycleInstallResult,
  type McpLifecycleInstallStep,
  type McpLifecycleLabelState,
  type McpLifecycleLabelTransition,
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
  /** Hermetic exact launchd-state seam. Unknown state must never be inferred. */
  labelStates?: (expected: readonly McpLifecycleLabelState[]) => readonly McpLifecycleLabelState[] | undefined;
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

interface ManagedMcpLifecycleReceiptV1 {
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

interface ManagedMcpLifecycleReceiptV2 {
  schemaVersion: 2;
  packageVersion: string;
  lifecycleSchemaVersion: number;
  policyVersion: string;
  matcherRegistryVersion: string;
  labels: string[];
  assetDigests: Record<string, string>;
  adoptedAt: string;
  compatibility: "current labels and paths preserved; rename deferred";
  labelTransitions: McpLifecycleLabelTransition[];
}

type ManagedMcpLifecycleReceipt = ManagedMcpLifecycleReceiptV1 | ManagedMcpLifecycleReceiptV2;

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
}, {
  packageVersion: "0.4.1",
  lifecycleSchemaVersion: 2,
  policyVersion: "strict-detached-v4",
  matcherRegistryVersion: "mcp-family-descriptors-v4",
  labels: [...MCP_LIFECYCLE_LABELS],
  assetDigests: {
    "lifecycle-module": "d70b1813b50082e19a71c0c392341caa9e584f66ee42e336c2966c7161b6f6a7",
    "idle-reaper": "60e801e3e5c6b230cee593f5bb5171d28c84e6ad1b83ceb4f955e845463e24f8",
    guard: "f10b9e98d117929c2b2d19b4a651fcdb60dcfd4760a78bfc482ae031a449b3a9",
    "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
    "guard-launch-agent": "56c8127ff1b2adf539b2bff14df5c5dee2ae92481306c808366498353ddbb43c",
  },
  compatibility: "current labels and paths preserved; rename deferred",
}, {
  packageVersion: "0.4.0",
  lifecycleSchemaVersion: 2,
  policyVersion: "strict-detached-v4",
  matcherRegistryVersion: "mcp-family-descriptors-v4",
  labels: [...MCP_LIFECYCLE_LABELS],
  assetDigests: {
    "lifecycle-module": "4021016ed4a6e9883377e5cf07c47111f069ea665ff50e2e35584ba3c20aae6f",
    "idle-reaper": "9cdca57a1c612be0dadd1e8b70e0cd068998815ca88b70bf5e2470573e34db8e",
    guard: "f10b9e98d117929c2b2d19b4a651fcdb60dcfd4760a78bfc482ae031a449b3a9",
    "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
    "guard-launch-agent": "56c8127ff1b2adf539b2bff14df5c5dee2ae92481306c808366498353ddbb43c",
  },
  compatibility: "current labels and paths preserved; rename deferred",
}, {
  // Interim 0.5.0 cut adopted while the modal-ops matcher repair was split
  // across releases (symlink-alias containment landed; the Homebrew framework
  // CLI-shim distribution equivalence had not).  Superseded by the repaired
  // same-version lib.
  packageVersion: "0.5.0",
  lifecycleSchemaVersion: 2,
  policyVersion: "strict-detached-v5",
  matcherRegistryVersion: "mcp-family-descriptors-v5",
  labels: [...MCP_LIFECYCLE_LABELS],
  assetDigests: {
    "lifecycle-module": "4c21b8967f7b34c84665300b6bc120636e204cf1ad12b140012fd41f1f35e52f",
    "idle-reaper": "b71268fa64c51005849e8dde031a9a4b0d508abe2e72a2072439bdf4012d1cf9",
    guard: "f10b9e98d117929c2b2d19b4a651fcdb60dcfd4760a78bfc482ae031a449b3a9",
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
  const result = await withLifecycleLock(lifecycleLockFile(paths.root), "MCP lifecycle repair", async () => {
    assertLifecycleReceiptsIdle(paths.root);
    // Status and preview may use the initial read above, but an apply must
    // make its mutation decision from health observed under the shared lock.
    const lockedReport = inspectMcpLifecycleHealth({
      targetHome,
      sourceRoot,
      backupRoot: join(paths.backup, "mcp-lifecycle"),
      managedReceiptPath: join(paths.root, "mcp-lifecycle-managed.json"),
      deep: options.deep === true || action !== "status",
    });
    return repairMcpLifecycle({
      targetHome,
      userRoot: paths.root,
      sourceRoot,
      report: lockedReport,
    });
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

  const reload = dependencies.reload ?? reloadLifecycleLabels;
  const install = dependencies.install ?? installMcpLifecyclePackage;
  const receiptPath = join(input.userRoot, "mcp-lifecycle-managed.json");
  // Freeze the verified package once.  Every live-mutation gate compares the
  // source again to this proof, but the receipt is always derived from these
  // already verified bytes rather than a later manifest read.
  const candidate = freezeMcpLifecycleCandidate(sourceRoot, input.targetHome);
  const expectedLabelStates = expectedMcpLifecycleLabelStates(candidate.verification);
  const readExactLabelStates = (currentReport: McpLifecycleHealthReport): readonly McpLifecycleLabelState[] => {
    const observed = dependencies.labelStates?.(expectedLabelStates) ?? currentReport.preview.labelStates;
    assertMcpLifecycleLabelStates(observed ?? undefined, expectedLabelStates);
    return [...observed!].sort((left, right) => left.label.localeCompare(right.label));
  };
  const sameLabelState = (left: McpLifecycleLabelState, right: McpLifecycleLabelState): boolean => (
    left.label === right.label
    && left.disabled === right.disabled
    && left.loadedInstances === right.loadedInstances
    && left.plistPath === right.plistPath
    && left.plistSha256 === right.plistSha256
  );
  const frozenLabelStates = readExactLabelStates(report);
  const intendedLabelStates = intendedMcpLifecycleLabelStates(
    frozenLabelStates,
    candidate.verification,
  );
  const operationsAttempted = new Map<string, string>([
    [MCP_LIFECYCLE_GUARD_LABEL, frozenLabelStates.find((state) => state.label === MCP_LIFECYCLE_GUARD_LABEL)!.disabled
      ? "preserve-disabled-unloaded"
      : "preserve-enabled-loaded"],
    [MCP_LIFECYCLE_REAPER_LABEL, "preserve-enabled-loaded"],
  ]);
  // Keep an identity-bound copy of the prior proof.  Matching bytes alone are
  // not enough: a replacement file can retain the same JSON while changing
  // ownership or traversing a symlink between validation and activation.
  const priorReceipt = existsSync(receiptPath) ? captureManagedReceipt(receiptPath) : null;
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
  const assertFrozenPriorReceiptRestored = (): void => {
    if (priorReceipt === null) {
      try {
        lstatSync(receiptPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("MCP lifecycle prior managed receipt was not restored.");
      }
      throw new Error("MCP lifecycle prior managed receipt was not restored.");
    }
    let restored: ManagedReceiptSnapshot;
    try {
      restored = captureManagedReceipt(receiptPath);
    } catch {
      throw new Error("MCP lifecycle prior managed receipt was not restored.");
    }
    if (!sameManagedReceiptSnapshot(restored, priorReceipt)) {
      throw new Error("MCP lifecycle prior managed receipt identity was not restored.");
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
      assertFrozenPriorReceiptRestored();
      return;
    }
    // If the receipt was never moved aside, its frozen inode is still the
    // only acceptable rollback identity. Reconstructing equivalent JSON here
    // would make rollback look successful while losing that proof.
    assertFrozenPriorReceiptRestored();
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
    const observedLabelStates = readExactLabelStates(installed);
    for (const intended of intendedLabelStates) {
      const observed = observedLabelStates.find((state) => state.label === intended.label);
      if (!observed || !sameLabelState(intended, observed)) {
        throw new Error(`MCP lifecycle label state did not reach the intended identity: ${intended.label}.`);
      }
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
      schemaVersion: 2, packageVersion: candidate.verification.manifest.package.version,
      lifecycleSchemaVersion: candidate.verification.manifest.lifecycle_schema_version,
      policyVersion: candidate.verification.manifest.policy_version,
      matcherRegistryVersion: candidate.verification.manifest.matcher_registry_version,
      labels: MCP_LIFECYCLE_LABELS,
      assetDigests: Object.fromEntries(candidate.verification.manifest.assets.map((asset) => [asset.id, asset.source_sha256])),
      adoptedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      compatibility: "current labels and paths preserved; rename deferred",
      labelTransitions: frozenLabelStates.map((before) => ({
        label: before.label,
        before,
        intended: intendedLabelStates.find((state) => state.label === before.label)!,
        observed: observedLabelStates.find((state) => state.label === before.label) ?? null,
        operationsAttempted: [operationsAttempted.get(before.label) ?? "preserve"],
      })),
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
  const assertReloadStillEligible = (
    expectedStates: readonly McpLifecycleLabelState[],
    requireExactIdentity = true,
  ): McpLifecycleHealthReport => {
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
    const latestLabelStates = readExactLabelStates(latest);
    if (requireExactIdentity) {
      for (const expected of expectedStates) {
        const observed = latestLabelStates.find((state) => state.label === expected.label);
        if (!observed || !sameLabelState(expected, observed)) {
          throw new Error(`MCP lifecycle label state changed during promotion: ${expected.label}.`);
        }
      }
    }
    return latest;
  };
  const reloadIntendedReaperAndVerify = (markActivationAttempted?: () => void): void => {
    assertReloadStillEligible(intendedLabelStates);
    let activationMarked = false;
    reload(input.targetHome, [MCP_LIFECYCLE_REAPER_LABEL], () => {
      assertReloadStillEligible(intendedLabelStates);
      if (!activationMarked) {
        markActivationAttempted?.();
        activationMarked = true;
      }
    });
    operationsAttempted.set(MCP_LIFECYCLE_REAPER_LABEL, "bootout-bootstrap-verify");
    assertReloadStillEligible(intendedLabelStates);
  };
  const verifyFrozenBeforeState = (): void => {
    assertFrozenPriorReceiptRestored();
    const restored = readExactLabelStates(inspectLatest());
    for (const frozen of frozenLabelStates) {
      const observed = restored.find((state) => state.label === frozen.label);
      if (!observed || !sameLabelState(frozen, observed)) {
        throw new Error(`MCP lifecycle rollback did not restore frozen state: ${frozen.label}.`);
      }
    }
  };
  const reloadFrozenReaperAndVerify = (): void => {
    verifyFrozenBeforeState();
    reload(input.targetHome, [MCP_LIFECYCLE_REAPER_LABEL], () => {
      verifyFrozenBeforeState();
    });
    verifyFrozenBeforeState();
  };
  let firstDestructiveBoundaryChecked = false;
  const installResult = install({
    sourceRoot,
    verifiedCandidate: candidate.verification,
    targetHome: input.targetHome,
    temporaryRoot: join(input.targetHome, ".codex", "tmp"),
    labelStates: () => {
      const latest = inspectLatest();
      const states = readExactLabelStates(latest);
      for (const frozen of frozenLabelStates) {
        const observed = states.find((state) => state.label === frozen.label);
        if (!observed || !sameLabelState(frozen, observed)) {
          throw new Error(`MCP lifecycle label state changed during promotion: ${frozen.label}.`);
        }
      }
      return states;
    },
    beforeStep: (step, asset) => {
      dependencies.beforeInstallStep?.(step, asset);
      // Adoption is explicit, but never grants a stale or replaced receipt or
      // canonical package permission to mutate the managed paths.
      assertPriorReceiptUnchanged();
      if (input.allowPriorManagedReceipt) readManagedReceipt(receiptPath);
      assertMcpLifecycleCandidateUnchanged(candidate);
      // `before-backup` is the first point at which the generic transaction
      // will rename an installed destination. Recheck complete eligibility
      // exactly once after the hook so a heartbeat that went stale after
      // preflight cannot cause even a transient installed-file mutation.
      // Later backups intentionally do not compare their promoted plist bytes
      // against the frozen-before identity.
      if (step === "before-backup" && !firstDestructiveBoundaryChecked) {
        assertReloadStillEligible(frozenLabelStates);
        firstDestructiveBoundaryChecked = true;
      }
      // The transaction can temporarily hold a plist in its private backup
      // directory. The exact disabled/loaded state is frozen before the first
      // file mutation, then re-proven with intended bytes immediately before
      // the reaper reload and with frozen-before bytes after rollback.
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
      reloadIntendedReaperAndVerify(markActivationAttempted);
    },
    afterRollback: () => {
      reloadFrozenReaperAndVerify();
    },
  });
  if (installResult.status === "deferred") {
    return { status: "deferred", report, installResult, reason: installResult.reason };
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
  if (receipt.schemaVersion !== 2) {
    throw new Error("Automatic MCP lifecycle reconciliation requires a current schema-v2 receipt.");
  }
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
  if (proof?.status !== "ok" && !allowPriorManagedReceipt) {
    return proof?.detail ?? "managed artifact proof is unavailable";
  }
  if (requireManagedProof && proof?.status !== "ok") {
    return proof?.detail ?? "managed artifact proof is unavailable";
  }
  return null;
}

function matchesAdoptablePredecessor(
  receipt: ManagedMcpLifecycleReceiptV1,
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
  if (receipt.schemaVersion !== 1) {
    throw new Error("Managed MCP lifecycle receipt is already current or is not an adoptable schema-v1 predecessor.");
  }
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

function reloadLifecycleLabels(
  targetHome: string,
  labels: readonly string[],
  beforeEach?: (label: string) => void,
): void {
  if (labels.some((label) => label !== MCP_LIFECYCLE_REAPER_LABEL)) {
    throw new Error("MCP lifecycle repair never reloads, bootstraps, or enables the Guard label.");
  }
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

function sameManagedReceiptSnapshot(
  left: ManagedReceiptSnapshot,
  right: ManagedReceiptSnapshot,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.bytes.equals(right.bytes);
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

function readManagedReceipt(path: string): ManagedMcpLifecycleReceipt | null {
  if (!existsSync(path)) return null;
  try {
    const snapshot = captureManagedReceipt(path);
    const value = JSON.parse(snapshot.bytes.toString("utf8")) as Partial<ManagedMcpLifecycleReceipt>;
    if (
      (value.schemaVersion !== 1 && value.schemaVersion !== 2)
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
      || (value.schemaVersion === 2 && !validManagedLabelTransitions(value.labelTransitions))
    ) {
      throw new Error("invalid receipt");
    }
    return value as ManagedMcpLifecycleReceipt;
  } catch (error) {
    throw new Error(`Managed MCP lifecycle receipt is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validManagedLabelTransitions(value: unknown): value is McpLifecycleLabelTransition[] {
  if (!Array.isArray(value) || value.length !== MCP_LIFECYCLE_LABELS.length) return false;
  const seen = new Set<string>();
  for (const transition of value) {
    if (!transition || typeof transition !== "object" || Array.isArray(transition)) return false;
    const record = transition as Partial<McpLifecycleLabelTransition>;
    if (!record.before || !record.intended || !record.observed
      || record.label !== record.before.label
      || record.label !== record.intended.label
      || record.label !== record.observed.label
      || !MCP_LIFECYCLE_LABELS.includes(record.before.label)
      || seen.has(record.before.label)
      || !validManagedLabelState(record.before)
      || !validManagedLabelState(record.intended)
      || !validManagedLabelState(record.observed)
      || !sameReceiptPolicyAndPath(record.before, record.intended)
      || !sameReceiptState(record.intended, record.observed)
      || !validManagedReceiptOperations(record.operationsAttempted, record.before)) return false;
    seen.add(record.before.label);
  }
  return seen.size === MCP_LIFECYCLE_LABELS.length;
}

function validManagedLabelState(value: McpLifecycleLabelState): boolean {
  if (typeof value.plistPath !== "string"
    || !value.plistPath.startsWith("/")
    || !value.plistPath.endsWith(`/Library/LaunchAgents/${value.label}.plist`)
    || !/^[a-f0-9]{64}$/.test(value.plistSha256)) return false;
  return value.label === MCP_LIFECYCLE_GUARD_LABEL
    ? (value.disabled === true && value.loadedInstances === 0) || (value.disabled === false && value.loadedInstances === 1)
    : value.disabled === false && value.loadedInstances === 1;
}

function sameReceiptPolicyAndPath(left: McpLifecycleLabelState, right: McpLifecycleLabelState): boolean {
  return left.label === right.label
    && left.disabled === right.disabled
    && left.loadedInstances === right.loadedInstances
    && left.plistPath === right.plistPath;
}

function validManagedReceiptOperations(value: unknown, before: McpLifecycleLabelState): boolean {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") return false;
  if (before.label === MCP_LIFECYCLE_GUARD_LABEL) {
    return value[0] === (before.disabled ? "preserve-disabled-unloaded" : "preserve-enabled-loaded");
  }
  return value[0] === "preserve-enabled-loaded" || value[0] === "bootout-bootstrap-verify";
}

function sameReceiptState(left: McpLifecycleLabelState, right: McpLifecycleLabelState): boolean {
  return left.label === right.label
    && left.disabled === right.disabled
    && left.loadedInstances === right.loadedInstances
    && left.plistPath === right.plistPath
    && left.plistSha256 === right.plistSha256;
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
