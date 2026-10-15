import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { officialLocalPluginIdV1, parseLosslessTomlDocument, readOfficialInstalledPluginSnapshotV1, OFFICIAL_PLUGIN_DEFINITION_POLICY_FINGERPRINT_V1 } from "../../src/account-router/account-continuity";
import { officialBundledAccountPlanV1, officialCanonicalPluginResponseV1, officialExecutionPluginParamsV1, officialFollowNativePluginMutationV1, officialSharedPluginResponseV1, officialThreadPluginParamsV1, type OfficialPluginInventoryV1 } from "../../src/account-router/official-bundled-adapter";
import { officialPluginAuthorizationMatchesV1 } from "../../src/account-router/official-plugin-provider-read";
import { hydrateOfficialSharedPluginLedgerV1, officialPluginEffectiveConfigMatchesV1, prepareOfficialPluginAccountServiceV1, type OfficialPluginProviderReadV1, type OfficialPluginServiceSessionV1 } from "../../src/account-router/official-plugin-service-controller";
import { SharedPluginLedgerStoreV1, sharedPluginWithheldReasonV1, type SharedPluginLedgerV1 } from "../../src/account-router/shared-plugin-ledger";
import type { OpaqueAccountId } from "../../src/account-router/types";

function effectiveOverrides(args: readonly string[], home?: string): Record<string, any> {
  const unpack = (node: any): any => {
    if (node && typeof node === "object" && node.type === "inline-table") return unpack(node.entries);
    if (node && typeof node === "object" && "type" in node && "value" in node) return node.value;
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, unpack(value)]));
    return node;
  };
  const effective = home && existsSync(join(home, "config.toml")) ? unpack(parseLosslessTomlDocument(readFileSync(join(home, "config.toml"), "utf8")).tree) : {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "-c" || args[index] === "--config") Object.assign(effective, unpack(parseLosslessTomlDocument(args[++index]! + "\n").tree));
  }
  return effective;
}

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "official-plugin-controller-")));
  chmodSync(root, 0o700);
  const services: Array<Awaited<ReturnType<typeof prepareOfficialPluginAccountServiceV1>>> = [];
  t.after(async () => {
    ledger.close();
    for (const service of services) assert.equal(await service.close(), true);
    const writable = (path: string): void => {
      const stat = lstatSync(path); if (stat.isSymbolicLink()) return;
      chmodSync(path, 0o700);
      if (stat.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name));
    };
    writable(root); rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "native"), stateRoot = join(root, "state");
  const account = `ar_${"a".repeat(43)}` as OpaqueAccountId;
  const home = join(stateRoot, "accounts", account, "execution-home");
  const write = (path: string, bytes: string) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 }); };
  mkdirSync(source, { mode: 0o700 }); mkdirSync(home, { recursive: true, mode: 0o700 });
  const ids = ["shared@openai-curated-remote", "local@local"];
  write(join(source, "config.toml"), ids.map(id => `[plugins."${id}"]\nenabled=false\n`).join("") + '[plugins."missing@openai-curated-remote"]\nenabled=true\n');
  const files = new Map<string, string>([
    ["skills/tool/SKILL.md", "# Native tool\nUse the bundled script.\n"],
    ["skills/tool/scripts/run.sh", "#!/bin/sh\nprintf fixture\n"],
    ["skills/tool/references/details.md", "Complete native reference\n"],
    ["hooks/hooks.json", '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"./hooks/start.sh"}]}]}}\n'],
    ["hooks/start.sh", "#!/bin/sh\nexit 0\n"],
  ]);
  for (const id of ids) {
    const [name, market] = id.split("@"), packageRoot = join(source, "plugins", "cache", market!, name!, "1.0.0");
    write(join(packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
    for (const [path, bytes] of files) write(join(packageRoot, path), bytes);
  }
  let session: OfficialPluginServiceSessionV1 | null = { actor: account, authIdentity: "fixture-auth", stamp: "fixture-session" };
  const ledger = new SharedPluginLedgerStoreV1({ root: join(root, "ledger"), sourceHome: source, secret: Buffer.alloc(32, 9), localLibrary: true,
    authority: { sourceAccountId: account, sourceRootIdentity: "fixture-native-root", modeFingerprint: "fixture-mode" } });
  const hydrate = (readProvider: OfficialPluginProviderReadV1 = async () => { throw new Error("provider must not hydrate local packages"); }) => hydrateOfficialSharedPluginLedgerV1({
    ledger, sourceHome: source, session: () => session, authorize: () => true, readProvider, localLibrary: true });
  const project = () => ledger.project({ stateRoot, account: { opaqueAccountId: account, codexHome: home }, authorize: () => true,
    writeEvidence: { accountChildAbsent: true, nativeWriterCensus: () => "zero" } });
  const service = async (readProvider: OfficialPluginProviderReadV1, preparationSession?: () => OfficialPluginServiceSessionV1 | null) => {
    const service = await prepareOfficialPluginAccountServiceV1({ root, upstreamBaseUrl: "https://provider.invalid/backend-api", ledger,
      session: () => session, preparationSession, readProvider, authorizeHeaders: () => true, policy: () => false, caEnvironment: {} });
    services.push(service);
    return service;
  };
  return { root, source, home, ids, files, write, ledger, hydrate, project, service, setSession: (value: OfficialPluginServiceSessionV1 | null) => { session = value; }, session: () => session! };
}

function signedLegacyFixture(f: ReturnType<typeof fixture>, input: { policy?: string; withheldIds?: string[] }): SharedPluginLedgerV1 {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
    throw new Error("invalid synthetic signed ledger value");
  };
  const { fingerprint: _fingerprint, ...value } = structuredClone(f.ledger.read()!);
  delete value.definitionPolicyFingerprint;
  if (input.policy !== undefined) value.definitionPolicyFingerprint = input.policy;
  const withheld = new Set(input.withheldIds ?? []);
  value.entries = value.entries.filter(entry => !withheld.has(entry.id));
  value.withheldPlugins = Object.fromEntries([...withheld].map(id => [id, sharedPluginWithheldReasonV1(new Error("plugin definition contains account-local authorization"))!]));
  const ledger = { ...value, fingerprint: createHash("sha256").update(canonical(value)).digest("hex") };
  const signed = { value: ledger, hmac: createHmac("sha256", Buffer.alloc(32, 9)).update("shared-plugin-ledger:v1\0" + canonical(ledger)).digest("hex") };
  f.write(join(f.ledger.root, "head.v1.json"), canonical(signed));
  f.write(join(f.ledger.root, "generations", `${ledger.generation}.json`), canonical(signed));
  return f.ledger.read()!;
}

