import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, join, resolve } from "node:path";
import { Socket } from "node:net";
import type { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { ACCOUNTS_BROKER_IDENTITY_FD_ENV, ACCOUNTS_BROKER_IDENTITY_TIMEOUT_MS } from "../codex-app-server-parent";
import {
  connectAccountsBrokerAppServerClient,
  type AccountsBrokerAppServerClientOptions,
  type AccountsBrokerAppServerConnection,
} from "./broker-host";
import { readAccountsBrokerSecret } from "./broker-socket";
import { readRouterLaunchSelection } from "./config";
import { parseJsonRpcLine } from "./protocol";
import { redactedRouterError } from "./redaction";
import { preflightRouterHomes } from "./app-server-mux";
import {
  isOpaqueAppToolsRef,
  isOpaqueRendererRef,
  type BrokerClientKind,
  type OpaqueAppToolsRef,
  type OpaqueRendererRef,
  type JsonRpcMessage,
} from "./types";

const OWNER_CONNECT_DELAY_MS = 100;
export const ACCOUNTS_BROKER_STARTUP_TIMEOUT_MS = 20_000;

interface BrokerAppServerArguments {
  configPath: string;
  stateRoot: string;
  command: string;
  args: string[];
}

/**
 * Per-desktop stdio client for the shared daemon. It never launches Codex
 * directly: an absent/unavailable broker is a terminal redacted app-server
 * failure, not authority to create a second SQLite writer.
 */
export async function runAccountsBrokerAppServerCli(argv = process.argv.slice(2)): Promise<void> {
  const started = performance.now();
  const deadline = started + ACCOUNTS_BROKER_STARTUP_TIMEOUT_MS;
  const diagnostic = (stage: "preflight" | "identity" | "connect", code: "ready" | "unavailable" | "deadline_exceeded"): void => {
    process.stderr.write(`Tweakers Accounts bridge: ${JSON.stringify({ stage, code, elapsedMs: Math.round(performance.now() - started) })}\n`);
  };
  const parsed = parseArguments(argv);
  if (!parsed) {
    diagnostic("preflight", "unavailable");
    process.exitCode = 1;
    return;
  }
  const selection = readRouterLaunchSelection(parsed.configPath);
  if (selection.mode !== "mux" || !selection.config || selection.config.schemaVersion !== 3 || !preflightRouterHomes(selection.config, parsed.stateRoot)) {
    diagnostic("preflight", "unavailable");
    process.exitCode = 1;
    return;
  }
  const secret = readAccountsBrokerSecret(parsed.stateRoot);
  if (!secret) {
    diagnostic("preflight", "unavailable");
    process.exitCode = 1;
    return;
  }
  const clientKind: BrokerClientKind = process.env.TWEAKERS_DERIVED_VARIANT === "1" ? "tweakers" : "chatgpt";
  let identity = desktopBrokerIdentityFromEnvironment();
  if (!identity && process.env[ACCOUNTS_BROKER_IDENTITY_FD_ENV] === "3") {
    try {
      identity = await readBrokerDesktopIdentityBootstrap(new Socket({ fd: 3, readable: true, writable: false }), Math.max(0, deadline - performance.now()));
    } catch { /* Emit only the bounded stage result below. */ }
  }
  // Random bridge identities would disconnect the app-server task from the
  // renderer that is allowed to confirm a handoff and receive reverse tools.
  // A v3 child without the main-bound identity must fail closed.
  if (!identity) {
    diagnostic("identity", performance.now() >= deadline ? "deadline_exceeded" : "unavailable");
    secret.fill(0);
    process.exitCode = 1;
    return;
  }
  diagnostic("identity", "ready");
  const clientOptions = {
    root: parsed.stateRoot,
    secret,
    clientKind,
    rendererRef: identity.rendererRef,
    appToolsRef: identity.appToolsRef,
  };
  const bridge = await connectAccountsBrokerForStartup(clientOptions, writeDesktop, deadline, () => startOwner(parsed));
  if (!bridge) {
    diagnostic("connect", "deadline_exceeded");
    secret.fill(0);
    process.exitCode = 1;
    return;
  }
  diagnostic("connect", "ready");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const message = parseJsonRpcLine(line);
    if (!message) {
      writeDesktop(redactedRouterError(null, "invalid_request"));
      return;
    }
    if (!bridge!.send(message)) {
      process.exitCode = 1;
      input.close();
    }
  });
  const shutdown = (): void => {
    input.close();
    bridge?.close();
    secret.fill(0);
  };
  // A closed broker transport must become a visible app-server failure. Never
  // leave native requests waiting on a bridge that can no longer answer them.
  void bridge.whenClosed.then(() => { process.exitCode = 1; shutdown(); });
  input.once("close", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/** Retry only transport establishment. No desktop JSON-RPC is read or replayed. */
export async function connectAccountsBrokerForStartup(
  options: AccountsBrokerAppServerClientOptions,
  onMessage: (message: JsonRpcMessage) => void,
  deadline: number,
  launchOwner: () => void,
): Promise<AccountsBrokerAppServerConnection | null> {
  let launched = false;
  while (performance.now() < deadline) {
    try {
      const connection = await connectAccountsBrokerAppServerClient({ ...options,
        timeoutMs: Math.min(5_000, Math.max(1, deadline - performance.now())) }, onMessage);
      if (performance.now() < deadline) return connection;
      connection.close();
      return null;
    } catch {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      // A connection attempt can establish its socket and then consume nearly
      // the entire startup budget waiting for the authenticated handshake. Do
      // not launch a competing owner when there is no full retry interval left.
      if (!launched && remainingMs > OWNER_CONNECT_DELAY_MS) { launched = true; launchOwner(); }
      await delay(Math.min(OWNER_CONNECT_DELAY_MS, remainingMs));
    }
  }
  return null;
}

function startOwner(parsed: BrokerAppServerArguments): void {
  const entrypoint = join(__dirname, "broker-host.js");
  if (!existsSync(entrypoint)) return;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  environment.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  try {
    const child = spawn(process.execPath, [
      entrypoint,
      "--config", parsed.configPath,
      "--state-root", parsed.stateRoot,
      "--", parsed.command, ...parsed.args,
    ], {
      cwd: process.cwd(),
      env: environment,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => { /* Connection deadline reports owner unavailability without raw spawn errors. */ });
    child.unref();
  } catch {
    // The caller emits only a generic broker-unavailable failure after its
    // bounded connect wait; no spawn error/path becomes desktop output.
  }
}

function writeDesktop(message: unknown): void {
  try { process.stdout.write(`${JSON.stringify(message)}\n`); } catch { process.exitCode = 1; }
}

function parseArguments(argv: string[]): BrokerAppServerArguments | null {
  const separator = argv.indexOf("--");
  if (separator < 0) return null;
  const flags = argv.slice(0, separator);
  const configPath = flagValue(flags, "--config");
  const stateRoot = flagValue(flags, "--state-root");
  const command = argv[separator + 1];
  const args = argv.slice(separator + 2);
  if (!configPath || !stateRoot || !command || !isAbsolute(configPath) || !isAbsolute(stateRoot)
    || resolve(configPath) !== configPath || resolve(stateRoot) !== stateRoot) return null;
  return { configPath, stateRoot, command, args };
}

function flagValue(flags: readonly string[], name: string): string | null {
  const index = flags.indexOf(name);
  return index >= 0 && typeof flags[index + 1] === "string" ? flags[index + 1] : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function desktopBrokerIdentityFromEnvironment(): { rendererRef: OpaqueRendererRef; appToolsRef: OpaqueAppToolsRef } | null {
  const rendererRef = process.env.TWEAKERS_ACCOUNTS_BROKER_RENDERER_REF;
  const appToolsRef = process.env.TWEAKERS_ACCOUNTS_BROKER_APP_TOOLS_REF;
  return isOpaqueRendererRef(rendererRef) && isOpaqueAppToolsRef(appToolsRef) ? { rendererRef, appToolsRef } : null;
}

/** One private, bounded frame. Never consume the native JSON-RPC stdin here. */
export function readBrokerDesktopIdentityBootstrap(
  input: Readable,
  timeoutMs = ACCOUNTS_BROKER_IDENTITY_TIMEOUT_MS,
): Promise<{ rendererRef: OpaqueRendererRef; appToolsRef: OpaqueAppToolsRef }> {
  return new Promise((resolvePromise, reject) => {
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (identity: { rendererRef: OpaqueRendererRef; appToolsRef: OpaqueAppToolsRef } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onClose);
      input.destroy();
      if (identity) resolvePromise(identity);
      else reject(new Error("identity bootstrap unavailable"));
    };
    const onData = (chunk: Buffer | string): void => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length + next.length > 1024) { finish(null); return; }
      bytes = Buffer.concat([bytes, next]);
    };
    const onEnd = (): void => {
      try {
        const value = JSON.parse(bytes.toString("utf8"));
        finish(value && isOpaqueRendererRef(value.rendererRef) && isOpaqueAppToolsRef(value.appToolsRef)
          ? { rendererRef: value.rendererRef, appToolsRef: value.appToolsRef } : null);
      } catch { finish(null); }
    };
    const onClose = (): void => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onClose);
    input.on("error", onClose);
  });
}

if (require.main === module) {
  void runAccountsBrokerAppServerCli().catch(() => { process.exitCode = 1; });
}
