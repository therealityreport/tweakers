import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  archiveTransactionState,
  generateProductionHealthReceipt,
  probeNativeHealth,
  PROMOTION_SURFACE_NAMES,
  readProductionHealthReceipt,
  readTransactionState,
  runInstallTransaction,
  transactionLockFile,
  TransactionLockHeldError,
  type ProductionHealthExpectationV2,
} from "../src/transaction";
import { createSignedBackupTransactionWiring, formatInvalidatedInstallError } from "../src/commands/install";

type Health = { host: "pass" | "fail" | "unknown"; session: "pass" | "fail" | "unknown"; permissions: Record<string, "pass" | "fail" | "unknown"> };

function promotionExpectation(): ProductionHealthExpectationV2 {
  const after = Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name, index) => [
    name,
    name === "app" ? "a".repeat(64) : String((index + 1) % 10).repeat(64),
  ])) as Record<(typeof PROMOTION_SURFACE_NAMES)[number], string>;
  return {
    schemaVersion: 2,
    app: { version: "1.0.0", build: "fixture", hash: after.app },
    requiredPermissions: ["accessibility"],
    surfaces: Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name) => [name, {
      preimageHash: "0".repeat(64),
      afterHash: after[name],
    }])) as ProductionHealthExpectationV2["surfaces"],
    userQuestions: {
      id: "co.tweakers.user-questions",
      version: "0.5.0",
      payloadHash: "f".repeat(64),
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tweaker-transaction-"));
  const appRoot = join(root, "app");
  const runtimeRoot = join(root, "runtime");
  const workRoot = join(root, "work");
  const stateFile = join(root, "transaction-state.json");
  writeFileSync(join(root, "sentinel"), "untouched");
  return { root, appRoot, runtimeRoot, workRoot, stateFile };
}

function clean(root: string) {
  rmSync(root, { recursive: true, force: true });
}

function options(f: ReturnType<typeof fixture>) {
  return {
    appRoot: f.appRoot,
    runtimeRoot: f.runtimeRoot,
    workRoot: f.workRoot,
    stateFile: f.stateFile,
    source: { version: "1.0.0", build: "fixture", hash: "fixture-hash" },
    requiredPermissions: ["accessibility"],
    now: new Date("2026-07-10T12:00:00.000Z"),
  };
}

function adapters(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const base = {
    isAppRunning: () => false,
    copyApp: () => calls.push("copyApp"),
    removeApp: () => calls.push("removeApp"),
    buildCandidate: () => calls.push("buildCandidate"),
    validateCandidate: () => true,
    probeCandidateHealth: (): Health => ({ host: "pass", session: "pass", permissions: { accessibility: "pass" } }),
    fingerprintApp: () => ({ version: "1.0.0", build: "fixture", hash: "fixture-hash" }),
    isAppComplete: () => true,
    snapshotRuntime: () => calls.push("snapshotRuntime"),
    promoteCandidate: () => calls.push("promoteCandidate"),
    restoreApp: () => calls.push("restoreApp"),
    restoreRuntime: () => calls.push("restoreRuntime"),
    probeHealth: (): Health => ({ host: "pass", session: "pass", permissions: { accessibility: "pass" } }),
    openApp: () => calls.push("openApp"),
  };
  return { adapters: { ...base, ...overrides }, calls };
}

function signedBackupFixture(root: string, candidateVersion: string, liveVersion: string | null) {
  const candidate = join(root, "candidate-user", "backup", "Codex.app");
  const live = join(root, "live-user", "backup", "Codex.app");
  const snapshot = join(root, "work", "last-known-good-backup");
  const marker = join(root, "work", "last-known-good-backup.json");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(candidate, "version"), candidateVersion);
  if (liveVersion !== null) {
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "version"), liveVersion);
  }
  return { candidate, live, snapshot, marker };
}

function signedBackupWiring(paths: ReturnType<typeof signedBackupFixture>) {
  return createSignedBackupTransactionWiring({
    candidateBackup: paths.candidate,
    liveBackup: paths.live,
    snapshot: paths.snapshot,
    marker: paths.marker,
  }, {
    verifyDeveloperId: (path) => existsSync(join(path, "version")) && readFileSync(join(path, "version"), "utf8") !== "invalid",
    copyDirectory: (source, destination) => cpSync(source, destination, { recursive: true }),
  });
}

test("holds when the app is running and does not quit or mutate live state", async () => {
  const f = fixture();
  try {
    mkdirSync(f.appRoot, { recursive: true });
    writeFileSync(join(f.appRoot, "live.txt"), "live-before");
    const { adapters: injected, calls } = adapters({ isAppRunning: () => true });
    const result = await runInstallTransaction(options(f), injected);
    assert.equal(result.status, "held");
    assert.equal(calls.includes("promoteCandidate"), false);
    assert.equal(calls.includes("restoreApp"), false);
    assert.equal(calls.includes("restoreRuntime"), false);
    assert.equal(calls.includes("openApp"), false);
    assert.equal(readFileSync(join(f.appRoot, "live.txt"), "utf8"), "live-before");
  } finally {
    clean(f.root);
  }
});

