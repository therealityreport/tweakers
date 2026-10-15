import { createHmac } from "node:crypto";
import { AccountsBrokerOwnerV1, isolatedAuthHelperArgs } from "../../src/account-router/broker-host";
import { nativeHistoryAuthIdentityHmacV1 } from "../../src/account-router/native-history";
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { officialBundledAccountPlanV1, officialPluginLedgerRootV1, officialFollowNativePluginMutationV1, officialOwnedConfigMutationAllowedV1, officialPluginInventoryFromResponseV1, officialSharedPluginResponseV1, officialCanonicalPluginResponseV1, officialThreadPluginConfigAllowedV1, officialThreadPluginParamsV1, type OfficialPluginInventoryV1 } from "../../src/account-router/official-bundled-adapter";
import { officialLocalPluginIdV1, parseLosslessTomlDocument, projectOfficialPluginPackagesV1, readOfficialInstalledPluginSnapshotV1 } from "../../src/account-router/account-continuity";
import type { OpaqueAccountId } from "../../src/account-router/types";
import { captureDesktopAppToolsContext } from "../../src/account-router/desktop-app-tools";
import { attestNativeDesktopConfigV1, NATIVE_DESKTOP_CONFIG_PROOF_V1 } from "../../src/account-router/native-desktop-config";

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stock-plugin-adapter-")));
  chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), stateRoot = join(root, "state"), account = `ar_${"a".repeat(43)}` as OpaqueAccountId;
  const home = join(stateRoot, "accounts", account, "execution-home");
  mkdirSync(source, { recursive: true, mode: 0o700 }); mkdirSync(home, { recursive: true, mode: 0o700 });
  const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }); };
  write(join(source, "config.toml"), '[plugins."shared@test"]\nenabled=true\n[plugins."disabled@test"]\nenabled=false\n[mcp_servers.remote]\nurl="https://remote.test/mcp"\nhttp_headers={Authorization="Bearer private-source-token"}\n');
  write(join(home, "config.toml"), '# preserve selected settings\n[plugins."shared@test"]\nenabled=false\n');
  for (const name of ["shared", "disabled"]) write(join(source, "plugins", "cache", "test", name, "1.0.0", ".codex-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
  write(join(source, "plugins", "cache", "test", "shared", "1.0.0", ".mcp.json"), JSON.stringify({ mcpServers: { remotePlugin: { url: "https://plugin.test/mcp" }, localTool: { command: "tool" } } }));
  const inventory: OfficialPluginInventoryV1 = { schema_version: 1, native_base_root: source, plugins: [{ id: "disabled@test", enabled: false, version: "1.0.0" }, { id: "shared@test", enabled: true, version: "1.0.0" }] };
  return { source, home, inventory, write, stateRoot, account };
}

test("stock inventory includes disabled definitions from every marketplace without remote IDs or credentials", () => {
  const inventory = officialPluginInventoryFromResponseV1({ marketplaces: [{ name: "test", plugins: [
    { id: "disabled@test", installed: true, enabled: false, version: "1.0.0", remotePluginId: "private-provider-id" },
    { id: "other@test", installed: false, enabled: true, version: null },
  ] }], marketplaceLoadErrors: [] }, "/source");
  assert.deepEqual(inventory?.plugins, [{ id: "disabled@test", enabled: false, version: "1.0.0" }]);
  assert.equal(officialPluginInventoryFromResponseV1({ marketplaces: [], marketplaceLoadErrors: [{}] }, "/source"), null);
});

test("backend registration updates select disjoint signed library custody without changing account projections", () => {
  const old = officialPluginLedgerRootV1("/owned-overlay", `sha256:${"a".repeat(64)}`), next = officialPluginLedgerRootV1("/owned-overlay", `sha256:${"b".repeat(64)}`);
  assert.notEqual(old, next); assert.equal(old, `/owned-overlay/shared-plugin-library/${"a".repeat(64)}`);
  assert.throws(() => officialPluginLedgerRootV1("/owned-overlay", "../escape"), /registration generation/);
});

test("one shared list retains selected account enablement and defaults only an unset new HTTP store", t => {
  const f = fixture(t), before = readFileSync(join(f.home, "config.toml")), sourceBefore = readFileSync(join(f.source, "config.toml"));
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory, args: ["app-server"] });
  assert.equal(plan.oauthIsolation, "file");
  assert.ok(plan.args.includes('mcp_oauth_credentials_store="file"'));
  assert.equal(plan.args.join(" ").includes("private-source-token"), false);
  assert.equal(plan.threadConfig['plugins."shared@test".enabled'], false);
  const response = officialSharedPluginResponseV1(f.inventory, plan) as any;
  assert.deepEqual(response.marketplaces[0].plugins.map((p: any) => [p.id, p.enabled]), [["disabled@test", false], ["shared@test", false]]);
  assert.deepEqual(readFileSync(join(f.home, "config.toml")), before);
  assert.deepEqual(readFileSync(join(f.source, "config.toml")), sourceBefore);
});

