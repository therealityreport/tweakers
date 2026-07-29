"use strict";

const { isDeepStrictEqual } = require("node:util");

const PERSISTED_ATOMS_KEY = "electron-persisted-atom-state";
const AGENT_MODES_KEY = "agent-mode-by-host-id";
const THREAD_PERMISSIONS_KEY = "heartbeat-thread-permissions-by-id";
const POLICY_FILE = ".codex-global-state.json";
const TRANSACTIONS_DIRECTORY = ".user-questions-policy-transactions";
const RECEIPT_SCHEMA_VERSION = 2;
const PREVIEW_SCHEMA_VERSION = 2;
const DEFAULT_POLICY_PROFILE = "maximum-access";
const POLICY_PROFILES = deepFreeze({
  "maximum-access": {
    id: "maximum-access",
    title: "Maximum access",
    description: "Keeps Full Access capabilities and permits every approval and question prompt.",
  },
  "questions-only": {
    id: "questions-only",
    title: "Questions only",
    description: "Permits User Questions while rejecting every other approval category.",
  },
});

const POLICY_SETTINGS_VIEW_MODEL = deepFreeze({
  title: "MCP question forms for Full Access tasks",
  defaultProfile: DEFAULT_POLICY_PROFILE,
  profiles: POLICY_PROFILES,
  consequences: [
    "Moves the local Codex mode to Custom.",
    "Enables MCP question forms for matching Full Access tasks.",
    "Requires a later Codex restart before the change takes effect.",
  ],
  restart: { requiredAfterApplyOrRestore: true, automatic: false },
  commands: {
    status: { readOnly: true },
    preview: { readOnly: true },
    apply: { explicit: true, requiresMatchingPreviewToken: true, restartsApp: false },
    restore: { explicit: true, remainsAvailableWhenTweakDisabled: true, restartsApp: false },
  },
});

class PolicyTransactionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "PolicyTransactionError";
    this.code = code;
    this.recoveryEvidence = options.recoveryEvidence || options.cause?.recoveryEvidence || null;
    this.sourceEvidence = mergeEvidenceLists(options.sourceEvidence, options.cause?.sourceEvidence);
  }
}

function questionOnlyApprovalPolicy() {
  return {
    granular: {
      sandbox_approval: false,
      rules: false,
      skill_approval: false,
      request_permissions: false,
      mcp_elicitations: true,
    },
  };
}

function maximumAccessApprovalPolicy() {
  return {
    granular: {
      sandbox_approval: true,
      rules: true,
      skill_approval: true,
      request_permissions: true,
      mcp_elicitations: true,
    },
  };
}

function policyProfile(profile = DEFAULT_POLICY_PROFILE) {
  if (typeof profile !== "string" || !Object.hasOwn(POLICY_PROFILES, profile)) {
    throw new PolicyTransactionError("POLICY_PROFILE_INVALID", "The selected User Questions permission profile is invalid");
  }
  return profile;
}

function approvalPolicyForProfile(profile) {
  return policyProfile(profile) === "maximum-access"
    ? maximumAccessApprovalPolicy()
    : questionOnlyApprovalPolicy();
}

function migrateGlobalState(value, profile = DEFAULT_POLICY_PROFILE) {
  if (!isRecord(value)) return { changed: false, state: value, repairedThreads: 0 };
  const plan = createMigrationPlan(value, profile);
  return {
    changed: plan.targets.length > 0,
    state: plan.targets.length > 0 ? plan.appliedState : value,
    repairedThreads: plan.affectedTaskCount,
  };
}

/** Read-only. It never creates a directory, backup, receipt, or temporary file. */
function previewPolicyChange(options = {}) {
  const context = policyContext(options);
  const profile = policyProfile(options.profile);
  runHook(options, "preview.before-read");
  const snapshot = readPolicySnapshot(context.file, context.deps);
  const plan = createMigrationPlan(snapshot.value, profile);
  return publicPreview(context.file, snapshot, plan, context.deps, profile);
}

/** Explicit write command. A byte-and-mode-bound Preview token is mandatory. */
function applyPolicyChange(options = {}) {
  const previewToken = requireOpaqueId(options.previewToken, "POLICY_PREVIEW_TOKEN_REQUIRED", "A Preview token is required before Apply");
  const context = policyContext(options);
  const profile = policyProfile(options.profile);
  const snapshot = readPolicySnapshot(context.file, context.deps);
  const plan = createMigrationPlan(snapshot.value, profile);
  const preview = publicPreview(context.file, snapshot, plan, context.deps, profile);

  if (preview.previewToken !== previewToken) {
    const prior = findIdempotentApply(context, previewToken, snapshot);
    if (prior) {
      return applyResult(
        prior,
        true,
        context.deps.path.join(context.transactionsDirectory, `${prior.transactionId}.receipt.json`),
        context.deps.path.join(context.transactionsDirectory, prior.backupFile),
      );
    }
    throw new PolicyTransactionError("POLICY_PREVIEW_STALE", "The policy file or its mode changed after Preview; run Preview again");
  }
  if (plan.targets.length === 0) {
    return {
      status: "current",
      changed: false,
      transactionId: null,
      restartRequired: false,
      restarted: false,
      profile,
    };
  }

  const appliedBytes = Buffer.from(`${JSON.stringify(plan.appliedState, null, 2)}\n`);
  const appliedSha256 = sha256(appliedBytes, context.deps);
  const transactionId = context.deps.randomUUID();
  const directory = context.transactionsDirectory;
  const backupFileName = `${transactionId}.before.json`;
  const receiptFileName = `${transactionId}.receipt.json`;
  const backupFile = context.deps.path.join(directory, backupFileName);
  const receiptFile = context.deps.path.join(directory, receiptFileName);
  const createdAt = context.deps.now();
  let directoryCreated = false;
  let sourceApplied = false;
  let transactionReceipt;

  const preparedReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    transactionId,
    status: "prepared",
    createdAt,
    updatedAt: createdAt,
    sourceFile: context.file,
    previewToken,
    backupFile: backupFileName,
    beforeSha256: snapshot.sha256,
    appliedSha256,
    beforeMode: snapshot.mode,
    appliedMode: snapshot.mode,
    affectedFields: preview.affectedFields,
    affectedFieldCount: preview.affectedFieldCount,
    affectedTaskCount: preview.affectedTaskCount,
    profile,
    targets: plan.targets,
    createdContainers: plan.createdContainers,
    restoredSha256: null,
    restoredMode: null,
    restoredAt: null,
    restoreSourceChanged: null,
    sourceEvidence: [],
  };
  transactionReceipt = preparedReceipt;

  try {
    directoryCreated = ensurePrivateTransactionDirectory(directory, context.deps, options);
    durableCreate(backupFile, snapshot.bytes, 0o600, context.deps, options, "apply.backup");
    durableCreate(receiptFile, receiptBytes(preparedReceipt), 0o600, context.deps, options, "apply.receipt-prepared");
    const sourceReplacement = durableAtomicReplace(
      context.file,
      snapshot,
      appliedBytes,
      snapshot.mode,
      context.deps,
      options,
      "apply.source",
      successEvidenceOptions(context, transactionId, "apply-source"),
    );
    sourceApplied = true;
    transactionReceipt = {
      ...preparedReceipt,
      sourceEvidence: [sourceReplacement.sourceEvidence],
    };

    const receiptSnapshot = readRawSnapshot(receiptFile, context.deps);
    const appliedReceipt = {
      ...transactionReceipt,
      status: "applied",
      updatedAt: context.deps.now(),
    };
    durableAtomicReplace(receiptFile, receiptSnapshot, receiptBytes(appliedReceipt), 0o600, context.deps, options, "apply.receipt-commit");
    const committed = readAndValidateReceipt(receiptFile, transactionId, context, backupFile);
    return applyResult(committed, false, receiptFile, backupFile);
  } catch (error) {
    transactionReceipt = mergeReceiptSourceEvidence(transactionReceipt, error?.sourceEvidence);
    let rollbackError = null;
    let rollbackEvidence = null;
    if (sourceApplied) {
      try {
        rollbackEvidence = rollbackExact(
          context.file,
          appliedSha256,
          snapshot,
          context.deps,
          options,
          "apply.rollback",
          successEvidenceOptions(context, transactionId, "apply-rollback"),
        );
      } catch (candidate) {
        rollbackError = candidate;
      }
    }
    if (rollbackEvidence) {
      transactionReceipt = appendSourceEvidence(transactionReceipt, rollbackEvidence);
      recordRecoveryRequiredReceipt(receiptFile, transactionReceipt, context, error);
      throw new PolicyTransactionError(
        "POLICY_APPLY_ROLLBACK_FAILED",
        "Apply failed after source publication; the source preimage was restored and every replaced inode was retained for recovery",
        { cause: error },
      );
    }
    if (rollbackError) {
      transactionReceipt = mergeReceiptSourceEvidence(transactionReceipt, rollbackError.sourceEvidence);
      recordRecoveryRequiredReceipt(receiptFile, transactionReceipt, context, rollbackError);
      throw new PolicyTransactionError("POLICY_APPLY_ROLLBACK_FAILED", "Apply failed and the exact source rollback could not be verified", { cause: rollbackError });
    }
    if (error?.sourceEvidence?.length > 0) {
      recordRecoveryRequiredReceipt(receiptFile, transactionReceipt, context, error);
      throw new PolicyTransactionError(
        "POLICY_APPLY_ROLLBACK_FAILED",
        "Apply could not establish a clean commit boundary; every retained source inode is recorded for recovery",
        { cause: error },
      );
    }
    if (error instanceof PolicyTransactionError && [
      "POLICY_REPLACEMENT_RECOVERY_FAILED",
      "POLICY_REPLACEMENT_EVIDENCE_RETAINED",
      "POLICY_SOURCE_COMMIT_UNCERTAIN",
    ].includes(error.code)) {
      recordRecoveryRequiredReceipt(receiptFile, transactionReceipt, context, error);
      throw new PolicyTransactionError("POLICY_APPLY_ROLLBACK_FAILED", "Apply failed and the exact source rollback could not be verified", { cause: error });
    }
    removeTransactionArtifacts([receiptFile, backupFile], directory, directoryCreated, context.deps);
    if (error instanceof PolicyTransactionError) throw error;
    throw new PolicyTransactionError("POLICY_APPLY_FAILED", "Apply failed; the source file was left byte-identical", { cause: error });
  }
}

