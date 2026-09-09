"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCOUNTS_TRANSFER_RECOVERY_FILE = void 0;
exports.verifyAccountsTransferRecovery = verifyAccountsTransferRecovery;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const watcher_health_1 = require("../watcher-health");
const native_transfer_1 = require("./native-transfer");
const native_source_retirement_1 = require("./native-source-retirement");
exports.ACCOUNTS_TRANSFER_RECOVERY_FILE = "accounts-transfer-recovery.v1.json";
/**
 * This is checked before the first v2 publication and every later preparation.
 * Missing, replaced or incompatible recovery artifacts keep transfer held.
 * It never edits a user home or imports code from a caller-selected directory.
 */
function verifyAccountsTransferRecovery(runtimeRoot) {
    try {
        if (native_transfer_1.ACCOUNTS_TRANSFER_READER_VERSION !== 2
            || native_source_retirement_1.ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION !== 2
            || (0, native_source_retirement_1.inspectNativeSourceRetirementCompatibilityV2)(2).state !== "compatible"
            || (0, native_source_retirement_1.inspectNativeSourceRetirementCompatibilityV2)(1).state !== "incompatible"
            || !(0, node_path_1.isAbsolute)(runtimeRoot))
            return false;
        const root = (0, node_fs_1.realpathSync)(runtimeRoot);
        if (!(0, watcher_health_1.readRuntimeFingerprintEvidence)(root))
            return false;
        const receiptPath = (0, node_path_1.join)(root, exports.ACCOUNTS_TRANSFER_RECOVERY_FILE);
        const identity = (0, node_fs_1.lstatSync)(receiptPath);
        if (!identity.isFile() || identity.isSymbolicLink() || identity.size > 16 * 1024)
            return false;
        const receipt = JSON.parse((0, node_fs_1.readFileSync)(receiptPath, "utf8"));
        if (receipt.version !== 1 || receipt.readerVersion !== 2
            || JSON.stringify(receipt.supportedTransferVersions) !== "[1,2]"
            || receipt.sourceRetirementReaderVersion !== 2
            || JSON.stringify(receipt.supportedSourceRetirementVersions) !== "[2]"
            || typeof receipt.recoveryRuntimeRoot !== "string" || !(0, node_path_1.isAbsolute)(receipt.recoveryRuntimeRoot)
            || receipt.recoveryRuntimeRoot !== (0, node_path_1.resolve)(receipt.recoveryRuntimeRoot)
            || !/^[a-f0-9]{64}$/.test(receipt.runtimeTransferSha256 ?? "")
            || !/^[a-f0-9]{64}$/.test(receipt.runtimeSourceRetirementSha256 ?? "")
            || !/^[a-f0-9]{64}$/.test(receipt.recoveryFingerprint ?? "")
            || !/^[a-f0-9]{64}$/.test(receipt.validationSha256 ?? "")
            || !/^[a-f0-9]{64}$/.test(receipt.sourceRuntimeFingerprint ?? "")
            || !Number.isInteger(receipt.sourceRuntimeFileCount) || Number(receipt.sourceRuntimeFileCount) < 1
            || typeof receipt.verifiedAt !== "string" || !Number.isFinite(Date.parse(receipt.verifiedAt)))
            return false;
        const recovery = (0, node_fs_1.realpathSync)(receipt.recoveryRuntimeRoot);
        if (recovery !== receipt.recoveryRuntimeRoot || recovery === root || recovery.startsWith(root + "/"))
            return false;
        const fingerprint = (0, watcher_health_1.readRuntimeFingerprintEvidence)(recovery);
        if (!fingerprint || fingerprint.fingerprint !== receipt.recoveryFingerprint)
            return false;
        const validationPath = (0, node_path_1.join)(recovery, "accounts-transfer-validation.v1.json");
        const validationStat = (0, node_fs_1.lstatSync)(validationPath);
        if (!validationStat.isFile() || validationStat.isSymbolicLink() || validationStat.size > 64 * 1024)
            return false;
        const validationBytes = (0, node_fs_1.readFileSync)(validationPath);
        if ((0, node_crypto_1.createHash)("sha256").update(validationBytes).digest("hex") !== receipt.validationSha256)
            return false;
        const validation = JSON.parse(validationBytes.toString("utf8"));
        if (validation.version !== 1 || !Array.isArray(validation.checks) || !validation.checks.length
            || validation.sourceRuntimeFingerprint !== receipt.sourceRuntimeFingerprint
            || validation.sourceRuntimeFileCount !== receipt.sourceRuntimeFileCount
            || validation.checks.some((check) => !check
                || typeof check.command !== "string" || !check.command || check.exitCode !== 0
                || typeof check.outputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(check.outputSha256)))
            return false;
        const sourceBeforeMetadata = fingerprintRuntimeExcluding(root, new Set([exports.ACCOUNTS_TRANSFER_RECOVERY_FILE]));
        const recoveryBeforeMetadata = fingerprintRuntimeExcluding(recovery, new Set(["accounts-transfer-validation.v1.json"]));
        if (sourceBeforeMetadata.fingerprint !== receipt.sourceRuntimeFingerprint
            || recoveryBeforeMetadata.fingerprint !== receipt.sourceRuntimeFingerprint
            || sourceBeforeMetadata.fileCount !== receipt.sourceRuntimeFileCount
            || recoveryBeforeMetadata.fileCount !== receipt.sourceRuntimeFileCount)
            return false;
        for (const directory of [root, recovery]) {
            for (const [relativePath, expected] of [
                [(0, node_path_1.join)("account-router", "native-transfer.js"), receipt.runtimeTransferSha256],
                [(0, node_path_1.join)("account-router", "native-source-retirement.js"), receipt.runtimeSourceRetirementSha256],
            ]) {
                const path = (0, node_path_1.join)(directory, relativePath);
                const stat = (0, node_fs_1.lstatSync)(path);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
                    return false;
                if ((0, node_crypto_1.createHash)("sha256").update((0, node_fs_1.readFileSync)(path)).digest("hex") !== expected)
                    return false;
            }
        }
        return true;
    }
    catch {
        return false;
    }
}
function fingerprintRuntimeExcluding(runtimeRoot, excludedRootFiles) {
    const hash = (0, node_crypto_1.createHash)("sha256");
    let fileCount = 0;
    const walk = (directory) => {
        for (const entry of (0, node_fs_1.readdirSync)(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.name === ".DS_Store")
                continue;
            const path = (0, node_path_1.join)(directory, entry.name);
            const name = (0, node_path_1.relative)(runtimeRoot, path);
            if (name === "runtime-fingerprint.json" || excludedRootFiles.has(name))
                continue;
            if (entry.isDirectory()) {
                walk(path);
            }
            else if (entry.isFile()) {
                fileCount += 1;
                hash.update(name);
                hash.update("\0");
                hash.update((0, node_fs_1.readFileSync)(path));
                hash.update("\0");
            }
        }
    };
    walk(runtimeRoot);
    return { fingerprint: hash.digest("hex"), fileCount };
}
//# sourceMappingURL=transfer-recovery.js.map