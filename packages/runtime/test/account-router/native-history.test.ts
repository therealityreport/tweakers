import { inspectNativeAuthenticationAtRoot, reconnectNativeAuthenticationAtRoot } from "../../src/account-router/doctor-auth";
import { NATIVE_AUTH_BINDING_FILE_V1, prepareNativeAuthBindingV1, publishPreparedNativeAuthBindingV1 } from "../../src/account-router/native-auth-binding";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { routerConfigFingerprint } from "../../src/account-router/config";
import {
  nativeHistoryAccountSetFingerprintV1,
  nativeHistoryEffectiveAuthHomeV1,
  nativeHistoryBindingSafeV1,
  nativeHistoryAuthIdentityHmacV1,
  nativeHistoryThreadReadContextV1,
  observeNativeHistoryWritersV1,
  observeNativeThreadWriterV1,
  observeNativeThreadWritersV1,
  readAndPreflightNativeHistorySourceStaticV1,
  signNativeHistorySourceV1,
  type NativeHistoryDirectoryIdentityV1,
  type NativeHistorySourceUnsignedV1,
} from "../../src/account-router/native-history";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type OpaqueAccountId, type RouterConfigV3 } from "../../src/account-router/types";

interface NativeFixture {
  stateRoot: string;
  homesRoot: string;
  secret: Buffer;
  config: RouterConfigV3;
  accounts: OpaqueAccountId[];
  rawAccounts: string[];
  codexHomes: string[];
  sqliteHomes: string[];
}

function privateWrite(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function identity(path: string): NativeHistoryDirectoryIdentityV1 {
  const stat = lstatSync(path);
  return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}

function opaque(secret: Buffer, raw: string): OpaqueAccountId {
  return `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`, "utf8").digest("base64url")}` as OpaqueAccountId;
}

function nativeFixture(): NativeFixture {
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "native-history-state-")));
  const homesRoot = realpathSync(mkdtempSync(join(tmpdir(), "native-history-homes-")));
  chmodSync(stateRoot, 0o700);
  chmodSync(homesRoot, 0o700);
  const secret = Buffer.alloc(32, 73);
  const rawAccounts = ["native-fixture-a", "native-fixture-b"];
  const accounts = rawAccounts.map((raw) => opaque(secret, raw));
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    schemaVersion: 3,
    mode: "quota_aware",
    policy: "quota_aware_v2",
    generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: accounts[1]!,
    accounts: accounts.map((account, index) => ({
      opaqueAccountId: account,
      included: true,
      weight: 1,
      capabilityFingerprint: `sha256:${String.fromCharCode(97 + index).repeat(64)}` as `sha256:${string}`,
      label: `Fixture ${index + 1}`,
    })),
    updatedAt: "2026-09-05T12:00:00.000Z",
  };
  const config: RouterConfigV3 = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  const codexHomes: string[] = [];
  const sqliteHomes: string[] = [];
  const accountSources = accounts.map((account, index) => {
    const codexHome = join(homesRoot, "accounts", account, "codex-home");
    const sqliteHome = join(homesRoot, "accounts", account, "sqlite-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
    privateWrite(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: rawAccounts[index], refresh_token: "fixture-only" } }));
    codexHomes.push(codexHome);
    sqliteHomes.push(sqliteHome);
    return {
      opaqueAccountId: account,
      codexHome,
      sqliteHome,
      codexHomeIdentity: identity(codexHome),
      sqliteHomeIdentity: identity(sqliteHome),
      authIdentityHmac: nativeHistoryAuthIdentityHmacV1(rawAccounts[index]!, secret),
    };
  });
  const unsigned: NativeHistorySourceUnsignedV1 = {
    version: 1,
    kind: "account-router-native-history-source",
    mode: "in_place",
    protocolFingerprint: config.protocolFingerprint,
    accountSetFingerprint: nativeHistoryAccountSetFingerprintV1(accounts),
    metadataAccountId: accounts[0]!,
    accounts: accountSources,
    issuedAt: "2026-09-05T12:00:00.000Z",
  };
  privateWrite(join(stateRoot, "native-history-source.v1.json"), JSON.stringify(signNativeHistorySourceV1(unsigned, secret)));
  return { stateRoot, homesRoot, secret, config, accounts, rawAccounts, codexHomes, sqliteHomes };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function censusResult(stdout: string): ReturnType<typeof spawnSync> {
  return { status: 0, signal: null, stdout, stderr: "" } as ReturnType<typeof spawnSync>;
}

function psRow(pid: number, ppid: number, comm: string, command: string): string {
  return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${comm.slice(0, 16).padEnd(16, " ")} ${command}`;
}