test("markerless reserved and ordinary packages use local aliases with complete Skills/hooks and unchanged source", async t => {
  const f = fixture(t), config = readFileSync(join(f.source, "config.toml"));
  const originalRoot = join(f.source, "plugins", "cache", "openai-curated-remote", "shared", "1.0.0");
  const inode = lstatSync(originalRoot).ino, snapshot = readOfficialInstalledPluginSnapshotV1(f.source);
  assert.equal(snapshot.plugins.find(p => p.id.startsWith("missing@"))!.version, null);
  const ledger = await f.hydrate();
  assert.equal(ledger.projectionMode, "local-library-v1");
  assert.deepEqual(ledger.entries.map(entry => entry.id).sort(), [...f.ids].sort());
  assert.ok(ledger.entries.every(entry => entry.remote === undefined));
  f.project();
  for (const id of f.ids) {
    const [name, market] = officialLocalPluginIdV1(id).split("@");
    const copied = join(f.home, "plugins", "cache", market!, name!, "1.0.0");
    assert.notEqual(market, id.split("@")[1]);
    for (const [path, bytes] of f.files) assert.equal(readFileSync(join(copied, path), "utf8"), bytes);
    assert.equal(existsSync(join(copied, ".codex-remote-plugin-install.json")), false);
    const catalogue = JSON.parse(readFileSync(join(f.home, "plugins", "cache", market!, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.deepEqual(catalogue.plugins, [{ name, source: { source: "local", path: `./${name}/1.0.0` } }]);
  }
  assert.equal(lstatSync(originalRoot).ino, inode);
  assert.deepEqual(readFileSync(join(f.source, "config.toml")), config);
  for (const [path, bytes] of f.files) assert.equal(readFileSync(join(originalRoot, path), "utf8"), bytes);
});

test("unchanged native source is reclassified when legacy signed policy has obsolete safe-package holds", async t => {
  for (const policy of [undefined, `sha256:${"0".repeat(64)}`]) await t.test(policy === undefined ? "missing legacy policy" : "noncurrent signed policy", async child => {
    const f = fixture(child), restoredId = f.ids[0]!, alias = officialLocalPluginIdV1(restoredId);
    f.write(join(f.source, "config.toml"), readFileSync(join(f.source, "config.toml"), "utf8").replace(`[plugins."${restoredId}"]\nenabled=false`, `[plugins."${restoredId}"]\nenabled=true`));
    const nativePackage = join(f.source, "plugins", "cache", "openai-curated-remote", "shared", "1.0.0");
    f.write(join(nativePackage, "auth.json"), "synthetic native-account auth store");
    const nativeConfig = readFileSync(join(f.source, "config.toml")), nativeAuth = readFileSync(join(nativePackage, "auth.json")), nativeInode = lstatSync(nativePackage).ino;
    const current = await f.hydrate();
    assert.equal(current.definitionPolicyFingerprint, OFFICIAL_PLUGIN_DEFINITION_POLICY_FINGERPRINT_V1);
    await f.ledger.validateSourceLease(current); assert.equal(f.ledger.verifyGeneration(current.fingerprint), true);
    const legacy = signedLegacyFixture(f, { policy, withheldIds: [restoredId] });
    assert.equal(legacy.entries.some(entry => entry.id === restoredId), false);
    assert.ok(legacy.withheldPlugins?.[restoredId]);
    assert.equal(legacy.sourceSnapshotFingerprint, current.sourceSnapshotFingerprint);
    const historyPath = join(f.ledger.root, "generations", `${legacy.generation}.json`), history = readFileSync(historyPath);
    assert.equal(f.ledger.verifyGeneration(legacy.fingerprint), false);
    assert.equal(f.ledger.verifyGeneration(current.fingerprint), false);
    await assert.rejects(f.ledger.validateSourceLease(legacy), /definition policy changed/);
    assert.throws(f.project, /definition policy changed/);
    await assert.rejects(f.service(async () => ({ status: 200, value: {} })), /definition policy changed/);

    const refreshed = await f.hydrate();
    assert.equal(refreshed.generation, legacy.generation + 1);
    assert.equal(refreshed.prior, legacy.fingerprint);
    assert.equal(refreshed.sourceSnapshotFingerprint, legacy.sourceSnapshotFingerprint);
    assert.equal(refreshed.definitionPolicyFingerprint, OFFICIAL_PLUGIN_DEFINITION_POLICY_FINGERPRINT_V1);
    assert.equal(refreshed.entries.some(entry => entry.id === restoredId), true);
    assert.deepEqual(refreshed.withheldPlugins, {});
    assert.deepEqual(readFileSync(historyPath), history);
    f.project();
    const [name, market] = alias.split("@"), projected = join(f.home, "plugins", "cache", market!, name!, "1.0.0");
    assert.equal(readFileSync(join(projected, "skills", "tool", "SKILL.md"), "utf8"), f.files.get("skills/tool/SKILL.md"));
    assert.equal(existsSync(join(projected, "auth.json")), false);
    assert.equal(lstatSync(nativePackage).ino, nativeInode);
    assert.deepEqual(readFileSync(join(f.source, "config.toml")), nativeConfig);
    assert.deepEqual(readFileSync(join(nativePackage, "auth.json")), nativeAuth);

    const inventory: OfficialPluginInventoryV1 = { schema_version: 1, native_base_root: f.source, plugins: readOfficialInstalledPluginSnapshotV1(f.source).plugins };
    const plan = () => officialBundledAccountPlanV1({ sourceHome: f.source, settingsHome: f.source, accountHome: f.home, inventory,
      localLibrary: true, args: ["app-server"], withheldPlugins: refreshed.withheldPlugins });
    const restored = plan();
    assert.equal(restored.withheldPlugins[restoredId], undefined);
    assert.equal(effectiveOverrides(restored.args).plugins[alias].enabled, true);
    assert.equal(effectiveOverrides(restored.args).plugins[officialLocalPluginIdV1(f.ids[1]!)].enabled, false);
    assert.ok(restored.withheldPlugins["missing@openai-curated-remote"]);
    f.write(join(f.home, "config.toml"), `[plugins."${alias}"]\nenabled=false\n`);
    const explicit = plan();
    assert.equal(effectiveOverrides(explicit.args).plugins[alias].enabled, false);
    assert.deepEqual(readFileSync(join(f.home, "config.toml")), Buffer.from(`[plugins."${alias}"]\nenabled=false\n`));
    await f.ledger.validateSourceLease(refreshed);
    assert.equal(f.ledger.verifyGeneration(refreshed.fingerprint), true);
    assert.equal(f.ledger.verifyGeneration(legacy.fingerprint), false);
    assert.equal((await f.hydrate()).fingerprint, refreshed.fingerprint);
  });
});

test("present malformed definition policy is rejected even with an otherwise valid signed journal", async t => {
  const f = fixture(t); await f.hydrate();
  assert.throws(() => signedLegacyFixture(f, { policy: "caller-provided-policy" }), /invalid shared plugin definition policy fingerprint/);
});

test("empty remote installed snapshot retains aliases and mutations never call provider or materialize", async t => {
  const f = fixture(t); await f.hydrate(); f.project(); let reads = 0;
  const service = await f.service(async () => { reads++; throw new Error("unexpected fallback"); });
  assert.deepEqual(await service.interceptHttp("GET", "/backend-api/ps/plugins/installed", new URLSearchParams(), Buffer.alloc(0)),
    { status: 200, value: { plugins: [], pagination: { next_page_token: null } } });
  for (const path of ["/ps/plugins/plugins_real/install", "/ps/plugins/plugins_real/uninstall", "/plugins/plugins_real/enable"]) {
    const reply = await service.interceptHttp("POST", path, new URLSearchParams(), Buffer.from("{}"));
    assert.equal(reply.status, 409); assert.match(JSON.stringify(reply.value), /plugins_follow_native/);
  }
  assert.equal((await service.interceptHttp("GET", "/ps/plugins/installed", new URLSearchParams("pageToken=next"), Buffer.alloc(0))).status, 400);
  assert.equal((await service.interceptHttp("GET", "/ps/plugins/installed", new URLSearchParams(), Buffer.from("x"))).status, 400);
  assert.equal(reads, 0);
  assert.equal(existsSync(join(f.home, "plugins", "cache", "openai-curated-remote", "plugins_real")), false);
  for (const id of f.ids) {
    const [name, market] = officialLocalPluginIdV1(id).split("@");
    assert.ok(existsSync(join(f.home, "plugins", "cache", market!, name!, "1.0.0", "skills", "tool", "SKILL.md")));
  }
  for (const method of ["plugin/install", "plugin/uninstall"]) assert.equal(officialFollowNativePluginMutationV1(method, {}), true);
});

test("unchanged native revalidation renews the existing account service lease", async t => {
  const f = fixture(t);
  const initial = await f.hydrate();
  const service = await f.service(async () => ({ status: 200, value: {} }));
  assert.equal(service.verify(), true);
  const path = join(f.source, "plugins/cache/local/local/1.0.0/skills/tool/SKILL.md");
  writeFileSync(path, readFileSync(path));
  const deadline = Date.now() + 2000;
  while (service.verify() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.verify(), false, "source watcher invalidates the old lease");
  assert.equal((await f.hydrate()).fingerprint, initial.fingerprint, "same bytes keep the generation");
  assert.equal(service.verify(), true, "resident account services recover without recreating their child");
});

test("unchanged hydration rejects authority changes across lease renewal", async t => {
  for (const change of ["abort", "session", "authorization"] as const) await t.test(change, async t => {
    const f = fixture(t); await f.hydrate();
    const controller = new AbortController(); let authorized = true;
    const validate = f.ledger.validateSourceLease.bind(f.ledger);
    f.ledger.validateSourceLease = async ledger => {
      await validate(ledger);
      if (change === "abort") controller.abort();
      else if (change === "session") f.setSession(null);
      else authorized = false;
    };
    await assert.rejects(hydrateOfficialSharedPluginLedgerV1({ ledger: f.ledger, sourceHome: f.source,
      session: f.session, authorize: () => authorized, signal: controller.signal, localLibrary: true,
      readProvider: async () => { throw new Error("unexpected provider read"); } }), /session changed/);
  });
});

test("genuine recommendation IDs survive canonical-name dedup, including a missing source package", async t => {
  const f = fixture(t);
  // Let source setup notifications settle; this fixture tests catalog dedup.
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  await f.hydrate();
  const plugins = [{ id: "plugins_installed_real", name: "shared" }, { id: "plugins_other_real", name: "other" }, { id: "plugins_missing_real", name: "missing" }];
  const service = await f.service(async path => { assert.equal(path, "/ps/plugins/suggested/codex"); return { status: 200, value: { plugins, pagination: { next_page_token: "genuine-next" } } }; });
  assert.deepEqual(await service.interceptHttp("GET", "/ps/plugins/suggested/codex", new URLSearchParams(), Buffer.alloc(0)), {
    status: 200, value: { plugins: plugins.slice(1), pagination: { next_page_token: "genuine-next" } },
  });
});

test("unsafe declared MCP file is signed as withheld while safe packages project and both native names dedup", async t => {
  const f = fixture(t), unsafeId = "shared@openai-curated-remote", safeId = "safe@openai-curated-remote";
  const unsafeRoot = join(f.source, "plugins", "cache", "openai-curated-remote", "shared", "1.0.0");
  const safeRoot = join(f.source, "plugins", "cache", "openai-curated-remote", "safe", "1.0.0");
  const unsafeManifest = JSON.stringify({ name: "shared", version: "1.0.0", mcpServers: "./servers.json" });
  const unsafeServers = JSON.stringify({ mcpServers: { remote: { url: "https://fixture.invalid/mcp", http_headers: { Authorization: "Bearer fixture-literal-never-shared" } } } });
  f.write(join(f.source, "config.toml"), `[plugins."${unsafeId}"]\nenabled=false\n[plugins."${safeId}"]\nenabled=true\n`);
  f.write(join(unsafeRoot, ".codex-plugin", "plugin.json"), unsafeManifest);
  f.write(join(unsafeRoot, "servers.json"), unsafeServers);
  f.write(join(safeRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "safe", version: "1.0.0" }));
  for (const [path, bytes] of f.files) f.write(join(safeRoot, path), bytes);
  const sourceConfig = readFileSync(join(f.source, "config.toml")), unsafeInode = lstatSync(unsafeRoot).ino;
  const ledger = await f.hydrate();
  assert.deepEqual(ledger.entries.map(entry => entry.id), [safeId]);
  assert.deepEqual(Object.keys(ledger.withheldPlugins ?? {}), [unsafeId]);
  assert.deepEqual(f.ledger.read()!.withheldPlugins, ledger.withheldPlugins);
  assert.equal(JSON.stringify(ledger).includes("fixture-literal-never-shared"), false);
  f.project();
  const unsafeAlias = officialLocalPluginIdV1(unsafeId).split("@"), safeAlias = officialLocalPluginIdV1(safeId).split("@");
  assert.equal(existsSync(join(f.home, "plugins", "cache", unsafeAlias[1]!, unsafeAlias[0]!, "1.0.0")), false);
  for (const [path, bytes] of f.files) assert.equal(readFileSync(join(f.home, "plugins", "cache", safeAlias[1]!, safeAlias[0]!, "1.0.0", path), "utf8"), bytes);
  assert.equal(lstatSync(unsafeRoot).ino, unsafeInode);
  assert.equal(readFileSync(join(unsafeRoot, ".codex-plugin", "plugin.json"), "utf8"), unsafeManifest);
  assert.equal(readFileSync(join(unsafeRoot, "servers.json"), "utf8"), unsafeServers);
  assert.deepEqual(readFileSync(join(f.source, "config.toml")), sourceConfig);
  const genuine = { id: "plugins_other_genuine", name: "other" };
  const service = await f.service(async path => {
    assert.equal(path, "/ps/plugins/suggested/codex");
    return { status: 200, value: { plugins: [{ id: "plugins_shared_genuine", name: "shared" }, { id: "plugins_safe_genuine", name: "safe" }, genuine] } };
  });
  assert.deepEqual(await service.interceptHttp("GET", "/ps/plugins/suggested/codex", new URLSearchParams(), Buffer.alloc(0)), { status: 200, value: { plugins: [genuine] } });
});

test("late actor, auth and stamp changes revoke replies; provider errors and exceptions disclose no upstream values", async t => {
  const f = fixture(t); await f.hydrate(); const initial = { ...f.session() };
  let next: OfficialPluginServiceSessionV1 | null = initial;
  let mode = "session";
  const secret = "fixture-private-upstream-value";
  const service = await f.service(async () => {
    if (mode === "throw") throw new Error(secret);
    if (mode === "error") return { status: 401, value: { error: secret } };
    f.setSession(next); return { status: 200, value: { plugins: [{ id: "plugins_late_real", name: secret }] } };
  });
  for (const changed of [{ ...initial, actor: "other-actor" }, { ...initial, authIdentity: "other-auth" }, { ...initial, stamp: "other-session" }, null]) {
    f.setSession(initial); next = changed;
    const reply = await service.interceptHttp("GET", "/ps/plugins/list", new URLSearchParams(), Buffer.alloc(0));
    assert.equal(reply.status, 503); assert.equal(JSON.stringify(reply).includes(secret), false);
  }
  f.setSession(initial);
  for (const current of ["error", "throw"]) {
    mode = current;
    const reply = await service.interceptHttp("GET", "/ps/plugins/list", new URLSearchParams(), Buffer.alloc(0));
    assert.equal(reply.status, current === "error" ? 401 : 503); assert.equal(JSON.stringify(reply).includes(secret), false);
  }
  f.setSession({ ...initial, authIdentity: "other-auth" });
  assert.equal(service.verify(), false);
});

test("provider authorization binds exact bearer and account; effective config checks base before auth without enabling false flags", () => {
  const credentials = { accessToken: "fixture-token", chatgptAccountId: "fixture-account" };
  const headers = { authorization: "Bearer fixture-token", "chatgpt-account-id": "fixture-account" };
  assert.equal(officialPluginAuthorizationMatchesV1(headers, credentials), true);
  for (const altered of [{ ...headers, authorization: "Bearer other-token" }, { ...headers, "chatgpt-account-id": "other-account" }, { authorization: headers.authorization }, { ...headers, authorization: [headers.authorization] }]) {
    assert.equal(officialPluginAuthorizationMatchesV1(altered as unknown as IncomingHttpHeaders, credentials), false);
  }
  const base = "https://127.0.0.1:12345/backend-api";
  const effective = { config: { chatgpt_base_url: base, features: { plugins: false, hooks: false, codex_hooks: false, remote_plugin: false } } };
  assert.equal(officialPluginEffectiveConfigMatchesV1(effective, base), true);
  assert.deepEqual(effective.config.features, { plugins: false, hooks: false, codex_hooks: false, remote_plugin: false });
  assert.equal(officialPluginEffectiveConfigMatchesV1({ config: { chatgpt_base_url: "https://managed.invalid/backend-api" } }, base), false);
  assert.equal(officialPluginEffectiveConfigMatchesV1({ config: { chatgpt_base_url: base, features: { hooks: "false" } } }, base), false);
  assert.equal(officialPluginEffectiveConfigMatchesV1({ config: { chatgpt_base_url: base, features: { codex_hooks: "false" } } }, base), false);
  assert.equal(officialPluginEffectiveConfigMatchesV1({}, base), false);
});

test("canonical UI mapping keeps execution paths and native trust hashes; requests translate disabled IDs and config", async t => {
  const f = fixture(t); await f.hydrate(); f.project();
  const inventory: OfficialPluginInventoryV1 = { schema_version: 1, native_base_root: f.source, plugins: readOfficialInstalledPluginSnapshotV1(f.source).plugins.filter(p => p.version !== null) };
  const canonical = f.ids[0]!, alias = officialLocalPluginIdV1(canonical), market = alias.split("@")[1]!;
  const path = join(f.home, "plugins", "cache", market, "shared", "1.0.0", "hooks", "start.sh"), trust = "native-trust-sha256-fixture";
  const hookKey = `${canonical}:hooks/hooks.json:session_start:0:0`, executionHookKey = `${alias}:hooks/hooks.json:session_start:0:0`;
  const raw = { pluginId: alias, namespace: `plugin:${alias}:hook`, marketplaceName: market, path, hooks: [{ id: executionHookKey, eventName: "sessionStart", command: path, hash: trust }], config: { [alias]: { enabled: false } } };
  const mapped = officialCanonicalPluginResponseV1(raw, inventory) as typeof raw;
  assert.equal(mapped.pluginId, canonical); assert.equal(mapped.namespace, `plugin:${canonical}:hook`);
  assert.equal(mapped.marketplaceName, "openai-curated-remote"); assert.equal(mapped.path, path);
  assert.deepEqual(mapped.hooks, [{ id: hookKey, eventName: "sessionStart", command: path, hash: trust }]);
  assert.deepEqual(mapped.config, { [canonical]: { enabled: false } }); assert.equal(raw.pluginId, alias);
  const params = { disabledPluginIds: [canonical, `plugin:${canonical}:hook`, "unknown@local"], config: { [`plugins."${canonical}".enabled`]: false } };
  assert.deepEqual(officialExecutionPluginParamsV1("thread/start", params, inventory, f.home), {
    disabledPluginIds: [alias, `plugin:${alias}:hook`, "unknown@local"], config: { plugins: { [alias]: { enabled: false } } },
  });
  assert.deepEqual(officialExecutionPluginParamsV1("thread/start", { config: { plugins: { [canonical]: { enabled: false, mcp_servers: { remote: { enabled: false } } } } } }, inventory, f.home), {
    config: { plugins: { [alias]: { enabled: false, mcp_servers: { remote: { enabled: false } } } } },
  });
  assert.deepEqual(officialExecutionPluginParamsV1("config/batchWrite", { edits: [{ keyPath: `plugins."${canonical}".enabled`, value: false }] }, inventory, f.home), { edits: [{ keyPath: `plugins."${alias}".enabled`, value: false }] });
  assert.deepEqual(officialExecutionPluginParamsV1("config/batchWrite", { edits: [
    { keyPath: `hooks.state.${JSON.stringify(hookKey)}.enabled`, value: false },
    { keyPath: `hooks.state.${JSON.stringify(hookKey)}.trusted_hash`, value: trust },
  ] }, inventory, f.home), { edits: [
    { keyPath: `hooks.state.${JSON.stringify(executionHookKey)}.enabled`, value: false },
    { keyPath: `hooks.state.${JSON.stringify(executionHookKey)}.trusted_hash`, value: trust },
  ] });
  assert.deepEqual(officialExecutionPluginParamsV1("plugin/read", { pluginName: "shared", remoteMarketplaceName: "openai-curated-remote" }, inventory, f.home), { pluginName: "shared", remoteMarketplaceName: null, marketplacePath: join(f.home, "plugins", "cache", market, ".agents", "plugins", "marketplace.json") });
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, accountHome: f.home, inventory, args: ["app-server"], localLibrary: true });
  for (const id of f.ids) {
    assert.equal((plan.threadConfig.plugins as Record<string, { enabled: boolean }>)[officialLocalPluginIdV1(id)]!.enabled, false);
    assert.equal(effectiveOverrides(plan.args).plugins[officialLocalPluginIdV1(id)].enabled, false);
  }
});

