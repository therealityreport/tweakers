import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ensureUserPaths } from "../paths.js";
import { readConfigFile, updateConfigFile } from "../config.js";
import { findSourceRoot } from "../source-root.js";
import { installManagedRuntime, managedCliPath, managedSourceRoot, writeDevelopmentProvenanceHash } from "../managed-runtime.js";
import { locateCodex } from "../platform.js";
import { openCodex, quitCodex } from "../alerts.js";
import { install, readAsarMarker } from "./install.js";
import { repair } from "./repair.js";
import { acquireProcessLock, type ProcessLock } from "../process-lock.js";
import { readState, resolveMode } from "../state.js";
import { assertLifecycleReceiptsIdle, lifecycleLockFile, withLifecycleLock } from "../lifecycle-lock.js";

export type RefreshSource = "development" | "stable" | "current";
export type RefreshPhase = "idle" | "preparing" | "quitting" | "promoting" | "complete" | "failed";

export interface LocalRefreshStatus {
  available: boolean;
  source: RefreshSource;
  phase: RefreshPhase;
  developmentSourceRoot: string | null;
  detail: string;
  error: string | null;
  checkedAt: string;
}

interface WorkflowAdapters {
  prepare(): void | Promise<void>;
  quit(): void | Promise<void>;
  promote(): void | Promise<void>;
  reopen(): void | Promise<void>;
  phase?(phase: RefreshPhase): void;
}

export async function runRefreshWorkflow(adapters: WorkflowAdapters): Promise<void> {
  adapters.phase?.("preparing");
  await adapters.prepare();
  adapters.phase?.("quitting");
  await adapters.quit();
  try {
    adapters.phase?.("promoting");
    await adapters.promote();
    adapters.phase?.("complete");
  } finally {
    await adapters.reopen();
  }
}

export function registerDevelopmentCheckout(configFile: string, sourceRoot: string): void {
  updateConfigFile(configFile, (config) => {
    const section = (config.tweaker ??= {}) as Record<string, unknown>;
    section.developmentSourceRoot = sourceRoot;
    section.lastPublishedTweakHash = hashTree(join(sourceRoot, "tweaks"), true);
  });
}

export function getLocalRefreshStatus(userRoot: string): LocalRefreshStatus {
  const configFile = join(userRoot, "config.json");
  const config = readConfigFile(configFile);
  const section = config.tweaker && typeof config.tweaker === "object"
    ? config.tweaker as Record<string, unknown>
    : {};
  const developmentSourceRoot = typeof section.developmentSourceRoot === "string" && existsSync(section.developmentSourceRoot)
    ? section.developmentSourceRoot
    : null;
  const refreshState = readJson<Partial<LocalRefreshStatus>>(join(userRoot, "refresh-state.json"));
  if (developmentSourceRoot) {
    const currentHash = hashTree(developmentSourceRoot, false);
    const provenance = readJson<{ sourceRuntimeHash?: string }>(join(managedSourceRoot(userRoot), ".tweakers-provenance.json"));
    if (!provenance?.sourceRuntimeHash || provenance.sourceRuntimeHash !== currentHash) {
      return status("development", true, developmentSourceRoot, "Development checkout has unapplied runtime changes", refreshState);
    }
  }
  const update = readJson<{ status?: string; currentVersion?: string; latestVersion?: string | null }>(join(userRoot, "self-update-state.json"));
  if (update?.latestVersion && update.latestVersion !== update.currentVersion) {
    return status("stable", true, developmentSourceRoot, `Stable ${update.latestVersion} is available`, refreshState);
  }
  return status("current", false, developmentSourceRoot, "Local ChatGPT is current", refreshState);
}

