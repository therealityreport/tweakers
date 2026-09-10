import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  NativeRemoteControllerV1,
  type NativeRemoteControllerOptionsV1,
  type RemoteModeGateV1,
  type RemoteNativeRequestV1,
} from "../../src/account-router/remote-controller";
import { assertRedacted } from "../../src/account-router/redaction";
import type { OpaqueAccountId } from "../../src/account-router/types";

const account = `ar_${"a".repeat(43)}` as OpaqueAccountId;
const secret = Buffer.alloc(32, 17);

type NativeHandler = (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;

function nativeStatus(status: "disabled" | "connecting" | "connected" | "errored" | "invalid", environmentId: string | null = "environment-private"): Record<string, unknown> {
  return {
    status,
    serverName: "server-private",
    installationId: "installation-private",
    environmentId,
  };
}

function nativePairing(expiresAt: number, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    pairingCode: "pairing-private-raw-code",
    manualPairingCode: "A1B2-C3D4",
    environmentId: "environment-private",
    expiresAt,
    ...overrides,
  };
}

function nativeClient(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    clientId: "client-private",
    displayName: null,
    deviceType: null,
    platform: null,
    osVersion: null,
    deviceModel: null,
    appVersion: null,
    lastSeenAt: null,
    ...overrides,
  };
}

function gateFixture(input: {
  readiness?: "ready" | "busy" | "unavailable";
  loadedThreads?: () => readonly string[] | null | Promise<readonly string[] | null>;
} = {}): { gate: RemoteModeGateV1; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    gate: {
      async beginEnable() { calls.push("beginEnable"); return input.readiness ?? "ready"; },
      commitEnabled() { calls.push("commitEnabled"); },
      abortEnable() { calls.push("abortEnable"); },
      beginDisable() { calls.push("beginDisable"); },
      async loadedThreads() { calls.push("loadedThreads"); return input.loadedThreads?.() ?? []; },
      commitDisabled() { calls.push("commitDisabled"); },
    },
  };
}

function controller(
  handler: NativeHandler,
  gate: RemoteModeGateV1,
  options: Partial<Omit<NativeRemoteControllerOptionsV1, "request" | "gate" | "secret">> = {},
): { controller: NativeRemoteControllerV1; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request: RemoteNativeRequestV1 = async (_accountId, method, params = {}) => {
    calls.push({ method, params: structuredClone(params) });
    return handler(method, params);
  };
  return {
    controller: new NativeRemoteControllerV1({ request, gate, secret, ...options }),
    calls,
  };
}

test("startup-disabled children receive only ephemeral enable, with strict outcomes and safe gate rollback", async () => {
  const successfulGate = gateFixture();
  const successful = controller(async (method) => {
    assert.equal(method, "remoteControl/enable");
    return nativeStatus("connecting");
  }, successfulGate.gate);
  const enabled = await successful.controller.enable(account);
  assert.deepEqual(enabled, { accountId: account, enabled: true, state: "pairing", pairing: null, devices: [] });
  assert.deepEqual(successful.calls, [{ method: "remoteControl/enable", params: { ephemeral: true } }]);
  assert.deepEqual(successfulGate.calls, ["beginEnable", "commitEnabled"]);

  const ambiguousGate = gateFixture();
  const ambiguous = controller(async (method) => {
    if (method === "remoteControl/enable") return nativeStatus("invalid");
    assert.equal(method, "remoteControl/disable");
    return nativeStatus("disabled", null);
  }, ambiguousGate.gate);
  assert.equal((await ambiguous.controller.enable(account)).state, "unavailable");
  assert.deepEqual(ambiguousGate.calls, ["beginEnable", "beginDisable", "loadedThreads", "commitDisabled"]);
  assert.equal(ambiguousGate.calls.includes("abortEnable"), false, "invalid success data is an ambiguous enable, never a desktop-ready rollback");

  const rejectedGate = gateFixture();
  const rejected = controller(async () => { throw { code: 403, message: "provider refused the request" }; }, rejectedGate.gate);
  assert.equal((await rejected.controller.enable(account)).state, "unavailable");
  assert.deepEqual(rejectedGate.calls, ["beginEnable", "abortEnable"]);
});