/** Explicit three-way restore. It never restarts Codex. */
function restorePolicyChange(options = {}) {
  const transactionId = requireOpaqueId(options.transactionId, "POLICY_TRANSACTION_ID_REQUIRED", "A transaction ID is required before Restore");
  const context = policyContext(options);
  const receiptFile = context.deps.path.join(context.transactionsDirectory, `${transactionId}.receipt.json`);
  const recoveryReceiptFile = context.deps.path.join(context.transactionsDirectory, `${transactionId}.recovery.json`);
  if (context.deps.fs.existsSync(recoveryReceiptFile)) {
    const recoverySnapshot = readPrivateArtifact(recoveryReceiptFile, context.deps, "POLICY_RECEIPT_MISSING");
    const recoveryReceipt = parseReceipt(
      recoverySnapshot,
      transactionId,
      context.file,
      context.deps,
      context.transactionsDirectory,
    );
    if (recoveryReceipt.status === "recovery-required") {
      throw new PolicyTransactionError("POLICY_TRANSACTION_INCOMPLETE", "Policy recovery evidence requires explicit resolution before Restore");
    }
  }
  const receiptSnapshot = readPrivateArtifact(receiptFile, context.deps, "POLICY_RECEIPT_MISSING");
  const receipt = parseReceipt(receiptSnapshot, transactionId, context.file, context.deps, context.transactionsDirectory);
  const backupFile = context.deps.path.join(context.transactionsDirectory, receipt.backupFile);
  const backupSnapshot = readPrivateArtifact(backupFile, context.deps, "POLICY_BACKUP_MISSING");
  if (backupSnapshot.sha256 !== receipt.beforeSha256) {
    throw new PolicyTransactionError("POLICY_BACKUP_INVALID", "The raw policy backup no longer matches its receipt");
  }
  validateReceiptAgainstBackup(receipt, backupSnapshot, context.deps);
  if (receipt.status === "restored") return restoreResult(receipt, true, receiptFile, backupFile);
  if (receipt.status !== "applied") {
    throw new PolicyTransactionError("POLICY_TRANSACTION_INCOMPLETE", "Only a fully applied transaction can be restored");
  }

  const source = readPolicySnapshot(context.file, context.deps);
  let restoredBytes;
  let restoredMode;
  if (source.sha256 === receipt.beforeSha256 && source.mode === receipt.beforeMode) {
    restoredBytes = source.bytes;
    restoredMode = source.mode;
  } else if (source.sha256 === receipt.appliedSha256 && source.mode === receipt.appliedMode) {
    restoredBytes = backupSnapshot.bytes;
    restoredMode = receipt.beforeMode;
  } else {
    for (const target of receipt.targets) {
      const current = readSlot(source.value, target.path);
      if (!sameSlot(current, target.applied)) {
        throw new PolicyTransactionError("POLICY_TARGET_DRIFT", "A targeted policy field changed after Apply; Restore refused without writing");
      }
    }
    const restoredState = applyTargetSide(source.value, receipt.targets, "before");
    pruneCreatedContainers(restoredState, receipt.createdContainers);
    restoredBytes = Buffer.from(`${JSON.stringify(restoredState, null, 2)}\n`);
    restoredMode = source.mode;
  }

  const restoredSha256 = sha256(restoredBytes, context.deps);
  const sourceAlreadyRestored = source.sha256 === restoredSha256 && source.mode === restoredMode;
  let sourceChanged = false;
  let transactionReceipt = receipt;
  try {
    if (!sourceAlreadyRestored) {
      const sourceReplacement = durableAtomicReplace(
        context.file,
        source,
        restoredBytes,
        restoredMode,
        context.deps,
        options,
        "restore.source",
        successEvidenceOptions(context, transactionId, "restore-source"),
      );
      sourceChanged = true;
      transactionReceipt = appendSourceEvidence(receipt, sourceReplacement.sourceEvidence);
    }
    const restoredReceipt = {
      ...transactionReceipt,
      status: "restored",
      updatedAt: context.deps.now(),
      restoredSha256,
      restoredMode,
      restoredAt: context.deps.now(),
      restoreSourceChanged: sourceChanged,
    };
    const currentReceipt = readRawSnapshot(receiptFile, context.deps);
    durableAtomicReplace(receiptFile, currentReceipt, receiptBytes(restoredReceipt), 0o600, context.deps, options, "restore.receipt-commit");
    const committed = readAndValidateReceipt(receiptFile, transactionId, context, backupFile);
    return restoreResult(committed, sourceAlreadyRestored, receiptFile, backupFile);
  } catch (error) {
    transactionReceipt = mergeReceiptSourceEvidence(transactionReceipt, error?.sourceEvidence);
    let rollbackError = null;
    let rollbackEvidence = null;
    if (sourceChanged) {
      try {
        rollbackEvidence = rollbackExact(
          context.file,
          restoredSha256,
          source,
          context.deps,
          options,
          "restore.rollback",
          successEvidenceOptions(context, transactionId, "restore-rollback"),
        );
      } catch (candidate) {
        rollbackError = candidate;
      }
    }
    restoreReceiptPreimage(receiptFile, receiptSnapshot, context.deps, options);
    if (rollbackEvidence) {
      transactionReceipt = appendSourceEvidence(transactionReceipt, rollbackEvidence);
      recordRecoveryRequiredReceipt(receiptFile, transactionReceipt, context, error);
      throw new PolicyTransactionError(
        "POLICY_RESTORE_ROLLBACK_FAILED",
        "Restore failed after source publication; the applied source was recovered and every replaced inode was retained for recovery",
        { cause: error },
      );
    }
    if (rollbackError) {
      transactionReceipt = mergeReceiptSourceEvidence(transactionReceipt, rollbackError.sourceEvidence);
      recordRecoveryRequiredReceipt(receiptFile, transactionReceipt, context, rollbackError);
      throw new PolicyTransactionError("POLICY_RESTORE_ROLLBACK_FAILED", "Restore failed and its source preimage could not be recovered", { cause: rollbackError });
    }
    if (error?.sourceEvidence?.length > 0) {
      recordRecoveryRequiredReceipt(receiptFile, transactionReceipt, context, error);
      throw new PolicyTransactionError(
        "POLICY_RESTORE_ROLLBACK_FAILED",
        "Restore could not establish a clean commit boundary; every retained source inode is recorded for recovery",
        { cause: error },
      );
    }
    if (error instanceof PolicyTransactionError && [
      "POLICY_REPLACEMENT_RECOVERY_FAILED",
      "POLICY_REPLACEMENT_EVIDENCE_RETAINED",
      "POLICY_SOURCE_COMMIT_UNCERTAIN",
    ].includes(error.code)) {
      recordRecoveryRequiredReceipt(receiptFile, transactionReceipt, context, error);
      throw new PolicyTransactionError(
        "POLICY_RESTORE_ROLLBACK_FAILED",
        "Restore failed after publishing replacement bytes; the source preimage was restored and the replacement was retained for recovery",
        { cause: error },
      );
    }
    if (error instanceof PolicyTransactionError) throw error;
    throw new PolicyTransactionError("POLICY_RESTORE_FAILED", "Restore failed; its source preimage was recovered", { cause: error });
  }
}