function observedNativeCensus(
  binding: Parameters<typeof observeNativeHistoryWritersV1>[0],
  psOutput: string,
  lsofOutput: string,
) {
  const spawn = ((command: string) => {
    if (command === "/bin/ps") return censusResult(psOutput);
    if (command === "/usr/sbin/lsof") return censusResult(lsofOutput);
    throw new Error(`unexpected census command ${command}`);
  }) as unknown as typeof spawnSync;
  return observeNativeHistoryWritersV1(binding, [], { spawn, uid: () => 501 });
}

test("native source binding is signed to storage identities but survives routing-policy changes", () => {
  const fixture = nativeFixture();
  const expected = `sha256:${createHash("sha256").update(JSON.stringify([...fixture.accounts].sort()), "utf8").digest("hex")}`;
  assert.equal(nativeHistoryAccountSetFingerprintV1([...fixture.accounts].reverse()), expected, "the account-set HMAC input is the bare sorted id array");
  const initial = readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, fixture.config, fixture.secret);
  assert.equal(initial.state, "ready");

  const changedDraft: Omit<RouterConfigV3, "fingerprint"> = {
    ...fixture.config,
    mode: "quota_aware",
    policy: "balanced_tokens_v1",
    primaryOpaqueAccountId: fixture.accounts[0]!,
    generation: 2,
    accounts: fixture.config.accounts.map((account, index) => ({ ...account, included: index === 0 })),
    updatedAt: "2026-09-05T12:01:00.000Z",
  };
  const changed: RouterConfigV3 = { ...changedDraft, fingerprint: routerConfigFingerprint(changedDraft) };
  assert.equal(readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, changed, fixture.secret).state, "ready", "disable/balance/primary changes must not invalidate storage authority");

  privateWrite(join(fixture.codexHomes[0]!, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "different-account" } }));
  const drifted = readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, changed, fixture.secret);
  assert.deepEqual(drifted, { state: "invalid", reason: "authentication_binding_invalid" });
});

test("native writer census permits only explicit child roots and rejects wrapper argv impersonation", async () => {
  const fixture = nativeFixture();
  const preflight = readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, fixture.config, fixture.secret);
  assert.equal(preflight.state, "ready");
  if (preflight.state !== "ready") return;
  const openPath = join(fixture.sqliteHomes[0]!, "state_5.sqlite");
  privateWrite(openPath, "fixture sqlite marker");
  const writer = spawn(process.execPath, ["-e", "const fs=require('node:fs');fs.openSync(process.argv[1], 'r+');process.stdout.write('ready');setInterval(()=>{}, 1000);", openPath], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolvePromise, reject) => { writer.stdout!.once("data", () => resolvePromise()); writer.once("error", reject); });
    let foreign = observeNativeHistoryWritersV1(preflight.binding);
    const censusDeadline = Date.now() + 15_000;
    while (!foreign.ok && foreign.reason === "writer_census_failed" && Date.now() < censusDeadline) {
      await delay(25);
      foreign = observeNativeHistoryWritersV1(preflight.binding);
    }
    assert.equal(foreign.ok, false);
    assert.equal(foreign.reason, "foreign_writer");
    assert.equal(foreign.foreignPids.includes(writer.pid!), true);
    let owned = observeNativeHistoryWritersV1(preflight.binding, [writer.pid!]);
    const ownedDeadline = Date.now() + 15_000;
    while (!owned.ok && owned.reason === "writer_census_failed" && Date.now() < ownedDeadline) {
      await delay(25);
      owned = observeNativeHistoryWritersV1(preflight.binding, [writer.pid!]);
    }
    assert.equal(owned.ok, true, `the exact child root is allowed to retain its native sqlite handle: ${JSON.stringify(owned)}`);
  } finally {
    writer.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => writer.once("exit", () => resolvePromise()));
  }

  // A Node bridge can contain the words `codex app-server` in its argv. It is
  // not a codex executable and must not be classified as an external backend.
  const wrapper = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000);", "/tmp/codex", "app-server"], { stdio: "ignore" });
  try {
    await delay(80);
    let observation = observeNativeHistoryWritersV1(preflight.binding);
    const wrapperDeadline = Date.now() + 15_000;
    while (!observation.ok && observation.reason === "writer_census_failed" && Date.now() < wrapperDeadline) {
      await delay(25);
      observation = observeNativeHistoryWritersV1(preflight.binding);
    }
    assert.equal(observation.ok, true, `wrapper census failed: ${JSON.stringify(observation)}`);
    assert.equal(observation.foreignPids.includes(wrapper.pid!), false, `Node wrapper was misclassified: ${JSON.stringify(observation)}`);
  } finally {
    wrapper.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => wrapper.once("exit", () => resolvePromise()));
  }
});

