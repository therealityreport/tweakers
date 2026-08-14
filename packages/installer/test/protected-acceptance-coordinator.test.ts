import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createActiveBackendIdentityReceipt,
} from "../src/environment-transaction";
import { adjudicateInstalledModeCanary } from "../src/installed-mode-canary";
import {
  acceptProtectedEnvironmentPublication,
  createProtectedRollbackEvidenceReceipt,
  produceInstalledModeCanaryFromMeasuredObservation,
} from "../src/protected-acceptance-coordinator";
import {
  createProtectedAppSignatureReceipt,
  verifyProtectedUiOffAbsence,
} from "../src/protected-app-shell";
import { observeFullQuit, prepareFullQuitObservation } from "../src/full-quit-observer";
import {
  createAppliedPendingLaunchGrant,
  createProtectedBootstrapPreflightReceipt,
  protectedLaunchIdentitySha256,
  type AppliedPendingLaunchGrantV1,
} from "../../runtime/src/protected-bootstrap";

// Source tests intentionally do not create the forbidden generated runtime
// asset. Production requires that asset's canonical validators; this explicit
// seam enables the byte-for-byte contract mirror only in this test process.
process.env.TWEAKERS_TEST_ALLOW_SOURCE_PROTECTED_BOOTSTRAP_CONTRACT = "1";

const SHA = (character: string) => character.repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const NOW = "2026-08-12T19:01:00.000Z";
const EXPIRES = "2026-08-12T20:01:00.000Z";
const APP_ROOT = "/Applications/ChatGPT.app";
const ASAR_PATH = `${APP_ROOT}/Contents/Resources/app.asar`;
const BACKEND_PATH = `${APP_ROOT}/Contents/Resources/codex`;
const DISPLAY_READBACK = "Authority=Tweakers Local Signing\nTeamIdentifier=LOCAL";

interface CanonicalEvidence {
  directory: string;
  grant: AppliedPendingLaunchGrantV1;
  preflight: ReturnType<typeof createProtectedBootstrapPreflightReceipt>;
  active: ReturnType<typeof createActiveBackendIdentityReceipt>;
  signing: ReturnType<typeof createProtectedAppSignatureReceipt>;
  uiOff: ReturnType<typeof verifyProtectedUiOffAbsence>;
  rollback: ReturnType<typeof createProtectedRollbackEvidenceReceipt>;
  observation: ReturnType<typeof measuredObservation>;
}

function request(root: string, transactionId = "protected-acceptance-1") {
  return {
    authorityRoot: root,
    transactionId,
    attempt: 1,
    acceptedBuildReceiptSha256: SHA("d"),
    environment: { uiFeatures: "off" as const, mcpSafetyProvider: "managed-turn-idle" as const, recoveryState: "normal-protected" as const },
    rollbackAppRoot: join(root, "rollback.app"),
    rollbackAttempted: false,
  };
}

function canonicalGrant(transactionId: string): AppliedPendingLaunchGrantV1 {
  const grant = createAppliedPendingLaunchGrant({
    transactionId,
    attempt: 1,
    issuedAt: NOW,
    expiresAt: EXPIRES,
    nonce: "protected-acceptance-nonce-0001",
    authoritySha256: SHA("a"),
    acceptedBuildReceiptSha256: SHA("d"),
    environment: { schemaVersion: 2, uiFeatures: "off", mcpSafetyProvider: "managed-turn-idle", recoveryState: "normal-protected" },
    identity: {
      appPath: APP_ROOT,
      appContentsSha256: SHA("b"),
      appAsarSha256: SHA("c"),
      asarHeaderSha256: SHA("e"),
      loaderPath: `${ASAR_PATH}/protected-loader.cjs`,
      loaderSha256: SHA("f"),
      metadataSha256: SHA("1"),
      runtimeMainPath: "/private/tweakers/runtime/main.js",
      runtimeMainSha256: SHA("2"),
      backendPath: BACKEND_PATH,
      backendSha256: SHA("3"),
      backendVersion: "0.147.0",
      backendArchitecture: "arm64",
      signatureReceiptSha256: digest(DISPLAY_READBACK),
      policyDigest: SHA("4"),
    },
  });
  return {
    ...grant,
    consumedBy: { desktopPid: 71, desktopKernelStart: "desktop-start", consumedAt: NOW },
  };
}

