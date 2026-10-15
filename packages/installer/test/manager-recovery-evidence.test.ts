import { ManagerOperationStore } from "../src/manager-operation-store.js";
import { independentRefreshHasProvenRetryableFailure } from "../src/manager-status.js";
import { TWEAKERS_MANAGER_ID, type TweakersManagerPreparedOperationV1 } from "../src/manager-contract.js";
import { TWEAKERS_VARIANT_BUNDLE_ID } from "../src/macos-variant.js";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createManagerRecoveryBinding, managerRuntimeAcceptancePath, managerRuntimeAcceptanceAttemptPath, persistManagerRuntimeAcceptance, persistRequiredManagerRuntimeAcceptance, readManagerRetainedPromotionEvidence, readManagerAcceptedBackendRecoveryEvidence, settleManagerAcceptedBackendRecovery, settleVerifiedManagerRecoveryOperations, managerOperationRecoveryIsVerified, managerRecoveryBindingPath, managerRecoveryJournalIdentitySha256, parseManagerRecoveryBinding, persistManagerRecoveryBinding, readManagerRecoveryBinding } from "../src/manager-recovery-evidence.js";
import type { IndependentTweakersRuntimeReadyExpectation } from "../src/runtime-ready-receipt.js";
import type { VariantGenerationFingerprint } from "../src/variant-generation.js";
import { combinedPayloadIdentity, type PrebuiltCombinedCandidateAuthority } from "../src/prebuilt-combined-candidate.js";
import type { AcceptedBackendTransitionJournalBindingV1 } from "../src/shared-native-backend-transition.js";

const operationId = "11111111-1111-4111-8111-111111111111";
const promotionId = "22222222-2222-4222-8222-222222222222";
const runtimeFingerprint = "d".repeat(64);
const wanted = { kind: "directory" as const, mode: 0o700, sha256: "a".repeat(64) };
const prior = { kind: "directory" as const, mode: 0o700, sha256: "b".repeat(64) };

function fixture(root = "/virtual/recovery") {
  const userRoot = join(root, "variants", "tweakers"), build = join(userRoot, "builds", promotionId), previous = join(userRoot, "previous", promotionId);
  const candidate = `/Applications/.Tweakers.app.candidate-${promotionId}.app`;
  const entries = ["runtime", "tweaks", "state.json", "config.json", "app"].map(name => ({
    name, source: name === "app" ? candidate : join(build, name), destination: name === "app" ? "/Applications/Tweakers.app" : join(userRoot, name),
    archive: name === "app" ? join(previous, "app", "Tweakers.app") : join(previous, "state", name),
    failed: name === "app" ? join(build, "failed-promotion", "app", "Tweakers.app") : join(build, "failed-promotion", "state", name),
    hadDestination: true, desired: { ...wanted }, previous: { ...prior },
  }));
  const journal = { version: 3, id: promotionId, userRoot, target: "/Applications/Tweakers.app", candidate, buildRoot: build, phase: "prepared", entries,
    activeReceipt: { source: join(build, "active-receipt.json"), destination: join(userRoot, "transactions", "variant-promotion", "active.json"),
      archive: join(previous, "active-receipt.json"), failed: join(build, "failed-promotion", "active-receipt.json"), hadDestination: true,
      desired: { kind: "file" as const, mode: 0o600, sha256: "c".repeat(64) }, previous: { kind: "file" as const, mode: 0o600, sha256: "e".repeat(64) },
      expected: { version: 3, id: promotionId, userRoot, target: "/Applications/Tweakers.app", entries: entries.filter(entry => entry.name !== "config.json").map(entry => ({ name: entry.name, path: entry.destination, fingerprint: entry.desired })) } } };
  const binding = createManagerRecoveryBinding({ managerRoot: root, operationId, journal, runtimeFingerprint,
    receiptRefs: ["independent-tweakers-patch:1.0.0"], dependencyPaths: [], createdAt: "2026-10-11T00:00:00.000Z" });
  const files = new Map<string, string>([[managerRecoveryBindingPath(root, operationId), JSON.stringify(binding)]]);
  const readText = (path: string) => files.has(path) ? { state: "present" as const, text: files.get(path)! } : { state: "missing" as const };
  const writeJournal = () => files.set(binding.journal.path, JSON.stringify(journal));
  const fingerprints = new Map<string, VariantGenerationFingerprint>();
  const fingerprint = (path: string) => { const value = fingerprints.get(path); if (!value) throw new Error("Missing fixture artifact"); return value; };
  return { root, journal, binding, files, readText, writeJournal, fingerprints, fingerprint, dependencies: { readText, fingerprint, absent: (path: string) => !fingerprints.has(path) } };
}

