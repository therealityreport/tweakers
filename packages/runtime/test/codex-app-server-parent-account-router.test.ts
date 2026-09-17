import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  buildAccountRouterMuxArgs,
  buildAccountsBrokerAppServerArgs,
  buildAccountsBrokerBlockedArgs,
  ACCOUNTS_BROKER_IDENTITY_FD_ENV,
  ACCOUNTS_BROKER_IDENTITY_TIMEOUT_MS,
  CODEX_APP_SERVER_PARENT_SOURCE,
  installCodexAppServerParent,
  resolveAccountsAuthorityMode,
  type MutableChildProcessModule,
  type SpawnFunction,
} from "../src/codex-app-server-parent";
import {
  ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY,
  ACCOUNT_ROUTER_SHARED_PLUGINS_MANIFEST_FILE,
  ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY,
  ACCOUNT_ROUTER_SHARED_SKILLS_MANIFEST_FILE,
  materializeSharedPluginsIntoAccount,
  materializeSharedSkillsIntoAccount,
  sharedPluginsManifestForSource,
  sharedSkillsManifestForSource,
} from "../src/account-router/app-server-mux";
import { resolveAccountsBrokerRootResolution } from "../src/account-router/broker-socket";
import { routerConfigFingerprint } from "../src/account-router/config";
import { createInitialRouterState } from "../src/account-router/state-store";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfig, type RouterConfigV2, type RouterConfigV3 } from "../src/account-router/types";
import { publishHistoryAdoptionEvidence } from "./account-router/history-adoption-fixtures";
import { readBrokerDesktopIdentityBootstrap } from "../src/account-router/broker-app-server";

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

function stagedBrokerConfig(): { root: string; configPath: string; accounts: [`ar_${string}`, `ar_${string}`]; config: RouterConfigV3 } {
  const staged = stagedRouterConfig();
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    schemaVersion: 3,
    mode: "quota_aware",
    policy: "quota_aware_v2",
    generation: 2,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: staged.accounts[0],
    accounts: [
      { opaqueAccountId: staged.accounts[0], included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}`, label: "Account 1" },
      { opaqueAccountId: staged.accounts[1], included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}`, label: "Account 2" },
    ],
    updatedAt: "2026-09-02T12:00:00.000Z",
  };
  const config = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  writePrivate(staged.configPath, JSON.stringify(config));
  publishHistoryAdoptionEvidence({
    root: dirname(staged.configPath),
    config,
    secret: Buffer.alloc(32, 3),
  });
  installBrokerSharedDefinitions(dirname(staged.configPath), staged.accounts);
  return { ...staged, config };
}

function installBrokerSharedDefinitions(
  stateRoot: string,
  accounts: readonly `ar_${string}`[],
): void {
  const skillsRoot = join(stateRoot, ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY);
  const skillDirectory = join(skillsRoot, "fixture");
  const skillFile = join(skillDirectory, "SKILL.md");
  mkdirSync(skillDirectory, { recursive: true, mode: 0o700 });
  writePrivate(skillFile, "fixture shared skill\n");
  const skillsManifest = sharedSkillsManifestForSource(skillsRoot, []);
  assert.ok(skillsManifest, "fixture shared Skills source must validate before sealing");
  writePrivate(join(stateRoot, ACCOUNT_ROUTER_SHARED_SKILLS_MANIFEST_FILE), `${JSON.stringify(skillsManifest)}\n`);
  chmodSync(skillFile, 0o400);
  chmodSync(skillDirectory, 0o500);
  chmodSync(skillsRoot, 0o500);

  const pluginsRoot = join(stateRoot, ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY);
  const pluginsCache = join(pluginsRoot, "cache");
  const registryRoot = join(pluginsCache, "fixture-registry");
  const packageNameRoot = join(registryRoot, "fixture-plugin");
  const packageRoot = join(packageNameRoot, "0.1.0");
  const packageFile = join(packageRoot, "package.json");
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  writePrivate(packageFile, '{"name":"fixture-plugin"}\n');
  const pluginsManifest = sharedPluginsManifestForSource(pluginsRoot);
  assert.ok(pluginsManifest, "fixture shared plugin source must validate before sealing");
  writePrivate(join(stateRoot, ACCOUNT_ROUTER_SHARED_PLUGINS_MANIFEST_FILE), `${JSON.stringify(pluginsManifest)}\n`);
  chmodSync(packageFile, 0o400);
  for (const directory of [packageRoot, packageNameRoot, registryRoot, pluginsCache, pluginsRoot]) chmodSync(directory, 0o500);

  for (const account of accounts) {
    const codexHome = join(stateRoot, "accounts", account, "codex-home");
    assert.equal(materializeSharedSkillsIntoAccount(stateRoot, codexHome), true);
    assert.equal(materializeSharedPluginsIntoAccount(stateRoot, codexHome), true);
  }
}

