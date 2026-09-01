import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultAccountRouterConfigPath, isRouterConfigV2, readRouterLaunchSelection } from "./config";
import {
  ACCOUNT_HISTORY_ADOPTION_INTENT_FILE,
  ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE,
  ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE,
  HISTORY_ADOPTION_MAX_ARTIFACT_BYTES,
  HISTORY_ADOPTION_MAX_OWNERS_BYTES,
  validateHistoryAdoptionArtifacts,
  validateHistoryAdoptionEvidence,
  type HistoryAdoptionFailure,
} from "./history-adoption";
import { AccountRouterMux, type RouterChild, type RouterChildFactory } from "./mux";
import { startRouterControlSocket, type RouterControlSocket } from "./control-socket";
import { parseJsonRpcLine } from "./protocol";
import { assertPrivateRegularFile, ensurePrivateDirectory, RouterStateStore, validateRouterState } from "./state-store";
import type { JsonRpcMessage, OpaqueAccountId, RouterConfig, RouterConfigV2, RouterState } from "./types";
import { isPlainRecord } from "./types";

const CHILD_INITIALIZE_TIMEOUT_MS = 10_000;
const GRACEFUL_SHUTDOWN_MS = 2_000;
const FORCED_SHUTDOWN_OBSERVATION_MS = 1_000;
const MAX_AUTH_BYTES = 256 * 1024;
const MAX_CHILD_CONFIG_BYTES = 4 * 1024;

interface MuxCliArguments {
  configPath: string;
  stateRoot: string;
  command: string;
  args: string[];
}

interface MuxShutdownTarget {
  shutdown(): void;
}