test("runtime writer census handles fixed-width macOS commands and unknown numeric descriptors", () => {
  const fixture = nativeFixture();
  const preflight = readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, fixture.config, fixture.secret);
  assert.equal(preflight.state, "ready");
  if (preflight.state !== "ready") return;
  const protectedPath = join(fixture.sqliteHomes[0]!, "state_5.sqlite");
  const pluginPath = join(fixture.codexHomes[0]!, "plugin-definition.json");

  const bundledCodexMetadata = observedNativeCensus(
    preflight.binding,
    psRow(701, 1, "/Applications/Tweakers ChatGPT.app/Contents/Resources/codex", "/Applications/Tweakers ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --listen stdio://") + "\n",
    ["p701", "f3", "ar", `n${pluginPath}`].join("\n") + "\n",
  );
  assert.deepEqual(bundledCodexMetadata, { ok: true, reason: "ready", foreignPids: [] }, "a real Codex backend may read unrelated enrolled metadata when its history is elsewhere");

  const bundledCodexHistory = observedNativeCensus(
    preflight.binding,
    psRow(701, 1, "/Applications/Tweakers ChatGPT.app/Contents/Resources/codex", "/Applications/Tweakers ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --listen stdio://") + "\n",
    ["p701", "f3", "ar", `n${protectedPath}`].join("\n") + "\n",
  );
  assert.deepEqual(bundledCodexHistory, { ok: false, reason: "foreign_writer", foreignPids: [701] }, "a real Codex backend stays visible when its space-containing bundle path opens protected history state");

  const nodeWrapper = observedNativeCensus(
    preflight.binding,
    psRow(702, 1, "/usr/bin/node", "/usr/bin/node -e bridge /tmp/codex app-server") + "\n",
    ["p702", "f3", "ar", `n${pluginPath}`].join("\n") + "\n",
  );
  assert.deepEqual(nodeWrapper, { ok: true, reason: "ready", foreignPids: [] }, "a Node bridge argument cannot impersonate a Codex backend");

  const longPathNodeWrapper = observedNativeCensus(
    preflight.binding,
    psRow(702, 1, "/Applications/Node Host.app/Contents/MacOS/node", "/Applications/Node Host.app/Contents/MacOS/node -e bridge /tmp/codex app-server") + "\n",
    ["p702", "f3", "ar", `n${pluginPath}`].join("\n") + "\n",
  );
  assert.deepEqual(longPathNodeWrapper, { ok: true, reason: "ready", foreignPids: [] }, "a fixed-width truncated Node command cannot impersonate Codex through a later argv value");

  const unknownNumeric = observedNativeCensus(
    preflight.binding,
    psRow(703, 1, "/usr/bin/node", "/usr/bin/node metadata-reader") + "\n",
    ["p703", "f7u", "a ", `n${protectedPath}`].join("\n") + "\n",
  );
  assert.deepEqual(unknownNumeric, { ok: false, reason: "foreign_writer", foreignPids: [703] }, "an unknown numeric descriptor on protected history state fails closed");

  const nonRegular = observedNativeCensus(
    preflight.binding,
    psRow(704, 1, "/usr/bin/node", "/usr/bin/node metadata-reader") + "\n",
    ["p704", "fcwd", "a ", `n${protectedPath}`].join("\n") + "\n",
  );
  assert.deepEqual(nonRegular, { ok: true, reason: "ready", foreignPids: [] }, "cwd/text/memory-style observations do not turn an arbitrary reader into a writer");

  const raced = observedNativeCensus(
    preflight.binding,
    psRow(705, 1, "/usr/bin/node", "/usr/bin/node metadata-reader") + "\n",
    ["p706", "f3", "ar", `n${pluginPath}`].join("\n") + "\n",
  );
  assert.deepEqual(raced, { ok: false, reason: "writer_census_failed", foreignPids: [] }, "a process-table/open-file race remains inconclusive");
});

