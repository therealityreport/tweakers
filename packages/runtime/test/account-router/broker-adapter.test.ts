import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { AccountsBrokerRendererAdapterV1 } from "../../src/account-router/broker-adapter";
import { AccountsBrokerV1, createBrokerHandshakeProof } from "../../src/account-router/broker";
import { NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES } from "../../src/account-router/native-request";
import type { BrokerHandshakeV1, OpaqueAccountId, OpaqueAppToolsRef, OpaqueConnectionDefinitionRef, OpaqueRendererRef } from "../../src/account-router/types";

const secret = Buffer.alloc(32, 31);
const account = `ar_${"q".repeat(43)}` as OpaqueAccountId;
const renderer = `br_${"r".repeat(43)}` as OpaqueRendererRef;
const tools = `bat_${"t".repeat(43)}` as OpaqueAppToolsRef;

function handshake(): BrokerHandshakeV1 {
  const unsigned = {
    version: 1 as const,
    clientKind: "chatgpt" as const,
    rendererRef: renderer,
    appToolsRef: tools,
    nonce: "a".repeat(32),
  };
  return { ...unsigned, proof: createBrokerHandshakeProof(secret, unsigned) };
}

test("renderer adapter accepts only the locked public envelope and strips all private account handles", async () => {
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({
    secret,
    client: {
      invoke: (envelope) => broker.invoke(renderer, envelope),
      subscribe: (handler) => broker.subscribe(renderer, handler),
    },
  });

  const profile = await adapter.invoke({ version: 1, action: "broker", requestId: "profile", command: "profile.read" });
  assert.equal(profile.ok, true);
  assert.deepEqual(profile.ok ? Object.keys(profile.result as object).sort() : [], ["accounts", "selectedAccountId"]);
  const serialized = JSON.stringify(profile);
  assert.doesNotMatch(serialized, /\b(?:ar|br|bat|bd|bt|bh)_/);
  const accountId = profile.ok
    ? (profile.result as { selectedAccountId: string | null }).selectedAccountId
    : null;
  assert.ok(accountId);

  const enabled = await adapter.invoke({
    version: 1,
    action: "broker",
    requestId: "enabled",
    command: "enabled.set",
    params: { accountId, enabled: false },
  });
  assert.equal(enabled.ok, true);
  assert.deepEqual(enabled.ok ? Object.keys(enabled.result as object).sort() : [], ["account", "lifecycle"]);
  assert.equal(enabled.ok ? (enabled.result as { account: { enabled: boolean } }).account.enabled : null, false);
  assert.equal(enabled.ok ? (enabled.result as { lifecycle: string }).lifecycle : null, "idle_child_stopped");

  const rejected = await adapter.invoke({
    version: 1,
    action: "broker",
    requestId: "raw",
    command: "enabled.set",
    params: { opaqueAccountId: account, enabled: true },
  } as never);
  assert.deepEqual(rejected, { version: 1, requestId: "raw", ok: false, error: { code: "invalid_request", retryable: false } });
});

