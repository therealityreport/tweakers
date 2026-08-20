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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { runEnvironmentTransactionGc } from "../src/environment-gc";
import {
  acquireCurrentEnvironmentModePairWarmCommitLease,
  environmentModeCacheGenerationPaths,
  environmentModeCachePaths,
  finalizeEnvironmentModePairReceipt,
  publishEnvironmentModePair,
  sealEnvironmentModeCacheTree,
  type EnvironmentModeCacheContentsIdentity,
  type EnvironmentModeCacheOuterAppEvidence,
  type EnvironmentModePairReceipt,
} from "../src/environment-mode-cache";
import {
  createEnvironmentProfileRegistry,
  createEnvironmentSelection,
  type EnvironmentSelection,
} from "../src/environment-profile";
import {
  writeEnvironmentTransactionReceipt,
  type EnvironmentTransactionPhase,
  type EnvironmentTransactionReceipt,
  type PreparedEnvironmentEvidence,
} from "../src/environment-transaction";
import {
  captureEnvironmentModeCacheContentsIdentity,
  writeEnvironmentWarmCommitReceipt,
} from "../src/environment-warm-commit";
import { createEnvironmentTiming } from "../src/environment-timing";

const BASE = "2026-07-17T01:00:00.000Z";

function selections(): { source: EnvironmentSelection; requested: EnvironmentSelection } {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
  });
  return {
    source: createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "tweakers",
      requestedAt: BASE,
      appliedAt: "2026-07-17T01:00:01.000Z",
    }),
    requested: createEnvironmentSelection({
      profile: registry.profiles.alpha,
      appExperience: "tweakers",
      requestedAt: "2026-07-17T02:00:00.000Z",
    }),
  };
}

function prepared(root: string, id: string, source: EnvironmentSelection, requested: EnvironmentSelection): PreparedEnvironmentEvidence {
  const preparedRoot = join(root, id, "prepared");
  return {
    preparedAt: "2026-07-17T02:00:01.000Z",
    candidate: {
      desktopPath: requested.selectedDesktopPath,
      artifactPath: join(preparedRoot, "candidate.app"),
      bundleId: requested.selectedDesktopBundleId,
      appExperience: requested.appExperience,
      releaseProfile: requested.releaseProfile,
      version: "26.717.1",
      build: "6001",
      artifactDigest: "candidate-digest",
      asarHeaderHash: "a".repeat(64),
      signature: {
        strict: true,
        gatekeeper: false,
        designatedRequirement: "identifier local.tweakers",
        teamIdentifier: "LOCALTEAM",
      },
    },
    backend: {
      lane: requested.backendLane,
      binaryPath: "/Applications/ChatGPT (Beta).app/Contents/Resources/codex",
      artifactPath: join(preparedRoot, "backend", "requested-codex"),
      version: "0.145.0-alpha.3",
      artifactDigest: "candidate-backend-digest",
    },
    rollback: {
      selection: source,
      desktopPath: source.selectedDesktopPath,
      desktopArtifactPath: join(preparedRoot, "rollback.app"),
      archivePath: join(root, "archives", id, "ChatGPT.app"),
      bundleId: source.selectedDesktopBundleId,
      desktopVersion: "26.707.1",
      desktopBuild: "5900",
      desktopArtifactDigest: "rollback-digest",
      desktopAsarHeaderHash: "b".repeat(64),
      backendLane: source.backendLane,
      backendBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      backendArtifactPath: join(preparedRoot, "backend", "rollback-codex"),
      backendVersion: "0.144.0",
      backendArtifactDigest: "rollback-backend-digest",
    },
  };
}