test("native handoff sanitizer accepts omitted full itemsView and rejects unsafe item types", () => {
  const accepted = nativeHistoryThreadReadContextV1({ thread: {
    id: "native-thread",
    turns: [{
      id: "native-turn",
      status: "completed",
      items: [
        { id: "native-user", type: "userMessage", content: [{ type: "text", text: "safe input" }] },
        { id: "native-agent", type: "agentMessage", text: "safe output" },
      ],
    }],
  } }, "native-thread");
  assert.equal(accepted.state, "ready");
  const unsafe = nativeHistoryThreadReadContextV1({ thread: {
    id: "native-thread",
    turns: [{ id: "native-turn", status: "completed", items: [{ id: "native-image", type: "image", data: "no" }] }],
  } }, "native-thread");
  assert.deepEqual(unsafe, { state: "unsafe" });
});


test("per-thread conflict checks permit SQLite and other conversations without warning", async () => {
  const fixture = nativeFixture();
  const preflight = readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, fixture.config, fixture.secret);
  assert.equal(preflight.state, "ready"); if (preflight.state !== "ready") return;
  const threadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const ps = psRow(701, 1, "/usr/bin/codex", "/usr/bin/codex app-server") + "\n";
  const check = (path: string, access = "u") => observeNativeThreadWriterV1(preflight.binding, threadId, [], {
    spawn: ((command: string) => censusResult(command === "/bin/ps" ? ps : `p701\nf4\na${access}\nn${path}\n`)) as typeof spawnSync, uid: () => 501,
  });
  assert.equal(check(join(fixture.codexHomes[0]!, "state_5.sqlite")).state, "clear");
  assert.equal(check(join(fixture.codexHomes[0]!, "sessions/2026/09/05/rollout-other.jsonl")).state, "clear");
  const rollout = join(fixture.codexHomes[0]!, `sessions/2026/09/05/rollout-2026-09-05-${threadId}.jsonl`);
  assert.equal(check(join(fixture.codexHomes[0]!, `sessions/2026/09/05/${threadId}_11111111-2222-3333-4444-555555555555.jsonl`)).state, "conflict", "edited streams remain part of the selected thread census");
  assert.equal(check(join(fixture.codexHomes[0]!, `sessions/2026/09/05/${threadId}.jsonl`)).state, "conflict");
  assert.equal(check(rollout, "r").state, "clear");
  assert.equal(check(rollout).state, "conflict");
  assert.equal(check(join(fixture.codexHomes[1]!, `thread-writer-locks/${threadId}.lock`)).state, "conflict");
  const otherThreadId = "other-native-thread";
  const commands: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let observedLsof!: () => void;
  const reachedLsof = new Promise<void>((resolve) => { observedLsof = resolve; });
  const batch = observeNativeThreadWritersV1(preflight.binding, [threadId, otherThreadId], [], {
    uid: () => 501,
    run: async (command) => {
      commands.push(command);
      if (command === "/bin/ps") return { stdout: ps, stderr: "" };
      observedLsof();
      await held;
      return { stdout: `p701\nf4\nau\nn${rollout}\n`, stderr: "" };
    },
  });
  await reachedLsof;
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  const observations = await batch;
  assert.deepEqual(commands, ["/bin/ps", "/usr/sbin/lsof"], "one census serves the entire observation batch");
  assert.equal(observations.get(threadId)?.state, "conflict");
  assert.equal(observations.get(otherThreadId)?.state, "clear");
  const failed = await observeNativeThreadWritersV1(preflight.binding, [threadId], [], {
    run: async () => { throw new Error("OS timeout"); },
  });
  assert.equal(failed.get(threadId)?.state, "unknown", "incomplete async evidence never clears a writer gate");
});


