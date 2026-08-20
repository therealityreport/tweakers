import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  environmentModeCachePaths,
  readCurrentEnvironmentModePair,
  sealEnvironmentModeCacheTree,
} from "../src/environment-mode-cache";
import {
  environment,
  type EnvironmentCommandDependencies,
} from "../src/commands/environment";
import {
  createEnvironmentModeProductionBindings,
  environmentModeCacheV2Enabled,
  resolveEnvironmentModeV2PreparedCommitCli,
  type EnvironmentModeProductionDeps,
} from "../src/environment-mode-production";
import type { ProcessInfo } from "../src/commands/debug";
import type { EnvironmentSelection } from "../src/environment-profile";
import type { PreparedEnvironmentEvidence } from "../src/environment-transaction";
import type { McpModeBridge } from "../src/mcp-mode-bridge";
import {
  environmentWarmCommitJournalFile,
  writeEnvironmentWarmCommitReceipt,
  type EnvironmentWarmCommitReceipt,
} from "../src/environment-warm-commit";

const NOW = "2026-08-18T12:00:00.000Z";
const OPENAI_TEAM = "2DC432GLL2";

interface ProductionFixture {
  root: string;
  current: EnvironmentSelection;
  requested: EnvironmentSelection;
  preparedEvidence(): PreparedEnvironmentEvidence;
  builderTransactionIds: string[];
  helperFile: string;
}

function withFixture(run: (fixture: ProductionFixture) => Promise<void> | void): Promise<void> {
  // The pair cache rejects symlink ancestors. Keep every destructive test
  // artifact below the physical workspace root rather than /tmp -> /var.
  const root = mkdtempSync(join(realpathSync(process.cwd()), ".tweaker-production-v2-"));
  return Promise.resolve()
    .then(() => run(makeFixture(root)))
    .finally(() => { rmSync(root, { recursive: true, force: true }); });
}

