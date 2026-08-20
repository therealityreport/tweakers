import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertEnvironmentModePairMaterialized,
  assertEnvironmentModePairWarmCommitMaterialized,
  acquireCurrentEnvironmentModePairWarmCommitLease,
  environmentModeCacheGenerationPaths,
  environmentModeCachePaths,
  environmentModeCacheReachability,
  environmentModePairStatSealDigest,
  finalizeEnvironmentModePairReceipt,
  prepareOrReuseEnvironmentModePair,
  publishEnvironmentModePair,
  readCurrentEnvironmentModePair,
  sealEnvironmentModeCacheTree,
  type EnvironmentModeCacheContentsIdentity,
  type EnvironmentModeCacheOuterAppEvidence,
  type EnvironmentModePairContentsExchangeProof,
  type EnvironmentModePairReceipt,
} from "../src/environment-mode-cache";
import type { EnvironmentSelection } from "../src/environment-profile";
import {
  captureEnvironmentModeCacheContentsIdentity,
  captureEnvironmentModeCacheOuterAppEvidence,
  commitPreparedEnvironmentModePairWarm,
  digestEnvironmentModeCacheOuterAppAclListing,
  type EnvironmentWarmCommitDeps,
  type EnvironmentWarmCommitPreflightReady,
  type EnvironmentWarmCommitProjection,
  type EnvironmentWarmCommitTargetProof,
} from "../src/environment-warm-commit";

const HASH = "a".repeat(64);
const APPROVAL_AT = "2026-08-18T12:00:00.000Z";
const APPLIED_AT = "2026-08-18T12:00:03.000Z";
const SECOND_SWITCH_AT = "2026-08-18T12:00:10.000Z";
const require = createRequire(import.meta.url);
const nativeHostPath = join(process.cwd(), "packages/native-host/dist/tweaker_native_host.node");

interface Fixture {
  root: string;
  paths: ReturnType<typeof environmentModeCachePaths>;
  receipt: EnvironmentModePairReceipt;
  liveLeaf: string;
  inactiveLeaf: string;
  runtimeLeaf: string;
  managedRuntimeLeaf: string;
}

function withFixture(
  run: (fixture: Fixture) => Promise<void> | void,
  sourceExperience: "chatgpt" | "tweakers" = "chatgpt",
): Promise<void> {
  // The cache deliberately rejects symlink ancestors. Some Linux images make
  // /tmp a /var alias, so use the physical test-workspace root instead.
  const root = mkdtempSync(join(realpathSync(process.cwd()), ".tweaker-warm-commit-"));
  return Promise.resolve()
    .then(() => run(makeFixture(root, sourceExperience)))
    .finally(() => { rmSync(root, { recursive: true, force: true }); });
}