function acceptedBackendBinding(root: string): AcceptedBackendTransitionJournalBindingV1 {
  const signature = { identity: "fixture-signing", teamIdentifier: null, designatedRequirement: null };
  const body: Omit<PrebuiltCombinedCandidateAuthority, "payloadIdentity"> = {
    schemaVersion: 1, transactionId: "backend-repair", installerPayloadHash: "1".repeat(64),
    acceptedBuildReceipt: { path: join(root, "accepted-build.json"), sha256: "2".repeat(64), acceptedAt: "2026-10-11T00:00:00.000Z",
      verification: { level: "source-verified", installedAcceptance: "required" }, sourceCommit: "3".repeat(40), sourceTree: "4".repeat(40),
      cargoLockSha256: "5".repeat(64), reviewedDiffSha256: "6".repeat(64),
      upstream: { repository: "https://github.com/openai/codex.git", tag: "rust-v0.162.0-alpha.17.2", commit: "3".repeat(40) },
      patchSeriesSha256: "7".repeat(64), buildCommand: "cargo build --locked --release", toolchain: "fixture", testEvidence: [{name: "fixture", command: "fixture test", receiptSha256: "7".repeat(64)}] },
    backend: { sourcePath: join(root, "codex"), sha256: "8".repeat(64), version: "0.162.0-alpha.17.2", architecture: "arm64", signature },
    closure: { codeModeHost: { path: join(root, "codex-code-mode-host"), sha256: "9".repeat(64), architecture: "arm64", signature }, resources: [] },
    runtime: { sourceRoot: join(root, "runtime"), fingerprint: runtimeFingerprint, fileCount: 1, documentSha256: "a".repeat(64) },
    sourceApp: { path: "/Applications/ChatGPT.app", bundleId: "com.openai.codex", contentsFingerprint: "b".repeat(64) },
  };
  return { operationId, lane: { version: 1, identity: { target: "/Applications/Tweakers.app", userRoot: join(root, "variants", "tweakers"),
    brokerRoot: join(root, "tweak-data", "co.tweakers.account-switcher") }, authority: { ...body, payloadIdentity: combinedPayloadIdentity(body) },
    priorRegistrationFingerprint: `sha256:${"c".repeat(64)}`, priorResolverBinarySha256: "e".repeat(64) } };
}

function acceptanceProof(f: ReturnType<typeof fixture>, pid = 1234) {
  const ready = { operationId, promotionId, schemaVersion: 5, kind: "tweakers-independent-runtime-ready", appRoot: f.binding.target,
    activePromotionReceiptSha256: f.binding.generation.activeReceiptSha256, runtimeFingerprint, mainInitialized: true, preloadInitialized: true, settingsMounted: true,
    pid, processStartToken: `process-birth-${pid}`, bundleId: TWEAKERS_VARIANT_BUNDLE_ID, appAsarHeaderHash: "f".repeat(64),
    appUserDataRoot: "/virtual/profile", codexHomeRoot: "/virtual/codex", accountsBrokerRoot: "/virtual/broker",
    brokerAuthorityExpectation: { globalRootState: "valid-v3", configSha256: "e".repeat(64) },
    appearance: { status: "normal", normalized: true }, sharedHistoryBrokerState: "connected", initializedTweakIds: [] as string[], observedAt: "2026-10-11T00:01:00.000Z" };
  const { pid: _pid, processStartToken: _token, mainInitialized, preloadInitialized, settingsMounted, appearance, sharedHistoryBrokerState, initializedTweakIds, observedAt, ...identity } = ready;
  const expectation = { ...identity, kind: "tweakers-independent-runtime-ready-expectation", appearanceExpectation: appearance,
    expectedTweakIds: initializedTweakIds, createdAt: "2026-10-11T00:00:00.000Z" } as IndependentTweakersRuntimeReadyExpectation;
  return { ready, expectation };
}