test("native requests capture one public account and dispatch only the reviewed surface method", async () => {
  const actions: unknown[] = [];
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: account, enabled: true }], secret,
    onDeviceAction(action) {
      actions.push(action);
      return action.kind === "native.request" ? { outcome: "accepted", value: { data: [{ id: "fixture-app" }] } } : { outcome: "rejected" };
    },
  });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client: {
    invoke: (envelope) => broker.invoke(renderer, envelope), subscribe: (handler) => broker.subscribe(renderer, handler),
  } });
  const profile = await adapter.invoke({ version: 1, action: "broker", requestId: "native-profile", command: "profile.read" });
  const accountId = profile.ok ? (profile.result as { selectedAccountId: string }).selectedAccountId : "";
  const response = await adapter.invoke({ version: 1, action: "broker", requestId: "native-apps", command: "native.request",
    params: { accountId, surface: "apps", method: "app/list", params: { limit: 20 } } });
  assert.equal(response.ok, true);
  assert.deepEqual(response.ok ? response.result : null, { accountId, surface: "apps", result: { data: [{ id: "fixture-app" }] } });
  assert.deepEqual(actions.filter((action) => (action as { kind?: string }).kind === "native.request"), [{ kind: "native.request", opaqueAccountId: account, surface: "apps", method: "app/list", params: { limit: 20 } }]);
  const reviewed: Array<{ surface: "apps" | "plugins" | "mcp"; method: string; params: Record<string, unknown> }> = [
    { surface: "apps", method: "config/read", params: { cwd: null, includeLayers: true } },
    { surface: "apps", method: "config/read", params: { cwd: realpathSync(process.cwd()), includeLayers: true } },
    { surface: "apps", method: "config/value/write", params: { keyPath: "apps.fixture.enabled", value: true, mergeStrategy: "upsert", filePath: null, expectedVersion: null } },
    { surface: "plugins", method: "config/batchWrite", params: { edits: [{ keyPath: "plugins.fixture.enabled", value: false, mergeStrategy: "replace" }], filePath: "/fixture/account/config.toml", expectedVersion: 7, reloadUserConfig: true } },
    { surface: "mcp", method: "config/value/write", params: { keyPath: "mcp_servers.fixture.enabled", value: true, mergeStrategy: "replace", filePath: null, expectedVersion: "version-8" } },
    { surface: "apps", method: "http.request", params: { verb: "GET", path: "/aip/connectors/{connector_id}", options: { parameters: { path: { connector_id: "connector-1" }, query: { include_actions: true } } } } },
    { surface: "apps", method: "http.request", params: { verb: "GET", path: "/aip/connectors/{connector_id}/link", options: { parameters: { path: { connector_id: "connector-1" } } } } },
    { surface: "apps", method: "http.request", params: { verb: "POST", path: "/aip/connectors/links/list_accessible", options: { requestBody: { principals: [], link_refresh_strategy: "BLOCKING" } } } },
    { surface: "apps", method: "http.request", params: { verb: "POST", path: "/aip/connectors/links/noauth", options: { requestBody: { connector_id: "connector-1", name: "Fixture", action_names: [], install_attempt_id: "attempt-1" } } } },
    { surface: "apps", method: "http.request", params: { verb: "POST", path: "/aip/connectors/links/oauth", options: { requestBody: { connector_id: "connector-1", name: "Fixture", action_names: null, callback_url: "https://chatgpt.com/callback", post_auth_url: "https://example.test/install", requested_companion_connector_ids: ["companion-1"] } } } },
    { surface: "apps", method: "http.request", params: { verb: "POST", path: "/aip/connectors/links/oauth/complete", options: { requestBody: { connector_id: "connector-1", connection_consent: { connection_id: "connection-1", granted_scopes: ["read"] } } } } },
    { surface: "apps", method: "http.request", params: { verb: "POST", path: "/aip/connectors/links/oauth/reauth", options: { requestBody: { callback_url: "https://chatgpt.com/callback", link_id: "link-1", post_auth_url: "https://example.test/install", requested_scopes: ["read"] } } } },
    { surface: "apps", method: "http.request", params: { verb: "POST", path: "/aip/connectors/links/oauth/callback", options: { requestBody: { full_redirect_url: "https://chatgpt.com/connector_platform_oauth_redirect?state=fixture" } } } },
    { surface: "apps", method: "http.request", params: { verb: "POST", path: "/aip/connectors/github/has_installations", options: { requestBody: { link_id: "link-1" } } } },
    { surface: "apps", method: "http.request", params: { verb: "GET", path: "/wham/github/installations/v2", options: { parameters: { query: { connector_id: "connector-1" } } } } },
    { surface: "plugins", method: "http.request", params: { verb: "GET", path: "/ps/plugins/installed", options: { parameters: { query: { pageToken: "page-2" } } } } },
    { surface: "plugins", method: "http.request", params: { verb: "GET", path: "/ps/plugins/{plugin_id}", options: { parameters: { path: { plugin_id: "plugin-1" } } } } },
    { surface: "plugins", method: "http.request", params: { verb: "POST", path: "/ps/plugins/{plugin_id}/install", options: { parameters: { path: { plugin_id: "plugin-1" }, query: { includeAppsNeedingAuth: true } }, requestBody: { install_attempt_id: "attempt-1" } } } },
    { surface: "plugins", method: "http.request", params: { verb: "POST", path: "/ps/plugins/{plugin_id}/uninstall", options: { parameters: { path: { plugin_id: "plugin-1" } } } } },
    { surface: "plugins", method: "http.request", params: { verb: "POST", path: "/ps/plugins/{plugin_id}/enable", options: { parameters: { path: { plugin_id: "plugin-1" } } } } },
    { surface: "plugins", method: "http.request", params: { verb: "POST", path: "/ps/plugins/{plugin_id}/disable", options: { parameters: { path: { plugin_id: "plugin-1" } } } } },
    { surface: "plugins", method: "http.request", params: { verb: "POST", path: "/apps/availability", options: { parameters: { query: { locale: "en-US", platform: "chat" } }, requestBody: { app_ids: ["app-1"] } } } },
    { surface: "plugins", method: "http.request", params: { verb: "POST", path: "/apps/content", options: { parameters: { query: { detail: "full", locale: "en-US", platform: "chat" } }, requestBody: { app_ids: ["app-1"] } } } },
    { surface: "plugins", method: "http.request", params: { verb: "POST", path: "/apps/workspace/content", options: { parameters: { query: { detail: "full", locale: "en-US", platform: "chat" } }, requestBody: { app_ids: ["app-1"] } } } },
    { surface: "apps", method: "app/read", params: { appIds: ["app-one", "app-two"], includeTools: true } },
    { surface: "apps", method: "app/installed", params: { forceRefresh: true } },
    { surface: "plugins", method: "plugin/list", params: { cwds: [], marketplaceKinds: ["vertical"], forceRefetch: false } },
    { surface: "plugins", method: "plugin/read", params: { remoteMarketplaceName: "official", pluginName: "fixture" } },
    { surface: "plugins", method: "plugin/install", params: { marketplacePath: "/fixture/marketplace", pluginName: "fixture", installAttemptId: "attempt-1" } },
    { surface: "plugins", method: "plugin/uninstall", params: { pluginId: "fixture@official" } },
    { surface: "mcp", method: "mcpServerStatus/list", params: { cursor: null, detail: "toolsAndAuthOnly", limit: 100, threadId: "thread-1" } },
    { surface: "mcp", method: "mcpServer/oauth/login", params: { name: "fixture", threadId: "thread-1", scopes: ["read", "write"] } },
  ];
  for (const [index, item] of reviewed.entries()) {
    const result = await adapter.invoke({ version: 1, action: "broker", requestId: `reviewed-${index}`, command: "native.request",
      params: { accountId, ...item } });
    assert.equal(result.ok, true, `${item.method} accepts its reviewed native call shape`);
  }
  const oldAppRead = await adapter.invoke({ version: 1, action: "broker", requestId: "old-app-read", command: "native.request",
    params: { accountId, surface: "apps", method: "app/read", params: { id: "legacy-wrong-shape" } } });
  assert.equal(oldAppRead.ok, false);
  const ambiguousMarketplace = await adapter.invoke({ version: 1, action: "broker", requestId: "ambiguous-marketplace", command: "native.request",
    params: { accountId, surface: "plugins", method: "plugin/install", params: { marketplacePath: "/one", remoteMarketplaceName: "two", pluginName: "fixture", installAttemptId: "attempt-2" } } });
  assert.equal(ambiguousMarketplace.ok, false);
  const crossSurfaceConfig = await adapter.invoke({ version: 1, action: "broker", requestId: "cross-surface-config", command: "native.request",
    params: { accountId, surface: "apps", method: "config/value/write", params: { keyPath: "plugins.fixture.enabled", value: true, mergeStrategy: "upsert", filePath: null, expectedVersion: null } } });
  assert.equal(crossSurfaceConfig.ok, false);
  const unsafeConfigPath = await adapter.invoke({ version: 1, action: "broker", requestId: "unsafe-config-path", command: "native.request",
    params: { accountId, surface: "plugins", method: "config/batchWrite", params: { edits: [{ keyPath: "plugins.fixture.enabled", value: true, mergeStrategy: "upsert" }], filePath: "bad\npath", expectedVersion: null } } });
  assert.equal(unsafeConfigPath.ok, false);
  const rendererHttpFields = await adapter.invoke({ version: 1, action: "broker", requestId: "renderer-http-fields", command: "native.request",
    params: { accountId, surface: "plugins", method: "http.request", params: { verb: "GET", path: "/ps/plugins/installed", options: { parameters: { query: {} }, additionalHeaders: { authorization: "forged" }, signal: "forged" } } } });
  assert.equal(rendererHttpFields.ok, false);
  const wrongHttpSurface = await adapter.invoke({
    version: 1, action: "broker", requestId: "wrong-http-surface", command: "native.request",
    params: {
      accountId, surface: "apps", method: "http.request",
      params: { verb: "POST", path: "/apps/availability", options: {
        parameters: { query: { locale: "en-US", platform: "chat" } }, requestBody: { app_ids: ["app-1"] },
      } },
    },
  });
  assert.equal(wrongHttpSurface.ok, false);
  const unknownHttpPath = await adapter.invoke({ version: 1, action: "broker", requestId: "unknown-http-path", command: "native.request",
    params: { accountId, surface: "apps", method: "http.request", params: { verb: "GET", path: "/backend-api/arbitrary", options: {} } } });
  assert.equal(unknownHttpPath.ok, false);
  const rejected = await adapter.invoke({ version: 1, action: "broker", requestId: "native-forged", command: "native.request",
    params: { accountId, surface: "profile", method: "account/logout", params: {} } });
  assert.equal(rejected.ok, false);
});