function makeFixture(root: string, sourceExperience: "chatgpt" | "tweakers"): Fixture {
  const paths = environmentModeCachePaths(root);
  const generation = environmentModeCacheGenerationPaths(paths, "warm-generation-a");
  const liveAppPath = join(root, "live", "ChatGPT.app");
  const liveLeaf = writeApp(liveAppPath, "outgoing-live");
  const inactiveLeaf = writeApp(generation.inactiveAppPath, "incoming-inactive");
  const runtimeLeaf = writeTree(generation.runtimeRoot, "runtime");
  const managedRuntimeLeaf = writeTree(generation.managedRuntimeRoot, "managed-runtime");
  const backendRoot = join(root, "backend");
  const nativeHostRoot = join(root, "native-host");
  writeTree(backendRoot, "backend");
  writeTree(nativeHostRoot, "native-host");
  writeFileSync(join(nativeHostRoot, "host"), "native-host-executable");

  const evidence = (appPath: string, marker: string) => ({
    bundleId: "com.openai.codex" as const,
    version: "26.818.1",
    build: "9001",
    appDigest: marker === "outgoing-live" ? "b".repeat(64) : "c".repeat(64),
    asarPath: join(appPath, "Contents", "Resources", "app.asar"),
    asarDigest: marker === "outgoing-live" ? "d".repeat(64) : "e".repeat(64),
    asarHeaderDigest: marker === "outgoing-live" ? "f".repeat(64) : "1".repeat(64),
    signature: {
      strict: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement: 'designated => identifier "com.openai.codex"',
      signatureDigest: marker === "outgoing-live" ? "2".repeat(64) : "3".repeat(64),
    },
  });
  const artifact = (rootPath: string, digest = HASH) => ({
    rootPath,
    digest,
    fileCount: 3,
    provenanceDigest: digest,
  });
  const raw: EnvironmentModePairReceipt = {
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
      live: {
        role: "live",
        experience: sourceExperience,
        appPath: liveAppPath,
        evidence: evidence(liveAppPath, "outgoing-live"),
      },
      inactive: {
        role: "inactive",
        experience: sourceExperience === "chatgpt" ? "tweakers" : "chatgpt",
        appPath: generation.inactiveAppPath,
        evidence: evidence(generation.inactiveAppPath, "incoming-inactive"),
      },
    },
    tweakers: {
      buildDigest: HASH,
      patchPayloadDigest: HASH,
      sourceControlDigest: HASH,
      runtime: artifact(generation.runtimeRoot, "4".repeat(64)),
      managedRuntime: artifact(generation.managedRuntimeRoot, "5".repeat(64)),
      backend: { ...artifact(backendRoot, "6".repeat(64)), lane: "bundled", version: "0.145.0" },
      nativeHost: {
        ...artifact(nativeHostRoot, "7".repeat(64)),
        executablePath: join(nativeHostRoot, "host"),
      },
    },
    seals: {
      liveApp: sealEnvironmentModeCacheTree(liveAppPath),
      inactiveApp: sealEnvironmentModeCacheTree(generation.inactiveAppPath),
      runtime: sealEnvironmentModeCacheTree(generation.runtimeRoot),
      managedRuntime: sealEnvironmentModeCacheTree(generation.managedRuntimeRoot),
    },
    invalidation: {
      official: {
        version: "26.818.1",
        build: "9001",
        trustDigest: HASH,
        signatureDigest: HASH,
        asarDigest: HASH,
        asarHeaderDigest: HASH,
        backendDigest: HASH,
        updaterDigest: HASH,
      },
      tweakers: {
        sourceDigest: HASH,
        buildDigest: HASH,
        patchPayloadDigest: HASH,
        runtimeDigest: "4".repeat(64),
        managedRuntimeDigest: "5".repeat(64),
        backendDigest: "6".repeat(64),
        nativeHostDigest: "7".repeat(64),
      },
      environment: {
        profileDigest: HASH,
        pathsDigest: HASH,
        contentsDevice: statSync(join(liveAppPath, "Contents")).dev.toString(),
        statSealDigest: HASH,
        mcpHelperDigest: HASH,
        lifecycleJournalDigest: HASH,
      },
      receiptDigest: HASH,
    },
    timestamps: {
      preparedAt: APPROVAL_AT,
      validatedAt: APPROVAL_AT,
      publishedAt: null,
      lastSuccessfulSwitchAt: null,
      lastPreCutoverCancellationAt: null,
      terminalAt: null,
    },
    pin: { state: "prepared", pinnedAt: APPROVAL_AT, releasedAt: null, releaseReason: null },
    supersession: { supersededAt: null, replacementGenerationId: null },
  };
  const receipt = publishEnvironmentModePair(paths, finalizeEnvironmentModePairReceipt(raw), {
    now: () => APPROVAL_AT,
  });
  return {
    root,
    paths,
    receipt,
    liveLeaf,
    inactiveLeaf,
    runtimeLeaf,
    managedRuntimeLeaf,
  };
}

function writeApp(root: string, marker: string): string {
  const leaf = join(root, "Contents", "Resources", "payload.txt");
  mkdirSync(join(root, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(root, "outer-only"), { recursive: true });
  writeFileSync(join(root, "Contents", "Resources", "app.asar"), `${marker}-asar`);
  writeFileSync(leaf, marker);
  writeFileSync(join(root, "outer-only", "survives.txt"), `${marker}-outer`);
  return leaf;
}

function writeTree(root: string, marker: string): string {
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "artifact.txt"), marker);
  const leaf = join(root, "nested", "leaf.txt");
  writeFileSync(leaf, marker);
  return leaf;
}

