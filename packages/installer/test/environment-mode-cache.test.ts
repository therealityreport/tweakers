import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertAtMostOneEnvironmentModeCachePreparation,
  assertEnvironmentModeCacheRootIsReal,
  assertEnvironmentModeCacheSameDevice,
  assertEnvironmentModeCacheSteadyState,
  assertEnvironmentModePairContentsExchangeable,
  assertEnvironmentModeCacheLiveTreeSeal,
  assertEnvironmentModeCacheTreeSeal,
  assertEnvironmentModeCacheTreeStatSealAfterRename,
  cancelStaleEnvironmentModePair,
  compareEnvironmentModeCacheInvalidation,
  environmentModeCacheGcEligibility,
  environmentModeCacheGenerationPaths,
  environmentModeCachePaths,
  environmentModeCacheReachability,
  environmentModeCacheState,
  environmentModePairReceiptDigest,
  environmentModePairStatSealDigest,
  finalizeEnvironmentModePairReceipt,
  invalidateCurrentEnvironmentModePair,
  invalidateEnvironmentModePair,
  isEnvironmentModeCacheTreeStatSeal,
  isEnvironmentModePairReceipt,
  markEnvironmentModePairPostCutoverRecovery,
  prepareAndPublishEnvironmentModePair,
  prepareOrReuseEnvironmentModePair,
  publishEnvironmentModePair,
  readCurrentEnvironmentModePair,
  readEnvironmentModePairGeneration,
  recordEnvironmentModePairHelperFailure,
  recordEnvironmentModePairPreCutoverCancellation,
  releaseCurrentEnvironmentModePairBeforeCutover,
  sealEnvironmentModeCacheTree,
  supersedePreparedEnvironmentModePair,
  validateCurrentEnvironmentModePair,
  type EnvironmentModePairReceipt,
} from "../src/environment-mode-cache";
import { runEnvironmentTransactionGc } from "../src/environment-gc";
import { writeEnvironmentWarmCommitReceipt } from "../src/environment-warm-commit";
import { createEnvironmentTiming } from "../src/environment-timing";

const HASH = "a".repeat(64);
const NOW = "2026-08-18T12:00:00.000Z";
const LATER = "2026-08-18T12:01:00.000Z";
const LATER_REPLACEMENT = "2026-08-18T12:02:00.000Z";

interface PairFixture {
  root: string;
  paths: ReturnType<typeof environmentModeCachePaths>;
  receipt: EnvironmentModePairReceipt;
  nestedLeaf: string;
}

function makePairFixture(generationId = "generation-a"): PairFixture {
  const lexicalRoot = mkdtempSync(join(tmpdir(), "tweaker-mode-cache-"));
  const paths = environmentModeCachePaths(lexicalRoot);
  return makePairInRoot(dirname(paths.cacheRoot), paths, generationId);
}

/** Run the reconciliation through a brand-new Node process to model owner death. */
function reconcileShadowInFreshProcess(environmentRoot: string): { generationId: string | null; digest: string | null } {
  const result = spawnSync(process.execPath, [
    "--import",
    "./scripts/test-root-preload.mjs",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    [
      'import { environmentModeCachePaths, reconcileCurrentEnvironmentModePairReceiptShadow } from "./packages/installer/src/environment-mode-cache.ts";',
      "const paths = environmentModeCachePaths(process.argv[1]);",
      "const receipt = reconcileCurrentEnvironmentModePairReceiptShadow(paths);",
      "process.stdout.write(JSON.stringify({ generationId: receipt?.generationId ?? null, digest: receipt?.invalidation.receiptDigest ?? null }));",
    ].join("\n"),
    environmentRoot,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || "fresh receipt-shadow reconciler failed");
  return JSON.parse(result.stdout) as { generationId: string | null; digest: string | null };
}

function makePairInRoot(
  root: string,
  paths: ReturnType<typeof environmentModeCachePaths>,
  generationId: string,
): PairFixture {
  const generation = environmentModeCacheGenerationPaths(paths, generationId);
  const liveAppPath = join(root, `live-${generationId}`, "ChatGPT.app");
  const nativeHostRoot = join(root, `native-host-${generationId}`);
  const nestedLeaf = writeAppTree(liveAppPath, `live-${generationId}`);
  writeAppTree(generation.inactiveAppPath, `inactive-${generationId}`);
  writeTree(generation.runtimeRoot, `runtime-${generationId}`);
  writeTree(generation.managedRuntimeRoot, `managed-${generationId}`);
  writeTree(nativeHostRoot, `native-${generationId}`);
  const appEvidence = (appPath: string) => ({
    bundleId: "com.openai.codex" as const,
    version: "26.818.1",
    build: "9001",
    appDigest: HASH,
    asarPath: join(appPath, "Contents", "Resources", "app.asar"),
    asarDigest: HASH,
    asarHeaderDigest: HASH,
    signature: {
      strict: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement: 'designated => identifier "com.openai.codex"',
      signatureDigest: HASH,
    },
  });
  const artifact = (rootPath: string) => ({ rootPath, digest: HASH, fileCount: 3, provenanceDigest: HASH });
  const receipt: EnvironmentModePairReceipt = {
    schemaVersion: 2,
    kind: "environment-mode-pair",
    generationId,
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
      live: { role: "live", experience: "chatgpt", appPath: liveAppPath, evidence: appEvidence(liveAppPath) },
      inactive: { role: "inactive", experience: "tweakers", appPath: generation.inactiveAppPath, evidence: appEvidence(generation.inactiveAppPath) },
    },
    tweakers: {
      buildDigest: HASH,
      patchPayloadDigest: HASH,
      sourceControlDigest: HASH,
      runtime: artifact(generation.runtimeRoot),
      managedRuntime: artifact(generation.managedRuntimeRoot),
      backend: { ...artifact(join(root, `backend-${generationId}`)), lane: "bundled", version: "0.145.0" },
      nativeHost: { ...artifact(nativeHostRoot), executablePath: join(nativeHostRoot, "host") },
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
        runtimeDigest: HASH,
        managedRuntimeDigest: HASH,
        backendDigest: HASH,
        nativeHostDigest: HASH,
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
      preparedAt: NOW,
      validatedAt: NOW,
      publishedAt: null,
      lastSuccessfulSwitchAt: null,
      lastPreCutoverCancellationAt: null,
      terminalAt: null,
    },
    pin: { state: "prepared", pinnedAt: NOW, releasedAt: null, releaseReason: null },
    supersession: { supersededAt: null, replacementGenerationId: null },
  };
  return { root, paths, receipt: finalizeEnvironmentModePairReceipt(receipt), nestedLeaf };
}

