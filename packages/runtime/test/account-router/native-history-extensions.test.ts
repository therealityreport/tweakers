import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { routerConfigFingerprint } from "../../src/account-router/config";
import {
  accountStorageBindingV2,
  nativeHistoryDocumentFingerprintV1,
  prepareNativeHistoryExtensionUpdateV1,
  preflightNativeHistoryExtensionsV1,
  publishPreparedNativeHistoryExtensionUpdateV1,
  recoverNativeHistoryExtensionUpdateV1,
  signNativeHistoryExtensionsV1,
  validateNativeHistoryManagedEnrollmentReceiptV1,
  writeNativeHistoryManagedEnrollmentReceiptV1,
  type NativeHistoryManagedAccountDraftV1,
  type NativeHistoryManagedAccountV1,
} from "../../src/account-router/native-history-extensions";
import {
  nativeHistoryAccountSourceForV1,
  nativeHistoryAccountSetFingerprintV1,
  nativeHistoryAuthIdentityHmacV1,
  nativeHistoryBindingSafeV1,
  observeNativeAccountWritersV1,
  observeNativeAccountOperationWritersV1,
  observeNativeThreadWriterV1,
  readAndPreflightNativeHistorySourceStaticV1,
  signNativeHistorySourceV1,
  type NativeHistoryDirectoryIdentityV1,
  type NativeHistorySourceV1,
} from "../../src/account-router/native-history";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type OpaqueAccountId, type RouterConfigV3 } from "../../src/account-router/types";

interface Fixture {
  stateRoot: string;
  secret: Buffer;
  source: NativeHistorySourceV1;
  sourceBytes: Buffer;
  sourceFingerprint: `sha256:${string}`;
  base: RouterConfigV3;
  next: RouterConfigV3;
  managed: NativeHistoryManagedAccountV1;
}

function privateWrite(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function identity(path: string): NativeHistoryDirectoryIdentityV1 {
  const stat = lstatSync(path);
  return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}

function opaque(secret: Buffer, raw: string): OpaqueAccountId {
  return `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`, "utf8").digest("base64url")}` as OpaqueAccountId;
}

function config(accounts: readonly OpaqueAccountId[], generation: number): RouterConfigV3 {
  const withoutFingerprint: Omit<RouterConfigV3, "fingerprint"> = {
    schemaVersion: 3,
    mode: "quota_aware",
    policy: "quota_aware_v2",
    generation,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: accounts[0]!,
    accounts: accounts.map((opaqueAccountId, index) => ({
      opaqueAccountId,
      included: true,
      weight: 1,
      capabilityFingerprint: `sha256:${String.fromCharCode(97 + index).repeat(64)}` as `sha256:${string}`,
      label: `Account ${index + 1}`,
    })),
    updatedAt: `2026-09-05T12:00:0${generation}.000Z`,
  };
  return { ...withoutFingerprint, fingerprint: routerConfigFingerprint(withoutFingerprint) };
}

function censusResult(stdout: string): ReturnType<typeof spawnSync> {
  return { status: 0, signal: null, stdout, stderr: "" } as ReturnType<typeof spawnSync>;
}

function psRow(pid: number, ppid: number, comm: string, command: string): string {
  return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${comm.slice(0, 16).padEnd(16, " ")} ${command}`;
}

function nativeCensusDependencies(ps: string, lsof: string) {
  return {
    spawn: ((command: string) => {
      if (command === "/bin/ps") return censusResult(ps);
      if (command === "/usr/sbin/lsof") return censusResult(lsof);
      throw new Error(`unexpected census command ${command}`);
    }) as unknown as typeof spawnSync,
    uid: () => 501,
  };
}

