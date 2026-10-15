import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
import { acceptedCombinedPayloadText, acceptedOfficialBundledPayloadText, assertAcceptedSharedNativeBackendTransitionContract,
  assertAcceptedBackendTransitionJournalBindingContract, type OfficialBundledCandidateAuthorityV2,
  type PrebuiltCombinedCandidateAuthorityV1, type AcceptedSharedNativeBackendTransitionLaneV1,
  type AcceptedSharedNativeBackendTransitionLaneV2 } from "../src/accepted-backend-transition-contract.ts";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const deps = {sha256, isCanonicalAbsolutePath: (path: string) => isAbsolute(path) && resolve(path) === path};
const identity = {target: "/fixture/Tweakers.app", userRoot: "/fixture/user", brokerRoot: "/fixture/broker"};
function official(): AcceptedSharedNativeBackendTransitionLaneV2 {
  const resourceTree = {sha256: "1".repeat(64), entries: 4, bytes: "300"};
  const bare: Omit<OfficialBundledCandidateAuthorityV2, "payloadIdentity"> = {schemaVersion: 2, kind: "official-bundled", transactionId: "official-fixture", installerPayloadHash: "2".repeat(64),
    backend: {sourcePath: "/fixture/Source.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", sha256: "3".repeat(64), version: "0.162.0-alpha.17.2", architecture: "arm64", certificateSha1: "A".repeat(40)},
    closure: {kind: "official-bundled", sourceAppRoot: "/fixture/Source.app", resourceRelativePath: "Contents/Resources/codex-cli", resourceTree,
      backend: {relativePath: "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", sha256: "3".repeat(64), certificateSha1: "A".repeat(40)},
      codeModeHost: {relativePath: "Contents/Resources/codex-cli/bin/codex-code-mode-host", sha256: "4".repeat(64), certificateSha1: "B".repeat(40)}},
    nativePackage: {relativePath: "Contents/Resources/codex-cli/codex-package.json", sha256: "5".repeat(64), layoutVersion: 1, version: "0.162.0-alpha.17.2", target: "aarch64-apple-darwin"},
    runtime: {sourceRoot: "/fixture/runtime", fingerprint: "6".repeat(64), fileCount: 10, documentSha256: "7".repeat(64), adapterVersion: "official-bundled-adapter-v1"},
    sourceApp: {path: "/fixture/Source.app", bundleId: "com.openai.codex", contentsFingerprint: "8".repeat(64), treeSeal: resourceTree}};
  return {version: 2, resolverProtocol: "official-bundled-v1", identity, authority: {...bare, payloadIdentity: sha256(acceptedOfficialBundledPayloadText(bare))},
    priorRegistrationFingerprint: `sha256:${"9".repeat(64)}`, priorResolverBinarySha256: "a".repeat(64)};
}
function legacy(): AcceptedSharedNativeBackendTransitionLaneV1 {
  const signature = {identity: "fixture", teamIdentifier: null, designatedRequirement: null};
  const bare: Omit<PrebuiltCombinedCandidateAuthorityV1, "payloadIdentity"> = {schemaVersion: 1, transactionId: "legacy", installerPayloadHash: "1".repeat(64),
    acceptedBuildReceipt: {path: "/fixture/accepted-build.json", sha256: "2".repeat(64), acceptedAt: "2026-10-11T00:00:00Z", sourceCommit: "3".repeat(40), sourceTree: "4".repeat(40),
      cargoLockSha256: "5".repeat(64), reviewedDiffSha256: "6".repeat(64), patchSeriesSha256: "7".repeat(64), upstream: {repository: "https://github.com/openai/codex.git", tag: "rust-v0.162.0-alpha.17.2", commit: "3".repeat(40)},
      verification: {level: "source-verified", installedAcceptance: "required"}, buildCommand: "cargo build --locked", toolchain: "fixture", testEvidence: [{name: "source check", command: "fixture-check", receiptSha256: "8".repeat(64)}]},
    backend: {sourcePath: "/fixture/codex", sha256: "9".repeat(64), version: "0.162.0-alpha.17.2", architecture: "arm64", signature},
    closure: {codeModeHost: {path: "/fixture/host", sha256: "a".repeat(64), architecture: "arm64", signature}, resources: []},
    runtime: {sourceRoot: "/fixture/runtime", fingerprint: "b".repeat(64), fileCount: 10, documentSha256: "c".repeat(64)},
    sourceApp: {path: "/fixture/Source.app", bundleId: "com.openai.codex", contentsFingerprint: "d".repeat(64)}};
  return {version: 1, identity, authority: {...bare, payloadIdentity: sha256(acceptedCombinedPayloadText(bare))}, priorRegistrationFingerprint: `sha256:${"e".repeat(64)}`, priorResolverBinarySha256: "f".repeat(64)};
}