function writeAppTree(root: string, text: string): string {
  const leaf = join(root, "nested", "leaf.txt");
  mkdirSync(join(root, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "Contents", "Resources", "app.asar"), `${text}-asar`);
  writeFileSync(leaf, text);
  return leaf;
}

function writeTree(root: string, text: string): void {
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "artifact.txt"), text);
  writeFileSync(join(root, "nested", "leaf.txt"), text);
}

function cloneReceipt(receipt: EnvironmentModePairReceipt): EnvironmentModePairReceipt {
  return JSON.parse(JSON.stringify(receipt)) as EnvironmentModePairReceipt;
}

/** Recompute only the receipt digest so negative schema tests cannot rely on a stale checksum. */
function withRecomputedReceiptDigest(receipt: EnvironmentModePairReceipt): EnvironmentModePairReceipt {
  receipt.invalidation.receiptDigest = environmentModePairReceiptDigest(receipt);
  return receipt;
}

function receiptForMaterializedGeneration(
  source: EnvironmentModePairReceipt,
  generation: ReturnType<typeof environmentModeCacheGenerationPaths>,
): EnvironmentModePairReceipt {
  const receipt = cloneReceipt(source);
  receipt.generationId = generation.generationId;
  receipt.paths = {
    cacheRoot: dirname(dirname(generation.generationRoot)),
    currentFile: join(dirname(dirname(generation.generationRoot)), "current.json"),
    generationRoot: generation.generationRoot,
    receiptFile: generation.receiptFile,
    inactiveAppPath: generation.inactiveAppPath,
    runtimeRoot: generation.runtimeRoot,
    managedRuntimeRoot: generation.managedRuntimeRoot,
  };
  receipt.roles.inactive = {
    ...receipt.roles.inactive,
    appPath: generation.inactiveAppPath,
    evidence: {
      ...receipt.roles.inactive.evidence,
      asarPath: join(generation.inactiveAppPath, "Contents", "Resources", "app.asar"),
    },
  };
  receipt.tweakers = {
    ...receipt.tweakers,
    runtime: { ...receipt.tweakers.runtime, rootPath: generation.runtimeRoot },
    managedRuntime: { ...receipt.tweakers.managedRuntime, rootPath: generation.managedRuntimeRoot },
  };
  receipt.seals = {
    liveApp: sealEnvironmentModeCacheTree(receipt.roles.live.appPath),
    inactiveApp: sealEnvironmentModeCacheTree(generation.inactiveAppPath),
    runtime: sealEnvironmentModeCacheTree(generation.runtimeRoot),
    managedRuntime: sealEnvironmentModeCacheTree(generation.managedRuntimeRoot),
  };
  receipt.invalidation = {
    ...receipt.invalidation,
    environment: {
      ...receipt.invalidation.environment,
      contentsDevice: statSync(join(receipt.roles.live.appPath, "Contents")).dev.toString(),
    },
  };
  return finalizeEnvironmentModePairReceipt(receipt);
}

function invalidationSnapshot(receipt: EnvironmentModePairReceipt) {
  const { receiptDigest: _receiptDigest, ...snapshot } = receipt.invalidation;
  return snapshot;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test("schema-v2 pair receipts bind opposite roles, exact generation paths, evidence, seals, and pin state", () => {
  const fixture = makePairFixture();
  try {
    assert.equal(isEnvironmentModePairReceipt(fixture.receipt, fixture.paths), true);
    assert.equal(
      fixture.receipt.invalidation.environment.statSealDigest,
      environmentModePairStatSealDigest(fixture.receipt.seals),
    );
    assert.notEqual(fixture.receipt.invalidation.environment.statSealDigest, HASH,
      "finalization replaces the caller placeholder with canonical pair-seal evidence");
    const escaped = cloneReceipt(fixture.receipt);
    escaped.paths.runtimeRoot = join(fixture.root, "outside-runtime");
    assert.equal(isEnvironmentModePairReceipt(escaped, fixture.paths), false);

    const wrongRole = cloneReceipt(fixture.receipt);
    wrongRole.roles.inactive.experience = "chatgpt";
    assert.equal(isEnvironmentModePairReceipt(wrongRole, fixture.paths), false);

    const weakEvidence = cloneReceipt(fixture.receipt);
    weakEvidence.roles.live.evidence.asarHeaderDigest = "not-a-digest";
    assert.equal(isEnvironmentModePairReceipt(weakEvidence, fixture.paths), false);

    const missingPath = cloneReceipt(fixture.receipt) as unknown as { paths: Record<string, unknown> };
    delete missingPath.paths.managedRuntimeRoot;
    assert.equal(isEnvironmentModePairReceipt(missingPath, fixture.paths), false);
  } finally {
    cleanup(fixture.root);
  }
});

test("schema-v2 derives the invalidation stat seal from canonical role seals and rejects any detached value", () => {
  const fixture = makePairFixture();
  try {
    const detached = withRecomputedReceiptDigest(cloneReceipt(fixture.receipt));
    detached.invalidation.environment.statSealDigest = "b".repeat(64);
    withRecomputedReceiptDigest(detached);
    assert.equal(isEnvironmentModePairReceipt(detached, fixture.paths), false);

    const changedRoleSeal = cloneReceipt(fixture.receipt);
    changedRoleSeal.seals.liveApp.sealDigest = "b".repeat(64);
    withRecomputedReceiptDigest(changedRoleSeal);
    assert.equal(isEnvironmentModePairReceipt(changedRoleSeal, fixture.paths), false,
      "a role-seal mutation cannot retain a previously derived invalidation digest");
  } finally {
    cleanup(fixture.root);
  }
});

test("schema-v2 requires strict OpenAI receipt trust for every ChatGPT role but not the Tweakers role", () => {
  const fixture = makePairFixture();
  try {
    const weakChatgptCases: Array<{
      label: string;
      weaken: (receipt: EnvironmentModePairReceipt) => void;
    }> = [
      {
        label: "strict signature",
        weaken: (receipt) => { receipt.roles.live.evidence.signature.strict = false; },
      },
      {
        label: "Gatekeeper acceptance",
        weaken: (receipt) => { receipt.roles.live.evidence.signature.gatekeeper = false; },
      },
      {
        label: "OpenAI team identifier",
        weaken: (receipt) => { receipt.roles.live.evidence.signature.teamIdentifier = "OTHERTEAM"; },
      },
      {
        label: "designated requirement",
        weaken: (receipt) => { receipt.roles.live.evidence.signature.designatedRequirement = ""; },
      },
    ];
    for (const { label, weaken } of weakChatgptCases) {
      const candidate = cloneReceipt(fixture.receipt);
      weaken(candidate);
      withRecomputedReceiptDigest(candidate);
      assert.equal(isEnvironmentModePairReceipt(candidate, fixture.paths), false, label);
    }

    // Schema validation must not assume the pristine role is live. The same
    // receipt rule applies when ChatGPT is the inactive target before a swap.
    const inactiveChatgpt = cloneReceipt(fixture.receipt);
    inactiveChatgpt.roles.live.experience = "tweakers";
    inactiveChatgpt.roles.inactive.experience = "chatgpt";
    withRecomputedReceiptDigest(inactiveChatgpt);
    assert.equal(isEnvironmentModePairReceipt(inactiveChatgpt, fixture.paths), true);
    for (const { label } of weakChatgptCases) {
      const candidate = cloneReceipt(inactiveChatgpt);
      const inactiveSignature = candidate.roles.inactive.evidence.signature;
      // Reuse each concrete weakening against the equivalent inactive role.
      if (label === "strict signature") inactiveSignature.strict = false;
      if (label === "Gatekeeper acceptance") inactiveSignature.gatekeeper = false;
      if (label === "OpenAI team identifier") inactiveSignature.teamIdentifier = "OTHERTEAM";
      if (label === "designated requirement") inactiveSignature.designatedRequirement = "";
      withRecomputedReceiptDigest(candidate);
      assert.equal(isEnvironmentModePairReceipt(candidate, fixture.paths), false, `inactive ${label}`);
    }

    const weakenedTweakers = cloneReceipt(fixture.receipt);
    weakenedTweakers.roles.inactive.evidence.signature = {
      ...weakenedTweakers.roles.inactive.evidence.signature,
      strict: false,
      gatekeeper: false,
      teamIdentifier: null,
      designatedRequirement: null,
    };
    withRecomputedReceiptDigest(weakenedTweakers);
    assert.equal(isEnvironmentModePairReceipt(weakenedTweakers, fixture.paths), true,
      "Tweakers does not inherit the pristine ChatGPT Team ID rule");
  } finally {
    cleanup(fixture.root);
  }
});

test("cache root and generation containment reject symlink roots and path escape", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-mode-cache-link-"));
  try {
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, join(root, "environment-cache"));
    assert.throws(
      () => assertEnvironmentModeCacheRootIsReal(environmentModeCachePaths(root)),
      /must not be a symlink/,
    );
  } finally {
    cleanup(root);
  }
});

