import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDesktopUpdateTransaction,
  desktopVersionAdvanced,
  pristineBackupProvesObservedDesktop,
  readDesktopUpdateReceipt,
  runSynchronousLocalRefresh,
  writeDesktopUpdateReceipt,
  type DesktopUpdateDependencies,
  type DesktopUpdateReceipt,
  type DesktopVersionIdentity,
} from "../src/desktop-update-transaction";
import type {
  EnvironmentCoordinator,
  EnvironmentTransactionReceipt,
} from "../src/environment-transaction";
import {
  createEnvironmentSelection,
  defaultEnvironmentProfileRegistry,
  resolveEnvironmentProfile,
  type EnvironmentSelection,
} from "../src/environment-profile";
import {
  assertLifecycleReceiptsIdle,
  lifecycleLockFile,
  withLifecycleLock,
} from "../src/lifecycle-lock";

const NOW = "2026-07-16T12:00:00.000Z";

test("desktop version comparison accepts only a numeric advance", () => {
  assert.equal(desktopVersionAdvanced(
    { marketingVersion: "1.0.0", build: "100" },
    { marketingVersion: "0.9.0", build: "90" },
  ), false);
  assert.equal(desktopVersionAdvanced(
    { marketingVersion: "1.0.0", build: "100" },
    { marketingVersion: "1.1.0", build: "110" },
  ), true);
  assert.equal(desktopVersionAdvanced(
    { marketingVersion: "1.1.0", build: null },
    { marketingVersion: "1.0.9", build: null },
  ), false);
  assert.equal(desktopVersionAdvanced(
    { marketingVersion: "1.0.0", build: "100" },
    { marketingVersion: "1.0.0", build: "100" },
  ), false);
});

test("pristine backup proof requires a Developer ID valid exact updated version and build", () => {
  const backupPath = "/tmp/Tweakers/backup/Codex.app";
  const observed = { marketingVersion: "26.715.31925", build: "5551" };
  const exactVersion = () => ({ ...observed });

  assert.equal(pristineBackupProvesObservedDesktop(backupPath, observed, {
    verifyDeveloperId: () => true,
    readVersion: exactVersion,
  }), true);
  assert.equal(pristineBackupProvesObservedDesktop(backupPath, observed, {
    verifyDeveloperId: () => false,
    readVersion: exactVersion,
  }), false);
  assert.equal(pristineBackupProvesObservedDesktop(backupPath, observed, {
    verifyDeveloperId: () => true,
    readVersion: () => ({ marketingVersion: "26.715.21425", build: "5551" }),
  }), false);
  assert.equal(pristineBackupProvesObservedDesktop(backupPath, observed, {
    verifyDeveloperId: () => true,
    readVersion: () => ({ marketingVersion: "26.715.31925", build: "5488" }),
  }), false);
});

test("pristine backup proof rejects incomplete observed desktop identity", () => {
  for (const observed of [
    { marketingVersion: null, build: "5551" },
    { marketingVersion: "26.715.31925", build: null },
  ]) {
    assert.equal(pristineBackupProvesObservedDesktop(
      "/tmp/Tweakers/backup/Codex.app",
      observed,
      {
        verifyDeveloperId: () => true,
        readVersion: () => ({ marketingVersion: "26.715.31925", build: "5551" }),
      },
    ), false);
  }
});

test("desktop receipt publication fsyncs its parent directory", async () => {
  await withFixture(async (fixture) => {
    const originalFsync = fs.fsyncSync;
    let directoryFsyncs = 0;
    fs.fsyncSync = (fd: number): void => {
      if (fs.fstatSync(fd).isDirectory()) directoryFsyncs += 1;
      originalFsync(fd);
    };
    syncBuiltinESMExports();
    try {
      writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt());
    } finally {
      fs.fsyncSync = originalFsync;
      syncBuiltinESMExports();
    }

    assert.equal(directoryFsyncs, 1);
  });
});

test("additive terminal chronology remains compatible with legacy schema-v1 receipts", async () => {
  await withFixture(async (fixture) => {
    const legacy = persistedReceipt({
      phase: "failed",
      safeOfficialMode: true,
      resumable: true,
      error: "legacy failure",
    });
    delete legacy.terminalAt;
    delete legacy.continuationAbandonedAt;
    fs.mkdirSync(join(fixture.root, "transactions"), { recursive: true });
    fs.writeFileSync(fixture.stateFile, `${JSON.stringify(legacy)}\n`);

    const decoded = readDesktopUpdateReceipt(fixture.stateFile);

    assert.equal(decoded?.schemaVersion, 1);
    assert.equal(decoded?.terminalAt, undefined);
    assert.equal(decoded?.continuationAbandonedAt, undefined);

    fs.writeFileSync(fixture.stateFile, `${JSON.stringify({
      ...legacy,
      terminalAt: "not-an-iso-timestamp",
    })}\n`);
    assert.throws(
      () => readDesktopUpdateReceipt(fixture.stateFile),
      /Desktop update receipt is invalid/,
    );
  });
});

function selection(appExperience: "chatgpt" | "tweakers" = "tweakers"): EnvironmentSelection {
  return createEnvironmentSelection({
    profile: resolveEnvironmentProfile(defaultEnvironmentProfileRegistry(), "stable"),
    appExperience,
    requestedAt: NOW,
    appliedAt: NOW,
  });
}

function environmentReceipt(
  transactionId: string,
  source: EnvironmentSelection,
  requested: EnvironmentSelection,
  phase: EnvironmentTransactionReceipt["phase"],
): EnvironmentTransactionReceipt {
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId,
    phase,
    error: phase === "rolled-back" ? "rolled back" : null,
    ownerPid: process.pid,
    source,
    requested: { ...requested, appliedAt: phase === "committed" ? NOW : null },
    oldMainPid: 100,
    newMainPid: phase === "committed" || phase === "rolled-back" ? 101 : null,
    attempt: phase === "prepared" ? 0 : 1,
    createdAt: NOW,
    updatedAt: NOW,
    committedAt: phase === "committed" ? NOW : null,
    rolledBackAt: phase === "rolled-back" ? NOW : null,
    cancelledAt: null,
  };
}

function fakeCoordinator(calls: string[]): EnvironmentCoordinator {
  let prepared: EnvironmentTransactionReceipt | null = null;
  let serial = 0;
  return {
    prepare: async ({ current, requested }) => {
      serial += 1;
      calls.push(`prepare:${requested.appExperience}`);
      prepared = environmentReceipt(`env-${serial}`, current, requested, "prepared");
      return prepared;
    },
    commit: async (id) => {
      assert.equal(id, prepared?.transactionId);
      calls.push(`commit:${prepared?.requested.appExperience}`);
      prepared = environmentReceipt(id!, prepared!.source, prepared!.requested, "committed");
      return prepared;
    },
    status: () => prepared,
    verify: async () => ({ ok: true, observedPid: 101, visibleWindow: true, appliedSelection: prepared?.requested ?? null, error: null }),
    rollback: async (id) => {
      calls.push(`rollback:${id}`);
      prepared = environmentReceipt(id!, prepared!.source, prepared!.requested, "rolled-back");
      return prepared;
    },
    cancel: async (id) => environmentReceipt(id!, prepared!.source, prepared!.requested, "cancelled"),
    recover: async (id) => {
      throw new Error(`unexpected environment recover for ${id}`);
    },
  };
}

