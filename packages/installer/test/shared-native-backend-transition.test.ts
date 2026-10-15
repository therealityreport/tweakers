import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { combinedPayloadIdentity, type PrebuiltCombinedCandidateAuthority } from "../src/prebuilt-combined-candidate.ts";
import { AcceptedBackendTransitionJournal, ForwardBackendTransitionRecoveryRequired,
  assertAcceptedSharedNativeBackendTransitionShape, assertAcceptedSharedNativeBackendTransitionPrior,
  assertAcceptedSharedNativeBackendTransitionRequestBinding, assertAcceptedSharedNativeBackendTransitionClosure,
  type AcceptedSharedNativeBackendTransitionLaneV1, type SharedNativeBackendTransitionPort } from "../src/shared-native-backend-transition.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "accepted-backend-transition-")));
  const userRoot = join(root, "variant"), brokerRoot = join(root, "broker"), buildRoot = join(userRoot, "builds", "promotion");
  mkdirSync(buildRoot, {recursive: true, mode: 0o700}); mkdirSync(brokerRoot, {mode: 0o700});
  const signature = {identity: "fixture", teamIdentifier: null, designatedRequirement: null};
  const bare: Omit<PrebuiltCombinedCandidateAuthority, "payloadIdentity"> = {
    schemaVersion: 1, transactionId: "source-accepted", installerPayloadHash: "a".repeat(64),
    acceptedBuildReceipt: {path: join(root, "accepted.json"), sha256: "b".repeat(64), acceptedAt: "2026-10-11T00:00:00Z",
      sourceCommit: "c".repeat(40), sourceTree: "d".repeat(40), cargoLockSha256: "e".repeat(64), reviewedDiffSha256: "f".repeat(64),
      upstream: {repository: "https://github.com/openai/codex.git", tag: "rust-v0.162.0-alpha.17.2", commit: "c".repeat(40)},
      patchSeriesSha256: "1".repeat(64), verification: {level: "source-verified", installedAcceptance: "required"},
      buildCommand: "cargo build --locked", toolchain: "fixture", testEvidence: [{name: "source check", command: "fixture-check", receiptSha256: "9".repeat(64)}]},
    backend: {sourcePath: join(root, "codex"), sha256: "2".repeat(64), version: "0.162.0-alpha.17.2", architecture: "arm64", signature},
    closure: {codeModeHost: {path: join(root, "host"), sha256: "3".repeat(64), architecture: "arm64", signature}, resources: []},
    runtime: {sourceRoot: join(root, "runtime"), fingerprint: "4".repeat(64), fileCount: 1, documentSha256: "5".repeat(64)},
    sourceApp: {path: join(root, "Codex.app"), bundleId: "com.openai.codex", contentsFingerprint: "6".repeat(64)},
  };
  const lane: AcceptedSharedNativeBackendTransitionLaneV1 = {version: 1, identity: {target: join(root, "Tweakers.app"), userRoot, brokerRoot},
    authority: {...bare, payloadIdentity: combinedPayloadIdentity(bare)}, priorRegistrationFingerprint: `sha256:${"7".repeat(64)}`, priorResolverBinarySha256: "8".repeat(64)};
  const operationId = "11111111-1111-4111-8111-111111111111";
  const journalPath = join(buildRoot, "journal.json");
  const binding = {lane, operationId};
  const journal = {version: 3, id: "promotion", buildRoot, userRoot, target: lane.identity.target, phase: "prepared", acceptedBackendTransition: binding,
    entries: [{name: "app", source: "fixture-app", desired: {sha256: "9".repeat(64)}}, {name: "runtime", source: "fixture-runtime", desired: {sha256: "a".repeat(64)}}]};
  const bytes = JSON.stringify(journal);
  writeFileSync(journalPath, bytes, {mode: 0o600});
  const directory = join(buildRoot, "accepted-backend-transition"); mkdirSync(directory, {mode: 0o700});
  const preparedJournalSha256 = sha(bytes), planFingerprint = `sha256:${"b".repeat(64)}`;
  const plan = {signedFixture: "immutable"};
  writeFileSync(join(directory, "intent.json"), JSON.stringify({version: 1, journalPath, preparedJournalBytes: bytes, preparedJournalSha256, plan, planFingerprint}), {mode: 0o600});
  const actions: string[] = [];
  const port: SharedNativeBackendTransitionPort = {
    readSharedNativeModeAtRootV1: () => ({state: "ready", fingerprint: lane.priorRegistrationFingerprint, document: {resolverBinarySha256: lane.priorResolverBinarySha256}}),
    prepareSharedNativeResolverTransitionAtRootV1: () => {throw new Error("unexpected preparation");},
    executeSharedNativeResolverTransitionAtRootV1(input) {
      actions.push(input.action);
      if (JSON.stringify(input.plan) !== JSON.stringify(plan) || input.expectedPlanFingerprint !== planFingerprint || input.stateRoot !== brokerRoot) return {state: "blocked", reason: "signed plan changed"};
      return {state: {validate: "validated", begin: "begun", publish: "published", finish: "finished"}[input.action],
        priorFingerprint: lane.priorRegistrationFingerprint, priorResolverBinarySha256: lane.priorResolverBinarySha256,
        resolverBinarySha256: lane.authority.backend.sha256,
        binding: {operationId, promotionId: "promotion", journalSha256: preparedJournalSha256, priorRepairFingerprint: null,
          appFingerprintSha256: "9".repeat(64), runtimeFingerprintSha256: "a".repeat(64)}};
    },
  };
  const transition = () => new AcceptedBackendTransitionJournal({journalPath, buildRoot, promotionId: "promotion", binding, port});
  return {root, lane, journal, journalPath, directory, port, actions, transition};
}
function using(action: (f: ReturnType<typeof fixture>) => void) { const f = fixture(); try {action(f);} finally {rmSync(f.root, {recursive: true, force: true});} }