test("main-only browser translation and child RPC remain bound to the selected public account", async () => {
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret });
  assert.equal(broker.handshake(handshake()).ok, true);
  const requests: unknown[] = [];
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client: {
    invoke: (envelope) => broker.invoke(renderer, envelope),
    subscribe: (handler) => broker.subscribe(renderer, handler),
    resolveNativeBrowserContext: async (opaqueAccountId) => ({ version: 1, status: "ready", opaqueAccountId,
      codexHome: "/private/fixture", configFile: "/private/fixture/config.toml", appServerVersion: "0.153.4" }),
    invokeNativeBrowserRequest: async (opaqueAccountId, method, params) => {
      requests.push({ opaqueAccountId, method, params });
      return { data: [] };
    },
  } });
  const profile = await adapter.invoke({ version: 1, action: "broker", requestId: "browser-profile", command: "profile.read" });
  const accountId = profile.ok ? (profile.result as { selectedAccountId: string }).selectedAccountId : "";
  assert.deepEqual(adapter.translateNativeBrowserRequest({ accountId, method: "browser.install",
    params: { hostId: "local", marketplacePath: "/fixture/marketplace", pluginName: "fixture" } }), {
    opaqueAccountId: account, method: "browser.install", params: { hostId: "local", marketplacePath: "/fixture/marketplace", pluginName: "fixture" },
  });
  assert.equal(adapter.translateNativeBrowserRequest({ accountId, method: "browser.install",
    params: { hostId: "remote", marketplacePath: null, pluginName: "fixture" } }), null);
  assert.deepEqual(await adapter.resolveNativeBrowserContext(accountId), { version: 1, status: "ready", opaqueAccountId: account,
    codexHome: "/private/fixture", configFile: "/private/fixture/config.toml", appServerVersion: "0.153.4" });
  assert.deepEqual(await adapter.invokeNativeBrowserRequest(accountId, "plugin/list", { marketplaceKinds: ["local"] }), { data: [] });
  assert.equal(await adapter.invokeNativeBrowserRequest(accountId, "plugin/list", { marketplaceKinds: ["remote"] }), null);
  assert.deepEqual(requests, [{ opaqueAccountId: account, method: "plugin/list", params: { marketplaceKinds: ["local"] } }]);
  const publicBypass = await adapter.invoke({ version: 1, action: "broker", requestId: "browser-bypass", command: "native.request",
    params: { accountId, surface: "plugins", method: "browser.sync", params: {} } });
  assert.equal(publicBypass.ok, false);
});