async function withFixture(
  run: (fixture: {
    root: string;
    stateFile: string;
    receiptRoot: string;
    lockFile: string;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweakers-desktop-update-"));
  try {
    await run({
      root,
      stateFile: join(root, "transactions", "desktop-update.json"),
      receiptRoot: join(root, "transactions", "desktop-update"),
      lockFile: join(root, "transactions", "desktop-update.lock"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function dependencies(overrides: Partial<DesktopUpdateDependencies> = {}) {
  const calls: string[] = [];
  const initial = selection("tweakers");
  const deps: DesktopUpdateDependencies = {
    environment: fakeCoordinator(calls),
    readCurrentSelection: () => initial,
    readDesktopVersion: () => ({ marketingVersion: "1.0.0", build: "100" }),
    readDesktopBundleIdentifier: () => initial.selectedDesktopBundleId,
    inspectLiveOfficialDesktop: () => ({
      version: { marketingVersion: "1.0.0", build: "100" },
      mainPid: 101,
    }),
    launchOfficialDesktop: () => { calls.push("launch-official-desktop"); },
    initiateNativeUpdate: async () => { calls.push("native-update-handoff"); },
    waitForVersionChange: async () => ({ marketingVersion: "1.1.0", build: "110" }),
    refreshEnvironmentTruth: async () => { calls.push("refresh-environment-truth"); },
    selectRefreshSource: () => "development",
    refreshTweakers: async ({ source }) => { calls.push(`refresh:${source}`); },
    verifyFinal: async () => ({ ok: true, error: null }),
    recoverVerifiedOfficialUpdate: async () => null,
    processAlive: () => false,
    readProcessStartToken: () => "test-owner-start",
    now: () => NOW,
    createId: () => "desktop-1",
    createOwnerGeneration: () => "owner-generation-1",
    ...overrides,
  };
  return { calls, deps };
}

function persistedReceipt(overrides: Partial<DesktopUpdateReceipt> = {}): DesktopUpdateReceipt {
  const initial = selection("tweakers");
  return {
    schemaVersion: 1,
    kind: "desktop-update",
    transactionId: "desktop-recovery",
    phase: "preparing",
    ownerPid: 999,
    source: initial,
    official: selection("chatgpt"),
    baseline: { marketingVersion: "1.0.0", build: "100" },
    observed: null,
    nativeUpdateHandoffAt: null,
    refreshSource: null,
    environmentTransactionId: null,
    safeOfficialMode: false,
    resumable: false,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
    continuationAbandonedAt: null,
    completedAt: null,
    rolledBackAt: null,
    ...overrides,
  };
}

test("a real official version change returns to Tweakers, refreshes the chosen source, and completes", async () => {
  await withFixture(async (fixture) => {
    const { calls, deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "completed");
    assert.equal(receipt.safeOfficialMode, false);
    assert.equal(receipt.resumable, false);
    assert.deepEqual(receipt.baseline, { marketingVersion: "1.0.0", build: "100" });
    assert.deepEqual(receipt.observed, { marketingVersion: "1.1.0", build: "110" });
    assert.equal(receipt.refreshSource, "development");
    assert.equal(receipt.terminalAt, receipt.completedAt);
    assert.equal(receipt.continuationAbandonedAt, null);
    assert.deepEqual(calls, [
      "refresh-environment-truth",
      "prepare:chatgpt",
      "commit:chatgpt",
      "native-update-handoff",
      "refresh-environment-truth",
      "prepare:tweakers",
      "commit:tweakers",
      "refresh:development",
    ]);
    assert.equal(transaction.status()?.phase, "completed");
    assert.equal(readdirSync(fixture.receiptRoot).length, 1);
  });
});

test("desktop update transaction logs one ordered event per persisted phase transition", async () => {
  await withFixture(async (fixture) => {
    const { deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    await transaction.start();

    const records = readFileSync(
      join(fixture.root, "log", "desktop-update.log"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; phase: string });
    assert.deepEqual(
      records.map(({ event, phase }) => `${event}:${phase}`),
      [
        "owner_started:preparing",
        "phase_transition:switching_to_chatgpt",
        "phase_transition:awaiting_native_update",
        "handoff_result:awaiting_native_update",
        "phase_transition:returning_to_tweakers",
        "phase_transition:refreshing_runtime",
        "phase_transition:verifying",
        "owner_completed:completed",
      ],
    );
  });
});

test("recovery transaction logs redact the user root and end with handled failure evidence", async () => {
  await withFixture(async (fixture) => {
    const { deps } = dependencies({
      refreshTweakers: async () => {
        throw new Error(`refresh failed under ${fixture.root}/managed-runtime`);
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const result = await transaction.start();
    const log = readFileSync(join(fixture.root, "log", "desktop-update.log"), "utf8");
    const records = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; phase: string; error?: string });

    assert.equal(result.phase, "rolled_back");
    assert.equal(log.includes(fixture.root), false);
    assert.deepEqual(records.at(-1), {
      schemaVersion: 1,
      ts: NOW,
      transactionId: "desktop-1",
      phase: "rolled_back",
      ownerPid: process.pid,
      ownerToken: "test-owner-start",
      ownerGeneration: "owner-generation-1",
      event: "handled_failure",
      error: "refresh failed under [user-root]/managed-runtime",
    });
  });
});

test("default final verification refuses completion without an exact updated pristine backup", async () => {
  await withFixture(async (fixture) => {
    const { deps } = dependencies();
    const { verifyFinal: _testVerifier, ...productionVerificationDeps } = deps;
    const transaction = createDesktopUpdateTransaction(fixture, productionVerificationDeps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "rolled_back");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, true);
    assert.match(receipt.error ?? "", /pristine official backup.*Developer ID valid.*updated desktop version\/build/i);
  });
});

test("an unreadable baseline fails before creating a transaction receipt", async () => {
  await withFixture(async (fixture) => {
    const { calls, deps } = dependencies({
      readDesktopVersion: () => ({ marketingVersion: null, build: null }),
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    await assert.rejects(
      () => transaction.start(),
      /both the ChatGPT version and build are unreadable.*No transaction was created/i,
    );
    assert.equal(transaction.status(), null);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(fixture.stateFile), false);
  });
});

test("an exact selected --app path is verified before the desktop transaction starts", async () => {
  await withFixture(async (fixture) => {
    const selected = selection("tweakers");
    const observedPaths: string[] = [];
    const { deps } = dependencies({
      readCurrentSelection: () => selected,
      readDesktopBundleIdentifier: (appPath) => {
        observedPaths.push(appPath);
        return selected.selectedDesktopBundleId;
      },
    });
    const transaction = createDesktopUpdateTransaction({
      ...fixture,
      appPath: selected.selectedDesktopPath,
    }, deps);

    assert.equal((await transaction.start()).phase, "completed");
    assert.deepEqual(observedPaths, [selected.selectedDesktopPath]);
  });
});

test("--app rejects non-absolute, non-app, path-mismatch, and bundle-mismatch inputs before persistence", async () => {
  const selected = selection("tweakers");
  const cases = [
    { appPath: "ChatGPT.app", expected: /exact absolute \.app path/ },
    { appPath: "/Applications/ChatGPT", expected: /exact absolute \.app path/ },
    { appPath: "/Applications/OpenAI Beta.app", expected: /does not match the selected stable environment/ },
    { appPath: selected.selectedDesktopPath, expected: /has identifier com\.example\.wrong; expected/ },
  ];

  for (const input of cases) {
    await withFixture(async (fixture) => {
      const { calls, deps } = dependencies({
        readCurrentSelection: () => selected,
        readDesktopBundleIdentifier: () => "com.example.wrong",
      });
      const transaction = createDesktopUpdateTransaction({ ...fixture, appPath: input.appPath }, deps);

      await assert.rejects(() => transaction.start(), input.expected);
      assert.equal(transaction.status(), null);
      assert.deepEqual(calls, []);
    });
  }
});

test("native updater handoff receives the exact official PID committed by the environment transaction", async () => {
  await withFixture(async (fixture) => {
    let receivedPid: number | null | undefined;
    const { deps } = dependencies({
      initiateNativeUpdate: async (input) => {
        receivedPid = input.officialMainPid;
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "completed");
    assert.equal(receivedPid, 101);
  });
});

test("environment truth refresh preserves the exact captured source selection before prepare", async () => {
  await withFixture(async (fixture) => {
    const capturedAt = "2026-07-17T18:19:55.288Z";
    const captured = {
      ...selection("tweakers"),
      requestedAt: capturedAt,
      appliedAt: capturedAt,
    };
    const refreshed: EnvironmentSelection[] = [];
    const calls: string[] = [];
    const baseEnvironment = fakeCoordinator(calls);
    const environment: EnvironmentCoordinator = {
      ...baseEnvironment,
      prepare: async (input) => {
        assert.deepEqual(
          input.current,
          refreshed.at(-1),
          "profile refresh must not remint the current selection timestamp",
        );
        return baseEnvironment.prepare(input);
      },
    };
    const { deps } = dependencies({
      environment,
      readCurrentSelection: () => captured,
      refreshEnvironmentTruth: async (current) => {
        refreshed.push(current);
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "completed");
    assert.equal(refreshed[0]?.requestedAt, capturedAt);
    assert.equal(refreshed[0]?.appliedAt, capturedAt);
    assert.deepEqual(
      refreshed.map((current) => current.appExperience),
      ["tweakers", "chatgpt"],
    );
  });
});

test("a ChatGPT-origin update requires a different final PID than the pre-update official process", async () => {
  await withFixture(async (fixture) => {
    let previousMainPid: number | null = null;
    const { deps } = dependencies({
      readCurrentSelection: () => selection("chatgpt"),
      verifyFinal: async (input) => {
        previousMainPid = input.previousMainPid;
        return { ok: true, error: null };
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "completed");
    assert.equal(receipt.officialMainPid, 101);
    assert.equal(previousMainPid, 101);
  });
});

test("completion waits until the selected refresh has actually resolved", async () => {
  await withFixture(async (fixture) => {
    let announceRefresh!: () => void;
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { announceRefresh = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const { deps } = dependencies({
      refreshTweakers: async () => {
        announceRefresh();
        await refreshGate;
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);
    let settled = false;

    const pending = transaction.start().finally(() => { settled = true; });
    await refreshStarted;

    assert.equal(settled, false);
    assert.equal(transaction.status()?.phase, "refreshing_runtime");
    releaseRefresh();
    assert.equal((await pending).phase, "completed");
  });
});

test("desktop update holds the shared lifecycle lease through native wait and cancellation stays terminal", async () => {
  await withFixture(async (fixture) => {
    let announceWait!: () => void;
    let releaseWait!: (value: DesktopVersionIdentity | null) => void;
    const waitStarted = new Promise<void>((resolve) => { announceWait = resolve; });
    const waitGate = new Promise<DesktopVersionIdentity | null>((resolve) => { releaseWait = resolve; });
    const { calls, deps } = dependencies({
      waitForVersionChange: async () => {
        announceWait();
        return waitGate;
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);
    const pending = transaction.start();
    await waitStarted;

    await assert.rejects(
      withLifecycleLock(lifecycleLockFile(fixture.root), "competing refresh", async () => undefined),
      /Another Tweakers lifecycle operation is active/,
    );
    const cancelled = await transaction.cancel();
    assert.equal(cancelled.phase, "failed");
    assert.equal(cancelled.resumable, false);
    releaseWait({ marketingVersion: "1.1.0", build: "110" });
    const result = await pending;
    assert.deepEqual(result, cancelled);
    assert.deepEqual(transaction.status(), cancelled);
    assert.deepEqual(calls, ["refresh-environment-truth", "prepare:chatgpt", "commit:chatgpt", "native-update-handoff"]);
  });
});

test("a cancellation that wins after the native wait settles cannot be overwritten by the waiter", async () => {
  await withFixture(async (fixture) => {
    let announceTransition!: () => void;
    let releaseTransition!: () => void;
    const transitionReached = new Promise<void>((resolve) => { announceTransition = resolve; });
    const transitionGate = new Promise<void>((resolve) => { releaseTransition = resolve; });
    const { deps } = dependencies({
      beforeNativeWaitTransition: async () => {
        announceTransition();
        await transitionGate;
      },
    });
    const waiter = createDesktopUpdateTransaction(fixture, deps);
    const canceller = createDesktopUpdateTransaction(fixture, deps);
    const pending = waiter.start();
    await transitionReached;

    const cancelled = await canceller.cancel();
    releaseTransition();
    const result = await pending;

    assert.equal(cancelled.phase, "failed");
    assert.equal(cancelled.resumable, false);
    assert.deepEqual(result, cancelled);
    assert.deepEqual(waiter.status(), cancelled);
  });
});

test("a post-wait continuation that wins cannot be rolled back by same-process cancellation", async () => {
  await withFixture(async (fixture) => {
    let announceRefresh!: () => void;
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { announceRefresh = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshCount = 0;
    const { calls, deps } = dependencies({
      refreshEnvironmentTruth: async () => {
        calls.push("refresh-environment-truth");
        refreshCount += 1;
        if (refreshCount === 1) return;
        announceRefresh();
        await refreshGate;
      },
      processAlive: () => true,
    });
    const waiter = createDesktopUpdateTransaction(fixture, deps);
    const canceller = createDesktopUpdateTransaction(fixture, deps);
    const pending = waiter.start();
    await refreshStarted;

    assert.equal(waiter.status()?.phase, "returning_to_tweakers");
    await assert.rejects(
      canceller.cancel(),
      /Desktop update owner PID .* is still active/,
    );
    assert.doesNotMatch(calls.join("\n"), /rollback:/);

    releaseRefresh();
    const result = await pending;
    assert.equal(result.phase, "completed");
    assert.equal(waiter.status()?.phase, "completed");
    assert.doesNotMatch(calls.join("\n"), /rollback:/);
  });
});

test("updated desktop truth must be recomputed before rebuilding Tweakers", async () => {
  await withFixture(async (fixture) => {
    let refreshCount = 0;
    const { calls, deps } = dependencies({
      refreshEnvironmentTruth: async () => {
        refreshCount += 1;
        if (refreshCount === 1) {
          calls.push("refresh-environment-truth");
          return;
        }
        throw new Error("updated trust failed");
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, true);
    assert.match(receipt.error ?? "", /updated desktop environment.*updated trust failed/i);
    assert.deepEqual(calls, ["refresh-environment-truth", "prepare:chatgpt", "commit:chatgpt", "native-update-handoff"]);
  });
});

test("a persisted attempt-zero preparation failure is correlated and explicitly recoverable", async () => {
  await withFixture(async (fixture) => {
    const calls: string[] = [];
    const initial = selection("tweakers");
    const official = selection("chatgpt");
    const failedPreparation = {
      ...environmentReceipt("env-prepare-failed", initial, official, "failed"),
      attempt: 0,
      error: "candidate preparation failed",
    };
    const coordinator: EnvironmentCoordinator = {
      ...fakeCoordinator(calls),
      prepare: async () => {
        calls.push("prepare:chatgpt");
        throw new Error("Could not prepare environment transaction: candidate preparation failed");
      },
      status: () => failedPreparation,
      rollback: async () => { throw new Error("preparation failure must not roll back"); },
      cancel: async () => { throw new Error("terminal preparation failure must not cancel"); },
    };
    const { deps } = dependencies({ environment: coordinator });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const failed = await transaction.start();

    assert.equal(failed.phase, "failed");
    assert.equal(failed.safeOfficialMode, false);
    assert.equal(failed.environmentTransactionId, "env-prepare-failed");
    assert.throws(
      () => assertLifecycleReceiptsIdle(fixture.root, { contextOwned: false }),
      /without confirmed safe official mode.*explicit recovery/i,
    );

    const recovered = await transaction.cancel();

    assert.equal(recovered.phase, "rolled_back");
    assert.equal(recovered.safeOfficialMode, false);
    assert.equal(recovered.resumable, false);
    assert.match(recovered.error ?? "", /recovered to its source selection/i);
    assert.deepEqual(calls, ["prepare:chatgpt"]);
    assert.doesNotThrow(() => assertLifecycleReceiptsIdle(fixture.root, { contextOwned: false }));
  });
});

test("desktop truth is refreshed before the first official environment preparation", async () => {
  await withFixture(async (fixture) => {
    const { calls, deps } = dependencies({
      refreshEnvironmentTruth: async () => { calls.push("refresh-stale-registry"); },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "completed");
    assert.deepEqual(calls.slice(0, 3), [
      "refresh-stale-registry",
      "prepare:chatgpt",
      "commit:chatgpt",
    ]);
  });
});

test("a failed prepare does not correlate an unrelated historical environment receipt", async () => {
  await withFixture(async (fixture) => {
    const historical = {
      ...environmentReceipt("historical-env", selection("chatgpt"), selection("tweakers"), "failed"),
      attempt: 0,
      error: "older unrelated failure",
    };
    const coordinator: EnvironmentCoordinator = {
      ...fakeCoordinator([]),
      prepare: async () => { throw new Error("prepare failed before persisting its own receipt"); },
      status: () => historical,
    };
    const { deps } = dependencies({ environment: coordinator });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const failed = await transaction.start();

    assert.equal(failed.phase, "failed");
    assert.equal(failed.environmentTransactionId, null);
    await assert.rejects(() => transaction.cancel(), /cannot be safely cancelled from failed/i);
    assert.throws(
      () => assertLifecycleReceiptsIdle(fixture.root, { contextOwned: false }),
      /without confirmed safe official mode.*explicit recovery/i,
    );
  });
});

test("the synchronous development refresh invokes the registered refresh path and restores its scoped environment", async () => {
  const env: NodeJS.ProcessEnv = { TWEAKERS_REFRESH_LOCAL_DETACHED: "previous" };
  const calls: Array<{ source: string; app: string; detached: string | undefined }> = [];

  await runSynchronousLocalRefresh({
    source: "development",
    selection: selection("tweakers"),
    observedDesktop: { marketingVersion: "1.1.0", build: "110" },
  }, {
    env,
    refresh: async ({ source, app }) => {
      calls.push({ source, app, detached: env.TWEAKERS_REFRESH_LOCAL_DETACHED });
    },
  });

  assert.deepEqual(calls, [{
    source: "development",
    app: selection("tweakers").selectedDesktopPath,
    detached: "1",
  }]);
  assert.equal(env.TWEAKERS_REFRESH_LOCAL_DETACHED, "previous");
});

test("timeout leaves the verified official app active and records a resumable safe outcome", async () => {
  await withFixture(async (fixture) => {
    const { calls, deps } = dependencies({ waitForVersionChange: async () => null });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, true);
    assert.match(receipt.error ?? "", /did not complete/i);
    assert.equal(receipt.terminalAt, NOW);
    assert.equal(receipt.continuationAbandonedAt, null);
    assert.deepEqual(calls, ["refresh-environment-truth", "prepare:chatgpt", "commit:chatgpt", "native-update-handoff"]);
  });
});

test("resume continues a persisted safe-official timeout without starting a second official switch", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    const priorTerminalAt = "2026-07-15T11:00:00.000Z";
    const timedOut: DesktopUpdateReceipt = {
      schemaVersion: 1,
      kind: "desktop-update",
      transactionId: "desktop-1",
      phase: "failed",
      ownerPid: 123,
      source: initial,
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: null,
      nativeUpdateHandoffAt: NOW,
      refreshSource: null,
      environmentTransactionId: "env-1",
      safeOfficialMode: true,
      resumable: true,
      error: "The official update did not complete before the timeout.",
      createdAt: priorTerminalAt,
      updatedAt: priorTerminalAt,
      terminalAt: priorTerminalAt,
      continuationAbandonedAt: null,
      completedAt: null,
      rolledBackAt: null,
    };
    writeDesktopUpdateReceipt(fixture.stateFile, timedOut);
    const { calls, deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.resume();

    assert.equal(receipt.phase, "completed");
    assert.equal(receipt.terminalAt, receipt.completedAt);
    assert.notEqual(receipt.terminalAt, priorTerminalAt);
    assert.equal(receipt.continuationAbandonedAt, null);
    assert.deepEqual(calls, ["native-update-handoff", "refresh-environment-truth", "prepare:tweakers", "commit:tweakers", "refresh:development"]);
  });
});

test("resume recovers its own stranded environment transaction before returning to Tweakers", async () => {
  // Live 2026-08-07 deadlock: the desktop receipt was failed+resumable while
  // its recorded environment transaction sat failed mid-rollback. Resume must
  // recover that transaction first — its receipt blocks the returning leg's
  // fresh prepare — instead of telling the user to run `environment recover`,
  // which the desktop receipt in turn blocks.
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      environmentTransactionId: "env-stranded",
      safeOfficialMode: true,
      resumable: true,
      error: "refresh failed",
    }));
    const stranded = {
      ...environmentReceipt("env-stranded", selection("chatgpt"), selection("tweakers"), "failed"),
      error: "Rollback requested; rollback failed: watcher promotion race",
    };
    let recovered = false;
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => ({
        version: { marketingVersion: "1.1.0", build: "110" },
        mainPid: 26138,
      }),
    });
    deps.environment = {
      ...deps.environment,
      status: () => (recovered
        ? { ...stranded, phase: "rolled-back", error: null }
        : stranded),
      recover: async (id) => {
        assert.equal(id, "env-stranded");
        calls.push(`recover:${id}`);
        recovered = true;
        return { ...stranded, phase: "rolled-back", error: null };
      },
    };

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "completed");
    assert.deepEqual(calls, [
      "recover:env-stranded",
      "refresh-environment-truth",
      "prepare:tweakers",
      "commit:tweakers",
      "refresh:development",
    ]);
  });
});

test("resume finishes only the refresh and verify legs when recovery proves Tweakers already live", async () => {
  // The stranded return-leg commit had actually landed: recover() proves the
  // REQUESTED Tweakers environment live and republishes its selection. The
  // official app is not running, so resume must not inspect official truth or
  // re-prepare the return — only the runtime refresh and final verification
  // remain.
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      observed: { marketingVersion: "1.1.0", build: "110" },
      environmentTransactionId: "env-stranded",
      safeOfficialMode: true,
      resumable: true,
      error: "refresh failed",
    }));
    const stranded = {
      ...environmentReceipt("env-stranded", selection("chatgpt"), selection("tweakers"), "failed"),
      error: "Rollback requested; rollback failed: watcher promotion race",
    };
    let recovered = false;
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => {
        throw new Error("official ChatGPT must not be inspected when Tweakers is proven live");
      },
      refreshEnvironmentTruth: async () => {
        throw new Error("official truth must not be refreshed when Tweakers is proven live");
      },
    });
    deps.environment = {
      ...deps.environment,
      status: () => (recovered
        ? environmentReceipt("env-stranded", selection("chatgpt"), selection("tweakers"), "committed")
        : stranded),
      recover: async (id) => {
        assert.equal(id, "env-stranded");
        calls.push(`recover:${id}`);
        recovered = true;
        return environmentReceipt("env-stranded", selection("chatgpt"), selection("tweakers"), "committed");
      },
      prepare: async () => {
        throw new Error("the return leg must not be re-prepared after a committed recovery");
      },
    };

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "completed");
    assert.equal(receipt.safeOfficialMode, false);
    assert.deepEqual(calls, ["recover:env-stranded", "refresh:development"]);
  });
});

test("resume surfaces an unrecoverable environment transaction as a resumable failure", async () => {
  await withFixture(async (fixture) => {
    // observed is non-null in every real return-leg failure; the terminal
    // recover diagnostic below must survive the tail dispatch anyway.
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      observed: { marketingVersion: "1.1.0", build: "110" },
      environmentTransactionId: "env-stranded",
      safeOfficialMode: true,
      resumable: true,
      error: "refresh failed",
    }));
    const stranded = {
      ...environmentReceipt("env-stranded", selection("chatgpt"), selection("tweakers"), "failed"),
      error: "Rollback requested; rollback failed: watcher promotion race",
    };
    const { calls, deps } = dependencies();
    deps.environment = {
      ...deps.environment,
      status: () => stranded,
      recover: async () => {
        throw new Error(
          "live desktop proves neither direction. Last failure: Rollback requested; rollback failed: watcher race",
        );
      },
    };

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.resumable, true);
    assert.equal(receipt.safeOfficialMode, true);
    assert.match(receipt.error ?? "", /Could not recover environment transaction env-stranded/);
    assert.match(receipt.error ?? "", /proves neither direction/);
    // The environment's quoted "rollback failed" text must be neutralized:
    // reproduced verbatim it would make desktopReceiptBlocksLifecycle treat
    // THIS receipt as a desktop-level rollback failure (permanently blocking
    // after a cancel).
    assert.doesNotMatch(receipt.error ?? "", /\brollback failed\b/i);
    assert.match(receipt.error ?? "", /rollback unsuccessful/);
    assert.deepEqual(calls, []);
  });
});

test("resume continues from a standalone environment recovery without inspecting official ChatGPT", async () => {
  // The gate's coupling allowance exists so `environment recover` can run
  // FIRST. When it already proved the requested Tweakers environment live,
  // the coupled receipt no longer blocks — resume must recognize the
  // committed recovery instead of inspecting the official app (which would
  // throw on the patched asar and stamp a false safeOfficialMode failure).
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      observed: { marketingVersion: "1.1.0", build: "110" },
      environmentTransactionId: "env-recovered",
      safeOfficialMode: true,
      resumable: true,
      error: "refresh failed",
    }));
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => {
        throw new Error("official ChatGPT must not be inspected after a committed recovery");
      },
      refreshEnvironmentTruth: async () => {
        throw new Error("official truth must not be refreshed after a committed recovery");
      },
    });
    deps.environment = {
      ...deps.environment,
      status: () => environmentReceipt("env-recovered", selection("chatgpt"), selection("tweakers"), "committed"),
      recover: async () => {
        throw new Error("recovery already happened standalone; resume must not repeat it");
      },
      prepare: async () => {
        throw new Error("the return leg must not be re-prepared after a committed recovery");
      },
    };

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "completed");
    assert.equal(receipt.safeOfficialMode, false);
    assert.deepEqual(calls, ["refresh:development"]);
  });
});

