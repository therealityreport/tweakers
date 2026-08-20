import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  acquireCurrentEnvironmentModePairWarmCommitLease,
  environmentModeCacheGenerationPaths,
  environmentModeCachePaths,
  finalizeEnvironmentModePairReceipt,
  invalidateCurrentEnvironmentModePair,
  publishEnvironmentModePair,
  readCurrentEnvironmentModePair,
  sealEnvironmentModeCacheTree,
  type EnvironmentModeCacheContentsIdentity,
  type EnvironmentModeCacheOuterAppEvidence,
  type EnvironmentModePairReceipt,
} from "../src/environment-mode-cache";
import { createEnvironmentTiming } from "../src/environment-timing";
import {
  captureEnvironmentModeCacheContentsIdentity,
  readEnvironmentWarmCommitReceipt,
  writeEnvironmentWarmCommitReceipt,
  type EnvironmentWarmCommitPreflightReady,
  type EnvironmentWarmCommitProjection,
  type EnvironmentWarmCommitReceipt,
  type EnvironmentWarmCommitTargetProof,
} from "../src/environment-warm-commit";
import {
  recoverEnvironmentModePairWarm,
  type EnvironmentWarmRecoveryDeps,
} from "../src/environment-warm-recovery";
import type { EnvironmentSelection } from "../src/environment-profile";

const APPROVAL_AT = "2026-08-18T12:00:00.000Z";
const APPLIED_AT = "2026-08-18T12:00:03.000Z";
const HASH = "a".repeat(64);

