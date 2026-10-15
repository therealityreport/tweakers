/** Complete on-disk custody fixture. Only the consuming gate's codesign port is replaced. */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DoctorRuntimeRepairAuthorityV1, DoctorRuntimeRepairAuthorityV2 } from "../../sdk/src/accepted-runtime-repair-contract";
import { acceptedCombinedPayloadText } from "../../sdk/src/accepted-backend-transition-contract";
import { canonicalManagerJson } from "../../installer/src/manager-contract";
import { fingerprintManagerManagedRuntimeSource } from "../../installer/src/managed-runtime";
import { computeRuntimeFingerprint } from "../../installer/src/runtime-fingerprint";
import { reviewRuntimeRepairGeneratedDelta } from "../../installer/src/runtime-repair-source-custody";
import { produceAcceptedRuntimeRepairChildFixture } from "../../installer/test/fixtures/accepted-runtime-repair-child";
import { fingerprintTweakersVariantGeneration as generation } from "../src/desktop-update-startup";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const leaf = "631275551276127985A524ACF1F469BF5164D50D";
const operationId = "00000000-0000-4000-8000-000000000001", promotionId = "00000000-0000-4000-8000-000000000002";
const repairId = "00000000-0000-4000-8000-000000000003", sourceTx = "00000000-0000-4000-8000-000000000004";
function directory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }
function write(path: string, value: string | Buffer, mode = 0o600) {
  directory(dirname(path)); writeFileSync(path, value, { mode }); chmodSync(path, mode); return { path, sha256: sha(value) };
}
function json(path: string, value: unknown) { return write(path, JSON.stringify(value) + "\n"); }
function sealModes(path: string): void {
  if (lstatSync(path).isDirectory()) { for (const name of readdirSync(path)) sealModes(join(path, name)); chmodSync(path, 0o500); }
  else chmodSync(path, 0o400);
}
function fileCount(path: string): number {
  return lstatSync(path).isDirectory() ? readdirSync(path).reduce((n, name) => n + fileCount(join(path, name)), 0) : 1;
}
function runtimeDocument(path: string) {
  const evidence = computeRuntimeFingerprint(path);
  const ref = json(join(path, "runtime-fingerprint.json"), { schemaVersion: 1, ...evidence });
  return { sourceRoot: path, ...evidence, documentSha256: ref.sha256 };
}
function bundle(source: string): string {
  return `compiled ${source}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3,
    sources: ["../src/main.ts"], sourcesContent: [source], names: [], mappings: "" })).toString("base64")}\n`;
}
const commands = [
  ...["installer", "runtime", "sdk"].map(name => ["node_modules/typescript/bin/tsc", "--noEmit", "-p", `packages/${name}/tsconfig.json`]),
  ["--import", "./scripts/test-root-preload.mjs", "--import", "tsx", "--test", "--test-concurrency=2", "--test-name-pattern=accepted runtime repair|schema6|schema5 is explicit",
    "packages/installer/test/accepted-runtime-repair.test.ts", "packages/installer/test/runtime-repair-source-custody.test.ts", "packages/installer/test/runtime-ready-receipt.test.ts",
    "packages/runtime/test/accepted-runtime-repair-contract.test.ts", "packages/installer/test/manager-historical-continuations.test.ts",
    "packages/installer/test/manager-action-adapter.test.ts", "packages/installer/test/manager-cli.test.ts",
    "packages/installer/test/generation-retention.test.ts",
    "packages/runtime/test/accepted-runtime-repair-bootstrap.test.ts", "packages/runtime/test/desktop-update-startup.test.ts"],
  ["--test", "scripts/verify-runtime-repair-source.test.mjs"],
];

