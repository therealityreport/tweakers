import { doctorImplementationScopes } from "./doctor-implementation.js";
import { verifyProbedAccountsTransferRecovery } from "./accounts-transfer-compatibility.js";
import { validateDoctorPatchRepair, type DoctorPatchRepairV1 } from "./doctor-patch-repair.js";
import { createRequire } from "node:module";
import { collectDoctorProtocolCoverage, DOCTOR_PROTOCOL_CONTRACTS, type DoctorProtocolCoverage } from "./doctor-protocol.js";
import { DOCTOR_CHECK_OWNERS } from "./doctor-review-plan.js";
import type { ReviewDoctorSourceChangesResult } from "./doctor-review.js";
import asar from "@electron/asar";
import { parse } from "acorn";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readPlist } from "./plist.js";
import { readHeaderHash } from "./asar.js";
import { patchCodexWindowServicesSource } from "./codex-window-services.js";
import { verifyWindowServicesOutput } from "./commands/install.js";
import { patchCodexAccountsNativeSources } from "./codex-accounts-native.js";
import { patchCodexModelSelectionSource } from "./codex-model-selection.js";
import { patchCodexInactiveThreadRetentionSource } from "./codex-inactive-thread-retention.js";
import { createJsonlManagedMcpAppServerTransport } from "./managed-mcp-canary-app-server-adapter.js";
import type {
  DoctorSourceAsarMemberEvidence,
  DoctorSourceComparison,
  DoctorSourceEvidence,
  DoctorSourceFileEvidence,
  DoctorSourceSha256,
} from "./doctor-evidence.js";

export interface DoctorValidationCommand {
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface DoctorValidationCheck {
  id: string;
  state: "passed" | "failed" | "unsupported";
  summary: string;
  artifacts: string[];
  commands: DoctorValidationCommand[];
  scope: string;
}

export interface DoctorValidationReport {
  schemaVersion: 1;
  checks: DoctorValidationCheck[];
  protocolCoverage?: DoctorProtocolCoverage;
  retainedBackendBaselineFingerprint?: DoctorSourceSha256;
  fingerprint: DoctorSourceSha256;
  binding: {
    beforeFingerprint: DoctorSourceSha256;
    afterFingerprint: DoctorSourceSha256;
    comparisonFingerprint: DoctorSourceSha256;
    tweakersFingerprint: DoctorSourceSha256;
  };
}

export interface DoctorPatchSourceEvidence {
  path: string;
  sha256: DoctorSourceSha256;
}

interface CommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: { message?: string };
}

interface ProtocolProbeResult {
  state: "passed" | "failed" | "unsupported";
  summary: string;
  command: DoctorValidationCommand;
}

interface DoctorValidationDependencies {
  run(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeout: number }): CommandResult;
  probeBackend(executable: string, environment: Readonly<Record<string, string>>, cwd: string): Promise<ProtocolProbeResult>;
}