test("resume leaves a terminal non-blocking environment receipt untouched", async () => {
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      environmentTransactionId: "env-done",
      safeOfficialMode: true,
      resumable: true,
      error: "handoff timed out",
    }));
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => ({
        version: { marketingVersion: "1.1.0", build: "110" },
        mainPid: 26138,
      }),
    });
    deps.environment = {
      ...deps.environment,
      status: () => environmentReceipt("env-done", selection("chatgpt"), selection("tweakers"), "rolled-back"),
      recover: async () => {
        throw new Error("must not recover a non-blocking environment receipt");
      },
    };

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "completed");
    assert.deepEqual(calls, [
      "refresh-environment-truth",
      "prepare:tweakers",
      "commit:tweakers",
      "refresh:development",
    ]);
  });
});

test("resume detects an already-installed official update and returns to Tweakers without another handoff", async () => {
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      officialMainPid: 82156,
      safeOfficialMode: true,
      resumable: true,
      error: "Native updater handoff failed for stale PID 82156",
    }));
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => ({
        version: { marketingVersion: "1.1.0", build: "110" },
        mainPid: 26138,
      }),
      initiateNativeUpdate: async () => {
        throw new Error("must not hand off after the installed build advanced");
      },
      waitForVersionChange: async () => {
        throw new Error("must not wait after the installed build advanced");
      },
    });

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "completed");
    assert.deepEqual(receipt.observed, { marketingVersion: "1.1.0", build: "110" });
    assert.equal(receipt.officialMainPid, 26138);
    assert.deepEqual(calls, [
      "refresh-environment-truth",
      "prepare:tweakers",
      "commit:tweakers",
      "refresh:development",
    ]);
  });
});