test("required retained acceptance refuses a missing binding and verifies the exact durable process proof", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-required-acceptance-")));
  try {
    const f = fixture(root), proof = acceptanceProof(f);
    const persist = () => persistRequiredManagerRuntimeAcceptance(root, proof.expectation, proof.ready, proof.ready.pid, proof.ready.processStartToken);
    assert.throws(persist, /requires its immutable recovery binding/);
    assert.equal(managerOperationRecoveryIsVerified(root, operationId), false);
    persistManagerRecoveryBinding(root, f.binding);
    persist();
    const bytes = readFileSync(managerRuntimeAcceptancePath(root, operationId));
    assert.equal(JSON.parse(bytes.toString()).pid, proof.ready.pid);
    persist(); assert.deepEqual(readFileSync(managerRuntimeAcceptancePath(root, operationId)), bytes);
    assert.throws(() => persistRequiredManagerRuntimeAcceptance(root, {...proof.expectation, promotionId: operationId},
      {...proof.ready, promotionId: operationId}, proof.ready.pid, proof.ready.processStartToken), /operation binding/);
    assert.deepEqual(readFileSync(managerRuntimeAcceptancePath(root, operationId)), bytes);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test("recovered launch appends exact private acceptance while retaining the first process proof", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-acceptance-attempt-")));
  try {
    const f = fixture(root), first = acceptanceProof(f), next = acceptanceProof(f, 5678);
    persistManagerRecoveryBinding(root, f.binding);
    persistManagerRuntimeAcceptance(root, first.expectation, first.ready, first.ready.pid, first.ready.processStartToken);
    const originalPath = managerRuntimeAcceptancePath(root, operationId), originalBytes = readFileSync(originalPath);
    persistManagerRuntimeAcceptance(root, next.expectation, next.ready, next.ready.pid, next.ready.processStartToken);
    const attemptPath = managerRuntimeAcceptanceAttemptPath(root, operationId, next.ready);
    assert.deepEqual(readFileSync(originalPath), originalBytes);
    assert.equal(lstatSync(attemptPath).mode & 0o777, 0o600);
    persistManagerRuntimeAcceptance(root, next.expectation, next.ready, next.ready.pid, next.ready.processStartToken);
    assert.throws(() => persistManagerRuntimeAcceptance(root, { ...next.expectation, createdAt: "2026-10-11T00:00:01.000Z" },
      next.ready, next.ready.pid, next.ready.processStartToken), /immutable/);
    assert.throws(() => persistManagerRuntimeAcceptance(root, { ...next.expectation, promotionId: operationId },
      { ...next.ready, promotionId: operationId }, next.ready.pid, next.ready.processStartToken), /operation binding/);
    f.journal.phase = "committed"; f.writeJournal();
    for (const entry of [...f.journal.entries, f.journal.activeReceipt]) f.fingerprints.set(entry.destination, entry.desired);
    f.files.set(join(f.binding.userRoot, "runtime", "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, fingerprint: runtimeFingerprint }));
    f.files.set(join(f.binding.userRoot, "runtime-ready.json"), JSON.stringify(next.ready));
    f.files.set(originalPath, originalBytes.toString());
    f.files.set(attemptPath, readFileSync(attemptPath, "utf8"));
    assert.equal(managerOperationRecoveryIsVerified(root, operationId, f.dependencies), true);
    f.files.set(attemptPath, JSON.stringify({ ...JSON.parse(readFileSync(attemptPath, "utf8")), pid: 1 }));
    assert.equal(managerOperationRecoveryIsVerified(root, operationId, f.dependencies), false);
    f.files.delete(attemptPath);
    f.files.set(join(f.binding.userRoot, "runtime-ready.json"), JSON.stringify(first.ready));
    assert.equal(managerOperationRecoveryIsVerified(root, operationId, f.dependencies), true);
    const third = acceptanceProof(f, 9999), linked = managerRuntimeAcceptanceAttemptPath(root, operationId, third.ready);
    symlinkSync(originalPath, linked);
    assert.throws(() => persistManagerRuntimeAcceptance(root, third.expectation, third.ready, third.ready.pid, third.ready.processStartToken), /unreadable/);
    assert.deepEqual(readFileSync(originalPath), originalBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trusted backend recovery reads only its original consumed operation and immutable journal", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-bound-forward-")));
  try {
    const f = fixture(root), journal = { ...f.journal, acceptedBackendTransition: acceptedBackendBinding(root) };
    const binding = createManagerRecoveryBinding({ managerRoot: root, operationId, journal, runtimeFingerprint,
      receiptRefs: f.binding.receiptRefs, dependencyPaths: [], createdAt: "2026-10-11T00:00:00.000Z" });
    persistManagerRecoveryBinding(root, binding);
    mkdirSync(dirname(binding.journal.path), { recursive: true, mode: 0o700 });
    writeFileSync(binding.journal.path, JSON.stringify(journal), { mode: 0o600 });
    const store = new ManagerOperationStore(root);
    const record: TweakersManagerPreparedOperationV1 = {
      schemaVersion: 1, kind: "tweakers-manager-operation", managerId: TWEAKERS_MANAGER_ID, protocolVersion: 1,
      operationId, preparedRequestId: promotionId, actionId: "refresh.independent",
      moduleIdentity: { state: "resolved", path: "/fixed/manager", sha256: "a".repeat(64) },
      boundStateToken: `sha256:${"b".repeat(64)}`, parameters: {}, parametersSha256: `sha256:${"c".repeat(64)}`,
      impact: "restart-app", createdAt: "2026-10-10T23:59:00.000Z", expiresAt: "2026-10-11T01:00:00.000Z",
      phase: "recovery-required", consumedAt: "2026-10-11T00:00:00.000Z", cancelledAt: null, completedAt: null, failedAt: null,
      recoveryRequiredAt: "2026-10-11T00:00:01.000Z", stateTokenInputsSha256: `sha256:${"d".repeat(64)}`,
      receiptChronologyRevision: `sha256:${"e".repeat(64)}`, receiptSnapshot: [], receiptRefs: binding.receiptRefs, outcome: null, error: "Interrupted",
    };
    store.create(record);
    const ordinaryBinding = createManagerRecoveryBinding({managerRoot: root, operationId, journal: f.journal, runtimeFingerprint,
      receiptRefs: f.binding.receiptRefs, dependencyPaths: [], createdAt: "2026-10-11T00:00:00.000Z"});
    writeFileSync(managerRecoveryBindingPath(root, operationId), JSON.stringify(ordinaryBinding));
    writeFileSync(binding.journal.path, JSON.stringify(f.journal));
    assert.equal(readManagerRetainedPromotionEvidence(root, operationId).acceptedBackendTransition, false);
    assert.throws(() => readManagerAcceptedBackendRecoveryEvidence(root, operationId), /journal authority changed/);
    writeFileSync(managerRecoveryBindingPath(root, operationId), JSON.stringify(binding));
    writeFileSync(binding.journal.path, JSON.stringify(journal));
    const evidence = readManagerAcceptedBackendRecoveryEvidence(root, operationId);
    assert.deepEqual(evidence.binding, binding); assert.equal(evidence.committed, false);
    const committed = { ...journal, phase: "committed" }, proof = acceptanceProof(f);
    writeFileSync(binding.journal.path, JSON.stringify(committed));
    store.replace({ ...record, phase: "completed", recoveryRequiredAt: null, completedAt: "2026-10-11T00:02:00.000Z", error: null,
      outcome: "verified-installation-accepted" });
    f.files.set(managerRecoveryBindingPath(root, operationId), JSON.stringify(binding));
    f.files.set(binding.journal.path, JSON.stringify(committed));
    for (const entry of [...journal.entries, journal.activeReceipt]) f.fingerprints.set(entry.destination, entry.desired);
    f.files.set(join(binding.userRoot, "runtime", "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, fingerprint: runtimeFingerprint }));
    f.files.set(join(binding.userRoot, "runtime-ready.json"), JSON.stringify(proof.ready));
    f.files.set(managerRuntimeAcceptancePath(root, operationId), JSON.stringify({ schemaVersion: 1, kind: "tweakers-manager-runtime-acceptance",
      expectation: proof.expectation, receipt: proof.ready, pid: proof.ready.pid, processStartToken: proof.ready.processStartToken }));
    assert.equal(settleManagerAcceptedBackendRecovery(root, operationId, f.dependencies), true);
    f.files.set(join(binding.userRoot, "runtime-ready.json"), JSON.stringify({ ...proof.ready, operationId: promotionId }));
    assert.equal(settleManagerAcceptedBackendRecovery(root, operationId, f.dependencies), false);
    f.files.set(join(binding.userRoot, "runtime-ready.json"), JSON.stringify(proof.ready));
    f.fingerprints.set(binding.target, prior);
    assert.equal(settleManagerAcceptedBackendRecovery(root, operationId, f.dependencies), false);
    writeFileSync(binding.journal.path, JSON.stringify(journal));
    store.replace(record);
    store.replace({ ...record, receiptRefs: ["independent-tweakers-patch:foreign"] });
    assert.throws(() => readManagerAcceptedBackendRecoveryEvidence(root, operationId), /operation binding/);
    store.replace(record);
    writeFileSync(binding.journal.path, JSON.stringify({ ...journal, phase: "app:promoted" }));
    assert.notEqual(readManagerAcceptedBackendRecoveryEvidence(root, operationId).journalSha256, evidence.journalSha256);
    writeFileSync(binding.journal.path, JSON.stringify({ ...journal, entries: journal.entries.slice(1) }));
    assert.throws(() => readManagerAcceptedBackendRecoveryEvidence(root, operationId), /identity/);
    store.replace({ ...record, phase: "prepared", consumedAt: null, recoveryRequiredAt: null });
    assert.throws(() => readManagerAcceptedBackendRecoveryEvidence(root, operationId), /original consumed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepted backend journal binds exact operation, roots and authority without allowing rollback settlement", () => {
  const f = fixture();
  const accepted = acceptedBackendBinding(f.root);
  const journal = { ...f.journal, acceptedBackendTransition: accepted };
  const create = (value: unknown) => createManagerRecoveryBinding({ managerRoot: f.root, operationId, journal: value, runtimeFingerprint,
    receiptRefs: ["independent-tweakers-patch:1.0.0"], dependencyPaths: [] });
  const binding = create(journal);
  assert.notEqual(binding.journal.identitySha256, f.binding.journal.identitySha256);
  for (const change of [
    { ...journal, unrelated: true },
    { ...journal, acceptedBackendTransition: { ...accepted, unrelated: true } },
    { ...journal, acceptedBackendTransition: { ...accepted, operationId: promotionId } },
    ...["target", "userRoot", "brokerRoot"].map(key => ({ ...journal, acceptedBackendTransition: { ...accepted,
      lane: { ...accepted.lane, identity: { ...accepted.lane.identity, [key]: "/elsewhere" } } } })),
    { ...journal, acceptedBackendTransition: { ...accepted, lane: { ...accepted.lane, authority: { ...accepted.lane.authority, payloadIdentity: "f".repeat(64) } } } },
    { ...journal, phase: "recovered" },
  ]) assert.throws(() => create(change));
  f.files.set(managerRecoveryBindingPath(f.root, operationId), JSON.stringify(binding));
  f.files.set(binding.journal.path, JSON.stringify({ ...journal, phase: "recovered" }));
  for (const entry of [...journal.entries, journal.activeReceipt]) f.fingerprints.set(entry.destination, entry.previous);
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, f.dependencies), false);
});

test("binding publication is immutable and durable without changing strict v1 records", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-recovery-binding-")));
  try {
    const f = fixture(root);
    persistManagerRecoveryBinding(root, f.binding);
    assert.deepEqual(readManagerRecoveryBinding(root, operationId), f.binding);
    persistManagerRecoveryBinding(root, f.binding);
    assert.throws(() => persistManagerRecoveryBinding(root, { ...f.binding, promotionId: operationId }), /invalid|immutable/);
    const path = managerRecoveryBindingPath(root, operationId);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).schemaVersion, 1);
    assert.equal(dirname(path).endsWith("manager-recovery-bindings"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy readable transaction parent supports private evidence but writable parents are refused", () => {
  for (const mode of [0o755, 0o775, 0o777]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-recovery-parent-")));
    try {
      const parent = join(root, "transactions"); mkdirSync(parent); chmodSync(parent, mode);
      const f = fixture(root);
      if (mode !== 0o755) {
        assert.throws(() => persistManagerRecoveryBinding(root, f.binding), /unsafe/);
      } else {
        persistManagerRecoveryBinding(root, f.binding);
        assert.deepEqual(readManagerRecoveryBinding(root, operationId), f.binding);
        assert.equal(lstatSync(parent).mode & 0o777, mode);
        assert.equal(lstatSync(dirname(managerRecoveryBindingPath(root, operationId))).mode & 0o777, 0o700);
        assert.equal(lstatSync(managerRecoveryBindingPath(root, operationId)).mode & 0o777, 0o600);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("exact recovered journal requires all restored bytes; unrelated recovery cannot settle", () => {
  const f = fixture();
  f.journal.phase = "recovered"; f.writeJournal();
  for (const entry of [...f.journal.entries, f.journal.activeReceipt]) f.fingerprints.set(entry.destination, entry.previous);
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, f.dependencies), true);
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, { ...f.dependencies, expectedReceiptRefs: ["independent-tweakers-patch:unrelated"] }), false);
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, { ...f.dependencies, consumedAt: "2026-10-11T00:00:01.000Z" }), false);
  f.fingerprints.set("/Applications/Tweakers.app", wanted);
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, f.dependencies), false);
  f.fingerprints.set("/Applications/Tweakers.app", prior);
  f.files.delete(f.binding.journal.path);
  f.files.set(join(f.journal.userRoot, "transactions", "variant-promotion", `${operationId}.json`), JSON.stringify({ ...f.journal, id: operationId }));
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, f.dependencies), false);
  f.writeJournal();
  f.journal.entries[0]!.desired.sha256 = "f".repeat(64); f.writeJournal();
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, f.dependencies), false);
});