function makeFixture(root: string): ProductionFixture {
  const liveApp = join(root, "Applications", "ChatGPT.app");
  const candidateApp = join(root, "prepared-source", "candidate.app");
  const runtimeSource = join(root, "prepared-source", "runtime");
  const managedSource = join(root, "prepared-source", "managed-runtime");
  const backendSource = join(root, "prepared-source", "backend", "codex");
  const nativeHostSource = join(root, "prepared-source", "native", "tweaker_native_host.node");
  const helperFile = join(root, "prepared-source", "mcp-mode-headless.js");
  writeApp(liveApp, "live-chatgpt");
  writeApp(candidateApp, "candidate-tweakers");
  writeTree(runtimeSource, "runtime");
  writeManagedRuntime(managedSource);
  mkdirSync(join(backendSource, ".."), { recursive: true });
  mkdirSync(join(nativeHostSource, ".."), { recursive: true });
  writeFileSync(backendSource, "backend-v2");
  writeFileSync(nativeHostSource, "native-host-v2");
  writeFileSync(helperFile, "export {};\n");

  const current: EnvironmentSelection = {
    selectedDesktopPath: liveApp,
    selectedDesktopBundleId: "com.openai.codex",
    releaseProfile: "stable",
    appExperience: "chatgpt",
    backendLane: "official-bundled",
    uiFeatures: "off",
    mcpSafetyProvider: "official-bundled-degraded",
    recoveryState: "pristine-openai-recovery",
    migrationState: "verified",
    quarantineReason: null,
    requestedAt: NOW,
    appliedAt: NOW,
  };
  const requested: EnvironmentSelection = {
    ...current,
    appExperience: "tweakers",
    backendLane: "bundled",
    uiFeatures: "on",
    mcpSafetyProvider: "managed-turn-idle",
    recoveryState: "normal-protected",
    requestedAt: NOW,
    appliedAt: null,
  };
  const builderTransactionIds: string[] = [];
  const preparedEvidence = (): PreparedEnvironmentEvidence => ({
    preparedAt: NOW,
    candidate: {
      desktopPath: liveApp,
      artifactPath: candidateApp,
      bundleId: "com.openai.codex",
      appExperience: "tweakers",
      releaseProfile: "stable",
      version: "26.818.1",
      build: "9001",
      artifactDigest: directoryDigest(candidateApp),
      asarHeaderHash: fileDigest(asar(candidateApp)),
      signature: {
        strict: true,
        gatekeeper: false,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: null,
      },
    },
    backend: {
      lane: "bundled",
      binaryPath: join(root, "active", "codex"),
      artifactPath: backendSource,
      version: "0.145.0",
      artifactDigest: fileDigest(backendSource),
    },
    swapHost: {
      path: nativeHostSource,
      sourceAppPath: candidateApp,
      digest: fileDigest(nativeHostSource),
      strict: true,
      designatedRequirement: 'designated => identifier "com.tweakers.native-host"',
      teamIdentifier: "TWEAKERS",
      authority: ["Developer ID Application: Tweakers"],
      certificateLeafHash: "a".repeat(64),
    },
    runtime: {
      targetPath: join(root, "runtime"),
      requested: {
        artifactPath: runtimeSource,
        artifactDigest: directoryDigest(runtimeSource),
        runtimeFingerprint: directoryDigest(runtimeSource),
        fileCount: 2,
      },
      rollback: {
        existed: true,
        artifactPath: join(root, "rollback", "runtime"),
        artifactDigest: "b".repeat(64),
        runtimeFingerprint: "b".repeat(64),
        fileCount: 2,
      },
    },
    managedRuntime: {
      targetPath: join(root, "managed-runtime", "current"),
      requested: {
        artifactPath: managedSource,
        artifactDigest: directoryDigest(managedSource),
        runtimeFingerprint: directoryDigest(managedSource),
        fileCount: 3,
        sourceRuntimeHash: "c".repeat(64),
        cliPath: join(managedSource, "packages", "installer", "dist", "cli.js"),
        cliArtifactDigest: fileDigest(join(managedSource, "packages", "installer", "dist", "cli.js")),
      },
      rollback: {
        existed: true,
        artifactPath: join(root, "rollback", "managed-runtime"),
        artifactDigest: "d".repeat(64),
        runtimeFingerprint: "d".repeat(64),
        fileCount: 3,
        sourceRuntimeHash: "d".repeat(64),
      },
    },
    rollback: {
      selection: current,
      desktopPath: liveApp,
      desktopArtifactPath: liveApp,
      archivePath: join(root, "rollback", "ChatGPT.app"),
      bundleId: "com.openai.codex",
      desktopVersion: "26.818.0",
      desktopBuild: "9000",
      desktopArtifactDigest: directoryDigest(liveApp),
      desktopAsarHeaderHash: fileDigest(asar(liveApp)),
      signature: {
        strict: true,
        gatekeeper: true,
        designatedRequirement: 'designated => identifier "com.openai.codex"',
        teamIdentifier: OPENAI_TEAM,
      },
      backendLane: "official-bundled",
      backendBinaryPath: join(liveApp, "Contents", "Resources", "codex"),
      backendArtifactPath: join(root, "rollback", "codex"),
      backendVersion: "0.144.0",
      backendArtifactDigest: "e".repeat(64),
    },
  });
  return { root, current, requested, preparedEvidence, builderTransactionIds, helperFile };
}

function createBindings(
  fixture: ProductionFixture,
  overrides: EnvironmentModeProductionDeps = {},
) {
  const mcp: McpModeBridge = {
    assertReady: () => {},
    reconcile: () => ({}) as never,
    prove: () => true,
  };
  return createEnvironmentModeProductionBindings({
    environmentRoot: fixture.root,
    registryFile: join(fixture.root, "environment-registry.json"),
    selectionFile: join(fixture.root, "environment-selection.json"),
    configFile: join(fixture.root, "config.json"),
    stateFile: join(fixture.root, "state.json"),
    runtimeProofFile: join(fixture.root, "environment-runtime-proof.json"),
    mcpConfigFile: join(fixture.root, "mcp-config.toml"),
    mcpStateFile: join(fixture.root, "mcp-state.json"),
    tweaksRoot: join(fixture.root, "tweaks"),
    watcherPromotionFile: join(fixture.root, "transactions", "environment-watcher.json"),
    mcpModeHelperFile: fixture.helperFile,
    preparePrerequisites: ({ transactionId }) => {
      fixture.builderTransactionIds.push(transactionId);
      return fixture.preparedEvidence();
    },
  }, {
    now: () => NOW,
    appFingerprint: directoryDigest,
    directoryFingerprint: directoryDigest,
    fileFingerprint: fileDigest,
    readHeader: (appRoot) => fileDigest(asar(appRoot)),
    mcpBridge: mcp,
    validateOfficial: () => {},
    ...overrides,
  });
}

