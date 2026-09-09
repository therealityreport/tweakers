import assert from "node:assert/strict";
import asarPackage from "@electron/asar";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finished } from "node:stream/promises";
import test from "node:test";
import {
  environmentModeCacheGenerationPaths,
  environmentModeCachePaths,
  invalidateCurrentEnvironmentModePair,
  readCurrentEnvironmentModePair,
  sealEnvironmentModeCacheTree,
} from "../src/environment-mode-cache";
import {
  writeWatcherPromotionReceipt,
  type WatcherPromotionReceipt,
} from "../src/watcher-promotion";
import {
  environment,
  type EnvironmentCommandDependencies,
} from "../src/commands/environment";
import {
  createEnvironmentModeProductionBindings,
  environmentModeWarmCommitTargetIdentity,
  environmentModeCacheV2Enabled,
  observeOrReopenExactVisibleDesktop,
  resolveEnvironmentModeV2PreparedCommitCli,
  type EnvironmentModeProductionDeps,
} from "../src/environment-mode-production";
import type { ProcessInfo } from "../src/commands/debug";
import type { EnvironmentSelection } from "../src/environment-profile";
import type { PreparedEnvironmentEvidence } from "../src/environment-transaction";
import type { McpModeBridge } from "../src/mcp-mode-bridge";
import { writePlist } from "../src/plist";
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
  // Resolve the temporary root to avoid /tmp symlink ancestors, and keep
  // disposable app bundles outside the workspace observed by Finder.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweaker-production-v2-"));
  return Promise.resolve()
    .then(() => run(makeFixture(root)))
    .finally(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
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
 * Give the two disposable fixture apps the same on-disk identity surfaces that
 * bounded production preflight reads: Info.plist, a readable ASAR marker, and
 * codesign output.  The production binding remains unmodified and therefore
 * cannot skip any role or signature assertion for these tests.
 */
async function prepareBoundedRoleFixture(fixture: ProductionFixture): Promise<void> {
  await writeBoundedRoleApp(
    fixture,
    fixture.current.selectedDesktopPath,
    "live-chatgpt",
    "chatgpt",
    "26.818.0",
    "9000",
  );
  await writeBoundedRoleApp(
    fixture,
    fixture.preparedEvidence().candidate.artifactPath,
    "candidate-tweakers",
    "tweakers",
    "26.818.1",
    "9001",
  );
}

async function writeBoundedRoleApp(
  fixture: ProductionFixture,
  appPath: string,
  sourceName: string,
  experience: "chatgpt" | "tweakers",
  version: string,
  build: string,
): Promise<void> {
  writePlist(join(appPath, "Contents", "Info.plist"), {
    CFBundleIdentifier: "com.openai.codex",
    CFBundleShortVersionString: version,
    CFBundleVersion: build,
  });
  const source = join(fixture.root, "bounded-role-asar-source", sourceName);
  mkdirSync(source, { recursive: true });
  const main = experience === "tweakers" ? "tweaker-loader.cjs" : "official.js";
  writeFileSync(join(source, "package.json"), `${JSON.stringify({
    name: sourceName,
    version: "1.0.0",
    main,
    ...(experience === "tweakers" ? { __tweaker: {} } : {}),
  })}\n`);
  writeFileSync(join(source, main), "export {};\n");
  const archive = asar(appPath);
  if (existsSync(archive)) unlinkSync(archive);
  const output = await asarPackage.createPackageWithOptions(source, archive, {
    globOptions: { dot: true },
  });
  await finished(output);
}

async function withFixtureCodesign<T>(
  fixture: ProductionFixture,
  run: () => Promise<T>,
): Promise<T> {
  const bin = join(fixture.root, "bounded-role-bin");
  const executable = join(bin, "codesign");
  mkdirSync(bin, { recursive: true });
  writeFileSync(executable, [
    "#!/bin/sh",
    "last=",
    "for arg in \"$@\"; do",
    "  if [ \"$arg\" = \"--verify\" ]; then exit 0; fi",
    "  last=\"$arg\"",
    "done",
    "case \"$last\" in",
    "  */environment-cache/*)",
    "    printf '%s\\n' 'Signature=adhoc' 'TeamIdentifier=not set' >&2",
    "    ;;",
    "  *)",
    `    printf '%s\\n' 'TeamIdentifier=${OPENAI_TEAM}' >&2`,
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(executable, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = priorPath === undefined ? bin : `${bin}:${priorPath}`;
  try {
    return await run();
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
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

test("tweakers-live warm preflight binds the complete pair for a pristine ChatGPT target", async () => {
  await withFixture(async (fixture) => {
    const mirrored = mirrorFixture(fixture);
    const bindings = createBindings(mirrored);
    const result = await bindings.prepare({
      current: mirrored.current,
      requested: mirrored.requested,
      generationId: "chatgpt-target-preflight",
    });
    assert.equal(result.state, "ready");
    assert.ok(result.receipt);

    const target = environmentModeWarmCommitTargetIdentity(result.receipt, result.receipt.roles.inactive);
    assert.equal(target.appExperience, "chatgpt");
    assert.equal(target.backendDigest, result.receipt.tweakers.backend.digest);
    assert.equal(target.runtimeDigest, result.receipt.tweakers.runtime.digest);
    assert.equal(target.managedRuntimeDigest, result.receipt.tweakers.managedRuntime.digest);
    assert.equal(target.nativeHostDigest, result.receipt.tweakers.nativeHost.digest);
  });
});

test("warm preflight reopens and re-proves an absent exact source before cutover", async () => {
  const appPath = "/Applications/ChatGPT.app";
  let source: { pid: number; visibleWindow: boolean } | null = null;
  const reopened: string[] = [];
  const sleeps: number[] = [];

  const observed = await observeOrReopenExactVisibleDesktop(
    appPath,
    () => source,
    (path) => {
      reopened.push(path);
      source = { pid: 808, visibleWindow: true };
    },
    async (milliseconds) => { sleeps.push(milliseconds); },
  );

  assert.deepEqual(reopened, [appPath]);
  assert.deepEqual(observed, { pid: 808, visibleWindow: true });
  assert.deepEqual(sleeps, []);
});

test("warm preflight source reopen stays bounded when the exact app remains absent", async () => {
  const appPath = "/Applications/ChatGPT.app";
  const reopened: string[] = [];
  const sleeps: number[] = [];

  const observed = await observeOrReopenExactVisibleDesktop(
    appPath,
    () => null,
    (path) => { reopened.push(path); },
    async (milliseconds) => { sleeps.push(milliseconds); },
  );

  assert.equal(observed, null);
  assert.deepEqual(reopened, [appPath]);
  assert.equal(sleeps.length, 240);
  assert.equal(sleeps.every((milliseconds) => milliseconds === 250), true);
});

test("production preflight reopens the exact absent source and revalidates the pair", async () => {
  await withFixture(async (fixture) => {
    await prepareBoundedRoleFixture(fixture);
    await withFixtureCodesign(fixture, async () => {
      let source: { pid: number; visibleWindow: boolean } | null = null;
      const reopened: string[] = [];
      const bindings = createBindings(fixture, {
        observeDesktop: () => source,
        reopenDesktop: (appPath) => {
          reopened.push(appPath);
          source = { pid: 808, visibleWindow: true };
        },
        sleep: async () => {},
      });
      const prepared = await bindings.prepare({
        current: fixture.current,
        requested: fixture.requested,
        generationId: "binding-source-reopen",
      });
      assert.ok(prepared.receipt);

      const preflight = await bindings.warmCommit.preflight(prepared.receipt);

      assert.equal(preflight.state, "ready");
      if (preflight.state !== "ready") assert.fail(preflight.reason);
      assert.deepEqual(reopened, [fixture.current.selectedDesktopPath]);
      assert.deepEqual(preflight.source, {
        appPath: fixture.current.selectedDesktopPath,
        pid: 808,
        visibleWindow: true,
      });
    });
  });
});

test("production preflight keeps persistent exact-source absence bounded and stale", async () => {
  await withFixture(async (fixture) => {
    await prepareBoundedRoleFixture(fixture);
    await withFixtureCodesign(fixture, async () => {
      const reopened: string[] = [];
      const sleeps: number[] = [];
      let observations = 0;
      const bindings = createBindings(fixture, {
        observeDesktop: () => {
          observations += 1;
          return null;
        },
        reopenDesktop: (appPath) => { reopened.push(appPath); },
        sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      });
      const prepared = await bindings.prepare({
        current: fixture.current,
        requested: fixture.requested,
        generationId: "binding-source-absent",
      });
      assert.ok(prepared.receipt);

      const preflight = await bindings.warmCommit.preflight(prepared.receipt);

      assert.deepEqual(preflight, {
        state: "stale_requires_prepare",
        reason: "exact source process with visible window is absent after bounded reopen",
      });
      assert.deepEqual(reopened, [fixture.current.selectedDesktopPath]);
      assert.equal(observations, 241);
      assert.equal(sleeps.length, 240);
      assert.equal(sleeps.every((milliseconds) => milliseconds === 250), true);
    });
  });
});

test("production preflight rejects sealed-pair drift introduced during exact-source reopen", async () => {
  await withFixture(async (fixture) => {
    await prepareBoundedRoleFixture(fixture);
    await withFixtureCodesign(fixture, async () => {
      let source: { pid: number; visibleWindow: boolean } | null = null;
      const bindings = createBindings(fixture, {
        observeDesktop: () => source,
        reopenDesktop: () => { source = { pid: 909, visibleWindow: true }; },
        sleep: async () => {},
      });
      const prepared = await bindings.prepare({
        current: fixture.current,
        requested: fixture.requested,
        generationId: "binding-source-reopen-drift",
      });
      assert.ok(prepared.receipt);
      const cachedCli = join(
        prepared.receipt.paths.managedRuntimeRoot,
        "packages",
        "installer",
        "dist",
        "cli.js",
      );
      const driftBindings = createBindings(fixture, {
        observeDesktop: () => source,
        reopenDesktop: () => {
          writeFileSync(cachedCli, "changed during reopen\n");
          source = { pid: 909, visibleWindow: true };
        },
        sleep: async () => {},
      });

      const preflight = await driftBindings.warmCommit.preflight(prepared.receipt);

      assert.equal(preflight.state, "stale_requires_prepare");
      if (preflight.state !== "stale_requires_prepare") assert.fail("expected stale preflight");
      assert.match(preflight.reason, /stat seal mismatch/);
    });
  });
});

test("prepare survives Finder creating .DS_Store in a sealed managed-runtime projection", async () => {
  await withFixture(async (fixture) => {
    const generationId = "finder-projection-generation";
    const preparationRoot = environmentModeCachePaths(fixture.root).preparationRoot;
    const managedProjection = join(
      preparationRoot,
      generationId,
      "projection",
      "managed-runtime",
    );
    const finderMetadata = join(managedProjection, ".DS_Store");
    let injected = false;
    const bindings = createBindings(fixture, {
      validateOfficial: () => {
        if (!injected && existsSync(managedProjection)) {
          writeFileSync(finderMetadata, "finder-created-after-seal\n");
          injected = true;
        }
      },
    });

    const result = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId,
    });

    assert.equal(result.state, "ready");
    assert.equal(injected, true);
    assert.ok(result.receipt);
    const promotedFinderMetadata = join(
      result.receipt.paths.generationRoot,
      "projection",
      "managed-runtime",
      ".DS_Store",
    );
    assert.equal(existsSync(promotedFinderMetadata), true);
    const control = JSON.parse(readFileSync(
      join(result.receipt.paths.generationRoot, "control-v2.json"),
      "utf8",
    )) as { schemaVersion: number; projection: { metadataPolicy: string } };
    assert.equal(control.schemaVersion, 2);
    assert.equal(control.projection.metadataPolicy, "macos-ds-store-regular-v1");
  });
});

test("missing or unknown projection metadata policy always forces fresh preparation", async () => {
  await withFixture(async (fixture) => {
    const bindings = createBindings(fixture);
    const first = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: "policy-generation-one",
    });
    assert.ok(first.receipt);
    const firstControlFile = join(first.receipt.paths.generationRoot, "control-v2.json");
    const firstControl = JSON.parse(readFileSync(firstControlFile, "utf8")) as {
      projection: { metadataPolicy?: string };
    };
    delete firstControl.projection.metadataPolicy;
    writeFileSync(firstControlFile, `${JSON.stringify(firstControl, null, 2)}\n`);

    const second = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: "policy-generation-two",
    });
    assert.ok(second.receipt);
    assert.equal(second.receipt.generationId, "policy-generation-two");
    const secondControlFile = join(second.receipt.paths.generationRoot, "control-v2.json");
    const secondControl = JSON.parse(readFileSync(secondControlFile, "utf8")) as {
      projection: { metadataPolicy: string };
    };
    secondControl.projection.metadataPolicy = "unknown-policy";
    writeFileSync(secondControlFile, `${JSON.stringify(secondControl, null, 2)}\n`);

    const third = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: "policy-generation-three",
    });
    assert.ok(third.receipt);
    assert.equal(third.receipt.generationId, "policy-generation-three");
    assert.deepEqual(fixture.builderTransactionIds, [
      "policy-generation-one",
      "policy-generation-two",
      "policy-generation-three",
    ]);
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

function abandonedPausedPromotion(transactionId: string, appRoot: string): WatcherPromotionReceipt {
  return {
    schemaVersion: 1,
    kind: "watcher-promotion",
    transactionId,
    phase: "paused",
    sourceAppRoot: appRoot,
    requestedAppRoot: appRoot,
    activeTargetAppRoot: null,
    sourceExpectedFingerprint: "9".repeat(64),
    targetExpectedFingerprint: null,
    snapshot: {
      schemaVersion: 1,
      kind: "watcher-promotion-snapshot",
      watcherKind: "launchd",
      configured: true,
      loaded: true,
      enabled: true,
      definitionPath: null,
      definitionDigest: null,
      capturedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    pausedAt: NOW,
    resumedAt: null,
    error: null,
  };
}

function terminalWarmJournal(generationId: string, sourceAppPath: string, terminal: boolean): EnvironmentWarmCommitReceipt {
  return {
    schemaVersion: 1,
    kind: "environment-warm-commit",
    transactionId: generationId,
    generationId,
    pairReceiptDigest: "a".repeat(64),
    sourceAppPath,
    targetExperience: "chatgpt",
    sourceMainPid: null,
    targetMainPid: null,
    phase: terminal ? "failed" : "exchange-intent",
    error: terminal ? "post-swap proof failed" : null,
    exchangeCount: terminal ? 2 : 1,
    stamps: [],
    timing: { schemaVersion: 1, approvalAt: NOW, readyAt: null, phases: {} },
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: terminal ? NOW : null,
  };
}

test("an abandoned paused watcher promotion from a terminal transaction is reclaimed before the new pause", async () => {
  await withFixture(async (fixture) => {
    const appRoot = fixture.current.selectedDesktopPath;
    const watcherFile = join(fixture.root, "transactions", "environment-watcher.json");
    const begun: string[] = [];
    const finished: Array<{ transactionId: string; targetAppRoot: string; targetExpectedFingerprint: string }> = [];
    const bindings = createBindings(fixture, {
      beginWatcher: ((_file, input) => {
        begun.push(input.transactionId);
        return abandonedPausedPromotion(input.transactionId, appRoot);
      }) as EnvironmentModeProductionDeps["beginWatcher"],
      finishWatcher: ((_file, input) => {
        finished.push(input);
        return abandonedPausedPromotion(input.transactionId, appRoot);
      }) as EnvironmentModeProductionDeps["finishWatcher"],
    });
    const cachePaths = environmentModeCachePaths(fixture.root);
    const deadGeneration = "dead-generation";
    const generationRoot = environmentModeCacheGenerationPaths(cachePaths, deadGeneration).generationRoot;
    mkdirSync(generationRoot, { recursive: true });

    // Terminal journal: the pause is provably orphaned and must be reclaimed
    // by resuming against the CURRENT pause request's live evidence.
    writeWatcherPromotionReceipt(watcherFile, abandonedPausedPromotion(deadGeneration, appRoot));
    writeEnvironmentWarmCommitReceipt(
      join(generationRoot, "warm-commit.json"),
      terminalWarmJournal(deadGeneration, appRoot, true),
    );
    await bindings.warmCommit.pauseWatcher({
      transactionId: "fresh-generation",
      sourceAppRoot: appRoot,
      targetAppRoot: appRoot,
      sourceExpectedFingerprint: "f".repeat(64),
    });
    assert.deepEqual(finished, [{
      transactionId: deadGeneration,
      targetAppRoot: appRoot,
      targetExpectedFingerprint: "f".repeat(64),
    }]);
    assert.deepEqual(begun, ["fresh-generation"]);

    // Non-terminal journal: the owner may still be alive, so the strict
    // begin-time refusal is preserved and no reclaim happens.
    writeWatcherPromotionReceipt(watcherFile, abandonedPausedPromotion(deadGeneration, appRoot));
    writeEnvironmentWarmCommitReceipt(
      join(generationRoot, "warm-commit.json"),
      terminalWarmJournal(deadGeneration, appRoot, false),
    );
    await bindings.warmCommit.pauseWatcher({
      transactionId: "fresh-generation",
      sourceAppRoot: appRoot,
      targetAppRoot: appRoot,
      sourceExpectedFingerprint: "f".repeat(64),
    });
    assert.equal(finished.length, 1);
    assert.deepEqual(begun, ["fresh-generation", "fresh-generation"]);

    // A pause without a v2 generation directory belongs to the legacy v1
    // coordinator; its owner's liveness cannot be proven here, so the strict
    // cross-transaction refusal is preserved.
    writeWatcherPromotionReceipt(watcherFile, abandonedPausedPromotion("legacy-v1-transaction", appRoot));
    await bindings.warmCommit.pauseWatcher({
      transactionId: "fresh-generation",
      sourceAppRoot: appRoot,
      targetAppRoot: appRoot,
      sourceExpectedFingerprint: "f".repeat(64),
    });
    assert.equal(finished.length, 1);

    // A cross-transaction "pausing" receipt is not resumable by
    // finishWatcherPromotion; the reclaim skips it instead of throwing.
    writeWatcherPromotionReceipt(watcherFile, {
      ...abandonedPausedPromotion(deadGeneration, appRoot),
      phase: "pausing",
      pausedAt: null,
    });
    writeEnvironmentWarmCommitReceipt(
      join(generationRoot, "warm-commit.json"),
      terminalWarmJournal(deadGeneration, appRoot, true),
    );
    await bindings.warmCommit.pauseWatcher({
      transactionId: "fresh-generation",
      sourceAppRoot: appRoot,
      targetAppRoot: appRoot,
      sourceExpectedFingerprint: "f".repeat(64),
    });
    assert.equal(finished.length, 1);
  });
});

test("a terminally released pair reclaims its orphaned nonterminal watcher pause", async () => {
  await withFixture(async (fixture) => {
    const appRoot = fixture.current.selectedDesktopPath;
    const watcherFile = join(fixture.root, "transactions", "environment-watcher.json");
    const deadGeneration = "terminal-pair-nonterminal-journal";
    const begun: string[] = [];
    const finished: Array<{ transactionId: string; targetAppRoot: string; targetExpectedFingerprint: string }> = [];
    const bindings = createBindings(fixture, {
      beginWatcher: ((_file, input) => {
        begun.push(input.transactionId);
        return abandonedPausedPromotion(input.transactionId, appRoot);
      }) as EnvironmentModeProductionDeps["beginWatcher"],
      finishWatcher: ((_file, input) => {
        finished.push(input);
        return abandonedPausedPromotion(input.transactionId, appRoot);
      }) as EnvironmentModeProductionDeps["finishWatcher"],
    });
    const prepared = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: deadGeneration,
    });
    assert.equal(prepared.state, "ready");
    assert.ok(prepared.receipt);
    const cachePaths = environmentModeCachePaths(fixture.root);
    invalidateCurrentEnvironmentModePair(cachePaths, deadGeneration, NOW);
    const replacement = await bindings.prepare({
      current: fixture.current,
      requested: fixture.requested,
      generationId: "fresh-generation",
    });
    assert.equal(replacement.state, "ready");
    assert.equal(replacement.receipt?.generationId, "fresh-generation");
    assert.equal(readCurrentEnvironmentModePair(cachePaths)?.generationId, "fresh-generation");
    const generationRoot = environmentModeCacheGenerationPaths(cachePaths, deadGeneration).generationRoot;
    writeWatcherPromotionReceipt(watcherFile, abandonedPausedPromotion(deadGeneration, appRoot));
    writeEnvironmentWarmCommitReceipt(
      join(generationRoot, "warm-commit.json"),
      terminalWarmJournal(deadGeneration, appRoot, false),
    );

    await bindings.warmCommit.pauseWatcher({
      transactionId: "fresh-generation",
      sourceAppRoot: appRoot,
      targetAppRoot: appRoot,
      sourceExpectedFingerprint: "f".repeat(64),
    });

    assert.deepEqual(finished, [{
      transactionId: deadGeneration,
      targetAppRoot: appRoot,
      targetExpectedFingerprint: "f".repeat(64),
    }]);
    assert.deepEqual(begun, ["fresh-generation"]);
  });
});