/** Shared EOF/signal cleanup: idempotent and deliberately does not close stdin. */
export function createMuxCliShutdown(
  mux: MuxShutdownTarget,
  closeControl: () => void | Promise<void>,
  pauseInput: () => void,
  scheduleForceExit: () => void,
): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    mux.shutdown();
    void closeControl();
    pauseInput();
    scheduleForceExit();
  };
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
    // A later v2 config is pending intent only. The running mux keeps the
    // startup config as active truth and never changes its route mid-session.
    readPendingConfig: () => readRouterLaunchSelection(parsed.configPath).config,
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
  const shutdown = createMuxCliShutdown(
    mux,
    () => control?.close(),
    () => process.stdin.pause(),
    () => {
      const force = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS + FORCED_SHUTDOWN_OBSERVATION_MS);
      force.unref();
    },
  );
  // `close` is also raised on stdin EOF. This shared callback must not call
  // input.close(), otherwise EOF recursively re-enters readline shutdown.
  input.once("close", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export function preflightRouterHomes(config: RouterConfig, stateRoot: string): boolean {
  return preflightRouterHomesDetail(config, stateRoot).ok;
}

/**
 * Non-secret startup evidence for the parent/direct-fallback decision. File
 * names, homes, identities, and provider data deliberately never escape it.
 */
export function preflightRouterHomesDetail(
  config: RouterConfig,
  stateRoot: string,
): { ok: true } | { ok: false; reason: HistoryAdoptionFailure | "startup_selfcheck_failed" } {
  if (!isRouterConfigV2(config)) return { ok: false, reason: "history_adoption_required" };
  const secret = readControlSecret(stateRoot);
  if (!secret) return { ok: false, reason: "startup_selfcheck_failed" };
  let intentBytes: Buffer | null = null;
  let receiptBytes: Buffer | null = null;
  let ownersBytes: Buffer | null = null;
  try {
    ensurePrivateDirectory(stateRoot);
    const state = stateAllowsBalancedStartup(config, stateRoot);
    if (!state) return { ok: false, reason: "startup_selfcheck_failed" };
    intentBytes = readOwnerPrivateRegularFile(join(stateRoot, ACCOUNT_HISTORY_ADOPTION_INTENT_FILE), HISTORY_ADOPTION_MAX_ARTIFACT_BYTES, false);
    receiptBytes = readOwnerPrivateRegularFile(join(stateRoot, ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE), HISTORY_ADOPTION_MAX_ARTIFACT_BYTES, false);
    ownersBytes = readOwnerPrivateRegularFile(join(stateRoot, ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE), HISTORY_ADOPTION_MAX_OWNERS_BYTES, false);
    if (!intentBytes || !receiptBytes || !ownersBytes) return { ok: false, reason: "history_adoption_required" };
    const adoption = validateHistoryAdoptionEvidence(config, state, secret, {
      intent: intentBytes, receipt: receiptBytes, owners: ownersBytes,
    });
    if (!adoption.ok) return adoption;
    const owner = adoption.evidence.receipt.legacyOwnerOpaqueAccountId;
    if (!validateHistoryAdoptionArtifacts(
      adoption.evidence.receipt,
      join(stateRoot, "accounts", owner, "codex-home"),
      join(stateRoot, "accounts", owner, "sqlite-home"),
    )) return { ok: false, reason: "history_adoption_artifact_mismatch" };
    for (const account of config.accounts) {
      if (!account.included) continue;
      for (const directory of [
        join(stateRoot, "accounts", account.opaqueAccountId),
        join(stateRoot, "accounts", account.opaqueAccountId, "codex-home"),
        join(stateRoot, "accounts", account.opaqueAccountId, "sqlite-home"),
      ]) {
        if (!existsSync(directory)) return { ok: false, reason: "startup_selfcheck_failed" };
        ensurePrivateDirectory(directory);
      }
      if (!validateIsolatedAccountHome(account.opaqueAccountId, stateRoot, secret)) return { ok: false, reason: "startup_selfcheck_failed" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "startup_selfcheck_failed" };
  } finally {
    intentBytes?.fill(0);
    receiptBytes?.fill(0);
    ownersBytes?.fill(0);
    secret.fill(0);
  }
}

/**
 * Stage-time hardening is rechecked immediately before the parent chooses the
 * mux. No source auth, symlink, custom config, or post-stage swap is trusted.
 */
function validateIsolatedAccountHome(account: OpaqueAccountId, stateRoot: string, secret: Buffer): boolean {
  const codexHome = join(stateRoot, "accounts", account, "codex-home");
  const authBytes = readOwnerPrivateRegularFile(join(codexHome, "auth.json"), MAX_AUTH_BYTES, false);
  const configBytes = readOwnerPrivateRegularFile(join(codexHome, "config.toml"), MAX_CHILD_CONFIG_BYTES, true);
  try {
    if (!authBytes || !configBytes || configBytes.byteLength !== 0) return false;
    const parsed = JSON.parse(authBytes.toString("utf8")) as unknown;
    const rawAccountId = authAccountId(parsed);
    if (!rawAccountId) return false;
    const expected = `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}`;
    return expected.length === account.length
      && timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(account, "utf8"));
  } catch {
    return false;
  } finally {
    authBytes?.fill(0);
    configBytes?.fill(0);
  }
}

/** Read a bounded, owner-private, single-link regular file without following symlinks. */
function readOwnerPrivateRegularFile(path: string, maxBytes: number, allowEmpty: boolean): Buffer | null {
  let descriptor: number | undefined;
  let bytes: Buffer | null = null;
  let succeeded = false;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || (before.mode & 0o077) !== 0 || before.size > maxBytes || (!allowEmpty && before.size <= 0)) return null;
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (!count) return null;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    succeeded = true;
    return bytes;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    // Ownership transfers only after every validation succeeds. Callers clear
    // the returned byte buffer promptly; failed reads never retain auth data.
    if (bytes && !succeeded) bytes.fill(0);
  }
}

function authAccountId(value: unknown): string | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.tokens)) return null;
  const accountId = value.tokens.account_id;
  return typeof accountId === "string" && accountId.length > 0 && accountId.length <= 1_024 ? accountId : null;
}

/** A staged disable or uncertain dispatch is never reopened by a restart. */
function stateAllowsBalancedStartup(config: RouterConfigV2, stateRoot: string): RouterState | null {
  const stateFile = join(stateRoot, "router-state.json");
  // A receipt proves a particular imported owner subset. A missing state
  // cannot prove that subset, so v2 falls back before any child process exists.
  if (!existsSync(stateFile)) return null;
  try {
    assertPrivateRegularFile(stateFile, 2 * 1024 * 1024);
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as unknown;
    // The store constructor is intentionally strict about configured accounts
    // and ledger weights. Check the entire candidate here so the signed parent
    // retains its direct app-server fallback instead of selecting a mux that
    // will fail moments later on a v1-to-v2 (or pair/order/weight) mismatch.
    if (!validateRouterState(state, config)) return null;
    return state.stagedDisable === null
      && state.correlations.length === 0
      && Object.keys(state.pendingThreadOwners).length === 0
      // A persisted reservation is ambiguous after a process crash: without
      // an atomic reservation-to-thread recovery proof, start direct/manual.
      && state.reservations.every((reservation) => reservation.state !== "reserved" && reservation.state !== "stranded_ambiguous")
      ? state
      : null;
  } catch {
    return null;
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