test("real installer backup wiring promotes the validated candidate during a successful transaction", async () => {
  const f = fixture();
  try {
    const signed = signedBackupFixture(f.root, "candidate", null);
    const wiring = signedBackupWiring(signed);
    const { adapters: injected } = adapters({
      validateCandidate: () => wiring.validateCandidate(),
      snapshotRuntime: () => wiring.snapshotLive(),
      promoteCandidate: () => wiring.promoteCandidate(),
      restoreRuntime: () => wiring.restoreLive(),
    });

    const result = await runInstallTransaction(options(f), injected);

    assert.equal(result.status, "promoted");
    assert.equal(readFileSync(join(signed.live, "version"), "utf8"), "candidate");
  } finally {
    clean(f.root);
  }
});

test("real installer backup wiring restores the prior backup after health rollback", async () => {
  const f = fixture();
  try {
    const signed = signedBackupFixture(f.root, "candidate", "prior");
    const wiring = signedBackupWiring(signed);
    const { adapters: injected } = adapters({
      validateCandidate: () => wiring.validateCandidate(),
      snapshotRuntime: () => wiring.snapshotLive(),
      promoteCandidate: () => wiring.promoteCandidate(),
      restoreRuntime: () => wiring.restoreLive(),
      probeHealth: (): Health => ({ host: "fail", session: "pass", permissions: { accessibility: "pass" } }),
    });

    const result = await runInstallTransaction(options(f), injected);

    assert.equal(result.status, "rolled-back");
    assert.equal(readFileSync(join(signed.live, "version"), "utf8"), "prior");
  } finally {
    clean(f.root);
  }
});

test("candidate-only, held, and invalid transactions never mutate the live signed backup", async () => {
  for (const mode of ["candidate-only", "held", "invalid"] as const) {
    const f = fixture();
    try {
      const signed = signedBackupFixture(f.root, mode === "invalid" ? "invalid" : "candidate", "prior");
      const wiring = signedBackupWiring(signed);
      const { adapters: injected } = adapters({
        isAppRunning: () => mode === "held",
        validateCandidate: () => wiring.validateCandidate(),
        snapshotRuntime: () => wiring.snapshotLive(),
        promoteCandidate: () => wiring.promoteCandidate(),
        restoreRuntime: () => wiring.restoreLive(),
      });
      const result = await runInstallTransaction(
        { ...options(f), candidateOnly: mode === "candidate-only" },
        injected,
      );

      assert.equal(result.status, mode === "candidate-only" ? "candidate-ready" : mode === "held" ? "held" : "invalidated");
      assert.equal(readFileSync(join(signed.live, "version"), "utf8"), "prior");
    } finally {
      clean(f.root);
    }
  }
});

test("invalidates candidate-build and candidate-validation failures without promoting", async () => {
  for (const failure of [
    { buildCandidate: () => { throw new Error("build failed"); } },
    { validateCandidate: () => false },
  ]) {
    const f = fixture();
    try {
      const { adapters: injected, calls } = adapters(failure);
      const result = failure.validateCandidate
        ? await runInstallTransaction(options(f), injected)
        : await assert.rejects(() => runInstallTransaction(options(f), injected), /build failed|candidate/i).then(() => null);
      const state = readTransactionState(f.stateFile);
      assert.equal(result?.status ?? "invalidated", "invalidated");
      assert.equal(state?.phase, "invalidated");
      if (failure.validateCandidate) {
        assert.equal(state?.failure, "candidate validator returned false without a reason");
        assert.notEqual(state?.failure, "candidate validation failed");
      }
      assert.equal(calls.includes("promoteCandidate"), false);
      assert.equal(existsSync(f.appRoot), false);
    } finally {
      clean(f.root);
    }
  }
});

test("preserves distinct candidate validation reasons in transaction state", async () => {
  const matrix = [
    ["signature-fail", "candidate signature invalid: codesign failed"],
    ["backup-missing", "candidate Developer-ID backup missing or unsigned"],
    ["marker-absent", "patch marker absent from candidate app.asar (asar not patched)"],
    ["marker-unreadable", "candidate app.asar could not be read (corrupt or locked)"],
  ] as const;
  const observed: string[] = [];

  for (const [, reason] of matrix) {
    const f = fixture();
    try {
      const { adapters: injected } = adapters({
        validateCandidate: () => { throw new Error(reason); },
      });
      const result = await runInstallTransaction(options(f), injected);
      assert.equal(result.status, "invalidated");
      assert.equal(result.state.failure, reason);
      assert.notEqual(result.state.failure, "candidate validation failed");
      observed.push(result.state.failure ?? "");
    } finally {
      clean(f.root);
    }
  }

  assert.equal(new Set(observed).size, matrix.length);
});

test("latches repeated invalidations for the same source and payload after two failed attempts", async () => {
  const f = fixture();
  try {
    const injected = adapters({ validateCandidate: () => false });
    const first = await runInstallTransaction({
      ...options(f),
      payloadHash: "payload-a",
    }, injected.adapters);
    const second = await runInstallTransaction({
      ...options(f),
      payloadHash: "payload-a",
      now: new Date("2026-07-10T12:02:00.000Z"),
    }, injected.adapters);
    const third = await runInstallTransaction({
      ...options(f),
      payloadHash: "payload-a",
      now: new Date("2026-07-10T12:10:00.000Z"),
    }, injected.adapters);

    assert.equal(first.status, "invalidated");
    assert.equal(second.status, "invalidated");
    assert.equal(third.status, "invalidated");
    assert.equal(injected.calls.filter((call) => call === "buildCandidate").length, 2);
    assert.equal(third.state.failureCount, 2);
  } finally {
    clean(f.root);
  }
});

