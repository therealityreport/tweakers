import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedPluginLedgerStoreV1, parseSharedPluginRemoteDescriptorV1, readSharedPluginRemoteIdentityV1, sharedPluginDescriptorResponseDigestV1, sharedPluginWithheldReasonV1 } from "../../src/account-router/shared-plugin-ledger";
import { assertNonsecretDefinitionJsonV1, captureOfficialPluginPackageV1, officialLocalPluginIdV1, officialPluginDefinitionBlocksV1, readOfficialPluginHttpServersV1 } from "../../src/account-router/account-continuity";
import type { OpaqueAccountId } from "../../src/account-router/types";

function fixture(t: test.TestContext, localLibrary = false, sourceVersion = "1.0.0") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shared-local-plugins-"))); chmodSync(root, 0o700);
  t.after(() => { store.close(); const writable = (path: string) => { const s = lstatSync(path); if (s.isSymbolicLink()) return; chmodSync(path, 0o700); if (s.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name)); }; writable(root); rmSync(root, { recursive: true, force: true }); });
  const source = join(root, "native"), stateRoot = join(root, "state"), account = `ar_${"a".repeat(43)}` as OpaqueAccountId;
  const home = join(stateRoot, "accounts", account, "execution-home");
  const write = (path: string, value: string) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, value, { mode: 0o600 }); };
  mkdirSync(source, { mode: 0o700 }); mkdirSync(home, { recursive: true, mode: 0o700 });
  const packageRoot = join(source, "plugins", "cache", "local", "plugin", sourceVersion);
  write(join(source, "config.toml"), '[plugins."plugin@local"]\nenabled=false\n');
  write(join(packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
  write(join(packageRoot, "skills", "tool", "SKILL.md"), "# Local skill\n");
  write(join(packageRoot, "auth.json"), "private account value remains native");
  const store = new SharedPluginLedgerStoreV1({ root: join(root, "overlay"), sourceHome: source, secret: Buffer.alloc(32, 7), localLibrary,
    authority: { sourceAccountId: account, sourceRootIdentity: "native-root-identity", modeFingerprint: "signed-mode-fingerprint" } });
  const candidate = { id: "plugin@local", version: sourceVersion, source: packageRoot };
  const project = () => store.project({ stateRoot, account: { opaqueAccountId: account, codexHome: home }, authorize: () => true,
    writeEvidence: { accountChildAbsent: true, nativeWriterCensus: () => "zero" } });
  return { root, source, stateRoot, account, home, packageRoot, write, store, candidate, project };
}

function remote(f: ReturnType<typeof fixture>) {
  f.packageRoot = join(f.source, "plugins", "cache", "openai-curated-remote", "plugin", "1.0.0");
  f.candidate.source = f.packageRoot;
  f.write(join(f.source, "config.toml"), '[plugins."plugin@openai-curated-remote"]\nenabled=false\n');
  f.write(join(f.packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
  f.write(join(f.packageRoot, "skills", "tool", "SKILL.md"), "# Local skill\n");
  f.write(join(f.packageRoot, ".codex-remote-plugin-install.json"), JSON.stringify({ schema_version: 1, remote_plugin_id: "plugins_real_123" }));
  const response = { id: "plugins_real_123", name: "plugin", scope: "GLOBAL", installation_policy: "AVAILABLE", authentication_policy: "ON_USE",
    must_show_installation_interstitial: true, status: "ENABLED", creator_name: "private source profile", release: { version: "1.0.0", display_name: "Plugin", description: "A shared definition", interface: {}, app_ids: ["connector_real"], mcp_servers: [{ key: "tool" }], skills: [{ name: "tool", description: "Local skill" }], bundle_download_url: "https://download.example/bundle?signature=private", app_manifest: { apps: [] } } };
  const provenance = { kind: "selected-account-detail" as const, actor: f.account, authIdentity: "auth-hmac", sessionStamp: "session-digest", responseDigest: sharedPluginDescriptorResponseDigestV1(response) };
  const descriptor = parseSharedPluginRemoteDescriptorV1("plugin@openai-curated-remote", "1.0.0", "plugins_real_123", response, provenance);
  return { response, provenance, descriptor, candidate: { ...f.candidate, id: "plugin@openai-curated-remote", remote: descriptor } };
}

test("native-owned runtime proof is read-only and rejects changed account custody", async t => {
  for (const mutation of ["none", "payload", "catalogue", "pending", "receipt", "home", "missing"] as const) {
    await t.test(mutation, async t => {
      const f = fixture(t, true);
      const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
      await f.store.validateSourceLease(ledger);
      f.project();
      const receipt = join(f.stateRoot, "accounts", f.account, "shared-plugin-projection.v1.json"), before = readFileSync(receipt, "utf8");
      const [name, market] = officialLocalPluginIdV1(f.candidate.id).split("@");
      if (mutation === "payload") f.write(join(f.home, "plugins", "cache", market!, name!, "1.0.0", "skills", "tool", "SKILL.md"), "changed");
      if (mutation === "catalogue") f.write(join(f.home, "plugins", "cache", market!, ".agents", "plugins", "marketplace.json"), "{}");
      if (mutation === "pending") f.write(join(f.stateRoot, "accounts", f.account, "plugin-projection-intent.v1.json"), "{}");
      if (mutation === "receipt") f.write(receipt, before.replace('"generation":1', '"generation":2'));
      const verify = () => f.store.verifyAccountProjection({ stateRoot: f.stateRoot, account: f.account,
        home: mutation === "home" ? f.source : f.home, ids: [mutation === "missing" ? "missing@local" : f.candidate.id] });
      if (mutation === "none") assert.deepEqual(verify(), [{ id: f.candidate.id, version: "1.0.0" }]);
      else assert.throws(verify);
      assert.equal(readFileSync(receipt, "utf8"), mutation === "receipt" ? before.replace('"generation":1', '"generation":2') : before);
    });
  }
});

test("signed canonical custody preserves source bytes/inodes and shares no account data", t => {
  const f = fixture(t), native = readFileSync(join(f.packageRoot, "auth.json")), inode = lstatSync(f.packageRoot).ino;
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  assert.equal(ledger.generation, 1); assert.equal(ledger.entries[0]!.id, "plugin@local");
  assert.equal(existsSync(join(f.store.packagePath(ledger.entries[0]!), "auth.json")), false);
  assert.equal(lstatSync(f.packageRoot).ino, inode); assert.deepEqual(readFileSync(join(f.packageRoot, "auth.json")), native);
  f.project(); assert.equal(existsSync(join(f.home, "plugins", "cache", "local", "plugin", "1.0.0", "skills", "tool", "SKILL.md")), true);
  assert.equal(existsSync(join(f.home, "plugins", "cache", "local", "plugin", "1.0.0", "auth.json")), false);
});

test("async account projection keeps the broker responsive and preserves signed package custody", async t => {
  const f = fixture(t);
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  try {
    await f.store.projectAsync({ stateRoot: f.stateRoot, account: { opaqueAccountId: f.account, codexHome: f.home },
      authorize: () => true, writeEvidence: { accountChildAbsent: true } });
  } finally { clearInterval(timer); }
  assert.ok(ticks > 0, "the main event loop runs while worker preparation is pending");
  assert.equal(existsSync(join(f.home, "plugins", "cache", "local", "plugin", "1.0.0", "skills", "tool", "SKILL.md")), true);
  assert.equal(existsSync(join(f.home, "plugins", "cache", "local", "plugin", "1.0.0", "auth.json")), false);
  f.project(); // The ordinary full verifier accepts the worker's exact durable receipt.
});

test("async projection rejects cancelled queued authority and retains account tampering", async t => {
  const f = fixture(t);
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger);
  const input = { stateRoot: f.stateRoot, account: { opaqueAccountId: f.account, codexHome: f.home },
    authorize: () => true, writeEvidence: { accountChildAbsent: true } };
  const first = f.store.projectAsync(input);
  let authorized = true;
  const second = f.store.projectAsync({ ...input, authorize: () => authorized });
  authorized = false;
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(results[1]!.status, "rejected");
  const skill = join(f.home, "plugins", "cache", "local", "plugin", "1.0.0", "skills", "tool", "SKILL.md");
  f.write(skill, "Account-local evidence must survive\n");
  await assert.rejects(f.store.projectAsync(input), (error: any) => error.message === "shared plugin projection failed" && error.preparationStage === "account-payload");
  assert.equal(readFileSync(skill, "utf8"), "Account-local evidence must survive\n");
});

test("in-flight projection holds its write lease through throwing authority, source drift, and owner shutdown", async t => {
  for (const failure of ["throw", "source", "shutdown"] as const) {
    await t.test(failure, async subtest => {
      const f = fixture(subtest);
      for (let index = 0; index < 200; index++) f.write(join(f.packageRoot, "assets", `${index}.txt`), "public fixture bytes\n");
      const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
      await f.store.validateSourceLease(ledger);
      let throwAuthority = false, settled = false;
      const pending = f.store.projectAsync({ stateRoot: f.stateRoot, account: { opaqueAccountId: f.account, codexHome: f.home },
        authorize: () => { if (throwAuthority) throw new Error("authority unavailable"); return true; }, writeEvidence: { accountChildAbsent: true } });
      const outcome = pending.then(() => { settled = true; return true; }, () => { settled = true; return false; });
      const intent = join(f.stateRoot, "accounts", f.account, "shared-plugin-projection-intent.v1.json");
      const deadline = Date.now() + 10_000;
      while (!existsSync(intent) && !settled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
      assert.equal(existsSync(intent), true, "cancel an actual worker copy after durable write intent");
      if (failure === "throw") throwAuthority = true;
      else if (failure === "source") f.write(join(f.source, "config.toml"), '[plugins."plugin@local"]\nenabled=true\n');
      else f.store.close();
      await Promise.resolve();
      assert.equal(settled, false, "cancellation does not release ownership before worker exit");
      assert.equal(await outcome, false);
      assert.equal(existsSync(intent), true, "interrupted publication retains its signed recovery intent");
      assert.equal(existsSync(join(f.stateRoot, "accounts", f.account, "shared-plugin-projection.v1.json")), false);
    });
  }
});

test("remote namespace requires real marker, release and descriptor provenance without provider claims", t => {
  const f = fixture(t);
  const r = remote(f);
  assert.throws(() => f.store.publish({ expected: null, packages: [{ ...f.candidate, id: "plugin@openai-curated-remote" }], authorize: () => true }), /real matching remote descriptor/);
  assert.equal(f.store.read(), null);
  assert.equal(readSharedPluginRemoteIdentityV1(f.packageRoot), "plugins_real_123");
  assert.equal(JSON.stringify(r.descriptor).includes("signature=private"), false);
  assert.equal(JSON.stringify(r.descriptor).includes("private source profile"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.descriptor, "status"), false);
  assert.throws(() => parseSharedPluginRemoteDescriptorV1("plugin@openai-curated-remote", "2.0.0", "plugins_real_123", r.response, r.provenance), /match/);
  assert.throws(() => parseSharedPluginRemoteDescriptorV1("plugin@created-by-me-remote", "1.0.0", "plugins_real_123", r.response, r.provenance), /scope/);
});

test("CAS rejects stale authority and signed heads reject tampering", t => {
  const f = fixture(t), first = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  assert.throws(() => f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true }), /stale/);
  const second = f.store.publish({ expected: first.fingerprint, packages: [f.candidate], authorize: () => true });
  assert.equal(second.generation, 2); assert.equal(second.prior, first.fingerprint);
  const path = join(f.root, "overlay", "head.v1.json"), raw = JSON.parse(readFileSync(path, "utf8")); raw.value.authority.sourceRootIdentity = "foreign";
  f.write(path, JSON.stringify(raw)); assert.throws(() => f.store.read(), /signature/);
});

test("strict projection rejects preexisting unowned and modified signed account packages", t => {
  const f = fixture(t); f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  const target = join(f.home, "plugins", "cache", "local", "plugin", "1.0.0", ".codex-plugin", "plugin.json");
  f.write(target, JSON.stringify({ name: "foreign", version: "1.0.0" }));
  assert.throws(f.project, /modified or unowned/); assert.equal(JSON.parse(readFileSync(target, "utf8")).name, "foreign");
});

test("projection signatures reject changed account bytes even if unsigned primitive receipt is tampered", t => {
  const f = fixture(t); f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true }); f.project();
  f.write(join(f.home, "plugins", "cache", "local", "plugin", "1.0.0", "skills", "tool", "SKILL.md"), "changed by user");
  assert.throws(f.project, /signed account package projection changed/);
});