test("Accounts authority projection preserves only an absent-global, preflight-safe local legacy selection", () => {
  const localV1 = stagedRouterConfig();
  const localV2 = stagedQuotaRouterConfig();
  const unsafeLocalV2 = stagedRouterConfig();
  writePrivate(unsafeLocalV2.configPath, JSON.stringify(localV2.config));
  const globalV3 = stagedBrokerConfig();
  const missingGlobalRoot = join(localV1.root, "missing-global-broker");

  assert.equal(resolveAccountsAuthorityMode({
    configPath: localV1.configPath,
    brokerRoot: missingGlobalRoot,
  }), "legacy", "a valid local v1 direct selection remains legacy only when global is absent");
  assert.equal(resolveAccountsAuthorityMode({
    configPath: localV2.configPath,
    brokerRoot: missingGlobalRoot,
  }), "legacy", "a valid local v2 selection requires and passes its launch preflight");
  assert.equal(resolveAccountsAuthorityMode({
    configPath: unsafeLocalV2.configPath,
    brokerRoot: missingGlobalRoot,
  }), "blocked", "a local v2 selection that fails preflight cannot expose legacy writers");
  assert.equal(resolveAccountsAuthorityMode({
    configPath: localV1.configPath,
    brokerRoot: dirname(globalV3.configPath),
  }), "global-v3", "a valid global v3 publication remains authoritative without probing its socket");
  assert.equal(resolveAccountsAuthorityMode({
    configPath: localV2.configPath,
    brokerRoot: dirname(localV1.configPath),
  }), "blocked", "a present global v1 file never falls back to local v2");
  assert.equal(resolveAccountsAuthorityMode({
    configPath: globalV3.configPath,
    brokerRoot: missingGlobalRoot,
  }), "blocked", "a local v3 file without the global rendezvous root is never legacy");
  assert.equal(resolveAccountsAuthorityMode({
    configPath: localV1.configPath,
    brokerRoot: null,
    brokerRootConfigured: true,
  }), "blocked", "an invalid configured global root is not treated as absent");

  const unsupportedGlobal = {
    ...globalV3.config,
    protocolFingerprint: `sha256:${"0".repeat(64)}`,
  };
  for (const [name, contents] of [
    ["malformed", "{"],
    ["v1", readFileSync(localV1.configPath, "utf8")],
    ["v2", JSON.stringify(localV2.config)],
    ["unsupported", JSON.stringify(unsupportedGlobal)],
  ] as const) {
    const brokerRoot = join(localV1.root, `blocked-global-${name}`);
    mkdirSync(brokerRoot, { recursive: true, mode: 0o700 });
    writePrivate(join(brokerRoot, "account-router-config.json"), contents);
    assert.equal(resolveAccountsAuthorityMode({
      configPath: localV2.configPath,
      brokerRoot,
    }), "blocked", `a present ${name} manager-global config must not permit a local fallback`);
  }

  const unreadableBrokerRoot = join(localV1.root, "blocked-global-unreadable");
  const unreadableGlobalConfig = join(unreadableBrokerRoot, "account-router-config.json");
  mkdirSync(unreadableBrokerRoot, { recursive: true, mode: 0o700 });
  writePrivate(unreadableGlobalConfig, JSON.stringify(globalV3.config));
  assert.equal(resolveAccountsAuthorityMode({
    configPath: localV2.configPath,
    brokerRoot: unreadableBrokerRoot,
    readFile: (path, encoding) => {
      if (path === unreadableGlobalConfig) throw new Error("test unreadable manager-global config");
      return readFileSync(path, encoding);
    },
  }), "blocked", "an unreadable manager-global config must not permit a local fallback");
});

