import assert from "node:assert/strict";
import test from "node:test";
import { createTweakersManagerClient } from "../src/tweakers-manager-client.js";

const HOME = "/Users/example";
const EXECUTABLE = `${HOME}/Library/Application Support/Tweakers/managers/com.thomashulihan.tweakers/generations/${"a".repeat(64)}/Tweakers Manager Launcher`;
const DESCRIPTOR = JSON.stringify({
  schemaVersion: 1,
  managerId: "com.thomashulihan.tweakers",
  protocolVersion: 1,
  executable: EXECUTABLE,
});

function publicActions(overrides: Partial<Record<"refresh.injected" | "refresh.independent", { available: boolean; reason: string }>> = {}) {
  return [
    { actionId: "refresh.injected", available: false, reason: "not requested", ...overrides["refresh.injected"] },
    { actionId: "refresh.independent", available: false, reason: "not requested", ...overrides["refresh.independent"] },
  ];
}

test("missing and malformed manager authority fail closed before any action can run", () => {
  let executions = 0;
  const missing = createTweakersManagerClient({
    homeDirectory: () => HOME,
    readText: () => { throw new Error("missing"); },
    execute: () => { executions += 1; return ""; },
  });
  assert.throws(() => missing.readStatus(), /unavailable or malformed/);
  assert.throws(() => missing.startAction("refresh.independent"), /unavailable or malformed/);

  const malformed = createTweakersManagerClient({
    homeDirectory: () => HOME,
    readText: () => JSON.stringify({ ...JSON.parse(DESCRIPTOR), protocolVersion: 99 }),
    execute: () => { executions += 1; return ""; },
  });
  assert.throws(() => malformed.readStatus(), /incompatible or blocked/);
  assert.throws(() => malformed.startAction("refresh.independent"), /incompatible or blocked/);
  assert.equal(executions, 0);
});

test("an archived manager descriptor is rejected before status or action execution", () => {
  let executions = 0;
  const archived = createTweakersManagerClient({
    homeDirectory: () => HOME,
    readText: () => JSON.stringify({
      ...JSON.parse(DESCRIPTOR),
      executable: `${HOME}/.Trash/Tweakers Manager Launcher`,
    }),
    execute: () => { executions += 1; return ""; },
  });
  assert.throws(() => archived.readStatus(), /incompatible or blocked/);
  assert.throws(() => archived.startAction("refresh.independent"), /incompatible or blocked/);
  assert.equal(executions, 0);
});

test("healthy authority binds and dispatches only an available manager action", () => {
  const ids = ["status-1", "status-2", "prepare-1", "operation-1", "execute-1"];
  const spawned: string[][] = [];
  const client = createTweakersManagerClient({
    homeDirectory: () => HOME,
    readText: () => DESCRIPTOR,
    createId: () => ids.shift()!,
    now: () => Date.parse("2026-09-02T22:00:00.000Z"),
    execute: (executable, args, input) => {
      if (executable === "/usr/bin/codesign") return "";
      const requestId = args[args.indexOf("--request-id") + 1];
      if (args[0] === "status") return JSON.stringify({
        protocolVersion: 1,
        managerId: "com.thomashulihan.tweakers",
        requestId,
        stateToken: `sha256:${"0".repeat(64)}`,
        status: { environment: { officialApp: { state: "valid", appPath: "/Applications/ChatGPT.app", bundleId: "com.openai.codex" } } },
        actions: publicActions({ "refresh.independent": { available: true, reason: "ready" } }),
      });
      assert.equal(args[0], "prepare");
      assert.equal(input, "{}");
      return JSON.stringify({
        protocolVersion: 1,
        managerId: "com.thomashulihan.tweakers",
        requestId,
        operationId: "operation-1",
        prepared: true,
      });
    },
    spawnDetached: (_executable, args) => { spawned.push([...args]); },
  });

  assert.equal(client.readStatus().status.environment?.officialApp?.appPath, "/Applications/ChatGPT.app");
  assert.deepEqual(client.startAction("refresh.independent"), { started: true, operationId: "operation-1" });
  assert.deepEqual(spawned, [["execute", "--request-id", "execute-1", "--operation-id", "operation-1", "--json"]]);
});

test("an unavailable action is rejected without prepare or execute", () => {
  let prepared = false;
  let spawned = false;
  const client = createTweakersManagerClient({
    homeDirectory: () => HOME,
    readText: () => DESCRIPTOR,
    createId: () => "status-only",
    execute: (executable, args) => {
      if (executable === "/usr/bin/codesign") return "";
      if (args[0] !== "status") prepared = true;
      return JSON.stringify({
        protocolVersion: 1,
        managerId: "com.thomashulihan.tweakers",
        requestId: "status-only",
        stateToken: `sha256:${"1".repeat(64)}`,
        status: {},
        actions: publicActions({ "refresh.independent": { available: false, reason: "no newer official app" } }),
      });
    },
    spawnDetached: () => { spawned = true; },
  });
  assert.throws(() => client.startAction("refresh.independent"), /no newer official app/);
  assert.equal(prepared, false);
  assert.equal(spawned, false);
});

