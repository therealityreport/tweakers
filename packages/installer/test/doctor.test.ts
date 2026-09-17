import assert from "node:assert/strict";
import asar from "@electron/asar";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { Writable } from "node:stream";
import test from "node:test";
import { readHeaderHash } from "../src/asar";
import {
  codeSignatureDoctorDetail,
  doctor,
  independentTweakersLiveHealthDoctorChecks,
} from "../src/commands/doctor";
import type {
  DoctorSourceComparison,
  DoctorSourceEvidence,
  DoctorSourceSha256,
} from "../src/doctor-evidence";
import {
  collectDoctorValidation,
  setDoctorValidationDependenciesForTest,
} from "../src/doctor-validation";
import {
  doctorCandidatePayloadFingerprint,
  doctorCodeScopeFingerprint,
  doctorImplementationScopes,
  sameDoctorCandidateImplementation,
} from "../src/doctor-implementation";
import {
  createEnvironmentSelection,
  defaultEnvironmentProfileRegistry,
  writeEnvironmentProfileRegistry,
} from "../src/environment-profile";
import { writePlist } from "../src/plist";

/**
 * Doctor must surface selection/registry drift: the state that breaks every
 * environment command while the app itself stays healthy (2026-07-22 incident:
 * a manually finalized selection left the registry `selected` stale and only
 * `environment status` — not doctor — reported the failure).
 */
async function doctorOutput(root: string, options: Parameters<typeof doctor>[0] = {}): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  const originalHome = process.env.TWEAKERS_HOME;
  process.env.TWEAKERS_HOME = root;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await doctor(options);
  } finally {
    console.log = original;
    if (originalHome === undefined) delete process.env.TWEAKERS_HOME;
    else process.env.TWEAKERS_HOME = originalHome;
    // doctor() flags failed checks via process.exitCode; the fixtures here
    // intentionally fail unrelated checks (missing app), so keep the test
    // process's own exit status clean.
    process.exitCode = 0;
  }
  return lines.join("\n");
}

test("doctor distinguishes local certificate signatures from ad-hoc signatures", () => {
  assert.equal(codeSignatureDoctorDetail(
    { ok: true, output: "" },
    { ok: true, adHoc: false, teamIdentifier: null, authority: ["Tweakers Local Signing"], output: "" },
  ), "valid (Tweakers Local Signing)");
  assert.equal(codeSignatureDoctorDetail(
    { ok: true, output: "" },
    { ok: true, adHoc: true, teamIdentifier: null, authority: [], output: "Signature=adhoc" },
  ), "valid (ad-hoc)");
  assert.equal(codeSignatureDoctorDetail(
    { ok: true, output: "" },
    { ok: true, adHoc: false, teamIdentifier: "TEAM", authority: ["Developer ID Application: Example"], output: "" },
  ), "valid (Developer ID Application: Example)");
});

test("doctor rejects stale independent Tweakers live-health evidence instead of treating it as current", () => {
  const checks = independentTweakersLiveHealthDoctorChecks({
    state: "stale",
    health: {} as never,
  });
  assert.deepEqual(checks, [{
    name: "independent Tweakers live health",
    ok: false,
    detail: "rejected stale evidence",
  }]);
});

