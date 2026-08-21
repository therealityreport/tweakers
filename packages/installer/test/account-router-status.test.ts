import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startRouterControlSocket } from "../../runtime/src/account-router/control-socket";
import type { RedactedControlStatus } from "../../runtime/src/account-router/types";
import {
  accountRouterDataRoot,
  formatAccountRouterEvidence,
  inspectAccountRouter,
  readLiveAccountRouterStatus,
} from "../src/account-router-status";

const secret = Buffer.alloc(32, 17);
const opaqueAccountId = `ar_${"a".repeat(43)}`;

function status(): RedactedControlStatus {
  return {
    schemaVersion: 1,
    mode: "balanced",
    protocolState: "supported",
    fairnessPrecision: "exact_completed_spend",
    accounts: [{
      opaqueAccountId,
      label: "Account A",
      eligibility: "eligible",
      normalizedSpend: 12,
      assignedThreadCount: 3,
    }],
    restartRequired: false,
    degradedReason: null,
  };
}

function writePrivate(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeRuntime(root: string): void {
  mkdirSync(join(root, "account-router"), { recursive: true });
  writeFileSync(join(root, "account-router", "app-server-mux.js"), "module.exports = {};\n");
  writeFileSync(join(root, "account-router", "control-socket.js"), "module.exports = {};\n");
  writeFileSync(join(root, "catalog.json"), JSON.stringify({
    entries: [{ id: "co.tweakers.account-switcher", manifest: { id: "co.tweakers.account-switcher", version: "0.2.0" } }],
  }));
}

test("installer status keeps source, candidate, installed, and authenticated live evidence distinct and redacted", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-status-"));
  const userRoot = join(fixture, "user");
  const sourceRoot = join(fixture, "source");
  const candidateRuntimeRoot = join(fixture, "candidate-runtime");
  const installedRuntimeRoot = join(fixture, "installed-runtime");
  const routerRoot = accountRouterDataRoot(userRoot);
  mkdirSync(routerRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(sourceRoot, "tweaks", "co.tweakers.account-switcher"), { recursive: true });
  writePrivate(join(sourceRoot, "tweaks", "co.tweakers.account-switcher", "manifest.json"), JSON.stringify({
    id: "co.tweakers.account-switcher", version: "0.2.0",
  }));
  writePrivate(join(routerRoot, "control-secret.v1"), secret);
  writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify({
    schemaVersion: 1,
    mode: "balanced",
    protocolFingerprint: `sha256:${"b".repeat(64)}`,
    primaryOpaqueAccountId: opaqueAccountId,
    accounts: [],
    updatedAt: "2026-08-19T12:00:00Z",
  }));
  writeRuntime(candidateRuntimeRoot);
  writeRuntime(installedRuntimeRoot);
  const control = await startRouterControlSocket({ root: routerRoot, secret: Buffer.from(secret), status });
  try {
    const evidence = await inspectAccountRouter({ userRoot, sourceRoot, candidateRuntimeRoot, installedRuntimeRoot });
    assert.deepEqual(evidence.source, { state: "present", version: "0.2.0" });
    assert.deepEqual(evidence.candidate, { state: "present", version: "0.2.0" });
    assert.deepEqual(evidence.installed, { state: "present", version: "0.2.0" });
    assert.deepEqual(evidence.configuration, { state: "balanced" });
    assert.equal(evidence.live.state, "active");
    assert.deepEqual(evidence.live.status?.accounts, [{
      label: "Account A", eligibility: "eligible", normalizedSpend: 12, assignedThreadCount: 3,
    }]);
    const rendered = formatAccountRouterEvidence(evidence).join("\n");
    assert.match(rendered, /source:\s+present \(0\.2\.0\)/);
    assert.match(rendered, /candidate:\s+present \(0\.2\.0\)/);
    assert.match(rendered, /installed:\s+present \(0\.2\.0\)/);
    assert.match(rendered, /live:\s+balanced, exact_completed_spend/);
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(opaqueAccountId));
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secret.toString("base64url")));
  } finally {
    await control.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("installer client fails closed when the control secret file is no longer owner-private", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-private-"));
  const routerRoot = accountRouterDataRoot(fixture);
  mkdirSync(routerRoot, { recursive: true, mode: 0o700 });
  const secretPath = join(routerRoot, "control-secret.v1");
  writePrivate(secretPath, secret);
  const control = await startRouterControlSocket({ root: routerRoot, secret: Buffer.from(secret), status });
  try {
    chmodSync(secretPath, 0o644);
    assert.deepEqual(await readLiveAccountRouterStatus(routerRoot), { state: "unavailable", status: null });
  } finally {
    await control.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