function managedAccount(stateRoot: string, secret: Buffer, raw: string): NativeHistoryManagedAccountDraftV1 & { opaqueAccountId: OpaqueAccountId } {
  const opaqueAccountId = opaque(secret, raw);
  const accountRoot = privateDirectory(join(stateRoot, "accounts", opaqueAccountId));
  const codexHome = privateDirectory(join(accountRoot, "codex-home"));
  const sqliteHome = privateDirectory(join(accountRoot, "sqlite-home"));
  privateWrite(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: raw, refresh_token: "fixture-only" } }));
  return {
    opaqueAccountId,
    accountRootRelativePath: `accounts/${opaqueAccountId}`,
    codexHomeIdentity: identity(codexHome),
    sqliteHomeIdentity: identity(sqliteHome),
    authIdentityHmac: nativeHistoryAuthIdentityHmacV1(raw, secret) as `hmac-sha256:${string}`,
  };
}

function fixture(): Fixture {
  const stateRoot = privateDirectory(mkdtempSync(join(tmpdir(), "native-history-extensions-")));
  const externalRoot = privateDirectory(mkdtempSync(join(tmpdir(), "native-history-extensions-external-")));
  privateDirectory(join(stateRoot, "accounts"));
  const secret = Buffer.alloc(32, 97);
  const rawExternal = "native-extension-external";
  const external = opaque(secret, rawExternal);
  const codexHome = privateDirectory(join(externalRoot, "codex-home"));
  const sqliteHome = privateDirectory(join(externalRoot, "sqlite-home"));
  privateWrite(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: rawExternal, refresh_token: "fixture-only" } }));
  const base = config([external], 1);
  const source = signNativeHistorySourceV1({
    version: 1,
    kind: "account-router-native-history-source",
    mode: "in_place",
    protocolFingerprint: base.protocolFingerprint,
    accountSetFingerprint: nativeHistoryAccountSetFingerprintV1([external]),
    metadataAccountId: external,
    accounts: [{
      opaqueAccountId: external,
      codexHome,
      sqliteHome,
      codexHomeIdentity: identity(codexHome),
      sqliteHomeIdentity: identity(sqliteHome),
      authIdentityHmac: nativeHistoryAuthIdentityHmacV1(rawExternal, secret),
    }],
    issuedAt: "2026-09-05T12:00:00.000Z",
  }, secret);
  const sourceBytes = Buffer.from(`${JSON.stringify(source)}\n`, "utf8");
  privateWrite(join(stateRoot, "native-history-source.v1.json"), sourceBytes);
  const managedDraft = managedAccount(stateRoot, secret, "managed-enrollment-account");
  const receipt = writeNativeHistoryManagedEnrollmentReceiptV1({
    stateRoot,
    secret,
    account: managedDraft,
    issuedAt: "2026-09-05T12:01:00.000Z",
  });
  const managed: NativeHistoryManagedAccountV1 = { ...managedDraft, enrollmentReceiptFingerprint: receipt.enrollmentReceiptFingerprint };
  return {
    stateRoot,
    secret,
    source,
    sourceBytes,
    sourceFingerprint: nativeHistoryDocumentFingerprintV1(sourceBytes),
    base,
    next: config([external, managed.opaqueAccountId], 2),
    managed,
  };
}