test("an explicitly invalid or conflicting global root blocks parent launch before local v2 selection", () => {
  const staged = stagedQuotaRouterConfig();
  const canonicalRoot = join(staged.root, "manager-global-broker");
  const muxEntrypoint = "/private/runtime/account-router/app-server-mux.js";
  for (const [name, environment] of [
    ["empty", { TWEAKERS_ACCOUNTS_BROKER_ROOT: "" }],
    ["compatibility-empty", { TWEAKER_ACCOUNTS_BROKER_ROOT: "" }],
    ["relative", { TWEAKERS_ACCOUNTS_BROKER_ROOT: "manager-global-broker" }],
    ["noncanonical", { TWEAKERS_ACCOUNTS_BROKER_ROOT: `${canonicalRoot}/.` }],
    ["conflicting-aliases", {
      TWEAKERS_ACCOUNTS_BROKER_ROOT: canonicalRoot,
      TWEAKER_ACCOUNTS_BROKER_ROOT: `${canonicalRoot}-other`,
    }],
    ["invalid-primary-valid-compatibility", {
      TWEAKERS_ACCOUNTS_BROKER_ROOT: "manager-global-broker",
      TWEAKER_ACCOUNTS_BROKER_ROOT: canonicalRoot,
    }],
    ["valid-primary-invalid-compatibility", {
      TWEAKERS_ACCOUNTS_BROKER_ROOT: canonicalRoot,
      TWEAKER_ACCOUNTS_BROKER_ROOT: "manager-global-broker",
    }],
  ] as const) {
    const resolution = resolveAccountsBrokerRootResolution({
      userRoot: staged.root,
      derivedVariant: false,
      environment,
    });
    assert.deepEqual(resolution, { root: null, configured: true }, name);

    const calls: Array<{ command: string; args: unknown }> = [];
    const childProcess: MutableChildProcessModule = { spawn: ((command, args) => {
      calls.push({ command, args });
      return {} as ChildProcess;
    }) as SpawnFunction };
    const installation = installCodexAppServerParent({
      childProcess,
      resourcesPath: "/Applications/ChatGPT.app/Contents/Resources",
      platform: "darwin",
      pathExists: (path) => path.endsWith("/cua_node/bin/node") || path === muxEntrypoint,
      accountRouter: {
        configPath: staged.configPath,
        brokerRoot: resolution.root,
        brokerRootConfigured: resolution.configured,
        runtimeEntrypointPath: muxEntrypoint,
        pathExists: () => assert.fail(`${name}: parent must block before reading local config`),
        readFile: () => assert.fail(`${name}: parent must block before reading local config`),
      },
    });
    childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
    assert.deepEqual(calls[0]?.args, buildAccountsBrokerBlockedArgs(), name);
    assert.doesNotMatch(JSON.stringify(calls[0]?.args), /app-server-mux|CODEX_APP_SERVER_PARENT_SOURCE/, name);
    installation.uninstall();
  }
});

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

