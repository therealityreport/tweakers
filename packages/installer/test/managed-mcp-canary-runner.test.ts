import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createManagedMcpCanaryObservationAdapter,
  runManagedMcpCanary,
  sha256TrustedManagedMcpCanaryRunnerSource,
  type ManagedMcpCallAdapterObservation,
  type ManagedMcpCanaryExpectedRoute,
  type ManagedMcpCanaryObservationAdapterImplementation,
  type ManagedMcpCanaryScenario,
  type ManagedMcpObservedProcess,
  type ManagedMcpProcessSnapshot,
  type ManagedMcpRouteStatusObservation,
} from "../src/managed-mcp-canary-runner.ts";
import {
  MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY,
  mcpCatalogFingerprint,
  prepareManagedMcpLifecycleRuntime,
  readAndVerifyManagedMcpLifecycleOverlay,
  type ManagedMcpConfigReconciliationPlan,
  type ManagedMcpFleetManifest,
  type ManagedMcpFleetManifestEntry,
} from "../src/managed-mcp-lifecycle.ts";

test("derives a complete hybrid canary pass from raw route and process observations", async () => {
  const fixture = createFixture();
  try {
    const input = fixture.input();
    const adapter = createManagedMcpCanaryObservationAdapter(new FakeObservationAdapter(input.expectedRoutes));
    const evidence = await runManagedMcpCanary(input, adapter);

    assert.equal(evidence.status, "passed");
    assert.equal(evidence.observations.routeProofs.length, 20);
    assert.deepEqual(evidence.observations.unsupportedProtocolProofs, []);
    assert.equal(evidence.lifecycle.zeroBeforeDiscovery, true);
    assert.equal(evidence.lifecycle.playwrightProfilesIndependent, true);
    assert.equal(evidence.lifecycle.cleanupAfterAppShutdown, true);
    assert.equal(evidence.pluginBundles.every((plugin) => plugin.routeOwnerProven), true);
  } finally {
    fixture.remove();
  }
});

test("rejects a forged external all-true runner object before accepting any evidence", async () => {
  const forged = {
    implementation: {
      lifecycle: Object.fromEntries([
        "zeroBeforeDiscovery", "launchOnCall", "cleanupAfterSuccess", "cleanupAfterError",
      ].map((key) => [key, true])),
    },
  };
  await assert.rejects(
    runManagedMcpCanary({} as never, forged as never),
    /repository-owned observation adapter API/,
  );
});

test("fails closed when raw discovery observes an eager helper", async () => {
  const fixture = createFixture();
  try {
    const input = fixture.input();
    const fake = new FakeObservationAdapter(input.expectedRoutes);
    fake.eagerAtDiscovery = true;
    await assert.rejects(
      runManagedMcpCanary(input, createManagedMcpCanaryObservationAdapter(fake)),
      /discovery-before|targeted MCP processes/,
    );
  } finally {
    fixture.remove();
  }
});

test("rejects a launched process root whose executable digest is absent from the route receipt", async () => {
  const fixture = createFixture();
  try {
    const original = fixture.input();
    const input = {
      ...original,
      expectedRoutes: original.expectedRoutes.map((route, index) => index === 0
        ? { ...route, artifactSha256: ["d".repeat(64)] }
        : route),
    };
    await assert.rejects(
      runManagedMcpCanary(input, createManagedMcpCanaryObservationAdapter(new FakeObservationAdapter(input.expectedRoutes))),
      /process root executable is not receipt-bound/i,
    );
  } finally {
    fixture.remove();
  }
});

class FakeObservationAdapter implements ManagedMcpCanaryObservationAdapterImplementation {
  eagerAtDiscovery = false;
  private tick = Date.parse("2026-07-20T12:00:00.000Z");
  private nextPid = 5_000;
  private nextTask = 0;
  private nextCall = 0;
  private readonly active = new Map<string, ManagedMcpObservedProcess>();

  constructor(private readonly routes: readonly ManagedMcpCanaryExpectedRoute[]) {}

  async startCandidate(input: {
    executable: string;
    argv: readonly ["app-server"];
    environment: Readonly<Record<string, string>>;
  }) {
    return { pid: 4_999, startedAt: this.now(), ...input };
  }

