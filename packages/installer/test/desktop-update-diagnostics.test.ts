import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectDesktopUpdateDiagnostics,
  DESKTOP_UPDATE_DIAGNOSTIC_STALE_MS,
} from "../src/desktop-update-diagnostics";
import {
  writeDesktopUpdateReceipt,
  type DesktopUpdateReceipt,
} from "../src/desktop-update-transaction";
import {
  createEnvironmentSelection,
  defaultEnvironmentProfileRegistry,
  resolveEnvironmentProfile,
} from "../src/environment-profile";
import { userPaths } from "../src/paths";

const NOW = "2026-07-19T12:00:00.000Z";

test("desktop update diagnostics name every durable path and return a bounded redacted log tail", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-desktop-diagnostics-"));
  const previous = process.env.TWEAKERS_HOME;
  process.env.TWEAKERS_HOME = root;
  try {
    const paths = userPaths();
    assert.equal(paths.desktopUpdateReceiptFile, join(root, "transactions", "desktop-update.json"));
    assert.equal(paths.desktopUpdateArchiveRoot, join(root, "transactions", "desktop-update"));
    assert.equal(paths.desktopUpdateHeartbeatFile, join(root, "transactions", "desktop-update.heartbeat.json"));
    assert.equal(paths.desktopUpdateLogFile, join(root, "log", "desktop-update.log"));

    mkdirSync(paths.logDir, { recursive: true });
    writeFileSync(
      paths.desktopUpdateLogFile,
      [
        `{"event":"old","path":"${root}/old"}`,
        `{"event":"one","path":"${root}/one"}`,
        `{"event":"two","path":"/Users/example/two"}`,
        "",
      ].join("\n"),
    );
    const diagnostics = collectDesktopUpdateDiagnostics(paths, {
      maxTailBytes: 4_096,
      maxTailLines: 2,
      homeDir: "/Users/example",
    });

    assert.equal(diagnostics.receipt, null);
    assert.deepEqual(diagnostics.logTail, [
      '{"event":"one","path":"[user-root]/one"}',
      '{"event":"two","path":"[home]/two"}',
    ]);
  } finally {
    if (previous === undefined) delete process.env.TWEAKERS_HOME;
    else process.env.TWEAKERS_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop update diagnostics expose blocking, stale, and unsafe receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-desktop-diagnostics-"));
  try {
    const receiptFile = join(root, "transactions", "desktop-update.json");
    writeDesktopUpdateReceipt(receiptFile, receipt({
      phase: "failed",
      safeOfficialMode: false,
      resumable: false,
      error: "rollback failed",
      updatedAt: NOW,
    }));

    const diagnostics = collectDesktopUpdateDiagnostics({ root, desktopUpdateReceiptFile: receiptFile }, {
      nowMs: Date.parse(NOW) + DESKTOP_UPDATE_DIAGNOSTIC_STALE_MS + 1,
    });

    assert.equal(diagnostics.blocking, true);
    assert.equal(diagnostics.stale, true);
    assert.equal(diagnostics.unsafe, true);
    assert.equal(diagnostics.receipt?.phase, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid desktop receipt is itself an unsafe blocking diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-desktop-diagnostics-"));
  try {
    const receiptFile = join(root, "transactions", "desktop-update.json");
    mkdirSync(join(root, "transactions"), { recursive: true });
    writeFileSync(receiptFile, "{\"phase\":\"surprise\"}\n");

    const diagnostics = collectDesktopUpdateDiagnostics({ root, desktopUpdateReceiptFile: receiptFile });

    assert.equal(diagnostics.receipt, null);
    assert.match(diagnostics.receiptError ?? "", /invalid/);
    assert.equal(diagnostics.blocking, true);
    assert.equal(diagnostics.unsafe, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function receipt(overrides: Partial<DesktopUpdateReceipt>): DesktopUpdateReceipt {
  const profile = resolveEnvironmentProfile(defaultEnvironmentProfileRegistry(), "stable");
  const source = createEnvironmentSelection({
    profile,
    appExperience: "tweakers",
    requestedAt: NOW,
    appliedAt: NOW,
  });
  const official = createEnvironmentSelection({
    profile,
    appExperience: "chatgpt",
    requestedAt: NOW,
    appliedAt: NOW,
  });
  return {
    schemaVersion: 1,
    kind: "desktop-update",
    transactionId: "diagnostic-transaction",
    phase: "awaiting_native_update",
    ownerPid: 123,
    ownerToken: "owner-token",
    ownerGeneration: "owner-generation",
    source,
    official,
    baseline: { marketingVersion: "1.0.0", build: "100" },
    observed: null,
    nativeUpdateHandoffAt: NOW,
    refreshSource: null,
    environmentTransactionId: "environment-transaction",
    officialMainPid: 456,
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