test("a manager-local enrollment extension preserves the source bytes and binds the effective union", () => {
  const f = fixture();
  const before = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.base, f.secret);
  assert.equal(before.state, "ready");
  const prepared = prepareNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    managedAccount: f.managed,
    issuedAt: "2026-09-05T12:02:00.000Z",
  });
  assert.equal(recoverNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    prior: prepared.prior,
    next: prepared.next,
  }).state, "prior");
  publishPreparedNativeHistoryExtensionUpdateV1({ stateRoot: f.stateRoot, secret: f.secret, prior: prepared.prior, next: prepared.next });
  assert.deepEqual(readFileSync(join(f.stateRoot, "native-history-source.v1.json")), f.sourceBytes, "enrollment never rewrites or reformats the signed source");
  const extensionBytes = readFileSync(join(f.stateRoot, "native-history-extensions.v1.json"), "utf8");
  assert.equal(extensionBytes.includes("managed-enrollment-account"), false, "the signed extension never stores a raw account identity");
  assert.equal(extensionBytes.includes("fixture-only"), false, "the signed extension never stores auth material");
  const after = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.next, f.secret);
  assert.equal(after.state, "ready");
  if (after.state !== "ready") return;
  assert.equal(after.binding.source.metadataAccountId, f.base.primaryOpaqueAccountId, "metadata authority remains in the original source");
  assert.deepEqual(after.binding.accounts.map((account) => account.opaqueAccountId), [f.base.primaryOpaqueAccountId, f.managed.opaqueAccountId].sort());
  const binding = accountStorageBindingV2(after.binding, f.managed.opaqueAccountId);
  assert.deepEqual(binding, {
    kind: "managed_adopted",
    accountRoot: join(f.stateRoot, "accounts", f.managed.opaqueAccountId),
    enrollmentReceiptFingerprint: f.managed.enrollmentReceiptFingerprint,
  });
  assert.equal(nativeHistoryAccountSourceForV1(after.binding, f.managed.opaqueAccountId), null, "external-only operations cannot accidentally claim an adopted home");
  assert.equal(nativeHistoryBindingSafeV1(after.binding), true);
  assert.equal(recoverNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    prior: prepared.prior,
    next: prepared.next,
  }).state, "next");
});

test("receipt and source-byte drift fail closed without accepting a config-only account", () => {
  const f = fixture();
  const preflight = preflightNativeHistoryExtensionsV1({
    stateRoot: f.stateRoot,
    config: f.next,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
  });
  assert.deepEqual(preflight, { state: "invalid", reason: "missing_extensions" }, "the router cannot gain an account before a signed extension exists");
  const prepared = prepareNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    managedAccount: f.managed,
    issuedAt: "2026-09-05T12:02:00.000Z",
  });
  publishPreparedNativeHistoryExtensionUpdateV1({ stateRoot: f.stateRoot, secret: f.secret, prior: prepared.prior, next: prepared.next });
  const bound = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.next, f.secret);
  assert.equal(bound.state, "ready");
  if (bound.state !== "ready") return;
  const receiptPath = join(f.stateRoot, "accounts", f.managed.opaqueAccountId, "native-history-enrollment-receipt.v1.json");
  privateWrite(receiptPath, `${readFileSync(receiptPath, "utf8").replace("managed-enrollment-account", "changed-account")}\n`);
  assert.equal(validateNativeHistoryManagedEnrollmentReceiptV1({ stateRoot: f.stateRoot, secret: f.secret, account: f.managed }), null);
  assert.equal(nativeHistoryBindingSafeV1(bound.binding), false, "a receipt rewrite invalidates a live binding");
});

test("a byte-preserving source binding rejects a harmless-looking source reserialization", () => {
  const f = fixture();
  const prepared = prepareNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    managedAccount: f.managed,
    issuedAt: "2026-09-05T12:02:00.000Z",
  });
  publishPreparedNativeHistoryExtensionUpdateV1({ stateRoot: f.stateRoot, secret: f.secret, prior: prepared.prior, next: prepared.next });
  const bound = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.next, f.secret);
  assert.equal(bound.state, "ready");
  if (bound.state !== "ready") return;
  privateWrite(join(f.stateRoot, "native-history-source.v1.json"), `${JSON.stringify(f.source, null, 2)}\n`);
  assert.equal(nativeHistoryBindingSafeV1(bound.binding), false, "the extension is tied to exact source bytes, not merely equivalent JSON");
  assert.deepEqual(readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.next, f.secret), { state: "invalid", reason: "invalid_extensions" });
});

