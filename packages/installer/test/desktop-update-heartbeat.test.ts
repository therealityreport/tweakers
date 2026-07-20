import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  desktopUpdateOwnerIsLive,
  readDesktopUpdateHeartbeat,
  removeDesktopUpdateHeartbeat,
  writeDesktopUpdateHeartbeat,
  type DesktopUpdateHeartbeat,
} from "../src/desktop-update-heartbeat";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");

function heartbeat(overrides: Partial<DesktopUpdateHeartbeat> = {}): DesktopUpdateHeartbeat {
  return {
    schemaVersion: 1,
    transactionId: "desktop-1",
    ownerPid: 123,
    ownerToken: "started-1",
    ownerGeneration: "generation-1",
    phase: "awaiting_native_update",
    beatAt: new Date(NOW - 1_000).toISOString(),
    ...overrides,
  };
}

test("heartbeat publication is private, atomic, and removable", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-desktop-heartbeat-"));
  const file = join(root, "transactions", "desktop-update.heartbeat.json");
  try {
    writeDesktopUpdateHeartbeat(file, heartbeat());
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readDesktopUpdateHeartbeat(file), heartbeat());
    assert.match(readFileSync(file, "utf8"), /"ownerGeneration":"generation-1"/);

    chmodSync(file, 0o644);
    writeDesktopUpdateHeartbeat(file, heartbeat({ beatAt: new Date(NOW).toISOString() }));
    assert.equal(statSync(file).mode & 0o777, 0o600);

    removeDesktopUpdateHeartbeat(file);
    assert.equal(readDesktopUpdateHeartbeat(file), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new owners require exact process identity and a fresh matching heartbeat after grace", () => {
  const receipt = {
    transactionId: "desktop-1",
    phase: "awaiting_native_update",
    ownerPid: 123,
    ownerToken: "started-1",
    ownerGeneration: "generation-1",
    updatedAt: new Date(NOW - 120_000).toISOString(),
  };
  const base = {
    receipt,
    heartbeat: heartbeat(),
    nowMs: NOW,
    processAlive: () => true,
    readProcessStartToken: () => "started-1",
  };

  assert.equal(desktopUpdateOwnerIsLive(base), true);
  assert.equal(desktopUpdateOwnerIsLive({
    ...base,
    heartbeat: heartbeat({ transactionId: "other" }),
  }), false);
  assert.equal(desktopUpdateOwnerIsLive({
    ...base,
    heartbeat: heartbeat({ beatAt: new Date(NOW + 10_000).toISOString() }),
  }), false);
  assert.equal(desktopUpdateOwnerIsLive({
    ...base,
    readProcessStartToken: () => "reused-pid",
  }), false);
  assert.equal(desktopUpdateOwnerIsLive({
    ...base,
    processAlive: () => false,
  }), false);
});

test("missing or corrupt heartbeat receives one receipt-time grace window", () => {
  const receipt = {
    transactionId: "desktop-1",
    phase: "awaiting_native_update",
    ownerPid: 123,
    ownerToken: "started-1",
    ownerGeneration: "generation-1",
    updatedAt: new Date(NOW - 30_000).toISOString(),
  };
  const base = {
    receipt,
    heartbeat: null,
    nowMs: NOW,
    processAlive: () => true,
    readProcessStartToken: () => "started-1",
  };
  assert.equal(desktopUpdateOwnerIsLive(base), true);
  assert.equal(desktopUpdateOwnerIsLive({
    ...base,
    nowMs: NOW + 61_000,
  }), false);
});

test("legacy receipts retain PID-only behavior and non-poll phases never use heartbeat takeover", () => {
  const legacy = {
    transactionId: "legacy",
    phase: "awaiting_native_update",
    ownerPid: 123,
    updatedAt: new Date(NOW - 600_000).toISOString(),
  };
  assert.equal(desktopUpdateOwnerIsLive({
    receipt: legacy,
    heartbeat: null,
    nowMs: NOW,
    processAlive: () => true,
    readProcessStartToken: () => null,
  }), true);

  const bounded = {
    transactionId: "desktop-1",
    phase: "verifying",
    ownerPid: 123,
    ownerToken: "started-1",
    ownerGeneration: "generation-1",
    updatedAt: new Date(NOW - 600_000).toISOString(),
  };
  assert.equal(desktopUpdateOwnerIsLive({
    receipt: bounded,
    heartbeat: null,
    nowMs: NOW,
    processAlive: () => true,
    readProcessStartToken: () => "started-1",
  }), true);
});

test("corrupt heartbeat files never become live proof", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-desktop-heartbeat-corrupt-"));
  const file = join(root, "desktop-update.heartbeat.json");
  try {
    writeFileSync(file, "{broken");
    assert.equal(readDesktopUpdateHeartbeat(file), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
