import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEnvironmentSelection,
  defaultEnvironmentProfileRegistry,
  resolveEnvironmentProfile,
  type EnvironmentSelection,
} from "../src/environment-profile";
import type { EnvironmentTransactionReceipt } from "../src/environment-transaction";
import type { DesktopUpdateReceipt } from "../src/desktop-update-transaction";
import { desktopReceiptBlocksLifecycle } from "../src/desktop-update-state";
import {
  assertLifecycleReceiptsIdle,
  lifecycleLockFile,
  withLifecycleLock,
} from "../src/lifecycle-lock";

const NOW = "2026-07-17T12:00:00.000Z";

function selection(appExperience: "chatgpt" | "tweakers"): EnvironmentSelection {
  return createEnvironmentSelection({
    profile: resolveEnvironmentProfile(defaultEnvironmentProfileRegistry(), "stable"),
    appExperience,
    requestedAt: NOW,
    appliedAt: NOW,
  });
}

function environmentReceipt(
  overrides: Partial<EnvironmentTransactionReceipt> = {},
): EnvironmentTransactionReceipt {
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId: "environment-1",
    phase: "failed",
    error: null,
    ownerPid: 123,
    source: selection("tweakers"),
    requested: selection("chatgpt"),
    prepared: null,
    applied: null,
    oldMainPid: 100,
    newMainPid: null,
    attempt: 0,
    createdAt: NOW,
    updatedAt: NOW,
    committedAt: null,
    rolledBackAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function desktopReceipt(overrides: Partial<DesktopUpdateReceipt> = {}): DesktopUpdateReceipt {
  return {
    schemaVersion: 1,
    kind: "desktop-update",
    transactionId: "desktop-1",
    phase: "failed",
    ownerPid: 123,
    source: selection("tweakers"),
    official: selection("chatgpt"),
    baseline: { marketingVersion: "1.0.0", build: "100" },
    observed: null,
    nativeUpdateHandoffAt: null,
    refreshSource: null,
    environmentTransactionId: null,
    officialMainPid: null,
    safeOfficialMode: true,
    resumable: false,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    rolledBackAt: null,
    ...overrides,
  };
}

test("one desktop receipt table drives lifecycle blocking", () => {
  const cases: Array<{
    name: string;
    receipt: DesktopUpdateReceipt;
    blocks: boolean;
  }> = [
    {
      name: "active phase",
      receipt: desktopReceipt({ phase: "awaiting_native_update", resumable: true }),
      blocks: true,
    },
    {
      name: "completed",
      receipt: desktopReceipt({ phase: "completed", safeOfficialMode: false }),
      blocks: false,
    },
    {
      name: "resumable rollback",
      receipt: desktopReceipt({ phase: "rolled_back", resumable: true }),
      blocks: true,
    },
    {
      name: "terminal rollback",
      receipt: desktopReceipt({ phase: "rolled_back", resumable: false }),
      blocks: false,
    },
    {
      name: "safe terminal cancellation",
      receipt: desktopReceipt({ phase: "failed", safeOfficialMode: true, resumable: false }),
      blocks: false,
    },
    {
      name: "unsafe failure",
      receipt: desktopReceipt({ phase: "failed", safeOfficialMode: false, resumable: false }),
      blocks: true,
    },
    {
      name: "rollback failure",
      receipt: desktopReceipt({
        phase: "failed",
        safeOfficialMode: true,
        resumable: false,
        error: "refresh failed; rollback failed: app reopen failed",
      }),
      blocks: true,
    },
  ];

  for (const entry of cases) {
    assert.equal(desktopReceiptBlocksLifecycle(entry.receipt), entry.blocks, entry.name);
  }
});

test("one lifecycle lock excludes unrelated same-process work while allowing nested owned work", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-lifecycle-lock-"));
  const file = lifecycleLockFile(root);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  try {
    const first = withLifecycleLock(file, "first", async () => {
      entered = true;
      await withLifecycleLock(file, "nested", async () => undefined);
      await paused;
      return "done";
    });
    while (!entered) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      withLifecycleLock(file, "second", async () => undefined),
      /Another Tweakers lifecycle operation is active/,
    );
    release();
    assert.equal(await first, "done");
  } finally {
    release?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable environment and resumable desktop receipts block other lifecycle owners", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-lifecycle-receipts-"));
  const transactions = join(root, "transactions");
  mkdirSync(transactions, { recursive: true });
  try {
    writeFileSync(join(transactions, "environment.json"), JSON.stringify(environmentReceipt({
      phase: "preparing",
    })));
    assert.throws(() => assertLifecycleReceiptsIdle(root, { contextOwned: false }), /environment-1.*preparing/i);

    writeFileSync(join(transactions, "environment.json"), JSON.stringify(environmentReceipt()));
    writeFileSync(join(transactions, "desktop-update.json"), JSON.stringify(desktopReceipt({ resumable: true })));
    assert.throws(() => assertLifecycleReceiptsIdle(root, { contextOwned: false }), /desktop-1.*failed/i);
    assert.doesNotThrow(() => assertLifecycleReceiptsIdle(root, {
      contextOwned: false,
      desktopTransactionId: "desktop-1",
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active desktop update context may nest its environment coordinator", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-lifecycle-desktop-nesting-"));
  const transactions = join(root, "transactions");
  mkdirSync(transactions, { recursive: true });
  try {
    writeFileSync(join(transactions, "desktop-update.json"), JSON.stringify(desktopReceipt({
      phase: "switching_to_chatgpt",
      ownerPid: process.pid,
    })));

    assert.throws(
      () => assertLifecycleReceiptsIdle(root),
      /desktop-1.*switching_to_chatgpt/i,
    );
    await withLifecycleLock(lifecycleLockFile(root), "desktop update", async () => {
      assert.doesNotThrow(() => assertLifecycleReceiptsIdle(root));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe failed desktop receipts remain blocking until explicit recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-lifecycle-desktop-failure-"));
  const transactions = join(root, "transactions");
  const desktopFile = join(transactions, "desktop-update.json");
  mkdirSync(transactions, { recursive: true });
  try {
    const unsafeFailures: Array<{
      receipt: DesktopUpdateReceipt;
      expected: RegExp;
    }> = [
      {
        receipt: desktopReceipt({
          transactionId: "desktop-unsafe-mode",
          safeOfficialMode: false,
          error: "return verification failed",
        }),
        expected: /desktop-unsafe-mode.*without confirmed safe official mode.*explicit recovery/i,
      },
      {
        receipt: desktopReceipt({
          transactionId: "desktop-rollback-failed",
          error: "refresh failed; rollback failed: official app could not be reopened",
        }),
        expected: /desktop-rollback-failed.*failed during rollback.*explicit recovery/i,
      },
    ];

    for (const { receipt, expected } of unsafeFailures) {
      writeFileSync(desktopFile, JSON.stringify(receipt));
      assert.throws(
        () => assertLifecycleReceiptsIdle(root, { contextOwned: false }),
        expected,
      );
      assert.doesNotThrow(() => assertLifecycleReceiptsIdle(root, {
        contextOwned: false,
        desktopTransactionId: receipt.transactionId,
      }));
    }

    writeFileSync(desktopFile, JSON.stringify(desktopReceipt({
      transactionId: "desktop-safe-cancel",
      error: "cancelled while official mode remained active",
    })));
    assert.doesNotThrow(() => assertLifecycleReceiptsIdle(root, { contextOwned: false }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owning the environment transaction recorded by a blocked desktop receipt crosses both gates", () => {
  // Live 2026-08-07 deadlock: desktop failed+resumable while its own
  // environment transaction failed mid-rollback. Recovering exactly that
  // environment transaction is a prerequisite of the desktop receipt's own
  // continuation and must not be blocked by it.
  const root = mkdtempSync(join(tmpdir(), "tweaker-lifecycle-coupled-"));
  const transactions = join(root, "transactions");
  mkdirSync(transactions, { recursive: true });
  try {
    writeFileSync(join(transactions, "environment.json"), JSON.stringify(environmentReceipt({
      transactionId: "env-return",
      error: "Rollback requested; rollback failed: watcher promotion race",
    })));
    writeFileSync(join(transactions, "desktop-update.json"), JSON.stringify(desktopReceipt({
      resumable: true,
      environmentTransactionId: "env-return",
    })));

    // Unrelated work stays blocked by both receipts.
    assert.throws(
      () => assertLifecycleReceiptsIdle(root, { contextOwned: false }),
      /env-return.*failed during rollback/i,
    );
    // Recovery of the coupled environment transaction crosses the environment
    // gate by id and the desktop gate by coupling.
    assert.doesNotThrow(() => assertLifecycleReceiptsIdle(root, {
      contextOwned: false,
      environmentTransactionId: "env-return",
      environmentRecovery: true,
    }));
    // The same coupled ownership WITHOUT the recovery flag stays blocked:
    // forward mutations (commit/rollback) of a coupled transaction must not
    // cut over or swap bytes outside the desktop update's supervision.
    assert.throws(
      () => assertLifecycleReceiptsIdle(root, {
        contextOwned: false,
        environmentTransactionId: "env-return",
      }),
      /desktop-1.*resume or cancel/i,
    );

    // An IDLE coupled environment receipt (terminal, nothing to recover) must
    // not open the desktop gate either, even for recovery.
    writeFileSync(join(transactions, "environment.json"), JSON.stringify(environmentReceipt({
      transactionId: "env-return",
      error: "refresh failed before any rollback was needed",
    })));
    assert.throws(
      () => assertLifecycleReceiptsIdle(root, {
        contextOwned: false,
        environmentTransactionId: "env-return",
        environmentRecovery: true,
      }),
      /desktop-1.*resume or cancel/i,
    );

    // A desktop receipt recording a DIFFERENT environment transaction still
    // blocks: the caller's transaction is unrelated to that receipt.
    writeFileSync(join(transactions, "environment.json"), JSON.stringify(environmentReceipt({
      transactionId: "env-other",
      error: "Rollback requested; rollback failed: watcher promotion race",
    })));
    writeFileSync(join(transactions, "desktop-update.json"), JSON.stringify(desktopReceipt({
      resumable: true,
      environmentTransactionId: null,
    })));
    assert.throws(
      () => assertLifecycleReceiptsIdle(root, {
        contextOwned: false,
        environmentTransactionId: "env-other",
        environmentRecovery: true,
      }),
      /desktop-1.*resume or cancel/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and unknown terminal receipts fail closed before lifecycle classification", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-lifecycle-invalid-receipts-"));
  const transactions = join(root, "transactions");
  const environmentFile = join(transactions, "environment.json");
  const desktopFile = join(transactions, "desktop-update.json");
  mkdirSync(transactions, { recursive: true });
  try {
    writeFileSync(environmentFile, JSON.stringify({ transactionId: "malformed-environment", phase: "failed" }));
    assert.throws(
      () => assertLifecycleReceiptsIdle(root, { contextOwned: false }),
      /environment transaction receipt is invalid/i,
    );

    writeFileSync(environmentFile, JSON.stringify(environmentReceipt()));
    writeFileSync(desktopFile, JSON.stringify({ transactionId: "malformed-desktop", phase: "completed" }));
    assert.throws(
      () => assertLifecycleReceiptsIdle(root, { contextOwned: false }),
      /desktop update receipt is invalid/i,
    );

    writeFileSync(desktopFile, JSON.stringify({ ...desktopReceipt(), phase: "unknown-terminal" }));
    assert.throws(
      () => assertLifecycleReceiptsIdle(root, { contextOwned: false }),
      /desktop update receipt is invalid/i,
    );

    writeFileSync(desktopFile, JSON.stringify(desktopReceipt()));
    writeFileSync(environmentFile, JSON.stringify({ ...environmentReceipt(), phase: "unknown-terminal" }));
    assert.throws(
      () => assertLifecycleReceiptsIdle(root, { contextOwned: false }),
      /environment transaction receipt is invalid/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment rollback failures stay blocking, but the owning transaction can recover", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-lifecycle-rollback-failure-"));
  const transactions = join(root, "transactions");
  mkdirSync(transactions, { recursive: true });
  try {
    writeFileSync(join(transactions, "environment.json"), JSON.stringify(environmentReceipt({
      transactionId: "environment-rollback-failed",
      error: "Commit failed; rollback failed: source app could not be reopened",
    })));

    assert.throws(
      () => assertLifecycleReceiptsIdle(root, { contextOwned: false }),
      /environment-rollback-failed.*failed during rollback.*explicit recovery/i,
    );

    await withLifecycleLock(lifecycleLockFile(root), "environment transaction", async () => {
      assert.throws(
        () => assertLifecycleReceiptsIdle(root),
        /environment-rollback-failed.*failed during rollback.*explicit recovery/i,
      );
      assert.doesNotThrow(() => assertLifecycleReceiptsIdle(root, {
        environmentTransactionId: "environment-rollback-failed",
      }));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