test("a changed source or payload resets a latched invalidation and rebuilds", async () => {
  const f = fixture();
  try {
    const injected = adapters({ validateCandidate: () => false });
    await runInstallTransaction({ ...options(f), payloadHash: "payload-a" }, injected.adapters);
    await runInstallTransaction({
      ...options(f),
      payloadHash: "payload-a",
      now: new Date("2026-07-10T12:02:00.000Z"),
    }, injected.adapters);

    const rebuilt = await runInstallTransaction({
      ...options(f),
      payloadHash: "payload-b",
      now: new Date("2026-07-10T12:03:00.000Z"),
    }, injected.adapters);

    assert.equal(rebuilt.status, "invalidated");
    assert.equal(rebuilt.state.payloadHash, "payload-b");
    assert.equal(rebuilt.state.failureCount, 1);
    assert.equal(injected.calls.filter((call) => call === "buildCandidate").length, 3);
  } finally {
    clean(f.root);
  }
});

test("backs off an invalidated transaction until its retry window expires", async () => {
  const f = fixture();
  try {
    const injected = adapters({ validateCandidate: () => false });
    const first = await runInstallTransaction(options(f), injected.adapters);
    const withinBackoff = await runInstallTransaction({
      ...options(f),
      now: new Date("2026-07-10T12:01:00.000Z"),
    }, injected.adapters);
    const afterBackoff = await runInstallTransaction({
      ...options(f),
      now: new Date("2026-07-10T12:02:00.001Z"),
    }, injected.adapters);

    assert.equal(first.status, "invalidated");
    assert.equal(withinBackoff.status, "invalidated");
    assert.equal(withinBackoff.state.failureCount, 1);
    assert.equal(afterBackoff.status, "invalidated");
    assert.equal(afterBackoff.state.failureCount, 2);
    assert.equal(injected.calls.filter((call) => call === "buildCandidate").length, 2);
  } finally {
    clean(f.root);
  }
});

test("recovers an interrupted phase by restoring the prior app/runtime snapshot", async () => {
  const f = fixture();
  try {
    writeFileSync(f.stateFile, JSON.stringify({
      schemaVersion: 1,
      phase: "promoting",
      appRoot: f.appRoot,
      runtimeRoot: f.runtimeRoot,
      source: options(f).source,
      candidateRoot: join(f.workRoot, "candidate.app"),
      pristineRoot: join(f.workRoot, "pristine.app"),
      lastKnownGoodRoot: join(f.workRoot, "last-known-good.app"),
      lastKnownGoodRuntimeRoot: join(f.workRoot, "last-known-good-runtime"),
      createdAt: "2026-07-10T11:59:00.000Z",
      updatedAt: "2026-07-10T11:59:00.000Z",
      rollbackAttempted: false,
    }));
    const { adapters: injected, calls } = adapters();
    const result = await runInstallTransaction(options(f), injected);
    assert.equal(result.status, "rolled-back");
    assert.ok(calls.includes("restoreApp"));
    assert.ok(calls.includes("restoreRuntime"));
    assert.equal(readTransactionState(f.stateFile)?.phase, "degraded");
    assert.equal(readTransactionState(f.stateFile)?.rollbackResult, "succeeded");
  } finally {
    clean(f.root);
  }
});

test("rolls back when any required health probe fails or is unknown", async () => {
  for (const health of [
    { host: "fail", session: "pass", permissions: { accessibility: "pass" } },
    { host: "pass", session: "unknown", permissions: { accessibility: "pass" } },
    { host: "pass", session: "pass", permissions: { accessibility: "unknown" } },
  ] satisfies Health[]) {
    const f = fixture();
    try {
      const { adapters: injected, calls } = adapters({ probeHealth: () => health });
      const result = await runInstallTransaction(options(f), injected);
      assert.equal(result.status, "rolled-back");
      assert.ok(calls.includes("restoreApp"));
      assert.ok(calls.includes("restoreRuntime"));
    } finally {
      clean(f.root);
    }
  }
});

test("first install proves the disposable candidate before any live promotion without a prior receipt", async () => {
  const f = fixture();
  try {
    const { adapters: injected, calls } = adapters({
      probeCandidateHealth: (): Health => {
        calls.push("probeCandidateHealth");
        return { host: "pass", session: "pass", permissions: { accessibility: "pass" } };
      },
    });
    const result = await runInstallTransaction(options(f), injected);
    assert.equal(result.status, "promoted");
    assert.ok(calls.indexOf("probeCandidateHealth") >= 0);
    assert.ok(calls.indexOf("probeCandidateHealth") < calls.indexOf("promoteCandidate"));
  } finally {
    clean(f.root);
  }
});