/**
 * Reverse the fixture direction: Tweakers is the live experience at the shared
 * desktop path and ChatGPT is the requested (inactive) target. The candidate
 * evidence carries the pristine OpenAI trust claim that the receipt pins for
 * the inactive ChatGPT role.
 */
function mirrorFixture(fixture: ProductionFixture): ProductionFixture {
  const current: EnvironmentSelection = { ...fixture.requested, appliedAt: NOW };
  const requested: EnvironmentSelection = { ...fixture.current, appliedAt: null };
  const preparedEvidence = (): PreparedEnvironmentEvidence => {
    const base = fixture.preparedEvidence();
    return {
      ...base,
      candidate: {
        ...base.candidate,
        appExperience: "chatgpt",
        signature: {
          strict: true,
          gatekeeper: true,
          designatedRequirement: 'designated => identifier "com.openai.codex"',
          teamIdentifier: OPENAI_TEAM,
        },
      },
      backend: { ...base.backend, lane: "official-bundled" },
      rollback: {
        ...base.rollback,
        selection: current,
        backendLane: "bundled",
        signature: {
          strict: true,
          gatekeeper: false,
          designatedRequirement: 'designated => identifier "com.openai.codex"',
          teamIdentifier: "TWEAKERS",
        },
      },
    };
  };
  return { ...fixture, current, requested, preparedEvidence };
}

test("prepare validates the official profile only through chatgpt-live selections", async () => {
  await withFixture(async (fixture) => {
    const validated: EnvironmentSelection[] = [];
    const bindings = createBindings(fixture, {
      validateOfficial: (selection) => { validated.push(selection); },
    });
    const result = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: "official-gating-live",
    });
    assert.equal(result.state, "ready");
    assert.ok(validated.length >= 1);
    for (const selection of validated) {
      assert.equal(selection.appExperience, "chatgpt");
      assert.equal(selection.selectedDesktopPath, fixture.current.selectedDesktopPath);
    }
  });
});

test("tweakers-live prepare and stale classification never consult the live-path official validator", async () => {
  await withFixture(async (fixture) => {
    const mirrored = mirrorFixture(fixture);
    const bindings = createBindings(mirrored, {
      validateOfficial: () => {
        throw new Error(
          "Environment desktop is not signed by OpenAI Team 2DC432GLL2 at /Applications/ChatGPT.app",
        );
      },
    });
    const result = await bindings.prepare({
      current: mirrored.current,
      requested: mirrored.requested,
      generationId: "official-gating-inactive",
    });
    assert.equal(result.state, "ready");
    assert.ok(result.receipt);

    const reasons = bindings.warmCommit.classifyStaleBeforeCutover(result.receipt, "bounded-check-failed");
    assert.equal(reasons.some((reason) => /not signed by OpenAI Team/.test(reason)), false);
  });
});