test("native catalog and configuration metadata round-trip without control-only redaction", async () => {
  let nativeResult: unknown;
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: account, enabled: true }], secret,
    onDeviceAction: (action) => action.kind === "native.request"
      ? { outcome: "accepted", value: nativeResult } : { outcome: "rejected" },
  });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client: {
    invoke: (envelope) => broker.invoke(renderer, envelope), subscribe: (handler) => broker.subscribe(renderer, handler),
  } });
  const accountId = adapter.accountId(account);
  const catalog = {
    marketplaces: [{ name: "local-plugins", path: "/plugins/marketplaces/local-plugins", plugins: [{
      id: "example@local-plugins", name: "example", interface: {
        displayName: "Email @ Example", longDescription: "Contact support@example.test for authorization setup.",
        defaultPrompt: ["Explain the bearer authorization header"],
      },
    }] }],
    featuredPluginIds: ["example@local-plugins"], marketplaceLoadErrors: [],
  };
  for (const [method, params, value] of [
    ["plugin/list", {}, catalog],
    ["config/read", { cwd: null, includeLayers: false }, { config: { plugins: { "example@local-plugins": { enabled: true } } } }],
    ["plugin/read", { pluginName: "example", marketplacePath: "/plugins/marketplaces/local-plugins" },
      { plugin: { ...catalog.marketplaces[0].plugins[0], inputSchema: { properties: { authorization: { description: "Provider authorization configuration" } } } } }],
  ] as const) {
    nativeResult = value;
    const response = await adapter.invoke({ version: 1, action: "broker", requestId: `metadata-${method.replace("/", "-")}`, command: "native.request",
      params: { accountId, surface: "plugins", method, params } });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.deepEqual(response.ok && response.result, { accountId, surface: "plugins", result: value });
  }
});

