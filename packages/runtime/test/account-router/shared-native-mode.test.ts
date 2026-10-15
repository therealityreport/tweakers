import { matchesPersistentDirectoryIdentity, preparePersistentIdentityGeneration, PERSISTENT_IDENTITIES_FILE } from "../../src/account-router/persistent-directory-identity";
import { AccountsBrokerOwnerV1, brokerChildEnvironment } from "../../src/account-router/broker-host";
import { ensureNativeExecutionHomesV1, prepareNativeAuthBindingV1, publishPreparedNativeAuthBindingV1, readNativeAuthBindingV1 } from "../../src/account-router/native-auth-binding";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import workers from "node:worker_threads";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SharedPluginLedgerStoreV1, runSharedPluginProjectionWorkerV1 } from "../../src/account-router/shared-plugin-ledger";
import { join } from "node:path";
import { bootstrapAccountContinuity, DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1 } from "../../src/account-router/account-continuity";
import { nativeHistoryAccountSetFingerprintV1, nativeHistoryAuthIdentityHmacV1, readAndPreflightNativeHistorySourceStaticV1, observeNativeExecutionHomeWritersV1, signNativeHistorySourceV1 } from "../../src/account-router/native-history";
import { routerConfigFingerprint } from "../../src/account-router/config";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT } from "../../src/account-router/types";
import { executeSharedNativeResolverTransitionV1, prepareSharedNativeModeV1, prepareSharedNativeResolverTransitionV1, publishSharedNativeModeV1, readSharedNativeModeV1, SHARED_NATIVE_MODE_FILE_V1 } from "../../src/account-router/shared-native-mode";
import type { OpaqueAccountId, RouterConfigV3 } from "../../src/account-router/types";

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object"
  ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value) + "\n").digest("hex")}` as const;
const sign = <T extends object>(value: T, secret: Buffer, domain: string) => ({ ...value, signature: `hmac-sha256:${createHmac("sha256", secret).update(domain + "\0" + canonical(value)).digest("hex")}` });

function fixture(t: test.TestContext, secondAccount = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stock-protocol-"))); chmodSync(root, 0o700);
  const writable = (path: string): void => { const stat = lstatSync(path); if (stat.isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)); } else if (stat.isFile()) chmodSync(path, 0o600); };
  t.after(() => { writable(root); rmSync(root, { recursive: true, force: true }); });
  const directory = (path: string) => { mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
  const write = (path: string, text: string) => writeFileSync(path, text, { mode: 0o600 });
  const stateRoot = directory(join(root, "state")), nativeHome = directory(join(root, "native")), sqliteHome = directory(join(root, "sqlite"));
  const secret = Buffer.alloc(32, 19), rawAccount = "fixture-source-only";
  const id = `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccount}`).digest("base64url")}` as OpaqueAccountId;
  const otherRaw = "fixture-primary-owned", otherId = `ar_${createHmac("sha256", secret).update(`account-router:v1:${otherRaw}`).digest("base64url")}` as OpaqueAccountId;
  const otherHome = secondAccount ? directory(join(root, "old-owned-home")) : null;
  if (otherHome) write(join(otherHome, "auth.json"), JSON.stringify({ tokens: { account_id: otherRaw, access_token: "fixture-primary-token", refresh_token: "fixture-primary-refresh" } }));
  write(join(nativeHome, "auth.json"), JSON.stringify({ tokens: { account_id: rawAccount } })); write(join(nativeHome, "config.toml"), "# native settings unchanged\n");
  const draft: Omit<RouterConfigV3, "fingerprint"> = { schemaVersion: 3, mode: "quota_aware", policy: "quota_aware_v2", generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: secondAccount ? otherId : id,
    accounts: [id, ...(secondAccount ? [otherId] : [])].map(opaqueAccountId => ({ opaqueAccountId, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` as const, label: "Fixture" })), updatedAt: "2026-10-12T00:00:00.000Z" };
  const config = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  const identity = (path: string) => { const stat = lstatSync(path); return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 }; };
  const source = signNativeHistorySourceV1({ version: 1, kind: "account-router-native-history-source", mode: "in_place", protocolFingerprint: config.protocolFingerprint,
    accountSetFingerprint: nativeHistoryAccountSetFingerprintV1(draft.accounts.map(account => account.opaqueAccountId)), metadataAccountId: id, accounts: [{ opaqueAccountId: id, codexHome: nativeHome, sqliteHome,
      codexHomeIdentity: identity(nativeHome), sqliteHomeIdentity: identity(sqliteHome), authIdentityHmac: nativeHistoryAuthIdentityHmacV1(rawAccount, secret) },
      ...(otherHome ? [{ opaqueAccountId: otherId, codexHome: otherHome, sqliteHome: otherHome, codexHomeIdentity: identity(otherHome), sqliteHomeIdentity: identity(otherHome), authIdentityHmac: nativeHistoryAuthIdentityHmacV1(otherRaw, secret) }] : [])].sort((a, b) => a.opaqueAccountId.localeCompare(b.opaqueAccountId)), issuedAt: "2026-10-12T00:00:00.000Z" }, secret);
  write(join(stateRoot, "native-history-source.v1.json"), JSON.stringify(source));
  const native = readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret); assert.equal(native.state, "ready"); if (native.state !== "ready") throw new Error("fixture binding unavailable");
  const context = { stateRoot, binding: native.binding, secret };
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: id, accounts: source.accounts.map(account => ({ opaqueAccountId: account.opaqueAccountId, codexHome: account.codexHome })), schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  const prepared = prepareSharedNativeModeV1({ ...context, overlayPath: directory(join(stateRoot, "overlay")), expectedSourceFingerprint: native.binding.sourceDocumentFingerprint,
    expectedRebaseIntentFingerprint: null, resolverBinarySha256: "a".repeat(64) }); assert.equal(prepared.state, "prepared"); if (prepared.state !== "prepared") throw new Error("fixture mode preparation unavailable");
  const published = publishSharedNativeModeV1({ ...context, plan: prepared.plan, expectedPlanFingerprint: prepared.fingerprint }); assert.equal(published.state, "published"); if (published.state !== "published") throw new Error("fixture mode publication unavailable");
  context.binding = published.binding;
  return { context, nativeHome, stateRoot, config, id, rawAccount, directory, write, sqliteHome, otherId, otherHome };
}

const repairBinding = { operationId: "fixture-stock-migration", promotionId: "fixture-promotion", journalSha256: "b".repeat(64), priorRepairFingerprint: null,
  appFingerprintSha256: "c".repeat(64), runtimeFingerprintSha256: "d".repeat(64) };

test("historical read is compatible; explicit stock protocol-only CAS exports no custom environment", t => {
  const f = fixture(t), before = readFileSync(join(f.nativeHome, "config.toml"));
  const current = readSharedNativeModeV1(f.context); assert.equal(current.state, "ready"); if (current.state !== "ready") return;
  assert.equal(current.document.resolverProtocol, "shared-native-overlay-v1"); assert.equal(current.environment.TWEAKERS_NATIVE_BASE_ROOT, f.nativeHome);
  assert.equal(prepareSharedNativeResolverTransitionV1({ ...f.context, expectedRegistrationFingerprint: current.fingerprint, resolverBinarySha256: current.document.resolverBinarySha256, repairBinding }).state, "blocked");
  const next = prepareSharedNativeResolverTransitionV1({ ...f.context, expectedRegistrationFingerprint: current.fingerprint, resolverBinarySha256: current.document.resolverBinarySha256,
    resolverProtocol: "official-bundled-v1", repairBinding }); assert.equal(next.state, "prepared"); if (next.state !== "prepared") return;
  const input = { ...f.context, plan: next.plan, expectedPlanFingerprint: next.fingerprint };
  for (const [action, state] of [["begin", "begun"], ["publish", "published"], ["finish", "finished"]] as const) {
    const result = executeSharedNativeResolverTransitionV1({ ...input, action });
    assert.equal(result.state, state, `${action}: ${JSON.stringify(result)}`);
  }
  const stock = readSharedNativeModeV1(f.context); assert.equal(stock.state, "ready"); if (stock.state !== "ready") return;
  assert.equal(stock.document.resolverProtocol, "official-bundled-v1"); assert.deepEqual(stock.environment, {});
  assert.deepEqual(readFileSync(join(f.nativeHome, "config.toml")), before);
});

test("stock CAS rejects signed retirement/source/root drift and stale registration authority", t => {
  const f = fixture(t), current = readSharedNativeModeV1(f.context); assert.equal(current.state, "ready"); if (current.state !== "ready") return;
  const next = prepareSharedNativeResolverTransitionV1({ ...f.context, expectedRegistrationFingerprint: current.fingerprint, resolverBinarySha256: "e".repeat(64), resolverProtocol: "official-bundled-v1", repairBinding });
  assert.equal(next.state, "prepared"); if (next.state !== "prepared") return;
  for (const change of ["retirement", "source", "overlay"] as const) {
    const plan: typeof next.plan = structuredClone(next.plan);
    if (change === "retirement") plan.document.retiredCopyState.priorPluginsFingerprint = `sha256:${"f".repeat(64)}`;
    if (change === "source") plan.document.sourceFingerprint = `sha256:${"f".repeat(64)}`;
    if (change === "overlay") plan.document.overlay.identity.inode++;
    const { signature: _documentSignature, ...document } = plan.document; plan.document = sign(document, f.context.secret, "shared-native-mode:v1");
    const { signature: _planSignature, ...unsigned }: typeof next.plan = plan;
    const changed: typeof next.plan = sign(unsigned, f.context.secret, "shared-native-resolver-transition:v1");
    assert.equal(executeSharedNativeResolverTransitionV1({ ...f.context, plan: changed, expectedPlanFingerprint: digest(changed), action: "begin" }).state, "blocked");
  }
  assert.equal(prepareSharedNativeResolverTransitionV1({ ...f.context, expectedRegistrationFingerprint: `sha256:${"0".repeat(64)}`, resolverBinarySha256: "e".repeat(64), resolverProtocol: "official-bundled-v1", repairBinding }).state, "blocked");
  assert.equal(JSON.parse(readFileSync(join(f.stateRoot, SHARED_NATIVE_MODE_FILE_V1), "utf8")).resolverProtocol, "shared-native-overlay-v1");
});


test("stock child home selection uses only the existing signed execution home and retains native SQLite/history roots", t => {
  const f = fixture(t), home = f.directory(join(f.stateRoot, "accounts", f.id, "execution-home"));
  f.write(join(home, "auth.json"), JSON.stringify({ tokens: { account_id: f.rawAccount, access_token: "fixture-owned-token" } }));
  const proof = prepareNativeAuthBindingV1({ stateRoot: f.stateRoot, config: f.config, secret: f.context.secret,
    expectedSourceFingerprint: f.context.binding.sourceDocumentFingerprint, accounts: [{ opaqueAccountId: f.id, authHome: home }] });
  publishPreparedNativeAuthBindingV1(proof);
  const native = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.config, f.context.secret);
  assert.equal(native.state, "ready"); if (native.state !== "ready") return;
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  Object.assign(host, { stateRoot: f.stateRoot, nativeHistory: native.binding,
    nativeAccountBinding: (account: string) => native.binding.accounts.find(entry => entry.opaqueAccountId === account) });
  const before = readFileSync(join(f.nativeHome, "config.toml")), authBefore = readFileSync(join(home, "auth.json"));
  const selected = host.officialExecutionHome(f.id);
  assert.equal(selected, home);
  const environment = brokerChildEnvironment(selected, f.sqliteHome, { PATH: "/usr/bin", HOME: "/fixture" });
  assert.equal(environment.CODEX_HOME, home); assert.equal(environment.CODEX_SQLITE_HOME, f.sqliteHome);
  assert.equal(environment.TWEAKERS_NATIVE_BASE_ROOT, undefined); assert.equal(environment.TWEAKERS_OVERLAY_ROOT, undefined);
  assert.equal(native.binding.accounts[0]!.codexHome, f.nativeHome);
  assert.deepEqual(readFileSync(join(f.nativeHome, "config.toml")), before);
  assert.deepEqual(readFileSync(join(home, "auth.json")), authBefore);
  host.isolatedAuthHome = () => f.nativeHome;
  assert.throws(() => host.officialExecutionHome(f.id), /signed account execution-home is missing or invalid/);
});

function partialExecutionHomes(t: test.TestContext) {
  const f = fixture(t, true), home = f.directory(join(f.stateRoot, "accounts", f.id, "execution-home"));
  f.write(join(home, "auth.json"), JSON.stringify({ tokens: { account_id: f.rawAccount, access_token: "fixture-source-token" } }));
  publishPreparedNativeAuthBindingV1(prepareNativeAuthBindingV1({ stateRoot: f.stateRoot, config: f.config, secret: f.context.secret,
    expectedSourceFingerprint: f.context.binding.sourceDocumentFingerprint, accounts: [{ opaqueAccountId: f.id, authHome: home }] }));
  const original = readFileSync(join(f.stateRoot, "native-auth-binding.v1.json"));
  const source = readFileSync(join(f.stateRoot, "native-history-source.v1.json"));
  const primaryAuth = readFileSync(join(f.otherHome!, "auth.json")), sourceAuth = readFileSync(join(home, "auth.json"));
  const migrate = (authorizeCopy: (account: OpaqueAccountId) => boolean) => ensureNativeExecutionHomesV1({
    stateRoot: f.stateRoot, config: f.config, secret: f.context.secret, authorizeCopy });
  return { ...f, home, original, source, primaryAuth, sourceAuth, migrate };
}

test("partial stock migration completes the primary account without replacing registration or other sign-ins", t => {
  const f = partialExecutionHomes(t);
  const before = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.config, f.context.secret);
  assert.equal(before.state, "ready"); if (before.state !== "ready") return;
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  Object.assign(host, { stateRoot: f.stateRoot, nativeHistory: before.binding,
    nativeAccountBinding: (account: string) => host.nativeHistory.accounts.find((entry: { opaqueAccountId: string }) => entry.opaqueAccountId === account) });
  assert.throws(() => host.officialExecutionHome(f.otherId), /execution-home is missing or invalid/);
  f.migrate(account => account === f.otherId);
  const after = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.config, f.context.secret);
  assert.equal(after.state, "ready"); if (after.state !== "ready") return;
  host.nativeHistory = after.binding;
  const primaryHome = join(f.stateRoot, "accounts", f.otherId, "execution-home");
  assert.equal(host.officialExecutionHome(f.otherId), primaryHome);
  assert.equal(host.officialExecutionHome(f.id), f.home);
  assert.deepEqual(readFileSync(join(primaryHome, "auth.json")), f.primaryAuth);
  assert.deepEqual(readFileSync(join(f.otherHome!, "auth.json")), f.primaryAuth);
  assert.deepEqual(readFileSync(join(f.home, "auth.json")), f.sourceAuth);
  assert.deepEqual(readFileSync(join(f.stateRoot, "native-auth-binding.v1.json")), f.original);
  assert.deepEqual(readFileSync(join(f.stateRoot, "native-history-source.v1.json")), f.source);
  const binding = readNativeAuthBindingV1(f.stateRoot, after.binding.source, f.context.secret)!;
  assert.equal(binding.document.accounts.length, 1, "original signed document remains intact");
  assert.equal(binding.accounts.length, 2, "effective authority includes both original accounts");
  f.migrate(() => { throw new Error("unchanged migration must not copy or require account idleness"); });
  const receipt = join(f.stateRoot, "accounts", f.otherId, "native-execution-home.v1", "native-execution-home.v1.json");
  const tampered = JSON.parse(readFileSync(receipt, "utf8")); tampered.entry.authHome = f.home;
  f.write(receipt, JSON.stringify(tampered));
  assert.equal(readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.config, f.context.secret).state, "invalid");
});

test("partial stock migration holds active accounts and retains changed unregistered data", t => {
  const f = partialExecutionHomes(t), accountRoot = join(f.stateRoot, "accounts", f.otherId);
  assert.throws(() => f.migrate(() => false), /requires its original account and destination to be idle/);
  assert.equal(existsSync(join(accountRoot, "execution-home")), false);
  const home = f.directory(join(accountRoot, "execution-home"));
  f.write(join(home, "auth.json"), "unrelated retained data");
  assert.throws(() => f.migrate(() => true), /authentication changed; retain it for recovery/);
  assert.equal(readFileSync(join(home, "auth.json"), "utf8"), "unrelated retained data");
  assert.equal(existsSync(join(accountRoot, "native-execution-home.v1", "native-execution-home.v1.json")), false);
  assert.deepEqual(readFileSync(join(f.stateRoot, "native-auth-binding.v1.json")), f.original);
});


test("partial stock migration ignores interrupted private staging and publishes single-link complete files", t => {
  const f = partialExecutionHomes(t), root = f.directory(join(f.stateRoot, "accounts", f.otherId));
  const home = f.directory(join(root, "execution-home"));
  const interrupted = f.directory(join(root, ".execution-home-" + "a".repeat(32) + ".staging"));
  f.write(join(interrupted, "auth.json"), "{partial");
  const receiptStage = f.directory(join(root, "native-execution-home.v1." + "b".repeat(32) + ".staging"));
  f.write(join(receiptStage, "native-execution-home.v1.json"), "");
  f.migrate(() => true);
  assert.deepEqual(readFileSync(join(home, "auth.json")), f.primaryAuth);
  assert.equal(lstatSync(join(home, "auth.json")).nlink, 1);
  assert.equal(lstatSync(join(root, "native-execution-home.v1", "native-execution-home.v1.json")).nlink, 1);
  assert.equal(readFileSync(join(interrupted, "auth.json"), "utf8"), "{partial", "interrupted evidence retained");
  assert.equal(readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.config, f.context.secret).state, "ready");
});

test("partial stock migration separately fences an unpublished destination writer", t => {
  const f = partialExecutionHomes(t), current = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.config, f.context.secret);
  assert.equal(current.state, "ready"); if (current.state !== "ready") return;
  const destination = join(f.stateRoot, "accounts", f.otherId, "execution-home");
  const spawn = ((command: string) => ({ status: 0, signal: null, stderr: "", stdout: command === "/bin/ps"
    ? `  701     1 ${"/usr/bin/node".padEnd(16, " ")} /usr/bin/node fixture-writer\n`
    : `p701\nf3\nau\nn${destination}/auth.json\n` })) as any;
  assert.deepEqual(observeNativeExecutionHomeWritersV1(current.binding, f.otherId, destination, { spawn }),
    { ok: false, reason: "foreign_writer", foreignPids: [701] });
  assert.equal(observeNativeExecutionHomeWritersV1(current.binding, f.otherId, f.nativeHome, { spawn }).ok, false);
});


test("root authority keeps legacy v2 fingerprints while validating signed protocol and root fields", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stock-root-authority-"))); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const overlay = join(root, "overlay"); mkdirSync(overlay, { mode: 0o700 });
  const stat = lstatSync(overlay), identity = { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
  const account = `ar_${"a".repeat(43)}`, secret = Buffer.alloc(32, 31);
  const unsigned = { version: 1, kind: "account-router-shared-native-mode", sourceFingerprint: `sha256:${"b".repeat(64)}`, sourceAccountId: account,
    nativeBase: { path: "/fixture-native-base", identity }, overlay: { path: overlay, identity }, resolverProtocol: "shared-native-overlay-v1", resolverBinarySha256: "c".repeat(64),
    retiredCopyState: { priorSharedFingerprint: `sha256:${"d".repeat(64)}`, priorPluginsFingerprint: `sha256:${"e".repeat(64)}`, abortedRebaseFingerprint: null } };
  const modePath = join(root, SHARED_NATIVE_MODE_FILE_V1);
  const publishFixture = (value: typeof unsigned) => writeFileSync(modePath, JSON.stringify(sign(value, secret, "shared-native-mode:v1")), { mode: 0o600 });
  const capture = (expected = identity) => preparePersistentIdentityGeneration({ stateRoot: root, secret,
    volumeUuid: () => "11111111-1111-1111-1111-111111111111",
    verify: () => matchesPersistentDirectoryIdentity({ stateRoot: root, secret, path: overlay, expected, authorityFile: SHARED_NATIVE_MODE_FILE_V1, accountId: account }) });
  const { resolverBinarySha256: _oldResolver, ...oldRootAuthority } = unsigned;
  const historicalFingerprint = `sha256:${createHash("sha256").update("shared-native-root-authority:v2\0" + canonical(oldRootAuthority)).digest("hex")}`;
  publishFixture(unsigned);
  const legacyProposal = capture();
  const legacy = legacyProposal.next.anchors[0]!;
  assert.equal(legacy.authorityFingerprint, historicalFingerprint);
  // Existing signed companion fixture: the test volume UUID seam lets this
  // regression exercise published-anchor behavior on every platform.
  const companionPath = join(root, PERSISTENT_IDENTITIES_FILE);
  writeFileSync(companionPath, JSON.stringify(legacyProposal.next), { mode: 0o600 });
  const legacyCompanionBytes = readFileSync(companionPath);
  publishFixture({ ...unsigned, resolverProtocol: "official-bundled-v1" });
  const stock = capture().next.anchors[0]!;
  assert.equal(stock.authorityFingerprint, historicalFingerprint);
  assert.equal(stock.documentFingerprint, legacy.documentFingerprint, "historical anchor evidence is retained unchanged");
  assert.notEqual(`sha256:${createHash("sha256").update(readFileSync(modePath)).digest("hex")}`, legacy.documentFingerprint,
    "the new full signed protocol document has its own distinct audit digest");
  assert.deepEqual(readFileSync(companionPath), legacyCompanionBytes);
  publishFixture({ ...unsigned, resolverProtocol: "future-protocol" });
  assert.throws(() => capture(), /persistent storage identity unavailable/);
  publishFixture({ ...unsigned, overlay: { ...unsigned.overlay, identity: { ...identity, inode: identity.inode + 1 } } });
  assert.throws(() => capture(), /persistent storage identity unavailable/, "signed root identity drift cannot reuse historical anchors");
  assert.throws(() => capture({ ...identity, inode: identity.inode + 1 }), /persistent storage identity unavailable/);
});


test("owned plugin publication must not cancel its preparation session", async t => {
  const f = fixture(t, true), home = f.directory(join(f.stateRoot, "accounts", f.id, "execution-home"));
  f.write(join(home, "auth.json"), JSON.stringify({ tokens: { account_id: f.rawAccount, access_token: "fixture-owned-token" } }));
  publishPreparedNativeAuthBindingV1(prepareNativeAuthBindingV1({ stateRoot: f.stateRoot, config: f.config, secret: f.context.secret,
    expectedSourceFingerprint: f.context.binding.sourceDocumentFingerprint, accounts: [{ opaqueAccountId: f.id, authHome: home }] }));
  const native = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.config, f.context.secret);
  assert.equal(native.state, "ready"); if (native.state !== "ready") return; f.context.binding = native.binding;
  const current = readSharedNativeModeV1(f.context); assert.equal(current.state, "ready"); if (current.state !== "ready") return;
  const next = prepareSharedNativeResolverTransitionV1({ ...f.context, expectedRegistrationFingerprint: current.fingerprint,
    resolverBinarySha256: current.document.resolverBinarySha256, resolverProtocol: "official-bundled-v1", repairBinding });
  assert.equal(next.state, "prepared"); if (next.state !== "prepared") return;
  for (const action of ["begin", "publish", "finish"] as const) executeSharedNativeResolverTransitionV1({ ...f.context, plan: next.plan, expectedPlanFingerprint: next.fingerprint, action });
  const packageRoot = f.directory(join(f.nativeHome, "plugins/cache/local/plugin/1.0.0"));
  f.directory(join(packageRoot, ".codex-plugin")); f.write(join(packageRoot, ".codex-plugin/plugin.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
  f.write(join(f.nativeHome, "config.toml"), '[plugins."plugin@local"]\nenabled=true\n');
  const mode = readSharedNativeModeV1(f.context); assert.equal(mode.state, "ready"); if (mode.state !== "ready") return;
  const store = new SharedPluginLedgerStoreV1({ root: f.directory(join(f.stateRoot, "library")), sourceHome: f.nativeHome, secret: Buffer.from(f.context.secret), localLibrary: true,
    authority: { sourceAccountId: f.id, sourceRootIdentity: "fixture-source", modeFingerprint: mode.fingerprint } });
  t.after(() => store.close());
  const ledger = store.publish({ expected: null, packages: [{ id: "plugin@local", version: "1.0.0", source: packageRoot }], authorize: () => true });
  await store.validateSourceLease(ledger);
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  Object.assign(host, { stateRoot: f.stateRoot, nativeHistory: native.binding, secret: f.context.secret, closed: false,
    officialPluginLedger: store, officialPluginSessionNonces: new Map([[f.id, "fixture-session"]]), officialPluginServices: new Map(), officialPluginServiceChildren: new WeakMap(), children: new Map() });
  assert.ok(host.officialPluginSession(f.id));
  const intent = join(f.stateRoot, "accounts", f.id, "plugin-projection-intent.v1.json"), originalRename = fs.renameSync;
  let observed = 0, authoritySurvived = true, modeReason: unknown, retainedMarker = "", workerError: unknown;
  const probe = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    const result = originalRename(...args);
    if (String(args[1]) === intent) {
      observed++; assert.equal(store.verifyGeneration(ledger.fingerprint), true, "the source lease stays valid at the real publication boundary");
      assert.equal(host.officialPluginSession(f.id), null, "ordinary service/HTTP authority stays strict");
      authoritySurvived = host.officialPluginSession(f.id, true) !== null;
      modeReason = readSharedNativeModeV1(f.context);
      retainedMarker = readFileSync(intent, "utf8");
      const marker = JSON.parse(retainedMarker);
      f.write(intent, JSON.stringify({ ...marker, projectionOwner: "foreign-owner" }));
      assert.equal(host.officialPluginSession(f.id, true), null, "another writer cannot borrow the active allowance");
      f.write(intent, retainedMarker);
      const other = join(f.directory(join(f.stateRoot, "accounts", f.otherId)), "plugin-projection-intent.v1.json");
      f.write(other, "{}");
      assert.equal(host.officialPluginSession(f.id, true), null, "another account remains blocked");
      fs.unlinkSync(other);
      assert.ok(host.officialPluginSession(f.id, true));
      const sharedIntent = join(f.stateRoot, "accounts", f.id, "shared-plugin-projection-intent.v1.json");
      const signedBytes = readFileSync(sharedIntent, "utf8");
      const originalOwnership = store.ownsPendingProjection.bind(store);
      const retireDuringValidation = t.mock.method(store, "ownsPendingProjection", (root: string, account: string) => {
        originalUnlink(intent); originalUnlink(sharedIntent);
        return originalOwnership(root, account);
      });
      try { assert.ok(host.officialPluginSession(f.id, true), "completed cleanup between presence and ownership checks cannot cancel preparation"); }
      finally { retireDuringValidation.mock.restore(); f.write(sharedIntent, signedBytes); f.write(intent, retainedMarker); }

    }
    return result;
  });
  const originalUnlink = fs.unlinkSync;
  let observedCleanup = 0;
  const cleanupProbe = t.mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => {
    if (String(args[0]) === intent) {
      observedCleanup++;
      assert.equal(host.officialPluginSession(f.id), null);
      assert.ok(host.officialPluginSession(f.id, true), "the owned marker remains valid after transaction cleanup and before retirement");
    }
    return originalUnlink(...args);
  });
  // Keep actual worker entry/projection and publication code, but execute this
  // one worker in-process so the journal boundary is deterministic to inspect.
  const worker = t.mock.method(workers, "Worker", class extends EventEmitter {
    stdout = new PassThrough(); stderr = new PassThrough();
    constructor(_code: string, options: { workerData: Parameters<typeof runSharedPluginProjectionWorkerV1>[0] }) {
      super(); queueMicrotask(() => { void runSharedPluginProjectionWorkerV1(options.workerData).then(() => {
        this.emit("message", { ok: true }); this.emit("exit", 0);
      }, error => { workerError = error; this.emit("error", error); this.emit("exit", 1); }); });
    }
  } as any);
  syncBuiltinESMExports();
  try { await store.projectAsync({ stateRoot: f.stateRoot, account: { opaqueAccountId: f.id, codexHome: home }, authorize: () => host.officialPluginSession(f.id, true) !== null, writeEvidence: { accountChildAbsent: true } }); }
  finally { probe.mock.restore(); cleanupProbe.mock.restore(); worker.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(workerError, undefined);
  assert.equal(observedCleanup, 1);
  assert.equal(observed, 1, "exercise the actual generic journal publication");
  assert.equal(authoritySurvived, true, JSON.stringify(modeReason));
  assert.ok(host.officialPluginSession(f.id), "strict authority returns once the generic marker is retired");
  f.write(intent, retainedMarker);
  assert.equal(store.ownsPendingProjection(f.stateRoot, f.id), false, "worker exit revokes ownership");
  assert.equal(host.officialPluginSession(f.id), null);
  assert.equal(host.officialPluginSession(f.id, true), null, "retained journals cannot revive an expired worker lease");
});