  async discover() {
    const routes: ManagedMcpRouteStatusObservation[] = this.routes.map((route) => ({
      owner: route.owner,
      server: route.server,
      transport: "local-stdio",
      enabled: true,
      lifecycle: route.lifecycle,
      state: "dormant",
      catalogSha256: route.catalogSha256,
      declarationFingerprint: route.declarationFingerprint,
      artifactSha256: route.artifactSha256,
      tools: [route.representativeTool],
      safeOffReason: null,
    }));
    return { capturedAt: this.now(), routes };
  }

  async snapshotProcesses(): Promise<ManagedMcpProcessSnapshot> {
    if (this.eagerAtDiscovery && this.nextTask === 0) {
      const process = this.process("config/headroom", "eager");
      return { capturedAt: this.now(), processes: [process] };
    }
    return this.snapshot();
  }

  async waitForRouteProcessCount(input: { routeKey: string; taskId: string; count: number }) {
    if (input.count === 0) this.active.delete(`${input.routeKey}\0${input.taskId}`);
    return this.snapshot();
  }

  async openTask(): Promise<string> {
    return `task-${++this.nextTask}`;
  }

  async callTool(input: {
    routeKey: string;
    taskId: string;
    tool: string;
    scenario: ManagedMcpCanaryScenario;
  }): Promise<ManagedMcpCallAdapterObservation> {
    const startedAt = this.now();
    const key = `${input.routeKey}\0${input.taskId}`;
    if (input.scenario !== "startup-failure" && !this.active.has(key)) {
      this.active.set(key, this.process(input.routeKey, input.taskId));
    }
    const during = this.snapshot();
    const route = this.routes.find((candidate) => `${candidate.owner}/${candidate.server}` === input.routeKey)!;
    if (route.lifecycle === "call" || input.scenario !== "success") this.active.delete(key);
    return {
      callId: `call-${++this.nextCall}`,
      routeKey: input.routeKey,
      taskId: input.taskId,
      tool: input.tool,
      scenario: input.scenario,
      outcome: input.scenario,
      startedAt,
      completedAt: this.now(),
      during,
      resultSha256: input.scenario === "success" ? "b".repeat(64) : null,
      errorClass: input.scenario === "success" ? null : `fixture-${input.scenario}`,
    };
  }

  async closeTask(taskId: string): Promise<void> {
    for (const [key, process] of this.active) if (process.taskId === taskId) this.active.delete(key);
  }

  async expireTaskLease(input: { routeKey: string; taskId: string }): Promise<void> {
    this.active.delete(`${input.routeKey}\0${input.taskId}`);
  }

  async shutdown(): Promise<void> {
    this.active.clear();
  }

  private snapshot(): ManagedMcpProcessSnapshot {
    return { capturedAt: this.now(), processes: [...this.active.values()] };
  }

  private process(routeKey: string, taskId: string): ManagedMcpObservedProcess {
    const pid = ++this.nextPid;
    return {
      pid,
      ppid: 4_999,
      startedAt: this.now(),
      executable: "/usr/bin/node",
      executableSha256: "c".repeat(64),
      argv: ["fixture-mcp"],
      routeKey,
      taskId,
    };
  }

  private now(): string {
    const value = new Date(this.tick).toISOString();
    this.tick += 1;
    return value;
  }
}