test("canceled, replaced-child, auth and generation-stale install tickets authorize nothing", t => {
  const f = fixture(t), first = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  const context = { actor: f.account, childStamp: "child-1", authIdentity: "auth-hmac", sessionStamp: "session-1", rendererRef: "desktop-1", approvalId: "approval-1", installAttemptId: "attempt-1", pluginId: "plugin@local" };
  const ticket = f.store.issueTicket({ ...context, expiresAt: Date.now() + 60_000 });
  assert.equal(f.store.validateTicket(ticket, context), true);
  assert.equal(f.store.validateTicket(ticket, {} as typeof context), false);
  assert.equal(f.store.validateTicket(ticket, { ...context, childStamp: "child-2" }), false);
  assert.equal(f.store.validateTicket(ticket, { ...context, authIdentity: "other-auth" }), false);
  f.store.cancelTicket(ticket.nonce); assert.equal(f.store.validateTicket(ticket, context), false);
  const next = f.store.issueTicket({ ...context, expiresAt: Date.now() + 60_000 });
  f.store.publish({ expected: first.fingerprint, packages: [f.candidate], authorize: () => true }); assert.equal(f.store.validateTicket(next, context), false);
});

test("local installed remote snapshot preserves disabled entries and requires selected-account availability", t => {
  const f = fixture(t), r = remote(f), ledger = f.store.publish({ expected: null, packages: [r.candidate], authorize: () => true }); f.project();
  assert.throws(() => f.store.installedSnapshot(ledger.fingerprint, () => false, () => null), /selected-account provider availability/);
  const snapshot = f.store.installedSnapshot(ledger.fingerprint, () => false, () => ({ status: "DISABLED_BY_ADMIN", disabled_reason: "disabled_by_admin" })) as any;
  assert.equal(snapshot.plugins.length, 1); assert.equal(snapshot.plugins[0].enabled, false); assert.equal(snapshot.plugins[0].status, "DISABLED_BY_ADMIN");
  assert.equal(snapshot.plugins[0].id, "plugins_real_123"); assert.equal(snapshot.plugins[0].must_show_installation_interstitial, true);
  assert.deepEqual(snapshot.plugins[0].release.app_ids, ["connector_real"]); assert.equal(snapshot.plugins[0].release.bundle_download_url, null);
  assert.equal((f.store.installedSnapshot(ledger.fingerprint, () => true, () => ({ status: "DISABLED_BY_ADMIN" })) as any).plugins[0].enabled, false);
});