test("disable retains the gate through native drain and fails closed when drain proof times out", async () => {
  let reads = 0;
  const drainedGate = gateFixture({ loadedThreads: () => (reads++ === 0 ? ["private-thread"] : []) });
  const waits: number[] = [];
  const drained = controller(async (method) => {
    assert.equal(method, "remoteControl/disable");
    return nativeStatus("disabled", null);
  }, drainedGate.gate, { drainPollMs: 1, drainTimeoutMs: 10, sleep: async (milliseconds) => { waits.push(milliseconds); } });
  assert.deepEqual(await drained.controller.disable(account), { accountId: account, enabled: false, state: "disabled", pairing: null, devices: [] });
  assert.deepEqual(drainedGate.calls, ["beginDisable", "loadedThreads", "loadedThreads", "commitDisabled"]);
  assert.deepEqual(waits, [1]);

  let now = 0;
  const timedOutGate = gateFixture({ loadedThreads: () => ["private-thread"] });
  const timedOut = controller(async () => nativeStatus("disabled", null), timedOutGate.gate, {
    now: () => now,
    drainPollMs: 1,
    drainTimeoutMs: 2,
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  assert.equal((await timedOut.controller.disable(account)).state, "unavailable");
  assert.equal(timedOutGate.calls.includes("commitDisabled"), false, "a timeout keeps the parent gate draining/unavailable");
});

test("pairing codes are short-lived direct action results and clear on claim, close, expiry, and disposal", async () => {
  let now = 1_000_000;
  type Timer = ReturnType<typeof setTimeout>;
  const timers: Array<{ callback: () => void; cleared: boolean }> = [];
  const gate = gateFixture();
  const paired = controller(async (method) => {
    if (method === "remoteControl/pairing/start") return nativePairing(1_100);
    if (method === "remoteControl/status/read") return nativeStatus("connecting");
    throw new Error("unexpected native method");
  }, gate.gate, {
    now: () => now,
    setTimer: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer as unknown as Timer;
    },
    clearTimer: (timer) => { (timer as unknown as { cleared: boolean }).cleared = true; },
  });
  const started = await paired.controller.pairingStart(account);
  assert.deepEqual(started.pairing, { code: "A1B2-C3D4", expiresAt: "1970-01-01T00:18:20.000Z" });
  assert.equal(JSON.stringify(started).includes("pairing-private-raw-code"), false);
  assert.equal(JSON.stringify(started).includes("environment-private"), false);
  paired.controller.closePairing(account);
  assert.equal(timers[0]?.cleared, true);
  assert.equal((await paired.controller.pairingStatus(account)).pairing, null);

  const claimedGate = gateFixture();
  const claimed = controller(async (method) => {
    if (method === "remoteControl/pairing/start") return nativePairing(1_100);
    if (method === "remoteControl/pairing/status") return { claimed: true };
    if (method === "remoteControl/status/read") return nativeStatus("connected");
    throw new Error("unexpected native method");
  }, claimedGate.gate, { now: () => now });
  await claimed.controller.pairingStart(account);
  assert.equal((await claimed.controller.pairingStatus(account)).pairing, null);

  const invalidGate = gateFixture();
  const invalid = controller(async () => nativePairing(1_100, { manualPairingCode: "not printable!" }), invalidGate.gate, { now: () => now });
  assert.equal((await invalid.controller.pairingStart(account)).state, "unavailable");
  const redactorSafe = controller(async () => nativePairing(1_100, { manualPairingCode: "sk-1234" }), gateFixture().gate, { now: () => now });
  assert.equal((await redactorSafe.controller.pairingStart(account)).state, "unavailable");

  const expiringGate = gateFixture();
  const expiring = controller(async (method) => {
    if (method === "remoteControl/pairing/start") return nativePairing(1_100);
    if (method === "remoteControl/status/read") return nativeStatus("connecting");
    throw new Error("unexpected native method");
  }, expiringGate.gate, {
    now: () => now,
    setTimer: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer as unknown as Timer;
    },
    clearTimer: (timer) => { (timer as unknown as { cleared: boolean }).cleared = true; },
  });
  await expiring.controller.pairingStart(account);
  now = 1_100_000;
  timers.at(-1)?.callback();
  assert.equal((await expiring.controller.status(account)).pairing, null);
  expiring.controller.dispose();
  assert.equal(timers.at(-1)?.cleared, true);
});