test("same-device checks accept materialized siblings and fail closed on a differing device", () => {
  const fixture = makePairFixture();
  try {
    assert.doesNotThrow(() => assertEnvironmentModeCacheSameDevice([
      fixture.receipt.roles.live.appPath,
      fixture.receipt.paths.inactiveAppPath,
    ]));
    assert.throws(() => assertEnvironmentModeCacheSameDevice([
      fixture.receipt.roles.live.appPath,
      fixture.receipt.paths.inactiveAppPath,
    ], {
      stat: (path) => ({ dev: path === fixture.receipt.roles.live.appPath ? 1 : 2 }),
    }), /same filesystem device/);
  } finally {
    cleanup(fixture.root);
  }
});

test("stat seals are deterministic and reject arbitrary nested leaf changes even when size and mtime are restored", () => {
  const fixture = makePairFixture();
  try {
    const first = sealEnvironmentModeCacheTree(fixture.receipt.roles.live.appPath);
    const second = sealEnvironmentModeCacheTree(fixture.receipt.roles.live.appPath);
    assert.deepEqual(second, first);
    assert.doesNotThrow(() => assertEnvironmentModeCacheTreeSeal(fixture.receipt.roles.live.appPath, first));

    const before = statSync(fixture.nestedLeaf);
    writeFileSync(fixture.nestedLeaf, "changed-leaf"); // exactly the original byte count
    utimesSync(fixture.nestedLeaf, before.atime, before.mtime);
    assert.throws(
      () => assertEnvironmentModeCacheTreeSeal(fixture.receipt.roles.live.appPath, first),
      /stat seal mismatch/,
    );
  } finally {
    cleanup(fixture.root);
  }
});