test("failed disposable candidate health invalidates before live mutation or rollback", async () => {
  const f = fixture();
  try {
    const { adapters: injected, calls } = adapters({
      probeCandidateHealth: (): Health => ({
        host: "pass", session: "unknown", permissions: { accessibility: "pass" },
      }),
    });
    const result = await runInstallTransaction(options(f), injected);
    assert.equal(result.status, "invalidated");
    assert.match(result.state.failure ?? "", /candidate health: session health unknown/);
    assert.equal(calls.includes("promoteCandidate"), false);
    assert.equal(calls.includes("restoreApp"), false);
    assert.equal(calls.includes("openApp"), false);
  } finally {
    clean(f.root);
  }
});

test("is idempotent after a successful promotion", async () => {
  const f = fixture();
  try {
    const first = adapters();
    const firstResult = await runInstallTransaction(options(f), first.adapters);
    assert.equal(firstResult.status, "promoted");
    const second = adapters();
    const secondResult = await runInstallTransaction(options(f), second.adapters);
    assert.equal(secondResult.status, "promoted");
    assert.deepEqual(second.calls, []);
  } finally {
    clean(f.root);
  }
});

test("candidate-only validates without promoting or opening the app", async () => {
  const f = fixture();
  try {
    let candidateHealthProbes = 0;
    const injected = adapters({
      probeCandidateHealth: (): Health => {
        candidateHealthProbes += 1;
        return { host: "pass", session: "pass", permissions: { accessibility: "pass" } };
      },
    });
    const result = await runInstallTransaction({ ...options(f), candidateOnly: true }, injected.adapters);
    assert.equal(result.status, "candidate-ready");
    assert.equal(candidateHealthProbes, 1);
    assert.equal(injected.calls.includes("promoteCandidate"), false);
    assert.equal(injected.calls.includes("openApp"), false);
    assert.equal(result.state.pendingReason, "explicit-candidate-only");
  } finally {
    clean(f.root);
  }
});

test("candidate-only invalidates when disposable schema health fails", async () => {
  const f = fixture();
  try {
    const injected = adapters({
      probeCandidateHealth: (): Health => ({
        host: "pass",
        session: "unknown",
        permissions: { accessibility: "pass" },
      }),
    });
    const result = await runInstallTransaction({ ...options(f), candidateOnly: true }, injected.adapters);
    assert.equal(result.status, "invalidated");
    assert.match(result.state.failure ?? "", /candidate health: session health unknown/);
    assert.equal(injected.calls.includes("promoteCandidate"), false);
    assert.equal(injected.calls.includes("openApp"), false);
  } finally {
    clean(f.root);
  }
});

test("candidate-only rebuilds when the installer payload changes under the same app build", async () => {
  const f = fixture();
  try {
    const first = adapters();
    const initial = await runInstallTransaction({ ...options(f), candidateOnly: true, payloadHash: "payload-a" }, first.adapters);
    assert.equal(initial.status, "candidate-ready");
    assert.equal(initial.state.payloadHash, "payload-a");

    const second = adapters();
    const rebuilt = await runInstallTransaction({
      ...options(f),
      candidateOnly: true,
      payloadHash: "payload-b",
      now: new Date("2026-07-10T12:01:00.000Z"),
    }, second.adapters);
    assert.equal(rebuilt.status, "candidate-ready");
    assert.equal(rebuilt.state.payloadHash, "payload-b");
    assert.ok(second.calls.includes("removeApp"));
    assert.ok(second.calls.includes("buildCandidate"));
    assert.equal(second.calls.includes("promoteCandidate"), false);
  } finally {
    clean(f.root);
  }
});

test("a held candidate rebuilds against a complete newer live app", async () => {
  const f = fixture();
  try {
    const held = adapters({ isAppRunning: () => true });
    assert.equal((await runInstallTransaction(options(f), held.adapters)).status, "held");

    const newerSource = { version: "1.0.1", build: "changed", hash: "changed-hash" };
    const next = adapters({ fingerprintApp: () => newerSource, isAppComplete: () => true });
    const result = await runInstallTransaction({
      ...options(f),
      source: newerSource,
      now: new Date("2026-07-10T12:01:00.000Z"),
    }, next.adapters);

    assert.equal(result.status, "promoted");
    assert.deepEqual(result.state.source, newerSource);
    assert.equal(next.calls.filter((call) => call === "buildCandidate").length, 1);
    assert.equal(result.state.pendingReason, undefined);
  } finally {
    clean(f.root);
  }
});

test("a held candidate waits when the newer live app signature is incomplete", async () => {
  const f = fixture();
  try {
    const held = adapters({ isAppRunning: () => true });
    assert.equal((await runInstallTransaction(options(f), held.adapters)).status, "held");

    const newerSource = { version: "1.0.1", build: "changed", hash: "changed-hash" };
    const incomplete = adapters({ fingerprintApp: () => newerSource, isAppComplete: () => false });
    const result = await runInstallTransaction({
      ...options(f),
      source: newerSource,
      now: new Date("2026-07-10T12:01:00.000Z"),
    }, incomplete.adapters);

    assert.equal(result.status, "held");
    assert.equal(result.state.phase, "pendingPromotion");
    assert.equal(result.state.pendingReason, "live-app-incomplete");
    assert.equal(result.state.failure, "official Codex update still in progress; live app signature is incomplete");
    assert.equal(incomplete.calls.includes("buildCandidate"), false);
    assert.equal(incomplete.calls.includes("promoteCandidate"), false);

    const settled = adapters({ fingerprintApp: () => newerSource, isAppComplete: () => true });
    const retried = await runInstallTransaction({
      ...options(f),
      source: newerSource,
      now: new Date("2026-07-10T12:02:00.000Z"),
    }, settled.adapters);
    assert.equal(retried.status, "promoted");
    assert.equal(settled.calls.filter((call) => call === "buildCandidate").length, 1);
  } finally {
    clean(f.root);
  }
});

