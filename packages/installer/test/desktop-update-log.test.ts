import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendDesktopUpdateLog,
  appendLifecycleAuditRecord,
  DESKTOP_UPDATE_LOG_SCHEMA_VERSION,
} from "../src/desktop-update-log";

const NOW = "2026-07-19T12:00:00.000Z";

test("desktop update events are persisted as private redacted JSONL", () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-desktop-update-log-"));
  const logPath = join(fixture, "log", "desktop-update.log");
  const homeDir = join(fixture, "Users", "owner");
  const userRoot = join(homeDir, "Library", "Application Support", "Tweakers");

  try {
    appendDesktopUpdateLog(logPath, {
      transactionId: "desktop-1",
      phase: "awaiting_native_update",
      ownerPid: 1234,
      ownerToken: "process-start-1",
      ownerGeneration: "generation-1",
      event: "owner_started",
      error: new Error(`handoff failed in ${userRoot}/transactions and ${homeDir}/Downloads`),
      jobLabel: `co.tweakers.desktop-update.${userRoot}`,
    }, {
      now: () => NOW,
      userRoot,
      homeDir,
      maxErrorChars: 96,
    });

    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    const persisted = readFileSync(logPath, "utf8");
    assert.equal(persisted.endsWith("\n"), true);
    assert.equal(persisted.includes(userRoot), false);
    assert.equal(persisted.includes(homeDir), false);

    const record = JSON.parse(persisted);
    assert.deepEqual(record, {
      schemaVersion: DESKTOP_UPDATE_LOG_SCHEMA_VERSION,
      ts: NOW,
      transactionId: "desktop-1",
      phase: "awaiting_native_update",
      ownerPid: 1234,
      ownerToken: "process-start-1",
      ownerGeneration: "generation-1",
      event: "owner_started",
      error: "Error: handoff failed in [user-root]/transactions and [home]/Downloads",
      jobLabel: "co.tweakers.desktop-update.[user-root]",
    });
    assert.ok(record.error.length <= 96);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("desktop update log rotation retains a bounded tail and a complete newest event", () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-desktop-update-log-"));
  const logPath = join(fixture, "desktop-update.log");
  const maxBytes = 420;
  const oldLine = `${JSON.stringify({ sequence: 1, payload: "x".repeat(240) })}\n`;

  try {
    writeFileSync(logPath, oldLine.repeat(2), { mode: 0o600 });
    appendDesktopUpdateLog(logPath, {
      transactionId: "desktop-rotation",
      phase: "completed",
      ownerPid: 5678,
      ownerToken: null,
      ownerGeneration: null,
      event: "owner_completed",
    }, {
      now: () => NOW,
      homeDir: fixture,
      maxBytes,
    });

    const rotated = readFileSync(logPath);
    assert.ok(rotated.byteLength <= maxBytes);
    const lines = rotated.toString("utf8").trimEnd().split("\n");
    assert.throws(() => JSON.parse(lines[0]!));
    assert.deepEqual(JSON.parse(lines.at(-1)!), {
      schemaVersion: DESKTOP_UPDATE_LOG_SCHEMA_VERSION,
      ts: NOW,
      transactionId: "desktop-rotation",
      phase: "completed",
      ownerPid: 5678,
      ownerToken: null,
      ownerGeneration: null,
      event: "owner_completed",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("lifecycle audit records persist approvals outside a live transaction and never throw", () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-desktop-update-log-"));
  const logPath = join(fixture, "log", "desktop-update.log");

  try {
    appendLifecycleAuditRecord(logPath, {
      event: "user_approval",
      action: "mode-switch:tweakers",
      detail: "Mode switch to tweakers approved via confirmation dialog",
    }, { now: () => NOW, homeDir: fixture });

    const record = JSON.parse(readFileSync(logPath, "utf8").trimEnd());
    assert.equal(record.event, "user_approval");
    assert.equal(record.phase, "none");
    assert.equal(record.transactionId, "mode-switch:tweakers");
    assert.equal(record.detail, "Mode switch to tweakers approved via confirmation dialog");

    appendLifecycleAuditRecord(logPath, {
      event: "manual_recovery",
      action: "manual-finalize",
      transactionId: "env-1",
      detail: "Environment receipt finalized manually",
    }, { now: () => NOW, homeDir: fixture });
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    assert.equal(JSON.parse(lines.at(-1)!).event, "manual_recovery");
    assert.equal(JSON.parse(lines.at(-1)!).transactionId, "env-1");

    // A denied log path must not fail the action being audited.
    assert.doesNotThrow(() => appendLifecycleAuditRecord("/dev/null/impossible/audit.log", {
      event: "user_approval",
      action: "mode-switch:chatgpt",
      detail: "unwritable log path",
    }));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