test("production stop terminates only captured helper identities and proves quiescence", async () => {
  await withFixture(async (fixture) => {
  const appPath = fixture.current.selectedDesktopPath;
  let mainRunning = true;
  let processes: ProcessInfo[] = [
    { pid: 101, ppid: 1, startedAtRaw: "main-start", startedAt: NOW, command: `${appPath}/Contents/MacOS/ChatGPT` },
    { pid: 102, ppid: 101, startedAtRaw: "crashpad-start", startedAt: NOW, command: `${appPath}/Contents/Frameworks/browser_crashpad_handler` },
    { pid: 103, ppid: 101, startedAtRaw: "monitor-start", startedAt: NOW, command: `${appPath}/Contents/Resources/native/bare-modifier-monitor` },
  ];
  const signals: string[] = [];
  const bindings = createBindings(fixture, {
    observeDesktop: () => mainRunning ? { pid: 101, visibleWindow: true } : null,
    quitDesktop: (_path, pid) => {
      assert.equal(pid, 101);
      mainRunning = false;
      processes = processes.filter((entry) => entry.pid !== pid);
    },
    relatedPids: () => processes.map((entry) => entry.pid),
    listProcesses: () => processes,
    signalProcess: (pid, signal) => {
      signals.push(`${pid}:${signal}`);
      if (signal === "SIGTERM" && pid === 102) {
        processes = processes.filter((entry) => entry.pid !== pid);
      }
      if (signal === "SIGKILL" && pid === 103) {
        processes = processes.filter((entry) => entry.pid !== pid);
      }
    },
    sleep: async () => {},
  });

  await bindings.warmCommit.stopExactSource({ appPath, pid: 101, visibleWindow: true });

  assert.deepEqual(signals, ["102:SIGTERM", "103:SIGTERM", "103:SIGKILL"]);
  assert.deepEqual(processes, []);
  });
});

test("v2 flag is explicit/default-off and production prepare uses generation-bound builder receipts", async () => {
  await withFixture(async (fixture) => {
    const config = join(fixture.root, "config.json");
    writeFileSync(config, "{}\n");
    assert.equal(environmentModeCacheV2Enabled(config), false);
    writeFileSync(config, JSON.stringify({ tweaker: { environmentModeCacheV2: true } }));
    assert.equal(environmentModeCacheV2Enabled(config), true);

    const bindings = createBindings(fixture);
    const first = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: "generation-one",
    });
    assert.equal(first.state, "ready");
    assert.equal(first.receipt?.generationId, "generation-one");
    assert.deepEqual(fixture.builderTransactionIds, ["generation-one"]);

    // A distinct builder receipt is required after the first generation is
    // terminal; this catches accidental reuse of a constant staging ID.
    bindings.cancel({ transactionId: "generation-one", cancelledAt: NOW });
    const second = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: "generation-two",
    });
    assert.equal(second.state, "ready");
    assert.equal(second.receipt?.generationId, "generation-two");
    assert.deepEqual(fixture.builderTransactionIds, ["generation-one", "generation-two"]);
    assert.equal(readCurrentEnvironmentModePair(environmentModeCachePaths(fixture.root))?.generationId, "generation-two");
  });
});

test("generation-bound helper resolves in a fresh process and rejects a changed cached CLI", async () => {
  await withFixture(async (fixture) => {
    const bindings = createBindings(fixture);
    await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: "fresh-helper-generation",
    });
    const direct = bindings.resolvePreparedCommitCli("fresh-helper-generation");
    assert.equal(direct.transactionId, "fresh-helper-generation");
    assert.equal(direct.cliArtifactDigest, fileDigest(direct.cliPath));

    const fresh = resolveInFreshProcess(fixture.root, "fresh-helper-generation");
    assert.equal(fresh.status, 0, fresh.stderr);
    const helper = JSON.parse(fresh.stdout) as { transactionId: string; cliPath: string; cliArtifactDigest: string };
    assert.equal(helper.transactionId, "fresh-helper-generation");
    assert.equal(helper.cliPath, direct.cliPath);
    assert.equal(helper.cliArtifactDigest, direct.cliArtifactDigest);

    writeFileSync(direct.cliPath, "changed cached helper CLI\n");
    assert.throws(
      () => resolveEnvironmentModeV2PreparedCommitCli(fixture.root, "fresh-helper-generation"),
      /helper CLI changed after preparation/,
    );
  });
});