test("candidate expiry remains invalidated with the honest failure", async () => {
  const f = fixture();
  try {
    const held = adapters({ isAppRunning: () => true });
    assert.equal((await runInstallTransaction(options(f), held.adapters)).status, "held");

    const next = adapters();
    const result = await runInstallTransaction({
      ...options(f),
      now: new Date("2026-07-11T12:00:00.001Z"),
    }, next.adapters);

    assert.equal(result.status, "invalidated");
    assert.equal(result.state.pendingReason, "candidate-expired");
    assert.equal(result.state.failure, "candidate expired before promotion (a newer app landed first)");
    assert.equal(next.calls.includes("buildCandidate"), false);
    assert.equal(next.calls.includes("promoteCandidate"), false);
  } finally {
    clean(f.root);
  }
});

test("a live-app rebuild does not count against the invalidation latch", async () => {
  const f = fixture();
  try {
    const held = adapters({ isAppRunning: () => true });
    assert.equal((await runInstallTransaction(options(f), held.adapters)).status, "held");

    const newerSource = { version: "1.0.1", build: "changed", hash: "changed-hash" };
    const failedRebuild = adapters({
      fingerprintApp: () => newerSource,
      isAppComplete: () => true,
      validateCandidate: () => false,
    });
    const failed = await runInstallTransaction({
      ...options(f),
      source: newerSource,
      now: new Date("2026-07-10T12:01:00.000Z"),
    }, failedRebuild.adapters);
    assert.equal(failed.status, "invalidated");
    assert.equal(failed.state.failureCount, 1);
    assert.equal(failedRebuild.calls.filter((call) => call === "buildCandidate").length, 1);

    const retry = adapters({ fingerprintApp: () => newerSource, isAppComplete: () => true });
    const retried = await runInstallTransaction({
      ...options(f),
      source: newerSource,
      now: new Date("2026-07-10T12:03:00.001Z"),
    }, retry.adapters);
    assert.equal(retried.status, "promoted");
    assert.equal(retry.calls.filter((call) => call === "buildCandidate").length, 1);
  } finally {
    clean(f.root);
  }
});

test("invalidated install alerts prefer the real failure or pending reason", () => {
  const drift = formatInvalidatedInstallError(
    "/Applications/Codex.app",
    "live app changed after the candidate was built — likely an official Codex update",
    "live-app-drift",
  );
  assert.match(drift, /Reason: live app changed after the candidate was built/);
  assert.doesNotMatch(drift, /Reason: candidate validation failed/);

  const pending = formatInvalidatedInstallError("/Applications/Codex.app", undefined, "candidate-expired");
  assert.match(pending, /Reason: candidate-expired/);
  assert.doesNotMatch(pending, /Reason: candidate validation failed/);
});

test("an ad-hoc candidate is never promoted and a normal install rebuilds a promotable candidate", async () => {
  const f = fixture();
  try {
    const injected = adapters();
    const first = await runInstallTransaction({ ...options(f), signingMode: "adhoc" }, injected.adapters);
    assert.equal(first.status, "candidate-ready");
    assert.equal(first.state.pendingReason, "adhoc-never-promotes");
    assert.equal(injected.calls.includes("promoteCandidate"), false);

    const later = adapters();
    const second = await runInstallTransaction({ ...options(f), now: new Date("2026-07-10T12:01:00.000Z") }, later.adapters);
    assert.equal(second.status, "promoted");
    assert.ok(later.calls.includes("buildCandidate"));
    assert.ok(later.calls.includes("promoteCandidate"));
  } finally {
    clean(f.root);
  }
});

test("production health receipt requires mode 0600, fresh matching app/runtime identity, and complete tri-state permissions", () => {
  const f = fixture();
  try {
    const receipt = join(f.root, "health.json");
    const expected = {
      app: options(f).source,
      runtimeHash: "runtime-hash",
      requiredPermissions: ["accessibility", "screen-recording"],
    };
    const valid = {
      schemaVersion: 1,
      observedAt: "2026-07-10T12:00:00.000Z",
      app: expected.app,
      runtimeHash: expected.runtimeHash,
      hostReady: "pass",
      authenticatedSession: "pass",
      declaredPermissions: { accessibility: "pass", "screen-recording": "pass" },
    };
    writeFileSync(receipt, JSON.stringify(valid), { mode: 0o600 });
    chmodSync(receipt, 0o600);
    assert.deepEqual(readProductionHealthReceipt(receipt, expected, { now: new Date("2026-07-10T12:00:30.000Z") }), {
      host: "pass",
      session: "pass",
      permissions: { accessibility: "pass", "screen-recording": "pass" },
    });

    chmodSync(receipt, 0o644);
    assert.equal(readProductionHealthReceipt(receipt, expected).host, "unknown");
    chmodSync(receipt, 0o600);
    assert.equal(readProductionHealthReceipt(receipt, expected, { now: new Date("2026-07-10T12:02:00.000Z") }).session, "unknown");
    assert.equal(readProductionHealthReceipt(receipt, { ...expected, runtimeHash: "changed" }).host, "unknown");
    assert.equal(readProductionHealthReceipt(receipt, { ...expected, app: { ...expected.app, hash: "changed" } }).host, "unknown");
  } finally {
    clean(f.root);
  }
});