test("resume reconciles the refreshed official selection before preparing the return to Tweakers", async () => {
  await withFixture(async (fixture) => {
    const persistedOfficial = selection("chatgpt");
    const refreshedOfficial = {
      ...persistedOfficial,
      appliedAt: "2026-07-18T19:19:46.595Z",
    };
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "rolled_back",
      source: selection("tweakers"),
      official: persistedOfficial,
      observed: { marketingVersion: "1.1.0", build: "110" },
      officialMainPid: 68976,
      safeOfficialMode: true,
      resumable: true,
      error: "Recovered safely in official mode.",
    }));
    const calls: string[] = [];
    const baseEnvironment = fakeCoordinator(calls);
    const environment: EnvironmentCoordinator = {
      ...baseEnvironment,
      prepare: async (input) => {
        assert.deepEqual(
          input.current,
          refreshedOfficial,
          "return preparation must use the selection refreshed from live registry truth",
        );
        return baseEnvironment.prepare(input);
      },
    };
    const { deps } = dependencies({
      environment,
      inspectLiveOfficialDesktop: async () => ({
        version: { marketingVersion: "1.1.0", build: "110" },
        mainPid: 68976,
      }),
      refreshEnvironmentTruth: async () => refreshedOfficial,
    });

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "completed");
    assert.deepEqual(receipt.official, refreshedOfficial);
    assert.deepEqual(calls, ["prepare:tweakers", "commit:tweakers"]);
  });
});