function canonicalSignature(input: {
  transactionId: string;
  grant: AppliedPendingLaunchGrantV1;
  grantSha256: string;
  preflight: ReturnType<typeof createProtectedBootstrapPreflightReceipt>;
}) {
  return createProtectedAppSignatureReceipt({
    transactionId: input.transactionId,
    attempt: 1,
    grantNonce: input.grant.nonce,
    appliedPendingLaunchGrantSha256: input.grantSha256,
    preflightReceiptSha256: input.preflight.receiptSha256,
    preflightIdentitySha256: protectedLaunchIdentitySha256(input.grant.identity),
    sourceContentsSha256: SHA("5"),
    protectedContentsSha256: input.grant.identity.appContentsSha256,
    signingPosture: "contained",
    signingMode: "local-identity",
    signingIdentity: "Tweakers Local Signing",
    certificateSha256: SHA("6"),
    identityCreated: false,
    keychainPath: "/private/tmp/tweakers-signing.keychain-db",
    keychainSha256: SHA("7"),
    loginKeychainPreferencesUnchanged: true,
    designatedRequirement: 'designated => identifier "com.openai.codex"',
    designatedRequirementSha256: SHA("8"),
    portableEntitlementsCanonical: JSON.stringify({ "com.apple.security.cs.disable-library-validation": true }),
    portableEntitlementsSha256: SHA("9"),
    removedEntitlementKeys: [
      "application-identifier",
      "com.apple.developer.team-identifier",
      "com.apple.security.application-groups",
      "keychain-access-groups",
      "com.apple.developer.aps-environment",
    ],
    appAsarSha256: input.grant.identity.appAsarSha256,
    appAsarHeaderSha256: input.grant.identity.asarHeaderSha256,
    infoPlistAsarIntegrity: { algorithm: "SHA256", path: "Resources/app.asar", hash: input.grant.identity.asarHeaderSha256 },
    nestedCode: [{
      path: "Contents/Resources/codex",
      sha256: input.grant.identity.backendSha256,
      architecture: "arm64",
      signingIdentity: "Tweakers Local Signing",
      designatedRequirement: 'identifier "com.openai.codex"',
      entitlementSha256: SHA("a"),
    }],
    insideOutSigned: true,
    strictVerifyOutput: "codesign --verify --deep --strict: valid",
    displayReadbackOutput: DISPLAY_READBACK,
    gatekeeperOutput: "spctl: accepted",
    createdAt: NOW,
    builderVersion: "protected-acceptance-coordinator/1",
    toolVersions: { codesign: "1", spctl: "1" },
    policyDigest: input.grant.identity.policyDigest,
  });
}

function canonicalUiOff(input: {
  transactionId: string;
  grant: AppliedPendingLaunchGrantV1;
  grantSha256: string;
  preflight: ReturnType<typeof createProtectedBootstrapPreflightReceipt>;
}) {
  return verifyProtectedUiOffAbsence({
    transactionId: input.transactionId,
    attempt: 1,
    grantNonce: input.grant.nonce,
    appliedPendingLaunchGrantSha256: input.grantSha256,
    preflightReceiptSha256: input.preflight.receiptSha256,
    preflightIdentitySha256: protectedLaunchIdentitySha256(input.grant.identity),
    appAsarSha256: input.grant.identity.appAsarSha256,
    pristine: [
      { path: "main.js", sha256: SHA("a"), kind: "file" as const },
      { path: "package.json", sha256: SHA("b"), kind: "file" as const },
    ],
    uiOff: [
      { path: "main.js", sha256: SHA("a"), kind: "file" as const },
      { path: "package.json", sha256: SHA("c"), kind: "file" as const },
      { path: "protected-loader.cjs", sha256: SHA("d"), kind: "file" as const },
      { path: "tweakers-protected.json", sha256: SHA("e"), kind: "file" as const },
    ],
    uiOn: [
      { path: "main.js", sha256: SHA("a"), kind: "file" as const },
      { path: "package.json", sha256: SHA("c"), kind: "file" as const },
      { path: "protected-loader.cjs", sha256: SHA("d"), kind: "file" as const },
      { path: "tweakers-protected.json", sha256: SHA("e"), kind: "file" as const },
      { path: "tweakers/runtime/main.js", sha256: SHA("f"), kind: "file" as const },
    ],
    trace: [
      { sequence: 1, kind: "module-load", originPath: "/candidate/protected-loader.cjs", target: "/candidate/protected-loader.cjs", sha256: SHA("d") },
      { sequence: 2, kind: "module-load", originPath: "/candidate/protected-loader.cjs", target: "/candidate/main.js", sha256: SHA("a") },
    ],
    protectedLoaderPath: "/candidate/protected-loader.cjs",
    openAiMainPath: "/candidate/main.js",
    pristinePackageJson: { main: "main.js", name: "codex" },
    uiOffPackageJson: { main: "protected-loader.cjs", name: "codex", __tweakersProtected: { originalMain: "main.js", uiFeatures: "off" } },
    checkedAt: NOW,
  });
}