test("native response exceptions retain account, surface, size and control-redaction boundaries", async () => {
  const foreign = `ar_${"z".repeat(43)}` as OpaqueAccountId;
  let responseResult: unknown;
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret });
  assert.equal(broker.handshake(handshake()).ok, true);
  const client = {
    invoke: async (envelope: Parameters<AccountsBrokerV1["invoke"]>[1]) => envelope.command === "native.request"
      ? { version: 1 as const, requestId: envelope.requestId, ok: true as const, result: responseResult }
      : broker.invoke(renderer, envelope),
    subscribe: (handler: Parameters<AccountsBrokerV1["subscribe"]>[1]) => broker.subscribe(renderer, handler),
  };
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client });
  const accountId = adapter.accountId(account);
  const invokeNative = (selected = accountId) => adapter.invoke({ version: 1, action: "broker", requestId: "native-boundary", command: "native.request",
    params: { accountId: selected, surface: "plugins", method: "plugin/list", params: {} } });
  for (const value of [
    { opaqueAccountId: foreign, surface: "plugins", result: {} },
    { opaqueAccountId: account, surface: "apps", result: {} },
    { opaqueAccountId: account, surface: "plugins" },
    { opaqueAccountId: account, surface: "plugins", result: "x".repeat(NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES) },
  ]) {
    responseResult = value;
    const response = await invokeNative();
    assert.deepEqual(response, { version: 1, requestId: "native-boundary", ok: false, error: { code: "broker_unavailable", retryable: true } });
  }
  const foreignPublicId = new AccountsBrokerRendererAdapterV1({ secret, client }).accountId(foreign);
  const forged = await invokeNative(foreignPublicId);
  assert.equal(forged.ok, false);
  assert.equal(!forged.ok && forged.error.code, "invalid_request", "mismatched responses must not register a new account");
  for (const label of ["Bearer fixture-value", account, "unmasked@example.test"]) {
    adapter.rememberLabel(account, label);
    const response = await adapter.invoke({ version: 1, action: "broker", requestId: "control-boundary", command: "profile.read" });
    assert.equal(response.ok, false, "native data exception must not exempt control response labels");
  }
});