test("doctor fails the environment consistency check when the selection drifts from the registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-drift-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ mode: "tweakers", appRoot: join(root, "missing.app") }));
    const registry = defaultEnvironmentProfileRegistry(root);
    registry.selected = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-22T15:57:00.000Z",
      appliedAt: "2026-07-22T15:57:00.000Z",
    });
    writeEnvironmentProfileRegistry(join(root, "environment-registry.json"), registry);
    const driftedSelection = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-22T16:18:00.000Z",
      appliedAt: "2026-07-22T16:18:00.000Z",
    });
    writeFileSync(join(root, "environment-selection.json"), `${JSON.stringify(driftedSelection)}\n`);

    const output = await doctorOutput(root);
    assert.match(output, /environment consistency/);
    assert.match(output, /does not match the profile registry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor passes the environment consistency check when the pair agrees", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-consistent-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ mode: "tweakers", appRoot: join(root, "missing.app") }));
    const registry = defaultEnvironmentProfileRegistry(root);
    const selection = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-22T16:18:00.000Z",
      appliedAt: "2026-07-22T16:18:00.000Z",
    });
    registry.selected = selection;
    registry.lastKnownWorkingSelection = selection;
    writeEnvironmentProfileRegistry(join(root, "environment-registry.json"), registry);
    writeFileSync(join(root, "environment-selection.json"), `${JSON.stringify(selection)}\n`);

    const output = await doctorOutput(root);
    assert.match(output, /environment consistency/);
    assert.match(output, /selection matches the profile registry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports the default-off sealed pair as unavailable without creating its cache root", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-cache-observe-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ mode: "chatgpt", appRoot: join(root, "missing.app") }));

    const output = await doctorOutput(root, { json: true });

    const report = JSON.parse(output) as { checks: Array<{ name: string; status: string; detail: string }> };
    const cacheCheck = report.checks.find((check) => check.name === "environment mode cache");
    assert.deepEqual(cacheCheck, {
      name: "environment mode cache",
      status: "ok",
      detail: "unavailable; no generation; no environment mode cache has been published",
    });
    assert.equal(existsSync(join(root, "environment-cache")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const validationSha = (bytes: Buffer | string): DoctorSourceSha256 =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function validationCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(validationCanonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${validationCanonical(object[key])}`).join(",")}}`;
}

function refreshValidationEvidenceFingerprint(evidence: DoctorSourceEvidence): void {
  evidence.fingerprint = validationSha(validationCanonical({
    schemaVersion: evidence.schemaVersion, kind: evidence.kind, version: evidence.version, build: evidence.build,
    backend: evidence.backend, shippedFiles: evidence.shippedFiles, asar: evidence.asar,
    schemas: { state: evidence.schemas.state, files: evidence.schemas.files, fingerprint: evidence.schemas.fingerprint, problem: evidence.schemas.problem },
    complete: evidence.complete, unresolvedEvidence: evidence.unresolvedEvidence,
  }));
}

function refreshValidationComparisonFingerprint(comparison: DoctorSourceComparison): void {
  const { fingerprint: _fingerprint, ...payload } = comparison;
  comparison.fingerprint = validationSha(validationCanonical(payload));
}

function attachValidationBackend(evidence: DoctorSourceEvidence, mode: "valid" | "invalid-model" | "wrong-home" | "invalid-account" | "invalid-threads"): void {
  const path = join(evidence.appPath, evidence.backend.path);
  const source = `#!/usr/bin/env node
if (!process.argv.includes('cli_auth_credentials_store="ephemeral"')) process.exit(7);
let buffered='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffered+=chunk;let lines=buffered.split('\\n');buffered=lines.pop();for(const line of lines){if(!line)continue;const message=JSON.parse(line);let result;if(message.method==='initialize')result={codexHome:${JSON.stringify(mode)}==='wrong-home'?'/wrong':process.env.CODEX_HOME,platformFamily:'unix',platformOs:'macos',userAgent:'fixture'};else if(message.method==='model/list')result={data:${JSON.stringify(mode)}==='invalid-model'?[{}]:[{defaultReasoningEffort:'medium',description:'Fixture',displayName:'Fixture',hidden:false,id:'fixture',isDefault:true,model:'fixture',supportedReasoningEfforts:[{description:'Medium',reasoningEffort:'medium'}]}],nextCursor:null};else if(message.method==='account/read')result={account:${JSON.stringify(mode)}==='invalid-account'?{}:null,requiresOpenaiAuth:true};else if(message.method==='thread/list'||message.method==='thread/loaded/list')result={data:${JSON.stringify(mode)}==='invalid-threads'?[{}]:[],nextCursor:null};else continue;process.stdout.write(JSON.stringify({id:message.id,result})+'\\n')}});
`;
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
  const existing = evidence.shippedFiles.find((entry) => entry.path === evidence.backend.path);
  const file = { path: evidence.backend.path, kind: "file" as const, bytes: Buffer.byteLength(source), sha256: validationSha(source) };
  if (existing) Object.assign(existing, file); else evidence.shippedFiles.push(file);
  evidence.backend.version = "fixture";
  evidence.backend.sha256 = file.sha256;
  refreshValidationEvidenceFingerprint(evidence);
}

async function validationFixture(root: string, name: string): Promise<DoctorSourceEvidence> {
  const appPath = join(root, `${name}.app`);
  const resources = join(appPath, "Contents", "Resources");
  const source = join(root, `${name}-asar-source`);
  mkdirSync(resources, { recursive: true });
  mkdirSync(source, { recursive: true });
  mkdirSync(join(source, "nested"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ main: "main" }));
  writeFileSync(join(source, "helper.js"), "export const helper = 1;\n");
  writeFileSync(join(source, "nested", "leaf.js"), "export const nested = true;\n");
  writeFileSync(join(source, "main.js"),
    "import './helper.js';import {\n nested\n} from './nested/leaf';" +
    "const stringExample=\"import './missing-string.js'\";/* import './missing-comment.js' */" +
    "let M=FM({buildFlavor:a,allowDevtools:p,globalState:j.globalState," +
    "getGlobalStateForHost:j.getGlobalStateForHost,desktopRoot:j.desktopRoot," +
    "preloadPath:j.preloadPath,repoRoot:j.repoRoot,disposables:k})," +
    "N=e=>M.isTrustedIpcSender(e.sender);wD({buildFlavor:a,isTrustedIpcEvent:N})\n");
  const asarPath = join(resources, "app.asar");
  // asar 3 returns its ending stream before buffered payload writes finish.
  // Capture fixture hashes only after those bytes reach the output file.
  const archiveWrite = await asar.createPackage(source, asarPath) as unknown as Writable;
  await finished(archiveWrite);
  const infoPath = join(appPath, "Contents", "Info.plist");
  writePlist(infoPath, {
    CFBundleShortVersionString: "1.0.0",
    CFBundleVersion: "100",
    ElectronAsarIntegrity: {
      "Resources/app.asar": { algorithm: "SHA256", hash: readHeaderHash(asarPath).headerHash },
    },
  });
  const shippedFiles = [
    ["Contents/Info.plist", infoPath],
    ["Contents/Resources/app.asar", asarPath],
  ].map(([path, absolute]) => ({
    path: path!, kind: "file" as const, bytes: statSync(absolute!).size,
    sha256: validationSha(readFileSync(absolute!)),
  }));
  const members = asar.listPackage(asarPath, { isPack: false }).map((entry) => entry.replace(/^\//, ""))
    .filter((path) => !("files" in asar.statFile(asarPath, path, false))).sort()
    .map((path) => {
      const bytes = asar.extractFile(asarPath, path);
      return { path, kind: "file" as const, bytes: bytes.length, rawSha256: validationSha(bytes), semanticSha256: validationSha(bytes), unpacked: false };
    });
  const evidence: DoctorSourceEvidence = {
    schemaVersion: 1,
    kind: "tweakers-doctor-source-evidence",
    appPath,
    version: "1.0.0",
    build: "100",
    backend: { path: "Contents/Resources/codex", version: null, sha256: null },
    shippedFiles,
    asar: { path: "Contents/Resources/app.asar", sha256: validationSha(readFileSync(asarPath)), members },
    schemas: { state: "missing_backend", command: [], files: [], fingerprint: null, problem: "fixture has no backend" },
    complete: false,
    unresolvedEvidence: ["backend-missing:Contents/Resources/codex"],
    fingerprint: validationSha("pending"),
    artifact: "doctor-source-evidence.json",
  };
  refreshValidationEvidenceFingerprint(evidence);
  return evidence;
}

function validationComparison(before: DoctorSourceEvidence, after: DoctorSourceEvidence): DoctorSourceComparison {
  const comparison: DoctorSourceComparison = {
    schemaVersion: 1,
    kind: "tweakers-doctor-source-comparison",
    beforeFingerprint: before.fingerprint,
    afterFingerprint: after.fingerprint,
    identical: false,
    complete: false,
    changes: [],
    renamedIdenticalArtifacts: [],
    requiredChecks: [],
    unresolvedEvidence: [],
    backendSourceComparison: { status: "not_attempted", reason: "fixture" },
    fingerprint: validationSha("pending"),
  };
  refreshValidationComparisonFingerprint(comparison);
  return comparison;
}

test("doctor validation binds exact evidence and passes representative package checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-validation-"));
  const restore = setDoctorValidationDependenciesForTest({
    run: () => ({ status: 0, stdout: "valid", stderr: "" }),
  });
  try {
    const before = await validationFixture(root, "before");
    const after = await validationFixture(root, "after");
    const comparison = validationComparison(before, after);
    comparison.requiredChecks = [
      "main-process-patch-compatibility",
      "frontend-patch-compatibility",
      "backend-version-and-app-server-compatibility",
    ];
    refreshValidationComparisonFingerprint(comparison);
    const report = await collectDoctorValidation({
      before, after, comparison,
      outputRoot: join(root, "output"), tweakersSourceRoot: join(import.meta.dirname, "../../.."),
    });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.binding.beforeFingerprint, before.fingerprint);
    assert.equal(report.binding.afterFingerprint, after.fingerprint);
    assert.match(report.fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(report.checks.find((entry) => entry.id === "evidence-binding")?.state, "passed");
    assert.equal(report.checks.find((entry) => entry.id === "after-source-bytes")?.state, "passed", report.checks.find((entry) => entry.id === "after-source-bytes")?.summary);
    assert.equal(report.checks.find((entry) => entry.id === "after-asar-package-integrity")?.state, "passed");
    assert.equal(report.checks.find((entry) => entry.id === "window-services-patch")?.state, "passed");
    assert.equal(report.checks.find((entry) => entry.id === "model-selection-patch"), undefined);
    assert.equal(report.checks.find((entry) => entry.id === "accounts-native-patch")?.state, "failed");
    assert.equal(report.checks.find((entry) => entry.id === "after-backend-protocol-smoke")?.state, "unsupported");
    assert.equal(existsSync(join(root, "output", "doctor-validation.json")), true);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor validation fails closed on binding drift and records command failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-validation-failure-"));
  const restore = setDoctorValidationDependenciesForTest({
    run: (command, args) => command === "/usr/bin/codesign"
      ? { status: 1, stdout: "", stderr: "invalid signature" }
      : { status: 0, stdout: command === "/usr/bin/file" && args.at(-1)?.includes("after-shipped") ? "ASCII text" : command === "/usr/bin/file" ? "Mach-O 64-bit" : "valid", stderr: "" },
  });
  try {
    const before = await validationFixture(root, "before");
    const after = await validationFixture(root, "after");
    const comparison = validationComparison(before, after);
    for (const [evidence, content] of [[before, "old"], [after, "new"]] as const) {
      const local = "Contents/Resources/changed (Alerts).node";
      const absolute = join(evidence.appPath, local);
      writeFileSync(absolute, content);
      evidence.shippedFiles.push({ path: local, kind: "file", bytes: content.length, sha256: validationSha(content) });
      refreshValidationEvidenceFingerprint(evidence);
    }
    comparison.beforeFingerprint = validationSha("wrong-before");
    comparison.afterFingerprint = after.fingerprint;
    comparison.changes.push({
      artifact: "shipped_file", path: "Contents/Resources/changed (Alerts).node", change: "modified",
      beforeSha256: before.shippedFiles.at(-1)!.sha256, afterSha256: after.shippedFiles.at(-1)!.sha256,
      semanticEquivalent: false, relevance: "relevant", area: "native_modules",
      tweakersOwnership: "fixture", requiredChecks: ["native-module-abi-compatibility"], reason: "fixture binary changed",
    });
    refreshValidationComparisonFingerprint(comparison);
    const report = await collectDoctorValidation({
      before, after, comparison, outputRoot: join(root, "output"),
      tweakersSourceRoot: join(import.meta.dirname, "../../.."),
    });
    assert.equal(report.checks.find((entry) => entry.id === "evidence-binding")?.state, "failed");
    const binary = report.checks.find((entry) => entry.id === "binary-metadata");
    assert.equal(binary?.state, "failed", JSON.stringify(report.checks.filter(entry => entry.id.includes("source-bytes") || entry.id === "binary-metadata")));
    const codesign = binary?.commands.filter((command) => command.argv[0] === "/usr/bin/codesign") ?? [];
    assert.equal(codesign.length, 2);
    assert.equal(codesign.every((command) => command.exitCode === 1), true);
    const structural = binary?.commands.filter((command) => command.argv[0] !== "/usr/bin/codesign") ?? [];
    assert.equal(structural.length, 4);
    assert.equal(structural.every((command) => !command.argv.at(-1)!.includes("(")), true);
    assert.equal(binary?.artifacts.some((artifact) => artifact.includes("changed (Alerts).node")), true);
    assert.match(binary?.summary ?? "", /expected Mach-O binary, found ASCII text/);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor validation backend probe binds isolated home and validates retained response schemas", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-validation-backend-"));
  try {
    const before = await validationFixture(root, "before");
    const after = await validationFixture(root, "after");
    attachValidationBackend(before, "valid");
    attachValidationBackend(after, "invalid-model");
    let comparison = validationComparison(before, after);
    comparison.requiredChecks = ["backend-version-and-app-server-compatibility"];
    refreshValidationComparisonFingerprint(comparison);
    let report = await collectDoctorValidation({
      before, after, comparison, outputRoot: join(root, "output-model"),
      tweakersSourceRoot: join(import.meta.dirname, "../../.."),
    });
    assert.equal(report.checks.find((entry) => entry.id === "before-backend-protocol-smoke")?.state, "passed", JSON.stringify(report.checks.filter(entry => entry.id.includes("source-bytes") || entry.id === "before-backend-protocol-smoke")));
    const invalidModel = report.checks.find((entry) => entry.id === "after-backend-protocol-smoke");
    assert.equal(invalidModel?.state, "failed");
    assert.match(invalidModel?.summary ?? "", /ModelListResponse fields/);
    assert.ok(invalidModel?.commands[0]?.argv.includes('cli_auth_credentials_store="ephemeral"'));

    attachValidationBackend(after, "wrong-home");
    comparison = validationComparison(before, after);
    comparison.requiredChecks = ["backend-version-and-app-server-compatibility"];
    refreshValidationComparisonFingerprint(comparison);
    report = await collectDoctorValidation({
      before, after, comparison, outputRoot: join(root, "output-home"),
      tweakersSourceRoot: join(import.meta.dirname, "../../.."),
    });
    const wrongHome = report.checks.find((entry) => entry.id === "after-backend-protocol-smoke");
    assert.equal(wrongHome?.state, "failed");
    assert.match(wrongHome?.summary ?? "", /isolated CODEX_HOME/);
    for (const mode of ["invalid-account", "invalid-threads"] as const) {
      attachValidationBackend(after, mode);
      const probeComparison = validationComparison(before, after);
      probeComparison.requiredChecks = ["backend-version-and-app-server-compatibility"];
      refreshValidationComparisonFingerprint(probeComparison);
      const failed = await collectDoctorValidation({before, after, comparison: probeComparison, outputRoot: join(root, mode), tweakersSourceRoot: join(import.meta.dirname, "../../..")});
      assert.equal(failed.checks.find(entry => entry.id === "after-backend-protocol-smoke")?.state, "failed");
      assert.match(failed.checks.find(entry => entry.id === "after-backend-protocol-smoke")?.summary ?? "", mode === "invalid-account" ? /account\/read/ : /thread\/loaded\/list/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-upstream maintenance verifies the actual unchanged backend and rejects baseline drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-maintenance-"));
  try {
    const before = await validationFixture(root, "official-before");
    const after = await validationFixture(root, "official-after");
    const installed = await validationFixture(root, "installed");
    const candidate = await validationFixture(root, "candidate");
    attachValidationBackend(before, "invalid-model");
    attachValidationBackend(after, "invalid-model");
    attachValidationBackend(installed, "valid");
    attachValidationBackend(candidate, "valid");
    const comparison = validationComparison(before, after);
    comparison.requiredChecks = ["backend-version-and-app-server-compatibility"];
    refreshValidationComparisonFingerprint(comparison);
    const baseline = {evidence: installed, originalAsarHeaderHash: readHeaderHash(join(after.appPath, after.asar.path)).headerHash};
    const input = {before, after, comparison, candidateEvidence: candidate, retainedBackendBaseline: baseline,
      tweakersSourceRoot: join(import.meta.dirname, "../../.."), outputRoot: join(root, "output")};
    const valid = await collectDoctorValidation(input);
    assert.equal(valid.checks.find(c => c.id === "retained-backend-baseline")?.state, "passed");
    assert.equal(valid.checks.find(c => c.id === "before-backend-protocol-smoke")?.state, "passed");
    assert.equal(valid.retainedBackendBaselineFingerprint, installed.fingerprint);
    const wrongSource = await collectDoctorValidation({...input, retainedBackendBaseline: {...baseline, originalAsarHeaderHash: "wrong"}});
    assert.equal(wrongSource.checks.find(c => c.id === "retained-backend-baseline")?.state, "failed");
    candidate.build = "101"; refreshValidationEvidenceFingerprint(candidate);
    const upgrade = await collectDoctorValidation(input);
    assert.equal(upgrade.checks.find(c => c.id === "retained-backend-baseline")?.state, "failed");
    candidate.build = "100"; attachValidationBackend(candidate, "invalid-model");
    const changed = await collectDoctorValidation(input);
    assert.equal(changed.checks.find(c => c.id === "retained-backend-baseline")?.state, "failed");
    assert.equal(changed.checks.find(c => c.id === "app-server-schema-contracts")?.state, "unsupported");
    attachValidationBackend(candidate, "valid");
    writeFileSync(join(installed.appPath, installed.backend.path), "tampered");
    const tampered = await collectDoctorValidation(input);
    assert.equal(tampered.checks.find(c => c.id === "retained-backend-baseline")?.state, "failed");
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("doctor candidate fingerprints bind reachable implementation and payload inputs only", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-fingerprint-"));
  const modules = join(root, "modules");
  const runtime = join(root, "runtime");
  try {
    mkdirSync(join(modules, "commands"), { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { "": { dependencies: { fixture: "1.0.0" } } } }));
    writeFileSync(join(modules, "commands", "create-variant.js"), [
      "import { candidate } from '../candidate.js';",
      "export function createTweakersVariantCandidateOnly() { return candidate(); }",
      "export function createTweakersVariant() { return 'promotion-v1'; }",
      "export function unusedUiPreview() { return 'unused-ui-v1'; }",
    ].join("\n"));
    writeFileSync(join(modules, "candidate.js"), [
      "import { referenced } from './referenced.js';",
      "function initialize(value) { return value; }",
      "const initialized = initialize('side-effect-v1');",
      "export function candidate() { return referenced() + initialized; }",
    ].join("\n"));
    writeFileSync(join(modules, "referenced.js"), "export function referenced() { return 'referenced-v1'; }\n");
    writeFileSync(join(modules, "doctor-validation.js"), "export function collectDoctorValidation() { return 'validation'; }\n");
    writeFileSync(join(modules, "doctor-compatibility.js"), [
      "export const DOCTOR_CORE_CHECKS = [];",
      "export function makeDoctorCompatibility() { return 'compatibility'; }",
      "export function assertDoctorCompatibility() { return 'assertion'; }",
    ].join("\n"));
    writeFileSync(join(modules, "doctor-approval.js"), "export function consumeDoctorCandidateApproval() { return 'approval'; }\n");
    writeFileSync(join(modules, "manager-action-adapter.js"), "export function createSealedTweakersManagerActionAdapter() { return 'adapter'; }\n");
    writeFileSync(join(runtime, "payload.js"), "payload-v1\n");

    const constructionEntries: Array<[string, string[]]> = [["commands/create-variant", ["createTweakersVariantCandidateOnly"]]];
    const baselineConstruction = doctorCodeScopeFingerprint(modules, constructionEntries);
    const baselineScopes = doctorImplementationScopes(modules, runtime);

    writeFileSync(join(modules, "commands", "create-variant.js"), [
      "import { candidate } from '../candidate.js';",
      "export function createTweakersVariantCandidateOnly() { return candidate(); }",
      "export function createTweakersVariant() { return 'promotion-v1'; }",
      "export function unusedUiPreview() { return 'unused-ui-v2'; }",
    ].join("\n"));
    assert.equal(doctorCodeScopeFingerprint(modules, constructionEntries), baselineConstruction, "unreachable UI declarations must not invalidate construction");

    writeFileSync(join(modules, "referenced.js"), "export function referenced() { return 'referenced-v2'; }\n");
    assert.notEqual(doctorCodeScopeFingerprint(modules, constructionEntries), baselineConstruction, "referenced declarations must invalidate construction");
    writeFileSync(join(modules, "referenced.js"), "export function referenced() { return 'referenced-v1'; }\n");

    writeFileSync(join(modules, "candidate.js"), [
      "import { referenced } from './referenced.js';",
      "function initialize(value) { return value; }",
      "const initialized = initialize('side-effect-v2');",
      "export function candidate() { return referenced() + initialized; }",
    ].join("\n"));
    assert.notEqual(doctorCodeScopeFingerprint(modules, constructionEntries), baselineConstruction, "named-import module initialization must invalidate construction");
    writeFileSync(join(modules, "candidate.js"), [
      "import { referenced } from './referenced.js';",
      "function initialize(value) { return value; }",
      "const initialized = initialize('side-effect-v1');",
      "export function candidate() { return referenced() + initialized; }",
    ].join("\n"));

    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    lock.packages[""].dependencies.fixture = "2.0.0";
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
    assert.notEqual(doctorCodeScopeFingerprint(modules, constructionEntries), baselineConstruction, "resolved dependency lock data must invalidate construction");
    lock.packages[""].dependencies.fixture = "1.0.0";
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));

    writeFileSync(join(modules, "dynamic.js"), "const moduleName = './candidate.js'; export async function dynamic() { return import(moduleName); }\n");
    assert.throws(() => doctorCodeScopeFingerprint(modules, [["dynamic", ["dynamic"]]]), /Nonliteral scoped import/, "nonliteral dynamic imports must fail closed");

    writeFileSync(join(modules, "commands", "create-variant.js"), [
      "import { candidate } from '../candidate.js';",
      "export function createTweakersVariantCandidateOnly() { return candidate(); }",
      "export function createTweakersVariant() { return 'promotion-v2'; }",
      "export function unusedUiPreview() { return 'unused-ui-v2'; }",
    ].join("\n"));
    const promotionChanged = doctorImplementationScopes(modules, runtime);
    assert.equal(promotionChanged.construction, baselineScopes.construction);
    assert.equal(promotionChanged.verification, baselineScopes.verification);
    assert.notEqual(promotionChanged.promotion, baselineScopes.promotion, "promotion implementation must use an independent scope");
    assert.equal(sameDoctorCandidateImplementation(baselineScopes, promotionChanged), true, "promotion-only changes must not invalidate an already constructed candidate");

    mkdirSync(join(runtime, "native"), { recursive: true });
    const baselinePayload = doctorCandidatePayloadFingerprint(runtime);
    mkdirSync(join(runtime, "native", "Tweakers Doctor.app"), { recursive: true });
    writeFileSync(join(runtime, "native", "Tweakers Doctor.app", "ignored"), "ignored-v1\n");
    writeFileSync(join(runtime, "runtime-fingerprint.json"), "metadata-v1\n");
    assert.equal(doctorCandidatePayloadFingerprint(runtime), baselinePayload, "native Doctor app and self-describing runtime metadata are excluded from candidate payload");
    writeFileSync(join(runtime, "native", "Tweakers Doctor.app", "ignored"), "ignored-v2\n");
    writeFileSync(join(runtime, "runtime-fingerprint.json"), "metadata-v2\n");
    assert.equal(doctorCandidatePayloadFingerprint(runtime), baselinePayload);

    writeFileSync(join(runtime, "payload.js"), "payload-v2\n");
    const payloadChanged = doctorImplementationScopes(modules, runtime);
    assert.notEqual(payloadChanged.payload, promotionChanged.payload);
    assert.equal(sameDoctorCandidateImplementation(promotionChanged, payloadChanged), false, "candidate payload changes must invalidate construction");
    writeFileSync(join(runtime, "payload.js"), "payload-v1\n");

    writeFileSync(join(runtime, "link-target-a"), "target-a\n");
    writeFileSync(join(runtime, "link-target-b"), "target-b\n");
    symlinkSync("link-target-a", join(runtime, "payload-link"));
    const firstLinkPayload = doctorCandidatePayloadFingerprint(runtime);
    rmSync(join(runtime, "payload-link"));
    symlinkSync("link-target-b", join(runtime, "payload-link"));
    assert.notEqual(doctorCandidatePayloadFingerprint(runtime), firstLinkPayload, "symlink targets must bind candidate payload");

    const beforeMode = doctorCandidatePayloadFingerprint(runtime);
    chmodSync(join(runtime, "payload.js"), 0o755);
    assert.notEqual(doctorCandidatePayloadFingerprint(runtime), beforeMode, "executable bits must bind candidate payload");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