function measuredObservation(input: {
  transactionId: string;
  grant: AppliedPendingLaunchGrantV1;
  grantSha256: string;
  preflight: ReturnType<typeof createProtectedBootstrapPreflightReceipt>;
  active: ReturnType<typeof createActiveBackendIdentityReceipt>;
  uiOff: ReturnType<typeof canonicalUiOff>;
}) {
  const authority = prepareFullQuitObservation({
    transactionId: input.transactionId,
    desktop: { pid: 1, kernelStart: "start", executablePath: "/app", executableSha256: SHA("a"), parentPid: null },
    expectedAppPath: "/app", expectedAppSha256: SHA("b"), preparedAt: NOW, expiresAt: EXPIRES, nonce: "measured-canary-nonce-0001",
  });
  return {
    schemaVersion: 1 as const,
    kind: "protected-installed-mode-observation" as const,
    verdict: "PASS" as const,
    transactionId: input.transactionId,
    attempt: 1,
    grantNonce: input.grant.nonce,
    appliedPendingLaunchGrantSha256: input.grantSha256,
    preflightReceiptSha256: input.preflight.receiptSha256,
    preflightIdentitySha256: protectedLaunchIdentitySha256(input.grant.identity),
    activeBackendReceiptSha256: input.active.receiptSha256,
    environment: input.grant.environment,
    fixture: { tokenFree: true, modelFree: true, completedIdleFleetTornDown: true, busyMailboxFleetPreserved: true, freshRespawnObserved: true, attachedUiOwnedSignalCount: 0, latencyMs: [1], cpuSamples: [1], rssBytes: [1] },
    fullQuitAuthority: authority,
    fullQuitReceipt: observeFullQuit(authority, { initial: [authority.desktop], final: [], observedAt: NOW }),
    uiOffAbsenceReceipt: input.uiOff,
    signingReceiptSha256: SHA("7"),
    managedMcpAdjudication: {
      schemaVersion: 1 as const,
      kind: "managed-mcp-canary-adjudication" as const,
      policyId: "managed-turn-idle-v3" as const,
      verdict: "PASS" as const,
      reasons: [],
      evidence: { sha256: SHA("8"), schemaVersion: 2, transactionId: input.transactionId, candidateSha256: SHA("9") },
      adjudicatedAt: NOW,
    },
    runtimeLoadTraceSha256: input.uiOff.loadTraceSha256,
    healthProbeReceiptSha256: SHA("a"),
    startedAt: NOW,
    completedAt: NOW,
    receiptSha256: SHA("b"),
  };
}