function createPolicyCommandInterface(options = {}) {
  return Object.freeze({
    viewModel: POLICY_SETTINGS_VIEW_MODEL,
    status: () => getPolicyTransactionStatus(options),
    preview: (profile = DEFAULT_POLICY_PROFILE) => previewPolicyChange({ ...options, profile }),
    apply: (previewToken, profile = DEFAULT_POLICY_PROFILE) => applyPolicyChange({ ...options, previewToken, profile }),
    restore: (transactionId) => restorePolicyChange({ ...options, transactionId }),
  });
}

/** Read-only discovery for keeping Restore visible across settings remounts. */
function getPolicyTransactionStatus(options = {}) {
  const context = policyContext(options);
  if (!context.deps.fs.existsSync(context.transactionsDirectory)) {
    return { status: "none", transactionId: null, restartRequired: false, restarted: false };
  }
  const applied = [];
  const invalidRecoveryTransactionIds = [];
  for (const name of context.deps.fs.readdirSync(context.transactionsDirectory).sort()) {
    const match = /^([a-zA-Z0-9-]{16,128})\.(?:receipt|recovery)\.json$/.exec(name);
    if (!match) continue;
    try {
      const snapshot = readPrivateArtifact(context.deps.path.join(context.transactionsDirectory, name), context.deps, "POLICY_RECEIPT_MISSING");
      const receipt = parseReceipt(snapshot, match[1], context.file, context.deps, context.transactionsDirectory);
      if (receipt.status === "applied" || receipt.status === "recovery-required") applied.push(receipt);
    } catch {
      if (name.endsWith(".recovery.json")) invalidRecoveryTransactionIds.push(match[1]);
    }
  }
  if (invalidRecoveryTransactionIds.length > 0) {
    return {
      status: "recovery-required",
      transactionId: invalidRecoveryTransactionIds[0],
      restartRequired: true,
      restarted: false,
    };
  }
  applied.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const current = applied[0];
  if (current?.status === "recovery-required") {
    return { status: "recovery-required", transactionId: current.transactionId, restartRequired: true, restarted: false };
  }
  return current
    ? inspectAppliedTransaction(context, current)
    : { status: "none", transactionId: null, restartRequired: false, restarted: false };
}

function inspectAppliedTransaction(context, receipt) {
  const targetCount = receipt.targets.length;
  let appliedTargetCount = 0;
  let beforeTargetCount = 0;
  let otherTargetCount = 0;
  try {
    const current = readPolicySnapshot(context.file, context.deps).value;
    for (const target of receipt.targets) {
      const slot = readSlot(current, target.path);
      if (sameSlot(slot, target.applied)) appliedTargetCount += 1;
      else if (sameSlot(slot, target.before)) beforeTargetCount += 1;
      else otherTargetCount += 1;
    }
  } catch {
    otherTargetCount = targetCount;
  }
  const status = targetCount > 0 && appliedTargetCount === targetCount
    ? "restorable"
    : targetCount > 0 && beforeTargetCount === targetCount
      ? "overwritten"
      : "drifted";
  return {
    status,
    transactionId: receipt.transactionId,
    profile: receipt.profile ?? null,
    targetCount,
    appliedTargetCount,
    beforeTargetCount,
    otherTargetCount,
    restartRequired: status === "restorable",
    restarted: false,
  };
}

/**
 * Deprecated compatibility shim for pre-T4 source. It deliberately performs
 * Preview only, so an old startup call cannot mutate policy.
 */
function repairGlobalStateFile(options = {}) {
  try {
    const preview = previewPolicyChange(options);
    return {
      changed: false,
      reason: preview.affectedFieldCount === 0 ? "current" : "explicit-apply-required",
      repairedThreads: 0,
      affectedThreads: preview.affectedTaskCount,
      previewToken: preview.previewToken,
    };
  } catch (error) {
    if (error?.code === "POLICY_SOURCE_MISSING") return { changed: false, reason: "missing", repairedThreads: 0 };
    if (error?.code === "POLICY_SOURCE_INVALID" || error?.code === "POLICY_SOURCE_SHAPE_INVALID") {
      return { changed: false, reason: "invalid", repairedThreads: 0 };
    }
    throw error;
  }
}

function createMigrationPlan(value, profile = DEFAULT_POLICY_PROFILE) {
  const selectedProfile = policyProfile(profile);
  if (!isRecord(value)) throw new PolicyTransactionError("POLICY_SOURCE_SHAPE_INVALID", "The policy file root must be a JSON object");
  const atomsSlot = readSlot(value, [PERSISTED_ATOMS_KEY]);
  if (atomsSlot.present && !isRecord(atomsSlot.value)) {
    throw new PolicyTransactionError("POLICY_SOURCE_SHAPE_INVALID", "The persisted atom state must be an object");
  }
  const atoms = atomsSlot.present ? atomsSlot.value : {};
  const modesSlot = readSlot(atoms, [AGENT_MODES_KEY]);
  if (modesSlot.present && !isRecord(modesSlot.value)) {
    throw new PolicyTransactionError("POLICY_SOURCE_SHAPE_INVALID", "The local mode state must be an object");
  }
  const permissionsSlot = readSlot(atoms, [THREAD_PERMISSIONS_KEY]);
  if (permissionsSlot.present && !isRecord(permissionsSlot.value)) {
    throw new PolicyTransactionError("POLICY_SOURCE_SHAPE_INVALID", "The task permission state must be an object");
  }

  const targets = [];
  const createdContainers = [];
  const affected = new Map();
  const affectedTasks = new Set();
  if (!atomsSlot.present) createdContainers.push([PERSISTED_ATOMS_KEY]);
  if (!modesSlot.present) createdContainers.push([PERSISTED_ATOMS_KEY, AGENT_MODES_KEY]);

  const localPath = [PERSISTED_ATOMS_KEY, AGENT_MODES_KEY, "local"];
  const local = readSlot(value, localPath);
  if (!local.present || local.value !== "custom") {
    addTarget(targets, localPath, local, { present: true, value: "custom" });
    addAffected(affected, `${PERSISTED_ATOMS_KEY}.${AGENT_MODES_KEY}.local`);
  }

  const permissions = permissionsSlot.present ? permissionsSlot.value : {};
  for (const [taskId, record] of Object.entries(permissions)) {
    if (!isManagedFullAccessRecord(record)) continue;
    let taskChanged = false;
    const activePath = [PERSISTED_ATOMS_KEY, THREAD_PERMISSIONS_KEY, taskId, "activePermissionProfile"];
    const active = readSlot(value, activePath);
    if (!active.present || active.value !== null) {
      addTarget(targets, activePath, active, { present: true, value: null });
      addAffected(affected, `${PERSISTED_ATOMS_KEY}.${THREAD_PERMISSIONS_KEY}.*.activePermissionProfile`);
      taskChanged = true;
    }
    const approvalPath = [PERSISTED_ATOMS_KEY, THREAD_PERMISSIONS_KEY, taskId, "approvalPolicy"];
    const approval = readSlot(value, approvalPath);
    const appliedApproval = approvalPolicyForProfile(selectedProfile);
    if (!approval.present || !deepEqual(approval.value, appliedApproval)) {
      addTarget(targets, approvalPath, approval, { present: true, value: appliedApproval });
      addAffected(affected, `${PERSISTED_ATOMS_KEY}.${THREAD_PERMISSIONS_KEY}.*.approvalPolicy`);
      taskChanged = true;
    }
    if (taskChanged) affectedTasks.add(taskId);
  }

  return {
    targets,
    createdContainers,
    affectedFields: [...affected.entries()].map(([name, count]) => ({ name, count })),
    affectedFieldCount: targets.length,
    affectedTaskCount: affectedTasks.size,
    appliedState: applyTargetSide(value, targets, "applied"),
  };
}

