"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_CANDIDATE_CODEX_HOME_ENV = exports.MCP_CANDIDATE_RECONCILIATION_ENV = void 0;
exports.userQuestionsMcpReceiptMatchesEnabledState = userQuestionsMcpReceiptMatchesEnabledState;
exports.resolveMcpRuntimePaths = resolveMcpRuntimePaths;
exports.reconcileMcpConfig = reconcileMcpConfig;
exports.createMcpReconciler = createMcpReconciler;
exports.readMcpSyncState = readMcpSyncState;
exports.fingerprint = fingerprint;
exports.planMcpConfigReconciliation = planMcpConfigReconciliation;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const mcp_sync_1 = require("./mcp-sync");
function userQuestionsMcpReceiptMatchesEnabledState(receipt, enabled) {
    if (receipt.status === "conflict"
        || receipt.status === "error"
        || receipt.conflicts.length !== 0
        || receipt.approvalPolicy.status !== "unchanged"
        || receipt.approvalPolicy.beforeRaw !== receipt.approvalPolicy.afterRaw
        || receipt.approvalPolicy.sandboxModeBeforeRaw !== receipt.approvalPolicy.sandboxModeAfterRaw
        || receipt.approvalPolicy.restartRequired)
        return false;
    const desiredCount = receipt.desiredNames.filter((name) => name === mcp_sync_1.USER_QUESTIONS_MCP_SERVER_NAME).length;
    const appliedCount = receipt.appliedNames.filter((name) => name === mcp_sync_1.USER_QUESTIONS_MCP_SERVER_NAME).length;
    if (!enabled)
        return desiredCount === 0 && appliedCount === 0;
    return desiredCount === 1
        && appliedCount === 1;
}
exports.MCP_CANDIDATE_RECONCILIATION_ENV = "TWEAKERS_CANDIDATE_MCP_RECONCILIATION";
exports.MCP_CANDIDATE_CODEX_HOME_ENV = "CODEX_HOME";
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
function resolveMcpRuntimePaths(options) {
    const env = options.env ?? process.env;
    const statePath = (0, node_path_1.join)(options.userRoot, "mcp-sync-state.json");
    const ordinaryCodexHome = (0, node_path_1.join)(options.homeDirectory, ".codex");
    const candidateOptIn = env[exports.MCP_CANDIDATE_RECONCILIATION_ENV];
    if (candidateOptIn === undefined || candidateOptIn === "") {
        return {
            codexHome: ordinaryCodexHome,
            configPath: (0, node_path_1.join)(ordinaryCodexHome, "config.toml"),
            statePath,
            candidateIsolated: false,
        };
    }
    if (candidateOptIn !== "1") {
        throw new Error(`${exports.MCP_CANDIDATE_RECONCILIATION_ENV} must be exactly 1`);
    }
    const candidateCodexHome = env[exports.MCP_CANDIDATE_CODEX_HOME_ENV];
    if (!candidateCodexHome) {
        throw new Error(`${exports.MCP_CANDIDATE_CODEX_HOME_ENV} is required for candidate MCP reconciliation`);
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
    if (resolvedCandidateHome === resolvedOrdinaryHome
        || isStrictDescendant(resolvedOrdinaryHome, resolvedCandidateHome)
        || isStrictDescendant(resolvedCandidateHome, resolvedOrdinaryHome)) {
        throw new Error("Candidate CODEX_HOME must not resolve to or contain the real ~/.codex directory");
    }
    if ((0, node_fs_1.existsSync)(candidateCodexHome) && !(0, node_fs_1.lstatSync)(candidateCodexHome).isDirectory()) {
        throw new Error("Candidate CODEX_HOME must be a directory when it already exists");
    }
    const configPath = (0, node_path_1.join)(candidateCodexHome, "config.toml");
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
function assertExactAbsolutePath(path, label) {
    if (!path || path.includes("\0") || !(0, node_path_1.isAbsolute)(path) || (0, node_path_1.resolve)(path) !== path) {
        throw new Error(`${label} must be an exact normalized absolute path`);
    }
}
function assertExistingDirectoryWithoutSymlinks(path, label) {
    if (!(0, node_fs_1.existsSync)(path) || !(0, node_fs_1.lstatSync)(path).isDirectory()) {
        throw new Error(`${label} must already exist as a directory`);
    }
    if ((0, node_fs_1.lstatSync)(path).isSymbolicLink() || resolveThroughExistingAncestor(path) !== path) {
        throw new Error(`${label} must not contain symbolic-link components`);
    }
}
function assertPathHasNoExistingSymlink(path, label) {
    const pathStat = lstatIfPresent(path);
    if (pathStat?.isSymbolicLink()
        || resolveThroughExistingAncestor(path) !== path) {
        throw new Error(`${label} must not contain symbolic-link components`);
    }
}
function assertRegularFileWhenPresent(path, label) {
    const pathStat = lstatIfPresent(path);
    if (pathStat && !pathStat.isFile()) {
        throw new Error(`${label} must be a regular file when it already exists`);
    }
    if (pathStat && pathStat.nlink !== 1) {
        throw new Error(`${label} must not be hard-linked`);
    }
}
function lstatIfPresent(path) {
    try {
        return (0, node_fs_1.lstatSync)(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
function resolveThroughExistingAncestor(path) {
    let ancestor = path;
    const missing = [];
    while (!(0, node_fs_1.existsSync)(ancestor)) {
        const parent = (0, node_path_1.dirname)(ancestor);
        if (parent === ancestor)
            break;
        missing.unshift((0, node_path_1.basename)(ancestor));
        ancestor = parent;
    }
    return (0, node_path_1.resolve)((0, node_fs_1.realpathSync)(ancestor), ...missing);
}
function isStrictDescendant(root, candidate) {
    const remainder = (0, node_path_1.relative)(root, candidate);
    return remainder.length > 0
        && remainder !== ".."
        && !remainder.startsWith(`..${node_path_1.sep}`)
        && !(0, node_path_1.isAbsolute)(remainder);
}
function reconcileMcpConfig(options, dependencies = {}) {
    return (0, mcp_sync_1.withMcpConfigMutationLock)(options.configPath, () => reconcileMcpConfigWithLock(options, dependencies));
}
function reconcileMcpConfigWithLock(options, dependencies) {
    const ownedTweaks = options.ownedTweaks ?? options.tweaks;
    const previousManagedConfigurationChangedAt = readMcpSyncState(options.statePath)?.managedConfigurationChangedAt ?? null;
    let preservedOptions = readPreservedOptions(options.statePath, ownedTweaks);
    const durablePreservedApprovalPolicy = readPreservedApprovalPolicy(options.statePath, options.configPath);
    recoverInterruptedCas(options.configPath);
    const recoveredRetiredEdit = recoverRetiredConfigEdits(options.configPath, options.tweaks, ownedTweaks, preservedOptions, durablePreservedApprovalPolicy);
    const now = dependencies.now ?? (() => new Date());
    const transactionId = dependencies.transactionId?.() ?? (0, node_crypto_1.randomUUID)();
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
            attempts: for (let attempt = 1; attempt <= 2; attempt += 1) {
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
                        plannedAfterFingerprint: fingerprint(plan.nextToml),
                        restartRequired: false,
                        managedConfigurationChangedAt: previousManagedConfigurationChangedAt,
                    });
                }
                const mode = (0, node_fs_1.existsSync)(options.configPath)
                    ? (0, node_fs_1.statSync)(options.configPath).mode & 0o777
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
                        if (hasPlanConflict(plan) || !plan.changed)
                            break attempts;
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
                        if (hasPlanConflict(plan) || !plan.changed)
                            break attempts;
                        continue;
                    }
                    const promoted = promoteConfigWithCas(options.configPath, tempPath, beforeFingerprint, () => dependencies.afterCapture?.(attempt, options.configPath), () => dependencies.beforeBackupRelease?.(attempt, options.configPath), () => dependencies.afterFinalCheck?.(attempt, options.configPath));
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
                        if (hasPlanConflict(plan) || !plan.changed)
                            break attempts;
                        continue;
                    }
                    const verified = readBytesIfExists(options.configPath);
                    if (fingerprint(verified) !== fingerprint(plan.nextToml)) {
                        throw new Error("MCP config verification failed after atomic replacement");
                    }
                    appliedPlanChange = true;
                    dependencies.afterCommit?.(options.configPath);
                    break;
                }
                finally {
                    (0, node_fs_1.rmSync)(tempPath, { force: true });
                }
            }
        }
        const after = readBytesIfExists(options.configPath);
        const policyTransitionAccepted = !hasPlanConflict(plan) && (appliedPlanChange || !plan.changed);
        const completedAt = now().toISOString();
        const managedConfigurationChangedAt = appliedPlanChange || recoveredRetiredEdit
            ? completedAt
            : previousManagedConfigurationChangedAt;
        const receipt = {
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
            restartRequired: appliedPlanChange || recoveredRetiredEdit,
            managedConfigurationChangedAt,
        };
        writeReceipt(options.statePath, receipt);
        return receipt;
    }
    catch (error) {
        const completedAt = now().toISOString();
        const receipt = {
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
            afterFingerprint: fingerprint(readBytesIfExists(options.configPath)),
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
function casBackupPath(configPath) {
    return (0, node_path_1.join)((0, node_path_1.dirname)(configPath), `.${(0, node_path_1.basename)(configPath)}.tweakers-cas-backup`);
}
function retiredConfigPrefix(configPath) {
    return `.${(0, node_path_1.basename)(configPath)}.tweakers-cas-retired.`;
}
function retiredConfigPath(configPath, id, expectedFingerprint) {
    return (0, node_path_1.join)((0, node_path_1.dirname)(configPath), `${retiredConfigPrefix(configPath)}${id}.${expectedFingerprint}`);
}
function retiredBaselinePath(retiredPath) {
    return `${retiredPath}.baseline`;
}
function listRetiredConfigs(configPath) {
    const directory = (0, node_path_1.dirname)(configPath);
    const prefix = retiredConfigPrefix(configPath);
    if (!(0, node_fs_1.existsSync)(directory))
        return [];
    const retired = [];
    for (const name of (0, node_fs_1.readdirSync)(directory)) {
        if (!name.startsWith(prefix))
            continue;
        const remainder = name.slice(prefix.length);
        const separator = remainder.lastIndexOf(".");
        if (separator <= 0)
            continue;
        const id = remainder.slice(0, separator);
        const expectedFingerprint = remainder.slice(separator + 1);
        if (!/^[a-f0-9]{64}$/.test(expectedFingerprint))
            continue;
        const path = (0, node_path_1.join)(directory, name);
        try {
            retired.push({
                path,
                id,
                expectedFingerprint,
                currentFingerprint: fingerprint((0, node_fs_1.readFileSync)(path)),
                mtimeMs: (0, node_fs_1.statSync)(path).mtimeMs,
            });
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    return retired;
}
function sameInode(left, right) {
    try {
        const leftStat = (0, node_fs_1.statSync)(left);
        const rightStat = (0, node_fs_1.statSync)(right);
        return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
function retireCurrentConfig(configPath, expectedFingerprint) {
    const existingLink = listRetiredConfigs(configPath)
        .find((retired) => sameInode(retired.path, configPath));
    if (existingLink) {
        const retiredPath = existingLink.expectedFingerprint === expectedFingerprint
            ? existingLink.path
            : markRetiredConfigObserved(configPath, existingLink);
        ensureRetiredBaseline(retiredPath, expectedFingerprint);
        (0, node_fs_1.rmSync)(configPath, { force: true });
        fsyncDirectory((0, node_path_1.dirname)(configPath));
        return retiredPath;
    }
    const retiredPath = retiredConfigPath(configPath, (0, node_crypto_1.randomUUID)(), expectedFingerprint);
    const baseline = (0, node_fs_1.readFileSync)(configPath);
    if (fingerprint(baseline) !== expectedFingerprint) {
        throw new Error("MCP config changed while its retained-inode baseline was captured");
    }
    (0, node_fs_1.renameSync)(configPath, retiredPath);
    writeRetiredBaseline(retiredPath, baseline);
    fsyncDirectory((0, node_path_1.dirname)(configPath));
    return retiredPath;
}
function ensureRetiredBaseline(retiredPath, expectedFingerprint) {
    const baselinePath = retiredBaselinePath(retiredPath);
    if ((0, node_fs_1.existsSync)(baselinePath))
        return;
    const current = (0, node_fs_1.readFileSync)(retiredPath);
    if (fingerprint(current) !== expectedFingerprint) {
        throw new Error(`Cannot safely recover retained MCP config edit without its baseline: ${retiredPath}`);
    }
    writeRetiredBaseline(retiredPath, current);
}
function writeRetiredBaseline(retiredPath, content) {
    const baselinePath = retiredBaselinePath(retiredPath);
    const tempPath = writeDurableTemp(baselinePath, content, 0o600);
    try {
        (0, node_fs_1.renameSync)(tempPath, baselinePath);
        fsyncDirectory((0, node_path_1.dirname)(baselinePath));
    }
    finally {
        (0, node_fs_1.rmSync)(tempPath, { force: true });
    }
}
function captureActiveConfig(configPath) {
    const activePath = casBackupPath(configPath);
    (0, node_fs_1.rmSync)(activePath, { force: true });
    (0, node_fs_1.linkSync)(configPath, activePath);
    fsyncDirectory((0, node_path_1.dirname)(configPath));
}
function releaseActiveConfig(configPath) {
    (0, node_fs_1.rmSync)(casBackupPath(configPath), { force: true });
    fsyncDirectory((0, node_path_1.dirname)(configPath));
}
function markRetiredConfigObserved(configPath, retired) {
    const observed = readBytesIfExists(retired.path);
    const observedFingerprint = fingerprint(observed);
    const observedPath = retiredConfigPath(configPath, retired.id, observedFingerprint);
    const previousBaselinePath = retiredBaselinePath(retired.path);
    if (observedPath !== retired.path)
        (0, node_fs_1.renameSync)(retired.path, observedPath);
    writeRetiredBaseline(observedPath, observed);
    if (previousBaselinePath !== retiredBaselinePath(observedPath)) {
        (0, node_fs_1.rmSync)(previousBaselinePath, { force: true });
    }
    return observedPath;
}
function recoverRetiredConfigEdits(configPath, tweaks, ownedTweaks, preservedOptions, preservedApprovalPolicy) {
    let retired = listRetiredConfigs(configPath);
    if (!(0, node_fs_1.existsSync)(configPath) && retired.length > 0) {
        const latest = [...retired].sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))[0];
        (0, node_fs_1.linkSync)(latest.path, configPath);
        fsyncDirectory((0, node_path_1.dirname)(configPath));
    }
    retired = listRetiredConfigs(configPath);
    const changed = retired
        .filter((entry) => entry.currentFingerprint !== entry.expectedFingerprint)
        .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    for (const entry of changed) {
        if (!(0, node_fs_1.existsSync)(entry.path))
            continue;
        let mergedRetiredFingerprint;
        if (!sameInode(entry.path, configPath)) {
            if ((0, node_fs_1.existsSync)(configPath)) {
                mergedRetiredFingerprint = mergeRetiredConfigEdit(configPath, entry, tweaks, ownedTweaks, preservedOptions, preservedApprovalPolicy);
            }
            else {
                (0, node_fs_1.linkSync)(entry.path, configPath);
            }
        }
        if (mergedRetiredFingerprint
            && fingerprint(readBytesIfExists(entry.path)) !== mergedRetiredFingerprint) {
            // The retained editor wrote again while its prior save was being merged.
            // Leave the old expected fingerprint in place so the watcher imports the
            // newer save on its next pass rather than marking unseen bytes observed.
            continue;
        }
        markRetiredConfigObserved(configPath, entry);
        fsyncDirectory((0, node_path_1.dirname)(configPath));
    }
    return changed.length > 0;
}
function mergeRetiredConfigEdit(configPath, retired, tweaks, ownedTweaks, preservedOptions, preservedApprovalPolicy) {
    const baselinePath = retiredBaselinePath(retired.path);
    if (!(0, node_fs_1.existsSync)(baselinePath)) {
        throw new Error(`Cannot safely merge retained MCP config edit without its baseline: ${retired.path}`);
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
        const mode = (0, node_fs_1.statSync)(configPath).mode & 0o777;
        const tempPath = writeDurableTemp(configPath, next, mode);
        try {
            if (promoteConfigWithCas(configPath, tempPath, currentFingerprint, () => undefined, () => undefined, () => undefined)) {
                return fingerprint(retiredBytes);
            }
        }
        finally {
            (0, node_fs_1.rmSync)(tempPath, { force: true });
        }
        if (attempt === 2) {
            throw new Error("Codex config changed during retained MCP edit recovery twice; no recovery was applied");
        }
    }
    throw new Error("Retained MCP config recovery ended without a merge result");
}
function recoverInterruptedCas(configPath) {
    const backup = casBackupPath(configPath);
    if (!(0, node_fs_1.existsSync)(backup))
        return;
    if (!(0, node_fs_1.existsSync)(configPath)) {
        try {
            (0, node_fs_1.linkSync)(backup, configPath);
            fsyncDirectory((0, node_path_1.dirname)(configPath));
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
    }
    (0, node_fs_1.rmSync)(backup, { force: true });
}
/**
 * Capture the exact old pathname, then publish with an exclusive hard link.
 * An external writer in the former read/rename window either becomes the new
 * pathname (and is replanned) or makes the link fail; it is never overwritten.
 */
function promoteConfigWithCas(configPath, tempPath, expectedFingerprint, afterCapture, beforeBackupRelease, afterFinalCheck) {
    let backup;
    let captured = false;
    try {
        if ((0, node_fs_1.existsSync)(configPath)) {
            captureActiveConfig(configPath);
            backup = retireCurrentConfig(configPath, expectedFingerprint);
            captured = true;
            afterCapture();
            if (fingerprint(readBytesIfExists(backup)) !== expectedFingerprint) {
                restoreCapturedConfig(backup, configPath);
                return false;
            }
        }
        else {
            afterCapture();
        }
        try {
            (0, node_fs_1.linkSync)(tempPath, configPath);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
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
    }
    catch (error) {
        if (captured && backup) {
            if ((0, node_fs_1.existsSync)(configPath)
                && fingerprint(readBytesIfExists(configPath)) === fingerprint(readBytesIfExists(tempPath))) {
                (0, node_fs_1.rmSync)(configPath, { force: true });
            }
            if (!(0, node_fs_1.existsSync)(configPath))
                restoreCapturedConfig(backup, configPath);
        }
        releaseActiveConfig(configPath);
        throw error;
    }
}
function restoreCapturedEditIfChanged(backup, configPath, tempPath, expectedFingerprint) {
    if (fingerprint(readBytesIfExists(backup)) === expectedFingerprint)
        return false;
    // A writer held the old inode open and changed it after pathname capture.
    // Remove only our just-linked candidate, restore/preserve external bytes,
    // and replan instead of silently discarding that edit.
    if (fingerprint(readBytesIfExists(configPath)) === fingerprint(readBytesIfExists(tempPath))) {
        (0, node_fs_1.rmSync)(configPath, { force: true });
    }
    restoreCapturedConfig(backup, configPath);
    return true;
}
function restoreCapturedConfig(backup, configPath) {
    let restored = false;
    try {
        (0, node_fs_1.linkSync)(backup, configPath);
        restored = true;
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        restored = sameInode(backup, configPath);
    }
    finally {
        if (restored)
            (0, node_fs_1.rmSync)(backup, { force: true });
        releaseActiveConfig(configPath);
        fsyncDirectory((0, node_path_1.dirname)(configPath));
    }
}
function createMcpReconciler(options, dependencies = {}) {
    const debounceMs = options.debounceMs ?? 250;
    const reconcile = dependencies.reconcileConfig ?? reconcileMcpConfig;
    const pending = [];
    let timer;
    let running;
    let closed = false;
    let lastAppliedFingerprint;
    const schedule = (immediate = false) => {
        if (closed || running || timer)
            return;
        timer = setTimeout(() => {
            timer = undefined;
            // Start on the next microtask so `running` is visible to requests that
            // arrive from synchronous reconciliation hooks.
            running = Promise.resolve().then(runPending).finally(() => {
                running = undefined;
                if (pending.length > 0)
                    schedule();
            });
        }, immediate ? 0 : debounceMs);
    };
    const runPending = async () => {
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
                for (const request of batch)
                    request.resolve(receipt);
            }
            catch (error) {
                options.onError?.(error);
                for (const request of batch)
                    request.reject(error);
            }
        }
    };
    const enqueue = (trigger, immediate) => {
        if (closed)
            return Promise.reject(new Error("MCP reconciler is closed"));
        const promise = new Promise((resolve, reject) => {
            pending.push({ trigger, resolve, reject });
        });
        if (immediate && timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        schedule(immediate);
        return promise;
    };
    const onConfigChange = (changedPath) => {
        if (closed)
            return;
        if (changedPath && changedPath !== options.configPath) {
            void enqueue("config-change", false).catch((error) => options.onError?.(error));
            return;
        }
        const observedFingerprint = fingerprint(readBytesIfExists(options.configPath));
        if (observedFingerprint === lastAppliedFingerprint)
            return;
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
            for (const request of pending.splice(0))
                request.reject(error);
        },
    };
}
function readMcpSyncState(statePath) {
    if (!(0, node_fs_1.existsSync)(statePath))
        return null;
    try {
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(statePath, "utf8"));
        if (parsed?.schemaVersion !== 1 && parsed?.schemaVersion !== 2)
            return null;
        const rawOptions = parsed.preservedOptions;
        const optionNames = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
            ? Object.keys(rawOptions)
            : [];
        const managedConfigurationChangedAt = normalizedTimestamp(parsed.managedConfigurationChangedAt) ?? (parsed.restartRequired === true
            ? normalizedTimestamp(parsed.completedAt)
            : null);
        return {
            ...parsed,
            schemaVersion: 2,
            phase: parsed.schemaVersion === 2 && parsed.phase === "prepared" ? "prepared" : "complete",
            preservedOptions: (0, mcp_sync_1.sanitizePreservedMcpOptions)(rawOptions, optionNames),
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
                ? (0, mcp_sync_1.sanitizePreservedApprovalPolicy)(parsed.preservedApprovalPolicy)
                : null,
            managedConfigurationChangedAt,
        };
    }
    catch {
        return null;
    }
}
function normalizedTimestamp(value) {
    if (typeof value !== "string")
        return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function readPreservedApprovalPolicy(statePath, configPath) {
    const state = readMcpSyncState(statePath);
    const preserved = (0, mcp_sync_1.sanitizePreservedApprovalPolicy)(state?.preservedApprovalPolicy);
    if (!state || state.phase !== "prepared" || !preserved)
        return preserved;
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
function readPreservedOptions(statePath, ownedTweaks) {
    const receipt = readMcpSyncState(statePath);
    return (0, mcp_sync_1.sanitizePreservedMcpOptions)(receipt?.preservedOptions, ownedTweaks.map((tweak) => (0, mcp_sync_1.mcpServerNameFromTweakId)(tweak.manifest.id)));
}
function fingerprint(value) {
    return (0, node_crypto_1.createHash)("sha256").update(value).digest("hex");
}
function planMcpConfigReconciliation(tweaks, currentToml, options = {}) {
    const mcpPlan = (0, mcp_sync_1.planManagedMcpReconciliation)(tweaks, currentToml, options);
    const ownedTweaks = options.ownedTweaks ?? tweaks;
    const preservedApprovalPolicy = (0, mcp_sync_1.sanitizePreservedApprovalPolicy)(options.preservedApprovalPolicy);
    const approvalPolicy = ownedTweaks.some((tweak) => tweak.manifest.id === "co.tweakers.user-questions")
        ? (0, mcp_sync_1.observeUserQuestionsApprovalPolicy)(currentToml, preservedApprovalPolicy)
        : mcpPlan.approvalPolicy;
    const plan = {
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
function managedBlocksDifferOnlyByLiveRoot(currentToml, plannedToml, tweaks) {
    if ((0, mcp_sync_1.stripManagedMcpBlock)(currentToml) !== (0, mcp_sync_1.stripManagedMcpBlock)(plannedToml))
        return false;
    const currentBlock = extractManagedBlock(currentToml);
    const plannedBlock = extractManagedBlock(plannedToml);
    if (!currentBlock || !plannedBlock)
        return false;
    const tweaksByServerName = new Map(tweaks.map((tweak) => [(0, mcp_sync_1.mcpServerNameFromTweakId)(tweak.manifest.id), tweak]));
    const currentLines = currentBlock.trimEnd().split(/\r?\n/);
    const plannedLines = plannedBlock.trimEnd().split(/\r?\n/);
    if (currentLines.length !== plannedLines.length)
        return false;
    let activeTweak;
    let alternateTweakDir;
    for (let index = 0; index < plannedLines.length; index += 1) {
        const expected = plannedLines[index] ?? "";
        const observed = currentLines[index] ?? "";
        const table = /^\[mcp_servers\.([^\]]+)\]$/.exec(expected);
        if (table) {
            activeTweak = tweaksByServerName.get(table[1] ?? "");
            alternateTweakDir = undefined;
            if (!activeTweak || observed !== expected)
                return false;
            continue;
        }
        if (observed === expected)
            continue;
        if (!activeTweak
            || !/^(?:command|args)\s*=/.test(expected)
            || !rootAwareGeneratedLineMatches(observed, expected, activeTweak, (alternate) => {
                if (alternateTweakDir && alternateTweakDir !== alternate)
                    return false;
                if (!alternateTweakMatches(activeTweak, alternate))
                    return false;
                alternateTweakDir = alternate;
                return true;
            })) {
            return false;
        }
    }
    return true;
}
function rootAwareGeneratedLineMatches(observedLine, expectedLine, expectedTweak, acceptAlternateDir) {
    const expectedTweakDir = expectedTweak.dir;
    const observed = splitJsonStringTokens(observedLine);
    const expected = splitJsonStringTokens(expectedLine);
    if (observed.literals.length !== expected.literals.length
        || observed.values.length !== expected.values.length
        || observed.literals.some((literal, index) => literal !== expected.literals[index])) {
        return false;
    }
    for (let index = 0; index < expected.values.length; index += 1) {
        const expectedValue = expected.values[index] ?? "";
        const observedValue = observed.values[index] ?? "";
        if (expectedValue === observedValue)
            continue;
        if (!expectedValue.startsWith(`${expectedTweakDir}/`)
            || !(0, node_path_1.isAbsolute)(observedValue)) {
            return false;
        }
        const suffix = expectedValue.slice(expectedTweakDir.length);
        if (!observedValue.endsWith(suffix))
            return false;
        const alternateDir = observedValue.slice(0, -suffix.length);
        if (!(0, node_path_1.isAbsolute)(alternateDir)
            || !(0, node_fs_1.existsSync)(alternateDir)
            || !(0, node_fs_1.existsSync)(expectedValue)
            || !(0, node_fs_1.existsSync)(observedValue)
            || !exactFileContentsMatch(expectedValue, observedValue)
            || !acceptAlternateDir(alternateDir)) {
            return false;
        }
    }
    return true;
}
function alternateTweakMatches(expected, alternateDir) {
    try {
        const expectedManifestBytes = (0, node_fs_1.readFileSync)((0, node_path_1.join)(expected.dir, "manifest.json"));
        const alternateManifestBytes = (0, node_fs_1.readFileSync)((0, node_path_1.join)(alternateDir, "manifest.json"));
        if (!expectedManifestBytes.equals(alternateManifestBytes))
            return false;
        const manifest = JSON.parse(alternateManifestBytes.toString("utf8"));
        if (!isRecord(manifest) || manifest.id !== expected.manifest.id)
            return false;
        const expectedMcp = normalizeManifestMcp(expected.manifest.mcp);
        const alternateMcp = normalizeManifestMcp(manifest.mcp);
        return expectedMcp !== null
            && alternateMcp !== null
            && expectedMcp.command === alternateMcp.command
            && stringArraysEqual(expectedMcp.args, alternateMcp.args)
            && stringRecordsEqual(expectedMcp.env, alternateMcp.env);
    }
    catch {
        return false;
    }
}
function exactFileContentsMatch(expectedPath, observedPath) {
    try {
        const expectedStat = (0, node_fs_1.statSync)(expectedPath);
        const observedStat = (0, node_fs_1.statSync)(observedPath);
        return expectedStat.isFile()
            && observedStat.isFile()
            && expectedStat.size === observedStat.size
            && (0, node_fs_1.readFileSync)(expectedPath).equals((0, node_fs_1.readFileSync)(observedPath));
    }
    catch {
        return false;
    }
}
function normalizeManifestMcp(value) {
    if (!isRecord(value) || typeof value.command !== "string" || value.command.length === 0)
        return null;
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))) {
        return null;
    }
    if (value.env !== undefined && (!isRecord(value.env)
        || Object.values(value.env).some((envValue) => typeof envValue !== "string"))) {
        return null;
    }
    return {
        command: value.command,
        args: value.args === undefined ? [] : value.args,
        env: value.env === undefined ? {} : value.env,
    };
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringArraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function stringRecordsEqual(left, right) {
    const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return leftEntries.length === rightEntries.length
        && leftEntries.every(([key, value], index) => (key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1]));
}
function splitJsonStringTokens(line) {
    const literals = [];
    const values = [];
    const pattern = /"(?:\\.|[^"\\])*"/g;
    let cursor = 0;
    for (const match of line.matchAll(pattern)) {
        const index = match.index ?? 0;
        literals.push(line.slice(cursor, index));
        try {
            values.push(JSON.parse(match[0]));
        }
        catch {
            return { literals: [line], values: [] };
        }
        cursor = index + match[0].length;
    }
    literals.push(line.slice(cursor));
    return { literals, values };
}
function extractManagedBlock(document) {
    let start;
    for (const line of classifyStructuralLines(document)) {
        if (!line.structural)
            continue;
        const marker = line.text.trim();
        if (marker === mcp_sync_1.MCP_MANAGED_START) {
            if (start !== undefined)
                return null;
            start = line.start;
        }
        else if (marker === mcp_sync_1.MCP_MANAGED_END) {
            if (start === undefined)
                return null;
            return document.slice(start, line.end);
        }
    }
    return null;
}
function classifyStructuralLines(document) {
    const lines = [];
    let lineStart = 0;
    let multiline = null;
    let quote = null;
    let escaped = false;
    let comment = false;
    const push = (end) => {
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
                if (character === "\r" && document[index + 1] === "\n")
                    index += 1;
                push(index + 1);
            }
            if (multiline === "basic") {
                if (escaped)
                    escaped = false;
                else if (character === "\\")
                    escaped = true;
            }
            continue;
        }
        if (comment) {
            if (character === "\n" || character === "\r") {
                if (character === "\r" && document[index + 1] === "\n")
                    index += 1;
                push(index + 1);
                comment = false;
            }
            continue;
        }
        if (quote) {
            if (quote === "basic") {
                if (escaped)
                    escaped = false;
                else if (character === "\\")
                    escaped = true;
                else if (character === '\"')
                    quote = null;
            }
            else if (character === "'")
                quote = null;
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
            if (character === "\r" && document[index + 1] === "\n")
                index += 1;
            push(index + 1);
        }
    }
    if (lineStart < document.length || document.length === 0)
        push(document.length);
    return lines;
}
function managedBlockFreeDocument(value) {
    const document = decodeToml(value);
    return (0, mcp_sync_1.planManagedMcpReconciliation)([], document).nextToml;
}
function mergeTextDocuments(baseline, current, retired) {
    if (retired === baseline || retired === current)
        return current;
    if (current === baseline)
        return retired;
    const baseLines = splitLines(baseline);
    const currentChanges = diffLineChanges(baseLines, splitLines(current), "current");
    const retiredChanges = diffLineChanges(baseLines, splitLines(retired), "retired");
    for (const left of currentChanges) {
        for (const right of retiredChanges) {
            const same = left.start === right.start
                && left.end === right.end
                && arraysEqual(left.replacement, right.replacement);
            if (same)
                continue;
            const bothInsert = left.start === left.end
                && right.start === right.end
                && left.start === right.start;
            if (bothInsert)
                continue;
            if (!(left.end <= right.start || right.end <= left.start)) {
                throw new Error("Retained MCP config edit conflicts with a newer current edit; both files were preserved");
            }
        }
    }
    const combined = [...currentChanges, ...retiredChanges]
        .filter((change, index, all) => !all.slice(0, index).some((previous) => (previous.start === change.start
        && previous.end === change.end
        && arraysEqual(previous.replacement, change.replacement))))
        .sort((left, right) => (left.start - right.start
        || left.end - right.end
        || (left.source === right.source ? 0 : left.source === "current" ? -1 : 1)));
    const result = [];
    let cursor = 0;
    for (const change of combined) {
        result.push(...baseLines.slice(cursor, change.start), ...change.replacement);
        cursor = Math.max(cursor, change.end);
    }
    result.push(...baseLines.slice(cursor));
    return result.join("");
}
function splitLines(value) {
    return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function diffLineChanges(baseline, variant, source) {
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
                ? 1 + lcs[(left + 1) * width + right + 1]
                : Math.max(lcs[(left + 1) * width + right], lcs[left * width + right + 1]);
        }
    }
    const changes = [];
    let left = 0;
    let right = 0;
    while (left < baseline.length || right < variant.length) {
        if (left < baseline.length && right < variant.length && baseline[left] === variant[right]) {
            left += 1;
            right += 1;
            continue;
        }
        const start = left;
        const replacement = [];
        while (left < baseline.length || right < variant.length) {
            if (left < baseline.length && right < variant.length && baseline[left] === variant[right])
                break;
            const insertScore = right < variant.length ? lcs[left * width + right + 1] : -1;
            const deleteScore = left < baseline.length ? lcs[(left + 1) * width + right] : -1;
            if (right < variant.length && insertScore >= deleteScore) {
                replacement.push(variant[right]);
                right += 1;
            }
            else {
                left += 1;
            }
        }
        changes.push({ start, end: left, replacement, source });
    }
    return changes;
}
function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function emptyReconciliationPlan() {
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
function replanAfterConcurrentEdit({ attempt, observed, tweaks, ownedTweaks, preservedOptions, preservedApprovalPolicy, }) {
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
function emptyApprovalPolicyReconciliation() {
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
function hasPlanConflict(plan) {
    return plan.conflicts.length > 0 || plan.approvalPolicy.status === "conflict";
}
function readBytesIfExists(path) {
    return (0, node_fs_1.existsSync)(path) ? (0, node_fs_1.readFileSync)(path) : Buffer.alloc(0);
}
function decodeToml(value) {
    try {
        return new node_util_1.TextDecoder("utf-8", { fatal: true }).decode(value);
    }
    catch {
        throw new Error("Malformed TOML: config.toml is not valid UTF-8");
    }
}
function writeReceipt(statePath, receipt) {
    const content = `${JSON.stringify(receipt, null, 2)}\n`;
    const tempPath = writeDurableTemp(statePath, content, 0o600);
    try {
        (0, node_fs_1.renameSync)(tempPath, statePath);
        fsyncDirectory((0, node_path_1.dirname)(statePath));
    }
    finally {
        (0, node_fs_1.rmSync)(tempPath, { force: true });
    }
}
function writeDurableTemp(destination, content, mode) {
    const directory = (0, node_path_1.dirname)(destination);
    (0, node_fs_1.mkdirSync)(directory, { recursive: true });
    const tempPath = (0, node_path_1.join)(directory, `.${(0, node_path_1.basename)(destination)}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.tmp`);
    const descriptor = (0, node_fs_1.openSync)(tempPath, "wx", mode);
    let completed = false;
    try {
        (0, node_fs_1.writeFileSync)(descriptor, content);
        (0, node_fs_1.fsyncSync)(descriptor);
        completed = true;
    }
    finally {
        (0, node_fs_1.closeSync)(descriptor);
        if (!completed)
            (0, node_fs_1.rmSync)(tempPath, { force: true });
    }
    return tempPath;
}
function fsyncDirectory(directory) {
    let descriptor;
    try {
        descriptor = (0, node_fs_1.openSync)(directory, "r");
        (0, node_fs_1.fsyncSync)(descriptor);
    }
    catch {
        // Some supported filesystems do not allow directory fsync.
    }
    finally {
        if (descriptor !== undefined)
            (0, node_fs_1.closeSync)(descriptor);
    }
}
function defaultConfigWatcher(configPath, onChange) {
    // Keep reconciliation importable by the headless environment transaction
    // helper without loading the watcher dependency. The desktop reconciler is
    // the only caller that reaches this branch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chokidar = require("chokidar");
    const watcher = chokidar.watch((0, node_path_1.dirname)(configPath), {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: {
            stabilityThreshold: 100,
            pollInterval: 25,
        },
    });
    const handlePath = (changedPath) => {
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
//# sourceMappingURL=mcp-reconciliation.js.map