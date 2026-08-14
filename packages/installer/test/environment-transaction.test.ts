import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  createEnvironmentProfileRegistry,
  createProtectedEnvironmentSelection,
  createEnvironmentSelection,
  fingerprintAppContents,
  writeEnvironmentProfileRegistry,
  type EnvironmentSelection,
} from "../src/environment-profile";
import {
  createEnvironmentCoordinator,
  createActiveBackendIdentityReceipt,
  createProtectedEnvironmentPublicationEvidence,
  createDefaultEnvironmentAdapters,
  createManagedAlphaBackendPreparer,
  defaultCodexMcpConfigFile,
  assertProtectedEnvironmentPublication,
  ENVIRONMENT_TRANSACTION_PHASES,
  environmentPreparationCapabilities,
  fingerprintDirectoryTree,
  InstallerEnvironmentCoordinator,
  readEnvironmentCommitHelperOutcome,
  readEnvironmentCommitHelperReceipt,
  readEnvironmentRuntimeProof,
  readEnvironmentTransactionReceipt,
  resolvePreparedEnvironmentCommitCli,
  submitEnvironmentCommitHelper,
  writeEnvironmentTransactionReceipt,
  type EnvironmentAppliedEvidence,
  type PreparedEnvironmentEvidence,
} from "../src/environment-transaction";
import { hashTree } from "../src/commands/refresh-local";
import { acquireProcessLock } from "../src/process-lock";
import { computeRuntimeFingerprint } from "../src/runtime-fingerprint";

test("default MCP ownership path targets the user's Codex config", () => {
  assert.equal(
    defaultCodexMcpConfigFile("/Users/example"),
    "/Users/example/.codex/config.toml",
  );
});

test("protected terminal publication requires one bound grant, preflight, active backend, and passing installed canary", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
  });
  const requested = createProtectedEnvironmentSelection({
    profile: registry.profiles.stable,
    uiFeatures: "off",
    requestedAt: "2026-08-12T19:00:00.000Z",
  });
  const active = createActiveBackendIdentityReceipt({
    transactionId: "protected-publication-1",
    attempt: 1,
    preflightReceiptSha256: "a".repeat(64),
    environment: {
      uiFeatures: "off",
      mcpSafetyProvider: "managed-turn-idle",
      recoveryState: "normal-protected",
    },
    desktop: {
      pid: 401,
      kernelStart: "desktop-kernel-start",
      executablePath: "/candidate/ChatGPT.app/Contents/MacOS/ChatGPT",
      appAsarSha256: "b".repeat(64),
    },
    appServer: {
      pid: 402,
      kernelStart: "app-server-kernel-start",
      uid: 501,
      executablePath: "/candidate/ChatGPT.app/Contents/Resources/codex",
      executableSha256: "c".repeat(64),
      version: "0.147.0-alpha.6.5",
      architecture: "arm64",
      parentDesktopPid: 401,
      parentDesktopKernelStart: "desktop-kernel-start",
    },
    acceptedBuildReceiptSha256: "d".repeat(64),
    observedAt: "2026-08-12T19:01:00.000Z",
  });
  const publication = createProtectedEnvironmentPublicationEvidence({
    transactionId: active.transactionId,
    attempt: active.attempt,
    appliedPendingLaunchGrantSha256: "e".repeat(64),
    preflightReceiptSha256: active.preflightReceiptSha256,
    activeBackend: active,
    installedCanary: {
      transactionId: active.transactionId,
      attempt: active.attempt,
      preflightReceiptSha256: active.preflightReceiptSha256,
      activeBackendReceiptSha256: active.receiptSha256,
      verdict: "PASS",
      receiptSha256: "f".repeat(64),
    },
    signingReceiptSha256: "1".repeat(64),
    rollbackEvidenceSha256: "2".repeat(64),
  });

  assert.doesNotThrow(() => assertProtectedEnvironmentPublication(publication, requested));
  assert.throws(
    () => assertProtectedEnvironmentPublication(publication, { ...requested, migrationState: "migration-blocked" }),
    /Legacy or quarantined selection/,
  );
  assert.throws(
    () => createProtectedEnvironmentPublicationEvidence({
      ...publication,
      installedCanary: { ...publication.installedCanary, verdict: "INCONCLUSIVE" },
    }),
    /receipt order or binding/,
  );
});

test("legacy runtime proofs are stale and current proofs bind the desktop and app.asar", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-runtime-proof-"));
  const file = join(root, "environment-runtime-proof.json");
  const proof = {
    schemaVersion: 2,
    kind: "environment-runtime-proof",
    pid: 123,
    appRoot: "/Applications/ChatGPT.app",
    bundleId: "com.openai.codex",
    desktopVersion: "26.727.51351",
    desktopBuild: "6119",
    appAsarHeaderHash: "a".repeat(64),
    appExperience: "tweakers",
    releaseProfile: "stable",
    backendLane: "bundled",
    binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    backendVersion: "0.146.0-alpha.9.2",
    backendFingerprint: "b".repeat(64),
    runtimePath: "/tmp/runtime",
    runtimeFingerprint: "c".repeat(64),
    runtimeFileCount: 1,
    managedRuntimePath: "/tmp/managed-runtime",
    managedRuntimeFingerprint: "d".repeat(64),
    managedRuntimeFileCount: 1,
    managedSourceRuntimeHash: null,
    observedAt: "2026-08-03T12:00:00.000Z",
  };
  try {
    writeFileSync(file, JSON.stringify({ ...proof, schemaVersion: 1 }));
    assert.equal(readEnvironmentRuntimeProof(file), null);
    writeFileSync(file, JSON.stringify(proof));
    assert.deepEqual(readEnvironmentRuntimeProof(file), proof);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom coordinators keep every adoption path inside their explicit root", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-path-isolation-"));
  try {
    const coordinator = new InstallerEnvironmentCoordinator({ environmentRoot: root });
    for (const path of [
      coordinator.transactionFile,
      coordinator.receiptRoot,
      coordinator.selectionFile,
      coordinator.registryFile,
      coordinator.configFile,
      coordinator.stateFile,
      coordinator.runtimeProofFile,
      coordinator.mcpStateFile,
      coordinator.tweaksRoot,
      coordinator.lockFile,
      coordinator.lifecycleLockFile,
    ]) {
      assert.equal(path === root || path.startsWith(`${root}/`), true, path);
    }
    assert.throws(
      () => new InstallerEnvironmentCoordinator({
        environmentRoot: root,
        stateFile: join(dirname(root), "outside-state.json"),
      }),
      /installer state file must be contained/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function selections(): { current: EnvironmentSelection; requested: EnvironmentSelection } {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
  });
  return {
    current: createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-17T01:00:00.000Z",
      appliedAt: "2026-07-17T01:00:01.000Z",
    }),
    requested: createEnvironmentSelection({
      profile: registry.profiles.alpha,
      appExperience: "tweakers",
      requestedAt: "2026-07-17T02:00:00.000Z",
    }),
  };
}

function preparedEvidence(current: EnvironmentSelection, requested: EnvironmentSelection): PreparedEnvironmentEvidence {
  return {
    preparedAt: "2026-07-17T02:00:05.000Z",
    candidate: {
      desktopPath: requested.selectedDesktopPath,
      artifactPath: "/tmp/prepared/ChatGPT (Beta).app",
      bundleId: requested.selectedDesktopBundleId,
      appExperience: requested.appExperience,
      releaseProfile: requested.releaseProfile,
      version: "26.717.1",
      build: "6001",
      artifactDigest: "candidate-sha256",
      asarHeaderHash: "a".repeat(64),
      signature: {
        strict: true,
        gatekeeper: true,
        designatedRequirement: "identifier prepared.tweakers.alpha",
        teamIdentifier: null,
      },
    },
    backend: {
      lane: requested.backendLane,
      binaryPath: "/tmp/prepared/codex-alpha",
      artifactPath: "/tmp/prepared/artifacts/codex-alpha",
      version: "0.145.0-alpha.3",
      artifactDigest: "backend-sha256",
    },
    rollback: {
      selection: current,
      desktopPath: current.selectedDesktopPath,
      desktopArtifactPath: "/tmp/prepared/rollback/ChatGPT.app",
      archivePath: "/tmp/prepared/archive/ChatGPT.app",
      bundleId: current.selectedDesktopBundleId,
      desktopVersion: "26.707.1",
      desktopBuild: "5900",
      desktopArtifactDigest: "rollback-desktop-sha256",
      desktopAsarHeaderHash: "b".repeat(64),
      backendLane: current.backendLane,
      backendBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      backendArtifactPath: "/tmp/prepared/rollback/codex",
      backendVersion: "0.144.0",
      backendArtifactDigest: "rollback-backend-sha256",
    },
  };
}

function writeRuntimeFixture(runtimeRoot: string, content = "runtime\n"): { fingerprint: string; fileCount: number } {
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, "main.js"), content);
  return refreshRuntimeFingerprint(runtimeRoot);
}

function refreshRuntimeFingerprint(runtimeRoot: string): { fingerprint: string; fileCount: number } {
  const evidence = computeRuntimeFingerprint(runtimeRoot);
  writeFileSync(join(runtimeRoot, "runtime-fingerprint.json"), `${JSON.stringify({
    schemaVersion: 1,
    fingerprint: evidence.fingerprint,
    fileCount: evidence.fileCount,
  }, null, 2)}\n`);
  return evidence;
}