test("uncertain publication retains signed recovery journal and blocks automatic retry", t => {
  const f = fixture(t); let calls = 0;
  assert.throws(() => f.store.publish({ expected: null, packages: [f.candidate], authorize: () => ++calls < 3 }), /uncertain/);
  assert.equal(existsSync(join(f.root, "overlay", "publication-intent.v1.json")), true);
  assert.equal(existsSync(join(f.root, "overlay", "publication-lock.v1.json")), true);
  assert.throws(() => f.store.read(), /uncertain/);
});

test("follow-native authority rejects Tweakers additions/removals and stale source revisions", t => {
  const f = fixture(t);
  assert.throws(() => f.store.publish({ expected: null, packages: [], authorize: () => true }), /follow-native/);
  assert.throws(() => f.store.publish({ expected: null, packages: [{ ...f.candidate, source: f.home }], authorize: () => true }), /exact source package/);
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  f.write(join(f.source, "config.toml"), '[plugins."plugin@local"]\nenabled=true\n');
  assert.throws(() => f.store.installedSnapshot(ledger.fingerprint, () => true, () => null), /revision changed/);
  assert.throws(f.project, /revision changed/);
  assert.equal(f.store.read()!.fingerprint, ledger.fingerprint);
});

for (const manifestPath of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
  test(`custody and metadata holds inspect arbitrary MCP references in ${manifestPath}`, t => {
    const f = fixture(t);
    f.write(join(f.packageRoot, manifestPath), JSON.stringify({ name: "plugin", version: "1.0.0", author: "Example Author",
      mcpServers: "./definitions/servers.json" }));
    f.write(join(f.packageRoot, "definitions", "servers.json"), JSON.stringify({ mcpServers: { remote: {
      url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer synthetic-fixture-value" },
    } } }));
    assert.throws(() => captureOfficialPluginPackageV1(f.packageRoot), /account-local authorization/);
    assert.throws(() => f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true }), /account-local authorization/);
    assert.deepEqual(readdirSync(join(f.store.root, "packages")), []);
    assert.equal(existsSync(join(f.home, "plugins", "cache")), false);
    const blocked = officialPluginDefinitionBlocksV1(f.source, [f.candidate]);
    assert.equal(blocked[f.candidate.id], sharedPluginWithheldReasonV1(new Error("plugin definition contains account-local authorization")));
    assert.equal(JSON.stringify(blocked).includes("synthetic-fixture-value"), false);
  });
}

test("metadata discovery reads supported legacy paths and inline objects without package-tree custody", t => {
  const f = fixture(t);
  f.write(join(f.packageRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plugin", author: "Example Author",
    mcpServers: "./definitions/legacy.json" }));
  f.write(join(f.packageRoot, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "plugin",
    mcpServers: { cursorInline: { url: "https://fixture.invalid/cursor" }, cursorStdio: { command: "fixture-tool" } } }));
  f.write(join(f.packageRoot, "plugin.json"), JSON.stringify({ name: "portable", entry: "./index.js", permissions: [], mcpServers: ["portable-server-name"] }));
  f.write(join(f.packageRoot, ".agents", "plugins", "plugin.json"), JSON.stringify({ name: "metadata", mcpServers: ["not-a-file"] }));
  f.write(join(f.packageRoot, "definitions", "legacy.json"), JSON.stringify({ mcpServers: { legacy: { url: "https://fixture.invalid/legacy" } } }));
  // A custody scan must reject this unrelated broken code link. Metadata-only
  // discovery must never inspect it while resolving HTTP OAuth holds.
  symlinkSync("./missing-code", join(f.packageRoot, "unrelated-code"));
  const names = readOfficialPluginHttpServersV1(f.source, [f.candidate], true, true).map(server => server.name).sort();
  assert.deepEqual(names, ["cursorInline", "cursorStdio", "legacy"]);
  assert.deepEqual(officialPluginDefinitionBlocksV1(f.source, [f.candidate]), {});
});

test("unsafe or missing declarations receive fixed public holds without copying private containers", t => {
  const f = fixture(t);
  for (const declared of ["./missing-servers.json", "./.plugin-data/servers.json"]) {
    f.write(join(f.packageRoot, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "plugin", mcpServers: declared }));
    const blocked = officialPluginDefinitionBlocksV1(f.source, [f.candidate]);
    assert.equal(blocked[f.candidate.id], sharedPluginWithheldReasonV1(new Error("unsafe MCP definition reference")));
    assert.throws(() => captureOfficialPluginPackageV1(f.packageRoot), /unsafe MCP definition/);
  }
});

test("Agent Plugins root schema uses optional fixed mcp.json and ignores root declaration metadata", t => {
  const f = fixture(t);
  f.write(join(f.packageRoot, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "plugin", version: "1.0.0", author: { name: "Example Author" }, mcpServers: ["ignored-server-name"] }));
  assert.doesNotThrow(() => captureOfficialPluginPackageV1(f.packageRoot));
  assert.deepEqual(readOfficialPluginHttpServersV1(f.source, [f.candidate], true), []);
  f.write(join(f.packageRoot, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { agent: { type: "streamable-http", url: "https://fixture.invalid/agent" } } }));
  assert.deepEqual(readOfficialPluginHttpServersV1(f.source, [f.candidate], true), [{ pluginId: f.candidate.id, name: "agent" }]);
  assert.doesNotThrow(() => captureOfficialPluginPackageV1(f.packageRoot));
  f.write(join(f.packageRoot, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { agent: { type: "streamable-http", url: "https://fixture.invalid/agent", headers: { "X-API-Key": "synthetic-fixture-value" } } } }));
  assert.throws(() => captureOfficialPluginPackageV1(f.packageRoot), /account-local authorization/);
  assert.equal(officialPluginDefinitionBlocksV1(f.source, [f.candidate])[f.candidate.id], sharedPluginWithheldReasonV1(new Error("plugin definition contains account-local authorization")));
});