interface Fixture {
  input(): Parameters<typeof runManagedMcpCanary>[0];
  remove(): void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "managed-mcp-canary-"));
  const catalogs = join(root, "catalog-source");
  const packageRoot = join(root, "artifacts", "playwright-package");
  const chromePackageRoot = join(root, "artifacts", "chrome-package");
  const bundledHelper = join(root, "artifacts", "node-repl");
  const pluginEntrypoint = join(root, "artifacts", "pdfx-server.mjs");
  createPackageRuntimeFixture(packageRoot, "@playwright/mcp", "0.0.99", "playwright-mcp", "../@playwright/mcp/cli.js");
  createPackageRuntimeFixture(chromePackageRoot, "chrome-devtools-mcp", "1.6.0", "chrome-devtools-mcp", "../chrome-devtools-mcp/cli.js");
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(bundledHelper, "bundled-helper\n");
  writeFileSync(pluginEntrypoint, "export {};\n");
  const routeSpecs = [
    ["config", "playwright", "task"], ["config", "headroom", "call"], ["config", "node_repl", "task"],
    ["plugin:chrome-devtools@0.1.0", "chrome-devtools", "task"],
    ["plugin:infographic-docs@1.3.1", "infographic-preview-playwright", "task"],
    ["plugin:build-ios-apps@0.1.2", "xcodebuildmcp", "task"],
    ["plugin:pdfx@0.1.0", "pdfx", "call"], ["plugin:pdfx@0.1.0", "pdfx-apps", "call"],
    ["plugin:shadcn@0.3.0", "shadcn", "call"], ["plugin:shadcn@0.3.0", "shadcn-apps", "call"],
    ["plugin:shadcn@0.3.0", "iconify", "call"], ["plugin:react-doctor@0.1.0", "react-doctor", "call"],
    ["plugin:record-and-replay@1.0.1000451", "event-stream", "task"],
    ["plugin:computer-use@26.715.52143", "computer-use", "task"],
    ["plugin:sites@0.1.30", "sites-design-picker", "call"],
    ["plugin:codex-security@0.1.11", "codex-security", "call"],
    ["plugin:creative-production@0.1.25", "creative_production_mcp", "call"],
    ["plugin:data-analytics@0.2.8", "dataAnalyticsWidgets", "call"],
    ["plugin:openai-developers@1.2.3", "openai-api-key-local-confirmation", "call"],
    ["plugin:decodo@0.1.0", "decodo", "call"],
  ] as const;
  const pluginArtifacts = [...new Map(routeSpecs.flatMap(([owner]) => {
    const match = /^plugin:([^@]+)@(.+)$/.exec(owner);
    return match ? [[match[1]!, { pluginId: match[1]!, version: match[2]! }] as const] : [];
  })).values()].map(({ pluginId, version }) => {
    const bundle = join(root, "artifacts", "plugin-bundles", pluginId);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, ".mcp.json"), "{}\n");
    if (pluginId === "chrome-devtools") {
      mkdirSync(join(bundle, "bin"), { recursive: true });
      writeFileSync(join(bundle, "bin", "chrome-devtools-mcp-locked"), "#!/bin/sh\nexit 0\n");
    }
    return {
      id: `${pluginId}-plugin-bundle`, kind: "plugin-bundle" as const, sourcePath: bundle, version,
      integrity: null, runtimeRelativePath: `plugin-bundles/${pluginId}/${version}`,
    };
  });
  const entries: ManagedMcpFleetManifestEntry[] = routeSpecs.map(([owner, server, lifecycle], index) => {
    const catalog = join(catalogs, `${index}-${server}.json`);
    const bytes = Buffer.from(`${JSON.stringify({ tools: [{ name: `${server}_tool` }] })}\n`);
    mkdirSync(catalogs, { recursive: true });
    writeFileSync(catalog, bytes);
    const declaration = {
      source: fingerprintSource(owner), environmentId: "local", command: `/opt/local/libexec/${server}`,
      args: [], cwd: null, explicitEnv: {}, inheritedEnvPolicy: MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY, inheritedEnv: [],
    } as const;
    return {
      owner, server, declarationFingerprint: mcpCatalogFingerprint({ server, declaration }, bytes), lifecycle,
      idleLeaseSec: lifecycle === "task" ? 300 : 0,
      catalog: { path: catalog, sha256: mcpDigest(bytes) }, required: true, declaration,
    };
  });
  const configReconciliation: ManagedMcpConfigReconciliationPlan = {
    schemaVersion: 1,
    feature: { table: "features", key: "mcp_on_demand", value: true },
    routes: [
      { owner: "config", server: "chrome-devtools", action: "archive-shadow", replacementOwner: "plugin:chrome-devtools@0.1.0", applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "computer-use", action: "archive-shadow", replacementOwner: "plugin:computer-use@26.715.52143", applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "playwright", action: "replace-floating", replacementOwner: null, applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "headroom", action: "retain-attested", replacementOwner: null, applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "node_repl", action: "retain-attested", replacementOwner: null, applyOnlyDuringApprovedCutover: true },
    ],
    applyOnlyDuringApprovedCutover: true,
    mutatesConfigDuringPreparation: false,
  };
  const manifest: ManagedMcpFleetManifest = {
    schemaVersion: 1, inventoryComplete: true, enabledLocalStdioRouteCount: entries.length, entries,
    artifacts: [
      ...pluginArtifacts,
      { id: "chrome", kind: "package", sourcePath: chromePackageRoot, version: "1.6.0", integrity: `sha512-${Buffer.from("chrome").toString("base64")}`, runtimeRelativePath: "packages/chrome/1.6.0" },
      { id: "playwright", kind: "package", sourcePath: packageRoot, version: "0.0.99", integrity: `sha512-${Buffer.from("playwright").toString("base64")}`, runtimeRelativePath: "packages/playwright/0.0.99" },
      { id: "node-repl", kind: "executable", sourcePath: bundledHelper, version: null, integrity: null, runtimeRelativePath: null },
      { id: "pdfx-entrypoint", kind: "plugin-entrypoint", sourcePath: pluginEntrypoint, version: "0.1.0", integrity: null, runtimeRelativePath: "bin/pdfx-server.mjs" },
    ],
    configReconciliation,
  };
  const manifestFile = join(root, "managed-mcp-fleet.v1.json");
  writeJson(manifestFile, manifest);
  const codexHome = join(root, "canary-home");
  const runtime = prepareManagedMcpLifecycleRuntime({
    manifestFile,
    runtimeRoot: join(codexHome, "managed-runtime"),
    now: () => "2026-07-20T11:59:00.000Z",
  });
  const overlay = readAndVerifyManagedMcpLifecycleOverlay(runtime.overlayFile);
  const candidatePath = join(root, "candidate-codex");
  const configPath = join(codexHome, "config.toml");
  writeFileSync(candidatePath, "candidate\n");
  writeFileSync(configPath, "[features]\nmcp_on_demand = true\n");
  const expectedRoutes: ManagedMcpCanaryExpectedRoute[] = overlay.entries.map((entry) => ({
    owner: entry.owner,
    server: entry.server,
    lifecycle: entry.lifecycle,
    idleLeaseSec: entry.idleLeaseSec,
    declarationFingerprint: entry.declarationFingerprint,
    catalogSha256: entry.catalog.sha256,
    artifactSha256: ["c".repeat(64)],
    representativeTool: `${entry.server}_tool`,
    representativeArguments: {},
  }));
  return {
    input: () => ({
      transactionId: "tx-canary", version: "0.145.0-alpha.18", candidatePath,
      candidateSha256: sha256File(candidatePath), codexHome, configPath, configSha256: sha256File(configPath),
      managedRuntime: runtime,
      pluginBundles: pluginArtifacts.map((plugin) => ({
        owner: `plugin:${plugin.id.replace(/-plugin-bundle$/, "")}@${plugin.version}`,
        installedPath: plugin.sourcePath,
        sha256: "a".repeat(64),
      })),
      expectedRoutes,
      trustedRunnerExpectedSha256: sha256TrustedManagedMcpCanaryRunnerSource(),
      trustedAdapterExpectedSha256: sha256TrustedManagedMcpCanaryRunnerSource(),
    }),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createPackageRuntimeFixture(root: string, packageName: string, version: string, binaryName: string, target: string): void {
  const packageRoot = join(root, "node_modules", ...packageName.split("/"));
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ private: true, dependencies: { [packageName]: version } })}\n`);
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: packageName, version })}\n`);
  writeFileSync(join(packageRoot, "cli.js"), "process.exit(0);\n");
  symlinkSync(target, join(bin, binaryName));
}

function fingerprintSource(owner: string) {
  if (owner === "config") return { origin: "config" as const };
  const match = /^plugin:([^@]+)@(.+)$/.exec(owner)!;
  return { origin: "plugin" as const, plugin_id: match[1]!, plugin_version: match[2]! };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mcpDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