test("the live tree seal tolerates macOS stat churn but rejects shape and payload changes", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweaker-mode-cache-live-"));
  try {
    const live = join(root, "ChatGPT.app");
    mkdirSync(join(live, "Contents"), { recursive: true });
    writeFileSync(join(live, "Contents", "app.bin"), "live-payload-bytes\n");
    const seal = sealEnvironmentModeCacheTree(live);

    // First-launch provenance xattrs mutate ctime without touching content
    // (live failure 2026-08-20). Both live-tree variants must tolerate it.
    const xattr = spawnSync("xattr", ["-w", "com.test.provenance", "stamped", join(live, "Contents", "app.bin")]);
    assert.equal(xattr.status, 0);
    assert.doesNotThrow(() => assertEnvironmentModeCacheLiveTreeSeal(live, seal));
    assert.doesNotThrow(() => assertEnvironmentModeCacheLiveTreeSeal(live, seal, { verifyContent: true }));
    // The strict cache seal still rejects the same churn - cache-resident
    // trees keep the full stat pin.
    assert.throws(() => assertEnvironmentModeCacheTreeSeal(live, seal), /stat seal mismatch/);

    // A same-size payload edit passes the byte-free shape check but the
    // full-validator context still rejects it through the payload digests.
    const before = statSync(join(live, "Contents", "app.bin"));
    writeFileSync(join(live, "Contents", "app.bin"), "live-payload-bytez\n"); // exactly the original byte count
    utimesSync(join(live, "Contents", "app.bin"), before.atime, before.mtime);
    assert.doesNotThrow(() => assertEnvironmentModeCacheLiveTreeSeal(live, seal));
    assert.throws(
      () => assertEnvironmentModeCacheLiveTreeSeal(live, seal, { verifyContent: true }),
      /live tree seal mismatch/,
    );

    // Size and topology changes fail both variants.
    writeFileSync(join(live, "Contents", "app.bin"), "grown");
    assert.throws(() => assertEnvironmentModeCacheLiveTreeSeal(live, seal), /live tree seal mismatch/);
    writeFileSync(join(live, "Contents", "extra.bin"), "new-entry");
    assert.throws(() => assertEnvironmentModeCacheLiveTreeSeal(live, seal), /live tree seal mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an activated projection accepts only the root ctime change caused by rename", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweaker-mode-cache-rename-"));
  try {
    const staged = join(root, "staged");
    const active = join(root, "active");
    mkdirSync(join(staged, "nested"), { recursive: true });
    writeFileSync(join(staged, "nested", "runtime.js"), "sealed-runtime\n");
    const seal = sealEnvironmentModeCacheTree(staged);
    renameSync(staged, active);
    assert.doesNotThrow(() => assertEnvironmentModeCacheTreeStatSealAfterRename(active, seal));

    writeFileSync(join(active, "nested", "runtime.js"), "changed-runtime\n");
    assert.throws(
      () => assertEnvironmentModeCacheTreeStatSealAfterRename(active, seal),
      /stat seal mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat seals validate deterministic depth-first trees with prefix-sharing siblings", () => {
  const lexicalRoot = mkdtempSync(join(tmpdir(), "tweaker-mode-cache-prefix-tree-"));
  const root = dirname(environmentModeCachePaths(lexicalRoot).cacheRoot);
  try {
    mkdirSync(join(root, "packages", "nested"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "packages", "nested", "entry.js"), "export {};\n");
    const seal = sealEnvironmentModeCacheTree(root);
    assert.equal(isEnvironmentModeCacheTreeStatSeal(seal), true);
    assertEnvironmentModeCacheTreeSeal(root, seal);
  } finally {
    cleanup(lexicalRoot);
  }
});

test("current role state publication is atomic and restores the predecessor if replacement publication fails", () => {
  const first = makePairFixture("generation-a");
  try {
    const published = publishEnvironmentModePair(first.paths, first.receipt, { now: () => NOW });
    assert.equal(published.generationId, "generation-a");
    const currentBefore = readFileSync(first.paths.currentFile, "utf8");
    const generationBefore = readFileSync(first.receipt.paths.receiptFile, "utf8");
    const second = makePairInRoot(first.root, first.paths, "generation-b");
    assert.throws(() => publishEnvironmentModePair(first.paths, second.receipt, {
      now: () => LATER,
      beforeCurrentPublish: () => { throw new Error("forced publication failure"); },
    }), /forced publication failure/);
    assert.equal(readFileSync(first.paths.currentFile, "utf8"), currentBefore);
    assert.equal(readFileSync(first.receipt.paths.receiptFile, "utf8"), generationBefore);
    assert.equal(readCurrentEnvironmentModePair(first.paths)?.generationId, "generation-a");
    assert.equal(readEnvironmentModePairGeneration(first.paths, "generation-a")?.pin.state, "prepared");

    const replacement = publishEnvironmentModePair(first.paths, second.receipt, { now: () => LATER });
    assert.equal(replacement.generationId, "generation-b");
    const superseded = readEnvironmentModePairGeneration(first.paths, "generation-a");
    assert.equal(superseded?.pin.state, "stale_requires_prepare");
    assert.equal(superseded?.supersession.replacementGenerationId, "generation-b");
    assert.equal(readCurrentEnvironmentModePair(first.paths)?.generationId, "generation-b");
  } finally {
    cleanup(first.root);
  }
});

test("current.json is the sole authority and repairs every torn generation receipt shadow before the next publication", () => {
  const first = makePairFixture("shadow-authority-a");
  try {
    const original = publishEnvironmentModePair(first.paths, first.receipt, { now: () => NOW });
    const transitioned = invalidateEnvironmentModePair(original, LATER);

    // Process death after the generation receipt rename/fsync but before the
    // current-pointer rename/fsync: the old pointer must win and repair its
    // own shadow, rather than treating the shadow as a new publication.
    writeFileSync(original.paths.receiptFile, `${JSON.stringify(transitioned)}\n`);
    assert.equal(readCurrentEnvironmentModePair(first.paths)?.invalidation.receiptDigest, original.invalidation.receiptDigest);
    const repairedAfterShadow = reconcileShadowInFreshProcess(first.root);
    assert.equal(repairedAfterShadow.digest, original.invalidation.receiptDigest);
    assert.equal(
      readEnvironmentModePairGeneration(first.paths, original.generationId)?.invalidation.receiptDigest,
      original.invalidation.receiptDigest,
    );

    // Process death after the current-pointer rename/fsync while a stale
    // generation shadow remains: the new current pointer wins and reconstructs
    // its shadow. The next publication then proceeds from that repaired state.
    writeFileSync(first.paths.currentFile, `${JSON.stringify(transitioned)}\n`);
    writeFileSync(original.paths.receiptFile, `${JSON.stringify(original)}\n`);
    const repairedAfterCurrent = reconcileShadowInFreshProcess(first.root);
    assert.equal(repairedAfterCurrent.digest, transitioned.invalidation.receiptDigest);
    assert.equal(
      readEnvironmentModePairGeneration(first.paths, original.generationId)?.invalidation.receiptDigest,
      transitioned.invalidation.receiptDigest,
    );

    const replacement = makePairInRoot(first.root, first.paths, "shadow-authority-b");
    assert.equal(
      publishEnvironmentModePair(first.paths, replacement.receipt, { now: () => LATER_REPLACEMENT }).generationId,
      replacement.receipt.generationId,
    );
    assert.equal(readCurrentEnvironmentModePair(first.paths)?.generationId, replacement.receipt.generationId);
  } finally {
    cleanup(first.root);
  }
});

test("replacement supersedes only prepared pins; stale cancellation is terminal and idempotent", () => {
  const fixture = makePairFixture();
  try {
    const stale = supersedePreparedEnvironmentModePair(fixture.receipt, "generation-b", LATER);
    assert.equal(stale.pin.state, "stale_requires_prepare");
    assert.equal(stale.pin.releasedAt, LATER);
    assert.equal(stale.pin.releaseReason, "superseded");
    assert.deepEqual(stale.supersession, { supersededAt: LATER, replacementGenerationId: "generation-b" });
    const cancelled = cancelStaleEnvironmentModePair(stale, "2026-08-18T12:02:00.000Z");
    assert.equal(cancelled.pin.state, "cancelled");
    assert.equal(cancelled.pin.releaseReason, "superseded", "cancellation retains its stale release origin");
    assert.equal(cancelStaleEnvironmentModePair(cancelled, "2026-08-18T12:03:00.000Z"), cancelled);
    assert.equal(environmentModeCacheGcEligibility(cancelled, "generation-b").eligible, true);
    assert.equal(environmentModeCacheGcEligibility(cancelled, cancelled.generationId).eligible, false);
  } finally {
    cleanup(fixture.root);
  }
});

test("invalidated stale grants cancel terminally and retain their invalidation audit", () => {
  const fixture = makePairFixture();
  try {
    const invalidated = invalidateEnvironmentModePair(fixture.receipt, LATER);
    assert.equal(invalidated.pin.releaseReason, "invalidated");
    assert.deepEqual(invalidated.supersession, { supersededAt: null, replacementGenerationId: null });

    const cancelled = cancelStaleEnvironmentModePair(invalidated, LATER_REPLACEMENT);
    assert.equal(cancelled.pin.state, "cancelled");
    assert.equal(cancelled.pin.releaseReason, "invalidated");
    assert.equal(cancelled.pin.releasedAt, LATER, "the invalidation release timestamp remains durable");
    assert.equal(cancelled.timestamps.terminalAt, LATER_REPLACEMENT);
    assert.deepEqual(cancelled.supersession, { supersededAt: null, replacementGenerationId: null });
    assert.equal(isEnvironmentModePairReceipt(cancelled, fixture.paths), true);
    assert.equal(cancelStaleEnvironmentModePair(cancelled, "2026-08-18T12:03:00.000Z"), cancelled);
  } finally {
    cleanup(fixture.root);
  }
});

test("publication links an already-invalidated current generation to its replacement atomically", () => {
  const first = makePairFixture("invalidated-current");
  try {
    publishEnvironmentModePair(first.paths, first.receipt, { now: () => NOW });
    const invalidated = invalidateCurrentEnvironmentModePair(first.paths, first.receipt.generationId, LATER);
    assert.equal(invalidated.pin.releaseReason, "invalidated");
    const replacementFixture = makePairInRoot(first.root, first.paths, "replacement-after-invalidation");

    assert.throws(() => publishEnvironmentModePair(first.paths, replacementFixture.receipt, {
      now: () => LATER_REPLACEMENT,
      beforeCurrentPublish: () => { throw new Error("forced replacement pointer failure"); },
    }), /forced replacement pointer failure/);
    const afterFailedPointer = readCurrentEnvironmentModePair(first.paths);
    assert.equal(afterFailedPointer?.generationId, first.receipt.generationId);
    assert.deepEqual(afterFailedPointer?.supersession, { supersededAt: null, replacementGenerationId: null });
    assert.equal(readEnvironmentModePairGeneration(first.paths, first.receipt.generationId)?.pin.releaseReason, "invalidated");

    const published = publishEnvironmentModePair(first.paths, replacementFixture.receipt, {
      now: () => LATER_REPLACEMENT,
    });
    assert.equal(published.generationId, replacementFixture.receipt.generationId);
    const replaced = readEnvironmentModePairGeneration(first.paths, first.receipt.generationId);
    assert.equal(replaced?.pin.state, "stale_requires_prepare");
    assert.equal(replaced?.pin.releaseReason, "invalidated", "replacement does not rewrite invalidation origin");
    assert.equal(replaced?.pin.releasedAt, LATER);
    assert.equal(replaced?.timestamps.terminalAt, LATER);
    assert.deepEqual(replaced?.supersession, {
      supersededAt: LATER_REPLACEMENT,
      replacementGenerationId: replacementFixture.receipt.generationId,
    });
    assert.equal(readCurrentEnvironmentModePair(first.paths)?.generationId, replacementFixture.receipt.generationId);
  } finally {
    cleanup(first.root);
  }
});

test("pre-cutover cancellation and helper failure release ordinary pins", () => {
  const fixture = makePairFixture();
  try {
    const retained = recordEnvironmentModePairPreCutoverCancellation(fixture.receipt, LATER);
    assert.equal(retained.pin.state, "cancelled");
    assert.equal(retained.pin.releasedAt, LATER);
    assert.equal(retained.pin.releaseReason, "cancelled");
    assert.equal(retained.timestamps.lastPreCutoverCancellationAt, LATER);
    assert.equal(environmentModeCacheState({ current: retained }), "stale");
    assert.equal(environmentModeCacheGcEligibility(retained, null).eligible, true);
    const abandoned = recordEnvironmentModePairHelperFailure(fixture.receipt, "2026-08-18T12:02:00.000Z");
    assert.equal(abandoned.pin.state, "abandoned");
    assert.equal(abandoned.pin.releaseReason, "helper_failed");
    assert.equal(environmentModeCacheGcEligibility(abandoned, null).eligible, true);
  } finally {
    cleanup(fixture.root);
  }
});

test("post-cutover recovery remains reachable and cannot be accidentally superseded", () => {
  const fixture = makePairFixture();
  try {
    const recovery = markEnvironmentModePairPostCutoverRecovery(fixture.receipt);
    assert.equal(environmentModeCacheReachability(recovery, recovery.generationId), "post_cutover_recovery");
    assert.equal(environmentModeCacheState({ current: recovery }), "stale");
    assert.throws(() => supersedePreparedEnvironmentModePair(recovery, "generation-b", LATER), /Only a pre-cutover prepared/);
  } finally {
    cleanup(fixture.root);
  }
});

test("T6 retains a released current pointer until replacement, then reclaims only payload roots and keeps its compact receipt", () => {
  const first = makePairFixture("generation-a");
  try {
    publishEnvironmentModePair(first.paths, first.receipt, { now: () => NOW });
    const cancelled = releaseCurrentEnvironmentModePairBeforeCutover(
      first.paths,
      first.receipt.generationId,
      LATER,
      "cancelled",
    );
    assert.equal(readCurrentEnvironmentModePair(first.paths)?.invalidation.receiptDigest, cancelled.invalidation.receiptDigest);

    const beforeReplacement = runEnvironmentTransactionGc({
      receiptRoot: join(first.root, "transactions", "environment"),
      transactionFile: join(first.root, "transactions", "environment.json"),
      cachePaths: first.paths,
      mode: "dry-run",
    });
    assert.equal(beforeReplacement.generationEntries[0]?.action, "keep");
    assert.match(beforeReplacement.generationEntries[0]?.reason ?? "", /awaiting an atomic replacement or clear/);
    assert.equal(existsSync(first.receipt.paths.inactiveAppPath), true);

    const second = makePairInRoot(first.root, first.paths, "generation-b");
    publishEnvironmentModePair(first.paths, second.receipt, { now: () => LATER_REPLACEMENT });
    const oldGenerationRoot = first.receipt.paths.generationRoot;
    for (const name of ["backend", "native", "projection"]) {
      mkdirSync(join(oldGenerationRoot, name), { recursive: true });
      writeFileSync(join(oldGenerationRoot, name, "artifact"), name);
    }
    const helperLabel = `co.tweakers.environment.${first.receipt.generationId}`;
    for (const name of [
      "control-v2.json",
      "commit-helper.json",
      `${helperLabel}.sh`,
      `${helperLabel}.stdout.log`,
      `${helperLabel}.stderr.log`,
      `${helperLabel}.outcome.json`,
    ]) writeFileSync(join(oldGenerationRoot, name), name);
    const planned = runEnvironmentTransactionGc({
      receiptRoot: join(first.root, "transactions", "environment"),
      transactionFile: join(first.root, "transactions", "environment.json"),
      cachePaths: first.paths,
      mode: "dry-run",
    });
    const old = planned.generationEntries.find((entry) => entry.generationId === "generation-a");
    const current = planned.generationEntries.find((entry) => entry.generationId === "generation-b");
    assert.equal(old?.action, "delete");
    assert.equal(current?.action, "keep");

    const applied = runEnvironmentTransactionGc({
      receiptRoot: join(first.root, "transactions", "environment"),
      transactionFile: join(first.root, "transactions", "environment.json"),
      cachePaths: first.paths,
      mode: "apply",
    });
    assert.equal(applied.generationEntries.find((entry) => entry.generationId === "generation-a")?.action, "deleted");
    assert.equal(existsSync(first.receipt.paths.inactiveRoot), false);
    assert.equal(existsSync(first.receipt.paths.runtimeRoot), false);
    assert.equal(existsSync(first.receipt.paths.managedRuntimeRoot), false);
    assert.equal(existsSync(join(oldGenerationRoot, "backend")), false);
    assert.equal(existsSync(join(oldGenerationRoot, "native")), false);
    assert.equal(existsSync(join(oldGenerationRoot, "projection")), false);
    assert.equal(existsSync(join(oldGenerationRoot, "control-v2.json")), false);
    assert.equal(existsSync(join(oldGenerationRoot, "commit-helper.json")), false);
    assert.equal(existsSync(first.receipt.paths.receiptFile), true);
    assert.deepEqual(readdirSync(first.receipt.paths.generationRoot).sort(), ["receipt.json"]);
  } finally {
    cleanup(first.root);
  }
});

test("T6 fails closed when an unreachable generation has unexpected candidate, rollback, or native-host bytes", () => {
  const first = makePairFixture("generation-a");
  try {
    publishEnvironmentModePair(first.paths, first.receipt, { now: () => NOW });
    const second = makePairInRoot(first.root, first.paths, "generation-b");
    publishEnvironmentModePair(first.paths, second.receipt, { now: () => LATER });
    for (const name of ["candidate.app", "rollback.app", "native-host"]) {
      mkdirSync(join(first.receipt.paths.generationRoot, name));
    }
    const result = runEnvironmentTransactionGc({
      receiptRoot: join(first.root, "transactions", "environment"),
      transactionFile: join(first.root, "transactions", "environment.json"),
      cachePaths: first.paths,
      mode: "dry-run",
    });
    const old = result.generationEntries.find((entry) => entry.generationId === "generation-a");
    assert.equal(old?.action, "keep");
    assert.match(old?.reason ?? "", /unexpected retained payload entry/);
    assert.equal(existsSync(first.receipt.paths.inactiveAppPath), true);
  } finally {
    cleanup(first.root);
  }
});

test("T6 apply revalidates containment under the cache mutex before reclaiming a generation", () => {
  const first = makePairFixture("generation-a");
  try {
    publishEnvironmentModePair(first.paths, first.receipt, { now: () => NOW });
    const second = makePairInRoot(first.root, first.paths, "generation-b");
    publishEnvironmentModePair(first.paths, second.receipt, { now: () => LATER });
    const result = runEnvironmentTransactionGc({
      receiptRoot: join(first.root, "transactions", "environment"),
      transactionFile: join(first.root, "transactions", "environment.json"),
      cachePaths: first.paths,
      mode: "apply",
      beforeDeleteGeneration: (entry) => {
        if (entry.generationId === "generation-a") {
          mkdirSync(join(first.receipt.paths.generationRoot, "candidate.app"));
        }
      },
    });
    const old = result.generationEntries.find((entry) => entry.generationId === "generation-a");
    assert.equal(old?.action, "keep");
    assert.match(old?.reason ?? "", /revalidation refused.*unexpected retained payload entry/);
    assert.equal(existsSync(first.receipt.paths.inactiveAppPath), true);
  } finally {
    cleanup(first.root);
  }
});

test("T6 recognizes a nonterminal post-cutover journal as the sole recovery reachability oracle", () => {
  const fixture = makePairFixture();
  try {
    const recovery = markEnvironmentModePairPostCutoverRecovery(fixture.receipt);
    publishEnvironmentModePair(fixture.paths, fixture.receipt, { now: () => NOW });
    writeFileSync(fixture.paths.currentFile, `${JSON.stringify(recovery)}\n`);
    writeFileSync(fixture.receipt.paths.receiptFile, `${JSON.stringify(recovery)}\n`);
    writeEnvironmentWarmCommitReceipt(join(fixture.receipt.paths.generationRoot, "warm-commit.json"), {
      schemaVersion: 1,
      kind: "environment-warm-commit",
      transactionId: "recovery-transaction-a",
      generationId: recovery.generationId,
      pairReceiptDigest: recovery.invalidation.receiptDigest,
      sourceAppPath: recovery.roles.live.appPath,
      sourceProjection: null,
      targetExperience: recovery.roles.inactive.experience,
      sourceMainPid: null,
      targetMainPid: null,
      phase: "exchanged",
      error: null,
      exchangeCount: 1,
      exchangeBefore: null,
      recoveryExchangeBefore: null,
      stamps: [{ phase: "exchanged", at: LATER, detail: null }],
      timing: createEnvironmentTiming(NOW),
      createdAt: NOW,
      updatedAt: LATER,
      terminalAt: null,
    });
    const result = runEnvironmentTransactionGc({
      receiptRoot: join(fixture.root, "transactions", "environment"),
      transactionFile: join(fixture.root, "transactions", "environment.json"),
      cachePaths: fixture.paths,
      mode: "dry-run",
    });
    assert.equal(result.generationEntries[0]?.action, "keep");
    assert.match(result.generationEntries[0]?.reason ?? "", /nonterminal post-cutover recovery journal/);
  } finally {
    cleanup(fixture.root);
  }
});

test("one next generation is enforced and a published cache is steady only without that reservation", () => {
  const fixture = makePairFixture();
  try {
    publishEnvironmentModePair(fixture.paths, fixture.receipt, { now: () => NOW });
    assert.equal(assertEnvironmentModeCacheSteadyState(fixture.paths).generationId, fixture.receipt.generationId);
    mkdirSync(fixture.paths.preparationRoot, { recursive: true });
    writeFileSync(join(fixture.paths.preparationRoot, ".DS_Store"), "finder-metadata");
    assert.equal(assertEnvironmentModeCacheSteadyState(fixture.paths).generationId, fixture.receipt.generationId);
    mkdirSync(join(fixture.paths.preparationRoot, "generation-next-a"), { recursive: true });
    assert.equal(assertAtMostOneEnvironmentModeCachePreparation(fixture.paths), "generation-next-a");
    assert.throws(() => assertEnvironmentModeCacheSteadyState(fixture.paths), /not steady/);
    mkdirSync(join(fixture.paths.preparationRoot, "generation-next-b"));
    assert.throws(() => assertAtMostOneEnvironmentModeCachePreparation(fixture.paths), /at most one next generation/);
    assert.equal(environmentModeCacheState({ current: fixture.receipt, nextGenerationId: "generation-next-a" }), "preparing");
    assert.equal(environmentModeCacheState({ current: null }), "unavailable");
    assert.equal(environmentModeCacheState({ current: fixture.receipt, unavailable: true }), "unavailable");
  } finally {
    cleanup(fixture.root);
  }
});

test("T3 reclaims one orphaned unpublished next generation before staging a fresh pair", async () => {
  const source = makePairFixture("source");
  const root = mkdtempSync(join(tmpdir(), "tweaker-mode-cache-orphaned-next-"));
  const paths = environmentModeCachePaths(root);
  const orphaned = join(paths.preparationRoot, "orphaned");
  try {
    mkdirSync(orphaned, { recursive: true });
    writeFileSync(join(paths.preparationRoot, ".DS_Store"), "finder-root-metadata");
    writeFileSync(join(orphaned, ".DS_Store"), "finder-generation-metadata");
    writeFileSync(join(orphaned, "partial"), "unpublished-candidate-bytes");

    const published = await prepareAndPublishEnvironmentModePair(paths, "fresh", {
      stage: ({ preparation }) => {
        writeAppTree(preparation.inactiveAppPath, "fresh-inactive");
        writeTree(preparation.runtimeRoot, "fresh-runtime");
        writeTree(preparation.managedRuntimeRoot, "fresh-managed-runtime");
      },
      validatePrepared: () => {},
      createValidatedReceipt: ({ generation }) => receiptForMaterializedGeneration(source.receipt, generation),
    }, { now: () => NOW });

    assert.equal(published.generationId, "fresh");
    assert.equal(existsSync(orphaned), false);
    assert.equal(readCurrentEnvironmentModePair(paths)?.generationId, "fresh");
    assert.equal(assertAtMostOneEnvironmentModeCachePreparation(paths), null);
  } finally {
    cleanup(source.root);
    cleanup(root);
  }
});

test("preparation metadata is ignored only when .DS_Store is a real regular file", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-mode-cache-next-metadata-"));
  const paths = environmentModeCachePaths(root);
  try {
    mkdirSync(join(paths.preparationRoot, ".DS_Store"), { recursive: true });
    assert.throws(
      () => assertAtMostOneEnvironmentModeCachePreparation(paths),
      /preparation metadata must be a regular file/,
    );
  } finally {
    cleanup(root);
  }
});