test("v2 transaction command reads the current pair and generation-local warm journal without legacy status", async () => {
  await withFixture(async (fixture) => {
    const bindings = createBindings(fixture);
    const prepared = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: "transaction-poll-generation",
    });
    const pair = prepared.receipt;
    assert.ok(pair);

    // Only the transaction action is exercised here.  If its v2 path creates
    // or queries a legacy coordinator, this guard fails the command.
    const commandDependencies = {
      paths: () => ({ root: fixture.root, configFile: join(fixture.root, "config.json") }),
      environmentModeCacheV2Enabled: () => true,
      createCoordinator: () => { throw new Error("legacy coordinator status must not run for a v2 poll"); },
      print: () => {},
    } as unknown as EnvironmentCommandDependencies;

    const preparedPoll = await environment("transaction", { json: true, quiet: true }, commandDependencies);
    assert.deepEqual(preparedPoll, {
      schemaVersion: 2,
      kind: "environment-mode-v2-transaction",
      transactionId: "transaction-poll-generation",
      generationId: "transaction-poll-generation",
      phase: "prepared",
      error: null,
      timing: null,
      createdAt: NOW,
      updatedAt: NOW,
      terminalAt: null,
      pinState: "prepared",
      requested: { appExperience: "tweakers", releaseProfile: "stable" },
    });

    const warmReceipt: EnvironmentWarmCommitReceipt = {
      schemaVersion: 1,
      kind: "environment-warm-commit",
      transactionId: pair.generationId,
      generationId: pair.generationId,
      pairReceiptDigest: pair.invalidation.receiptDigest,
      sourceAppPath: fixture.current.selectedDesktopPath,
      targetExperience: "tweakers",
      sourceMainPid: null,
      targetMainPid: null,
      phase: "ready",
      error: null,
      exchangeCount: 1,
      stamps: [],
      timing: { schemaVersion: 1, approvalAt: NOW, readyAt: NOW, phases: {} },
      createdAt: NOW,
      updatedAt: NOW,
      terminalAt: NOW,
    };
    writeEnvironmentWarmCommitReceipt(environmentWarmCommitJournalFile(pair), warmReceipt);

    const warmPoll = await environment("transaction", { json: true, quiet: true }, commandDependencies);
    assert.deepEqual(warmPoll, {
      schemaVersion: 2,
      kind: "environment-mode-v2-transaction",
      transactionId: "transaction-poll-generation",
      generationId: "transaction-poll-generation",
      phase: "ready",
      error: null,
      timing: warmReceipt.timing,
      createdAt: NOW,
      updatedAt: NOW,
      terminalAt: NOW,
      pinState: "prepared",
      requested: { appExperience: "tweakers", releaseProfile: "stable" },
    });
  });
});

function resolveInFreshProcess(root: string, generationId: string) {
  return spawnSync(process.execPath, [
    "--import",
    "./scripts/test-root-preload.mjs",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    [
      'import { resolveEnvironmentModeV2PreparedCommitCli } from "./packages/installer/src/environment-mode-production.ts";',
      "process.stdout.write(JSON.stringify(resolveEnvironmentModeV2PreparedCommitCli(process.argv[1], process.argv[2])));",
    ].join("\n"),
    root,
    generationId,
  ], { cwd: process.cwd(), encoding: "utf8" });
}

function writeApp(root: string, marker: string): void {
  mkdirSync(join(root, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(root, "Contents", "Nested"), { recursive: true });
  writeFileSync(asar(root), `${marker}-asar`);
  writeFileSync(join(root, "Contents", "Nested", "leaf.txt"), `${marker}-nested`);
}

function writeTree(root: string, marker: string): void {
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "artifact.txt"), marker);
  writeFileSync(join(root, "nested", "leaf.txt"), `${marker}-nested`);
}

function writeManagedRuntime(root: string): void {
  writeTree(root, "managed-runtime");
  mkdirSync(join(root, "packages", "installer", "dist"), { recursive: true });
  writeFileSync(join(root, "packages", "installer", "dist", "cli.js"), "export {};\n");
}

function asar(appRoot: string): string {
  return join(appRoot, "Contents", "Resources", "app.asar");
}

function directoryDigest(root: string): string {
  return sealEnvironmentModeCacheTree(root).contentDigest;
}

function fileDigest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