test("renderer adapter emits only approved dotted lifecycle events and redacted envelopes", async () => {
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({
    secret,
    client: {
      invoke: (envelope) => broker.invoke(renderer, envelope),
      subscribe: (handler) => broker.subscribe(renderer, handler),
    },
  });
  // Populate opaque-to-public account mapping before an event arrives.
  await adapter.invoke({ version: 1, action: "broker", requestId: "profile", command: "profile.read" });
  const events: unknown[] = [];
  const unsubscribe = adapter.subscribe((event) => events.push(event));
  assert.equal(broker.updateQuota({
    opaqueAccountId: account,
    freshness: "fresh",
    remainingPercent: 75,
    resetAt: "2026-09-03T00:00:00.000Z",
    shortWindowPressure: 20,
    resetCredits: 1,
  }), true);
  unsubscribe();
  assert.equal(events.length, 1);
  assert.deepEqual((events[0] as { type: string }).type, "quota.updated");
  assert.doesNotMatch(JSON.stringify(events), /\b(?:ar|br|bat|bd|bt|bh)_/);
  assert.doesNotMatch(JSON.stringify(events), /secret|auth\.json|cookie|token/i);
});

test("renderer adapter reports provider-unavailable plugin state without offering cross-surface authorization", async () => {
  const definition = `bd_${"u".repeat(43)}` as OpaqueConnectionDefinitionRef;
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: account, enabled: true }],
    secret,
    onDeviceAction(action) {
      if (action.kind === "profile.read") return { outcome: "accepted", value: { identifierMasked: null, plan: null, avatarUrl: null } };
      if (action.kind === "connection.list") return { outcome: "accepted", value: [{ definitionRef: definition, status: "unavailable" }] };
      return { outcome: "rejected" };
    },
  });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({
    secret,
    client: {
      invoke: (envelope) => broker.invoke(renderer, envelope),
      subscribe: (handler) => broker.subscribe(renderer, handler),
    },
  });
  const profile = await adapter.invoke({ version: 1, action: "broker", requestId: "unavailable_profile", command: "profile.read" });
  const accountId = profile.ok ? (profile.result as { selectedAccountId: string }).selectedAccountId : null;
  assert.ok(accountId);
  const response = await adapter.invoke({
    version: 1,
    action: "broker",
    requestId: "unavailable_plugin",
    command: "connection.list",
    params: { accountId, surface: "plugins" },
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  const connection = response.ok
    ? (response.result as { connections: Array<{ status: string; authorizationAvailable: boolean }> }).connections[0]
    : null;
  assert.deepEqual(connection && { status: connection.status, authorizationAvailable: connection.authorizationAvailable }, {
    status: "unavailable",
    authorizationAvailable: false,
  });
});

test("connection read results do not synthesize changes and authoritative last-row removal reaches the renderer", async () => {
  const definition = `bd_${"n".repeat(43)}` as OpaqueConnectionDefinitionRef;
  let now = 1_000;
  let rows = [{ definitionRef: definition, status: "connected" }];
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret, now: () => now,
    onDeviceAction: () => ({ outcome: "accepted", value: rows }),
  });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client: {
    invoke: (envelope) => broker.invoke(renderer, envelope), subscribe: (handler) => broker.subscribe(renderer, handler),
  } });
  const profile = await adapter.invoke({ version: 1, action: "broker", requestId: "connection-profile", command: "profile.read" });
  const accountId = profile.ok ? (profile.result as { selectedAccountId: string }).selectedAccountId : null;
  assert.ok(accountId);
  let nonce = 0;
  const list = () => adapter.invoke({ version: 1, action: "broker", requestId: `connection-list-${++nonce}`, command: "connection.list", params: { accountId, surface: "plugins" } });
  // Read-before-subscribe still records the scope needed to report its later removal.
  const first = await list();
  assert.equal(first.ok, true);
  const connectionId = first.ok ? (first.result as { connections: Array<{ connectionId: string }> }).connections[0]!.connectionId : null;
  const events: Array<{ type: string; payload: unknown }> = [];
  const stop = adapter.subscribe((event) => events.push(event));
  now = 2_000; assert.equal((await list()).ok, true);
  const status = await adapter.invoke({ version: 1, action: "broker", requestId: "connection-status", command: "connection.status", params: { accountId, surface: "plugins", connectionId } });
  assert.equal(status.ok, true);
  assert.equal(events.length, 0, "a direct read response is not a change notification");
  rows = [{ definitionRef: definition, status: "blocked" }]; await list();
  assert.equal(events.length, 1, "one authoritative change must not be duplicated by a synthetic command event");
  assert.equal(events[0]?.type, "connection.updated");
  rows = []; await list();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1]?.payload, { accountId, connections: [] });
  await list();
  assert.equal(events.length, 2);
  assert.doesNotMatch(JSON.stringify(events), /\b(?:ar|br|bat|bd|bt|bh)_|oauthUrl/);
  stop();
});