test("T3 stages one immutable next generation, revalidates final paths, then atomically publishes", async () => {
  const source = makePairFixture("source");
  const root = mkdtempSync(join(tmpdir(), "tweaker-mode-cache-stage-"));
  const paths = environmentModeCachePaths(root);
  const calls: string[] = [];
  const beforeLive = readFileSync(source.nestedLeaf, "utf8");
  try {
    const published = await prepareAndPublishEnvironmentModePair(paths, "prepared-a", {
      stage: ({ preparation }) => {
        calls.push("stage");
        writeAppTree(preparation.inactiveAppPath, "prepared-inactive");
        writeTree(preparation.runtimeRoot, "prepared-runtime");
        writeTree(preparation.managedRuntimeRoot, "prepared-managed-runtime");
      },
      validatePrepared: ({ preparation }) => {
        calls.push("validate-next");
        assert.equal(existsSync(preparation.inactiveAppPath), true);
        assert.equal(existsSync(preparation.runtimeRoot), true);
        assert.equal(existsSync(preparation.managedRuntimeRoot), true);
      },
      createValidatedReceipt: ({ generation }) => {
        calls.push("validate-generation");
        return receiptForMaterializedGeneration(source.receipt, generation);
      },
    }, { now: () => NOW });
    assert.deepEqual(calls, ["stage", "validate-next", "validate-generation"]);
    assert.equal(published.generationId, "prepared-a");
    assert.equal(assertAtMostOneEnvironmentModeCachePreparation(paths), null);
    assert.equal(readCurrentEnvironmentModePair(paths)?.generationId, "prepared-a");
    assert.equal(readFileSync(source.nestedLeaf, "utf8"), beforeLive, "preparation never writes the live app");
  } finally {
    cleanup(source.root);
    cleanup(root);
  }
});