test("schema-v2 production health accepts only the exact eight surfaces and canonical User Questions proof", () => {
  const f = fixture();
  try {
    const receipt = join(f.root, "health-v2.json");
    const expected = promotionExpectation();
    const valid = {
      schemaVersion: 2,
      observedAt: "2026-07-10T12:00:00.000Z",
      app: expected.app,
      hostReady: "pass",
      authenticatedSession: "pass",
      declaredPermissions: { accessibility: "pass" },
      surfaces: Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name) => [name, {
        preimageHash: expected.surfaces[name].preimageHash,
        expectedHash: expected.surfaces[name].afterHash,
        observedHash: expected.surfaces[name].afterHash,
        status: "pass",
      }])),
      userQuestions: {
        expected: expected.userQuestions,
        observed: expected.userQuestions,
        identity: "pass",
        mainLifecycle: "pass",
        brokerSelfTest: "pass",
        schemaSelfTest: "pass",
        rendererStorageSelfTest: "pass",
        mcpConflictCount: 0,
        zeroMcpConflicts: "pass",
      },
      promotionReady: "pass",
    };
    writeFileSync(receipt, JSON.stringify(valid), { mode: 0o600 });
    chmodSync(receipt, 0o600);

    assert.deepEqual(readProductionHealthReceipt(receipt, expected, {
      now: new Date("2026-07-10T12:00:30.000Z"),
    }), {
      host: "pass",
      session: "pass",
      permissions: { accessibility: "pass" },
      promotionReady: "pass",
    });

    const missingSurface = structuredClone(valid);
    delete (missingSurface.surfaces as Record<string, unknown>).policy;
    writeFileSync(receipt, JSON.stringify(missingSurface), { mode: 0o600 });
    assert.equal(readProductionHealthReceipt(receipt, expected, { now: options(f).now }).promotionReady, "unknown");

    const conflicting = structuredClone(valid);
    conflicting.userQuestions.mcpConflictCount = 1;
    conflicting.userQuestions.zeroMcpConflicts = "fail";
    conflicting.promotionReady = "fail";
    writeFileSync(receipt, JSON.stringify(conflicting), { mode: 0o600 });
    assert.equal(readProductionHealthReceipt(receipt, expected, { now: options(f).now }).promotionReady, "fail");
  } finally {
    clean(f.root);
  }
});

test("strict v2 transaction accepts sidecars only after health and rolls them back on acceptance CAS failure", async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const pass: Health & { promotionReady: "pass" } = {
      host: "pass",
      session: "pass",
      permissions: { accessibility: "pass" },
      promotionReady: "pass",
    };
    const injected = adapters({
      probeCandidateHealth: () => pass,
      probeHealth: () => pass,
      acceptPromotion: () => {
        calls.push("acceptPromotion");
        throw new Error("snapshot CAS changed");
      },
      rollbackPromotion: () => calls.push("rollbackPromotion"),
      restoreApp: () => calls.push("restoreApp"),
      restoreRuntime: () => calls.push("restoreRuntime"),
    });
    const result = await runInstallTransaction({
      ...options(f),
      requirePromotionHealthV2: true,
    }, injected.adapters);

    assert.equal(result.status, "rolled-back");
    assert.match(result.state.failure ?? "", /promotion acceptance: snapshot CAS changed/);
    assert.deepEqual(calls, ["acceptPromotion", "rollbackPromotion", "restoreApp", "restoreRuntime"]);
  } finally {
    clean(f.root);
  }
});

test("native session and declared-permission probes map failures and unsupported signals to unknown", async () => {
  const matrix = [
    {
      adapter: {
        probeHostReady: () => "pass" as const,
        probeAuthenticatedSession: () => "pass" as const,
        probeDeclaredPermission: () => "pass" as const,
      },
      expected: { host: "pass", session: "pass", permissions: { accessibility: "pass" } },
    },
    {
      adapter: {
        probeHostReady: () => { throw new Error("no host marker"); },
        probeAuthenticatedSession: () => "unknown" as const,
        probeDeclaredPermission: () => { throw new Error("unsupported probe"); },
      },
      expected: { host: "unknown", session: "unknown", permissions: { accessibility: "unknown" } },
    },
    {
      adapter: {
        probeHostReady: () => "pass" as const,
        probeAuthenticatedSession: () => "fail" as const,
        probeDeclaredPermission: () => "fail" as const,
      },
      expected: { host: "pass", session: "fail", permissions: { accessibility: "fail" } },
    },
  ];
  for (const fixture of matrix) {
    assert.deepEqual(await probeNativeHealth(fixture.adapter, ["accessibility"]), fixture.expected);
  }
});

