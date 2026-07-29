import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createJsonlManagedMcpAppServerTransport,
  createManagedMcpAppServerObservationAdapter,
  sha256TrustedManagedMcpAppServerAdapterSource,
  type ManagedMcpAppServerAdapterDependencies,
  type ManagedMcpAppServerTransport,
} from "../src/managed-mcp-canary-app-server-adapter.ts";
import type { ManagedMcpCanaryRunInput } from "../src/managed-mcp-canary-runner.ts";

test("JSONL transport correlates responses, notifications, and RPC errors", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const writes: unknown[] = [];
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(line) as { id?: number; method: string };
      writes.push(message);
      if (message.id && message.method === "initialize") {
        stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "fixture" } })}\n`);
      } else if (message.id) {
        stdout.write(`${JSON.stringify({ id: message.id, error: { code: -1, message: "fixture-error" } })}\n`);
      }
    }
  });
  const child = Object.assign(emitter, {
    pid: 4321,
    stdin,
    stdout,
    stderr,
    kill: () => { emitter.emit("exit", null, "SIGKILL"); return true; },
  }) as never;
  const transport = createJsonlManagedMcpAppServerTransport(child);
  assert.deepEqual(await transport.request("initialize", {}), { userAgent: "fixture" });
  transport.notify("initialized");
  await assert.rejects(transport.request("unsupported", {}), /fixture-error/);
  assert.equal((writes[1] as { method: string }).method, "initialized");
  await transport.terminate();
});

test("production adapter uses isolated JSONL/CLI routes and reports unsupported fault hooks", async () => {
  const input = fixtureInput();
  const requests: Array<{ method: string; params: unknown }> = [];
  const launches: unknown[] = [];
  let helperRunning = false;
  const transport: ManagedMcpAppServerTransport = {
    pid: 7000,
    async request(method, params) {
      requests.push({ method, params });
      if (method === "initialize") return {};
      if (method === "mcpServerStatus/list") return {
        data: [{
          name: "headroom",
          owner: "config",
          lifecycle: "on_demand_call",
          lifecycleState: "dormant",
          catalogDigest: `sha256:${"a".repeat(64)}`,
          reason: null,
          tools: { ping: { name: "ping" } },
        }],
        nextCursor: null,
      };
      if (method === "thread/start") return { thread: { id: "thread-fixture" } };
      if (method === "mcpServer/tool/call") {
        helperRunning = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        helperRunning = false;
        return { content: [{ type: "text", text: "ok" }] };
      }
      if (method === "thread/delete") return {};
      throw new Error(`unexpected ${method}`);
    },
    notify(method) { requests.push({ method, params: undefined }); },
    async terminate() {},
  };
  const dependencies: ManagedMcpAppServerAdapterDependencies = {
    launch(spec) { launches.push(spec); return transport; },
    async census() {
      return helperRunning ? [{
        pid: 7001,
        ppid: 7000,
        startedAt: "2026-07-20T12:00:00.000Z",
        executable: "/usr/bin/node",
        executableSha256: "b".repeat(64),
        argv: ["fixture-helper"],
      }] : [];
    },
    async listCli() {
      return [{
        name: "headroom",
        owner: "config",
        lifecycle: "on_demand_call",
        lifecycle_state: "dormant",
        catalog_digest: `sha256:${"a".repeat(64)}`,
        enabled: true,
        transport: { type: "stdio", command: "/fixture/headroom" },
      }];
    },
    now: monotonicClock(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const adapter = createManagedMcpAppServerObservationAdapter(input, dependencies);
  assert.deepEqual(adapter.capabilities, { controlledLeaseExpiry: false, faultInjection: false });
  const implementation = adapter.implementation;
  await implementation.startCandidate({
    executable: input.candidatePath,
    argv: ["app-server"],
    environment: { CODEX_HOME: input.codexHome, CODEX_MANAGED_MCP_ROOT: input.managedRuntime.managedPackageRoot },
  });
  const status = await implementation.discover();
  assert.equal(status.routes[0]?.state, "dormant");
  assert.equal(status.routes[0]?.declarationFingerprint, null);
  const taskId = await implementation.openTask("fixture");
  const call = await implementation.callTool({
    routeKey: "config/headroom",
    taskId,
    tool: "ping",
    arguments: {},
    scenario: "success",
  });
  assert.equal(call.outcome, "success");
  assert.equal(call.during.processes[0]?.routeKey, "config/headroom");
  await assert.rejects(implementation.callTool({
    routeKey: "config/headroom",
    taskId,
    tool: "ping",
    arguments: {},
    scenario: "cancel",
  }), /proof unavailable.*cancel/i);
  await implementation.closeTask(taskId);
  await implementation.shutdown();
  const launch = launches[0] as { cwd: string; argv: string[]; environment: Record<string, string> };
  assert.equal(launch.cwd, input.codexHome);
  assert.deepEqual(launch.argv, ["app-server"]);
  assert.equal(launch.environment.HOME, input.codexHome);
  assert.equal(requests.some((request) => request.method === "thread/delete"), true);
});

function fixtureInput(): ManagedMcpCanaryRunInput {
  const root = "/private/tmp/managed-mcp-adapter-fixture";
  return {
    transactionId: "tx-adapter",
    version: "0.145.0-alpha.18",
    candidatePath: "/private/tmp/managed-mcp-adapter-fixture/codex",
    candidateSha256: "c".repeat(64),
    codexHome: root,
    configPath: `${root}/config.toml`,
    configSha256: "d".repeat(64),
    managedRuntime: {
      runtimeRoot: `${root}/managed-runtime`,
      managedPackageRoot: `${root}/managed-runtime/packages`,
    } as never,
    pluginBundles: [],
    expectedRoutes: [{
      owner: "config",
      server: "headroom",
      lifecycle: "call",
      idleLeaseSec: 0,
      declarationFingerprint: `sha256:${"e".repeat(64)}`,
      catalogSha256: `sha256:${"a".repeat(64)}`,
      artifactSha256: ["b".repeat(64)],
      representativeTool: "ping",
      representativeArguments: {},
    }],
    trustedRunnerExpectedSha256: "f".repeat(64),
    trustedAdapterExpectedSha256: sha256TrustedManagedMcpAppServerAdapterSource(),
  };
}

function monotonicClock(): () => string {
  let value = Date.parse("2026-07-20T12:00:00.000Z");
  return () => new Date(value++).toISOString();
}
