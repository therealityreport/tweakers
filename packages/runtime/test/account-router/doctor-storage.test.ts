import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";
import { routerConfigFingerprint } from "../../src/account-router/config";
import { inspectNativeStorageIdentitiesAtRoot, repairNativeStorageIdentitiesAtRoot } from "../../src/account-router/doctor-storage";
import { nativeHistoryAccountSetFingerprintV1, nativeHistoryAuthIdentityHmacV1, nativeHistoryBindingSafeV1, readAndPreflightNativeHistorySourceStaticV1, signNativeHistorySourceV1 } from "../../src/account-router/native-history";
import { matchesPersistentDirectoryIdentity, nativeVolumeUuid, parsePersistentIdentityGeneration, PERSISTENT_IDENTITIES_FILE, PERSISTENT_IDENTITIES_JOURNAL,
  preparePersistentIdentityGeneration, publishPersistentIdentityGeneration, readPersistentIdentityGeneration, restorePriorPersistentIdentityGeneration,
  type PersistentIdentityGeneration, type PreparedPersistentIdentities } from "../../src/account-router/persistent-directory-identity";
import { prepareNativeEnrollmentIdentityIntentV2, verifyNativeEnrollmentIdentityIntentV2, writeNativeHistoryManagedEnrollmentReceiptV1 } from "../../src/account-router/native-history-extensions";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type OpaqueAccountId, type RouterConfigV3 } from "../../src/account-router/types";

const mac = { skip: process.platform !== "darwin" };
const write = (path: string, value: unknown) => writeFileSync(path, typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 });
const identity = (path: string, drift = false) => { const s = lstatSync(path); return { device: s.dev - (drift ? 2 : 0), inode: s.ino, uid: s.uid, mode: s.mode & 0o7777 }; };
const opaque = (secret: Buffer, raw: string) => `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`).digest("base64url")}` as OpaqueAccountId;
function fixture(t: test.TestContext, drift = true) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "doc-id-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "state"), home = join(temp, "home"), sqlite = join(temp, "sqlite");
  for (const dir of [root, home, sqlite]) mkdirSync(dir, { mode: 0o700 });
  const secret = Buffer.alloc(32, 83), raw = "doctor-storage-fixture", account = opaque(secret, raw);
  const draft = { schemaVersion: 3 as const, mode: "quota_aware" as const, policy: "quota_aware_v2" as const, generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: account,
    accounts: [{ opaqueAccountId: account, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}` as const, label: "Fixture" }], updatedAt: "2026-09-10T12:00:00.000Z" };
  const config: RouterConfigV3 = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  const source = signNativeHistorySourceV1({ version: 1, kind: "account-router-native-history-source", mode: "in_place", protocolFingerprint: config.protocolFingerprint,
    accountSetFingerprint: nativeHistoryAccountSetFingerprintV1([account]), metadataAccountId: account,
    accounts: [{ opaqueAccountId: account, codexHome: home, sqliteHome: sqlite, codexHomeIdentity: identity(home, drift), sqliteHomeIdentity: identity(sqlite, drift), authIdentityHmac: nativeHistoryAuthIdentityHmacV1(raw, secret) }],
    issuedAt: config.updatedAt }, secret);
  write(join(root, "control-secret.v1"), secret); write(join(root, "account-router-config.json"), config); write(join(root, "native-history-source.v1.json"), source);
  write(join(home, "auth.json"), { tokens: { account_id: raw, access_token: "fixture-only" } });
  const verify = () => readAndPreflightNativeHistorySourceStaticV1(root, config, secret).state === "ready";
  return { root, home, sqlite, secret, source, config, account, verify,
    prepare: () => preparePersistentIdentityGeneration({ stateRoot: root, secret, verify, allowLegacyDeviceChange: true }) };
}
function resign(value: PersistentIdentityGeneration, secret: Buffer): PersistentIdentityGeneration {
  const { signature: _signature, ...unsigned } = value;
  return { ...unsigned, signature: `hmac-sha256:${createHmac("sha256", secret).update("native-storage-identities:v2\0").update(JSON.stringify(unsigned)).digest("hex")}` };
}