test("production native probes atomically generate an exact-mode receipt without launching ChatGPT", async () => {
  const f = fixture();
  try {
    const receipt = join(f.root, "health", "promotion.json");
    const expected = {
      app: options(f).source,
      runtimeHash: "runtime-hash",
      requiredPermissions: ["accessibility", "screen-recording"],
    };
    const calls: string[] = [];
    const health = await generateProductionHealthReceipt(receipt, expected, {
      probeHostReady: () => { calls.push("host"); return "pass"; },
      probeAuthenticatedSession: () => { calls.push("session"); return "pass"; },
      probeDeclaredPermission: (permission) => { calls.push(permission); return "pass"; },
    }, { now: new Date("2026-07-10T12:00:00.000Z") });

    assert.deepEqual(health, {
      host: "pass",
      session: "pass",
      permissions: { accessibility: "pass", "screen-recording": "pass" },
    });
    assert.deepEqual(calls, ["host", "session", "accessibility", "screen-recording"]);
    assert.equal(lstatSync(receipt).mode & 0o777, 0o600);
    assert.deepEqual(readProductionHealthReceipt(receipt, expected, {
      now: new Date("2026-07-10T12:00:30.000Z"),
    }), health);
    assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), {
      schemaVersion: 1,
      observedAt: "2026-07-10T12:00:00.000Z",
      app: expected.app,
      runtimeHash: "runtime-hash",
      hostReady: "pass",
      authenticatedSession: "pass",
      declaredPermissions: { accessibility: "pass", "screen-recording": "pass" },
    });
  } finally {
    clean(f.root);
  }
});

test("generated unknown probe observations fail closed and insecure receipt files are rejected", async () => {
  const f = fixture();
  try {
    const receipt = join(f.root, "promotion.json");
    const expected = { app: options(f).source, runtimeHash: "runtime-hash", requiredPermissions: ["accessibility"] };
    await generateProductionHealthReceipt(receipt, expected, {
      probeHostReady: () => { throw new Error("not ready"); },
      probeAuthenticatedSession: () => "unknown",
      probeDeclaredPermission: () => { throw new Error("unsupported"); },
    }, { now: options(f).now });
    assert.deepEqual(readProductionHealthReceipt(receipt, expected, { now: options(f).now }), {
      host: "unknown", session: "unknown", permissions: { accessibility: "unknown" },
    });

    chmodSync(receipt, 0o400);
    assert.equal(readProductionHealthReceipt(receipt, expected, { now: options(f).now }).host, "unknown");
    chmodSync(receipt, 0o700);
    assert.equal(readProductionHealthReceipt(receipt, expected, { now: options(f).now }).host, "unknown");
    rmSync(receipt);
    const target = join(f.root, "target.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, receipt);
    assert.equal(readProductionHealthReceipt(receipt, expected, { now: options(f).now }).host, "unknown");
  } finally {
    clean(f.root);
  }
});

test("a formerly baseline-blocked candidate can promote once health becomes available", async () => {
  const f = fixture();
  try {
    const first = adapters();
    assert.equal((await runInstallTransaction({
      ...options(f), candidateOnly: true, candidateOnlyReason: "baseline-health-unavailable",
    }, first.adapters)).status, "candidate-ready");
    const second = adapters();
    const result = await runInstallTransaction({ ...options(f), now: new Date("2026-07-10T12:01:00.000Z") }, second.adapters);
    assert.equal(result.status, "promoted");
    assert.ok(second.calls.includes("promoteCandidate"));
  } finally {
    clean(f.root);
  }
});

test("an explicitly candidate-only build is never promoted and coordinated refresh rebuilds it", async () => {
  const f = fixture();
  try {
    const first = adapters();
    const held = await runInstallTransaction({
      ...options(f), candidateOnly: true, candidateOnlyReason: "explicit",
    }, first.adapters);
    assert.equal(held.state.pendingReason, "explicit-candidate-only");
    const second = adapters();
    const rebuilt = await runInstallTransaction({
      ...options(f), candidateOnly: true, candidateOnlyReason: "coordinated-refresh",
      now: new Date("2026-07-10T12:01:00.000Z"),
    }, second.adapters);
    assert.equal(rebuilt.status, "candidate-ready");
    assert.equal(rebuilt.state.pendingReason, "coordinated-refresh");
    assert.ok(second.calls.includes("buildCandidate"));
    assert.equal(second.calls.includes("promoteCandidate"), false);
  } finally {
    clean(f.root);
  }
});

test("a coordinated refresh promotes the exact candidate held before quit", async () => {
  const f = fixture();
  try {
    const first = adapters();
    const held = await runInstallTransaction({
      ...options(f), candidateOnly: true, candidateOnlyReason: "coordinated-refresh",
    }, first.adapters);
    assert.equal(held.status, "candidate-ready");
    assert.equal(held.state.pendingReason, "coordinated-refresh");
    const second = adapters();
    const promoted = await runInstallTransaction({
      ...options(f), now: new Date("2026-07-10T12:01:00.000Z"),
    }, second.adapters);
    assert.equal(promoted.status, "promoted");
    assert.ok(second.calls.includes("promoteCandidate"));
    assert.equal(second.calls.includes("buildCandidate"), false);
  } finally {
    clean(f.root);
  }
});

function interruptedState(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    phase: "promoting",
    appRoot: f.appRoot,
    runtimeRoot: f.runtimeRoot,
    source: options(f).source,
    candidateRoot: join(f.workRoot, "candidate.app"),
    pristineRoot: join(f.workRoot, "pristine.app"),
    lastKnownGoodRoot: join(f.workRoot, "last-known-good.app"),
    lastKnownGoodRuntimeRoot: join(f.workRoot, "last-known-good-runtime"),
    createdAt: "2026-07-10T11:59:00.000Z",
    updatedAt: "2026-07-10T11:59:00.000Z",
    rollbackAttempted: false,
    ...extra,
  };
}

