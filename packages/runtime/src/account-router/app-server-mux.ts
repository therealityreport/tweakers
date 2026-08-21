import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultAccountRouterConfigPath, readRouterLaunchSelection } from "./config";
import { AccountRouterMux, type RouterChild, type RouterChildFactory } from "./mux";
import { startRouterControlSocket, type RouterControlSocket } from "./control-socket";
import { parseJsonRpcLine } from "./protocol";
import { assertPrivateRegularFile, ensurePrivateDirectory, RouterStateStore } from "./state-store";
import type { JsonRpcMessage, OpaqueAccountId, RouterConfig } from "./types";
import { isPlainRecord } from "./types";

const CHILD_INITIALIZE_TIMEOUT_MS = 10_000;
const GRACEFUL_SHUTDOWN_MS = 2_000;
const FORCED_SHUTDOWN_OBSERVATION_MS = 1_000;

interface MuxCliArguments {
  configPath: string;
  stateRoot: string;
  command: string;
  args: string[];
}

/** Executable entry point run under ChatGPT's bundled signed Node parent. */
export async function runAccountRouterMuxCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(argv);
  if (!parsed) {
    process.exitCode = 1;
    return;
  }
  const selection = readRouterLaunchSelection(parsed.configPath);
  if (selection.mode !== "mux" || !selection.config || !preflightRouterHomes(selection.config, parsed.stateRoot)) {
    process.exitCode = 1;
    return;
  }
  const secret = readControlSecret(parsed.stateRoot);
  if (!secret) {
    process.exitCode = 1;
    return;
  }
  const store = new RouterStateStore(parsed.stateRoot, selection.config);
  let input: ReturnType<typeof createInterface> | null = null;
  let control: RouterControlSocket | null = null;
  let fatalExitScheduled = false;
  const scheduleFatalExit = () => {
    if (fatalExitScheduled) return;
    fatalExitScheduled = true;
    process.exitCode = 1;
    input?.close();
    process.stdin.pause();
    void control?.close();
    const force = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS + FORCED_SHUTDOWN_OBSERVATION_MS);
    force.unref();
  };
  const mux = new AccountRouterMux({
    config: selection.config,
    store,
    controlSecret: secret,
    childFactory: new ProcessRouterChildFactory(parsed.command, parsed.args, parsed.stateRoot),
    writeDesktop: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    onFatal: scheduleFatalExit,
    onShutdown: () => { void control?.close(); },
  });
  try {
    control = await startRouterControlSocket({
      root: parsed.stateRoot,
      secret,
      status: () => mux.status(),
    });
  } catch {
    process.exitCode = 1;
    return;
  }
  if (!mux.start()) {
    await control.close();
    process.exitCode = 1;
    return;
  }
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => mux.receiveDesktopLine(line));
  const shutdown = () => {
    input.close();
    mux.shutdown();
    void control?.close();
    const force = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS + FORCED_SHUTDOWN_OBSERVATION_MS);
    force.unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export function preflightRouterHomes(config: RouterConfig, stateRoot: string): boolean {
  try {
    ensurePrivateDirectory(stateRoot);
    if (!stateAllowsBalancedStartup(stateRoot)) return false;
    for (const account of config.accounts) {
      if (!account.included) continue;
      for (const directory of [
        join(stateRoot, "accounts", account.opaqueAccountId),
        join(stateRoot, "accounts", account.opaqueAccountId, "codex-home"),
        join(stateRoot, "accounts", account.opaqueAccountId, "sqlite-home"),
      ]) {
        if (!existsSync(directory)) return false;
        ensurePrivateDirectory(directory);
      }
    }
    return Boolean(readControlSecret(stateRoot));
  } catch {
    return false;
  }
}

