import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTweakersManagerStatusArguments,
  runTweakersManagerCli,
} from "../src/manager-cli";
import { TweakersManagerActionAdapter } from "../src/manager-action-adapter";
import { MANAGER_PROTOCOL_VERSION, TWEAKERS_MANAGER_ID } from "../src/manager-contract";
import { resolveSealedTweakersManagerUserRoot } from "../src/manager-descriptor";
import { managerStatusPaths } from "../src/manager-status";

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

test("manager CLI projects exactly two public refresh actions while retaining the internal registration binding", async () => {
  const writes: string[] = [];
  const statusToken = `sha256:${"e".repeat(64)}`;
  let observedEnabledActionIds: readonly string[] | undefined;
  const adapter = {
    actionIds: () => [
      "refresh.injected",
      "refresh.independent",
      "official-source.register",
    ] as const,
  } as unknown as TweakersManagerActionAdapter;
  const exit = await runTweakersManagerCli(["status", "--request-id", REQUEST_ID, "--json"], {
    executable: () => EXECUTABLE,
    adapter,
    status: (input) => {
      observedEnabledActionIds = input.enabledActionIds;
      return {
        protocolVersion: MANAGER_PROTOCOL_VERSION,
        managerId: TWEAKERS_MANAGER_ID,
        generatedAt: "2026-08-27T23:00:00.000Z",
        stateToken: statusToken,
        status: { schemaVersion: 1, installation: {}, mode: {}, environment: {}, updater: {}, runtime: {}, coordinator: {}, operations: {}, receipts: [] },
        actions: [
          { actionId: "environment.cancel", available: false, reason: "internal" },
          { actionId: "refresh.injected", available: false, reason: "candidate" },
          { actionId: "refresh.independent", available: true, reason: "reapply" },
          { actionId: "official-source.register", available: true, reason: "bind source" },
        ],
        stateTokenInputs: { intentionallyNotPublished: true },
      } as never;
    },
    write: (line) => writes.push(line),
  });

  assert.equal(exit, 0);
  assert.equal(writes.length, 1);
  const response = JSON.parse(writes[0] ?? "") as {
    stateToken?: string;
    actions?: Array<{ actionId: string; available: boolean }>;
  };
  assert.equal(response.stateToken, statusToken);
  assert.deepEqual(response.actions?.map((action) => action.actionId), [
    "refresh.injected",
    "refresh.independent",
  ]);
  assert.deepEqual(observedEnabledActionIds, [
    "refresh.injected",
    "refresh.independent",
    "official-source.register",
  ]);
});

test("manager CLI exposes registration readiness only through its fixed narrow command", async () => {
  const writes: string[] = [];
  const statusToken = `sha256:${"f".repeat(64)}`;
  let observedSourceVerification: string | undefined;
  const adapter = {
    actionIds: () => [
      "refresh.injected",
      "refresh.independent",
      "official-source.register",
    ] as const,
  } as unknown as TweakersManagerActionAdapter;
  const exit = await runTweakersManagerCli(["official-source-registration", "--request-id", REQUEST_ID, "--json"], {
    executable: () => EXECUTABLE,
    adapter,
    status: (input) => {
      observedSourceVerification = input.officialSourceVerification;
      return ({
      protocolVersion: MANAGER_PROTOCOL_VERSION,
      managerId: TWEAKERS_MANAGER_ID,
      generatedAt: "2026-08-27T23:00:00.000Z",
      stateToken: statusToken,
      status: { schemaVersion: 1, installation: {}, mode: {}, environment: {}, updater: {}, runtime: {}, coordinator: {}, operations: {}, receipts: [] },
      actions: [
        { actionId: "refresh.injected", available: false, reason: "candidate" },
        { actionId: "refresh.independent", available: false, reason: "source is missing" },
        { actionId: "official-source.register", available: true, reason: "seal the fixed official source" },
      ],
      stateTokenInputs: { intentionallyNotPublished: true },
      }) as never;
    },
    write: (line) => writes.push(line),
  });

  assert.equal(exit, 0);
  assert.equal(writes.length, 1);
  const response = JSON.parse(writes[0] ?? "") as Record<string, unknown>;
  assert.equal(response.stateToken, statusToken);
  assert.equal(observedSourceVerification, "strict");
  assert.equal(Object.hasOwn(response, "actions"), false, "registration must not expand the generic public action list");
  assert.deepEqual(response.officialSourceRegistration, {
    actionId: "official-source.register",
    available: true,
    reason: "seal the fixed official source",
  });
});