test("sealed backend transition rejects each changed closure or source authority", () => using(f => {
  assertAcceptedSharedNativeBackendTransitionShape(f.lane);
  for (const mutate of [
    (lane: typeof f.lane) => lane.authority.backend.sha256 = "f".repeat(64),
    (lane: typeof f.lane) => lane.authority.closure.codeModeHost.sha256 = "f".repeat(64),
    (lane: typeof f.lane) => lane.authority.runtime.fingerprint = "f".repeat(64),
    (lane: typeof f.lane) => lane.authority.acceptedBuildReceipt.upstream.commit = "f".repeat(40),
    (lane: typeof f.lane) => lane.authority.acceptedBuildReceipt.patchSeriesSha256 = "f".repeat(64),
    (lane: typeof f.lane) => lane.authority.acceptedBuildReceipt.sha256 = "f".repeat(64),
  ]) {const lane = structuredClone(f.lane); mutate(lane); assert.throws(() => assertAcceptedSharedNativeBackendTransitionShape(lane), /contract is invalid/);}
  assert.throws(() => assertAcceptedSharedNativeBackendTransitionShape({...f.lane, approved: true}), /contract is invalid/);
}));
test("signed prior registration is required before app-only rollback", () => using(f => {
  f.transition().assertRollbackAllowed();
  f.port.readSharedNativeModeAtRootV1 = () => ({state: "ready", fingerprint: `sha256:${"0".repeat(64)}`, document: {resolverBinarySha256: f.lane.priorResolverBinarySha256}});
  assert.throws(() => assertAcceptedSharedNativeBackendTransitionPrior(f.lane, f.port), /Signed prior/);
  assert.throws(() => f.transition().assertRollbackAllowed(), ForwardBackendTransitionRecoveryRequired);
}));
test("successful begin makes rollback forward-only even before publication", () => using(f => {
  f.transition().execute("begin");
  assert.deepEqual(f.actions, ["begin"]);
  assert.throws(() => f.transition().assertRollbackAllowed(), ForwardBackendTransitionRecoveryRequired);
}));
test("crash after resolver begin but before marker still blocks app-only rollback", () => using(f => {
  writeFileSync(join(f.lane.identity.brokerRoot, "shared-native-mode-transition.v1.json"), "intent", {mode: 0o600});
  assert.throws(() => f.transition().assertRollbackAllowed(), ForwardBackendTransitionRecoveryRequired);
  assert.deepEqual(f.actions, []);
}));
for (const field of ["target", "userRoot", "id", "buildRoot", "acceptedBackendTransition", "entries"]) {
  test(`immutable prepared journal rejects ${field} mutation before CAS`, () => using(f => {
    const current = JSON.parse(readFileSync(f.journalPath, "utf8")); current[field] = "changed";
    writeFileSync(f.journalPath, JSON.stringify(current));
    assert.throws(() => f.transition().execute("validate"), /journal closure/);
    assert.deepEqual(f.actions, []);
  }));
}
test("phase replay retains the immutable prepared identity", () => using(f => {
  writeFileSync(f.journalPath, JSON.stringify({...f.journal, phase: "app:promoted"}));
  f.transition().execute("validate"); assert.deepEqual(f.actions, ["validate"]);
}));
test("linked or public intent cannot authorize CAS", () => using(f => {
  chmodSync(join(f.directory, "intent.json"), 0o644);
  assert.throws(() => f.transition().execute("validate"), /owner-private/); assert.deepEqual(f.actions, []);
  chmodSync(join(f.directory, "intent.json"), 0o600);
  const copy = join(f.directory, "copy.json"); writeFileSync(copy, readFileSync(join(f.directory, "intent.json")), {mode: 0o600});
  rmSync(join(f.directory, "intent.json")); symlinkSync(copy, join(f.directory, "intent.json"));
  assert.throws(() => f.transition().execute("validate"), /linked/); assert.deepEqual(f.actions, []);
}));
test("missing accepted receipt rejects promotion closure before CAS", () => using(f => {
  assert.throws(() => assertAcceptedSharedNativeBackendTransitionClosure(f.lane, f.lane.identity.target, f.lane.authority.runtime.sourceRoot), /missing or linked/);
  assert.deepEqual(f.actions, []);
}));
test("candidate request cannot substitute a different accepted binary", () => using(f => {
  assert.throws(() => assertAcceptedSharedNativeBackendTransitionRequestBinding({version: 1, prebuilt: {} as never,
    priorRegistrationFingerprint: f.lane.priorRegistrationFingerprint, priorResolverBinarySha256: f.lane.priorResolverBinarySha256}, f.lane), /request differs/);
}));