function publicPreview(file, snapshot, plan, deps, profile) {
  const mutationFingerprint = sha256(Buffer.from(JSON.stringify({ targets: plan.targets, createdContainers: plan.createdContainers })), deps);
  const previewToken = sha256(Buffer.from(JSON.stringify({
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    file,
    sourceSha256: snapshot.sha256,
    sourceMode: snapshot.mode,
    profile,
    mutationFingerprint,
  })), deps);
  return {
    affectedFields: plan.affectedFields.map((field) => ({ ...field })),
    affectedFieldCount: plan.affectedFieldCount,
    affectedTaskCount: plan.affectedTaskCount,
    sourceFingerprint: snapshot.sha256,
    previewToken,
    profile,
  };
}

function applyResult(receipt, idempotent, receiptFile = null, backupFile = null) {
  return {
    status: idempotent ? "already-applied" : "applied",
    changed: !idempotent,
    transactionId: receipt.transactionId,
    receiptFile,
    backupFile,
    beforeSha256: receipt.beforeSha256,
    appliedSha256: receipt.appliedSha256,
    sourceMode: receipt.appliedMode,
    restartRequired: true,
    restarted: false,
    profile: receipt.profile ?? null,
  };
}

function restoreResult(receipt, idempotent, receiptFile, backupFile) {
  return {
    status: idempotent ? "already-restored" : "restored",
    changed: !idempotent,
    transactionId: receipt.transactionId,
    receiptFile,
    backupFile,
    restoredSha256: receipt.restoredSha256 || receipt.beforeSha256,
    sourceMode: receipt.restoredMode ?? receipt.beforeMode,
    restartRequired: !idempotent,
    restarted: false,
  };
}

function successEvidenceOptions(context, transactionId, operation) {
  return {
    directory: context.transactionsDirectory,
    transactionId,
    operation,
  };
}

function appendSourceEvidence(receipt, evidence) {
  return mergeReceiptSourceEvidence(receipt, [evidence]);
}

function mergeReceiptSourceEvidence(receipt, evidence) {
  return {
    ...receipt,
    sourceEvidence: mergeEvidenceLists(receipt.sourceEvidence, evidence),
  };
}

function mergeEvidenceLists(...lists) {
  const merged = new Map();
  for (const evidence of lists.flatMap((value) => Array.isArray(value) ? value : [])) {
    if (!evidence || typeof evidence !== "object") continue;
    const key = `${evidence.operation || "unknown"}:${evidence.file || "unknown"}`;
    const prior = merged.get(key);
    if (!prior || (prior.status === "provisional" && evidence.status === "retained")) merged.set(key, evidence);
  }
  return [...merged.values()];
}

function readAndValidateReceipt(receiptFile, transactionId, context, backupFile) {
  const receiptSnapshot = readPrivateArtifact(receiptFile, context.deps, "POLICY_RECEIPT_MISSING");
  const receipt = parseReceipt(
    receiptSnapshot,
    transactionId,
    context.file,
    context.deps,
    context.transactionsDirectory,
  );
  const backupSnapshot = readPrivateArtifact(backupFile, context.deps, "POLICY_BACKUP_MISSING");
  if (backupSnapshot.sha256 !== receipt.beforeSha256) {
    throw new PolicyTransactionError("POLICY_BACKUP_INVALID", "The raw policy backup no longer matches its receipt");
  }
  validateReceiptAgainstBackup(receipt, backupSnapshot, context.deps);
  return receipt;
}

function findIdempotentApply(context, previewToken, source) {
  if (!context.deps.fs.existsSync(context.transactionsDirectory)) return null;
  for (const name of context.deps.fs.readdirSync(context.transactionsDirectory)) {
    if (!name.endsWith(".receipt.json")) continue;
    try {
      const raw = readPrivateArtifact(context.deps.path.join(context.transactionsDirectory, name), context.deps, "POLICY_RECEIPT_MISSING");
      const transactionId = name.slice(0, -".receipt.json".length);
      const receipt = parseReceipt(raw, transactionId, context.file, context.deps, context.transactionsDirectory);
      if (receipt.status === "applied" && receipt.previewToken === previewToken && receipt.sourceFile === context.file
        && receipt.appliedSha256 === source.sha256 && receipt.appliedMode === source.mode) return receipt;
    } catch {}
  }
  return null;
}

function parseReceipt(snapshot, expectedId, expectedSourceFile, deps, transactionsDirectory) {
  let receipt;
  try {
    receipt = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch (error) {
    throw new PolicyTransactionError("POLICY_RECEIPT_INVALID", "The policy receipt is not valid JSON", { cause: error });
  }
  const valid = isRecord(receipt)
    && receipt.schemaVersion === RECEIPT_SCHEMA_VERSION
    && receipt.transactionId === expectedId
    && receipt.sourceFile === expectedSourceFile
    && ["prepared", "applied", "restored", "recovery-required"].includes(receipt.status)
    && isSha256(receipt.beforeSha256)
    && isSha256(receipt.appliedSha256)
    && Number.isInteger(receipt.beforeMode)
    && Number.isInteger(receipt.appliedMode)
    && receipt.backupFile === `${expectedId}.before.json`
    && Array.isArray(receipt.targets)
    && Array.isArray(receipt.createdContainers)
    && Array.isArray(receipt.sourceEvidence)
    && receipt.sourceEvidence.every((evidence) => validSourceEvidenceShape(evidence, expectedId))
    && new Set(receipt.sourceEvidence.map((evidence) => evidence.operation)).size === receipt.sourceEvidence.length
    && receipt.targets.every(validReceiptTarget)
    && receipt.createdContainers.every(validCreatedContainer)
    && new Set(receipt.targets.map((target) => JSON.stringify(target.path))).size === receipt.targets.length
    && (receipt.status !== "applied" || hasSourceEvidence(receipt, "apply-source"))
    && (receipt.status !== "restored" || (
      typeof receipt.restoreSourceChanged === "boolean"
      && hasSourceEvidence(receipt, "apply-source")
      && (!receipt.restoreSourceChanged || hasSourceEvidence(receipt, "restore-source"))
    ))
    && (receipt.status !== "recovery-required" || validRecoveryEvidence(receipt.recovery));
  if (!valid) throw new PolicyTransactionError("POLICY_RECEIPT_INVALID", "The policy receipt failed validation");
  validateSourceEvidence(receipt, deps, transactionsDirectory);
  validateRecoveryEvidence(receipt, deps, transactionsDirectory);
  return receipt;
}

function validSourceEvidenceShape(value, transactionId) {
  return isRecord(value)
    && ["provisional", "retained"].includes(value.status)
    && ["apply-source", "restore-source", "apply-rollback", "restore-rollback"].includes(value.operation)
    && typeof value.file === "string"
    && value.file.endsWith(`${transactionId}.${value.operation}.evidence`)
    && isSha256(value.capturedSha256)
    && isSha256(value.observedSha256)
    && Number.isInteger(value.capturedMode)
    && /^\d+$/.test(value.device)
    && /^\d+$/.test(value.inode);
}

function hasSourceEvidence(receipt, operation) {
  return receipt.sourceEvidence.some((evidence) => evidence.operation === operation && evidence.status === "retained");
}

function validateSourceEvidence(receipt, deps, transactionsDirectory) {
  const directory = deps.path.resolve(transactionsDirectory);
  const directoryStat = deps.fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw new PolicyTransactionError("POLICY_TRANSACTION_DIRECTORY_UNSAFE", "Source evidence requires the private 0700 transaction directory");
  }
  for (const evidence of receipt.sourceEvidence) {
    const resolved = deps.path.resolve(evidence.file);
    const expected = deps.path.join(directory, `${receipt.transactionId}.${evidence.operation}.evidence`);
    if (resolved !== expected || deps.path.dirname(resolved) !== directory) {
      throw new PolicyTransactionError("POLICY_RECEIPT_INVALID", "The source evidence path escapes its transaction directory");
    }
    if (evidence.status === "provisional") {
      // Recovery receipts may disclose an evidence path whose final identity
      // observation failed. Never delete or trust that path automatically;
      // the recorded expected dev+ino/mode remain operator-visible evidence.
      continue;
    }
    let current;
    try {
      current = readRawSnapshot(resolved, deps);
    } catch (error) {
      throw new PolicyTransactionError("POLICY_SOURCE_EVIDENCE_INVALID", "Retained source evidence is missing or unsafe", { cause: error });
    }
    if (current.device !== evidence.device || current.inode !== evidence.inode || current.mode !== evidence.capturedMode) {
      throw new PolicyTransactionError("POLICY_SOURCE_EVIDENCE_INVALID", "Retained source evidence no longer has its recorded identity or mode");
    }
    // A writer that already held the replaced inode may append after the
    // point-in-time receipt observation. The path, inode identity, and private
    // parent are authoritative; hash drift is observed but never invalidates
    // evidence or makes those late bytes unreachable.
  }
}