/** Preserve length and mtime; warm stat seals must still catch the ctime change. */
function mutateNestedLeafWithRestoredMtime(path: string): void {
  const before = statSync(path);
  const original = readFileSync(path, "utf8");
  const mutated = original.length === 0
    ? "x"
    : `${original.slice(0, -1)}${original.endsWith("x") ? "y" : "x"}`;
  assert.equal(mutated.length, original.length);
  writeFileSync(path, mutated);
  utimesSync(path, before.atime, before.mtime);
}

function outerEvidence(path: string): EnvironmentModeCacheOuterAppEvidence {
  const stat = lstatSync(path, { bigint: true });
  return {
    path,
    stat: {
      relativePath: "",
      type: "directory",
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mode: stat.mode.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
      symlinkTarget: null,
    },
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    // The native macOS capture records real digests. A test-owned fake swap
    // has no ACL/xattr provider, so it proves continuity with fixed evidence.
    aclDigest: HASH,
    xattrDigest: HASH,
    quarantineDigest: HASH,
  };
}

function exchangeBefore(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitPreflightReady["exchangeBefore"] {
  return {
    liveContentsBefore: contentsIdentity(pair.roles.live.appPath),
    inactiveContentsBefore: contentsIdentity(pair.paths.inactiveAppPath),
    liveOuterBefore: outerEvidence(pair.roles.live.appPath),
    inactiveOuterBefore: outerEvidence(pair.paths.inactiveAppPath),
  };
}

function contentsIdentity(appPath: string): EnvironmentModeCacheContentsIdentity {
  return captureEnvironmentModeCacheContentsIdentity(join(appPath, "Contents"));
}

test("outer-app ACL digest excludes mutable ls metadata while retaining only ACL records", () => {
  const before = [
    "drwxr-xr-x+ 5 user staff 160 Aug 18 12:00 /tmp/Disposable.app",
    " 0: group:everyone deny delete",
  ].join("\n");
  const afterSameAcl = [
    "drwxr-xr-x+ 5 user staff 160 Aug 18 12:01 /tmp/Disposable.app",
    " 0: group:everyone deny delete",
  ].join("\n");
  const changedAcl = [
    "drwx------ + 9 root wheel 288 Aug 18 12:02 /elsewhere/Other.app",
    " 0: group:everyone deny write",
  ].join("\n");

  assert.equal(
    digestEnvironmentModeCacheOuterAppAclListing(before),
    digestEnvironmentModeCacheOuterAppAclListing(afterSameAcl),
  );
  assert.notEqual(
    digestEnvironmentModeCacheOuterAppAclListing(before),
    digestEnvironmentModeCacheOuterAppAclListing(changedAcl),
  );
});

test("real macOS native Contents swap preserves ACL-only outer evidence and strict outer identity proof", {
  skip: process.platform !== "darwin",
}, async () => {
  await withFixture(async (fixture) => {
    assert.equal(existsSync(nativeHostPath), true, "native host must be built before macOS swap proof");
    const nativeHost = require(nativeHostPath) as { swapDirectories(first: string, second: string): void };
    const lease = acquireCurrentEnvironmentModePairWarmCommitLease(fixture.paths);
    try {
      const pair = lease.receipt;
      const before = {
        liveContentsBefore: contentsIdentity(pair.roles.live.appPath),
        inactiveContentsBefore: contentsIdentity(pair.paths.inactiveAppPath),
        liveOuterBefore: captureEnvironmentModeCacheOuterAppEvidence(pair.roles.live.appPath),
        inactiveOuterBefore: captureEnvironmentModeCacheOuterAppEvidence(pair.paths.inactiveAppPath),
      };

      nativeHost.swapDirectories(before.liveContentsBefore.path, before.inactiveContentsBefore.path);

      const rotated = lease.completeContentsExchange({
        ...before,
        liveContentsAfter: contentsIdentity(pair.roles.live.appPath),
        inactiveContentsAfter: contentsIdentity(pair.paths.inactiveAppPath),
        liveOuterAfter: captureEnvironmentModeCacheOuterAppEvidence(pair.roles.live.appPath),
        inactiveOuterAfter: captureEnvironmentModeCacheOuterAppEvidence(pair.paths.inactiveAppPath),
      }, APPROVAL_AT);
      assert.equal(rotated.roles.live.experience, "tweakers");
      assert.equal(rotated.roles.inactive.experience, "chatgpt");
      assert.equal(rotated.timestamps.lastSuccessfulSwitchAt, APPROVAL_AT);
    } finally {
      lease.release();
    }
  });
});

function exchangeProof(
  pair: EnvironmentModePairReceipt,
  before: EnvironmentWarmCommitPreflightReady["exchangeBefore"],
): EnvironmentModePairContentsExchangeProof {
  return {
    ...before,
    liveContentsAfter: contentsIdentity(pair.roles.live.appPath),
    inactiveContentsAfter: contentsIdentity(pair.paths.inactiveAppPath),
    liveOuterAfter: outerEvidence(pair.roles.live.appPath),
    inactiveOuterAfter: outerEvidence(pair.paths.inactiveAppPath),
  };
}

function selectionFor(pair: EnvironmentModePairReceipt, appliedAt: string | null): EnvironmentSelection {
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

function targetProof(
  pair: EnvironmentModePairReceipt,
  projection: EnvironmentWarmCommitProjection,
): EnvironmentWarmCommitTargetProof {
  const tweakers = pair.roles.live.experience === "tweakers";
  return {
    pid: 202,
    visibleWindow: true,
    appPath: pair.roles.live.appPath,
    appExperience: pair.roles.live.experience,
    bundleId: pair.roles.live.evidence.bundleId,
    version: pair.roles.live.evidence.version,
    build: pair.roles.live.evidence.build,
    asarHeaderDigest: pair.roles.live.evidence.asarHeaderDigest,
    signatureDigest: pair.roles.live.evidence.signature.signatureDigest,
    selection: { ...projection.selection, appliedAt: APPLIED_AT },
    desktopArtifactDigest: pair.roles.live.evidence.appDigest,
    backendDigest: tweakers ? pair.tweakers.backend.digest : null,
    runtimeDigest: tweakers ? pair.tweakers.runtime.digest : null,
    managedRuntimeDigest: tweakers ? pair.tweakers.managedRuntime.digest : null,
    tweakersLoaderActive: tweakers,
    mcpEnabled: tweakers,
  };
}

function targetIdentity(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitPreflightReady["target"] {
  const target = pair.roles.inactive;
  return {
    appPath: pair.paths.inactiveAppPath,
    appExperience: target.experience,
    bundleId: target.evidence.bundleId,
    version: target.evidence.version,
    build: target.evidence.build,
    asarHeaderDigest: target.evidence.asarHeaderDigest,
    signatureDigest: target.evidence.signature.signatureDigest,
    backendDigest: pair.tweakers.backend.digest,
    runtimeDigest: pair.tweakers.runtime.digest,
    managedRuntimeDigest: pair.tweakers.managedRuntime.digest,
    nativeHostDigest: pair.tweakers.nativeHost.digest,
  };
}

function warmDeps(
  fixture: Fixture,
  events: string[],
  overrides: Partial<EnvironmentWarmCommitDeps> = {},
): EnvironmentWarmCommitDeps {
  const fakeExchange = (first: string, second: string): void => {
    events.push("exchange");
    const temporary = join(fixture.root, `test-swap-${events.filter((event) => event === "exchange").length}`);
    renameSync(first, temporary);
    renameSync(second, first);
    renameSync(temporary, second);
  };
  return {
    now: () => APPROVAL_AT,
    timingClock: {
      nowIso: () => APPROVAL_AT,
      monotonicMs: (() => {
        let value = 0;
        return () => ++value;
      })(),
    },
    preflight: (pair) => {
      events.push("preflight");
      return {
        state: "ready",
        source: { appPath: pair.roles.live.appPath, pid: 101, visibleWindow: true },
        target: targetIdentity(pair),
        exchangeBefore: exchangeBefore(pair),
      };
    },
    classifyStaleBeforeCutover: (_pair, reason) => {
      events.push("full-validate-stale");
      return [`classified: ${reason}`];
    },
    pauseWatcher: () => { events.push("pause"); },
    stopExactSource: (source) => { events.push(`stop:${source.pid}`); },
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
    recheckSourceAfterShutdown: () => { events.push("recheck"); },
    exchangeContents: fakeExchange,
    captureExchangeProof: ({ pair, before }) => {
      events.push("capture-proof");
      return exchangeProof(pair, before);
    },
    projectTarget: (pair) => {
      events.push("project");
      return {
        selection: selectionFor(pair, null),
        targetExpectedFingerprint: pair.roles.live.evidence.appDigest,
        restore: () => { events.push("restore"); },
      };
    },
    reopenTarget: () => { events.push("reopen"); },
    proveTarget: ({ pair, projection }) => {
      events.push("prove-target");
      return targetProof(pair, projection);
    },
    bindWatcherTarget: () => { events.push("bind-watcher"); },
    publishSelection: () => { events.push("publish-selection"); },
    resumeWatcher: () => { events.push("resume-watcher"); },
    ...overrides,
  };
}

function commit(fixture: Fixture, deps: EnvironmentWarmCommitDeps, transactionId = fixture.receipt.generationId) {
  return commitPreparedEnvironmentModePairWarm({
    transactionId,
    approvalAt: APPROVAL_AT,
    cachePaths: fixture.paths,
  }, deps);
}

test("two successful warm commits alternate one sealed pair without preparation and publish prepared only after watcher resume", async () => {
  await withFixture(async (fixture) => {
    const events: string[] = [];
    const liveBefore = contentsIdentity(fixture.receipt.roles.live.appPath);
    const inactiveBefore = contentsIdentity(fixture.receipt.paths.inactiveAppPath);
    const liveOuterBefore = outerEvidence(fixture.receipt.roles.live.appPath);
    const inactiveOuterBefore = outerEvidence(fixture.receipt.paths.inactiveAppPath);
    const boundedPostApprovalDeps = warmDeps(fixture, events);
    const receipt = await commit(fixture, boundedPostApprovalDeps);

    assert.equal(receipt.phase, "ready");
    assert.equal(receipt.exchangeCount, 1);
    assert.equal(receipt.timing.approvalAt, APPROVAL_AT);
    assert.notEqual(receipt.timing.readyAt, null);
    assert.equal(receipt.stamps.some((stamp) => stamp.phase === "exchange-intent"), true);
    assert.equal(
      receipt.stamps.findIndex((stamp) => stamp.phase === "exchange-intent")
        < receipt.stamps.findIndex((stamp) => stamp.phase === "exchanged"),
      true,
    );
    assert.equal(
      receipt.stamps.findIndex((stamp) => stamp.phase === "watcher-resumed")
        < receipt.stamps.findIndex((stamp) => stamp.phase === "terminal-target-proven"),
      true,
    );
    assert.equal(
      receipt.stamps.findIndex((stamp) => stamp.phase === "terminal-target-proven")
        < receipt.stamps.findIndex((stamp) => stamp.phase === "ready"),
      true,
    );
    assert.deepEqual(events, [
      "preflight",
      "pause",
      "stop:101",
      "recheck",
      "exchange",
      "capture-proof",
      "project",
      "reopen",
      "prove-target",
      "bind-watcher",
      "publish-selection",
      "resume-watcher",
    ]);
    for (const forbiddenOperation of [
      "buildPatchedCandidateOnly",
      "cloneAppTree",
      "copyRuntimeTree",
      "copyManagedRuntime",
      "runCanary",
      "hashTree",
    ]) {
      assert.equal(Object.hasOwn(boundedPostApprovalDeps, forbiddenOperation), false, forbiddenOperation);
    }

    const current = readCurrentEnvironmentModePair(fixture.paths);
    assert.notEqual(current, null);
    assert.equal(current!.roles.live.experience, "tweakers");
    assert.equal(current!.roles.inactive.experience, "chatgpt");
    assert.equal(current!.pin.state, "prepared");
    assert.equal(environmentModeCacheReachability(current!, current!.generationId), "prepared_grant");
    assert.equal(current!.timestamps.lastSuccessfulSwitchAt, APPROVAL_AT);
    assert.equal(current!.invalidation.environment.statSealDigest, environmentModePairStatSealDigest(current!.seals));
    assert.deepEqual(contentsIdentity(current!.roles.live.appPath), {
      ...inactiveBefore,
      path: join(current!.roles.live.appPath, "Contents"),
    });
    assert.deepEqual(contentsIdentity(current!.paths.inactiveAppPath), {
      ...liveBefore,
      path: join(current!.paths.inactiveAppPath, "Contents"),
    });
    const liveOuterAfter = outerEvidence(current!.roles.live.appPath);
    const inactiveOuterAfter = outerEvidence(current!.paths.inactiveAppPath);
    for (const [before, after] of [
      [liveOuterBefore, liveOuterAfter],
      [inactiveOuterBefore, inactiveOuterAfter],
    ] as const) {
      assert.equal(after.path, before.path);
      assert.equal(after.stat.dev, before.stat.dev);
      assert.equal(after.stat.ino, before.stat.ino);
      assert.equal(after.stat.mode, before.stat.mode);
      assert.equal(after.uid, before.uid);
      assert.equal(after.gid, before.gid);
      assert.equal(after.aclDigest, before.aclDigest);
      assert.equal(after.xattrDigest, before.xattrDigest);
      assert.equal(after.quarantineDigest, before.quarantineDigest);
    }
    assertEnvironmentModePairWarmCommitMaterialized(fixture.paths, current!);
    assertEnvironmentModePairMaterialized(fixture.paths, current!);

    let preparationCalls = 0;
    const cacheHit = await prepareOrReuseEnvironmentModePair(fixture.paths, "must-not-prepare", {
      inspectInvalidation: (pair) => {
        const { receiptDigest: _receiptDigest, ...snapshot } = pair.invalidation;
        return snapshot;
      },
      stage: () => { preparationCalls += 1; },
      validatePrepared: () => { preparationCalls += 1; },
      createValidatedReceipt: () => {
        preparationCalls += 1;
        return current!;
      },
    }, { now: () => SECOND_SWITCH_AT });
    assert.equal(cacheHit.state, "cache_hit");
    assert.equal(cacheHit.receipt.generationId, current!.generationId);
    assert.equal(preparationCalls, 0, "the rotated pair is a full valid cache hit without preparation/build work");

    const secondEvents: string[] = [];
    const secondReceipt = await commit(fixture, warmDeps(fixture, secondEvents, {
      now: () => SECOND_SWITCH_AT,
    }));
    assert.equal(secondReceipt.phase, "ready");
    assert.equal(secondReceipt.exchangeCount, 1);
    assert.deepEqual(secondEvents.filter((event) => event === "exchange"), ["exchange"]);
    const secondCurrent = readCurrentEnvironmentModePair(fixture.paths);
    assert.notEqual(secondCurrent, null);
    assert.equal(secondCurrent!.generationId, current!.generationId);
    assert.equal(secondCurrent!.roles.live.experience, "chatgpt");
    assert.equal(secondCurrent!.roles.inactive.experience, "tweakers");
    assert.equal(secondCurrent!.pin.state, "prepared");
    assert.equal(environmentModeCacheReachability(secondCurrent!, secondCurrent!.generationId), "prepared_grant");
    assert.equal(secondCurrent!.timestamps.lastSuccessfulSwitchAt, SECOND_SWITCH_AT);
    assert.equal(
      secondCurrent!.invalidation.environment.statSealDigest,
      environmentModePairStatSealDigest(secondCurrent!.seals),
    );
    assert.deepEqual(contentsIdentity(secondCurrent!.roles.live.appPath), liveBefore);
    assert.deepEqual(contentsIdentity(secondCurrent!.paths.inactiveAppPath), inactiveBefore);
    assertEnvironmentModePairMaterialized(fixture.paths, secondCurrent!);

    const source = readFileSync(fileURLToPath(new URL("../src/environment-warm-commit.ts", import.meta.url)), "utf8");
    assert.doesNotMatch(source, /\b(?:buildPatchedCandidateOnly|cloneAppTree|copyDirectoryPreservingModes|hashTree|sealEnvironmentModeCacheTree)\b/);
  });
});

test("a pre-approval arbitrary nested app mutation is stale_requires_prepare before watcher pause or exact quit", async () => {
  await withFixture(async (fixture) => {
    const events: string[] = [];
    mutateNestedLeafWithRestoredMtime(fixture.liveLeaf);

    const receipt = await commit(fixture, warmDeps(fixture, events));

    assert.equal(receipt.phase, "stale_requires_prepare");
    assert.equal(receipt.exchangeCount, 0);
    assert.deepEqual(events, ["full-validate-stale"]);
    assert.match(receipt.error ?? "", /tree stat seal mismatch/);
    const current = readCurrentEnvironmentModePair(fixture.paths);
    assert.equal(current?.pin.state, "stale_requires_prepare");
    assert.equal(current?.pin.releaseReason, "invalidated");
  });
});

test("exact PID drift refuses after pause without broad kill or exchange", async () => {
  await withFixture(async (fixture) => {
    const events: string[] = [];
    const receipt = await commit(fixture, warmDeps(fixture, events, {
      stopExactSource: (source) => {
        events.push(`stop:${source.pid}`);
        throw new Error("captured main PID 101 drifted before quit");
      },
    }));

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.exchangeCount, 0);
    assert.deepEqual(events, ["preflight", "pause", "stop:101", "reopen", "resume-watcher"]);
    assert.match(receipt.error ?? "", /PID 101 drifted/);
    assert.equal(receipt.stamps.some((entry) => entry.phase === "source-watcher-resumed"), true);
  });
});

test("a watcher pause refusal does not manufacture ownership or attempt a mismatched resume", async () => {
  await withFixture(async (fixture) => {
    const events: string[] = [];
    const receipt = await commit(fixture, warmDeps(fixture, events, {
      pauseWatcher: () => {
        events.push("pause-refused");
        throw new Error("older watcher promotion remains paused");
      },
    }));

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.exchangeCount, 0);
    assert.deepEqual(events, ["preflight", "pause-refused"]);
    assert.equal(receipt.stamps.some((entry) => entry.phase === "source-watcher-resumed"), false);
  });
});

test("a late arbitrary nested app mutation after shutdown refuses before the sole exchange", async () => {
  await withFixture(async (fixture) => {
    const events: string[] = [];
    const receipt = await commit(fixture, warmDeps(fixture, events, {
      recheckSourceAfterShutdown: () => {
        events.push("recheck");
        mutateNestedLeafWithRestoredMtime(fixture.liveLeaf);
      },
    }));

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.exchangeCount, 0);
    assert.deepEqual(events, ["preflight", "pause", "stop:101", "recheck", "reopen", "resume-watcher"]);
    assert.match(receipt.error ?? "", /tree stat seal mismatch/);
    assert.equal(receipt.stamps.some((entry) => entry.phase === "source-watcher-resumed"), true);
  });
});

