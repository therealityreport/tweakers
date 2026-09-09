import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startRouterControlSocket } from "../../runtime/src/account-router/control-socket";
import type { RedactedControlStatus } from "../../runtime/src/account-router/types";
import {
  ACCOUNT_HISTORY_ADOPTION_INTENT_FILE,
  ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE,
  ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE,
  ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT,
  CODEX_HISTORY_ARTIFACTS,
  OFFICIAL_CODEX_DATABASES,
  canonicalJson,
  createHistoryAdoptionIntent,
  createHistoryAdoptionOwners,
  createHistoryAdoptionReceipt,
  historyAdoptionIntentFingerprint,
  historyAdoptionPoolFingerprint,
  historyAdoptionThreadOwnersFingerprint,
} from "../src/account-history-adoption";
import {
  accountRouterDataRoot,
  assertIndependentTweakersAccountsRegistration,
  formatAccountRouterEvidence,
  inspectIndependentTweakersLiveHealth,
  inspectAccountRouter,
  parseBrokerLiveResponse,
  readIndependentTweakersBrokerAuthorityExpectation,
  readRegisteredDevelopmentSourceRoot,
  readLiveAccountRouterStatus,
} from "../src/account-router-status";
import {
  REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS,
  TWEAKERS_ORIGINAL_EXECUTABLE,
  TWEAKERS_VARIANT_LAUNCHER_EXECUTABLE,
} from "../src/macos-variant";

const secret = Buffer.alloc(32, 17);
const opaqueAccountId = `ar_${"a".repeat(43)}`;
const opaqueAccountIdB = `ar_${"c".repeat(43)}`;
const opaqueAccountIdC = `ar_${"e".repeat(43)}`;
// Shared recursively key-sorted canonical JSON vector: runtime, UI, installer.
const quotaFingerprint = "sha256:b26118045c98f42a6dcd1e53ba871d63b1a4b23b4aaf8f35969645bf719826b7";
const adoptionThreadId = "01a05546-cf93-7383-96ed-dc76ce3d1b3c";
const adoptionFingerprint = `sha256:${"e".repeat(64)}` as const;

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

function quotaStatus(): RedactedControlStatus {
  return {
    schemaVersion: 2,
    active: { mode: "quota_aware", policy: "quota_aware_v1", generation: 7, fingerprint: quotaFingerprint },
    pending: null,
    protocolState: "supported",
    accounts: [{
      opaqueAccountId,
      label: "Account A",
      eligibility: "eligible",
      plan: "Plus",
      identifierMasked: "••••-1234",
      weekly: { remainingPercent: 71, resetAt: "2026-09-02T12:00:00Z", freshness: "fresh" },
      shortWindowPressure: 12,
      assignedThreadCount: 3,
    }, {
      opaqueAccountId: opaqueAccountIdB,
      label: "Beta",
      eligibility: "eligible",
      plan: null,
      identifierMasked: "••••-5678",
      weekly: { remainingPercent: null, resetAt: null, freshness: "unknown" },
      shortWindowPressure: null,
      assignedThreadCount: 2,
    }],
    poolRemainingPercent: null,
    restartRequired: false,
    degradedReason: "quota_unknown",
  };
}

function quotaConfig(mode: "manual" | "quota_aware" = "quota_aware") {
  return {
    schemaVersion: 2,
    mode,
    policy: mode === "quota_aware" ? "quota_aware_v1" : null,
    generation: 7,
    fingerprint: quotaFingerprint,
    protocolFingerprint: "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10",
    primaryOpaqueAccountId: opaqueAccountId,
    accounts: [{
      opaqueAccountId,
      included: true,
      weight: 1,
      capabilityFingerprint: `sha256:${"b".repeat(64)}`,
      label: "Alpha",
    }, {
      opaqueAccountId: opaqueAccountIdB,
      included: true,
      weight: 1,
      capabilityFingerprint: `sha256:${"d".repeat(64)}`,
      label: "Beta",
    }],
    updatedAt: "2026-08-31T12:00:00.000Z",
  };
}

function restageConfig(
  original: ReturnType<typeof quotaConfig>,
  options: {
    generation: number;
    mode?: "manual" | "quota_aware";
    primaryOpaqueAccountId?: string;
    accounts?: ReturnType<typeof quotaConfig>["accounts"];
  },
) {
  const mode = options.mode ?? original.mode;
  const config = {
    ...original,
    mode,
    policy: mode === "quota_aware" ? "quota_aware_v1" : null,
    generation: options.generation,
    primaryOpaqueAccountId: options.primaryOpaqueAccountId ?? original.primaryOpaqueAccountId,
    accounts: options.accounts ?? original.accounts,
  };
  const canonical = {
    schemaVersion: config.schemaVersion,
    mode: config.mode,
    policy: config.policy,
    generation: config.generation,
    protocolFingerprint: config.protocolFingerprint,
    primaryOpaqueAccountId: config.primaryOpaqueAccountId,
    accounts: config.accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      included: account.included,
      weight: account.weight,
      capabilityFingerprint: account.capabilityFingerprint,
      label: account.label,
    })),
  };
  return {
    ...config,
    fingerprint: `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`,
  };
}