test("v3 selects the shared broker client, disables remote control, and never passes shared SQLite", () => {
  const staged = stagedBrokerConfig();
  const brokerRoot = dirname(staged.configPath);
  const rootResolution = resolveAccountsBrokerRootResolution({
    userRoot: staged.root,
    derivedVariant: true,
    environment: {
      TWEAKERS_ACCOUNTS_BROKER_ROOT: brokerRoot,
      TWEAKER_ACCOUNTS_BROKER_ROOT: brokerRoot,
    },
  });
  assert.deepEqual(rootResolution, { root: brokerRoot, configured: true });
  const calls: Array<{ command: string; args: unknown; options: unknown }> = [];
  const childProcess: MutableChildProcessModule = { spawn: ((command, args, options) => {
    calls.push({ command, args, options });
    return {} as ChildProcess;
  }) as SpawnFunction };
  const brokerEntrypoint = "/private/runtime/account-router/broker-app-server.js";
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/Applications/Tweakers.app/Contents/Resources",
    platform: "darwin",
    pathExists: (path) => path.endsWith("/cua_node/bin/node") || path === brokerEntrypoint || path === staged.configPath,
    secondaryVariant: true,
    secondaryVariantSharedSqliteHome: "/must-not-pass/sqlite",
    accountRouter: {
      configPath: staged.configPath,
      brokerRoot: rootResolution.root,
      brokerRootConfigured: rootResolution.configured,
      brokerEntrypointPath: brokerEntrypoint,
      pathExists: (path) => path === brokerEntrypoint || path === staged.configPath,
      resolveBrokerDesktopIdentity: () => ({ rendererRef: `br_${"a".repeat(43)}`, appToolsRef: `bat_${"b".repeat(43)}` }),
    },
  });
  childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
  assert.deepEqual(calls[0]?.args, buildAccountsBrokerAppServerArgs(brokerEntrypoint, staged.configPath, "/usr/local/bin/codex", ["app-server"]));
  assert.doesNotMatch(JSON.stringify(calls[0]?.args), /shared-sqlite-home/);
  assert.equal((calls[0]?.options as { env?: Record<string, string> }).env?.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, "1");
  assert.equal((calls[0]?.options as { stdio?: unknown }).stdio, "pipe", "an existing renderer uses the original three stdio pipes");
  assert.equal((calls[0]?.options as { env?: Record<string, string> }).env?.TWEAKERS_ACCOUNTS_BROKER_RENDERER_REF, `br_${"a".repeat(43)}`);
  assert.equal((calls[0]?.options as { env?: Record<string, string> }).env?.[ACCOUNTS_BROKER_IDENTITY_FD_ENV], undefined);
  installation.uninstall();
});

test("v3 private identity bootstrap waits for an owned renderer and cleans up every terminal path", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const staged = stagedBrokerConfig();
  const identity = { rendererRef: `br_${"a".repeat(43)}`, appToolsRef: `bat_${"b".repeat(43)}` };
  for (const outcome of ["ready", "exit", "error", "timeout"] as const) {
    const pipe = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, pipe] }) as unknown as ChildProcess;
    let current: typeof identity | null = null;
    let resolutions = 0;
    let options: any;
    const childProcess: MutableChildProcessModule = { spawn: ((_command, _args, value) => { options = value; return child; }) as SpawnFunction };
    const installation = installCodexAppServerParent({
      childProcess, resourcesPath: "/present", platform: "darwin", pathExists: () => true,
      accountRouter: { brokerRoot: dirname(staged.configPath), configPath: staged.configPath,
        resolveBrokerDesktopIdentity: () => { resolutions += 1; return current; } },
    });
    try {
      childProcess.spawn("codex", ["app-server"], { stdio: ["pipe", "inherit", "pipe"], env: {
        TWEAKERS_ACCOUNTS_BROKER_RENDERER_REF: identity.rendererRef,
        TWEAKERS_ACCOUNTS_BROKER_APP_TOOLS_REF: identity.appToolsRef,
      } });
      assert.deepEqual(options.stdio, ["pipe", "inherit", "pipe", "pipe"]);
      assert.equal(options.env[ACCOUNTS_BROKER_IDENTITY_FD_ENV], "3");
      assert.equal(options.env.TWEAKERS_ACCOUNTS_BROKER_RENDERER_REF, undefined, "inherited refs cannot substitute for main ownership");
      assert.equal(pipe.read(), null);
      if (outcome === "ready") {
        current = identity;
        t.mock.timers.tick(25);
        assert.equal(pipe.writableEnded, true);
        assert.deepEqual(JSON.parse(pipe.read().toString()), identity);
      } else if (outcome === "timeout") t.mock.timers.tick(ACCOUNTS_BROKER_IDENTITY_TIMEOUT_MS);
      else child.emit(outcome, outcome === "error" ? new Error("fixture") : 1);
      if (outcome !== "ready") assert.equal(pipe.destroyed, true);
      const after = resolutions;
      t.mock.timers.tick(ACCOUNTS_BROKER_IDENTITY_TIMEOUT_MS);
      assert.equal(resolutions, after, "terminal bootstrap must stop polling");
    } finally { pipe.destroy(); installation.uninstall(); }
  }
});

