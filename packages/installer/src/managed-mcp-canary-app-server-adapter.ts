import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  createManagedMcpCanaryObservationAdapter,
  type ManagedMcpCallAdapterObservation,
  type ManagedMcpCanaryObservationAdapter,
  type ManagedMcpCanaryObservationAdapterImplementation,
  type ManagedMcpCanaryRunInput,
  type ManagedMcpCandidateStartObservation,
  type ManagedMcpObservedProcess,
  type ManagedMcpProcessSnapshot,
  type ManagedMcpRouteStatusObservation,
  type ManagedMcpStatusSnapshot,
} from "./managed-mcp-canary-runner.js";

const RPC_TIMEOUT_MS = 30_000;
const PROCESS_LAUNCH_OBSERVATION_MS = 5_000;
const MAX_JSONL_BYTES = 4 * 1024 * 1024;

export interface ManagedMcpAppServerTransport {
  readonly pid: number;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  terminate(): Promise<void>;
}

export interface ManagedMcpAppServerLaunchSpec {
  executable: string;
  argv: readonly ["app-server"];
  cwd: string;
  environment: Readonly<Record<string, string>>;
}

export interface ManagedMcpCensusProcess {
  pid: number;
  ppid: number;
  startedAt: string;
  executable: string;
  executableSha256: string;
  argv: readonly string[];
}

export interface ManagedMcpAppServerAdapterDependencies {
  launch(spec: ManagedMcpAppServerLaunchSpec): ManagedMcpAppServerTransport;
  census(parentPid: number): Promise<readonly ManagedMcpCensusProcess[]>;
  listCli(input: {
    executable: string;
    cwd: string;
    environment: Readonly<Record<string, string>>;
  }): Promise<unknown>;
  now(): string;
  sleep(ms: number): Promise<void>;
}

export function trustedManagedMcpAppServerAdapterSourcePath(): string {
  return fileURLToPath(import.meta.url);
}

export function sha256TrustedManagedMcpAppServerAdapterSource(
  sourcePath = trustedManagedMcpAppServerAdapterSourcePath(),
): string {
  return sha256File(sourcePath);
}

/**
 * Creates the only production observation adapter. Its child process and CLI
 * probes are forced into the isolated CODEX_HOME; absent protocol fault hooks
 * are recorded as capabilities rather than fabricated as successful proofs.
 */
export function createManagedMcpAppServerObservationAdapter(
  input: ManagedMcpCanaryRunInput,
  dependencies: ManagedMcpAppServerAdapterDependencies = defaultDependencies(),
): ManagedMcpCanaryObservationAdapter {
  const sourcePath = trustedManagedMcpAppServerAdapterSourcePath();
  const sourceSha256 = sha256TrustedManagedMcpAppServerAdapterSource(sourcePath);
  if (sourceSha256 !== input.trustedAdapterExpectedSha256) {
    throw new Error("Managed MCP app-server adapter source digest does not match candidate state");
  }
  return createManagedMcpCanaryObservationAdapter(
    new AppServerObservationAdapter(input, dependencies),
    {
      attestation: { identity: sourcePath, sha256: sourceSha256 },
      capabilities: { controlledLeaseExpiry: false, faultInjection: false },
    },
  );
}

class AppServerObservationAdapter implements ManagedMcpCanaryObservationAdapterImplementation {
  private transport: ManagedMcpAppServerTransport | null = null;
  private startObservation: ManagedMcpCandidateStartObservation | null = null;
  private readonly processOwners = new Map<number, { routeKey: string; taskId: string }>();
  private actualEnvironment: Readonly<Record<string, string>> | null = null;

  constructor(
    private readonly input: ManagedMcpCanaryRunInput,
    private readonly dependencies: ManagedMcpAppServerAdapterDependencies,
  ) {}