test("committed journal requires its own startup receipt and bound generation", () => {
  const f = fixture(); f.journal.phase = "committed"; f.writeJournal();
  for (const entry of [...f.journal.entries, f.journal.activeReceipt]) f.fingerprints.set(entry.destination, entry.desired);
  f.files.set(join(f.binding.userRoot, "runtime", "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, fingerprint: runtimeFingerprint }));
  const readyPath = join(f.binding.userRoot, "runtime-ready.json");
  const ready = { operationId, promotionId, schemaVersion: 5, kind: "tweakers-independent-runtime-ready", appRoot: f.binding.target,
    activePromotionReceiptSha256: f.binding.generation.activeReceiptSha256, runtimeFingerprint, mainInitialized: true, preloadInitialized: true, settingsMounted: true,
    pid: 1234, processStartToken: "process-birth", bundleId: TWEAKERS_VARIANT_BUNDLE_ID, appAsarHeaderHash: "f".repeat(64),
    appUserDataRoot: "/virtual/profile", codexHomeRoot: "/virtual/codex", accountsBrokerRoot: "/virtual/broker",
    brokerAuthorityExpectation: { globalRootState: "valid-v3", configSha256: "e".repeat(64) },
    appearance: { status: "normal", normalized: true }, sharedHistoryBrokerState: "connected", initializedTweakIds: [], observedAt: "2026-10-11T00:01:00.000Z" };
  const { pid, processStartToken, mainInitialized, preloadInitialized, settingsMounted, appearance, sharedHistoryBrokerState, initializedTweakIds, observedAt, ...identity } = ready;
  const expectation = { ...identity, kind: "tweakers-independent-runtime-ready-expectation", appearanceExpectation: appearance, expectedTweakIds: initializedTweakIds, createdAt: "2026-10-11T00:00:00.000Z" };
  const proof = { schemaVersion: 1, kind: "tweakers-manager-runtime-acceptance", expectation, receipt: ready, pid, processStartToken };
  f.files.set(managerRuntimeAcceptancePath(f.root, operationId), JSON.stringify(proof));
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, f.dependencies), false);
  f.files.set(readyPath, JSON.stringify({ ...ready, operationId: promotionId }));
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, f.dependencies), false);
  f.files.set(readyPath, JSON.stringify(ready));
  assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, f.dependencies), true);
  for (const changed of [{ schemaVersion: 3 }, { pid: 0 }, { processStartToken: "" }, { bundleId: "other" },
    { appearance: { status: "normal", normalized: false } }, { sharedHistoryBrokerState: "blocked" }, { initializedTweakIds: ["unknown"] },
    { appUserDataRoot: "/other" }, { accountsBrokerRoot: "/other" }, { unexpected: true }]) {
    const corrupted = { ...ready, ...changed };
    f.files.set(readyPath, JSON.stringify(corrupted));
    // Matching saved bytes still cannot bypass the full schema and prepared challenge.
    f.files.set(managerRuntimeAcceptancePath(f.root, operationId), JSON.stringify({ ...proof, receipt: corrupted }));
    assert.equal(managerOperationRecoveryIsVerified(f.root, operationId, f.dependencies), false, JSON.stringify(changed));
  }
});

