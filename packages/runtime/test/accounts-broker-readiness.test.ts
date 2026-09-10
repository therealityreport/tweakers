import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readAccountsBrokerSetupState } from "../src/account-router/broker-readiness";
import { routerConfigFingerprint } from "../src/account-router/config";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfigV3, type OpaqueAccountId } from "../src/account-router/types";
import { invokeAccountsNativeBrowserAction } from "../src/accounts-native-browser";

test("missing account registration is diagnosed without creating a root or reading legacy accounts", (t) => {
  const parent = resolve(mkdtempSync(join(tmpdir(), "accounts-readiness-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "broker");
  assert.equal(readAccountsBrokerSetupState(root), "setup-required");
  assert.equal(existsSync(root), false);
  mkdirSync(root, { mode: 0o700 });
  assert.equal(readAccountsBrokerSetupState(root), "setup-required");
  assert.equal(readAccountsBrokerSetupState(null), "unavailable");
  assert.equal(readAccountsBrokerSetupState("relative-root"), "unavailable");
});

test("two registered accounts remain registered during a service outage; incomplete and unsafe files stay distinct", (t) => {
  const root = resolve(mkdtempSync(join(tmpdir(), "accounts-registration-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const accounts = ["a", "b"].map((value, index) => ({
    opaqueAccountId: `ar_${value.repeat(43)}` as OpaqueAccountId,
    included: true, weight: 1, label: `Account ${index + 1}`,
    capabilityFingerprint: `sha256:${"c".repeat(64)}` as const,
  }));
  const config: RouterConfigV3 = {
    schemaVersion: 3, mode: "quota_aware", policy: "balanced_tokens_v1", generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: accounts[0]!.opaqueAccountId, accounts,
    updatedAt: "2026-09-05T00:00:00.000Z", fingerprint: `sha256:${"0".repeat(64)}`,
  };
  config.fingerprint = routerConfigFingerprint(config);
  const configPath = join(root, "account-router-config.json");
  const secretPath = join(root, "control-secret.v1");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  assert.equal(readAccountsBrokerSetupState(root), "setup-required", "config alone is not a completed registration");
  writeFileSync(secretPath, Buffer.alloc(32, 17), { mode: 0o600 });
  assert.equal(readAccountsBrokerSetupState(root), "registered", "no live service or socket is needed to diagnose completed setup");
  writeFileSync(secretPath, Buffer.alloc(8));
  assert.equal(readAccountsBrokerSetupState(root), "unavailable", "malformed credentials must not request fresh setup");
  unlinkSync(secretPath);
  symlinkSync(join(root, "absent-secret"), secretPath);
  assert.equal(readAccountsBrokerSetupState(root), "unavailable", "a dangling capability symlink is not missing setup");
  unlinkSync(secretPath);
  writeFileSync(secretPath, Buffer.alloc(32, 17), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 3 }));
  assert.equal(readAccountsBrokerSetupState(root), "unavailable");
  writeFileSync(configPath, JSON.stringify(config));
  chmodSync(root, 0o755);
  assert.equal(readAccountsBrokerSetupState(root), "unavailable");
});

test("native browser actions bind the broker home and refuse a different account catalog", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "accounts-browser-binding-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "account-b");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "config.toml"), "", { mode: 0o600 });
  const effects: unknown[] = [];
  const bridge = { version: 1, hookSetSha256: "a".repeat(64), create: (input: any) => {
    effects.push({ home: input.codexHome });
    return { sync: async () => ({ codexHome: input.codexHome }), install: async (params: unknown) => { effects.push(params); }, uninstall: async () => {} };
  } };
  let valid = true;
  const deps = { isCurrent: () => valid, compatibility: () => ({ compatible: true, reason: null, hookSetSha256: bridge.hookSetSha256, build: "26.901.51231" }), bridge: () => bridge,
    context: async (accountId: string) => accountId === "account_b" ? { version: 1 as const, status: "ready" as const, opaqueAccountId: "private_b", codexHome: home, configFile: join(home, "config.toml"), appServerVersion: "0.153.4" } : null,
    request: async (accountId: string) => { assert.equal(accountId, "account_b"); return { marketplaces: [{ name: "known", path: "/known/marketplace", plugins: [{ name: "chrome" }] }] }; },
  };
  const request = { accountId: "account_b", opaqueAccountId: "private_b", method: "browser.sync", params: {} };
  assert.deepEqual(await invokeAccountsNativeBrowserAction(request, deps), { ok: true }, "private native paths never reach the renderer result");
  assert.deepEqual(effects, [{ home }]);
  await assert.rejects(invokeAccountsNativeBrowserAction({ ...request, method: "browser.install", params: { hostId: "local", marketplacePath: "/other/account/marketplace", pluginName: "chrome" } }, deps), /does not belong/);
  assert.equal(effects.length, 2, "no install side effect occurs for a different catalog");
  await assert.rejects(invokeAccountsNativeBrowserAction({ ...request, opaqueAccountId: "private_a" }, deps), /binding is unavailable/);
  valid = false;
  await assert.rejects(invokeAccountsNativeBrowserAction(request, deps), /integration is unavailable/);
  assert.equal(effects.length, 2);
});