function validRecoveryEvidence(value) {
  return isRecord(value)
    && typeof value.code === "string"
    && /^POLICY_[A-Z_]+$/.test(value.code)
    && isSha256(value.sourceSha256)
    && Number.isInteger(value.sourceMode)
    && (value.evidence === undefined || validRetainedEvidence(value.evidence));
}

function validRetainedEvidence(value) {
  return isRecord(value)
    && ["provisional", "retained"].includes(value.status)
    && typeof value.file === "string"
    && value.file.length > 0
    && isSha256(value.observedSha256)
    && Number.isInteger(value.mode)
    && value.mode >= 0
    && value.mode <= 0o7777
    && /^\d+$/.test(value.device)
    && /^\d+$/.test(value.inode)
    && ["recovery-interrupted", "preimage-restored"].includes(value.sourceState)
    && (value.status !== "retained" || (value.mode === 0o600 && value.sourceState === "preimage-restored"));
}

function validateRecoveryEvidence(receipt, deps, transactionsDirectory) {
  const evidence = receipt.recovery?.evidence;
  if (!evidence) return;
  const directory = deps.path.resolve(transactionsDirectory);
  const directoryStat = deps.fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw new PolicyTransactionError("POLICY_TRANSACTION_DIRECTORY_UNSAFE", "Recovery evidence requires the private 0700 transaction directory");
  }
  const resolved = deps.path.resolve(evidence.file);
  const expectedPrefix = `${deps.path.basename(receipt.sourceFile)}.`;
  if (deps.path.dirname(resolved) !== directory
    || !deps.path.basename(resolved).startsWith(expectedPrefix)
    || !deps.path.basename(resolved).endsWith(".recovery.evidence")) {
    throw new PolicyTransactionError("POLICY_RECEIPT_INVALID", "The recovery evidence path escapes its transaction directory");
  }
  let current;
  try {
    current = readRawSnapshot(resolved, deps);
  } catch (error) {
    throw new PolicyTransactionError("POLICY_RECOVERY_EVIDENCE_INVALID", "Recovery evidence is missing or unsafe", { cause: error });
  }
  if (current.device !== evidence.device || current.inode !== evidence.inode || current.mode !== evidence.mode) {
    throw new PolicyTransactionError("POLICY_RECOVERY_EVIDENCE_INVALID", "Recovery evidence no longer has its recorded identity or mode");
  }
}

function validCreatedContainer(path) {
  return Array.isArray(path) && (
    (path.length === 1 && path[0] === PERSISTED_ATOMS_KEY)
    || (path.length === 2 && path[0] === PERSISTED_ATOMS_KEY && path[1] === AGENT_MODES_KEY)
  );
}

function validateReceiptAgainstBackup(receipt, backup, deps) {
  let before;
  try {
    before = JSON.parse(backup.bytes.toString("utf8"));
  } catch (error) {
    throw new PolicyTransactionError("POLICY_BACKUP_INVALID", "The raw policy backup is not valid JSON", { cause: error });
  }
  if (!isRecord(before) || receipt.targets.some((target) => !sameSlot(readSlot(before, target.path), target.before))) {
    throw new PolicyTransactionError("POLICY_RECEIPT_INVALID", "The policy receipt does not match its raw backup");
  }
  const reconstructed = Buffer.from(`${JSON.stringify(applyTargetSide(before, receipt.targets, "applied"), null, 2)}\n`);
  if (sha256(reconstructed, deps) !== receipt.appliedSha256) {
    throw new PolicyTransactionError("POLICY_RECEIPT_INVALID", "The policy receipt's applied hash cannot be reconstructed from its targets");
  }
}

function validReceiptTarget(target) {
  if (!isRecord(target) || !Array.isArray(target.path) || !validSlot(target.before) || !validSlot(target.applied)) return false;
  const [atoms, group, taskOrLocal, field] = target.path;
  if (atoms !== PERSISTED_ATOMS_KEY) return false;
  if (group === AGENT_MODES_KEY) return target.path.length === 3 && taskOrLocal === "local";
  return group === THREAD_PERMISSIONS_KEY && target.path.length === 4 && typeof taskOrLocal === "string" && taskOrLocal.length > 0
    && ["activePermissionProfile", "approvalPolicy"].includes(field);
}

function validSlot(slot) {
  return isRecord(slot) && typeof slot.present === "boolean" && (!slot.present || Object.hasOwn(slot, "value"));
}

function readPolicySnapshot(file, deps) {
  let snapshot;
  try {
    snapshot = readRawSnapshot(file, deps);
  } catch (error) {
    if (error?.code === "ENOENT") throw new PolicyTransactionError("POLICY_SOURCE_MISSING", "The Codex policy file does not exist", { cause: error });
    if (error instanceof PolicyTransactionError) throw error;
    throw new PolicyTransactionError("POLICY_SOURCE_UNREADABLE", "The Codex policy file could not be read", { cause: error });
  }
  try {
    snapshot.value = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch (error) {
    throw new PolicyTransactionError("POLICY_SOURCE_INVALID", "The Codex policy file is not valid JSON", { cause: error });
  }
  return snapshot;
}

function readRawSnapshot(file, deps) {
  const before = deps.fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new PolicyTransactionError("POLICY_SOURCE_UNSAFE", "Policy transaction paths must be regular files, not links");
  }
  const bytes = deps.fs.readFileSync(file);
  const after = deps.fs.lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new PolicyTransactionError("POLICY_SOURCE_DRIFT", "The policy file changed while it was being read");
  }
  return {
    file,
    bytes,
    sha256: sha256(bytes, deps),
    mode: after.mode & 0o7777,
    device: String(after.dev),
    inode: String(after.ino),
  };
}

function readPrivateArtifact(file, deps, missingCode) {
  let snapshot;
  try {
    snapshot = readRawSnapshot(file, deps);
  } catch (error) {
    if (error?.code === "ENOENT") throw new PolicyTransactionError(missingCode, "The requested policy transaction artifact does not exist", { cause: error });
    throw error;
  }
  if ((snapshot.mode & 0o777) !== 0o600) {
    throw new PolicyTransactionError("POLICY_ARTIFACT_PERMISSIONS", "Policy backups and receipts must have mode 0600");
  }
  return snapshot;
}