test("bundled main and standalone modules resolve the same packaged volume identity helper", mac, t => {
  const f = fixture(t), proposal = f.prepare();
  publishPersistentIdentityGeneration(f.root, f.secret, proposal);
  const runtime = join(f.root, "runtime"), native = join(runtime, "native");
  mkdirSync(native, { recursive: true });
  copyFileSync(join(__dirname, "../../../native-host/dist/tweaker_native_host.node"), join(native, "tweaker_native_host.node"));
  for (const relative of ["main.cjs", "account-router/identity.cjs"]) {
    const outfile = join(runtime, relative);
    buildSync({ entryPoints: [join(__dirname, "../../src/account-router/persistent-directory-identity.ts")], outfile,
      bundle: true, platform: "node", format: "cjs" });
    const input = { stateRoot: f.root, path: f.home, expected: f.source.accounts[0]!.codexHomeIdentity,
      authorityFile: "native-history-source.v1.json", accountId: f.account };
    const result = JSON.parse(execFileSync(process.execPath, ["-e", `
      const module = require(process.argv[1]);
      const input = JSON.parse(process.argv[2]);
      console.log(JSON.stringify({ uuid: module.nativeVolumeUuid(input.path),
        matches: module.matchesPersistentDirectoryIdentity({...input, secret: Buffer.alloc(32, 83)}) }));
    `, outfile, JSON.stringify(input)], { encoding: "utf8" }));
    assert.equal(result.uuid, nativeVolumeUuid(f.home));
    assert.equal(result.matches, true);
  }
});

test("Doctor repairs only the changed device number, with original credentials and signed source intact", mac, async t => {
  const f = fixture(t), original = readFileSync(join(f.root, "native-history-source.v1.json")), credentials = readFileSync(join(f.home, "auth.json"));
  assert.deepEqual(readAndPreflightNativeHistorySourceStaticV1(f.root, f.config, f.secret), { state: "invalid", reason: "source_drift" });
  const first = inspectNativeStorageIdentitiesAtRoot(f.root);
  assert.equal(first.state, "repairable"); assert.equal(first.legacyVolumeUnproven, true);
  assert.equal(existsSync(join(f.root, PERSISTENT_IDENTITIES_FILE)), false, "inspection did not create metadata");
  const result = await repairNativeStorageIdentitiesAtRoot(f.root, first.fingerprint);
  assert.equal(result.state, "ready"); assert.equal(f.verify(), true);
  assert.deepEqual(readFileSync(join(f.root, "native-history-source.v1.json")), original);
  assert.deepEqual(readFileSync(join(f.home, "auth.json")), credentials);
  assert.equal(existsSync(join(f.root, PERSISTENT_IDENTITIES_JOURNAL)), false);
});

test("read-only inspection rejects unsafe permissions, replacement paths, and changed authentication", mac, t => {
  const f = fixture(t);
  chmodSync(f.home, 0o777);
  assert.equal(inspectNativeStorageIdentitiesAtRoot(f.root).state, "blocked"); assert.equal(lstatSync(f.home).mode & 0o777, 0o777);
  chmodSync(f.home, 0o700);
  write(join(f.home, "auth.json"), { tokens: { account_id: "different-account" } });
  assert.equal(inspectNativeStorageIdentitiesAtRoot(f.root).reason, "authentication_binding_invalid");
  renameSync(f.sqlite, `${f.sqlite}-retained`); symlinkSync(`${f.sqlite}-retained`, f.sqlite);
  assert.equal(inspectNativeStorageIdentitiesAtRoot(f.root).state, "blocked");
});