interface Fixture {
  root: string;
  paths: ReturnType<typeof environmentModeCachePaths>;
  pair: EnvironmentModePairReceipt;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(realpathSync(process.cwd()), ".tweaker-warm-recovery-"));
  try {
    await run(makeFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeFixture(root: string): Fixture {
  const paths = environmentModeCachePaths(root);
  const generation = environmentModeCacheGenerationPaths(paths, "recovery-generation-a");
  const liveAppPath = join(root, "live", "ChatGPT.app");
  writeApp(liveAppPath, "source");
  writeApp(generation.inactiveAppPath, "target");
  writeTree(generation.runtimeRoot, "runtime");
  writeTree(generation.managedRuntimeRoot, "managed-runtime");
  const backendRoot = join(root, "backend");
  const nativeRoot = join(root, "native");
  writeTree(backendRoot, "backend");
  writeTree(nativeRoot, "native");
  const appEvidence = (path: string, marker: string) => ({
    bundleId: "com.openai.codex" as const,
    version: "26.818.1",
    build: "9001",
    appDigest: marker === "source" ? "b".repeat(64) : "c".repeat(64),
    asarPath: join(path, "Contents", "Resources", "app.asar"),
    asarDigest: marker === "source" ? "d".repeat(64) : "e".repeat(64),
    asarHeaderDigest: marker === "source" ? "f".repeat(64) : "1".repeat(64),
    signature: {
      strict: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement: 'designated => identifier "com.openai.codex"',
      signatureDigest: marker === "source" ? "2".repeat(64) : "3".repeat(64),
    },
  });
  const artifact = (rootPath: string, digest: string) => ({ rootPath, digest, fileCount: 2, provenanceDigest: digest });
  const pair = finalizeEnvironmentModePairReceipt({
    schemaVersion: 2,
    kind: "environment-mode-pair",
    generationId: generation.generationId,
    releaseProfile: "stable",
    paths: {
      cacheRoot: paths.cacheRoot,
      currentFile: paths.currentFile,
      generationRoot: generation.generationRoot,
      receiptFile: generation.receiptFile,
      inactiveAppPath: generation.inactiveAppPath,
      runtimeRoot: generation.runtimeRoot,
      managedRuntimeRoot: generation.managedRuntimeRoot,
    },
    roles: {
      live: { role: "live", experience: "chatgpt", appPath: liveAppPath, evidence: appEvidence(liveAppPath, "source") },
      inactive: { role: "inactive", experience: "tweakers", appPath: generation.inactiveAppPath, evidence: appEvidence(generation.inactiveAppPath, "target") },
    },
    tweakers: {
      buildDigest: HASH,
      patchPayloadDigest: HASH,
      sourceControlDigest: HASH,
      runtime: artifact(generation.runtimeRoot, "4".repeat(64)),
      managedRuntime: artifact(generation.managedRuntimeRoot, "5".repeat(64)),
      backend: { ...artifact(backendRoot, "6".repeat(64)), lane: "bundled" as const, version: "0.145.0" },
      nativeHost: { ...artifact(nativeRoot, "7".repeat(64)), executablePath: join(nativeRoot, "host") },
    },
    seals: {
      liveApp: sealEnvironmentModeCacheTree(liveAppPath),
      inactiveApp: sealEnvironmentModeCacheTree(generation.inactiveAppPath),
      runtime: sealEnvironmentModeCacheTree(generation.runtimeRoot),
      managedRuntime: sealEnvironmentModeCacheTree(generation.managedRuntimeRoot),
    },
    invalidation: {
      official: {
        version: "26.818.1", build: "9001", trustDigest: HASH, signatureDigest: HASH,
        asarDigest: HASH, asarHeaderDigest: HASH, backendDigest: HASH, updaterDigest: HASH,
      },
      tweakers: {
        sourceDigest: HASH, buildDigest: HASH, patchPayloadDigest: HASH, runtimeDigest: "4".repeat(64),
        managedRuntimeDigest: "5".repeat(64), backendDigest: "6".repeat(64), nativeHostDigest: "7".repeat(64),
      },
      environment: {
        profileDigest: HASH, pathsDigest: HASH,
        contentsDevice: statSync(join(liveAppPath, "Contents")).dev.toString(),
        statSealDigest: HASH, mcpHelperDigest: HASH, lifecycleJournalDigest: HASH,
      },
      receiptDigest: HASH,
    },
    timestamps: {
      preparedAt: APPROVAL_AT, validatedAt: APPROVAL_AT, publishedAt: null,
      lastSuccessfulSwitchAt: null, lastPreCutoverCancellationAt: null, terminalAt: null,
    },
    pin: { state: "prepared", pinnedAt: APPROVAL_AT, releasedAt: null, releaseReason: null },
    supersession: { supersededAt: null, replacementGenerationId: null },
  });
  return { root, paths, pair: publishEnvironmentModePair(paths, pair, { now: () => APPROVAL_AT }) };
}

function writeApp(root: string, marker: string): void {
  mkdirSync(join(root, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(root, "outer"), { recursive: true });
  writeFileSync(join(root, "Contents", "Resources", "app.asar"), `${marker}-asar`);
  writeFileSync(join(root, "Contents", "Resources", "payload.txt"), marker);
  writeFileSync(join(root, "outer", "preserved.txt"), marker);
}

function writeTree(root: string, marker: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "artifact.txt"), marker);
}

function outer(path: string): EnvironmentModeCacheOuterAppEvidence {
  const stat = lstatSync(path, { bigint: true });
  return {
    path,
    stat: {
      relativePath: "", type: "directory", dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
      mode: stat.mode.toString(), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), symlinkTarget: null,
    },
    uid: stat.uid.toString(), gid: stat.gid.toString(), aclDigest: HASH, xattrDigest: HASH, quarantineDigest: HASH,
  };
}