function durableCreate(file, bytes, mode, deps, options, operation) {
  if (deps.fs.existsSync(file)) throw new PolicyTransactionError("POLICY_TRANSACTION_COLLISION", "A unique transaction artifact already exists");
  const temporary = `${file}.${deps.pid}.${deps.randomUUID()}.tmp`;
  let descriptor = null;
  let renamed = false;
  try {
    runHook(options, `${operation}.before-open`);
    descriptor = deps.fs.openSync(temporary, "wx", mode);
    deps.fs.fchmodSync(descriptor, mode);
    runHook(options, `${operation}.before-write`);
    deps.fs.writeFileSync(descriptor, bytes);
    runHook(options, `${operation}.before-fsync`);
    deps.fs.fsyncSync(descriptor);
    deps.fs.closeSync(descriptor);
    descriptor = null;
    runHook(options, `${operation}.before-rename`);
    deps.fs.renameSync(temporary, file);
    renamed = true;
    syncDirectory(deps.path.dirname(file), deps, options, `${operation}.directory-fsync`);
    runHook(options, `${operation}.before-verify`);
    const verified = readRawSnapshot(file, deps);
    if (verified.sha256 !== sha256(bytes, deps) || verified.mode !== mode) throw new Error("artifact verification failed");
  } catch (error) {
    if (descriptor !== null) try { deps.fs.closeSync(descriptor); } catch {}
    try { deps.fs.unlinkSync(temporary); } catch {}
    if (renamed) {
      try {
        const current = readRawSnapshot(file, deps);
        if (current.sha256 === sha256(bytes, deps)) deps.fs.unlinkSync(file);
      } catch {}
    }
    throw error;
  }
}

function durableAtomicReplace(file, expected, desiredBytes, desiredMode, deps, options, operation, successEvidence = null) {
  const temporary = `${file}.${deps.pid}.${deps.randomUUID()}.tmp`;
  const captured = `${file}.${deps.pid}.${deps.randomUUID()}.cas`;
  let descriptor = null;
  let sourceCaptured = false;
  let candidatePublished = false;
  let retainedSourceEvidence = null;
  const desiredSha256 = sha256(desiredBytes, deps);
  try {
    runHook(options, `${operation}.before-open`);
    descriptor = deps.fs.openSync(temporary, "wx", desiredMode);
    deps.fs.fchmodSync(descriptor, desiredMode);
    runHook(options, `${operation}.before-write`);
    deps.fs.writeFileSync(descriptor, desiredBytes);
    runHook(options, `${operation}.before-fsync`);
    deps.fs.fsyncSync(descriptor);
    deps.fs.closeSync(descriptor);
    descriptor = null;
    runHook(options, `${operation}.before-cas`);
    assertSnapshot(file, expected, deps);
    // Retire the exact pathname first, then publish through an exclusive hard
    // link. A concurrent writer either changes the captured inode (detected by
    // the checks below) or recreates the pathname and makes linkSync fail with
    // EEXIST. In neither case can its bytes be overwritten.
    deps.fs.renameSync(file, captured);
    sourceCaptured = true;
    runHook(options, `${operation}.after-capture`);
    assertSnapshot(captured, expected, deps);
    runHook(options, `${operation}.before-rename`);
    assertSnapshot(captured, expected, deps);
    try {
      deps.fs.linkSync(temporary, file);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new PolicyTransactionError(
          "POLICY_SOURCE_DRIFT",
          "The policy file changed before its exclusive replacement",
          { cause: error },
        );
      }
      throw error;
    }
    candidatePublished = true;
    syncDirectory(deps.path.dirname(file), deps, options, `${operation}.directory-fsync`);
    assertSnapshot(captured, expected, deps);
    runHook(options, `${operation}.before-verify`);
    const verified = readRawSnapshot(file, deps);
    if (verified.sha256 !== desiredSha256 || verified.mode !== desiredMode) throw new Error("atomic replacement verification failed");
    assertSnapshot(captured, expected, deps);
    if (successEvidence) {
      retainedSourceEvidence = retainSuccessfulSourceEvidence(
        captured,
        expected,
        successEvidence,
        deps,
        options,
        operation,
        (provisional) => { retainedSourceEvidence = provisional; },
      );
    }
    deps.fs.unlinkSync(captured);
    sourceCaptured = false;
    syncDirectory(deps.path.dirname(file), deps, options, `${operation}.capture-release-fsync`);
    if (retainedSourceEvidence) {
      try {
        runHook(options, `${operation}.success-evidence.before-final-observation`);
        retainedSourceEvidence = observeSuccessfulSourceEvidence(retainedSourceEvidence, deps);
      } catch (observationError) {
        retainedSourceEvidence = { ...retainedSourceEvidence, status: "provisional" };
        throw observationError;
      }
    }
  } catch (error) {
    if (descriptor !== null) try { deps.fs.closeSync(descriptor); } catch {}
    try { deps.fs.unlinkSync(temporary); } catch {}
    if (sourceCaptured) {
      try {
        const recoveryEvidence = recoverCapturedReplacement(
          file,
          captured,
          desiredSha256,
          desiredMode,
          candidatePublished,
          deps,
          options,
          operation,
        );
        sourceCaptured = false;
        if (recoveryEvidence) {
          throw new PolicyTransactionError(
            "POLICY_REPLACEMENT_EVIDENCE_RETAINED",
            "The source preimage was restored, but the published replacement remains externally writable and was retained for recovery",
            { recoveryEvidence, sourceEvidence: retainedSourceEvidence ? [retainedSourceEvidence] : [] },
          );
        }
      } catch (recoveryError) {
        if (recoveryError instanceof PolicyTransactionError
          && recoveryError.code === "POLICY_REPLACEMENT_EVIDENCE_RETAINED") {
          throw new PolicyTransactionError(
            recoveryError.code,
            recoveryError.message,
            {
              cause: recoveryError,
              recoveryEvidence: recoveryError.recoveryEvidence,
              sourceEvidence: mergeEvidenceLists(
                retainedSourceEvidence ? [retainedSourceEvidence] : [],
                recoveryError.sourceEvidence,
              ),
            },
          );
        }
        throw new PolicyTransactionError(
          "POLICY_REPLACEMENT_RECOVERY_FAILED",
          "Atomic replacement failed and its captured preimage could not be safely restored",
          { cause: recoveryError, sourceEvidence: retainedSourceEvidence ? [retainedSourceEvidence] : [] },
        );
      }
    }
    if (retainedSourceEvidence) {
      throw new PolicyTransactionError(
        "POLICY_SOURCE_COMMIT_UNCERTAIN",
        "The source replacement could not establish a clean commit boundary; retained inode evidence requires recovery",
        { cause: error, sourceEvidence: [retainedSourceEvidence] },
      );
    }
    throw error;
  } finally {
    if (descriptor !== null) try { deps.fs.closeSync(descriptor); } catch {}
    try { deps.fs.unlinkSync(temporary); } catch {}
    if (!sourceCaptured) try { deps.fs.unlinkSync(captured); } catch {}
  }
  return retainedSourceEvidence ? { sourceEvidence: retainedSourceEvidence } : null;
}

function retainSuccessfulSourceEvidence(captured, expected, evidence, deps, options, operation, onRetained) {
  const directory = deps.path.resolve(evidence.directory);
  const directoryStat = deps.fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw new PolicyTransactionError(
      "POLICY_TRANSACTION_DIRECTORY_UNSAFE",
      "Source evidence requires the existing private 0700 transaction directory",
    );
  }
  const evidenceFile = deps.path.join(directory, `${evidence.transactionId}.${evidence.operation}.evidence`);
  if (deps.fs.existsSync(evidenceFile)) {
    throw new PolicyTransactionError("POLICY_TRANSACTION_COLLISION", "A unique source-evidence artifact already exists");
  }
  const capturedSnapshot = readRawSnapshot(captured, deps);
  if (capturedSnapshot.sha256 !== expected.sha256 || capturedSnapshot.mode !== expected.mode) {
    throw new PolicyTransactionError("POLICY_SOURCE_DRIFT", "The replaced source changed before its evidence could be retained");
  }
  deps.fs.linkSync(captured, evidenceFile);
  const provisional = {
    status: "provisional",
    operation: evidence.operation,
    file: evidenceFile,
    capturedSha256: expected.sha256,
    observedSha256: capturedSnapshot.sha256,
    capturedMode: expected.mode,
    device: capturedSnapshot.device,
    inode: capturedSnapshot.inode,
  };
  onRetained(provisional);
  syncDirectory(directory, deps, options, `${operation}.success-evidence.directory-fsync`);
  const linked = readRawSnapshot(evidenceFile, deps);
  if (linked.device !== capturedSnapshot.device || linked.inode !== capturedSnapshot.inode || linked.mode !== capturedSnapshot.mode) {
    throw new PolicyTransactionError("POLICY_SOURCE_EVIDENCE_INVALID", "The retained source evidence does not name the captured inode");
  }
  return { ...provisional, status: "retained", observedSha256: linked.sha256 };
}