test("resume rebinds an unchanged official build to its currently proved process before handoff", async () => {
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      officialMainPid: 82156,
      safeOfficialMode: true,
      resumable: true,
      error: "Native updater handoff failed for stale PID 82156",
    }));
    let handoffPid: number | null = null;
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => ({
        version: { marketingVersion: "1.0.0", build: "100" },
        mainPid: 26138,
      }),
      initiateNativeUpdate: async (input) => {
        handoffPid = input.officialMainPid;
        calls.push("native-update-handoff");
      },
    });

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "completed");
    assert.equal(handoffPid, 26138);
    assert.equal(receipt.officialMainPid, 26138);
    assert.deepEqual(calls, [
      "native-update-handoff",
      "refresh-environment-truth",
      "prepare:tweakers",
      "commit:tweakers",
      "refresh:development",
    ]);
  });
});

test("resume keeps safe official mode resumable when live official proof fails", async () => {
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      officialMainPid: 82156,
      safeOfficialMode: true,
      resumable: true,
      error: "Native updater handoff failed for stale PID 82156",
    }));
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => {
        throw new Error("The live desktop is not a pristine OpenAI-signed app");
      },
    });

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, true);
    assert.equal(receipt.officialMainPid, 82156);
    assert.match(receipt.error ?? "", /could not verify live official ChatGPT.*pristine OpenAI-signed/i);
    assert.deepEqual(calls, []);
  });
});

test("resume recovers an interrupted awaiting receipt only after its owner exits", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    writeDesktopUpdateReceipt(fixture.stateFile, {
      schemaVersion: 1,
      kind: "desktop-update",
      transactionId: "desktop-1",
      phase: "awaiting_native_update",
      ownerPid: 999,
      source: initial,
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: null,
      nativeUpdateHandoffAt: NOW,
      refreshSource: null,
      environmentTransactionId: "env-1",
      safeOfficialMode: true,
      resumable: true,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      rolledBackAt: null,
    });
    const { calls, deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.resume();

    assert.equal(receipt.phase, "completed");
    assert.deepEqual(calls, ["native-update-handoff", "refresh-environment-truth", "prepare:tweakers", "commit:tweakers", "refresh:development"]);
  });
});

test("resume refuses to duplicate an awaiting transaction whose owner is still alive", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    writeDesktopUpdateReceipt(fixture.stateFile, {
      schemaVersion: 1,
      kind: "desktop-update",
      transactionId: "desktop-1",
      phase: "awaiting_native_update",
      ownerPid: 999,
      source: initial,
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: null,
      nativeUpdateHandoffAt: NOW,
      refreshSource: null,
      environmentTransactionId: "env-1",
      safeOfficialMode: true,
      resumable: true,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      rolledBackAt: null,
    });
    const { deps } = dependencies({ processAlive: () => true });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    await assert.rejects(() => transaction.resume(), /owner PID 999 is still active/i);
  });
});

test("resume after a return failure reuses the observed update instead of handing off to the updater again", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    writeDesktopUpdateReceipt(fixture.stateFile, {
      schemaVersion: 1,
      kind: "desktop-update",
      transactionId: "desktop-1",
      phase: "rolled_back",
      ownerPid: 123,
      source: initial,
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: { marketingVersion: "1.1.0", build: "110" },
      nativeUpdateHandoffAt: NOW,
      refreshSource: "development",
      environmentTransactionId: "env-2",
      safeOfficialMode: true,
      resumable: true,
      error: "refresh failed",
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      rolledBackAt: NOW,
    });
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => ({
        version: { marketingVersion: "1.1.0", build: "110" },
        mainPid: 26138,
      }),
      initiateNativeUpdate: async () => { throw new Error("must not hand off again"); },
      waitForVersionChange: async () => { throw new Error("must not wait again"); },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.resume();

    assert.equal(receipt.phase, "completed");
    assert.deepEqual(calls, ["refresh-environment-truth", "prepare:tweakers", "commit:tweakers", "refresh:development"]);
  });
});