test("a signed prior extension may retain its original raw formatting during later recovery", () => {
  const f = fixture();
  const first = prepareNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    managedAccount: f.managed,
    issuedAt: "2026-09-05T12:02:00.000Z",
  });
  publishPreparedNativeHistoryExtensionUpdateV1({ stateRoot: f.stateRoot, secret: f.secret, prior: first.prior, next: first.next });
  // Extensions are signed canonically, so whitespace is not an authority
  // boundary. Their journal proof still tracks the exact current bytes.
  const extensionPath = join(f.stateRoot, "native-history-extensions.v1.json");
  privateWrite(extensionPath, `${JSON.stringify(first.next.document, null, 2)}\n`);
  const secondDraft = managedAccount(f.stateRoot, f.secret, "managed-enrollment-account-2");
  const secondReceipt = writeNativeHistoryManagedEnrollmentReceiptV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    account: secondDraft,
    issuedAt: "2026-09-05T12:03:00.000Z",
  });
  const second = { ...secondDraft, enrollmentReceiptFingerprint: secondReceipt.enrollmentReceiptFingerprint };
  const next = config([f.base.primaryOpaqueAccountId, f.managed.opaqueAccountId, second.opaqueAccountId], 3);
  const prepared = prepareNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.next,
    nextConfig: next,
    managedAccount: second,
    issuedAt: "2026-09-05T12:03:00.000Z",
  });
  assert.equal(recoverNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.next,
    nextConfig: next,
    prior: prepared.prior,
    next: prepared.next,
  }).state, "prior");
});

test("selected account census isolates manager-local writers and thread locks", () => {
  const f = fixture();
  const prepared = prepareNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    managedAccount: f.managed,
    issuedAt: "2026-09-05T12:02:00.000Z",
  });
  publishPreparedNativeHistoryExtensionUpdateV1({ stateRoot: f.stateRoot, secret: f.secret, prior: prepared.prior, next: prepared.next });
  const preflight = readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.next, f.secret);
  assert.equal(preflight.state, "ready");
  if (preflight.state !== "ready") return;

  const writerPid = 701;
  const ps = `${psRow(writerPid, 1, "/usr/bin/node", "/usr/bin/node managed-home-writer")}\n`;
  const accountRoot = join(f.stateRoot, "accounts", f.managed.opaqueAccountId);
  const managedConfigWrite = ["p701", "f3", "au", `n${join(accountRoot, "config.toml")}`].join("\n") + "\n";
  const dependencies = nativeCensusDependencies(ps, managedConfigWrite);

  assert.deepEqual(
    observeNativeAccountWritersV1(preflight.binding, f.base.primaryOpaqueAccountId, [], dependencies),
    { ok: true, reason: "ready", foreignPids: [] },
    "a selected external account ignores a writer confined to a separate manager-local home",
  );
  const externalConfigWrite = ["p701", "f3", "au", `n${join(f.source.accounts[0]!.codexHome, "config.toml")}`].join("\n") + "\n";
  assert.deepEqual(
    observeNativeAccountWritersV1(preflight.binding, f.base.primaryOpaqueAccountId, [], nativeCensusDependencies(ps, externalConfigWrite)),
    { ok: false, reason: "foreign_writer", foreignPids: [writerPid] },
    "per-account external preflight fences writable config and capability paths, not only history files",
  );
  assert.deepEqual(
    observeNativeAccountWritersV1(preflight.binding, f.managed.opaqueAccountId, [], dependencies),
    { ok: false, reason: "foreign_writer", foreignPids: [writerPid] },
    "a manager-local account requires an exclusive account-root census",
  );
  assert.deepEqual(
    observeNativeAccountWritersV1(preflight.binding, f.managed.opaqueAccountId, [writerPid], dependencies),
    { ok: false, reason: "writer_census_failed", foreignPids: [] },
    "a managed account cannot claim clear while its selected broker child remains present",
  );

  assert.deepEqual(observeNativeAccountOperationWritersV1(preflight.binding, f.managed.opaqueAccountId, writerPid, dependencies),
    { ok: true, reason: "ready", foreignPids: [] }, "the selected native child may perform its own account-local operation");
  assert.deepEqual(observeNativeAccountOperationWritersV1(preflight.binding, f.managed.opaqueAccountId, 999, dependencies),
    { ok: false, reason: "foreign_writer", foreignPids: [writerPid] }, "another account child cannot exempt the selected home's writer");

  const threadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const managedThreadWrite = ["p701", "f3", "au", `n${join(accountRoot, "codex-home", "thread-writer-locks", `${threadId}.lock`)}`].join("\n") + "\n";
  assert.deepEqual(
    observeNativeThreadWriterV1(preflight.binding, threadId, [], nativeCensusDependencies(ps, managedThreadWrite)),
    { state: "conflict", foreignPids: [writerPid] },
    "thread fencing includes the manager-local extension CODEX_HOME",
  );
});