export async function refreshLocal(opts: { source?: "smart" | "development" | "stable"; app?: string } = {}): Promise<void> {
  const paths = ensureUserPaths();
  // Refuse BEFORE the launchd handoff: a local refresh in ChatGPT mode would
  // rebuild and promote a patched bundle over the pristine official app.
  assertRefreshAllowedByMode(paths.stateFile, opts.app);
  if (handoffRefreshLocalToLaunchd(paths.root)) return;
  await withLifecycleLock(lifecycleLockFile(paths.root), "local refresh", async () => {
  assertLifecycleReceiptsIdle(paths.root);
  const current = getLocalRefreshStatus(paths.root);
  const selected: RefreshSource = opts.source === "development" ? "development"
    : opts.source === "stable" ? "stable"
    : current.source === "development" ? "development" : "stable";
  const sourceRoot = selected === "development" ? current.developmentSourceRoot : managedSourceRoot(paths.root);
  if (!sourceRoot) throw new Error("No registered Tweakers development checkout is available");
  const lockFile = join(paths.root, "refresh-local.lock");
  const lock = acquireRefreshLock(lockFile);
  const stableStageRoot = join(paths.root, "refresh-stable-stage");
  let preparedStableSource: string | null = null;
  const writePhase = (phase: RefreshPhase, error: string | null = null): void => writeRefreshState(paths.root, {
    available: phase === "failed",
    source: selected,
    phase,
    developmentSourceRoot: current.developmentSourceRoot,
    detail: phase === "complete" ? "Local ChatGPT refresh completed" : `Local refresh ${phase}`,
    error,
    checkedAt: new Date().toISOString(),
  });
  try {
    const appRoot = locateCodex(opts.app).appRoot;
    await runRefreshWorkflow({
      phase: (phase) => writePhase(phase),
      prepare: async () => {
        if (selected === "stable") {
          rmSync(stableStageRoot, { recursive: true, force: true });
          const stageEnv = {
            ...process.env,
            TWEAKERS_USER_ROOT: stableStageRoot,
            TWEAKER_USER_ROOT: stableStageRoot,
            [["CODEX", "PLUSPLUS", "USER_ROOT"].join("_")]: stableStageRoot,
          };
          runChecked(process.execPath, [resolve(process.argv[1]), "update", "--no-repair", "--quiet", "--force"], process.cwd(), stageEnv);
          preparedStableSource = managedSourceRoot(stableStageRoot);
          const stagedCli = managedCliPath(stableStageRoot);
          runChecked(process.execPath, [stagedCli, "install", "--app", appRoot, "--candidate-only", "--coordinated-refresh", "--no-watcher"], process.cwd(), process.env);
        } else {
          runChecked(npmCommand(), ["run", "build"], sourceRoot);
          await install({ app: appRoot, candidateOnly: true, candidateOnlyReason: "coordinated-refresh", watcher: false, quiet: true });
        }
      },
      quit: () => quitCodex(appRoot),
      promote: async () => {
        if (selected === "stable") {
          if (!preparedStableSource) throw new Error("Stable refresh source was not prepared");
          runChecked(process.execPath, [managedCliPath(stableStageRoot), "repair", "--app", appRoot, "--force", "--quiet"], process.cwd(), process.env);
          installManagedRuntime(preparedStableSource, paths.root);
        } else {
          await repair({ app: appRoot, force: true, quiet: true });
          const managed = installManagedRuntime(sourceRoot, paths.root);
          writeDevelopmentProvenanceHash(managed, hashTree(sourceRoot, false));
        }
      },
      reopen: () => openCodex(appRoot, { detached: true, delayMs: 750 }),
    });
  } catch (error) {
    writePhase("failed", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    lock.release();
    rmSync(stableStageRoot, { recursive: true, force: true });
  }
  });
}

function assertRefreshAllowedByMode(stateFile: string, app?: string): void {
  const state = readState(stateFile);
  let markerPresent = false;
  try {
    markerPresent = readAsarMarker(locateCodex(app ?? state?.appRoot).asarPath) === "present";
  } catch {
    // A missing/unreadable app resolves as unpatched below.
  }
  if (resolveMode(state, markerPresent) !== "chatgpt") return;
  throw new Error(
    "Refusing to refresh the local app while ChatGPT mode is active.\n" +
      "The official app stays pristine in ChatGPT mode; a refresh would rebuild and promote a patched bundle.\n" +
      "Run `tweaker mode tweakers` first.",
  );
}

export function refreshCliPath(userRoot: string, status = getLocalRefreshStatus(userRoot)): string {
  if (status.source === "development" && status.developmentSourceRoot) {
    return join(status.developmentSourceRoot, "packages", "installer", "dist", "cli.js");
  }
  return managedCliPath(userRoot);
}

export function hashTree(root: string, tweaksOnly: boolean): string {
  const hash = createHash("sha256");
  if (!existsSync(root)) return hash.digest("hex");
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules", "dist", ".DS_Store"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (!tweaksOnly && (rel === "tweaks" || rel.startsWith("tweaks/") || rel.startsWith("packages/installer/assets/runtime"))) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) { hash.update(rel); hash.update(readFileSync(path)); }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function status(source: RefreshSource, available: boolean, developmentSourceRoot: string | null, detail: string, saved: Partial<LocalRefreshStatus> | null): LocalRefreshStatus {
  return { available, source, phase: saved?.phase === "failed" ? "failed" : "idle", developmentSourceRoot, detail, error: saved?.error ?? null, checkedAt: new Date().toISOString() };
}

function writeRefreshState(userRoot: string, value: LocalRefreshStatus): void {
  writeFileSync(join(userRoot, "refresh-state.json"), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function runChecked(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) {
    const detail = result.error?.message
      ?? (result.signal ? `signal ${result.signal}` : `status ${result.status ?? "unknown"}`);
    throw new Error(`${command} ${args.join(" ")} failed with ${detail}`);
  }
}

function npmCommand(): string { return process.platform === "win32" ? "npm.cmd" : "npm"; }

interface RefreshHandoffAdapters {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  argv: string[];
  execPath: string;
  cwd: string;
  now(): number;
  submit(command: string, args: string[]): { status: number | null };
}

export function handoffRefreshLocalToLaunchd(
  userRoot: string,
  overrides: Partial<RefreshHandoffAdapters> = {},
): boolean {
  const adapters: RefreshHandoffAdapters = {
    platform: process.platform,
    env: process.env,
    argv: process.argv,
    execPath: process.execPath,
    cwd: process.cwd(),
    now: Date.now,
    submit: (command, args) => spawnSync(command, args, { stdio: "ignore" }),
    ...overrides,
  };
  if (adapters.platform !== "darwin") return false;
  if (adapters.env.TWEAKERS_REFRESH_LOCAL_DETACHED === "1") return false;
  const cli = adapters.argv[1];
  if (!cli) return false;
  writeRefreshState(userRoot, {
    available: false,
    source: "current",
    phase: "preparing",
    developmentSourceRoot: null,
    detail: "Local refresh handed off to launchd",
    error: null,
    checkedAt: new Date().toISOString(),
  });
  const label = `com.therealityreport.tweakers.refresh-local.${process.pid}.${adapters.now()}`;
  const refreshCommand = [
    `cd ${shellQuote(adapters.cwd)}`,
    [
      "TWEAKERS_REFRESH_LOCAL_DETACHED=1",
      `PATH=${shellQuote(adapters.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin")}`,
      [adapters.execPath, cli, ...adapters.argv.slice(2)].map(shellQuote).join(" "),
    ].join(" "),
  ].join(" && ");
  // launchctl-submitted jobs are relaunched by launchd every time they exit,
  // even on exit code 0 — the job must unregister itself or the refresh (and
  // the app restart it triggers) repeats forever.
  const command = `${refreshCommand}; launchctl remove ${shellQuote(label)}`;
  const result = adapters.submit("launchctl", ["submit", "-l", label, "--", "/bin/sh", "-c", command]);
  if (result.status === 0) return true;
  return false;
}

export function acquireRefreshLock(lockFile: string): ProcessLock {
  return acquireProcessLock(lockFile, {
    onContended: (owner) => new Error(
      owner
        ? `A Tweakers local refresh is already running (PID ${owner})`
        : "A Tweakers local refresh is already running",
    ),
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
