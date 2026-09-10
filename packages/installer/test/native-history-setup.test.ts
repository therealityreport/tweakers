import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeHistorySetupIdle, setupNativeHistory, type NativeHistorySetupInput } from "../src/native-history-setup.js";
import { routerConfigFingerprint, validateRouterConfig } from "../../runtime/src/account-router/config.js";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type OpaqueAccountId, type RouterConfigV2 } from "../../runtime/src/account-router/types.js";
import { readAndPreflightNativeHistorySourceStaticV1, parseNativeHistorySourceV1 } from "../../runtime/src/account-router/native-history.js";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-native-setup-")));
  // These IDs deliberately sort differently under localeCompare and wire order.
  const secret = Buffer.alloc(32, 1);
  const legacy = join(root, "legacy"); const native = join(root, "native"); const global = join(root, "global");
  for (const p of [legacy, native]) mkdirSync(p, { mode: 0o700 });
  const rawIds = ["original-signed-in-account", "other-signed-in-account"];
  const ids = rawIds.map((id) => `ar_${createHmac("sha256", secret).update(`account-router:v1:${id}`).digest("base64url")}` as OpaqueAccountId);
  function write(path: string, value: unknown) { writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600); }
  writeFileSync(join(legacy, "control-secret.v1"), secret, { mode: 0o600 });
  const config: RouterConfigV2 = { schemaVersion: 2, mode: "quota_aware", policy: "quota_aware_v1", generation: 2, protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: ids[1]!, accounts: ids.map((opaqueAccountId, i) => ({ opaqueAccountId, included: true, weight: 1, label: `Account ${i}`, capabilityFingerprint: `sha256:${"a".repeat(64)}` })) as RouterConfigV2["accounts"], updatedAt: "2026-09-05T00:00:00.000Z", fingerprint: `sha256:${"0".repeat(64)}` };
  config.fingerprint = routerConfigFingerprint(config); write(join(legacy, "account-router-config.json"), config);
  for (const [i, id] of ids.entries()) {
    for (const home of ["codex-home", "sqlite-home"]) mkdirSync(join(legacy, "accounts", id, home), { recursive: true, mode: 0o700 });
    write(join(legacy, "accounts", id, "codex-home", "auth.json"), { tokens: { account_id: rawIds[i], access_token: "fixture-secret" } });
  }
  write(join(native, "auth.json"), { tokens: { account_id: rawIds[0], access_token: "original-secret" } });
  mkdirSync(join(native, "sessions")); write(join(native, "sessions", "retained.jsonl"), "native history must remain exactly here\n");
  const appPaths = [join(root, "Original.app"), join(root, "Tweakers.app")];
  for (const app of appPaths) mkdirSync(app, { mode: 0o755 });
  const input: NativeHistorySetupInput = { legacyRouterRoot: legacy, sourceCodexRoot: native, sourceSqliteRoot: native, globalRoot: global, appPaths };
  return { root, secret, legacy, native, global, ids, rawIds, config, input, write };
}
const now = () => "2026-09-05T06:00:00.000Z";
const CENSUS_ROOT = "/Users/fixture/.codex";
const CENSUS_APPS = ["/Applications/Original.app", "/Applications/Tweakers.app"] as const;

function censusResult(stdout: string): ReturnType<typeof spawnSync> {
  return { status: 0, signal: null, stdout, stderr: "" } as ReturnType<typeof spawnSync>;
}

