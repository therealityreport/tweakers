import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acceptedOfficialBundledPayloadText } from "../../sdk/src/accepted-backend-transition-contract.ts";
import { captureOfficialBundledBackendClosure, NATIVE_CODEX_BACKEND, NATIVE_CODEX_CLI_ROOT, NATIVE_CODE_MODE_HOST } from "../src/native-bundled-backend.ts";
import { fingerprintAppContents } from "../src/environment-profile.ts";
import { sealOfficialSourceTree } from "../src/official-source-registration.ts";
import { computeRuntimeFingerprint } from "../src/runtime-fingerprint.ts";
import { AcceptedBackendTransitionJournal, assertAcceptedSharedNativeBackendTransitionShape,
  assertAcceptedSharedNativeBackendTransitionRequestBinding, assertAcceptedSharedNativeBackendTransitionClosure,
  assertAcceptedSharedNativeBackendTransitionPrior, ForwardBackendTransitionRecoveryRequired,
  prepareOfficialBundledBackendTransitionRequest,
  type AcceptedSharedNativeBackendTransitionLaneV2, type AcceptedSharedNativeBackendTransitionRequestV2,
  type SharedNativeBackendTransitionPort, type OfficialBundledCandidateAuthorityV2 } from "../src/shared-native-backend-transition.ts";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const signatures = { certificate: () => "A".repeat(40), verify: () => ({ok: true, output: "fixture"}) };
function fixture(adapterReady = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "official-transition-")));
  const source = join(root, "Source.app"), candidate = join(root, "Candidate.app"), runtime = join(root, "runtime");
  for (const path of [NATIVE_CODEX_BACKEND, NATIVE_CODE_MODE_HOST]) {
    mkdirSync(dirname(join(source, path)), {recursive: true});
    writeFileSync(join(source, path), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1])); chmodSync(join(source, path), 0o755);
  }
  const relativePath = `${NATIVE_CODEX_CLI_ROOT}/codex-package.json` as const;
  const metadata = {layoutVersion: 1, version: "0.162.0-alpha.17.2", target: "aarch64-apple-darwin", variant: "codex", entrypoint: "bin/codex", resourcesDir: "codex-resources", pathDir: "codex-path"};
  writeFileSync(join(source, relativePath), JSON.stringify(metadata));
  writeFileSync(join(source, NATIVE_CODEX_CLI_ROOT, "bin", "codex"), "#!/bin/sh\nexit 0\n");
  const resource = join(source, NATIVE_CODEX_CLI_ROOT, "context.json"); writeFileSync(resource, "native context");
  cpSync(source, candidate, {recursive: true});
  mkdirSync(join(runtime, "account-router"), {recursive: true});
  writeFileSync(join(runtime, "account-router", "official-bundled-adapter.js"), `exports.OFFICIAL_BUNDLED_ADAPTER_VERSION_V1 = "official-bundled-adapter-v1";\nexports.OFFICIAL_BUNDLED_ADAPTER_READY_V1 = ${adapterReady};\n`);
  const runtimeEvidence = computeRuntimeFingerprint(runtime);
  const document = JSON.stringify({schemaVersion: 1, ...runtimeEvidence}) + "\n"; writeFileSync(join(runtime, "runtime-fingerprint.json"), document);
  const closure = captureOfficialBundledBackendClosure(source, signatures)!;
  const bare: Omit<OfficialBundledCandidateAuthorityV2, "payloadIdentity"> = {schemaVersion: 2, kind: "official-bundled", transactionId: "official-fixture", installerPayloadHash: "1".repeat(64),
    backend: {sourcePath: join(source, NATIVE_CODEX_BACKEND), sha256: closure.backend.sha256, version: metadata.version, architecture: "arm64", certificateSha1: closure.backend.certificateSha1},
    closure: {...closure, backend: {...closure.backend, relativePath: NATIVE_CODEX_BACKEND}, codeModeHost: {...closure.codeModeHost, relativePath: NATIVE_CODE_MODE_HOST}},
    nativePackage: {relativePath, sha256: sha(readFileSync(join(source, relativePath))), layoutVersion: 1, version: metadata.version, target: "aarch64-apple-darwin"},
    runtime: {sourceRoot: runtime, ...runtimeEvidence, documentSha256: sha(document), adapterVersion: "official-bundled-adapter-v1"},
    sourceApp: {path: source, bundleId: "com.openai.codex", contentsFingerprint: fingerprintAppContents(source), treeSeal: sealOfficialSourceTree(source)}};
  const userRoot = join(root, "user"), brokerRoot = join(root, "broker"); mkdirSync(brokerRoot, {mode: 0o700});
  const lane: AcceptedSharedNativeBackendTransitionLaneV2 = {version: 2, resolverProtocol: "official-bundled-v1", identity: {target: candidate, userRoot, brokerRoot},
    authority: {...bare, payloadIdentity: sha(acceptedOfficialBundledPayloadText(bare))}, priorRegistrationFingerprint: `sha256:${"2".repeat(64)}`, priorResolverBinarySha256: "3".repeat(64)};
  const request: AcceptedSharedNativeBackendTransitionRequestV2 = {version: 2, officialBundled: {transactionId: bare.transactionId, expectedSourceAppFingerprint: bare.sourceApp.contentsFingerprint,
    expectedBundleId: bare.sourceApp.bundleId, expectedBackendSha256: bare.backend.sha256, expectedVersion: bare.backend.version, expectedArchitecture: "arm64",
    expectedRuntimeFingerprint: bare.runtime.fingerprint, expectedRuntimeFileCount: bare.runtime.fileCount, expectedRuntimeDocumentSha256: bare.runtime.documentSha256},
    priorRegistrationFingerprint: lane.priorRegistrationFingerprint, priorResolverBinarySha256: lane.priorResolverBinarySha256};
  const buildRoot = join(userRoot, "builds", "promotion"); mkdirSync(buildRoot, {recursive: true, mode: 0o700});
  const journalPath = join(buildRoot, "journal.json"), operationId = "11111111-1111-4111-8111-111111111111";
  const binding = {lane, operationId};
  const journal = {version: 3, id: "promotion", buildRoot, userRoot, target: candidate, phase: "prepared", acceptedBackendTransition: binding,
    entries: [{name: "app", source: candidate, desired: {sha256: "4".repeat(64)}}, {name: "runtime", source: runtime, desired: {sha256: "5".repeat(64)}}]};
  const journalBytes = JSON.stringify(journal); writeFileSync(journalPath, journalBytes, {mode: 0o600});
  const actions: string[] = [], preparations: Parameters<SharedNativeBackendTransitionPort["prepareSharedNativeResolverTransitionAtRootV1"]>[0][] = [];
  const plan = {document: {resolverProtocol: "official-bundled-v1", resolverBinarySha256: lane.authority.backend.sha256}};
  const port: SharedNativeBackendTransitionPort = {
    readSharedNativeModeAtRootV1: () => ({state: "ready", fingerprint: lane.priorRegistrationFingerprint, document: {resolverBinarySha256: lane.priorResolverBinarySha256}}),
    prepareSharedNativeResolverTransitionAtRootV1: input => {preparations.push(input); return {state: "prepared", plan, fingerprint: `sha256:${"6".repeat(64)}`};},
    executeSharedNativeResolverTransitionAtRootV1: input => {actions.push(input.action); return {state: {validate: "validated", begin: "begun", publish: "published", finish: "finished"}[input.action],
      priorFingerprint: lane.priorRegistrationFingerprint, priorResolverBinarySha256: lane.priorResolverBinarySha256, resolverBinarySha256: lane.authority.backend.sha256,
      binding: {operationId, promotionId: "promotion", journalSha256: sha(journalBytes), priorRepairFingerprint: null, appFingerprintSha256: "4".repeat(64), runtimeFingerprintSha256: "5".repeat(64)}};},
  };
  const transition = (beforePhase?: () => void) => new AcceptedBackendTransitionJournal({journalPath, buildRoot, promotionId: "promotion", binding, port, nativeSignatures: signatures, beforePhase});
  return {root, source, candidate, runtime, lane, request, transition, actions, preparations, port, relativePath};
}
function using(action: (f: ReturnType<typeof fixture>) => void) {const f = fixture(); try {action(f);} finally {rmSync(f.root, {recursive: true, force: true});}}