/** A staged disable or uncertain dispatch is never reopened by a restart. */
function stateAllowsBalancedStartup(stateRoot: string): boolean {
  const stateFile = join(stateRoot, "router-state.json");
  if (!existsSync(stateFile)) return true;
  try {
    assertPrivateRegularFile(stateFile, 2 * 1024 * 1024);
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as unknown;
    if (!isPlainRecord(state) || state.stagedDisable !== null || !Array.isArray(state.correlations) || !isPlainRecord(state.pendingThreadOwners)) return false;
    return state.correlations.length === 0 && Object.keys(state.pendingThreadOwners).length === 0;
  } catch {
    return false;
  }
}

function readControlSecret(stateRoot: string): Buffer | null {
  const path = join(stateRoot, "control-secret.v1");
  try {
    if (!existsSync(path)) return null;
    assertPrivateRegularFile(path, 512);
    const secret = Buffer.from(readFileSync(path));
    return secret.byteLength === 32 ? secret : null;
  } catch {
    return null;
  }
}

class ProcessRouterChildFactory implements RouterChildFactory {
  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly stateRoot: string,
  ) {}

  create(account: OpaqueAccountId, handlers: { onMessage(message: JsonRpcMessage): void; onFailure(): void }): RouterChild {
    const accountRoot = join(this.stateRoot, "accounts", account);
    const codexHome = join(accountRoot, "codex-home");
    const sqliteHome = join(accountRoot, "sqlite-home");
    const child = spawn(this.command, [...this.args], {
      cwd: process.cwd(),
      env: sanitizedChildEnvironment(codexHome, sqliteHome),
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (!child.stdin || !child.stdout) throw new Error("account-router child lacks JSONL stdio");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = parseJsonRpcLine(line);
      if (message) handlers.onMessage(message);
      else handlers.onFailure();
    });
    child.once("error", () => handlers.onFailure());
    child.once("exit", () => handlers.onFailure());
    const initializeTimeout = setTimeout(() => handlers.onFailure(), CHILD_INITIALIZE_TIMEOUT_MS);
    initializeTimeout.unref();
    return new ProcessRouterChild(account, child, () => clearTimeout(initializeTimeout));
  }
}

class ProcessRouterChild implements RouterChild {
  constructor(
    readonly opaqueAccountId: OpaqueAccountId,
    private readonly child: ChildProcess,
    private readonly clearInitializeTimeout: () => void,
  ) {}

  send(message: JsonRpcMessage): void {
    if (!this.child.stdin || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("account-router child is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  terminate(signal: NodeJS.Signals): void {
    this.clearInitializeTimeout();
    this.child.kill(signal);
    const force = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, GRACEFUL_SHUTDOWN_MS);
    force.unref();
  }

  markInitialized(): void {
    this.clearInitializeTimeout();
  }
}

export function sanitizedChildEnvironment(codexHome: string, sqliteHome: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The child receives only operating-system launch values. In particular, no
  // arbitrary parent env, headers, OAuth state, or provider token is copied
  // into an account home through process inheritance.
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  return { ...environment, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome };
}

function parseArguments(argv: string[]): MuxCliArguments | null {
  const separator = argv.indexOf("--");
  if (separator < 0) return null;
  const flags = argv.slice(0, separator);
  const command = argv[separator + 1];
  const args = argv.slice(separator + 2);
  const configPath = flagValue(flags, "--config");
  const stateRoot = flagValue(flags, "--state-root");
  if (!configPath || !stateRoot || !command) return null;
  return { configPath, stateRoot, command, args };
}

function flagValue(flags: string[], name: string): string | null {
  const index = flags.indexOf(name);
  return index >= 0 && typeof flags[index + 1] === "string" ? flags[index + 1] : null;
}

export function defaultMuxPaths(userRoot = process.env.TWEAKERS_USER_ROOT ?? process.env.TWEAKER_USER_ROOT): { configPath: string; stateRoot: string } | null {
  const configPath = defaultAccountRouterConfigPath(userRoot);
  return configPath ? { configPath, stateRoot: dirname(configPath) } : null;
}

if (require.main === module) {
  void runAccountRouterMuxCli().catch(() => { process.exitCode = 1; });
}