function psRow(pid: number, ppid: number, comm: string, command: string): string {
  return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${comm.slice(0, 16).padEnd(16, " ")} ${command}`;
}

function setupIdleFromCensus(psOutput: string, lsofOutput: string) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const blockers: Array<{ reason: string; pids: number[] }> = [];
  const spawn = ((command: string, args?: readonly string[]) => {
    calls.push({ command, args: args ?? [] });
    if (command === "/bin/ps") return censusResult(psOutput);
    if (command === "/usr/sbin/lsof") return censusResult(lsofOutput);
    throw new Error(`unexpected census command ${command}`);
  }) as unknown as typeof spawnSync;
  return {
    idle: nativeHistorySetupIdle([CENSUS_ROOT], CENSUS_APPS, {
      spawn,
      uid: () => 501,
      selfPid: 999_999,
      onBlocked: (evidence) => { blockers.push(evidence); },
    }),
    calls,
    blockers,
  };
}

test("preview binds the auth-matched account rather than primary and writes nothing", () => {
  const f = fixture(); const before = readdirSync(f.root);
  const result = setupNativeHistory(f.input, { idle: () => false, now });
  assert.equal(result.sourceAccountIndex, 0); assert.equal(result.idle, false); assert.equal(result.copiesHistory, false);
  assert.equal(result.copiesCredentials, false); assert.equal(result.accountCount, 2);
  assert.ok(result.coreMetadataBytes < 16 * 1024); assert.deepEqual(readdirSync(f.root), before);
  assert.equal(existsSync(f.global), false);
});

test("publication references existing homes, emits valid v3 config, and copies no transcripts or auth", () => {
  const f = fixture(); const original = readFileSync(join(f.native, "sessions", "retained.jsonl"));
  const result = setupNativeHistory({ ...f.input, apply: true }, { idle: () => true, now });
  assert.equal(result.state, "registered");
  assert.equal(existsSync(`${f.global}.native-setup-reservation`), true, "the publication reservation remains as the durable no-overwrite marker");
  assert.deepEqual(readdirSync(f.global).sort(), ["account-router-config.json", "canonical-history.v1.json", "control-secret.v1", "native-history-setup.v1.json", "native-history-source.v1.json"]);
  const config = JSON.parse(readFileSync(join(f.global, "account-router-config.json"), "utf8"));
  assert.ok(validateRouterConfig(config)); assert.equal(config.policy, "quota_aware_v2");
  const binding = JSON.parse(readFileSync(join(f.global, "native-history-source.v1.json"), "utf8"));
  assert.notDeepEqual([...f.ids].sort(), [...f.ids].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(binding.accounts.map((a: { opaqueAccountId: string }) => a.opaqueAccountId), [...f.ids].sort());
  assert.ok(parseNativeHistorySourceV1(binding, config, f.secret), "installer output passes the runtime's strict signed parser");
  assert.equal(readAndPreflightNativeHistorySourceStaticV1(f.global, config, f.secret).state, "ready");
  assert.equal(binding.accounts.find((a: { opaqueAccountId: string }) => a.opaqueAccountId === f.ids[0]).codexHome, f.native);
  assert.equal(binding.accounts.find((a: { opaqueAccountId: string }) => a.opaqueAccountId === f.ids[1]).codexHome, join(f.legacy, "accounts", f.ids[1]!, "codex-home"));
  assert.deepEqual(readFileSync(join(f.native, "sessions", "retained.jsonl")), original);
  assert.equal(JSON.stringify(binding).includes("original-secret"), false);
  assert.throws(() => setupNativeHistory({ ...f.input, apply: true }, { idle: () => true, now }), /already exists/);
});

test("active apps permit metadata registration without changing native home bytes", () => {
  const f = fixture();
  const auth = readFileSync(join(f.native, "auth.json"));
  const history = readFileSync(join(f.native, "sessions", "retained.jsonl"));
  const entries = readdirSync(f.native);
  const result = setupNativeHistory({ ...f.input, apply: true }, { idle: () => false, now });
  assert.equal(result.state, "registered");
  assert.equal(result.idle, false);
  assert.deepEqual(readdirSync(f.native), entries);
  assert.deepEqual(readFileSync(join(f.native, "auth.json")), auth);
  assert.deepEqual(readFileSync(join(f.native, "sessions", "retained.jsonl")), history);
  const config = JSON.parse(readFileSync(join(f.global, "account-router-config.json"), "utf8"));
  assert.equal(readAndPreflightNativeHistorySourceStaticV1(f.global, config, f.secret).state, "ready");
});

test("an auth-proved live secondary home retains its new task in place", () => {
  const f = fixture(); const secondary = join(f.root, "live-secondary");
  mkdirSync(secondary, { mode: 0o700 });
  f.write(join(secondary, "auth.json"), { tokens: { account_id: f.rawIds[1] } });
  f.write(join(secondary, "existing-task.jsonl"), "new secondary task stays here\n");
  const input = { ...f.input, secondaryCodexRoot: secondary, secondarySqliteRoot: secondary };
  const result = setupNativeHistory({ ...input, apply: true }, { idle: () => true, now });
  assert.equal(result.secondaryLiveHome, true);
  const config = JSON.parse(readFileSync(join(f.global, "account-router-config.json"), "utf8"));
  const binding = JSON.parse(readFileSync(join(f.global, "native-history-source.v1.json"), "utf8"));
  assert.equal(binding.metadataAccountId, f.ids[0]);
  assert.equal(binding.accounts.find((a: { opaqueAccountId: string }) => a.opaqueAccountId === f.ids[1]).codexHome, secondary);
  assert.equal(readAndPreflightNativeHistorySourceStaticV1(f.global, config, f.secret).state, "ready");
  assert.equal(readFileSync(join(secondary, "existing-task.jsonl"), "utf8"), "new secondary task stays here\n");
  assert.equal(existsSync(join(f.global, "existing-task.jsonl")), false);
});

test("secondary home requires paired roots, distinct saved identity, and nonoverlap", () => {
  const f = fixture();
  assert.throws(() => setupNativeHistory({ ...f.input, secondaryCodexRoot: f.native }, { idle: () => true, now }), /together/);
  assert.throws(() => setupNativeHistory({ ...f.input, secondaryCodexRoot: f.native, secondarySqliteRoot: f.native }, { idle: () => true, now }), /other included/);
  const secondary = join(f.root, "live-secondary"); mkdirSync(secondary, { mode: 0o700 });
  f.write(join(secondary, "auth.json"), { tokens: { account_id: "not-saved" } });
  assert.throws(() => setupNativeHistory({ ...f.input, secondaryCodexRoot: secondary, secondarySqliteRoot: secondary }, { idle: () => true, now }), /other included/);
  f.write(join(secondary, "auth.json"), { tokens: { account_id: f.rawIds[1] } });
  assert.throws(() => setupNativeHistory({ ...f.input, secondaryCodexRoot: secondary, secondarySqliteRoot: f.native }, { idle: () => true, now }), /overlap/);
  assert.equal(existsSync(f.global), false);
});

test("unknown native identity and changed saved identity both reject", () => {
  const f = fixture(); f.write(join(f.native, "auth.json"), { tokens: { account_id: "unregistered" } });
  assert.throws(() => setupNativeHistory(f.input, { idle: () => true, now }), /does not match/);
  f.write(join(f.native, "auth.json"), { tokens: { account_id: f.rawIds[0] } });
  f.write(join(f.legacy, "accounts", f.ids[1]!, "codex-home", "auth.json"), { tokens: { account_id: "changed" } });
  assert.throws(() => setupNativeHistory(f.input, { idle: () => true, now }), /saved account identity mismatch/);
});

test("auth drift during the first census cannot publish a stale binding", () => {
  const f = fixture();
  assert.throws(() => setupNativeHistory({ ...f.input, apply: true }, { now, idle: () => { f.write(join(f.native, "auth.json"), { tokens: { account_id: "changed" } }); return true; } }), /does not match/);
  assert.equal(existsSync(f.global), false);
});

test("symlinked source and writable source roots reject; ordinary owner-owned native mode 0755 works", () => {
  const f = fixture(); const link = join(f.root, "native-link"); symlinkSync(f.native, link);
  assert.throws(() => setupNativeHistory({ ...f.input, sourceCodexRoot: link }, { idle: () => true, now }), /canonical/);
  chmodSync(f.native, 0o777);
  assert.throws(() => setupNativeHistory(f.input, { idle: () => true, now }), /unsafe account directory/);
  chmodSync(f.native, 0o755); assert.equal(setupNativeHistory(f.input, { idle: () => true, now }).state, "preview");
});

test("broker destination cannot overlap the native source", () => {
  const f = fixture();
  assert.throws(() => setupNativeHistory({ ...f.input, globalRoot: join(f.native, "broker") }, { idle: () => true, now }), /overlap/);
});

test("registration refuses legacy configurations that the runtime would reject", () => {
  for (const mutate of [
    (c: Record<string, any>) => { c.unrecognized = true; },
    (c: Record<string, any>) => { c.accounts[0].unrecognized = true; },
    (c: Record<string, any>) => { c.accounts[0].weight = 1.5; },
    (c: Record<string, any>) => { c.accounts[0].weight = 101; },
    (c: Record<string, any>) => { c.accounts[0].label = "name@example.invalid"; },
    (c: Record<string, any>) => { c.updatedAt = "invalid"; },
    (c: Record<string, any>) => { c.policy = null; },
  ]) {
    const f = fixture(); mutate(f.config);
    f.config.fingerprint = routerConfigFingerprint(f.config);
    f.write(join(f.legacy, "account-router-config.json"), f.config);
    assert.throws(() => setupNativeHistory(f.input, { idle: () => true, now }), /configuration/);
    assert.equal(existsSync(f.global), false);
  }
});

test("an absent desktop path cannot bypass the final writer census", () => {
  const f = fixture();
  assert.throws(() => setupNativeHistory({ ...f.input, appPaths: [f.input.appPaths[0]!, join(f.root, "Absent.app")] }, { idle: () => true, now }));
  assert.equal(existsSync(f.global), false);
});

test("setup census permits disjoint backends and readonly enrolled metadata without a recursive walk", () => {
  const observed = setupIdleFromCensus(
    [
      psRow(100, 1, "/usr/bin/node", "/usr/bin/node bridge /usr/local/bin/codex app-server"),
      psRow(101, 1, "/usr/local/bin/codex", "/usr/local/bin/codex app-server --listen stdio://"),
      psRow(102, 1, "/usr/bin/node", "/usr/bin/node /Applications/Original.app/Contents/MacOS/Original"),
      psRow(103, 1, "/usr/local/bin/codex", "/usr/local/bin/codex app-server --listen stdio://"),
    ].join("\n") + "\n",
    [
      "p100", "f3", "ar", `n${CENSUS_ROOT}/.codex-global-state.json`,
      "p101", "f3", "ar", "n/Users/fixture/other-home/state_5.sqlite",
      "p102", "f3", "ar", `n${CENSUS_ROOT}/.codex-global-state.json`,
      "p103", "f3", "ar", `n${CENSUS_ROOT}/plugins/cache/registry/example/1.0.0/definition.json`,
    ].join("\n") + "\n",
  );
  assert.equal(observed.idle, true);
  assert.deepEqual(observed.calls.map(({ command }) => command), ["/bin/ps", "/usr/sbin/lsof"]);
  assert.deepEqual(observed.calls[1]!.args, ["-nP", "-u", "501", "-Fpafn"]);
  assert.equal(observed.calls.some(({ args }) => args.includes("+D")), false);
});

test("setup census blocks an enrolled native writer, a real enrolled app-server reading protected history, and an exact participating app", () => {
  const writer = setupIdleFromCensus(
    psRow(100, 1, "/usr/bin/node", "/usr/bin/node writer") + "\n",
    ["p100", "f3", "au", `n${CENSUS_ROOT}/state_5.sqlite-wal`].join("\n") + "\n",
  );
  assert.equal(writer.idle, false);

  const nativeBackend = setupIdleFromCensus(
    psRow(101, 1, "/usr/local/bin/codex", "/usr/local/bin/codex -c features.code_mode_host=true app-server --listen stdio://") + "\n",
    ["p101", "f3", "ar", `n${CENSUS_ROOT}/state_5.sqlite`].join("\n") + "\n",
  );
  assert.equal(nativeBackend.idle, false);

  const spacedNativeBackend = setupIdleFromCensus(
    psRow(103, 1, "/Applications/Tweakers ChatGPT.app/Contents/Resources/codex", "/Applications/Tweakers ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --listen stdio://") + "\n",
    ["p103", "f3", "ar", `n${CENSUS_ROOT}/history/thread-123.jsonl`].join("\n") + "\n",
  );
  assert.equal(spacedNativeBackend.idle, false);

  const longPathNodeWrapper = setupIdleFromCensus(
    psRow(104, 1, "/Applications/Node Host.app/Contents/MacOS/node", "/Applications/Node Host.app/Contents/MacOS/node -e bridge /tmp/codex app-server") + "\n",
    ["p104", "f3", "ar", `n${CENSUS_ROOT}/state_5.sqlite`].join("\n") + "\n",
  );
  assert.equal(longPathNodeWrapper.idle, true, "a fixed-width truncated Node command cannot impersonate Codex through a later argv value");

  const participatingApp = setupIdleFromCensus(
    psRow(102, 1, "/tmp/has space/x", "/Applications/Original.app/Contents/MacOS/Original") + "\n",
    "p102\nf3\nar\nn/Users/fixture/other-home/metadata.json\n",
  );
  assert.equal(participatingApp.idle, false);
  assert.deepEqual(participatingApp.calls.map(({ command }) => command), ["/bin/ps"]);
  assert.deepEqual(participatingApp.blockers, [{ reason: "participating-app-processes", pids: [102] }]);
});

test("setup census fails closed when process and open-file evidence is incomplete", () => {
  const raced = setupIdleFromCensus(
    psRow(100, 1, "/usr/bin/node", "/usr/bin/node metadata-reader") + "\n",
    ["p101", "f3", "ar", `n${CENSUS_ROOT}/.codex-global-state.json`].join("\n") + "\n",
  );
  assert.equal(raced.idle, false);

  const malformed = setupIdleFromCensus(
    psRow(100, 1, "/usr/bin/node", "/usr/bin/node metadata-reader") + "\n",
    ["p100", "f3", "ax", `n${CENSUS_ROOT}/.codex-global-state.json`].join("\n") + "\n",
  );
  assert.equal(malformed.idle, false);
});

test("setup census treats unknown numeric protected descriptors as inconclusive without blocking cwd, txt, or mem", () => {
  for (const path of [`${CENSUS_ROOT}/state_5.sqlite`, `${CENSUS_ROOT}/rollout-0001.jsonl`]) {
    const unknownNumeric = setupIdleFromCensus(
      psRow(100, 1, "/usr/bin/node", "/usr/bin/node metadata-reader") + "\n",
      ["p100", "f7u", "a ", `n${path}`].join("\n") + "\n",
    );
    assert.equal(unknownNumeric.idle, false, path);
  }
  const unknownMetadata = setupIdleFromCensus(
    psRow(100, 1, "/usr/bin/node", "/usr/bin/node metadata-reader") + "\n",
    ["p100", "f8", "a ", `n${CENSUS_ROOT}/.codex-global-state.json`].join("\n") + "\n",
  );
  assert.equal(unknownMetadata.idle, true, "unknown access does not turn ordinary metadata into a history writer");
  for (const descriptor of ["cwd", "txt", "mem"]) {
    const nonNumeric = setupIdleFromCensus(
      psRow(100, 1, "/usr/bin/node", "/usr/bin/node metadata-reader") + "\n",
      ["p100", `f${descriptor}`, "a ", `n${CENSUS_ROOT}/state_5.sqlite`].join("\n") + "\n",
    );
    assert.equal(nonNumeric.idle, true, descriptor);
  }
});