test("MCP OAuth handoff is never emitted through the renderer event stream", async () => {
  const definition = `bd_${"m".repeat(43)}` as OpaqueConnectionDefinitionRef;
  const oauthUrl = "https://provider.example.test/oauth/start";
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: account, enabled: true }],
    secret,
    onDeviceAction(action) {
      if (action.kind === "connection.list") return { outcome: "accepted", value: [{ definitionRef: definition, status: "unknown" }] };
      if (action.kind === "connection.authorize") return { outcome: "accepted", value: { oauthUrl } };
      return { outcome: "rejected" };
    },
  });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({
    secret,
    client: {
      invoke: (envelope) => broker.invoke(renderer, envelope),
      subscribe: (handler) => broker.subscribe(renderer, handler),
    },
  });
  const profile = await adapter.invoke({ version: 1, action: "broker", requestId: "oauth-profile", command: "profile.read" });
  const accountId = profile.ok ? (profile.result as { selectedAccountId: string }).selectedAccountId : null;
  assert.ok(accountId);
  const listed = await adapter.invoke({
    version: 1, action: "broker", requestId: "oauth-list", command: "connection.list", params: { accountId, surface: "mcp" },
  });
  const connectionId = listed.ok ? (listed.result as { connections: Array<{ connectionId: string }> }).connections[0]?.connectionId : null;
  assert.ok(connectionId, JSON.stringify(listed));
  const events: unknown[] = [];
  const unsubscribe = adapter.subscribe((event) => events.push(event));
  const authorized = await adapter.invoke({
    version: 1,
    action: "broker",
    requestId: "oauth-authorize",
    command: "connection.authorize",
    params: { accountId, connectionId, surface: "mcp" },
  });
  unsubscribe();
  assert.equal(authorized.ok, true, JSON.stringify(authorized));
  assert.equal(authorized.ok ? (authorized.result as { oauthUrl: string }).oauthUrl : null, oauthUrl, "main owns consuming this adapter-validated handoff");
  assert.equal(events.length, 1, "only the broker's URL-free connection state event may be published");
  assert.doesNotMatch(JSON.stringify(events), /oauth\/start|provider\.example\.test|oauthUrl/);
});

test("renderer quota depletion expires at a known short-window reset", async () => {
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client: {
    invoke: (envelope) => broker.invoke(renderer, envelope),
    subscribe: (handler) => broker.subscribe(renderer, handler),
  } });
  await adapter.invoke({ version: 1, action: "broker", requestId: "profile-reset", command: "profile.read" });
  const events: Array<{ payload: { quota: { depleted: boolean } } }> = [];
  const unsubscribe = adapter.subscribe((event) => events.push(event as typeof events[number]));
  for (const shortWindowResetAt of [Date.now() + 60_000, 1, null]) {
    assert.equal(broker.updateQuota({ opaqueAccountId: account, freshness: "fresh", remainingPercent: 75,
      resetAt: "2099-01-01T00:00:00.000Z", shortWindowPressure: 100, shortWindowResetAt, resetCredits: null }), true);
  }
  unsubscribe();
  assert.deepEqual(events.map((event) => event.payload.quota.depleted), [true, false, true]);
});