test("persistent UUID mismatch and signed-generation tampering fail closed", mac, t => {
  const f = fixture(t), proposal = f.prepare(); publishPersistentIdentityGeneration(f.root, f.secret, proposal);
  const changed = resign({ ...proposal.next, anchors: proposal.next.anchors.map(a => ({ ...a, volumeUuid: "00000000-0000-0000-0000-000000000000" })) }, f.secret);
  write(join(f.root, PERSISTENT_IDENTITIES_FILE), changed);
  assert.equal(f.verify(), false); assert.equal(inspectNativeStorageIdentitiesAtRoot(f.root).state, "blocked");
  changed.signature = `hmac-sha256:${"0".repeat(64)}`;
  write(join(f.root, PERSISTENT_IDENTITIES_FILE), changed);
  assert.equal(inspectNativeStorageIdentitiesAtRoot(f.root).state, "blocked");
});

test("journal bytes are part of consent and malformed journals are never repairable", mac, async t => {
  const f = fixture(t), first = f.prepare(), second = f.prepare();
  write(join(f.root, PERSISTENT_IDENTITIES_JOURNAL), first);
  const report = inspectNativeStorageIdentitiesAtRoot(f.root); assert.equal(report.state, "repairable");
  write(join(f.root, PERSISTENT_IDENTITIES_JOURNAL), second);
  await assert.rejects(repairNativeStorageIdentitiesAtRoot(f.root, report.fingerprint), /evidence changed/);
  assert.equal(existsSync(join(f.root, PERSISTENT_IDENTITIES_FILE)), false);
  write(join(f.root, PERSISTENT_IDENTITIES_JOURNAL), { next: { signature: "invalid" }, priorFingerprint: null });
  assert.equal(inspectNativeStorageIdentitiesAtRoot(f.root).state, "blocked");
});

test("interrupted publication replays its exact generation and rollback restores a coherent predecessor", mac, async t => {
  const f = fixture(t), proposal = f.prepare();
  write(join(f.root, PERSISTENT_IDENTITIES_JOURNAL), proposal);
  const committed = publishPersistentIdentityGeneration(f.root, f.secret, proposal);
  const report = inspectNativeStorageIdentitiesAtRoot(f.root); assert.equal(report.reason, "identity_repair_incomplete");
  await repairNativeStorageIdentitiesAtRoot(f.root, report.fingerprint);
  assert.equal(readPersistentIdentityGeneration(f.root, f.secret)?.fingerprint, committed);
  const next = f.prepare(); publishPersistentIdentityGeneration(f.root, f.secret, next);
  restorePriorPersistentIdentityGeneration(f.root, f.secret, next);
  assert.equal(readPersistentIdentityGeneration(f.root, f.secret)?.fingerprint, committed);
  restorePriorPersistentIdentityGeneration(f.root, f.secret, proposal);
  assert.equal(existsSync(join(f.root, PERSISTENT_IDENTITIES_FILE)), false);
  assert.equal(f.verify(), false, "restored legacy drift remains blocked rather than claiming readiness");
});

test("cached native binding invalidates after generation change and publishers cannot drop prior anchors", mac, t => {
  const f = fixture(t, false), before = readAndPreflightNativeHistorySourceStaticV1(f.root, f.config, f.secret);
  assert.equal(before.state, "ready"); if (before.state !== "ready") return;
  const initial = f.prepare(); publishPersistentIdentityGeneration(f.root, f.secret, initial);
  assert.equal(nativeHistoryBindingSafeV1(before.binding), false);
  const current = readPersistentIdentityGeneration(f.root, f.secret)!.fingerprint;
  const next = f.prepare(); next.next = resign({ ...next.next, anchors: next.next.anchors.slice(0, 1) }, f.secret);
  assert.throws(() => publishPersistentIdentityGeneration(f.root, f.secret, next));
  assert.equal(readPersistentIdentityGeneration(f.root, f.secret)!.fingerprint, current);
  const tooLarge: PreparedPersistentIdentities = { ...f.prepare() };
  tooLarge.next = resign({ ...tooLarge.next, anchors: Array.from({ length: 512 }, (_, i) => ({ ...initial.next.anchors[0]!, path: `/${"x".repeat(800)}/${i}` })) }, f.secret);
  assert.throws(() => publishPersistentIdentityGeneration(f.root, f.secret, tooLarge));
  assert.equal(readPersistentIdentityGeneration(f.root, f.secret)!.fingerprint, current);
});