function prepareEvidence(root: string, transactionId = "protected-acceptance-1"): CanonicalEvidence {
  const directory = join(root, "transactions", "protected", transactionId);
  mkdirSync(directory, { recursive: true });
  const grant = canonicalGrant(transactionId);
  const grantBytes = Buffer.from(JSON.stringify(grant));
  const grantSha256 = createHash("sha256").update(grantBytes).digest("hex");
  const preflight = createProtectedBootstrapPreflightReceipt({
    schemaVersion: 1,
    kind: "protected-bootstrap-preflight",
    transactionId,
    attempt: 1,
    nonce: grant.nonce,
    verdict: "PASS",
    reason: null,
    environment: grant.environment,
    identitySha256: protectedLaunchIdentitySha256(grant.identity),
    backend: { path: grant.identity.backendPath, sha256: grant.identity.backendSha256, version: grant.identity.backendVersion, architecture: "arm64" },
    consumedAt: NOW,
    emittedAt: NOW,
  });
  const active = createActiveBackendIdentityReceipt({
    transactionId,
    attempt: 1,
    preflightReceiptSha256: preflight.receiptSha256,
    environment: grant.environment,
    desktop: { pid: 71, kernelStart: "desktop-start", executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", appAsarSha256: grant.identity.appAsarSha256 },
    appServer: { pid: 72, kernelStart: "server-start", uid: 501, executablePath: grant.identity.backendPath, executableSha256: grant.identity.backendSha256, version: grant.identity.backendVersion, architecture: "arm64", parentDesktopPid: 71, parentDesktopKernelStart: "desktop-start" },
    acceptedBuildReceiptSha256: grant.acceptedBuildReceiptSha256,
    observedAt: NOW,
  });
  const signing = canonicalSignature({ transactionId, grant, grantSha256, preflight });
  const uiOff = canonicalUiOff({ transactionId, grant, grantSha256, preflight });
  const rollback = createProtectedRollbackEvidenceReceipt({
    schemaVersion: 1,
    kind: "protected-rollback-evidence",
    transactionId,
    attempt: 1,
    grantNonce: grant.nonce,
    appliedPendingLaunchGrantSha256: grantSha256,
    preflightReceiptSha256: preflight.receiptSha256,
    preflightIdentitySha256: protectedLaunchIdentitySha256(grant.identity),
    acceptedBuildReceiptSha256: grant.acceptedBuildReceiptSha256,
    rollbackAppRoot: join(root, "rollback.app"),
    rollbackAppContentsSha256: SHA("5"),
    rollbackAppAsarSha256: SHA("6"),
    rollbackAttempted: false,
    observedAt: NOW,
  });
  const observation = {
    ...measuredObservation({ transactionId, grant, grantSha256, preflight, active, uiOff }),
    signingReceiptSha256: signing.receiptSha256,
  };
  const canary = produceInstalledModeCanaryFromMeasuredObservation(observation, signing);
  for (const [name, value] of Object.entries({
    "launch-grant.json": grant,
    "preflight.json": preflight,
    "active-backend.json": active,
    "installed-mode-observation.json": observation,
    "installed-mode-canary.json": canary,
    "signing-receipt.json": signing,
    "rollback-evidence.json": rollback,
  })) writeFileSync(join(directory, name), JSON.stringify(value));
  return { directory, grant, preflight, active, signing, uiOff, rollback, observation };
}

test("protected promotion accepts only complete canonical and cross-bound post-main receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-acceptance-"));
  try {
    prepareEvidence(root);
    const evidence = acceptProtectedEnvironmentPublication(request(root));
    assert.equal(evidence.installedCanary.verdict, "PASS");
    assert.equal(evidence.activeBackend.appServer.parentDesktopPid, evidence.activeBackend.desktop.pid);
    assert.equal(JSON.parse(readFileSync(join(root, "transactions", "protected", "protected-acceptance-1", "protected-environment-publication.json"), "utf8")).receiptSha256, evidence.receiptSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected terminal gate rejects fabricated and tampered sidecars", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-acceptance-tamper-"));
  try {
    const requestInput = request(root);
    assert.throws(() => acceptProtectedEnvironmentPublication(requestInput), /launch-grant\.json/i);
    const cases: Array<[string, (directory: string) => void, RegExp]> = [
      ["fabricated grant", (directory) => writeFileSync(join(directory, "launch-grant.json"), JSON.stringify({ grant: true })), /launch grant is invalid/i],
      ["preflight nonce", (directory) => {
        const value = JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8"));
        value.nonce = "tampered-preflight-nonce-0001";
        writeFileSync(join(directory, "preflight.json"), JSON.stringify(value));
      }, /preflight receipt is missing/i],
      ["active accepted build", (directory) => {
        const value = JSON.parse(readFileSync(join(directory, "active-backend.json"), "utf8"));
        value.acceptedBuildReceiptSha256 = SHA("f");
        writeFileSync(join(directory, "active-backend.json"), JSON.stringify(value));
      }, /active backend receipt is invalid/i],
      ["signing ASAR", (directory) => {
        const value = JSON.parse(readFileSync(join(directory, "signing-receipt.json"), "utf8"));
        value.appAsarSha256 = SHA("f");
        writeFileSync(join(directory, "signing-receipt.json"), JSON.stringify(value));
      }, /signature receipt is invalid/i],
      ["UI load trace", (directory) => {
        const value = JSON.parse(readFileSync(join(directory, "installed-mode-observation.json"), "utf8"));
        value.uiOffAbsenceReceipt.loadTraceSha256 = SHA("f");
        writeFileSync(join(directory, "installed-mode-observation.json"), JSON.stringify(value));
      }, /UI-off absence receipt is invalid|measured installed-mode observation/i],
      ["rollback hash", (directory) => {
        const value = JSON.parse(readFileSync(join(directory, "rollback-evidence.json"), "utf8"));
        value.rollbackAppAsarSha256 = SHA("f");
        writeFileSync(join(directory, "rollback-evidence.json"), JSON.stringify(value));
      }, /rollback evidence is invalid/i],
    ];
    for (const [name, tamper, error] of cases) {
      const caseRoot = join(root, name.replaceAll(" ", "-"));
      const { directory } = prepareEvidence(caseRoot);
      tamper(directory);
      assert.throws(() => acceptProtectedEnvironmentPublication(request(caseRoot)), error, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measured canary adapter refuses a UI receipt whose canonical launch binding is tampered", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-measured-"));
  try {
    const evidence = prepareEvidence(root, "protected-measured-1");
    assert.equal(produceInstalledModeCanaryFromMeasuredObservation(evidence.observation, evidence.signing).verdict, "PASS");
    assert.throws(() => produceInstalledModeCanaryFromMeasuredObservation({
      ...evidence.observation,
      uiOffAbsenceReceipt: { ...evidence.uiOff, grantNonce: "tampered-ui-nonce-0001" },
    }, evidence.signing), /UI-off absence receipt is invalid/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