function writeManagedRuntimeFixture(
  managedRoot: string,
  content = "managed runtime\n",
  sourceRuntimeHash = "a".repeat(64),
  provenance: Record<string, unknown> | null = null,
): { fingerprint: string; fileCount: number } {
  const evidence = writeRuntimeFixture(
    join(managedRoot, "packages", "installer", "assets", "runtime"),
    content,
  );
  const cliPath = join(managedRoot, "packages", "installer", "dist", "cli.js");
  mkdirSync(join(cliPath, ".."), { recursive: true });
  writeFileSync(cliPath, "export {};\n");
  writeFileSync(join(managedRoot, ".tweakers-provenance.json"), `${JSON.stringify({
    ...(provenance ?? {
      kind: "development-bootstrap",
      sourceRuntimeHash,
    }),
  }, null, 2)}\n`);
  return evidence;
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("default preparation accepts the canonical profile fingerprint for a pristine app with symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-canonical-fingerprint-"));
  const appPath = join(root, "Applications", "ChatGPT.app");
  const pristinePath = join(root, "backup", "Codex.app");
  const registryFile = join(root, "environment-registry.json");
  try {
    for (const app of [appPath, pristinePath]) {
      mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
      mkdirSync(join(app, "Contents", "Versions", "A"), { recursive: true });
      writeFileSync(join(app, "Contents", "Resources", "codex"), "bundled-cli");
      writeFileSync(join(app, "Contents", "Versions", "A", "marker"), "payload");
      symlinkSync("A", join(app, "Contents", "Versions", "Current"));
    }
    writeRuntimeFixture(join(root, "runtime"));
    writeManagedRuntimeFixture(join(root, "managed-runtime", "current"));
    const pristineFingerprint = fingerprintAppContents(pristinePath);
    const registry = createEnvironmentProfileRegistry({
      stableDesktopPath: appPath,
      alphaDesktopPath: join(root, "Applications", "ChatGPT (Beta).app"),
      environmentRoot: root,
      stableEvidence: {
        officialVersion: "26.707.1",
        officialBuild: "5900",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        signatureCheckedAt: "2026-07-17T02:00:00.000Z",
        officialBackendVersion: "0.144.5",
        officialBackendFingerprint: "bundled-cli-digest",
        backendVersion: "0.144.5",
        backendFingerprint: "bundled-cli-digest",
        pristineBackupPath: pristinePath,
        pristineBackupFingerprint: pristineFingerprint,
        patchedPayloadBuildable: true,
      },
    });
    const current = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-17T02:00:00.000Z",
      appliedAt: "2026-07-17T02:00:01.000Z",
    });
    const requested = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-17T02:01:00.000Z",
    });
    const selectedRegistry = { ...registry, selected: current, lastKnownWorkingSelection: current };
    const adapters = createDefaultEnvironmentAdapters({
      registryFile,
      receiptRoot: join(root, "receipts"),
      configFile: join(root, "config.json"),
      stateFile: join(root, "state.json"),
      sourceRoot: root,
    }, {
      assertMcpModeReady: () => {},
      loadState: () => ({ registry: selectedRegistry, current, migratedFromLegacy: false }),
      cloneApp: (source, destination) => cpSync(source, destination, { recursive: true, verbatimSymlinks: true }),
      copyBackend: (source, destination) => cpSync(source, destination),
      readMarker: (asarPath) => asarPath.includes("candidate.app") || asarPath.includes("Codex.app") ? "absent" : "present",
      readAsarHeaderHash: () => "a".repeat(64),
      fileFingerprint: () => "bundled-cli-digest",
      readDesktopIdentity: () => ({ bundleId: "com.openai.codex", version: "26.707.1", build: "5900" }),
      verifyOfficial: () => ({
        strict: true,
        gatekeeper: true,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: "2DC432GLL2",
      }),
      verifyPatched: () => ({
        strict: true,
        gatekeeper: false,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: null,
      }),
      readBackendVersion: () => "0.144.5",
    });

    const prepared = await adapters.preparePrerequisites({
      transactionId: "canonical-fingerprint",
      current,
      requested,
      oldMainPid: 101,
    });
    assert.equal(prepared.candidate.artifactDigest, pristineFingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function appliedEvidence(
  selection: EnvironmentSelection,
  direction: "requested" | "rollback" = "requested",
): EnvironmentAppliedEvidence {
  const rollback = direction === "rollback";
  return {
    observedAt: "2026-07-17T02:00:10.000Z",
    selection: { ...selection, appliedAt: "2026-07-17T02:00:10.000Z" },
    desktopVersion: rollback ? "26.707.1" : "26.717.1",
    desktopBuild: rollback ? "5900" : "6001",
    backendVersion: rollback ? "0.144.0" : "0.145.0-alpha.3",
    desktopArtifactDigest: rollback ? "rollback-desktop-sha256" : "candidate-sha256",
    asarHeaderHash: (rollback ? "b" : "a").repeat(64),
    backendArtifactDigest: rollback ? "rollback-backend-sha256" : "backend-sha256",
  };
}

test("commit records the exact old PID, retries once, and proves a different visible process", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-transaction-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const receiptRoot = join(root, "transactions", "environment");
  const selectionFile = join(root, "environment-selection.json");
  const { current, requested } = selections();
  const calls: string[] = [];
  const observations = [
    { pid: 101, visibleWindow: true },
    { pid: 201, visibleWindow: false },
    { pid: 202, visibleWindow: true },
  ];

  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot,
      selectionFile,
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-1",
      preparePrerequisites: ({ requested: selection }) => {
        calls.push(`prepare:${selection.selectedDesktopPath}`);
        return preparedEvidence(current, requested);
      },
      stagePreparedEnvironment: ({ direction }) => {
        calls.push(`stage:${direction}`);
      },
      observeDesktop: async (path) => {
        calls.push(`observe:${path}`);
        return observations.shift() ?? null;
      },
      quitDesktop: async (path, pid) => {
        calls.push(`quit:${path}:${pid}`);
      },
      processAlive: () => false,
      cleanupHelpers: async (path, stoppedPid) => {
        calls.push(`cleanup:${path}:${stoppedPid}`);
      },
      applyPreparedEnvironment: async ({ direction }) => {
        calls.push(`apply:${direction}`);
      },
      reopenDesktop: async (path) => {
        calls.push(`reopen:${path}`);
      },
      refreshWatcher: async (path) => {
        calls.push(`watcher:${path}`);
      },
      proveAppliedEnvironment: () => appliedEvidence(requested),
      sleep: async () => {},
    });

    assert.equal(
      (coordinator as { registryFile: string }).registryFile,
      join(root, "environment-registry.json"),
      "an isolated selection file must never fall back to the live user registry",
    );

    const prepared = await coordinator.prepare({ current, requested });
    assert.equal(prepared.schemaVersion, 1);
    assert.equal(prepared.kind, "environment");
    assert.equal(prepared.phase, "prepared");
    assert.equal(prepared.error, null);
    assert.equal(prepared.oldMainPid, 101);
    assert.equal(prepared.prepared?.candidate.artifactDigest, "candidate-sha256");
    assert.equal(existsSync(selectionFile), false, "prepare must not publish requested state before confirmation");

    const committed = await coordinator.commit(prepared.transactionId);
    assert.equal(committed.phase, "committed");
    assert.equal(committed.attempt, 2);
    assert.equal(committed.oldMainPid, 101);
    assert.equal(committed.newMainPid, 202);
    assert.equal(committed.requested.appliedAt, "2026-07-17T02:00:10.000Z");
    assert.deepEqual(coordinator.status(), committed);
    assert.deepEqual(readEnvironmentTransactionReceipt(transactionFile), committed);
    assert.equal(existsSync(join(receiptRoot, "environment-1.json")), true);
    assert.equal(JSON.parse(readFileSync(selectionFile, "utf8")).appliedAt, "2026-07-17T02:00:10.000Z");

    assert.deepEqual(calls, [
      "observe:/Applications/ChatGPT.app",
      "prepare:/Applications/ChatGPT (Beta).app",
      "stage:requested",
      "quit:/Applications/ChatGPT.app:101",
      "cleanup:/Applications/ChatGPT.app:101",
      "apply:requested",
      "reopen:/Applications/ChatGPT (Beta).app",
      "observe:/Applications/ChatGPT (Beta).app",
      "quit:/Applications/ChatGPT (Beta).app:201",
      "cleanup:/Applications/ChatGPT (Beta).app:201",
      "reopen:/Applications/ChatGPT (Beta).app",
      "observe:/Applications/ChatGPT (Beta).app",
      "watcher:/Applications/ChatGPT (Beta).app",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion keeps the watcher paused through proof, publishes state, then resumes before terminal commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-watcher-order-"));
  const { current, requested } = selections();
  const events: string[] = [];
  let running: "source" | "requested" | null = "source";
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      createId: () => "watcher-order",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: (path) => {
        if (path === current.selectedDesktopPath && running === "source") return { pid: 101, visibleWindow: true };
        if (path === requested.selectedDesktopPath && running === "requested") return { pid: 202, visibleWindow: true };
        return null;
      },
      pauseWatcher: (input) => {
        events.push("pause");
        assert.equal(input.sourceExpectedFingerprint, "rollback-desktop-sha256");
      },
      quitDesktop: () => { events.push("quit"); running = null; },
      processAlive: () => false,
      cleanupHelpers: () => { events.push("cleanup"); },
      applyPreparedEnvironment: () => { events.push("apply"); },
      reopenDesktop: () => { events.push("reopen"); running = "requested"; },
      proveAppliedEnvironment: () => { events.push("prove"); return appliedEvidence(requested); },
      bindWatcherTarget: (input) => {
        events.push("bind-watcher-target");
        assert.equal(input.applied.asarHeaderHash, "a".repeat(64));
      },
      publishSelection: () => { events.push("publish"); },
      resumeWatcher: (input) => {
        events.push("resume");
        assert.equal(input.targetExpectedFingerprint, "candidate-sha256");
        assert.equal(events.includes("publish"), true);
      },
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    const committed = await coordinator.commit(prepared.transactionId);
    events.push(`terminal:${committed.phase}`);
    assert.deepEqual(events, [
      "pause",
      "quit",
      "cleanup",
      "apply",
      "reopen",
      "prove",
      "bind-watcher-target",
      "publish",
      "resume",
      "terminal:committed",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale watcher-target state fails closed and rolls back before watcher resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-watcher-bind-fail-"));
  const { current, requested } = selections();
  let running: "source" | "requested" | null = "source";
  let sourcePid = 101;
  const resumes: string[] = [];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      createId: () => "watcher-bind-fail",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: (path) => {
        if (path === current.selectedDesktopPath && running === "source") return { pid: sourcePid, visibleWindow: true };
        if (path === requested.selectedDesktopPath && running === "requested") return { pid: 202, visibleWindow: true };
        return null;
      },
      pauseWatcher: () => {},
      quitDesktop: () => { running = null; },
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: () => {},
      reopenDesktop: (path) => {
        running = path === requested.selectedDesktopPath ? "requested" : "source";
        if (running === "source") sourcePid = 303;
      },
      proveAppliedEnvironment: ({ direction }) => direction === "requested"
        ? appliedEvidence(requested)
        : appliedEvidence(current, "rollback"),
      bindWatcherTarget: ({ direction }) => {
        if (direction === "requested") throw new Error("persisted watcher ASAR hash is stale");
      },
      publishSelection: () => {},
      resumeWatcher: ({ targetAppRoot }) => { resumes.push(targetAppRoot); },
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    const result = await coordinator.commit(prepared.transactionId);
    assert.equal(result.phase, "rolled-back");
    assert.deepEqual(resumes, [current.selectedDesktopPath]);
    assert.match(result.error ?? "", /persisted watcher ASAR hash is stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed watcher pause prevents app shutdown and cutover", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-watcher-pause-fail-"));
  const { current, requested } = selections();
  const mutations: string[] = [];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "environment.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
    }, {
      createId: () => "watcher-pause-fail",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 101, visibleWindow: true }),
      pauseWatcher: () => { throw new Error("watcher remained active"); },
      quitDesktop: () => { mutations.push("quit"); },
      applyPreparedEnvironment: () => { mutations.push("apply"); },
      reopenDesktop: () => { mutations.push("reopen"); },
    });
    const prepared = await coordinator.prepare({ current, requested });
    const cancelled = await coordinator.commit(prepared.transactionId);
    assert.equal(cancelled.phase, "cancelled");
    assert.match(cancelled.error ?? "", /watcher remained active/);
    assert.deepEqual(mutations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit waits for the submitting CLI to release the lifecycle lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-lease-retry-"));
  const lifecycleLockFile = join(root, "transactions", "lifecycle.lock");
  const { current, requested } = selections();
  const observations = [
    { pid: 101, visibleWindow: true },
    { pid: 202, visibleWindow: true },
  ];
  let holder: ReturnType<typeof acquireProcessLock> | null = null;
  let waits = 0;
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      lifecycleLockFile,
    }, {
      createId: () => "lease-retry",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: () => {},
      reopenDesktop: () => {},
      proveAppliedEnvironment: () => appliedEvidence(requested),
      sleep: async () => {
        waits += 1;
        holder?.release();
        holder = null;
      },
    });
    const prepared = await coordinator.prepare({ current, requested });
    holder = acquireProcessLock(lifecycleLockFile);

    const committed = await coordinator.commit(prepared.transactionId);

    assert.equal(committed.phase, "committed");
    assert.equal(waits, 1);
  } finally {
    holder?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed-app preparation applies without stopping and verifies the newly opened app", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-closed-"));
  const { current, requested } = selections();
  const calls: string[] = [];
  let requestedOpen = false;
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "environment.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-closed",
      preparePrerequisites: ({ oldMainPid }) => {
        assert.equal(oldMainPid, null);
        return preparedEvidence(current, requested);
      },
      observeDesktop: (path) => {
        calls.push(`observe:${path}`);
        if (path === current.selectedDesktopPath) return null;
        return requestedOpen ? { pid: 202, visibleWindow: true } : null;
      },
      quitDesktop: (_path, pid) => { calls.push(`quit:${pid}`); },
      processAlive: () => false,
      cleanupHelpers: (_path, pid) => { calls.push(`cleanup:${pid}`); },
      applyPreparedEnvironment: ({ direction }) => { calls.push(`apply:${direction}`); },
      reopenDesktop: () => { requestedOpen = true; calls.push("reopen"); },
      refreshWatcher: () => { calls.push("watcher"); },
      proveAppliedEnvironment: () => appliedEvidence(requested),
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    assert.equal(prepared.oldMainPid, null);
    const committed = await coordinator.commit(prepared.transactionId);
    assert.equal(committed.phase, "committed");
    assert.equal(committed.oldMainPid, null);
    assert.equal(committed.newMainPid, 202);
    assert.equal(calls.some((call) => call.startsWith("quit:")), false);
    assert.equal(calls.some((call) => call.startsWith("cleanup:")), false);
    assert.deepEqual(calls.slice(-3), [
      "reopen",
      "observe:/Applications/ChatGPT (Beta).app",
      "watcher",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed-app commit safely binds an exact source app that appears after preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-closed-race-"));
  const { current, requested } = selections();
  let sourceObservations = 0;
  let requestedOpen = false;
  const stopped: number[] = [];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "environment.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-closed-race",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: (path) => {
        if (path === current.selectedDesktopPath) {
          sourceObservations += 1;
          return sourceObservations === 1 ? null : { pid: 151, visibleWindow: true };
        }
        return requestedOpen ? { pid: 202, visibleWindow: true } : null;
      },
      quitDesktop: (_path, pid) => { stopped.push(pid); },
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: () => {},
      reopenDesktop: () => { requestedOpen = true; },
      refreshWatcher: () => {},
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : appliedEvidence(requested),
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    assert.equal(prepared.oldMainPid, null);
    const committed = await coordinator.commit(prepared.transactionId);
    assert.equal(committed.phase, "committed");
    assert.equal(committed.oldMainPid, 151);
    assert.deepEqual(stopped, [151]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt validator accepts every declared phase with prepared evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-phases-"));
  const file = join(root, "environment.json");
  const { current, requested } = selections();
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: file,
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-phases",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 101, visibleWindow: true }),
    });
    const prepared = await coordinator.prepare({ current, requested });
    for (const phase of ENVIRONMENT_TRANSACTION_PHASES) {
      const receipt = {
        ...prepared,
        phase,
        ...(phase === "committed" ? {
          applied: appliedEvidence(requested),
          newMainPid: 202,
          committedAt: "2026-07-17T02:00:10.000Z",
        } : {}),
        ...(phase === "rolled-back" ? {
          applied: appliedEvidence(current, "rollback"),
          newMainPid: 303,
          rolledBackAt: "2026-07-17T02:00:10.000Z",
        } : {}),
        ...(phase === "cancelled" ? {
          cancelledAt: "2026-07-17T02:00:10.000Z",
        } : {}),
      };
      writeEnvironmentTransactionReceipt(file, receipt);
      assert.equal(readEnvironmentTransactionReceipt(file)?.phase, phase);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed requested-state proof rolls back after exactly one retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-rollback-"));
  const { current, requested } = selections();
  const calls: string[] = [];
  const observations = [
    { pid: 101, visibleWindow: true },
    { pid: 201, visibleWindow: true },
    { pid: 202, visibleWindow: true },
    { pid: 202, visibleWindow: true },
    { pid: 303, visibleWindow: true },
  ];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-rollback",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: async (path) => {
        calls.push(`observe:${path}`);
        return observations.shift() ?? null;
      },
      quitDesktop: async (path, pid) => { calls.push(`quit:${path}:${pid}`); },
      processAlive: () => false,
      cleanupHelpers: async (path, pid) => { calls.push(`cleanup:${path}:${pid}`); },
      applyPreparedEnvironment: async ({ direction }) => { calls.push(`apply:${direction}`); },
      reopenDesktop: async (path) => { calls.push(`reopen:${path}`); },
      refreshWatcher: async (path) => { calls.push(`watcher:${path}`); },
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    const receipt = await coordinator.commit(prepared.transactionId);

    assert.equal(receipt.phase, "rolled-back");
    assert.equal(receipt.attempt, 2);
    assert.equal(receipt.newMainPid, 303);
    assert.match(receipt.error ?? "", /^Commit failed after one retry:/);
    assert.equal(receipt.applied?.selection.appliedAt, "2026-07-17T02:00:10.000Z");
    assert.equal(calls.filter((call) => call === "reopen:/Applications/ChatGPT (Beta).app").length, 2);
    assert.equal(calls.at(-3), "reopen:/Applications/ChatGPT.app");
    assert.equal(calls.at(-2), "observe:/Applications/ChatGPT.app");
    assert.equal(calls.at(-1), "watcher:/Applications/ChatGPT.app");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transient relaunch command failure uses the existing retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-relaunch-retry-"));
  const { current, requested } = selections();
  const observations = [
    { pid: 101, visibleWindow: true },
    null,
    { pid: 202, visibleWindow: true },
  ];
  let requestedReopens = 0;

  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-relaunch-retry",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: () => {},
      reopenDesktop: (path) => {
        if (path !== requested.selectedDesktopPath) return;
        requestedReopens += 1;
        if (requestedReopens === 1) {
          throw new Error("Command failed: osascript -e <reopen script>");
        }
      },
      refreshWatcher: () => {},
      proveAppliedEnvironment: ({ direction }) => direction === "requested"
        ? appliedEvidence(requested)
        : appliedEvidence(current, "rollback"),
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    const receipt = await coordinator.commit(prepared.transactionId);

    assert.equal(receipt.phase, "committed");
    assert.equal(receipt.attempt, 2);
    assert.equal(receipt.newMainPid, 202);
    assert.equal(requestedReopens, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relaunch AppleScript stderr survives commit rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-relaunch-error-"));
  const { current, requested } = selections();
  const observations = [
    { pid: 101, visibleWindow: true },
    null,
    null,
    null,
    { pid: 303, visibleWindow: true },
  ];
  const relaunchError = Object.assign(
    new Error("Command failed: osascript -e <reopen script>"),
    {
      status: 1,
      stderr: Buffer.from(
        `${"x".repeat(10_000)}\n` +
        "execution error: System Events got an error: Not authorized to send Apple events. (-1743)\n",
      ),
    },
  );

  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-relaunch-error",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: () => {},
      reopenDesktop: (path) => {
        if (path === requested.selectedDesktopPath) throw relaunchError;
      },
      refreshWatcher: () => {},
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    const receipt = await coordinator.commit(prepared.transactionId);

    assert.equal(receipt.phase, "rolled-back");
    assert.equal(receipt.attempt, 2);
    assert.match(
      receipt.error ?? "",
      /System Events got an error: Not authorized to send Apple events\. \(-1743\)/,
    );
    assert.doesNotMatch(receipt.error ?? "", /<reopen script>/);
    assert.equal(receipt.error?.match(/\[truncated \d+ chars\]/g)?.length, 2);
    assert.ok((receipt.error ?? "").length < 6_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relaunch diagnostics survive a throwing requested-state proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-relaunch-proof-error-"));
  const { current, requested } = selections();
  const observations = [
    { pid: 101, visibleWindow: true },
    { pid: 201, visibleWindow: true },
    { pid: 202, visibleWindow: true },
    { pid: 303, visibleWindow: true },
  ];
  const relaunchError = Object.assign(
    new Error("Command failed: osascript -e <reopen script>"),
    {
      status: 1,
      stderr: Buffer.from("candidate launch rejected by taskgated\n"),
    },
  );

  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-relaunch-proof-error",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: () => {},
      reopenDesktop: (path) => {
        if (path === requested.selectedDesktopPath) throw relaunchError;
      },
      refreshWatcher: () => {},
      proveAppliedEnvironment: ({ direction }) => {
        if (direction === "requested") throw new Error("requested proof exploded");
        return appliedEvidence(current, "rollback");
      },
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    const receipt = await coordinator.commit(prepared.transactionId);

    assert.equal(receipt.phase, "rolled-back");
    assert.match(receipt.error ?? "", /requested proof exploded/);
    assert.match(receipt.error ?? "", /candidate launch rejected by taskgated/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-existing requested selection file cannot satisfy post-apply proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-false-proof-"));
  const selectionFile = join(root, "environment-selection.json");
  const { current, requested } = selections();
  const observations = [
    { pid: 101, visibleWindow: true },
    { pid: 201, visibleWindow: true },
    { pid: 202, visibleWindow: true },
    { pid: 202, visibleWindow: true },
    { pid: 303, visibleWindow: true },
  ];
  try {
    writeFileSync(selectionFile, JSON.stringify(appliedEvidence(requested).selection));
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile,
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-false-proof",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: () => {},
      reopenDesktop: () => {},
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    const result = await coordinator.commit(prepared.transactionId);
    assert.equal(result.phase, "rolled-back");
    assert.equal(JSON.parse(readFileSync(selectionFile, "utf8")).backendLane, current.backendLane);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel is terminal and never stops or opens a desktop", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-cancel-"));
  const { current, requested } = selections();
  let stoppedOrOpened = false;
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-cancel",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 101, visibleWindow: true }),
      quitDesktop: () => { stoppedOrOpened = true; },
      reopenDesktop: () => { stoppedOrOpened = true; },
    });

    const prepared = await coordinator.prepare({ current, requested });
    const cancelled = await coordinator.cancel(prepared.transactionId);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.error, null);
    assert.equal(cancelled.cancelledAt, "2026-07-17T02:00:10.000Z");
    assert.equal(stoppedOrOpened, false);
    assert.equal(existsSync(join(root, "transactions", "environment", "environment-cancel.json")), true);
    assert.equal(existsSync(join(root, "environment-selection.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit rejects legacy Tweakers evidence before stopping the running app", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-legacy-runtime-preflight-"));
  const { current, requested } = selections();
  const lifecycle: string[] = [];
  let validations = 0;
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transaction.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      lockFile: join(root, "environment.lock"),
      lifecycleLockFile: join(root, "lifecycle.lock"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      createId: () => "legacy-runtime-receipt",
      now: () => "2026-07-17T02:00:05.000Z",
      observeDesktop: () => ({ pid: 101, visibleWindow: true }),
      preparePrerequisites: () => preparedEvidence(current, requested),
      validatePreparedEnvironment: ({ receipt }) => {
        validations += 1;
        if (validations === 1) return;
        throw new Error(
          `Environment transaction ${receipt.transactionId} predates atomic runtime evidence; cancel it and prepare a new candidate`,
        );
      },
      quitDesktop: () => { lifecycle.push("quit"); },
      cleanupHelpers: () => { lifecycle.push("cleanup"); },
      applyPreparedEnvironment: () => { lifecycle.push("apply"); },
      reopenDesktop: () => { lifecycle.push("reopen"); },
      proveAppliedEnvironment: () => null,
    });

    const prepared = await coordinator.prepare({ current, requested });
    await assert.rejects(
      coordinator.commit(prepared.transactionId),
      /predates atomic runtime evidence; cancel it and prepare a new candidate/,
    );
    assert.deepEqual(lifecycle, []);
    assert.equal(coordinator.status()?.phase, "prepared");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-cutover cleanup failure cancels without overwriting or rolling back the running source", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-guard-"));
  const { current, requested } = selections();
  let cleanupCalls = 0;
  let reopenCalls = 0;
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-guard",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 101, visibleWindow: true }),
      quitDesktop: () => {},
      processAlive: (pid) => pid === 101,
      cleanupHelpers: () => { cleanupCalls += 1; },
      reopenDesktop: () => { reopenCalls += 1; },
    });

    const prepared = await coordinator.prepare({ current, requested });
    const failed = await coordinator.commit(prepared.transactionId);
    assert.equal(failed.phase, "cancelled");
    assert.match(failed.error ?? "", /Refusing helper cleanup while exact main PID 101 is still alive/);
    await assert.rejects(
      () => coordinator.rollback(prepared.transactionId),
      /already cancelled/,
    );
    assert.equal(cleanupCalls, 0);
    assert.equal(reopenCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed main PID before cutover cancels without applying a false rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-pid-change-"));
  const { current, requested } = selections();
  const observations = [
    { pid: 101, visibleWindow: true },
    { pid: 202, visibleWindow: true },
  ];
  const applied: string[] = [];
  let reopenCalls = 0;
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-pid-change",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => { throw new Error("expected main PID 101 is not current"); },
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: ({ direction }) => { applied.push(direction); },
      reopenDesktop: () => { reopenCalls += 1; },
    });

    const prepared = await coordinator.prepare({ current, requested });
    const cancelled = await coordinator.commit(prepared.transactionId);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.attempt, 0);
    assert.equal(cancelled.applied, null);
    assert.match(cancelled.error ?? "", /expected main PID 101 is not current/);
    assert.deepEqual(applied, []);
    assert.equal(reopenCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed main PID before cutover is rebound only after exact source proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-pid-rebind-"));
  const { current, requested } = selections();
  let observedPid: number | null = 101;
  const quitAttempts: number[] = [];
  const applied: string[] = [];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-pid-rebind",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observedPid === null ? null : { pid: observedPid, visibleWindow: true },
      quitDesktop: (_path, expectedPid) => {
        quitAttempts.push(expectedPid);
        if (expectedPid === 101) {
          observedPid = 202;
          throw new Error("expected main PID 101 is not current");
        }
        assert.equal(expectedPid, 202);
        observedPid = null;
      },
      processAlive: (pid) => observedPid === pid,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: ({ direction }) => { applied.push(direction); },
      reopenDesktop: () => { observedPid = 303; },
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : appliedEvidence(requested),
      publishSelection: () => {},
      refreshWatcher: () => {},
      sleep: async () => {},
    });

    const prepared = await coordinator.prepare({ current, requested });
    const committed = await coordinator.commit(prepared.transactionId);
    assert.equal(committed.phase, "committed");
    assert.equal(committed.oldMainPid, 202);
    assert.equal(committed.newMainPid, 303);
    assert.deepEqual(quitAttempts, [101, 202]);
    assert.deepEqual(applied, ["requested"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy pre-cutover rollback failure recovery preserves the proven live source app", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-legacy-pre-cutover-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const { current, requested } = selections();
  const mutations: string[] = [];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-legacy-pre-cutover",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 202, visibleWindow: true }),
      quitDesktop: () => { mutations.push("quit"); },
      applyPreparedEnvironment: ({ direction }) => { mutations.push(`apply:${direction}`); },
      reopenDesktop: () => { mutations.push("reopen"); },
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      publishSelection: (selection) => { mutations.push(`publish:${selection.appExperience}`); },
    });
    const prepared = await coordinator.prepare({ current, requested });
    writeEnvironmentTransactionReceipt(transactionFile, {
      ...prepared,
      phase: "failed",
      error: "Commit failed: Refusing to quit /Applications/ChatGPT.app: expected main PID 101 is not current; rollback failed: atomic directory swap failed: Operation not permitted",
      applied: null,
      newMainPid: null,
      attempt: 0,
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    });

    const recovered = await coordinator.rollback(prepared.transactionId);
    assert.equal(recovered.phase, "cancelled");
    assert.equal(recovered.newMainPid, 202);
    assert.equal(recovered.applied?.selection.appExperience, current.appExperience);
    assert.match(recovered.error ?? "", /Recovered safely without replacing the app/);
    assert.deepEqual(mutations, [`publish:${current.appExperience}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native-host pre-swap failure recovery preserves a replacement source PID without applying rollback bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-native-host-pre-swap-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const { current, requested } = selections();
  const mutations: string[] = [];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
    }, {
      now: () => "2026-07-18T19:06:08.000Z",
      createId: () => "environment-native-host-pre-swap",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 68976, visibleWindow: true }),
      quitDesktop: () => { mutations.push("quit"); },
      applyPreparedEnvironment: ({ direction }) => { mutations.push(`apply:${direction}`); },
      reopenDesktop: () => { mutations.push("reopen"); },
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      publishSelection: (selection) => { mutations.push(`publish:${selection.appExperience}`); },
    });
    const prepared = await coordinator.prepare({ current, requested });
    writeEnvironmentTransactionReceipt(transactionFile, {
      ...prepared,
      phase: "failed",
      error: "Commit failed: Staged native host Team ID does not match its containing candidate (none != 2DC432GLL2); rollback failed: No signed staged native host exists in either app payload; refusing repo/runtime dlopen fallback",
      applied: null,
      newMainPid: null,
      attempt: 0,
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    });

    const recovered = await coordinator.rollback(prepared.transactionId);
    assert.equal(recovered.phase, "cancelled");
    assert.equal(recovered.newMainPid, 68976);
    assert.equal(recovered.applied?.selection.appExperience, current.appExperience);
    assert.match(recovered.error ?? "", /Recovered safely without replacing the app/);
    assert.deepEqual(mutations, [`publish:${current.appExperience}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-cutover source recovery failure is terminal without applying rollback bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-source-recovery-"));
  const { current, requested } = selections();
  const applied: string[] = [];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "transactions", "environment.json"),
      receiptRoot: join(root, "transactions", "environment"),
      selectionFile: join(root, "environment-selection.json"),
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "environment-source-recovery",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return { pid: 101, visibleWindow: true };
          }
          return null;
        };
      })(),
      quitDesktop: () => { throw new Error("expected main PID 101 is not current"); },
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: ({ direction }) => { applied.push(direction); },
      reopenDesktop: () => { throw new Error("source app did not reopen"); },
    });

    const prepared = await coordinator.prepare({ current, requested });
    const failed = await coordinator.commit(prepared.transactionId);
    assert.equal(failed.phase, "failed");
    assert.equal(failed.attempt, 0);
    assert.equal(failed.applied, null);
    assert.match(failed.error ?? "", /source recovery failed: source app did not reopen/);
    assert.deepEqual(applied, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default proof rejects exact bundle, path, version, backend lane, backend version, and fingerprint drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-default-proof-"));
  const backendPath = join(root, "backend", "codex");
  const { current, requested } = selections();
  const prepared = preparedEvidence(current, requested);
  prepared.backend.binaryPath = backendPath;
  prepared.runtime = {
    targetPath: join(root, "runtime"),
    requested: {
      artifactPath: join(root, "receipts", "default-proof", "prepared", "runtime", "requested"),
      artifactDigest: "requested-runtime-digest",
      runtimeFingerprint: "c".repeat(64),
      fileCount: 177,
    },
    rollback: {
      existed: true,
      artifactPath: join(root, "receipts", "default-proof", "prepared", "runtime", "rollback"),
      artifactDigest: "rollback-runtime-digest",
      runtimeFingerprint: "d".repeat(64),
      fileCount: 170,
    },
  };
  prepared.managedRuntime = {
    targetPath: join(root, "managed-runtime", "current"),
    requested: {
      artifactPath: join(root, "receipts", "default-proof", "prepared", "managed-runtime", "requested"),
      artifactDigest: "requested-managed-runtime-digest",
      runtimeFingerprint: "c".repeat(64),
      fileCount: 177,
      sourceRuntimeHash: "e".repeat(64),
    },
    rollback: {
      existed: true,
      artifactPath: join(root, "receipts", "default-proof", "prepared", "managed-runtime", "rollback"),
      artifactDigest: "rollback-managed-runtime-digest",
      runtimeFingerprint: "d".repeat(64),
      fileCount: 170,
      sourceRuntimeHash: "f".repeat(64),
    },
  };
  const mutable = {
    bundleId: requested.selectedDesktopBundleId as string | null,
    version: prepared.candidate.version as string | null,
    build: prepared.candidate.build as string | null,
    appRoot: requested.selectedDesktopPath,
    lane: requested.backendLane as typeof requested.backendLane | null,
    backendVersion: prepared.backend.version as string | null,
    desktopDigest: prepared.candidate.artifactDigest,
    backendDigest: prepared.backend.artifactDigest,
    runtimeBinaryPath: backendPath,
    runtimePid: 202,
    runtimeDesktopVersion: prepared.candidate.version,
    runtimeDesktopBuild: prepared.candidate.build,
    runtimeAsarHeaderHash: prepared.candidate.asarHeaderHash!,
    runtimeFingerprint: prepared.runtime.requested.runtimeFingerprint,
    runtimeFileCount: prepared.runtime.requested.fileCount,
    managedRuntimeFingerprint: prepared.managedRuntime.requested.runtimeFingerprint,
    managedRuntimeFileCount: prepared.managedRuntime.requested.fileCount,
    managedSourceRuntimeHash: prepared.managedRuntime.requested.sourceRuntimeHash,
    runtimeTreeDigest: prepared.runtime.requested.artifactDigest,
    managedRuntimeTreeDigest: prepared.managedRuntime.requested.artifactDigest,
    mcpMode: true,
  };
  let appFingerprintCalls = 0;
  try {
    mkdirSync(join(root, "backend"), { recursive: true });
    writeFileSync(backendPath, "backend", { flag: "a" });
    mkdirSync(prepared.runtime.targetPath, { recursive: true });
    mkdirSync(
      join(prepared.managedRuntime.targetPath, "packages", "installer", "assets", "runtime"),
      { recursive: true },
    );
    writeFileSync(
      join(prepared.managedRuntime.targetPath, ".tweakers-provenance.json"),
      `${JSON.stringify({ sourceRuntimeHash: prepared.managedRuntime.requested.sourceRuntimeHash })}\n`,
    );
    const adapters = createDefaultEnvironmentAdapters({
      registryFile: join(root, "profiles.json"),
      receiptRoot: join(root, "receipts"),
      configFile: join(root, "config.json"),
      stateFile: join(root, "state.json"),
    }, {
      proveMcpMode: () => mutable.mcpMode,
      readDesktopIdentity: () => ({
        bundleId: mutable.bundleId,
        version: mutable.version,
        build: mutable.build,
      }),
      readMarker: () => "present",
      readAsarHeaderHash: () => "a".repeat(64),
      appFingerprint: () => {
        appFingerprintCalls += 1;
        return mutable.desktopDigest;
      },
      fileFingerprint: () => mutable.backendDigest,
      directoryFingerprint: (path) => path === prepared.runtime!.targetPath
        ? mutable.runtimeTreeDigest
        : mutable.managedRuntimeTreeDigest,
      readRuntimeFingerprintEvidence: (path) => path === prepared.runtime!.targetPath
        ? { fingerprint: mutable.runtimeFingerprint, fileCount: mutable.runtimeFileCount }
        : { fingerprint: mutable.managedRuntimeFingerprint, fileCount: mutable.managedRuntimeFileCount },
      readBackendVersion: () => mutable.backendVersion,
      readBackendLane: () => mutable.lane,
      readAppState: () => ({
        appExperience: requested.appExperience,
        appRoot: mutable.appRoot,
        bundleId: requested.selectedDesktopBundleId,
        patchedAsarHash: "a".repeat(64),
      }),
      readRuntimeProof: () => ({
        schemaVersion: 2,
        kind: "environment-runtime-proof",
        pid: mutable.runtimePid,
        appRoot: requested.selectedDesktopPath,
        bundleId: requested.selectedDesktopBundleId,
        desktopVersion: mutable.runtimeDesktopVersion,
        desktopBuild: mutable.runtimeDesktopBuild,
        appAsarHeaderHash: mutable.runtimeAsarHeaderHash,
        appExperience: "tweakers",
        releaseProfile: requested.releaseProfile,
        backendLane: "managed-alpha",
        binaryPath: mutable.runtimeBinaryPath,
        backendVersion: prepared.backend.version,
        backendFingerprint: mutable.backendDigest,
        runtimePath: prepared.runtime!.targetPath,
        runtimeFingerprint: mutable.runtimeFingerprint,
        runtimeFileCount: mutable.runtimeFileCount,
        managedRuntimePath: join(
          prepared.managedRuntime!.targetPath,
          "packages",
          "installer",
          "assets",
          "runtime",
        ),
        managedRuntimeFingerprint: mutable.managedRuntimeFingerprint,
        managedRuntimeFileCount: mutable.managedRuntimeFileCount,
        managedSourceRuntimeHash: mutable.managedSourceRuntimeHash,
        observedAt: "2026-07-17T02:00:10.000Z",
      }),
      now: () => "2026-07-17T02:00:10.000Z",
    });
    const receipt = {
      schemaVersion: 1 as const,
      kind: "environment" as const,
      transactionId: "default-proof",
      phase: "verifying" as const,
      error: null,
      ownerPid: process.pid,
      source: current,
      requested,
      prepared,
      applied: null,
      oldMainPid: 101,
      newMainPid: null,
      attempt: 1,
      createdAt: "2026-07-17T02:00:00.000Z",
      updatedAt: "2026-07-17T02:00:00.000Z",
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    };
    const prove = () => adapters.proveAppliedEnvironment({
      direction: "requested",
      receipt,
      expected: requested,
      observation: { pid: 202, visibleWindow: true },
      prepared,
    });

    assert.notEqual(await prove(), null);
    assert.equal(appFingerprintCalls, 1);
    mutable.bundleId = "com.openai.codex";
    assert.equal(await prove(), null, "wrong bundle must fail");
    assert.equal(appFingerprintCalls, 1, "cheap identity drift must not hash the app");
    mutable.bundleId = requested.selectedDesktopBundleId;
    mutable.appRoot = "/Applications/Wrong.app";
    assert.equal(await prove(), null, "wrong exact path must fail");
    mutable.appRoot = requested.selectedDesktopPath;
    mutable.version = "0.0.0";
    assert.equal(await prove(), null, "wrong desktop version must fail");
    mutable.version = prepared.candidate.version;
    mutable.lane = "bundled";
    assert.equal(await prove(), null, "wrong backend lane must fail");
    mutable.lane = requested.backendLane;
    mutable.backendVersion = "0.0.0";
    assert.equal(await prove(), null, "wrong backend version must fail");
    mutable.backendVersion = prepared.backend.version;
    mutable.backendDigest = "wrong-backend-digest";
    assert.equal(await prove(), null, "wrong backend fingerprint must fail");
    mutable.backendDigest = prepared.backend.artifactDigest;
    mutable.runtimeBinaryPath = "/tmp/wrong-running-codex";
    assert.equal(await prove(), null, "wrong backend actually selected by the new runtime must fail");
    mutable.runtimeBinaryPath = backendPath;
    mutable.runtimePid = 999;
    assert.equal(await prove(), null, "runtime proof from another PID must fail");
    assert.equal(appFingerprintCalls, 1, "stale runtime proof must not hash the app");
    mutable.runtimePid = 202;
    mutable.runtimeDesktopVersion = "0.0.0";
    assert.equal(await prove(), null, "runtime proof from another desktop version must fail");
    mutable.runtimeDesktopVersion = prepared.candidate.version;
    mutable.runtimeDesktopBuild = "0";
    assert.equal(await prove(), null, "runtime proof from another desktop build must fail");
    mutable.runtimeDesktopBuild = prepared.candidate.build;
    mutable.runtimeAsarHeaderHash = "0".repeat(64);
    assert.equal(await prove(), null, "runtime proof from another app.asar must fail");
    mutable.runtimeAsarHeaderHash = prepared.candidate.asarHeaderHash!;
    mutable.runtimeFingerprint = "0".repeat(64);
    assert.equal(await prove(), null, "wrong active runtime fingerprint must fail");
    mutable.runtimeFingerprint = prepared.runtime.requested.runtimeFingerprint;
    mutable.runtimeTreeDigest = "runtime-tree-drift";
    assert.equal(await prove(), null, "changed active runtime tree must fail");
    mutable.runtimeTreeDigest = prepared.runtime.requested.artifactDigest;
    mutable.managedRuntimeTreeDigest = "managed-runtime-tree-drift";
    assert.equal(await prove(), null, "changed managed runtime tree must fail");
    mutable.managedRuntimeTreeDigest = prepared.managedRuntime.requested.artifactDigest;
    mutable.managedSourceRuntimeHash = "1".repeat(64);
    assert.equal(await prove(), null, "wrong managed runtime provenance must fail");
    mutable.managedSourceRuntimeHash = prepared.managedRuntime.requested.sourceRuntimeHash;
    mutable.mcpMode = false;
    assert.equal(await prove(), null, "unapplied MCP mode ownership must fail");
    assert.equal(appFingerprintCalls, 1, "unapplied MCP ownership must not hash the app");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default preparation stages immutable app/backend/rollback evidence and default apply uses it after cutover", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-default-apply-"));
  const appPath = join(root, "Applications", "ChatGPT.app");
  const alphaPath = join(root, "Applications", "ChatGPT (Beta).app");
  const pristinePath = join(root, "artifacts", "stable", "pristine.app");
  const patchedPath = join(root, "mode", "patched-payload", "ChatGPT.app");
  const registryFile = join(root, "environment-registry.json");
  const receiptRoot = join(root, "receipts");
  const stateFile = join(root, "state.json");
  let liveMode: "chatgpt" | "tweakers" = "tweakers";
  let liveDigest = "patched-digest";
  let liveBackendDigest = "rollback-backend-digest";
  const writes: string[] = [];
  try {
    for (const path of [appPath, pristinePath, patchedPath]) mkdirSync(path, { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify({
      version: "1.0.0",
      installedAt: "2026-07-17T01:00:00.000Z",
      appRoot: appPath,
      originalAsarHash: "original-header",
      patchedAsarHash: "old-patched-header",
      patchedAsarStat: { size: 99, mtimeMs: 100 },
      watcherStatGuardPasses: 7,
      codexVersion: "26.706.0",
      codexChannel: "stable",
      codexBundleId: "com.openai.codex",
      fuseFlipped: false,
      resigned: true,
      originalEntryPoint: "main.js",
      watcher: "launchd",
      mode: "tweakers",
    }, null, 2)}\n`);
    const rollbackRuntimePath = join(root, "runtime");
    writeRuntimeFixture(rollbackRuntimePath, "rollback runtime\n");
    chmodSync(rollbackRuntimePath, 0o755);
    chmodSync(join(rollbackRuntimePath, "main.js"), 0o644);
    const rollbackRuntimeDigest = fingerprintDirectoryTree(rollbackRuntimePath);
    writeManagedRuntimeFixture(
      join(root, "managed-runtime", "current"),
      "rollback managed runtime\n",
    );
    const base = createEnvironmentProfileRegistry({
      stableDesktopPath: appPath,
      alphaDesktopPath: alphaPath,
      environmentRoot: root,
      stableEvidence: {
        officialVersion: "26.707.1",
        officialBuild: "5900",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        signatureCheckedAt: "2026-07-17T02:00:00.000Z",
        officialBackendVersion: "0.144.0",
        officialBackendFingerprint: "official-backend-digest",
        backendVersion: null,
        backendFingerprint: null,
        pristineBackupPath: pristinePath,
        pristineBackupFingerprint: "pristine-digest",
        patchedPayloadPath: patchedPath,
        patchedPayloadFingerprint: "patched-digest",
      },
    });
    const current = createEnvironmentSelection({
      profile: base.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-17T01:00:00.000Z",
      appliedAt: "2026-07-17T01:00:01.000Z",
    });
    const requested = createEnvironmentSelection({
      profile: base.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-17T02:00:00.000Z",
    });
    const registry = createEnvironmentProfileRegistry({
      stableDesktopPath: appPath,
      alphaDesktopPath: alphaPath,
      environmentRoot: root,
      selected: current,
      lastKnownWorkingSelection: current,
      stableEvidence: {
        officialVersion: "26.707.1",
        officialBuild: "5900",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        signatureCheckedAt: "2026-07-17T02:00:00.000Z",
        officialBackendVersion: "0.144.0",
        officialBackendFingerprint: "official-backend-digest",
        backendVersion: null,
        backendFingerprint: null,
        pristineBackupPath: pristinePath,
        pristineBackupFingerprint: "pristine-digest",
        patchedPayloadPath: patchedPath,
        patchedPayloadFingerprint: "patched-digest",
      },
    });
    const adapters = createDefaultEnvironmentAdapters({
      registryFile,
      receiptRoot,
      configFile: join(root, "config.json"),
      stateFile,
    }, {
      assertMcpModeReady: () => {},
      reconcileMcpMode: (appExperience) => {
        const published = JSON.parse(readFileSync(stateFile, "utf8")) as { mode?: string };
        writes.push(`state:${published.mode}`);
        writes.push(`mcp:${appExperience}`);
      },
      loadState: () => ({ registry, current, migratedFromLegacy: true }),
      cloneApp: (source, destination) => {
        mkdirSync(join(destination, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(destination, "Contents", "Resources", "codex"), source.includes("pristine") ? "official" : "rollback");
      },
      copyBackend: (_source, destination) => {
        mkdirSync(join(destination, ".."), { recursive: true });
        writeFileSync(destination, "backend");
      },
      readMarker: (asarPath) => {
        if (asarPath.includes("candidate.app") || asarPath.includes("pristine")) return "absent";
        if (asarPath.startsWith(appPath)) return liveMode === "chatgpt" ? "absent" : "present";
        return "present";
      },
      readAsarHeaderHash: () => "a".repeat(64),
      appFingerprint: (path) => {
        if (path === appPath) return liveDigest;
        if (path.includes("candidate.app") || path.includes("pristine")) return "pristine-digest";
        return "patched-digest";
      },
      fileFingerprint: (path) => path.startsWith(appPath)
        ? liveBackendDigest
        : path.includes("rollback") ? "rollback-backend-digest" : "official-backend-digest",
      readDesktopIdentity: () => ({ bundleId: "com.openai.codex", version: "26.707.1", build: "5900" }),
      verifyOfficial: () => ({
        strict: true,
        gatekeeper: true,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: "2DC432GLL2",
      }),
      verifyPatched: () => ({
        strict: true,
        gatekeeper: false,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: null,
      }),
      readBackendVersion: (artifactPath) => basename(artifactPath) === "rollback-codex" ? null : "0.144.0",
      replaceApp: (source, destination, validate) => {
        writes.push(`replace:${destination}`);
        liveMode = source.includes("rollback.app") ? "tweakers" : "chatgpt";
        liveDigest = source.includes("rollback.app") ? "patched-digest" : "pristine-digest";
        liveBackendDigest = source.includes("rollback.app")
          ? "rollback-backend-digest"
          : "official-backend-digest";
        mkdirSync(join(destination, "Contents", "Resources"), { recursive: true });
        writeFileSync(
          join(destination, "Contents", "Resources", "codex"),
          source.includes("rollback.app") ? "rollback" : "official",
        );
        assert.equal(validate(destination), true);
      },
      writeBackendLane: (_file, lane) => { writes.push(`lane:${lane}`); },
      readAsarHeaderHash: () => "fresh-original-header",
      readPatchedAsarEvidence: () => ({
        headerHash: "live-patched-header",
        stat: { size: 123, mtimeMs: 456 },
      }),
      now: () => "2026-07-17T02:00:05.000Z",
    });

    let prepared: PreparedEnvironmentEvidence;
    const preparationUmask = process.umask(0o077);
    try {
      prepared = await adapters.preparePrerequisites({ transactionId: "default-apply", current, requested, oldMainPid: 101 });
    } finally {
      process.umask(preparationUmask);
    }
    assert.equal(prepared.candidate.artifactDigest, "pristine-digest");
    assert.equal(prepared.rollback.desktopArtifactDigest, "patched-digest");
    assert.equal(prepared.backend.artifactDigest, "official-backend-digest");
    assert.ok(prepared.runtime);
    assert.equal(
      prepared.runtime.rollback.artifactDigest,
      rollbackRuntimeDigest,
      "the default rollback snapshot must preserve source modes under umask 077",
    );
    assert.equal(existsSync(join(receiptRoot, "default-apply", "prepared", "candidate.app")), true);
    assert.equal(existsSync(registryFile), true, "prepare may persist recomputed registry evidence");
    assert.equal(existsSync(join(root, "environment-selection.json")), false);

    const requestedRuntimePath = prepared.runtime.requested.artifactPath;
    const requestedRunnerPath = join(requestedRuntimePath, "runner");
    const requestedRunnerLinkPath = join(requestedRuntimePath, "runner-link");
    writeFileSync(requestedRunnerPath, "#!/bin/sh\nexit 0\n");
    symlinkSync("runner", requestedRunnerLinkPath);
    chmodSync(requestedRuntimePath, 0o755);
    chmodSync(join(requestedRuntimePath, "main.js"), 0o644);
    chmodSync(requestedRunnerPath, 0o755);
    const requestedRuntime = refreshRuntimeFingerprint(requestedRuntimePath);
    prepared.runtime.requested.runtimeFingerprint = requestedRuntime.fingerprint;
    prepared.runtime.requested.fileCount = requestedRuntime.fileCount;
    prepared.runtime.requested.artifactDigest = fingerprintDirectoryTree(requestedRuntimePath);

    const replacementUmask = process.umask(0o077);
    try {
      await adapters.applyPreparedEnvironment({
        direction: "requested",
        receipt: {
          schemaVersion: 1,
          kind: "environment",
          transactionId: "default-apply",
          phase: "applying",
          error: null,
          ownerPid: process.pid,
          source: current,
          requested,
          prepared,
          applied: null,
          oldMainPid: 101,
          newMainPid: null,
          attempt: 0,
          createdAt: "2026-07-17T02:00:00.000Z",
          updatedAt: "2026-07-17T02:00:00.000Z",
          committedAt: null,
          rolledBackAt: null,
          cancelledAt: null,
        },
        prepared,
      });
    } finally {
      process.umask(replacementUmask);
    }
    assert.equal(fingerprintDirectoryTree(rollbackRuntimePath), prepared.runtime.requested.artifactDigest);
    assert.equal(lstatSync(rollbackRuntimePath).mode & 0o7777, 0o755);
    assert.equal(lstatSync(join(rollbackRuntimePath, "main.js")).mode & 0o7777, 0o644);
    assert.equal(lstatSync(join(rollbackRuntimePath, "runner")).mode & 0o7777, 0o755);
    assert.equal(lstatSync(join(rollbackRuntimePath, "runner-link")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(rollbackRuntimePath, "runner-link")), "runner");
    assert.deepEqual(writes, [
      `replace:${appPath}`,
      "lane:official-bundled",
      "state:chatgpt",
      "mcp:chatgpt",
    ]);
    const officialState = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    assert.equal(officialState.mode, "chatgpt");
    assert.equal(officialState.originalAsarHash, "fresh-original-header");
    assert.equal(officialState.patchedAsarHash, "old-patched-header");
    assert.equal("patchedAsarStat" in officialState, false);
    assert.equal("watcherStatGuardPasses" in officialState, false);
    const payloadMetadata = JSON.parse(readFileSync(
      join(root, "mode", "patched-payload", "payload.json"),
      "utf8",
    )) as { baseVersion: string | null; baseBuild: string | null; parkedAt: string };
    assert.deepEqual(payloadMetadata, {
      schemaVersion: 1,
      baseVersion: "26.707.1",
      baseBuild: "5900",
      patchedAsarHash: "old-patched-header",
      parkedAt: "2026-07-17T02:00:05.000Z",
    });

    await adapters.applyPreparedEnvironment({
      direction: "rollback",
      receipt: {
        schemaVersion: 1,
        kind: "environment",
        transactionId: "default-apply",
        phase: "applying",
        error: null,
        ownerPid: process.pid,
        source: current,
        requested,
        prepared,
        applied: null,
        oldMainPid: 101,
        newMainPid: null,
        attempt: 1,
        createdAt: "2026-07-17T02:00:00.000Z",
        updatedAt: "2026-07-17T02:00:00.000Z",
        committedAt: null,
        rolledBackAt: null,
        cancelledAt: null,
      },
      prepared,
    });
    assert.deepEqual(writes.slice(-4), [
      `replace:${appPath}`,
      "lane:bundled",
      "state:tweakers",
      "mcp:tweakers",
    ]);
    const tweakersState = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    assert.equal(tweakersState.mode, "tweakers");
    assert.equal(tweakersState.originalAsarHash, "fresh-original-header");
    assert.equal(tweakersState.patchedAsarHash, "live-patched-header");
    assert.deepEqual(tweakersState.patchedAsarStat, { size: 123, mtimeMs: 456 });
    assert.equal(tweakersState.watcherStatGuardPasses, 0);
    symlinkSync("../../outside-runtime", join(root, "runtime", "escaping-link"));
    await assert.rejects(
      adapters.preparePrerequisites({
        transactionId: "unsafe-rollback-runtime",
        current,
        requested,
        oldMainPid: 303,
      }),
      /rollback runtime contains an escaping symlink/,
      "a rollback snapshot may preserve broken internal links but never an escaping link",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebuilding stable Tweakers after an official update binds the candidate to the new official backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-updated-stable-"));
  const appPath = join(root, "Applications", "ChatGPT.app");
  const alphaPath = join(root, "Applications", "ChatGPT (Beta).app");
  const patchedPath = join(root, "mode", "patched-payload", "ChatGPT.app");
  const registryFile = join(root, "environment-registry.json");
  const calls: string[] = [];
  let executionSourceRoot = root;
  let requestedRuntimeLinkTarget = "same-a.js";
  let managedRuntimeLinkTarget = "same-a.js";
  let officialSignatureTeam = "2DC432GLL2";
  let mutateManagedSourceDuringStage = false;
  let mutateControlPlaneDuringBuild = false;
  try {
    const sourceCli = join(root, "packages", "installer", "dist", "cli.js");
    mkdirSync(join(sourceCli, ".."), { recursive: true });
    writeFileSync(sourceCli, "export {};\n");
    for (const path of [appPath, patchedPath]) {
      mkdirSync(join(path, "Contents", "Resources"), { recursive: true });
      writeFileSync(join(path, "Contents", "Resources", "codex"), path === appPath ? "updated-backend" : "stale-backend");
    }
    const base = createEnvironmentProfileRegistry({
      stableDesktopPath: appPath,
      alphaDesktopPath: alphaPath,
      environmentRoot: root,
      stableEvidence: {
        officialVersion: "26.715.31925",
        officialBuild: "5551",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        signatureCheckedAt: "2026-07-18T19:00:00.000Z",
        officialBackendVersion: "0.145.0-alpha.18",
        officialBackendFingerprint: "updated-backend-digest",
        backendVersion: null,
        backendFingerprint: "stale-backend-digest",
        patchedPayloadPath: patchedPath,
        patchedPayloadFingerprint: "stale-patched-digest",
        patchedPayloadBuildable: true,
      },
    });
    const current = createEnvironmentSelection({
      profile: base.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-18T18:59:00.000Z",
      appliedAt: "2026-07-18T18:59:01.000Z",
    });
    const requested = createEnvironmentSelection({
      profile: base.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-18T19:00:00.000Z",
    });
    const registry = createEnvironmentProfileRegistry({
      stableDesktopPath: appPath,
      alphaDesktopPath: alphaPath,
      environmentRoot: root,
      selected: current,
      lastKnownWorkingSelection: current,
      stableEvidence: {
        officialVersion: "26.715.31925",
        officialBuild: "5551",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        signatureCheckedAt: "2026-07-18T19:00:00.000Z",
        officialBackendVersion: "0.145.0-alpha.18",
        officialBackendFingerprint: "updated-backend-digest",
        backendVersion: null,
        backendFingerprint: "stale-backend-digest",
        patchedPayloadPath: patchedPath,
        patchedPayloadFingerprint: "stale-patched-digest",
        patchedPayloadBuildable: true,
      },
    });
    writeEnvironmentProfileRegistry(registryFile, registry);
    writeFileSync(join(root, "config.json"), `${JSON.stringify({
      tweaker: { developmentSourceRoot: root },
    })}\n`);
    const adapters = createDefaultEnvironmentAdapters({
      registryFile,
      receiptRoot: join(root, "receipts"),
      configFile: join(root, "config.json"),
      stateFile: join(root, "state.json"),
    }, {
      assertMcpModeReady: () => {},
      executionSourceRoot: () => executionSourceRoot,
      prepareDevelopmentSource: () => {
        calls.push("build-development");
        if (mutateControlPlaneDuringBuild) {
          const cli = join(root, "packages", "installer", "dist", "cli.js");
          mkdirSync(join(cli, ".."), { recursive: true });
          writeFileSync(cli, "changed during build\n");
        }
      },
      loadState: () => ({ registry, current, migratedFromLegacy: false }),
      preparePatchedPayload: (_profile, destination) => {
        calls.push("build-patched");
        mkdirSync(join(destination, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(destination, "Contents", "Resources", "codex"), "updated-backend");
      },
      prepareRuntimeAssets: (destination) => {
        writeRuntimeFixture(destination, "updated runtime\n");
        writeFileSync(join(destination, "same-a.js"), "same\n");
        writeFileSync(join(destination, "same-b.js"), "same\n");
        symlinkSync(requestedRuntimeLinkTarget, join(destination, "selected.js"));
        refreshRuntimeFingerprint(destination);
      },
      prepareManagedRuntime: (_source, destination, provenance) => {
        calls.push("stage-managed");
        if (mutateManagedSourceDuringStage) {
          writeFileSync(join(_source, "package.json"), "{\"changed\":true}\n");
        }
        if (_source === join(root, "managed-runtime", "current")) {
          cpSync(_source, destination, { recursive: true, verbatimSymlinks: true });
          writeFileSync(
            join(destination, ".tweakers-provenance.json"),
            `${JSON.stringify(provenance, null, 2)}\n`,
          );
          return;
        }
        const packaged = join(destination, "packages", "installer", "assets", "runtime");
        writeManagedRuntimeFixture(
          destination,
          "updated runtime\n",
          provenance.sourceRuntimeHash as string,
          provenance,
        );
        writeFileSync(join(packaged, "same-a.js"), "same\n");
        writeFileSync(join(packaged, "same-b.js"), "same\n");
        symlinkSync(managedRuntimeLinkTarget, join(packaged, "selected.js"));
        refreshRuntimeFingerprint(packaged);
      },
      cloneApp: (_source, destination) => {
        mkdirSync(join(destination, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(destination, "Contents", "Resources", "codex"), "updated-backend");
      },
      stageSwapHost: (candidateAppPaths, destination) => {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, "signed swap host");
        return {
          sourceAppPath: candidateAppPaths[0]!,
          digest: fileDigest(destination),
          strict: true,
          designatedRequirement: 'identifier "co.tweakers.swap-host"',
          teamIdentifier: "2DC432GLL2",
          authority: ["Apple Development: Tweakers"],
          certificateLeafHash: null,
        };
      },
      loadSwapHost: () => () => {},
      copyBackend: (_source, destination) => {
        mkdirSync(join(destination, ".."), { recursive: true });
        writeFileSync(destination, "updated-backend");
      },
      readMarker: (path) => path.includes("candidate.app") || path.startsWith(patchedPath) ? "present" : "absent",
      readAsarHeaderHash: () => "a".repeat(64),
      appFingerprint: (path) => path.includes("candidate.app") ? "rebuilt-patched-digest" : "official-app-digest",
      fileFingerprint: () => "updated-backend-digest",
      readDesktopIdentity: () => ({ bundleId: "com.openai.codex", version: "26.715.31925", build: "5551" }),
      verifyOfficial: () => ({
        strict: true,
        gatekeeper: true,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: officialSignatureTeam,
      }),
      verifyPatched: () => ({
        strict: true,
        gatekeeper: false,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: null,
      }),
      readBackendVersion: () => "0.145.0-alpha.18",
      now: () => "2026-07-18T19:00:05.000Z",
    });

    const prepared = await adapters.preparePrerequisites({
      transactionId: "updated-stable-prepare",
      current,
      requested,
      oldMainPid: 26138,
    });

    assert.deepEqual(calls, ["build-development", "build-patched", "stage-managed"]);
    assert.equal(prepared.backend.artifactDigest, "updated-backend-digest");
    assert.equal(prepared.backend.version, "0.145.0-alpha.18");
    assert.equal(prepared.runtime?.targetPath, join(root, "runtime"));
    assert.equal(prepared.runtime?.rollback.existed, false);
    assert.equal(prepared.runtime?.requested.runtimeFingerprint.length, 64);
    assert.equal(prepared.managedRuntime?.targetPath, join(root, "managed-runtime", "current"));
    assert.equal(prepared.managedRuntime?.rollback.existed, false);
    assert.equal(prepared.managedRuntime?.requested.sourceRuntimeHash?.length, 64);
    assert.equal(existsSync(join(root, "runtime")), false, "prepare must not mutate the live runtime");
    assert.equal(
      existsSync(join(root, "managed-runtime", "current")),
      false,
      "prepare must not mutate the managed runtime",
    );

    const receipt = {
      schemaVersion: 1 as const,
      kind: "environment" as const,
      transactionId: "updated-stable-prepare",
      phase: "prepared" as const,
      error: null,
      ownerPid: process.pid,
      source: current,
      requested,
      prepared,
      applied: null,
      oldMainPid: 26138,
      newMainPid: null,
      attempt: 0,
      createdAt: "2026-07-18T19:00:00.000Z",
      updatedAt: "2026-07-18T19:00:05.000Z",
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    };
    adapters.validatePreparedEnvironment({ receipt, prepared });
    const receiptOwnedCli = resolvePreparedEnvironmentCommitCli(
      receipt,
      join(root, "receipts"),
    );
    assert.equal(receiptOwnedCli.cliPath, prepared.managedRuntime!.requested.cliPath);
    assert.equal(
      receiptOwnedCli.cliArtifactDigest,
      prepared.managedRuntime!.requested.cliArtifactDigest,
    );
    const mutableInvokingCli = join(root, "packages", "installer", "dist", "cli.js");
    mkdirSync(join(mutableInvokingCli, ".."), { recursive: true });
    writeFileSync(mutableInvokingCli, "later checkout build\n");
    assert.notEqual(
      receiptOwnedCli.cliPath,
      mutableInvokingCli,
      "submit must remain bound to the receipt-owned CLI after checkout drift",
    );
    writeFileSync(mutableInvokingCli, "export {};\n");
    rmSync(join(prepared.runtime!.requested.artifactPath, "selected.js"));
    symlinkSync("same-b.js", join(prepared.runtime!.requested.artifactPath, "selected.js"));
    assert.throws(
      () => adapters.validatePreparedEnvironment({ receipt, prepared }),
      /requested runtime artifact is missing or changed/,
      "retargeting a symlink must change the full staged-tree digest even when both targets have equal bytes",
    );
    rmSync(join(prepared.runtime!.requested.artifactPath, "selected.js"));
    symlinkSync("same-a.js", join(prepared.runtime!.requested.artifactPath, "selected.js"));
    adapters.validatePreparedEnvironment({ receipt, prepared });
    writeFileSync(join(prepared.runtime!.requested.artifactPath, "main.js"), "tampered runtime\n");
    assert.throws(
      () => adapters.validatePreparedEnvironment({ receipt, prepared }),
      /requested runtime artifact is missing or changed/,
    );
    officialSignatureTeam = "WRONGTEAM";
    assert.throws(
      () => adapters.validatePreparedEnvironment({ receipt, prepared, direction: "rollback" }),
      /rollback desktop signature evidence is missing or changed/,
      "rollback trust must be reverified before the running app is stopped",
    );
    officialSignatureTeam = "2DC432GLL2";
    rmSync(prepared.rollback.desktopArtifactPath, { recursive: true, force: true });
    symlinkSync(appPath, prepared.rollback.desktopArtifactPath);
    assert.throws(
      () => adapters.validatePreparedEnvironment({ receipt, prepared, direction: "rollback" }),
      /rollback desktop artifact uses a symlink alias/,
      "rollback authority cannot alias the live app through a receipt-root symlink",
    );

    const mismatchedExecutionRoot = join(root, "other-checkout");
    mkdirSync(mismatchedExecutionRoot, { recursive: true });
    executionSourceRoot = mismatchedExecutionRoot;
    const callsBeforeMismatch = [...calls];
    await assert.rejects(
      adapters.preparePrerequisites({
        transactionId: "mismatched-execution-root",
        current,
        requested,
        oldMainPid: 26138,
      }),
      /does not own the executing installer/,
    );
    assert.deepEqual(calls, callsBeforeMismatch, "source mismatch must fail before build or candidate staging");
    assert.equal(
      existsSync(join(root, "receipts", "mismatched-execution-root", "prepared", "candidate.app")),
      false,
    );

    executionSourceRoot = root;
    rmSync(join(root, "packages"), { recursive: true, force: true });
    mutateControlPlaneDuringBuild = true;
    await assert.rejects(
      adapters.preparePrerequisites({
        transactionId: "stale-executing-control-plane",
        current,
        requested,
        oldMainPid: 26138,
      }),
      /control-plane bytes changed during the candidate build/,
      "a build that replaces the loaded installer must fail closed until a fresh CLI retries",
    );
    mutateControlPlaneDuringBuild = false;
    rmSync(join(root, "packages"), { recursive: true, force: true });
    mkdirSync(join(sourceCli, ".."), { recursive: true });
    writeFileSync(sourceCli, "export {};\n");
    requestedRuntimeLinkTarget = "../../outside-runtime";
    await assert.rejects(
      adapters.preparePrerequisites({
        transactionId: "escaping-runtime-link",
        current,
        requested,
        oldMainPid: 26138,
      }),
      /requested runtime contains an escaping symlink/,
    );

    requestedRuntimeLinkTarget = "same-a.js";
    managedRuntimeLinkTarget = "same-b.js";
    await assert.rejects(
      adapters.preparePrerequisites({
        transactionId: "cross-runtime-link-drift",
        current,
        requested,
        oldMainPid: 26138,
      }),
      /were not built from the same assets/,
      "active and managed runtime equality must include symlink targets",
    );
    managedRuntimeLinkTarget = "same-a.js";
    mutateManagedSourceDuringStage = true;
    await assert.rejects(
      adapters.preparePrerequisites({
        transactionId: "managed-source-stage-drift",
        current,
        requested,
        oldMainPid: 26138,
      }),
      /Managed runtime source changed while its candidate artifact was being staged/,
    );
    mutateManagedSourceDuringStage = false;
    const developmentRoot = join(root, "registered-development");
    mkdirSync(developmentRoot, { recursive: true });
    writeFileSync(join(developmentRoot, "package.json"), "{}\n");
    const developmentHash = hashTree(developmentRoot, false);
    const managedSource = join(root, "managed-runtime", "current");
    const managedPackagedRuntime = join(
      managedSource,
      "packages",
      "installer",
      "assets",
      "runtime",
    );
    writeManagedRuntimeFixture(managedSource, "updated runtime\n", developmentHash);
    writeFileSync(join(managedPackagedRuntime, "same-a.js"), "same\n");
    writeFileSync(join(managedPackagedRuntime, "same-b.js"), "same\n");
    symlinkSync("same-a.js", join(managedPackagedRuntime, "selected.js"));
    refreshRuntimeFingerprint(managedPackagedRuntime);
    const stableProvenance = {
      kind: "github-release",
      ref: "v1.0.0",
      installedAt: "2026-07-18T18:00:00.000Z",
      sourceRuntimeHash: developmentHash,
      releaseAsset: "tweakers-v1.0.0.tgz",
    };
    writeFileSync(
      join(managedSource, ".tweakers-provenance.json"),
      `${JSON.stringify(stableProvenance, null, 2)}\n`,
    );
    writeFileSync(join(root, "config.json"), `${JSON.stringify({
      tweaker: { developmentSourceRoot: developmentRoot },
    })}\n`);
    executionSourceRoot = managedSource;
    const callsBeforeStable = calls.length;
    const stablePrepared = await adapters.preparePrerequisites({
      transactionId: "stable-provenance",
      current,
      requested,
      oldMainPid: 26138,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(
        join(stablePrepared.managedRuntime!.requested.artifactPath, ".tweakers-provenance.json"),
        "utf8",
      )),
      stableProvenance,
      "current managed-runtime promotion must preserve the complete stable provenance",
    );
    assert.deepEqual(
      calls.slice(callsBeforeStable),
      ["build-patched", "stage-managed"],
      "a current managed runtime must not be relabeled or rebuilt as development",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit bundled-derived receipt controls backend selection while every patched payload rebuilds with its runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-bundled-derived-"));
  const appPath = join(root, "Applications", "ChatGPT.app");
  const alphaPath = join(root, "Applications", "ChatGPT (Beta).app");
  const patchedPath = join(root, "mode", "patched-payload", "ChatGPT.app");
  const registryFile = join(root, "environment-registry.json");
  const receiptFile = join(root, "codex-source", "receipt.json");
  const derivedBinary = join(root, "codex-source", "codex");
  const derivedFingerprint = "d".repeat(64);
  const derivedVersion = "0.145.0-alpha.18";
  let buildCalls = 0;
  try {
    for (const path of [appPath, patchedPath]) {
      mkdirSync(join(path, "Contents", "Resources"), { recursive: true });
    }
    mkdirSync(join(patchedPath, "Contents", "Resources", "tweakers", "native"), { recursive: true });
    mkdirSync(join(receiptFile, ".."), { recursive: true });
    writeFileSync(join(appPath, "Contents", "Resources", "codex"), "stock-backend");
    writeFileSync(join(patchedPath, "Contents", "Resources", "codex"), "stale-derived-backend");
    writeFileSync(
      join(patchedPath, "Contents", "Resources", "tweakers", "native", "tweaker_native_host.node"),
      "host",
    );
    writeFileSync(receiptFile, "{}\n");
    writeFileSync(derivedBinary, "derived-backend");
    writeManagedRuntimeFixture(root);

    const registry = createEnvironmentProfileRegistry({
      stableDesktopPath: appPath,
      alphaDesktopPath: alphaPath,
      environmentRoot: root,
      stableEvidence: {
        officialVersion: "26.715.31925",
        officialBuild: "5551",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        signatureCheckedAt: "2026-07-19T17:00:00.000Z",
        officialBackendVersion: derivedVersion,
        officialBackendFingerprint: "stock-backend-digest",
        patchedPayloadPath: patchedPath,
        patchedPayloadFingerprint: "patched-payload-digest",
        patchedPayloadBuildable: true,
      },
    });
    const current = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-19T17:00:00.000Z",
      appliedAt: "2026-07-19T17:00:01.000Z",
    });
    const requested = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-19T17:01:00.000Z",
    });
    const selectedRegistry = { ...registry, selected: current, lastKnownWorkingSelection: current };
    writeEnvironmentProfileRegistry(registryFile, selectedRegistry);

    const descriptor = (version = derivedVersion) => ({
      binaryPath: derivedBinary,
      version,
      fingerprint: derivedFingerprint,
      receiptPath: receiptFile,
      transactionId: "bundled-derived-control",
    });
    const makeAdapters = (input: {
      transactionRoot: string;
      configuredReceipt: boolean;
      descriptorVersion?: string;
      candidateFingerprint: string;
      candidateVersion: string;
    }) => createDefaultEnvironmentAdapters({
      registryFile,
      receiptRoot: join(root, input.transactionRoot),
      configFile: join(root, "config.json"),
      stateFile: join(root, "state.json"),
      sourceRoot: root,
      ...(input.configuredReceipt ? { bundledDerivedReceiptFile: receiptFile } : {}),
    }, {
      assertMcpModeReady: () => {},
      loadState: () => ({ registry: selectedRegistry, current, migratedFromLegacy: false }),
      readBundledDerivedArtifact: () => descriptor(input.descriptorVersion),
      preparePatchedPayload: (_profile, destination, runtimeDestination, bundledDerivedBackend) => {
        buildCalls += 1;
        assert.equal(
          bundledDerivedBackend?.fingerprint,
          input.configuredReceipt ? derivedFingerprint : undefined,
        );
        mkdirSync(join(destination, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(destination, "Contents", "Resources", "codex"), "derived-backend");
        writeRuntimeFixture(runtimeDestination);
      },
      prepareManagedRuntime: (_source, destination, provenance) => {
        writeManagedRuntimeFixture(destination, "runtime\n", provenance.sourceRuntimeHash ?? undefined, provenance);
      },
      cloneApp: (source, destination) => cpSync(source, destination, { recursive: true }),
      copyBackend: (source, destination) => {
        mkdirSync(join(destination, ".."), { recursive: true });
        cpSync(source, destination);
      },
      readMarker: (path) => path.startsWith(patchedPath) || path.includes("candidate.app") ? "present" : "absent",
      readAsarHeaderHash: () => "a".repeat(64),
      appFingerprint: (path) => path === patchedPath
        ? "patched-payload-digest"
        : path.includes("candidate.app")
          ? "prepared-payload-digest"
          : "stock-payload-digest",
      fileFingerprint: (path) => path.startsWith(patchedPath)
        ? "stale-derived-digest"
        : path.includes("candidate.app") || path.includes("requested-codex")
          ? input.candidateFingerprint
          : "stock-backend-digest",
      readDesktopIdentity: () => ({ bundleId: "com.openai.codex", version: "26.715.31925", build: "5551" }),
      verifyPatched: () => ({
        strict: true,
        gatekeeper: false,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: null,
      }),
      verifyOfficial: () => ({
        strict: true,
        gatekeeper: true,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: "2DC432GLL2",
      }),
      readBackendVersion: (path) => path.startsWith(patchedPath)
        ? "0.145.0-alpha.17"
        : path.includes("candidate.app") || path.includes("requested-codex")
          ? input.candidateVersion
          : derivedVersion,
      now: () => "2026-07-19T17:01:05.000Z",
    });

    const derivedAdapters = makeAdapters({
      transactionRoot: "derived-receipts",
      configuredReceipt: true,
      candidateFingerprint: derivedFingerprint,
      candidateVersion: derivedVersion,
    });
    const prepared = await derivedAdapters.preparePrerequisites({
      transactionId: "derived-rebuild",
      current,
      requested,
      oldMainPid: 101,
    });
    assert.equal(buildCalls, 1, "a stale reusable payload must rebuild for the configured derived fingerprint");
    assert.equal(prepared.backend.artifactDigest, derivedFingerprint);
    assert.equal(prepared.backend.version, derivedVersion);
    assert.equal(prepared.backend.lane, "bundled", "the derived control must not become a managed lane");

    const mismatchedVersionAdapters = makeAdapters({
      transactionRoot: "mismatch-receipts",
      configuredReceipt: true,
      descriptorVersion: "0.144.6",
      candidateFingerprint: derivedFingerprint,
      candidateVersion: derivedVersion,
    });
    await assert.rejects(
      () => mismatchedVersionAdapters.preparePrerequisites({
        transactionId: "derived-version-mismatch",
        current,
        requested,
        oldMainPid: 101,
      }),
      /does not match desktop control/,
    );

    const defaultAdapters = makeAdapters({
      transactionRoot: "default-receipts",
      configuredReceipt: false,
      candidateFingerprint: "stock-backend-digest",
      candidateVersion: derivedVersion,
    });
    const defaultPrepared = await defaultAdapters.preparePrerequisites({
      transactionId: "default-reuse",
      current,
      requested,
      oldMainPid: 101,
    });
    assert.equal(buildCalls, 2, "the default bundled backend still rebuilds the coupled patched payload and runtime");
    assert.equal(defaultPrepared.backend.artifactDigest, "stock-backend-digest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare rebuilds a stale patched Alpha payload and installs its managed backend before confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-alpha-prepare-"));
  const stablePath = join(root, "Applications", "ChatGPT.app");
  const alphaPath = join(root, "Applications", "ChatGPT (Beta).app");
  const registryFile = join(root, "environment-registry.json");
  const stalePatchedAlpha = join(root, "environments", "alpha", "patched", "ChatGPT.app");
  const calls: string[] = [];
  try {
    mkdirSync(stablePath, { recursive: true });
    mkdirSync(stalePatchedAlpha, { recursive: true });
    const sourceCli = join(root, "packages", "installer", "dist", "cli.js");
    mkdirSync(join(sourceCli, ".."), { recursive: true });
    writeFileSync(sourceCli, "export {};\n");
    const base = createEnvironmentProfileRegistry({
      stableDesktopPath: stablePath,
      alphaDesktopPath: alphaPath,
      environmentRoot: root,
      alphaEvidence: {
        officialVersion: "26.717.1",
        officialBuild: "6001",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex.beta"',
        signatureCheckedAt: "2026-07-17T02:00:00.000Z",
        patchedPayloadFingerprint: "stale-alpha-digest",
        backendInstallable: true,
        patchedPayloadBuildable: true,
      },
    });
    const current = createEnvironmentSelection({
      profile: base.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-17T01:00:00.000Z",
      appliedAt: "2026-07-17T01:00:01.000Z",
    });
    const registry = createEnvironmentProfileRegistry({
      stableDesktopPath: stablePath,
      alphaDesktopPath: alphaPath,
      environmentRoot: root,
      selected: current,
      lastKnownWorkingSelection: current,
      alphaEvidence: {
        officialVersion: "26.717.1",
        officialBuild: "6001",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex.beta"',
        signatureCheckedAt: "2026-07-17T02:00:00.000Z",
        patchedPayloadFingerprint: "stale-alpha-digest",
        backendInstallable: true,
        patchedPayloadBuildable: true,
      },
    });
    const requested = createEnvironmentSelection({
      profile: registry.profiles.alpha,
      appExperience: "tweakers",
      requestedAt: "2026-07-17T02:00:00.000Z",
    });
    writeEnvironmentProfileRegistry(registryFile, registry);
    const adapters = createDefaultEnvironmentAdapters({
      registryFile,
      receiptRoot: join(root, "receipts"),
      configFile: join(root, "config.json"),
      stateFile: join(root, "state.json"),
      sourceRoot: root,
    }, {
      assertMcpModeReady: () => {},
      cloneApp: (_source, destination) => {
        mkdirSync(join(destination, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(destination, "Contents", "Resources", "codex"), "stable-backend");
      },
      copyBackend: (_source, destination) => {
        mkdirSync(join(destination, ".."), { recursive: true });
        writeFileSync(destination, "backend");
      },
      preparePatchedPayload: (_profile, destination) => {
        calls.push("build-patched-alpha");
        mkdirSync(join(destination, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(destination, "Contents", "Resources", "codex"), "patched-alpha");
      },
      prepareRuntimeAssets: (destination) => {
        writeRuntimeFixture(destination, "alpha runtime\n");
      },
      prepareManagedRuntime: (_source, destination, provenance) => {
        writeManagedRuntimeFixture(
          destination,
          "alpha runtime\n",
          provenance.sourceRuntimeHash as string,
          provenance,
        );
      },
      prepareManagedBackend: (_profile, destination) => {
        calls.push("install-managed-alpha");
        mkdirSync(join(destination, ".."), { recursive: true });
        writeFileSync(destination, "managed-alpha");
      },
      readMarker: (path) => path.includes("candidate.app") || path === join(stalePatchedAlpha, "Contents", "Resources", "app.asar")
        ? "present"
        : "absent",
      readAsarHeaderHash: () => "a".repeat(64),
      appFingerprint: (path) => path.includes("candidate.app")
        ? "built-alpha-digest"
        : path === stalePatchedAlpha
          ? "stale-alpha-digest"
          : "stable-rollback-digest",
      fileFingerprint: (path) => path.includes("requested-codex") ? "managed-alpha-digest" : "stable-backend-digest",
      readDesktopIdentity: (path) => path.includes("candidate.app")
        ? { bundleId: "com.openai.codex.beta", version: "26.717.1", build: "6001" }
        : path === stalePatchedAlpha
          ? { bundleId: "com.openai.codex.beta", version: "26.716.9", build: "5999" }
          : { bundleId: "com.openai.codex", version: "26.707.1", build: "5900" },
      verifyPatched: () => ({
        strict: true,
        gatekeeper: false,
        designatedRequirement: 'designated => identifier "com.openai.codex.beta"',
        teamIdentifier: null,
      }),
      verifyOfficial: () => ({
        strict: true,
        gatekeeper: true,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: "2DC432GLL2",
      }),
      readBackendVersion: (path) => path.includes("requested-codex") ? "0.145.0-alpha.3" : "0.144.0",
      now: () => "2026-07-17T02:00:05.000Z",
    });

    const prepared = await adapters.preparePrerequisites({ transactionId: "alpha-prepare", current, requested, oldMainPid: 101 });
    assert.deepEqual(calls, ["build-patched-alpha", "install-managed-alpha"]);
    assert.equal(prepared.candidate.artifactDigest, "built-alpha-digest");
    assert.equal(prepared.backend.artifactDigest, "managed-alpha-digest");
    assert.equal(prepared.backend.lane, "managed-alpha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed Alpha preparer uses the runtime manager and stages only its validated binary", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-managed-alpha-preparer-"));
  const binary = join(root, "managed", "codex");
  const destination = join(root, "prepared", "codex");
  const calls: string[] = [];
  try {
    mkdirSync(join(root, "managed"), { recursive: true });
    writeFileSync(binary, "validated-alpha");
    const profile = createEnvironmentProfileRegistry({
      stableDesktopPath: join(root, "Applications", "ChatGPT.app"),
      alphaDesktopPath: join(root, "Applications", "ChatGPT (Beta).app"),
      environmentRoot: root,
      alphaEvidence: {
        officialVersion: "26.717.1",
        officialBuild: "6001",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex.beta"',
        signatureCheckedAt: "2026-07-17T02:00:00.000Z",
        backendInstallable: true,
        patchedPayloadBuildable: true,
      },
    }).profiles.alpha;
    const prepare = createManagedAlphaBackendPreparer({
      installBeta: async () => { calls.push("install"); },
      validateCurrent: async () => {
        calls.push("validate");
        return { valid: true, binary };
      },
    }, {
      readBackendVersion: () => "0.145.0-alpha.3",
    });
    await prepare(profile, destination);
    assert.deepEqual(calls, ["install", "validate"]);
    assert.equal(readFileSync(destination, "utf8"), "validated-alpha");
    assert.deepEqual(environmentPreparationCapabilities("darwin", "arm64"), {
      patchedPayloadBuildable: true,
      backendInstallable: true,
    });
    assert.equal(environmentPreparationCapabilities("darwin", "x64").backendInstallable, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("visible window waits for a later health proof without consuming the one allowed relaunch retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-health-race-"));
  const { current, requested } = selections();
  const observations = [
    { pid: 101, visibleWindow: true },
    { pid: 202, visibleWindow: true },
    { pid: 202, visibleWindow: true },
  ];
  let proofs = 0;
  let reopens = 0;
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "environment.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 2,
      verificationIntervalMs: 0,
    }, {
      now: () => "2026-07-17T02:00:10.000Z",
      createId: () => "health-race",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      validatePreparedEnvironment: () => {},
      applyPreparedEnvironment: () => {},
      reopenDesktop: () => { reopens += 1; },
      proveAppliedEnvironment: () => (++proofs === 1 ? null : appliedEvidence(requested)),
      sleep: async () => {},
    });
    const prepared = await coordinator.prepare({ current, requested });
    const committed = await coordinator.commit(prepared.transactionId);
    assert.equal(committed.phase, "committed");
    assert.equal(committed.attempt, 1);
    assert.equal(proofs, 2);
    assert.equal(reopens, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a concurrent environment prepare is refused while the durable receipt is active", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-concurrent-"));
  const { current, requested } = selections();
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "environment.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
    }, {
      createId: () => "concurrent",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 101, visibleWindow: true }),
    });
    await coordinator.prepare({ current, requested });
    await assert.rejects(
      coordinator.prepare({ current, requested }),
      /is still prepared/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead pre-cutover owner is cancelled before a new environment prepare", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-dead-owner-"));
  const transactionFile = join(root, "environment.json");
  const receiptRoot = join(root, "receipts");
  const { current, requested } = selections();
  try {
    const staleCoordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot,
      selectionFile: join(root, "selection.json"),
    }, {
      createId: () => "stale-owner",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 101, visibleWindow: true }),
    });
    const stale = await staleCoordinator.prepare({ current, requested });
    writeEnvironmentTransactionReceipt(transactionFile, { ...stale, ownerPid: 4242 });

    const freshCoordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot,
      selectionFile: join(root, "selection.json"),
    }, {
      createId: () => "fresh-owner",
      processAlive: () => false,
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 102, visibleWindow: true }),
    });
    const fresh = await freshCoordinator.prepare({ current, requested });

    assert.equal(fresh.transactionId, "fresh-owner");
    assert.equal(fresh.phase, "prepared");
    const archived = readEnvironmentTransactionReceipt(join(receiptRoot, "stale-owner.json"));
    assert.equal(archived?.phase, "cancelled");
    assert.match(archived?.error ?? "", /owner PID 4242 exited/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback polls until the restored app is activated and its state is proven", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-rollback-readiness-"));
  const { current, requested } = selections();
  const observations = [
    { pid: 101, visibleWindow: true },
    null,
    null,
    { pid: 303, visibleWindow: false },
    { pid: 304, visibleWindow: true },
  ];
  let sleeps = 0;
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile: join(root, "environment.json"),
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 3,
      verificationIntervalMs: 1,
    }, {
      createId: () => "rollback-readiness",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: ({ direction }) => {
        if (direction === "requested") throw new Error("requested apply failed");
      },
      reopenDesktop: () => {},
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      sleep: async () => { sleeps += 1; },
    });
    const prepared = await coordinator.prepare({ current, requested });
    const rolledBack = await coordinator.commit(prepared.transactionId);
    assert.equal(rolledBack.phase, "rolled-back");
    assert.equal(rolledBack.newMainPid, 304);
    assert.equal(sleeps, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback validates recovery evidence before observing or stopping the running target", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-rollback-preflight-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const { current, requested } = selections();
  const prepared = preparedEvidence(current, requested);
  const quits: number[] = [];
  let observations = 0;
  try {
    writeEnvironmentTransactionReceipt(transactionFile, {
      schemaVersion: 1,
      kind: "environment",
      transactionId: "rollback-preflight",
      phase: "verifying",
      error: "requested proof failed",
      ownerPid: process.pid,
      source: current,
      requested,
      prepared,
      applied: null,
      oldMainPid: null,
      newMainPid: 202,
      attempt: 1,
      createdAt: "2026-07-17T02:00:00.000Z",
      updatedAt: "2026-07-17T02:00:09.000Z",
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    });
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      validatePreparedEnvironment: ({ direction }) => {
        assert.equal(direction, "rollback");
        throw new Error("rollback snapshot changed");
      },
      observeDesktop: () => {
        observations += 1;
        return { pid: 202, visibleWindow: true };
      },
      quitDesktop: (_path, pid) => { quits.push(pid); },
      processAlive: () => false,
      cleanupHelpers: () => {},
      sleep: async () => {},
    });

    const failed = await coordinator.rollback("rollback-preflight");
    assert.equal(failed.phase, "failed");
    assert.match(failed.error ?? "", /rollback snapshot changed/);
    assert.equal(observations, 0);
    assert.deepEqual(quits, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback validation ignores a corrupt requested artifact and restores only rollback evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-rollback-direction-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const { current, requested } = selections();
  const prepared = preparedEvidence(current, requested);
  const validationDirections: Array<"requested" | "rollback" | undefined> = [];
  const observations = [
    { pid: 202, visibleWindow: true },
    { pid: 303, visibleWindow: true },
  ];
  try {
    writeEnvironmentTransactionReceipt(transactionFile, {
      schemaVersion: 1,
      kind: "environment",
      transactionId: "rollback-direction",
      phase: "verifying",
      error: "requested artifact is corrupt",
      ownerPid: process.pid,
      source: current,
      requested,
      prepared,
      applied: null,
      oldMainPid: null,
      newMainPid: 202,
      attempt: 1,
      createdAt: "2026-07-17T02:00:00.000Z",
      updatedAt: "2026-07-17T02:00:09.000Z",
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    });
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      validatePreparedEnvironment: ({ direction }) => {
        validationDirections.push(direction);
        if (direction !== "rollback") throw new Error("corrupt requested artifact");
      },
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: ({ direction }) => { assert.equal(direction, "rollback"); },
      reopenDesktop: () => {},
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      publishSelection: () => {},
      sleep: async () => {},
    });

    const rolledBack = await coordinator.rollback("rollback-direction");
    assert.equal(rolledBack.phase, "rolled-back");
    assert.deepEqual(validationDirections, ["rollback"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback application failure ends in a durable failed receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-rollback-fail-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const { current, requested } = selections();
  const observations = [
    { pid: 101, visibleWindow: true },
    { pid: 201, visibleWindow: true },
    { pid: 202, visibleWindow: true },
    { pid: 202, visibleWindow: true },
  ];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      createId: () => "rollback-fail",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => observations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      applyPreparedEnvironment: ({ direction }) => {
        if (direction === "rollback") throw new Error("rollback artifact rejected");
      },
      reopenDesktop: () => {},
      proveAppliedEnvironment: () => null,
      sleep: async () => {},
    });
    const prepared = await coordinator.prepare({ current, requested });
    const failed = await coordinator.commit(prepared.transactionId);
    assert.equal(failed.phase, "failed");
    assert.match(failed.error ?? "", /rollback failed: rollback artifact rejected/);
    assert.equal(existsSync(join(root, "receipts", "rollback-fail.json")), true);

    await assert.rejects(
      coordinator.prepare({ current, requested }),
      /rollback-fail.*failed during rollback.*explicit recovery/i,
    );
    assert.equal(coordinator.status()?.transactionId, "rollback-fail");
    assert.equal(coordinator.status()?.phase, "failed");

    const recoveryObservations = [
      null,
      null,
      { pid: 303, visibleWindow: true },
    ];
    const recovery = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      observeDesktop: () => recoveryObservations.shift() ?? null,
      quitDesktop: () => {},
      processAlive: () => false,
      cleanupHelpers: () => {},
      validatePreparedEnvironment: () => {},
      applyPreparedEnvironment: () => {},
      reopenDesktop: () => {},
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      publishSelection: () => {},
      sleep: async () => {},
    });
    const recovered = await recovery.rollback(failed.transactionId);
    assert.equal(recovered.transactionId, failed.transactionId);
    assert.equal(recovered.phase, "rolled-back");
    assert.equal(recovered.newMainPid, 303);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd commit helper submission records the exact external command and durable receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-helper-"));
  const receiptFile = join(root, "helper.json");
  const managedRuntimeArtifactPath = join(root, "managed-runtime");
  const cliPath = join(managedRuntimeArtifactPath, "cli.js");
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    mkdirSync(managedRuntimeArtifactPath, { recursive: true });
    writeFileSync(cliPath, "process.exit(0);\n");
    const receipt = submitEnvironmentCommitHelper({
      transactionId: "environment-123",
      cliPath,
      cliArtifactDigest: fileDigest(cliPath),
      managedRuntimeArtifactPath,
      managedRuntimeArtifactDigest: fingerprintDirectoryTree(managedRuntimeArtifactPath),
      userRoot: root,
      receiptFile,
      now: "2026-07-17T02:00:00.000Z",
    }, {
      submit: (command, args) => {
        calls.push({ command, args });
        return { status: 0, output: "" };
      },
    });
    assert.equal(receipt.phase, "submitted");
    assert.equal(receipt.outcomeFile, join(root, "co.tweakers.environment.environment-123.outcome.json"));
    assert.equal(receipt.stdoutFile, join(root, "co.tweakers.environment.environment-123.stdout.log"));
    assert.equal(receipt.stderrFile, join(root, "co.tweakers.environment.environment-123.stderr.log"));
    assert.deepEqual(calls, [{
      command: "launchctl",
      args: [
        "submit",
        "-l",
        "co.tweakers.environment.environment-123",
        "-o",
        join(root, "co.tweakers.environment.environment-123.stdout.log"),
        "-e",
        join(root, "co.tweakers.environment.environment-123.stderr.log"),
        "--",
        "/bin/sh",
        join(root, "co.tweakers.environment.environment-123.sh"),
      ],
    }]);
    assert.deepEqual(readEnvironmentCommitHelperReceipt(receiptFile), receipt);
    assert.deepEqual(readEnvironmentCommitHelperOutcome(receipt.outcomeFile), {
      schemaVersion: 1,
      kind: "environment-commit-helper-outcome",
      transactionId: "environment-123",
      label: "co.tweakers.environment.environment-123",
      phase: "not-started",
      pid: null,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
    });
    const wrapper = readFileSync(receipt.wrapperFile, "utf8");
    assert.match(wrapper, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(wrapper, new RegExp(cliPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(wrapper, /EXPECTED_CLI_SHA=/);
    assert.match(wrapper, /EXPECTED_MANAGED_RUNTIME_SHA=/);
    assert.match(wrapper, /shasum -a 256/);
    assert.match(wrapper, /environment.*commit.*--transaction/);
    assert.match(wrapper, /export TWEAKERS_HOME=/);
    assert.match(wrapper, /export TWEAKER_HOME=/);
    assert.match(wrapper, /export TWEAKERS_USER_ROOT=/);
    assert.match(wrapper, /export TWEAKER_USER_ROOT=/);
    assert.match(wrapper, /export CODEX_PLUSPLUS_USER_ROOT=/);
    assert.match(wrapper, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(wrapper, /trap cleanup EXIT HUP INT TERM/);
    assert.match(wrapper, /environment-commit-helper-outcome/);
    assert.match(wrapper, /launchctl remove/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment helper submission is same-process exclusive, idempotent while fresh, and recoverable when stale", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-helper-idempotent-"));
  const receiptFile = join(root, "helper.json");
  const managedRuntimeArtifactPath = join(root, "managed-runtime");
  const cliPath = join(managedRuntimeArtifactPath, "cli.js");
  mkdirSync(managedRuntimeArtifactPath, { recursive: true });
  writeFileSync(cliPath, "process.exit(0);\n");
  const input = {
    transactionId: "environment-idempotent",
    cliPath,
    cliArtifactDigest: fileDigest(cliPath),
    managedRuntimeArtifactPath,
    managedRuntimeArtifactDigest: fingerprintDirectoryTree(managedRuntimeArtifactPath),
    userRoot: root,
    receiptFile,
    staleAfterMs: 1_000,
  } as const;
  let submits = 0;
  try {
    const first = submitEnvironmentCommitHelper({
      ...input,
      now: "2026-07-17T02:00:00.000Z",
    }, {
      submit: () => {
        submits += 1;
        assert.throws(() => submitEnvironmentCommitHelper({
          ...input,
          now: "2026-07-17T02:00:00.000Z",
        }), /already being submitted.*PID/i);
        return { status: 0, output: "" };
      },
    });
    const reused = submitEnvironmentCommitHelper({
      ...input,
      now: "2026-07-17T02:00:00.500Z",
    }, {
      submit: () => {
        submits += 1;
        return { status: 0, output: "" };
      },
    });
    assert.deepEqual(reused, first);
    assert.equal(submits, 1);

    writeFileSync(first.outcomeFile, `${JSON.stringify({
      schemaVersion: 1,
      kind: "environment-commit-helper-outcome",
      transactionId: input.transactionId,
      label: first.label,
      phase: "running",
      pid: 4242,
      startedAt: "2026-07-17T02:00:00.000Z",
      heartbeatAt: "2026-07-17T02:00:00.000Z",
      finishedAt: null,
      exitCode: null,
      error: null,
    })}\n`);
    const live = submitEnvironmentCommitHelper({
      ...input,
      now: "2026-07-17T02:00:02.000Z",
    }, {
      processAlive: (pid) => pid === 4242,
      remove: () => { throw new Error("must not remove a live helper"); },
      submit: () => { throw new Error("must not replace a live helper"); },
    });
    assert.deepEqual(live, first);

    let removals = 0;
    const recovered = submitEnvironmentCommitHelper({
      ...input,
      now: "2026-07-17T02:00:03.000Z",
    }, {
      processAlive: () => false,
      remove: (label) => {
        assert.equal(label, "co.tweakers.environment.environment-idempotent");
        removals += 1;
      },
      submit: () => {
        submits += 1;
        return { status: 0, output: "" };
      },
    });
    assert.equal(recovered.phase, "submitted");
    assert.equal(recovered.submittedAt, "2026-07-17T02:00:03.000Z");
    assert.equal(removals, 1);
    assert.equal(submits, 2);
    assert.ok(readdirSync(root).some((name) => name.startsWith("helper.json.") && name.endsWith(".previous")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd helper wrapper records the command outcome and removes its executable wrapper", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-helper-run-"));
  const managedRuntimeArtifactPath = join(root, "managed-runtime");
  const cliPath = join(managedRuntimeArtifactPath, "true");
  try {
    mkdirSync(managedRuntimeArtifactPath, { recursive: true });
    cpSync("/usr/bin/true", cliPath);
    chmodSync(cliPath, 0o700);
    const receipt = submitEnvironmentCommitHelper({
      transactionId: "environment-789",
      cliPath,
      cliArtifactDigest: fileDigest(cliPath),
      managedRuntimeArtifactPath,
      managedRuntimeArtifactDigest: fingerprintDirectoryTree(managedRuntimeArtifactPath),
      userRoot: root,
      receiptFile: join(root, "helper.json"),
      now: "2026-07-17T02:00:00.000Z",
    }, {
      submit: () => ({ status: 0, output: "" }),
    });
    const executed = spawnSync("/bin/sh", [receipt.wrapperFile], { encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
    const outcome = readEnvironmentCommitHelperOutcome(receipt.outcomeFile)!;
    assert.equal(outcome.phase, "succeeded");
    assert.equal(outcome.exitCode, 0);
    assert.equal(existsSync(receipt.wrapperFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd helper wrapper refuses receipt-owned CLI drift before commit starts", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-helper-cli-drift-"));
  const managedRuntimeArtifactPath = join(root, "managed-runtime");
  const cliPath = join(managedRuntimeArtifactPath, "cli.sh");
  try {
    mkdirSync(managedRuntimeArtifactPath, { recursive: true });
    writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
    chmodSync(cliPath, 0o700);
    const receipt = submitEnvironmentCommitHelper({
      transactionId: "environment-cli-drift",
      cliPath,
      cliArtifactDigest: fileDigest(cliPath),
      managedRuntimeArtifactPath,
      managedRuntimeArtifactDigest: fingerprintDirectoryTree(managedRuntimeArtifactPath),
      userRoot: root,
      receiptFile: join(root, "helper.json"),
      now: "2026-07-17T02:00:00.000Z",
    }, {
      submit: () => ({ status: 0, output: "" }),
    });
    writeFileSync(cliPath, "#!/bin/sh\nexit 7\n");
    chmodSync(cliPath, 0o700);

    const executed = spawnSync("/bin/sh", [receipt.wrapperFile], { encoding: "utf8" });

    assert.equal(executed.status, 65, executed.stderr);
    const outcome = readEnvironmentCommitHelperOutcome(receipt.outcomeFile)!;
    assert.equal(outcome.phase, "failed");
    assert.equal(outcome.exitCode, 65);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd helper wrapper refuses sibling module drift before the receipt-owned CLI loads", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-helper-module-drift-"));
  const managedRuntimeArtifactPath = join(root, "managed-runtime");
  const cliPath = join(managedRuntimeArtifactPath, "cli.js");
  const commandPath = join(managedRuntimeArtifactPath, "commands", "environment.js");
  const markerPath = join(root, "cli-started");
  try {
    mkdirSync(join(managedRuntimeArtifactPath, "commands"), { recursive: true });
    writeFileSync(join(managedRuntimeArtifactPath, "package.json"), "{\"type\":\"module\"}\n");
    writeFileSync(commandPath, "export const commandVersion = 1;\n");
    writeFileSync(
      cliPath,
      `import "./commands/environment.js";\n`
      + `import { writeFileSync } from "node:fs";\n`
      + `writeFileSync(${JSON.stringify(markerPath)}, "started\\n");\n`,
    );
    const receipt = submitEnvironmentCommitHelper({
      transactionId: "environment-module-drift",
      cliPath,
      cliArtifactDigest: fileDigest(cliPath),
      managedRuntimeArtifactPath,
      managedRuntimeArtifactDigest: fingerprintDirectoryTree(managedRuntimeArtifactPath),
      userRoot: root,
      receiptFile: join(root, "helper.json"),
      now: "2026-07-17T02:00:00.000Z",
    }, {
      submit: () => ({ status: 0, output: "" }),
    });
    writeFileSync(commandPath, "export const commandVersion = 2;\n");

    const executed = spawnSync("/bin/sh", [receipt.wrapperFile], { encoding: "utf8" });

    assert.equal(executed.status, 65, executed.stderr);
    assert.equal(existsSync(markerPath), false);
    const outcome = readEnvironmentCommitHelperOutcome(receipt.outcomeFile)!;
    assert.equal(outcome.phase, "failed");
    assert.equal(outcome.exitCode, 65);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment helper submission rejects stale managed-runtime evidence and helper state inside that tree", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-helper-boundary-"));
  const managedRuntimeArtifactPath = join(root, "managed-runtime");
  const cliPath = join(managedRuntimeArtifactPath, "cli.js");
  const siblingPath = join(managedRuntimeArtifactPath, "environment.js");
  try {
    mkdirSync(managedRuntimeArtifactPath, { recursive: true });
    writeFileSync(cliPath, "process.exit(0);\n");
    writeFileSync(siblingPath, "export const version = 1;\n");
    const cliArtifactDigest = fileDigest(cliPath);
    const managedRuntimeArtifactDigest = fingerprintDirectoryTree(managedRuntimeArtifactPath);
    writeFileSync(siblingPath, "export const version = 2;\n");

    assert.throws(() => submitEnvironmentCommitHelper({
      transactionId: "environment-stale-tree",
      cliPath,
      cliArtifactDigest,
      managedRuntimeArtifactPath,
      managedRuntimeArtifactDigest,
      userRoot: root,
      receiptFile: join(root, "helper.json"),
    }), /managed runtime changed before submission/i);

    writeFileSync(siblingPath, "export const version = 1;\n");
    assert.throws(() => submitEnvironmentCommitHelper({
      transactionId: "environment-helper-inside-tree",
      cliPath,
      cliArtifactDigest,
      managedRuntimeArtifactPath,
      managedRuntimeArtifactDigest: fingerprintDirectoryTree(managedRuntimeArtifactPath),
      userRoot: root,
      receiptFile: join(managedRuntimeArtifactPath, "helper.json"),
    }), /receipt must be outside the immutable managed runtime/i);
    assert.equal(existsSync(join(managedRuntimeArtifactPath, "helper.json.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd helper submission failure is durable and never reports a commit outcome", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-helper-failed-"));
  const receiptFile = join(root, "helper.json");
  const managedRuntimeArtifactPath = join(root, "managed-runtime");
  const cliPath = join(managedRuntimeArtifactPath, "cli");
  try {
    mkdirSync(managedRuntimeArtifactPath, { recursive: true });
    writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
    chmodSync(cliPath, 0o700);
    assert.throws(() => submitEnvironmentCommitHelper({
      transactionId: "environment-456",
      cliPath,
      cliArtifactDigest: fileDigest(cliPath),
      managedRuntimeArtifactPath,
      managedRuntimeArtifactDigest: fingerprintDirectoryTree(managedRuntimeArtifactPath),
      userRoot: root,
      receiptFile,
      now: "2026-07-17T02:00:00.000Z",
    }, {
      submit: () => ({ status: 5, output: "launchd rejected helper" }),
    }), /launchd rejected helper/);
    const receipt = readEnvironmentCommitHelperReceipt(receiptFile)!;
    assert.equal(receipt.phase, "submit-failed");
    assert.equal(receipt.error, "launchd rejected helper");
    const outcome = readEnvironmentCommitHelperOutcome(receipt.outcomeFile)!;
    assert.equal(outcome.phase, "not-started");
    assert.equal(outcome.exitCode, null);
    assert.equal(outcome.error, null);
    assert.equal(existsSync(receipt.wrapperFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt writer rejects malformed prepared and applied evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-invalid-evidence-"));
  const file = join(root, "environment.json");
  const { current, requested } = selections();
  try {
    const evidence = preparedEvidence(current, requested);
    const receipt = {
      schemaVersion: 1 as const,
      kind: "environment" as const,
      transactionId: "invalid-evidence",
      phase: "prepared" as const,
      error: null,
      ownerPid: process.pid,
      source: current,
      requested,
      prepared: evidence,
      applied: null,
      oldMainPid: 101,
      newMainPid: null,
      attempt: 0,
      createdAt: "2026-07-17T02:00:00.000Z",
      updatedAt: "2026-07-17T02:00:00.000Z",
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    };
    evidence.candidate.artifactPath = "relative/candidate.app";
    assert.throws(() => writeEnvironmentTransactionReceipt(file, receipt), /invalid environment transaction receipt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function preparedOnDisk(
  receiptRoot: string,
  transactionId: string,
  current: EnvironmentSelection,
  requested: EnvironmentSelection,
): PreparedEnvironmentEvidence {
  const preparedRoot = join(receiptRoot, transactionId, "prepared");
  const candidateArtifactPath = join(preparedRoot, "candidate.app");
  const rollbackArtifactPath = join(preparedRoot, "rollback.app");
  const candidateBackendArtifact = join(preparedRoot, "backend", "requested-codex");
  const rollbackBackendArtifact = join(preparedRoot, "backend", "rollback-codex");
  mkdirSync(candidateArtifactPath, { recursive: true });
  mkdirSync(rollbackArtifactPath, { recursive: true });
  mkdirSync(join(preparedRoot, "backend"), { recursive: true });
  writeFileSync(candidateBackendArtifact, "candidate-backend");
  writeFileSync(rollbackBackendArtifact, "rollback-backend");
  const base = preparedEvidence(current, requested);
  return {
    ...base,
    candidate: { ...base.candidate, artifactPath: candidateArtifactPath },
    backend: { ...base.backend, artifactPath: candidateBackendArtifact },
    rollback: {
      ...base.rollback,
      desktopArtifactPath: rollbackArtifactPath,
      backendArtifactPath: rollbackBackendArtifact,
    },
  };
}

test("a host-less nonmatching desktop fails preflight before the app is stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-hostless-preflight-"));
  const receiptRoot = join(root, "receipts");
  const transactionFile = join(root, "transactions", "environment.json");
  const stablePath = join(root, "Applications", "ChatGPT.app");
  const alphaPath = join(root, "Applications", "ChatGPT (Beta).app");
  let quitAttempted = false;
  try {
    mkdirSync(stablePath, { recursive: true });
    mkdirSync(alphaPath, { recursive: true });
    const registry = createEnvironmentProfileRegistry({
      stableDesktopPath: stablePath,
      alphaDesktopPath: alphaPath,
      environmentRoot: root,
    });
    const current = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-17T01:00:00.000Z",
      appliedAt: "2026-07-17T01:00:01.000Z",
    });
    const requested = createEnvironmentSelection({
      profile: registry.profiles.alpha,
      appExperience: "chatgpt",
      requestedAt: "2026-07-17T02:00:00.000Z",
    });
    const prepared = preparedOnDisk(receiptRoot, "hostless-preflight", current, requested);
    prepared.rollback.signature = prepared.candidate.signature;

    const adapters = createDefaultEnvironmentAdapters({
      registryFile: join(root, "environment-registry.json"),
      receiptRoot,
      configFile: join(root, "config.json"),
      stateFile: join(root, "state.json"),
      environmentRoot: root,
    }, {
      appFingerprint: (path) => {
        if (path === prepared.candidate.artifactPath) return prepared.candidate.artifactDigest;
        if (path === prepared.rollback.desktopArtifactPath || path === stablePath) {
          return prepared.rollback.desktopArtifactDigest;
        }
        return "unexpected-live-digest";
      },
      fileFingerprint: (path) => (
        path === prepared.backend.artifactPath
          ? prepared.backend.artifactDigest
          : prepared.rollback.backendArtifactDigest
      ),
      readDesktopIdentity: (path) => {
        if (path === prepared.rollback.desktopArtifactPath || path === stablePath) {
          return {
            bundleId: current.selectedDesktopBundleId,
            version: prepared.rollback.desktopVersion,
            build: prepared.rollback.desktopBuild,
          };
        }
        return {
          bundleId: requested.selectedDesktopBundleId,
          version: prepared.candidate.version,
          build: prepared.candidate.build,
        };
      },
      readMarker: () => "absent",
      verifyOfficial: () => prepared.candidate.signature,
    });
    writeEnvironmentTransactionReceipt(transactionFile, {
      schemaVersion: 1,
      kind: "environment",
      transactionId: "hostless-preflight",
      phase: "prepared",
      error: null,
      ownerPid: process.pid,
      source: current,
      requested,
      prepared,
      applied: null,
      oldMainPid: 101,
      newMainPid: null,
      attempt: 0,
      createdAt: "2026-07-17T02:00:00.000Z",
      updatedAt: "2026-07-17T02:00:05.000Z",
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    });
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot,
      selectionFile: join(root, "environment-selection.json"),
      registryFile: join(root, "environment-registry.json"),
      configFile: join(root, "config.json"),
      stateFile: join(root, "state.json"),
      lockFile: join(root, "environment.lock"),
      lifecycleLockFile: join(root, "lifecycle.lock"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      validatePreparedEnvironment: adapters.validatePreparedEnvironment,
      observeDesktop: () => ({ pid: 101, visibleWindow: true }),
      quitDesktop: () => { quitAttempted = true; },
      processAlive: () => false,
      sleep: async () => {},
    });

    await assert.rejects(
      coordinator.commit("hostless-preflight"),
      /has no signed receipt-owned swap host/,
    );
    assert.equal(quitAttempted, false);
    assert.equal(coordinator.status()?.phase, "prepared");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation refuses to replace a live desktop newer than its prepared payload", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-downgrade-"));
  const receiptRoot = join(root, "receipts");
  // The live-payload guard returns early when nothing exists at the desktop
  // path, so the "live" desktop must be a real directory — a hermetic stand-in
  // under the temp root, never the machine's actual /Applications bundle.
  const liveDesktopPath = join(root, "Applications", "ChatGPT.app");
  mkdirSync(liveDesktopPath, { recursive: true });
  // Runtime evidence is only required when Tweakers is involved; this guard is
  // about desktop bytes, so an official-only transition keeps the test focused.
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: liveDesktopPath,
    alphaDesktopPath: join(root, "Applications", "ChatGPT (Beta).app"),
  });
  const current = createEnvironmentSelection({
    profile: registry.profiles.stable,
    appExperience: "chatgpt",
    requestedAt: "2026-07-17T01:00:00.000Z",
    appliedAt: "2026-07-17T01:00:01.000Z",
  });
  const requested = createEnvironmentSelection({
    profile: registry.profiles.alpha,
    appExperience: "chatgpt",
    requestedAt: "2026-07-17T02:00:00.000Z",
  });
  try {
    const prepared = preparedOnDisk(receiptRoot, "downgrade", current, requested);
    const adapters = createDefaultEnvironmentAdapters({
      registryFile: join(root, "registry.json"),
      receiptRoot,
      configFile: join(root, "config.json"),
      stateFile: join(root, "state.json"),
      environmentRoot: root,
    }, {
      // The live desktop advanced past the recorded rollback payload, exactly
      // as an official Sparkle update does to a stranded transaction.
      readDesktopIdentity: () => ({
        bundleId: current.selectedDesktopBundleId,
        version: "26.721.41059",
        build: "5948",
      }),
    });
    const receipt = readEnvironmentTransactionReceipt(join(root, "missing.json")) ?? {
      schemaVersion: 1 as const,
      kind: "environment" as const,
      transactionId: "downgrade",
      phase: "failed" as const,
      error: null,
      ownerPid: 1,
      source: current,
      requested,
      prepared,
      applied: null,
      oldMainPid: null,
      newMainPid: null,
      attempt: 0,
      createdAt: "2026-07-17T02:00:00.000Z",
      updatedAt: "2026-07-17T02:00:00.000Z",
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    };

    assert.throws(
      () => adapters.validatePreparedEnvironment({ receipt, prepared, direction: "rollback" }),
      /Refusing to replace .*the live desktop is 26\.721\.41059 \(build 5948\).*older 26\.707\.1 \(build 5900\)/s,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery finalizes a stranded receipt from whichever direction the machine proves", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-recover-proof-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const { current, requested } = selections();
  const applied: string[] = [];
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      createId: () => "recover-proof",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 4242, visibleWindow: true }),
      applyPreparedEnvironment: ({ direction }) => { applied.push(direction); },
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      publishSelection: () => {},
      sleep: async () => {},
    });
    const prepared = await coordinator.prepare({ current, requested });
    writeEnvironmentTransactionReceipt(transactionFile, {
      ...prepared,
      phase: "failed",
      error: "Rollback requested; rollback failed: No signed staged native host exists in either app payload",
      applied: null,
      newMainPid: null,
      attempt: 2,
    });

    const recovered = await coordinator.recover("recover-proof");

    assert.equal(recovered.phase, "rolled-back");
    assert.equal(recovered.newMainPid, 4242);
    assert.equal(recovered.applied?.selection.appExperience, current.appExperience);
    assert.match(recovered.error ?? "", /Recovered by proving the live rollback environment/);
    assert.match(recovered.error ?? "", /No signed staged native host/);
    // Recovery proves; it never replaces bytes.
    assert.deepEqual(applied, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal recovery keeps the failed lifecycle gate when archive publication fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-terminal-order-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const receiptRoot = join(root, "receipts");
  const { current, requested } = selections();
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot,
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      createId: () => "terminal-order",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 4242, visibleWindow: true }),
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      publishSelection: () => {},
      sleep: async () => {},
    });
    const prepared = await coordinator.prepare({ current, requested });
    writeEnvironmentTransactionReceipt(transactionFile, {
      ...prepared,
      phase: "failed",
      error: "rollback failed",
    });
    rmSync(receiptRoot, { recursive: true, force: true });
    writeFileSync(receiptRoot, "archive path intentionally blocked\n");

    await assert.rejects(
      coordinator.recover("terminal-order"),
      /EEXIST|ENOTDIR|not a directory/i,
    );
    assert.equal(readEnvironmentTransactionReceipt(transactionFile)?.phase, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery adopts a verified newer official desktop without applying any bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-recover-adopt-"));
  const transactionFile = join(root, "transactions", "environment.json");
  // The stranded shape this exists for: an official ChatGPT source that the
  // Sparkle updater advanced while the switch to Tweakers was stuck.
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
  });
  const current = createEnvironmentSelection({
    profile: registry.profiles.stable,
    appExperience: "chatgpt",
    requestedAt: "2026-07-17T01:00:00.000Z",
    appliedAt: "2026-07-17T01:00:01.000Z",
  });
  const requested = createEnvironmentSelection({
    profile: registry.profiles.stable,
    appExperience: "tweakers",
    requestedAt: "2026-07-17T02:00:00.000Z",
  });
  const applied: string[] = [];
  const adoptions: string[] = [];
  let adoptionCommits = 0;
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      createId: () => "recover-adopt",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 5151, visibleWindow: true }),
      applyPreparedEnvironment: ({ direction }) => { applied.push(direction); },
      proveAppliedEnvironment: () => null,
      proveOfficialDesktop: ({ selection, baseline }) => {
        adoptions.push(`${selection.appExperience}:${baseline.build ?? "none"}`);
        return {
          observed: { marketingVersion: "26.721.41059", build: "5948" },
          selection: { ...current, appExperience: "chatgpt" },
          mainPid: 6262,
          state: {} as never,
          registry,
        };
      },
      commitOfficialDesktop: ({ proof }) => {
        adoptionCommits += 1;
        return proof;
      },
      publishSelection: () => {},
      sleep: async () => {},
    });
    const prepared = await coordinator.prepare({ current, requested });
    writeEnvironmentTransactionReceipt(transactionFile, {
      ...prepared,
      phase: "failed",
      error: "Rollback requested; rollback failed: the recorded payload is stale",
      applied: null,
      newMainPid: null,
      attempt: 2,
    });

    const recovered = await coordinator.recover("recover-adopt");

    assert.equal(recovered.phase, "cancelled");
    assert.equal(recovered.newMainPid, 6262);
    assert.notEqual(recovered.cancelledAt, null);
    assert.match(
      recovered.error ?? "",
      /^Recovered by adopting the verified live official ChatGPT update\. Previous failure: /,
    );
    assert.deepEqual(applied, []);
    // Only chatgpt selections can be adopted, and each is offered its own
    // recorded payload as the baseline to advance past.
    assert.deepEqual(adoptions, ["chatgpt:5900"]);
    assert.equal(adoptionCommits, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery refuses to invent an outcome when nothing can be proven", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-recover-unprovable-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const { current, requested } = selections();
  try {
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      createId: () => "recover-unprovable",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 7373, visibleWindow: true }),
      proveAppliedEnvironment: () => null,
      proveOfficialDesktop: () => null,
      publishSelection: () => {},
      sleep: async () => {},
    });
    const prepared = await coordinator.prepare({ current, requested });
    writeEnvironmentTransactionReceipt(transactionFile, {
      ...prepared,
      phase: "failed",
      error: "Rollback requested; rollback failed: nothing usable",
      applied: null,
      newMainPid: null,
      attempt: 2,
    });

    await assert.rejects(
      coordinator.recover("recover-unprovable"),
      /could not be recovered from live evidence/,
    );
    assert.equal(coordinator.status()?.phase, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy receipts gain receipt-owned swap evidence before recovery touches the app", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-swap-migration-"));
  const transactionFile = join(root, "transactions", "environment.json");
  const { current, requested } = selections();
  const migrations: string[] = [];
  const quits: string[] = [];
  try {
    const swapHost = {
      path: join(root, "receipts", "swap-migration", "prepared", "swap", "tweaker_native_host.node"),
      sourceAppPath: join(root, "receipts", "swap-migration", "prepared", "candidate.app"),
      digest: "a".repeat(64),
      strict: true as const,
      designatedRequirement: 'designated => certificate leaf = H"abc123"',
      teamIdentifier: null,
      authority: ["Tweakers Local Signing"],
      certificateLeafHash: "abc123",
    };
    const coordinator = createEnvironmentCoordinator({
      transactionFile,
      receiptRoot: join(root, "receipts"),
      selectionFile: join(root, "selection.json"),
      verificationPolls: 1,
      verificationIntervalMs: 0,
    }, {
      createId: () => "swap-migration",
      preparePrerequisites: () => preparedEvidence(current, requested),
      observeDesktop: () => ({ pid: 8484, visibleWindow: true }),
      quitDesktop: (path) => { quits.push(path); },
      processAlive: () => false,
      migrateSwapHost: ({ receipt }) => {
        migrations.push(receipt.transactionId);
        return swapHost;
      },
      proveAppliedEnvironment: ({ direction }) => direction === "rollback"
        ? appliedEvidence(current, "rollback")
        : null,
      publishSelection: () => {},
      sleep: async () => {},
    });
    const prepared = await coordinator.prepare({ current, requested });
    const originalError = "Rollback requested; rollback failed: No signed staged native host exists";
    writeEnvironmentTransactionReceipt(transactionFile, {
      ...prepared,
      phase: "failed",
      error: originalError,
      applied: null,
      newMainPid: null,
      attempt: 2,
    });

    const recovered = await coordinator.recover("swap-migration");

    assert.deepEqual(recovered.prepared?.swapHost, swapHost);
    assert.deepEqual(migrations, ["swap-migration"]);
    // Migration runs before anything can stop the live app.
    assert.deepEqual(quits, []);
    assert.match(recovered.error ?? "", /No signed staged native host exists/);

    // Re-running is a no-op: the evidence is already published.
    const again = await coordinator.recover("swap-migration");
    assert.deepEqual(migrations, ["swap-migration"]);
    assert.equal(again.phase, recovered.phase);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy receipts without asar integrity evidence stay readable when terminal", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-legacy-"));
  const file = join(root, "environment.json");
  const { current, requested } = selections();
  try {
    const prepared = preparedEvidence(current, requested) as Record<string, unknown>;
    delete (prepared.candidate as Record<string, unknown>).asarHeaderHash;
    delete (prepared.rollback as Record<string, unknown>).desktopAsarHeaderHash;
    const applied = appliedEvidence(requested) as Record<string, unknown>;
    delete applied.asarHeaderHash;
    const receipt = {
      schemaVersion: 1,
      kind: "environment",
      transactionId: "legacy-committed",
      phase: "committed",
      error: null,
      ownerPid: 4242,
      source: current,
      requested: { ...requested, appliedAt: "2026-07-17T02:00:10.000Z" },
      prepared,
      applied,
      oldMainPid: 101,
      newMainPid: 202,
      attempt: 1,
      createdAt: "2026-07-17T02:00:05.000Z",
      updatedAt: "2026-07-17T02:00:10.000Z",
      committedAt: "2026-07-17T02:00:10.000Z",
      rolledBackAt: null,
      cancelledAt: null,
    };
    const protectionAxes = ["uiFeatures", "mcpSafetyProvider", "recoveryState", "migrationState", "quarantineReason"];
    for (const selection of [
      receipt.source,
      receipt.requested,
      (receipt.prepared as PreparedEnvironmentEvidence).rollback.selection,
      (receipt.applied as EnvironmentAppliedEvidence).selection,
    ]) {
      for (const axis of protectionAxes) delete (selection as unknown as Record<string, unknown>)[axis];
    }
    writeFileSync(file, `${JSON.stringify(receipt)}\n`);
    // A committed legacy receipt is terminal history; the lifecycle gate must
    // treat it as idle instead of poisoning every refresh with "invalid".
    const normalized = readEnvironmentTransactionReceipt(file);
    assert.equal(normalized?.phase, "committed");
    assert.equal(normalized?.source.migrationState, "migration-blocked");
    assert.equal(normalized?.requested.migrationState, "migration-blocked");

    // The same evidence in an in-flight phase cannot be verified and must
    // stay invalid (fail closed).
    writeFileSync(file, `${JSON.stringify({
      ...receipt,
      phase: "applying",
      applied: null,
      committedAt: null,
      newMainPid: null,
    })}\n`);
    assert.throws(() => readEnvironmentTransactionReceipt(file), /invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