function receipt(
  receiptRoot: string,
  id: string,
  phase: EnvironmentTransactionPhase,
  updatedAt: string,
): EnvironmentTransactionReceipt {
  const { source, requested } = selections();
  const evidence = prepared(receiptRoot, id, source, requested);
  const appliedSelection = { ...requested, appliedAt: updatedAt };
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId: id,
    phase,
    error: phase === "failed" ? "fixture failure" : null,
    ownerPid: 9001,
    source,
    requested,
    prepared: evidence,
    applied: phase === "committed" ? {
      observedAt: updatedAt,
      selection: appliedSelection,
      desktopVersion: evidence.candidate.version,
      desktopBuild: evidence.candidate.build,
      backendVersion: evidence.backend.version,
      desktopArtifactDigest: evidence.candidate.artifactDigest,
      asarHeaderHash: evidence.candidate.asarHeaderHash,
      backendArtifactDigest: evidence.backend.artifactDigest,
    } : null,
    oldMainPid: 100,
    newMainPid: phase === "committed" ? 101 : null,
    attempt: phase === "committed" ? 1 : 0,
    createdAt: "2026-07-17T02:00:00.000Z",
    updatedAt,
    committedAt: phase === "committed" ? updatedAt : null,
    rolledBackAt: null,
    cancelledAt: phase === "cancelled" ? updatedAt : null,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-gc-"));
  const receiptRoot = join(root, "transactions", "environment");
  const transactionFile = join(root, "transactions", "environment.json");
  mkdirSync(receiptRoot, { recursive: true });
  const add = (id: string, phase: EnvironmentTransactionPhase, updatedAt: string, bytes = 32) => {
    const value = receipt(receiptRoot, id, phase, updatedAt);
    const preparedRoot = join(receiptRoot, id, "prepared");
    mkdirSync(preparedRoot, { recursive: true });
    writeFileSync(join(preparedRoot, "payload.bin"), Buffer.alloc(bytes, id));
    writeEnvironmentTransactionReceipt(join(receiptRoot, `${id}.json`), value);
    return value;
  };
  return { root, receiptRoot, transactionFile, add };
}

