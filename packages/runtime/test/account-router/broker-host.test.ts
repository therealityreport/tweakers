import { prepareSharedNativeModeV1, publishSharedNativeModeV1 } from "../../src/account-router/shared-native-mode";
import { readAndPreflightNativeHistorySourceStaticV1 } from "../../src/account-router/native-history";
import { bootstrapAccountContinuity, DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, prepareAccountConfigBeforeSpawn, loadSharedAccountBase } from "../../src/account-router/account-continuity";
import { AccountsPreferencesStore } from "../../src/account-router/preferences";
import { AccountModelCatalogsV1, requestedModelFromParamsV1 } from "../../src/account-router/models";
import { installCodexAppServerParent, type MutableChildProcessModule, type SpawnFunction } from "../../src/codex-app-server-parent";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { connectAccountsBrokerForStartup } from "../../src/account-router/broker-app-server";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES, ACCOUNTS_BROKER_APP_SERVER_SOCKET_FILE, createBrokerStartupDiagnostics, AccountsBrokerOwnerV1, BrokerProcessChild, credentialStoreArgs, connectAccountsBrokerAppServerClient, type EnrollmentMaterializationFaultPointV1 } from "../../src/account-router/broker-host";
import { createOpaqueAppToolsRef, createOpaqueRendererRef, type BrokerDesktopIdentityBindingV1 } from "../../src/account-router/broker";
import { AccountsBrokerSocketClientV1, accountsBrokerSocketPath } from "../../src/account-router/broker-socket";
import { CanonicalHistoryStoreV1 } from "../../src/account-router/canonical-history";
import { routerConfigFingerprint } from "../../src/account-router/config";
import { nativeHistoryAccountSetFingerprintV1, nativeHistoryAuthIdentityHmacV1, signNativeHistorySourceV1, type NativeHistoryDirectoryIdentityV1, type NativeHistorySourceUnsignedV1 } from "../../src/account-router/native-history";
import {
  ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY,
  ACCOUNT_ROUTER_SHARED_SKILLS_MANIFEST_FILE,
  ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY,
  ACCOUNT_ROUTER_SHARED_PLUGINS_MANIFEST_FILE,
  materializeSharedPluginsIntoAccount,
  materializeSharedSkillsIntoAccount,
  preflightRouterHomes,
  sharedSkillsManifestForSource,
  sharedPluginsManifestForSource,
} from "../../src/account-router/app-server-mux";
import { RouterStateStore } from "../../src/account-router/state-store";
import { parseNativeBrowserChildRequestV1, parseNativeRequestV1 } from "../../src/account-router/native-request";
import type { AccountsBrokerV1 } from "../../src/account-router/broker";
import {
  ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
  type BrokerEventV1,
  type JsonRpcMessage,
  type OpaqueAccountId,
  type OpaqueAppToolsRef,
  type OpaqueConnectionDefinitionRef,
  type OpaqueRendererRef,
  type RouterConfigV3,
} from "../../src/account-router/types";
import { publishHistoryAdoptionEvidence } from "./history-adoption-fixtures";