const DEFAULT_DEPENDENCIES: DoctorValidationDependencies = {
  run(command, args, options) {
    return spawnSync(command, [...args], {
      encoding: "utf8",
      env: options.env,
      timeout: options.timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
  },
  async probeBackend(executable, environment, cwd) {
    const args = ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"'];
    const argv = [executable, ...args];
    let stderr = "";
    try {
      const child = spawn(executable, args, {
        cwd,
        env: { ...environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.once("error", (error) => { stderr = `${stderr}${error.message}`.slice(-64 * 1024); });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
      const transport = createJsonlManagedMcpAppServerTransport(child);
      try {
        const initialized = await transport.request("initialize", {
          clientInfo: { name: "tweakers-doctor-validation", title: "Tweakers Doctor Validation", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        }, 15_000);
        if (!validInitializeResponse(initialized, cwd)) throw new Error("initialize response does not bind to the isolated CODEX_HOME or required platform fields");
        transport.notify("initialized");
        const models = await transport.request("model/list", {}, 15_000);
        if (!validModelListResponse(models)) throw new Error("model/list response does not match the required ModelListResponse fields");
        const account = await transport.request("account/read", {refreshToken: false}, 15_000);
        if (!isRecord(account) || account.account !== null || typeof account.requiresOpenaiAuth !== "boolean") throw new Error("isolated account/read did not return an unauthenticated account");
        const loaded = await transport.request("thread/loaded/list", {}, 15_000);
        if (!isRecord(loaded) || !Array.isArray(loaded.data) || loaded.data.length !== 0) throw new Error("isolated thread/loaded/list did not return an empty list");
        const threads = await transport.request("thread/list", {limit: 1}, 15_000);
        if (!isRecord(threads) || !Array.isArray(threads.data) || threads.data.length !== 0) throw new Error("isolated thread/list did not return empty history");
        return {
          state: "passed",
          summary: `initialize, model/list (${models.data.length} models), unauthenticated account/read, thread/loaded/list and thread/list passed`,
          command: { argv, exitCode: null, stdout: "initialize: isolated codexHome and platform fields; model/list: validated model rows; child deliberately terminated", stderr },
        };
      } finally {
        await transport.terminate();
      }
    } catch (error) {
      return {
        state: "failed",
        summary: errorMessage(error),
        command: { argv, exitCode: null, stdout: "", stderr: stderr || errorMessage(error) },
      };
    }
  },
};

function validInitializeResponse(value: unknown, expectedCodexHome: string): boolean {
  return isRecord(value)
    && value.codexHome === expectedCodexHome
    && nonEmptyString(value.platformFamily)
    && nonEmptyString(value.platformOs)
    && nonEmptyString(value.userAgent);
}

function validModelListResponse(value: unknown): value is { data: unknown[]; nextCursor?: string | null } {
  if (!isRecord(value) || !Array.isArray(value.data)
    || !(value.nextCursor === undefined || value.nextCursor === null || typeof value.nextCursor === "string")) return false;
  return value.data.every((candidate) => {
    if (!isRecord(candidate)
      || !nonEmptyString(candidate.defaultReasoningEffort)
      || typeof candidate.description !== "string"
      || typeof candidate.displayName !== "string"
      || typeof candidate.hidden !== "boolean"
      || typeof candidate.id !== "string"
      || typeof candidate.isDefault !== "boolean"
      || typeof candidate.model !== "string"
      || !Array.isArray(candidate.supportedReasoningEfforts)) return false;
    return candidate.supportedReasoningEfforts.every((option) => isRecord(option)
      && typeof option.description === "string" && nonEmptyString(option.reasoningEffort));
  });
}

let dependencies: DoctorValidationDependencies = DEFAULT_DEPENDENCIES;

/** Test seam for fixed command and process outcomes. */
export function setDoctorValidationDependenciesForTest(
  replacement: Partial<DoctorValidationDependencies>,
): () => void {
  const previous = dependencies;
  dependencies = { ...DEFAULT_DEPENDENCIES, ...replacement };
  return () => { dependencies = previous; };
}

export async function collectDoctorValidation(input: {
  before: DoctorSourceEvidence;
  after: DoctorSourceEvidence;
  comparison: DoctorSourceComparison;
  outputRoot: string;
  tweakersSourceRoot: string;
  compatibilityOnly?: boolean;
  patchRepairs?: DoctorPatchRepairV1[];
  candidateEvidence?: DoctorSourceEvidence;
  /** Same-upstream maintenance only; the registered backend must remain byte-identical. */
  retainedBackendBaseline?: { evidence: DoctorSourceEvidence; originalAsarHeaderHash: string };
}): Promise<DoctorValidationReport> {
  const outputRoot = exactAbsolutePath(input.outputRoot, "Doctor validation output root");
  exactAbsolutePath(input.tweakersSourceRoot, "Tweakers source root");
  for (const app of [input.before.appPath, input.after.appPath]) {
    if (sameOrInside(outputRoot, app)) throw new Error("Doctor validation output root must be outside retained app bundles");
  }
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

  const scopedComparison = input.compatibilityOnly ? { ...input.comparison, requiredChecks: ["main-process-patch-compatibility", "frontend-patch-compatibility", "backend-version-and-app-server-compatibility", "generated-app-server-schema-compatibility"] as DoctorSourceComparison["requiredChecks"] } : input.comparison;
  const tweakersFingerprint = doctorPatchImplementationFingerprint();
  const binding = {
    beforeFingerprint: input.before.fingerprint,
    afterFingerprint: input.after.fingerprint,
    comparisonFingerprint: input.comparison.fingerprint,
    tweakersFingerprint,
  };
  const checks: DoctorValidationCheck[] = [];
  checks.push(validateBinding(input.before, input.after, input.comparison));

  const sourceChecks = [verifyDoctorSourceBytes("before", input.before), verifyDoctorSourceBytes("after", input.after)];
  checks.push(...sourceChecks);
  checks.push(sourceChecks[0]!.state === "passed"
    ? validateAsarPackage("before", input.before)
    : skippedUntrusted("before-asar-package-integrity", input.before.asar.path, "package structure and static import resolution; no runtime claim"));
  checks.push(sourceChecks[1]!.state === "passed"
    ? validateAsarPackage("after", input.after)
    : skippedUntrusted("after-asar-package-integrity", input.after.asar.path, "package structure and static import resolution; no runtime claim"));
  checks.push(...(sourceChecks[1]!.state === "passed"
    ? validatePatchCompatibility(input.after, scopedComparison, input.patchRepairs)
    : skippedPatchCompatibility(input.after, scopedComparison)));
  if (!input.compatibilityOnly && hasChangedBinaries(input.comparison)) {
    checks.push(sourceChecks.every((entry) => entry.state === "passed")
      ? validateBinaryMetadata(input.before, input.after, input.comparison, outputRoot)
      : skippedUntrusted("binary-metadata", "retained app bundles", "structural architecture, linkage, and source signature evidence only"));
  }
  const protocolAfter = input.candidateEvidence ?? input.after;
  let protocolBefore = input.before;
  let retainedBaselineTrusted = true;
  if (input.retainedBackendBaseline) {
    const {evidence, originalAsarHeaderHash} = input.retainedBackendBaseline;
    const bytes = verifyDoctorSourceBytes("before", evidence);
    retainedBaselineTrusted = !!input.candidateEvidence && bytes.state === "passed"
      && fingerprintEvidence(evidence) === evidence.fingerprint
      && evidence.version === input.after.version && evidence.build === input.after.build
      && protocolAfter.version === input.after.version && protocolAfter.build === input.after.build
      && !!evidence.backend.sha256 && evidence.backend.sha256 === protocolAfter.backend.sha256
      && originalAsarHeaderHash === readHeaderHash(bundlePath(input.after.appPath, input.after.asar.path)).headerHash;
    checks.push(check("retained-backend-baseline", retainedBaselineTrusted ? "passed" : "failed",
      retainedBaselineTrusted ? "Same upstream source and byte-identical registered backend; protocol regression checks use the verified installed backend"
        : "Installed maintenance baseline, source identity, or retained backend bytes changed",
      [evidence.artifact, ...bytes.artifacts], [], "Same-upstream registered backend continuity; no stock-backend equivalence claim"));
    if (retainedBaselineTrusted) protocolBefore = evidence;
  }
  const candidateBytes = input.candidateEvidence ? verifyDoctorSourceBytes("after", input.candidateEvidence) : null;
  if (candidateBytes) {
    checks.push({...candidateBytes, id: "candidate-source-bytes"});
    const recoveryReady = verifyProbedAccountsTransferRecovery(input.tweakersSourceRoot);
    checks.push({ id: "candidate-accounts-recovery", state: recoveryReady ? "passed" : "unsupported",
      summary: recoveryReady ? "Exact candidate runtime has a verified retained Accounts recovery copy" : "Candidate Accounts recovery receipt is missing, changed, or unavailable; rebuild the candidate recovery copy",
      scope: "Accounts recovery and reader compatibility", commands: [], artifacts: [join(input.tweakersSourceRoot, "accounts-transfer-recovery.v1.json")] });
  }
  const protocolChecks = await validateBackendProtocol(protocolBefore, protocolAfter, scopedComparison, outputRoot,
    [sourceChecks[0]!.state === "passed" && retainedBaselineTrusted, (candidateBytes ?? sourceChecks[1])!.state === "passed"]);
  checks.push(...protocolChecks.map(c => input.candidateEvidence && c.id === "after-backend-protocol-smoke" ? {...c, id: "candidate-backend-protocol-smoke"} : c));

  const needsProtocol = scopedComparison.requiredChecks.some(id => id === "generated-app-server-schema-compatibility" || id === "backend-version-and-app-server-compatibility");
  const protocolCoverage = needsProtocol ? collectDoctorProtocolCoverage(protocolBefore, protocolAfter) : undefined;
  if (protocolCoverage) {
    const trusted = retainedBaselineTrusted && checks[0]!.state === "passed" && sourceChecks.every(item => item.state === "passed") && (!candidateBytes || candidateBytes.state === "passed");
    checks.push(check("app-server-schema-contracts", !trusted ? "unsupported" : protocolCoverage.interfaces.every(item => item.status === "compatible") ? "passed" : protocolCoverage.interfaces.some(item => item.status === "incompatible") ? "failed" : "unsupported",
      !trusted ? "Source binding failed; protocol compatibility is untrusted" : protocolCoverage.interfaces.map(item => `${item.owner}: ${item.method}: ${item.status}${item.reasons.length ? ` (${item.reasons.join("; ")})` : ""}`).join("\n"),
      [join(outputRoot, "doctor-protocol-coverage.json")], [], "Exact generated schema contracts; no authenticated behavior claim"));
    writeJsonAtomically(join(outputRoot, "doctor-protocol-coverage.json"), protocolCoverage);
    let adapterState: DoctorValidationCheck["state"] = "unsupported", adapterSummary = "Production adapter module unavailable";
    const adapterPath = join(input.tweakersSourceRoot, "account-router", "doctor-protocol-checks.js");
    if (trusted) try {
      const module = createRequire(import.meta.url)(adapterPath) as {runDoctorProtocolAdapterChecks: (contracts: typeof DOCTOR_PROTOCOL_CONTRACTS) => Array<{method: string; passed: boolean; summary: string}>};
      const results = module.runDoctorProtocolAdapterChecks(DOCTOR_PROTOCOL_CONTRACTS);
      adapterState = results.length === DOCTOR_PROTOCOL_CONTRACTS.length && results.every((r, i) => r.passed && r.method === DOCTOR_PROTOCOL_CONTRACTS[i]!.method) ? "passed" : "failed";
      adapterSummary = results.map(r => `${r.method}: ${r.passed ? "passed" : "failed"}: ${r.summary}`).join("\n");
    } catch (error) { adapterSummary = errorMessage(error); }
    checks.push(check("app-server-adapter-contracts", adapterState, adapterSummary, [adapterPath], [], "Synthetic production parser, routing and correlation checks; does not prove authenticated mux behavior"));
    if (!input.compatibilityOnly) checks.push(check("app-server-behavior-coverage", "unsupported", "Authenticated account, token refresh, approval decisions and turn execution were not performed. Their behavior remains unresolved.", [], [], "No real account mutation or paid turn was attempted"));
  }
  const payload = { schemaVersion: 1 as const, checks, binding, ...(protocolCoverage ? {protocolCoverage} : {}),
    ...(input.retainedBackendBaseline ? {retainedBackendBaselineFingerprint: input.retainedBackendBaseline.evidence.fingerprint} : {}) };
  const report: DoctorValidationReport = {
    ...payload,
    fingerprint: doctorValidationReportFingerprint(payload),
  };
  writeJsonAtomically(join(outputRoot, "doctor-validation.json"), report);
  return report;
}

function validateBinding(
  before: DoctorSourceEvidence,
  after: DoctorSourceEvidence,
  comparison: DoctorSourceComparison,
): DoctorValidationCheck {
  const problems: string[] = [];
  if (comparison.beforeFingerprint !== before.fingerprint) problems.push("comparison before fingerprint does not match evidence");
  if (comparison.afterFingerprint !== after.fingerprint) problems.push("comparison after fingerprint does not match evidence");
  if (fingerprintEvidence(before) !== before.fingerprint) problems.push("before evidence fingerprint does not match its content");
  if (fingerprintEvidence(after) !== after.fingerprint) problems.push("after evidence fingerprint does not match its content");
  const { fingerprint: _fingerprint, ...comparisonPayload } = comparison;
  if (sha256(Buffer.from(canonicalJson(comparisonPayload))) !== comparison.fingerprint) {
    problems.push("comparison fingerprint does not match its content");
  }
  if (before.schemaVersion !== 1 || after.schemaVersion !== 1 || comparison.schemaVersion !== 1) problems.push("unsupported source evidence schema");
  return check("evidence-binding", problems.length === 0 ? "passed" : "failed",
    problems.join("; ") || "comparison is bound to the supplied before and after evidence",
    [before.artifact, after.artifact], [], "source evidence identity only");
}

export function verifyDoctorSourceBytes(side: "before" | "after", evidence: DoctorSourceEvidence): DoctorValidationCheck {
  const problems: string[] = [];
  const artifacts: string[] = [];
  const expectedPaths = new Set(evidence.shippedFiles.map((entry) => entry.path));
  let actualPaths: Set<string>;
  try { actualPaths = new Set(collectBundleEntries(evidence.appPath)); }
  catch (error) { actualPaths = new Set(); problems.push(`bundle inventory unavailable: ${errorMessage(error)}`); }
  for (const path of expectedPaths) if (!actualPaths.has(path)) problems.push(`${path}: evidence entry is missing`);
  for (const path of actualPaths) if (!expectedPaths.has(path)) problems.push(`${path}: retained bundle entry is absent from evidence`);
  for (const file of evidence.shippedFiles) {
    const path = bundlePath(evidence.appPath, file.path);
    artifacts.push(path);
    verifyFileEvidence(path, file, problems);
  }
  const asarPath = bundlePath(evidence.appPath, evidence.asar.path);
  if (evidence.asar.sha256 === null) problems.push(`${evidence.asar.path}: evidence has no archive digest`);
  else verifyRegularDigest(asarPath, evidence.asar.sha256, problems);
  if (existsSync(asarPath)) {
    try {
      const actualMembers = new Set(listAsar(asarPath));
      const expectedMembers = new Set(evidence.asar.members.map((member) => normalizeMember(member.path)));
      for (const path of expectedMembers) if (!actualMembers.has(path)) problems.push(`${path}: evidence ASAR member is missing`);
      for (const path of actualMembers) if (!expectedMembers.has(path)) problems.push(`${path}: ASAR member is absent from evidence`);
    } catch (error) { problems.push(`ASAR inventory unavailable: ${errorMessage(error)}`); }
    for (const member of evidence.asar.members) verifyAsarMember(asarPath, member, problems);
  }
  return check(`${side}-source-bytes`, problems.length === 0 ? "passed" : "failed",
    problems.join("; ") || `all ${evidence.shippedFiles.length} shipped files and ${evidence.asar.members.length} ASAR members match evidence`,
    artifacts, [], "exact retained source bytes and inventory hashes");
}

function validateAsarPackage(side: "before" | "after", evidence: DoctorSourceEvidence): DoctorValidationCheck {
  const asarPath = bundlePath(evidence.appPath, evidence.asar.path);
  const plistPath = bundlePath(evidence.appPath, "Contents/Info.plist");
  const problems: string[] = [];
  try {
    const headerHash = readHeaderHash(asarPath).headerHash;
    const plist = readPlist(plistPath);
    const integrity = isRecord(plist.ElectronAsarIntegrity)
      ? plist.ElectronAsarIntegrity["Resources/app.asar"] : undefined;
    if (!isRecord(integrity) || integrity.algorithm !== "SHA256" || integrity.hash !== headerHash) {
      problems.push("Info.plist ElectronAsarIntegrity does not match the app.asar header");
    }
    const inventory = new Set(listAsar(asarPath));
    if (!inventory.has("package.json")) problems.push("package.json is missing from app.asar");
    else {
      const pkg = JSON.parse(extractAsar(asarPath, "package.json").toString("utf8")) as unknown;
      const main = isRecord(pkg) && typeof pkg.main === "string" ? normalizeMember(pkg.main) : null;
      if (!main || !resolveStaticMemberReference(asarPath, main, inventory)) problems.push("package.json main entry is missing from app.asar");
    }
    problems.push(...unresolvedStaticImports(asarPath, inventory));
  } catch (error) {
    problems.push(errorMessage(error));
  }
  return check(`${side}-asar-package-integrity`, problems.length === 0 ? "passed" : "failed",
    problems.join("; ") || "ASAR header, package main entry, and exact relative JavaScript imports resolve",
    [asarPath, plistPath], [], "package structure and static import resolution; no runtime claim");
}

function validatePatchCompatibility(evidence: DoctorSourceEvidence, comparison: DoctorSourceComparison, repairs: DoctorPatchRepairV1[] = []): DoctorValidationCheck[] {
  const asarPath = bundlePath(evidence.appPath, evidence.asar.path);
  let sources: Map<string, string>;
  try { sources = javascriptSources(asarPath); }
  catch (error) {
    return [check("patch-compatibility", "failed", errorMessage(error), [asarPath], [], "known source patch dry runs")];
  }
  const frontendRequired = comparison.requiredChecks.includes("frontend-patch-compatibility");
  const mainRequired = comparison.requiredChecks.includes("main-process-patch-compatibility");
  const checks: DoctorValidationCheck[] = [];
  if (mainRequired) {
    checks.push(singleSourcePatchCheck("window-services-patch", sources, true, (path, source) => {
      const result = patchCodexWindowServicesSource(source);
      if (!result) return false;
      if (result.changed) verifyWindowServicesOutput(source, result.source, path);
      return true;
    }, "main-process window service hook"));
  }
  if (frontendRequired) {
    const modelSelection = optionalSingleSourcePatchCheck("model-selection-patch", rendererSources(sources),
      (_path, source) => patchCodexModelSelectionSource(source) !== null, "optional renderer model-selection hook");
    if (modelSelection) checks.push(modelSelection);
    checks.push(singleSourcePatchCheck("inactive-thread-retention-patch", rendererSources(sources), true,
      (path, source) => {
        const repair = repairs.find(r => r.path === path);
        if (repair) validateDoctorPatchRepair(repair, source);
        return patchCodexInactiveThreadRetentionSource(source, repair?.telemetryAnchor) !== null;
      }, "renderer inactive-thread hook"));
    try {
      const result = patchCodexAccountsNativeSources(sources);
      const compatible = result.record.status === "compatible";
      checks.push(check("accounts-native-patch", compatible ? "passed" : "failed",
        compatible ? `dry run verified ${result.record.assets.length} pinned assets` : result.record.reason ?? "Accounts patch hooks unavailable",
        [...sources.keys()], [], "Accounts native source patch compatibility"));
    } catch (error) {
      checks.push(check("accounts-native-patch", "failed", errorMessage(error), [...sources.keys()], [], "Accounts native source patch compatibility"));
    }
  }
  return checks;
}

function singleSourcePatchCheck(
  id: string,
  sources: ReadonlyMap<string, string>,
  required: boolean,
  patcher: (path: string, source: string) => boolean,
  scope: string,
): DoctorValidationCheck {
  const matches: string[] = [];
  const failures: string[] = [];
  for (const [path, source] of sources) {
    try { if (patcher(path, source)) matches.push(path); }
    catch (error) { failures.push(`${path}: ${errorMessage(error)}`); }
  }
  if (failures.length > 0) return check(id, "failed", failures.join("; "), [...sources.keys()], [], scope);
  if (matches.length !== 1) {
    return check(id, required ? "failed" : "unsupported",
      `expected one supported hook carrier; found ${matches.length}`, matches, [], scope);
  }
  return check(id, "passed", `in-memory dry run accepted ${matches[0]}`, matches, [], scope);
}

function optionalSingleSourcePatchCheck(
  id: string,
  sources: ReadonlyMap<string, string>,
  patcher: (path: string, source: string) => boolean,
  scope: string,
): DoctorValidationCheck | null {
  const matches: string[] = [];
  const failures: string[] = [];
  for (const [path, source] of sources) {
    try { if (patcher(path, source)) matches.push(path); }
    catch (error) { failures.push(`${path}: ${errorMessage(error)}`); }
  }
  if (failures.length > 0) return check(id, "failed", failures.join("; "), [...sources.keys()], [], scope);
  if (matches.length === 0) return null;
  if (matches.length !== 1) return check(id, "failed", `expected at most one supported hook carrier; found ${matches.length}`, matches, [], scope);
  return check(id, "passed", `in-memory dry run accepted ${matches[0]}`, matches, [], scope);
}

function validateBinaryMetadata(
  before: DoctorSourceEvidence,
  after: DoctorSourceEvidence,
  comparison: DoctorSourceComparison,
  outputRoot: string,
): DoctorValidationCheck {
  const commands: DoctorValidationCommand[] = [];
  const artifacts = new Set<string>();
  const problems: string[] = [];
  const changed = binaryChanges(comparison);
  const temporaryRoot = mkdtempSync(join(outputRoot, "binary-metadata-"));
  try {
    for (const change of changed) {
      for (const [side, evidence] of [["before", before], ["after", after]] as const) {
        let path: string;
        let artifact: string;
        if (change.artifact === "shipped_file") {
          path = bundlePath(evidence.appPath, change.path);
          artifact = path;
          if (!existsSync(path) || !lstatSync(path).isFile()) continue;
          if (/[()]/.test(path)) {
            const safePath = join(temporaryRoot, `${side}-shipped-${sha256(Buffer.from(change.path)).slice(7, 23)}`);
            writeFileSync(safePath, readFileSync(path), { mode: 0o600 });
            path = safePath;
          }
        } else {
          const member = evidence.asar.members.find((candidate) => candidate.path === change.path && candidate.kind === "file");
          if (!member) continue;
          path = join(temporaryRoot, `${side}-${sha256(Buffer.from(change.path)).slice(7, 23)}`);
          writeFileSync(path, extractAsar(bundlePath(evidence.appPath, evidence.asar.path), change.path), { mode: 0o600 });
          artifact = `${evidence.asar.path}:${change.path}`;
        }
        artifacts.add(artifact);
        const file = runRecorded("/usr/bin/file", ["-b", path]);
        commands.push(file);
        if (file.exitCode !== 0) { problems.push(`${artifact}: file inspection failed`); continue; }
        if (!file.stdout.includes("Mach-O")) {
          if (expectedMachO(change)) problems.push(`${artifact}: expected Mach-O binary, found ${file.stdout.trim() || "unknown format"}`);
          continue;
        }
        for (const [command, args] of [["/usr/bin/lipo", ["-archs", path]], ["/usr/bin/otool", ["-L", path]]] as const) {
          const result = runRecorded(command, args);
          commands.push(result);
          if (result.exitCode !== 0) problems.push(`${artifact}: ${command} failed`);
        }
      }
    }
  } catch (error) {
    problems.push(`binary structural inspection failed: ${errorMessage(error)}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  for (const evidence of [before, after]) {
    const result = runRecorded("/usr/bin/codesign", ["--verify", "--deep", "--strict", evidence.appPath]);
    commands.push(result);
    artifacts.add(evidence.appPath);
    if (result.exitCode !== 0) problems.push(`${evidence.appPath}: source bundle signature verification failed`);
  }
  if (changed.length === 0) {
    return check("binary-metadata", problems.length ? "failed" : "unsupported",
      problems.join("; ") || "no changed binary artifacts require architecture or linkage inspection",
      [...artifacts], commands, "structural architecture, linkage, and source signature evidence only");
  }
  return check("binary-metadata", problems.length ? "failed" : "passed",
    problems.join("; ") || `verified structural metadata for ${artifacts.size} retained binary paths`,
    [...artifacts], commands, "structural architecture, linkage, and source signature evidence only");
}

async function validateBackendProtocol(
  before: DoctorSourceEvidence,
  after: DoctorSourceEvidence,
  comparison: DoctorSourceComparison,
  outputRoot: string,
  sourceBytesTrusted: readonly [boolean, boolean],
): Promise<DoctorValidationCheck[]> {
  const required = comparison.requiredChecks.includes("backend-version-and-app-server-compatibility");
  const results: DoctorValidationCheck[] = [];
  if (!required) return results;
  for (const [index, [side, evidence]] of ([["before", before], ["after", after]] as const).entries()) {
    const executable = bundlePath(evidence.appPath, evidence.backend.path);
    if (!sourceBytesTrusted[index]) {
      results.push(check(`${side}-backend-protocol-smoke`, "unsupported", "source byte evidence did not validate; backend execution refused",
        [executable], [], "initialize, model/list, unauthenticated account/read and empty thread list interactions only"));
      continue;
    }
    if (evidence.backend.sha256 === null || !existsSync(executable)) {
      results.push(check(`${side}-backend-protocol-smoke`, "unsupported", "retained backend is unavailable",
        [executable], [], "initialize, model/list, unauthenticated account/read and empty thread list interactions only"));
      continue;
    }
    try {
      if (!lstatSync(executable).isFile() || (lstatSync(executable).mode & 0o111) === 0) {
        results.push(check(`${side}-backend-protocol-smoke`, "unsupported", "retained backend is not an executable regular file",
          [executable], [], "initialize, model/list, unauthenticated account/read and empty thread list interactions only"));
        continue;
      }
    } catch (error) {
      results.push(check(`${side}-backend-protocol-smoke`, "unsupported", errorMessage(error),
        [executable], [], "initialize, model/list, unauthenticated account/read and empty thread list interactions only"));
      continue;
    }
    const probeRoot = mkdtempSync(join(outputRoot, `${side}-backend-probe-`));
    const home = join(probeRoot, "home");
    const temporary = join(probeRoot, "tmp");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const environment = {
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      HOME: home,
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: home,
      TMPDIR: temporary,
    };
    try {
      const result = await dependencies.probeBackend(executable, environment, home);
      results.push(check(`${side}-backend-protocol-smoke`, result.state, result.summary,
        [executable], [result.command], "initialize, model/list, unauthenticated account/read and empty thread list interactions only"));
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }
  return results;
}

export function collectDoctorPatchSources(): DoctorPatchSourceEvidence[] {
  return [{ path: "scoped-candidate-verification:v1", sha256: doctorImplementationScopes().verification as DoctorSourceSha256 }];
}

export function doctorPatchImplementationFingerprint(): DoctorSourceSha256 {
  return doctorImplementationScopes().verification as DoctorSourceSha256;
}

export function doctorValidationReportFingerprint(
  report: Pick<DoctorValidationReport, "schemaVersion" | "checks" | "binding" | "protocolCoverage" | "retainedBackendBaselineFingerprint">,
): DoctorSourceSha256 {
  return sha256(Buffer.from(canonicalJson({
    schemaVersion: report.schemaVersion,
    checks: report.checks,
    binding: report.binding,
    ...(report.protocolCoverage ? {protocolCoverage: report.protocolCoverage} : {}),
    ...(report.retainedBackendBaselineFingerprint ? {retainedBackendBaselineFingerprint: report.retainedBackendBaselineFingerprint} : {}),
  })));
}

function skippedPatchCompatibility(evidence: DoctorSourceEvidence, comparison: DoctorSourceComparison): DoctorValidationCheck[] {
  const expected: Array<[string, string]> = [];
  if (comparison.requiredChecks.includes("main-process-patch-compatibility")) {
    expected.push(["window-services-patch", "main-process window service hook"]);
  }
  if (comparison.requiredChecks.includes("frontend-patch-compatibility")) {
    expected.push(
      ["inactive-thread-retention-patch", "renderer inactive-thread hook"],
      ["accounts-native-patch", "Accounts native source patch compatibility"],
    );
  }
  return expected.map(([id, scope]) => skippedUntrusted(id, evidence.asar.path, scope));
}

function hasChangedBinaries(comparison: DoctorSourceComparison): boolean {
  return binaryChanges(comparison).length > 0;
}

function binaryChanges(comparison: DoctorSourceComparison): DoctorSourceComparison["changes"] {
  return comparison.changes.filter((change) => (change.artifact === "shipped_file" || change.artifact === "asar_member")
    && ["backend", "native_modules", "desktop_executables", "helpers"].includes(change.area));
}

function expectedMachO(change: DoctorSourceComparison["changes"][number]): boolean {
  if (["backend", "native_modules", "desktop_executables"].includes(change.area)) return true;
  const path = change.path;
  return /\.(?:dylib|node)$/i.test(path)
    || path.startsWith("Contents/MacOS/")
    || /^Contents\/Frameworks\/.*\/Versions\/[^/]+\/[^/.]+$/.test(path);
}

function fingerprintEvidence(evidence: DoctorSourceEvidence): DoctorSourceSha256 {
  return sha256(Buffer.from(canonicalJson({
    schemaVersion: evidence.schemaVersion,
    kind: evidence.kind,
    version: evidence.version,
    build: evidence.build,
    backend: evidence.backend,
    shippedFiles: evidence.shippedFiles,
    asar: evidence.asar,
    schemas: {
      state: evidence.schemas.state,
      files: evidence.schemas.files,
      fingerprint: evidence.schemas.fingerprint,
      problem: evidence.schemas.problem,
    },
    complete: evidence.complete,
    unresolvedEvidence: evidence.unresolvedEvidence,
  })));
}

function collectBundleEntries(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else output.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(root);
  return output.sort();
}

function skippedUntrusted(id: string, artifact: string, scope: string): DoctorValidationCheck {
  return check(id, "unsupported", "source byte evidence did not validate; downstream inspection refused", [artifact], [], scope);
}

function unresolvedStaticImports(asarPath: string, inventory: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const member of [...inventory].filter((path) => /\.[cm]?js$/i.test(path))) {
    let source: string;
    try { source = extractAsar(asarPath, member).toString("utf8"); }
    catch (error) { problems.push(`${member}: ${errorMessage(error)}`); continue; }
    let references: string[];
    try { references = staticModuleReferences(source); }
    catch (error) { problems.push(`${member}: JavaScript parse failed: ${errorMessage(error)}`); continue; }
    for (const reference of references) {
      if (!reference.startsWith("./") && !reference.startsWith("../")) continue;
      const target = normalizeMember(posix.join(posix.dirname(member), reference));
      if (!resolveStaticMemberReference(asarPath, target, inventory)) {
        problems.push(`${member}: unresolved static import ${reference}`);
      }
    }
  }
  return problems;
}

function staticModuleReferences(source: string): string[] {
  const root = parse(source, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
  const references: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(value.type)) {
      const reference = literalString(value.source);
      if (reference !== null) references.push(reference);
    } else if (value.type === "ImportExpression") {
      const reference = literalString(value.source);
      if (reference !== null) references.push(reference);
    } else if (value.type === "CallExpression" && isRecord(value.callee)
      && value.callee.type === "Identifier" && value.callee.name === "require" && Array.isArray(value.arguments)) {
      const reference = literalString(value.arguments[0]);
      if (reference !== null) references.push(reference);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!["start", "end", "loc", "range", "type"].includes(key)) visit(child);
    }
  };
  visit(root);
  return references;
}

function literalString(value: unknown): string | null {
  return isRecord(value) && value.type === "Literal" && typeof value.value === "string" ? value.value : null;
}

function resolveStaticMemberReference(
  asarPath: string,
  target: string,
  inventory: ReadonlySet<string>,
  visited = new Set<string>(),
): string | null {
  if (visited.has(target)) return null;
  visited.add(target);
  const candidates = [
    target,
    `${target}.js`,
    `${target}.mjs`,
    `${target}.cjs`,
    `${target}.json`,
    `${target}.node`,
    posix.join(target, "index.js"),
    posix.join(target, "index.mjs"),
    posix.join(target, "index.cjs"),
  ];
  const exact = candidates.find((candidate) => inventory.has(candidate));
  if (exact) return exact;

  const packageJson = posix.join(target, "package.json");
  if (!inventory.has(packageJson) || !target.split("/").includes("node_modules")) return null;
  try {
    const pkg = JSON.parse(extractAsar(asarPath, packageJson).toString("utf8")) as unknown;
    if (!isRecord(pkg) || typeof pkg.main !== "string" || pkg.main.trim().length === 0) return null;
    return resolveStaticMemberReference(asarPath, normalizeMember(posix.join(target, pkg.main)), inventory, visited);
  } catch {
    return null;
  }
}

function javascriptSources(asarPath: string): Map<string, string> {
  return new Map(listAsar(asarPath).filter((path) => /\.[cm]?js$/i.test(path))
    .map((path) => [path, extractAsar(asarPath, path).toString("utf8")]));
}

function rendererSources(sources: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...sources].filter(([path]) => path.startsWith("webview/")));
}

function listAsar(path: string): string[] {
  return asar.listPackage(path, { isPack: false })
    .map(normalizeMember)
    .filter((member) => member.length > 0 && !("files" in asar.statFile(path, member, false)))
    .sort();
}

function extractAsar(path: string, member: string): Buffer {
  return asar.extractFile(path, normalizeMember(member));
}

function normalizeMember(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, ""));
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) throw new Error(`Unsafe ASAR member path: ${path}`);
  return normalized;
}

function verifyAsarMember(path: string, member: DoctorSourceAsarMemberEvidence, problems: string[]): void {
  try {
    if (member.kind === "symlink") {
      const entry = asar.statFile(path, normalizeMember(member.path), false);
      if (!("link" in entry)) { problems.push(`${member.path}: expected ASAR symlink`); return; }
      if (entry.link !== member.linkTarget) problems.push(`${member.path}: ASAR symlink target mismatch`);
      const encoded = Buffer.from(`symlink:${entry.link}`);
      if (sha256(encoded) !== member.rawSha256) problems.push(`${member.path}: ASAR symlink digest mismatch`);
      return;
    }
    const bytes = extractAsar(path, member.path);
    const actual = sha256(bytes);
    if (actual !== member.rawSha256) problems.push(`${member.path}: ASAR member digest mismatch`);
    if (bytes.length !== member.bytes) problems.push(`${member.path}: ASAR member size mismatch`);
  } catch (error) { problems.push(`${member.path}: ${errorMessage(error)}`); }
}

function verifyFileEvidence(path: string, evidence: DoctorSourceFileEvidence, problems: string[]): void {
  if (evidence.kind === "symlink") {
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink()) { problems.push(`${path}: expected symlink`); return; }
      const target = readlinkSync(path);
      if (target !== evidence.linkTarget) problems.push(`${path}: symlink target mismatch`);
      if (Buffer.byteLength(target) !== evidence.bytes) problems.push(`${path}: symlink size mismatch`);
      if (sha256(Buffer.from(`symlink:${target}`)) !== evidence.sha256) problems.push(`${path}: symlink digest mismatch`);
    } catch (error) { problems.push(`${path}: ${errorMessage(error)}`); }
    return;
  }
  verifyRegularDigest(path, evidence.sha256, problems, evidence.bytes);
}

function verifyRegularDigest(path: string, expected: DoctorSourceSha256, problems: string[], bytes?: number): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) { problems.push(`${path}: expected regular file`); return; }
    const content = readFileSync(path);
    if (bytes !== undefined && content.length !== bytes) problems.push(`${path}: size mismatch`);
    if (sha256(content) !== expected) problems.push(`${path}: digest mismatch`);
  } catch (error) { problems.push(`${path}: ${errorMessage(error)}`); }
}

function runRecorded(command: string, args: readonly string[]): DoctorValidationCommand {
  const result = dependencies.run(command, args, { env: { PATH: "/usr/bin:/bin" }, timeout: 30_000 });
  return {
    argv: [command, ...args],
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function check(
  id: string,
  state: DoctorValidationCheck["state"],
  summary: string,
  artifacts: string[],
  commands: DoctorValidationCommand[],
  scope: string,
): DoctorValidationCheck {
  return { id, state, summary, artifacts: [...new Set(artifacts)].sort(), commands, scope };
}

function exactAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an exact absolute path`);
  return path;
}

function bundlePath(root: string, local: string): string {
  const path = resolve(root, ...local.split("/"));
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes its root: ${local}`);
  return path;
}

function sameOrInside(child: string, parent: string): boolean {
  const local = relative(parent, child);
  return local === "" || (!local.startsWith(`..${sep}`) && local !== "..");
}

function writeJsonAtomically(path: string, value: unknown): void {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, path);
}

function sha256(bytes: Buffer): DoctorSourceSha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Doctor validation canonical JSON received a non-JSON value");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Disposable preparation is not compatibility approval or permission to install. */
export function canPrepareDoctorCandidate(review: ReviewDoctorSourceChangesResult, validation: DoctorValidationReport | null,
  binding: DoctorValidationReport["binding"], requiredChecks: string[]): boolean {
  if (!validation || validation.schemaVersion !== 1 || !validation.binding || !Array.isArray(validation.checks)
    || !Array.isArray(review.findings) || review.state === "fixes_required"
    || review.findings.some(finding => finding.disposition === "fixes_required" || /^(?:validation\.|review\.(?:preflight|packet|tweakers-source|installed-runtime|source-drift|before-source-drift|after-source-drift|evidence-error))/.test(finding.id))
    || validation.fingerprint !== review.validationFingerprint || doctorValidationReportFingerprint(validation) !== validation.fingerprint
    || Object.keys(binding).some(key => validation.binding[key as keyof typeof binding] !== binding[key as keyof typeof binding])
    || new Set(validation.checks.map(check => check.id)).size !== validation.checks.length
    || validation.checks.some(check => check.state !== "passed")) return false;
  const owners = DOCTOR_CHECK_OWNERS as Record<string, { observed: string[] }>;
  if (requiredChecks.some(id => !Object.hasOwn(owners, id))) return false;
  const required = ["evidence-binding", "before-source-bytes", "after-source-bytes", "before-asar-package-integrity", "after-asar-package-integrity",
    ...requiredChecks.flatMap(id => owners[id]!.observed)];
  return required.every(id => validation.checks.some(check => check.id === id && check.state === "passed"));
}