test("binding rejects unsafe paths, duplicate fields and changed journal identity", () => {
  const f = fixture();
  assert.equal(managerRecoveryJournalIdentitySha256(f.journal), managerRecoveryJournalIdentitySha256({ ...f.journal, phase: "recovered" }));
  assert.notEqual(managerRecoveryJournalIdentitySha256(f.journal), managerRecoveryJournalIdentitySha256({ ...f.journal, target: "/Applications/Other.app" }));
  assert.throws(() => parseManagerRecoveryBinding(f.root, { ...f.binding, dependencyPaths: ["/elsewhere/runtime"] }, operationId), /references/);
  assert.throws(() => parseManagerRecoveryBinding(f.root, { ...f.binding, target: "/Applications/Other.app" }, operationId), /identity/);
  f.files.set(managerRecoveryBindingPath(f.root, operationId), JSON.stringify(f.binding).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
  assert.throws(() => readManagerRecoveryBinding(f.root, operationId, f.readText), /repeats key "schemaVersion"/);
});

test("unsafe occupied recovery storage is refused before publication", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-recovery-path-")));
  try {
    const f = fixture(root);
    mkdirSync(join(root, "transactions"), { mode: 0o700 });
    writeFileSync(join(root, "transactions", "manager-recovery-bindings"), "occupied", { mode: 0o600 });
    assert.throws(() => persistManagerRecoveryBinding(root, f.binding), /unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("settled recovered operation stays terminal after a later generation replaces restored bytes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-recovery-settlement-")));
  try {
    const f = fixture(root), store = new ManagerOperationStore(root);
    const record: TweakersManagerPreparedOperationV1 = {
      schemaVersion: 1, kind: "tweakers-manager-operation", managerId: TWEAKERS_MANAGER_ID, protocolVersion: 1,
      operationId, preparedRequestId: promotionId, actionId: "refresh.independent",
      moduleIdentity: { state: "resolved", path: "/fixed/manager", sha256: "a".repeat(64) },
      boundStateToken: `sha256:${"b".repeat(64)}`, parameters: {}, parametersSha256: `sha256:${"c".repeat(64)}`,
      impact: "restart-app", createdAt: "2026-10-10T23:59:00.000Z", expiresAt: "2026-10-11T01:00:00.000Z",
      phase: "recovery-required", consumedAt: "2026-10-11T00:00:00.000Z", cancelledAt: null, completedAt: null, failedAt: null,
      recoveryRequiredAt: "2026-10-11T00:00:01.000Z", stateTokenInputsSha256: `sha256:${"d".repeat(64)}`,
      receiptChronologyRevision: `sha256:${"e".repeat(64)}`, receiptSnapshot: [], receiptRefs: f.binding.receiptRefs,
      outcome: null, error: "Startup failed",
    };
    store.create(record);
    f.journal.phase = "recovered"; f.writeJournal();
    for (const entry of [...f.journal.entries, f.journal.activeReceipt]) f.fingerprints.set(entry.destination, entry.previous);
    assert.deepEqual(settleVerifiedManagerRecoveryOperations(root, store, "2026-10-11T00:02:00.000Z", f.dependencies), [operationId]);
    assert.equal(store.read(operationId)?.phase, "failed");
    f.fingerprints.set("/Applications/Tweakers.app", wanted);
    assert.equal(managerOperationRecoveryIsVerified(root, operationId, f.dependencies), false);
    assert.deepEqual(settleVerifiedManagerRecoveryOperations(root, store, "2026-10-11T00:03:00.000Z", f.dependencies), []);
    assert.equal(store.read(operationId)?.outcome, "verified-promotion-recovered");
    const terminal = store.read(operationId)!;
    assert.equal(independentRefreshHasProvenRetryableFailure(terminal, root), true,
      "Doctor must accept durable completed recovery after its restored bytes change");
    for (const altered of [
      { ...terminal, outcome: "ordinary-failure" },
      { ...terminal, failedAt: null },
      { ...terminal, recoveryRequiredAt: "2026-10-11T00:03:00.000Z" },
      { ...terminal, actionId: "desktop-update.start" as const },
    ]) assert.equal(independentRefreshHasProvenRetryableFailure(altered, root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