test("T3 reuses only a fully validated current generation and performs no build on a cache hit", async () => {
  const fixture = makePairFixture("cache-hit");
  let stageCalls = 0;
  try {
    publishEnvironmentModePair(fixture.paths, fixture.receipt, { now: () => NOW });
    const result = await prepareOrReuseEnvironmentModePair(fixture.paths, "must-not-stage", {
      inspectInvalidation: (receipt) => invalidationSnapshot(receipt),
      stage: () => { stageCalls += 1; },
      validatePrepared: () => { stageCalls += 1; },
      createValidatedReceipt: () => fixture.receipt,
    }, { now: () => LATER });
    assert.equal(result.state, "cache_hit");
    assert.equal(result.receipt.generationId, fixture.receipt.generationId);
    assert.equal(stageCalls, 0, "a validated cache hit never starts candidate work");
    assert.equal(existsSync(environmentModeCacheGenerationPaths(fixture.paths, "must-not-stage").generationRoot), false);
  } finally {
    cleanup(fixture.root);
  }
});

test("T3 removes a failed unpublished next reservation and never publishes partial generation bytes", async () => {
  const source = makePairFixture("source");
  const root = mkdtempSync(join(tmpdir(), "tweaker-mode-cache-stage-fail-"));
  const paths = environmentModeCachePaths(root);
  try {
    await assert.rejects(() => prepareAndPublishEnvironmentModePair(paths, "prepared-fail", {
      stage: ({ preparation }) => {
        writeAppTree(preparation.inactiveAppPath, "partial");
        writeTree(preparation.runtimeRoot, "partial");
        writeTree(preparation.managedRuntimeRoot, "partial");
        // macOS Finder may add this while a large candidate is staged. It is
        // metadata, not a second reservation, and cleanup must remove it with
        // the exact unpublished generation after a pre-publication failure.
        writeFileSync(join(preparation.generationRoot, ".DS_Store"), "finder-metadata");
      },
      validatePrepared: () => { throw new Error("forced pre-publish validation failure"); },
      createValidatedReceipt: () => source.receipt,
    }), /forced pre-publish validation failure/);
    assert.equal(readCurrentEnvironmentModePair(paths), null);
    assert.equal(assertAtMostOneEnvironmentModeCachePreparation(paths), null);
    assert.equal(existsSync(environmentModeCacheGenerationPaths(paths, "prepared-fail").generationRoot), false);
  } finally {
    cleanup(source.root);
    cleanup(root);
  }
});