test("Accounts preferences cross the authenticated adapter with exact defaults and patch validation", async () => {
  let preferences = { failoverMode: "automatic" as "automatic" | "ask", unifiedCatalogEnabled: false };
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: account, enabled: true }], secret,
    onPreferencesRead: () => ({ ...preferences }),
    onPreferencesUpdate: (patch) => (preferences = { ...preferences, ...patch }),
  });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client: {
    invoke: (envelope) => broker.invoke(renderer, envelope), subscribe: (handler) => broker.subscribe(renderer, handler),
  } });
  const invoke = (command: string, params = {}) => adapter.invoke({ version: 1, action: "broker", requestId: `pref-${Math.random().toString(36).slice(2)}`, command, params });
  const initial = await invoke("preferences.read");
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.ok && initial.result, { failoverMode: "automatic", unifiedCatalogEnabled: false });
  const updated = await invoke("preferences.update", { failoverMode: "ask", unifiedCatalogEnabled: true });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.ok && updated.result, { failoverMode: "ask", unifiedCatalogEnabled: true });
  for (const invalid of [{}, { failoverMode: "sometimes" }, { unifiedCatalogEnabled: "true" }, { failoverMode: "automatic", extra: true }]) {
    const result = await invoke("preferences.update", invalid);
    assert.equal(result.ok, false);
  }
  assert.deepEqual(preferences, { failoverMode: "ask", unifiedCatalogEnabled: true });
});

test("copy-email reveals only the explicitly requested account and never emits identity in events", async () => {
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret,
    onDeviceAction: (action) => action.kind === "profile.email" ? { outcome: "accepted", value: "example@example.test" } : { outcome: "rejected" },
  });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client: {
    invoke: (envelope) => broker.invoke(renderer, envelope), subscribe: (handler) => broker.subscribe(renderer, handler),
  } });
  const profile = await adapter.invoke({ version: 1, action: "broker", requestId: "email-profile", command: "profile.read" });
  assert.equal(profile.ok, true);
  const accountId = (profile.ok && (profile.result as { selectedAccountId: string }).selectedAccountId) as string;
  const events: unknown[] = [];
  const stop = adapter.subscribe((event) => events.push(event));
  const copied = await adapter.invoke({ version: 1, action: "broker", requestId: "email-copy", command: "profile.email", params: { accountId } });
  assert.equal(copied.ok, true);
  assert.deepEqual(copied.ok && copied.result, { accountId, email: "example@example.test" });
  assert.doesNotMatch(JSON.stringify(events), /example@example\.test/);
  const unknown = await adapter.invoke({ version: 1, action: "broker", requestId: "email-unknown", command: "profile.email", params: { accountId: `account_${"x".repeat(43)}` } });
  assert.equal(unknown.ok, false);
  stop();
});


test("two saved subscriptions use masked identities without changing account handles", async () => {
  const second = `ar_${"s".repeat(43)}` as OpaqueAccountId;
  const broker = new AccountsBrokerV1({
    secret,
    accounts: [
      { opaqueAccountId: account, label: "account-2", enabled: true, safeProfile: { identifierMasked: "c*****@example.test", avatarUrl: null, plan: "pro" } },
      { opaqueAccountId: second, label: "account-3", enabled: true, safeProfile: { identifierMasked: "a*****@example.test", avatarUrl: null, plan: "pro" } },
    ],
  });
  assert.equal(broker.handshake(handshake()).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, rendererRef: renderer, client: {
    invoke: (envelope) => broker.invoke(renderer, envelope),
    subscribe: (handler) => broker.subscribe(renderer, handler),
  } });
  const response = await adapter.invoke({ version: 1, action: "broker", requestId: "two-identities", command: "profile.read" });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const rows = (response.result as { accounts: Array<{ accountId: string; label: string; email: string }> }).accounts;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.label), ["c*****@example.test", "a*****@example.test"]);
  assert.deepEqual(rows.map((row) => row.label), rows.map((row) => row.email));
  assert.equal(rows[0].accountId, adapter.accountId(account));
  assert.equal(rows[1].accountId, adapter.accountId(second));
  assert.doesNotMatch(JSON.stringify(response), /account-2|account-3|\bar_/);
  const again = await adapter.invoke({ version: 1, action: "broker", requestId: "two-identities-again", command: "profile.read" });
  assert.deepEqual(again.ok ? again.result : null, response.result);
});