  async startCandidate(request: {
    executable: string;
    argv: readonly ["app-server"];
    environment: Readonly<Record<string, string>>;
  }): Promise<ManagedMcpCandidateStartObservation> {
    if (this.transport) throw new Error("Managed MCP candidate app-server is already running");
    if (request.executable !== this.input.candidatePath
      || request.environment.CODEX_HOME !== this.input.codexHome
      || request.environment.CODEX_MANAGED_MCP_ROOT !== this.input.managedRuntime.managedPackageRoot) {
      throw new Error("Managed MCP app-server launch escaped the isolated receipt");
    }
    const temporary = join(this.input.codexHome, "tmp");
    mkdirSync(temporary, { recursive: true });
    const environment = isolatedEnvironment(this.input, temporary);
    this.actualEnvironment = environment;
    this.transport = this.dependencies.launch({
      executable: request.executable,
      argv: request.argv,
      cwd: this.input.codexHome,
      environment,
    });
    await this.transport.request("initialize", {
      clientInfo: { name: "tweakers-managed-mcp-canary", title: "Managed MCP Canary", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.transport.notify("initialized");
    this.startObservation = {
      pid: this.transport.pid,
      startedAt: this.dependencies.now(),
      executable: request.executable,
      argv: request.argv,
      environment: request.environment,
    };
    return this.startObservation;
  }

  async discover(): Promise<ManagedMcpStatusSnapshot> {
    const transport = this.requireTransport();
    const cli = await this.dependencies.listCli({
      executable: this.input.candidatePath,
      cwd: this.input.codexHome,
      environment: this.requireEnvironment(),
    });
    const cliRows = parseCliRows(cli);
    const appRows: unknown[] = [];
    let cursor: string | null = null;
    do {
      const response = requireRecord(await transport.request("mcpServerStatus/list", {
        cursor,
        limit: 100,
        detail: "full",
      }), "MCP status response");
      if (!Array.isArray(response.data)) throw new Error("MCP status response lacks data");
      appRows.push(...response.data);
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
    } while (cursor !== null);
    const routes = appRows.map((raw) => statusObservation(raw, cliRows));
    return { capturedAt: this.dependencies.now(), routes };
  }

  async snapshotProcesses(): Promise<ManagedMcpProcessSnapshot> {
    const transport = this.transport;
    if (!transport) return { capturedAt: this.dependencies.now(), processes: [] };
    const raw = await this.dependencies.census(transport.pid);
    const live = new Set(raw.map((process) => process.pid));
    for (const pid of this.processOwners.keys()) if (!live.has(pid)) this.processOwners.delete(pid);
    const processes: ManagedMcpObservedProcess[] = raw.map((process) => {
      const owner = this.processOwners.get(process.pid);
      // Any unexplained app-server descendant is promotion-significant. The
      // runner therefore fails closed instead of silently treating it as an
      // unrelated process during discovery or a route call.
      return {
        ...process,
        commandLine: process.argv.join(" "),
        artifactIdentities: [{
          path: process.executable,
          sha256: process.executableSha256,
          source: "executable" as const,
        }],
        routeKey: owner?.routeKey ?? "unknown-descendant",
        taskId: owner?.taskId ?? "unknown",
      };
    });
    return { capturedAt: this.dependencies.now(), processes };
  }

  async waitForRouteProcessCount(request: {
    routeKey: string;
    taskId: string;
    count: number;
    deadlineMs: number;
  }): Promise<ManagedMcpProcessSnapshot> {
    const deadline = Date.now() + request.deadlineMs;
    let snapshot = await this.snapshotProcesses();
    while (ownedCount(snapshot, request.routeKey, request.taskId) !== request.count && Date.now() < deadline) {
      await this.dependencies.sleep(25);
      snapshot = await this.snapshotProcesses();
    }
    return snapshot;
  }

  async openTask(label: string): Promise<string> {
    const response = requireRecord(await this.requireTransport().request("thread/start", {
      cwd: this.input.codexHome,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      baseInstructions: `Isolated Managed MCP canary context: ${label}`,
    }), "thread/start response");
    const thread = requireRecord(response.thread, "thread/start thread");
    if (typeof thread.id !== "string" || thread.id.length === 0) throw new Error("thread/start response lacks thread id");
    return thread.id;
  }

  async callTool(request: {
    routeKey: string;
    taskId: string;
    tool: string;
    arguments: Readonly<Record<string, unknown>>;
    scenario: "success" | "error" | "timeout" | "cancel" | "startup-failure" | "dropped-caller";
  }): Promise<ManagedMcpCallAdapterObservation> {
    if (request.scenario !== "success") {
      throw new Error(`Managed MCP protocol proof unavailable: ${request.scenario} injection is not exposed by app-server`);
    }
    const route = this.input.expectedRoutes.find((candidate) =>
      `${candidate.owner}/${candidate.server}` === request.routeKey
    );
    if (!route) throw new Error(`Unknown Managed MCP canary route ${request.routeKey}`);
    const startedAt = this.dependencies.now();
    const before = await this.dependencies.census(this.requireTransport().pid);
    let settled = false;
    let result: unknown;
    let failure: unknown;
    const pending = this.requireTransport().request("mcpServer/tool/call", {
      threadId: request.taskId,
      server: route.server,
      tool: request.tool,
      arguments: request.arguments,
    }).then((value) => { result = value; settled = true; }, (error) => { failure = error; settled = true; });
    let duringRaw: readonly ManagedMcpCensusProcess[] = [];
    const beforePids = new Set(before.map((process) => process.pid));
    const observationDeadline = Date.now() + PROCESS_LAUNCH_OBSERVATION_MS;
    do {
      const current = await this.dependencies.census(this.requireTransport().pid);
      const existingOwned = current.filter((process) => {
        const owner = this.processOwners.get(process.pid);
        return owner?.routeKey === request.routeKey && owner.taskId === request.taskId;
      });
      const launched = current.filter((process) => !beforePids.has(process.pid));
      if (launched.length > 0) {
        assignProcessTree(launched, request.routeKey, request.taskId, this.processOwners);
      }
      if (launched.length > 0 || existingOwned.length > 0) {
        duringRaw = current;
        break;
      }
      if (!settled) await this.dependencies.sleep(10);
    } while (!settled && Date.now() < observationDeadline);
    await pending;
    if (failure) throw failure;
    if (duringRaw.length === 0) duringRaw = await this.dependencies.census(this.requireTransport().pid);
    const during = censusSnapshot(duringRaw, this.processOwners, this.dependencies.now());
    return {
      callId: createHash("sha256").update(`${request.routeKey}\0${request.taskId}\0${startedAt}`).digest("hex").slice(0, 24),
      routeKey: request.routeKey,
      taskId: request.taskId,
      tool: request.tool,
      scenario: "success",
      outcome: "success",
      startedAt,
      completedAt: this.dependencies.now(),
      during,
      resultSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      errorClass: null,
    };
  }

  async closeTask(taskId: string): Promise<void> {
    await this.requireTransport().request("thread/delete", { threadId: taskId });
  }

  async expireTaskLease(): Promise<void> {
    throw new Error("Managed MCP protocol proof unavailable: controlled lease expiry is not exposed by app-server");
  }

  async shutdown(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.terminate();
    this.processOwners.clear();
  }

  private requireTransport(): ManagedMcpAppServerTransport {
    if (!this.transport) throw new Error("Managed MCP candidate app-server is not running");
    return this.transport;
  }

  private requireEnvironment(): Readonly<Record<string, string>> {
    if (!this.actualEnvironment) throw new Error("Managed MCP isolated environment is not initialized");
    return this.actualEnvironment;
  }
}

export function createJsonlManagedMcpAppServerTransport(
  child: ChildProcessWithoutNullStreams,
): ManagedMcpAppServerTransport {
  if (!child.pid) throw new Error("Managed MCP app-server child lacks pid");
  let nextId = 0;
  let closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > MAX_JSONL_BYTES) {
      rejectAll(new Error("Managed MCP app-server JSONL response exceeded size limit"));
      child.kill("SIGKILL");
      return;
    }
    let message: unknown;
    try { message = JSON.parse(line); } catch {
      rejectAll(new Error("Managed MCP app-server emitted malformed JSONL"));
      child.kill("SIGKILL");
      return;
    }
    if (!isRecord(message) || typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (isRecord(message.error)) waiter.reject(new Error(`app-server RPC error: ${String(message.error.message)}`));
    else waiter.resolve(message.result);
  });
  child.once("exit", (code, signal) => {
    closed = true;
    rejectAll(new Error(`Managed MCP app-server exited (${code ?? signal ?? "unknown"})`));
  });
  const rejectAll = (error: Error): void => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  const write = (value: unknown): void => {
    if (closed || !child.stdin.writable) throw new Error("Managed MCP app-server stdin is closed");
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  return {
    pid: child.pid,
    request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
      const id = ++nextId;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Managed MCP app-server RPC timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve: resolvePromise, reject, timer });
        write({ id, method, params });
      });
    },
    notify(method, params) { write(params === undefined ? { method } : { method, params }); },
    async terminate() {
      if (closed) return;
      child.stdin.end();
      await Promise.race([
        new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
        new Promise<void>((resolvePromise) => setTimeout(() => { child.kill("SIGKILL"); resolvePromise(); }, 2_000)),
      ]);
    },
  };
}

