import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_MANAGED_MCP_FLEET_ROUTES,
  assertManagedMcpPreparedRuntimeEvidence,
  type ManagedMcpLifecycle,
  type ManagedMcpPreparedRuntimeEvidence,
} from "./managed-mcp-lifecycle.js";
import type { CodexRustLifecycleTestEvidence } from "./codex-derived-receipt.js";

export const MANAGED_MCP_CANARY_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const MANAGED_MCP_CANARY_REQUIRED_ROUTE_COUNT = 20 as const;
export const MANAGED_MCP_CANARY_CLEANUP_DEADLINE_MS = 10_000 as const;

export type ManagedMcpCanaryScenario =
  | "success"
  | "error"
  | "timeout"
  | "cancel"
  | "startup-failure"
  | "dropped-caller";

export interface ManagedMcpCanaryExpectedRoute {
  owner: string;
  server: string;
  lifecycle: ManagedMcpLifecycle;
  idleLeaseSec: number;
  declarationFingerprint: string;
  catalogSha256: string;
  artifactSha256: readonly string[];
  artifacts: readonly { path: string; sha256: string }[];
  representativeTool: string;
  representativeArguments: Readonly<Record<string, unknown>>;
}

export interface ManagedMcpCanaryPluginInput {
  owner: string;
  installedPath: string;
  sha256: string;
}

export interface ManagedMcpCanaryRunInput {
  transactionId: string;
  version: string;
  candidatePath: string;
  candidateSha256: string;
  codexHome: string;
  configPath: string;
  configSha256: string;
  managedRuntime: ManagedMcpPreparedRuntimeEvidence;
  pluginBundles: readonly ManagedMcpCanaryPluginInput[];
  expectedRoutes: readonly ManagedMcpCanaryExpectedRoute[];
  /** Digest bound into candidate state before this repository-owned source executes. */
  trustedRunnerExpectedSha256: string;
  /** Digest of the repository-owned app-server adapter bound into candidate state. */
  trustedAdapterExpectedSha256: string;
  rustLifecycleTests: CodexRustLifecycleTestEvidence;
  cleanupDeadlineMs?: number;
}

export interface ManagedMcpObservedProcess {
  pid: number;
  ppid: number;
  startedAt: string;
  executable: string;
  executableSha256: string;
  argv: readonly string[];
  commandLine: string;
  artifactIdentities: readonly {
    path: string;
    sha256: string;
    source: "executable" | "argv" | "open-file";
  }[];
  /** Assigned from the candidate's process ownership/status telemetry, not argv guessing. */
  routeKey: string | null;
  taskId: string | null;
}

export interface ManagedMcpProcessSnapshot {
  capturedAt: string;
  processes: readonly ManagedMcpObservedProcess[];
}

export interface ManagedMcpRouteStatusObservation {
  owner: string;
  server: string;
  transport: "local-stdio" | "remote-http";
  enabled: boolean;
  lifecycle: ManagedMcpLifecycle | "legacy_eager" | null;
  state: "dormant" | "running" | "legacy_eager" | "safe_off";
  catalogSha256: string | null;
  declarationFingerprint: string | null;
  artifactSha256: readonly string[];
  tools: readonly string[];
  safeOffReason: string | null;
}

export interface ManagedMcpStatusSnapshot {
  capturedAt: string;
  routes: readonly ManagedMcpRouteStatusObservation[];
}

export interface ManagedMcpCandidateStartObservation {
  pid: number;
  startedAt: string;
  executable: string;
  argv: readonly string[];
  environment: Readonly<Record<string, string>>;
}

export interface ManagedMcpCallAdapterObservation {
  callId: string;
  routeKey: string;
  taskId: string;
  tool: string;
  scenario: ManagedMcpCanaryScenario;
  outcome: ManagedMcpCanaryScenario;
  startedAt: string;
  completedAt: string;
  during: ManagedMcpProcessSnapshot;
  resultSha256: string | null;
  errorClass: string | null;
}

export interface ManagedMcpCallProof extends ManagedMcpCallAdapterObservation {
  before: ManagedMcpProcessSnapshot;
  after: ManagedMcpProcessSnapshot;
}

export interface ManagedMcpRouteProof {
  routeKey: string;
  lifecycle: ManagedMcpLifecycle;
  calls: readonly ManagedMcpCallProof[];
  taskIds: readonly string[];
  processRootPids: readonly number[];
  cleanupSnapshots: readonly {
    reason: "call-complete" | "task-close" | "lease-expiry";
    taskId: string;
    snapshot: ManagedMcpProcessSnapshot;
  }[];
  cleanupObservedAt: string;
}

export interface ManagedMcpLifecycleMatrix {
  zeroBeforeDiscovery: true;
  launchOnCall: true;
  cleanupAfterSuccess: true;
  cleanupAfterTaskClose: true;
  cleanupAfterAppShutdown: true;
  callScopedReturnsToZero: true;
  taskScopedReuseWithinLease: true;
  taskScopedIsolation: true;
  playwrightProfilesIndependent: true;
  allExpectedToolsCallable: true;
  noCatalogMismatch: true;
  noPackageDrift: true;
  noOrphanedParent: true;
}

