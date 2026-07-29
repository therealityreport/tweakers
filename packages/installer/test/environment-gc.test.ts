import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { runEnvironmentTransactionGc } from "../src/environment-gc";
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

test("dry run keeps active, non-terminal, live-owner, symlinked roots, and newest rollback artifacts", () => {
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
    assert.match(byId.get("current-failed")?.reason ?? "", /current environment transaction/);
    assert.equal(byId.get("non-terminal")?.action, "keep");
    assert.match(byId.get("non-terminal")?.reason ?? "", /non-terminal/);
    assert.equal(byId.get("new-committed")?.action, "keep");
    assert.match(byId.get("new-committed")?.reason ?? "", /newest committed rollback/);
    assert.equal(byId.get("live-owner")?.action, "keep");
    assert.match(byId.get("live-owner")?.reason ?? "", /still alive/);
    assert.equal(byId.get("symlinked")?.action, "keep");
    assert.match(byId.get("symlinked")?.reason ?? "", /symlink/);
    assert.equal(byId.get("symlinked-transaction")?.action, "keep");
    assert.match(byId.get("symlinked-transaction")?.reason ?? "", /symlink/);
    assert.equal(byId.get("old-committed")?.action, "delete");
    assert.equal(byId.get("terminal")?.action, "delete");
    assert.equal(existsSync(join(outside, "sentinel")), true);
    assert.equal(existsSync(join(transactionOutside, "prepared", "sentinel")), true);
    assert.equal(result.reclaimedBytes, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("dry run marks superseded terminal artifacts eligible without deleting them", () => {
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
    assert.equal(existsSync(join(f.receiptRoot, "old-committed", "prepared")), true);
    assert.ok(result.eligibleBytes > 0);
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
    assert.equal(result.reclaimedBytes, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("apply revalidation refuses a nested symlink that drifts outside prepared", () => {
  const f = fixture();
  try {
    f.add("drifting-link", "cancelled", "2026-07-17T02:01:00.000Z");
    const newest = f.add("new-committed", "committed", "2026-07-17T02:02:00.000Z");
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
    assert.equal(result.reclaimedBytes, 0);
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