export function completeAcceptedRuntimeRepairFixture(phase: "challenge:published" | "committed") {
  const managerRoot = realpathSync(mkdtempSync(join(tmpdir(), "accepted-runtime-repair-complete-"))); chmodSync(managerRoot, 0o700);
  const userRoot = join(managerRoot, "variants", "tweakers"), target = join(managerRoot, "Tweakers.app");
  const childRoot = join(userRoot, "builds", promotionId, "runtime-repair", "accepted", "operations", repairId);
  directory(childRoot);
  const manager = join(managerRoot, "managers", "com.thomashulihan.tweakers");
  const node = write(join(managerRoot, "node"), "fixture node", 0o700);
  const signature = { identity: "fixture Developer ID", teamIdentifier: null, designatedRequirement: null };
  const createWorker = (source: string, repaired: boolean) => {
    const runtimeStage = join(managerRoot, repaired ? "new-runtime-stage" : "old-runtime-stage"); directory(runtimeStage);
    write(join(runtimeStage, "main.js"), bundle(source));
    write(join(runtimeStage, "account-router", "native-transfer.js"), "reader2\n");
    write(join(runtimeStage, "account-router", "native-source-retirement.js"), "retirement2\n");
    const raw = runtimeDocument(runtimeStage), runtimeRoot = join(manager, "runtime-generations", raw.fingerprint);
    directory(dirname(runtimeRoot)); renameSync(runtimeStage, runtimeRoot);
    const baseline = { ...raw, sourceRoot: runtimeRoot };
    const stage = join(managerRoot, repaired ? "new-managed-stage" : "old-managed-stage"); directory(stage);
    for (const name of ["package.json", "package-lock.json", "bin/cli", "node_modules/dependency/index.js", "packages/installer/package.json", "packages/sdk/package.json", "packages/sdk/dist/index.js"]) write(join(stage, name), "unchanged\n");
    const module = join(stage, "packages", "installer", "dist");
    write(join(module, "manager-descriptor.js"), `const PINNED_MANAGER_DESIGNATED_REQUIREMENT = 'identifier "com.therealityreport.tweakers.manager-launcher" and certificate leaf = H"${leaf.toLowerCase()}"';\n`);
    const assets = join(stage, "packages", "installer", "assets", "runtime"); directory(dirname(assets)); cpSync(runtimeRoot, assets, { recursive: true });
    let custody: any;
    if (repaired) {
      const evidence = join(module, "runtime-repair-source-evidence"), logRoot = join(evidence, "logs", repairId);
      directory(logRoot);
      const sourceFiles = [{ relativePath: "packages/runtime/src/main.ts", mode: 0o644, sha256: sha(source) }];
      const checkNode = { path: node.path, sha256: node.sha256, version: "v22.0.0" };
      const checks: any = { version: 1, kind: "tweakers-runtime-repair-source-checks", checkoutRoot: "/private/captured-checkout",
        sourceFiles, inputIdentity: sha(JSON.stringify(sourceFiles)), node: checkNode, dependencyIdentity: sha("captured dependencies"), environmentIdentity: sha("captured environment"),
        inputSnapshots: {}, checks: commands.map((argv, i) => ({ command: node.path, argv, cwd: "/private/captured-checkout",
          startedAt: "2026-10-12T13:00:00Z", completedAt: "2026-10-12T13:01:00Z", exitCode: 0,
          stdout: { relativePath: `logs/${repairId}/${i}.stdout.log`, sha256: sha(`passed ${i}`) },
          stderr: { relativePath: `logs/${repairId}/${i}.stderr.log`, sha256: sha("") } })) };
      for (const [i, check] of checks.checks.entries()) { write(join(evidence, check.stdout.relativePath), `passed ${i}`); write(join(evidence, check.stderr.relativePath), ""); }
      const snapshot = { sourceFiles, inputIdentity: checks.inputIdentity, dependencyIdentity: checks.dependencyIdentity, environmentIdentity: checks.environmentIdentity, node: checkNode };
      for (const side of ["before", "after"]) {
        const relativePath = `logs/${repairId}/inputs-${side}.json`, ref = json(join(evidence, relativePath), snapshot);
        checks.inputSnapshots[side] = { relativePath, sha256: ref.sha256 };
      }
      const checksRef = json(join(evidence, "checks.json"), checks);
      custody = { version: 1, kind: "tweakers-runtime-repair-source-custody", checkReceipt: { relativePath: "runtime-repair-source-evidence/checks.json", sha256: checksRef.sha256 },
        sourceFiles, packagedRuntime: { fingerprint: baseline.fingerprint, fileCount: baseline.fileCount, documentSha256: baseline.documentSha256 },
        generatedFiles: [{ relativePath: "packages/installer/assets/runtime/main.js", mode: 0o644, sealedMode: 0o400, sha256: sha(bundle(source)), mappingKind: "esbuild-source-map",
          sourceInputs: [{ relativeSourcePath: sourceFiles[0]!.relativePath, sha256: sourceFiles[0]!.sha256 }] }] };
      json(join(module, "runtime-repair-source-custody.json"), custody);
    }
    sealModes(stage); sealModes(runtimeRoot);
    const managedFingerprint = fingerprintManagerManagedRuntimeSource(stage), count = fileCount(stage);
    chmodSync(stage, 0o700);
    json(join(stage, "managed-runtime-fingerprint.json"), { schemaVersion: 1, fingerprint: managedFingerprint, fileCount: count }); chmodSync(join(stage, "managed-runtime-fingerprint.json"), 0o400);
    const managedRoot = join(manager, "managed-runtime-generations", managedFingerprint); directory(dirname(managedRoot)); renameSync(stage, managedRoot);
    chmodSync(managedRoot, 0o500);
    const moduleRoot = join(managedRoot, "packages", "installer", "dist");
    const managerBytes = `//# TWEAKERS_MANAGER_RUNTIME_FINGERPRINT_V1=${baseline.fingerprint}\n//# TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT_V1=${managedFingerprint}\n`;
    const values = { "manager-id": "com.thomashulihan.tweakers", "protocol-version": "1", "launcher-sha256": sha("fixture launcher"), "node-path": node.path,
      "node-sha256": node.sha256, "manager-sha256": sha(managerBytes), "managed-runtime-fingerprint": managedFingerprint };
    const generationId = sha(["TWEAKERS_MANAGER_GENERATION_V1", ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ""].join("\n"));
    const generationRoot = join(manager, "generations", generationId), launcher = write(join(generationRoot, "Tweakers Manager Launcher"), "fixture launcher", 0o500);
    write(join(generationRoot, "manager.mjs"), managerBytes, 0o400);
    const seal = write(join(generationRoot, "target.seal"), ["TWEAKERS_MANAGER_TARGET_SEAL_V1", `manager-id=${values["manager-id"]}`, "protocol-version=1", `generation-id=${generationId}`,
      ...Object.entries(values).slice(2).map(([key, value]) => `${key}=${value}`), ""].join("\n"), 0o400);
    const scopes = { version: 1 as const, construction: `sha256:${sha("construction")}`, verification: `sha256:${sha("verification")}`, promotion: `sha256:${sha("promotion")}`, payload: `sha256:${sha("payload")}` };
    return { baseline, runtimeRoot, moduleRoot, managedRoot, custody, worker: { generationId, launcherPath: launcher.path, launcherSha256: launcher.sha256, sealSha256: seal.sha256,
      nodePath: node.path, nodeSha256: node.sha256, implementationScopes: scopes } };
  };
  const old = createWorker("old bootstrap", false), next = createWorker("new bootstrap", true);
  // These mutable recovery copies are intentionally distinct from the sealed accepted baseline.
  const priorRuntime = join(childRoot, "prior-runtime"); cpSync(old.runtimeRoot, priorRuntime, { recursive: true });
  const makeWritable = (path: string): void => { chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600); if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name)); };
  makeWritable(priorRuntime); json(join(priorRuntime, "historical-recovery-marker.json"), { retained: true }); const prior = runtimeDocument(priorRuntime);
  const recoveryRoot = join(userRoot, "accounts-transfer-recovery", repairId); directory(dirname(recoveryRoot)); cpSync(next.runtimeRoot, recoveryRoot, { recursive: true }); makeWritable(recoveryRoot);
  const validation = json(join(recoveryRoot, "accounts-transfer-validation.v1.json"), { version: 1, checks: [{ command: "captured focused checks", exitCode: 0, outputSha256: sha("passed") }],
    sourceRuntimeFingerprint: next.baseline.fingerprint, sourceRuntimeFileCount: next.baseline.fileCount }); const recoveryEvidence = runtimeDocument(recoveryRoot);
  const runtimeRoot = join(userRoot, "runtime"); directory(userRoot); cpSync(next.runtimeRoot, runtimeRoot, { recursive: true }); makeWritable(runtimeRoot);
  const marker = json(join(runtimeRoot, "accounts-transfer-recovery.v1.json"), { version: 1, readerVersion: 2, supportedTransferVersions: [1, 2], sourceRetirementReaderVersion: 2,
    supportedSourceRetirementVersions: [2], runtimeTransferSha256: sha("reader2\n"), runtimeSourceRetirementSha256: sha("retirement2\n"), recoveryRuntimeRoot: recoveryRoot,
    recoveryFingerprint: recoveryEvidence.fingerprint, validationSha256: validation.sha256, sourceRuntimeFingerprint: next.baseline.fingerprint,
    sourceRuntimeFileCount: next.baseline.fileCount, verifiedAt: "2026-10-12T13:30:00Z" });
  const installed = runtimeDocument(runtimeRoot);
  const backend = write(join(target, "Contents", "Resources", "codex"), "accepted backend", 0o700), helper = write(join(target, "Contents", "Resources", "codex-code-mode-host"), "accepted helper", 0o700);
  write(join(userRoot, "tweaks", "manifest.json"), "{}"); json(join(userRoot, "state.json"), {}); json(join(userRoot, "config.json"), { tweaks: { "com.example.tweak": { enabled: true } } });
  const paths: Record<string, string> = { runtime: runtimeRoot, tweaks: join(userRoot, "tweaks"), "state.json": join(userRoot, "state.json"), "config.json": join(userRoot, "config.json"), app: target };
  const priorId = "00000000-0000-4000-8000-000000000007", priorBuild = join(userRoot, "builds", priorId);
  const priorGenerations: Record<string, any> = Object.fromEntries(Object.entries(paths).map(([name, path]) =>
    [name, generation(name === "runtime" ? priorRuntime : path)]));
  const priorActive = { version: 3, id: priorId, userRoot, target, entries: ["runtime", "tweaks", "state.json", "app"].map(name =>
    ({ name, path: paths[name], fingerprint: priorGenerations[name] })) };
  const priorActiveSource = json(join(priorBuild, "active-receipt.json"), priorActive);
  const retainedPriorActive = json(join(childRoot, "prior-active-receipt.json"), priorActive);
  const priorCandidate = join(dirname(target), `.Tweakers.app.candidate-${priorId}.app`);
  json(join(userRoot, "transactions", "variant-promotion", `${priorId}.json`), {
    version: 3, id: priorId, userRoot, target, candidate: priorCandidate, buildRoot: priorBuild, phase: "committed",
    entries: Object.keys(paths).map(name => ({ name, source: name === "app" ? priorCandidate : join(priorBuild, name), destination: paths[name],
      archive: name === "app" ? join(userRoot, "previous", priorId, "app", "Tweakers.app") : join(userRoot, "previous", priorId, "state", name),
      failed: name === "app" ? join(priorBuild, "failed-promotion", "app", "Tweakers.app") : join(priorBuild, "failed-promotion", "state", name),
      hadDestination: false, previous: null, desired: priorGenerations[name] })),
    activeReceipt: { source: priorActiveSource.path, destination: join(userRoot, "transactions", "variant-promotion", "active.json"),
      archive: join(userRoot, "previous", priorId, "active-receipt.json"), failed: join(priorBuild, "failed-promotion", "active-receipt.json"),
      hadDestination: false, previous: null, desired: generation(priorActiveSource.path), expected: priorActive },
  });
  const unchanged = { app: generation(target), backendSha256: backend.sha256, helperSha256: helper.sha256, backendSignature: signature, helperSignature: signature,
    resources: [], tweaks: generation(join(userRoot, "tweaks")), state: generation(join(userRoot, "state.json")), config: generation(join(userRoot, "config.json")),
    priorActiveReceipt: generation(retainedPriorActive.path) };
  const acceptedBuildReceipt = json(join(managerRoot, "codex-source", "accepted", sourceTx, "accepted-build.json"), { retained: "signed accepted baseline" });
  linkSync(acceptedBuildReceipt.path, join(dirname(acceptedBuildReceipt.path), ".accepted-build.json.92916.1791789816698.tmp"));
  const laneAuthority: any = { schemaVersion: 1, transactionId: sourceTx, installerPayloadHash: sha("installer payload"), acceptedBuildReceipt: { ...acceptedBuildReceipt,
      acceptedAt: "2026-10-12T11:00:00Z", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), cargoLockSha256: sha("lock"), reviewedDiffSha256: sha("diff"), patchSeriesSha256: sha("patches"),
      upstream: { repository: "https://github.com/openai/codex.git", tag: "rust-v0.162.0-alpha.17.2", commit: "a".repeat(40) }, verification: { level: "source-verified", installedAcceptance: "required" },
      buildCommand: "cargo build --locked --release", toolchain: "captured rustc", testEvidence: [{ name: "focused", command: "cargo test --locked --lib", receiptSha256: sha("captured test") }] },
    backend: { sourcePath: backend.path, sha256: backend.sha256, version: "0.162.0-alpha.17.2", architecture: "arm64", signature },
    closure: { codeModeHost: { path: helper.path, sha256: helper.sha256, architecture: "arm64", signature }, resources: [] }, runtime: old.baseline,
    sourceApp: { path: target, contentsFingerprint: sha("native source"), bundleId: "com.openai.codex" } };
  laneAuthority.payloadIdentity = sha(acceptedCombinedPayloadText(laneAuthority));
  const lane = { version: 1, identity: { target, userRoot, brokerRoot: join(userRoot, "accounts-broker") }, authority: laneAuthority,
    priorRegistrationFingerprint: `sha256:${sha("prior registration")}`, priorResolverBinarySha256: sha("old resolver") };
  const generations: Record<string, any> = { runtime: generation(priorRuntime), tweaks: unchanged.tweaks, "state.json": unchanged.state, "config.json": unchanged.config, app: unchanged.app };
  const active = { version: 3, id: promotionId, userRoot, target, entries: ["runtime", "tweaks", "state.json", "app"].map(name => ({ name, path: paths[name], fingerprint: generations[name] })) };
  const activeSource = json(join(userRoot, "builds", promotionId, "active-receipt.json"), active);
  const candidate = join(dirname(target), `.Tweakers.app.candidate-${promotionId}.app`), buildRoot = join(userRoot, "builds", promotionId);
  const journal: any = { version: 3, id: promotionId, userRoot, target, candidate, buildRoot, phase: "app:promoted", acceptedBackendTransition: { operationId, lane },
    entries: Object.keys(paths).map(name => ({ name, source: name === "app" ? candidate : join(buildRoot, name), destination: paths[name],
      archive: name === "app" ? join(userRoot, "previous", promotionId, "app", "Tweakers.app") : join(userRoot, "previous", promotionId, "state", name),
      failed: name === "app" ? join(buildRoot, "failed-promotion", "app", "Tweakers.app") : join(buildRoot, "failed-promotion", "state", name),
      hadDestination: true, previous: generations[name], desired: generations[name] })),
    activeReceipt: { source: activeSource.path, destination: join(userRoot, "transactions", "variant-promotion", "active.json"), archive: join(userRoot, "previous", promotionId, "active-receipt.json"),
      failed: join(buildRoot, "failed-promotion", "active-receipt.json"), hadDestination: true, previous: unchanged.priorActiveReceipt, desired: generation(activeSource.path), expected: active } };
  const originalJournal = json(join(userRoot, "transactions", "variant-promotion", `${promotionId}.json`), journal);
  const operation = { operationId, actionId: "refresh.independent", phase: "recovery-required", consumedAt: "2026-10-12T12:00:00Z", recoveryRequiredAt: "2026-10-12T12:01:00Z",
    completedAt: null, failedAt: null, cancelledAt: null, outcome: null, error: { message: "original latch failure" }, receiptRefs: [], moduleIdentity: { state: "resolved", path: old.worker.launcherPath, sha256: old.worker.launcherSha256 } };
  const originalOperation = json(join(managerRoot, "transactions", "manager-operations", `${operationId}.json`), operation);
  const originalExpectationValue = { schemaVersion: 5, kind: "tweakers-independent-runtime-ready-expectation", operationId, promotionId, activePromotionReceiptSha256: journal.activeReceipt.desired.sha256,
    appRoot: target, bundleId: "com.therealityreport.tweakers", appAsarHeaderHash: sha("asar"), runtimeFingerprint: prior.fingerprint,
    appUserDataRoot: join(userRoot, "app-data"), codexHomeRoot: join(userRoot, "codex"), accountsBrokerRoot: lane.identity.brokerRoot,
    brokerAuthorityExpectation: { globalRootState: "valid-v3", configSha256: sha("broker config") }, appearanceExpectation: { status: "normal", normalized: true },
    expectedTweakIds: ["com.example.tweak"], createdAt: "2026-10-12T12:00:00Z" };
  const originalExpectation = json(join(userRoot, "runtime-ready-expectation.json"), originalExpectationValue);
  const originalBundle = join(managerRoot, "doctor", "retained", "TweakersCandidateReceipt.bundle");
  const originalReceipt = json(join(originalBundle, "Contents", "Resources", "variant-candidate-receipt.json"), { id: promotionId, signingIdentityHash: leaf, acceptedBackendTransition: lane,
    identity: { appTarget: target, userRoot, appUserDataRoot: originalExpectationValue.appUserDataRoot, codexHomeRoot: originalExpectationValue.codexHomeRoot, accountsBrokerRoot: lane.identity.brokerRoot }, artifacts: { app: unchanged.app } });
  const originalCandidate = { bundlePath: originalBundle, bundleGeneration: generation(originalBundle), json: originalReceipt, id: promotionId, signingIdentityHash: leaf };
  const custody = json(join(childRoot, "original-custody.json"), { version: 1, kind: "tweakers-accepted-runtime-repair-original-custody", operationId, promotionId, trustedLeafSha1: leaf,
    originalWorker: old.worker, originalCandidateReceipt: originalCandidate, unchanged: { app: unchanged.app, tweaks: unchanged.tweaks, state: unchanged.state, config: unchanged.config, priorActiveReceipt: unchanged.priorActiveReceipt },
    originalAcceptedBaseline: old.baseline, priorRuntime: generations.runtime });
  const { phase: _phase, ...journalIdentity } = journal;
  const recoveryBinding = json(join(managerRoot, "transactions", "manager-recovery-bindings", `${operationId}.json`), { schemaVersion: 1, kind: "tweakers-manager-recovery-binding", operationId, promotionId, userRoot, target,
    generation: { appSha256: unchanged.app.sha256, runtimeFingerprint: prior.fingerprint, activeReceiptSha256: journal.activeReceipt.desired.sha256 },
    journal: { path: originalJournal.path, identitySha256: sha(canonicalManagerJson(journalIdentity)) }, receiptRefs: [], dependencyPaths: [], createdAt: "2026-10-12T12:00:00Z" });
  const origin = (source: { path: string; sha256: string }, name: string) => ({ sourcePath: source.path, sourceSha256AtCapture: source.sha256,
    snapshot: write(join(childRoot, name), readFileSync(source.path)) });
  const reviewed = reviewRuntimeRepairGeneratedDelta(old.managedRoot, next.managedRoot, next.custody);
  const authority: DoctorRuntimeRepairAuthorityV1 = { version: 1, kind: "tweakers-doctor-accepted-runtime-repair", operationId, promotionId, repairId, expectedPriorHeadSha256: null,
    originals: { operation: origin(originalOperation, "original-operation.json"), journal: origin(originalJournal, "original-journal.json"), expectation: origin(originalExpectation, "original-expectation.json"),
      custody, acceptedBuildReceipt, recoveryBinding, preparedCasIntent: json(join(childRoot, "prepared-cas-intent.json"), { captured: true }) },
    completedCas: { planFingerprint: `sha256:${sha('{"completed":true}\n')}`, prior: json(join(childRoot, "cas-prior.json"), { prior: true }), completed: json(join(childRoot, "cas-completed.json"), { completed: true }),
      currentRegistration: json(join(childRoot, "registration.json"), { resolverBinarySha256: backend.sha256 }), resolverSha256: backend.sha256 },
    originalWorker: old.worker, authorizedWorker: next.worker, originalTrustedLeafSha1: leaf,
    review: { jobId: sourceTx, reportFingerprint: `sha256:${sha("report")}`, validationFingerprint: `sha256:${sha("validation")}`, candidateFingerprint: `sha256:${sha("candidate")}`,
      adoptionFingerprint: `sha256:${sha("adoption")}`, promotionFingerprint: `sha256:${sha("promotion")}` }, unchanged, priorRuntime: generations.runtime,
    originalAcceptedBaseline: old.baseline, repairedBaseline: next.baseline, repairedRuntime: { generation: generation(runtimeRoot), evidence: { ...installed, sourceRoot: join(childRoot, "next-runtime") } },
    recovery: { root: recoveryRoot, generation: generation(recoveryRoot), markerSha256: marker.sha256, validationSha256: validation.sha256 },
    sourceDelta: { originalSourceVerification: json(join(childRoot, "original-sealed-source-verification.json"), { version: 1, kind: "tweakers-runtime-repair-original-sealed-verification",
      qualification: "retained-sealed-module-and-runtime-not-historical-raw-ts", worker: old.worker, moduleRoot: old.moduleRoot, runtimeRoot: old.runtimeRoot,
      moduleGeneration: generation(old.moduleRoot), runtimeGeneration: generation(old.runtimeRoot), candidateReceipt: originalCandidate.json, candidateReceiptBundleGeneration: originalCandidate.bundleGeneration }),
      repairedSourceVerification: { path: join(next.moduleRoot, "runtime-repair-source-custody.json"), sha256: sha(readFileSync(join(next.moduleRoot, "runtime-repair-source-custody.json"))) },
      reviewedDelta: json(join(childRoot, "reviewed-generated-delta.json"), reviewed), changedGeneratedFiles: reviewed.changes.map(change => ({ path: join(next.managedRoot, change.relativePath), sha256: change.after.sha256 })) },
    createdAt: "2026-10-12T13:59:00Z" };
  const child = produceAcceptedRuntimeRepairChildFixture({ managerRoot, userRoot, authority, originalJournal: journal, originalExpectation: originalExpectationValue, phase });
  write(journal.activeReceipt.destination, readFileSync(phase === "committed" ? child.effectiveActiveReceipt : join(childRoot, "prior-active-receipt.json")));
  const recordAcceptance = (acceptedChild: typeof child) => {
    const receipt = { ...acceptedChild.expectation, kind: "tweakers-independent-runtime-ready", pid: 1234, processStartToken: "fixture birth", appearance: originalExpectationValue.appearanceExpectation,
      mainInitialized: true, preloadInitialized: true, settingsMounted: true, sharedHistoryBrokerState: "connected", initializedTweakIds: originalExpectationValue.expectedTweakIds,
      observedAt: acceptedChild.intent.version === 1 ? "2026-10-12T14:03:00Z" : "2026-10-12T14:13:00Z" } as Record<string, unknown>;
    delete receipt.appearanceExpectation; delete receipt.expectedTweakIds; delete receipt.createdAt;
    const proof = { schemaVersion: 1, kind: "tweakers-manager-runtime-acceptance", expectation: acceptedChild.expectation, receipt, pid: 1234, processStartToken: "fixture birth" };
    const snapshot = json(join(acceptedChild.root, "acceptance.json"), proof);
    const source = write(join(managerRoot, "transactions", "manager-recovery-bindings", `${operationId}.acceptance.${sha(canonicalManagerJson(receipt))}.json`), readFileSync(snapshot.path));
    json(join(acceptedChild.root, "acceptance-source.json"), { version: 1, kind: "tweakers-accepted-runtime-repair-acceptance-source", sourcePath: source.path, sourceSha256AtCapture: source.sha256, snapshot });
  };
  if (phase === "committed") recordAcceptance(child);
  return { managerRoot, userRoot, target, child, authority, old, next, operation, originalOperation, input: { managerRoot, userRoot, target, operationId, promotionId },
    createWorker, makeWritable, recordAcceptance,
    settle: (completedAt = "2026-10-12T14:04:00Z") => json(originalOperation.path, { ...operation, phase: "completed", completedAt, recoveryRequiredAt: null, failedAt: null, cancelledAt: null, outcome: "verified-installation-accepted", error: null }) };
}