test("warm stat seals reject arbitrary nested app, runtime, and managed-runtime mutation with restored mtime", async () => {
  for (const target of ["liveLeaf", "inactiveLeaf", "runtimeLeaf", "managedRuntimeLeaf"] as const) {
    await withFixture((fixture) => {
      mutateNestedLeafWithRestoredMtime(fixture[target]);
      assert.throws(
        () => assertEnvironmentModePairWarmCommitMaterialized(fixture.paths, fixture.receipt),
        /tree stat seal mismatch/,
        target,
      );
    });
  }
});

test("a post-swap failure immediately exchanges Contents back and restores the projection", async () => {
  await withFixture(async (fixture) => {
    const events: string[] = [];
    const liveBefore = contentsIdentity(fixture.receipt.roles.live.appPath);
    const inactiveBefore = contentsIdentity(fixture.receipt.paths.inactiveAppPath);
    const receipt = await commit(fixture, warmDeps(fixture, events, {
      reopenTarget: () => {
        events.push("reopen");
        throw new Error("target launch failed");
      },
    }));

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.exchangeCount, 2);
    assert.equal(receipt.stamps.some((stamp) => stamp.phase === "exchange-reverted"), true);
    assert.deepEqual(events, [
      "preflight",
      "pause",
      "stop:101",
      "recheck",
      "exchange",
      "capture-proof",
      "project",
      "reopen",
      "pause",
      "observe-inverse-target",
      "stop-inverse:absent",
      "observe-inverse-target",
      "exchange",
      "restore",
    ]);
    assert.deepEqual(contentsIdentity(fixture.receipt.roles.live.appPath), liveBefore);
    assert.deepEqual(contentsIdentity(fixture.receipt.paths.inactiveAppPath), inactiveBefore);
    const current = readCurrentEnvironmentModePair(fixture.paths);
    assert.equal(current?.pin.state, "post_cutover_recovery");
    assert.equal(events.includes("resume-watcher"), false);
  });
});