test("local library inherits disabled native features only when execution-home and CLI values are unset", async t => {
  const f = fixture(t);
  f.write(join(f.source, "config.toml"), readFileSync(join(f.source, "config.toml"), "utf8") + "[features]\nplugins=false\ncodex_hooks=false\nremote_plugin=false\n");
  await f.hydrate(); f.project();
  const inventory: OfficialPluginInventoryV1 = { schema_version: 1, native_base_root: f.source, plugins: readOfficialInstalledPluginSnapshotV1(f.source).plugins.filter(p => p.version !== null) };
  const input = { sourceHome: f.source, accountHome: f.home, settingsHome: f.source, inventory, args: ["app-server"], localLibrary: true };
  const plan = officialBundledAccountPlanV1(input);
  for (const feature of ["plugins", "codex_hooks", "remote_plugin"]) assert.equal(effectiveOverrides(plan.args, f.home).features[feature], false);
  f.write(join(f.home, "config.toml"), "[features]\nplugins=true\ncodex_hooks=true\nremote_plugin=true\n");
  const owned = officialBundledAccountPlanV1(input);
  for (const feature of ["plugins", "codex_hooks", "remote_plugin"]) assert.equal(effectiveOverrides(owned.args, f.home).features[feature], true);
  const cli = officialBundledAccountPlanV1({ ...input, args: ["-c", "features.codex_hooks=false", "app-server"] });
  assert.equal(effectiveOverrides(cli.args, f.home).features.codex_hooks, false);
});