function defaultDependencies(): ManagedMcpAppServerAdapterDependencies {
  return {
    launch(spec) {
      const child = spawn(spec.executable, [...spec.argv], {
        cwd: spec.cwd,
        env: { ...spec.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return createJsonlManagedMcpAppServerTransport(child);
    },
    census: collectManagedMcpDescendants,
    listCli: ({ executable, cwd, environment }) => new Promise((resolvePromise, reject) => {
      execFile(executable, ["mcp", "list", "--json"], {
        cwd,
        env: { ...environment },
        maxBuffer: MAX_JSONL_BYTES,
        timeout: RPC_TIMEOUT_MS,
      }, (error, stdout) => {
        if (error) { reject(error); return; }
        try { resolvePromise(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
      });
    }),
    now: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  };
}

async function collectManagedMcpDescendants(parentPid: number): Promise<readonly ManagedMcpCensusProcess[]> {
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,etime=,comm=,command="], { maxBuffer: MAX_JSONL_BYTES }, (error, output) => {
      if (error) reject(error); else resolvePromise(output);
    });
  });
  const now = Date.now();
  const rows = stdout.split("\n").flatMap((line): ManagedMcpCensusProcess[] => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const elapsed = parseElapsedMs(match[3]!);
    const executable = match[4]!;
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || elapsed === null || !isAbsolute(executable)) return [];
    let executableSha256: string;
    try {
      const stat = lstatSync(executable);
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      executableSha256 = sha256File(executable);
    } catch { return []; }
    return [{
      pid,
      ppid,
      startedAt: new Date(now - elapsed).toISOString(),
      executable,
      executableSha256,
      argv: [match[5] ?? ""],
    }];
  });
  const descendants = new Set<number>([parentPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
      descendants.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => row.pid !== parentPid && descendants.has(row.pid));
}

