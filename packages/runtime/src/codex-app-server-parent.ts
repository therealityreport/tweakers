import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Writable } from "node:stream";
import {
  defaultAccountRouterConfigPath,
  readRouterLaunchSelection,
} from "./account-router/config";
import { preflightRouterHomes } from "./account-router/app-server-mux";

const INSTALL_MARKER = Symbol.for("co.tweakers.codex-app-server-parent");
export const ACCOUNTS_BROKER_IDENTITY_FD_ENV = "TWEAKERS_ACCOUNTS_BROKER_IDENTITY_FD";
export const ACCOUNTS_BROKER_IDENTITY_TIMEOUT_MS = 20_000;

/**
 * The native browser peer authorizer validates three generations of process
 * ancestry. A locally re-signed desktop app therefore cannot be the direct
 * grandparent of the signed Codex browser processes. This tiny signed-Node
 * parent keeps the desktop app outside that three-process window without
 * changing the native host or its authorization policy.
 */
export const CODEX_APP_SERVER_PARENT_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
const [command, ...args] = process.argv.slice(1);
if (!command) {
  process.stderr.write("Tweakers Codex parent: missing child command\n");
  process.exit(1);
}
const child = spawn(command, args, {
  cwd: process.cwd(),
  // A signed Node parent is part of the native peer trust chain. Never let a
  // caller turn NODE_OPTIONS preloads into code running inside that process or
  // pass them onward to the signed Codex descendants it authorizes.
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS")),
  stdio: "inherit",
});
let forwardedSignal = null;
let escalationTimer = null;
const childIsRunning = () => child.exitCode === null && child.signalCode === null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (forwardedSignal === null) forwardedSignal = signal;
    if (!childIsRunning()) return;
    child.kill(signal);
    if (escalationTimer === null) {
      escalationTimer = setTimeout(() => {
        escalationTimer = null;
        if (childIsRunning()) child.kill("SIGKILL");
      }, 1000);
    }
  });
}
child.once("error", (error) => {
  if (escalationTimer !== null) clearTimeout(escalationTimer);
  process.stderr.write("Tweakers Codex parent: " + error.message + "\n");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (escalationTimer !== null) clearTimeout(escalationTimer);
  if (typeof code === "number") {
    process.exit(code);
    return;
  }
  const exitSignal = signal || forwardedSignal;
  if (exitSignal) {
    process.removeAllListeners(exitSignal);
    process.kill(process.pid, exitSignal);
    return;
  }
  process.exit(1);
});
`;

export type SpawnFunction = (
  command: string,
  args?: readonly string[] | SpawnOptions,
  options?: SpawnOptions,
) => ChildProcess;

export interface MutableChildProcessModule {
  spawn: SpawnFunction;
  [INSTALL_MARKER]?: InstalledParent;
}

interface InstalledParent {
  originalSpawn: SpawnFunction;
  wrappedSpawn: SpawnFunction;
  children: Set<ChildProcess>;
  cleanupStarted: boolean;
  cleanupInFlight?: Promise<CodexAppServerParentCleanupResult>;
}

export interface CodexAppServerParentCleanupResult {
  tracked: number;
  terminated: number;
  forced: number;
  failed: number;
}

export interface CodexAppServerParentInstallOptions {
  childProcess?: MutableChildProcessModule;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  pathExists?: (path: string) => boolean;
  accountRouter?: AccountRouterParentOptions;
  /** Derived desktop shell: retain only its per-window app-tools MCP. */
  secondaryVariant?: boolean;
  /** Shared task index requested by the derived shell; never renderer-owned. */
  secondaryVariantSharedSqliteHome?: string;
}

/**
 * The only parent-visible router input is a redacted, versioned config.  It
 * is read before process creation so invalid/stale state leaves the exact
 * direct app-server parent path reachable without opening a mux session.
 */
export interface AccountRouterParentOptions {
  userRoot?: string;
  /**
   * Manager-global v3 broker rendezvous root. Derived variants must provide
   * this exact root; they may not derive a variant-local state/config root.
   */
  brokerRoot?: string | null;
  /**
   * Set only by runtime main when either global-root alias was explicitly
   * configured. A true value with no resolved root is a terminal blocked
   * launch, not an absent-global legacy fallback.
   */
  brokerRootConfigured?: boolean;
  configPath?: string | null;
  runtimeEntrypointPath?: string;
  brokerEntrypointPath?: string;
  pathExists?: (path: string) => boolean;
  readFile?: (path: string, encoding: BufferEncoding) => string;
  /**
   * Main-process session identity for the app-server bridge. It is resolved at
   * spawn time so the bridge and Accounts IPC use the same opaque endpoint.
   */
  resolveBrokerDesktopIdentity?: () => { rendererRef: string; appToolsRef: string } | null;
}

/**
 * The Accounts UI gets only this non-secret, main-owned authority result. It
 * must never infer local-writer permission from whether a broker socket happens
 * to be reachable.
 */
export type AccountsAuthorityMode = "global-v3" | "legacy" | "blocked";

export interface AccountsAuthorityResolutionOptions {
  userRoot?: string;
  /** A resolved manager-global root; it is never sent to a renderer. */
  brokerRoot?: string | null;
  /** Distinguishes an absent broker-root setting from an invalid configured one. */
  brokerRootConfigured?: boolean;
  configPath?: string | null;
  pathExists?: (path: string) => boolean;
  readFile?: (path: string, encoding: BufferEncoding) => string;
}

/**
 * Select the sole Accounts authority before any tweak lifecycle begins.
 *
 * A present manager-global config is a publication boundary: a valid v3 file
 * remains globally authoritative even when its broker is unavailable, while
 * every other present global state blocks local writers.  Only an absent global
 * config plus a valid, launch-preflight-safe local v1/v2 selection can retain
 * the legacy writer.
 */
export function resolveAccountsAuthorityMode(
  options: AccountsAuthorityResolutionOptions = {},
): AccountsAuthorityMode {
  try {
    const userRoot = options.userRoot ?? process.env.TWEAKERS_USER_ROOT ?? process.env.TWEAKER_USER_ROOT;
    const localConfigPath = options.configPath ?? defaultAccountRouterConfigPath(userRoot);
    const pathExists = options.pathExists ?? existsSync;
    const brokerRoot = options.brokerRoot;
    if (options.brokerRootConfigured === true && !brokerRoot) return "blocked";

    if (brokerRoot) {
      const globalConfigPath = join(brokerRoot, "account-router-config.json");
      if (pathExists(globalConfigPath)) {
        const globalSelection = readRouterLaunchSelection(globalConfigPath, options.readFile, pathExists);
        return globalSelection.config?.schemaVersion === 3 ? "global-v3" : "blocked";
      }
    }

    if (!localConfigPath) return "blocked";
    const localSelection = readRouterLaunchSelection(localConfigPath, options.readFile, pathExists);
    if (localSelection.config?.schemaVersion === 1) return "legacy";
    if (localSelection.config?.schemaVersion !== 2 || localSelection.mode !== "mux") return "blocked";
    return preflightRouterHomes(localSelection.config, dirname(localConfigPath)) ? "legacy" : "blocked";
  } catch {
    return "blocked";
  }
}

export interface CodexAppServerParentInstallResult {
  installed: boolean;
  bundledNodePath: string | null;
  reason: "installed" | "already-installed" | "unsupported-platform" | "missing-bundled-node";
  cleanupTrackedParents(options?: {
    termTimeoutMs?: number;
    killTimeoutMs?: number;
  }): Promise<CodexAppServerParentCleanupResult>;
  uninstall(): void;
}

export function isCodexAppServerSpawn(
  command: unknown,
  args: unknown,
  options?: SpawnOptions,
): command is string {
  if (typeof command !== "string" || basename(command) !== "codex") return false;
  if (!Array.isArray(args)) return false;
  if (!args.every((value) => typeof value === "string")) return false;
  const directLaunch = args[0] === "app-server";
  const desktopLaunch = args[0] === "-c"
    && args[1] === "features.code_mode_host=true"
    && args[2] === "app-server";
  if (!directLaunch && !desktopLaunch) return false;
  const appServerIndex = directLaunch ? 0 : 2;
  if (args.lastIndexOf("app-server") !== appServerIndex) return false;
  if (options?.shell || options?.detached) return false;

  // The parent script preserves the normal stdin/stdout/stderr contract. Do
  // not interpose on launches that depend on IPC or extra inherited file
  // descriptors because those cannot be faithfully proxied through `node -e`.
  if (Array.isArray(options?.stdio) && options.stdio.length > 3) return false;
  if (options?.stdio === "ignore") return false;

  return true;
}

export function buildCodexAppServerParentArgs(command: string, args: readonly string[]): string[] {
  return ["-e", CODEX_APP_SERVER_PARENT_SOURCE, "--", command, ...args];
}

export function buildAccountRouterMuxArgs(
  entrypoint: string,
  configPath: string,
  command: string,
  args: readonly string[],
  sharedSqliteHome?: string,
): string[] {
  return [
    entrypoint,
    "--config", configPath,
    "--state-root", dirname(configPath),
    ...(sharedSqliteHome ? ["--shared-sqlite-home", sharedSqliteHome] : []),
    "--", command, ...args,
  ];
}

/** V3 uses a shared broker client and deliberately never accepts shared SQLite. */
export function buildAccountsBrokerAppServerArgs(
  entrypoint: string,
  configPath: string,
  command: string,
  args: readonly string[],
): string[] {
  return [
    entrypoint,
    "--config", configPath,
    "--state-root", dirname(configPath),
    "--", command, ...args,
  ];
}

/** A V3 preflight failure is terminal, never permission to launch direct. */
export const ACCOUNTS_BROKER_BLOCKED_SOURCE = String.raw`
"use strict";
process.stderr.write("Tweakers Accounts broker: unavailable\n");
process.exitCode = 1;
process.stdin.resume();
process.stdin.once("data", () => process.exit(1));
setTimeout(() => process.exit(1), 1000).unref();
`;

export function buildAccountsBrokerBlockedArgs(): string[] {
  return ["-e", ACCOUNTS_BROKER_BLOCKED_SOURCE];
}

/**
 * A derived desktop has its own Codex configuration home, but OpenAI's main
 * process still supplies every enabled desktop plugin as a CLI override. Keep
 * the one per-window `codex_app` pipe and remove all other MCP/plugin
 * projections so a side-by-side launch cannot duplicate the primary app's
 * complete child-process fleet.
 */
export function secondaryVariantAppServerArgs(args: readonly string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const value = args[index + 1];
    if (current === "-c" && typeof value === "string" && isSecondaryConnectionOverride(value)) {
      index += 1;
      continue;
    }
    output.push(current);
  }
  return output;
}

export const SECONDARY_VARIANT_REMOTE_CONTROL_DISABLED_ENV =
  "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED";

function isSecondaryConnectionOverride(value: string): boolean {
  const separator = value.indexOf("=");
  if (separator <= 0) return false;
  const key = value.slice(0, separator).trim();
  if (key.startsWith("plugins.")) return true;
  if (!key.startsWith("mcp_servers.")) return false;
  return key !== "mcp_servers.codex_app" && !key.startsWith("mcp_servers.codex_app.");
}

export function installCodexAppServerParent(
  options: CodexAppServerParentInstallOptions = {},
): CodexAppServerParentInstallResult {
  const childProcess = options.childProcess ??
    (require("node:child_process") as MutableChildProcessModule);
  const platform = options.platform ?? process.platform;
  const resourcesPath = options.resourcesPath ??
    (typeof process.resourcesPath === "string" ? process.resourcesPath : "");
  const pathExists = options.pathExists ?? existsSync;
  const existing = childProcess[INSTALL_MARKER];

  if (existing) {
    // A caller that did not install the hook must not be able to remove the
    // first caller's installation through the returned handle.
    return result(false, null, "already-installed", childProcess);
  }
  if (platform !== "darwin") {
    return result(false, null, "unsupported-platform", childProcess);
  }
  if (!resourcesPath) {
    return result(false, null, "missing-bundled-node", childProcess);
  }

  const bundledNodePath = join(resourcesPath, "cua_node", "bin", "node");
  if (!pathExists(bundledNodePath)) {
    return result(false, bundledNodePath, "missing-bundled-node", childProcess);
  }

  const originalSpawn = childProcess.spawn;
  const installed = {
    originalSpawn,
    wrappedSpawn: undefined as unknown as SpawnFunction,
    children: new Set<ChildProcess>(),
    cleanupStarted: false,
  } satisfies InstalledParent;
  const wrappedSpawn: SpawnFunction = function wrappedCodexSpawn(
    this: unknown,
    command: string,
    argsOrOptions?: readonly string[] | SpawnOptions,
    maybeOptions?: SpawnOptions,
  ): ChildProcess {
    if (
      Array.isArray(argsOrOptions) &&
      isCodexAppServerSpawn(command, argsOrOptions, maybeOptions)
    ) {
      if (installed.cleanupStarted) {
        throw new Error("Tweakers Codex parent: app-server cleanup has started");
      }
      const appServerArgs = options.secondaryVariant
        ? secondaryVariantAppServerArgs(argsOrOptions)
        : [...argsOrOptions];
      const router = accountRouterLaunch({
        router: options.accountRouter,
        bundledNodePath,
        defaultPathExists: pathExists,
      });
      const childArgs = router?.kind === "mux"
        ? buildAccountRouterMuxArgs(
          router.entrypoint,
          router.configPath,
          command,
          appServerArgs,
          options.secondaryVariant ? options.secondaryVariantSharedSqliteHome : undefined,
        )
        : router?.kind === "broker"
          ? buildAccountsBrokerAppServerArgs(router.entrypoint, router.configPath, command, appServerArgs)
          : router?.kind === "blocked"
            ? buildAccountsBrokerBlockedArgs()
            : buildCodexAppServerParentArgs(command, appServerArgs);
      const spawnOptions = sanitizeParentSpawnOptions(
        maybeOptions,
        options.secondaryVariant === true,
        router?.kind === "broker" || router?.kind === "blocked",
        router?.kind === "broker" ? router.identity : null,
      );
      const bootstrapIdentity = router?.kind === "broker" && !router.identity;
      if (bootstrapIdentity) {
        // Native can start its app-server before creating the first window.
        // Keep native stdin untouched while main binds the real renderer.
        const stdio = spawnOptions.stdio;
        spawnOptions.stdio = Array.isArray(stdio)
          ? [stdio[0] ?? "pipe", stdio[1] ?? "pipe", stdio[2] ?? "pipe", "pipe"]
          : stdio === "inherit" ? [0, 1, 2, "pipe"]
            : [stdio ?? "pipe", stdio ?? "pipe", stdio ?? "pipe", "pipe"];
        spawnOptions.env![ACCOUNTS_BROKER_IDENTITY_FD_ENV] = "3";
      }
      const child = Reflect.apply(originalSpawn, this, [
        bundledNodePath,
        childArgs,
        spawnOptions,
      ]) as ChildProcess;
      installed.children.add(child);
      child.once?.("exit", () => installed.children.delete(child));
      child.once?.("error", () => installed.children.delete(child));
      if (bootstrapIdentity) bootstrapBrokerDesktopIdentity(child, options.accountRouter?.resolveBrokerDesktopIdentity);
      return child;
    }
    return Reflect.apply(originalSpawn, this, [command, argsOrOptions, maybeOptions]) as ChildProcess;
  };

  installed.wrappedSpawn = wrappedSpawn;
  childProcess.spawn = wrappedSpawn;
  childProcess[INSTALL_MARKER] = installed;
  return result(true, bundledNodePath, "installed", childProcess, installed);
}

type AccountRouterLaunch =
  | { kind: "mux"; entrypoint: string; configPath: string }
  | { kind: "broker"; entrypoint: string; configPath: string; identity: { rendererRef: string; appToolsRef: string } | null }
  | { kind: "blocked" };

function accountRouterLaunch(options: {
  router: AccountRouterParentOptions | undefined;
  bundledNodePath: string;
  defaultPathExists: (path: string) => boolean;
}): AccountRouterLaunch | null {
  const brokerRoot = options.router?.brokerRoot;
  // This must happen before any local router config is read. An explicit but
  // invalid/conflicting manager-global root has no safe local-writer fallback.
  if (options.router?.brokerRootConfigured === true && !brokerRoot) return { kind: "blocked" };
  const userRoot = options.router?.userRoot ?? process.env.TWEAKERS_USER_ROOT ?? process.env.TWEAKER_USER_ROOT;
  const localConfigPath = options.router?.configPath ?? defaultAccountRouterConfigPath(userRoot);
  const pathExists = options.router?.pathExists ?? options.defaultPathExists;
  let configPath = localConfigPath;
  let selection = readRouterLaunchSelection(configPath, options.router?.readFile, pathExists);
  if (brokerRoot) {
    const brokerConfigPath = join(brokerRoot, "account-router-config.json");
    // The manager-global file is the publication boundary. Once it exists,
    // every non-v3 result is unsafe to reinterpret as a local legacy config:
    // that would reopen a mux/direct writer after v3 publication failed.
    if (pathExists(brokerConfigPath)) {
      configPath = brokerConfigPath;
      selection = readRouterLaunchSelection(brokerConfigPath, options.router?.readFile, pathExists);
      if (selection.config?.schemaVersion !== 3) return { kind: "blocked" };
    }
  }
  // A local/derived v3 file without the manager-global rendezvous root must
  // not silently split a durable ledger. Do not fall through to direct.
  const selectedBrokerConfigPath = brokerRoot ? join(brokerRoot, "account-router-config.json") : null;
  if (selection.config?.schemaVersion === 3 && (!brokerRoot || configPath !== selectedBrokerConfigPath)) {
    return { kind: "blocked" };
  }
  if (selection.mode !== "mux" || !configPath) return null;
  if (selection.config?.schemaVersion === 3) {
    const entrypoint = options.router?.brokerEntrypointPath ?? join(__dirname, "account-router", "broker-app-server.js");
    if (!pathExists(entrypoint) || !preflightRouterHomes(selection.config, dirname(configPath))) return { kind: "blocked" };
    const identity = options.router?.resolveBrokerDesktopIdentity?.() ?? null;
    return { kind: "broker", entrypoint, configPath, identity: validBrokerDesktopIdentity(identity) ? identity : null };
  }
  const entrypoint = options.router?.runtimeEntrypointPath ?? join(__dirname, "account-router", "app-server-mux.js");
  if (!pathExists(entrypoint) || !preflightRouterHomes(selection.config!, dirname(configPath))) return null;
  return { kind: "mux", entrypoint, configPath };
}

function sanitizeParentSpawnOptions(
  options?: SpawnOptions,
  secondaryVariant = false,
  brokerMode = false,
  brokerIdentity: { rendererRef: string; appToolsRef: string } | null = null,
): SpawnOptions {
  const env = { ...(options?.env ?? process.env) };
  delete env.NODE_OPTIONS;
  if (secondaryVariant || brokerMode) env[SECONDARY_VARIANT_REMOTE_CONTROL_DISABLED_ENV] = "1";
  if (brokerMode) {
    delete env.TWEAKERS_ACCOUNTS_BROKER_RENDERER_REF;
    delete env.TWEAKERS_ACCOUNTS_BROKER_APP_TOOLS_REF;
    delete env[ACCOUNTS_BROKER_IDENTITY_FD_ENV];
  }
  if (brokerIdentity) {
    env.TWEAKERS_ACCOUNTS_BROKER_RENDERER_REF = brokerIdentity.rendererRef;
    env.TWEAKERS_ACCOUNTS_BROKER_APP_TOOLS_REF = brokerIdentity.appToolsRef;
  }
  return { ...(options ?? {}), env };
}

function bootstrapBrokerDesktopIdentity(
  child: ChildProcess,
  resolveIdentity: AccountRouterParentOptions["resolveBrokerDesktopIdentity"],
): void {
  const pipe = child.stdio?.[3] as Writable | null | undefined;
  if (!pipe || typeof pipe.end !== "function") return;
  let poll: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const cleanup = (): void => {
    if (poll) clearInterval(poll);
    if (timeout) clearTimeout(timeout);
    child.removeListener("exit", cancel);
    child.removeListener("error", cancel);
  };
  const cancel = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    pipe.destroy();
  };
  const attempt = (): void => {
    if (settled) return;
    try {
      const identity = resolveIdentity?.();
      if (!validBrokerDesktopIdentity(identity)) return;
      settled = true;
      cleanup();
      pipe.end(`${JSON.stringify({ rendererRef: identity.rendererRef, appToolsRef: identity.appToolsRef })}\n`);
    } catch { cancel(); }
  };
  // Retain the error listener through end/destroy: a child exiting during the
  // final write must never raise an unhandled EPIPE in Electron main.
  pipe.on("error", cancel);
  pipe.once("close", cancel);
  child.once("exit", cancel);
  child.once("error", cancel);
  poll = setInterval(attempt, 25);
  timeout = setTimeout(cancel, ACCOUNTS_BROKER_IDENTITY_TIMEOUT_MS);
  poll.unref();
  timeout.unref();
  attempt();
}

function validBrokerDesktopIdentity(value: unknown): value is { rendererRef: string; appToolsRef: string } {
  return !!value && typeof value === "object"
    && /^br_[A-Za-z0-9_-]{16,128}$/.test((value as { rendererRef?: unknown }).rendererRef as string)
    && /^bat_[A-Za-z0-9_-]{16,128}$/.test((value as { appToolsRef?: unknown }).appToolsRef as string);
}

function result(
  installed: boolean,
  bundledNodePath: string | null,
  reason: CodexAppServerParentInstallResult["reason"],
  childProcess: MutableChildProcessModule,
  state?: InstalledParent,
): CodexAppServerParentInstallResult {
  return {
    installed,
    bundledNodePath,
    reason,
    async cleanupTrackedParents(options = {}) {
      if (!state || childProcess[INSTALL_MARKER] !== state) {
        return { tracked: 0, terminated: 0, forced: 0, failed: 0 };
      }
      state.cleanupStarted = true;
      if (state.cleanupInFlight) return state.cleanupInFlight;
      state.cleanupInFlight = drainTrackedParents(
        state,
        options.termTimeoutMs ?? 2_000,
        options.killTimeoutMs ?? 1_000,
      );
      try {
        return await state.cleanupInFlight;
      } finally {
        state.cleanupInFlight = undefined;
      }
    },
    uninstall() {
      if (!state || childProcess[INSTALL_MARKER] !== state) return;
      if (childProcess.spawn === state.wrappedSpawn) childProcess.spawn = state.originalSpawn;
      delete childProcess[INSTALL_MARKER];
    },
  };
}

type TrackedParentTermination = "already-exited" | "terminated" | "forced" | "failed";

async function terminateTrackedParent(
  child: ChildProcess,
  termTimeoutMs: number,
  killTimeoutMs: number,
): Promise<TrackedParentTermination> {
  if (child.exitCode !== null || child.signalCode !== null) return "already-exited";
  if (!child.kill("SIGTERM")) return "failed";
  const completionTimeoutMs = Math.max(0, termTimeoutMs) + Math.max(0, killTimeoutMs);
  if (!await waitForChildExit(child, completionTimeoutMs)) return "failed";
  return child.signalCode === "SIGKILL" ? "forced" : "terminated";
}

async function drainTrackedParents(
  state: InstalledParent,
  termTimeoutMs: number,
  killTimeoutMs: number,
): Promise<CodexAppServerParentCleanupResult> {
  const attempted = new Set<ChildProcess>();
  let terminated = 0;
  let forced = 0;
  let failed = 0;

  while (true) {
    const pending = [...state.children].filter((child) => !attempted.has(child));
    if (pending.length === 0) break;
    for (const child of pending) {
      attempted.add(child);
      const outcome = await terminateTrackedParent(child, termTimeoutMs, killTimeoutMs);
      if (outcome === "terminated") terminated += 1;
      else if (outcome === "forced") forced += 1;
      else if (outcome === "failed") failed += 1;
      if (outcome !== "failed") state.children.delete(child);
    }
  }

  return { tracked: attempted.size, terminated, forced, failed };
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolvePromise(exited);
    };
    const onExit = (): void => settle(true);
    const onError = (): void => settle(false);
    const timer = setTimeout(() => settle(false), Math.max(0, timeoutMs));
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