test("extension preflight rejects collisions, changed source binding, receipt loss, and unsafe candidates", () => {
  const f = fixture();
  const prepared = prepareNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    managedAccount: f.managed,
    issuedAt: "2026-09-05T12:02:00.000Z",
  });
  const { signature: _signature, ...unsigned } = prepared.next.document;
  const preflight = () => preflightNativeHistoryExtensionsV1({
    stateRoot: f.stateRoot,
    config: f.next,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
  });
  const writeExtension = (document: typeof prepared.next.document) => {
    privateWrite(join(f.stateRoot, "native-history-extensions.v1.json"), `${JSON.stringify(document)}\n`);
  };

  const changedBase = signNativeHistoryExtensionsV1({
    ...unsigned,
    baseSourceFingerprint: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
  }, f.secret);
  writeExtension(changedBase);
  assert.deepEqual(preflight(), { state: "invalid", reason: "base_source_mismatch" });

  const overlap = signNativeHistoryExtensionsV1({
    ...unsigned,
    managedAccounts: [{
      ...f.managed,
      opaqueAccountId: f.base.primaryOpaqueAccountId,
      accountRootRelativePath: `accounts/${f.base.primaryOpaqueAccountId}`,
    }],
  }, f.secret);
  writeExtension(overlap);
  assert.deepEqual(preflight(), { state: "invalid", reason: "effective_account_set_mismatch" });

  const identityDrift = signNativeHistoryExtensionsV1({
    ...unsigned,
    managedAccounts: [{
      ...f.managed,
      codexHomeIdentity: { ...f.managed.codexHomeIdentity, inode: f.managed.codexHomeIdentity.inode + 1 },
    }],
  }, f.secret);
  writeExtension(identityDrift);
  assert.deepEqual(preflight(), { state: "invalid", reason: "managed_receipt_invalid" });

  writeExtension(prepared.next.document);
  unlinkSync(join(f.stateRoot, "accounts", f.managed.opaqueAccountId, "native-history-enrollment-receipt.v1.json"));
  assert.deepEqual(preflight(), { state: "invalid", reason: "managed_receipt_invalid" });

  assert.throws(() => signNativeHistoryExtensionsV1({
    ...unsigned,
    managedAccounts: [{ ...f.managed, accountRootRelativePath: "accounts/../escaped" as `accounts/${string}` }],
  }, f.secret), /invalid native history extensions/);
  assert.throws(() => signNativeHistoryExtensionsV1({
    ...unsigned,
    managedAccounts: [f.managed, f.managed],
  }, f.secret), /invalid native history extensions/);
});

test("prepared proof validation rejects a forged next document before any publication", () => {
  const f = fixture();
  const prepared = prepareNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    managedAccount: f.managed,
    issuedAt: "2026-09-05T12:02:00.000Z",
  });
  const forged = {
    ...prepared.next,
    document: { ...prepared.next.document, signature: `hmac-sha256:${"0".repeat(64)}` },
  } as typeof prepared.next;
  assert.throws(() => publishPreparedNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    prior: prepared.prior,
    next: forged,
  }), /invalid native history extension publish input/);
  assert.equal(existsSync(join(f.stateRoot, "native-history-extensions.v1.json")), false, "a rejected candidate leaves the prior extension bytes untouched");
  assert.deepEqual(recoverNativeHistoryExtensionUpdateV1({
    stateRoot: f.stateRoot,
    secret: f.secret,
    baseSource: f.source,
    baseSourceDocumentFingerprint: f.sourceFingerprint,
    priorConfig: f.base,
    nextConfig: f.next,
    prior: prepared.prior,
    next: forged,
  }), { state: "invalid", reason: "invalid_proof" });
});