test("rollback validates the restored app with validateRestoredApp, not the candidate marker check", async () => {
  const f = fixture();
  try {
    writeFileSync(f.stateFile, JSON.stringify(interruptedState(f)));
    // The restored last-known-good app is pristine: the candidate validator
    // (which requires the Tweakers patch marker) rejects it.
    const { adapters: injected } = adapters({
      validateCandidate: () => false,
      validateRestoredApp: () => true,
    });
    const result = await runInstallTransaction(options(f), injected);
    assert.equal(result.status, "rolled-back");
    assert.equal(readTransactionState(f.stateFile)?.rollbackResult, "succeeded");
  } finally {
    clean(f.root);
  }
});

test("an interrupted state owned by a live process is held, never rolled back", async () => {
  const f = fixture();
  try {
    // PID 1 (launchd) is always alive; process.kill(1, 0) yields EPERM.
    writeFileSync(f.stateFile, JSON.stringify(interruptedState(f, { ownerPid: 1 })));
    const { adapters: injected, calls } = adapters();
    const result = await runInstallTransaction(options(f), injected);
    assert.equal(result.status, "held");
    assert.equal(calls.includes("restoreApp"), false);
    assert.equal(readTransactionState(f.stateFile)?.phase, "promoting");
  } finally {
    clean(f.root);
  }
});

test("a degraded record for a DIFFERENT source is archived and a fresh transaction proceeds", async () => {
  const f = fixture();
  try {
    writeFileSync(f.stateFile, JSON.stringify(interruptedState(f, {
      phase: "degraded",
      rollbackAttempted: true,
      rollbackResult: "failed",
      source: { version: "0.9.0", build: "older", hash: "old-hash" },
    })));
    const { adapters: injected, calls } = adapters();
    const result = await runInstallTransaction(options(f), injected);
    assert.equal(result.status, "promoted");
    assert.ok(calls.includes("promoteCandidate"));
  } finally {
    clean(f.root);
  }
});

test("archive failure preserves the legacy install journal as source evidence", () => {
  const f = fixture();
  const realDate = globalThis.Date;
  const fixedMilliseconds = realDate.parse("2026-07-17T03:04:05.678Z");
  const fixedStamp = new realDate(fixedMilliseconds).toISOString().replace(/[:.]/g, "-");
  const archived = `${f.stateFile.replace(/\.json$/, "")}.${fixedStamp}.promoting.json`;
  const sourceBytes = '{"legacy":"evidence"}\n';
  try {
    writeFileSync(f.stateFile, sourceBytes);
    mkdirSync(archived);
    globalThis.Date = class extends realDate {
      constructor(value?: string | number | Date) {
        super(value === undefined ? fixedMilliseconds : value instanceof realDate ? value.getTime() : value);
      }
      static now(): number { return fixedMilliseconds; }
    } as DateConstructor;

    archiveTransactionState(f.stateFile, interruptedState(f) as Parameters<typeof archiveTransactionState>[1]);
    assert.equal(readFileSync(f.stateFile, "utf8"), sourceBytes);
  } finally {
    globalThis.Date = realDate;
    clean(f.root);
  }
});

test("a degraded record for the SAME source still blocks (crash-loop protection)", async () => {
  const f = fixture();
  try {
    writeFileSync(f.stateFile, JSON.stringify(interruptedState(f, {
      phase: "degraded",
      rollbackAttempted: true,
    })));
    const { adapters: injected, calls } = adapters();
    const result = await runInstallTransaction(options(f), injected);
    assert.equal(result.status, "blocked");
    assert.equal(calls.includes("promoteCandidate"), false);
  } finally {
    clean(f.root);
  }
});

test("the transaction lock rejects concurrent runs and reclaims stale locks", async () => {
  const f = fixture();
  try {
    const lockFile = transactionLockFile(f.stateFile);
    mkdirSync(join(f.root), { recursive: true });
    // Live foreign owner (PID 1) → locked.
    writeFileSync(lockFile, "1\n");
    const { adapters: injected } = adapters();
    await assert.rejects(() => runInstallTransaction(options(f), injected), TransactionLockHeldError);
    // Dead owner → reclaimed, transaction proceeds and releases the lock.
    writeFileSync(lockFile, "999999\n");
    const result = await runInstallTransaction(options(f), injected);
    assert.equal(result.status, "promoted");
    assert.equal(existsSync(lockFile), false);
  } finally {
    clean(f.root);
  }
});