test("device pages are bounded, labels are redacted, ids are HMACs, and revoke re-resolves native ids", async () => {
  const environmentId = "environment-private";
  const first = nativeClient({
    clientId: "client-private-a",
    displayName: "alice@example.com",
    deviceModel: "Bearer device",
    platform: "macOS",
  });
  const second = nativeClient({ clientId: "client-private-b", displayName: "Safe laptop" });
  let revoked = false;
  let page = 0;
  const gate = gateFixture();
  const fixture = controller(async (method, params) => {
    if (method === "remoteControl/status/read") return nativeStatus("connected", environmentId);
    if (method === "remoteControl/client/list") {
      assert.equal(params.environmentId, environmentId);
      if (revoked) return { data: [second], nextCursor: null };
      return page++ === 0 ? { data: [first], nextCursor: "cursor-private" } : { data: [second], nextCursor: null };
    }
    if (method === "remoteControl/client/revoke") {
      assert.deepEqual(params, { environmentId, clientId: "client-private-a" });
      revoked = true;
      return {};
    }
    throw new Error("unexpected native method");
  }, gate.gate);
  const listed = await fixture.controller.devicesList(account);
  const expectedFirst = `device_${createHmac("sha256", secret).update(`accounts:remote-device:v1\0${account}\0${environmentId}\0client-private-a`, "utf8").digest("base64url")}`;
  assert.equal(listed.devices[0]?.deviceId, expectedFirst);
  assert.equal(listed.devices[0]?.label, "macOS");
  assert.doesNotThrow(() => assertRedacted(listed));
  const serialized = JSON.stringify(listed);
  for (const raw of [environmentId, "client-private-a", "client-private-b", "cursor-private", "alice@example.com"]) assert.equal(serialized.includes(raw), false);

  const revokedResult = await fixture.controller.deviceRevoke(account, expectedFirst);
  assert.deepEqual(revokedResult.devices, [{ deviceId: `device_${createHmac("sha256", secret).update(`accounts:remote-device:v1\0${account}\0${environmentId}\0client-private-b`, "utf8").digest("base64url")}`, label: "Safe laptop" }]);
  assert.equal(fixture.calls.filter((call) => call.method === "remoteControl/client/list").length, 3, "revoke lists again instead of caching raw client ids");

  const boundedGate = gateFixture();
  const bounded = controller(async (method) => method === "remoteControl/status/read"
    ? nativeStatus("connected", environmentId)
    : { data: [first], nextCursor: "cursor-private" }, boundedGate.gate, { maxDevicePages: 1 });
  assert.equal((await bounded.controller.devicesList(account)).state, "unavailable");
});

test("native errors and error text collapse to unavailable without guessing MFA or exposing private values", async () => {
  const gate = gateFixture();
  const rawError = "401 Bearer pairing-private-raw-code environment-private client-private";
  const failed = controller(async () => { throw new Error(rawError); }, gate.gate);
  const result = await failed.controller.status(account);
  assert.deepEqual(result, { accountId: account, enabled: false, state: "unavailable", pairing: null, devices: [] });
  assert.notEqual(result.state, "mfa_required");
  assert.equal(JSON.stringify(result).includes(rawError), false);
});