test("explicit global MCP storage suppresses shared HTTP before backend startup and preserves stdio/settings/auth", t => {
  const f = fixture(t);
  f.write(join(f.home, "config.toml"), 'mcp_oauth_credentials_store="keyring"\n[plugins."shared@test"]\nenabled=true\n');
  f.write(join(f.home, ".credentials.json"), "account-local-auth-preserved");
  const before = readFileSync(join(f.home, "config.toml"));
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory, args: ["app-server"] });
  assert.equal(plan.oauthIsolation, "blocked");
  assert.ok(plan.args.includes('plugins."shared@test".mcp_servers."remotePlugin".enabled=false'));
  assert.equal(plan.threadConfig['plugins."shared@test".mcp_servers."remotePlugin".enabled'], false);
  assert.equal(plan.threadConfig['plugins."shared@test".mcp_servers."localTool".enabled'], undefined);
  assert.equal(plan.args.some(arg => arg.startsWith("mcp_oauth_credentials_store=")), false);
  assert.deepEqual(readFileSync(join(f.home, "config.toml")), before);
  assert.equal(readFileSync(join(f.home, ".credentials.json"), "utf8"), "account-local-auth-preserved");
});

test("owned execution defaults to file; explicit file and quoted CLI enablement remain usable", t => {
  const f = fixture(t);
  f.write(join(f.home, "config.toml"), '[mcp_servers.existing]\nurl="https://account.test/mcp"\n');
  assert.equal(officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory, args: ["app-server"] }).oauthIsolation, "file");
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory,
    args: ["-c", 'mcp_oauth_credentials_store="file"', "-c", 'plugins."shared@test".enabled=false', "app-server"] });
  assert.equal(plan.oauthIsolation, "file");
  assert.equal(plan.threadConfig['plugins."shared@test".enabled'], false);
  assert.equal(plan.args.some(arg => arg.endsWith("remotePlugin\".enabled=false")), false);
});

test("native source home cannot be selected for stock execution", t => {
  const f = fixture(t), args = ["app-server"];
  assert.throws(() => officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.source, inventory: f.inventory, args }), /signed Tweakers-owned execution-home/);
});

test("target-owned package projection includes disabled packages, excludes auth containers, and rejects secret-bearing MCP definitions", t => {
  const f = fixture(t), packageRoot = join(f.source, "plugins", "cache", "test", "shared", "1.0.0");
  f.write(join(packageRoot, "auth.json"), "native-auth-must-stay");
  const input = { stateRoot: f.stateRoot, sourceHome: f.source, account: { opaqueAccountId: f.account, codexHome: f.home }, plugins: f.inventory.plugins,
    writeEvidence: { accountChildAbsent: true as const, nativeWriterCensus: () => "zero" as const } };
  const nativeInode = lstatSync(join(packageRoot, "auth.json")).ino;
  assert.equal(projectOfficialPluginPackagesV1(input), true);
  assert.equal(existsSync(join(f.home, "plugins", "cache", "test", "disabled", "1.0.0", ".codex-plugin", "plugin.json")), true);
  assert.equal(existsSync(join(f.home, "plugins", "cache", "test", "shared", "1.0.0", "auth.json")), false);
  assert.equal(lstatSync(join(packageRoot, "auth.json")).ino, nativeInode);
  f.write(join(packageRoot, ".mcp.json"), JSON.stringify({ mcpServers: { remotePlugin: { url: "https://plugin.test/mcp", headers: { Authorization: "Bearer source-secret" } } } }));
  assert.throws(() => projectOfficialPluginPackagesV1(input), /authorization/);
  assert.throws(() => projectOfficialPluginPackagesV1({ ...input, account: { opaqueAccountId: f.account, codexHome: f.source } }), /owned/);
});