/** Build one fully materialized, terminally proved v2 pair in this disposable GC fixture. */
function makeProvedCurrentV2Pair(root: string): ReturnType<typeof environmentModeCachePaths> {
  const physicalRoot = realpathSync(root);
  const paths = environmentModeCachePaths(physicalRoot);
  const generation = environmentModeCacheGenerationPaths(paths, "proved-v2-generation");
  const liveAppPath = join(physicalRoot, "v2-live", "ChatGPT.app");
  const writeApp = (appPath: string, marker: string): void => {
    mkdirSync(join(appPath, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(appPath, "outer-only"), { recursive: true });
    writeFileSync(join(appPath, "Contents", "Resources", "app.asar"), `${marker}-asar`);
    writeFileSync(join(appPath, "Contents", "Resources", "payload.txt"), marker);
    writeFileSync(join(appPath, "outer-only", "retained.txt"), marker);
  };
  const writeTree = (path: string, marker: string): void => {
    mkdirSync(join(path, "nested"), { recursive: true });
    writeFileSync(join(path, "artifact.txt"), marker);
    writeFileSync(join(path, "nested", "leaf.txt"), marker);
  };
  writeApp(liveAppPath, "v2-source");
  writeApp(generation.inactiveAppPath, "v2-target");
  writeTree(generation.runtimeRoot, "v2-runtime");
  writeTree(generation.managedRuntimeRoot, "v2-managed-runtime");
  const backendRoot = join(physicalRoot, "v2-backend");
  const nativeHostRoot = join(physicalRoot, "v2-native-host");
  writeTree(backendRoot, "v2-backend");
  writeTree(nativeHostRoot, "v2-native-host");
  writeFileSync(join(nativeHostRoot, "host"), "native-host");

  const hash = "a".repeat(64);
  const evidence = (appPath: string, marker: "source" | "target") => ({
    bundleId: "com.openai.codex" as const,
    version: "26.818.1",
    build: "9001",
    appDigest: marker === "source" ? "b".repeat(64) : "c".repeat(64),
    asarPath: join(appPath, "Contents", "Resources", "app.asar"),
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
  const artifact = (rootPath: string, digest = hash) => ({ rootPath, digest, fileCount: 3, provenanceDigest: digest });
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
      live: { role: "live", experience: "chatgpt", appPath: liveAppPath, evidence: evidence(liveAppPath, "source") },
      inactive: { role: "inactive", experience: "tweakers", appPath: generation.inactiveAppPath, evidence: evidence(generation.inactiveAppPath, "target") },
    },
    tweakers: {
      buildDigest: hash,
      patchPayloadDigest: hash,
      sourceControlDigest: hash,
      runtime: artifact(generation.runtimeRoot, "4".repeat(64)),
      managedRuntime: artifact(generation.managedRuntimeRoot, "5".repeat(64)),
      backend: { ...artifact(backendRoot, "6".repeat(64)), lane: "bundled", version: "0.145.0" },
      nativeHost: { ...artifact(nativeHostRoot, "7".repeat(64)), executablePath: join(nativeHostRoot, "host") },
    },
    seals: {
      liveApp: sealEnvironmentModeCacheTree(liveAppPath),
      inactiveApp: sealEnvironmentModeCacheTree(generation.inactiveAppPath),
      runtime: sealEnvironmentModeCacheTree(generation.runtimeRoot),
      managedRuntime: sealEnvironmentModeCacheTree(generation.managedRuntimeRoot),
    },
    invalidation: {
      official: {
        version: "26.818.1", build: "9001", trustDigest: hash, signatureDigest: hash,
        asarDigest: hash, asarHeaderDigest: hash, backendDigest: hash, updaterDigest: hash,
      },
      tweakers: {
        sourceDigest: hash, buildDigest: hash, patchPayloadDigest: hash, runtimeDigest: "4".repeat(64),
        managedRuntimeDigest: "5".repeat(64), backendDigest: "6".repeat(64), nativeHostDigest: "7".repeat(64),
      },
      environment: {
        profileDigest: hash,
        pathsDigest: hash,
        contentsDevice: statSync(join(liveAppPath, "Contents")).dev.toString(),
        statSealDigest: hash,
        mcpHelperDigest: hash,
        lifecycleJournalDigest: hash,
      },
      receiptDigest: hash,
    },
    timestamps: {
      preparedAt: BASE,
      validatedAt: BASE,
      publishedAt: null,
      lastSuccessfulSwitchAt: null,
      lastPreCutoverCancellationAt: null,
      terminalAt: null,
    },
    pin: { state: "prepared", pinnedAt: BASE, releasedAt: null, releaseReason: null },
    supersession: { supersededAt: null, replacementGenerationId: null },
  };
  publishEnvironmentModePair(paths, finalizeEnvironmentModePairReceipt(raw), { now: () => BASE });
  const lease = acquireCurrentEnvironmentModePairWarmCommitLease(paths);
  try {
    const pair = lease.receipt;
    const contents = (appPath: string): EnvironmentModeCacheContentsIdentity =>
      captureEnvironmentModeCacheContentsIdentity(join(appPath, "Contents"));
    const outer = (appPath: string): EnvironmentModeCacheOuterAppEvidence => {
      const stat = lstatSync(appPath, { bigint: true });
      return {
        path: appPath,
        stat: {
          relativePath: "", type: "directory", dev: stat.dev.toString(), ino: stat.ino.toString(),
          size: stat.size.toString(), mode: stat.mode.toString(), mtimeNs: stat.mtimeNs.toString(),
          ctimeNs: stat.ctimeNs.toString(), symlinkTarget: null,
        },
        uid: stat.uid.toString(), gid: stat.gid.toString(),
        aclDigest: hash, xattrDigest: hash, quarantineDigest: hash,
      };
    };
    const before = {
      liveContentsBefore: contents(pair.roles.live.appPath),
      inactiveContentsBefore: contents(pair.paths.inactiveAppPath),
      liveOuterBefore: outer(pair.roles.live.appPath),
      inactiveOuterBefore: outer(pair.paths.inactiveAppPath),
    };
    const temporary = join(physicalRoot, "v2-contents-swap-temporary");
    renameSync(before.liveContentsBefore.path, temporary);
    renameSync(before.inactiveContentsBefore.path, before.liveContentsBefore.path);
    renameSync(temporary, before.inactiveContentsBefore.path);
    lease.completeContentsExchange({
      ...before,
      liveContentsAfter: contents(pair.roles.live.appPath),
      inactiveContentsAfter: contents(pair.paths.inactiveAppPath),
      liveOuterAfter: outer(pair.roles.live.appPath),
      inactiveOuterAfter: outer(pair.paths.inactiveAppPath),
    }, "2026-07-17T03:00:00.000Z");
    const terminal = lease.completeTerminalTargetProof();
    writeEnvironmentWarmCommitReceipt(join(terminal.paths.generationRoot, "warm-commit.json"), {
      schemaVersion: 1,
      kind: "environment-warm-commit",
      transactionId: "proved-v2-warm-commit",
      generationId: terminal.generationId,
      pairReceiptDigest: terminal.invalidation.receiptDigest,
      sourceAppPath: terminal.roles.live.appPath,
      sourceProjection: null,
      targetExperience: terminal.roles.live.experience,
      sourceMainPid: 101,
      targetMainPid: 202,
      phase: "ready",
      error: null,
      exchangeCount: 1,
      exchangeBefore: null,
      recoveryExchangeBefore: null,
      stamps: [
        { phase: "terminal-target-proven", at: "2026-07-17T03:00:00.000Z", detail: null },
        { phase: "ready", at: "2026-07-17T03:00:00.000Z", detail: null },
      ],
      timing: { ...createEnvironmentTiming(BASE), readyAt: "2026-07-17T03:00:00.000Z" },
      createdAt: BASE,
      updatedAt: "2026-07-17T03:00:00.000Z",
      terminalAt: "2026-07-17T03:00:00.000Z",
    });
  } finally {
    lease.release();
  }
  return paths;
}

test("dry run keeps active, non-terminal, recovery-owned, unsafe, and newest v1 rollback roots until v2 proof exists", () => {
  const f = fixture();
  try {
    f.add("old-committed", "committed", "2026-07-17T02:01:00.000Z");
    f.add("new-committed", "committed", "2026-07-17T02:02:00.000Z");
    const current = f.add("current-failed", "failed", "2026-07-17T02:03:00.000Z");
    f.add("non-terminal", "prepared", "2026-07-17T02:04:00.000Z");
    const liveOwner = f.add("live-owner", "cancelled", "2026-07-17T02:05:00.000Z");
    liveOwner.ownerPid = 9002;
    writeEnvironmentTransactionReceipt(join(f.receiptRoot, "live-owner.json"), liveOwner);
    f.add("terminal", "cancelled", "2026-07-17T02:06:00.000Z");
    writeEnvironmentTransactionReceipt(f.transactionFile, current);

    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "keep");
    const symlinkReceipt = f.add("symlinked", "cancelled", "2026-07-17T02:07:00.000Z");
    rmSync(join(f.receiptRoot, "symlinked", "prepared"), { recursive: true });
    symlinkSync(outside, join(f.receiptRoot, "symlinked", "prepared"));
    writeEnvironmentTransactionReceipt(join(f.receiptRoot, "symlinked.json"), symlinkReceipt);

    const transactionOutside = join(f.root, "transaction-outside");
    mkdirSync(join(transactionOutside, "prepared"), { recursive: true });
    writeFileSync(join(transactionOutside, "prepared", "sentinel"), "keep");
    const symlinkedTransactionReceipt = f.add(
      "symlinked-transaction",
      "cancelled",
      "2026-07-17T02:08:00.000Z",
    );
    rmSync(join(f.receiptRoot, "symlinked-transaction"), { recursive: true });
    symlinkSync(transactionOutside, join(f.receiptRoot, "symlinked-transaction"));
    writeEnvironmentTransactionReceipt(
      join(f.receiptRoot, "symlinked-transaction.json"),
      symlinkedTransactionReceipt,
    );

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "dry-run",
      now: new Date("2026-07-17T03:00:00.000Z"),
      processAlive: (pid) => pid === 9002,
    });
    const byId = new Map(result.entries.map((entry) => [entry.transactionId, entry]));

    assert.equal(byId.get("current-failed")?.action, "keep");
    assert.match(byId.get("current-failed")?.reason ?? "", /only copy of its rollback evidence/);
    assert.equal(byId.get("non-terminal")?.action, "keep");
    assert.match(byId.get("non-terminal")?.reason ?? "", /non-terminal/);
    assert.equal(byId.get("new-committed")?.action, "keep");
    assert.match(byId.get("new-committed")?.reason ?? "", /newest committed schema-v1 rollback evidence/);
    assert.equal(byId.get("live-owner")?.action, "delete");
    assert.equal(byId.get("symlinked")?.action, "keep");
    assert.match(byId.get("symlinked")?.reason ?? "", /symlink/);
    assert.equal(byId.get("symlinked-transaction")?.action, "keep");
    assert.match(byId.get("symlinked-transaction")?.reason ?? "", /symlink/);
    assert.equal(byId.get("old-committed")?.action, "delete");
    assert.equal(byId.get("terminal")?.action, "delete");
    assert.equal(existsSync(join(outside, "sentinel")), true);
    assert.equal(existsSync(join(transactionOutside, "prepared", "sentinel")), true);
    assert.equal(result.reclaimedBytes, 0, "dry-run never reclaims payload bytes");
    assert.equal(result.retainedRollbackTransactionId, "new-committed");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("dry run retains only the newest committed v1 rollback candidate without deleting it", () => {
  const f = fixture();
  try {
    f.add("old-committed", "committed", "2026-07-17T02:01:00.000Z", 50);
    const newest = f.add("new-committed", "committed", "2026-07-17T02:02:00.000Z", 50);
    f.add("terminal", "cancelled", "2026-07-17T02:03:00.000Z", 50);
    writeEnvironmentTransactionReceipt(f.transactionFile, newest);

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "dry-run",
      processAlive: () => false,
    });
    const byId = new Map(result.entries.map((entry) => [entry.transactionId, entry]));
    assert.equal(byId.get("old-committed")?.action, "delete");
    assert.equal(byId.get("terminal")?.action, "delete");
    assert.equal(byId.get("new-committed")?.action, "keep");
    assert.equal(result.retainedRollbackTransactionId, "new-committed");
    assert.equal(existsSync(join(f.receiptRoot, "old-committed", "prepared")), true);
    assert.ok(result.eligibleBytes > 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an unsafe newer committed v1 tree cannot displace the newest usable rollback evidence", () => {
  const f = fixture();
  try {
    f.add("usable-committed", "committed", "2026-07-17T02:01:00.000Z", 50);
    const unsafe = f.add("unsafe-newer-committed", "committed", "2026-07-17T02:02:00.000Z", 50);
    writeEnvironmentTransactionReceipt(f.transactionFile, unsafe);
    const outside = join(f.root, "unsafe-v1-outside");
    mkdirSync(outside);
    rmSync(join(f.receiptRoot, "unsafe-newer-committed", "prepared"), { recursive: true });
    symlinkSync(outside, join(f.receiptRoot, "unsafe-newer-committed", "prepared"));

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "dry-run",
      processAlive: () => false,
    });
    const byId = new Map(result.entries.map((entry) => [entry.transactionId, entry]));
    assert.equal(result.retainedRollbackTransactionId, "usable-committed");
    assert.equal(byId.get("usable-committed")?.action, "keep");
    assert.equal(byId.get("unsafe-newer-committed")?.action, "keep");
    assert.match(byId.get("unsafe-newer-committed")?.reason ?? "", /symlink/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a fully materialized current v2 pair with terminal journal proof safely supersedes the newest v1 rollback evidence", () => {
  const f = fixture();
  try {
    f.add("old-committed", "committed", "2026-07-17T02:01:00.000Z", 50);
    const newest = f.add("new-committed", "committed", "2026-07-17T02:02:00.000Z", 50);
    writeEnvironmentTransactionReceipt(f.transactionFile, newest);
    const beforeV2Proof = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "dry-run",
      processAlive: () => false,
    });
    assert.equal(beforeV2Proof.retainedRollbackTransactionId, "new-committed");
    assert.equal(beforeV2Proof.entries.find((entry) => entry.transactionId === "new-committed")?.action, "keep");

    const cachePaths = makeProvedCurrentV2Pair(f.root);
    const afterV2Proof = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      cachePaths,
      mode: "dry-run",
      processAlive: () => false,
    });
    assert.equal(afterV2Proof.retainedRollbackTransactionId, null);
    assert.equal(afterV2Proof.entries.find((entry) => entry.transactionId === "old-committed")?.action, "delete");
    assert.equal(afterV2Proof.entries.find((entry) => entry.transactionId === "new-committed")?.action, "delete");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("dry run accepts contained Electron framework symlinks without double-counting targets", () => {
  const f = fixture();
  try {
    f.add("terminal", "cancelled", "2026-07-17T02:01:00.000Z");
    const newest = f.add("new-committed", "committed", "2026-07-17T02:02:00.000Z");
    writeEnvironmentTransactionReceipt(f.transactionFile, newest);

    const frameworkRoot = join(
      f.receiptRoot,
      "terminal",
      "prepared",
      "candidate.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
    );
    const versionRoot = join(frameworkRoot, "Versions", "A");
    mkdirSync(versionRoot, { recursive: true });
    const frameworkBytes = 1024 * 1024;
    writeFileSync(join(versionRoot, "Electron Framework"), Buffer.alloc(frameworkBytes, 7));
    symlinkSync("A", join(frameworkRoot, "Versions", "Current"));
    symlinkSync(
      "Versions/Current/Electron Framework",
      join(frameworkRoot, "Electron Framework"),
    );

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "dry-run",
      processAlive: () => false,
    });
    const entry = result.entries.find((candidate) => candidate.transactionId === "terminal");

    assert.equal(entry?.action, "delete");
    assert.ok((entry?.bytes ?? 0) >= frameworkBytes);
    assert.ok((entry?.bytes ?? Number.POSITIVE_INFINITY) < frameworkBytes * 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("dry run protects relative and absolute symlinks that resolve outside prepared", () => {
  const f = fixture();
  try {
    f.add("relative-escape", "cancelled", "2026-07-17T02:01:00.000Z");
    f.add("absolute-escape", "cancelled", "2026-07-17T02:02:00.000Z");
    const newest = f.add("new-committed", "committed", "2026-07-17T02:03:00.000Z");
    writeEnvironmentTransactionReceipt(f.transactionFile, newest);

    const outside = join(f.root, "outside-links");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "keep");
    const relativePrepared = join(f.receiptRoot, "relative-escape", "prepared");
    symlinkSync(relative(relativePrepared, outside), join(relativePrepared, "escape"));
    symlinkSync(outside, join(f.receiptRoot, "absolute-escape", "prepared", "escape"));

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "dry-run",
      processAlive: () => false,
    });
    const byId = new Map(result.entries.map((entry) => [entry.transactionId, entry]));

    for (const id of ["relative-escape", "absolute-escape"]) {
      assert.equal(byId.get(id)?.action, "keep");
      assert.match(byId.get(id)?.reason ?? "", /outside the canonical prepared directory/);
    }
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("dry run protects dangling and prepared-root-cyclic symlinks", () => {
  const f = fixture();
  try {
    f.add("dangling", "cancelled", "2026-07-17T02:01:00.000Z");
    f.add("cyclic-to-root", "cancelled", "2026-07-17T02:02:00.000Z");
    const newest = f.add("new-committed", "committed", "2026-07-17T02:03:00.000Z");
    writeEnvironmentTransactionReceipt(f.transactionFile, newest);

    symlinkSync("missing-target", join(f.receiptRoot, "dangling", "prepared", "dangling"));
    symlinkSync(".", join(f.receiptRoot, "cyclic-to-root", "prepared", "root"));

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "dry-run",
      processAlive: () => false,
    });
    const byId = new Map(result.entries.map((entry) => [entry.transactionId, entry]));

    assert.equal(byId.get("dangling")?.action, "keep");
    assert.match(byId.get("dangling")?.reason ?? "", /unsafe or unreadable/);
    assert.equal(byId.get("cyclic-to-root")?.action, "keep");
    assert.match(byId.get("cyclic-to-root")?.reason ?? "", /outside the canonical prepared directory/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("apply deletes only after revalidation and refuses a phase drift", () => {
  const f = fixture();
  try {
    const drifting = f.add("drifting", "cancelled", "2026-07-17T02:01:00.000Z");
    const newest = f.add("new-committed", "committed", "2026-07-17T02:02:00.000Z");
    f.add("other-terminal", "cancelled", "2026-07-17T02:02:30.000Z");
    writeEnvironmentTransactionReceipt(f.transactionFile, newest);
    let changed = false;

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "apply",
      processAlive: () => false,
      beforeDelete: (entry) => {
        if (entry.transactionId !== "drifting" || changed) return;
        changed = true;
        writeEnvironmentTransactionReceipt(join(f.receiptRoot, "drifting.json"), {
          ...drifting,
          phase: "prepared",
          cancelledAt: null,
        });
      },
    });

    const entry = result.entries.find((candidate) => candidate.transactionId === "drifting");
    assert.equal(entry?.action, "keep");
    assert.match(entry?.reason ?? "", /revalidation refused.*non-terminal/);
    assert.equal(existsSync(join(f.receiptRoot, "drifting", "prepared")), true);
    assert.ok(result.reclaimedBytes > 0, "the unrelated terminal payload is reclaimed");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("apply revalidation refuses a nested symlink that drifts outside prepared", () => {
  const f = fixture();
  try {
    f.add("drifting-link", "cancelled", "2026-07-17T02:01:00.000Z");
    const newest = f.add("new-committed", "committed", "2026-07-17T02:02:00.000Z");
    f.add("other-terminal", "cancelled", "2026-07-17T02:02:30.000Z");
    writeEnvironmentTransactionReceipt(f.transactionFile, newest);
    const preparedRoot = join(f.receiptRoot, "drifting-link", "prepared");
    const link = join(preparedRoot, "payload-link");
    symlinkSync("payload.bin", link);
    const outside = join(f.root, "outside-revalidation");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "keep");
    let changed = false;

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "apply",
      processAlive: () => false,
      beforeDelete: (entry) => {
        if (entry.transactionId !== "drifting-link" || changed) return;
        changed = true;
        rmSync(link);
        symlinkSync(outside, link);
      },
    });

    const entry = result.entries.find((candidate) => candidate.transactionId === "drifting-link");
    assert.equal(entry?.action, "keep");
    assert.match(entry?.reason ?? "", /revalidation refused.*outside the canonical prepared directory/);
    assert.equal(existsSync(preparedRoot), true);
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
    assert.ok(result.reclaimedBytes > 0, "the unrelated terminal payload is reclaimed");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("apply removes an eligible terminal prepared directory but retains its receipt", () => {
  const f = fixture();
  try {
    f.add("terminal", "cancelled", "2026-07-17T02:01:00.000Z", 128);
    const newest = f.add("new-committed", "committed", "2026-07-17T02:02:00.000Z");
    writeEnvironmentTransactionReceipt(f.transactionFile, newest);
    const preparedRoot = join(f.receiptRoot, "terminal", "prepared");
    symlinkSync("payload.bin", join(preparedRoot, "payload-link"));
    const receiptFile = join(f.receiptRoot, "terminal.json");
    const receiptBefore = readFileSync(receiptFile, "utf8");
    const transactionSentinel = join(f.receiptRoot, "terminal", "keep.txt");
    writeFileSync(transactionSentinel, "transaction sibling");
    const externalSentinel = join(f.root, "external-sentinel.txt");
    writeFileSync(externalSentinel, "external");

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "apply",
      processAlive: () => false,
    });
    assert.equal(result.entries.find((entry) => entry.transactionId === "terminal")?.action, "deleted");
    assert.equal(existsSync(preparedRoot), false);
    assert.equal(readFileSync(receiptFile, "utf8"), receiptBefore);
    assert.equal(readFileSync(transactionSentinel, "utf8"), "transaction sibling");
    assert.equal(readFileSync(externalSentinel, "utf8"), "external");
    assert.ok(result.reclaimedBytes > 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("GC refuses prepared evidence that escapes the canonical transaction directory", () => {
  const f = fixture();
  try {
    const unsafe = f.add("unsafe", "cancelled", "2026-07-17T02:01:00.000Z");
    unsafe.prepared!.candidate.artifactPath = join(f.root, "outside", "candidate.app");
    writeFileSync(join(f.receiptRoot, "unsafe.json"), `${JSON.stringify(unsafe)}\n`);
    const newest = f.add("new-committed", "committed", "2026-07-17T02:02:00.000Z");
    writeEnvironmentTransactionReceipt(f.transactionFile, newest);

    const result = runEnvironmentTransactionGc({
      receiptRoot: f.receiptRoot,
      transactionFile: f.transactionFile,
      mode: "dry-run",
      processAlive: () => false,
    });
    const entry = result.entries.find((candidate) => candidate.transactionId === "unsafe");
    assert.equal(entry?.action, "keep");
    assert.match(entry?.reason ?? "", /outside its canonical prepared directory/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