test("per-chat policy preserves explicit disabling and enabling while source holds and OAuth blocks remain forced", async t => {
  const f = fixture(t), shared = f.ids[0]!, local = f.ids[1]!;
  f.write(join(f.source, "plugins", "cache", "openai-curated-remote", "shared", "1.0.0", ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://fixture.invalid/mcp" }, stdio: { command: "fixture-tool" } } }));
  await f.hydrate(); f.project();
  f.write(join(f.home, "config.toml"), 'mcp_oauth_credentials_store="keyring"\n');
  const inventory: OfficialPluginInventoryV1 = { schema_version: 1, native_base_root: f.source, plugins: readOfficialInstalledPluginSnapshotV1(f.source).plugins };
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, settingsHome: f.source, accountHome: f.home, inventory, args: ["app-server"], localLibrary: true });
  assert.equal(plan.oauthIsolation, "blocked");
  const sharedAlias = officialLocalPluginIdV1(shared), localAlias = officialLocalPluginIdV1(local), missingAlias = officialLocalPluginIdV1("missing@openai-curated-remote");
  const defaults = officialThreadPluginParamsV1({}, plan, inventory, f.home) as { config: { plugins: Record<string, any> } };
  assert.equal(defaults.config.plugins[sharedAlias].enabled, false);
  const explicit = officialThreadPluginParamsV1({ disabledPluginIds: [local], config: { plugins: {
    [shared]: { enabled: true, mcp_servers: { remote: { enabled: true }, stdio: { enabled: false } } },
    [local]: { enabled: false }, "missing@openai-curated-remote": { enabled: true },
  } } }, plan, inventory, f.home) as { disabledPluginIds: string[]; config: { plugins: Record<string, any> } };
  assert.deepEqual(explicit.disabledPluginIds, [localAlias]);
  assert.equal(explicit.config.plugins[sharedAlias].enabled, true);
  assert.equal(explicit.config.plugins[localAlias].enabled, false);
  assert.equal(explicit.config.plugins[missingAlias].enabled, false);
  assert.equal(explicit.config.plugins[sharedAlias].mcp_servers.remote.enabled, false);
  assert.equal(explicit.config.plugins[sharedAlias].mcp_servers.stdio.enabled, false);
  const withheld = officialThreadPluginParamsV1({ config: { plugins: { [local]: { enabled: true } } } }, { ...plan, withheldPlugins: { ...plan.withheldPlugins, [local]: "Source definition unavailable" } }, inventory, f.home) as { config: { plugins: Record<string, any> } };
  assert.equal(withheld.config.plugins[localAlias].enabled, false);
});