test("rolled-back resume failure receives fresh terminal chronology", async () => {
  await withFixture(async (fixture) => {
    const priorTerminalAt = "2026-07-15T11:00:00.000Z";
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "rolled_back",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: { marketingVersion: "1.1.0", build: "110" },
      officialMainPid: 26138,
      safeOfficialMode: true,
      resumable: true,
      error: "refresh failed",
      updatedAt: priorTerminalAt,
      terminalAt: priorTerminalAt,
      continuationAbandonedAt: null,
      completedAt: null,
      rolledBackAt: priorTerminalAt,
    }));
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => ({
        version: { marketingVersion: "1.0.0", build: "100" },
        mainPid: 30001,
      }),
      initiateNativeUpdate: async () => { throw new Error("must not hand off after a recorded update"); },
    });

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, true);
    assert.equal(receipt.officialMainPid, 30001);
    assert.match(receipt.error ?? "", /live official version.*did not advance/i);
    assert.equal(receipt.terminalAt, NOW);
    assert.notEqual(receipt.terminalAt, priorTerminalAt);
    assert.equal(receipt.continuationAbandonedAt, null);
    assert.equal(receipt.completedAt, null);
    assert.equal(receipt.rolledBackAt, null);
    assert.deepEqual(calls, []);
  });
});

test("an active receipt refuses a concurrent start", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    writeDesktopUpdateReceipt(fixture.stateFile, {
      schemaVersion: 1,
      kind: "desktop-update",
      transactionId: "active",
      phase: "awaiting_native_update",
      ownerPid: 456,
      source: initial,
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: null,
      nativeUpdateHandoffAt: NOW,
      refreshSource: null,
      environmentTransactionId: "env-1",
      safeOfficialMode: true,
      resumable: false,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      rolledBackAt: null,
    });
    const { deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    await assert.rejects(() => transaction.start(), /awaiting_native_update.*resume or cancel/i);
  });
});

test("a resumable terminal receipt blocks a new start until it is resumed or cancelled", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    writeDesktopUpdateReceipt(fixture.stateFile, {
      schemaVersion: 1,
      kind: "desktop-update",
      transactionId: "timed-out",
      phase: "failed",
      ownerPid: 456,
      source: initial,
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: null,
      nativeUpdateHandoffAt: NOW,
      refreshSource: null,
      environmentTransactionId: "env-1",
      safeOfficialMode: true,
      resumable: true,
      error: "timed out",
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      rolledBackAt: null,
    });
    const { deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    await assert.rejects(() => transaction.start(), /resume or cancel/i);
  });
});

test("a lower observed build is rejected as a downgrade and never returns to Tweakers", async () => {
  await withFixture(async (fixture) => {
    const { calls, deps } = dependencies({
      waitForVersionChange: async () => ({ marketingVersion: "0.9.0", build: "90" }),
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.observed, null);
    assert.match(receipt.error ?? "", /did not advance/i);
    assert.deepEqual(calls, ["refresh-environment-truth", "prepare:chatgpt", "commit:chatgpt", "native-update-handoff"]);
  });
});

test("refresh failure rolls the return environment back to safe official mode", async () => {
  await withFixture(async (fixture) => {
    const { calls, deps } = dependencies({
      refreshTweakers: async () => { throw new Error("refresh failed"); },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "rolled_back");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, true);
    assert.match(receipt.error ?? "", /refresh failed/);
    assert.match(calls.at(-1) ?? "", /^rollback:env-2$/);
  });
});

test("cancel marks an awaiting transaction terminal without leaving temporary files", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    writeDesktopUpdateReceipt(fixture.stateFile, {
      schemaVersion: 1,
      kind: "desktop-update",
      transactionId: "active",
      phase: "awaiting_native_update",
      ownerPid: 456,
      source: initial,
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: null,
      nativeUpdateHandoffAt: NOW,
      refreshSource: null,
      environmentTransactionId: "env-1",
      safeOfficialMode: true,
      resumable: false,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      rolledBackAt: null,
    });
    chmodSync(fixture.stateFile, 0o644);
    const { deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.cancel();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, false);
    assert.match(receipt.error ?? "", /cancelled/i);
    assert.equal(receipt.terminalAt, NOW);
    assert.equal(receipt.continuationAbandonedAt, null);
    assert.equal(statSync(fixture.stateFile).mode & 0o777, 0o600);
    assert.equal(existsSync(`${fixture.stateFile}.${process.pid}.tmp`), false);
    assert.equal(JSON.parse(readFileSync(fixture.stateFile, "utf8")).transactionId, "active");
  });
});

test("a separate process may cancel an exact native-update wait while its owner is still alive", async () => {
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      transactionId: "live-native-wait",
      phase: "awaiting_native_update",
      ownerPid: 999,
      nativeUpdateHandoffAt: NOW,
      environmentTransactionId: "env-1",
      safeOfficialMode: true,
      resumable: true,
    }));
    const { deps } = dependencies({ processAlive: () => true });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.cancel();

    assert.equal(receipt.transactionId, "live-native-wait");
    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.ownerPid, process.pid);
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, false);
    assert.match(receipt.error ?? "", /cancelled/i);
  });
});

test("cancel abandons a failed continuation without overwriting its causal error", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    const causalError = "The official update did not complete before the timeout.";
    const causalUpdatedAt = "2026-07-15T11:00:00.000Z";
    writeDesktopUpdateReceipt(fixture.stateFile, {
      schemaVersion: 1,
      kind: "desktop-update",
      transactionId: "timed-out",
      phase: "failed",
      ownerPid: 456,
      source: initial,
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: null,
      nativeUpdateHandoffAt: NOW,
      refreshSource: null,
      environmentTransactionId: "env-1",
      safeOfficialMode: true,
      resumable: true,
      error: causalError,
      createdAt: causalUpdatedAt,
      updatedAt: causalUpdatedAt,
      completedAt: null,
      rolledBackAt: null,
    });
    const { deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.cancel();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, false);
    assert.equal(receipt.error, causalError);
    assert.equal(receipt.ownerPid, process.pid);
    assert.equal(receipt.terminalAt, causalUpdatedAt);
    assert.equal(receipt.continuationAbandonedAt, NOW);
    assert.equal(receipt.updatedAt, NOW);
  });
});

test("cancel abandons a rolled-back continuation without overwriting durable diagnostics", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    const causalError = "Commit failed: osascript failed (exit 1): launch rejected by taskgated";
    const causalTerminalAt = "2026-07-15T11:30:00.000Z";
    writeDesktopUpdateReceipt(fixture.stateFile, {
      schemaVersion: 1,
      kind: "desktop-update",
      transactionId: "rolled-back-relaunch",
      phase: "rolled_back",
      ownerPid: 456,
      source: initial,
      official: selection("chatgpt"),
      baseline: { marketingVersion: "1.0.0", build: "100" },
      observed: { marketingVersion: "1.1.0", build: "110" },
      nativeUpdateHandoffAt: NOW,
      refreshSource: null,
      environmentTransactionId: "env-return",
      safeOfficialMode: true,
      resumable: true,
      error: causalError,
      createdAt: causalTerminalAt,
      updatedAt: causalTerminalAt,
      terminalAt: causalTerminalAt,
      continuationAbandonedAt: null,
      completedAt: null,
      rolledBackAt: causalTerminalAt,
    });
    const { deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.cancel();

    assert.equal(receipt.phase, "rolled_back");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, false);
    assert.equal(receipt.error, causalError);
    assert.equal(receipt.terminalAt, causalTerminalAt);
    assert.equal(receipt.continuationAbandonedAt, NOW);
    assert.equal(receipt.rolledBackAt, causalTerminalAt);
    assert.equal(receipt.updatedAt, NOW);
    assert.equal(receipt.ownerPid, process.pid);
  });
});

test("owner-dead recovery cancels a preparing desktop update before any environment mutation", async () => {
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt());
    const { calls, deps } = dependencies();
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const recovered = await transaction.cancel();

    assert.equal(recovered.phase, "rolled_back");
    assert.equal(recovered.safeOfficialMode, false);
    assert.equal(recovered.resumable, false);
    assert.deepEqual(calls, []);
  });
});

test("owner-dead recovery cancels an orphaned prepared official switch before its ID was recorded", async () => {
  await withFixture(async (fixture) => {
    const calls: string[] = [];
    const initial = selection("tweakers");
    const official = selection("chatgpt");
    let environment = environmentReceipt("env-switch", initial, official, "prepared");
    const coordinator: EnvironmentCoordinator = {
      ...fakeCoordinator(calls),
      status: () => environment,
      cancel: async (id) => {
        assert.equal(id, "env-switch");
        calls.push(`cancel:${id}`);
        environment = environmentReceipt(id!, initial, official, "cancelled");
        return environment;
      },
    };
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "switching_to_chatgpt",
    }));
    const { deps } = dependencies({ environment: coordinator });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const recovered = await transaction.cancel();

    assert.equal(recovered.phase, "rolled_back");
    assert.equal(recovered.safeOfficialMode, false);
    assert.deepEqual(calls, ["cancel:env-switch"]);
  });
});