test("historical v1 schema and serialized payload ordering remain exact", () => {
  const lane = legacy(); assertAcceptedSharedNativeBackendTransitionContract(lane, deps);
  const a = lane.authority;
  assert.equal(acceptedCombinedPayloadText(a), JSON.stringify({schemaVersion: a.schemaVersion, transactionId: a.transactionId, installerPayloadHash: a.installerPayloadHash,
    acceptedBuildReceipt: a.acceptedBuildReceipt, backend: a.backend, closure: a.closure, runtime: a.runtime, sourceApp: a.sourceApp}));
  assert.throws(() => assertAcceptedSharedNativeBackendTransitionContract({...lane, resolverProtocol: "official-bundled-v1"}, deps));
  assert.throws(() => assertAcceptedSharedNativeBackendTransitionContract({...lane, priorResolverBinarySha256: a.backend.sha256}, deps));
});

test("official v2 is an explicit supplied-byte authority without Cargo/build/test receipts", () => {
  const lane = official(); assertAcceptedSharedNativeBackendTransitionContract(lane, deps);
  assert.equal("acceptedBuildReceipt" in lane.authority, false);
  assertAcceptedBackendTransitionJournalBindingContract({lane, operationId: "11111111-1111-4111-8111-111111111111"}, deps);
  assert.throws(() => assertAcceptedSharedNativeBackendTransitionContract({...lane, version: 1}, deps));
});

for (const field of ["backend", "closure", "nativePackage", "runtime", "sourceApp", "installerPayloadHash"] as const) {
  test(`official payload rejects ${field} authority drift`, () => {
    const lane = official(); (lane.authority as unknown as Record<string, unknown>)[field] = "substituted";
    assert.throws(() => assertAcceptedSharedNativeBackendTransitionContract(lane, deps));
  });
}

test("rehashed official authority still requires the fixed native layout, arm64 target and adapter", () => {
  for (const mutate of [
    (a: OfficialBundledCandidateAuthorityV2) => (a.closure.backend as {relativePath: string}).relativePath = "Contents/Resources/codex",
    (a: OfficialBundledCandidateAuthorityV2) => (a.nativePackage as {target: string}).target = "x86_64-apple-darwin",
    (a: OfficialBundledCandidateAuthorityV2) => (a.runtime as {adapterVersion: string}).adapterVersion = "unverified",
    (a: OfficialBundledCandidateAuthorityV2) => a.closure.sourceAppRoot = "/fixture/Other.app",
    (a: OfficialBundledCandidateAuthorityV2) => a.backend.certificateSha1 = "",
    (a: OfficialBundledCandidateAuthorityV2) => (a as unknown as Record<string, unknown>).acceptedBuildReceipt = {},
  ]) {const lane = official(); mutate(lane.authority); lane.authority.payloadIdentity = sha256(acceptedOfficialBundledPayloadText(lane.authority));
    assert.throws(() => assertAcceptedSharedNativeBackendTransitionContract(lane, deps));}
});