function before(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitPreflightReady["exchangeBefore"] {
  return {
    liveContentsBefore: contents(pair.roles.live.appPath),
    inactiveContentsBefore: contents(pair.paths.inactiveAppPath),
    liveOuterBefore: outer(pair.roles.live.appPath),
    inactiveOuterBefore: outer(pair.paths.inactiveAppPath),
  };
}

function contents(appPath: string): EnvironmentModeCacheContentsIdentity {
  return captureEnvironmentModeCacheContentsIdentity(join(appPath, "Contents"));
}

function exchange(root: string, first: string, second: string): void {
  const temporary = join(root, `swap-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  renameSync(first, temporary);
  renameSync(second, first);
  renameSync(temporary, second);
}

function sourceProjection(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitReceipt["sourceProjection"] {
  const source = pair.roles.live;
  const sourceContents = pair.seals.liveApp.entries.find((entry) => entry.relativePath === "Contents");
  if (sourceContents === undefined) throw new Error("fixture lacks source Contents seal");
  return {
    appPath: source.appPath,
    appExperience: source.experience,
    releaseProfile: pair.releaseProfile,
    bundleId: source.evidence.bundleId,
    desktopArtifactDigest: source.evidence.appDigest,
    asarHeaderDigest: source.evidence.asarHeaderDigest,
    signatureDigest: source.evidence.signature.signatureDigest,
    contentsDev: sourceContents.dev,
    contentsIno: sourceContents.ino,
    backendDigest: null,
    runtimeDigest: null,
    managedRuntimeDigest: null,
    nativeHostDigest: null,
    mcpEnabled: false,
  };
}

function journal(pair: EnvironmentModePairReceipt, phase: EnvironmentWarmCommitReceipt["phase"]): EnvironmentWarmCommitReceipt {
  return {
    schemaVersion: 1,
    kind: "environment-warm-commit",
    transactionId: "recovery-transaction-a",
    generationId: pair.generationId,
    pairReceiptDigest: pair.invalidation.receiptDigest,
    sourceAppPath: pair.roles.live.appPath,
    sourceProjection: sourceProjection(pair),
    targetExperience: pair.roles.inactive.experience,
    sourceMainPid: 101,
    targetMainPid: null,
    phase,
    error: phase === "failed" ? "fault injected" : null,
    exchangeCount: 0,
    exchangeBefore: before(pair),
    recoveryExchangeBefore: null,
    stamps: [{ phase, at: APPROVAL_AT, detail: null }],
    timing: {
      ...createEnvironmentTiming(APPROVAL_AT),
      readyAt: phase === "ready" ? APPROVAL_AT : null,
    },
    createdAt: APPROVAL_AT,
    updatedAt: APPROVAL_AT,
    terminalAt: phase === "stale_requires_prepare" || phase === "ready" || phase === "failed" ? APPROVAL_AT : null,
  };
}

function selection(pair: EnvironmentModePairReceipt, appliedAt: string | null): EnvironmentSelection {
  const tweakers = pair.roles.live.experience === "tweakers";
  return {
    selectedDesktopPath: pair.roles.live.appPath,
    selectedDesktopBundleId: pair.roles.live.evidence.bundleId,
    releaseProfile: pair.releaseProfile,
    appExperience: pair.roles.live.experience,
    backendLane: tweakers ? "bundled" : "official-bundled",
    uiFeatures: tweakers ? "on" : "off",
    mcpSafetyProvider: tweakers ? "managed-turn-idle" : "official-bundled-degraded",
    recoveryState: tweakers ? "normal-protected" : "pristine-openai-recovery",
    migrationState: "verified",
    quarantineReason: null,
    requestedAt: APPROVAL_AT,
    appliedAt,
  };
}

function projection(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitProjection {
  return {
    selection: selection(pair, null),
    targetExpectedFingerprint: pair.roles.live.evidence.appDigest,
    restore: () => undefined,
  };
}

function proof(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitTargetProof {
  const tweakers = pair.roles.live.experience === "tweakers";
  return {
    pid: tweakers ? 202 : 303,
    visibleWindow: true,
    appPath: pair.roles.live.appPath,
    appExperience: pair.roles.live.experience,
    bundleId: pair.roles.live.evidence.bundleId,
    version: pair.roles.live.evidence.version,
    build: pair.roles.live.evidence.build,
    asarHeaderDigest: pair.roles.live.evidence.asarHeaderDigest,
    signatureDigest: pair.roles.live.evidence.signature.signatureDigest,
    selection: selection(pair, APPLIED_AT),
    desktopArtifactDigest: pair.roles.live.evidence.appDigest,
    backendDigest: tweakers ? pair.tweakers.backend.digest : null,
    runtimeDigest: tweakers ? pair.tweakers.runtime.digest : null,
    managedRuntimeDigest: tweakers ? pair.tweakers.managedRuntime.digest : null,
    tweakersLoaderActive: tweakers,
    mcpEnabled: tweakers,
  };
}

function recoveryDeps(fixture: Fixture, events: string[], targetProof = false): EnvironmentWarmRecoveryDeps {
  return {
    now: () => APPLIED_AT,
    checkForVerifiedNewerOfficial: () => ({ state: "unchanged" }),
    adoptVerifiedNewerOfficial: () => { throw new Error("unexpected official adoption"); },
    pauseWatcher: () => { events.push("pause-inverse"); },
    observeExactLiveTarget: () => {
      events.push("observe-inverse-target");
      return { state: "absent" };
    },
    stopExactLiveTarget: ({ expected, process }) => {
      events.push(`stop-inverse:${process?.pid ?? "absent"}`);
      return {
        pid: process?.pid ?? null,
        appPath: expected.appPath,
        processStopped: true,
        helpersStopped: true,
      };
    },
    captureExchangeBefore: (pair) => before(pair),
    captureExchangeProof: ({ pair }) => ({
      liveContentsAfter: contents(pair.roles.live.appPath),
      inactiveContentsAfter: contents(pair.paths.inactiveAppPath),
      liveOuterAfter: outer(pair.roles.live.appPath),
      inactiveOuterAfter: outer(pair.paths.inactiveAppPath),
    }),
    exchangeContents: (first, second) => {
      events.push("exchange");
      exchange(fixture.root, first, second);
    },
    restoreSource: ({ pair }) => {
      events.push("restore-source");
      return projection(pair);
    },
    observeSource: () => null,
    reopenSource: () => { events.push("reopen-source"); },
    proveSource: ({ pair }) => {
      events.push("prove-source");
      return proof(pair);
    },
    proveTarget: ({ pair }) => targetProof ? proof(pair) : null,
    bindWatcherTarget: () => { events.push("bind"); },
    publishSelection: () => { events.push("publish"); },
    resumeWatcher: () => { events.push("resume"); },
  };
}

function writeJournal(fixture: Fixture, receipt: EnvironmentWarmCommitReceipt): void {
  writeEnvironmentWarmCommitReceipt(join(fixture.pair.paths.generationRoot, "warm-commit.json"), receipt);
}

function rotatePairForward(fixture: Fixture): EnvironmentModePairReceipt {
  const lease = acquireCurrentEnvironmentModePairWarmCommitLease(fixture.paths);
  try {
    const pair = lease.receipt;
    const initial = before(pair);
    exchange(fixture.root, initial.liveContentsBefore.path, initial.inactiveContentsBefore.path);
    return lease.completeContentsExchange({
      ...initial,
      liveContentsAfter: contents(pair.roles.live.appPath),
      inactiveContentsAfter: contents(pair.paths.inactiveAppPath),
      liveOuterAfter: outer(pair.roles.live.appPath),
      inactiveOuterAfter: outer(pair.paths.inactiveAppPath),
    }, APPLIED_AT);
  } finally {
    lease.release();
  }
}

test("recovery locates a rotated source by sealed Contents inode, not its stable outer app path", async () => {
  await withFixture(async (fixture) => {
    const original = fixture.pair;
    const sourceContents = contents(original.roles.live.appPath);
    const targetContents = contents(original.paths.inactiveAppPath);
    const rotated = rotatePairForward(fixture);
    // Simulate T4's immediate inverse exchange after its cache role rotation.
    // The stable live outer app path remains unchanged; only the source
    // Contents inode tells recovery that source is already live.
    exchange(fixture.root, join(rotated.roles.live.appPath, "Contents"), join(rotated.paths.inactiveAppPath, "Contents"));
    const events: string[] = [];
    const receipt = journal(original, "exchange-reverted");
    writeJournal(fixture, receipt);
    const recovered = await recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, recoveryDeps(fixture, events));
    assert.equal(recovered.phase, "ready");
    assert.deepEqual(events, ["restore-source", "reopen-source", "prove-source", "bind", "publish", "resume"]);
    assert.deepEqual(contents(original.roles.live.appPath), sourceContents);
    assert.deepEqual(contents(original.paths.inactiveAppPath), targetContents);
    assert.equal(readCurrentEnvironmentModePair(fixture.paths)!.roles.live.experience, "chatgpt");
  });
});

test("fault recovery covers every durable journal boundary with a proved source or target", async () => {
  const sourcePhases = [
    "approved",
    "watcher-paused",
    "source-stopped",
    "exchange-intent",
    "exchanged",
    "projected",
    "reopened",
    "inverse-watcher-paused",
    "inverse-target-quiescent",
    "inverse-exchange-intent",
    "recovery-exchange-intent",
    "exchange-reverted",
    "source-proven",
    "source-watcher-bound",
    "source-selection-published",
    "source-watcher-resumed",
    "terminal-source-proven",
    "failed",
  ] as const;
  for (const phase of sourcePhases) {
    await withFixture(async (fixture) => {
      const original = fixture.pair;
      const postCutover = [
        "exchanged",
        "projected",
        "reopened",
        "inverse-watcher-paused",
        "inverse-target-quiescent",
        "inverse-exchange-intent",
        "recovery-exchange-intent",
        "exchange-reverted",
        "failed",
      ]
        .includes(phase);
      let rotated: EnvironmentModePairReceipt | null = null;
      if (postCutover) rotated = rotatePairForward(fixture);
      if (phase === "exchange-reverted" || phase === "failed") {
        // A preceding helper already exchanged source back but died before its
        // post-cutover role receipt was repaired.
        exchange(fixture.root,
          join(rotated!.roles.live.appPath, "Contents"),
          join(rotated!.paths.inactiveAppPath, "Contents"));
      }
      const durable = journal(original, phase);
      if (phase === "recovery-exchange-intent" && rotated !== null) {
        durable.recoveryExchangeBefore = before(rotated);
      }
      writeJournal(fixture, durable);
      const events: string[] = [];
      const recovered = await recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, recoveryDeps(fixture, events));
      assert.equal(recovered.phase, "ready", phase);
      const current = readCurrentEnvironmentModePair(fixture.paths)!;
      assert.equal(current.roles.live.experience, "chatgpt", phase);
      assert.equal(current.pin.state, "prepared", phase);
      assert.equal(events.includes("restore-source"), true, phase);
      assert.equal(events.slice(-3).join(","), "bind,publish,resume", phase);
    });
  }

  for (const phase of [
    "target-proven",
    "watcher-bound",
    "selection-published",
    "watcher-resumed",
    "terminal-target-proven",
  ] as const) {
    await withFixture(async (fixture) => {
      const original = fixture.pair;
      const rotated = rotatePairForward(fixture);
      writeJournal(fixture, journal(original, phase));
      const events: string[] = [];
      const recovered = await recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, recoveryDeps(fixture, events, true));
      assert.equal(recovered.phase, "ready", phase);
      assert.deepEqual(events, ["bind", "publish", "resume"], phase);
      const current = readCurrentEnvironmentModePair(fixture.paths)!;
      assert.equal(current.roles.live.experience, rotated.roles.live.experience, phase);
      assert.equal(current.pin.state, "prepared", phase);
    });
  }
});

test("an ambiguous exchange-intent proves the source inode is inactive before one inverse exchange", async () => {
  await withFixture(async (fixture) => {
    const original = fixture.pair;
    const sourceBefore = contents(original.roles.live.appPath);
    const targetBefore = contents(original.paths.inactiveAppPath);
    // The durable intent exists, but a process died between the native exchange
    // and the cache-role receipt. Recovery must use source's sealed Contents
    // identity rather than infer an outcome from the intent alone.
    exchange(fixture.root,
      join(original.roles.live.appPath, "Contents"),
      join(original.paths.inactiveAppPath, "Contents"));
    writeJournal(fixture, journal(original, "exchange-intent"));
    const events: string[] = [];

    const recovered = await recoverEnvironmentModePairWarm(
      { cachePaths: fixture.paths },
      recoveryDeps(fixture, events),
    );

    assert.equal(recovered.phase, "ready");
    assert.deepEqual(events, [
      "pause-inverse",
      "observe-inverse-target",
      "stop-inverse:absent",
      "observe-inverse-target",
      "exchange",
      "restore-source",
      "reopen-source",
      "prove-source",
      "bind",
      "publish",
      "resume",
    ]);
    assert.deepEqual(contents(original.roles.live.appPath), sourceBefore);
    assert.deepEqual(contents(original.paths.inactiveAppPath), targetBefore);
    assert.equal(readCurrentEnvironmentModePair(fixture.paths)!.roles.live.experience, "chatgpt");
  });
});

test("recovery pauses watcher and stops the exact live target PID/helpers before its inverse exchange", async () => {
  await withFixture(async (fixture) => {
    const original = fixture.pair;
    rotatePairForward(fixture);
    writeJournal(fixture, journal(original, "reopened"));
    const events: string[] = [];
    const deps = recoveryDeps(fixture, events);
    let observed = false;
    deps.observeExactLiveTarget = ({ expected }) => {
      events.push(observed ? "observe-inverse-absent" : "observe-inverse-exact");
      if (observed) return { state: "absent" };
      observed = true;
      return { state: "exact", process: { ...expected, pid: 202, visibleWindow: true } };
    };
    deps.stopExactLiveTarget = ({ expected, process }) => {
      events.push(`stop-inverse:${process?.pid ?? "absent"}`);
      return {
        pid: process?.pid ?? null,
        appPath: expected.appPath,
        processStopped: true,
        helpersStopped: true,
      };
    };

    const recovered = await recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, deps);

    assert.equal(recovered.phase, "ready");
    const index = (event: string, from = 0) => events.indexOf(event, from);
    const pause = index("pause-inverse");
    const exact = index("observe-inverse-exact");
    const stopped = index("stop-inverse:202");
    const absent = index("observe-inverse-absent");
    const exchangeIndex = index("exchange");
    assert.equal(pause < exact && exact < stopped && stopped < absent && absent < exchangeIndex, true);
    const stampIndex = (phase: string) => recovered.stamps.findIndex((stamp) => stamp.phase === phase);
    assert.equal(stampIndex("inverse-watcher-paused") < stampIndex("inverse-target-quiescent"), true);
    assert.equal(stampIndex("inverse-target-quiescent") < stampIndex("inverse-exchange-intent"), true);
    assert.equal(stampIndex("inverse-exchange-intent") < stampIndex("recovery-exchange-intent"), true);
    assert.equal(stampIndex("recovery-exchange-intent") < stampIndex("exchange-reverted"), true);
  });
});

test("ambiguous Contents inode evidence retains the journal and generation without recovery mutation", async () => {
  await withFixture(async (fixture) => {
    const original = fixture.pair;
    const durable = journal(original, "source-stopped");
    writeJournal(fixture, durable);
    const displaced = join(fixture.root, "ambiguous-source-contents");
    renameSync(join(original.roles.live.appPath, "Contents"), displaced);
    writeApp(original.roles.live.appPath, "unproven-third-payload");
    const currentBefore = readCurrentEnvironmentModePair(fixture.paths)!;
    const liveBefore = contents(original.roles.live.appPath);
    const inactiveBefore = contents(original.paths.inactiveAppPath);
    const events: string[] = [];

    await assert.rejects(
      () => recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, recoveryDeps(fixture, events)),
      /cannot prove exact Contents inode roles/,
    );

    assert.deepEqual(events, [], "ambiguous evidence must not invoke exchange, projection, watcher, or selection adapters");
    assert.deepEqual(contents(original.roles.live.appPath), liveBefore);
    assert.deepEqual(contents(original.paths.inactiveAppPath), inactiveBefore);
    assert.deepEqual(readCurrentEnvironmentModePair(fixture.paths), currentBefore);
    const retained = readEnvironmentWarmCommitReceipt(join(original.paths.generationRoot, "warm-commit.json"))!;
    assert.equal(retained.generationId, original.generationId);
    assert.equal(retained.phase, "source-stopped");
    assert.match(retained.error ?? "", /cannot prove exact Contents inode roles/);
  });
});

test("a bound adapter failure leaves a durable journal that a later recovery can resume", async () => {
  await withFixture(async (fixture) => {
    const original = fixture.pair;
    writeJournal(fixture, journal(original, "source-stopped"));
    const events: string[] = [];
    const failing = recoveryDeps(fixture, events);
    failing.restoreSource = () => {
      events.push("restore-source");
      throw new Error("injected source projection adapter failure");
    };
    const currentBefore = readCurrentEnvironmentModePair(fixture.paths)!;

    await assert.rejects(
      () => recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, failing),
      /injected source projection adapter failure/,
    );

    assert.deepEqual(events, ["restore-source"]);
    assert.deepEqual(readCurrentEnvironmentModePair(fixture.paths), currentBefore);
    const retained = readEnvironmentWarmCommitReceipt(join(original.paths.generationRoot, "warm-commit.json"))!;
    assert.equal(retained.phase, "source-stopped");
    assert.equal(retained.generationId, original.generationId);
    assert.match(retained.error ?? "", /injected source projection adapter failure/);

    const retryEvents: string[] = [];
    const retried = await recoverEnvironmentModePairWarm(
      { cachePaths: fixture.paths },
      recoveryDeps(fixture, retryEvents),
    );
    assert.equal(retried.phase, "ready");
    assert.deepEqual(retryEvents, ["restore-source", "reopen-source", "prove-source", "bind", "publish", "resume"]);
  });
});

test("journal source-projection binding mismatches fail closed before adapters mutate", async () => {
  const cases: Array<{
    label: string;
    mutate(receipt: EnvironmentWarmCommitReceipt): EnvironmentWarmCommitReceipt;
    message: RegExp;
  }> = [
    {
      label: "source desktop digest",
      mutate: (receipt) => ({
        ...receipt,
        sourceProjection: { ...receipt.sourceProjection!, desktopArtifactDigest: "9".repeat(64) },
      }),
      message: /source projection identity does not bind the sealed pair/,
    },
    {
      label: "pristine source MCP projection",
      mutate: (receipt) => ({
        ...receipt,
        sourceProjection: { ...receipt.sourceProjection!, mcpEnabled: true },
      }),
      message: /source projection runtime and MCP identity does not bind the sealed pair/,
    },
  ];
  for (const scenario of cases) {
    await withFixture(async (fixture) => {
      const original = fixture.pair;
      writeJournal(fixture, scenario.mutate(journal(original, "source-stopped")));
      const currentBefore = readCurrentEnvironmentModePair(fixture.paths)!;
      const events: string[] = [];
      const deps = recoveryDeps(fixture, events);
      deps.checkForVerifiedNewerOfficial = () => {
        events.push("updater");
        return { state: "unchanged" };
      };

      await assert.rejects(
        () => recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, deps),
        scenario.message,
        scenario.label,
      );

      assert.deepEqual(events, [], scenario.label);
      assert.deepEqual(readCurrentEnvironmentModePair(fixture.paths), currentBefore, scenario.label);
      assert.equal(
        readEnvironmentWarmCommitReceipt(join(original.paths.generationRoot, "warm-commit.json"))!.phase,
        "source-stopped",
        scenario.label,
      );
    });
  }
});

test("a partial persistent recovery adapter fails closed before touching its journal or pair", async () => {
  await withFixture(async (fixture) => {
    const original = fixture.pair;
    const durable = journal(original, "source-stopped");
    writeJournal(fixture, durable);
    const currentBefore = readCurrentEnvironmentModePair(fixture.paths)!;
    const events: string[] = [];
    const incomplete = recoveryDeps(fixture, events) as unknown as Record<string, unknown>;
    delete incomplete.resumeWatcher;

    await assert.rejects(
      () => recoverEnvironmentModePairWarm(
        { cachePaths: fixture.paths },
        incomplete as unknown as EnvironmentWarmRecoveryDeps,
      ),
      /requires a complete explicitly bound persistent recovery adapter/,
    );

    assert.deepEqual(events, []);
    assert.deepEqual(readCurrentEnvironmentModePair(fixture.paths), currentBefore);
    assert.deepEqual(readEnvironmentWarmCommitReceipt(join(original.paths.generationRoot, "warm-commit.json")), durable);
  });
});

test("terminal stale and ready journals remain history without a new mutation", async () => {
  await withFixture(async (fixture) => {
    invalidateCurrentEnvironmentModePair(fixture.paths, fixture.pair.generationId, APPLIED_AT);
    writeJournal(fixture, journal(fixture.pair, "stale_requires_prepare"));
    const staleEvents: string[] = [];
    const stale = await recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, recoveryDeps(fixture, staleEvents));
    assert.equal(stale.phase, "stale_requires_prepare");
    assert.deepEqual(staleEvents, []);
  });
  await withFixture(async (fixture) => {
    invalidateCurrentEnvironmentModePair(fixture.paths, fixture.pair.generationId, APPLIED_AT);
    writeJournal(fixture, journal(fixture.pair, "official-update-adopted"));
    const events: string[] = [];
    const recovered = await recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, recoveryDeps(fixture, events));
    assert.equal(recovered.phase, "stale_requires_prepare");
    assert.deepEqual(events, [], "the durable adoption marker needs only a terminal journal fsync");
  });
  await withFixture(async (fixture) => {
    writeJournal(fixture, journal(fixture.pair, "ready"));
    const readyEvents: string[] = [];
    const ready = await recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, recoveryDeps(fixture, readyEvents));
    assert.equal(ready.phase, "ready");
    assert.deepEqual(readyEvents, []);
  });
});

test("verified newer official adoption invalidates the grant before any Contents exchange", async () => {
  await withFixture(async (fixture) => {
    const events: string[] = [];
    writeJournal(fixture, journal(fixture.pair, "source-stopped"));
    const deps = recoveryDeps(fixture, events);
    deps.checkForVerifiedNewerOfficial = () => ({ state: "newer_verified_official", selection: {
      ...selection(fixture.pair, APPLIED_AT),
      appExperience: "chatgpt",
      uiFeatures: "off",
      backendLane: "official-bundled",
      mcpSafetyProvider: "official-bundled-degraded",
      recoveryState: "pristine-openai-recovery",
    } });
    deps.adoptVerifiedNewerOfficial = () => ({ pid: 404, visibleWindow: true, selection: {
      ...selection(fixture.pair, APPLIED_AT),
      appExperience: "chatgpt",
      uiFeatures: "off",
      backendLane: "official-bundled",
      mcpSafetyProvider: "official-bundled-degraded",
      recoveryState: "pristine-openai-recovery",
    } });
    const recovered = await recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, deps);
    assert.equal(recovered.phase, "stale_requires_prepare");
    assert.equal(readCurrentEnvironmentModePair(fixture.paths)!.pin.state, "stale_requires_prepare");
    assert.deepEqual(events, []);
    assert.equal(readEnvironmentWarmCommitReceipt(join(fixture.pair.paths.generationRoot, "warm-commit.json"))!.phase, "stale_requires_prepare");
  });
});

test("a failed verified-official adoption leaves the stale journal retryable without an exchange", async () => {
  await withFixture(async (fixture) => {
    const official = {
      ...selection(fixture.pair, APPLIED_AT),
      appExperience: "chatgpt" as const,
      uiFeatures: "off" as const,
      backendLane: "official-bundled" as const,
      mcpSafetyProvider: "official-bundled-degraded" as const,
      recoveryState: "pristine-openai-recovery" as const,
    };
    writeJournal(fixture, journal(fixture.pair, "source-stopped"));
    const failingEvents: string[] = [];
    const failing = recoveryDeps(fixture, failingEvents);
    failing.checkForVerifiedNewerOfficial = () => ({ state: "newer_verified_official", selection: official });
    failing.adoptVerifiedNewerOfficial = () => { throw new Error("injected official adoption failure"); };

    await assert.rejects(
      () => recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, failing),
      /injected official adoption failure/,
    );

    const stale = readCurrentEnvironmentModePair(fixture.paths)!;
    assert.equal(stale.generationId, fixture.pair.generationId);
    assert.equal(stale.pin.state, "stale_requires_prepare");
    const retained = readEnvironmentWarmCommitReceipt(join(fixture.pair.paths.generationRoot, "warm-commit.json"))!;
    assert.equal(retained.phase, "source-stopped");
    assert.match(retained.error ?? "", /injected official adoption failure/);
    assert.deepEqual(failingEvents, []);

    const retryEvents: string[] = [];
    const retry = recoveryDeps(fixture, retryEvents);
    retry.checkForVerifiedNewerOfficial = () => ({ state: "newer_verified_official", selection: official });
    retry.adoptVerifiedNewerOfficial = () => ({ pid: 505, visibleWindow: true, selection: official });
    const recovered = await recoverEnvironmentModePairWarm({ cachePaths: fixture.paths }, retry);
    assert.equal(recovered.phase, "stale_requires_prepare");
    assert.equal(readCurrentEnvironmentModePair(fixture.paths)!.pin.state, "stale_requires_prepare");
    assert.deepEqual(retryEvents, []);
  });
});