test("missing or stale source registration is discoverable and executable without a fourth public action", () => {
  const ids = ["status-1", "registration-1", "registration-2", "prepare-1", "operation-1", "execute-1"];
  const spawned: string[][] = [];
  const calls: string[][] = [];
  const client = createTweakersManagerClient({
    homeDirectory: () => HOME,
    readText: () => DESCRIPTOR,
    createId: () => ids.shift()!,
    now: () => Date.parse("2026-09-02T22:00:00.000Z"),
    execute: (executable, args, input) => {
      if (executable === "/usr/bin/codesign") return "";
      calls.push([...args]);
      const requestId = args[args.indexOf("--request-id") + 1];
      if (args[0] === "status") return JSON.stringify({
        protocolVersion: 1,
        managerId: "com.thomashulihan.tweakers",
        requestId,
        stateToken: `sha256:${"2".repeat(64)}`,
        status: { environment: { officialApp: { state: "valid", appPath: "/Applications/ChatGPT.app", bundleId: "com.openai.codex" } } },
        actions: publicActions({ "refresh.independent": { available: false, reason: "verified official source is missing or stale" } }),
      });
      if (args[0] === "official-source-registration") return JSON.stringify({
        protocolVersion: 1,
        managerId: "com.thomashulihan.tweakers",
        requestId,
        stateToken: `sha256:${"3".repeat(64)}`,
        officialSourceRegistration: {
          actionId: "official-source.register",
          available: true,
          reason: "seal the exact current stable ChatGPT app",
        },
      });
      assert.equal(args[0], "prepare");
      assert.equal(args[args.indexOf("--action") + 1], "official-source.register");
      assert.equal(args[args.indexOf("--state-token") + 1], `sha256:${"3".repeat(64)}`);
      assert.equal(input, "{}");
      return JSON.stringify({
        protocolVersion: 1,
        managerId: "com.thomashulihan.tweakers",
        requestId,
        operationId: "operation-1",
        prepared: true,
      });
    },
    spawnDetached: (_executable, args) => { spawned.push([...args]); },
  });

  const publicStatus = client.readStatus();
  assert.deepEqual(publicStatus.actions.map((action) => action.actionId), [
    "refresh.injected",
    "refresh.independent",
  ]);
  assert.equal(publicStatus.actions.find((action) => action.actionId === "refresh.independent")?.available, false);
  assert.deepEqual(client.readOfficialSourceRegistration(), {
    stateToken: `sha256:${"3".repeat(64)}`,
    officialSourceRegistration: {
      actionId: "official-source.register",
      available: true,
      reason: "seal the exact current stable ChatGPT app",
    },
  });
  assert.deepEqual(client.startOfficialSourceRegistration(), { started: true, operationId: "operation-1" });
  assert.deepEqual(spawned, [["execute", "--request-id", "execute-1", "--operation-id", "operation-1", "--json"]]);
  assert.equal(calls.filter((args) => args[0] === "status").length, 1);
  assert.equal(calls.filter((args) => args[0] === "official-source-registration").length, 2);
});

test("an unavailable registration prerequisite is an exact safe terminal before prepare or execute", () => {
  let prepared = false;
  let spawned = false;
  const client = createTweakersManagerClient({
    homeDirectory: () => HOME,
    readText: () => DESCRIPTOR,
    createId: () => "registration-status",
    execute: (executable, args) => {
      if (executable === "/usr/bin/codesign") return "";
      if (args[0] === "prepare") prepared = true;
      return JSON.stringify({
        protocolVersion: 1,
        managerId: "com.thomashulihan.tweakers",
        requestId: "registration-status",
        stateToken: `sha256:${"4".repeat(64)}`,
        officialSourceRegistration: {
          actionId: "official-source.register",
          available: false,
          reason: "normal verified ChatGPT mode is required",
        },
      });
    },
    spawnDetached: () => { spawned = true; },
  });

  assert.throws(() => client.startOfficialSourceRegistration(), /normal verified ChatGPT mode is required/);
  assert.equal(prepared, false);
  assert.equal(spawned, false);
});

test("legacy desktop-update action projections are rejected before preparation or execution", () => {
  let prepared = false;
  const client = createTweakersManagerClient({
    homeDirectory: () => HOME,
    readText: () => DESCRIPTOR,
    createId: () => "legacy-status",
    execute: (executable, args) => {
      if (executable === "/usr/bin/codesign") return "";
      if (args[0] === "prepare") prepared = true;
      return JSON.stringify({
        protocolVersion: 1,
        managerId: "com.thomashulihan.tweakers",
        requestId: "legacy-status",
        stateToken: `sha256:${"7".repeat(64)}`,
        status: {},
        actions: [{ actionId: "desktop-update.start", available: true, reason: "legacy" }, ...publicActions()],
      });
    },
  });

  assert.throws(() => client.readStatus(), /incompatible public action projection/);
  assert.equal(prepared, false);
});