for (const phase of ["returning_to_tweakers", "refreshing_runtime", "verifying"] as const) {
  test(`owner-dead recovery rolls ${phase} back to safe official mode`, async () => {
    await withFixture(async (fixture) => {
      const calls: string[] = [];
      const initial = selection("tweakers");
      const official = selection("chatgpt");
      let environment = environmentReceipt("env-return", official, initial, "committed");
      const coordinator: EnvironmentCoordinator = {
        ...fakeCoordinator(calls),
        status: () => environment,
        rollback: async (id) => {
          assert.equal(id, "env-return");
          calls.push(`rollback:${id}`);
          environment = environmentReceipt(id!, official, initial, "rolled-back");
          return environment;
        },
      };
      writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
        phase,
        observed: { marketingVersion: "1.1.0", build: "110" },
        nativeUpdateHandoffAt: NOW,
        refreshSource: phase === "returning_to_tweakers" ? null : "development",
        environmentTransactionId: "env-return",
        safeOfficialMode: true,
      }));
      const { deps } = dependencies({ environment: coordinator });
      const transaction = createDesktopUpdateTransaction(fixture, deps);

      const recovered = await transaction.cancel();

      assert.equal(recovered.phase, "rolled_back");
      assert.equal(recovered.safeOfficialMode, true);
      assert.equal(recovered.resumable, true);
      assert.deepEqual(calls, ["rollback:env-return"]);
    });
  });
}

test("owner-dead return preparation failure remains safely resumable in proved official mode", async () => {
  await withFixture(async (fixture) => {
    const calls: string[] = [];
    const initial = selection("tweakers");
    const official = selection("chatgpt");
    const failedPreparation = {
      ...environmentReceipt("env-return-prepare", official, initial, "failed"),
      prepared: null,
      applied: null,
      attempt: 0,
      error: "Environment registry selected value does not match the current transition source",
    };
    const coordinator: EnvironmentCoordinator = {
      ...fakeCoordinator(calls),
      status: () => failedPreparation,
      rollback: async () => {
        calls.push("unexpected-rollback");
        return failedPreparation;
      },
    };
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "returning_to_tweakers",
      observed: { marketingVersion: "1.1.0", build: "110" },
      environmentTransactionId: "env-return-prepare",
      safeOfficialMode: true,
      resumable: false,
    }));
    const { deps } = dependencies({ environment: coordinator });

    const recovered = await createDesktopUpdateTransaction(fixture, deps).cancel();

    assert.equal(recovered.phase, "rolled_back");
    assert.equal(recovered.safeOfficialMode, true);
    assert.equal(recovered.resumable, true);
    assert.deepEqual(calls, []);
  });
});

test("owner-dead recovery preserves an unsafe blocker when environment rollback failed", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    const official = selection("chatgpt");
    const failedEnvironment = {
      ...environmentReceipt("env-return", initial, official, "failed"),
      error: "return failed; rollback failed: official app did not reopen",
    };
    const { deps } = dependencies({
      environment: {
        ...fakeCoordinator([]),
        status: () => failedEnvironment,
      },
    });
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "switching_to_chatgpt",
      environmentTransactionId: "env-return",
      safeOfficialMode: false,
    }));
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const recovered = await transaction.cancel();

    assert.equal(recovered.phase, "failed");
    assert.equal(recovered.safeOfficialMode, false);
    assert.equal(recovered.resumable, false);
    assert.match(recovered.error ?? "", /owner-dead recovery failed.*rollback failed/i);
    assert.throws(
      () => assertLifecycleReceiptsIdle(fixture.root, { contextOwned: false }),
      /failed during rollback.*explicit recovery/i,
    );
  });
});

test("owner-dead return recovery resumes after the environment proves pristine official mode without another swap", async () => {
  await withFixture(async (fixture) => {
    const calls: string[] = [];
    const initial = selection("tweakers");
    const official = selection("chatgpt");
    const failedEnvironment = {
      ...environmentReceipt("env-return", official, initial, "failed"),
      attempt: 0,
      error: "Commit failed: staged native host identity mismatch; rollback failed: no staged host",
    };
    const recoveredEnvironment = {
      ...failedEnvironment,
      phase: "cancelled" as const,
      applied: {
        observedAt: NOW,
        selection: official,
        desktopVersion: "1.1.0",
        desktopBuild: "110",
        backendVersion: "0.145.0-alpha.18",
        desktopArtifactDigest: "official-desktop",
        backendArtifactDigest: "official-backend",
      },
      newMainPid: 202,
      cancelledAt: NOW,
      error: `Recovered safely without replacing the app. Previous failure: ${failedEnvironment.error}`,
    };
    const { deps } = dependencies({
      environment: {
        ...fakeCoordinator(calls),
        status: () => failedEnvironment,
        rollback: async (id) => {
          assert.equal(id, "env-return");
          calls.push(`prove-source:${id}`);
          return recoveredEnvironment;
        },
      },
      recoverVerifiedOfficialUpdate: async () => {
        calls.push("unexpected-adoption");
        return null;
      },
    });
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      observed: { marketingVersion: "1.1.0", build: "110" },
      environmentTransactionId: "env-return",
      safeOfficialMode: false,
      resumable: false,
      error: failedEnvironment.error,
    }));

    const recovered = await createDesktopUpdateTransaction(fixture, deps).cancel();

    assert.equal(recovered.phase, "rolled_back");
    assert.equal(recovered.safeOfficialMode, true);
    assert.equal(recovered.resumable, true);
    assert.match(recovered.error ?? "", /recovered to safe official mode/i);
    assert.deepEqual(calls, ["prove-source:env-return"]);
  });
});

test("owner-dead recovery adopts a separately verified official update after rollback failed", async () => {
  await withFixture(async (fixture) => {
    const calls: string[] = [];
    const initial = selection("tweakers");
    const official = selection("chatgpt");
    const failedEnvironment = {
      ...environmentReceipt("env-return", initial, official, "failed"),
      error: "return failed; rollback failed: official app did not reopen",
    };
    const recoveredSelection = {
      ...official,
      appliedAt: NOW,
    };
    const { deps } = dependencies({
      environment: {
        ...fakeCoordinator(calls),
        status: () => failedEnvironment,
        rollback: async () => {
          calls.push("unexpected-rollback");
          return failedEnvironment;
        },
      },
      recoverVerifiedOfficialUpdate: async ({ receipt, environmentReceipt: failed }) => {
        assert.equal(receipt.transactionId, "desktop-recovery");
        assert.equal(failed.transactionId, "env-return");
        calls.push("adopt-verified-official");
        return {
          observed: { marketingVersion: "1.1.0", build: "110" },
          selection: recoveredSelection,
          mainPid: 101,
        };
      },
    });
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "switching_to_chatgpt",
      environmentTransactionId: "env-return",
      safeOfficialMode: false,
    }));
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const recovered = await transaction.cancel();

    assert.equal(recovered.phase, "completed");
    assert.equal(recovered.safeOfficialMode, false);
    assert.equal(recovered.resumable, false);
    assert.equal(recovered.error, null);
    assert.equal(recovered.completedAt, NOW);
    assert.equal(recovered.officialMainPid, 101);
    assert.deepEqual(recovered.observed, { marketingVersion: "1.1.0", build: "110" });
    assert.deepEqual(recovered.official, recoveredSelection);
    assert.deepEqual(calls, ["adopt-verified-official"]);
  });
});