test("official authority verifies supplied native bytes and generated runtime without a custom build receipt", () => using(f => {
  assert.equal("acceptedBuildReceipt" in f.lane.authority, false);
  assertAcceptedSharedNativeBackendTransitionShape(f.lane);
  assertAcceptedSharedNativeBackendTransitionRequestBinding(f.request, f.lane);
  assertAcceptedSharedNativeBackendTransitionClosure(f.lane, f.candidate, f.runtime, signatures);
}));

test("an unready local adapter cannot admit a sealed candidate or begin the resolver transition", () => {
  const f = fixture(false);
  try {
    assert.throws(() => assertAcceptedSharedNativeBackendTransitionClosure(f.lane, f.candidate, f.runtime, signatures), /Local official backend adapter is not ready/);
    assert.throws(() => f.transition().prepare(), /Local official backend adapter is not ready/);
    assert.deepEqual(f.preparations, []);
    assert.deepEqual(f.actions, []);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("official candidate authority rejects substituted hashes, metadata, protocol, source and fabricated receipts", () => using(f => {
  const changes: Array<(lane: typeof f.lane) => void> = [
    lane => lane.authority.backend.sha256 = "a".repeat(64), lane => lane.authority.closure.codeModeHost.certificateSha1 = "B".repeat(40),
    lane => lane.authority.closure.resourceTree.sha256 = "b".repeat(64), lane => lane.authority.nativePackage.version = "0.1.0",
    lane => lane.authority.runtime.fingerprint = "c".repeat(64), lane => lane.authority.sourceApp.treeSeal.sha256 = "d".repeat(64),
    lane => (lane as unknown as Record<string, unknown>).resolverProtocol = "shared-native-overlay-v1",
    lane => (lane.authority as unknown as Record<string, unknown>).acceptedBuildReceipt = {},
  ];
  for (const change of changes) {const altered = structuredClone(f.lane); change(altered); assert.throws(() => assertAcceptedSharedNativeBackendTransitionShape(altered), /contract is invalid/);}
  assert.throws(() => assertAcceptedSharedNativeBackendTransitionRequestBinding({...f.request, officialBundled: {...f.request.officialBundled, expectedVersion: "0.1.0"}}, f.lane), /request differs/);
}));

test("official journal sends explicit protocol and retains the exact prior registration guard", () => using(f => {
  f.transition().prepare(); assert.equal(f.preparations.length, 1); assert.equal(f.preparations[0].resolverProtocol, "official-bundled-v1");
  assert.equal(f.preparations[0].expectedRegistrationFingerprint, f.lane.priorRegistrationFingerprint);
  f.port.readSharedNativeModeAtRootV1 = () => ({state: "ready", fingerprint: `sha256:${"0".repeat(64)}`, document: {resolverBinarySha256: f.lane.priorResolverBinarySha256}});
  assert.throws(() => assertAcceptedSharedNativeBackendTransitionPrior(f.lane, f.port), /Signed prior/);
  assert.throws(() => f.transition().assertRollbackAllowed(), ForwardBackendTransitionRecoveryRequired);
}));

test("official journal refuses a runtime port that ignores the explicit protocol", () => using(f => {
  f.port.prepareSharedNativeResolverTransitionAtRootV1 = () => ({state: "prepared", plan: {document: {resolverProtocol: "shared-native-overlay-v1", resolverBinarySha256: f.lane.authority.backend.sha256}}, fingerprint: `sha256:${"6".repeat(64)}`});
  assert.throws(() => f.transition().prepare(), /explicit resolver protocol/); assert.deepEqual(f.actions, []);
}));

for (const drift of ["backend", "helper", "resource", "metadata", "runtime"] as const) {
  test(`official ${drift} drift is rejected before resolver begin`, () => using(f => {
    f.transition().prepare(); f.actions.length = 0;
    const path = {backend: join(f.candidate, NATIVE_CODEX_BACKEND), helper: join(f.candidate, NATIVE_CODE_MODE_HOST), resource: join(f.candidate, NATIVE_CODEX_CLI_ROOT, "context.json"),
      metadata: join(f.candidate, f.relativePath), runtime: join(f.runtime, "account-router", "official-bundled-adapter.js")}[drift];
    writeFileSync(path, "changed");
    assert.throws(() => f.transition().execute("begin")); assert.deepEqual(f.actions, []);
  }));
}

test("official closure is revalidated after the phase guard before resolver publication", () => using(f => {
  f.transition().prepare(); f.actions.length = 0;
  assert.throws(() => f.transition(() => writeFileSync(join(f.candidate, NATIVE_CODEX_CLI_ROOT, "context.json"), "drift")).finishPromoted(f.candidate, f.runtime), /resource closure changed/);
  assert.deepEqual(f.actions, []);
}));

test("official closure is revalidated after publication before admission finish", () => using(f => {
  f.transition().prepare(); f.actions.length = 0;
  const execute = f.port.executeSharedNativeResolverTransitionAtRootV1;
  f.port.executeSharedNativeResolverTransitionAtRootV1 = input => {const result = execute(input); if (input.action === "publish") writeFileSync(join(f.candidate, NATIVE_CODEX_CLI_ROOT, "context.json"), "drift"); return result;};
  assert.throws(() => f.transition().finishPromoted(f.candidate, f.runtime), /resource closure changed/);
  assert.deepEqual(f.actions, ["publish"]);
}));

test("official protocol-only transition can bind unchanged backend bytes without changing the legacy contract", () => using(f => {
  const lane = {...f.lane, priorResolverBinarySha256: f.lane.authority.backend.sha256}; assertAcceptedSharedNativeBackendTransitionShape(lane);
}));

test("absent signed registration needs no transition; blocked or pending registration fails closed", () => using(f => {
  const input = {sourceAppRoot: join(f.root, "not-inspected.app"), brokerRoot: f.lane.identity.brokerRoot,
    runtimeRoot: f.runtime, transactionId: "no-transition", port: f.port};
  f.port.readSharedNativeModeAtRootV1 = () => ({state: "absent"});
  assert.equal(prepareOfficialBundledBackendTransitionRequest(input), undefined);
  for (const state of ["blocked", "pending", "missing", "ready"]) {
    f.port.readSharedNativeModeAtRootV1 = () => ({state});
    assert.throws(() => prepareOfficialBundledBackendTransitionRequest(input), /Signed prior backend registration unavailable/);
  }
}));