function observeSuccessfulSourceEvidence(evidence, deps) {
  const before = deps.fs.lstatSync(evidence.file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new PolicyTransactionError("POLICY_SOURCE_EVIDENCE_INVALID", "The retained source evidence is not a regular file");
  }
  const bytes = deps.fs.readFileSync(evidence.file);
  const after = deps.fs.lstatSync(evidence.file);
  if (String(before.dev) !== evidence.device || String(before.ino) !== evidence.inode
    || String(after.dev) !== evidence.device || String(after.ino) !== evidence.inode
    || (before.mode & 0o7777) !== evidence.capturedMode || (after.mode & 0o7777) !== evidence.capturedMode) {
    throw new PolicyTransactionError("POLICY_SOURCE_EVIDENCE_INVALID", "The retained source evidence changed identity or mode before receipt commit");
  }
  return { ...evidence, observedSha256: sha256(bytes, deps) };
}

function recoverCapturedReplacement(file, captured, desiredSha256, desiredMode, candidatePublished, deps, options, operation) {
  const capturedSnapshot = readRawSnapshot(captured, deps);
  const retired = `${file}.${deps.pid}.${deps.randomUUID()}.recovery`;
  let activeRetired = false;
  let retainedEvidence = null;

  try {
    const active = deps.fs.existsSync(file) ? readRawSnapshot(file, deps) : null;

    if (candidatePublished) {
      if (!active || active.sha256 !== desiredSha256 || active.mode !== desiredMode) {
        throw new PolicyTransactionError(
          "POLICY_ROLLBACK_DRIFT",
          "The replacement changed before recovery; refusing to overwrite it",
        );
      }

      runHook(options, `${operation}.recovery.after-validation`);
      // Capture the exact active pathname before removing anything. A
      // pathname recreation makes the later exclusive link fail, while an
      // in-place edit follows this inode into the private evidence link.
      deps.fs.renameSync(file, retired);
      activeRetired = true;
      runHook(options, `${operation}.recovery.after-capture`);
      retainedEvidence = retainRecoveryEvidence(
        file,
        retired,
        deps,
        options,
        operation,
        (provisional) => { retainedEvidence = provisional; },
      );
      assertRecoverySnapshot(retired, desiredSha256, desiredMode, deps);
    } else if (active) {
      // A concurrent writer recreated the pathname after the original source
      // was captured. It is authoritative. Keep both it and the captured
      // preimage so the caller can retain recovery-required evidence.
      throw new PolicyTransactionError(
        "POLICY_ROLLBACK_DRIFT",
        "The policy pathname was recreated during recovery; refusing to overwrite it",
      );
    }

    runHook(options, `${operation}.recovery.before-publish`);
    try {
      deps.fs.linkSync(captured, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      throw new PolicyTransactionError(
        "POLICY_ROLLBACK_DRIFT",
        "The policy pathname was recreated during recovery; refusing to overwrite it",
        { cause: error },
      );
    }

    const restored = readRawSnapshot(file, deps);
    if (restored.sha256 !== capturedSnapshot.sha256 || restored.mode !== capturedSnapshot.mode) {
      throw new Error("captured policy recovery verification failed");
    }
    assertSnapshot(captured, capturedSnapshot, deps);
    syncDirectory(deps.path.dirname(file), deps, options, `${operation}.recovery.directory-fsync`);
    runHook(options, `${operation}.recovery.before-cleanup`);
    assertSnapshot(file, capturedSnapshot, deps);
    assertSnapshot(captured, capturedSnapshot, deps);

    // Neither unlink below can remove an inode's final name: the restored
    // preimage remains at `file`, and the published replacement has a durable
    // link in the private transaction directory. An open writer may still
    // change the latter at any time, which is why its evidence is retained and
    // this recovery is always surfaced as recovery-required.
    deps.fs.unlinkSync(captured);
    if (activeRetired) {
      deps.fs.unlinkSync(retired);
      activeRetired = false;
    }
    syncDirectory(deps.path.dirname(file), deps, {}, `${operation}.recovery.cleanup-fsync`);
    if (retainedEvidence) {
      makeRecoveryEvidencePrivate(retainedEvidence.file, deps);
      syncDirectory(deps.path.dirname(retainedEvidence.file), deps, {}, `${operation}.recovery.evidence-final-fsync`);
      retainedEvidence = observeRecoveryEvidence(retainedEvidence.file, deps);
    }
    return retainedEvidence;
  } catch (error) {
    // If an in-place edit followed the replacement into its retired pathname,
    // put that inode back at the source path without overwriting a pathname a
    // different concurrent writer may already have recreated. Leave every
    // captured artifact in place for recovery-required diagnosis.
    if (activeRetired && !deps.fs.existsSync(file)) {
      try { deps.fs.linkSync(retired, file); } catch {}
    }
    if (retainedEvidence) {
      throw new PolicyTransactionError(
        "POLICY_REPLACEMENT_RECOVERY_FAILED",
        "Replacement recovery stopped after retaining private inode evidence",
        { cause: error, recoveryEvidence: retainedEvidence },
      );
    }
    throw error;
  }
}

function retainRecoveryEvidence(file, retired, deps, options, operation, onRetained) {
  const sourceDirectory = deps.path.dirname(file);
  const evidenceDirectory = deps.path.basename(sourceDirectory) === TRANSACTIONS_DIRECTORY
    ? sourceDirectory
    : deps.path.join(sourceDirectory, TRANSACTIONS_DIRECTORY);
  const directoryStat = deps.fs.lstatSync(evidenceDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw new PolicyTransactionError(
      "POLICY_TRANSACTION_DIRECTORY_UNSAFE",
      "Recovery evidence requires the existing private 0700 transaction directory",
    );
  }
  const evidenceFile = deps.path.join(evidenceDirectory, `${deps.path.basename(retired)}.evidence`);
  deps.fs.linkSync(retired, evidenceFile);
  const linked = readRawSnapshot(evidenceFile, deps);
  const provisional = {
    status: "provisional",
    file: evidenceFile,
    observedSha256: linked.sha256,
    mode: linked.mode,
    device: linked.device,
    inode: linked.inode,
    sourceState: "recovery-interrupted",
  };
  onRetained(provisional);
  syncDirectory(evidenceDirectory, deps, options, `${operation}.recovery.evidence-directory-fsync`);
  return provisional;
}

function makeRecoveryEvidencePrivate(file, deps) {
  let descriptor;
  try {
    descriptor = deps.fs.openSync(file, "r");
    deps.fs.fchmodSync(descriptor, 0o600);
    deps.fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) try { deps.fs.closeSync(descriptor); } catch {}
  }
}

function observeRecoveryEvidence(file, deps) {
  const snapshot = readRawSnapshot(file, deps);
  const stat = deps.fs.lstatSync(file);
  return {
    status: "retained",
    file,
    observedSha256: snapshot.sha256,
    mode: snapshot.mode,
    device: String(stat.dev),
    inode: String(stat.ino),
    sourceState: "preimage-restored",
  };
}

function assertRecoverySnapshot(file, expectedSha256, expectedMode, deps) {
  const current = readRawSnapshot(file, deps);
  if (current.sha256 !== expectedSha256 || current.mode !== expectedMode) {
    throw new PolicyTransactionError(
      "POLICY_ROLLBACK_DRIFT",
      "The replacement changed during recovery; refusing to remove it",
    );
  }
}

function rollbackExact(file, expectedCurrentSha256, preimage, deps, options, operation, successEvidence) {
  const current = readRawSnapshot(file, deps);
  if (current.sha256 !== expectedCurrentSha256) {
    throw new PolicyTransactionError("POLICY_ROLLBACK_DRIFT", "The committed bytes changed before rollback; refusing to overwrite them");
  }
  const replacement = durableAtomicReplace(file, current, preimage.bytes, preimage.mode, deps, options, operation, successEvidence);
  return replacement.sourceEvidence;
}