/** A real depth-two lineage: the failed predecessor runtime is archived without changing any original custody. */
export function completeAcceptedRuntimeRepairSuccessorFixture(phase: "challenge:published" | "committed") {
  const f = completeAcceptedRuntimeRepairFixture("challenge:published");
  const successorId = "00000000-0000-4000-8000-000000000008";
  const root = join(f.userRoot, "builds", promotionId, "runtime-repair", "accepted", "operations", successorId); directory(root);
  const next = f.createWorker("successor bootstrap", true);
  const originals = { ...f.authority.originals };
  for (const [key, name] of [["operation", "original-operation.json"], ["journal", "original-journal.json"], ["expectation", "original-expectation.json"]] as const) {
    originals[key] = { ...originals[key], snapshot: write(join(root, name), readFileSync(originals[key].snapshot.path)) };
  }
  originals.custody = write(join(root, "original-custody.json"), readFileSync(originals.custody.path));
  const challengePath = join(f.userRoot, "runtime-ready-expectation.json"), challengeBytes = readFileSync(challengePath);
  const capturedChallenge = write(join(root, "predecessor-challenge.json"), challengeBytes);
  const runtimeRoot = join(f.userRoot, "runtime"), installedRuntime = generation(runtimeRoot);
  renameSync(runtimeRoot, join(root, "prior-runtime"));
  cpSync(next.runtimeRoot, runtimeRoot, { recursive: true }); f.makeWritable(runtimeRoot);
  const recoveryRoot = join(f.userRoot, "accounts-transfer-recovery", successorId); cpSync(next.runtimeRoot, recoveryRoot, { recursive: true }); f.makeWritable(recoveryRoot);
  const validation = json(join(recoveryRoot, "accounts-transfer-validation.v1.json"), { version: 1, checks: [{ command: "captured focused checks", exitCode: 0, outputSha256: sha("passed") }],
    sourceRuntimeFingerprint: next.baseline.fingerprint, sourceRuntimeFileCount: next.baseline.fileCount }); const recoveryEvidence = runtimeDocument(recoveryRoot);
  const marker = json(join(runtimeRoot, "accounts-transfer-recovery.v1.json"), { version: 1, readerVersion: 2, supportedTransferVersions: [1, 2], sourceRetirementReaderVersion: 2,
    supportedSourceRetirementVersions: [2], runtimeTransferSha256: sha("reader2\n"), runtimeSourceRetirementSha256: sha("retirement2\n"), recoveryRuntimeRoot: recoveryRoot,
    recoveryFingerprint: recoveryEvidence.fingerprint, validationSha256: validation.sha256, sourceRuntimeFingerprint: next.baseline.fingerprint,
    sourceRuntimeFileCount: next.baseline.fileCount, verifiedAt: "2026-10-12T14:09:00Z" });
  const installed = runtimeDocument(runtimeRoot), reviewed = reviewRuntimeRepairGeneratedDelta(f.old.managedRoot, next.managedRoot, next.custody);
  write(join(root, "prior-active-receipt.json"), readFileSync(join(f.child.root, "prior-active-receipt.json")));
  const authority: DoctorRuntimeRepairAuthorityV2 = { ...f.authority, version: 2, repairId: successorId,
    expectedPriorHeadSha256: f.child.runtimeRepair.headSha256, originals,
    predecessor: { binding: f.child.runtimeRepair, publication: { path: join(f.child.root, "publication.json"), sha256: sha(readFileSync(join(f.child.root, "publication.json"))) },
      challenge: { sourcePath: challengePath, sourceSha256AtCapture: sha(challengeBytes), snapshot: capturedChallenge }, installedRuntime },
    authorizedWorker: next.worker, review: { ...f.authority.review, jobId: "00000000-0000-4000-8000-000000000009" },
    repairedBaseline: next.baseline, repairedRuntime: { generation: generation(runtimeRoot), evidence: { ...installed, sourceRoot: join(root, "next-runtime") } },
    recovery: { root: recoveryRoot, generation: generation(recoveryRoot), markerSha256: marker.sha256, validationSha256: validation.sha256 },
    sourceDelta: { originalSourceVerification: write(join(root, "original-sealed-source-verification.json"), readFileSync(f.authority.sourceDelta.originalSourceVerification.path)),
      repairedSourceVerification: { path: join(next.moduleRoot, "runtime-repair-source-custody.json"), sha256: sha(readFileSync(join(next.moduleRoot, "runtime-repair-source-custody.json"))) },
      reviewedDelta: json(join(root, "reviewed-generated-delta.json"), reviewed), changedGeneratedFiles: reviewed.changes.map(change => ({ path: join(next.managedRoot, change.relativePath), sha256: change.after.sha256 })) },
    createdAt: "2026-10-12T14:09:00Z" };
  const originalJournal = JSON.parse(readFileSync(originals.journal.snapshot.path, "utf8")), originalExpectation = JSON.parse(readFileSync(originals.expectation.snapshot.path, "utf8"));
  const child = produceAcceptedRuntimeRepairChildFixture({ managerRoot: f.managerRoot, userRoot: f.userRoot, authority, originalJournal, originalExpectation, phase });
  if (phase === "committed") {
    write(originalJournal.activeReceipt.destination, readFileSync(child.effectiveActiveReceipt)); f.recordAcceptance(child);
  }
  return { ...f, child, authority, next, predecessor: f.child, predecessorAuthority: f.authority,
    settle: () => f.settle("2026-10-12T14:14:00Z") };
}