test("every post-cutover failure pauses watcher and stops the exact live target before the inverse exchange", async () => {
  const phaseFaults: Array<{
    phase: string;
    override: (events: string[]) => Partial<EnvironmentWarmCommitDeps>;
  }> = [
    {
      phase: "projection",
      override: (events) => ({ projectTarget: () => { events.push("project"); throw new Error("fault: projection"); } }),
    },
    {
      phase: "reopen",
      override: (events) => ({ reopenTarget: () => { events.push("reopen"); throw new Error("fault: reopen"); } }),
    },
    {
      phase: "target proof",
      override: (events) => ({ proveTarget: () => { events.push("prove-target"); throw new Error("fault: target proof"); } }),
    },
    {
      phase: "watcher bind",
      override: (events) => ({ bindWatcherTarget: () => { events.push("bind-watcher"); throw new Error("fault: watcher bind"); } }),
    },
    {
      phase: "selection publication",
      override: (events) => ({ publishSelection: () => { events.push("publish-selection"); throw new Error("fault: selection publication"); } }),
    },
    {
      phase: "watcher resume",
      override: (events) => ({ resumeWatcher: () => { events.push("resume-watcher"); throw new Error("fault: watcher resume"); } }),
    },
  ];
  for (const fault of phaseFaults) {
    await withFixture(async (fixture) => {
      const events: string[] = [];
      let observed = false;
      const receipt = await commit(fixture, warmDeps(fixture, events, {
        ...fault.override(events),
        observeExactLiveTarget: ({ pair, expected }) => {
          assert.equal(pair.roles.live.experience, expected.appExperience, `${fault.phase}: rotated pair`);
          events.push(observed ? "observe-inverse-absent" : "observe-inverse-exact");
          if (observed) return { state: "absent" };
          observed = true;
          return { state: "exact", process: { ...expected, pid: 202, visibleWindow: true } };
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
      }));

      assert.equal(receipt.phase, "failed", fault.phase);
      assert.equal(receipt.exchangeCount, 2, fault.phase);
      const stampIndex = (phase: string) => receipt.stamps.findIndex((stamp) => stamp.phase === phase);
      assert.equal(stampIndex("inverse-watcher-paused") < stampIndex("inverse-target-quiescent"), true, fault.phase);
      assert.equal(stampIndex("inverse-target-quiescent") < stampIndex("inverse-exchange-intent"), true, fault.phase);
      assert.equal(stampIndex("inverse-exchange-intent") < stampIndex("exchange-reverted"), true, fault.phase);
      const initialExchange = events.indexOf("exchange");
      const inversePause = events.indexOf("pause", initialExchange + 1);
      const exactObservation = events.indexOf("observe-inverse-exact");
      const stopped = events.indexOf("stop-inverse:202");
      const absentObservation = events.indexOf("observe-inverse-absent");
      const inverseExchange = events.indexOf("exchange", initialExchange + 1);
      assert.equal(initialExchange < inversePause, true, fault.phase);
      assert.equal(inversePause < exactObservation, true, fault.phase);
      assert.equal(exactObservation < stopped, true, fault.phase);
      assert.equal(stopped < absentObservation, true, fault.phase);
      assert.equal(absentObservation < inverseExchange, true, fault.phase);
    });
  }
});

test("a pristine ChatGPT target fails closed if its dormant Tweakers loader or MCP remains active", async () => {
  await withFixture(async (fixture) => {
    const events: string[] = [];
    const receipt = await commit(fixture, warmDeps(fixture, events, {
      proveTarget: ({ pair, projection }) => {
        events.push("prove-target");
        return {
          ...targetProof(pair, projection),
          tweakersLoaderActive: true,
          mcpEnabled: true,
        };
      },
    }));

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.exchangeCount, 2);
    assert.match(receipt.error ?? "", /Pristine ChatGPT target still exposes dormant Tweakers runtime or MCP state/);
    assert.equal(events.includes("bind-watcher"), false);
    assert.equal(events.includes("publish-selection"), false);
    assert.equal(events.includes("resume-watcher"), false);
  }, "tweakers");
});