test("manager CLI rejects retired desktop-update recovery commands before execution", async () => {
  const writes: string[] = [];
  const exit = await runTweakersManagerCli(["desktop-update-recovery", "--request-id", REQUEST_ID, "--json"], {
    status: () => assert.fail("retired command must not collect status") as never,
    adapter: rejectingAdapter(),
    write: (line) => writes.push(line),
  });
  assert.equal(exit, 64);
  assert.equal((JSON.parse(writes[0] ?? "") as { error: { code: string } }).error.code, "unsupported_action");
});

test("manager CLI still prepares the internal official-source registration action", async () => {
  let observedActionId: string | undefined;
  const adapter = {
    actionIds: () => ["official-source.register"] as const,
    prepare: async (input: { actionId: string }) => {
      observedActionId = input.actionId;
      return {
        operationId: OPERATION_ID,
        actionId: "official-source.register" as const,
        boundStateToken: STATE_TOKEN,
        expiresAt: EXPIRES_AT,
        impact: "repair-app" as const,
        prepared: true as const,
      };
    },
  } as unknown as TweakersManagerActionAdapter;
  const exit = await runTweakersManagerCli([
    "prepare", "--request-id", REQUEST_ID, "--operation-id", OPERATION_ID,
    "--action", "official-source.register", "--state-token", STATE_TOKEN,
    "--expires-at", EXPIRES_AT, "--json",
  ], {
    executable: () => EXECUTABLE,
    adapter,
    readStdin: () => Buffer.from("{}"),
    write: () => {},
    now: () => "2026-08-27T23:00:00.000Z",
  });

  assert.equal(exit, 0);
  assert.equal(observedActionId, "official-source.register");
});

test("sealed manager status binds the canonical global root without inherited environment", async () => {
  const canonicalRoot = resolveSealedTweakersManagerUserRoot(null, "/Users/tweakers-fixture");
  assert.equal(canonicalRoot, "/Users/tweakers-fixture/Library/Application Support/Tweakers");
  assert.equal(
    resolveSealedTweakersManagerUserRoot("/private/tweakers-cli-root", "/Users/tweakers-fixture"),
    "/private/tweakers-cli-root",
    "explicit test/CLI roots remain authoritative",
  );
  assert.equal(
    managerStatusPaths(canonicalRoot).independentStateFile,
    "/Users/tweakers-fixture/Library/Application Support/Tweakers/variants/tweakers/state.json",
  );

  let observedPaths: unknown;
  const exit = await runTweakersManagerCli(["status", "--request-id", REQUEST_ID, "--json"], {
    executable: () => EXECUTABLE,
    userRoot: () => canonicalRoot,
    status: (input) => {
      observedPaths = input.paths;
      return {
        protocolVersion: MANAGER_PROTOCOL_VERSION,
        managerId: TWEAKERS_MANAGER_ID,
        generatedAt: "2026-08-27T23:00:00.000Z",
        stateToken: `sha256:${"d".repeat(64)}`,
        status: { schemaVersion: 1, installation: {}, mode: {}, environment: {}, updater: {}, runtime: {}, coordinator: {}, operations: {}, receipts: [] },
        actions: [],
        stateTokenInputs: { intentionallyNotPublished: true },
      } as never;
    },
    write: () => {},
  });

  assert.equal(exit, 0);
  assert.deepEqual(observedPaths, managerStatusPaths(canonicalRoot));
});

test("manager CLI rejects noncanonical requests before status or adapter execution", async () => {
  const failures: Array<{ argv: string[]; code: string }> = [
    { argv: ["status", "--json", "--request-id", REQUEST_ID], code: "invalid_request" },
    { argv: ["status", "--request-id", REQUEST_ID.toUpperCase(), "--json"], code: "invalid_request" },
    { argv: ["unbounded-command", "--request-id", REQUEST_ID, "--json"], code: "unsupported_action" },
    { argv: ["offline-migration-launcher-run-v1"], code: "unsupported_action" },
    { argv: ["native-history-activation-run-v1"], code: "unsupported_action" },
    {
      argv: [
        "prepare", "--request-id", REQUEST_ID, "--operation-id", OPERATION_ID,
        "--action", "refresh.full", "--state-token", STATE_TOKEN,
        "--expires-at", EXPIRES_AT, "--json",
      ],
      code: "unsupported_action",
    },
    { argv: ["status", "--request-id", REQUEST_ID, "--json", "extra"], code: "invalid_request" },
    { argv: ["desktop-update-recovery", "--request-id", REQUEST_ID.toUpperCase(), "--json"], code: "unsupported_action" },
    { argv: ["desktop-update-recovery", "--json", "--request-id", REQUEST_ID], code: "unsupported_action" },
    { argv: ["desktop-update-recovery", "--request-id", REQUEST_ID, "--json", "extra"], code: "unsupported_action" },
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
