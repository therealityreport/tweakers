import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEnvironmentProfileRegistry,
  createEnvironmentSelection,
  fingerprintAppContents,
  writeEnvironmentProfileRegistry,
  type EnvironmentSelection,
} from "../src/environment-profile";
import {
  createEnvironmentCoordinator,
  createDefaultEnvironmentAdapters,
  createManagedAlphaBackendPreparer,
  defaultCodexMcpConfigFile,
  ENVIRONMENT_TRANSACTION_PHASES,
  environmentPreparationCapabilities,
  readEnvironmentCommitHelperOutcome,
  readEnvironmentCommitHelperReceipt,
  readEnvironmentTransactionReceipt,
  submitEnvironmentCommitHelper,
  writeEnvironmentTransactionReceipt,
  type EnvironmentAppliedEvidence,
  type PreparedEnvironmentEvidence,
} from "../src/environment-transaction";
import { acquireProcessLock } from "../src/process-lock";

test("default MCP ownership path targets the user's Codex config", () => {
  assert.equal(
    defaultCodexMcpConfigFile("/Users/example"),
    "/Users/example/.codex/config.toml",
  );
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
      backendLane: current.backendLane,
      backendBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      backendArtifactPath: "/tmp/prepared/rollback/codex",
      backendVersion: "0.144.0",
      backendArtifactDigest: "rollback-backend-sha256",
    },
  };
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
    }, {
      assertMcpModeReady: () => {},
      loadState: () => ({ registry: selectedRegistry, current, migratedFromLegacy: false }),
      cloneApp: (source, destination) => cpSync(source, destination, { recursive: true, verbatimSymlinks: true }),
      copyBackend: (source, destination) => cpSync(source, destination),
      readMarker: (asarPath) => asarPath.includes("candidate.app") || asarPath.includes("Codex.app") ? "absent" : "present",
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
    mcpMode: true,
  };
  try {
    mkdirSync(join(root, "backend"), { recursive: true });
    writeFileSync(backendPath, "backend", { flag: "a" });
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
      appFingerprint: () => mutable.desktopDigest,
      fileFingerprint: () => mutable.backendDigest,
      readBackendVersion: () => mutable.backendVersion,
      readBackendLane: () => mutable.lane,
      readAppState: () => ({
        appExperience: requested.appExperience,
        appRoot: mutable.appRoot,
        bundleId: requested.selectedDesktopBundleId,
      }),
      readRuntimeProof: () => ({
        schemaVersion: 1,
        kind: "environment-runtime-proof",
        pid: mutable.runtimePid,
        appRoot: requested.selectedDesktopPath,
        bundleId: requested.selectedDesktopBundleId,
        appExperience: "tweakers",
        releaseProfile: requested.releaseProfile,
        backendLane: "managed-alpha",
        binaryPath: mutable.runtimeBinaryPath,
        backendVersion: prepared.backend.version,
        backendFingerprint: mutable.backendDigest,
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
    mutable.bundleId = "com.openai.codex";
    assert.equal(await prove(), null, "wrong bundle must fail");
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
    mutable.runtimePid = 202;
    mutable.mcpMode = false;
    assert.equal(await prove(), null, "unapplied MCP mode ownership must fail");
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
  let liveMode: "chatgpt" | "tweakers" = "tweakers";
  let liveDigest = "patched-digest";
  let liveBackendDigest = "rollback-backend-digest";
  const writes: string[] = [];
  try {
    for (const path of [appPath, pristinePath, patchedPath]) mkdirSync(path, { recursive: true });
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
        backendVersion: "0.144.0",
        backendFingerprint: "rollback-backend-digest",
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
        backendVersion: "0.144.0",
        backendFingerprint: "rollback-backend-digest",
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
      stateFile: join(root, "state.json"),
    }, {
      assertMcpModeReady: () => {},
      reconcileMcpMode: (appExperience) => { writes.push(`mcp:${appExperience}`); },
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
      readBackendVersion: (path) => path.includes("rollback") ? "0.144.0" : "0.144.0",
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
      writeAppState: (_file, selection) => { writes.push(`state:${selection.appExperience}`); },
      now: () => "2026-07-17T02:00:05.000Z",
    });

    const prepared = await adapters.preparePrerequisites({ transactionId: "default-apply", current, requested, oldMainPid: 101 });
    assert.equal(prepared.candidate.artifactDigest, "pristine-digest");
    assert.equal(prepared.rollback.desktopArtifactDigest, "patched-digest");
    assert.equal(prepared.backend.artifactDigest, "official-backend-digest");
    assert.equal(existsSync(join(receiptRoot, "default-apply", "prepared", "candidate.app")), true);
    assert.equal(existsSync(registryFile), true, "prepare may persist recomputed registry evidence");
    assert.equal(existsSync(join(root, "environment-selection.json")), false);

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
    assert.deepEqual(writes, [
      `replace:${appPath}`,
      "lane:official-bundled",
      "state:chatgpt",
      "mcp:chatgpt",
    ]);
    const payloadMetadata = JSON.parse(readFileSync(
      join(root, "mode", "patched-payload", "payload.json"),
      "utf8",
    )) as { baseVersion: string | null; baseBuild: string | null; parkedAt: string };
    assert.deepEqual(payloadMetadata, {
      schemaVersion: 1,
      baseVersion: "26.707.1",
      baseBuild: "5900",
      patchedAsarHash: null,
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
  try {
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
    const adapters = createDefaultEnvironmentAdapters({
      registryFile,
      receiptRoot: join(root, "receipts"),
      configFile: join(root, "config.json"),
      stateFile: join(root, "state.json"),
    }, {
      assertMcpModeReady: () => {},
      loadState: () => ({ registry, current, migratedFromLegacy: false }),
      preparePatchedPayload: (_profile, destination) => {
        mkdirSync(join(destination, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(destination, "Contents", "Resources", "codex"), "updated-backend");
      },
      cloneApp: (_source, destination) => {
        mkdirSync(join(destination, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(destination, "Contents", "Resources", "codex"), "updated-backend");
      },
      copyBackend: (_source, destination) => {
        mkdirSync(join(destination, ".."), { recursive: true });
        writeFileSync(destination, "updated-backend");
      },
      readMarker: (path) => path.includes("candidate.app") || path.startsWith(patchedPath) ? "present" : "absent",
      appFingerprint: (path) => path.includes("candidate.app") ? "rebuilt-patched-digest" : "official-app-digest",
      fileFingerprint: () => "updated-backend-digest",
      readDesktopIdentity: () => ({ bundleId: "com.openai.codex", version: "26.715.31925", build: "5551" }),
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

    assert.equal(prepared.backend.artifactDigest, "updated-backend-digest");
    assert.equal(prepared.backend.version, "0.145.0-alpha.18");
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
      prepareManagedBackend: (_profile, destination) => {
        calls.push("install-managed-alpha");
        mkdirSync(join(destination, ".."), { recursive: true });
        writeFileSync(destination, "managed-alpha");
      },
      readMarker: (path) => path.includes("candidate.app") || path === join(stalePatchedAlpha, "Contents", "Resources", "app.asar")
        ? "present"
        : "absent",
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
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    const receipt = submitEnvironmentCommitHelper({
      transactionId: "environment-123",
      cliPath: "/usr/local/lib/tweaker/cli.js",
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
    assert.match(wrapper, /\/usr\/local\/lib\/tweaker\/cli\.js/);
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
  const input = {
    transactionId: "environment-idempotent",
    cliPath: "/usr/local/lib/tweaker/cli.js",
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
  try {
    const receipt = submitEnvironmentCommitHelper({
      transactionId: "environment-789",
      cliPath: "/usr/bin/true",
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

test("launchd helper submission failure is durable and never reports a commit outcome", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-helper-failed-"));
  const receiptFile = join(root, "helper.json");
  try {
    assert.throws(() => submitEnvironmentCommitHelper({
      transactionId: "environment-456",
      cliPath: "/usr/local/bin/tweaker",
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