test("portable root metadata and ignored legacy arrays never become file references", t => {
  const f = fixture(t);
  f.write(join(f.packageRoot, "plugin.json"), JSON.stringify({ name: "portable", entry: "./sdk.js", permissions: ["network"], mcpServers: ["portable-server-name"] }));
  f.write(join(f.packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", version: "1.0.0",
    mcpServers: ["./not-a-reference.json", "bare-server-name"] }));
  f.write(join(f.packageRoot, ".agents", "plugins", "plugin.json"), JSON.stringify({ name: "metadata", mcpServers: "./also-not-a-reference.json" }));
  assert.deepEqual(officialPluginDefinitionBlocksV1(f.source, [f.candidate]), {});
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  assert.equal(ledger.entries.length, 1);
  f.write(join(f.packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", mcpServers: [{ headers: { Authorization: "Bearer synthetic-fixture-value" } }] }));
  assert.throws(() => captureOfficialPluginPackageV1(f.packageRoot), /account-local authorization/);
  f.write(join(f.packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", mcpServers: "./actual-reference.json" }));
  f.write(join(f.packageRoot, "actual-reference.json"), JSON.stringify({ mcpServers: { actual: { url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer synthetic-fixture-value" } } } }));
  assert.throws(() => captureOfficialPluginPackageV1(f.packageRoot), /account-local authorization/);
  f.write(join(f.packageRoot, "actual-reference.json"), JSON.stringify({ mcpServers: { actual: { url: "https://fixture.invalid/mcp" } } }));
  f.write(join(f.packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", mcpServers: "bare-server-name" }));
  assert.doesNotThrow(() => captureOfficialPluginPackageV1(f.packageRoot));
  f.write(join(f.packageRoot, "plugin.json"), JSON.stringify({ name: "portable", entry: "./sdk.js", client_secret: "synthetic-fixture-value" }));
  assert.throws(() => captureOfficialPluginPackageV1(f.packageRoot), /account-local authorization/);
});

test("semantic TOML public labels and references pass while config and TOML credential leaves remain held", t => {
  const f = fixture(t);
  f.write(join(f.packageRoot, "settings.toml"), 'keywords=["oauth", "api-key"]\noutput_token_limit=4096\napi_key="${FIXTURE_KEY}"\n');
  assert.doesNotThrow(() => captureOfficialPluginPackageV1(f.packageRoot));
  f.write(join(f.packageRoot, "config.json"), JSON.stringify({ client_secret: "synthetic-fixture-value" }));
  assert.throws(() => captureOfficialPluginPackageV1(f.packageRoot), /account-local authorization/);
  f.write(join(f.packageRoot, "config.json"), JSON.stringify({ author: "Example Author" }));
  f.write(join(f.packageRoot, "settings.toml"), 'client_secret="synthetic-fixture-value"\n');
  assert.throws(() => captureOfficialPluginPackageV1(f.packageRoot), /account-local authorization/);
});

test("public author metadata survives custody while embedded private keys and literal credential leaves fail", t => {
  const f = fixture(t);
  f.write(join(f.packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", version: "1.0.0",
    author: "Example Author", authors: [{ name: "Second Author" }], mcpServers: { public: { url: "https://fixture.invalid/mcp", auth: "oauth" } } }));
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  f.project();
  assert.equal(JSON.parse(readFileSync(join(f.store.packagePath(ledger.entries[0]!), ".codex-plugin", "plugin.json"), "utf8")).author, "Example Author");
  assert.doesNotThrow(() => assertNonsecretDefinitionJsonV1({ author: "Example Author", apiKey: "${FIXTURE_KEY}" }));
  for (const value of [{ author: "Example Author\n-----BEGIN PRIVATE KEY-----\nsynthetic fixture\n-----END PRIVATE KEY-----" },
    { apiKey: "synthetic-fixture-value" }, { privateKey: "synthetic-fixture-value" }]) {
    assert.throws(() => assertNonsecretDefinitionJsonV1(value), /account-local authorization/);
  }
});

test("signed safe-plus-withheld union projects safe siblings and rejects omissions, fake holds and tampering", t => {
  const f = fixture(t), unsafeRoot = join(f.source, "plugins", "cache", "local", "unsafe", "1.0.0"), unsafeId = "unsafe@local";
  f.write(join(f.source, "config.toml"), '[plugins."plugin@local"]\nenabled=false\n[plugins."unsafe@local"]\nenabled=true\n');
  f.write(join(unsafeRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "unsafe", version: "1.0.0", mcpServers: "./servers.json" }));
  f.write(join(unsafeRoot, "servers.json"), JSON.stringify({ mcpServers: { unsafe: { url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer synthetic-fixture-value" } } } }));
  const reason = sharedPluginWithheldReasonV1(new Error("plugin definition contains account-local authorization"))!;
  assert.throws(() => f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true }), /follow-native/);
  assert.throws(() => f.store.publish({ expected: null, packages: [], withheldPlugins: { [f.candidate.id]: reason, [unsafeId]: reason }, authorize: () => true }), /no longer matches/);
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], withheldPlugins: { [unsafeId]: reason }, authorize: () => true });
  assert.deepEqual(ledger.withheldPlugins, { [unsafeId]: reason });
  assert.deepEqual(ledger.entries.map(entry => entry.id), [f.candidate.id]);
  assert.equal(JSON.stringify(ledger).includes("synthetic-fixture-value"), false);
  assert.equal(readdirSync(join(f.store.root, "packages")).length, 1);
  f.project();
  assert.equal(existsSync(join(f.home, "plugins", "cache", "local", "plugin", "1.0.0", "skills", "tool", "SKILL.md")), true);
  assert.equal(existsSync(join(f.home, "plugins", "cache", "local", "unsafe")), false);
  const headPath = join(f.store.root, "head.v1.json"), head = JSON.parse(readFileSync(headPath, "utf8"));
  head.value.withheldPlugins[unsafeId] = "changed public reason";
  f.write(headPath, JSON.stringify(head));
  assert.throws(() => f.store.read(), /signature/);
});

async function waitForInvalidation(store: SharedPluginLedgerStoreV1, fingerprint: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (store.verifyGeneration(fingerprint) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(store.verifyGeneration(fingerprint), false, "source watch must invalidate the accepted generation");
}

test("queued source notifications require one fresh full proof and continued notifications remain held", async t => {
  const originalWatch = fs.watch, watchers: ReturnType<typeof fs.watch>[] = [];
  const captureWatch = t.mock.method(fs, "watch", (...args: unknown[]) => {
    const watcher = Reflect.apply(originalWatch, fs, args) as ReturnType<typeof fs.watch>;
    watchers.push(watcher); return watcher;
  });
  syncBuiltinESMExports();
  let f: ReturnType<typeof fixture>;
  try { f = fixture(t); } finally { captureWatch.mock.restore(); syncBuiltinESMExports(); }
  let notifications = 1, proofs = 0;
  const originalRead = fs.readdirSync;
  const sourceReads = t.mock.method(fs, "readdirSync", (...args: unknown[]) => {
    const result = Reflect.apply(originalRead, fs, args);
    if (args[0] === join(f.source, "plugins", "cache")) {
      proofs++;
      if (notifications !== 0) {
        if (notifications > 0) notifications--;
        queueMicrotask(() => watchers[0]!.emit("change", "change", "local/plugin/1.0.0/skills/tool/SKILL.md"));
      }
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const snapshot = await f.store.readNativeSnapshot();
    assert.equal(snapshot.plugins[0]!.id, f.candidate.id);
    assert.ok(proofs >= 2, "the invalidated result must receive a fresh full source proof");
    notifications = -1;
    watchers[0]!.emit("change", "change", "local/plugin/1.0.0/skills/tool/SKILL.md");
    await assert.rejects(f.store.readNativeSnapshot(), /revision changed during validation/);
  } finally { sourceReads.mock.restore(); syncBuiltinESMExports(); }
});

for (const change of ["config", "definition", "code", "version"] as const) {
  test(`source ${change} edits invalidate the cheap generation lease`, async t => {
    const f = fixture(t), ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
    await f.store.validateSourceLease(ledger); assert.equal(f.store.verifyGeneration(ledger.fingerprint), true);
    await f.store.validateSourceLease(ledger);
    if (change === "config") f.write(join(f.source, "config.toml"), '[plugins."plugin@local"]\nenabled=true\n');
    if (change === "definition") f.write(join(f.packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", version: "1.0.0", description: "Changed definition" }));
    if (change === "code") f.write(join(f.packageRoot, "skills", "tool", "SKILL.md"), "# Changed code\n");
    if (change === "version") f.write(join(f.source, "plugins", "cache", "local", "plugin", "2.0.0", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", version: "2.0.0" }));
    await waitForInvalidation(f.store, ledger.fingerprint);
    await assert.rejects(f.store.validateSourceLease(ledger), /revision changed/);
  });
}

for (const location of ["plugin-root", "version", "atomic-plugin-root"] as const) {
  test(`local-library ${location} remote marker refresh preserves the verified definition lease`, async t => {
    const f = fixture(t, true), r = remote(f);
    const marker = location === "version" ? join(f.packageRoot, ".codex-remote-plugin-install.json")
      : join(f.packageRoot, "..", ".codex-remote-plugin-install.json");
    const bytes = JSON.stringify({ schema_version: 1, remote_plugin_id: "plugins_real_123" });
    f.write(marker, bytes);
    const ledger = f.store.publish({ expected: null, packages: [{ id: r.candidate.id, version: r.candidate.version, source: r.candidate.source }], authorize: () => true });
    await f.store.validateSourceLease(ledger);
    assert.equal(f.store.verifyGeneration(ledger.fingerprint), true);
    if (location === "atomic-plugin-root") {
      const temporary = join(f.packageRoot, "..", ".tmpF9v3G1");
      f.write(temporary, bytes);
      fs.renameSync(temporary, marker);
    } else f.write(marker, bytes); // Native refresh can rewrite this account-owned marker unchanged.
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    assert.equal((await f.store.readNativeSnapshot()).fingerprint, ledger.sourceSnapshotFingerprint);
    assert.equal(f.store.verifyGeneration(ledger.fingerprint), true, "unchanged native account metadata must not cancel local definition preparation");
    await f.store.projectAsync({ stateRoot: f.stateRoot, account: { opaqueAccountId: f.account, codexHome: f.home },
      authorize: () => true, writeEvidence: { accountChildAbsent: true } });
  });
}

test("local-library version directory removal invalidates the definition lease", async t => {
  const f = fixture(t, true), ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger);
  fs.renameSync(f.packageRoot, join(f.root, "retained-version"));
  await waitForInvalidation(f.store, ledger.fingerprint);
  await assert.rejects(f.store.validateSourceLease(ledger), /revision changed/);
});

test("local-library new version directories invalidate the definition lease", async t => {
  const f = fixture(t, true), ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger);
  f.write(join(f.packageRoot, "..", "2.0.0", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "plugin", version: "2.0.0" }));
  await waitForInvalidation(f.store, ledger.fingerprint);
  await assert.rejects(f.store.validateSourceLease(ledger), /revision changed/);
});

test("canonical remote identity remains checked in local-library leases", async t => {
  const f = fixture(t, true), r = remote(f);
  const ledger = f.store.publish({ expected: null, packages: [r.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger);
  assert.equal(f.store.verifyGeneration(ledger.fingerprint), true);
  f.write(join(f.packageRoot, ".codex-remote-plugin-install.json"), JSON.stringify({ schema_version: 1, remote_plugin_id: "plugins_changed_456" }));
  assert.equal(f.store.verifyGeneration(ledger.fingerprint), false, "a retained remote descriptor must still match its exact native identity");
});

test("ignored native credential and data writes preserve the source lease", async t => {
  const f = fixture(t), ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger);
  f.write(join(f.source, "auth.json"), "synthetic native-only auth");
  f.write(join(f.packageRoot, "auth.json"), "synthetic plugin-only auth");
  f.write(join(f.packageRoot, ".plugin-data", "account.json"), "synthetic private data");
  f.write(join(f.packageRoot, "credentials", "provider.json"), "synthetic private credential");
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  assert.equal(f.store.verifyGeneration(ledger.fingerprint), true);
  assert.equal((await f.store.readNativeSnapshot()).fingerprint, ledger.sourceSnapshotFingerprint);
});

test("cheap signed generation verification never traverses package trees and still checks durable custody", async t => {
  const f = fixture(t), ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger);
  const noTreeReads = t.mock.method(fs, "readdirSync", () => { throw new Error("unexpected package tree traversal"); });
  syncBuiltinESMExports();
  try {
    assert.equal(f.store.verifyGeneration(ledger.fingerprint), true);
    assert.deepEqual(f.store.installedSnapshot(ledger.fingerprint, () => true, () => null, true), { plugins: [], pagination: { next_page_token: null } });
    assert.throws(() => f.store.read(), /unexpected package tree traversal/);
    const generationPath = join(f.store.root, "generations", `${ledger.generation}.json`), generation = JSON.parse(readFileSync(generationPath, "utf8"));
    generation.value.withheldPlugins = { "fake@local": "changed" };
    f.write(generationPath, JSON.stringify(generation));
    assert.equal(f.store.verifyGeneration(ledger.fingerprint), false);
  } finally { noTreeReads.mock.restore(); syncBuiltinESMExports(); }
});

test("second preparation validation reuses the unchanged source proof without native tree reads", async t => {
  const f = fixture(t), ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger);
  const nativeProof = t.mock.method(f.store, "readNativeSnapshot");
  const noTreeReads = t.mock.method(fs, "readdirSync", () => { throw new Error("unexpected native tree traversal during lease reuse"); });
  syncBuiltinESMExports();
  try {
    await f.store.validateSourceLease(ledger);
    assert.equal(nativeProof.mock.callCount(), 0);
    assert.equal(f.store.verifyGeneration(ledger.fingerprint), true);
  } finally { noTreeReads.mock.restore(); nativeProof.mock.restore(); syncBuiltinESMExports(); }
});

test("source drift during publication keeps the uncertain journal and never accepts a head", t => {
  const f = fixture(t); let calls = 0;
  assert.throws(() => f.store.publish({ expected: null, packages: [f.candidate], authorize: () => {
    if (++calls === 2) f.write(join(f.packageRoot, "skills", "tool", "SKILL.md"), "# Source changed during publication\n");
    return true;
  } }), /revision changed/);
  assert.equal(existsSync(join(f.store.root, "publication-intent.v1.json")), true);
  assert.equal(existsSync(join(f.store.root, "head.v1.json")), false);
  assert.throws(() => f.store.read(), /uncertain/);
});

test("store close invalidates generation leases and rejects further source reads", async t => {
  const f = fixture(t), ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger); assert.equal(f.store.verifyGeneration(ledger.fingerprint), true);
  f.store.close(); f.store.close();
  assert.equal(f.store.verifyGeneration(ledger.fingerprint), false);
  await assert.rejects(f.store.readNativeSnapshot(), /closed/);
  assert.throws(() => f.store.read(), /closed/);
});

test("one store owns two watchers and a watcher error revokes its source lease", async t => {
  const originalWatch = fs.watch, watchers: ReturnType<typeof fs.watch>[] = [];
  const captureWatch = t.mock.method(fs, "watch", (...args: unknown[]) => {
    const watcher = Reflect.apply(originalWatch, fs, args) as ReturnType<typeof fs.watch>;
    watchers.push(watcher); return watcher;
  });
  syncBuiltinESMExports();
  let f: ReturnType<typeof fixture>;
  try { f = fixture(t); } finally { captureWatch.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(watchers.length, 2);
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  await f.store.validateSourceLease(ledger);
  await f.store.validateSourceLease(ledger);
  assert.equal(f.store.verifyGeneration(ledger.fingerprint), true);
  assert.equal(watchers.length, 2);
  watchers[0]!.emit("error", new Error("synthetic watcher error"));
  assert.equal(f.store.verifyGeneration(ledger.fingerprint), false);
  await assert.rejects(f.store.validateSourceLease(ledger), /revision changed/);
});

test("public auth keywords, skill names, interfaces and numeric token limits survive definition custody", t => {
  const f = fixture(t), manifest = { name: "plugin", version: "1.0.0", author: "Example Author",
    keywords: ["oauth", "api-key", "auth", "token", "authorization"],
    skills: [{ name: "oauth", interface: { default_prompt: "api-key", capabilities: ["auth", "oauth"] } }],
  };
  const mcp = { mcpServers: { public: { command: "fixture-tool", args: ["--api-key", "${FIXTURE_KEY}"],
    env_http_headers: { Authorization: "FIXTURE_TOKEN", "X-API-Key": "FIXTURE_API_KEY" },
    tools: { js: { output_token_limit: 4_096, token_budget: 100, token_count: 0, max_output_tokens: 200 } },
  } } };
  assert.doesNotThrow(() => assertNonsecretDefinitionJsonV1(manifest));
  assert.doesNotThrow(() => assertNonsecretDefinitionJsonV1(mcp));
  f.write(join(f.packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
  f.write(join(f.packageRoot, ".mcp.json"), JSON.stringify(mcp));
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  assert.equal(ledger.entries.length, 1);
  assert.deepEqual(officialPluginDefinitionBlocksV1(f.source, [f.candidate]), {});
});

test("literal credential assignments and adjacent command values fail while environment references remain public", () => {
  for (const value of ["api-key=synthetic-fixture-value", "--access_token=123", "client_secret=synthetic-fixture-value",
    "Bearer synthetic-fixture-value", "Basic synthetic-fixture-value", { args: ["--api-key", "synthetic-fixture-value"] },
    { args: ["--client-secret", "synthetic-fixture-value"] }, { access_token: 123 }, { client_secret: "synthetic-fixture-value" },
    { tools: { js: { output_token_limit: "synthetic-fixture-value" } } },
    { env_http_headers: { Authorization: "Bearer synthetic-fixture-value" } },
  ]) assert.throws(() => assertNonsecretDefinitionJsonV1(value), /account-local authorization/);
  for (const value of ["oauth", "api-key", "--api-key=${FIXTURE_KEY}", "access_token=$FIXTURE_TOKEN", "Bearer ${FIXTURE_TOKEN}",
    { args: ["--api-key", "${FIXTURE_KEY}", "--client-secret", "$FIXTURE_SECRET"] },
    { headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" } },
    { env_http_headers: { Authorization: "FIXTURE_TOKEN" } },
  ]) assert.doesNotThrow(() => assertNonsecretDefinitionJsonV1(value));
});

test("lease renewal rejects a remote identity changed during native snapshot validation", async t => {
  const f = fixture(t), r = remote(f);
  const ledger = f.store.publish({ expected: null, packages: [r.candidate], authorize: () => true });
  const snapshot = f.store.readNativeSnapshot.bind(f.store);
  f.store.readNativeSnapshot = async () => {
    f.write(join(f.packageRoot, ".codex-remote-plugin-install.json"), JSON.stringify({ schema_version: 1, remote_plugin_id: "plugins_changed_456" }));
    return snapshot();
  };
  await assert.rejects(f.store.validateSourceLease(ledger), /remote identity changed/);
  assert.equal(f.store.verifyGeneration(ledger.fingerprint), false);
});


test("local library uses the sealed manifest version for native execution layout", t => {
  const f = fixture(t, true, "0722921d");
  const ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  f.project();
  const [name, market] = officialLocalPluginIdV1(f.candidate.id).split("@");
  const packageParent = join(f.home, "plugins/cache", market!, name!);
  assert.equal(ledger.entries[0]!.version, "0722921d", "native source identity remains unchanged");
  assert.equal(existsSync(join(packageParent, "1.0.0", "skills/tool/SKILL.md")), true);
  assert.equal(existsSync(join(packageParent, "0722921d")), false);
  const catalogue = JSON.parse(readFileSync(join(f.home, "plugins/cache", market!, ".agents/plugins/marketplace.json"), "utf8"));
  assert.equal(catalogue.plugins[0].source.path, "./plugin/1.0.0");
  f.project();
});

function legacyNativeLayout(t: test.TestContext, second = false) {
  const f = fixture(t, true, "0722921d");
  const secondCandidate = { id: "second@local", version: "1.0.0", source: join(f.source, "plugins/cache/local/second/1.0.0") };
  if (second) {
    f.write(join(f.source, "config.toml"), '[plugins."plugin@local"]\nenabled=false\n[plugins."second@local"]\nenabled=false\n');
    f.write(join(secondCandidate.source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "second", version: "1.0.0" }));
    f.write(join(secondCandidate.source, "skills/tool/SKILL.md"), "# Second skill");
  }
  f.store.publish({ expected: null, packages: second ? [f.candidate, secondCandidate] : [f.candidate], authorize: () => true }); f.project();
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(value);
  const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  const accountRoot = join(f.stateRoot, "accounts", f.account), sharedPath = join(accountRoot, "shared-plugin-projection.v1.json"), genericPath = join(accountRoot, "plugin-projections.v1.json");
  const id = officialLocalPluginIdV1(f.candidate.id), [name, market] = id.split("@"), parent = join(f.home, "plugins/cache", market!, name!);
  const shared = JSON.parse(readFileSync(sharedPath, "utf8")).value, generic = JSON.parse(readFileSync(genericPath, "utf8"));
  const cataloguePath = join(f.home, "plugins/cache", market!, ".agents/plugins/marketplace.json"), catalogue = JSON.parse(readFileSync(cataloguePath, "utf8"));
  catalogue.plugins[0].source.path = "./plugin/0722921d"; f.write(cataloguePath, JSON.stringify(catalogue));
  shared.catalogues[0].digest = digest(catalogue); shared.packages[0].version = "0722921d"; delete shared.layoutPolicy;
  generic.entries[id] = { version: "0722921d", fingerprint: "sha256:" + digest({ id, version: "0722921d", files: captureOfficialPluginPackageV1(join(parent, "1.0.0")).files }) };
  f.write(genericPath, JSON.stringify(generic));
  const legacy = { value: shared, hmac: createHmac("sha256", Buffer.alloc(32, 7)).update("shared-plugin-ledger:v1\0" + canonical(shared)).digest("hex") };
  f.write(sharedPath, JSON.stringify(legacy));
  return { ...f, accountRoot, sharedPath, genericPath, parent, legacy, generic, cataloguePath, secondCandidate };
}

test("local layout adopts an identical native rename and retains signed original receipts", t => {
  const f = legacyNativeLayout(t), inode = lstatSync(join(f.parent, "1.0.0")).ino;
  f.project(); f.project();
  assert.equal(lstatSync(join(f.parent, "1.0.0")).ino, inode, "migration does not rewrite package bytes");
  const next = JSON.parse(readFileSync(f.sharedPath, "utf8")).value;
  assert.equal(next.packages[0].version, "1.0.0"); assert.equal(next.layoutPolicy, "native-manifest-version-v1");
  const directory = join(f.accountRoot, "shared-plugin-layout-migrations"), names = readdirSync(directory);
  assert.equal(names.length, 1);
  const record = JSON.parse(readFileSync(join(directory, names[0]!), "utf8")).value;
  assert.deepEqual(record.context.priorReceipt, f.legacy); assert.deepEqual(record.genericBefore, f.generic);
  assert.equal(JSON.parse(readFileSync(f.cataloguePath, "utf8")).plugins[0].source.path, "./plugin/1.0.0");
});

test("local layout rejects changed bytes, unowned receipts, extra versions, and invalid manifests without writes", t => {
  for (const kind of ["bytes", "unowned", "extra", "manifest"] as const) {
    const f = legacyNativeLayout(t);
    if (kind === "bytes") f.write(join(f.parent, "1.0.0/skills/tool/SKILL.md"), "Changed locally");
    if (kind === "unowned") { const value = JSON.parse(readFileSync(f.genericPath, "utf8")); value.entries = {}; f.write(f.genericPath, JSON.stringify(value)); }
    if (kind === "extra") mkdirSync(join(f.parent, "extra"), { mode: 0o700 });
    if (kind === "manifest") f.write(join(f.parent, "1.0.0/.codex-plugin/plugin.json"), JSON.stringify({ name: "plugin", version: "../unsafe" }));
    const before = [readFileSync(f.sharedPath), readFileSync(f.genericPath), readFileSync(f.cataloguePath)];
    assert.throws(() => f.project());
    assert.deepEqual([readFileSync(f.sharedPath), readFileSync(f.genericPath), readFileSync(f.cataloguePath)], before);
    assert.equal(existsSync(join(f.accountRoot, "shared-plugin-layout-migrations")), false);
  }
});

test("local layout recovers exactly after interruption between receipt publications", t => {
  const f = legacyNativeLayout(t), original = fs.renameSync;
  fs.renameSync = ((from, to) => { if (String(to) === f.sharedPath) throw new Error("fixture receipt interruption"); return original(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(() => f.project(), /fixture receipt interruption/); } finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(JSON.parse(readFileSync(f.sharedPath, "utf8")), f.legacy);
  assert.equal(Object.values(JSON.parse(readFileSync(f.genericPath, "utf8")).entries as Record<string, { version: string }>)[0]!.version, "1.0.0");
  f.project(); assert.equal(JSON.parse(readFileSync(f.sharedPath, "utf8")).value.layoutPolicy, "native-manifest-version-v1");
});

test("local layout authority loss leaves original receipts intact", t => {
  const f = legacyNativeLayout(t), before = [readFileSync(f.sharedPath), readFileSync(f.genericPath)];
  let calls = 0;
  assert.throws(() => f.store.project({ stateRoot: f.stateRoot, account: { opaqueAccountId: f.account, codexHome: f.home },
    writeEvidence: { accountChildAbsent: true, nativeWriterCensus: () => "zero" }, authorize: () => ++calls < 2 }), /authority/);
  assert.deepEqual([readFileSync(f.sharedPath), readFileSync(f.genericPath)], before);
});

test("local execution version rejects a present unsafe version instead of falling back", t => {
  const f = fixture(t, true, "0722921d"); f.write(join(f.packageRoot, ".codex-plugin/plugin.json"), JSON.stringify({ name: "plugin", version: "../escape" }));
  f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  assert.throws(() => f.project(), /unsafe plugin execution version/);
  assert.equal(existsSync(join(f.home, "plugins/cache")), false);
});


test("canonical projection retains source cache version when manifest version differs", t => {
  const f = fixture(t, false, "0722921d");
  f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true }); f.project();
  assert.equal(existsSync(join(f.home, "plugins/cache/local/plugin/0722921d/skills/tool/SKILL.md")), true);
  assert.equal(existsSync(join(f.home, "plugins/cache/local/plugin/1.0.0")), false);
});


test("local layout preflights the complete batch before reconciling any receipt", t => {
  for (const kind of ["manifest", "unowned", "extra"] as const) {
    const f = legacyNativeLayout(t, true), id = officialLocalPluginIdV1("second@local"), [name, market] = id.split("@");
    if (kind === "manifest") {
      f.write(join(f.secondCandidate.source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "second", version: "../unsafe" }));
      f.store.publish({ expected: f.store.read()!.fingerprint, packages: [f.candidate, f.secondCandidate], authorize: () => true });
    }
    if (kind === "unowned") { const value = JSON.parse(readFileSync(f.genericPath, "utf8")); delete value.entries[id]; f.write(f.genericPath, JSON.stringify(value)); }
    if (kind === "extra") mkdirSync(join(f.home, "plugins/cache", market!, name!, "extra"), { mode: 0o700 });
    const before = [readFileSync(f.sharedPath), readFileSync(f.genericPath), readFileSync(f.cataloguePath)];
    assert.throws(() => f.project());
    assert.deepEqual([readFileSync(f.sharedPath), readFileSync(f.genericPath), readFileSync(f.cataloguePath)], before);
    assert.equal(existsSync(join(f.accountRoot, "shared-plugin-layout-migrations")), false);
  }
});


test("startup inventory and hydration share one immutable source proof through lease validation", async t => {
  const f = fixture(t), ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
  const first = await f.store.readNativeSnapshot();
  const expected = structuredClone(first);
  first.plugins.length = 0;
  const noTreeReads = t.mock.method(fs, "readdirSync", () => { throw new Error("duplicate startup source scan"); });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await f.store.readNativeSnapshot(), expected);
    await f.store.validateSourceLease(ledger);
    assert.equal(f.store.verifyGeneration(ledger.fingerprint), true);
  } finally { noTreeReads.mock.restore(); syncBuiltinESMExports(); }
});


for (const change of ["source", "config", "head", "pending"] as const) {
  test(`startup snapshot proof cannot admit changed ${change}`, async t => {
    const f = fixture(t), ledger = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true });
    await f.store.readNativeSnapshot();
    if (change === "source") f.write(join(f.packageRoot, "skills", "tool", "SKILL.md"), "# Changed definition\n");
    if (change === "config") f.write(join(f.source, "config.toml"), '[plugins."plugin@local"]\nenabled=true\n');
    if (change === "head") f.write(join(f.store.root, "head.v1.json"), '{}');
    if (change === "pending") f.write(join(f.store.root, "publication-intent.v1.json"), '{}');
    await assert.rejects(f.store.validateSourceLease(ledger));
    assert.equal(f.store.verifyGeneration(ledger.fingerprint), false);
  });
}

function pendingUnchangedProjection(t: test.TestContext) {
  const f = fixture(t, true);
  const first = f.store.publish({ expected: null, packages: [f.candidate], authorize: () => true }); f.project();
  f.write(join(f.source, "config.toml"), '[plugins."plugin@local"]\nenabled=true\n');
  const ledger = f.store.publish({ expected: first.fingerprint, packages: [f.candidate], authorize: () => true });
  const root = join(f.stateRoot, "accounts", f.account), receipt = join(root, "shared-plugin-projection.v1.json");
  const intentPath = join(root, "shared-plugin-projection-intent.v1.json"), genericPath = join(root, "plugin-projections.v1.json");
  const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : JSON.stringify(value);
  const sign = (value: any) => ({ value, hmac: createHmac("sha256", Buffer.alloc(32, 7)).update("shared-plugin-ledger:v1\0" + canonical(value)).digest("hex") });
  const stat = lstatSync(f.home), prior = readFileSync(receipt), generic = readFileSync(genericPath);
  const intent = { version: 1, account: f.account, home: f.home, identity: `${stat.dev}:${stat.ino}:${stat.uid}`, generation: ledger.generation,
    ledgerFingerprint: ledger.fingerprint, priorReceiptDigest: createHash("sha256").update(canonical(JSON.parse(prior.toString()))).digest("hex"),
    projectionOwner: "12345678-1234-4234-8234-123456789012" };
  f.write(intentPath, JSON.stringify(sign(intent)));
  const intentBytes = readFileSync(intentPath), inode = lstatSync(intentPath).ino, digest = createHash("sha256").update(intentBytes).digest("hex");
  const recoveryRoot = join(root, "shared-plugin-projection-recovery"), archived = join(recoveryRoot, digest + ".intent.json");
  const [name, market] = officialLocalPluginIdV1(f.candidate.id).split("@"), parent = join(f.home, "plugins/cache", market!, name!);
  const input = { stateRoot: f.stateRoot, account: { opaqueAccountId: f.account, codexHome: f.home }, authorize: () => true,
    writeEvidence: { accountChildAbsent: true, nativeWriterCensus: () => "zero" as const, pluginProjectionOwner: "23456789-1234-4234-8234-123456789012" } };
  return { ...f, ledger, root, receipt, intentPath, genericPath, prior, generic, sign, intent, intentBytes, inode, recoveryRoot, archived, parent, market: market!, input };
}

test("pending projection recovery runs in the worker and preserves original signed evidence", async t => {
  const f = pendingUnchangedProjection(t);
  f.write(join(f.parent, ".DS_Store"), "Finder metadata");
  await f.store.validateSourceLease(f.ledger);
  await f.store.projectAsync({ ...f.input, writeEvidence: { accountChildAbsent: true } });
  assert.deepEqual(readFileSync(f.archived), f.intentBytes); assert.equal(lstatSync(f.archived).ino, f.inode);
  assert.equal(existsSync(f.intentPath), false);
  const record = JSON.parse(readFileSync(join(f.recoveryRoot, readdirSync(f.recoveryRoot).find(name => !name.endsWith(".intent.json"))!), "utf8")).value;
  assert.deepEqual(record.priorReceipt, JSON.parse(f.prior.toString()));
  assert.equal(JSON.parse(readFileSync(f.receipt, "utf8")).value.generation, f.ledger.generation);
  assert.deepEqual(readFileSync(f.genericPath), f.generic);
  assert.equal(readFileSync(join(f.parent, ".DS_Store"), "utf8"), "Finder metadata");
  f.project();
});

test("pending projection recovery rejects changed or unowned state without retiring the intent", async t => {
  for (const kind of ["hmac", "generation", "home", "nonce", "prior", "generic", "extra-id", "generic-intent", "transaction", "payload", "catalogue", "extra-version", "finder-link", "owner"] as const) {
    await t.test(kind, t => {
      const f = pendingUnchangedProjection(t);
      if (kind === "hmac") f.write(f.intentPath, JSON.stringify({ ...f.sign(f.intent), hmac: "0".repeat(64) }));
      if (kind === "generation") f.write(f.intentPath, JSON.stringify(f.sign({ ...f.intent, generation: 99 })));
      if (kind === "home") f.write(f.intentPath, JSON.stringify(f.sign({ ...f.intent, home: f.source })));
      if (kind === "nonce") f.write(f.intentPath, JSON.stringify(f.sign({ ...f.intent, projectionOwner: "invalid" })));
      if (kind === "prior") f.write(f.intentPath, JSON.stringify(f.sign({ ...f.intent, priorReceiptDigest: "0".repeat(64) })));
      if (kind === "generic" || kind === "extra-id") {
        const g = JSON.parse(f.generic.toString());
        if (kind === "generic") g.entries[Object.keys(g.entries)[0]!].fingerprint = "sha256:" + "0".repeat(64);
        else g.entries["unowned@local"] = Object.values(g.entries)[0];
        f.write(f.genericPath, JSON.stringify(g));
      }
      if (kind === "generic-intent") f.write(join(f.root, "plugin-projection-intent.v1.json"), "{}");
      if (kind === "transaction") mkdirSync(join(f.home, ".tweakers-plugins-1234567890123456"), { mode: 0o700 });
      if (kind === "payload") f.write(join(f.parent, "1.0.0/skills/tool/SKILL.md"), "Changed");
      if (kind === "catalogue") f.write(join(f.home, "plugins/cache", f.market, ".agents/plugins/marketplace.json"), "{}");
      if (kind === "extra-version") mkdirSync(join(f.parent, "extra"), { mode: 0o700 });
      if (kind === "finder-link") symlinkSync(join(f.parent, "1.0.0"), join(f.parent, ".DS_Store"));
      const before = readFileSync(f.intentPath);
      assert.throws(() => f.store.project(kind === "owner" ? { ...f.input, writeEvidence: { accountChildAbsent: true } } : f.input));
      assert.deepEqual(readFileSync(f.intentPath), before); assert.deepEqual(readFileSync(f.receipt), f.prior);
      assert.equal(existsSync(f.archived), false);
    });
  }
});

test("pending projection recovery retries prepared evidence and preserves prior receipt on cancellation", t => {
  const f = pendingUnchangedProjection(t), rename = fs.renameSync;
  fs.renameSync = ((from, to) => { if (String(to) === f.archived) throw new Error("fixture archive interruption"); return rename(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(() => f.store.project(f.input), /fixture archive interruption/); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(f.intentPath), f.intentBytes); assert.deepEqual(readFileSync(f.receipt), f.prior);
  assert.equal(readdirSync(f.recoveryRoot).length, 1);
  let calls = 0;
  assert.throws(() => f.store.project({ ...f.input, authorize: () => ++calls < 3 }), /changed before archival/);
  assert.equal(existsSync(f.archived), false);
  f.store.project(f.input); assert.deepEqual(readFileSync(f.archived), f.intentBytes);
});

test("pending projection recovery survives interruption after archival before ordinary publication", t => {
  const f = pendingUnchangedProjection(t), rename = fs.renameSync;
  fs.renameSync = ((from, to) => { if (String(to) === f.intentPath) throw new Error("fixture publication interruption"); return rename(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(() => f.store.project(f.input), /fixture publication interruption/); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(f.archived), f.intentBytes); assert.deepEqual(readFileSync(f.receipt), f.prior);
  assert.equal(existsSync(f.intentPath), false);
  f.store.project(f.input);
  assert.equal(JSON.parse(readFileSync(f.receipt, "utf8")).value.generation, f.ledger.generation);
});