test("broker identity reader accepts only a complete bounded frame and closes on failure", async () => {
  const identity = { rendererRef: `br_${"a".repeat(43)}`, appToolsRef: `bat_${"b".repeat(43)}` };
  const input = new PassThrough();
  const ready = readBrokerDesktopIdentityBootstrap(input);
  input.write(JSON.stringify(identity).slice(0, 15));
  input.end(JSON.stringify(identity).slice(15));
  assert.deepEqual(await ready, identity);
  assert.equal(input.destroyed, true);
  for (const invalid of ["{}", JSON.stringify({ ...identity, appToolsRef: "invalid" }), "x".repeat(1025), `${JSON.stringify(identity)}\n${JSON.stringify(identity)}`]) {
    const stream = new PassThrough();
    const rejected = assert.rejects(readBrokerDesktopIdentityBootstrap(stream), /identity bootstrap unavailable/);
    stream.end(invalid);
    await rejected;
    assert.equal(stream.destroyed, true);
  }
  for (const failure of ["timeout", "close", "error"] as const) {
    const stream = new PassThrough();
    const rejected = assert.rejects(readBrokerDesktopIdentityBootstrap(stream, 10), /identity bootstrap unavailable/);
    if (failure === "close") stream.destroy();
    if (failure === "error") stream.destroy(new Error("private fixture detail"));
    await rejected;
    assert.equal(stream.destroyed, true);
  }
});

test("v3 broker preflight failures are blocked rather than routed direct", () => {
  const staged = stagedBrokerConfig();
  writePrivate(join(dirname(staged.configPath), "history-adoption-receipt.v1.json"), "{}");
  const calls: Array<{ command: string; args: unknown }> = [];
  const childProcess: MutableChildProcessModule = { spawn: ((command, args) => {
    calls.push({ command, args });
    return {} as ChildProcess;
  }) as SpawnFunction };
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/Applications/ChatGPT.app/Contents/Resources",
    platform: "darwin",
    pathExists: () => true,
    accountRouter: {
      configPath: staged.configPath,
      brokerRoot: dirname(staged.configPath),
      brokerEntrypointPath: "/broker-app-server.js",
      pathExists: () => true,
    },
  });
  childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
  assert.deepEqual(calls[0]?.args, buildAccountsBrokerBlockedArgs("history_adoption_invalid"));
  assert.doesNotMatch(JSON.stringify(calls[0]?.args), /CODEX_APP_SERVER_PARENT_SOURCE/);
  installation.uninstall();
});

