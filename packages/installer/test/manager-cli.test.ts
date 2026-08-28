import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTweakersManagerStatusArguments,
  runTweakersManagerCli,
} from "../src/manager-cli";
import { TweakersManagerActionAdapter } from "../src/manager-action-adapter";
import { MANAGER_PROTOCOL_VERSION, TWEAKERS_MANAGER_ID } from "../src/manager-contract";

const REQUEST_ID = "018f0d36-4c08-7a3e-9c1d-123456789abc";
const OPERATION_ID = "018f0d36-4c08-7a3e-9c1d-123456789abd";
const STATE_TOKEN = `sha256:${"a".repeat(64)}` as const;
const EXPIRES_AT = "2026-08-27T23:05:00.000Z";
const EXECUTABLE = { state: "resolved" as const, path: "/fixed/Tweakers Manager Launcher", sha256: "b".repeat(64) };

test("manager CLI emits exactly the status protocol envelope with a host request id", async () => {
  const writes: string[] = [];
  const exit = await runTweakersManagerCli(["status", "--request-id", REQUEST_ID, "--json"], {
    executable: () => EXECUTABLE,
    status: () => ({
      protocolVersion: MANAGER_PROTOCOL_VERSION,
      managerId: TWEAKERS_MANAGER_ID,
      generatedAt: "2026-08-27T23:00:00.000Z",
      stateToken: `sha256:${"c".repeat(64)}`,
      status: { schemaVersion: 1, installation: {}, mode: {}, environment: {}, updater: {}, runtime: {}, coordinator: {}, operations: {}, receipts: [] },
      actions: [],
      stateTokenInputs: { intentionallyNotPublished: true },
    }) as never,
    write: (line) => writes.push(line),
  });

  assert.equal(exit, 0);
  assert.equal(writes.length, 1);
  const response = JSON.parse(writes[0] ?? "") as Record<string, unknown>;
  assert.equal(response.protocolVersion, 1);
  assert.equal(response.managerId, TWEAKERS_MANAGER_ID);
  assert.equal(response.requestId, REQUEST_ID);
  assert.equal(Object.hasOwn(response, "stateTokenInputs"), false);
  assert.deepEqual(response.actions, []);
});

test("manager CLI rejects noncanonical requests before status or adapter execution", async () => {
  const failures: Array<{ argv: string[]; code: string }> = [
    { argv: ["status", "--json", "--request-id", REQUEST_ID], code: "invalid_request" },
    { argv: ["status", "--request-id", REQUEST_ID.toUpperCase(), "--json"], code: "invalid_request" },
    { argv: ["unbounded-command", "--request-id", REQUEST_ID, "--json"], code: "unsupported_action" },
    { argv: ["status", "--request-id", REQUEST_ID, "--json", "extra"], code: "invalid_request" },
  ];
  for (const failure of failures) {
    const writes: string[] = [];
    const exit = await runTweakersManagerCli(failure.argv, {
      status: () => assert.fail("invalid manager argv must not collect status") as never,
      adapter: rejectingAdapter(),
      write: (line) => writes.push(line),
      now: () => "2026-08-27T23:00:00.000Z",
    });
    assert.equal(exit, 64);
    assert.equal(writes.length, 1);
    const body = JSON.parse(writes[0] ?? "") as { error?: { code?: string }; requestId?: string | null };
    assert.equal(body.error?.code, failure.code);
  }
});

test("prepare rejects duplicate, trailing, oversized, and unknown JSON before an action can be prepared", async () => {
  const argv = [
    "prepare", "--request-id", REQUEST_ID, "--operation-id", OPERATION_ID,
    "--action", "environment.cancel", "--state-token", STATE_TOKEN,
    "--expires-at", EXPIRES_AT, "--json",
  ];
  for (const input of [
    Buffer.from('{"x":1,"x":2}'),
    Buffer.from('{} trailing'),
    Buffer.from('{"unexpected":true}'),
    Buffer.alloc(64 * 1024 + 1, 0x20),
  ]) {
    const writes: string[] = [];
    const exit = await runTweakersManagerCli(argv, {
      executable: () => EXECUTABLE,
      adapter: rejectingAdapter(),
      readStdin: () => input,
      write: (line) => writes.push(line),
      now: () => "2026-08-27T23:00:00.000Z",
    });
    assert.equal(exit, 64);
    assert.equal(writes.length, 1);
    assert.equal((JSON.parse(writes[0] ?? "") as { error: { code: string } }).error.code, "invalid_request");
  }
});

test("prepare emits the strictly correlated bounded response", async () => {
  const writes: string[] = [];
  const adapter = {
    async prepare(input: unknown) {
      assert.deepEqual(input, {
        requestId: REQUEST_ID,
        operationId: OPERATION_ID,
        actionId: "environment.cancel",
        stateToken: STATE_TOKEN,
        expiresAt: EXPIRES_AT,
        parameters: {},
        executable: EXECUTABLE,
      });
      return {
        operationId: OPERATION_ID,
        actionId: "environment.cancel" as const,
        boundStateToken: STATE_TOKEN,
        expiresAt: EXPIRES_AT,
        impact: "restart-app" as const,
        prepared: true as const,
      };
    },
  } as unknown as TweakersManagerActionAdapter;
  const exit = await runTweakersManagerCli([
    "prepare", "--request-id", REQUEST_ID, "--operation-id", OPERATION_ID,
    "--action", "environment.cancel", "--state-token", STATE_TOKEN,
    "--expires-at", EXPIRES_AT, "--json",
  ], {
    executable: () => EXECUTABLE,
    adapter,
    readStdin: () => Buffer.from("{}"),
    write: (line) => writes.push(line),
    now: () => "2026-08-27T23:00:00.000Z",
  });
  assert.equal(exit, 0);
  const body = JSON.parse(writes[0] ?? "") as Record<string, unknown>;
  assert.equal(body.requestId, REQUEST_ID);
  assert.equal(body.operationId, OPERATION_ID);
  assert.equal(body.prepared, true);
  assert.equal(body.impact, "restart-app");
});

test("status argv parser accepts only exact lowercase UUID protocol shape", () => {
  assert.deepEqual(
    parseTweakersManagerStatusArguments(["status", "--request-id", REQUEST_ID, "--json"]),
    { requestId: REQUEST_ID },
  );
  assert.throws(() => parseTweakersManagerStatusArguments([]), /Expected/);
});

function rejectingAdapter(): TweakersManagerActionAdapter {
  return {
    prepare: async () => assert.fail("invalid request must not prepare"),
    execute: async () => assert.fail("invalid request must not execute"),
    cancel: async () => assert.fail("invalid request must not cancel"),
  } as unknown as TweakersManagerActionAdapter;
}
