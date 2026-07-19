import assert from "node:assert/strict";
import test from "node:test";
import {
  proveRegularChatGptMcpRuntime,
  type RegularChatGptMcpRuntimeProofDependencies,
} from "../src/mcp-runtime-proof";
import type { ProcessInfo } from "../src/commands/debug";

const MAIN_STARTED = "2026-07-17T16:00:00.000Z";
const TWEAKS_ROOT = "/Users/test/Library/Application Support/codex-plusplus/tweaks";

function proc(
  pid: number,
  ppid: number | null,
  command: string,
  startedAt = MAIN_STARTED,
): ProcessInfo {
  return {
    pid,
    ppid,
    command,
    startedAt,
    startedAtRaw: "Fri Jul 17 12:00:00 2026",
  };
}

function dependencies(
  processes: ProcessInfo[],
  configMtimeMs = Date.parse("2026-07-17T15:59:00.000Z"),
): RegularChatGptMcpRuntimeProofDependencies {
  return {
    listProcesses: () => processes,
    configMtimeMs: () => configMtimeMs,
  };
}

test("regular ChatGPT MCP runtime accepts a process started after clean config", () => {
  const proof = proveRegularChatGptMcpRuntime({
    mainPid: 100,
    configPath: "/Users/test/.codex/config.toml",
    tweaksRoot: TWEAKS_ROOT,
    configurationChanged: false,
  }, dependencies([
    proc(100, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
    proc(101, 100, "/Applications/ChatGPT.app/Contents/Resources/codex app-server"),
  ]));

  assert.equal(proof.ok, true);
  assert.deepEqual(proof.ownedProcessPids, []);
  assert.equal(proof.error, null);
});

test("a reconciliation change requires a new ChatGPT process", () => {
  const proof = proveRegularChatGptMcpRuntime({
    mainPid: 100,
    configPath: "/Users/test/.codex/config.toml",
    tweaksRoot: TWEAKS_ROOT,
    configurationChanged: true,
  }, dependencies([proc(100, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")]));

  assert.equal(proof.ok, false);
  assert.match(proof.error ?? "", /configuration changed.*restart ChatGPT/i);
});

test("a ChatGPT process older than the config requires restart even after a no-op reconcile", () => {
  const proof = proveRegularChatGptMcpRuntime({
    mainPid: 100,
    configPath: "/Users/test/.codex/config.toml",
    tweaksRoot: TWEAKS_ROOT,
    configurationChanged: false,
  }, dependencies(
    [proc(100, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")],
    Date.parse("2026-07-17T16:01:00.000Z"),
  ));

  assert.equal(proof.ok, false);
  assert.match(proof.error ?? "", /started before.*restart ChatGPT/i);
});

test("Tweakers-owned descendants of the exact ChatGPT process fail runtime proof", () => {
  const mcpPath = `${TWEAKS_ROOT}/user-questions/mcp-server.js`;
  const proof = proveRegularChatGptMcpRuntime({
    mainPid: 100,
    configPath: "/Users/test/.codex/config.toml",
    tweaksRoot: TWEAKS_ROOT,
    configurationChanged: false,
  }, dependencies([
    proc(100, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
    proc(101, 100, "/Applications/ChatGPT.app/Contents/Resources/codex app-server"),
    proc(102, 101, `node ${mcpPath}`),
  ]));

  assert.equal(proof.ok, false);
  assert.deepEqual(proof.ownedProcessPids, [102]);
  assert.match(proof.error ?? "", /Tweakers-owned processes.*102/);
});

test("an identical path outside the exact ChatGPT ancestry is not claimed", () => {
  const mcpPath = `${TWEAKS_ROOT}/user-questions/mcp-server.js`;
  const proof = proveRegularChatGptMcpRuntime({
    mainPid: 100,
    configPath: "/Users/test/.codex/config.toml",
    tweaksRoot: TWEAKS_ROOT,
    configurationChanged: false,
  }, dependencies([
    proc(100, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
    proc(500, 1, `node ${mcpPath}`),
  ]));

  assert.equal(proof.ok, true);
  assert.deepEqual(proof.ownedProcessPids, []);
});

test("process enumeration failure never proves an empty runtime", () => {
  assert.throws(
    () => proveRegularChatGptMcpRuntime({
      mainPid: 100,
      configPath: "/Users/test/.codex/config.toml",
      tweaksRoot: TWEAKS_ROOT,
      configurationChanged: false,
    }, {
      listProcesses: () => { throw new Error("ps failed"); },
      configMtimeMs: () => null,
    }),
    /ps failed/,
  );
});
