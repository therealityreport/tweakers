import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isDesktopUpdateReceipt, readDesktopUpdateReceipt, type DesktopUpdateReceipt } from "../src/desktop-update-receipt.js";
import { createEnvironmentSelection, defaultEnvironmentProfileRegistry, resolveEnvironmentProfile } from "../src/environment-profile.js";

const NOW = "2026-07-16T12:00:00.000Z";

function receipt(root: string): DesktopUpdateReceipt {
  const profile = resolveEnvironmentProfile(defaultEnvironmentProfileRegistry(root), "stable");
  const selection = (appExperience: "tweakers" | "chatgpt") => createEnvironmentSelection({
    profile, appExperience, requestedAt: NOW, appliedAt: NOW,
  });
  return {
    schemaVersion: 1, kind: "desktop-update", transactionId: "desktop-recovery", phase: "preparing",
    ownerPid: 999, source: selection("tweakers"), official: selection("chatgpt"),
    baseline: { marketingVersion: "1.0.0", build: "100" }, observed: null,
    nativeUpdateHandoffAt: null, refreshSource: null, environmentTransactionId: null,
    safeOfficialMode: false, resumable: false, error: null,
    createdAt: NOW, updatedAt: NOW, completedAt: null, rolledBackAt: null,
  };
}

test("leaf receipt reader retains missing, unreadable, invalid, and legacy schema-v1 outcomes", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-receipt-leaf-"));
  const file = join(root, "desktop-update.json");
  try {
    assert.equal(readDesktopUpdateReceipt(file), null);
    writeFileSync(file, "{");
    assert.throws(() => readDesktopUpdateReceipt(file), /Desktop update receipt is unreadable/);
    const legacy = receipt(root);
    writeFileSync(file, JSON.stringify(legacy));
    assert.deepEqual(readDesktopUpdateReceipt(file), legacy);
    assert.equal(isDesktopUpdateReceipt(legacy), true);
    for (const patch of [{ phase: "unknown" }, { terminalAt: "invalid" }, { officialMainPid: 0 }]) {
      writeFileSync(file, JSON.stringify({ ...legacy, ...patch }));
      assert.throws(() => readDesktopUpdateReceipt(file), /Desktop update receipt is invalid/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy selections normalize only for terminal non-resumable history", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-receipt-legacy-"));
  const file = join(root, "desktop-update.json");
  try {
    const legacy = receipt(root);
    legacy.phase = "failed";
    legacy.safeOfficialMode = true;
    for (const selection of [legacy.source, legacy.official]) {
      for (const axis of ["uiFeatures", "mcpSafetyProvider", "recoveryState", "migrationState", "quarantineReason"]) {
        delete (selection as unknown as Record<string, unknown>)[axis];
      }
    }
    writeFileSync(file, JSON.stringify(legacy));
    const historical = readDesktopUpdateReceipt(file);
    assert.equal(historical?.source.migrationState, "migration-blocked");
    assert.equal(historical?.official.migrationState, "verified");
    for (const patch of [{ resumable: true }, { phase: "preparing" }]) {
      writeFileSync(file, JSON.stringify({ ...legacy, ...patch }));
      assert.throws(() => readDesktopUpdateReceipt(file), /Desktop update receipt is invalid/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