test("signed withholding disables a formerly enabled alias while retaining its prior projection and unavailable UI", async t => {
  for (const extension of ["json", "toml"]) await t.test(`credential-bearing config.${extension}`, async child => {
    const f = fixture(child), id = f.ids[0]!, alias = officialLocalPluginIdV1(id), [name, market] = alias.split("@");
    f.write(join(f.source, "config.toml"), readFileSync(join(f.source, "config.toml"), "utf8").replace(`[plugins."${id}"]\nenabled=false`, `[plugins."${id}"]\nenabled=true`));
    await f.hydrate(); f.project();
    const sourcePackage = join(f.source, "plugins", "cache", "openai-curated-remote", "shared", "1.0.0");
    const projected = join(f.home, "plugins", "cache", market!, name!, "1.0.0");
    const catalogue = join(f.home, "plugins", "cache", market!, ".agents", "plugins", "marketplace.json");
    const skillBytes = readFileSync(join(projected, "skills", "tool", "SKILL.md")), catalogueBytes = readFileSync(catalogue);
    const firstInventory: OfficialPluginInventoryV1 = { schema_version: 1, native_base_root: f.source, plugins: readOfficialInstalledPluginSnapshotV1(f.source).plugins };
    const firstPlan = officialBundledAccountPlanV1({ sourceHome: f.source, settingsHome: f.source, accountHome: f.home, inventory: firstInventory, localLibrary: true, args: ["app-server"], withheldPlugins: f.ledger.read()!.withheldPlugins });
    assert.equal(effectiveOverrides(firstPlan.args).plugins[alias].enabled, true);
    const unsafePath = join(sourcePackage, `config.${extension}`);
    const unsafeBytes = extension === "json" ? JSON.stringify({ Authorization: "Bearer fixture-config-secret" }) : 'Authorization="Bearer fixture-config-secret"\n';
    f.write(unsafePath, unsafeBytes);
    const withheld = await f.hydrate();
    assert.ok(withheld.withheldPlugins?.[id]);
    assert.equal(withheld.entries.some(entry => entry.id === id), false);
    f.project();
    assert.deepEqual(readFileSync(join(projected, "skills", "tool", "SKILL.md")), skillBytes);
    assert.deepEqual(readFileSync(catalogue), catalogueBytes);
    assert.equal(existsSync(join(projected, `config.${extension}`)), false);
    assert.equal(readFileSync(unsafePath, "utf8"), unsafeBytes);
    const inventory: OfficialPluginInventoryV1 = { schema_version: 1, native_base_root: f.source, plugins: readOfficialInstalledPluginSnapshotV1(f.source).plugins };
    const plan = officialBundledAccountPlanV1({ sourceHome: f.source, settingsHome: f.source, accountHome: f.home, inventory, localLibrary: true, args: ["app-server"], withheldPlugins: withheld.withheldPlugins });
    assert.equal(effectiveOverrides(plan.args).plugins[alias].enabled, false);
    const params = officialThreadPluginParamsV1({ config: { plugins: { [id]: { enabled: true } } } }, plan, inventory, f.home) as { config: { plugins: Record<string, { enabled: boolean }> } };
    assert.equal(params.config.plugins[alias]!.enabled, false);
    const response = officialSharedPluginResponseV1(inventory, plan) as { marketplaces: Array<{ plugins: Array<{ id: string; enabled: boolean; status?: string }> }> };
    const row = response.marketplaces.flatMap(marketplace => marketplace.plugins).find(plugin => plugin.id === id)!;
    assert.equal(row.enabled, false); assert.equal(row.status, "unavailable");
  });
});