function recordRecoveryRequiredReceipt(receiptFile, preparedReceipt, context, cause) {
  const source = readRawSnapshot(context.file, context.deps);
  const recoveryReceipt = {
    ...preparedReceipt,
    status: "recovery-required",
    updatedAt: context.deps.now(),
    sourceEvidence: mergeEvidenceLists(preparedReceipt.sourceEvidence, cause?.sourceEvidence),
    recovery: {
      code: cause instanceof PolicyTransactionError ? cause.code : "POLICY_ROLLBACK_DRIFT",
      sourceSha256: source.sha256,
      sourceMode: source.mode,
      ...(cause?.recoveryEvidence ? { evidence: cause.recoveryEvidence } : {}),
    },
  };
  const failures = [];

  // A transient failure while replacing the primary receipt must not leave a
  // prepared/applied receipt beside retained evidence. Re-read and retry once;
  // each attempt owns a fresh compare-and-replace boundary.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const currentReceipt = readRawSnapshot(receiptFile, context.deps);
      durableAtomicReplace(
        receiptFile,
        currentReceipt,
        receiptBytes(recoveryReceipt),
        0o600,
        context.deps,
        {},
        "policy.recovery-receipt",
      );
      validateRecoveryReceiptFile(receiptFile, recoveryReceipt, context);
      return receiptFile;
    } catch (error) {
      failures.push(error);
    }
  }

  // If the primary receipt pathname cannot be advanced, publish an independent
  // schema-v2 sidecar so every retained inode still has a durable reference and
  // status discovery remains fail-closed.
  const fallbackFile = context.deps.path.join(
    context.transactionsDirectory,
    `${preparedReceipt.transactionId}.recovery.json`,
  );
  try {
    if (context.deps.fs.existsSync(fallbackFile)) {
      const currentFallback = readRawSnapshot(fallbackFile, context.deps);
      durableAtomicReplace(
        fallbackFile,
        currentFallback,
        receiptBytes(recoveryReceipt),
        0o600,
        context.deps,
        {},
        "policy.recovery-sidecar",
      );
    } else {
      durableCreate(
        fallbackFile,
        receiptBytes(recoveryReceipt),
        0o600,
        context.deps,
        {},
        "policy.recovery-sidecar",
      );
    }
    validateRecoveryReceiptFile(fallbackFile, recoveryReceipt, context);
    return fallbackFile;
  } catch (fallbackError) {
    throw new PolicyTransactionError(
      "POLICY_RECOVERY_RECEIPT_UNCERTAIN",
      "Retained policy evidence could not be durably referenced by a recovery receipt",
      {
        cause: fallbackError,
        recoveryEvidence: recoveryReceipt.recovery.evidence,
        sourceEvidence: recoveryReceipt.sourceEvidence,
        receiptFailures: failures,
      },
    );
  }
}

function validateRecoveryReceiptFile(file, expected, context) {
  const snapshot = readPrivateArtifact(file, context.deps, "POLICY_RECEIPT_MISSING");
  const receipt = parseReceipt(
    snapshot,
    expected.transactionId,
    context.file,
    context.deps,
    context.transactionsDirectory,
  );
  if (receipt.status !== "recovery-required") {
    throw new PolicyTransactionError("POLICY_RECEIPT_INVALID", "The recovery receipt did not commit recovery-required state");
  }
}

function assertSnapshot(file, expected, deps) {
  const current = readRawSnapshot(file, deps);
  if (current.sha256 !== expected.sha256 || current.mode !== expected.mode) {
    throw new PolicyTransactionError("POLICY_SOURCE_DRIFT", "The policy file changed before its atomic replacement");
  }
}

function ensurePrivateTransactionDirectory(directory, deps, options) {
  runHook(options, "apply.transaction-directory.before-create");
  let created = false;
  try {
    deps.fs.mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = deps.fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new PolicyTransactionError("POLICY_TRANSACTION_DIRECTORY_UNSAFE", "The policy transaction directory must be a private 0700 directory");
  }
  if (created) {
    try {
      syncDirectory(deps.path.dirname(directory), deps, options, "apply.transaction-directory.parent-fsync");
    } catch (error) {
      try { deps.fs.rmdirSync(directory); } catch {}
      throw error;
    }
  }
  return created;
}

function syncDirectory(directory, deps, options, operation) {
  let descriptor;
  try {
    descriptor = deps.fs.openSync(directory, "r");
    runHook(options, operation);
    deps.fs.fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) try { deps.fs.closeSync(descriptor); } catch {}
  }
}

function restoreReceiptPreimage(file, preimage, deps, options) {
  try {
    const current = readRawSnapshot(file, deps);
    if (current.sha256 !== preimage.sha256 || current.mode !== preimage.mode) {
      durableAtomicReplace(file, current, preimage.bytes, preimage.mode, deps, options, "restore.receipt-rollback");
    }
  } catch {}
}

function removeTransactionArtifacts(files, directory, directoryCreated, deps) {
  for (const file of files) try { deps.fs.unlinkSync(file); } catch {}
  try { syncDirectory(directory, deps, {}, "cleanup.directory-fsync"); } catch {}
  if (directoryCreated) try { deps.fs.rmdirSync(directory); } catch {}
}

function policyContext(options) {
  const deps = options.deps || nodeDeps();
  const codexHome = options.codexHome || deps.env.CODEX_HOME || deps.path.join(deps.homedir(), ".codex");
  const file = deps.path.resolve(codexHome, POLICY_FILE);
  return {
    deps,
    file,
    transactionsDirectory: deps.path.resolve(codexHome, TRANSACTIONS_DIRECTORY),
  };
}

function addTarget(targets, path, before, applied) {
  targets.push({ path: [...path], before: cloneSlot(before), applied: cloneSlot(applied) });
}

function addAffected(affected, name) {
  affected.set(name, (affected.get(name) || 0) + 1);
}

function applyTargetSide(value, targets, side) {
  const result = cloneJson(value);
  for (const target of targets) writeSlot(result, target.path, target[side]);
  return result;
}

function readSlot(root, path) {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { present: false };
    current = current[segment];
  }
  return { present: true, value: cloneJson(current) };
}

function writeSlot(root, path, slot) {
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (!isRecord(current[segment])) current[segment] = {};
    current = current[segment];
  }
  const key = path[path.length - 1];
  if (slot.present) current[key] = cloneJson(slot.value);
  else delete current[key];
}

function pruneCreatedContainers(root, paths) {
  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    const slot = readSlot(root, path);
    if (slot.present && isRecord(slot.value) && Object.keys(slot.value).length === 0) writeSlot(root, path, { present: false });
  }
}

function cloneSlot(slot) {
  return slot.present ? { present: true, value: cloneJson(slot.value) } : { present: false };
}

function sameSlot(left, right) {
  return left.present === right.present && (!left.present || deepEqual(left.value, right.value));
}

function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

function requireOpaqueId(value, code, message) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{16,128}$/.test(value)) throw new PolicyTransactionError(code, message);
  return value;
}

function isManagedFullAccessRecord(value) {
  if (!isRecord(value) || !isRecord(value.sandboxPolicy)) return false;
  if (value.sandboxPolicy.type !== "dangerFullAccess") return false;
  return value.approvalPolicy === "never"
    || value.activePermissionProfile?.id === ":danger-full-access"
    || deepEqual(value.approvalPolicy, maximumAccessApprovalPolicy())
    || deepEqual(value.approvalPolicy, questionOnlyApprovalPolicy());
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function deepEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function sha256(bytes, deps) {
  return deps.crypto.createHash("sha256").update(bytes).digest("hex");
}

function runHook(options, stage) {
  options.testHooks?.onStage?.(stage);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function nodeDeps() {
  return {
    fs: require("node:fs"),
    path: require("node:path"),
    crypto: require("node:crypto"),
    homedir: require("node:os").homedir,
    env: process.env,
    pid: process.pid,
    now: () => new Date().toISOString(),
    randomUUID: () => require("node:crypto").randomUUID(),
  };
}

module.exports = {
  DEFAULT_POLICY_PROFILE,
  POLICY_PROFILES,
  POLICY_SETTINGS_VIEW_MODEL,
  PolicyTransactionError,
  applyPolicyChange,
  createPolicyCommandInterface,
  getPolicyTransactionStatus,
  migrateGlobalState,
  maximumAccessApprovalPolicy,
  previewPolicyChange,
  questionOnlyApprovalPolicy,
  repairGlobalStateFile,
  restorePolicyChange,
};