test("caller cannot publish or finish without promoted closure verification", () => using(f => {
  assert.throws(() => f.transition().execute("finish" as never), /closure verification/);
  assert.deepEqual(f.actions, []);
}));
test("changed signed response binding never becomes begun evidence", () => using(f => {
  const execute = f.port.executeSharedNativeResolverTransitionAtRootV1;
  f.port.executeSharedNativeResolverTransitionAtRootV1 = input => ({...execute(input), binding: {operationId: "different"}});
  assert.throws(() => f.transition().execute("begin"), /binding changed/);
  assert.equal(readFileSync(join(f.directory, "intent.json"), "utf8").includes("preparedJournalBytes"), true);
  // A mismatched sink response does not invent successful local begin evidence.
  f.transition().assertRollbackAllowed();
}));
test("cross-operation intent replay is rejected before CAS", () => using(f => {
  const intent = JSON.parse(readFileSync(join(f.directory, "intent.json"), "utf8"));
  const prepared = JSON.parse(intent.preparedJournalBytes);
  prepared.acceptedBackendTransition.operationId = "22222222-2222-4222-8222-222222222222";
  intent.preparedJournalBytes = JSON.stringify(prepared); intent.preparedJournalSha256 = sha(intent.preparedJournalBytes);
  writeFileSync(join(f.directory, "intent.json"), JSON.stringify(intent));
  assert.throws(() => f.transition().execute("validate"), /journal closure/);
  assert.deepEqual(f.actions, []);
}));