export interface ManagedMcpCanaryEvidence {
  schemaVersion: typeof MANAGED_MCP_CANARY_EVIDENCE_SCHEMA_VERSION;
  kind: "managed-mcp-observed-canary";
  status: "passed";
  transactionId: string;
  version: string;
  candidate: { path: string; sha256: string };
  isolatedHome: { root: string; configPath: string; configSha256: string };
  managedMcp: {
    runtimeRoot: string;
    managedPackageRoot: string;
    runtimeTreeSha256: string;
    overlayPath: string;
    overlaySha256: string;
    fleetFingerprint: string;
    requiredCoverage: readonly string[];
    mcpOnDemandEnabled: true;
  };
  pluginBundles: readonly {
    owner: string;
    installedPath: string;
    sha256: string;
    routeOwnerProven: true;
  }[];
  trustedRunner: { identity: string; attestationSha256: string };
  trustedObservationAdapter: { identity: string; attestationSha256: string };
  rustLifecycleTests: CodexRustLifecycleTestEvidence;
  observations: {
    candidateStart: ManagedMcpCandidateStartObservation;
    discoveryBefore: ManagedMcpProcessSnapshot;
    discoveryStatus: ManagedMcpStatusSnapshot;
    discoveryAfter: ManagedMcpProcessSnapshot;
    routeProofs: readonly ManagedMcpRouteProof[];
    unsupportedProtocolProofs: readonly string[];
    shutdownBefore: ManagedMcpProcessSnapshot;
    shutdownAfter: ManagedMcpProcessSnapshot;
  };
  lifecycle: ManagedMcpLifecycleMatrix;
  startedAt: string;
  completedAt: string;
}