test("stock package custody tolerates regular Finder metadata beside its single version", t => {
  const f = fixture(t);
  const input = { stateRoot: f.stateRoot, sourceHome: f.source, account: { opaqueAccountId: f.account, codexHome: f.home }, plugins: f.inventory.plugins,
    writeEvidence: { accountChildAbsent: true as const, nativeWriterCensus: () => "zero" as const } };
  projectOfficialPluginPackagesV1(input);
  const parent = join(f.home, "plugins/cache/test/shared"), metadata = join(parent, ".DS_Store");
  f.write(metadata, "Finder metadata");
  const inode = lstatSync(metadata).ino;
  assert.equal(projectOfficialPluginPackagesV1(input), true);
  assert.equal(lstatSync(metadata).ino, inode);
  f.write(join(f.source, "plugins/cache/test/shared/1.0.0/SKILL.md"), "updated definition");
  assert.equal(projectOfficialPluginPackagesV1(input), true);
  assert.equal(readFileSync(join(parent, "1.0.0/SKILL.md"), "utf8"), "updated definition");
});

for (const kind of ["unknown-file", "extra-version", "metadata-directory", "metadata-symlink"] as const) {
  test(`stock package custody rejects ${kind} beside its version`, t => {
    const f = fixture(t);
    const input = { stateRoot: f.stateRoot, sourceHome: f.source, account: { opaqueAccountId: f.account, codexHome: f.home }, plugins: f.inventory.plugins,
      writeEvidence: { accountChildAbsent: true as const, nativeWriterCensus: () => "zero" as const } };
    projectOfficialPluginPackagesV1(input);
    const parent = join(f.home, "plugins/cache/test/shared");
    if (kind === "unknown-file") f.write(join(parent, "unexpected"), "unowned");
    else if (kind === "metadata-symlink") symlinkSync(join(parent, "1.0.0"), join(parent, ".DS_Store"));
    else mkdirSync(join(parent, kind === "extra-version" ? "2.0.0" : ".DS_Store"), { mode: 0o700 });
    assert.throws(() => projectOfficialPluginPackagesV1(input), /modified or unowned/);
  });
}

test("a secret-bearing shared plugin is visible but independently unavailable in the owned account", t => {
  const f = fixture(t), packageRoot = join(f.source, "plugins", "cache", "test", "shared", "1.0.0");
  f.write(join(packageRoot, ".mcp.json"), JSON.stringify({ mcpServers: { remotePlugin: { url: "https://plugin.test/mcp", headers: { Authorization: "Bearer account-A-token" } } } }));
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory, args: ["app-server"] });
  assert.equal(plan.threadConfig['plugins."shared@test".enabled'], false);
  assert.match(plan.withheldPlugins["shared@test"]!, /unsafe to share/);
  const result = officialSharedPluginResponseV1(f.inventory, plan) as any;
  assert.equal(result.marketplaces[0].plugins.find((row: any) => row.id === "shared@test").status, "unavailable");
  assert.equal(result.marketplaces[0].plugins.find((row: any) => row.id === "disabled@test").status, undefined);
  assert.equal(plan.args.join(" ").includes("account-A-token"), false);
});