test("owner-dead recovery idempotently completes after the environment adoption commit point", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    const official = selection("chatgpt");
    const recoveredEnvironment = {
      ...environmentReceipt("env-return", initial, official, "cancelled"),
      error: "Recovered by adopting the verified live official ChatGPT update. Previous failure: rollback failed",
      cancelledAt: NOW,
    };
    let adoptionCalls = 0;
    const { deps } = dependencies({
      environment: {
        ...fakeCoordinator([]),
        status: () => recoveredEnvironment,
      },
      recoverVerifiedOfficialUpdate: async () => {
        adoptionCalls += 1;
        return {
          observed: { marketingVersion: "1.1.0", build: "110" },
          selection: { ...official, appliedAt: NOW },
          mainPid: 101,
        };
      },
    });
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "switching_to_chatgpt",
      environmentTransactionId: "env-return",
      safeOfficialMode: false,
    }));

    const recovered = await createDesktopUpdateTransaction(fixture, deps).cancel();

    assert.equal(adoptionCalls, 1);
    assert.equal(recovered.phase, "completed");
    assert.equal(recovered.error, null);
    assert.deepEqual(recovered.observed, { marketingVersion: "1.1.0", build: "110" });
  });
});

test("owner-dead recovery refuses to adopt while the environment owner is alive", async () => {
  await withFixture(async (fixture) => {
    const initial = selection("tweakers");
    const official = selection("chatgpt");
    const failedEnvironment = {
      ...environmentReceipt("env-return", initial, official, "failed"),
      ownerPid: 888,
      error: "return failed; rollback failed: official app did not reopen",
    };
    let adoptionCalls = 0;
    const { deps } = dependencies({
      environment: {
        ...fakeCoordinator([]),
        status: () => failedEnvironment,
      },
      processAlive: (pid) => pid === 888,
      recoverVerifiedOfficialUpdate: async () => {
        adoptionCalls += 1;
        return null;
      },
    });
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "switching_to_chatgpt",
      environmentTransactionId: "env-return",
      safeOfficialMode: false,
    }));

    const recovered = await createDesktopUpdateTransaction(fixture, deps).cancel();

    assert.equal(adoptionCalls, 0);
    assert.equal(recovered.phase, "failed");
    assert.match(recovered.error ?? "", /environment transaction owner PID 888 is still active/);
  });
});

test("owner-dead rollback recovery holds the shared lifecycle lease", async () => {
  await withFixture(async (fixture) => {
    let announceRollback!: () => void;
    let releaseRollback!: () => void;
    const rollbackStarted = new Promise<void>((resolve) => { announceRollback = resolve; });
    const rollbackGate = new Promise<void>((resolve) => { releaseRollback = resolve; });
    const initial = selection("tweakers");
    const official = selection("chatgpt");
    let environment = environmentReceipt("env-return", official, initial, "committed");
    const coordinator: EnvironmentCoordinator = {
      ...fakeCoordinator([]),
      status: () => environment,
      rollback: async (id) => {
        announceRollback();
        await rollbackGate;
        environment = environmentReceipt(id!, official, initial, "rolled-back");
        return environment;
      },
    };
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "returning_to_tweakers",
      observed: { marketingVersion: "1.1.0", build: "110" },
      environmentTransactionId: "env-return",
      safeOfficialMode: true,
    }));
    const { deps } = dependencies({ environment: coordinator });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const pending = transaction.cancel();
    await rollbackStarted;
    await assert.rejects(
      withLifecycleLock(lifecycleLockFile(fixture.root), "competing refresh", async () => undefined),
      /Another Tweakers lifecycle operation is active/,
    );
    releaseRollback();
    assert.equal((await pending).phase, "rolled_back");
  });
});

test("owner-dead recovery refuses every non-resumable phase while its different owner is alive", async () => {
  for (const phase of ["preparing", "switching_to_chatgpt", "returning_to_tweakers", "refreshing_runtime", "verifying"] as const) {
    await withFixture(async (fixture) => {
      writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({ phase }));
      const { deps } = dependencies({ processAlive: () => true });
      const transaction = createDesktopUpdateTransaction(fixture, deps);

      await assert.rejects(() => transaction.cancel(), /owner PID 999 is still active/i);
      assert.equal(transaction.status()?.phase, phase);
    });
  }
});

test("native updater handoff failure remains safe and resumable in official mode", async () => {
  await withFixture(async (fixture) => {
    const { calls, deps } = dependencies({
      initiateNativeUpdate: async () => {
        calls.push("native-update-handoff");
        throw new Error("native updater unavailable");
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, true);
    assert.equal(receipt.nativeUpdateHandoffAt, null);
    assert.match(receipt.error ?? "", /native updater unavailable/i);
    assert.deepEqual(calls, ["refresh-environment-truth", "prepare:chatgpt", "commit:chatgpt", "native-update-handoff"]);
  });
});

test("a click-level handoff failure keeps awaiting the native update and completes when the version advances", async () => {
  await withFixture(async (fixture) => {
    const { calls, deps } = dependencies({
      initiateNativeUpdate: async () => {
        calls.push("native-update-handoff");
        return {
          ok: false as const,
          kind: "menu_item_not_found" as const,
          message: "ChatGPT's native update menu item could not be found.",
          permissionGuidance: null,
        };
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "completed");
    assert.equal(receipt.error, null);
    assert.equal(receipt.nativeUpdateHandoffAt, null);
    assert.deepEqual(calls, [
      "refresh-environment-truth",
      "prepare:chatgpt",
      "commit:chatgpt",
      "native-update-handoff",
      "refresh-environment-truth",
      "prepare:tweakers",
      "commit:tweakers",
      "refresh:development",
    ]);
  });
});

test("a dead official PID during handoff still completes via the version wait (Sparkle relaunch)", async () => {
  await withFixture(async (fixture) => {
    const { deps } = dependencies({
      initiateNativeUpdate: async () => ({
        ok: false as const,
        kind: "process_not_proven" as const,
        message: "The exact ChatGPT process 9754 could not be proven at /Applications/ChatGPT.app.",
        permissionGuidance: null,
      }),
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "completed");
    assert.equal(receipt.error, null);
  });
});

test("an unsupported-platform handoff failure fails terminal, safe, and resumable", async () => {
  await withFixture(async (fixture) => {
    const { deps } = dependencies({
      initiateNativeUpdate: async () => ({
        ok: false as const,
        kind: "unsupported_platform" as const,
        message: "OpenAI's native desktop updater is available only on macOS.",
        permissionGuidance: null,
      }),
      waitForVersionChange: async () => {
        throw new Error("must not wait on an unsupported platform");
      },
    });
    const transaction = createDesktopUpdateTransaction(fixture, deps);

    const receipt = await transaction.start();

    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.safeOfficialMode, true);
    assert.equal(receipt.resumable, true);
    assert.match(receipt.error ?? "", /available only on macOS/i);
  });
});

test("resume relaunches a closed official app before verifying, then returns to Tweakers", async () => {
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      officialMainPid: 82156,
      safeOfficialMode: true,
      resumable: true,
      error: "Native updater handoff failed for stale PID 82156",
    }));
    let inspectCalls = 0;
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => {
        inspectCalls += 1;
        if (inspectCalls === 1) {
          throw new Error("The exact official ChatGPT process could not be proven at /Applications/ChatGPT.app");
        }
        return {
          version: { marketingVersion: "1.1.0", build: "110" },
          mainPid: 26138,
        };
      },
    });
    const transaction = createDesktopUpdateTransaction(
      { ...fixture, resumeLaunchWaitMs: 2_000, pollIntervalMs: 5 },
      deps,
    );

    const receipt = await transaction.resume();

    assert.equal(receipt.phase, "completed");
    assert.deepEqual(receipt.observed, { marketingVersion: "1.1.0", build: "110" });
    assert.equal(receipt.officialMainPid, 26138);
    assert.equal(calls[0], "launch-official-desktop");
    assert.ok(inspectCalls >= 2);
  });
});

test("resume does not relaunch when the live desktop fails a disk-level proof", async () => {
  await withFixture(async (fixture) => {
    writeDesktopUpdateReceipt(fixture.stateFile, persistedReceipt({
      phase: "failed",
      source: selection("tweakers"),
      official: selection("chatgpt"),
      officialMainPid: 82156,
      safeOfficialMode: true,
      resumable: true,
      error: "Native updater handoff failed for stale PID 82156",
    }));
    const { calls, deps } = dependencies({
      inspectLiveOfficialDesktop: async () => {
        throw new Error("The live desktop at /Applications/ChatGPT.app is not pristine ChatGPT");
      },
    });

    const receipt = await createDesktopUpdateTransaction(fixture, deps).resume();

    assert.equal(receipt.phase, "failed");
    assert.match(receipt.error ?? "", /not pristine/i);
    assert.deepEqual(calls, []);
  });
});