test("broker fatal diagnostics preserve process failure and exclude sensitive error content", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "broker-fatal-diagnostic-")));
  chmodSync(root, 0o700);
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const { installBrokerTerminationDiagnostics } = require(process.argv[1]);
    installBrokerTerminationDiagnostics(process.argv[2]);
    const error = new TypeError('private-account-token');
    error.stack = 'TypeError: private-account-token /account-router/ledger.js:2:3\\n    at fail (/private/home/runtime/account-router/private-account-token.js:1:1)\\n    at fail (/private/home/runtime/account-router/broker-host.js:716:21)';
    setImmediate(() => { throw error; });
  `, join(__dirname, "../../src/account-router/broker-host.ts"), root], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 1);
  assert.equal(child.signal, null);
  const files = readdirSync(root);
  assert.equal(files.length, 1);
  const bytes = readFileSync(join(root, files[0]!), "utf8");
  assert.equal(bytes.includes("private-account-token"), false);
  assert.equal(bytes.includes("/private/home"), false);
  assert.equal(lstatSync(join(root, files[0]!)).mode & 0o777, 0o600);
  const diagnostic = JSON.parse(bytes);
  assert.equal(diagnostic.kind, "uncaught_exception");
  assert.equal(diagnostic.errorName, "TypeError");
  assert.deepEqual(diagnostic.locations, [{ module: "broker-host", line: 716, column: 21 }]);
});

test("startup diagnostics retain only bounded stage codes and timings", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "broker-startup-diagnostic-")));
  chmodSync(root, 0o700);
  const record = createBrokerStartupDiagnostics(root);
  record({ stage: "probe", code: "private-secret", elapsedMs: 1 } as any);
  for (let index = 0; index < 20; index += 1) record({ stage: "probe", code: "probe_timeout", elapsedMs: index, secret: "private-secret" } as any);
  const files = readdirSync(root);
  assert.equal(files.length, 1);
  const bytes = readFileSync(join(root, files[0]!), "utf8");
  assert.equal(bytes.includes("private-secret"), false);
  assert.equal(JSON.parse(bytes).events.length, 16);
  assert.equal(lstatSync(join(root, files[0]!)).mode & 0o777, 0o600);
});

test("startup connection retries stop at the remaining deadline and bound a stalled handshake", async () => {
  for (const stalled of [false, true]) {
    const fixture = createFixture();
    const sockets = new Set<Socket>();
    const server = createServer(socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
    if (stalled) await new Promise<void>(resolvePromise => server.listen(accountsBrokerSocketPath(fixture.root, ACCOUNTS_BROKER_APP_SERVER_SOCKET_FILE), resolvePromise));
    let launches = 0;
    const binding = desktopBinding("tweakers", 959);
    const started = performance.now();
    try {
      const result = await connectAccountsBrokerForStartup({ root: fixture.root, secret: fixture.secret, clientKind: "tweakers",
        rendererRef: createOpaqueRendererRef(fixture.secret, 959, binding), appToolsRef: createOpaqueAppToolsRef(fixture.secret, 959, binding) },
      () => assert.fail("no native work may arrive before connection"), started + 150, () => { launches += 1; });
      assert.equal(result, null);
      assert.ok(performance.now() - started < 700, "a single pending handshake must not add its old five-second timeout");
      assert.equal(launches, stalled ? 0 : 1, "each bridge launches at most one owner contender");
    } finally {
      for (const socket of sockets) socket.destroy();
      if (stalled) await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    }
  }
});

test("model catalogs gate known native models while custom models and failed account catalogs remain eligible", async () => {
  const accounts = ["ar_model_a", "ar_model_b", "ar_model_c"] as OpaqueAccountId[];
  const calls = new Map<OpaqueAccountId, number>();
  const catalogs = new AccountModelCatalogsV1(async (account) => {
    calls.set(account, (calls.get(account) ?? 0) + 1);
    if (account === accounts[2]) throw new Error("fixture unavailable");
    return { data: account === accounts[0] ? [{ id: "native-a" }] : [{ slug: "native-b" }] };
  }, () => 1_000);
  const native = await catalogs.support("native-a", accounts);
  assert.equal(native.native, true);
  assert.deepEqual([...native.eligible], [accounts[0], accounts[2]]);
  assert.deepEqual([...native.unsupported], [accounts[1]]);
  const custom = await catalogs.support("custom-proxy-model", accounts);
  assert.equal(custom.native, false);
  assert.deepEqual([...custom.eligible], accounts);
  assert.deepEqual([...calls.values()], [1, 1, 1], "successful and failed catalogs share the ten-minute cache");
  assert.equal(requestedModelFromParamsV1({ model: "top-level" }), "top-level");
  assert.equal(requestedModelFromParamsV1({ config: { model: "nested" } }), null);
});

test("native HTTP requests use only the selected account credentials and fixed upstream origin", async () => {
  const fixture = createNativeFixture();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ accountScoped: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  try {
    await owner.start();
    const outcome = await (owner as any).dispatchDeviceAction({
      kind: "native.request",
      opaqueAccountId: fixture.accounts[1],
      surface: "plugins",
      method: "http.request",
      params: { verb: "POST", path: "/ps/plugins/{plugin_id}/install", options: {
        parameters: { path: { plugin_id: "fixture/plugin" }, query: { includeAppsNeedingAuth: true } },
        requestBody: { install_attempt_id: "attempt-1" },
      } },
    });
    assert.deepEqual(outcome, { outcome: "accepted", value: { accountScoped: true } });
    assert.equal(calls.length, 1, "mutating HTTP requests are dispatched exactly once");
    assert.equal(calls[0]!.url, "https://chatgpt.com/backend-api/ps/plugins/fixture%2Fplugin/install?includeAppsNeedingAuth=true");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer fixture-native-access-1");
    assert.equal(headers["chatgpt-account-id"], fixture.rawAccounts[1]);
    assert.equal(headers["OAI-Product-Sku"], "CODEX");
    assert.equal(calls[0]!.init.redirect, "manual");
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(new Uint8Array(4 * 1024 * 1024 + 1), { status: 200 });
    }) as typeof fetch;
    const oversized = await (owner as any).dispatchDeviceAction({
      kind: "native.request", opaqueAccountId: fixture.accounts[1], surface: "plugins", method: "http.request",
      params: { verb: "GET", path: "/ps/plugins/installed", options: { parameters: { query: {} } } },
    });
    assert.deepEqual(oversized, { outcome: "ambiguous" }, "an unbounded provider body is rejected without exposing it");
    assert.equal(calls.length, 2, "a rejected provider response is not retried");
  } finally {
    globalThis.fetch = originalFetch;
    await owner.close();
  }
});

test("plugins native skills/list accepts only bounded canonical cwd parameters and returns the selected child result", async () => {
  const fixture = createNativeFixture();
  const cwd = realpathSync(fixture.root);
  assert.deepEqual(parseNativeRequestV1({ surface: "plugins", method: "skills/list", params: { cwds: [cwd], forceReload: true } }),
    { surface: "plugins", method: "skills/list", params: { cwds: [cwd], forceReload: true } });
  assert.equal(parseNativeRequestV1({ surface: "apps", method: "skills/list", params: {} }), null);
  assert.equal(parseNativeRequestV1({ surface: "plugins", method: "skills/list", params: { cwds: [join(cwd, "missing")] } }), null);
  assert.equal(parseNativeRequestV1({ surface: "plugins", method: "skills/list", params: { cwds: Array(65).fill(cwd) } }), null);
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const host = owner as any;
  let desktop: DesktopClient | null = null;
  try {
    await owner.start();
    desktop = await connectDesktop(fixture, 77, "tweakers");
    const context = await host.resolveNativeBrowserContext(desktop.rendererRef, fixture.accounts[1]);
    assert.equal(context.status, "ready");
    assert.equal(context.opaqueAccountId, fixture.accounts[1]);
    assert.equal(context.appServerVersion, "0.153.4-alpha.1+build.7");
    const outcome = await (owner as any).dispatchDeviceAction({ kind: "native.request", opaqueAccountId: fixture.accounts[1],
      surface: "plugins", method: "skills/list", params: { cwds: [cwd], forceReload: true } });
    assert.deepEqual(outcome, { outcome: "accepted", value: { ok: true } });
    assert.deepEqual(parseNativeBrowserChildRequestV1("plugin/list", { marketplaceKinds: ["local"] }),
      { method: "plugin/list", params: { marketplaceKinds: ["local"] } });
    assert.equal(parseNativeBrowserChildRequestV1("plugin/list", { marketplaceKinds: ["remote"] }), null);
    const browserEdits = ["mcp_servers.node_repl", "mcp_servers.computer-use", "mcp_servers.cua_repl"].map((keyPath) =>
      ({ keyPath, value: { command: "fixture" }, mergeStrategy: "replace" })).concat([
        { keyPath: "shell_environment_policy.set.BROWSER_USE_AVAILABLE_BACKENDS", value: null, mergeStrategy: "replace" },
        { keyPath: "shell_environment_policy.set.NODE_REPL_TRUSTED_CODE_PATHS", value: null, mergeStrategy: "replace" },
      ]);
    assert.ok(parseNativeBrowserChildRequestV1("config/batchWrite", { edits: browserEdits, expectedVersion: null, filePath: null, reloadUserConfig: false }));
    assert.equal(parseNativeBrowserChildRequestV1("config/batchWrite", { edits: browserEdits.slice(1), expectedVersion: null, filePath: null, reloadUserConfig: false }), null);
    assert.deepEqual(await host.invokeNativeBrowserRequest(desktop.rendererRef, fixture.accounts[1], "plugin/list", { marketplaceKinds: ["local"] }), { ok: true });
  } finally { desktop?.close(); await owner.close(); }
});

interface Fixture {
  root: string;
  secret: Buffer;
  config: RouterConfigV3;
  accounts: OpaqueAccountId[];
  rawAccounts: string[];
}

interface DesktopClient {
  readonly messages: JsonRpcMessage[];
  readonly rendererRef: OpaqueRendererRef;
  readonly appToolsRef: OpaqueAppToolsRef;
  readonly send: (message: JsonRpcMessage) => boolean;
  readonly close: () => void;
  readonly whenClosed: Promise<void>;
}

function desktopBinding(clientKind: "chatgpt" | "tweakers", webContentsId: number, session = `fixture-session-${clientKind}-${webContentsId}`): BrokerDesktopIdentityBindingV1 {
  return {
    clientKind,
    bundleIdentity: clientKind === "chatgpt" ? "com.openai.chatgpt" : "co.tweakers.desktop",
    sessionNonce: session,
  };
}

function opaque(secret: Buffer, rawAccountId: string): OpaqueAccountId {
  return `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}` as OpaqueAccountId;
}

function privateWrite(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Exact shared-root mutation oracle for owner-election contention tests. */
function brokerRootArtifacts(root: string): Record<string, { bytes: number; digest: string; mode: number } | null> {
  const names = [
    "account-router-config.json",
    "router-state.json",
    "canonical-history.v1.json",
    "canonical-history.v1.journal.jsonl",
    "enrollment-materialization.v1.json",
  ];
  return Object.fromEntries(names.map((name) => {
    const path = join(root, name);
    if (!existsSync(path)) return [name, null];
    const stat = lstatSync(path);
    return [name, {
      bytes: stat.size,
      digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
      mode: stat.mode & 0o777,
    }];
  }));
}

function seedRecoverablePreparedTurn(fixture: Fixture): void {
  const history = new CanonicalHistoryStoreV1(
    fixture.root,
    Date.now,
    randomBytes,
    (nativeThreadId) => `lh_${createHmac("sha256", fixture.secret).update(`canonical-history:v1:${nativeThreadId}`, "utf8").digest("base64url")}`,
  );
  const renderer = createOpaqueRendererRef(fixture.secret, 997, desktopBinding("chatgpt", 997));
  const conversationId = history.createConversation({
    opaqueAccountId: fixture.accounts[0]!,
    nativeThreadId: "election-recovery-thread",
    ownerRendererRef: renderer,
    ownerLabel: "ChatGPT",
  });
  history.beginTurn(conversationId, fixture.accounts[0]!, "election-recovery-thread", renderer, "ChatGPT", { input: [{ type: "text", text: "recover exactly once" }] });
}

function createFixture(options: { accounts?: number; disabled?: readonly number[]; adoption?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "accounts-broker-host-"));
  chmodSync(root, 0o700);
  const secret = Buffer.alloc(32, 41);
  const rawAccounts = ["fixture-account-a", "fixture-account-b", "fixture-account-c"].slice(0, options.accounts ?? 2);
  const accounts = rawAccounts.map((raw) => opaque(secret, raw));
  const disabled = new Set(options.disabled ?? []);
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    schemaVersion: 3,
    mode: "quota_aware",
    policy: "quota_aware_v2",
    generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: accounts[0]!,
    accounts: accounts.map((account, index) => ({
      opaqueAccountId: account,
      included: !disabled.has(index),
      weight: 1,
      capabilityFingerprint: `sha256:${String.fromCharCode(97 + index).repeat(64)}` as `sha256:${string}`,
      label: `Account ${index + 1}`,
    })),
    updatedAt: "2026-09-02T12:00:00.000Z",
  };
  const config: RouterConfigV3 = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  privateWrite(join(root, "control-secret.v1"), secret);
  privateWrite(join(root, "account-router-config.json"), JSON.stringify(config));
  // Production startup is fail-closed when migration/bootstrap did not create
  // this file. The fixture performs that explicit empty-store bootstrap.
  privateWrite(join(root, "canonical-history.v1.json"), JSON.stringify({ version: 1, conversations: [] }));
  for (const [index, account] of accounts.entries()) {
    const codexHome = join(root, "accounts", account, "codex-home");
    const sqliteHome = join(root, "accounts", account, "sqlite-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
    privateWrite(join(codexHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: rawAccounts[index], refresh_token: "fixture-refresh-only" },
    }));
    privateWrite(join(codexHome, "config.toml"), "");
  }
  const sharedSkills = join(root, ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY);
  const sharedSkillDirectory = join(sharedSkills, "fixture");
  const sharedSkill = join(sharedSkillDirectory, "SKILL.md");
  mkdirSync(sharedSkillDirectory, { recursive: true, mode: 0o700 });
  privateWrite(sharedSkill, "fixture shared skill\n");
  const manifest = sharedSkillsManifestForSource(sharedSkills);
  assert.ok(manifest, "fixture shared Skills source must validate before sealing");
  privateWrite(join(root, ACCOUNT_ROUTER_SHARED_SKILLS_MANIFEST_FILE), JSON.stringify(manifest));
  chmodSync(sharedSkill, 0o400);
  chmodSync(sharedSkillDirectory, 0o500);
  chmodSync(sharedSkills, 0o500);
  for (const account of accounts) {
    assert.equal(materializeSharedSkillsIntoAccount(root, join(root, "accounts", account, "codex-home")), true);
  }
  const sharedPlugins = join(root, ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY);
  const sharedPluginRegistry = join(sharedPlugins, "cache", "fixture-registry");
  const sharedPluginNameRoot = join(sharedPluginRegistry, "fixture-plugin");
  const sharedPluginRoot = join(sharedPluginNameRoot, "0.1.0");
  mkdirSync(sharedPluginRoot, { recursive: true, mode: 0o700 });
  privateWrite(join(sharedPluginRoot, "package.json"), "{\"name\":\"fixture-plugin\"}\n");
  const pluginManifest = sharedPluginsManifestForSource(sharedPlugins);
  assert.ok(pluginManifest, "fixture shared plugin source must validate before sealing");
  privateWrite(join(root, ACCOUNT_ROUTER_SHARED_PLUGINS_MANIFEST_FILE), JSON.stringify(pluginManifest));
  chmodSync(join(sharedPluginRoot, "package.json"), 0o400);
  chmodSync(sharedPluginRoot, 0o500); chmodSync(sharedPluginNameRoot, 0o500); chmodSync(sharedPluginRegistry, 0o500); chmodSync(join(sharedPlugins, "cache"), 0o500); chmodSync(sharedPlugins, 0o500);
  for (const account of accounts) {
    assert.equal(materializeSharedPluginsIntoAccount(root, join(root, "accounts", account, "codex-home")), true);
  }
  // V3 preflight requires the completed adoption evidence copied by the
  // offline migration; the in-memory broker fixture creates the same bounded
  // proof explicitly before owner startup.
  publishHistoryAdoptionEvidence({ root, config, secret, threadIds: [] });
  return { root, secret, config, accounts, rawAccounts };
}

interface NativeFixture extends Fixture {
  homesRoot: string;
}

function nativeDirectoryIdentity(path: string): NativeHistoryDirectoryIdentityV1 {
  const stat = lstatSync(path);
  return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}

/** A sealed external source fixture: canonical store stays explicitly empty. */
function createNativeFixture(): NativeFixture {
  const fixture = createFixture();
  fixture.root = realpathSync(fixture.root);
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    ...fixture.config,
    mode: "manual",
    policy: null,
    primaryOpaqueAccountId: fixture.accounts[1]!,
    generation: fixture.config.generation + 1,
    updatedAt: "2026-09-05T12:00:00.000Z",
  };
  fixture.config = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  privateWrite(join(fixture.root, "account-router-config.json"), JSON.stringify(fixture.config));
  publishHistoryAdoptionEvidence({ root: fixture.root, config: fixture.config, secret: fixture.secret, threadIds: [] });
  const homesRoot = realpathSync(mkdtempSync(join(tmpdir(), "accounts-native-history-homes-")));
  chmodSync(homesRoot, 0o700);
  const accounts = fixture.accounts.map((opaqueAccountId, index) => {
    const codexHome = join(homesRoot, "accounts", opaqueAccountId, "codex-home");
    const sqliteHome = join(homesRoot, "accounts", opaqueAccountId, "sqlite-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
    privateWrite(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {
      account_id: fixture.rawAccounts[index], access_token: `fixture-native-access-${index}`, refresh_token: "fixture-only",
    } }));
    return {
      opaqueAccountId,
      codexHome,
      sqliteHome,
      codexHomeIdentity: nativeDirectoryIdentity(codexHome),
      sqliteHomeIdentity: nativeDirectoryIdentity(sqliteHome),
      authIdentityHmac: nativeHistoryAuthIdentityHmacV1(fixture.rawAccounts[index]!, fixture.secret),
    };
  });
  // The original source has legacy project membership outside SQLite. It is
  // read only by the bounded helper; no source history is copied into root.
  privateWrite(join(accounts[0]!.codexHome, ".codex-global-state.json"), JSON.stringify({
    "app-server-project-id-by-legacy-project-id-by-host": {
      [`local:${accounts[0]!.codexHome}`]: { "legacy-source-project": "project-source" },
    },
    "thread-project-assignments": { "legacy-a": { projectKind: "local", projectId: "legacy-source-project" } },
    "sidebar-project-thread-orders": { "legacy-source-project": { threadIds: ["legacy-a"] } },
  }));
  const unsigned: NativeHistorySourceUnsignedV1 = {
    version: 1,
    kind: "account-router-native-history-source",
    mode: "in_place",
    protocolFingerprint: fixture.config.protocolFingerprint,
    accountSetFingerprint: nativeHistoryAccountSetFingerprintV1(fixture.accounts),
    metadataAccountId: fixture.accounts[0]!,
    accounts: accounts.sort((left, right) => left.opaqueAccountId < right.opaqueAccountId ? -1 : left.opaqueAccountId > right.opaqueAccountId ? 1 : 0),
    issuedAt: "2026-09-05T12:00:00.000Z",
  };
  privateWrite(join(fixture.root, "native-history-source.v1.json"), JSON.stringify(signNativeHistorySourceV1(unsigned, fixture.secret)));
  return { ...fixture, homesRoot };
}

function enableNativeBalancedTokens(fixture: NativeFixture): void {
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    ...fixture.config,
    mode: "quota_aware",
    policy: "balanced_tokens_v1",
    generation: fixture.config.generation + 1,
    updatedAt: "2026-09-05T12:01:00.000Z",
  };
  fixture.config = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  privateWrite(join(fixture.root, "account-router-config.json"), JSON.stringify(fixture.config));
}

interface NativeFixtureProgramOptions {
  sameIdTransfer?: boolean;
  paged?: boolean;
  collision?: boolean;
  /** Exercise the live quota refresh that precedes a balanced native handoff. */
  sourceQuotaExhausted?: boolean;
  /** Keep the broker-owned turn active until its origin app-tools response arrives. */
  requireToolApproval?: boolean;
  /** Native transfer warmup outcome before the one allowed final resume. */
  transferWarmup?: "busy" | "unexpected" | "timeout";
  /** Shared append-only ordering trace for the coordinator and fixture child. */
  transferEventLog?: string;
}

function nativeFixtureChildProgram(
  accountA: OpaqueAccountId,
  accountB: OpaqueAccountId,
  unavailableB = false,
  options: NativeFixtureProgramOptions = {},
): string {
  return `
    const fs = require("node:fs");
    const path = require("node:path");
    const home = process.env.CODEX_HOME || "";
    const account = path.basename(path.dirname(home));
    const root = path.dirname(path.dirname(path.dirname(home)));
    const options = ${JSON.stringify(options)};
    const accountA = ${JSON.stringify(accountA)};
    const accountB = ${JSON.stringify(accountB)};
    let buffered = "";
    let turnSequence = 0;
    const recordedTurns = new Map();
    const startedProjects = new Map();
    const pendingTools = new Map();
    let sameIdTransferResumeCount = 0;
    const transferEvent = (value) => {
      if (!options.transferEventLog) return;
      try { fs.appendFileSync(options.transferEventLog, value + "\\n", { mode: 0o600 }); } catch {}
    };
    const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
    const fail = (id, code = 404) => write({ jsonrpc: "2.0", id, error: { code, message: "fixture" } });
    const baseTurn = (id, label) => ({ id: "turn-" + id, status: "completed", items: [
      { id: "item-user-" + id, type: "userMessage", content: [{ type: "text", text: "user " + label }] },
      { id: "item-agent-" + id, type: "agentMessage", text: "agent " + label }
    ] });
    const sourceProject = (id) => id === "existing-a" || id === "native-source" ? "project-source" : id === "target-b" ? "project-target" : null;
    const knownIds = () => {
      const ids = account === accountA
        ? ["existing-a", "legacy-a", "segment-a2", "native-source", "archived-a"]
        : ["existing-b", "segment-b", "target-b", "archived-b"];
      if (options.collision) ids.push("native-collision");
      for (const id of startedProjects.keys()) ids.push(id);
      return new Set(ids);
    };
    const projectFor = (id) => startedProjects.has(id) ? startedProjects.get(id) : sourceProject(id);
    const thread = (id, projectId = projectFor(id)) => ({
      id,
      sessionId: "session-for-" + id,
      projectId,
      title: id,
      // Deliberately large source-only cumulative usage proves a read-through
      // transcript never becomes a broker token charge.
      tokenUsage: id === "existing-a" ? { total: { inputTokens: 50000, outputTokens: 9000 } } : undefined,
      turns: [...(startedProjects.has(id) ? [] : [baseTurn(id, id)]), ...(recordedTurns.get(id) || [])],
    });
    const listRows = (archived, cursor) => {
      if (archived) {
        return account === accountA ? ["archived-a"] : ["archived-b"];
      }
      if (options.paged && cursor) {
        return account === accountA ? ["page-a2"] : ["page-b2"];
      }
      const rows = account === accountA
        ? ["existing-a", "legacy-a", "segment-a2"]
        : ["existing-b", "segment-b"];
      if (options.collision) rows.push("native-collision");
      for (const id of startedProjects.keys()) rows.push(id);
      return rows;
    };
    const completeTurn = (pending) => {
      const items = [];
      if (pending.context) {
        items.push({ id: "item-context-" + pending.turnId, type: "userMessage", content: [{ type: "text", text: pending.context }] });
      }
      items.push(
        { id: "item-user-" + pending.turnId, type: "userMessage", content: [{ type: "text", text: pending.inputText }] },
        { id: "item-agent-" + pending.turnId, type: "agentMessage", text: "agent broker continuation" },
      );
      const turn = { id: pending.turnId, status: "completed", itemsView: "full", items };
      const turns = recordedTurns.get(pending.threadId) || [];
      turns.push(turn);
      recordedTurns.set(pending.threadId, turns);
      write({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
        threadId: pending.threadId,
        turnId: pending.turnId,
        tokenUsage: { total: { inputTokens: 11, outputTokens: 7 }, last: { inputTokens: 11, outputTokens: 7 } },
      } });
      write({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: pending.threadId, turn } });
    };
    let initialized = false;
    let initializeCount = 0;
    let initializeParams = null;
    const receive = (message) => {
      if (!message || typeof message !== "object") return;
      if (message.method === "initialize") {
        transferEvent("child:" + account + ":initialize");
        initializeCount += 1; initializeParams = message.params;
        return respond(message.id, { userAgent: "fixture/0.153.4-alpha.1+build.7 (Mac OS)", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" });
      }
      if (message.method === "initialized") { initialized = true; return; }
      if (typeof message.method === "string" && !initialized) return write({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Not initialized" } });
      if (message.method === "fixture/initialization") return respond(message.id, { initializeCount, initializeParams, initialized });
      if (message.method === "plugin/installed" && message.params?.nativeBaseInventoryOnly === true && process.env.TWEAKERS_OVERLAY_ROOT) {
        const overlay = process.env.TWEAKERS_OVERLAY_ROOT;
        fs.appendFileSync(path.join(overlay, "fixture-inventory-requests.jsonl"), JSON.stringify({ account, params: message.params }) + "\\n");
        const override = path.join(overlay, "fixture-inventory-response.json");
        if (fs.existsSync(override)) {
          const value = JSON.parse(fs.readFileSync(override, "utf8"));
          return value.error ? write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "inventory unavailable" } }) : respond(message.id, value);
        }
        return respond(message.id, { marketplaces: [{ name: "openai-curated-remote", path: null, plugins: [
          { id: "zeta@openai-curated-remote", installed: true, enabled: false, version: null, remotePluginId: "private-provider-id" },
          { id: "alpha@openai-curated-remote", installed: true, enabled: true, version: "1.2.3" },
          { id: "absent@openai-curated-remote", installed: false, enabled: true, version: null },
        ] }], marketplaceLoadErrors: [] });
      }
      if (message.method === "config/value/write" || message.method === "config/batchWrite") {
        if (process.env.TWEAKERS_OVERLAY_ROOT) fs.appendFileSync(path.join(process.env.TWEAKERS_OVERLAY_ROOT, "fixture-config-requests.jsonl"), JSON.stringify({ account, method: message.method, params: message.params }) + "\\n");
        return respond(message.id, {});
      }
      if (typeof message.method !== "string") {
        const pending = pendingTools.get(message.id);
        if (!pending) return;
        pendingTools.delete(message.id);
        completeTurn(pending);
        return;
      }
      const p = message.params || {};
      if (${JSON.stringify(unavailableB)} && account === accountB && (message.method === "thread/list" || message.method === "thread/read")) return fail(message.id, 500);
      if (message.method === "project/list") return respond(message.id, { data: account === accountA ? [{ id: "project-source", name: "Source", roots: [] }] : [{ id: "project-target", name: "Source", roots: [] }], nextCursor: null });
      if (message.method === "project/read") return respond(message.id, { project: account === accountA ? { id: "project-source", name: "Source", roots: [] } : { id: p.projectId, name: "Source", roots: [] } });
      if (message.method === "project/import") return respond(message.id, { project: { id: "project-target", name: "Source", roots: [] } });
      if (message.method === "project/update") return respond(message.id, { project: { id: p.projectId, name: "Source", roots: [] } });
      if (message.method === "thread/list") {
        if (p.projectId === "project-target") return respond(message.id, { data: [{ ...thread("target-b", "project-target"), turns: [] }], nextCursor: null });
        if (p.projectId === "project-source") return respond(message.id, { data: [{ ...thread("native-source", "project-source"), turns: [] }], nextCursor: null });
        const rows = listRows(p.archived === true, p.cursor).map((id) => ({ ...thread(id), turns: [] }));
        return respond(message.id, { data: rows, nextCursor: options.paged && p.archived !== true && !p.cursor ? "native-page-" + account : null });
      }
      if (message.method === "thread/read") {
        if (!knownIds().has(p.threadId) && p.threadId !== "page-a2" && p.threadId !== "page-b2") return fail(message.id);
        const value = thread(p.threadId);
        if (p.includeTurns === false) value.turns = [];
        return respond(message.id, { thread: value });
      }
      if (message.method === "thread/loaded/list") {
        transferEvent("child:" + account + ":loaded");
        return respond(message.id, { data: account === accountA ? ["existing-a"] : [], nextCursor: null });
      }
      if (message.method === "thread/resume" && options.sameIdTransfer && account === accountB && p.threadId === "existing-a" && p.path === "/fixture/proven-rollout.jsonl") {
        sameIdTransferResumeCount += 1;
        if (sameIdTransferResumeCount === 1) {
          const outcome = options.transferWarmup || "busy";
          transferEvent("child:" + account + ":warmup:" + outcome);
          if (outcome === "timeout") return;
          if (outcome === "unexpected") return respond(message.id, { threadId: p.threadId, resumedBy: account, unexpected: true });
          return write({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "thread " + p.threadId + " already has an active writer" } });
        }
        transferEvent("child:" + account + ":resume");
        startedProjects.set(p.threadId, "project-source");
        return respond(message.id, { threadId: p.threadId, resumedBy: account });
      }
      if (message.method === "thread/resume") return knownIds().has(p.threadId) ? respond(message.id, { threadId: p.threadId, resumedBy: account }) : fail(message.id);
      if (message.method === "thread/archive") {
        if (!knownIds().has(p.threadId)) return fail(message.id);
        try { fs.appendFileSync(path.join(root, "native-fixture-archives.log"), account + ":" + p.threadId + "\\n", { mode: 0o600 }); } catch {}
        return respond(message.id, { threadId: p.threadId, archivedBy: account });
      }
      if (message.method === "thread/start") {
        const threadId = "fresh-" + account;
        startedProjects.set(threadId, p.projectId ?? null);
        try { fs.appendFileSync(path.join(root, "native-fixture-thread-starts.log"), account + "\\n", { mode: 0o600 }); } catch {}
        return respond(message.id, { threadId, projectId: p.projectId ?? null });
      }
      if (message.method === "turn/start") {
        if (!knownIds().has(p.threadId)) return fail(message.id);
        const turnId = "turn-broker-" + (++turnSequence);
        const inputText = Array.isArray(p.input) && p.input.length === 1 && p.input[0] && typeof p.input[0].text === "string"
          ? p.input[0].text
          : "fixture input";
        const context = p.additionalContext && p.additionalContext.broker_logical_history_v1 && typeof p.additionalContext.broker_logical_history_v1.value === "string"
          ? p.additionalContext.broker_logical_history_v1.value
          : null;
        const pending = { threadId: p.threadId, turnId, inputText, context };
        respond(message.id, { threadId: p.threadId, turnId, accepted: true });
        if (options.requireToolApproval) {
          const toolId = "native-fixture-tool:" + turnId;
          pendingTools.set(toolId, pending);
          write({ jsonrpc: "2.0", id: toolId, method: "app-tools/request", params: { threadId: p.threadId } });
          return;
        }
        setTimeout(() => completeTurn(pending), 8).unref();
        return;
      }
      if (message.method === "account/read") return respond(message.id, { account: { authenticated: true } });
      if (message.method === "account/rateLimits/read") return respond(message.id, { rateLimits: { weekly: { remainingPercent: options.sourceQuotaExhausted && account === accountA ? 0 : 80, resetAt: "2099-01-01T00:00:00.000Z" } } });
      respond(message.id, { ok: true });
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buffered += chunk; for (;;) { const i = buffered.indexOf("\\n"); if (i < 0) return; const line = buffered.slice(0, i); buffered = buffered.slice(i + 1); try { receive(JSON.parse(line)); } catch { process.exitCode = 1; } } });
  `;
}

function fixtureChildProgram(
  accountA: OpaqueAccountId,
  accountB: OpaqueAccountId,
  accountC?: OpaqueAccountId,
  paged = false,
  pluginListFailures = 0,
  emitTokenUsage: boolean | "late" = false,
  unauthenticatedAccount: OpaqueAccountId | null = null,
  connectionPages = false,
): string {
  return `
    const fs = require("node:fs");
    const path = require("node:path");
    const home = process.env.CODEX_HOME || "";
    const account = path.basename(path.dirname(home));
    const root = path.dirname(path.dirname(path.dirname(home)));
    try { fs.appendFileSync(path.join(root, "fixture-child-starts.log"), account + "\\n", { mode: 0o600 }); } catch {}
    const turns = new Map();
    let delayedTokenUsage = null;
    let pluginListAttempts = 0;
    const failedFeatureReplays = new Set();
    let buffered = "";
    const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const paged = ${JSON.stringify(paged)};
    const emitTokenUsage = ${JSON.stringify(emitTokenUsage)};
    const unauthenticatedAccount = ${JSON.stringify(unauthenticatedAccount)};
    const listRows = (cursor) => {
      if (paged && cursor) {
        if (account === ${JSON.stringify(accountA)}) return [{ id: "thread-a-page-2", title: "A page 2", updatedAt: "2026-09-02T10:00:00.000Z" }];
        if (account === ${JSON.stringify(accountB)}) return [{ id: "thread-b-page-2", title: "B page 2", updatedAt: "2026-09-02T11:00:00.000Z" }];
      }
      if (account === ${JSON.stringify(accountA)}) return [{ id: "thread-a", title: "A", updatedAt: "2026-09-02T14:00:00.000Z" }, { id: "duplicate-thread", title: "First", updatedAt: "2026-09-02T13:00:00.000Z" }];
      if (account === ${JSON.stringify(accountB)}) return [{ id: "thread-b", title: "B", updatedAt: "2026-09-02T12:00:00.000Z" }, { id: "duplicate-thread", title: "Second", updatedAt: "2026-09-02T12:30:00.000Z" }];
      if (account === ${JSON.stringify(accountC ?? "")}) return [{ id: "thread-c", title: "C", updatedAt: "2026-09-02T09:00:00.000Z" }];
      return [];
    };
    const quota = () => account === ${JSON.stringify(accountA)} ? 0 : account === ${JSON.stringify(accountB)} ? 80 : 65;
    const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
    let initialized = false;
    let initializeCount = 0;
    let initializeParams = null;
    const receive = (message) => {
      if (!message || typeof message !== "object") return;
      if (message.method === "initialize") {
        initializeCount += 1; initializeParams = message.params;
        return respond(message.id, { userAgent: "fixture", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" });
      }
      if (message.method === "initialized") { initialized = true; return; }
      if (typeof message.method === "string" && !initialized) return write({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Not initialized" } });
      if (message.method === "fixture/initialization") return respond(message.id, { initializeCount, initializeParams, initialized });
      if (typeof message.method !== "string") {
        const turn = turns.get(message.id);
        if (turn !== undefined) {
          turns.delete(message.id);
          respond(turn.id, { threadId: turn.threadId, forwarded: true });
          if (emitTokenUsage === true) {
            const inputTokens = account === ${JSON.stringify(accountA)} ? 9000 : 100;
            write({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
              threadId: turn.threadId,
              turnId: "native-turn-" + turn.id,
              tokenUsage: { total: { inputTokens, outputTokens: 0 }, last: { inputTokens, outputTokens: 0 } }
            } });
          }
          write({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: turn.threadId, turn: { id: "native-turn-" + turn.id, status: "completed", itemsView: "full", items: [
            { id: "native-user-" + turn.id, type: "userMessage", content: Array.isArray(turn.input) ? turn.input.map((entry) => ({ type: "text", text: entry.text })) : [{ type: "text", text: "fixture input" }] },
            { id: "native-agent-" + turn.id, type: "agentMessage", text: "fixture completed" }
          ] } } });
          if (emitTokenUsage === "late") {
            const inputTokens = account === ${JSON.stringify(accountA)} ? 9000 : 100;
            // This accounting fixture releases the late official total only
            // after a following turn/start reaches the provider. That proves
            // old-turn attribution against an already active next reservation
            // without a scheduler-dependent delay.
            delayedTokenUsage = {
              threadId: turn.threadId,
              turnId: "native-turn-" + turn.id,
              tokenUsage: { total: { inputTokens, outputTokens: 0 }, last: { inputTokens, outputTokens: 0 } },
            };
          }
        }
        return;
      }
      if (message.method === "thread/list") return respond(message.id, { data: listRows(message.params && message.params.cursor), nextCursor: paged && !(message.params && message.params.cursor) ? "provider-page-" + account : null });
      if (message.method === "thread/search") return respond(message.id, { data: listRows(message.params && message.params.cursor).map((thread) => ({ thread })), nextCursor: null });
      if (message.method === "thread/loaded/list") return respond(message.id, { data: listRows(message.params && message.params.cursor).map((thread) => thread.id), nextCursor: null });
      if (message.method === "threadSection/list") return respond(message.id, { data: [{ id: "fixture-section", name: "Fixture" }], nextCursor: null });
      if (message.method === "account/rateLimits/read") return respond(message.id, { rateLimits: { weekly: { remainingPercent: quota(), resetAt: "2099-09-03T00:00:00.000Z" }, resetCredits: quota() === 0 ? 0 : 1 } });
      if (message.method === "account/rateLimitResetCredit/consume") return respond(message.id, { outcome: "reset" });
      if (message.method === "experimentalFeature/enablement/set") {
        try { fs.appendFileSync(path.join(root, "fixture-feature-enablement.log"), JSON.stringify({ account, params: message.params }) + "\\n", { mode: 0o600 }); } catch {}
        if (message.params?.failOnce === true && !failedFeatureReplays.has(message.params.feature)) {
          failedFeatureReplays.add(message.params.feature);
          return write({ jsonrpc: "2.0", id: message.id, error: { code: 500, message: "fixture replay failure" } });
        }
        return respond(message.id, { ok: true });
      }
      if (message.method === "model/list") {
        const cursor = message.params && message.params.cursor;
        if (!cursor) return respond(message.id, { data: [{ id: "first-" + account }], nextCursor: "models-page-2" });
        return respond(message.id, { data: [{ id: "second-" + account }], nextCursor: null });
      }
      if (message.method === "account/read") return respond(message.id, {
        account: {
          authenticated: account !== unauthenticatedAccount,
          email: "fixture-account@example.test",
          planType: "Fixture Plan",
          avatarUrl: "https://images.example.invalid/avatar.png?cache=private#fragment",
        },
      });
      if (message.method === "account/login/start") {
        if (account.startsWith("be_")) {
          fs.mkdirSync(home, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "enrolled-fixture-account", refresh_token: "never-public" } }), { mode: 0o600 });
          fs.writeFileSync(path.join(home, "config.toml"), "", { mode: 0o600 });
        }
        const loginId = "fixture-login-" + account;
        respond(message.id, { type: "chatgptDeviceCode", loginId, verificationUrl: "https://example.invalid/device", userCode: "ABCD-1234" });
        setTimeout(() => write({ jsonrpc: "2.0", method: "account/login/completed", params: { loginId, success: true } }), 8).unref();
        return;
      }
      if (message.method === "account/login/cancel") return respond(message.id, {});
      if (message.method === "app/installed") {
        if (${JSON.stringify(connectionPages)}) return write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
        return respond(message.id, { apps: [{ id: "fixture-app", enabled: true, callable: true }] });
      }
      if (message.method === "app/list" && ${JSON.stringify(connectionPages)}) {
        const offset = Number(message.params?.cursor || 0);
        return respond(message.id, { data: Array.from({ length: 100 }, (_, index) => ({ id: "fixture-app-" + (offset + index), name: "Same Display Name", isEnabled: true, isAccessible: true })), nextCursor: offset < 200 ? String(offset + 100) : null });
      }
      if (message.method === "app/list") return respond(message.id, { data: [{ id: "fixture-app", name: "Fixture App", isEnabled: true, isAccessible: true }] });
      if (message.method === "fixture/echo") return respond(message.id, message.params);
      if (message.method === "plugin/list" || message.method === "plugin/installed") {
        if (message.params?.fixtureLarge) return respond(message.id, { marketplaces: [{ plugins: [{ id: "fixture-large@test", installed: true, interface: { description: "界🌍".repeat(180000) } }] }] });
        pluginListAttempts += 1;
        if (${JSON.stringify(pluginListFailures)} === -1 && pluginListAttempts > 1) return respond(message.id, { marketplaces: [], marketplaceLoadErrors: [{ message: "Fixture marketplace unavailable" }] });
        try { fs.appendFileSync(path.join(root, "fixture-plugin-list-attempts.log"), account + "\\n", { mode: 0o600 }); } catch {}
        if (pluginListAttempts <= ${JSON.stringify(pluginListFailures)}) return write({ jsonrpc: "2.0", id: message.id, error: { code: 404, message: "plugin service unavailable" } });
        return respond(message.id, { marketplaces: [{ plugins: [{ id: "fixture-plugin@test", name: "Fixture Plugin", enabled: true, installed: true }] }] });
      }
      if (message.method === "mcpServerStatus/list") return respond(message.id, { data: [{ name: "fixture-mcp", status: "connected" }] });
      if (message.method === "mcpServer/oauth/login") return respond(message.id, { authorizationUrl: "https://example.invalid/oauth?state=fixture-state" });
      if (message.method === "fixture/crash") return process.exit(17);
      if (message.method === "thread/start") {
        try { fs.appendFileSync(path.join(root, "fixture-child-thread-starts.log"), account + "\\n", { mode: 0o600 }); } catch {}
        return respond(message.id, { threadId: "fresh-" + account + "-" + message.id });
      }
      if (message.method === "thread/fork") return respond(message.id, { threadId: "forked-" + account + "-" + message.id });
      if (message.method === "turn/start") {
        if (Array.isArray(message.params && message.params.input) && message.params.input.some((entry) => entry && entry.text === "ack then wait")) {
          respond(message.id, { threadId: message.params && message.params.threadId, accepted: true });
          return;
        }
        if (Array.isArray(message.params && message.params.input) && message.params.input.some((entry) => entry && entry.text === "ack then release late")) {
          respond(message.id, { threadId: message.params && message.params.threadId, accepted: true });
          if (delayedTokenUsage) {
            write({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: delayedTokenUsage });
            delayedTokenUsage = null;
          }
          return;
        }
        if (Array.isArray(message.params && message.params.input) && message.params.input.some((entry) => entry && entry.text === "complete without tool")) {
          respond(message.id, { threadId: message.params && message.params.threadId, accepted: true });
          setTimeout(() => write({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: message.params && message.params.threadId, turn: {
            id: "native-turn-" + message.id, status: "completed", itemsView: "full", items: []
          } } }), 20).unref();
          return;
        }
        const toolId = "fixture-tool:" + message.id;
        turns.set(toolId, { id: message.id, threadId: message.params && message.params.threadId, input: message.params && message.params.input });
        write({ jsonrpc: "2.0", id: toolId, method: "app-tools/request", params: { threadId: message.params && message.params.threadId } });
        if (Array.isArray(message.params && message.params.input) && message.params.input.some((entry) => entry && entry.text === "crash child")) {
          setTimeout(() => process.exit(17), 8).unref();
        }
        return;
      }
      respond(message.id, { ok: true });
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffered += chunk;
      while (true) {
        const newline = buffered.indexOf("\\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try { receive(JSON.parse(line)); } catch { process.exitCode = 1; }
      }
    });
  `;
}

async function connectDesktop(
  fixture: Fixture,
  webContentsId: number,
  clientKind: "chatgpt" | "tweakers",
  session?: string,
): Promise<DesktopClient> {
  const binding = desktopBinding(clientKind, webContentsId, session);
  const rendererRef = createOpaqueRendererRef(fixture.secret, webContentsId, binding);
  const appToolsRef = createOpaqueAppToolsRef(fixture.secret, webContentsId, binding);
  const messages: JsonRpcMessage[] = [];
  const bridge = await connectAccountsBrokerAppServerClient({
    root: fixture.root,
    secret: fixture.secret,
    clientKind,
    rendererRef,
    appToolsRef,
  }, (message) => messages.push(message));
  bridge.send({ jsonrpc: "2.0", id: "fixture-initialize", method: "initialize", params: {
    clientInfo: { name: "fixture-desktop", version: "1" },
    capabilities: { experimentalApi: true, requestAttestation: true, extensions: { "test.extension": {} } },
  } });
  await waitForMessage(messages, (message) => responseFor([message], "fixture-initialize") !== undefined, "desktop initialize response missing");
  bridge.send({ jsonrpc: "2.0", method: "initialized" });
  messages.splice(0, messages.length);
  return { messages, rendererRef, appToolsRef, send: bridge.send, close: bridge.close, whenClosed: bridge.whenClosed };
}

function controlClient(fixture: Fixture, webContentsId = 1, clientKind: "chatgpt" | "tweakers" = "chatgpt", session?: string): AccountsBrokerSocketClientV1 {
  const binding = desktopBinding(clientKind, webContentsId, session);
  return new AccountsBrokerSocketClientV1({
    root: fixture.root,
    secret: fixture.secret,
    clientKind,
    rendererRef: createOpaqueRendererRef(fixture.secret, webContentsId, binding),
    appToolsRef: createOpaqueAppToolsRef(fixture.secret, webContentsId, binding),
  });
}


function enableBalancedTokens(fixture: Fixture): void {
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    ...fixture.config,
    policy: "balanced_tokens_v1",
    generation: fixture.config.generation + 1,
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  fixture.config = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  privateWrite(join(fixture.root, "account-router-config.json"), JSON.stringify(fixture.config));
}

/**
 * Automatic routing is intentionally closed until quota evidence is fresh.
 * These legacy lifecycle tests exercise their named primary account, so give
 * that account the same bounded evidence a real quota probe would provide.
 */
function seedFreshPrimaryQuota(owner: AccountsBrokerOwnerV1, fixture: Fixture): void {
  const broker = (owner as unknown as { broker: AccountsBrokerV1 }).broker;
  for (const [index, opaqueAccountId] of fixture.accounts.entries()) {
    assert.equal(broker.updateQuota({
      opaqueAccountId,
      freshness: "fresh",
      remainingPercent: index === 0 ? 80 : 0,
      resetAt: "2099-09-03T00:00:00.000Z",
      observedAt: Date.now(),
      shortWindowPressure: index === 0 ? 0 : 100,
      resetCredits: 0,
    }), true);
  }
}


async function bootstrapBalancedRouting(owner: AccountsBrokerOwnerV1, fixture: Fixture, desktop: DesktopClient, id = "balance-bootstrap"): Promise<void> {
  desktop.send({ jsonrpc: "2.0", id, method: "thread/start", params: {} });
  await waitForMessage(desktop.messages, (message) => responseFor([message], id) !== undefined, "balanced capacity bootstrap response missing");
  const broker = (owner as unknown as { broker: AccountsBrokerV1 }).broker;
  for (const opaqueAccountId of fixture.accounts) {
    assert.equal(broker.updateQuota({
      opaqueAccountId,
      freshness: "fresh",
      remainingPercent: 80,
      resetAt: "2099-09-03T00:00:00.000Z",
      observedAt: Date.now(),
      shortWindowPressure: 0,
      shortWindowResetAt: null,
      rateLimitReached: false,
      resetCredits: 0,
    }), true);
  }
}

async function readBalance(control: AccountsBrokerSocketClientV1, requestId: string): Promise<{
  policy: string;
  accounts: Array<{ opaqueAccountId: string; completedTokens: number; reservedTokens: number; unreportedTokens: number; precision: string }>;
  degradedReason: string | null;
  nextAccountId: string | null;
}> {
  const result = await control.invoke({ version: 1, requestId, command: "balance.read" });
  assert.equal(result.ok, true);
  return result.result as {
    policy: string;
    accounts: Array<{ opaqueAccountId: string; completedTokens: number; reservedTokens: number; unreportedTokens: number; precision: string }>;
    degradedReason: string | null;
    nextAccountId: string | null;
  };
}

async function waitForMessage(
  messages: readonly JsonRpcMessage[],
  predicate: (message: JsonRpcMessage) => boolean,
  failure: string,
  timeoutMs = 3_000,
): Promise<JsonRpcMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(failure);
}

async function waitForCondition(condition: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(failure);
}

function responseFor(messages: readonly JsonRpcMessage[], id: string | number): JsonRpcMessage | undefined {
  return messages.find((message) => "id" in message && message.id === id && !("method" in message));
}

let generatedSchemaRoot: string | null = null;
function assertGeneratedSchema(name: string, value: unknown): void {
  if (generatedSchemaRoot === null) {
    const root = mkdtempSync(join(tmpdir(), "accounts-protocol-schema-"));
    const isolatedHome = join(root, "home");
    mkdirSync(isolatedHome, { mode: 0o700 });
    const schemaRoot = join(root, "schema");
    const binary = process.env.TWEAKERS_TEST_CODEX_BINARY
      ?? join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
    const generated = spawnSync(binary, ["app-server", "generate-json-schema", "--experimental", "--out", schemaRoot], {
      env: {
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        HOME: isolatedHome,
        CODEX_HOME: isolatedHome,
        CODEX_SQLITE_HOME: isolatedHome,
      },
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(generated.status, 0, `isolated app-server schema generation failed: ${generated.error?.message ?? generated.stderr}`);
    generatedSchemaRoot = schemaRoot;
  }
  const path = join(generatedSchemaRoot, "v2", `${name}.json`);
  assert.equal(existsSync(path), true, `generated app-server schema missing: ${name}`);
  // Ajv is a root test dependency. Keeping this at the test boundary avoids
  // shipping a schema validator in the desktop runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Ajv = require("ajv") as new (options?: unknown) => { compile(schema: unknown): (input: unknown) => boolean & { errors?: unknown } };
  const validate = new Ajv({ allErrors: true, jsonPointers: true, unknownFormats: "ignore", logger: false }).compile(JSON.parse(readFileSync(path, "utf8")) as unknown);
  assert.equal(validate(value), true, `${name} rejected canonical response: ${JSON.stringify(validate.errors)}`);
}

test("synchronized owner contenders reserve before recovery and the loser leaves every shared artifact unchanged", async () => {
  const fixture = createFixture();
  seedRecoverablePreparedTurn(fixture);
  let reservationReady!: () => void;
  const reservationReached = new Promise<void>((resolvePromise) => { reservationReady = resolvePromise; });
  let releaseWinner!: () => void;
  const releaseGate = new Promise<void>((resolvePromise) => { releaseWinner = resolvePromise; });
  const winner = new AccountsBrokerOwnerV1(
    fixture.config,
    fixture.root,
    fixture.secret,
    process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)],
    { onReservationAcquired: async () => { reservationReady(); await releaseGate; } },
  );
  const winnerStart = winner.start();
  await reservationReached;
  const afterElectionBeforeRecovery = brokerRootArtifacts(fixture.root);
  const loser = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  try {
    await assert.rejects(loser.start(), /accounts broker socket is already active/);
    assert.deepEqual(
      brokerRootArtifacts(fixture.root),
      afterElectionBeforeRecovery,
      "a synchronized losing contender must not recover, create state, or rewrite config/canonical artifacts",
    );
    releaseWinner();
    await winnerStart;
    const afterWinnerRecovery = brokerRootArtifacts(fixture.root);
    assert.notDeepEqual(afterWinnerRecovery, afterElectionBeforeRecovery, "the elected owner alone performs startup recovery");
    const canonical = JSON.parse(readFileSync(join(fixture.root, "canonical-history.v1.json"), "utf8")) as {
      conversations: Array<{ segments: Array<{ turns: Array<{ phase: string }> }> }>;
    };
    assert.equal(canonical.conversations[0]?.segments[0]?.turns[0]?.phase, "aborted");
  } finally {
    releaseWinner();
    await winner.close();
  }
});

test("a contender beside a live owner cannot unlink its election socket or mutate shared broker files", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const beforeLoser = brokerRootArtifacts(fixture.root);
  const contender = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  try {
    await assert.rejects(contender.start(), /accounts broker socket is already active/);
    assert.deepEqual(brokerRootArtifacts(fixture.root), beforeLoser, "a live-owner contender must not touch shared-root state");
  } finally {
    await owner.close();
  }
});

test("an elected owner initialization failure releases its reservation before a later owner recovers", async () => {
  const fixture = createFixture();
  seedRecoverablePreparedTurn(fixture);
  const beforeFailure = brokerRootArtifacts(fixture.root);
  const failingOwner = new AccountsBrokerOwnerV1(
    fixture.config,
    fixture.root,
    fixture.secret,
    process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)],
    { onReservationAcquired: () => { throw new Error("deterministic post-election initialization failure"); } },
  );
  await assert.rejects(failingOwner.start(), /deterministic post-election initialization failure/);
  assert.deepEqual(brokerRootArtifacts(fixture.root), beforeFailure, "failed pre-recovery initialization must release without shared writes");

  const recoveryOwner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  try {
    await recoveryOwner.start();
    const canonical = JSON.parse(readFileSync(join(fixture.root, "canonical-history.v1.json"), "utf8")) as {
      conversations: Array<{ segments: Array<{ turns: Array<{ phase: string }> }> }>;
    };
    assert.equal(canonical.conversations[0]?.segments[0]?.turns[0]?.phase, "aborted", "the later elected owner performs the one recovery");
  } finally {
    await recoveryOwner.close();
  }
});

test("broker startup and child creation fail closed when the sealed shared Skills source or an account copy drifts", async () => {
  const fixture = createFixture();
  const sourceSkill = join(fixture.root, ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY, "fixture", "SKILL.md");
  chmodSync(sourceSkill, 0o600);
  privateWrite(sourceSkill, "source drift\n");
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await assert.rejects(owner.start(), /shared Skills\/account-home preflight failed/);

  const clean = createFixture();
  const accountSkill = join(clean.root, "accounts", clean.accounts[0]!, "codex-home", "skills", "fixture", "SKILL.md");
  chmodSync(accountSkill, 0o600);
  privateWrite(accountSkill, "account drift\n");
  const driftedOwner = new AccountsBrokerOwnerV1(clean.config, clean.root, clean.secret, process.execPath, ["-e", fixtureChildProgram(clean.accounts[0]!, clean.accounts[1]!)]);
  await assert.rejects(driftedOwner.start(), /shared Skills\/account-home preflight failed/);

  const pluginDrift = createFixture();
  const sourcePlugin = join(pluginDrift.root, ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", "0.1.0", "package.json");
  chmodSync(sourcePlugin, 0o600);
  privateWrite(sourcePlugin, "{\"name\":\"drifted\"}\n");
  const pluginDriftedOwner = new AccountsBrokerOwnerV1(pluginDrift.config, pluginDrift.root, pluginDrift.secret, process.execPath, ["-e", fixtureChildProgram(pluginDrift.accounts[0]!, pluginDrift.accounts[1]!)]);
  await assert.rejects(pluginDriftedOwner.start(), /shared Skills\/account-home preflight failed/);
});

test("plugin connection reads retry once inside the selected account child", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(
    fixture.config,
    fixture.root,
    fixture.secret,
    process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, undefined, false, 1)],
  );
  await owner.start();
  await connectDesktop(fixture, 17, "chatgpt");
  const control = controlClient(fixture, 17);
  try {
    const response = await control.invoke({
      version: 1,
      requestId: "plugin-retry",
      command: "connection.list",
      params: { opaqueAccountId: fixture.accounts[0], kind: "plugin" },
    });
    assert.equal(response.ok, true);
    const attempts = readFileSync(join(fixture.root, "fixture-plugin-list-attempts.log"), "utf8").trim().split("\n").filter(Boolean);
    assert.deepEqual(attempts, [fixture.accounts[0], fixture.accounts[0]], "the bounded retry never substitutes another account child");
  } finally {
    await control.close();
    await owner.close();
  }
});

test("Apps, Plugins, and MCP status stay in the selected login while only proven MCP OAuth is actionable", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(
    fixture.config,
    fixture.root,
    fixture.secret,
    process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)],
  );
  await owner.start();
  await connectDesktop(fixture, 18, "chatgpt");
  const control = controlClient(fixture, 18);
  try {
    const appA = await control.invoke({
      version: 1,
      requestId: "apps-a",
      command: "connection.list",
      params: { opaqueAccountId: fixture.accounts[0], kind: "app" },
    });
    const appB = await control.invoke({
      version: 1,
      requestId: "apps-b",
      command: "connection.list",
      params: { opaqueAccountId: fixture.accounts[1], kind: "app" },
    });
    assert.equal(appA.ok, true, JSON.stringify(appA));
    assert.equal(appB.ok, true, JSON.stringify(appB));
    const appARow = appA.ok ? (appA.result as Array<{ opaqueAccountId: OpaqueAccountId; definitionRef: OpaqueConnectionDefinitionRef }>)[0] : null;
    const appBRow = appB.ok ? (appB.result as Array<{ opaqueAccountId: OpaqueAccountId; definitionRef: OpaqueConnectionDefinitionRef }>)[0] : null;
    assert.equal(appARow?.opaqueAccountId, fixture.accounts[0]);
    assert.equal(appBRow?.opaqueAccountId, fixture.accounts[1]);
    assert.notEqual(appARow?.definitionRef, appBRow?.definitionRef, "a shared definition receives a distinct account-local handle");

    const plugins = await control.invoke({
      version: 1,
      requestId: "plugins-b",
      command: "connection.list",
      params: { opaqueAccountId: fixture.accounts[1], kind: "plugin" },
    });
    assert.equal(plugins.ok, true);
    const pluginDefinition = plugins.ok
      ? (plugins.result as Array<{ definitionRef: OpaqueConnectionDefinitionRef }>)[0]?.definitionRef
      : null;
    assert.ok(pluginDefinition);
    const pluginAuthorize = await control.invoke({
      version: 1,
      requestId: "plugins-b-authorize",
      command: "connection.authorize",
      params: { opaqueAccountId: fixture.accounts[1], kind: "plugin", definitionRef: pluginDefinition },
    });
    assert.equal(pluginAuthorize.ok, false, "the provider exposes no plugin OAuth method");

    const mcp = await control.invoke({
      version: 1,
      requestId: "mcp-b",
      command: "connection.list",
      params: { opaqueAccountId: fixture.accounts[1], kind: "mcp" },
    });
    assert.equal(mcp.ok, true);
    const mcpDefinition = mcp.ok
      ? (mcp.result as Array<{ opaqueAccountId: OpaqueAccountId; definitionRef: OpaqueConnectionDefinitionRef }>)[0]
      : null;
    assert.equal(mcpDefinition?.opaqueAccountId, fixture.accounts[1]);
    const authorized = await control.invoke({
      version: 1,
      requestId: "mcp-b-authorize",
      command: "connection.authorize",
      params: { opaqueAccountId: fixture.accounts[1], kind: "mcp", definitionRef: mcpDefinition?.definitionRef },
    });
    assert.equal(authorized.ok, true);
    assert.equal(authorized.ok ? (authorized.result as { opaqueAccountId: string }).opaqueAccountId : null, fixture.accounts[1]);
    assert.match(authorized.ok ? (authorized.result as { oauthUrl: string }).oauthUrl : "", /^https:\/\/example\.invalid\/oauth\?/);

    const crossAccount = await control.invoke({
      version: 1,
      requestId: "mcp-cross-account",
      command: "connection.authorize",
      params: { opaqueAccountId: fixture.accounts[0], kind: "mcp", definitionRef: mcpDefinition?.definitionRef },
    });
    assert.equal(crossAccount.ok, false, "one login cannot reuse another login's MCP authorization handle");
    assert.doesNotMatch(readFileSync(join(fixture.root, "router-state.json"), "utf8"), /fixture-state|oauth/i, "OAuth handoff data is never persisted");
  } finally {
    await control.close();
    await owner.close();
  }
});

test("reconnect and cancellation operate only on the explicitly selected account home", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(
    fixture.config,
    fixture.root,
    fixture.secret,
    process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)],
  );
  await owner.start();
  await connectDesktop(fixture, 19, "chatgpt");
  const control = controlClient(fixture, 19);
  try {
    const started = await control.invoke({
      version: 1,
      requestId: "reconnect-a",
      command: "reconnect.start",
      params: { opaqueAccountId: fixture.accounts[0] },
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    const enrollmentRef = started.ok ? (started.result as { enrollmentRef: string }).enrollmentRef : null;
    assert.ok(enrollmentRef);
    assert.doesNotMatch(JSON.stringify(started), /fixture-login|refresh-only/);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const completed = await control.invoke({
      version: 1,
      requestId: "reconnect-a-status",
      command: "reconnect.status",
      params: { enrollmentRef },
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.ok ? (completed.result as { state: string }).state : null, "complete");

    const cancelStart = await control.invoke({
      version: 1,
      requestId: "reconnect-b",
      command: "reconnect.start",
      params: { opaqueAccountId: fixture.accounts[1] },
    });
    assert.equal(cancelStart.ok, true);
    const cancelRef = cancelStart.ok ? (cancelStart.result as { enrollmentRef: string }).enrollmentRef : null;
    assert.ok(cancelRef);
    const cancelled = await control.invoke({
      version: 1,
      requestId: "reconnect-b-cancel",
      command: "reconnect.cancel",
      params: { enrollmentRef: cancelRef },
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.ok ? (cancelled.result as { state: string }).state : null, "cancelled");
    assert.doesNotMatch(JSON.stringify(cancelled), /fixture-login|refresh-only/);

    const starts = readFileSync(join(fixture.root, "fixture-child-starts.log"), "utf8").trim().split("\n").filter(Boolean);
    assert.deepEqual(starts, [fixture.accounts[0], fixture.accounts[1]], "reconnect never starts or substitutes an unselected login child");
  } finally {
    await control.close();
    await owner.close();
  }
});

test("v3 empty canonical history is available to both desktop clients without account fanout", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const first = await connectDesktop(fixture, 1, "chatgpt");
  const second = await connectDesktop(fixture, 2, "tweakers");
  try {
    assert.equal(first.send({ jsonrpc: "2.0", id: "list-first", method: "thread/list" }), true);
    const firstResponse = await waitForMessage(first.messages, (message) => responseFor([message], "list-first") !== undefined, "first merged history response missing") as { result?: { data?: Array<{ id: string }> } };
    assert.deepEqual(firstResponse.result?.data?.map((row) => row.id), []);

    assert.equal(second.send({ jsonrpc: "2.0", id: "list-second", method: "thread/list" }), true);
    const secondResponse = await waitForMessage(second.messages, (message) => responseFor([message], "list-second") !== undefined, "second merged history response missing") as { result?: { data?: Array<{ id: string }> } };
    assert.deepEqual(secondResponse.result?.data?.map((row) => row.id), []);
    const state = new RouterStateStore(fixture.root, fixture.config).snapshot();
    assert.equal(state.threadOwners["thread-a"], undefined);
    assert.doesNotMatch(JSON.stringify([...first.messages, ...second.messages]), /\bar_[A-Za-z0-9_-]+/);
  } finally {
    first.close();
    second.close();
    await owner.close();
  }
});

test("v3 canonical history never accepts provider cursors", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, undefined, true)]);
  await owner.start();
  const first = await connectDesktop(fixture, 3, "chatgpt");
  const second = await connectDesktop(fixture, 4, "tweakers");
  try {
    assert.equal(first.send({ jsonrpc: "2.0", id: "page-one", method: "thread/list" }), true);
    const firstPage = await waitForMessage(first.messages, (message) => responseFor([message], "page-one") !== undefined, "first paged history response missing") as { result?: { data?: Array<{ id: string }>; nextCursor?: string | null } };
    assert.deepEqual(firstPage.result?.data?.map((row) => row.id), []);
    const cursor = firstPage.result?.nextCursor;
    assert.equal(cursor, null);

    assert.equal(second.send({ jsonrpc: "2.0", id: "page-two", method: "thread/list", params: { cursor } }), true);
    const secondPage = await waitForMessage(second.messages, (message) => responseFor([message], "page-two") !== undefined, "second paged history response missing") as { result?: { data?: Array<{ id: string }>; nextCursor?: string | null } };
    assert.deepEqual(secondPage.result?.data?.map((row) => row.id), []);
    assert.equal(secondPage.result?.nextCursor, null);

    assert.equal(first.send({ jsonrpc: "2.0", id: "tampered", method: "thread/list", params: { cursor: "hc_tampered" } }), true);
    const tampered = await waitForMessage(first.messages, (message) => responseFor([message], "tampered") !== undefined, "canonical list response missing") as { error?: unknown };
    assert.ok(tampered.error, "unsupported provider cursor must fail closed instead of reaching an account child");
  } finally {
    first.close();
    second.close();
    await owner.close();
  }
});

test("v3 canonical reads do not start disabled or ordinary account homes", async () => {
  const disabledFixture = createFixture({ disabled: [1] });
  const disabledOwner = new AccountsBrokerOwnerV1(disabledFixture.config, disabledFixture.root, disabledFixture.secret, process.execPath, ["-e", fixtureChildProgram(disabledFixture.accounts[0]!, disabledFixture.accounts[1]!)]);
  await disabledOwner.start();
  const disabledClient = await connectDesktop(disabledFixture, 11, "chatgpt");
  try {
    assert.equal(disabledClient.send({ jsonrpc: "2.0", id: "disabled-list", method: "thread/list" }), true);
    const response = await waitForMessage(disabledClient.messages, (message) => responseFor([message], "disabled-list") !== undefined, "partial history response missing") as { result?: { data?: Array<{ id: string }> } };
    assert.deepEqual(response.result?.data?.map((row) => row.id), []);
    assert.deepEqual(readFileSync(join(disabledFixture.root, "fixture-child-starts.log"), "utf8").trim().split("\n"), [disabledFixture.accounts[0]], "only the desktop handshake starts primary; disabled history is never started");
  } finally {
    disabledClient.close();
    await disabledOwner.close();
  }

  const fixture = createFixture({ accounts: 3 });
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, fixture.accounts[2])]);
  await owner.start();
  const client = await connectDesktop(fixture, 12, "chatgpt");
  try {
    assert.equal(client.send({ jsonrpc: "2.0", id: "cache-one", method: "thread/list" }), true);
    await waitForMessage(client.messages, (message) => responseFor([message], "cache-one") !== undefined, "first cached history response missing");
    const startsBefore = existsSync(join(fixture.root, "fixture-child-starts.log")) ? readFileSync(join(fixture.root, "fixture-child-starts.log"), "utf8").trim().split("\n").filter(Boolean).length : 0;
    assert.equal(client.send({ jsonrpc: "2.0", id: "cache-two", method: "thread/list" }), true);
    await waitForMessage(client.messages, (message) => responseFor([message], "cache-two") !== undefined, "second cached history response missing");
    const startsAfter = existsSync(join(fixture.root, "fixture-child-starts.log")) ? readFileSync(join(fixture.root, "fixture-child-starts.log"), "utf8").trim().split("\n").filter(Boolean).length : 0;
    assert.equal(startsAfter, startsBefore, "canonical refresh must not start account children");
  } finally {
    client.close();
    await owner.close();
  }
});

test("automatic allocation refreshes unknown or stale quota exactly once and never treats reset credits as capacity", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const desktop = await connectDesktop(fixture, 19, "chatgpt");
  const internals = owner as unknown as { broker: AccountsBrokerV1 };
  const startsPath = join(fixture.root, "fixture-child-thread-starts.log");
  const currentStarts = () => existsSync(startsPath) ? readFileSync(startsPath, "utf8").trim().split("\n").filter(Boolean) : [];
  try {
    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[0]!, freshness: "unknown", remainingPercent: null, resetAt: null, shortWindowPressure: null, resetCredits: 99 }), true);
    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[1]!, freshness: "fresh", remainingPercent: 62, resetAt: null, shortWindowPressure: 8, resetCredits: 0 }), true);
    desktop.send({ jsonrpc: "2.0", id: "fresh-beats-unknown", method: "thread/start", params: {} });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "fresh-beats-unknown") !== undefined, "fresh allocation response missing");
    assert.deepEqual(currentStarts(), [fixture.accounts[1]], "the bounded refresh selects the provider-proven positive account");

    desktop.send({ jsonrpc: "2.0", id: "all-unknown", method: "thread/start", params: {} });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "all-unknown") !== undefined, "all-unknown refresh response missing");
    assert.deepEqual(currentStarts(), [fixture.accounts[1], fixture.accounts[1]], "unknown evidence refreshes before a single provider write");

    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[0]!, freshness: "stale", remainingPercent: 91, resetAt: null, shortWindowPressure: 0, resetCredits: 99 }), true);
    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[1]!, freshness: "stale", remainingPercent: 88, resetAt: null, shortWindowPressure: 0, resetCredits: 99 }), true);
    desktop.send({ jsonrpc: "2.0", id: "stale", method: "thread/start", params: {} });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "stale") !== undefined, "stale refresh response missing");
    assert.deepEqual(currentStarts(), [fixture.accounts[1], fixture.accounts[1], fixture.accounts[1]], "stale evidence is replaced before allocation");

    const exhausted = { resetAt: "2099-09-03T00:00:00.000Z", observedAt: Date.now() };
    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[0]!, freshness: "fresh", remainingPercent: 0, shortWindowPressure: 100, resetCredits: 1, ...exhausted }), true);
    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[1]!, freshness: "fresh", remainingPercent: 0, shortWindowPressure: 100, resetCredits: 1, ...exhausted }), true);
    desktop.send({ jsonrpc: "2.0", id: "zero-with-credit", method: "thread/start", params: {} });
    const zeroWithCredit = await waitForMessage(desktop.messages, (message) => responseFor([message], "zero-with-credit") !== undefined, "zero-with-credit refusal missing") as { error?: { data?: { code?: string } } };
    assert.equal(zeroWithCredit.error?.data?.code, "unknown_thread_owner");
    assert.deepEqual(currentStarts(), [fixture.accounts[1], fixture.accounts[1], fixture.accounts[1]], "reset credits are explicit confirmation only, never automatic capacity");
  } finally {
    desktop.close();
    await owner.close();
  }
});

test("automatic quota refresh rejects a duplicate external JSON-RPC id before any second provider write", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const desktop = await connectDesktop(fixture, 190, "chatgpt");
  const startsPath = join(fixture.root, "fixture-child-thread-starts.log");
  try {
    assert.equal(desktop.send({ jsonrpc: "2.0", id: "duplicate-refresh", method: "thread/start", params: {} }), true);
    assert.equal(desktop.send({ jsonrpc: "2.0", id: "duplicate-refresh", method: "thread/start", params: {} }), true);
    await waitForCondition(() => existsSync(startsPath), "original deferred request did not start exactly once");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const starts = readFileSync(startsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(starts.length, 1, "duplicate refresh id must produce at most one provider thread/start");
    const duplicate = desktop.messages.find((message) => responseFor([message], "duplicate-refresh") !== undefined && "error" in message) as { error?: { data?: { code?: string } } } | undefined;
    assert.equal(duplicate?.error?.data?.code, "invalid_correlation");
  } finally {
    desktop.close();
    await owner.close();
  }
});

test("legacy balanced policy migrates concurrent new work to quota selection", async () => {
  const fixture = createFixture();
  enableBalancedTokens(fixture);
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const desktop = await connectDesktop(fixture, 191, "chatgpt");
  const control = controlClient(fixture, 191);
  const startsPath = join(fixture.root, "fixture-child-thread-starts.log");
  try {
    await bootstrapBalancedRouting(owner, fixture, desktop);
    desktop.send({ jsonrpc: "2.0", id: "concurrent-a", method: "thread/start", params: {} });
    desktop.send({ jsonrpc: "2.0", id: "concurrent-b", method: "thread/start", params: {} });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "concurrent-a") !== undefined, "first concurrent start missing");
    await waitForMessage(desktop.messages, (message) => responseFor([message], "concurrent-b") !== undefined, "second concurrent start missing");
    const starts = readFileSync(startsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.deepEqual(starts.slice(-2), [fixture.accounts[0], fixture.accounts[0]], "the larger available quota wins both concurrent starts");
    const balance = await readBalance(control, "concurrent-balance");
    assert.equal(balance.policy, "quota_aware_v2");
    assert.equal(balance.nextAccountId, null);
  } finally {
    await control.close();
    desktop.close();
    await owner.close();
  }
});

test("balanced routing excludes an account/read signed-out account even when its quota probe is fresh and positive", async () => {
  const fixture = createFixture();
  enableBalancedTokens(fixture);
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, undefined, false, 0, false, fixture.accounts[1]!)]);
  await owner.start();
  const desktop = await connectDesktop(fixture, 192, "chatgpt");
  const control = controlClient(fixture, 192);
  const startsPath = join(fixture.root, "fixture-child-thread-starts.log");
  try {
    desktop.send({ jsonrpc: "2.0", id: "auth-false", method: "thread/start", params: {} });
    const response = await waitForMessage(desktop.messages, (message) => responseFor([message], "auth-false") !== undefined, "signed-out capacity decision missing") as { error?: { data?: { code?: string } } };
    assert.equal(response.error?.data?.code, "unknown_thread_owner");
    assert.equal(existsSync(startsPath), false, "fresh quota alone must never dispatch a signed-out account");
    const balance = await readBalance(control, "auth-false-balance");
    assert.equal(balance.degradedReason, null);
    assert.equal(balance.nextAccountId, null);
  } finally {
    await control.close();
    desktop.close();
    await owner.close();
  }
});

test("quota routing leaves the retired token-balance ledger unchanged by late usage", async () => {
  const fixture = createFixture();
  enableBalancedTokens(fixture);
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, undefined, false, 0, "late")]);
  await owner.start();
  const desktop = await connectDesktop(fixture, 193, "chatgpt");
  const control = controlClient(fixture, 193);
  try {
    await bootstrapBalancedRouting(owner, fixture, desktop);
    desktop.send({ jsonrpc: "2.0", id: "late-thread", method: "thread/start", params: {} });
    const started = await waitForMessage(desktop.messages, (message) => responseFor([message], "late-thread") !== undefined, "late accounting thread missing") as { result?: { threadId?: string } };
    const threadId = started.result?.threadId;
    assert.equal(typeof threadId, "string");
    desktop.send({ jsonrpc: "2.0", id: "late-first", method: "turn/start", params: { threadId, input: [{ type: "text", text: "first delayed usage" }] } });
    const firstTool = await waitForMessage(desktop.messages, (message) => "method" in message && message.method === "app-tools/request", "first late-accounting tool missing") as { id: string | number };
    desktop.send({ jsonrpc: "2.0", id: firstTool.id, result: { approved: true } });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "late-first") !== undefined, "first turn response missing");
    await waitForMessage(desktop.messages, (message) => "method" in message && message.method === "turn/completed", "first terminal notification missing");
    desktop.send({ jsonrpc: "2.0", id: "late-second", method: "turn/start", params: { threadId, input: [{ type: "text", text: "ack then release late" }] } });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "late-second") !== undefined, "overlapping second turn acknowledgement missing");
    const balance = await readBalance(control, "late-repaid-balance");
    const first = balance.accounts.find((account) => account.opaqueAccountId === fixture.accounts[0]);
    assert.equal(balance.policy, "quota_aware_v2");
    assert.equal(first?.completedTokens, 0, "new usage does not rewrite the retired historical ledger");
    assert.equal(first?.unreportedTokens, 0);
    assert.equal(first?.reservedTokens, 0);

  } finally {
    await control.close();
    desktop.close();
    await owner.close();
  }
});

test("a renderer disconnect creates no retired token-balance reservation", async () => {
  const fixture = createFixture();
  enableBalancedTokens(fixture);
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const desktop = await connectDesktop(fixture, 194, "chatgpt");
  try {
    await bootstrapBalancedRouting(owner, fixture, desktop);
    desktop.send({ jsonrpc: "2.0", id: "disconnect-thread", method: "thread/start", params: {} });
    const started = await waitForMessage(desktop.messages, (message) => responseFor([message], "disconnect-thread") !== undefined, "disconnect accounting thread missing") as { result?: { threadId?: string } };
    desktop.send({ jsonrpc: "2.0", id: "disconnect-turn", method: "turn/start", params: { threadId: started.result?.threadId, input: [{ type: "text", text: "complete without tool" }] } });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "disconnect-turn") !== undefined, "turn acknowledgement missing before disconnect");
    desktop.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 70));
    const snapshot = (owner as unknown as { tokenBalance: { accountSummary(account: OpaqueAccountId): { reservedTokens: number; unreportedTokens: number } | null } }).tokenBalance.accountSummary(fixture.accounts[0]!);
    assert.equal(snapshot?.reservedTokens, 0, "terminal provider notification settles the reservation without a renderer");
    assert.equal(snapshot?.unreportedTokens, 0, "quota routing never creates token-balancing debt");
  } finally {
    await owner.close();
  }
});

test("host holds an ineligible continuation, forwards it once to the replacement account, and returns app tools only to its origin desktop", async () => {
  const fixture = createFixture();
  new AccountsPreferencesStore(fixture.root).update({ failoverMode: "ask" });
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const origin = await connectDesktop(fixture, 21, "chatgpt");
  const other = await connectDesktop(fixture, 22, "tweakers");
  seedFreshPrimaryQuota(owner, fixture);
  const control = controlClient(fixture, 21);
  const events: BrokerEventV1[] = [];
  const unsubscribe = control.subscribe((event) => events.push(event));
  try {
    // Start a broker-owned source segment; V3 does not query provider history
    // just to infer a durable owner for an empty canonical store.
    assert.equal(origin.send({ jsonrpc: "2.0", id: "seed", method: "thread/start", params: {} }), true);
    const seeded = await waitForMessage(origin.messages, (message) => responseFor([message], "seed") !== undefined, "thread seed missing") as { result?: { threadId?: string } };
    const sourceThreadId = seeded.result?.threadId;
    assert.match(sourceThreadId ?? "", /^lh_[A-Za-z0-9_-]{43}$/, "desktop receives only the stable logical thread handle");
    // Complete one source-account turn before the account becomes ineligible;
    // safe continuation requires committed canonical context, not a DB replay.
    assert.equal(origin.send({ jsonrpc: "2.0", id: "source-turn", method: "turn/start", params: { threadId: sourceThreadId, input: [{ type: "text", text: "source context" }] } }), true);
    const sourceTool = await waitForMessage(origin.messages, (message) => "method" in message && message.method === "app-tools/request", "source app-tools request missing") as { id: string | number };
    assert.equal(origin.send({ jsonrpc: "2.0", id: sourceTool.id, result: { approved: true } }), true);
    await waitForMessage(origin.messages, (message) => responseFor([message], "source-turn") !== undefined, "source turn response missing");
    const quota = await control.invoke({ version: 1, requestId: "quota", command: "quota.read" });
    assert.equal(quota.ok, true);
    assert.equal(origin.send({ jsonrpc: "2.0", id: "continue", method: "turn/start", params: { threadId: sourceThreadId, input: [{ type: "text", text: "continue safely" }] } }), true);
    const handoffEvent = await waitForBrokerEvent(events, (event) => event.type === "continuation" && isPendingHandoff(event.payload), "held continuation event missing");
    const handoff = handoffEvent.payload as { handoffRef: string; fromOpaqueAccountId: string; toOpaqueAccountId: string };
    assert.equal(handoff.fromOpaqueAccountId, fixture.accounts[0]);
    assert.equal(handoff.toOpaqueAccountId, fixture.accounts[1]);
    assert.equal(responseFor(origin.messages, "continue"), undefined, "continuation must remain held before confirmation");

    const confirmed = await control.invoke({ version: 1, requestId: "confirm", command: "handoff.confirm", params: { handoffRef: handoff.handoffRef } });
    assert.equal(confirmed.ok, true);
    const toolRequest = await waitForMessage(origin.messages, (message) => "method" in message && message.method === "app-tools/request" && message.id !== sourceTool.id, "origin app-tools request missing") as { id: string | number };
    assert.equal(other.messages.some((message) => "method" in message && message.method === "app-tools/request"), false, "another desktop cannot receive origin app tools");
    assert.equal(origin.send({ jsonrpc: "2.0", id: toolRequest.id, result: { approved: true } }), true);
    const forwarded = await waitForMessage(origin.messages, (message) => responseFor([message], "continue") !== undefined, "forwarded continuation response missing");
    assert.equal("result" in forwarded, true);
    await waitForMessage(origin.messages, (message) => "method" in message && message.method === "turn/completed" && origin.messages.filter((entry) => "method" in entry && entry.method === "turn/completed").length >= 2, "target segment completion missing");

    // Exercise the required A -> B -> A shape. A's source native mapping is
    // never reused at B, and returning to A still starts a third segment.
    (owner as unknown as { broker: AccountsBrokerV1 }).broker.updateQuota({ opaqueAccountId: fixture.accounts[0]!, freshness: "fresh", remainingPercent: 80, resetAt: "2099-09-03T00:00:00.000Z", observedAt: Date.now(), shortWindowPressure: 0, resetCredits: 0 });
    (owner as unknown as { broker: AccountsBrokerV1 }).broker.updateQuota({ opaqueAccountId: fixture.accounts[1]!, freshness: "fresh", remainingPercent: 0, resetAt: "2099-09-03T00:00:00.000Z", observedAt: Date.now(), shortWindowPressure: 100, resetCredits: 0 });
    assert.equal(origin.send({ jsonrpc: "2.0", id: "return-to-a", method: "turn/start", params: { threadId: sourceThreadId, input: [{ type: "text", text: "return safely" }] } }), true);
    const returnHandoffEvent = await waitForBrokerEvent(events, (event) => event.type === "continuation" && isPendingHandoff(event.payload) && (event.payload as { toOpaqueAccountId?: string }).toOpaqueAccountId === fixture.accounts[0], "return handoff missing");
    const returnHandoff = returnHandoffEvent.payload as { handoffRef: string };
    const returnConfirmed = await control.invoke({ version: 1, requestId: "return-confirm", command: "handoff.confirm", params: { handoffRef: returnHandoff.handoffRef } });
    assert.equal(returnConfirmed.ok, true);
    const returnTool = await waitForMessage(origin.messages, (message) => "method" in message && message.method === "app-tools/request" && message.id !== sourceTool.id && message.id !== toolRequest.id, "return origin app-tools request missing") as { id: string | number };
    origin.send({ jsonrpc: "2.0", id: returnTool.id, result: { approved: true } });
    await waitForMessage(origin.messages, (message) => responseFor([message], "return-to-a") !== undefined, "return completion response missing");
    await waitForMessage(origin.messages, (message) => "method" in message && message.method === "turn/completed" && origin.messages.filter((entry) => "method" in entry && entry.method === "turn/completed").length >= 3, "return segment completion missing");

    const canonical = JSON.parse(readFileSync(join(fixture.root, "canonical-history.v1.json"), "utf8")) as { conversations: Array<{ segments: Array<{ opaqueAccountId: string; nativeThreadId: string; state: string }> }> };
    const segments = canonical.conversations[0]?.segments ?? [];
    assert.deepEqual(segments.map((segment) => segment.opaqueAccountId), [fixture.accounts[0], fixture.accounts[1], fixture.accounts[0]]);
    assert.equal(new Set(segments.map((segment) => segment.nativeThreadId)).size, 3, "each physical segment has its own account-local native thread");
    assert.deepEqual(segments.map((segment) => segment.state), ["committed", "committed", "committed"]);
    const state = new RouterStateStore(fixture.root, fixture.config).snapshot();
    assert.equal(state.threadOwners[sourceThreadId!], undefined, "public logical ids never become provider-owner keys");
    assert.equal(Object.values(state.threadOwners).filter((ownerAccount) => ownerAccount === fixture.accounts[0]).length >= 1, true, "source native ownership remains private and immutable");
    assert.equal(Object.entries(state.threadOwners).filter(([threadId]) => threadId.startsWith("fresh-")).some(([, account]) => account === fixture.accounts[1]), true, "target account receives a distinct native segment");

    const repeated = await control.invoke({ version: 1, requestId: "confirm-again", command: "handoff.confirm", params: { handoffRef: handoff.handoffRef } });
    assert.equal(repeated.ok, false);
    assert.equal(origin.messages.filter((message) => responseFor([message], "continue") !== undefined).length, 1, "the held continuation is written exactly once");
  } finally {
    unsubscribe();
    await control.close();
    origin.close();
    other.close();
    await owner.close();
  }
});

test("canonical committed transcript is schema-valid, peer-synchronized, and remains readable while its account is offline", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const origin = await connectDesktop(fixture, 61, "chatgpt");
  const peer = await connectDesktop(fixture, 62, "tweakers");
  seedFreshPrimaryQuota(owner, fixture);
  const peerControl = controlClient(fixture, 62, "tweakers");
  try {
    origin.send({ jsonrpc: "2.0", id: "logical-start", method: "thread/start", params: {} });
    const started = await waitForMessage(origin.messages, (message) => responseFor([message], "logical-start") !== undefined, "logical start missing") as { result?: { threadId?: string } };
    const publicThreadId = started.result?.threadId;
    assert.match(publicThreadId ?? "", /^lh_[A-Za-z0-9_-]{43}$/);

    peer.send({ jsonrpc: "2.0", id: "peer-read-empty", method: "thread/read", params: { threadId: publicThreadId, includeTurns: true } });
    const initialRead = await waitForMessage(peer.messages, (message) => responseFor([message], "peer-read-empty") !== undefined, "peer canonical read missing") as { result?: unknown };
    assertGeneratedSchema("ThreadReadResponse", initialRead.result);

    origin.send({ jsonrpc: "2.0", id: "logical-turn", method: "turn/start", params: { threadId: publicThreadId, input: [{ type: "text", text: "shared completion" }] } });
    const toolRequest = await waitForMessage(origin.messages, (message) => "method" in message && message.method === "app-tools/request", "origin tool request missing") as { id: string | number };
    const activeHistory = await peerControl.invoke({ version: 1, requestId: "peer-active-history", command: "history.read" }) as {
      ok: boolean;
      result?: { conversation?: { activeClient?: { clientId?: string } | null; peerBusy?: boolean; historyWarning?: string | null } | null };
    };
    assert.equal(activeHistory.result?.conversation?.activeClient?.clientId, origin.rendererRef, "the connected active desktop is the current owner");
    assert.equal(activeHistory.result?.conversation?.peerBusy, true, "a connected different desktop sees the active conversation");
    assert.equal(activeHistory.result?.conversation?.historyWarning, null, "ordinary active work is not a missing-history warning");
    peer.send({ jsonrpc: "2.0", id: "peer-simultaneous-turn", method: "turn/start", params: { threadId: publicThreadId, input: [{ type: "text", text: "must not dispatch" }] } });
    const busy = await waitForMessage(peer.messages, (message) => responseFor([message], "peer-simultaneous-turn") !== undefined, "peer busy response missing") as { error?: { data?: { code?: string } } };
    assert.equal(busy.error?.data?.code, "conversation_busy");
    peer.send({ jsonrpc: "2.0", id: "peer-steer", method: "turn/steer", params: { threadId: publicThreadId, input: [{ type: "text", text: "must not steer peer turn" }] } });
    peer.send({ jsonrpc: "2.0", id: "peer-mutation", method: "thread/name/set", params: { threadId: publicThreadId, name: "must not mutate peer thread" } });
    const steer = await waitForMessage(peer.messages, (message) => responseFor([message], "peer-steer") !== undefined, "peer steer rejection missing") as { error?: { data?: { code?: string } } };
    const mutation = await waitForMessage(peer.messages, (message) => responseFor([message], "peer-mutation") !== undefined, "peer mutation rejection missing") as { error?: { data?: { code?: string } } };
    assert.equal(steer.error?.data?.code, "conversation_busy");
    assert.equal(mutation.error?.data?.code, "conversation_busy");
    origin.send({ jsonrpc: "2.0", id: toolRequest.id, result: { approved: true } });
    await waitForMessage(origin.messages, (message) => responseFor([message], "logical-turn") !== undefined, "origin completion response missing");
    const peerCommit = await waitForMessage(peer.messages, (message) => "method" in message && message.method === "turn/completed", "peer did not receive canonical completed turn") as { params?: unknown };
    assertGeneratedSchema("TurnCompletedNotification", peerCommit.params);
    assert.match(JSON.stringify(peerCommit), /shared completion|fixture completed/);
    assert.doesNotMatch(JSON.stringify(peerCommit), /(?:fresh-|native-(?:turn|user|agent)-)/);
    assert.equal(origin.messages.filter((message) => "method" in message && message.method === "app-tools/request").length, 1);
    assert.equal(peer.messages.some((message) => "method" in message && message.method === "app-tools/request"), false, "tools remain origin-only");

    origin.send({ jsonrpc: "2.0", id: "logical-list", method: "thread/list", params: { limit: 50, cursor: null, sortDirection: "desc", sortKey: "updated_at", archived: false, cwd: null, modelProviders: ["openai"], sourceKinds: ["appServer"] } });
    const list = await waitForMessage(origin.messages, (message) => responseFor([message], "logical-list") !== undefined, "canonical list missing") as { result?: unknown };
    assertGeneratedSchema("ThreadListResponse", list.result);
    origin.send({ jsonrpc: "2.0", id: "logical-search", method: "thread/search", params: { searchTerm: "shared", limit: 50, cursor: null, sortDirection: "desc", sortKey: "updated_at", archived: false, sourceKinds: ["appServer"] } });
    const search = await waitForMessage(origin.messages, (message) => responseFor([message], "logical-search") !== undefined, "canonical search missing") as { result?: unknown };
    assertGeneratedSchema("ThreadSearchResponse", search.result);
    origin.send({ jsonrpc: "2.0", id: "logical-turns", method: "thread/turns/list", params: { threadId: publicThreadId, itemsView: "full", limit: 50, cursor: null, sortDirection: "asc" } });
    const turns = await waitForMessage(origin.messages, (message) => responseFor([message], "logical-turns") !== undefined, "canonical turns missing") as { result?: unknown };
    assertGeneratedSchema("ThreadTurnsListResponse", turns.result);
    origin.send({ jsonrpc: "2.0", id: "logical-items", method: "thread/items/list", params: { threadId: publicThreadId, limit: 50, cursor: null, sortDirection: "asc" } });
    const items = await waitForMessage(origin.messages, (message) => responseFor([message], "logical-items") !== undefined, "canonical items missing") as { result?: unknown };
    assertGeneratedSchema("ThreadItemsListResponse", items.result);

    (owner as unknown as { broker: AccountsBrokerV1 }).broker.markChildUnavailable(fixture.accounts[0]!);
    peer.send({ jsonrpc: "2.0", id: "peer-read-offline", method: "thread/read", params: { threadId: publicThreadId, includeTurns: true } });
    const offlineRead = await waitForMessage(peer.messages, (message) => responseFor([message], "peer-read-offline") !== undefined, "offline canonical read missing") as { result?: unknown };
    assertGeneratedSchema("ThreadReadResponse", offlineRead.result);
    const history = await peerControl.invoke({ version: 1, requestId: "peer-history", command: "history.read" });
    assert.equal(history.ok, true);
    assert.match(JSON.stringify(history.ok ? history.result : null), /"availability":"partial"/);
    assert.doesNotMatch(JSON.stringify([...origin.messages, ...peer.messages]), /(?:fresh-|native-(?:turn|user|agent)-)/);
  } finally {
    origin.close();
    peer.close();
    await owner.close();
  }
});

for (const failure of ["exit", "stdin", "stdout", "kill-error"] as const) test(`an unexpected child ${failure} failure settles the written turn as ambiguous without replaying it`, async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const origin = await connectDesktop(fixture, 71, "chatgpt");
  seedFreshPrimaryQuota(owner, fixture);
  try {
    origin.send({ jsonrpc: "2.0", id: "crash-thread", method: "thread/start", params: {} });
    const started = await waitForMessage(origin.messages, (message) => responseFor([message], "crash-thread") !== undefined, "crash fixture thread missing") as { result?: { threadId?: string } };
    const publicThreadId = started.result?.threadId;
    assert.match(publicThreadId ?? "", /^lh_[A-Za-z0-9_-]{43}$/);

    origin.send({ jsonrpc: "2.0", id: "crash-turn", method: "turn/start", params: { threadId: publicThreadId, input: [{ type: "text", text: failure === "exit" ? "crash child" : "transport failure" }] } });
    await waitForMessage(origin.messages, (message) => "method" in message && message.method === "app-tools/request", "child did not reach the provider write boundary");
    if (failure !== "exit") {
      const internals = owner as unknown as { children: Map<OpaqueAccountId, { child: ChildProcess }> };
      const heldChild = internals.children.get(fixture.accounts[0]!)!;
      const processChild = heldChild.child;
      const originalKill = processChild.kill.bind(processChild);
      if (failure === "kill-error") processChild.kill = () => {
        processChild.emit("error", Object.assign(new Error("fixture signal failure"), { code: "EPERM" }));
        return false;
      };
      processChild[failure === "kill-error" ? "stdin" : failure]!.emit("error", Object.assign(new Error("fixture transport failure"), { code: "EPIPE" }));
      if (failure === "kill-error") {
        try {
          assert.equal(internals.children.get(fixture.accounts[0]!), heldChild, "failed signalling retains the native writer ownership");
          assert.equal(processChild.exitCode, null);
          assert.equal(await (owner as any).initializeChild(heldChild), false, "a cached successful handshake cannot make a broken transport ready again");
          origin.send({ jsonrpc: "2.0", id: "broken-child-read", method: "app/installed", params: {} });
          const rejected = await waitForMessage(origin.messages, (message) => responseFor([message], "broken-child-read") !== undefined, "broken child must fail promptly without starving the broker event loop") as { error?: { data?: { code?: string } } };
          assert.equal(rejected.error?.data?.code, "post_start_failure");
          assert.equal(internals.children.get(fixture.accounts[0]!), heldChild, "rejected reads retain ownership until real exit");
        } finally {
          processChild.kill = originalKill;
          originalKill("SIGTERM");
        }
      }
    }
    const terminal = await waitForMessage(origin.messages, (message) => responseFor([message], "crash-turn") !== undefined, "child-exit terminal response missing") as { error?: { data?: { code?: string } } };
    assert.equal(terminal.error?.data?.code, "post_start_failure");

    const canonical = JSON.parse(readFileSync(join(fixture.root, "canonical-history.v1.json"), "utf8")) as {
      conversations: Array<{ segments: Array<{ state: string; turns: Array<{ state: string; phase: string }> }> }>;
    };
    const turn = canonical.conversations[0]?.segments[0]?.turns[0];
    assert.equal(turn?.state, "ambiguous", "possibly-written work is terminally ambiguous and cannot be replayed");
    assert.equal(turn?.phase, "ambiguous");
  } finally {
    origin.close();
    await owner.close();
  }
});

test("the bounded pending-desktop timeout releases the lease once and makes a possibly-written turn ambiguous", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const origin = await connectDesktop(fixture, 72, "chatgpt");
  seedFreshPrimaryQuota(owner, fixture);
  try {
    origin.send({ jsonrpc: "2.0", id: "timeout-thread", method: "thread/start", params: {} });
    const started = await waitForMessage(origin.messages, (message) => responseFor([message], "timeout-thread") !== undefined, "timeout fixture thread missing") as { result?: { threadId?: string } };
    origin.send({ jsonrpc: "2.0", id: "timeout-turn", method: "turn/start", params: { threadId: started.result?.threadId, input: [{ type: "text", text: "ack then wait" }] } });
    await waitForMessage(origin.messages, (message) => responseFor([message], "timeout-turn") !== undefined, "timeout fixture acknowledgement missing");
    const acknowledgements = origin.messages.filter((message) => responseFor([message], "timeout-turn") !== undefined).length;
    const internals = owner as unknown as { pendingDesktop: Map<string, unknown>; expirePendingDesktop(id: string): void };
    const pendingId = [...internals.pendingDesktop.keys()][0];
    assert.ok(pendingId, "turn request must have a bounded pending entry");
    internals.expirePendingDesktop(pendingId!);
    await waitForCondition(() => origin.messages.filter((message) => responseFor([message], "timeout-turn") !== undefined).length === acknowledgements + 1, "timeout terminal response missing");
    const terminal = origin.messages.filter((message) => responseFor([message], "timeout-turn") !== undefined).at(-1) as { error?: { data?: { code?: string } } };
    assert.equal(terminal.error?.data?.code, "post_start_failure");
    const canonical = JSON.parse(readFileSync(join(fixture.root, "canonical-history.v1.json"), "utf8")) as { conversations: Array<{ segments: Array<{ turns: Array<{ phase: string }> }> }> };
    assert.equal(canonical.conversations[0]?.segments[0]?.turns[0]?.phase, "ambiguous");
    assert.equal(internals.pendingDesktop.size, 0, "timeout cleanup must not leak an outstanding request");
  } finally {
    origin.close();
    await owner.close();
  }
});

for (const reset of [false, true]) test(`an acknowledged turn remains terminally watched through app-server ${reset ? "reset" : "disconnect"} and same-renderer reconnect`, async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const origin = await connectDesktop(fixture, 73, "chatgpt");
  seedFreshPrimaryQuota(owner, fixture);
  let reconnected: DesktopClient | null = null;
  try {
    origin.send({ jsonrpc: "2.0", id: "disconnect-thread", method: "thread/start", params: {} });
    const started = await waitForMessage(origin.messages, (message) => responseFor([message], "disconnect-thread") !== undefined, "disconnect fixture thread missing") as { result?: { threadId?: string } };
    const publicThreadId = started.result?.threadId;
    origin.send({ jsonrpc: "2.0", id: "disconnect-turn", method: "turn/start", params: { threadId: publicThreadId, input: [{ type: "text", text: "ack then wait" }] } });
    const acknowledgement = await waitForMessage(origin.messages, (message) => responseFor([message], "disconnect-turn") !== undefined, "turn/start acknowledgement missing") as { result?: { threadId?: string } };
    assert.equal(acknowledgement.result?.threadId, publicThreadId, "acknowledgement must use the stable logical id");
    const localControl = controlClient(fixture, 73);
    const localHistory = await localControl.invoke({ version: 1, requestId: "local-active-history", command: "history.read" }) as {
      ok: boolean;
      result?: { conversation?: { activeClient?: { clientId?: string } | null; peerBusy?: boolean; historyWarning?: string | null } | null };
    };
    assert.equal(localHistory.result?.conversation?.activeClient?.clientId, origin.rendererRef);
    assert.equal(localHistory.result?.conversation?.peerBusy, false, "the active local desktop is not its own peer");
    assert.equal(localHistory.result?.conversation?.historyWarning, null, "active work alone is not a terminal warning");
    await localControl.close();
    const internals = owner as unknown as { pendingDesktop: Map<string, unknown>; clients: Map<OpaqueRendererRef, { socket: Socket }> };
    assert.equal(internals.pendingDesktop.size, 1, "acknowledgement must retain one terminal watchdog until completion");
    if (reset) internals.clients.get(origin.rendererRef)!.socket.emit("error", Object.assign(new Error("fixture renderer reset"), { code: "ECONNRESET" }));
    else origin.close();
    await waitForCondition(() => {
      const canonical = JSON.parse(readFileSync(join(fixture.root, "canonical-history.v1.json"), "utf8")) as { conversations: Array<{ segments: Array<{ turns: Array<{ phase: string }> }> }> };
      return canonical.conversations[0]?.segments[0]?.turns[0]?.phase === "ambiguous";
    }, "disconnect did not settle the active canonical lease");

    reconnected = await connectDesktop(fixture, 73, "chatgpt");
    reconnected.send({ jsonrpc: "2.0", id: "reconnect-read", method: "thread/read", params: { threadId: publicThreadId, includeTurns: true } });
    const read = await waitForMessage(reconnected.messages, (message) => responseFor([message], "reconnect-read") !== undefined, "same renderer could not reconnect after cleanup") as { result?: unknown };
    assertGeneratedSchema("ThreadReadResponse", read.result);
    const reconnectedControl = controlClient(fixture, 73);
    const history = await reconnectedControl.invoke({ version: 1, requestId: "reconnect-history", command: "history.read" }) as {
      ok: boolean;
      result?: { conversation?: { activeClient?: unknown; peerBusy?: boolean; historyWarning?: string | null } | null };
    };
    assert.equal(history.result?.conversation?.activeClient, null, "a disconnected renderer is not retained as a live owner");
    assert.equal(history.result?.conversation?.peerBusy, false, "stale renderer state cannot claim peer activity");
    assert.equal(history.result?.conversation?.historyWarning, "ambiguous", "the terminal uncertainty remains visible after reconnect");
    await reconnectedControl.close();
  } finally {
    reconnected?.close();
    origin.close();
    await owner.close();
  }
});

test("a nonportable continuation is rejected before destination dispatch with a durable content-free incomplete receipt", async () => {
  const fixture = createFixture();
  new AccountsPreferencesStore(fixture.root).update({ failoverMode: "ask" });
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  const origin = await connectDesktop(fixture, 81, "chatgpt");
  seedFreshPrimaryQuota(owner, fixture);
  const control = controlClient(fixture, 81);
  const events: BrokerEventV1[] = [];
  const unsubscribe = control.subscribe((event) => events.push(event));
  let ownerClosed = false;
  let restartedOwner: AccountsBrokerOwnerV1 | null = null;
  let restartedClient: DesktopClient | null = null;
  let restartedControl: AccountsBrokerSocketClientV1 | null = null;
  try {
    origin.send({ jsonrpc: "2.0", id: "attachment-source", method: "thread/start", params: {} });
    const started = await waitForMessage(origin.messages, (message) => responseFor([message], "attachment-source") !== undefined, "attachment source thread missing") as { result?: { threadId?: string } };
    const publicThreadId = started.result?.threadId;
    origin.send({ jsonrpc: "2.0", id: "attachment-source-turn", method: "turn/start", params: { threadId: publicThreadId, input: [{ type: "text", text: "portable source context" }] } });
    const sourceTool = await waitForMessage(origin.messages, (message) => "method" in message && message.method === "app-tools/request", "attachment source tool request missing") as { id: string | number };
    origin.send({ jsonrpc: "2.0", id: sourceTool.id, result: { approved: true } });
    await waitForMessage(origin.messages, (message) => responseFor([message], "attachment-source-turn") !== undefined, "attachment source completion missing");
    await control.invoke({ version: 1, requestId: "attachment-quota", command: "quota.read" });
    const startsBeforeUnsafeContinuation = existsSync(join(fixture.root, "fixture-child-starts.log")) ? readFileSync(join(fixture.root, "fixture-child-starts.log"), "utf8") : "";
    const threadStartsBeforeUnsafeContinuation = existsSync(join(fixture.root, "fixture-child-thread-starts.log")) ? readFileSync(join(fixture.root, "fixture-child-thread-starts.log"), "utf8") : "";

    const unsafeReference = "file:///private/unsafe-account-local/image.png";
    origin.send({ jsonrpc: "2.0", id: "attachment-continue", method: "turn/start", params: {
      threadId: publicThreadId,
      input: [{ type: "localImage", path: unsafeReference }],
    } });
    const held = await waitForBrokerEvent(events, (event) => event.type === "continuation" && isPendingHandoff(event.payload), "unsupported continuation was not held") as { payload: { handoffRef: string } };
    const confirmation = await control.invoke({ version: 1, requestId: "attachment-confirm", command: "handoff.confirm", params: { handoffRef: held.payload.handoffRef } });
    assert.equal(confirmation.ok, false, "a nonportable input must not reach a target account");
    assert.equal(confirmation.ok ? null : confirmation.error.code, "linked_continuation_required", "control receives the distinct pre-dispatch outcome");
    const terminal = await waitForMessage(origin.messages, (message) => responseFor([message], "attachment-continue") !== undefined, "linked-continuation response missing") as { error?: { data?: { code?: string } } };
    assert.equal(terminal.error?.data?.code, "linked_continuation_required");
    assert.doesNotMatch(JSON.stringify(origin.messages), /unsafe-account-local|image\.png/, "unverified local references never leave the broker hold");
    assert.doesNotMatch(JSON.stringify({ events, confirmation, terminal }), /unsafe-account-local|image\.png|localImage/, "control events and terminal responses retain only the bounded outcome code");

    const canonicalPath = join(fixture.root, "canonical-history.v1.json");
    const canonicalRaw = readFileSync(canonicalPath, "utf8");
    const canonical = JSON.parse(canonicalRaw) as {
      conversations: Array<{ availability: string; segments: Array<{ opaqueAccountId: string; state: string; turns: Array<{ state: string; phase: string; nativeTurnId: unknown; nativeItemIds: unknown; serializedInput: unknown; portableTranscript: unknown }> }> }>;
    };
    const sourceSegment = canonical.conversations[0]?.segments[0];
    const receipt = sourceSegment?.turns.at(-1);
    assert.equal(canonical.conversations[0]?.segments.length, 1, "pre-dispatch rejection never fabricates a target physical segment");
    assert.equal(sourceSegment?.opaqueAccountId, fixture.accounts[0]);
    assert.equal(canonical.conversations[0]?.availability, "incomplete");
    assert.deepEqual(receipt && {
      state: receipt.state,
      phase: receipt.phase,
      nativeTurnId: receipt.nativeTurnId,
      nativeItemIds: receipt.nativeItemIds,
      serializedInput: receipt.serializedInput,
      portableTranscript: receipt.portableTranscript,
    }, {
      state: "incomplete",
      phase: "aborted",
      nativeTurnId: null,
      nativeItemIds: [],
      serializedInput: null,
      portableTranscript: null,
    }, "the durable receipt stores no rejected continuation payload");
    const durableFiles = [
      canonicalRaw,
      existsSync(join(fixture.root, "canonical-history.v1.journal.jsonl")) ? readFileSync(join(fixture.root, "canonical-history.v1.journal.jsonl"), "utf8") : "",
      readFileSync(join(fixture.root, "router-state.json"), "utf8"),
    ].join("\n");
    assert.doesNotMatch(durableFiles, /unsafe-account-local|image\.png|localImage/, "unsafe continuation data never enters a state/snapshot/journal artifact");
    const startsAfterRejection = existsSync(join(fixture.root, "fixture-child-starts.log")) ? readFileSync(join(fixture.root, "fixture-child-starts.log"), "utf8") : "";
    assert.equal(startsAfterRejection, startsBeforeUnsafeContinuation, "the nonportable continuation itself never acquires or starts a destination child");
    const threadStartsAfterRejection = existsSync(join(fixture.root, "fixture-child-thread-starts.log")) ? readFileSync(join(fixture.root, "fixture-child-thread-starts.log"), "utf8") : "";
    assert.equal(threadStartsAfterRejection, threadStartsBeforeUnsafeContinuation, "the nonportable continuation never issues a destination thread/start provider request");

    // A later safe turn succeeds on the source account, yet must not erase
    // the known terminal continuity gap from the logical projection.
    const internals = owner as unknown as { broker: AccountsBrokerV1 };
    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[0]!, freshness: "fresh", remainingPercent: 80, resetAt: "2099-09-03T00:00:00.000Z", observedAt: Date.now(), shortWindowPressure: 0, resetCredits: 0 }), true);
    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[1]!, freshness: "fresh", remainingPercent: 0, resetAt: "2099-09-03T00:00:00.000Z", observedAt: Date.now(), shortWindowPressure: 100, resetCredits: 0 }), true);
    origin.send({ jsonrpc: "2.0", id: "safe-after-gap", method: "turn/start", params: { threadId: publicThreadId, input: [{ type: "text", text: "later safe source turn" }] } });
    const laterTool = await waitForMessage(origin.messages, (message) => "method" in message && message.method === "app-tools/request" && message.id !== sourceTool.id, "later safe source tool request missing") as { id: string | number };
    origin.send({ jsonrpc: "2.0", id: laterTool.id, result: { approved: true } });
    await waitForMessage(origin.messages, (message) => responseFor([message], "safe-after-gap") !== undefined, "later safe source completion missing");
    const currentHistory = await control.invoke({ version: 1, requestId: "history-after-gap", command: "history.read" }) as { ok: boolean; result?: { conversation?: { availability?: string; historyWarning?: string | null } | null } };
    assert.equal(currentHistory.ok, true);
    assert.equal(currentHistory.result?.conversation?.availability, "incomplete", "a later successful turn must not overwrite the known gap");
    assert.equal(currentHistory.result?.conversation?.historyWarning, "content_gap", "the durable failed receipt remains explicit after later success");
    assert.equal(events.some((event) => event.type === "history"
      && (event.payload as { historyWarning?: string | null }).historyWarning === "content_gap"), true,
    "the runtime event validator preserves the explicit warning");

    // Invalid but non-nonportable input remains the ordinary pre-dispatch
    // rejection and must not add a linked-continuation receipt.
    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[0]!, freshness: "fresh", remainingPercent: 0, resetAt: "2099-09-03T00:00:00.000Z", observedAt: Date.now(), shortWindowPressure: 100, resetCredits: 0 }), true);
    assert.equal(internals.broker.updateQuota({ opaqueAccountId: fixture.accounts[1]!, freshness: "fresh", remainingPercent: 80, resetAt: "2099-09-03T00:00:00.000Z", observedAt: Date.now(), shortWindowPressure: 0, resetCredits: 0 }), true);
    const beforeGenericRejection = JSON.parse(readFileSync(canonicalPath, "utf8")) as typeof canonical;
    const turnCountBeforeGenericRejection = beforeGenericRejection.conversations[0]?.segments[0]?.turns.length;
    origin.send({ jsonrpc: "2.0", id: "invalid-continue", method: "turn/start", params: { threadId: publicThreadId, input: [{ type: "text", text: "" }] } });
    const invalidHeld = await waitForBrokerEvent(events, (event) => event.type === "continuation" && isPendingHandoff(event.payload) && (event.payload as { handoffRef: string }).handoffRef !== held.payload.handoffRef, "invalid continuation was not held") as { payload: { handoffRef: string } };
    const invalidConfirmation = await control.invoke({ version: 1, requestId: "invalid-confirm", command: "handoff.confirm", params: { handoffRef: invalidHeld.payload.handoffRef } });
    assert.equal(invalidConfirmation.ok, false);
    assert.equal(invalidConfirmation.ok ? null : invalidConfirmation.error.code, "handoff_unavailable");
    const invalidTerminal = await waitForMessage(origin.messages, (message) => responseFor([message], "invalid-continue") !== undefined, "ordinary rejection desktop response missing") as { error?: { data?: { code?: string } } };
    assert.equal(invalidTerminal.error?.data?.code, "handoff_unavailable");
    const afterGenericRejection = JSON.parse(readFileSync(canonicalPath, "utf8")) as typeof canonical;
    assert.equal(afterGenericRejection.conversations[0]?.segments[0]?.turns.length, turnCountBeforeGenericRejection, "ordinary rejection must not fabricate a linked receipt");

    // Reopen the synthetic owner and refetch canonical history without any
    // account DB merge. The committed transcript remains readable and the
    // durable gap remains visible as incomplete.
    unsubscribe();
    await control.close();
    origin.close();
    await owner.close();
    ownerClosed = true;
    restartedOwner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
    await restartedOwner.start();
    restartedClient = await connectDesktop(fixture, 81, "chatgpt");
    restartedClient.send({ jsonrpc: "2.0", id: "restart-read", method: "thread/read", params: { threadId: publicThreadId, includeTurns: true } });
    const restartedRead = await waitForMessage(restartedClient.messages, (message) => responseFor([message], "restart-read") !== undefined, "restart canonical read missing") as { result?: unknown };
    assertGeneratedSchema("ThreadReadResponse", restartedRead.result);
    assert.match(JSON.stringify(restartedRead), /portable source context/);
    assert.doesNotMatch(JSON.stringify(restartedRead), /unsafe-account-local|image\.png/);
    restartedControl = controlClient(fixture, 81);
    const restartHistory = await restartedControl.invoke({ version: 1, requestId: "restart-history", command: "history.read" }) as { ok: boolean; result?: { conversation?: { availability?: string; historyWarning?: string | null } | null } };
    assert.equal(restartHistory.ok, true);
    assert.equal(restartHistory.result?.conversation?.availability, "incomplete");
    assert.equal(restartHistory.result?.conversation?.historyWarning, "content_gap");
  } finally {
    restartedClient?.close();
    await restartedControl?.close();
    if (restartedOwner) await restartedOwner.close();
    unsubscribe();
    await control.close();
    origin.close();
    if (!ownerClosed) await owner.close();
  }
});

test("dynamic enrollment uses a temporary isolated home, canonical opaque id, and restart-preflight-compatible materialization", async () => {
  const fixture = createFixture({ adoption: true });
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  await owner.start();
  await connectDesktop(fixture, 31, "chatgpt");
  const control = controlClient(fixture, 31);
  try {
    const started = await control.invoke({ version: 1, requestId: "enroll-start", command: "enrollment.start" });
    assert.equal(started.ok, true, JSON.stringify(started));
    const enrollment = started.ok ? started.result as { enrollmentRef: string } : null;
    assert.ok(enrollment?.enrollmentRef);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const completed = await control.invoke({ version: 1, requestId: "enroll-status", command: "enrollment.status", params: { enrollmentRef: enrollment!.enrollmentRef } });
    assert.equal(completed.ok, true);
    const expected = opaque(fixture.secret, "enrolled-fixture-account");
    const profile = await control.invoke({ version: 1, requestId: "profile", command: "profile.read" });
    assert.equal(profile.ok, true);
    assert.equal(profile.ok ? (profile.result as { accounts: Array<{ opaqueAccountId: string }> }).accounts.some((account) => account.opaqueAccountId === expected) : false, true);
    assert.equal(existsSync(join(fixture.root, "accounts", expected, "codex-home", "auth.json")), true);
    assert.equal(existsSync(join(fixture.root, "accounts", expected, "sqlite-home")), true);
    const enrolledSkill = join(fixture.root, "accounts", expected, "codex-home", "skills", "fixture", "SKILL.md");
    assert.equal(readFileSync(enrolledSkill, "utf8"), "fixture shared skill\n");
    assert.equal(lstatSync(enrolledSkill).mode & 0o777, 0o400, "enrollment materializes the sealed manager Skills source before its child starts");
    const persisted = JSON.parse(readFileSync(join(fixture.root, "account-router-config.json"), "utf8")) as RouterConfigV3;
    assert.equal(persisted.accounts.some((account) => account.opaqueAccountId === expected), true);
    assert.equal(preflightRouterHomes(persisted, fixture.root), true, "new canonical account home survives the strict restart preflight");

    // A second fresh enrollment authenticating to the same private account id
    // cannot duplicate an account/home or turn a retry into a copied login.
    const second = await control.invoke({ version: 1, requestId: "enroll-again", command: "enrollment.start" });
    assert.equal(second.ok, true);
    const secondEnrollment = second.ok ? second.result as { enrollmentRef: string } : null;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const duplicate = await control.invoke({ version: 1, requestId: "enroll-again-status", command: "enrollment.status", params: { enrollmentRef: secondEnrollment!.enrollmentRef } });
    assert.equal(duplicate.ok, true, "the lifecycle query itself remains redacted and successful");
    assert.equal(duplicate.ok ? (duplicate.result as { state: string }).state : null, "failed", "duplicate materialization fails closed");
    const afterDuplicate = JSON.parse(readFileSync(join(fixture.root, "account-router-config.json"), "utf8")) as RouterConfigV3;
    assert.equal(afterDuplicate.accounts.filter((account) => account.opaqueAccountId === expected).length, 1);
  } finally {
    await control.close();
    await owner.close();
  }
});

test("enrollment materialization recovers one canonical home after every durable process-death boundary", async () => {
  const restartTable: ReadonlyArray<{ faultAt: EnrollmentMaterializationFaultPointV1; journalPhase: string | null }> = [
    { faultAt: "after_home_move", journalPhase: "home_moved" },
    { faultAt: "after_state_publish", journalPhase: "state_published" },
    { faultAt: "after_config_publish", journalPhase: "config_published" },
    { faultAt: "after_final_commit", journalPhase: null },
  ];

  for (const { faultAt, journalPhase } of restartTable) {
    const fixture = createFixture({ adoption: true });
    const expected = opaque(fixture.secret, "enrolled-fixture-account");
    let failedOwner: AccountsBrokerOwnerV1 | null = new AccountsBrokerOwnerV1(
      fixture.config,
      fixture.root,
      fixture.secret,
      process.execPath,
      ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)],
      { enrollmentMaterializationFaultAt: faultAt },
    );
    let failedControl: AccountsBrokerSocketClientV1 | null = null;
    let recoveredOwner: AccountsBrokerOwnerV1 | null = null;
    let recoveredControl: AccountsBrokerSocketClientV1 | null = null;
    try {
      await failedOwner.start();
      await connectDesktop(fixture, 110 + restartTable.findIndex((row) => row.faultAt === faultAt), "chatgpt");
      failedControl = controlClient(fixture, 110 + restartTable.findIndex((row) => row.faultAt === faultAt));
      const started = await failedControl.invoke({ version: 1, requestId: `${faultAt}-start`, command: "enrollment.start" });
      assert.equal(started.ok, true, `${faultAt}: enrollment start failed before the fault boundary`);
      const enrollmentRef = started.ok ? (started.result as { enrollmentRef: string }).enrollmentRef : null;
      assert.ok(enrollmentRef, `${faultAt}: enrollment reference missing`);

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      const interrupted = await failedControl.invoke({ version: 1, requestId: `${faultAt}-status`, command: "enrollment.status", params: { enrollmentRef: enrollmentRef! } });
      assert.equal(interrupted.ok, true, `${faultAt}: interrupted enrollment status was not observable`);
      assert.equal(interrupted.ok ? (interrupted.result as { state: string }).state : null, "failed", `${faultAt}: fault hook was not reached`);

      const journalPath = join(fixture.root, "enrollment-materialization.v1.json");
      if (journalPhase === null) {
        assert.equal(existsSync(journalPath), false, `${faultAt}: the final-commit fault must run after journal cleanup`);
      } else {
        assert.equal(existsSync(journalPath), true, `${faultAt}: durable recovery journal missing`);
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { phase?: string; opaqueAccountId?: string };
        assert.equal(journal.phase, journalPhase, `${faultAt}: unexpected durable recovery phase`);
        assert.equal(journal.opaqueAccountId, expected, `${faultAt}: journal must bind the one canonical account`);
        assert.doesNotMatch(JSON.stringify(journal), /enrolled-fixture-account|never-public/, `${faultAt}: journal exposed private enrollment identity or credentials`);
      }
      assert.doesNotMatch(JSON.stringify([started, interrupted]), /enrolled-fixture-account|never-public/, `${faultAt}: public enrollment result exposed private enrollment data`);

      await failedControl.close();
      failedControl = null;
      await failedOwner.close();
      failedOwner = null;

      // Pass the original fixture config deliberately: recovery must obtain
      // the committed next generation from disk, including after_final_commit.
      recoveredOwner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
      await recoveredOwner.start();
      const persisted = JSON.parse(readFileSync(join(fixture.root, "account-router-config.json"), "utf8")) as RouterConfigV3;
      const recoveredState = new RouterStateStore(fixture.root, persisted).snapshot();
      const accountHomes = readdirSync(join(fixture.root, "accounts")).sort();
      assert.equal(persisted.generation, fixture.config.generation + 1, `${faultAt}: recovery did not publish exactly one config generation`);
      assert.equal(persisted.accounts.filter((account) => account.opaqueAccountId === expected).length, 1, `${faultAt}: recovery duplicated the enrolled account`);
      assert.equal(accountHomes.filter((account) => account === expected).length, 1, `${faultAt}: recovery did not leave exactly one canonical home`);
      assert.equal(accountHomes.length, fixture.accounts.length + 1, `${faultAt}: recovery created an unexpected account home`);
      assert.ok(recoveredState.ledger[expected], `${faultAt}: recovered state lacks the enrolled account ledger entry`);
      assert.deepEqual(Object.keys(recoveredState.ledger).sort(), persisted.accounts.map((account) => account.opaqueAccountId).sort(), `${faultAt}: recovered state/config account generations differ`);
      assert.equal(preflightRouterHomes(persisted, fixture.root), true, `${faultAt}: strict preflight rejected the recovered homes`);
      assert.equal(existsSync(journalPath), false, `${faultAt}: recovery did not clear its journal`);
      const stagingRoot = join(fixture.root, "enrollments");
      assert.equal(!existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0, true, `${faultAt}: recovery left duplicated enrollment staging`);

      await connectDesktop(fixture, 150 + restartTable.findIndex((row) => row.faultAt === faultAt), "chatgpt");
      recoveredControl = controlClient(fixture, 150 + restartTable.findIndex((row) => row.faultAt === faultAt));
      const configBeforeRetry = readFileSync(join(fixture.root, "account-router-config.json"), "utf8");
      const stateBeforeRetry = readFileSync(join(fixture.root, "router-state.json"), "utf8");
      const homesBeforeRetry = readdirSync(join(fixture.root, "accounts")).sort();
      const retryStarted = await recoveredControl.invoke({ version: 1, requestId: `${faultAt}-duplicate-start`, command: "enrollment.start" });
      assert.equal(retryStarted.ok, true, `${faultAt}: duplicate retry did not start its isolated enrollment`);
      const retryRef = retryStarted.ok ? (retryStarted.result as { enrollmentRef: string }).enrollmentRef : null;
      assert.ok(retryRef, `${faultAt}: duplicate retry reference missing`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      const duplicate = await recoveredControl.invoke({ version: 1, requestId: `${faultAt}-duplicate-status`, command: "enrollment.status", params: { enrollmentRef: retryRef! } });
      assert.equal(duplicate.ok, true, `${faultAt}: duplicate retry status was not observable`);
      assert.equal(duplicate.ok ? (duplicate.result as { state: string }).state : null, "failed", `${faultAt}: duplicate retry was not rejected`);
      assert.equal(readFileSync(join(fixture.root, "account-router-config.json"), "utf8"), configBeforeRetry, `${faultAt}: duplicate retry rewrote config`);
      assert.equal(readFileSync(join(fixture.root, "router-state.json"), "utf8"), stateBeforeRetry, `${faultAt}: duplicate retry rewrote state`);
      assert.deepEqual(readdirSync(join(fixture.root, "accounts")).sort(), homesBeforeRetry, `${faultAt}: duplicate retry changed canonical homes`);
      assert.equal(existsSync(journalPath), false, `${faultAt}: duplicate retry created a recovery journal`);
    } finally {
      await recoveredControl?.close();
      if (recoveredOwner) await recoveredOwner.close();
      await failedControl?.close();
      if (failedOwner) await failedOwner.close();
    }
  }
});

test("restart reconciliation clears unreplayable pending handoffs and preserves an explicit ambiguous forwarding receipt", async () => {
  const fixture = createFixture();
  const store = new RouterStateStore(fixture.root, fixture.config);
  const pendingRef = `bh_${"p".repeat(43)}`;
  const forwardingRef = `bh_${"f".repeat(43)}`;
  const taskA = `bt_${"a".repeat(43)}`;
  const taskB = `bt_${"b".repeat(43)}`;
  const conversationA = `lc_${"a".repeat(43)}`;
  const conversationB = `lc_${"b".repeat(43)}`;
  const confirmationA = `bc_${"a".repeat(43)}`;
  const confirmationB = `bc_${"b".repeat(43)}`;
  store.update((state) => {
    state.threadOwners["thread-pending"] = fixture.accounts[0]!;
    state.threadOwners["thread-forwarding"] = fixture.accounts[0]!;
    state.ledger[fixture.accounts[0]!]!.assignedThreadCount = 2;
  });
  store.update((state) => {
    state.pendingHandoffs = {
      [pendingRef]: {
        version: 1,
        handoffRef: pendingRef as `bh_${string}`,
        confirmationId: confirmationA as `bc_${string}`,
        conversationId: conversationA as `lc_${string}`,
        taskRef: taskA as `bt_${string}`,
        originRendererRef: createOpaqueRendererRef(fixture.secret, 41, desktopBinding("chatgpt", 41)),
        fromOpaqueAccountId: fixture.accounts[0]!,
        toOpaqueAccountId: fixture.accounts[1]!,
        state: "pending",
        expiresAt: "2026-09-03T00:00:00.000Z",
      },
      [forwardingRef]: {
        version: 1,
        handoffRef: forwardingRef as `bh_${string}`,
        confirmationId: confirmationB as `bc_${string}`,
        conversationId: conversationB as `lc_${string}`,
        taskRef: taskB as `bt_${string}`,
        originRendererRef: createOpaqueRendererRef(fixture.secret, 42, desktopBinding("chatgpt", 42)),
        fromOpaqueAccountId: fixture.accounts[0]!,
        toOpaqueAccountId: fixture.accounts[1]!,
        state: "forwarding",
        expiresAt: "2026-09-03T00:00:00.000Z",
      },
    };
  });
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  try {
    await owner.start();
    const recovered = new RouterStateStore(fixture.root, fixture.config).snapshot();
    assert.equal(recovered.pendingHandoffs?.[pendingRef], undefined);
    assert.equal(recovered.pendingHandoffs?.[forwardingRef]?.state, "ambiguous");
    assert.equal(recovered.threadOwners["thread-forwarding"], fixture.accounts[0], "restart never moves a possibly delivered continuation");
  } finally {
    await owner.close();
  }
});

test("native source keeps provider ids, exact owners, and legacy project rows", async () => {
  const fixture = createNativeFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  let chat: DesktopClient | null = null;
  let tweaks: DesktopClient | null = null;
  try {
    await owner.start();
    chat = await connectDesktop(fixture, 801, "chatgpt");
    tweaks = await connectDesktop(fixture, 802, "tweakers");
    chat.send({ jsonrpc: "2.0", id: "native-list", method: "thread/list", params: { limit: 100 } });
    await waitForMessage(chat.messages, (message) => responseFor([message], "native-list") !== undefined, "native list response missing");
    const list = responseFor(chat.messages, "native-list") as { result: { data: Array<{ id: string }> } };
    assert.deepEqual(list.result.data.map((row) => row.id).sort(), ["existing-a", "existing-b", "legacy-a", "segment-a2", "segment-b"].sort(), "native list preserves source ids");
    const state = new RouterStateStore(fixture.root, fixture.config).snapshot();
    assert.equal(state.threadOwners["existing-a"], fixture.accounts[0]);
    assert.equal(state.threadOwners["existing-b"], fixture.accounts[1]);

    tweaks.send({ jsonrpc: "2.0", id: "desktop-projects", method: "tweakers/desktopProjects/read", params: {} });
    await waitForMessage(tweaks.messages, (message) => responseFor([message], "desktop-projects") !== undefined, "native desktop project projection missing");
    const desktopProjects = responseFor(tweaks.messages, "desktop-projects") as { result: {
      values: { "local-projects": Record<string, { name: string }> }; projectIdMap: Record<string, string>;
    } };
    assert.equal(desktopProjects.result.values["local-projects"]["legacy-source-project"]?.name, "Source",
      "the broker supplies full current native records even when legacy display metadata is absent");
    assert.equal(desktopProjects.result.projectIdMap["legacy-source-project"], "project-source");

    tweaks.send({ jsonrpc: "2.0", id: "native-read", method: "thread/read", params: { threadId: "existing-a", includeTurns: false } });
    await waitForMessage(tweaks.messages, (message) => responseFor([message], "native-read") !== undefined, "native exact read response missing");
    const read = responseFor(tweaks.messages, "native-read") as { result: { thread: { id: string; sessionId: string; turns: unknown[] } } };
    assert.equal(read.result.thread.id, "existing-a");
    assert.equal(read.result.thread.sessionId, "session-for-existing-a", "native session ids are retained");
    assert.deepEqual(read.result.thread.turns, []);

    tweaks.send({ jsonrpc: "2.0", id: "native-resume", method: "thread/resume", params: { threadId: "existing-a" } });
    await waitForMessage(tweaks.messages, (message) => responseFor([message], "native-resume") !== undefined, "native resume response missing");
    const resume = responseFor(tweaks.messages, "native-resume") as { result: { threadId: string; resumedBy: string } };
    assert.equal(resume.result.threadId, "existing-a");
    assert.equal(resume.result.resumedBy, fixture.accounts[0]);

    tweaks.send({ jsonrpc: "2.0", id: "unknown-resume", method: "thread/resume", params: { threadId: "unknown-native" } });
    await waitForMessage(tweaks.messages, (message) => responseFor([message], "unknown-resume") !== undefined, "unknown native resume response missing");
    assert.ok("error" in (responseFor(tweaks.messages, "unknown-resume") as Record<string, unknown>));
    assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["unknown-native"], undefined, "unknown mutation never chooses a fallback owner");

    // Manual primary is B, so this source sidebar project must be imported as
    // bounded metadata before B starts a project-owned native thread.
    chat.send({ jsonrpc: "2.0", id: "project-start", method: "thread/start", params: { projectId: "project-source" } });
    // Project import crosses several real host writer censuses. Allow those
    // bounded process inspections to finish on a busy development machine.
    await waitForMessage(chat.messages, (message) => responseFor([message], "project-start") !== undefined, "cross-account project start missing", 15_000);
    chat.send({ jsonrpc: "2.0", id: "project-members", method: "thread/list", params: { projectId: "project-source", limit: 100 } });
    await waitForMessage(chat.messages, (message) => responseFor([message], "project-members") !== undefined, "legacy project filter response missing");
    const projectMembers = responseFor(chat.messages, "project-members") as { result: { data: Array<{ id: string; projectId: string | null }> } };
    assert.deepEqual(projectMembers.result.data.map((row) => row.id).sort(), ["legacy-a", "target-b"], "legacy source membership and imported target project share the public sidebar project");
    assert.equal(projectMembers.result.data.every((row) => row.projectId === "project-source"), true);

  } finally {
    await chat?.close();
    await tweaks?.close();
    await owner.close();
  }
});

test("native metadata reads keep zero-turn broker bindings out of logical history before and after restart", async () => {
  const fixture = createNativeFixture();
  let owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  let desktop: DesktopClient | null = null;
  let control: AccountsBrokerSocketClientV1 | null = null;
  try {
    await owner.start();
    desktop = await connectDesktop(fixture, 812, "tweakers");
    desktop.send({ jsonrpc: "2.0", id: "zero-list", method: "thread/list", params: { limit: 100 } });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "zero-list") !== undefined, "native ownership list missing");
    desktop.send({ jsonrpc: "2.0", id: "zero-read", method: "thread/read", params: { threadId: "existing-a", includeTurns: false } });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "zero-read") !== undefined, "native zero-turn read missing");
    control = controlClient(fixture, 812, "tweakers");
    let history = await control.invoke({ version: 1, requestId: "zero-history", command: "history.read" }) as { ok: boolean; result?: { conversation?: unknown } };
    assert.equal(history.result?.conversation, null, "native metadata access alone does not create a history warning card");
    assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["existing-a"], fixture.accounts[0], "private routing ownership remains intact");

    await control.close(); control = null;
    desktop.close(); desktop = null;
    await owner.close();
    owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
      ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
    await owner.start();
    desktop = await connectDesktop(fixture, 813, "tweakers");
    desktop.send({ jsonrpc: "2.0", id: "restart-zero-read", method: "thread/read", params: { threadId: "existing-a", includeTurns: false } });
    await waitForMessage(desktop.messages, (message) => responseFor([message], "restart-zero-read") !== undefined, "restarted native zero-turn read missing");
    control = controlClient(fixture, 813, "tweakers");
    history = await control.invoke({ version: 1, requestId: "restart-zero-history", command: "history.read" }) as typeof history;
    assert.equal(history.result?.conversation, null, "restart does not turn the retained bootstrap binding into missing history");
  } finally {
    await control?.close();
    desktop?.close();
    await owner.close();
  }
});

for (const retirementOutcome of ["retired", "held", "unsupported"] as const) test(`native handoff ${retirementOutcome === "retired" ? "preserves the native ID after coordinator proof" : retirementOutcome === "held" ? "holds continuation and affected-thread mutations until source retirement recovers" : "rejects unsupported transfer without a segmented fallback"}`, async () => {
  const supported = retirementOutcome !== "unsupported";
  let pendingRetirement = false;
  let recoveryAllowed = false;
  const fixture = createNativeFixture();
  const transferEventLog = join(fixture.root, "native-transfer-events.log");
  enableNativeBalancedTokens(fixture);
  new AccountsPreferencesStore(fixture.root).update({ failoverMode: "ask" });
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, false,
      { sourceQuotaExhausted: true, requireToolApproval: true, sameIdTransfer: true, transferEventLog })]);
  let origin: DesktopClient | null = null;
  let control: AccountsBrokerSocketClientV1 | null = null;
  let unsubscribe: (() => void) | null = null;
  const proofEvents: string[] = [];
  const proof = (event: string): void => { proofEvents.push(event); appendFileSync(transferEventLog, `host:${event}\n`, { mode: 0o600 }); };
  let nativeOwner = fixture.accounts[0]!;
  try {
    await owner.start();
    // The native-transfer suite separately proves filesystem/SQLite settlement.
    // This port verifies the broker's ordering and exact same-ID dispatch contract.
    (owner as unknown as { nativeTransfer: object }).nativeTransfer = {
      ownerForThread: () => nativeOwner,
      hasPendingSourceRetirement: (threadId: string) => threadId === "existing-a" && pendingRetirement,
      pendingSourceRetirements: () => pendingRetirement ? [{ operationId: "retirement-fixture", threadId: "existing-a", sourceAccountId: fixture.accounts[0], targetAccountId: fixture.accounts[1] }] : [],
      recoverSourceRetirements: async () => { if (recoveryAllowed) pendingRetirement = false; return { retiredOperationIds: recoveryAllowed ? ["retirement-fixture"] : [], heldOperationIds: recoveryAllowed ? [] : ["retirement-fixture"] }; },
      sourceProjectionReady: async (threadId: string, accountId: string) => {
        assert.equal(threadId, "existing-a");
        assert.equal(accountId, fixture.accounts[0]);
        proof("source-projected");
        return true;
      },
      prepareSameThreadTransfer: async (input: { operationId: string; threadId: string; sourceAccountId: string; targetAccountId: string }) => {
        assert.equal(input.threadId, "existing-a");
        assert.equal(input.sourceAccountId, fixture.accounts[0]);
        assert.equal(input.targetAccountId, fixture.accounts[1]);
        proof("prepare");
        return supported ? { state: "ready", operationId: input.operationId, targetPath: "/fixture/proven-rollout.jsonl" } : { state: "unsupported" };
      },
      revalidatePrepared: async () => { proof("revalidated"); return true; },
      markResumeDispatching: () => { proof("resume"); },
      confirmPreparationProbeBlocked: async (_operation: string, response: { error?: { code?: number; message?: string } }) => {
        assert.equal(response.error?.code, -32600);
        assert.equal(response.error?.message, "thread existing-a already has an active writer");
        proof("probe-blocked");
        return true;
      },
      releasePreparationLeaseForResume: () => { proof("released"); return true; },
      revalidateResumedGeneration: async () => { proof("resumed-revalidated"); return true; },
      releasePreparationLease: () => { proof("cleanup"); },
      settleResume: (_operation: string, response: { result?: { threadId?: string; resumedBy?: string } }) => {
        assert.equal(response.result?.threadId, "existing-a");
        assert.equal(response.result?.resumedBy, fixture.accounts[1]);
        proof("proved");
        return { state: "proved" };
      },
      commitWriter: () => { proof("commit"); nativeOwner = fixture.accounts[1]!; pendingRetirement = true; },
      retireSourceProjection: async () => {
        assert.equal(nativeOwner, fixture.accounts[1]);
        assert.equal((owner as any).children.has(fixture.accounts[0]), false);
        assert.equal((owner as any).nativeTransferHeldAccounts.has(fixture.accounts[0]), true);
        proof(retirementOutcome);
        if (retirementOutcome === "retired") pendingRetirement = false;
        return { state: retirementOutcome };
      },
      preflightSharedWriterLocks: () => ({ state: "ready" }),
    };
    origin = await connectDesktop(fixture, 821, "chatgpt");
    control = controlClient(fixture, 821);
    const events: BrokerEventV1[] = [];
    unsubscribe = control.subscribe((event) => events.push(event));
    origin.send({ jsonrpc: "2.0", id: "native-handoff", method: "turn/start", params: {
      threadId: "existing-a", input: [{ type: "text", text: "continue native safely" }] } });
    const held = await waitForBrokerEvent(events, (event) => event.type === "continuation" && isPendingHandoff(event.payload), "native held continuation missing") as { payload: { handoffRef: string } };
    assert.equal(responseFor(origin.messages, "native-handoff"), undefined);
    const confirmed = await control.invoke({ version: 1, requestId: "native-handoff-confirm", command: "handoff.confirm", params: { handoffRef: held.payload.handoffRef } });
    assert.equal(confirmed.ok, retirementOutcome === "retired");
    if (retirementOutcome === "held") {
      const result = responseFor(origin.messages, "native-handoff") as { error?: { data?: { code?: string } } };
      assert.equal(result.error?.data?.code, "ambiguous_dispatch");
      assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["existing-a"], fixture.accounts[1]);
      assert.equal(proofEvents.includes("held"), true);
      for (const method of ["turn/start", "thread/archive", "thread/resume"]) {
        const id = `pending-retirement-${method}`;
        origin.send({ jsonrpc: "2.0", id, method, params: { threadId: "existing-a", input: [{ type: "text", text: "must remain held" }] } });
        const blocked = await waitForMessage(origin.messages, (message) => responseFor([message], id) !== undefined, "pending retirement mutation response missing") as { error?: { data?: { code?: string } } };
        assert.equal(blocked.error?.data?.code, "account_history_busy");
      }
      assert.equal(origin.messages.some((message) => "method" in message && message.method === "app-tools/request"), false, "neither the original continuation nor later turns reach the provider");
      assert.equal(existsSync(join(fixture.root, "native-fixture-archives.log")), false);
      recoveryAllowed = true;
      await (owner as any).recoverNativeSourceRetirements();
      assert.equal(pendingRetirement, false);
      origin.send({ jsonrpc: "2.0", id: "retired-thread-archive", method: "thread/archive", params: { threadId: "existing-a" } });
      const archived = await waitForMessage(origin.messages, (message) => responseFor([message], "retired-thread-archive") !== undefined, "recovered retirement mutation response missing") as { result?: { archivedBy?: string } };
      assert.equal(archived.result?.archivedBy, fixture.accounts[1]);
      assert.equal(origin.messages.some((message) => "method" in message && message.method === "app-tools/request"), false, "recovery never replays the ambiguous continuation");
      return;
    }
    if (!supported) {
      assert.deepEqual(proofEvents, ["source-projected", "prepare"]);
      assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["existing-a"], fixture.accounts[0]);
      return;
    }
    const forwarded = await waitForMessage(origin.messages, (message) => responseFor([message], "native-handoff") !== undefined, "native turn acknowledgement missing") as { result: { threadId: string } };
    assert.equal(forwarded.result.threadId, "existing-a");
    assert.deepEqual(proofEvents, ["source-projected", "prepare", "revalidated", "resume", "probe-blocked", "revalidated", "resume", "released", "resumed-revalidated", "proved", "commit", "retired", "cleanup"]);
    const transferEvents = readFileSync(transferEventLog, "utf8").trim().split("\n");
    const preparedAt = transferEvents.indexOf("host:prepare");
    assert.deepEqual(transferEvents.slice(preparedAt, preparedAt + 11), [
      "host:prepare", `child:${fixture.accounts[1]}:initialize`, `child:${fixture.accounts[1]}:loaded`, "host:revalidated",
      "host:resume", `child:${fixture.accounts[1]}:warmup:busy`, `child:${fixture.accounts[1]}:loaded`, "host:probe-blocked", "host:revalidated", "host:resume", "host:released",
    ], "the exact target is initialized, probed busy, rechecked empty, and revalidated before lease release");
    assert.equal(transferEvents[preparedAt + 11], `child:${fixture.accounts[1]}:resume`, "only the final resume follows lease release");
    const tool = await waitForMessage(origin.messages, (message) => "method" in message && message.method === "app-tools/request", "native app-tools request missing") as { id: string | number };
    const canonical = (owner as unknown as { canonicalHistory: CanonicalHistoryStoreV1 }).canonicalHistory;
    const conversationId = canonical.conversationForNative(fixture.accounts[0]!, "existing-a");
    assert.ok(conversationId);
    assert.equal(canonical.activeNativeThread(conversationId!)?.nativeThreadId, "existing-a");
    assert.equal(canonical.activeNativeThread(conversationId!)?.opaqueAccountId, fixture.accounts[1]);
    assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["existing-a"], fixture.accounts[1]);
    origin.send({ jsonrpc: "2.0", id: tool.id, result: { approved: true } });
    await waitForMessage(origin.messages, (message) => "method" in message && message.method === "turn/completed", "native terminal notification missing");
    const balance = await readBalance(control, "native-quota-balance");
    assert.equal(balance.policy, "quota_aware_v2");
    assert.ok(balance.accounts.every((account) => account.reservedTokens === 0 && account.completedTokens === 0));
  } finally {
    unsubscribe?.();
    await control?.close();
    origin?.close();
    await owner.close();
  }
});

for (const warmupOutcome of ["unexpected", "timeout"] as const) test(`native handoff holds an unresolved transfer after a ${warmupOutcome} warmup outcome`, async () => {
  const fixture = createNativeFixture();
  const transferEventLog = join(fixture.root, "native-transfer-negative-events.log");
  enableNativeBalancedTokens(fixture);
  new AccountsPreferencesStore(fixture.root).update({ failoverMode: "ask" });
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, false,
      { sourceQuotaExhausted: true, sameIdTransfer: true, transferWarmup: warmupOutcome, transferEventLog })]);
  let origin: DesktopClient | null = null;
  let control: AccountsBrokerSocketClientV1 | null = null;
  const coordinatorEvents: string[] = [];
  try {
    await owner.start();
    (owner as unknown as { nativeTransfer: object }).nativeTransfer = {
      ownerForThread: () => fixture.accounts[0],
      hasPendingSourceRetirement: () => false,
      sourceProjectionReady: async () => true,
      prepareSameThreadTransfer: async (input: { operationId: string }) => ({ state: "ready", operationId: input.operationId, targetPath: "/fixture/proven-rollout.jsonl" }),
      revalidatePrepared: async () => { coordinatorEvents.push("revalidated"); return true; },
      markResumeDispatching: () => { coordinatorEvents.push("marked"); },
      releasePreparationLeaseForResume: () => { coordinatorEvents.push("released"); return true; },
      releasePreparationLease: () => { coordinatorEvents.push("cleanup"); },
      preflightSharedWriterLocks: () => ({ state: "ready" }),
    };
    origin = await connectDesktop(fixture, warmupOutcome === "unexpected" ? 822 : 823, "chatgpt");
    control = controlClient(fixture, warmupOutcome === "unexpected" ? 822 : 823);
    const events: BrokerEventV1[] = [];
    const unsubscribe = control.subscribe((event) => events.push(event));
    try {
      origin.send({ jsonrpc: "2.0", id: `native-handoff-${warmupOutcome}`, method: "turn/start", params: {
        threadId: "existing-a", input: [{ type: "text", text: "hold an uncertain warmup" }] } });
      const held = await waitForBrokerEvent(events, (event) => event.type === "continuation" && isPendingHandoff(event.payload), "native held continuation missing") as { payload: { handoffRef: string } };
      const confirmed = await control.invoke({ version: 1, requestId: `native-handoff-${warmupOutcome}-confirm`, command: "handoff.confirm", params: { handoffRef: held.payload.handoffRef } });
      assert.equal(confirmed.ok, false);
      assert.deepEqual(coordinatorEvents, ["revalidated", "marked", "cleanup"], "the journal records dispatch before a probe whose outcome can become unknown");
      const childEvents = readFileSync(transferEventLog, "utf8").trim().split("\n");
      assert.equal(childEvents.filter((event) => event.endsWith(`:warmup:${warmupOutcome}`)).length, 1);
      assert.equal(childEvents.some((event) => event.endsWith(":resume")), false, "an uncertain warmup never permits a second resume");
      const heldResponse = responseFor(origin.messages, `native-handoff-${warmupOutcome}`) as { error?: { data?: { code?: string } } };
      assert.equal(heldResponse.error?.data?.code, "ambiguous_dispatch", "the desktop receives ambiguity without a provider continuation");
      assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["existing-a"], fixture.accounts[0]);
    } finally { unsubscribe(); }
  } finally {
    await control?.close();
    origin?.close();
    await owner.close();
  }
});

test("native paged and archived lists preserve exact rows without leaking child cursors", async () => {
  const fixture = createNativeFixture();
  const owner = new AccountsBrokerOwnerV1(
    fixture.config,
    fixture.root,
    fixture.secret,
    process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, false, { paged: true })],
  );
  let client: DesktopClient | null = null;
  try {
    await owner.start();
    client = await connectDesktop(fixture, 831, "chatgpt");
    client.send({ jsonrpc: "2.0", id: "native-page-one", method: "thread/list", params: { limit: 100 } });
    const first = await waitForMessage(client.messages, (message) => responseFor([message], "native-page-one") !== undefined, "first native page missing") as {
      result: { data: Array<{ id: string }>; nextCursor: string | null };
    };
    assert.equal(first.result.data.some((row) => row.id === "page-a2" || row.id === "page-b2"), false, "the first merged page does not duplicate a later provider page");
    assert.match(first.result.nextCursor ?? "", /^hc_[A-Za-z0-9_-]{16,128}$/, "the broker owns the public pagination cursor");
    assert.doesNotMatch(first.result.nextCursor ?? "", /native-page-/, "a child cursor never reaches a desktop client");

    client.send({ jsonrpc: "2.0", id: "native-page-two", method: "thread/list", params: { limit: 100, cursor: first.result.nextCursor! } });
    const second = await waitForMessage(client.messages, (message) => responseFor([message], "native-page-two") !== undefined, "second native page missing") as {
      result: { data: Array<{ id: string }>; nextCursor: string | null };
    };
    assert.deepEqual(second.result.data.map((row) => row.id).sort(), ["page-a2", "page-b2"]);
    assert.equal(second.result.nextCursor, null);
    const state = new RouterStateStore(fixture.root, fixture.config).snapshot();
    assert.equal(state.threadOwners["page-a2"], fixture.accounts[0], "a complete merged page binds only its exact source owner");
    assert.equal(state.threadOwners["page-b2"], fixture.accounts[1]);

    client.send({ jsonrpc: "2.0", id: "native-archived-list", method: "thread/list", params: { archived: true, limit: 100 } });
    const archived = await waitForMessage(client.messages, (message) => responseFor([message], "native-archived-list") !== undefined, "archived native list missing") as {
      result: { data: Array<{ id: string }>; nextCursor: string | null };
    };
    assert.deepEqual(archived.result.data.map((row) => row.id).sort(), ["archived-a", "archived-b"]);
    assert.equal(archived.result.nextCursor, null);

    client.send({ jsonrpc: "2.0", id: "native-archive-exact-owner", method: "thread/archive", params: { threadId: "archived-b" } });
    const archive = await waitForMessage(client.messages, (message) => responseFor([message], "native-archive-exact-owner") !== undefined, "native archive response missing") as {
      result: { threadId: string; archivedBy: string };
    };
    assert.equal(archive.result.threadId, "archived-b");
    assert.equal(archive.result.archivedBy, fixture.accounts[1], "archive remains bound to the exact historical account");
  } finally {
    await client?.close();
    await owner.close();
  }
});

test("native duplicate ids reject list and mutation ownership instead of choosing an account", async () => {
  const fixture = createNativeFixture();
  const owner = new AccountsBrokerOwnerV1(
    fixture.config,
    fixture.root,
    fixture.secret,
    process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, false, { collision: true })],
  );
  let client: DesktopClient | null = null;
  try {
    await owner.start();
    client = await connectDesktop(fixture, 832, "tweakers");
    client.send({ jsonrpc: "2.0", id: "native-collision-list", method: "thread/list", params: { limit: 100 } });
    const listed = await waitForMessage(client.messages, (message) => responseFor([message], "native-collision-list") !== undefined, "native collision list response missing") as {
      error?: { data?: { code?: string } };
    };
    assert.equal(listed.error?.data?.code, "unknown_thread_owner");
    assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["native-collision"], undefined, "an ambiguous list row never becomes durable state");

    client.send({ jsonrpc: "2.0", id: "native-collision-archive", method: "thread/archive", params: { threadId: "native-collision" } });
    const archived = await waitForMessage(client.messages, (message) => responseFor([message], "native-collision-archive") !== undefined, "native collision archive response missing") as {
      error?: { data?: { code?: string } };
    };
    assert.equal(archived.error?.data?.code, "unknown_thread_owner");
    assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["native-collision"], undefined, "a collision cannot fall back to account order for a mutation");
  } finally {
    await client?.close();
    await owner.close();
  }
});

test("a native thread writer conflict blocks only that thread without replay", async () => {
  const fixture = createNativeFixture();
  const args = ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)] as const;
  let owner: AccountsBrokerOwnerV1 | null = null;
  let client: DesktopClient | null = null;
  let blockedOwner: AccountsBrokerOwnerV1 | null = null;
  let recoveredOwner: AccountsBrokerOwnerV1 | null = null;
  let recoveredClient: DesktopClient | null = null;
  let foreignWriter: ReturnType<typeof spawn> | null = null;
  const archiveLog = join(fixture.homesRoot, "native-fixture-archives.log");
  try {
    owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, args);
    await owner.start();
    client = await connectDesktop(fixture, 833, "chatgpt");
    client.send({ jsonrpc: "2.0", id: "native-conflict-bind", method: "thread/list", params: { limit: 100 } });
    await waitForMessage(client.messages, (message) => responseFor([message], "native-conflict-bind") !== undefined, "native owner binding list missing");
    assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["existing-a"], fixture.accounts[0]);

    const sqlitePath = join(fixture.homesRoot, "accounts", fixture.accounts[0]!, "codex-home", "thread-writer-locks", "existing-a.lock");
    mkdirSync(join(sqlitePath, ".."), { recursive: true, mode: 0o700 });
    privateWrite(sqlitePath, "fixture sqlite writer marker");
    foreignWriter = spawn(process.execPath, ["-e", "const fs=require('node:fs');fs.openSync(process.argv[1], 'r+');setInterval(()=>{}, 1000);", sqlitePath], { stdio: "ignore" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));

    client.send({ jsonrpc: "2.0", id: "native-conflict-archive", method: "thread/archive", params: { threadId: "existing-a" } });
    const rejected = await waitForMessage(client.messages, (message) => responseFor([message], "native-conflict-archive") !== undefined, "terminal native writer-conflict response missing") as {
      error?: { data?: { code?: string } };
    };
    assert.equal(rejected.error?.data?.code, "account_history_busy");
    assert.equal(existsSync(archiveLog), false, "the current owner rejects before a foreign-writer mutation can reach a provider child");

    await client.close();
    client = null;
    await owner.close();
    owner = null;
    blockedOwner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, args);
    await blockedOwner.start();
    assert.ok(blockedOwner, "an unrelated thread writer does not terminate the broker");
    await blockedOwner.close();
    blockedOwner = null;
    assert.equal(existsSync(archiveLog), false, "a failed takeover does not replay the rejected request");

    foreignWriter.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => foreignWriter!.once("exit", () => resolvePromise()));
    foreignWriter = null;

    recoveredOwner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, args);
    await recoveredOwner.start();
    assert.equal(existsSync(archiveLog), false, "fresh recovery starts only from durable state and never replays an old mutation");
    recoveredClient = await connectDesktop(fixture, 834, "chatgpt");
    recoveredClient.send({ jsonrpc: "2.0", id: "native-recovered-archive", method: "thread/archive", params: { threadId: "existing-a" } });
    const archived = await waitForMessage(recoveredClient.messages, (message) => responseFor([message], "native-recovered-archive") !== undefined,
      "fresh owner archive response missing", 7_000) as {
      result: { archivedBy: string };
    };
    assert.equal(archived.result.archivedBy, fixture.accounts[0]);
    assert.equal(readFileSync(archiveLog, "utf8"), `${fixture.accounts[0]}:existing-a\n`, "only an explicitly retried post-census request reaches the recovered owner");
  } finally {
    if (foreignWriter) {
      foreignWriter.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => foreignWriter!.once("exit", () => resolvePromise()));
    }
    await recoveredClient?.close();
    await recoveredOwner?.close();
    await blockedOwner?.close();
    await client?.close();
    await owner?.close();
  }
});

test("partial native lists remain readable but cannot bind an owner or resume", async () => {
  const fixture = createNativeFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, true)]);
  let client: DesktopClient | null = null;
  try {
    await owner.start();
    client = await connectDesktop(fixture, 811, "chatgpt");
    client.send({ jsonrpc: "2.0", id: "partial-list", method: "thread/list", params: { limit: 100 } });
    await waitForMessage(client.messages, (message) => responseFor([message], "partial-list") !== undefined, "partial native list missing");
    const list = responseFor(client.messages, "partial-list") as { result: { data: Array<{ id: string }> } };
    assert.equal(list.result.data.some((row) => row.id === "existing-a"), true, "responding source row remains readable");
    assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["existing-a"], undefined, "partial fanout creates no durable owner");
    client.send({ jsonrpc: "2.0", id: "partial-read", method: "thread/read", params: { threadId: "existing-a", includeTurns: false } });
    await waitForMessage(client.messages, (message) => responseFor([message], "partial-read") !== undefined, "transient point read missing");
    assert.equal((responseFor(client.messages, "partial-read") as { result: { thread: { id: string } } }).result.thread.id, "existing-a");
    client.send({ jsonrpc: "2.0", id: "partial-resume", method: "thread/resume", params: { threadId: "existing-a" } });
    await waitForMessage(client.messages, (message) => responseFor([message], "partial-resume") !== undefined, "partial resume response missing");
    assert.ok("error" in (responseFor(client.messages, "partial-resume") as Record<string, unknown>));
    assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().threadOwners["existing-a"], undefined, "unsafe resume does not persist transient proof");
  } finally {
    await client?.close();
    await owner.close();
  }
});

async function waitForBrokerEvent(
  events: readonly BrokerEventV1[],
  predicate: (event: BrokerEventV1) => boolean,
  failure: string,
): Promise<BrokerEventV1> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const match = events.find(predicate);
    if (match) return match;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(failure);
}

function isPendingHandoff(value: unknown): value is { handoffRef: string; state: string } {
  return typeof value === "object" && value !== null
    && typeof (value as { handoffRef?: unknown }).handoffRef === "string"
    && (value as { state?: unknown }).state === "pending";
}


test("native donor child closure publishes settings independently of the routing primary", async () => {
  const fixture = createNativeFixture();
  const accounts = fixture.accounts.map((opaqueAccountId) => ({ opaqueAccountId,
    codexHome: join(fixture.homesRoot, "accounts", opaqueAccountId, "codex-home") }));
  const donor = accounts.find((account) => account.opaqueAccountId === fixture.accounts[0])!;
  assert.notEqual(donor.opaqueAccountId, fixture.config.primaryOpaqueAccountId);
  const secondary = accounts.find((account) => account !== donor)!;
  privateWrite(join(donor.codexHome, "config.toml"), 'model = "initial-shared"\n');
  privateWrite(join(secondary.codexHome, "config.toml"), 'model_verbosity = "low"\n');
  const authBefore = accounts.map((account) => readFileSync(join(account.codexHome, "auth.json"), "utf8"));
  const base = bootstrapAccountContinuity({ stateRoot: fixture.root, primaryOpaqueAccountId: fixture.config.primaryOpaqueAccountId,
    sharedSourceOpaqueAccountId: donor.opaqueAccountId,
    accounts, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(base.state, "ready", base.reason);
  for (const account of accounts) {
    assert.equal(prepareAccountConfigBeforeSpawn({ stateRoot: fixture.root, account, shared: base.shared!, plugins: base.plugins!,
      schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true, writeEvidence: { accountChildAbsent: true } }).state, "ready");
  }
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const lifecycle = owner as unknown as { quiesceIdleAccount(account: OpaqueAccountId): Promise<boolean> };
  let client: DesktopClient | null = null;
  try {
    await owner.start();
    client = await connectDesktop(fixture, 910, "chatgpt");
    client.send({ jsonrpc: "2.0", id: "continuity-first", method: "thread/list", params: {} });
    await waitForMessage(client.messages, (message) => responseFor([message], "continuity-first") !== undefined, "initial native child list missing", 15_000);
    assert.match(readFileSync(join(secondary.codexHome, "config.toml"), "utf8"), /initial-shared/);
    // Isolated fixture edit represents a native config change made by its child.
    privateWrite(join(donor.codexHome, "config.toml"), 'model = "updated-shared"\n');
    assert.equal(await lifecycle.quiesceIdleAccount(donor.opaqueAccountId), true);
    assert.ok(loadSharedAccountBase(fixture.root)!.config.generation > base.shared!.config.generation);
    assert.equal(await lifecycle.quiesceIdleAccount(secondary.opaqueAccountId), true);
    client.send({ jsonrpc: "2.0", id: "continuity-next", method: "thread/resume", params: { threadId: "existing-b" } });
    await waitForMessage(client.messages, (message) => responseFor([message], "continuity-next") !== undefined, "cold native child resume missing", 15_000);
    const inherited = readFileSync(join(secondary.codexHome, "config.toml"), "utf8");
    assert.match(inherited, /updated-shared/);
    assert.match(inherited, /model_verbosity = "low"/);
    assert.deepEqual(accounts.map((account) => readFileSync(join(account.codexHome, "auth.json"), "utf8")), authBefore);
  } finally { client?.close(); await owner.close(); }
});

test("native settings defer while another app is active and preserve its edits before first inheritance", async () => {
  const fixture = createNativeFixture();
  const accounts = fixture.accounts.map((opaqueAccountId) => ({ opaqueAccountId,
    codexHome: join(fixture.homesRoot, "accounts", opaqueAccountId, "codex-home") }));
  const sharedOwner = accounts.find((account) => account.opaqueAccountId === fixture.accounts[0])!;
  const native = accounts.find((account) => account !== sharedOwner)!;
  privateWrite(join(sharedOwner.codexHome, "config.toml"), 'model = "shared-model"\nmodel_verbosity = "high"\n');
  privateWrite(join(native.codexHome, "config.toml"), 'model_verbosity = "low"\n');
  const originalNative = readFileSync(join(native.codexHome, "config.toml"), "utf8");
  const authBefore = accounts.map((account) => readFileSync(join(account.codexHome, "auth.json"), "utf8"));
  const base = bootstrapAccountContinuity({ stateRoot: fixture.root, primaryOpaqueAccountId: sharedOwner.opaqueAccountId,
    accounts, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(base.state, "ready", base.reason);
  assert.equal(prepareAccountConfigBeforeSpawn({ stateRoot: fixture.root, account: sharedOwner, shared: base.shared!, plugins: base.plugins!,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true, writeEvidence: { accountChildAbsent: true } }).state, "ready");
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const continuity = owner as unknown as {
    prepareAccountContinuity(account: OpaqueAccountId, codexHome: string): boolean;
    nativeContinuityDeferred: Set<OpaqueAccountId>;
    nativeContinuityReasons: Map<OpaqueAccountId, string>;
    broker: AccountsBrokerV1;
  };
  let foreign: ReturnType<typeof spawn> | null = null;
  try {
    await owner.start();
    foreign = spawn(process.execPath, ["-e", "require('node:fs').openSync(process.argv[1], 'r+');process.stdout.write('ready');setInterval(()=>{}, 1000);",
      join(native.codexHome, "config.toml")], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolvePromise, reject) => { foreign!.stdout!.once("data", () => resolvePromise()); foreign!.once("error", reject); });
    assert.equal(continuity.prepareAccountContinuity(native.opaqueAccountId, native.codexHome), true);
    assert.equal(continuity.nativeContinuityDeferred.has(native.opaqueAccountId), true);
    assert.equal(continuity.nativeContinuityReasons.get(native.opaqueAccountId), "account_in_use");
    assert.deepEqual(continuity.broker.pool().accounts.find((account) => account.opaqueAccountId === native.opaqueAccountId) && {
      state: continuity.broker.pool().accounts.find((account) => account.opaqueAccountId === native.opaqueAccountId)!.continuityState,
      reason: continuity.broker.pool().accounts.find((account) => account.opaqueAccountId === native.opaqueAccountId)!.continuityReason,
    }, { state: "deferred", reason: "account_in_use" });
    assert.equal(readFileSync(join(native.codexHome, "config.toml"), "utf8"), originalNative, "busy native configuration remains untouched");
    privateWrite(join(native.codexHome, "config.toml"), 'model_verbosity = "medium"\nmodel_reasoning_effort = "high"\n');
    assert.equal(continuity.prepareAccountContinuity(native.opaqueAccountId, native.codexHome), true);
    foreign.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => foreign!.once("exit", () => resolvePromise()));
    foreign = null;
    assert.equal(continuity.prepareAccountContinuity(native.opaqueAccountId, native.codexHome), true);
    const inherited = readFileSync(join(native.codexHome, "config.toml"), "utf8");
    assert.match(inherited, /model = "shared-model"/);
    assert.match(inherited, /model_verbosity = "medium"/);
    assert.match(inherited, /model_reasoning_effort = "high"/);
    assert.equal(continuity.nativeContinuityDeferred.has(native.opaqueAccountId), false);
    assert.equal(continuity.nativeContinuityReasons.has(native.opaqueAccountId), false);
    foreign = spawn(process.execPath, ["-e", "require('node:fs').openSync(process.argv[1], 'r+');process.stdout.write('ready');setInterval(()=>{}, 1000);",
      join(native.codexHome, "config.toml")], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolvePromise, reject) => { foreign!.stdout!.once("data", () => resolvePromise()); foreign!.once("error", reject); });
    assert.equal(continuity.prepareAccountContinuity(native.opaqueAccountId, native.codexHome), true);
    assert.equal(continuity.nativeContinuityDeferred.has(native.opaqueAccountId), false, "an already-effective busy home needs no migration");
    assert.equal(readFileSync(join(native.codexHome, "config.toml"), "utf8"), inherited);
    assert.deepEqual(accounts.map((account) => readFileSync(join(account.codexHome, "auth.json"), "utf8")), authBefore);
  } finally {
    if (foreign) { foreign.kill("SIGTERM"); await new Promise<void>((resolvePromise) => foreign!.once("exit", () => resolvePromise())); }
    await owner.close();
  }
});

test("native donor mismatch reports migration pending without changing account homes", async () => {
  const fixture = createNativeFixture();
  const accounts = fixture.accounts.map((opaqueAccountId) => ({ opaqueAccountId,
    codexHome: join(fixture.homesRoot, "accounts", opaqueAccountId, "codex-home") }));
  const oldDonor = accounts.find((account) => account.opaqueAccountId === fixture.config.primaryOpaqueAccountId)!;
  const registeredDonor = accounts.find((account) => account.opaqueAccountId === fixture.accounts[0])!;
  privateWrite(join(oldDonor.codexHome, "config.toml"), 'model = "old-donor"\n');
  privateWrite(join(registeredDonor.codexHome, "config.toml"), 'model = "registered-donor"\n');
  const before = accounts.map((account) => readFileSync(join(account.codexHome, "config.toml"), "utf8"));
  const base = bootstrapAccountContinuity({ stateRoot: fixture.root, primaryOpaqueAccountId: oldDonor.opaqueAccountId,
    accounts, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(base.state, "ready", base.reason);
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const continuity = owner as unknown as {
    prepareAccountContinuity(account: OpaqueAccountId, codexHome: string): boolean;
    broker: AccountsBrokerV1;
  };
  try {
    await owner.start();
    assert.equal(continuity.prepareAccountContinuity(registeredDonor.opaqueAccountId, registeredDonor.codexHome), true);
    const projected = continuity.broker.pool().accounts.find((account) => account.opaqueAccountId === registeredDonor.opaqueAccountId);
    assert.equal(projected?.continuityState, "deferred");
    assert.equal(projected?.continuityReason, "migration_pending");
    assert.deepEqual(accounts.map((account) => readFileSync(join(account.codexHome, "config.toml"), "utf8")), before,
      "donor mismatch only reports the pending migration");
  } finally { await owner.close(); }
});


test("every cold account child negotiates the desktop capabilities once before native requests", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const host = owner as any;
  let desktop: DesktopClient | null = null;
  try {
    await owner.start();
    // No headless guess may negotiate weaker capabilities before the desktop arrives.
    const before = host.broker.acquireChild(fixture.accounts[1]);
    assert.equal(await host.requestBrokerChild(fixture.accounts[1], before, "account/read", {}), null);
    desktop = await connectDesktop(fixture, 940, "tweakers");
    for (const account of fixture.accounts) {
      const child = host.broker.acquireChild(account);
      const results = await Promise.all(Array.from({ length: 3 }, () => host.requestBrokerChild(account, child, "fixture/initialization", {})));
      for (const response of results) {
        assert.equal(response.result.initialized, true);
        assert.equal(response.result.initializeCount, 1);
        assert.deepEqual(response.result.initializeParams.capabilities, {
          experimentalApi: true, requestAttestation: true, extensions: { "test.extension": {} },
        });
      }
    }
    assert.equal(await host.quiesceIdleAccount(fixture.accounts[1]), true);
    const cold = host.broker.acquireChild(fixture.accounts[1]);
    const result = await host.requestBrokerChild(fixture.accounts[1], cold, "fixture/initialization", {});
    assert.equal(result.result.initializeCount, 1);
    assert.equal(result.result.initialized, true);
    host.remoteModes.set(fixture.accounts[1], "enabled");
    assert.ok(await host.requestBrokerChild(fixture.accounts[1], cold, "account/read", {}), "remote ownership does not block safe reads");
    assert.ok(await host.requestBrokerChild(fixture.accounts[1], cold, "remoteControl/status/read", {}), "remote operations retain their own gate");
    assert.equal(await host.requestBrokerChild(fixture.accounts[1], cold, "project/update", {}), null, "remote ownership blocks desktop project writes");
    host.remoteModes.delete(fixture.accounts[1]);
    desktop.send({ jsonrpc: "2.0", id: "incompatible-init", method: "initialize", params: { clientInfo: { name: "other", version: "2" } } });
    const rejected = await waitForMessage(desktop.messages, (message) => responseFor([message], "incompatible-init") !== undefined, "incompatible initialize missing") as { error?: unknown };
    assert.ok(rejected.error);
  } finally { desktop?.close(); await owner.close(); }
});

test("feature broadcasts serialize the latest value and cold-child readiness includes replay", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const host = owner as any;
  let desktop: DesktopClient | null = null;
  try {
    await owner.start();
    desktop = await connectDesktop(fixture, 945, "tweakers");
    for (const [id, enabled] of [["feature-1", true], ["feature-2", false], ["feature-3", true]] as const) {
      desktop.send({ jsonrpc: "2.0", id, method: "experimentalFeature/enablement/set", params: { feature: "fixture", enabled } });
    }
    for (const id of ["feature-1", "feature-2", "feature-3"]) {
      await waitForMessage(desktop.messages, (message) => responseFor([message], id) !== undefined, `feature response ${id} missing`);
    }
    assert.equal(host.featureEnablements.size, 1);
    assert.equal(host.featureEnablements.get("fixture").enabled, true);
    const rows = readFileSync(join(fixture.root, "fixture-feature-enablement.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    for (const account of fixture.accounts) {
      assert.deepEqual(rows.filter((row) => row.account === account).map((row) => row.params.enabled), [true, false, true]);
    }
    assert.equal(await host.quiesceIdleAccount(fixture.accounts[1]), true);
    const cold = host.broker.acquireChild(fixture.accounts[1]);
    assert.equal(await host.initializeChild(cold), true, "a cold protocol handshake completes only after the latest feature replay");
    host.featureEnablements.set("retry-fixture", { feature: "retry-fixture", enabled: true, failOnce: true });
    host.featureRevision += 1;
    assert.equal(await host.initializeChild(cold), false, "a real failed replay keeps a protocol-ready child unavailable");
    assert.equal(await host.initializeChild(cold), true, "the next readiness attempt retries the failed replay without deadlock");
  } finally { desktop?.close(); await owner.close(); }
});

test("feature acknowledgements bind the exact child and failed peers retain the latest requested state", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const host = owner as any;
  let desktop: DesktopClient | null = null;
  try {
    await owner.start();
    desktop = await connectDesktop(fixture, 947, "tweakers");
    const request = host.requestBrokerChild.bind(host);
    let acknowledgeFirst!: () => void;
    const firstAcknowledged = new Promise<void>((resolve) => { acknowledgeFirst = resolve; });
    let replacement: any;
    host.requestBrokerChild = async (account: string, child: any, method: string, params: any) => {
      const response = await request(account, child, method, params);
      if (method !== "experimentalFeature/enablement/set" || params.feature !== "replacement-race") return response;
      if (account === fixture.accounts[0]) acknowledgeFirst();
      else {
        await firstAcknowledged;
        assert.equal(await host.quiesceIdleAccount(fixture.accounts[0]), true);
        replacement = host.broker.acquireChild(fixture.accounts[0]);
        assert.equal(await host.initializeChild(replacement), true);
      }
      return response;
    };
    desktop.send({ jsonrpc: "2.0", id: "feature-replacement", method: "experimentalFeature/enablement/set", params: { feature: "replacement-race", enabled: true } });
    const response = await waitForMessage(desktop.messages, (message) => responseFor([message], "feature-replacement") !== undefined, "feature broadcast response missing") as { error?: unknown };
    assert.equal(response.error, undefined);
    host.requestBrokerChild = request;
    assert.ok(replacement);
    assert.equal(await host.initializeChild(replacement), true);
    const rows = readFileSync(join(fixture.root, "fixture-feature-enablement.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => row.account === fixture.accounts[0] && row.params.feature === "replacement-race").length, 2,
      "the replacement must replay the feature acknowledged by the old child");
    desktop.send({ jsonrpc: "2.0", id: "feature-partial", method: "experimentalFeature/enablement/set", params: { feature: "failed-peer", enabled: true, failOnce: true } });
    const partial = await waitForMessage(desktop.messages, (message) => responseFor([message], "feature-partial") !== undefined, "partial feature response missing") as { error?: unknown };
    assert.ok(partial.error, "the caller learns that the broadcast was not fully applied");
    assert.equal(host.featureEnablements.get("failed-peer").enabled, true);
    for (const account of fixture.accounts) {
      assert.equal(await host.initializeChild(host.broker.acquireChild(account)), true,
        "a peer retries the retained request before serving another operation");
    }
  } finally { desktop?.close(); await owner.close(); }
});

test("fork responses use the returned fork conversation and model catalogs consume every bounded page", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const host = owner as any;
  let desktop: DesktopClient | null = null;
  try {
    await owner.start();
    desktop = await connectDesktop(fixture, 946, "tweakers");
    desktop.send({ jsonrpc: "2.0", id: "start-for-fork", method: "thread/start", params: {} });
    const started = await waitForMessage(desktop.messages, (message) => responseFor([message], "start-for-fork") !== undefined, "thread start missing") as { result: { threadId: string } };
    desktop.send({ jsonrpc: "2.0", id: "fork", method: "thread/fork", params: { threadId: started.result.threadId } });
    const forked = await waitForMessage(desktop.messages, (message) => responseFor([message], "fork") !== undefined, "thread fork missing") as { result: { threadId: string } };
    assert.notEqual(forked.result.threadId, started.result.threadId);
    const catalog = await host.readAccountModels(fixture.accounts[0]);
    assert.deepEqual(catalog.data.map((row: { id: string }) => row.id), [`first-${fixture.accounts[0]}`, `second-${fixture.accounts[0]}`]);
    assert.equal(catalog.nextCursor, null);
  } finally { desktop?.close(); await owner.close(); }
});

test("native section order is durable and scopes a foreign before-thread to the next local row", async () => {
  const fixture = createNativeFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const host = owner as any;
  try {
    await owner.start();
    assert.equal(host.nativeHistorySectionId(fixture.accounts[0], "shared-section"), "shared-section");
    assert.equal(host.nativeHistorySectionId(fixture.accounts[1], "shared-section"), "shared-section");
    assert.equal(host.historySections.get("shared-section").account, fixture.accounts[1], "the last successful listing selects the write home");
    host.nativeSectionHomes.set("moving-thread", { account: fixture.accounts[0], currentLocalId: null, expiresAt: Date.now() + 60_000 });
    const key = host.nativeSectionOrderKey("shared-section");
    host.store.update((state: any) => {
      state.threadOwners["foreign-thread"] = fixture.accounts[1];
      state.threadOwners["local-thread"] = fixture.accounts[0];
      state.nativeSectionOrders = { [key]: ["foreign-thread", "local-thread"] };
    });
    const translated = host.nativeSectionMoveRequest({ jsonrpc: "2.0", id: "move", method: "thread/section/move",
      params: { threadId: "moving-thread", sectionId: "shared-section", beforeThreadId: "foreign-thread" } }, fixture.accounts[0]);
    assert.equal(translated.params.beforeThreadId, "local-thread");
    assert.equal(translated.params.sectionId, "shared-section", "an unpinned thread can be moved into an available target section");
    const metadata = host.nativeSectionMoveMetadata(translated.params);
    assert.deepEqual(metadata, { threadId: "moving-thread", sectionKey: key, beforeThreadId: "local-thread" },
      "move metadata follows the thread listing home instead of the last account that listed the shared section");
    host.commitNativeSectionMove(metadata);
    const reloaded = new RouterStateStore(fixture.root, fixture.config).snapshot();
    assert.deepEqual(reloaded.nativeSectionOrders?.[key], ["foreign-thread", "moving-thread", "local-thread"]);
    host.commitNativeSectionMove({ threadId: "moving-thread", sectionKey: null, beforeThreadId: null });
    assert.equal(new RouterStateStore(fixture.root, fixture.config).snapshot().nativeSectionOrders?.[key]?.includes("moving-thread"), false);
  } finally { await owner.close(); }
});


test("initialization attestation stays with its requesting desktop and a failed handshake sends no native work", async () => {
  for (const complete of [true, false]) {
    const fixture = createFixture();
    const marker = join(fixture.root, "native-requests.log");
    const program = `
      const fs = require("node:fs");
      let initId = null;
      let ready = false;
      const write = value => process.stdout.write(JSON.stringify(value) + "\\n");
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          initId = message.id;
          write({ jsonrpc: "2.0", id: "native-attestation", method: "attestation/generate", params: { challenge: "fixture-challenge" } });
        } else if (message.id === "native-attestation" && message.result?.token === "origin-proof") {
          write({ jsonrpc: "2.0", id: initId, result: { userAgent: "fixture", codexHome: process.env.CODEX_HOME } });
        } else if (message.method === "initialized") ready = true;
        else if (message.method) {
          fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ method: message.method, ready }) + "\\n");
          write({ jsonrpc: "2.0", id: message.id, result: { account: null } });
        }
      });`;
    const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath, ["-e", program]);
    const connections: Array<{ close(): void }> = [];
    try {
      await owner.start();
      const originBinding = desktopBinding("tweakers", 950);
      const originMessages: JsonRpcMessage[] = [];
      const origin = await connectAccountsBrokerAppServerClient({ root: fixture.root, secret: fixture.secret, clientKind: "tweakers",
        rendererRef: createOpaqueRendererRef(fixture.secret, 950, originBinding), appToolsRef: createOpaqueAppToolsRef(fixture.secret, 950, originBinding) }, message => originMessages.push(message));
      connections.push(origin);
      origin.send({ jsonrpc: "2.0", id: "init", method: "initialize", params: { clientInfo: { name: "desktop", version: "1" }, capabilities: { requestAttestation: true } } });
      const challenge = await waitForMessage(originMessages, message => "method" in message && message.method === "attestation/generate", "attestation callback missing") as { id: string };
      const peerBinding = desktopBinding("chatgpt", 951);
      const peerMessages: JsonRpcMessage[] = [];
      const peer = await connectAccountsBrokerAppServerClient({ root: fixture.root, secret: fixture.secret, clientKind: "chatgpt",
        rendererRef: createOpaqueRendererRef(fixture.secret, 951, peerBinding), appToolsRef: createOpaqueAppToolsRef(fixture.secret, 951, peerBinding) }, message => peerMessages.push(message));
      connections.push(peer);
      peer.send({ jsonrpc: "2.0", id: challenge.id, result: { token: "origin-proof" } });
      origin.send({ jsonrpc: "2.0", id: "early-account", method: "account/read", params: {} });
      if (complete) origin.send({ jsonrpc: "2.0", id: challenge.id, result: { token: "origin-proof" } });
      const response = await waitForMessage(originMessages, message => responseFor([message], "early-account") !== undefined, "gated account response missing", 8_000) as { error?: unknown };
      if (complete) {
        assert.equal(response.error, undefined);
        assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n").map(line => JSON.parse(line)), [{ method: "account/read", ready: true }]);
      } else {
        assert.ok(response.error);
        assert.equal(existsSync(marker), false, "forged attestation and expired initialization cannot dispatch account work");
      }
      assert.equal(peerMessages.some(message => "method" in message && message.method === "attestation/generate"), false);
    } finally { for (const connection of connections) connection.close(); await owner.close(); }
  }
});


test("native catalogs above 512 KiB and split Unicode survive without closing the desktop bridge", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  let desktop: DesktopClient | null = null;
  try {
    await owner.start();
    desktop = await connectDesktop(fixture, 960, "tweakers");
    assert.equal(desktop.send({ jsonrpc: "2.0", id: "large-catalog", method: "plugin/list", params: { fixtureLarge: true } }), true);
    const catalog = await waitForMessage(desktop.messages, message => responseFor([message], "large-catalog") !== undefined, "large native catalog missing", 10_000) as any;
    const expected = "界🌍".repeat(180000);
    const actual = catalog.result.marketplaces[0].plugins[0].interface.description;
    assert.equal(Buffer.byteLength(actual), Buffer.byteLength(expected));
    assert.equal(createHash("sha256").update(actual).digest("hex"), createHash("sha256").update(expected).digest("hex"));
    assert.equal(desktop.send({ jsonrpc: "2.0", id: "unicode-echo", method: "fixture/echo", params: { value: expected } }), true);
    const echo = await waitForMessage(desktop.messages, message => responseFor([message], "unicode-echo") !== undefined, "Unicode request missing", 10_000) as any;
    assert.equal(createHash("sha256").update(echo.result.value).digest("hex"), createHash("sha256").update(expected).digest("hex"));
    assert.equal(desktop.send({ jsonrpc: "2.0", id: "over-bound", method: "fixture/echo", params: { value: "x".repeat(ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES) } }), false);
    assert.equal(desktop.send({ jsonrpc: "2.0", id: "after-catalog", method: "skills/list", params: { cwds: [] } }), true);
    const after = await waitForMessage(desktop.messages, message => responseFor([message], "after-catalog") !== undefined, "same bridge no longer answers after catalog", 10_000) as { result?: { ok?: boolean } };
    assert.equal(after.result?.ok, true);
    await owner.close();
    await desktop.whenClosed;
  } finally { desktop?.close(); await owner.close(); }
});

test("the desktop stdio bridge preserves early initialization through identity bootstrap and exits with its broker", async () => {
  for (const mode of ["immediate", "identity", "owner"] as const) {
    const delayedIdentity = mode === "identity";
    const fixture = createFixture();
    const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
      ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)],
      { onReservationAcquired: mode === "owner" ? () => new Promise(resolvePromise => setTimeout(resolvePromise, 6_000)) : undefined });
    const binding = desktopBinding("tweakers", 961);
    let adapter: ReturnType<typeof spawn> | null = null;
    let identityReady = !delayedIdentity;
    const entrypoint = join(__dirname, "../../src/account-router/broker-app-server.ts");
    const childProcess: MutableChildProcessModule = { spawn: ((_command, args, options) =>
      spawn(process.execPath, ["--import", "tsx", ...(args as string[])], options)) as SpawnFunction };
    const installation = installCodexAppServerParent({
      childProcess, resourcesPath: "/fixture", platform: "darwin", pathExists: () => true,
      accountRouter: { brokerRoot: fixture.root, brokerEntrypointPath: entrypoint,
        resolveBrokerDesktopIdentity: () => identityReady ? {
          rendererRef: createOpaqueRendererRef(fixture.secret, 961, binding),
          appToolsRef: createOpaqueAppToolsRef(fixture.secret, 961, binding),
        } : null },
    });
    const ownerStarted = owner.start();
    try {
      if (mode !== "owner") await ownerStarted;
      adapter = childProcess.spawn("/fixture/codex", ["app-server"], {
        cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TWEAKERS_DERIVED_VARIANT: "1" },
      });
      const exited = new Promise<number | null>((resolvePromise) => adapter!.once("exit", resolvePromise));
      let initializationResponses = 0;
      const ready = new Promise<void>((resolvePromise, reject) => {
        let bytes = "";
        const timer = setTimeout(() => reject(new Error("stdio bridge initialization timed out")), 8_000);
        adapter!.stdout!.on("data", (chunk) => {
          bytes += chunk.toString();
          if (bytes.includes("\n")) { initializationResponses += 1; clearTimeout(timer); assert.equal(JSON.parse(bytes.trim()).id, "bridge-init"); resolvePromise(); }
        });
      });
      adapter.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: "bridge-init", method: "initialize", params: { clientInfo: { name: "fixture-desktop", version: "1" } } }) + "\n");
      if (delayedIdentity) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
        assert.equal(adapter.exitCode, null, "the bridge must wait for the first owned window");
        identityReady = true;
      }
      await ready;
      assert.equal(initializationResponses, 1, "startup reconnects cannot replay initialization");
      await ownerStarted;
      await owner.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([exited, new Promise<"timeout">((resolvePromise) => { timer = setTimeout(() => resolvePromise("timeout"), 3_000); })]);
      if (timer) clearTimeout(timer);
      assert.equal(code, 1, "closed broker must not leave a live but unresponsive desktop adapter");
    } finally {
      if (adapter && adapter.exitCode === null && adapter.signalCode === null) adapter.kill("SIGTERM");
      await ownerStarted.catch(() => {});
      await owner.close();
      installation.uninstall();
    }
  }
});


test("account connection reads consume every native page and retain both selected accounts beyond 256 entries", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, undefined, false, 0, false, null, true)]);
  let desktop: DesktopClient | null = null;
  let control: AccountsBrokerSocketClientV1 | null = null;
  try {
    await owner.start();
    desktop = await connectDesktop(fixture, 962, "tweakers");
    control = controlClient(fixture, 962, "tweakers");
    const events: BrokerEventV1[] = [];
    const unsubscribe = control.subscribe((event) => events.push(event));
    for (const [index, account] of fixture.accounts.entries()) {
      const response = await control.invoke({ version: 1, requestId: "paged-connections-" + index, command: "connection.list", params: { opaqueAccountId: account, kind: "app" } });
      assert.equal(response.ok, true, JSON.stringify(response));
      if (response.ok) {
        const rows = response.result as Array<{ opaqueAccountId: string; definitionRef: string }>;
        assert.equal(rows.length, 300, "later native pages cannot disappear or hit the old 256-row cache cap");
        assert.equal(new Set(rows.map((row) => row.definitionRef)).size, 300, "stable ids distinguish equal display names");
        assert.ok(rows.every((row) => row.opaqueAccountId === account));
      }
    }
    assert.equal((owner as any).broker.connectionStates().length, 600);
    const profile = await control.invoke({ version: 1, requestId: "after-large-connections", command: "profile.read" });
    assert.equal(profile.ok, true, "large responses and events must not close the private command channel");
    assert.ok(events.some((event) => event.type === "connection" && Array.isArray(event.payload) && event.payload.length === 600));
    unsubscribe();
  } finally { await control?.close(); desktop?.close(); await owner.close(); }
});


test("partial native installed plugin catalogs preserve cached rows as unavailable", async () => {
  const fixture = createFixture();
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", fixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!, undefined, false, -1)]);
  await owner.start();
  const desktop = await connectDesktop(fixture, 963, "tweakers");
  const control = controlClient(fixture, 963, "tweakers");
  try {
    const first = await control.invoke({ version: 1, requestId: "installed-complete", command: "connection.list", params: { opaqueAccountId: fixture.accounts[0], kind: "plugin" } });
    assert.equal(first.ok, true);
    const partial = await control.invoke({ version: 1, requestId: "installed-partial", command: "connection.list", params: { opaqueAccountId: fixture.accounts[0], kind: "plugin" } });
    assert.equal(partial.ok, true);
    if (first.ok && partial.ok) {
      const prior = first.result as Array<{ definitionRef: string }>;
      const current = partial.result as Array<{ definitionRef: string; status: string }>;
      assert.equal(prior.length, 1);
      assert.deepEqual(current.map((row) => row.definitionRef), prior.map((row) => row.definitionRef));
      assert.ok(current.every((row) => row.status === "unavailable"));
    }
  } finally { await control.close(); desktop.close(); await owner.close(); }
});


test("direct child initialization gates provider readiness on private external login and account read", async () => {
  for (const accept of [true, false]) {
    const processChild = spawn(process.execPath, ["-e", `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', line => { const m = JSON.parse(line); if (!m.id) return;
        const result = m.method === 'initialize' ? { userAgent: 'fixture/1.0.0' }
          : m.method === 'account/login/start' ? { type: 'chatgptAuthTokens' }
          : { account: ${accept ? "{ type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' }" : "null"} };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      });
    `], { stdio: ["pipe", "pipe", "ignore"] });
    const sequence: string[] = [];
    const child = new BrokerProcessChild("ar_fixture" as OpaqueAccountId, processChild, () => { throw new Error("private auth escaped"); }, () => {}, async (candidate) => {
      assert.equal(candidate.ready, false);
      assert.throws(() => candidate.send({ jsonrpc: "2.0", id: "blocked", method: "thread/start", params: {} }));
      sequence.push("login"); const login = await candidate.requestPrivate("account/login/start", { type: "chatgptAuthTokens", accessToken: "synthetic", chatgptAccountId: "fixture" });
      assert.ok(login && !login.error); assert.equal(candidate.ready, false);
      sequence.push("read"); const read = await candidate.requestPrivate("account/read", { refreshToken: false });
      return !!(read?.result as any)?.account;
    });
    try {
      const result = await child.initialize({ clientInfo: { name: "fixture", version: "1" } }, {} as any);
      assert.equal(result, accept); assert.equal(child.ready, accept); assert.deepEqual(sequence, ["login", "read"]);
    } finally { assert.equal(await child.terminateAndWait(), true); }
  }
  assert.deepEqual(credentialStoreArgs(["app-server", "-c", 'cli_auth_credentials_store="auto"'], "ephemeral"), ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"']);
});

test("isolated credential refresh is single-flight and reconnect publishes only matching successful auth", async () => {
  for (const loginIdentity of ["registered", "foreign"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "broker-isolated-auth-"))); chmodSync(root, 0o700);
    const authHome = join(root, "auth-home"); mkdirSync(authHome, { mode: 0o700 });
    const originalHome = join(root, "original"); mkdirSync(originalHome, { mode: 0o700 });
    const original = Buffer.from(JSON.stringify({ tokens: { account_id: "original-sentinel", access_token: "sentinel" } }));
    writeFileSync(join(originalHome, "auth.json"), original, { mode: 0o600 });
    writeFileSync(join(authHome, "auth.json"), JSON.stringify({ tokens: { account_id: "registered", access_token: "old", refresh_token: "refresh" } }), { mode: 0o600 });
    const script = join(root, "helper.cjs");
    writeFileSync(script, `
      const fs = require('node:fs'); const path = require('node:path');
      const ephemeral = process.argv.includes('cli_auth_credentials_store="ephemeral"');
      if (process.env.CODEX_HOME !== process.env.CODEX_SQLITE_HOME || (!ephemeral && !process.argv.includes('cli_auth_credentials_store="file"'))) process.exit(2);
      const home = process.env.CODEX_HOME; const auth = path.join(home, 'auth.json');
      let external = false;
      const reply = (m, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line); if (!m.id) return;
        if (m.method === 'initialize') return reply(m, { userAgent: 'fixture/1.0.0' });
        if (m.method === 'account/login/start' && ephemeral) {
          if (m.params.accessToken !== 'fresh') return process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:'expired token'}})+'\\n');
          external = true; return reply(m, {type:'chatgptAuthTokens'});
        }
        if (m.method === 'account/read') {
          if (ephemeral) return reply(m, {account: external ? {type:'chatgpt',email:'fixture@example.invalid',planType:'plus'} : null});
          if (m.params.refreshToken) { fs.appendFileSync(path.join(home, 'refresh-count'), '1'); fs.writeFileSync(auth, JSON.stringify({tokens:{account_id:'registered', access_token:'fresh', refresh_token:'new-refresh'}}), {mode:384}); }
          return setTimeout(() => reply(m, { account: { type:'chatgpt', email:'fixture@example.invalid', planType:'plus' } }), 30);
        }
      });
    `, { mode: 0o600 });
    const secret = Buffer.alloc(32, 11);
    const account = `ar_${createHmac("sha256", secret).update("account-router:v1:registered").digest("base64url")}` as OpaqueAccountId;
    const owner = Object.create(AccountsBrokerOwnerV1.prototype) as any;
    Object.assign(owner, { secret, command: process.execPath, args: [script], authRefreshes: new Map(), authHelperTails: new Map(), authHelperQueued: new Map(), activeAuthHelpers: new Map(), enrollmentHelpers: new Map(),
      desktopInitialization: { params: { clientInfo: { name: "fixture", version: "1" } }, client: {} },
      isolatedAuthHome: () => authHome,
      nativeAccountBinding: () => ({ opaqueAccountId: account, authIdentityHmac: nativeHistoryAuthIdentityHmacV1("registered", secret), codexHome: originalHome, sqliteHome: originalHome }),
      receiveChild: () => {},
    });
    const serialOrder: string[] = [];
    const profileRead = owner.withAuthHelper(account, async (helper: BrokerProcessChild) => {
      serialOrder.push("profile-start");
      const response = await helper.requestPrivate("account/read", { refreshToken: false }); serialOrder.push("profile-done"); return response;
    });
    const first = owner.refreshIsolatedAuth(account); const second = owner.refreshIsolatedAuth(account);
    assert.equal(first, second);
    assert.ok(await profileRead); assert.deepEqual(serialOrder, ["profile-start", "profile-done"]);
    assert.equal((await first)?.accessToken, "fresh"); assert.equal(readFileSync(join(authHome, "refresh-count"), "utf8"), "1");
    const beforeReconnect = readFileSync(join(authHome, "auth.json"));
    const helper = owner.reconnectHelper("reconnect-fixture", account);
    assert.ok(helper.root.startsWith(authHome)); assert.notEqual(helper.root, authHome);
    assert.equal(await helper.child.initialize(owner.desktopInitialization.params, {}), true);
    writeFileSync(join(helper.root, "auth.json"), JSON.stringify({ tokens: { account_id: loginIdentity, access_token: "reconnected", refresh_token: "new" } }), { mode: 0o600 });
    await owner.completeIsolatedReconnect(helper);
    assert.equal(helper.completion.success, loginIdentity === "registered");
    if (loginIdentity === "foreign") assert.deepEqual(readFileSync(join(authHome, "auth.json")), beforeReconnect);
    else assert.equal(JSON.parse(readFileSync(join(authHome, "auth.json"), "utf8")).tokens.access_token, "reconnected");
    owner.retireEnrollmentHelper("reconnect-fixture");
    const cancel = owner.reconnectHelper("cancel-fixture", account); const cancelBefore = readFileSync(join(authHome, "auth.json"));
    owner.retireEnrollmentHelper("cancel-fixture"); await cancel.child.whenClosed();
    assert.deepEqual(readFileSync(join(authHome, "auth.json")), cancelBefore);
    writeFileSync(join(authHome, "auth.json"), JSON.stringify({ tokens: { account_id: "registered", access_token: "expired", refresh_token: "refresh" } }), { mode: 0o600 });
    Object.assign(owner, {
      stateRoot: root, nativeHistory: {}, nativeTransferHeldAccounts: new Set(), children: new Map(),
      prepareAccountContinuity: () => true, nativeHistoryWritersSafe: () => true,
      failPendingForChild: () => {}, broker: { markChildUnavailable: () => {} },
    });
    const startup = owner.createChild(account) as BrokerProcessChild;
    try {
      assert.equal(await startup.initialize(owner.desktopInitialization.params, {} as any), true, "expired stored tokens refresh before external login and readiness");
      assert.equal(readFileSync(join(authHome, "refresh-count"), "utf8"), "11");
    } finally { await startup.terminateAndWait(); }
    assert.deepEqual(readFileSync(join(originalHome, "auth.json")), original);
  }
});

test("external refresh stays owner-private, rejects foreign identity and bounds duplicate correlation", async () => {
  const secret = Buffer.alloc(32, 19); const account = "ar_fixture" as OpaqueAccountId;
  const sent: any[] = []; let unavailable = 0; let terminated = 0; let refreshes = 0;
  const child = { send: (value: unknown) => sent.push(value), terminate: () => { terminated += 1; } };
  const owner = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  Object.assign(owner, { secret, children: new Map([[account, child]]), pendingAuthRefreshRequests: new Map(),
    broker: { markChildUnavailable: () => { unavailable += 1; } }, isolatedAuthHome: () => "/synthetic/auth-home",
    nativeAccountBinding: () => ({ authIdentityHmac: nativeHistoryAuthIdentityHmacV1("registered", secret) }),
    refreshIsolatedAuth: async () => { refreshes += 1; return { accessToken: "private-synthetic-token", chatgptAccountId: "registered", chatgptPlanType: null }; },
  });
  owner.routeChildRequest(account, child, { jsonrpc: "2.0", id: "foreign", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "foreign" } });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(refreshes, 0); assert.equal(unavailable, 1); assert.ok(sent[0].error);
  assert.equal(JSON.stringify(sent[0]).includes("foreign"), true, "only the synthetic correlation ID is preserved");
  owner.routeChildRequest(account, child, { jsonrpc: "2.0", id: "valid", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "registered" } });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(refreshes, 1); assert.equal(sent[1].result.accessToken, "private-synthetic-token");
  owner.refreshIsolatedAuth = async () => null;
  owner.routeChildRequest(account, child, { jsonrpc: "2.0", id: "failed", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: null } });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(unavailable, 2); assert.ok(sent[2].error); assert.equal(JSON.stringify(sent[2]).includes("private-synthetic-token"), false);
  let settle!: (value: null) => void; owner.refreshIsolatedAuth = () => new Promise((resolvePromise) => { settle = resolvePromise; });
  const duplicate = { jsonrpc: "2.0", id: "duplicate", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: null } };
  owner.routeChildRequest(account, child, duplicate); owner.routeChildRequest(account, child, duplicate);
  assert.equal(terminated, 1); settle(null); await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(owner.pendingAuthRefreshRequests.size, 0);
});


test("native inventory binds the current actor across refresh, rejects drift and preserves only valid same-actor cache", async () => {
  const fixture = createFixture();
  const baseRoot = join(fixture.root, "native-base");
  const overlay = join(fixture.root, "overlay");
  mkdirSync(baseRoot, { mode: 0o700 }); mkdirSync(overlay, { mode: 0o700 });
  const setActor = (raw: string) => privateWrite(join(baseRoot, "auth.json"), JSON.stringify({ tokens: { account_id: raw, access_token: "never-publish-this" } }));
  setActor(fixture.rawAccounts[0]!);
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  Object.assign(host, { config: { ...fixture.config, primaryOpaqueAccountId: fixture.accounts[1] }, secret: fixture.secret,
    stateRoot: fixture.root, closed: false, inventoryFreshUntil: 0, inventoryFreshKey: "", inventoryRefresh: null });
  const mode = { state: "ready", fingerprint: `sha256:${"a".repeat(64)}`, document: {
    sourceAccountId: fixture.accounts[1], nativeBase: { path: baseRoot }, overlay: { path: overlay },
  } };
  host.sharedNativeMode = () => mode;
  host.nativeAccountBinding = (account: OpaqueAccountId) => {
    const index = fixture.accounts.indexOf(account);
    return index < 0 ? null : { opaqueAccountId: account, authIdentityHmac: nativeHistoryAuthIdentityHmacV1(fixture.rawAccounts[index]!, fixture.secret) };
  };
  host.initializeChild = async () => true;
  host.broker = { acquireChild: (account: OpaqueAccountId) => ({ ready: true, opaqueAccountId: account }) };
  const requests: OpaqueAccountId[] = [];
  let complete!: (value: unknown) => void;
  host.requestInitializedBrokerChild = async (account: OpaqueAccountId, _child: unknown, method: string, params: unknown) => {
    assert.equal(method, "plugin/installed"); assert.deepEqual(params, { nativeBaseInventoryOnly: true });
    requests.push(account); return new Promise((resolvePromise) => { complete = resolvePromise; });
  };
  let reloads = 0;
  host.reloadSharedNativeChildren = async () => { reloads++; };
  const result = { result: { marketplaces: [{ name: "openai-curated-remote", plugins: [
    { id: "valid.plugin@openai-curated-remote", installed: true, enabled: false, version: null, remotePluginId: "never-publish-provider-id" },
  ] }], marketplaceLoadErrors: [] } };
  const first = host.ensureNativePluginInventory();
  const concurrent = host.ensureNativePluginInventory();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(requests, [fixture.accounts[0]], "actual base credentials override routing and history donor");
  setActor(fixture.rawAccounts[1]!);
  complete(result);
  assert.deepEqual(await Promise.all([first, concurrent]), [false, false]);
  const inventoryPath = join(overlay, "plugins", "tweakers-native-inventory.json");
  assert.equal(existsSync(inventoryPath), false, "an actor switch during provider read cannot publish stale identity data");
  mkdirSync(join(overlay, "plugins"), { mode: 0o755 });
  host.requestInitializedBrokerChild = async (account: OpaqueAccountId) => { requests.push(account); return result; };
  assert.equal(await host.ensureNativePluginInventory(), true);
  assert.equal(requests.at(-1), fixture.accounts[1]);
  assert.equal(reloads, 1);
  assert.equal(lstatSync(join(overlay, "plugins")).mode & 0o777, 0o700, "native-created plugin directories become private for inventory publication");
  const published = readFileSync(inventoryPath, "utf8");
  assert.equal(published.includes("never-publish"), false);
  const inode = lstatSync(inventoryPath).ino;
  host.requestInitializedBrokerChild = async () => ({ error: { code: -32000 } });
  assert.equal(await host.ensureNativePluginInventory(true), true);
  assert.equal(lstatSync(inventoryPath).ino, inode);
  host.inventoryFreshKey = ""; host.inventoryFreshUntil = 0;
  assert.equal(await host.ensureNativePluginInventory(), true, "persisted same-actor cache works after owner cache reset");
  setActor(fixture.rawAccounts[0]!);
  assert.equal(await host.ensureNativePluginInventory(), false, "a different actor cannot inherit the former actor's cache on failure");
  setActor(fixture.rawAccounts[1]!);
  privateWrite(inventoryPath, published.replace('"enabled":false', '"enabled":true'));
  assert.equal(await host.ensureNativePluginInventory(true), false, "valid-looking data with a changed digest is rejected");
  privateWrite(inventoryPath, published);
  privateWrite(join(fixture.root, "shared-native-plugin-inventory.v1.json"), "{}");
  assert.equal(await host.ensureNativePluginInventory(true), false, "missing provenance is never an authoritative cache");
  for (const plugin of [
    { id: "bad..name@openai-curated-remote", installed: true, enabled: true, version: null },
    { id: "valid@openai-curated-remote", installed: true, enabled: "true", version: null },
    { id: "valid@openai-curated-remote", installed: true, enabled: true, version: "" },
  ]) {
    host.requestInitializedBrokerChild = async () => ({ result: { marketplaces: [{ name: "openai-curated-remote", plugins: [plugin] }], marketplaceLoadErrors: [] } });
    assert.equal(await host.ensureNativePluginInventory(true), false);
    assert.equal(readFileSync(inventoryPath, "utf8"), published, "malformed remote data must leave the last published bytes intact");
  }
  host.requestInitializedBrokerChild = async () => result;
  assert.equal(await host.ensureNativePluginInventory(true), true);
  assert.equal(reloads, 2);
  setActor("unconfigured-actor");
  const count = requests.length;
  assert.equal(await host.ensureNativePluginInventory(), false);
  assert.equal(requests.length, count, "unconfigured base actor never dispatches to an arbitrary child");
});

test("shared native children keep original homes and bypass copying with a verified resolver", async () => {
  const fixture = createNativeFixture();
  const accounts = fixture.accounts.map((opaqueAccountId) => ({ opaqueAccountId,
    codexHome: join(fixture.homesRoot, "accounts", opaqueAccountId, "codex-home") }));
  const donor = accounts.find((account) => account.opaqueAccountId === fixture.accounts[0])!;
  privateWrite(join(donor.codexHome, "config.toml"), 'model = "native-base"\n');
  const base = bootstrapAccountContinuity({ stateRoot: fixture.root, primaryOpaqueAccountId: fixture.config.primaryOpaqueAccountId,
    sharedSourceOpaqueAccountId: donor.opaqueAccountId, accounts, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(base.state, "ready", base.reason);
  const preflight = readAndPreflightNativeHistorySourceStaticV1(fixture.root, fixture.config, fixture.secret);
  assert.equal(preflight.state, "ready");
  if (preflight.state !== "ready") return;
  const overlayPath = join(fixture.root, "shared-overlay");
  mkdirSync(overlayPath, { mode: 0o700 });
  const context = { stateRoot: fixture.root, binding: preflight.binding, secret: fixture.secret };
  const plan = prepareSharedNativeModeV1({ ...context, overlayPath,
    expectedSourceFingerprint: preflight.binding.sourceDocumentFingerprint,
    expectedRebaseIntentFingerprint: null,
    resolverBinarySha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
  });
  assert.equal(plan.state, "prepared", plan.state === "blocked" ? plan.reason : undefined);
  if (plan.state !== "prepared") return;
  assert.equal(publishSharedNativeModeV1({ ...context, plan: plan.plan, expectedPlanFingerprint: plan.fingerprint }).state, "published");
  const originalConfigs = accounts.map((account) => existsSync(join(account.codexHome, "config.toml"))
    ? readFileSync(join(account.codexHome, "config.toml"), "utf8") : null);
  const originalAuth = accounts.map((account) => readFileSync(join(account.codexHome, "auth.json"), "utf8"));
  const marker = join(fixture.root, "shared-launches.jsonl");
  const prefix = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, JSON.stringify({home:process.env.CODEX_HOME,sqlite:process.env.CODEX_SQLITE_HOME,base:process.env.TWEAKERS_NATIVE_BASE_ROOT,overlay:process.env.TWEAKERS_OVERLAY_ROOT})+"\\n");`;
  const owner = new AccountsBrokerOwnerV1(fixture.config, fixture.root, fixture.secret, process.execPath,
    ["-e", prefix + nativeFixtureChildProgram(fixture.accounts[0]!, fixture.accounts[1]!)]);
  const host = owner as any;
  let desktop: DesktopClient | null = null;
  try {
    await owner.start();
    desktop = await connectDesktop(fixture, 984, "tweakers");
    for (const account of fixture.accounts) {
      const child = host.broker.acquireChild(account);
      assert.ok(child);
      assert.ok(await host.requestBrokerChild(account, child, "account/read", {}));
    }
    const launches = readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    for (const entry of preflight.binding.accounts) assert.ok(launches.some((launch) =>
      launch.home === entry.codexHome && launch.sqlite === entry.sqliteHome
      && launch.base === donor.codexHome && launch.overlay === overlayPath));
    desktop.send({ jsonrpc: "2.0", id: "inventory-desktop", method: "plugin/list", params: {} });
    const peer = host.broker.acquireChild(fixture.accounts[1]);
    assert.ok(await host.requestBrokerChild(fixture.accounts[1], peer, "skills/list", {}));
    await waitForMessage(desktop.messages, (message) => responseFor([message], "inventory-desktop") !== undefined, "inventory-gated desktop read missing");
    const inventoryPath = join(overlayPath, "plugins", "tweakers-native-inventory.json");
    const inventoryBytes = readFileSync(inventoryPath, "utf8");
    const inventory = JSON.parse(inventoryBytes);
    assert.deepEqual(inventory, { schema_version: 1, native_base_root: donor.codexHome, plugins: [
      { id: "alpha@openai-curated-remote", enabled: true, version: "1.2.3" },
      { id: "zeta@openai-curated-remote", enabled: false, version: null },
    ] });
    assert.equal(inventoryBytes.includes("private-provider-id"), false);
    assert.equal(lstatSync(inventoryPath).mode & 0o777, 0o600);
    const inventoryRequests = () => readFileSync(join(overlayPath, "fixture-inventory-requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(inventoryRequests().length, 1, "concurrent consumers must share one raw bootstrap");
    assert.equal(inventoryRequests()[0].account, donor.opaqueAccountId);
    assert.notEqual(donor.opaqueAccountId, fixture.config.primaryOpaqueAccountId, "the fixture distinguishes native actor from routing primary");
    const originalInode = lstatSync(inventoryPath).ino;
    assert.equal(await host.ensureNativePluginInventory(true), true);
    assert.equal(lstatSync(inventoryPath).ino, originalInode, "unchanged inventory must not republish");
    const responseOverride = join(overlayPath, "fixture-inventory-response.json");
    privateWrite(responseOverride, JSON.stringify({ error: true }));
    assert.equal(await host.ensureNativePluginInventory(true), true, "same-actor valid cache survives provider failure");
    assert.equal(readFileSync(inventoryPath, "utf8"), inventoryBytes);
    const changedInventory = { marketplaces: [{ name: "openai-curated-remote", plugins: [
      { id: "alpha@openai-curated-remote", installed: true, enabled: false, version: "2" },
    ] }], marketplaceLoadErrors: [] };
    privateWrite(responseOverride, JSON.stringify(changedInventory));
    assert.equal(await host.ensureNativePluginInventory(true), true);
    assert.deepEqual(JSON.parse(readFileSync(inventoryPath, "utf8")).plugins, [{ id: "alpha@openai-curated-remote", enabled: false, version: "2" }]);
    const originalFetch = globalThis.fetch;
    let providerMutations = 0;
    globalThis.fetch = async () => { providerMutations++; throw new Error("unexpected provider mutation"); };
    try {
      const legacy = await host.dispatchDeviceAction({ kind: "native.request", opaqueAccountId: fixture.accounts[0], surface: "plugins",
        method: "http.request", params: { verb: "POST", path: "/ps/plugins/{plugin_id}/uninstall", options: { path: { plugin_id: "fixture-plugin" }, query: {} } } });
      assert.equal(legacy.outcome, "rejected");
      assert.equal(providerMutations, 0);
    } finally { globalThis.fetch = originalFetch; }
    const writeResult = await host.dispatchDeviceAction({ kind: "native.request", opaqueAccountId: fixture.accounts[0],
      surface: "plugins", method: "config/value/write", params: { keyPath: "plugins.example.enabled", value: false, mergeStrategy: "replace", filePath: null, expectedVersion: null } });
    assert.equal(writeResult.outcome, "accepted");
    const requests = readFileSync(join(overlayPath, "fixture-config-requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((request) => request.method === "config/value/write").length, 1);
    for (const account of fixture.accounts) assert.ok(requests.some((request) => request.account === account && request.method === "config/batchWrite"
      && request.params.reloadUserConfig === true && request.params.edits.length === 0));
    for (const account of fixture.accounts) assert.equal(await host.quiesceIdleAccount(account), true);
    assert.equal(loadSharedAccountBase(fixture.root)!.fingerprint, base.shared!.fingerprint);
    assert.deepEqual(accounts.map((account) => existsSync(join(account.codexHome, "config.toml"))
      ? readFileSync(join(account.codexHome, "config.toml"), "utf8") : null), originalConfigs);
    assert.deepEqual(accounts.map((account) => readFileSync(join(account.codexHome, "auth.json"), "utf8")), originalAuth);
    host.command = "/usr/bin/true";
    assert.throws(() => host.createChild(fixture.accounts[0]), /unverified shared native resolver binary/);
  } finally { desktop?.close(); await owner.close(); }
});