function writePrivate(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeAdoptionIntent(
  routerRoot: string,
  config = quotaConfig(),
  configFingerprint = config.fingerprint,
  legacyOwnerOpaqueAccountId = opaqueAccountId,
) {
  const intent = createHistoryAdoptionIntent({
    protocolFingerprint: ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT,
    accountOpaqueIds: [opaqueAccountId, opaqueAccountIdB],
    configGeneration: config.generation,
    configFingerprint,
    legacyOwnerOpaqueAccountId,
    createdAt: "2026-08-31T12:00:00.000Z",
  }, Buffer.from(secret));
  writePrivate(join(routerRoot, ACCOUNT_HISTORY_ADOPTION_INTENT_FILE), JSON.stringify(intent));
  return intent;
}

function writeAdoptionProofArtifacts(
  routerRoot: string,
  intent: ReturnType<typeof writeAdoptionIntent>,
  legacyOwnerOpaqueAccountId = opaqueAccountId,
  options: { receiptAdoptedAt?: string; importedThreadCount?: number } = {},
): void {
  const poolFingerprint = historyAdoptionPoolFingerprint(
    ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT,
    [opaqueAccountId, opaqueAccountIdB],
  );
  const threadOwnersFingerprint = historyAdoptionThreadOwnersFingerprint([adoptionThreadId], legacyOwnerOpaqueAccountId);
  const owners = createHistoryAdoptionOwners({
    protocolFingerprint: ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT,
    poolFingerprint,
    legacyOwnerOpaqueAccountId,
    threadIds: [adoptionThreadId],
    threadOwnersFingerprint,
    adoptedAt: "2026-08-31T12:00:01.000Z",
  }, Buffer.from(secret));
  const receipt = createHistoryAdoptionReceipt({
    protocolFingerprint: ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT,
    poolFingerprint,
    intentFingerprint: historyAdoptionIntentFingerprint(intent),
    legacyOwnerOpaqueAccountId,
    sourceFingerprint: adoptionFingerprint,
    destinationFingerprint: adoptionFingerprint,
    databases: OFFICIAL_CODEX_DATABASES.map((name) => ({ name, present: false, sha256: null, bytes: 0, integrity: null })),
    histories: CODEX_HISTORY_ARTIFACTS.map((name) => ({ name, present: false, sha256: null, bytes: 0, fileCount: 0 })),
    importedThreadCount: options.importedThreadCount ?? 1,
    threadOwnersFingerprint,
    backupFingerprint: adoptionFingerprint,
    adoptedAt: options.receiptAdoptedAt ?? "2026-08-31T12:00:01.000Z",
  }, Buffer.from(secret));
  writePrivate(join(routerRoot, ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE), JSON.stringify(owners));
  writePrivate(join(routerRoot, ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE), JSON.stringify(receipt));
}

function writeAdoptionProof(routerRoot: string, config = quotaConfig()): void {
  writeAdoptionProofArtifacts(routerRoot, writeAdoptionIntent(routerRoot, config));
}

function writeRuntime(root: string): void {
  mkdirSync(join(root, "account-router"), { recursive: true });
  mkdirSync(join(root, "tweaks", "co.tweakers.account-switcher"), { recursive: true });
  writeFileSync(join(root, "main.js"), "module.exports = {};\n");
  writeFileSync(join(root, "account-router", "app-server-mux.js"), "module.exports = {};\n");
  writeFileSync(join(root, "account-router", "control-socket.js"), "module.exports = {};\n");
  writeFileSync(join(root, "account-router", "history-adoption.js"), "module.exports = {};\n");
  writeFileSync(join(root, "account-router", "quota.js"), "module.exports = {};\n");
  writeFileSync(join(root, "tweaks", "co.tweakers.account-switcher", "index.js"), "module.exports = {};\n");
  writeFileSync(join(root, "catalog.json"), JSON.stringify({
    entries: [{ id: "co.tweakers.account-switcher", manifest: { id: "co.tweakers.account-switcher", version: "0.2.0" } }],
  }));
}

function writeSource(root: string): void {
  const manifestPath = join(root, "tweaks", "co.tweakers.account-switcher", "manifest.json");
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    id: "co.tweakers.account-switcher", version: "0.2.1",
  }));
}

function listTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      entries.push(relative);
      if (entry.isDirectory()) visit(join(directory, entry.name), relative);
    }
  };
  visit(root);
  return entries.sort();
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
    const evidence = await inspectAccountRouter({
      userRoot,
      registeredDevelopmentSourceRoot: sourceRoot,
      candidateRuntimeRoot,
      installedRuntimeRoot,
    });
    assert.deepEqual(evidence.source, { state: "present", version: "0.2.0" });
    assert.deepEqual(evidence.candidate, { state: "present", version: "0.2.0" });
    assert.deepEqual(evidence.installed, { state: "present", version: "0.2.0" });
    assert.deepEqual(evidence.configuration, {
      state: "balanced",
      pending: { schemaVersion: 1, mode: "balanced", policy: null, generation: null, fingerprint: null },
    });
    assert.deepEqual(evidence.historyAdoption, { state: "not_applicable" });
    assert.equal(evidence.live.state, "active");
    assert.deepEqual(evidence.live.status?.accounts, [{
      label: "Account A", eligibility: "eligible", plan: null, identifierMasked: null,
      weekly: null, shortWindowPressure: null, normalizedSpend: 12, assignedThreadCount: 3,
    }]);
    const rendered = formatAccountRouterEvidence(evidence).join("\n");
    assert.match(rendered, /source:\s+present \(0\.2\.0\)/);
    assert.match(rendered, /candidate:\s+present \(0\.2\.0\)/);
    assert.match(rendered, /installed:\s+present \(0\.2\.0\)/);
    assert.match(rendered, /pending:\s+balanced; legacy v1/);
    assert.match(rendered, /history:\s+not applicable/);
    assert.match(rendered, /live:\s+balanced; exact_completed_spend/);
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(opaqueAccountId));
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secret.toString("base64url")));
  } finally {
    await control.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("registered source provenance resolves the checkout realpath and reports absent or stale registrations without paths", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-source-"));
  const sourceRoot = join(fixture, "registered-source");
  const sourceLink = join(fixture, "registered-link");
  const missingManifestRoot = join(fixture, "missing-manifest");
  try {
    writeSource(sourceRoot);
    mkdirSync(missingManifestRoot, { recursive: true });
    symlinkSync(sourceRoot, sourceLink);

    const config = { tweaker: { developmentSourceRoot: sourceLink } };
    assert.equal(readRegisteredDevelopmentSourceRoot(config), sourceLink);
    assert.equal(readRegisteredDevelopmentSourceRoot({ tweaker: {} }), null);
    assert.equal(readRegisteredDevelopmentSourceRoot({ tweaker: { developmentSourceRoot: 1 } }), null);

    const present = await inspectAccountRouter({
      userRoot: join(fixture, "user"),
      registeredDevelopmentSourceRoot: readRegisteredDevelopmentSourceRoot(config),
      candidateRuntimeRoot: join(fixture, "no-candidate"),
      installedRuntimeRoot: join(fixture, "no-installed"),
    });
    assert.deepEqual(present.source, { state: "present", version: "0.2.1" });

    const missing = await inspectAccountRouter({
      userRoot: join(fixture, "user"),
      registeredDevelopmentSourceRoot: missingManifestRoot,
      candidateRuntimeRoot: join(fixture, "no-candidate"),
      installedRuntimeRoot: join(fixture, "no-installed"),
    });
    assert.deepEqual(missing.source, { state: "missing", version: null });

    const stale = await inspectAccountRouter({
      userRoot: join(fixture, "user"),
      registeredDevelopmentSourceRoot: join(fixture, "stale-registration"),
      candidateRuntimeRoot: join(fixture, "no-candidate"),
      installedRuntimeRoot: join(fixture, "no-installed"),
    });
    assert.deepEqual(stale.source, {
      state: "unavailable", version: null, unavailableReason: "registration_stale",
    });
    const rendered = formatAccountRouterEvidence(stale).join("\n");
    assert.match(rendered, /source:\s+unavailable \(registered checkout is stale\)/);
    assert.doesNotMatch(rendered, new RegExp(fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("not-staged source, candidate, and installed observations are independent and read-only", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-read-only-"));
  const candidateRuntimeRoot = join(fixture, "candidate-runtime");
  const installedRuntimeRoot = join(fixture, "installed-runtime");
  try {
    writeRuntime(candidateRuntimeRoot);
    const beforeCandidateOnly = listTree(fixture);
    const candidateOnly = await inspectAccountRouter({
      userRoot: join(fixture, "user"),
      registeredDevelopmentSourceRoot: null,
      candidateRuntimeRoot,
      installedRuntimeRoot,
    });
    assert.deepEqual(candidateOnly.source, {
      state: "unavailable", version: null, unavailableReason: "not_registered",
    });
    assert.deepEqual(candidateOnly.candidate, { state: "present", version: "0.2.0" });
    assert.deepEqual(candidateOnly.installed, { state: "missing", version: null });
    assert.deepEqual(candidateOnly.configuration, { state: "not_staged", pending: null });
    assert.deepEqual(candidateOnly.live, { state: "unavailable", status: null });
    assert.deepEqual(listTree(fixture), beforeCandidateOnly);

    writeRuntime(installedRuntimeRoot);
    const beforeInstalledOnly = listTree(fixture);
    const installedOnly = await inspectAccountRouter({
      userRoot: join(fixture, "user"),
      registeredDevelopmentSourceRoot: null,
      candidateRuntimeRoot: join(fixture, "no-candidate"),
      installedRuntimeRoot,
    });
    assert.deepEqual(installedOnly.candidate, { state: "missing", version: null });
    assert.deepEqual(installedOnly.installed, { state: "present", version: "0.2.0" });
    assert.deepEqual(installedOnly.configuration, { state: "not_staged", pending: null });
    assert.deepEqual(installedOnly.live, { state: "unavailable", status: null });
    assert.deepEqual(listTree(fixture), beforeInstalledOnly);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("installer status requires every critical v0.4 Accounts runtime artifact", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-runtime-artifacts-"));
  const files = [
    "main.js",
    "account-router/app-server-mux.js",
    "account-router/control-socket.js",
    "account-router/history-adoption.js",
    "account-router/quota.js",
    "tweaks/co.tweakers.account-switcher/index.js",
  ];
  try {
    for (const [index, file] of files.entries()) {
      const runtimeRoot = join(fixture, `runtime-${index}`);
      writeRuntime(runtimeRoot);
      unlinkSync(join(runtimeRoot, file));
      const evidence = await inspectAccountRouter({
        userRoot: join(fixture, `user-${index}`),
        candidateRuntimeRoot: runtimeRoot,
        installedRuntimeRoot: join(fixture, `installed-${index}`),
      });
      assert.deepEqual(evidence.candidate, { state: "missing", version: "0.2.0" }, file);
    }
  } finally {
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

test("v2 keeps pending disk intent separate from authenticated quota-aware runtime truth", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-v2-"));
  const userRoot = join(fixture, "user");
  const routerRoot = accountRouterDataRoot(userRoot);
  mkdirSync(routerRoot, { recursive: true, mode: 0o700 });
  writePrivate(join(routerRoot, "control-secret.v1"), secret);
  writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(quotaConfig()));
  const control = await startRouterControlSocket({ root: routerRoot, secret: Buffer.from(secret), status: quotaStatus });
  try {
    const evidence = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(evidence.configuration.pending, {
      schemaVersion: 2, mode: "quota_aware", policy: "quota_aware_v1", generation: 7, fingerprint: quotaFingerprint,
    });
    assert.equal(evidence.live.status?.active.mode, "quota_aware");
    assert.equal(evidence.live.status?.accounts[0]?.plan, "Plus");
    assert.equal(evidence.live.status?.accounts[1]?.weekly?.freshness, "unknown");
    assert.equal(evidence.live.status?.poolRemainingPercent, null);
    const rendered = formatAccountRouterEvidence(evidence).join("\n");
    assert.match(rendered, /pending:\s+quota aware \(quota_aware_v1\); generation 7/);
    assert.match(rendered, /live:\s+quota aware \(quota_aware_v1\); generation 7/);
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(opaqueAccountId));
  } finally {
    await control.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("history-adoption readiness exposes only finite redacted states", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-adoption-"));
  const userRoot = join(fixture, "user");
  const routerRoot = accountRouterDataRoot(userRoot);
  const config = quotaConfig();
  mkdirSync(routerRoot, { recursive: true, mode: 0o700 });
  writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(config));
  try {
    const required = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(required.historyAdoption, { state: "required" });

    writePrivate(join(routerRoot, "control-secret.v1"), secret);
    writeAdoptionIntent(routerRoot, config);
    const pending = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(pending.historyAdoption, { state: "pending_offline_adoption" });

    writeAdoptionProof(routerRoot, config);
    const adopted = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(adopted.historyAdoption, { state: "adopted" });
    assert.match(formatAccountRouterEvidence(adopted).join("\n"), /history:\s+adopted/);
    assert.doesNotMatch(JSON.stringify(adopted), new RegExp(opaqueAccountId));
    assert.doesNotMatch(JSON.stringify(adopted), /hmac|history-adoption-intent|history-adoption-receipt/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("history-adoption mismatch and tamper fail closed without artifact disclosure", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-adoption-invalid-"));
  const userRoot = join(fixture, "user");
  const routerRoot = accountRouterDataRoot(userRoot);
  const config = quotaConfig();
  mkdirSync(routerRoot, { recursive: true, mode: 0o700 });
  writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(config));
  writePrivate(join(routerRoot, "control-secret.v1"), secret);
  try {
    writeAdoptionIntent(routerRoot, config, adoptionFingerprint);
    const mismatch = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(mismatch.historyAdoption, { state: "mismatch" });

    writePrivate(join(routerRoot, ACCOUNT_HISTORY_ADOPTION_INTENT_FILE), "{\"hmac\":\"hmac-sha256:tampered\"}");
    const invalid = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(invalid.historyAdoption, { state: "invalid" });
    assert.doesNotMatch(JSON.stringify(invalid), /tampered|hmac|history-adoption/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("history-adoption status accepts immutable same-pool restaging and rejects changed evidence", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-adoption-restage-"));
  const userRoot = join(fixture, "user");
  const routerRoot = accountRouterDataRoot(userRoot);
  const original = quotaConfig();
  mkdirSync(routerRoot, { recursive: true, mode: 0o700 });
  writePrivate(join(routerRoot, "control-secret.v1"), secret);
  try {
    writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(original));
    writeAdoptionProof(routerRoot, original);

    const quotaRestage = restageConfig(original, { generation: 8 });
    writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(quotaRestage));
    const quotaRestaged = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(quotaRestaged.historyAdoption, { state: "adopted" });

    const manualRestage = restageConfig(quotaRestage, { generation: 9, mode: "manual" });
    writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(manualRestage));
    const manualRestaged = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(manualRestaged.historyAdoption, { state: "adopted" });
    assert.match(formatAccountRouterEvidence(manualRestaged).join("\n"), /v2 Manual remains mux-backed for history; new threads use the primary account/);

    const changedPool = restageConfig(manualRestage, {
      generation: 10,
      accounts: [manualRestage.accounts[0]!, { ...manualRestage.accounts[1]!, opaqueAccountId: opaqueAccountIdC }],
    });
    writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(changedPool));
    const poolMismatch = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(poolMismatch.historyAdoption, { state: "mismatch" });

    writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(manualRestage));
    const originalIntent = writeAdoptionIntent(routerRoot, original);
    writeAdoptionProofArtifacts(routerRoot, originalIntent, opaqueAccountIdB);
    const ownerMismatch = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(ownerMismatch.historyAdoption, { state: "mismatch" });

    writeAdoptionProofArtifacts(routerRoot, originalIntent, opaqueAccountId, { importedThreadCount: 2 });
    const receiptMismatch = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(receiptMismatch.historyAdoption, { state: "mismatch" });

    writeAdoptionProofArtifacts(routerRoot, originalIntent);
    unlinkSync(join(routerRoot, ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE));
    const missingEvidence = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(missingEvidence.historyAdoption, { state: "invalid" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("manual pending intent does not hide an active legacy balanced mux, and balanced intent reports no mux", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-pending-live-"));
  const userRoot = join(fixture, "user");
  const routerRoot = accountRouterDataRoot(userRoot);
  mkdirSync(routerRoot, { recursive: true, mode: 0o700 });
  writePrivate(join(routerRoot, "control-secret.v1"), secret);
  writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify({
    schemaVersion: 1, mode: "manual", protocolFingerprint: `sha256:${"b".repeat(64)}`,
    primaryOpaqueAccountId: opaqueAccountId, accounts: [], updatedAt: "2026-08-31T12:00:00Z",
  }));
  const control = await startRouterControlSocket({ root: routerRoot, secret: Buffer.from(secret), status });
  try {
    const manualPending = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.equal(manualPending.configuration.state, "manual");
    assert.equal(manualPending.live.status?.active.mode, "balanced");
    assert.match(formatAccountRouterEvidence(manualPending).join("\n"), /pending:\s+manual; legacy v1[\s\S]*live:\s+balanced/);
  } finally {
    await control.close();
  }
  writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify({
    schemaVersion: 1, mode: "balanced", protocolFingerprint: `sha256:${"b".repeat(64)}`,
    primaryOpaqueAccountId: opaqueAccountId, accounts: [], updatedAt: "2026-08-31T12:00:00Z",
  }));
  try {
    const balancedPending = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.equal(balancedPending.configuration.state, "balanced");
    assert.deepEqual(balancedPending.live, { state: "not_running", status: null });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("v2 config fingerprint vector and unsafe fields fail closed", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-v2-invalid-"));
  const userRoot = join(fixture, "user");
  const routerRoot = accountRouterDataRoot(userRoot);
  mkdirSync(routerRoot, { recursive: true, mode: 0o700 });
  const config = quotaConfig();
  assert.equal(config.fingerprint, quotaFingerprint, "fixed v2 canonical fingerprint vector");
  const unicodeConfig = quotaConfig();
  unicodeConfig.fingerprint = "sha256:7302673995d79719491abb35e46a9a7b0fc5f15d57ad793727d10505e33e2cdb";
  unicodeConfig.accounts[0]!.label = "Café 東京";
  unicodeConfig.accounts[1]!.label = "Équipe 2";
  writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(unicodeConfig));
  const unicodeEvidence = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
  assert.equal(unicodeEvidence.configuration.state, "quota_aware", "normalized Unicode local labels remain valid");

  const invalidConfigs = [
    ["protocol fingerprint", { ...config, protocolFingerprint: `sha256:${"f".repeat(64)}` }],
    ["fractional weight", { ...config, accounts: [{ ...config.accounts[0]!, weight: 1.5 }, config.accounts[1]!] }],
    ["primary membership", { ...config, primaryOpaqueAccountId: `ar_${"z".repeat(43)}` }],
    ["invalid UTC date", { ...config, updatedAt: "2026-02-30T12:00:00.000Z" }],
    ["noncanonical UTC fraction", { ...config, updatedAt: "2026-08-31T12:00:00.0Z" }],
    ["unsafe label", { ...config, accounts: [{ ...config.accounts[0]!, label: "Bearer sk-proj-abcdefgh" }, config.accounts[1]!] }],
    ["fingerprint", { ...config, fingerprint: `sha256:${"f".repeat(64)}` }],
  ] as const;
  for (const [name, invalidConfig] of invalidConfigs) {
    writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify(invalidConfig));
    const invalidEvidence = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(invalidEvidence.configuration, { state: "invalid", pending: null }, name);
  }

  writePrivate(join(routerRoot, "account-router-config.json"), JSON.stringify({ ...config, providerError: "must not pass" }));
  try {
    const unsafe = await inspectAccountRouter({ userRoot, candidateRuntimeRoot: join(fixture, "candidate"), installedRuntimeRoot: join(fixture, "installed") });
    assert.deepEqual(unsafe.configuration, { state: "invalid", pending: null });
    assert.equal(unsafe.live.state, "unavailable");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("installer rejects malformed or unredacted v2 socket projections", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-account-router-v2-redaction-"));
  const routerRoot = accountRouterDataRoot(join(fixture, "user"));
  mkdirSync(routerRoot, { recursive: true, mode: 0o700 });
  writePrivate(join(routerRoot, "control-secret.v1"), secret);
  const malformed = {
    ...quotaStatus(),
    providerError: "unexpected provider detail",
  } as unknown as RedactedControlStatus;
  const control = await startRouterControlSocket({ root: routerRoot, secret: Buffer.from(secret), status: () => malformed });
  try {
    assert.deepEqual(await readLiveAccountRouterStatus(routerRoot), { state: "unavailable", status: null });
  } finally {
    await control.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("broker status keeps authenticated client, child, handoff, and browser evidence finite and identifier-free", () => {
  const rendererA = `br_${"r".repeat(24)}`;
  const rendererB = `br_${"s".repeat(24)}`;
  const brokerFrame = {
    version: 1,
    requestId: "tweaker-cli-broker-status-v1",
    status: {
      version: 1,
      state: "available",
      registeredClients: [
        { rendererRef: rendererA, clientKind: "chatgpt" },
        { rendererRef: rendererB, clientKind: "tweakers" },
      ],
      pool: {
        maxResidentChildren: 2,
        residentChildren: 2,
        heldWorkCount: 1,
        accounts: [
          { enabled: true, state: "active", childState: "active", activeRunCount: 1, assignedTaskCount: 3 },
          { enabled: true, state: "ready", childState: "resident", activeRunCount: 0, assignedTaskCount: 1 },
        ],
      },
      pendingHandoffs: { pendingCount: 1, ambiguousCount: 0 },
      browserEvidence: { observed: true, observedAt: "2026-09-02T12:00:00.000Z" },
    },
  };
  const parsed = parseBrokerLiveResponse(Buffer.from(JSON.stringify(brokerFrame)), "tweaker-cli-broker-status-v1");
  assert.deepEqual(parsed, {
    state: "available",
    registeredClients: { total: 2, chatgpt: 1, tweakers: 1 },
    residentChildren: 2,
    maxResidentChildren: 2,
    heldWorkCount: 1,
    childStates: { absent: 0, resident: 1, active: 1, held: 0, evicted: 0 },
    pendingHandoffs: { pendingCount: 1, ambiguousCount: 0 },
    browserEvidence: { observed: true, observedAt: "2026-09-02T12:00:00.000Z" },
  });
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(`${rendererA}|${rendererB}|${opaqueAccountId}|${opaqueAccountIdB}`));

  for (const invalid of [
    { ...brokerFrame, status: { ...brokerFrame.status, secret: "must-not-pass" } },
    { ...brokerFrame, status: { ...brokerFrame.status, registeredClients: [{ rendererRef: rendererA, clientKind: "chatgpt", path: "/private/path" }] } },
    { ...brokerFrame, status: { ...brokerFrame.status, pool: { ...brokerFrame.status.pool, residentChildren: 3 } } },
    { ...brokerFrame, status: { ...brokerFrame.status, pool: { ...brokerFrame.status.pool, accounts: [{ ...brokerFrame.status.pool.accounts[0], opaqueAccountId }] } } },
    { ...brokerFrame, status: { ...brokerFrame.status, browserEvidence: { observed: true, observedAt: "not-a-timestamp" } } },
  ]) {
    assert.equal(parseBrokerLiveResponse(Buffer.from(JSON.stringify(invalid)), "tweaker-cli-broker-status-v1"), null);
  }

  const tooManyClients = {
    ...brokerFrame,
    status: {
      ...brokerFrame.status,
      registeredClients: Array.from({ length: 17 }, (_, index) => ({
        rendererRef: `br_${String(index).padStart(24, "x")}`,
        clientKind: index % 2 === 0 ? "chatgpt" : "tweakers",
      })),
    },
  };
  assert.equal(parseBrokerLiveResponse(Buffer.from(JSON.stringify(tooManyClients)), "tweaker-cli-broker-status-v1"), null);
});

test("independent runtime readiness binds only an absent broker root or an exact global-v3 config fingerprint", () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-broker-authority-"));
  try {
    const brokerRoot = join(fixture, "global-broker");
    assert.deepEqual(readIndependentTweakersBrokerAuthorityExpectation(brokerRoot), {
      globalRootState: "absent",
      configSha256: null,
    });

    mkdirSync(brokerRoot, { recursive: true, mode: 0o700 });
    assert.throws(
      () => readIndependentTweakersBrokerAuthorityExpectation(brokerRoot),
      /exactly valid global-v3 config/,
      "an existing root with no config is not absence",
    );
    writePrivate(join(brokerRoot, "account-router-config.json"), JSON.stringify({ schemaVersion: 3 }));
    assert.throws(() => readIndependentTweakersBrokerAuthorityExpectation(brokerRoot), /exactly valid global-v3 config/);

    const config = brokerV3Config();
    const bytes = Buffer.from(`${JSON.stringify(config)}\n`);
    writePrivate(join(brokerRoot, "account-router-config.json"), bytes);
    assert.deepEqual(readIndependentTweakersBrokerAuthorityExpectation(brokerRoot), {
      globalRootState: "valid-v3",
      configSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    chmodSync(brokerRoot, 0o755);
    assert.throws(() => readIndependentTweakersBrokerAuthorityExpectation(brokerRoot), /owner-private real directory/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Accounts promotion requires a complete registration even when an absent root can be inspected", (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-accounts-promotion-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const brokerRoot = join(fixture, "broker");
  assert.throws(() => assertIndependentTweakersAccountsRegistration(brokerRoot), /setup is incomplete/);
  mkdirSync(brokerRoot, { mode: 0o700 });
  writePrivate(join(brokerRoot, "account-router-config.json"), JSON.stringify(brokerV3Config()));
  assert.throws(() => assertIndependentTweakersAccountsRegistration(brokerRoot), /capability is missing/);
  const secretPath = join(brokerRoot, "control-secret.v1");
  writePrivate(secretPath, Buffer.alloc(8));
  assert.throws(() => assertIndependentTweakersAccountsRegistration(brokerRoot), /capability is missing/);
  writePrivate(secretPath, Buffer.alloc(32, 17));
  assert.equal(assertIndependentTweakersAccountsRegistration(brokerRoot).globalRootState, "valid-v3");
  chmodSync(secretPath, 0o644);
  assert.throws(() => assertIndependentTweakersAccountsRegistration(brokerRoot), /capability is missing/);
});

test("independent live health rejects stale, exited, PID-reused, and malformed records", () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-live-health-"));
  try {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const record = independentLiveHealth({ observedAt: "2026-09-04T11:59:00.000Z" });
    writePrivate(join(fixture, "independent-live-health.json"), JSON.stringify(record));
    assert.equal(inspectIndependentTweakersLiveHealth(fixture, {
      nowMs: () => now,
      processAlive: () => true,
      readProcessStartToken: () => record.processStartToken,
      readProcessCommand: () => `/Applications/Tweakers.app/Contents/MacOS/${TWEAKERS_ORIGINAL_EXECUTABLE} --user-data-dir=${record.appUserDataRoot}`,
      expectedAccountsBrokerRoot: record.accountsBrokerRoot,
      verifyCurrentIdentity: () => true,
    }).state, "current");
    assert.equal(inspectIndependentTweakersLiveHealth(fixture, {
      nowMs: () => now,
      processAlive: () => true,
      readProcessStartToken: () => record.processStartToken,
      readProcessCommand: () => "/Applications/Other.app/Contents/MacOS/Other",
      expectedAccountsBrokerRoot: record.accountsBrokerRoot,
      verifyCurrentIdentity: () => true,
    }).state, "process_identity_mismatch");
    assert.equal(inspectIndependentTweakersLiveHealth(fixture, {
      nowMs: () => now,
      processAlive: () => true,
      readProcessStartToken: () => record.processStartToken,
      readProcessCommand: () => `"/Applications/Tweakers.app/Contents/MacOS/${TWEAKERS_ORIGINAL_EXECUTABLE}" --user-data-dir=${record.appUserDataRoot}`,
      expectedAccountsBrokerRoot: record.accountsBrokerRoot,
      verifyCurrentIdentity: () => true,
    }).state, "current");
    for (const command of [
      `/Applications/Tweakers.app/Contents/MacOS/${TWEAKERS_ORIGINAL_EXECUTABLE}`,
      `/Applications/Tweakers.app/Contents/MacOS/${TWEAKERS_ORIGINAL_EXECUTABLE} --user-data-dir=/Users/fixture/Other/app-data`,
      `/Applications/Tweakers.app/Contents/MacOS/${TWEAKERS_ORIGINAL_EXECUTABLE} --user-data-dir=${record.appUserDataRoot} --user-data-dir=/Users/fixture/Other/app-data`,
      `/Applications/Tweakers.app/Contents/MacOS/${TWEAKERS_ORIGINAL_EXECUTABLE} --user-data-dir=${record.appUserDataRoot} --started-from-launcher`,
      `/Applications/Tweakers.app/Contents/MacOS/${TWEAKERS_VARIANT_LAUNCHER_EXECUTABLE} --user-data-dir=${record.appUserDataRoot}`,
    ]) {
      assert.equal(inspectIndependentTweakersLiveHealth(fixture, {
        nowMs: () => now,
        processAlive: () => true,
        readProcessStartToken: () => record.processStartToken,
        readProcessCommand: () => command,
        expectedAccountsBrokerRoot: record.accountsBrokerRoot,
        verifyCurrentIdentity: () => true,
      }).state, "process_identity_mismatch", command);
    }
    assert.equal(inspectIndependentTweakersLiveHealth(fixture, {
      nowMs: () => now,
      processAlive: () => true,
      readProcessStartToken: () => record.processStartToken,
      readProcessCommand: () => "/Applications/Tweakers.app/Contents/Frameworks/Tweakers Helper.app/Contents/MacOS/Tweakers Helper --type=renderer",
      expectedAccountsBrokerRoot: record.accountsBrokerRoot,
      verifyCurrentIdentity: () => true,
    }).state, "process_identity_mismatch");
    assert.equal(inspectIndependentTweakersLiveHealth(fixture, {
      nowMs: () => now + 2 * 60 * 1_000 + 1,
      processAlive: () => true,
      readProcessStartToken: () => record.processStartToken,
      expectedAccountsBrokerRoot: record.accountsBrokerRoot,
    }).state, "stale");
    assert.equal(inspectIndependentTweakersLiveHealth(fixture, {
      nowMs: () => now,
      processAlive: () => false,
      readProcessStartToken: () => record.processStartToken,
      expectedAccountsBrokerRoot: record.accountsBrokerRoot,
    }).state, "process_not_running");
    assert.equal(inspectIndependentTweakersLiveHealth(fixture, {
      nowMs: () => now,
      processAlive: () => true,
      readProcessStartToken: () => "PID reused",
      expectedAccountsBrokerRoot: record.accountsBrokerRoot,
    }).state, "process_identity_mismatch");
    writePrivate(join(fixture, "independent-live-health.json"), JSON.stringify({
      ...record,
      initializedTweakIds: record.initializedTweakIds.slice(0, -1),
    }));
    assert.equal(inspectIndependentTweakersLiveHealth(fixture).state, "invalid");
    writePrivate(join(fixture, "independent-live-health.json"), JSON.stringify({ ...record, appearance: { ...record.appearance, unexpected: true } }));
    assert.equal(inspectIndependentTweakersLiveHealth(fixture).state, "invalid");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("independent live health rejects current global-v3 broker config byte drift", () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-live-health-config-drift-"));
  try {
    const brokerRoot = join(fixture, "broker");
    mkdirSync(brokerRoot, { recursive: true, mode: 0o700 });
    const config = brokerV3Config();
    const configBytes = Buffer.from(`${JSON.stringify(config)}\n`);
    writePrivate(join(brokerRoot, "account-router-config.json"), configBytes);
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const record = {
      ...independentLiveHealth({ observedAt: "2026-09-04T11:59:00.000Z" }),
      accountsBrokerRoot: brokerRoot,
      accountsBrokerConfigSha256: createHash("sha256").update(configBytes).digest("hex"),
      sharedHistoryBrokerState: "connected" as const,
    };
    writePrivate(join(fixture, "independent-live-health.json"), JSON.stringify(record));
    const currentProcess = {
      nowMs: () => now,
      processAlive: () => true,
      readProcessStartToken: () => record.processStartToken,
      readProcessCommand: () => `/Applications/Tweakers.app/Contents/MacOS/${TWEAKERS_ORIGINAL_EXECUTABLE} --user-data-dir=${record.appUserDataRoot}`,
      expectedAccountsBrokerRoot: brokerRoot,
      verifyCurrentIdentity: () => true,
    };
    assert.equal(inspectIndependentTweakersLiveHealth(fixture, currentProcess).state, "current");
    writePrivate(join(brokerRoot, "account-router-config.json"), Buffer.from(`\n${configBytes}`));
    assert.equal(inspectIndependentTweakersLiveHealth(fixture, currentProcess).state, "invalid");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("balanced token policy remains valid in installer authority and pending diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-balanced-policy-"));
  const brokerRoot = accountRouterDataRoot(root);
  mkdirSync(brokerRoot, { recursive: true, mode: 0o700 });
  const config = brokerV3Config("balanced_tokens_v1");
  const bytes = Buffer.from(JSON.stringify(config));
  writePrivate(join(brokerRoot, "account-router-config.json"), bytes);
  assert.deepEqual(readIndependentTweakersBrokerAuthorityExpectation(brokerRoot), {
    globalRootState: "valid-v3", configSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const evidence = await inspectAccountRouter({ userRoot: root, brokerRoot });
  assert.equal(evidence.configuration.state, "quota_aware");
  assert.equal(evidence.configuration.pending?.policy, "balanced_tokens_v1");
});

function brokerV3Config(policy = "quota_aware_v2") {
  const account = {
    opaqueAccountId,
    included: true,
    weight: 1,
    capabilityFingerprint: `sha256:${"b".repeat(64)}`,
    label: "Alpha",
  };
  const canonical = {
    schemaVersion: 3,
    mode: "quota_aware",
    policy,
    generation: 1,
    protocolFingerprint: "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10",
    primaryOpaqueAccountId: opaqueAccountId,
    accounts: [account],
  };
  return {
    ...canonical,
    fingerprint: `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`,
    updatedAt: "2026-09-04T12:00:00.000Z",
  };
}

function independentLiveHealth(input: { observedAt: string }) {
  const metrics = {
    electronZoomLevel: 0,
    electronZoomFactor: 1,
    cssWindowZoom: 1,
    rootZoom: 1,
    bodyZoom: 1,
    rootFontSizePx: 16,
    bodyFontSizePx: 16,
    visualViewportScale: 1,
    devicePixelRatio: 2,
    displayScaleFactor: 2,
    bounds: { x: 0, y: 0, width: 1200, height: 900 },
  };
  return {
    schemaVersion: 1,
    kind: "tweakers-independent-live-health",
    pid: 1234,
    processStartToken: "Thu Sep  4 12:00:00 2026",
    appRoot: "/Applications/Tweakers.app",
    bundleId: "com.therealityreport.tweakers",
    appAsarHeaderHash: "a".repeat(64),
    appSignatureSha256: "b".repeat(64),
    runtimeFingerprint: "c".repeat(64),
    appUserDataRoot: "/Users/fixture/Tweakers/app-data",
    codexHomeRoot: "/Users/fixture/Tweakers/codex-home",
    accountsBrokerRoot: "/Users/fixture/Tweakers/broker",
    accountsBrokerConfigSha256: null,
    sharedHistoryBrokerState: "blocked",
    initializedTweakIds: [...REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS].sort(),
    lifecycleFailures: [],
    appearance: { status: "normal", normalized: true, windowId: 1, before: metrics, after: metrics },
    observedAt: input.observedAt,
  };
}
