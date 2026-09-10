import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readRuntimeFingerprintEvidence } from "../watcher-health";
import { ACCOUNTS_TRANSFER_READER_VERSION } from "./native-transfer";
import {
  ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION,
  inspectNativeSourceRetirementCompatibilityV2,
} from "./native-source-retirement";

export const ACCOUNTS_TRANSFER_RECOVERY_FILE = "accounts-transfer-recovery.v1.json";

/** A prepared recovery runtime can read both formats but need not enable new transfers. */
export interface AccountsTransferRecoveryReceiptV1 {
  version: 1;
  readerVersion: 2;
  supportedTransferVersions: [1, 2];
  sourceRetirementReaderVersion: 2;
  supportedSourceRetirementVersions: [2];
  runtimeTransferSha256: string;
  runtimeSourceRetirementSha256: string;
  recoveryRuntimeRoot: string;
  recoveryFingerprint: string;
  validationSha256: string;
  sourceRuntimeFingerprint: string;
  sourceRuntimeFileCount: number;
  verifiedAt: string;
}

/**
 * This is checked before the first v2 publication and every later preparation.
 * Missing, replaced or incompatible recovery artifacts keep transfer held.
 * It never edits a user home or imports code from a caller-selected directory.
 */
export function verifyAccountsTransferRecovery(runtimeRoot: string): boolean {
  try {
    if (ACCOUNTS_TRANSFER_READER_VERSION !== 2
      || ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION !== 2
      || inspectNativeSourceRetirementCompatibilityV2(2).state !== "compatible"
      || inspectNativeSourceRetirementCompatibilityV2(1).state !== "incompatible"
      || !isAbsolute(runtimeRoot)) return false;
    const root = realpathSync(runtimeRoot);
    if (!readRuntimeFingerprintEvidence(root)) return false;
    const receiptPath = join(root, ACCOUNTS_TRANSFER_RECOVERY_FILE);
    const identity = lstatSync(receiptPath);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.size > 16 * 1024) return false;
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Partial<AccountsTransferRecoveryReceiptV1>;
    if (receipt.version !== 1 || receipt.readerVersion !== 2
      || JSON.stringify(receipt.supportedTransferVersions) !== "[1,2]"
      || receipt.sourceRetirementReaderVersion !== 2
      || JSON.stringify(receipt.supportedSourceRetirementVersions) !== "[2]"
      || typeof receipt.recoveryRuntimeRoot !== "string" || !isAbsolute(receipt.recoveryRuntimeRoot)
      || receipt.recoveryRuntimeRoot !== resolve(receipt.recoveryRuntimeRoot)
      || !/^[a-f0-9]{64}$/.test(receipt.runtimeTransferSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(receipt.runtimeSourceRetirementSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(receipt.recoveryFingerprint ?? "")
      || !/^[a-f0-9]{64}$/.test(receipt.validationSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(receipt.sourceRuntimeFingerprint ?? "")
      || !Number.isInteger(receipt.sourceRuntimeFileCount) || Number(receipt.sourceRuntimeFileCount) < 1
      || typeof receipt.verifiedAt !== "string" || !Number.isFinite(Date.parse(receipt.verifiedAt))) return false;
    const recovery = realpathSync(receipt.recoveryRuntimeRoot);
    if (recovery !== receipt.recoveryRuntimeRoot || recovery === root || recovery.startsWith(root + "/")) return false;
    const fingerprint = readRuntimeFingerprintEvidence(recovery);
    if (!fingerprint || fingerprint.fingerprint !== receipt.recoveryFingerprint) return false;
    const validationPath = join(recovery, "accounts-transfer-validation.v1.json");
    const validationStat = lstatSync(validationPath);
    if (!validationStat.isFile() || validationStat.isSymbolicLink() || validationStat.size > 64 * 1024) return false;
    const validationBytes = readFileSync(validationPath);
    if (createHash("sha256").update(validationBytes).digest("hex") !== receipt.validationSha256) return false;
    const validation = JSON.parse(validationBytes.toString("utf8")) as {
      version?: unknown;
      checks?: unknown;
      sourceRuntimeFingerprint?: unknown;
      sourceRuntimeFileCount?: unknown;
    };
    if (validation.version !== 1 || !Array.isArray(validation.checks) || !validation.checks.length
      || validation.sourceRuntimeFingerprint !== receipt.sourceRuntimeFingerprint
      || validation.sourceRuntimeFileCount !== receipt.sourceRuntimeFileCount
      || validation.checks.some((check: { command?: unknown; exitCode?: unknown; outputSha256?: unknown }) => !check
        || typeof check.command !== "string" || !check.command || check.exitCode !== 0
        || typeof check.outputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(check.outputSha256))) return false;
    const sourceBeforeMetadata = fingerprintRuntimeExcluding(root, new Set([ACCOUNTS_TRANSFER_RECOVERY_FILE]));
    const recoveryBeforeMetadata = fingerprintRuntimeExcluding(recovery, new Set(["accounts-transfer-validation.v1.json"]));
    if (sourceBeforeMetadata.fingerprint !== receipt.sourceRuntimeFingerprint
      || recoveryBeforeMetadata.fingerprint !== receipt.sourceRuntimeFingerprint
      || sourceBeforeMetadata.fileCount !== receipt.sourceRuntimeFileCount
      || recoveryBeforeMetadata.fileCount !== receipt.sourceRuntimeFileCount) return false;
    for (const directory of [root, recovery]) {
      for (const [relativePath, expected] of [
        [join("account-router", "native-transfer.js"), receipt.runtimeTransferSha256],
        [join("account-router", "native-source-retirement.js"), receipt.runtimeSourceRetirementSha256],
      ] as const) {
        const path = join(directory, relativePath);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return false;
        if (createHash("sha256").update(readFileSync(path)).digest("hex") !== expected) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function fingerprintRuntimeExcluding(
  runtimeRoot: string,
  excludedRootFiles: ReadonlySet<string>,
): { fingerprint: string; fileCount: number } {
  const hash = createHash("sha256");
  let fileCount = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".DS_Store") continue;
      const path = join(directory, entry.name);
      const name = relative(runtimeRoot, path);
      if (name === "runtime-fingerprint.json" || excludedRootFiles.has(name)) continue;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        fileCount += 1;
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  walk(runtimeRoot);
  return { fingerprint: hash.digest("hex"), fileCount };
}