test("auth companion repairs credentials without moving history and rejects source, companion and home drift", () => {
  const fixture = nativeFixture();
  const original = readFileSync(join(fixture.stateRoot, "native-history-source.v1.json"));
  const sourceFingerprint = `sha256:${createHash("sha256").update(original).digest("hex")}`;
  const authHome = join(fixture.homesRoot, "isolated-auth"); mkdirSync(authHome, { mode: 0o700 });
  privateWrite(join(authHome, "auth.json"), JSON.stringify({ tokens: { account_id: fixture.rawAccounts[0], access_token: "synthetic-access", refresh_token: "synthetic-refresh" } }));
  privateWrite(join(fixture.codexHomes[0]!, "auth.json"), JSON.stringify({ tokens: { account_id: "foreign-original" } }));
  assert.equal(readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, fixture.config, fixture.secret).state, "invalid");
  const prepared = prepareNativeAuthBindingV1({ ...fixture, expectedSourceFingerprint: sourceFingerprint, accounts: [{ opaqueAccountId: fixture.accounts[0]!, authHome }] });
  publishPreparedNativeAuthBindingV1(prepared);
  const bound = readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, fixture.config, fixture.secret);
  assert.equal(bound.state, "ready"); if (bound.state !== "ready") return;
  assert.equal(nativeHistoryEffectiveAuthHomeV1(bound.binding, fixture.accounts[0]!), authHome);
  assert.equal(bound.binding.accounts.find((a) => a.opaqueAccountId === fixture.accounts[0])!.codexHome, fixture.codexHomes[0]);
  assert.deepEqual(readFileSync(join(fixture.stateRoot, "native-history-source.v1.json")), original);
  assert.throws(() => publishPreparedNativeAuthBindingV1(prepared));
  privateWrite(join(authHome, "auth.json"), JSON.stringify({ tokens: { account_id: fixture.rawAccounts[1], access_token: "foreign" } }));
  assert.equal(nativeHistoryBindingSafeV1(bound.binding), false);
  privateWrite(join(authHome, "auth.json"), JSON.stringify({ tokens: { account_id: fixture.rawAccounts[0], access_token: "synthetic-rotated" } }));
  assert.equal(nativeHistoryBindingSafeV1(bound.binding), true);
  renameSync(authHome, `${authHome}-prior`); mkdirSync(authHome, { mode: 0o700 });
  privateWrite(join(authHome, "auth.json"), readFileSync(join(`${authHome}-prior`, "auth.json")));
  assert.equal(nativeHistoryBindingSafeV1(bound.binding), false);
});

test("auth companion preparation rejects foreign identity, symlinks and changed publication preimages", () => {
  const fixture = nativeFixture();
  const path = join(fixture.stateRoot, "native-history-source.v1.json"); const bytes = readFileSync(path);
  const authHome = join(fixture.homesRoot, "isolated-auth"); mkdirSync(authHome, { mode: 0o700 });
  const input = { ...fixture, expectedSourceFingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, accounts: [{ opaqueAccountId: fixture.accounts[0]!, authHome }] };
  privateWrite(join(authHome, "auth.json"), JSON.stringify({ tokens: { account_id: fixture.rawAccounts[1], access_token: "synthetic" } }));
  assert.throws(() => prepareNativeAuthBindingV1(input));
  renameSync(join(authHome, "auth.json"), join(authHome, "prior.json")); symlinkSync(join(authHome, "prior.json"), join(authHome, "auth.json"));
  assert.throws(() => prepareNativeAuthBindingV1(input));
  renameSync(join(authHome, "auth.json"), join(authHome, "prior-link"));
  privateWrite(join(authHome, "auth.json"), JSON.stringify({ tokens: { account_id: fixture.rawAccounts[0], access_token: "synthetic" } }));
  const prepared = prepareNativeAuthBindingV1(input); privateWrite(path, Buffer.concat([bytes, Buffer.from(" ")]));
  assert.throws(() => publishPreparedNativeAuthBindingV1(prepared));
  privateWrite(path, bytes); publishPreparedNativeAuthBindingV1(prepared);
  const ready = readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, fixture.config, fixture.secret);
  assert.equal(ready.state, "ready"); if (ready.state !== "ready") return;
  renameSync(join(fixture.stateRoot, NATIVE_AUTH_BINDING_FILE_V1), join(fixture.stateRoot, "prior-companion"));
  assert.equal(nativeHistoryBindingSafeV1(ready.binding), false, "removing an accepted override cannot silently switch auth homes");
});