test("a present global broker config blocks malformed, incompatible, and unreadable v3 publication states", () => {
  const legacy = stagedRouterConfig();
  for (const [name, contents] of [
    ["malformed", "{"],
    ["schema-v1", readFileSync(legacy.configPath, "utf8")],
    ["schema-v2", JSON.stringify(stagedQuotaRouterConfig().config)],
    ["unreadable", null],
  ] as const) {
    const staged = stagedQuotaRouterConfig();
    const brokerRoot = join(staged.root, `global-broker-${name}`);
    const brokerConfigPath = join(brokerRoot, "account-router-config.json");
    mkdirSync(brokerRoot, { recursive: true, mode: 0o700 });
    if (contents !== null) writePrivate(brokerConfigPath, contents);

    const calls: Array<{ command: string; args: unknown }> = [];
    const childProcess: MutableChildProcessModule = { spawn: ((command, args) => {
      calls.push({ command, args });
      return {} as ChildProcess;
    }) as SpawnFunction };
    const muxEntrypoint = "/private/runtime/account-router/app-server-mux.js";
    const installation = installCodexAppServerParent({
      childProcess,
      resourcesPath: "/Applications/ChatGPT.app/Contents/Resources",
      platform: "darwin",
      pathExists: (path) => path.endsWith("/cua_node/bin/node") || path === muxEntrypoint,
      accountRouter: {
        configPath: staged.configPath,
        brokerRoot,
        runtimeEntrypointPath: muxEntrypoint,
        pathExists: (path) => path === staged.configPath || path === brokerConfigPath || path === muxEntrypoint,
        ...(contents === null ? {
          readFile: (path: string, encoding: BufferEncoding) => {
            if (path === brokerConfigPath) throw new Error("test unreadable global broker config");
            return readFileSync(path, encoding);
          },
        } : {}),
      },
    });
    childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
    assert.deepEqual(calls[0]?.args, buildAccountsBrokerBlockedArgs(), name);
    assert.doesNotMatch(JSON.stringify(calls[0]?.args), /app-server-mux|CODEX_APP_SERVER_PARENT_SOURCE/, name);
    installation.uninstall();
  }
});

test("an absent global broker config preserves validated local v2 mux startup", () => {
  const staged = stagedQuotaRouterConfig();
  const brokerRoot = join(staged.root, "absent-global-broker");
  const brokerConfigPath = join(brokerRoot, "account-router-config.json");
  const calls: Array<{ command: string; args: unknown }> = [];
  const childProcess: MutableChildProcessModule = { spawn: ((command, args) => {
    calls.push({ command, args });
    return {} as ChildProcess;
  }) as SpawnFunction };
  const muxEntrypoint = "/private/runtime/account-router/app-server-mux.js";
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/Applications/ChatGPT.app/Contents/Resources",
    platform: "darwin",
    pathExists: (path) => path.endsWith("/cua_node/bin/node") || path === muxEntrypoint,
    accountRouter: {
      configPath: staged.configPath,
      brokerRoot,
      brokerRootConfigured: true,
      runtimeEntrypointPath: muxEntrypoint,
      pathExists: (path) => path === staged.configPath || path === muxEntrypoint,
    },
  });
  childProcess.spawn("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" });
  assert.deepEqual(calls[0]?.args, buildAccountRouterMuxArgs(muxEntrypoint, staged.configPath, "/usr/local/bin/codex", ["app-server"]));
  installation.uninstall();
});

test("secondary variant passes shared task storage only to the mux and filters inherited plugins", () => {
  const staged = stagedQuotaRouterConfig();
  const calls: Array<{ command: string; args: unknown }> = [];
  const childProcess: MutableChildProcessModule = { spawn: ((command, args) => {
    calls.push({ command, args });
    return {} as ChildProcess;
  }) as SpawnFunction };
  const muxEntrypoint = "/private/runtime/account-router/app-server-mux.js";
  const shared = "/Users/test/.codex";
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/Applications/Tweakers.app/Contents/Resources",
    platform: "darwin",
    pathExists: (path) => path.endsWith("/cua_node/bin/node") || path === muxEntrypoint,
    secondaryVariant: true,
    secondaryVariantSharedSqliteHome: shared,
    accountRouter: {
      configPath: staged.configPath,
      runtimeEntrypointPath: muxEntrypoint,
      pathExists: (path) => path === muxEntrypoint || path === staged.configPath,
    },
  });
  childProcess.spawn("/usr/local/bin/codex", [
    "app-server",
    "-c", "mcp_servers.codex_app={command=\"app-tools\"}",
    "-c", "plugins.\"shadcn@local\".enabled=true",
  ], { stdio: "pipe" });
  assert.deepEqual(calls[0]?.args, buildAccountRouterMuxArgs(
    muxEntrypoint,
    staged.configPath,
    "/usr/local/bin/codex",
    ["app-server", "-c", "mcp_servers.codex_app={command=\"app-tools\"}"],
    shared,
  ));
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