test("new optional authority can retain exact legacy protection, but a partially anchored authority cannot", mac, t => {
  const f = fixture(t, false); publishPersistentIdentityGeneration(f.root, f.secret, f.prepare());
  const newHome = join(f.root, "optional-home"); mkdirSync(newHome, { mode: 0o700 });
  const input = { stateRoot: f.root, secret: f.secret, path: newHome, expected: identity(newHome), authorityFile: "native-auth-binding.v1.json", accountId: f.account };
  write(join(f.root, input.authorityFile), { fixtureAuthority: true });
  assert.equal(matchesPersistentDirectoryIdentity(input), true);
  const prepared = preparePersistentIdentityGeneration({ stateRoot: f.root, secret: f.secret, verify: () => matchesPersistentDirectoryIdentity(input) });
  publishPersistentIdentityGeneration(f.root, f.secret, prepared);
  const another = join(f.root, "another"); mkdirSync(another, { mode: 0o700 });
  assert.equal(matchesPersistentDirectoryIdentity({ ...input, path: another, expected: identity(another) }), false);
  assert.equal(nativeVolumeUuid(newHome), parsePersistentIdentityGeneration(prepared.next, f.secret).anchors.find(a => a.path === newHome)?.volumeUuid);
});

test("enrollment interruption uses signed original identities after a device renumbering", mac, t => {
  const f = fixture(t, false), raw = "new-enrollment", account = opaque(f.secret, raw);
  const accountRoot = join(f.root, "accounts", account), home = join(accountRoot, "codex-home"), sqlite = join(accountRoot, "sqlite-home");
  mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(sqlite, { mode: 0o700 }); write(join(home, "auth.json"), { tokens: { account_id: raw } });
  const draft = { opaqueAccountId: account, accountRootRelativePath: `accounts/${account}`, codexHomeIdentity: identity(home), sqliteHomeIdentity: identity(sqlite), authIdentityHmac: nativeHistoryAuthIdentityHmacV1(raw, f.secret) as `hmac-sha256:${string}` };
  const intent = prepareNativeEnrollmentIdentityIntentV2({ stateRoot: f.root, secret: f.secret, account: draft, issuedAt: f.config.updatedAt });
  // Model a prior boot's signed device numbers while keeping its volume and file identities.
  intent.account.codexHomeIdentity.device -= 2; intent.account.sqliteHomeIdentity.device -= 2;
  const { signature: _signature, ...unsigned } = intent;
  intent.signature = `hmac-sha256:${createHmac("sha256", f.secret).update("native-enrollment-identities:v2\0" + JSON.stringify(unsigned)).digest("hex")}`;
  verifyNativeEnrollmentIdentityIntentV2(f.root, f.secret, intent);
  const input = { stateRoot: f.root, secret: f.secret, account: intent.account, issuedAt: intent.issuedAt, identityIntent: intent };
  const first = writeNativeHistoryManagedEnrollmentReceiptV1(input), second = writeNativeHistoryManagedEnrollmentReceiptV1(input);
  assert.deepEqual(first, second); assert.equal(first.receipt.codexHomeIdentity.device, intent.account.codexHomeIdentity.device);
  intent.codexVolumeUuid = "00000000-0000-0000-0000-000000000000";
  assert.throws(() => verifyNativeEnrollmentIdentityIntentV2(f.root, f.secret, intent));
});
