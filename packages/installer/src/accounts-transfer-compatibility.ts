import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cloneOrCopyDirectoryPreservingModes } from "./fs-copy.js";
import { computeRuntimeFingerprint, readRuntimeFingerprintEvidence } from "./runtime-fingerprint.js";
import { TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG } from "./macos-variant-bindings.js";

const TWEAK_ID = "co.tweakers.account-switcher";
const MARKER = "native-transfer.minimum-runtime.json";
const RECOVERY_FILE = "accounts-transfer-recovery.v1.json";
const VALIDATION_FILE = "accounts-transfer-validation.v1.json";
const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function publishPreparedRuntimeFingerprint(root: string): void {
  const contents = JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(root) }) + "\n";
  const temporary = join(root, `.runtime-fingerprint-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    // Sealed sources have read-only files. Replace this candidate-owned metadata
    // atomically instead of mutating permissions or overwriting the source inode.
    renameSync(temporary, join(root, "runtime-fingerprint.json"));
  } finally { rmSync(temporary, { force: true }); }
}

function regularFile(path: string, limit: number): Buffer | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("Unsafe Accounts compatibility evidence");
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Observe the exact variant binding and the older environment-local namespace. */
export function accountsTransferBrokerRoots(userRoot: string, appRoot?: string): string[] {
  const roots = new Set([join(resolve(userRoot), "tweak-data", TWEAK_ID)]);
  if (resolve(userRoot).endsWith("/variants/tweakers")) roots.add(join(dirname(dirname(resolve(userRoot))), "tweak-data", TWEAK_ID));
  if (appRoot) {
    const bytes = regularFile(join(appRoot, "Contents", "Resources", TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG), 4096);
    if (bytes) {
      const root = bytes.toString("utf8").trim();
      if (!isAbsolute(root) || resolve(root) !== root) throw new Error("Invalid Accounts broker compatibility binding");
      roots.add(root);
    }
  }
  return [...roots];
}

function needsV2(roots: readonly string[]): boolean {
  let required = false;
  for (const root of roots) {
    const bytes = regularFile(join(root, MARKER), 1024);
    if (bytes) {
      let marker: unknown;
      try { marker = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Accounts transfer minimum-runtime marker is corrupt; recovery is held"); }
      if (!marker || typeof marker !== "object" || Array.isArray(marker)
        || Object.keys(marker).sort().join(",") !== "minimumTransferVersion,version"
        || (marker as any).version !== 1 || (marker as any).minimumTransferVersion !== 2) {
        throw new Error("Accounts transfer minimum-runtime marker is unsupported; recovery is held");
      }
      required = true;
    }
    // Removing the marker must not permit a downgrade over published v2 data.
    if (regularFile(join(root, "native-catalog.v2.json"), 64 * 1024 * 1024)
      || regularFile(join(root, "native-catalog.v2.journal.jsonl"), 256 * 1024 * 1024)) required = true;
  }
  return required;
}

function needsSourceRetirementV2(roots: readonly string[]): boolean {
  let required = false;
  for (const root of roots) {
    const path = join(root, "native-source-retirements.v2");
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Accounts source-retirement evidence is unsafe; recovery is held");
      }
      required = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return required;
}

/** Read exports in a fresh process, after verifying the complete runtime tree. */
export function readAccountsTransferReaderVersion(runtimeRoot: string): number {
  const before = readRuntimeFingerprintEvidence(runtimeRoot);
  if (!before) return 0;
  const path = join(runtimeRoot, "account-router", "native-transfer.js");
  if (!regularFile(path, 8 * 1024 * 1024)) return 0;
  const probe = spawnSync(process.execPath, ["-e", `const m=require(process.argv[1]);const v=m.ACCOUNTS_TRANSFER_READER_VERSION;if(v===2&&typeof m.inspectNativeTransferCompatibilityV2==='function'&&m.inspectNativeTransferCompatibilityV2(null,1).state==='compatible'&&m.inspectNativeTransferCompatibilityV2({version:1,minimumTransferVersion:2},1).state==='incompatible'&&m.inspectNativeTransferCompatibilityV2({version:1,minimumTransferVersion:2},2).state==='compatible')process.stdout.write('2');`, path], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const after = readRuntimeFingerprintEvidence(runtimeRoot);
  return probe.status === 0 && probe.stdout === "2" && after?.fingerprint === before.fingerprint ? 2 : 0;
}

/** Probe the actual compiled store that owns current source-retirement journals. */
export function readAccountsSourceRetirementReaderVersion(runtimeRoot: string): number {
  const before = readRuntimeFingerprintEvidence(runtimeRoot);
  if (!before) return 0;
  const path = join(runtimeRoot, "account-router", "native-source-retirement.js");
  if (!regularFile(path, 8 * 1024 * 1024)) return 0;
  const probe = spawnSync(process.execPath, ["-e", `const m=require(process.argv[1]);const v=m.ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION;const inspect=m.inspectNativeSourceRetirementCompatibilityV2;if(v===2&&typeof inspect==='function'&&inspect(1).state==='incompatible'&&inspect(2).state==='compatible'&&inspect(3).state==='incompatible'&&inspect(2).minimumVersion===2)process.stdout.write('2');`, path], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const after = readRuntimeFingerprintEvidence(runtimeRoot);
  return probe.status === 0 && probe.stdout === "2"
    && after?.fingerprint === before.fingerprint && after.fileCount === before.fileCount ? 2 : 0;
}

/** Run before the first app, runtime, receipt, or configuration replacement. */
export function assertAccountsTransferRuntimeCompatible(runtimeRoot: string, brokerRoots: readonly string[]): void {
  if (needsV2(brokerRoots) && readAccountsTransferReaderVersion(runtimeRoot) < 2) {
    throw new Error("Accounts transfer state requires runtime reader v2. Refusing this promotion or rollback; retain the current runtime and use a compatible forward recovery.");
  }
  if (needsSourceRetirementV2(brokerRoots) && readAccountsSourceRetirementReaderVersion(runtimeRoot) < 2) {
    throw new Error("Accounts source-retirement journals require runtime reader v2. Refusing this promotion or rollback; retain the current runtime and use a compatible forward recovery.");
  }
}

export interface AccountsTransferValidationEvidence {
  version: 1;
  checks: Array<{ command: string; exitCode: 0; outputSha256: string }>;
}

/** Prepare a retained reader-only recovery copy; never touches account state. */
export function prepareAccountsTransferRecovery(input: {
  runtimeRoot: string;
  recoveryRoot: string;
  validation: AccountsTransferValidationEvidence;
}): void {
  const root = realpathSync(input.runtimeRoot);
  const recovery = resolve(input.recoveryRoot);
  if (recovery === root || recovery.startsWith(root + "/") || root.startsWith(recovery + "/")) throw new Error("Recovery runtime must be a separate retained artifact");
  const sourceBefore = readRuntimeFingerprintEvidence(root);
  if (!sourceBefore) throw new Error("Recovery source does not have a valid complete runtime fingerprint");
  if (readAccountsTransferReaderVersion(root) !== 2) throw new Error("Recovery source does not prove both transfer readers");
  if (readAccountsSourceRetirementReaderVersion(root) !== 2) throw new Error("Recovery source does not prove the current source-retirement reader");
  if (input.validation.version !== 1 || !input.validation.checks.length || input.validation.checks.some((check) => !check.command || check.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(check.outputSha256))) throw new Error("Recovery requires successful source validation evidence");
  mkdirSync(dirname(recovery), { recursive: true, mode: 0o700 });
  mkdirSync(recovery, { mode: 0o700 });
  cloneOrCopyDirectoryPreservingModes(root, recovery);
  const copiedSource = computeRuntimeFingerprint(recovery);
  if (copiedSource.fingerprint !== sourceBefore.fingerprint || copiedSource.fileCount !== sourceBefore.fileCount) {
    throw new Error("Recovery copy does not match the complete source runtime fingerprint");
  }
  const sourceAfterCopy = readRuntimeFingerprintEvidence(root);
  if (!sourceAfterCopy
    || sourceAfterCopy.fingerprint !== sourceBefore.fingerprint
    || sourceAfterCopy.fileCount !== sourceBefore.fileCount) {
    throw new Error("Recovery source changed while it was copied");
  }
  const validation = JSON.stringify({
    ...input.validation,
    sourceRuntimeFingerprint: sourceBefore.fingerprint,
    sourceRuntimeFileCount: sourceBefore.fileCount,
  }, null, 2) + "\n";
  writeFileSync(join(recovery, VALIDATION_FILE), validation, { flag: "wx", mode: 0o600 });
  const fingerprint = computeRuntimeFingerprint(recovery);
  publishPreparedRuntimeFingerprint(recovery);
  if (readAccountsTransferReaderVersion(recovery) !== 2
    || readAccountsSourceRetirementReaderVersion(recovery) !== 2) {
    throw new Error("Prepared recovery runtime failed its current reader verification");
  }
  writeFileSync(join(root, RECOVERY_FILE), JSON.stringify({
    version: 1, readerVersion: 2, supportedTransferVersions: [1, 2],
    sourceRuntimeFingerprint: sourceBefore.fingerprint,
    sourceRuntimeFileCount: sourceBefore.fileCount,
    sourceRetirementReaderVersion: 2,
    supportedSourceRetirementVersions: [2],
    runtimeTransferSha256: sha(readFileSync(join(root, "account-router", "native-transfer.js"))),
    runtimeSourceRetirementSha256: sha(readFileSync(join(root, "account-router", "native-source-retirement.js"))),
    recoveryRuntimeRoot: realpathSync(recovery), recoveryFingerprint: fingerprint.fingerprint,
    validationSha256: sha(validation), verifiedAt: new Date().toISOString(),
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  publishPreparedRuntimeFingerprint(root);
}

/** Derive recovery evidence from fresh-process probes of this exact runtime. */
export function prepareProbedAccountsTransferRecovery(runtimeRoot: string, recoveryRoot: string): void {
  const before = readRuntimeFingerprintEvidence(runtimeRoot);
  if (!before) throw new Error("Accounts recovery source fingerprint is unavailable");
  const observed = { transferReader: readAccountsTransferReaderVersion(runtimeRoot), sourceRetirementReader: readAccountsSourceRetirementReaderVersion(runtimeRoot) };
  const after = readRuntimeFingerprintEvidence(runtimeRoot);
  if (observed.transferReader !== 2 || observed.sourceRetirementReader !== 2 || after?.fingerprint !== before.fingerprint) throw new Error("Accounts recovery reader probes failed or source changed");
  prepareAccountsTransferRecovery({ runtimeRoot, recoveryRoot, validation: { version: 1, checks: [{
    command: "Fresh-process transfer v1/v2 and source-retirement v2 reader compatibility probes",
    exitCode: 0, outputSha256: sha(JSON.stringify({ source: before, observed })),
  }] } });
}

/** Verify the retained recovery binding using the exact fingerprinted candidate runtime. */
export function verifyProbedAccountsTransferRecovery(runtimeRoot: string): boolean {
  const before = readRuntimeFingerprintEvidence(runtimeRoot);
  if (!before) return false;
  const helper = join(runtimeRoot, "account-router", "transfer-recovery.js");
  if (!regularFile(helper, 8 * 1024 * 1024)) return false;
  const result = spawnSync(process.execPath, ["-e", "const m=require(process.argv[1]);if(m.verifyAccountsTransferRecovery(process.argv[2]))process.stdout.write('verified');", helper, runtimeRoot], {
    encoding: "utf8", timeout: 10000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 && result.stdout === "verified" && readRuntimeFingerprintEvidence(runtimeRoot)?.fingerprint === before.fingerprint;
}