export interface ManagedMcpCanaryObservationAdapterImplementation {
  startCandidate(input: {
    executable: string;
    argv: readonly ["app-server"];
    environment: Readonly<Record<string, string>>;
  }): Promise<ManagedMcpCandidateStartObservation>;
  discover(): Promise<ManagedMcpStatusSnapshot>;
  snapshotProcesses(): Promise<ManagedMcpProcessSnapshot>;
  waitForRouteProcessCount(input: {
    routeKey: string;
    taskId: string;
    count: number;
    deadlineMs: number;
  }): Promise<ManagedMcpProcessSnapshot>;
  openTask(label: string): Promise<string>;
  callTool(input: {
    routeKey: string;
    taskId: string;
    tool: string;
    arguments: Readonly<Record<string, unknown>>;
    scenario: ManagedMcpCanaryScenario;
  }): Promise<ManagedMcpCallAdapterObservation>;
  closeTask(taskId: string): Promise<void>;
  expireTaskLease(input: { routeKey: string; taskId: string; idleLeaseSec: number }): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ManagedMcpCanaryObservationAdapter {
  readonly implementation: ManagedMcpCanaryObservationAdapterImplementation;
  readonly attestation: { identity: string; sha256: string };
  readonly capabilities: {
    controlledLeaseExpiry: boolean;
    faultInjection: boolean;
  };
}

const trustedAdapters = new WeakSet<object>();

/**
 * Brand a low-level observation adapter. There is deliberately no adapter for
 * importing an external pass/fail JSON document: the runner computes every
 * acceptance bit from status, process, and call observations.
 */
export function createManagedMcpCanaryObservationAdapter(
  implementation: ManagedMcpCanaryObservationAdapterImplementation,
  options: {
    attestation?: { identity: string; sha256: string };
    capabilities?: { controlledLeaseExpiry: boolean; faultInjection: boolean };
  } = {},
): ManagedMcpCanaryObservationAdapter {
  const adapter = Object.freeze({
    implementation,
    attestation: Object.freeze(options.attestation ?? {
      identity: trustedManagedMcpCanaryRunnerSourcePath(),
      sha256: sha256TrustedManagedMcpCanaryRunnerSource(),
    }),
    capabilities: Object.freeze(options.capabilities ?? {
      controlledLeaseExpiry: true,
      faultInjection: true,
    }),
  });
  trustedAdapters.add(adapter);
  return adapter;
}

export function trustedManagedMcpCanaryRunnerSourcePath(): string {
  return fileURLToPath(import.meta.url);
}

export function sha256TrustedManagedMcpCanaryRunnerSource(
  sourcePath = trustedManagedMcpCanaryRunnerSourcePath(),
): string {
  return sha256File(sourcePath);
}

export async function runManagedMcpCanary(
  input: ManagedMcpCanaryRunInput,
  adapter: ManagedMcpCanaryObservationAdapter,
): Promise<ManagedMcpCanaryEvidence> {
  if (!trustedAdapters.has(adapter)) {
    throw new Error("Managed MCP canary requires the repository-owned observation adapter API");
  }
  validateRunInput(input);
  const implementation = adapter.implementation;
  const runnerPath = trustedManagedMcpCanaryRunnerSourcePath();
  const runnerSha256 = sha256TrustedManagedMcpCanaryRunnerSource(runnerPath);
  if (runnerSha256 !== input.trustedRunnerExpectedSha256) {
    throw new Error("Managed MCP canary runner source digest does not match candidate state");
  }
  if (adapter.attestation.sha256 !== input.trustedAdapterExpectedSha256
    || sha256File(adapter.attestation.identity) !== adapter.attestation.sha256) {
    throw new Error("Managed MCP canary adapter source digest does not match candidate state");
  }
  const startedAt = new Date().toISOString();
  const environment = {
    CODEX_HOME: input.codexHome,
    CODEX_MANAGED_MCP_ROOT: input.managedRuntime.managedPackageRoot,
  };
  const candidateStart = await implementation.startCandidate({
    executable: input.candidatePath,
    argv: ["app-server"],
    environment,
  });
  assertCandidateStart(candidateStart, input, environment);

  const discoveryBefore = await implementation.snapshotProcesses();
  assertSnapshot(discoveryBefore, "discovery-before");
  assertTargetedRouteCount(discoveryBefore, 0, "discovery-before");
  const discoveryStatus = await implementation.discover();
  validateStatusSnapshot(discoveryStatus, input.expectedRoutes);
  const discoveryAfter = await implementation.snapshotProcesses();
  assertSnapshot(discoveryAfter, "discovery-after");
  assertTargetedRouteCount(discoveryAfter, 0, "discovery-after");

  const cleanupDeadlineMs = input.cleanupDeadlineMs ?? MANAGED_MCP_CANARY_CLEANUP_DEADLINE_MS;
  const routeProofs: ManagedMcpRouteProof[] = [];
  try {
    for (const route of input.expectedRoutes) {
      routeProofs.push(route.lifecycle === "call"
        ? await proveCallScopedRoute(implementation, route, cleanupDeadlineMs)
        : await proveTaskScopedRoute(
          implementation,
          route,
          cleanupDeadlineMs,
          adapter.capabilities.controlledLeaseExpiry,
        ));
    }
    const unsupportedProtocolProofs = [
      ...(adapter.capabilities.faultInjection ? [] : [
        "mcp-call-error-injection",
        "mcp-call-timeout-injection",
        "mcp-call-cancellation",
        "mcp-startup-error-injection",
        "mcp-dropped-caller-injection",
      ]),
      ...(adapter.capabilities.controlledLeaseExpiry ? [] : ["controlled-task-lease-expiry"]),
    ];

    const shutdownRoute = input.expectedRoutes.find((route) => route.lifecycle === "task");
    if (!shutdownRoute) throw new Error("Managed MCP canary requires a task-scoped route");
    const shutdownTask = await implementation.openTask("canary-shutdown");
    await observeCall(
      implementation,
      shutdownRoute,
      shutdownTask,
      "success",
      cleanupDeadlineMs,
      /*expectQuiescentAfter*/ false,
    );
    const shutdownBefore = await implementation.snapshotProcesses();
    assertRouteProcessCount(shutdownBefore, routeKey(shutdownRoute), shutdownTask, 1, "shutdown-before", true);
    await implementation.shutdown();
    const shutdownAfter = await implementation.snapshotProcesses();
    assertSnapshot(shutdownAfter, "shutdown-after");
    assertTargetedRouteCount(shutdownAfter, 0, "shutdown-after");

    const lifecycle = deriveLifecycleMatrix({
      routes: input.expectedRoutes,
      routeProofs,
      discoveryBefore,
      discoveryAfter,
      discoveryStatus,
      shutdownBefore,
      shutdownAfter,
      cleanupDeadlineMs,
    });
    const evidence: ManagedMcpCanaryEvidence = {
      schemaVersion: MANAGED_MCP_CANARY_EVIDENCE_SCHEMA_VERSION,
      kind: "managed-mcp-observed-canary",
      status: "passed",
      transactionId: input.transactionId,
      version: input.version,
      candidate: { path: input.candidatePath, sha256: input.candidateSha256 },
      isolatedHome: { root: input.codexHome, configPath: input.configPath, configSha256: input.configSha256 },
      managedMcp: {
        runtimeRoot: input.managedRuntime.runtimeRoot,
        managedPackageRoot: input.managedRuntime.managedPackageRoot,
        runtimeTreeSha256: input.managedRuntime.runtimeTreeSha256,
        overlayPath: input.managedRuntime.overlayFile,
        overlaySha256: input.managedRuntime.overlaySha256,
        fleetFingerprint: input.managedRuntime.fleetFingerprint,
        requiredCoverage: input.managedRuntime.requiredCoverage,
        mcpOnDemandEnabled: true,
      },
      pluginBundles: input.pluginBundles.map((plugin) => ({ ...plugin, routeOwnerProven: true as const })),
      trustedRunner: { identity: runnerPath, attestationSha256: runnerSha256 },
      trustedObservationAdapter: {
        identity: adapter.attestation.identity,
        attestationSha256: adapter.attestation.sha256,
      },
      rustLifecycleTests: { ...input.rustLifecycleTests },
      observations: {
        candidateStart,
        discoveryBefore,
        discoveryStatus,
        discoveryAfter,
        routeProofs,
        unsupportedProtocolProofs,
        shutdownBefore,
        shutdownAfter,
      },
      lifecycle,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    assertManagedMcpCanaryEvidence(evidence, input);
    return evidence;
  } catch (error) {
    await implementation.shutdown().catch(() => undefined);
    throw error;
  }
}

export function assertManagedMcpCanaryEvidence(
  evidence: unknown,
  input: ManagedMcpCanaryRunInput,
): asserts evidence is ManagedMcpCanaryEvidence {
  validateRunInput(input);
  if (!isRecord(evidence)) throw new Error("Managed MCP canary evidence is not an object");
  assertExactKeys(evidence, [
    "schemaVersion", "kind", "status", "transactionId", "version", "candidate", "isolatedHome",
    "managedMcp", "pluginBundles", "trustedRunner", "trustedObservationAdapter", "rustLifecycleTests",
    "observations", "lifecycle", "startedAt", "completedAt",
  ], "Managed MCP canary evidence");
  if (
    evidence.schemaVersion !== 1
    || evidence.kind !== "managed-mcp-observed-canary"
    || evidence.status !== "passed"
    || evidence.transactionId !== input.transactionId
    || evidence.version !== input.version
    || !isRecord(evidence.candidate)
    || evidence.candidate.path !== input.candidatePath
    || evidence.candidate.sha256 !== input.candidateSha256
    || !isRecord(evidence.isolatedHome)
    || evidence.isolatedHome.root !== input.codexHome
    || evidence.isolatedHome.configPath !== input.configPath
    || evidence.isolatedHome.configSha256 !== input.configSha256
    || !isRecord(evidence.trustedRunner)
    || evidence.trustedRunner.identity !== trustedManagedMcpCanaryRunnerSourcePath()
    || evidence.trustedRunner.attestationSha256 !== input.trustedRunnerExpectedSha256
    || !isRecord(evidence.trustedObservationAdapter)
    || typeof evidence.trustedObservationAdapter.identity !== "string"
    || evidence.trustedObservationAdapter.attestationSha256 !== input.trustedAdapterExpectedSha256
    || !validTimestamp(evidence.startedAt)
    || !validTimestamp(evidence.completedAt)
    || Date.parse(evidence.startedAt as string) > Date.parse(evidence.completedAt as string)
  ) {
    throw new Error("Managed MCP canary evidence is not bound to the prepared candidate");
  }
  if (!isRecord(evidence.observations) || !isRecord(evidence.lifecycle)) {
    throw new Error("Managed MCP canary observations are missing");
  }
  assertLifecycleTrue(evidence.lifecycle);
  const observations = evidence.observations as unknown as ManagedMcpCanaryEvidence["observations"];
  assertEvidenceBindings(evidence, input);
  validateStatusSnapshot(observations.discoveryStatus, input.expectedRoutes);
  const recomputed = deriveLifecycleMatrix({
    routes: input.expectedRoutes,
    routeProofs: observations.routeProofs,
    discoveryBefore: observations.discoveryBefore,
    discoveryAfter: observations.discoveryAfter,
    discoveryStatus: observations.discoveryStatus,
    shutdownBefore: observations.shutdownBefore,
    shutdownAfter: observations.shutdownAfter,
    cleanupDeadlineMs: input.cleanupDeadlineMs ?? MANAGED_MCP_CANARY_CLEANUP_DEADLINE_MS,
  });
  if (JSON.stringify(recomputed) !== JSON.stringify(evidence.lifecycle)) {
    throw new Error("Managed MCP lifecycle matrix was not derived from the recorded observations");
  }
}

function assertEvidenceBindings(
  evidence: Record<string, unknown>,
  input: ManagedMcpCanaryRunInput,
): void {
  const actual = evidence as unknown as ManagedMcpCanaryEvidence;
  const expectedManagedMcp: ManagedMcpCanaryEvidence["managedMcp"] = {
    runtimeRoot: input.managedRuntime.runtimeRoot,
    managedPackageRoot: input.managedRuntime.managedPackageRoot,
    runtimeTreeSha256: input.managedRuntime.runtimeTreeSha256,
    overlayPath: input.managedRuntime.overlayFile,
    overlaySha256: input.managedRuntime.overlaySha256,
    fleetFingerprint: input.managedRuntime.fleetFingerprint,
    requiredCoverage: input.managedRuntime.requiredCoverage,
    mcpOnDemandEnabled: true,
  };
  if (JSON.stringify(actual.managedMcp) !== JSON.stringify(expectedManagedMcp)) {
    throw new Error("Managed MCP canary runtime evidence is not receipt-bound");
  }
  const expectedPlugins = input.pluginBundles.map((plugin) => ({ ...plugin, routeOwnerProven: true as const }));
  if (JSON.stringify(actual.pluginBundles) !== JSON.stringify(expectedPlugins)) {
    throw new Error("Managed MCP canary plugin evidence is not receipt-bound");
  }
  if (JSON.stringify(actual.rustLifecycleTests) !== JSON.stringify(input.rustLifecycleTests)) {
    throw new Error("Managed MCP canary Rust lifecycle evidence is not receipt-bound");
  }
  assertCandidateStart(actual.observations.candidateStart, input, {
    CODEX_HOME: input.codexHome,
    CODEX_MANAGED_MCP_ROOT: input.managedRuntime.managedPackageRoot,
  });
  for (const plugin of input.pluginBundles) {
    if (!input.expectedRoutes.some((route) => route.owner === plugin.owner)) {
      throw new Error(`Managed MCP installed plugin owner has no verified route: ${plugin.owner}`);
    }
  }
}

export function writeManagedMcpCanaryEvidence(file: string, evidence: ManagedMcpCanaryEvidence): void {
  requireAbsolutePath(file, "Managed MCP canary evidence file");
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  const directory = openSync(dirname(file), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  rmSync(temporary, { force: true });
}

async function proveCallScopedRoute(
  adapter: ManagedMcpCanaryObservationAdapterImplementation,
  route: ManagedMcpCanaryExpectedRoute,
  cleanupDeadlineMs: number,
): Promise<ManagedMcpRouteProof> {
  const taskId = await adapter.openTask(`canary-call-${route.server}`);
  try {
    const proof = await observeCall(adapter, route, taskId, "success", cleanupDeadlineMs, true);
    return {
      routeKey: routeKey(route),
      lifecycle: "call",
      calls: [proof],
      taskIds: [taskId],
      processRootPids: rootPids(proof.during, routeKey(route), taskId),
      cleanupSnapshots: [{ reason: "call-complete", taskId, snapshot: proof.after }],
      cleanupObservedAt: proof.after.capturedAt,
    };
  } finally {
    await adapter.closeTask(taskId);
  }
}

async function proveTaskScopedRoute(
  adapter: ManagedMcpCanaryObservationAdapterImplementation,
  route: ManagedMcpCanaryExpectedRoute,
  cleanupDeadlineMs: number,
  controlledLeaseExpiry: boolean,
): Promise<ManagedMcpRouteProof> {
  const key = routeKey(route);
  const taskA = await adapter.openTask(`canary-task-a-${route.server}`);
  const taskB = await adapter.openTask(`canary-task-b-${route.server}`);
  const calls: ManagedMcpCallProof[] = [];
  try {
    const first = await observeCall(adapter, route, taskA, "success", cleanupDeadlineMs, false);
    const second = await observeCall(adapter, route, taskA, "success", cleanupDeadlineMs, false);
    const otherTask = await observeCall(adapter, route, taskB, "success", cleanupDeadlineMs, false);
    calls.push(first, second, otherTask);
    const rootsA = rootPids(first.during, key, taskA);
    const rootsASecond = rootPids(second.during, key, taskA);
    const rootsB = rootPids(otherTask.during, key, taskB);
    if (rootsA.length !== 1 || JSON.stringify(rootsA) !== JSON.stringify(rootsASecond)) {
      throw new Error(`Task-scoped route ${key} did not reuse one process root within its lease`);
    }
    if (rootsB.length !== 1 || rootsB[0] === rootsA[0]) {
      throw new Error(`Task-scoped route ${key} leaked a process root across tasks`);
    }
    await adapter.closeTask(taskB);
    const afterTaskBClose = await adapter.waitForRouteProcessCount({
      routeKey: key,
      taskId: taskB,
      count: 0,
      deadlineMs: cleanupDeadlineMs,
    });
    assertRouteProcessCount(afterTaskBClose, key, taskB, 0, `${key} task B close`);
    await adapter.closeTask(taskA);
    const afterClose = await adapter.waitForRouteProcessCount({ routeKey: key, taskId: taskA, count: 0, deadlineMs: cleanupDeadlineMs });
    assertRouteProcessCount(afterClose, key, taskA, 0, `${key} task close`);

    let leaseTask: string | null = null;
    let afterLease: ManagedMcpProcessSnapshot | null = null;
    if (controlledLeaseExpiry) {
      leaseTask = await adapter.openTask(`canary-lease-${route.server}`);
      const leaseCall = await observeCall(adapter, route, leaseTask, "success", cleanupDeadlineMs, false);
      calls.push(leaseCall);
      await adapter.expireTaskLease({ routeKey: key, taskId: leaseTask, idleLeaseSec: route.idleLeaseSec });
      afterLease = await adapter.waitForRouteProcessCount({ routeKey: key, taskId: leaseTask, count: 0, deadlineMs: cleanupDeadlineMs });
      assertRouteProcessCount(afterLease, key, leaseTask, 0, `${key} lease expiry`);
      await adapter.closeTask(leaseTask);
    }
    return {
      routeKey: key,
      lifecycle: "task",
      calls,
      taskIds: [taskA, taskB, ...(leaseTask ? [leaseTask] : [])],
      processRootPids: [...new Set([...rootsA, ...rootsB])].sort((a, b) => a - b),
      cleanupSnapshots: [
        { reason: "task-close", taskId: taskB, snapshot: afterTaskBClose },
        { reason: "task-close", taskId: taskA, snapshot: afterClose },
        ...(leaseTask && afterLease
          ? [{ reason: "lease-expiry" as const, taskId: leaseTask, snapshot: afterLease }]
          : []),
      ],
      cleanupObservedAt: (afterLease ?? afterClose).capturedAt,
    };
  } finally {
    await adapter.closeTask(taskB).catch(() => undefined);
    await adapter.closeTask(taskA).catch(() => undefined);
  }
}

async function observeCall(
  adapter: ManagedMcpCanaryObservationAdapterImplementation,
  route: ManagedMcpCanaryExpectedRoute,
  taskId: string,
  scenario: ManagedMcpCanaryScenario,
  cleanupDeadlineMs: number,
  expectQuiescentAfter: boolean,
): Promise<ManagedMcpCallProof> {
  const key = routeKey(route);
  const before = await adapter.snapshotProcesses();
  assertSnapshot(before, `${key} ${scenario} before`);
  const call = await adapter.callTool({
    routeKey: key,
    taskId,
    tool: route.representativeTool,
    arguments: route.representativeArguments,
    scenario,
  });
  assertCallObservation(call, route, taskId, scenario);
  if (scenario !== "startup-failure") {
    assertRouteProcessCount(call.during, key, taskId, 1, `${key} ${scenario} during`, true);
  }
  const after = expectQuiescentAfter
    ? await adapter.waitForRouteProcessCount({ routeKey: key, taskId, count: 0, deadlineMs: cleanupDeadlineMs })
    : await adapter.snapshotProcesses();
  assertSnapshot(after, `${key} ${scenario} after`);
  if (expectQuiescentAfter) {
    assertRouteProcessCount(after, key, taskId, 0, `${key} ${scenario} cleanup`);
    const cleanupElapsed = Date.parse(after.capturedAt) - Date.parse(call.completedAt);
    if (cleanupElapsed < 0 || cleanupElapsed > cleanupDeadlineMs) {
      throw new Error(`Managed MCP route ${key} cleanup exceeded ${cleanupDeadlineMs}ms`);
    }
  }
  return { ...call, before, after };
}

function deriveLifecycleMatrix(input: {
  routes: readonly ManagedMcpCanaryExpectedRoute[];
  routeProofs: readonly ManagedMcpRouteProof[];
  discoveryBefore: ManagedMcpProcessSnapshot;
  discoveryAfter: ManagedMcpProcessSnapshot;
  discoveryStatus: ManagedMcpStatusSnapshot;
  shutdownBefore: ManagedMcpProcessSnapshot;
  shutdownAfter: ManagedMcpProcessSnapshot;
  cleanupDeadlineMs: number;
}): ManagedMcpLifecycleMatrix {
  if (input.routeProofs.length !== input.routes.length) throw new Error("Managed MCP per-route proof coverage is incomplete");
  const proofByKey = new Map(input.routeProofs.map((proof) => [proof.routeKey, proof]));
  for (const route of input.routes) {
    const key = routeKey(route);
    const proof = proofByKey.get(key);
    if (!proof || proof.lifecycle !== route.lifecycle || proof.calls.length === 0) {
      throw new Error(`Managed MCP route proof missing for ${key}`);
    }
    for (const call of proof.calls) assertCallProof(call, route, input.cleanupDeadlineMs);
  }
  assertTargetedRouteCount(input.discoveryBefore, 0, "discovery-before");
  assertTargetedRouteCount(input.discoveryAfter, 0, "discovery-after");
  assertSnapshot(input.shutdownBefore, "shutdown-before");
  if (targeted(input.shutdownBefore).length === 0) {
    throw new Error("App shutdown proof did not begin with a running helper");
  }
  assertTargetedRouteCount(input.shutdownAfter, 0, "shutdown-after");
  validateStatusSnapshot(input.discoveryStatus, input.routes);
  const taskProofs = input.routeProofs.filter((proof) => proof.lifecycle === "task");
  const callProofs = input.routeProofs.filter((proof) => proof.lifecycle === "call");
  if (taskProofs.length === 0 || callProofs.length === 0) throw new Error("Hybrid lifecycle classes were not both exercised");
  for (const proof of taskProofs) {
    if (proof.calls.length < 3 || proof.taskIds.length < 2 || proof.processRootPids.length < 2) {
      throw new Error(`Task lifecycle proof is incomplete for ${proof.routeKey}`);
    }
    const [first, second, otherTask] = proof.calls;
    const firstRoots = first ? rootPids(first.during, proof.routeKey, first.taskId) : [];
    const secondRoots = second ? rootPids(second.during, proof.routeKey, second.taskId) : [];
    const otherRoots = otherTask ? rootPids(otherTask.during, proof.routeKey, otherTask.taskId) : [];
    if (!first || !second || !otherTask
      || first.taskId !== second.taskId
      || otherTask.taskId === first.taskId
      || JSON.stringify(firstRoots) !== JSON.stringify(secondRoots)
      || otherRoots.some((pid) => firstRoots.includes(pid))) {
      throw new Error(`Task reuse or cross-task isolation evidence is invalid for ${proof.routeKey}`);
    }
    const closedTasks = new Set(proof.cleanupSnapshots
      .filter((item) => item.reason === "task-close")
      .map((item) => item.taskId));
    if (!closedTasks.has(first.taskId) || !closedTasks.has(otherTask.taskId)) {
      throw new Error(`Task-close snapshots are missing for ${proof.routeKey}`);
    }
    for (const cleanup of proof.cleanupSnapshots) {
      assertRouteProcessCount(
        cleanup.snapshot,
        proof.routeKey,
        cleanup.taskId,
        0,
        `${proof.routeKey} ${cleanup.reason}`,
      );
    }
  }
  for (const proof of callProofs) {
    if (proof.calls.some((call) => targeted(call.after).length !== 0)) {
      throw new Error(`Call lifecycle cleanup is incomplete for ${proof.routeKey}`);
    }
  }
  const playwright = input.routeProofs.filter((proof) =>
    proof.routeKey.endsWith("/playwright") || proof.routeKey.endsWith("/infographic-preview-playwright")
  );
  if (playwright.length !== 2) throw new Error("Both Playwright profiles were not proved independently");
  const playwrightRoots = playwright.map((proof) => proof.processRootPids[0]);
  if (playwrightRoots.some((pid) => pid === undefined) || new Set(playwrightRoots).size !== 2) {
    throw new Error("Playwright profiles did not use independent owning process roots");
  }
  return lifecycleTrueMatrix();
}

function validateRunInput(input: ManagedMcpCanaryRunInput): void {
  requireNonEmpty(input.transactionId, "transaction id");
  requireNonEmpty(input.version, "candidate version");
  requireExactFile(input.candidatePath, input.candidateSha256, "candidate binary");
  requireAbsolutePath(input.codexHome, "isolated CODEX_HOME");
  requireExactFile(input.configPath, input.configSha256, "isolated config");
  if (input.configPath !== resolve(input.codexHome, "config.toml")) {
    throw new Error("Managed MCP canary config must be the isolated CODEX_HOME config.toml");
  }
  const config = readFileSync(input.configPath, "utf8");
  if (!/^\s*mcp_on_demand\s*=\s*true\s*$/mu.test(config)) {
    throw new Error("Managed MCP canary requires mcp_on_demand = true in isolated config");
  }
  assertManagedMcpPreparedRuntimeEvidence(input.managedRuntime);
  if (input.managedRuntime.runtimeRoot !== resolve(input.codexHome, "managed-runtime")) {
    throw new Error("Managed MCP runtime must be installed under the isolated CODEX_HOME");
  }
  requireSha256(input.trustedRunnerExpectedSha256, "trusted runner digest");
  requireSha256(input.trustedAdapterExpectedSha256, "trusted adapter digest");
  validateRustLifecycleTests(input.rustLifecycleTests, input.candidateSha256);
  if (input.cleanupDeadlineMs !== undefined
    && (!Number.isInteger(input.cleanupDeadlineMs) || input.cleanupDeadlineMs <= 0 || input.cleanupDeadlineMs > 10_000)) {
    throw new Error("Managed MCP cleanup deadline must be between 1 and 10000ms");
  }
  validateExpectedRoutes(input.expectedRoutes, input.managedRuntime);
  if (input.pluginBundles.length === 0) throw new Error("Managed MCP plugin install evidence is empty");
  for (const plugin of input.pluginBundles) {
    requireNonEmpty(plugin.owner, "plugin owner");
    requireAbsolutePath(plugin.installedPath, `plugin ${plugin.owner} path`);
    requireSha256(plugin.sha256, `plugin ${plugin.owner} digest`);
  }
}

function validateRustLifecycleTests(
  evidence: CodexRustLifecycleTestEvidence,
  candidateSha256: string,
): void {
  if (!evidence || evidence.schemaVersion !== 1 || evidence.kind !== "codex-rust-lifecycle-tests") {
    throw new Error("Managed MCP canary requires receipt-bound Rust lifecycle evidence");
  }
  requireNonEmpty(evidence.sourceCommit, "Rust lifecycle source commit");
  requireSha256(evidence.patchedTreeSha256, "Rust lifecycle patched tree digest");
  requireSha256(evidence.cargoLockSha256, "Rust lifecycle Cargo.lock digest");
  if (!Array.isArray(evidence.command) || evidence.command.length === 0) {
    throw new Error("Rust lifecycle test command is empty");
  }
  for (const argument of evidence.command) requireNonEmpty(argument, "Rust lifecycle command argument");
  if (evidence.exitCode !== 0 || !Array.isArray(evidence.passedTests) || evidence.passedTests.length === 0) {
    throw new Error("Rust lifecycle tests did not record a passing test set");
  }
  for (const passedTest of evidence.passedTests) requireNonEmpty(passedTest, "Rust lifecycle passed test");
  requireAbsolutePath(evidence.stdoutFile, "Rust lifecycle stdout path");
  requireSha256(evidence.stdoutSha256, "Rust lifecycle stdout digest");
  requireAbsolutePath(evidence.stderrFile, "Rust lifecycle stderr path");
  requireSha256(evidence.stderrSha256, "Rust lifecycle stderr digest");
  requireSha256(evidence.candidateBinarySha256, "Rust lifecycle candidate digest");
  if (evidence.candidateBinarySha256 !== candidateSha256) {
    throw new Error("Rust lifecycle evidence does not match the prepared candidate");
  }
  if (!validTimestamp(evidence.startedAt) || !validTimestamp(evidence.completedAt)
    || Date.parse(evidence.startedAt) > Date.parse(evidence.completedAt)) {
    throw new Error("Rust lifecycle test timestamps are invalid");
  }
}

function validateExpectedRoutes(
  routes: readonly ManagedMcpCanaryExpectedRoute[],
  runtime: ManagedMcpPreparedRuntimeEvidence,
): void {
  if (routes.length !== MANAGED_MCP_CANARY_REQUIRED_ROUTE_COUNT) {
    throw new Error(`Managed MCP canary requires exactly ${MANAGED_MCP_CANARY_REQUIRED_ROUTE_COUNT} routes`);
  }
  const keys = routes.map(routeKey);
  if (new Set(keys).size !== keys.length) throw new Error("Managed MCP canary route manifest contains duplicates");
  for (const required of REQUIRED_MANAGED_MCP_FLEET_ROUTES) {
    const match = routes.find((route) => route.server === required.server && logicalOwner(route.owner) === required.ownerId);
    if (!match) throw new Error(`Managed MCP canary route manifest is missing ${required.ownerId}/${required.server}`);
  }
  const coverage = new Set(runtime.requiredCoverage);
  for (const route of routes) {
    requireNonEmpty(route.owner, "route owner");
    requireNonEmpty(route.server, "route server");
    requireNonEmpty(route.representativeTool, `route ${routeKey(route)} representative tool`);
    requireSha256Digest(route.catalogSha256, `route ${routeKey(route)} catalog digest`);
    requireSha256Digest(route.declarationFingerprint, `route ${routeKey(route)} declaration fingerprint`);
    for (const digest of route.artifactSha256) requireSha256(digest, `route ${routeKey(route)} artifact digest`);
    if (route.artifactSha256.length === 0) {
      throw new Error(`Route ${routeKey(route)} has no receipt-bound artifact digest`);
    }
    if (route.lifecycle === "call" && route.idleLeaseSec !== 0) {
      throw new Error(`Call-scoped route ${routeKey(route)} must have a zero idle lease`);
    }
    if (route.lifecycle === "task" && route.idleLeaseSec <= 0) {
      throw new Error(`Task-scoped route ${routeKey(route)} must have a positive idle lease`);
    }
    const owner = logicalOwner(route.owner);
    const logicalKey = `${route.owner === "config" ? "config" : "plugin"}:${owner}/${route.server}`;
    if (!coverage.has(logicalKey)) throw new Error(`Prepared runtime does not cover ${logicalKey}`);
  }
}

function validateStatusSnapshot(
  status: ManagedMcpStatusSnapshot,
  expectedRoutes: readonly ManagedMcpCanaryExpectedRoute[],
): void {
  if (!status || !Array.isArray(status.routes)) throw new Error("Managed MCP status observation is invalid");
  if (status.routes.filter((route) => route.transport === "local-stdio" && route.enabled).length !== expectedRoutes.length) {
    throw new Error("Unknown, missing, or disabled local stdio route in canary status");
  }
  const statusKeys = new Set<string>();
  for (const observed of status.routes) {
    if (observed.transport !== "local-stdio" || !observed.enabled) continue;
    const key = `${observed.owner}/${observed.server}`;
    if (statusKeys.has(key)) throw new Error(`Duplicate enabled local stdio status route ${key}`);
    statusKeys.add(key);
    const expected = expectedRoutes.find((route) => routeKey(route) === key);
    if (!expected) throw new Error(`Unknown enabled local stdio status route ${key}`);
    if (
      observed.lifecycle !== expected.lifecycle
      || observed.state !== "dormant"
      || observed.safeOffReason !== null
      || observed.catalogSha256 !== expected.catalogSha256
      || (observed.declarationFingerprint !== null
        && observed.declarationFingerprint !== expected.declarationFingerprint)
      || !observed.tools.includes(expected.representativeTool)
      || (observed.artifactSha256.length > 0
        && JSON.stringify([...observed.artifactSha256].sort())
          !== JSON.stringify([...expected.artifactSha256].sort()))
    ) throw new Error(`Managed MCP status identity or catalog drift for ${key}`);
  }
  if (statusKeys.size !== expectedRoutes.length) throw new Error("Managed MCP status route coverage is incomplete");
}

function assertCandidateStart(
  observed: ManagedMcpCandidateStartObservation,
  input: ManagedMcpCanaryRunInput,
  expectedEnvironment: Readonly<Record<string, string>>,
): void {
  if (
    !Number.isInteger(observed.pid) || observed.pid <= 0
    || observed.executable !== input.candidatePath
    || JSON.stringify(observed.argv) !== JSON.stringify(["app-server"])
    || observed.environment.CODEX_HOME !== expectedEnvironment.CODEX_HOME
    || observed.environment.CODEX_MANAGED_MCP_ROOT !== expectedEnvironment.CODEX_MANAGED_MCP_ROOT
    || !validTimestamp(observed.startedAt)
  ) throw new Error("Managed MCP canary did not start the candidate app-server in the isolated CODEX_HOME");
}

function assertCallObservation(
  call: ManagedMcpCallAdapterObservation,
  route: ManagedMcpCanaryExpectedRoute,
  taskId: string,
  scenario: ManagedMcpCanaryScenario,
): void {
  if (
    call.routeKey !== routeKey(route)
    || call.taskId !== taskId
    || call.tool !== route.representativeTool
    || call.scenario !== scenario
    || call.outcome !== scenario
    || !validTimestamp(call.startedAt)
    || !validTimestamp(call.completedAt)
    || Date.parse(call.startedAt) > Date.parse(call.completedAt)
    || (scenario === "success" && !isRawSha256(call.resultSha256))
    || (scenario !== "success" && (typeof call.errorClass !== "string" || call.errorClass.length === 0))
  ) throw new Error(`Managed MCP ${scenario} call observation is invalid for ${routeKey(route)}`);
  assertSnapshot(call.during, `${routeKey(route)} ${scenario} during`);
}

function assertCallProof(
  call: ManagedMcpCallProof,
  route: ManagedMcpCanaryExpectedRoute,
  cleanupDeadlineMs: number,
): void {
  assertCallObservation(call, route, call.taskId, call.scenario);
  if (call.scenario !== "success") throw new Error(`Unexpected non-success per-route proof for ${routeKey(route)}`);
  assertRouteProcessCount(call.during, routeKey(route), call.taskId, 1, `${routeKey(route)} call`, true);
  const owningRoots = new Set(rootPids(call.during, routeKey(route), call.taskId));
  const rootProcesses = call.during.processes.filter((process) => owningRoots.has(process.pid));
  if (rootProcesses.length === 0 || rootProcesses.some((process) =>
    !route.artifactSha256.includes(process.executableSha256)
  )) {
    throw new Error(`Launched process root executable is not receipt-bound for ${routeKey(route)}`);
  }
  if (route.lifecycle === "call") {
    assertRouteProcessCount(call.after, routeKey(route), call.taskId, 0, `${routeKey(route)} call cleanup`);
    const elapsed = Date.parse(call.after.capturedAt) - Date.parse(call.completedAt);
    if (elapsed < 0 || elapsed > cleanupDeadlineMs) throw new Error(`Call cleanup exceeded deadline for ${routeKey(route)}`);
  }
}

function assertSnapshot(snapshot: ManagedMcpProcessSnapshot, label: string): void {
  if (!snapshot || !validTimestamp(snapshot.capturedAt) || !Array.isArray(snapshot.processes)) {
    throw new Error(`Invalid Managed MCP process snapshot: ${label}`);
  }
  const pids = new Set<number>();
  for (const process of snapshot.processes) {
    if (!Number.isInteger(process.pid) || process.pid <= 0 || pids.has(process.pid)) {
      throw new Error(`Invalid or duplicate process id in ${label}`);
    }
    pids.add(process.pid);
    if (!Number.isInteger(process.ppid) || process.ppid < 0 || !validTimestamp(process.startedAt)
      || !isAbsolute(process.executable) || !isRawSha256(process.executableSha256) || !Array.isArray(process.argv)) {
      throw new Error(`Invalid process observation in ${label}`);
    }
  }
  for (const process of targeted(snapshot)) {
    if (!process.routeKey || !process.taskId) throw new Error(`Targeted process lacks ownership telemetry in ${label}`);
  }
}

function assertRouteProcessCount(
  snapshot: ManagedMcpProcessSnapshot,
  key: string,
  taskId: string,
  count: number,
  label: string,
  atLeast = false,
): void {
  assertSnapshot(snapshot, label);
  const matching = targeted(snapshot).filter((process) => process.routeKey === key && process.taskId === taskId);
  if ((atLeast && matching.length < count) || (!atLeast && matching.length !== count)) {
    throw new Error(`Expected ${atLeast ? "at least " : ""}${count} owning processes for ${key} in ${label}; got ${matching.length}`);
  }
  const wrongOwner = targeted(snapshot).filter((process) => process.routeKey !== key);
  if (count > 0 && wrongOwner.length > 0) throw new Error(`Unrelated MCP process launched during ${label}`);
}

function assertTargetedRouteCount(snapshot: ManagedMcpProcessSnapshot, count: number, label: string): void {
  assertSnapshot(snapshot, label);
  if (targeted(snapshot).length !== count) {
    throw new Error(`Expected ${count} targeted MCP processes in ${label}; got ${targeted(snapshot).length}`);
  }
}

function rootPids(snapshot: ManagedMcpProcessSnapshot, key: string, taskId: string): number[] {
  const matching = targeted(snapshot).filter((process) => process.routeKey === key && process.taskId === taskId);
  const ids = new Set(matching.map((process) => process.pid));
  return matching.filter((process) => !ids.has(process.ppid)).map((process) => process.pid).sort((a, b) => a - b);
}

function targeted(snapshot: ManagedMcpProcessSnapshot): ManagedMcpObservedProcess[] {
  return snapshot.processes.filter((process) => process.routeKey !== null);
}

function routeKey(route: Pick<ManagedMcpCanaryExpectedRoute, "owner" | "server">): string {
  return `${route.owner}/${route.server}`;
}

function logicalOwner(owner: string): string {
  if (owner === "config") return "config";
  const withoutPrefix = owner.startsWith("plugin:") ? owner.slice("plugin:".length) : owner;
  const at = withoutPrefix.lastIndexOf("@");
  return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix;
}

function lifecycleTrueMatrix(): ManagedMcpLifecycleMatrix {
  return {
    zeroBeforeDiscovery: true,
    launchOnCall: true,
    cleanupAfterSuccess: true,
    cleanupAfterTaskClose: true,
    cleanupAfterAppShutdown: true,
    callScopedReturnsToZero: true,
    taskScopedReuseWithinLease: true,
    taskScopedIsolation: true,
    playwrightProfilesIndependent: true,
    allExpectedToolsCallable: true,
    noCatalogMismatch: true,
    noPackageDrift: true,
    noOrphanedParent: true,
  };
}

function assertLifecycleTrue(value: Record<string, unknown>): void {
  const expected = lifecycleTrueMatrix();
  assertExactKeys(value, Object.keys(expected), "Managed MCP lifecycle matrix");
  if (Object.keys(expected).some((key) => value[key] !== true)) {
    throw new Error("Managed MCP lifecycle matrix contains an unproved result");
  }
}

function requireExactFile(path: string, expectedSha256: string, label: string): void {
  requireAbsolutePath(path, label);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be an exact regular file`);
  requireSha256(expectedSha256, `${label} digest`);
  if (sha256File(path) !== expectedSha256) throw new Error(`${label} digest drift`);
}

function requireAbsolutePath(path: string, label: string): void {
  if (!path || !isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute normalized path`);
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
}

function requireSha256(value: string, label: string): void {
  if (!isRawSha256(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function requireSha256Digest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a sha256: fingerprint`);
}

function isRawSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unexpected fields`);
}