test("stock inventory is a read-only signed-source snapshot with no inventory RPC and config-generation fences", async t => {
  const f = fixture(t), secret = Buffer.alloc(32, 22), raw = "stock-source-account";
  const actor = `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`).digest("base64url")}`;
  f.write(join(f.source, "auth.json"), JSON.stringify({ tokens: { account_id: raw } }));
  const nativeBefore = readFileSync(join(f.source, "config.toml"));
  const overlay = join(f.stateRoot, "overlay"); mkdirSync(overlay, { mode: 0o700 });
  const mode = { state: "ready", fingerprint: `sha256:${"a".repeat(64)}`, document: { resolverProtocol: "official-bundled-v1",
    sourceAccountId: actor, nativeBase: { path: f.source, identity: { device: 1, inode: 2, uid: process.getuid?.() ?? 0, mode: 0o40700 } }, overlay: { path: overlay } }, environment: {} };
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  Object.assign(host, { stateRoot: f.stateRoot, closed: false, secret, config: { accounts: [{ opaqueAccountId: actor, included: true }] },
    inventoryFreshUntil: 0, inventoryFreshKey: "", inventoryRefresh: null,
    sharedNativeMode: () => mode, nativeAccountBinding: (account: string) => account === actor ? { opaqueAccountId: actor, codexHome: f.source, authIdentityHmac: nativeHistoryAuthIdentityHmacV1(raw, secret) } : null,
    initializeChild: async () => { throw new Error("source child must not start for an inventory read"); },
    broker: { acquireChild: () => { throw new Error("inventory must not acquire a source child"); } }, reloadSharedNativeChildren: async () => {},
    requestInitializedBrokerChild: async () => { throw new Error("stock plugin inventory RPC is forbidden on the native source"); } });
  assert.equal(await host.ensureNativePluginInventory(), true);
  assert.deepEqual(readFileSync(join(f.source, "config.toml")), nativeBefore);
  const binding = host.nativeInventoryBinding(); assert.ok(host.cachedNativeInventory(binding));
  f.write(join(f.source, "config.toml"), nativeBefore.toString() + "# changed native generation\n");
  assert.equal(host.cachedNativeInventory(host.nativeInventoryBinding()), null);
  assert.equal(await host.ensureNativePluginInventory(true), true);
  mode.document.sourceAccountId = "ar_different-source";
  assert.equal(await host.ensureNativePluginInventory(true), false);
});

test("inline TOML account settings remain explicit and file storage stays isolated", t => {
  const f = fixture(t);
  f.write(join(f.home, "config.toml"), 'mcp_oauth_credentials_store="file"\nplugins={"shared@test"={enabled=false}}\n');
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory, args: ["app-server"] });
  assert.equal(plan.threadConfig['plugins."shared@test".enabled'], false);
  assert.equal(plan.oauthIsolation, "file");
  assert.equal(plan.threadConfig.mcp_oauth_credentials_store, "file");
});


test("read-only source snapshots preserve disabled package definitions and do not copy credential fields", t => {
  const f = fixture(t), configPath = join(f.source, "config.toml"), before = readFileSync(configPath), inode = lstatSync(configPath).ino;
  const snapshot = readOfficialInstalledPluginSnapshotV1(f.source);
  assert.deepEqual(snapshot.plugins, f.inventory.plugins);
  assert.match(snapshot.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(snapshot).includes("private-source-token"), false);
  assert.deepEqual(readFileSync(configPath), before); assert.equal(lstatSync(configPath).ino, inode);
});

test("a stock child without an existing signed execution-home cannot start on the native source home", () => {
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  Object.assign(host, { nativeTransferHeldAccounts: new Set(), children: new Map(), nativeHistory: {},
    nativeAccountBinding: () => ({ codexHome: "/native-source" }),
    officialNativeMode: () => ({ document: { nativeBase: { path: "/native-source" } } }) });
  assert.throws(() => host.createChild("ar_source"), /signed account execution-home is missing or invalid/);
});

test("stock canonical package IDs preserve selected MCP approval policy", t => {
  const f = fixture(t), original = "shared@test", alias = original;
  f.write(join(f.home, "config.toml"), 'mcp_oauth_credentials_store="file"\n[plugins."shared@test"]\nenabled=false\n[plugins."shared@test".mcp_servers.remotePlugin]\ndefault_tools_approval_mode="approve"\ndisabled_tools=["destructive"]\n');
  const before = readFileSync(join(f.home, "config.toml"));
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory, args: ["app-server"] });
  assert.equal(alias, original);
  assert.equal(plan.threadConfig[`plugins.${JSON.stringify(alias)}.enabled`], false);
  assert.ok(plan.args.includes(`plugins.${JSON.stringify(alias)}.mcp_servers.remotePlugin.default_tools_approval_mode="approve"`));
  assert.ok(plan.args.includes(`plugins.${JSON.stringify(alias)}.mcp_servers.remotePlugin.disabled_tools=["destructive"]`));
  const inventory = officialSharedPluginResponseV1(f.inventory, plan) as any;
  assert.equal(inventory.marketplaces[0].plugins.find((plugin: any) => plugin.id === original).enabled, false);
  assert.equal(JSON.stringify(inventory).includes("tweakers-shared-"), false);
  assert.deepEqual(readFileSync(join(f.home, "config.toml")), before);
});

test("native source auto store is not an owned execution preference; explicit owned choices stay intact", t => {
  const f = fixture(t);
  f.write(join(f.source, "config.toml"), 'mcp_oauth_credentials_store="auto"\n[plugins."shared@test"]\nenabled=true\n[mcp_servers.native]\nurl="https://native.test/mcp"\n');
  const before = readFileSync(join(f.source, "config.toml"));
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, settingsHome: f.source, accountHome: f.home, inventory: f.inventory, args: ["app-server"] });
  assert.equal(plan.oauthIsolation, "file"); assert.ok(plan.args.includes('mcp_oauth_credentials_store="file"'));
  f.write(join(f.home, "config.toml"), 'mcp_oauth_credentials_store="auto"\n');
  assert.equal(officialBundledAccountPlanV1({ sourceHome: f.source, settingsHome: f.source, accountHome: f.home, inventory: f.inventory, args: ["app-server"] }).oauthIsolation, "blocked");
  assert.deepEqual(readFileSync(join(f.source, "config.toml")), before);
});

test("follow-native blocks definition/provider writes while keeping genuine reads available", () => {
  for (const method of ["plugin/install", "plugin/uninstall", "marketplace/add", "marketplace/remove", "marketplace/upgrade"]) assert.equal(officialFollowNativePluginMutationV1(method, {}), true);
  assert.equal(officialFollowNativePluginMutationV1("http.request", { verb: "POST", path: "/ps/plugins/real-id/install" }), true);
  assert.equal(officialFollowNativePluginMutationV1("http.request", { verb: "GET", path: "/ps/plugins/recommended" }), false);
  assert.equal(officialFollowNativePluginMutationV1("plugin/read", {}), false);
  const helper = isolatedAuthHelperArgs(["app-server", "-c", "features.plugins=true"], true);
  assert.deepEqual(helper.slice(-6), ["-c", "features.plugins=false", "-c", "features.codex_hooks=false", "-c", "features.hooks=false"]);
});

test("stock policy writes stay in the exact owned execution config and cannot replace service/root authority", () => {
  const home = "/owned/accounts/account/execution-home";
  const allowed = (keyPath: string, filePath: string | null = null) => officialOwnedConfigMutationAllowedV1("config/value/write", { keyPath, filePath, value: keyPath.endsWith("trusted_hash") ? "owned-hash" : false }, home);
  assert.equal(allowed('plugins."shared@test".enabled'), true);
  assert.equal(allowed('hooks.state."shared@test:hooks/hooks.json:stop:0:0".trusted_hash'), true);
  assert.equal(allowed('plugins."shared@test".enabled', `${home}/config.toml`), true);
  assert.equal(allowed('plugins."shared@test".enabled', "/native/config.toml"), false);
  for (const key of ["chatgpt_base_url", "codex_home", "permissions.filesystem", "features.plugins", "marketplaces.test.source", 'plugins."shared@test".source', "bypass_hook_trust", "broken\nchatgpt_base_url"]) assert.equal(allowed(key), false, key);
});

test("native projectless directory preference is writable only as an owned scalar leaf", () => {
  const home = "/owned/accounts/account/execution-home";
  const edit = (keyPath: string, value: unknown) => ({ keyPath, value });
  const allowed = (edits: unknown[], filePath = `${home}/config.toml`) => officialOwnedConfigMutationAllowedV1("config/batchWrite", { edits, filePath }, home);
  for (const key of ["desktop.projectlessWorkspaceRoot", '"desktop"."projectlessWorkspaceRoot"']) {
    for (const value of ["/workspace/documents", null]) {
      assert.equal(allowed([edit(key, value)]), true);
      assert.equal(officialOwnedConfigMutationAllowedV1("config/value/write", edit(key, value), home), true);
    }
    for (const value of [false, 42, {}, ["/workspace/documents"]]) assert.equal(allowed([edit(key, value)]), false);
  }
  assert.equal(allowed([edit("desktop.projectlessWorkspaceRoot", "/workspace/documents")], "/native/config.toml"), false);
  for (const value of [{ projectlessWorkspaceRoot: "/workspace/documents" }, { proxy: "untrusted" }, { credentials: {} }]) assert.equal(allowed([edit("desktop", value)]), false);
  for (const key of ["desktop.projectlessWorkspaceRoot.extra", "desktop.otherRoot", "codex_home", "desktop.ProjectlessWorkspaceRoot"]) {
    assert.equal(allowed([edit(key, "/workspace/documents")]), false);
  }
  assert.equal(allowed([edit("desktop.projectlessWorkspaceRoot", "/workspace/documents"), edit("codex_home", "/native")]), false);
});

test("valid stock execution-home holds admission without a prepared shared library service", () => {
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  Object.assign(host, { nativeTransferHeldAccounts: new Set(), children: new Map(), nativeHistory: {}, officialPluginServices: new Map(),
    nativeAccountBinding: () => ({ codexHome: "/native-source" }),
    officialExecutionHome: () => "/owned-execution-home",
    officialNativeMode: () => ({ document: { nativeBase: { path: "/native-source" } } }) });
  assert.throws(() => host.createChild("ar_source"), /verified shared plugin library or account service is unavailable/);
});

test("multiple CLI policy leaves retain every disabled plugin, feature sibling and approval", t => {
  const f = fixture(t);
  f.write(join(f.source, "config.toml"), '[features]\nplugins=true\nrecommended_plugins=true\n[plugins."shared@test"]\nenabled=true\n[plugins."disabled@test"]\nenabled=true\n');
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, settingsHome: f.source, accountHome: f.home, inventory: { ...f.inventory, plugins: f.inventory.plugins.map(plugin => ({ ...plugin, enabled: true })) }, localLibrary: true,
    args: ["app-server", "-c", 'plugins."shared@test".enabled=false', "-c", 'plugins."disabled@test".enabled=false', "-c", 'plugins."shared@test".mcp_servers.remotePlugin.default_tools_approval_mode="approve"', "-c", "features.shell_snapshot=false", "-c", "features.tool_suggest=false"] });
  assert.equal(plan.sourceEnablement["shared@test"], false); assert.equal(plan.sourceEnablement["disabled@test"], false);
  const rootPlugins = plan.threadConfig.plugins as any;
  assert.equal(rootPlugins[officialLocalPluginIdV1("shared@test")].mcp_servers.remotePlugin.default_tools_approval_mode, "approve");
  const features = parseLosslessTomlDocument(plan.args.findLast(arg => arg.startsWith("features="))! + "\n").tree.features as any;
  assert.equal(features.entries.shell_snapshot.value, false); assert.equal(features.entries.tool_suggest.value, false);
});

test("chat policy and hook trust remain usable while executable definition overrides are denied", t => {
  const f = fixture(t), plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory, localLibrary: true, args: ["app-server"] });
  for (const config of [{ mcp_servers: { injected: { command: "untrusted-tool" } } }, { 'mcp_servers.injected.url': "https://untrusted.test/mcp" },
    { hooks: { sessionStart: [{ command: "untrusted-hook" }] } }, { 'marketplaces.injected.source': "/untrusted" },
    { plugins: { "shared@test": { source: "/untrusted" } } }, { '"marketplaces".injected.source': "/untrusted" },
    { 'plugins.shared@test.mcp_servers.remotePlugin.command': "/untrusted" },
    { 'plugins.shared@test.mcp_servers.remotePlugin.url': "https://untrusted.test/mcp" },
    { 'plugins.shared@test.__proto__.enabled': true }, { 'plugins.shared@test.constructor.enabled': true },
    { 'plugins.shared@test.mcp_servers."__proto__".unique_field': true },
    { 'plugins.shared@test.mcp_servers."\\u005f_proto__".unique_field': true },
    { 'plugins.shared@test.mcp_servers."constructor".unique_field': true },
    { 'plugins.shared@test..enabled': true }]) {
    assert.equal(officialThreadPluginConfigAllowedV1({ config }), false);
    assert.throws(() => officialThreadPluginParamsV1({ config }, plan, f.inventory, f.home), /follows native Codex/);
  }
  const input = { config: { plugins: { "shared@test": { enabled: false, mcp_servers: { remotePlugin: { default_tools_approval_mode: "approve", disabled_tools: ["dangerous"] } } } },
    hooks: { state: { "shared@test:hooks/hooks.json:session_start:0:0": { enabled: false, trusted_hash: "owned-hash" } } } } };
  assert.equal(officialThreadPluginConfigAllowedV1(input), true);
  const result = officialThreadPluginParamsV1(input, plan, f.inventory, f.home) as any, alias = officialLocalPluginIdV1("shared@test");
  assert.equal(result.config.plugins[alias].enabled, false);
  assert.equal(result.config.plugins[alias].mcp_servers.remotePlugin.default_tools_approval_mode, "approve");
  assert.equal(result.config.hooks.state[`${alias}:hooks/hooks.json:session_start:0:0`].trusted_hash, "owned-hash");
  assert.equal(officialOwnedConfigMutationAllowedV1("config/value/write", { keyPath: 'plugins."shared@test".enabled', value: { source: "/untrusted" } }, f.home), false);
  assert.equal(officialThreadPluginConfigAllowedV1({config: {'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools': ['list_projects']}}), true);
  assert.equal(officialThreadPluginConfigAllowedV1({config: {'plugins."codex-app-tools@openai-bundled".mcp_servers.codex_app.enabled_tools': ['list_projects']}}), true);
});

test("official desktop tools enter only after policy mapping and retain exact current-client custody", t => {
  const f = fixture(t), plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory, localLibrary: true, args: ["app-server"] });
  const context = captureDesktopAppToolsContext("/Applications/Tweakers.app/Contents/Resources", { CODEX_APP_TOOLS_PIPE_PATH: "/private/tmp/fixture.sock" }, () => JSON.stringify({ mcpServers: { codex_app: {
    command: "./launch", args: ["./server.mjs"], cwd: ".", env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_BROWSER_USE_NODE_PATH", "CODEX_ELECTRON_RESOURCES_PATH", "CODEX_CLI_PATH"],
  } } }))!;
  const client = { rendererRef: "fixture", desktopAppTools: context };
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  const secret = Buffer.alloc(32, 7);
  Object.assign(host, { secret, officialNativeMode: () => ({}), officialDesktopConfigs: new WeakMap(), desktopThreadConfigs: new WeakMap(), threadAppToolsBindings: new WeakMap(), clients: new Map([[client.rendererRef, client]]),
    officialAccountPlan: () => ({ plan, inventory: f.inventory }), officialExecutionHome: () => f.home,
    officialPluginServices: new Map([[f.account, { verify: () => true, baseUrl: "https://127.0.0.1:1234/backend-api" }]]) });
  const source = { config: { "mcp_servers.codex_app": { command: "renderer-forged", enabled_tools: ["allowed"] }, 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.default_tools_approval_mode': "prompt", 'plugins."shared@test".enabled': false } };
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const params = host.desktopAppToolsParams(client, source);
    assert.equal(officialThreadPluginConfigAllowedV1(params), true);
    assert.equal(host.officialPluginParams(f.account, method, params), params);
    const result = host.officialThreadParams(f.account, method, params);
    assert.deepEqual(result.config.mcp_servers.codex_app, { ...context.definition, enabled_tools: ["allowed"], default_tools_approval_mode: "prompt" });
    assert.equal(result.config.plugins[officialLocalPluginIdV1("shared@test")].enabled, false);
    const untrusted = host.desktopAppToolsParams(client, { config: { "mcp_servers.other": { command: "untrusted" } } });
    assert.throws(() => host.officialThreadParams(f.account, method, untrusted), /follows native Codex/);
  }
  const pending = host.desktopAppToolsParams(client, source);
  const signed = attestNativeDesktopConfigV1(secret, context, { "mcp_servers.node_repl": { command: "/native/repl", args: [] }, 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled_tools': ["signed-allowed"] });
  const captured = host.desktopAppToolsParams(client, { config: { ...signed, "mcp_servers.node_repl.enabled_tools": ["js"] } });
  const rebound = host.desktopAppToolsParams(client, captured);
  const mapped = host.officialThreadParams(f.account, "thread/resume", rebound);
  assert.equal(mapped.config.mcp_servers.node_repl.command, "/native/repl");
  assert.deepEqual(mapped.config.mcp_servers.codex_app.enabled_tools, ["signed-allowed"]);
  assert.deepEqual(mapped.config.mcp_servers.node_repl.enabled_tools, ["js"]);
  assert.equal(Object.hasOwn(mapped.config, NATIVE_DESKTOP_CONFIG_PROOF_V1), false);
  host.recordThreadAppToolsBinding({}, "thread", client, rebound);
  const handoff = host.desktopThreadParams(client, "thread", { threadId: "thread", path: "/target/projection", excludeTurns: true });
  assert.ok(handoff);
  const resumed = host.officialThreadParams(f.account, "thread/resume", handoff);
  assert.equal(resumed.config.mcp_servers.node_repl.command, "/native/repl");
  assert.deepEqual(resumed.config.mcp_servers.node_repl.enabled_tools, ["js"]);
  const freshHandoff = host.desktopThreadParams(client, "thread", {});
  assert.equal(host.officialThreadParams(f.account, "thread/start", freshHandoff).config.mcp_servers.node_repl.command, "/native/repl");
  assert.equal(host.desktopThreadParams({ ...client }, "thread", {}), null);
  assert.equal(host.desktopThreadParams(client, "unknown", {}), null);
  host.clients.set(client.rendererRef, { ...client });
  assert.throws(() => host.officialThreadParams(f.account, "thread/start", pending), /binding changed/);
  host.clients.set(client.rendererRef, client);
  client.desktopAppTools = { ...context };
  assert.throws(() => host.officialThreadParams(f.account, "thread/start", pending), /binding changed/);
  assert.equal(source.config["mcp_servers.codex_app"].command, "renderer-forged");
});

test("native transfer rejects missing desktop configuration before acquiring or quiescing any child", async () => {
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  let effects = 0;
  const forbidden = () => { effects++; throw new Error("preflight must precede mutations"); };
  Object.assign(host, { nativeTransfer: { prepareSameThreadTransfer: forbidden }, threadByTaskRef: new Map([["task", "thread"]]),
    heldDesktopContinuations: new Map([["handoff", { client: {} }]]), remoteBlocksDesktop: () => false,
    canonicalHistory: { hasActiveTurn: () => false }, store: { ownerOf: () => "source" }, desktopThreadParams: () => null,
    broker: { acquireChild: forbidden, quota: forbidden }, quiesceIdleAccount: forbidden });
  assert.equal(await host.forwardNativeContinuation({ taskRef: "task", handoffRef: "handoff", fromOpaqueAccountId: "source", toOpaqueAccountId: "target", conversationId: "conversation",
    continuation: { jsonrpc: "2.0", id: "request", method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text: "continue" }] } } }), "rejected");
  assert.equal(effects, 0);
});

test("native response retains canonical withheld inventory without remote IDs or executable claims", t => {
  const f = fixture(t);
  f.write(join(f.source, "plugins", "cache", "test", "shared", "1.0.0", ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer fixture-secret" } } } }));
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory: f.inventory, localLibrary: true, args: ["app-server"] });
  const result = officialCanonicalPluginResponseV1({ marketplaces: [{ name: "test", plugins: [] }], marketplaceLoadErrors: [] }, f.inventory, "plugin/installed", plan) as any;
  const row = result.marketplaces[0].plugins.find((row: any) => row.id === "shared@test");
  assert.equal(row.installed, true); assert.equal(row.enabled, false); assert.equal(row.localVersion, null);
  assert.equal(row.remotePluginId, null); assert.equal(row.sharedDefinitionState, "unavailable");
  assert.match(row.interface.shortDescription, /unsafe to share/); assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
});

test("unchanged signed broker generation does not rehydrate source inventory on ordinary reads", async t => {
  const f = fixture(t), mode = { fingerprint: "fixture-mode" }, binding = { mode, key: "fixture-inventory" };
  let preparations = 0;
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  Object.assign(host, { closed: false, inventoryFreshKey: binding.key, inventoryFreshUntil: 0,
    sharedNativeMode: () => ({ state: "ready" }), officialNativeMode: () => mode, nativeInventoryBinding: () => binding,
    cachedNativeInventory: () => f.inventory, officialPluginLedgerModeFingerprint: mode.fingerprint, officialPluginGeneration: { fingerprint: "signed-generation" },
    officialPluginLedger: { verifyGeneration: (fingerprint: string) => fingerprint === "signed-generation" },
    prepareOfficialPluginServices: async () => { preparations++; } });
  assert.equal(await host.ensureNativePluginInventory(), true);
  assert.equal(preparations, 1, "cheap service preparation still admits new or reauthenticated actors");
});
