import assert from "node:assert/strict";
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
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT } from "../src/account-router/types";

const accountA = `ar_${"A".repeat(43)}`;
const accountB = `ar_${"B".repeat(43)}`;

function writePrivate(path: string, contents: string | Buffer): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function stagedRouterConfig(): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), "account-router-parent-"));
  const data = join(root, "tweak-data", "co.tweakers.account-switcher");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  for (const account of [accountA, accountB]) {
    mkdirSync(join(data, "accounts", account, "codex-home"), { recursive: true, mode: 0o700 });
    mkdirSync(join(data, "accounts", account, "sqlite-home"), { recursive: true, mode: 0o700 });
  }
  writePrivate(join(data, "control-secret.v1"), Buffer.alloc(32, 3));
  const configPath = join(data, "account-router-config.json");
  writePrivate(configPath, JSON.stringify({
    schemaVersion: 1,
    mode: "balanced",
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: accountA,
    accounts: [
      { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
      { opaqueAccountId: accountB, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
    ],
    updatedAt: "2026-08-19T12:00:00Z",
  }));
  return { root, configPath };
}

test("parent selects mux only after a private, complete staged router preflight", () => {
  const staged = stagedRouterConfig();
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