test("auth companion supports only the exact owner-private manager-local execution home", () => {
  const fixture = nativeFixture();
  const authHome = join(fixture.stateRoot, "accounts", fixture.accounts[0]!, "execution-home");
  mkdirSync(authHome, { recursive: true, mode: 0o700 });
  privateWrite(join(authHome, "auth.json"), JSON.stringify({ tokens: { account_id: fixture.rawAccounts[0], access_token: "synthetic-access" } }));
  const source = readFileSync(join(fixture.stateRoot, "native-history-source.v1.json"));
  const input = { ...fixture, expectedSourceFingerprint: `sha256:${createHash("sha256").update(source).digest("hex")}`, accounts: [{ opaqueAccountId: fixture.accounts[0]!, authHome }] };
  const prepared = prepareNativeAuthBindingV1(input);
  chmodSync(join(fixture.stateRoot, "accounts"), 0o755);
  assert.throws(() => publishPreparedNativeAuthBindingV1(prepared));
  chmodSync(join(fixture.stateRoot, "accounts"), 0o700);
  publishPreparedNativeAuthBindingV1(prepared);
  const ready = readAndPreflightNativeHistorySourceStaticV1(fixture.stateRoot, fixture.config, fixture.secret);
  assert.equal(ready.state, "ready"); if (ready.state !== "ready") return;
  assert.equal(nativeHistoryEffectiveAuthHomeV1(ready.binding, fixture.accounts[0]!), authHome);
  chmodSync(join(fixture.stateRoot, "accounts", fixture.accounts[0]!), 0o755);
  assert.equal(nativeHistoryBindingSafeV1(ready.binding), false);
});

for (const isolated of [false, true]) test(`Doctor reconnect preserves both identities (${isolated ? "isolated" : "original"} home)`, async () => {
  const f = nativeFixture();
  privateWrite(join(f.stateRoot, "account-router-config.json"), JSON.stringify(f.config));
  privateWrite(join(f.stateRoot, "control-secret.v1"), f.secret);
  const auth = (raw: string) => JSON.stringify({ tokens: { account_id: raw, access_token: "fixture-access", refresh_token: "fixture-refresh" } });
  for (let i = 0; i < f.accounts.length; i++) privateWrite(join(f.codexHomes[i]!, "auth.json"), auth(f.rawAccounts[i]!));
  let home = f.codexHomes[0]!;
  if (isolated) {
    home = realpathSync(mkdtempSync(join(tmpdir(), "reconnect-auth-"))); chmodSync(home, 0o700);
    privateWrite(join(home, "auth.json"), auth(f.rawAccounts[0]!));
    const bytes = readFileSync(join(f.stateRoot, "native-history-source.v1.json"));
    publishPreparedNativeAuthBindingV1(prepareNativeAuthBindingV1({ ...f, expectedSourceFingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, accounts: [{ opaqueAccountId: f.accounts[0]!, authHome: home }] }));
  }
  const source = readFileSync(join(f.stateRoot, "native-history-source.v1.json"));
  const other = readFileSync(join(f.codexHomes[1]!, "auth.json"));
  privateWrite(join(home, "auth.json"), auth(f.rawAccounts[1]!));
  const before = readFileSync(join(home, "auth.json"));
  const inspection = inspectNativeAuthenticationAtRoot(f.stateRoot);
  assert.equal(inspection.state, "reconnect_required");
  assert.deepEqual(inspection.accounts.map(a => a.accountId), [f.accounts[0]]);
  const input = { root: f.stateRoot, accountId: f.accounts[0]!, expectedFingerprint: inspection.fingerprint };
  await assert.rejects(reconnectNativeAuthenticationAtRoot({ ...input, login: async staged => { privateWrite(join(staged, "auth.json"), auth(f.rawAccounts[1]!)); } }), /not Account/);
  assert.deepEqual(readFileSync(join(home, "auth.json")), before);
  await assert.rejects(reconnectNativeAuthenticationAtRoot({ ...input, login: async () => { throw new Error("cancelled"); } }), /cancelled/);
  assert.deepEqual(readFileSync(join(home, "auth.json")), before);
  await assert.rejects(reconnectNativeAuthenticationAtRoot({ ...input, login: async staged => {
    privateWrite(join(staged, "auth.json"), auth(f.rawAccounts[0]!));
    privateWrite(join(home, "auth.json"), auth(f.rawAccounts[1]!) + " ");
  } }), /changed/);
  const changed = inspectNativeAuthenticationAtRoot(f.stateRoot);
  const restored = await reconnectNativeAuthenticationAtRoot({ ...input, expectedFingerprint: changed.fingerprint, login: async staged => { privateWrite(join(staged, "auth.json"), auth(f.rawAccounts[0]!)); } });
  assert.equal(restored.state, "ready");
  assert.equal(readAndPreflightNativeHistorySourceStaticV1(f.stateRoot, f.config, f.secret).state, "ready");
  assert.deepEqual(readFileSync(join(f.stateRoot, "native-history-source.v1.json")), source);
  assert.deepEqual(readFileSync(join(f.codexHomes[1]!, "auth.json")), other);
});
