import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  buildAccountRouterMuxArgs,
  CODEX_APP_SERVER_PARENT_SOURCE,
  installCodexAppServerParent,
  type MutableChildProcessModule,
  type SpawnFunction,
} from "../src/codex-app-server-parent";
import { routerConfigFingerprint } from "../src/account-router/config";
import { createInitialRouterState } from "../src/account-router/state-store";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfig, type RouterConfigV2 } from "../src/account-router/types";
import { publishHistoryAdoptionEvidence } from "./account-router/history-adoption-fixtures";

const accountA = `ar_${"A".repeat(43)}`;
const accountB = `ar_${"B".repeat(43)}`;

function opaque(secret: Buffer, raw: string): `ar_${string}` {
  return `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`, "utf8").digest("base64url")}`;
}

function writePrivate(path: string, contents: string | Buffer): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function stagedRouterConfig(): { root: string; configPath: string; accounts: [`ar_${string}`, `ar_${string}`] } {
  const root = mkdtempSync(join(tmpdir(), "account-router-parent-"));
  const data = join(root, "tweak-data", "co.tweakers.account-switcher");
  const secret = Buffer.alloc(32, 3);
  const accounts = [opaque(secret, "account-a"), opaque(secret, "account-b")] as [`ar_${string}`, `ar_${string}`];
  mkdirSync(data, { recursive: true, mode: 0o700 });
  for (const [index, account] of accounts.entries()) {
    mkdirSync(join(data, "accounts", account, "codex-home"), { recursive: true, mode: 0o700 });
    mkdirSync(join(data, "accounts", account, "sqlite-home"), { recursive: true, mode: 0o700 });
    writePrivate(join(data, "accounts", account, "codex-home", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: index === 0 ? "account-a" : "account-b", refresh_token: "test-only" } }));
    writePrivate(join(data, "accounts", account, "codex-home", "config.toml"), "");
  }
  writePrivate(join(data, "control-secret.v1"), secret);
  const configPath = join(data, "account-router-config.json");
  writePrivate(configPath, JSON.stringify({
    schemaVersion: 1,
    mode: "balanced",
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: accounts[0],
    accounts: [
      { opaqueAccountId: accounts[0], included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
      { opaqueAccountId: accounts[1], included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
    ],
    updatedAt: "2026-08-19T12:00:00Z",
  }));
  return { root, configPath, accounts };
}

function stagedQuotaRouterConfig(mode: "quota_aware" | "manual" = "quota_aware"): { root: string; configPath: string; accounts: [`ar_${string}`, `ar_${string}`]; config: RouterConfigV2 } {
  const staged = stagedRouterConfig();
  const draft: Omit<RouterConfigV2, "fingerprint"> = {
    schemaVersion: 2,
    mode,
    policy: mode === "quota_aware" ? "quota_aware_v1" : null,
    generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: staged.accounts[0],
    accounts: [
      { opaqueAccountId: staged.accounts[0], included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}`, label: "Account 1" },
      { opaqueAccountId: staged.accounts[1], included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}`, label: "Account 2" },
    ],
    updatedAt: "2026-08-31T12:00:00.000Z",
  };
  const config = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  writePrivate(staged.configPath, JSON.stringify(config));
  publishHistoryAdoptionEvidence({
    root: join(staged.root, "tweak-data", "co.tweakers.account-switcher"),
    config,
    secret: Buffer.alloc(32, 3),
  });
  return { ...staged, config };
}

test("parent selects mux only after a private, complete signed v2 adoption preflight", () => {
  const staged = stagedQuotaRouterConfig();
  const calls: Array<{ command: string; args: unknown }> = [];
  const original: SpawnFunction = (command, args) => {
    calls.push({ command, args });
    return {} as ChildProcess;
  };
  const childProcess: MutableChildProcessModule = { spawn: original };
  const muxEntrypoint = "/private/runtime/account-router/app-server-mux.js";
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/Applications/ChatGPT.app/Contents/Resources",
    platform: "darwin",
    pathExists: (path) => path.endsWith("/cua_node/bin/node") || path === muxEntrypoint,
    accountRouter: { configPath: staged.configPath, runtimeEntrypointPath: muxEntrypoint, pathExists: (path) => path === muxEntrypoint || path === staged.configPath },
  });
  childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
  assert.deepEqual(calls[0], {
    command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    args: buildAccountRouterMuxArgs(muxEntrypoint, staged.configPath, "/usr/local/bin/codex", ["app-server"]),
  });
  installation.uninstall();
});

test("parent selects the mux for a valid v2 quota-aware config", () => {
  const staged = stagedQuotaRouterConfig();
  const calls: Array<{ command: string; args: unknown }> = [];
  const original: SpawnFunction = (command, args) => {
    calls.push({ command, args });
    return {} as ChildProcess;
  };
  const childProcess: MutableChildProcessModule = { spawn: original };
  const muxEntrypoint = "/private/runtime/account-router/app-server-mux.js";
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/Applications/ChatGPT.app/Contents/Resources",
    platform: "darwin",
    pathExists: (path) => path.endsWith("/cua_node/bin/node") || path === muxEntrypoint,
    accountRouter: { configPath: staged.configPath, runtimeEntrypointPath: muxEntrypoint, pathExists: (path) => path === muxEntrypoint || path === staged.configPath },
  });
  childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
  assert.deepEqual(calls[0]?.args, buildAccountRouterMuxArgs(muxEntrypoint, staged.configPath, "/usr/local/bin/codex", ["app-server"]));
  installation.uninstall();
});

test("parent keeps an adopted v2 manual configuration mux-backed for history reads", () => {
  const staged = stagedQuotaRouterConfig("quota_aware");
  const restage: Omit<RouterConfigV2, "fingerprint"> = {
    ...staged.config,
    mode: "manual",
    policy: null,
    generation: staged.config.generation + 1,
    primaryOpaqueAccountId: staged.accounts[1],
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
  const manual = { ...restage, fingerprint: routerConfigFingerprint(restage) };
  writePrivate(staged.configPath, JSON.stringify(manual));
  const calls: Array<{ command: string; args: unknown }> = [];
  const childProcess: MutableChildProcessModule = { spawn: (command, args) => {
    calls.push({ command, args });
    return {} as ChildProcess;
  } };
  const muxEntrypoint = "/private/runtime/account-router/app-server-mux.js";
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/Applications/ChatGPT.app/Contents/Resources",
    platform: "darwin",
    pathExists: (path) => path.endsWith("/cua_node/bin/node") || path === muxEntrypoint,
    accountRouter: { configPath: staged.configPath, runtimeEntrypointPath: muxEntrypoint, pathExists: (path) => path === muxEntrypoint || path === staged.configPath },
  });
  childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
  assert.deepEqual(calls[0]?.args, buildAccountRouterMuxArgs(muxEntrypoint, staged.configPath, "/usr/local/bin/codex", ["app-server"]));
  installation.uninstall();
});

test("parent keeps direct startup for v1 and every invalid adoption receipt", () => {
  const directArgs = ["-e", CODEX_APP_SERVER_PARENT_SOURCE, "--", "/usr/local/bin/codex", "app-server"];
  for (const tamper of [false, true]) {
    const staged = tamper ? stagedQuotaRouterConfig() : stagedRouterConfig();
    if (tamper) writePrivate(join(staged.root, "tweak-data", "co.tweakers.account-switcher", "history-adoption-receipt.v1.json"), "{}");
    const calls: Array<{ command: string; args: unknown }> = [];
    const childProcess: MutableChildProcessModule = { spawn: (command, args) => {
      calls.push({ command, args });
      return {} as ChildProcess;
    } };
    const installation = installCodexAppServerParent({
      childProcess,
      resourcesPath: "/Applications/ChatGPT.app/Contents/Resources",
      platform: "darwin",
      pathExists: () => true,
      accountRouter: { configPath: staged.configPath, runtimeEntrypointPath: "/mux.js", pathExists: () => true },
    });
    childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
    assert.deepEqual(calls[0]?.args, directArgs);
    installation.uninstall();
  }
});

test("parent retains direct startup when an old router state does not match a staged v2 candidate", () => {
  const staged = stagedQuotaRouterConfig();
  const legacy: RouterConfig = {
    schemaVersion: 1, mode: "balanced", protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: staged.accounts[0],
    accounts: [
      { opaqueAccountId: staged.accounts[0], included: true, weight: 2, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
      { opaqueAccountId: staged.accounts[1], included: true, weight: 3, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
    ], updatedAt: "2026-08-19T12:00:00Z",
  };
  writePrivate(join(staged.root, "tweak-data", "co.tweakers.account-switcher", "router-state.json"), JSON.stringify(createInitialRouterState(legacy)));
  const calls: Array<{ command: string; args: unknown }> = [];
  const original: SpawnFunction = (command, args) => {
    calls.push({ command, args });
    return {} as ChildProcess;
  };
  const childProcess: MutableChildProcessModule = { spawn: original };
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/Applications/ChatGPT.app/Contents/Resources",
    platform: "darwin",
    pathExists: () => true,
    accountRouter: { configPath: staged.configPath, runtimeEntrypointPath: "/mux.js", pathExists: () => true },
  });
  childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
  assert.deepEqual(calls[0]?.args, ["-e", CODEX_APP_SERVER_PARENT_SOURCE, "--", "/usr/local/bin/codex", "app-server"]);
  installation.uninstall();
});

test("parent preserves direct parent args when staged router preflight is incomplete", () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const original: SpawnFunction = (command, args) => {
    calls.push({ command, args });
    return {} as ChildProcess;
  };
  const childProcess: MutableChildProcessModule = { spawn: original };
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/present",
    platform: "darwin",
    pathExists: () => true,
    accountRouter: { configPath: "/missing/account-router-config.json", runtimeEntrypointPath: "/mux.js", pathExists: () => false },
  });
  childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
  assert.deepEqual(calls[0]?.args, ["-e", CODEX_APP_SERVER_PARENT_SOURCE, "--", "/usr/local/bin/codex", "app-server"]);
  installation.uninstall();
});