function statusObservation(raw: unknown, cliRows: readonly Record<string, unknown>[]): ManagedMcpRouteStatusObservation {
  const row = requireRecord(raw, "MCP app-server status row");
  const name = requireString(row.name, "MCP status name");
  const owner = requireString(row.owner, `MCP status ${name} owner`);
  const cli = cliRows.find((candidate) => candidate.name === name && candidate.owner === owner);
  if (!cli) throw new Error(`Candidate CLI status lacks ${owner}/${name}`);
  const transport = requireRecord(cli.transport, `Candidate CLI transport ${owner}/${name}`);
  const lifecycle = row.lifecycle === "on_demand_call" ? "call" : row.lifecycle === "on_demand_task" ? "task" : null;
  const state = row.lifecycleState;
  if (!lifecycle || !["dormant", "running", "legacy_eager", "safe_off"].includes(String(state))) {
    throw new Error(`Unsupported MCP lifecycle status for ${owner}/${name}`);
  }
  const tools = requireRecord(row.tools, `MCP tools ${owner}/${name}`);
  return {
    owner,
    server: name,
    transport: transport.type === "stdio" ? "local-stdio" : "remote-http",
    enabled: cli.enabled === true,
    lifecycle,
    state: state as ManagedMcpRouteStatusObservation["state"],
    catalogSha256: typeof row.catalogDigest === "string" ? row.catalogDigest : null,
    declarationFingerprint: null,
    artifactSha256: [],
    tools: Object.keys(tools),
    safeOffReason: typeof row.reason === "string" ? row.reason : null,
  };
}

function parseCliRows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Candidate CLI mcp list output is invalid");
  return value;
}

function isolatedEnvironment(input: ManagedMcpCanaryRunInput, temporary: string): Readonly<Record<string, string>> {
  return {
    HOME: input.codexHome,
    USER: process.env.USER ?? "codex-canary",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "codex-canary",
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: process.env.SHELL ?? "/bin/zsh",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: `${temporary}/`,
    CODEX_HOME: input.codexHome,
    CODEX_MANAGED_MCP_ROOT: input.managedRuntime.managedPackageRoot,
    CODEX_APP_SERVER_MANAGED_CONFIG_PATH: join(input.codexHome, "managed_config.toml"),
  };
}

function assignProcessTree(
  processes: readonly ManagedMcpCensusProcess[],
  routeKey: string,
  taskId: string,
  owners: Map<number, { routeKey: string; taskId: string }>,
): void {
  for (const process of processes) owners.set(process.pid, { routeKey, taskId });
}

function censusSnapshot(
  raw: readonly ManagedMcpCensusProcess[],
  owners: ReadonlyMap<number, { routeKey: string; taskId: string }>,
  capturedAt: string,
): ManagedMcpProcessSnapshot {
  return {
    capturedAt,
    processes: raw.map((process) => ({
      ...process,
      commandLine: process.argv.join(" "),
      artifactIdentities: [{
        path: process.executable,
        sha256: process.executableSha256,
        source: "executable" as const,
      }],
      routeKey: owners.get(process.pid)?.routeKey ?? "unknown-descendant",
      taskId: owners.get(process.pid)?.taskId ?? "unknown",
    })),
  };
}

function ownedCount(snapshot: ManagedMcpProcessSnapshot, routeKey: string, taskId: string): number {
  return snapshot.processes.filter((process) => process.routeKey === routeKey && process.taskId === taskId).length;
}

function parseElapsedMs(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256File(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Attested source path must be absolute and normalized");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