test("T3 cache validation runs the full validator after a stat-seal mismatch and terminally invalidates", () => {
  const fixture = makePairFixture();
  let fullValidatorCalls = 0;
  try {
    publishEnvironmentModePair(fixture.paths, fixture.receipt, { now: () => NOW });
    const before = statSync(fixture.nestedLeaf);
    writeFileSync(fixture.nestedLeaf, "changed-leaf");
    utimesSync(fixture.nestedLeaf, before.atime, before.mtime);
    const result = validateCurrentEnvironmentModePair(fixture.paths, {
      inspectInvalidation: (receipt) => {
        fullValidatorCalls += 1;
        return invalidationSnapshot(receipt);
      },
    }, () => LATER);
    assert.equal(fullValidatorCalls, 1, "full validation occurs even after a seal failure");
    assert.equal(result.state, "stale_requires_prepare");
    assert.equal(result.receipt?.pin.state, "stale_requires_prepare");
    assert.ok(result.reasons.some((reason) => reason.startsWith("stat-seal:")));
    assert.equal(readCurrentEnvironmentModePair(fixture.paths)?.pin.releaseReason, "invalidated");
  } finally {
    cleanup(fixture.root);
  }
});

test("T3 invalidation snapshots reject every practical invalidation input", () => {
  const cases: Array<{
    group: "official" | "tweakers" | "environment";
    key: string;
    replacement: string;
  }> = [
    { group: "official", key: "version", replacement: "26.818.2" },
    { group: "official", key: "build", replacement: "9002" },
    { group: "official", key: "trustDigest", replacement: "b".repeat(64) },
    { group: "official", key: "signatureDigest", replacement: "b".repeat(64) },
    { group: "official", key: "asarDigest", replacement: "b".repeat(64) },
    { group: "official", key: "asarHeaderDigest", replacement: "b".repeat(64) },
    { group: "official", key: "backendDigest", replacement: "b".repeat(64) },
    { group: "official", key: "updaterDigest", replacement: "b".repeat(64) },
    { group: "tweakers", key: "sourceDigest", replacement: "b".repeat(64) },
    { group: "tweakers", key: "buildDigest", replacement: "b".repeat(64) },
    { group: "tweakers", key: "patchPayloadDigest", replacement: "b".repeat(64) },
    { group: "tweakers", key: "runtimeDigest", replacement: "b".repeat(64) },
    { group: "tweakers", key: "managedRuntimeDigest", replacement: "b".repeat(64) },
    { group: "tweakers", key: "backendDigest", replacement: "b".repeat(64) },
    { group: "tweakers", key: "nativeHostDigest", replacement: "b".repeat(64) },
    { group: "environment", key: "profileDigest", replacement: "b".repeat(64) },
    { group: "environment", key: "pathsDigest", replacement: "b".repeat(64) },
    { group: "environment", key: "contentsDevice", replacement: "999999" },
    { group: "environment", key: "statSealDigest", replacement: "b".repeat(64) },
    { group: "environment", key: "mcpHelperDigest", replacement: "b".repeat(64) },
    { group: "environment", key: "lifecycleJournalDigest", replacement: "b".repeat(64) },
  ];
  for (const item of cases) {
    const fixture = makePairFixture(`generation-${item.group}-${item.key}`);
    try {
      publishEnvironmentModePair(fixture.paths, fixture.receipt, { now: () => NOW });
      const observed = invalidationSnapshot(fixture.receipt);
      const mutable = JSON.parse(JSON.stringify(observed)) as Record<string, Record<string, string>>;
      mutable[item.group]![item.key] = item.replacement;
      assert.deepEqual(compareEnvironmentModeCacheInvalidation(
        fixture.receipt.invalidation,
        mutable as typeof observed,
      ), [item.group]);
      const result = validateCurrentEnvironmentModePair(fixture.paths, {
        inspectInvalidation: () => mutable as typeof observed,
      }, () => LATER);
      assert.equal(result.state, "stale_requires_prepare", `${item.group}.${item.key}`);
      assert.ok(result.reasons.includes(`invalidation: ${item.group}`));
    } finally {
      cleanup(fixture.root);
    }
  }
});

test("T3 requires the actual Contents directories to be exchangeable on one device", () => {
  const fixture = makePairFixture();
  try {
    assert.doesNotThrow(() => assertEnvironmentModePairContentsExchangeable(fixture.receipt));
    assert.throws(() => assertEnvironmentModePairContentsExchangeable(fixture.receipt, {
      stat: (path) => ({ dev: path === join(fixture.receipt.roles.live.appPath, "Contents") ? 1 : 2 }),
    }), /same filesystem device/);
  } finally {
    cleanup(fixture.root);
  }
});