test("safe siblings remain usable when referenced MCP files are missing or malformed", async t => {
  const f = fixture(t), missing = "missing-mcp@openai-curated-remote", malformed = "malformed-mcp@openai-curated-remote";
  f.write(join(f.source, "config.toml"), readFileSync(join(f.source, "config.toml"), "utf8").replace('[plugins."local@local"]\nenabled=false', '[plugins."local@local"]\nenabled=true') + `[plugins."${missing}"]\nenabled=true\n[plugins."${malformed}"]\nenabled=true\n`);
  for (const id of [missing, malformed]) {
    const name = id.split("@")[0]!, root = join(f.source, "plugins", "cache", "openai-curated-remote", name, "1.0.0");
    f.write(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0", mcpServers: "./servers.json" }));
    if (id === malformed) f.write(join(root, "servers.json"), "{ deliberately malformed fixture JSON");
  }
  const ledger = await f.hydrate();
  assert.deepEqual(ledger.entries.map(entry => entry.id).sort(), [...f.ids].sort());
  assert.deepEqual(Object.keys(ledger.withheldPlugins ?? {}).sort(), [missing, malformed].sort());
  f.project();
  const inventory: OfficialPluginInventoryV1 = { schema_version: 1, native_base_root: f.source, plugins: readOfficialInstalledPluginSnapshotV1(f.source).plugins };
  const plan = officialBundledAccountPlanV1({ sourceHome: f.source, settingsHome: f.source, accountHome: f.home, inventory, localLibrary: true, args: ["app-server"], withheldPlugins: ledger.withheldPlugins });
  assert.equal(effectiveOverrides(plan.args).plugins[officialLocalPluginIdV1("local@local")].enabled, true);
  for (const id of [missing, malformed]) assert.equal(effectiveOverrides(plan.args).plugins[officialLocalPluginIdV1(id)].enabled, false);
  for (const id of f.ids) {
    const [name, market] = officialLocalPluginIdV1(id).split("@");
    assert.equal(readFileSync(join(f.home, "plugins", "cache", market!, name!, "1.0.0", "skills", "tool", "SKILL.md"), "utf8"), f.files.get("skills/tool/SKILL.md"));
  }
});


test("owned preparation authority never admits ordinary plugin HTTP", async t => {
  const f = fixture(t); await f.hydrate();
  const captured = f.session(); let preparation: OfficialPluginServiceSessionV1 | null = captured;
  const service = await f.service(async () => { throw new Error("blocked HTTP cannot contact the provider"); }, () => preparation);
  assert.equal(service.verify(), true); assert.equal(service.verifyPreparation!(), true);
  f.setSession(null);
  assert.equal(service.verify(), false); assert.equal(service.verifyPreparation!(), true);
  assert.equal((await service.interceptHttp("GET", "/ps/plugins/installed", new URLSearchParams(), Buffer.alloc(0))).status, 503);
  preparation = null;
  assert.equal(service.verifyPreparation!(), false, "revoked ownership must not fall back to a different session");
  f.setSession(captured); assert.equal(service.verify(), true);
  assert.equal(service.verifyPreparation!(), false);
  preparation = captured; assert.equal(service.verifyPreparation!(), true);
  assert.equal(await service.close(), true);
  assert.equal(service.verifyPreparation!(), false);
});
