import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ensureUserPaths } from "../paths.js";
import { ensureModeCoordinatorConfigured } from "../switcher-setup.js";
import { readConfigFile, updateConfigFile } from "../config.js";
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

export interface RefreshLocalOptions {
  source?: "smart" | "development" | "stable";
  app?: string;
  developmentRoot?: string;
}

export interface RefreshSelection {
  selected: "development" | "stable";
  sourceRoot: string;
  developmentSourceRoot: string | null;
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

export async function refreshLocal(opts: RefreshLocalOptions = {}): Promise<void> {
  // An explicit root is invocation-scoped. Validate it before launchd handoff,
  // then carry the original CLI argv through unchanged. In particular, do not
  // consult or update the co-owned config.json development registration.
  const explicitDevelopmentRoot = resolveExplicitDevelopmentRoot(opts);
  const paths = ensureUserPaths();
  // Refuse BEFORE the launchd handoff: a local refresh in ChatGPT mode would
  // rebuild and promote a patched bundle over the pristine official app.
  assertRefreshAllowedByMode(paths.stateFile, opts.app);
  if (handoffRefreshLocalToLaunchd(paths.root, {}, explicitDevelopmentRoot === null ? undefined : {
    source: "development",
    developmentSourceRoot: explicitDevelopmentRoot,
  })) return;
  await withLifecycleLock(lifecycleLockFile(paths.root), "local refresh", async () => {
  assertLifecycleReceiptsIdle(paths.root);
  const selection = explicitDevelopmentRoot === null
    ? resolveRefreshSelection(paths.root, opts)
    : explicitDevelopmentSelection(explicitDevelopmentRoot);
  const { selected, sourceRoot } = selection;
  const lockFile = join(paths.root, "refresh-local.lock");
  const lock = acquireRefreshLock(lockFile);
  const stableStageRoot = join(paths.root, "refresh-stable-stage");
  let preparedStableSource: string | null = null;
  const writePhase = (phase: RefreshPhase, error: string | null = null): void => writeRefreshState(paths.root, {
    available: phase === "failed",
    source: selected,
    phase,
    developmentSourceRoot: selection.developmentSourceRoot,
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
        await restoreModeCoordinatorMetadata();
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

export function resolveRefreshSelection(userRoot: string, opts: RefreshLocalOptions = {}): RefreshSelection {
  const explicitDevelopmentRoot = resolveExplicitDevelopmentRoot(opts);
  if (explicitDevelopmentRoot !== null) return explicitDevelopmentSelection(explicitDevelopmentRoot);

  const current = getLocalRefreshStatus(userRoot);
  // Smart selection prefers a registered development checkout even when it is
  // hash-current: the stable path depends on a published release that may not
  // exist or may lag the installed desktop. `--source stable` still forces it.
  const selected = opts.source === "development" ? "development"
    : opts.source === "stable" ? "stable"
    : current.source === "development" || current.developmentSourceRoot !== null ? "development" : "stable";
  const sourceRoot = selected === "development" ? current.developmentSourceRoot : managedSourceRoot(userRoot);
  if (!sourceRoot) throw new Error("No registered Tweakers development checkout is available");
  return {
    selected,
    sourceRoot,
    developmentSourceRoot: current.developmentSourceRoot,
  };
}

export function resolveExplicitDevelopmentRoot(opts: RefreshLocalOptions): string | null {
  if (opts.developmentRoot === undefined) return null;
  if (opts.source !== "development") {
    throw new Error("--development-root is valid only with --source development");
  }
  const requested = opts.developmentRoot;
  if (typeof requested !== "string" || requested.length === 0 || !isAbsolute(requested) || resolve(requested) !== requested) {
    throw new Error("--development-root must be an exact absolute path to a Tweakers Git worktree");
  }

  let sourceRoot: string;
  try {
    sourceRoot = realpathSync(requested);
  } catch {
    throw new Error(`--development-root does not exist: ${requested}`);
  }
  if (sourceRoot !== requested || !statSync(sourceRoot).isDirectory()) {
    throw new Error("--development-root must name an existing real directory without symlink or path aliases");
  }

  const rootPackage = readPackageRecord(join(sourceRoot, "package.json"));
  const installerPackage = readPackageRecord(join(sourceRoot, "packages", "installer", "package.json"));
  if (rootPackage?.name !== "@therealityreport/tweakers"
    || !Array.isArray(rootPackage.workspaces)
    || !rootPackage.workspaces.includes("packages/*")
    || installerPackage?.name !== "@therealityreport/tweakers-installer") {
    throw new Error(`--development-root is not a Tweakers package root: ${sourceRoot}`);
  }

  const git = spawnSync("git", ["-C", sourceRoot, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let gitRoot: string | null = null;
  if (git.status === 0 && git.stdout.trim() !== "") {
    try { gitRoot = realpathSync(git.stdout.trim()); } catch { gitRoot = null; }
  }
  if (gitRoot !== sourceRoot) {
    throw new Error(`--development-root is not the root of a Tweakers Git worktree: ${sourceRoot}`);
  }
  return sourceRoot;
}

function explicitDevelopmentSelection(sourceRoot: string): RefreshSelection {
  return {
    selected: "development",
    sourceRoot,
    developmentSourceRoot: sourceRoot,
  };
}

function readPackageRecord(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
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
  // Capture instead of inheriting stdio: refresh usually runs detached (launchd
  // or a desktop-update owner), so inherited child output is lost and failures
  // land in refresh-state/desktop-update logs with no cause. Echo the captured
  // output so interactive runs stay as informative as before.
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const detail = result.error?.message
      ?? (result.signal ? `signal ${result.signal}` : `status ${result.status ?? "unknown"}`);
    const tail = [result.stdout, result.stderr]
      .filter((chunk): chunk is string => typeof chunk === "string" && chunk.trim() !== "")
      .join("\n")
      .trim()
      .split("\n")
      .slice(-8)
      .join("\n")
      .slice(-800);
    throw new Error(`${command} ${args.join(" ")} failed with ${detail}${tail ? `: ${tail}` : ""}`);
  }
}

/**
 * launchd-spawned refreshes run with a minimal PATH that lacks version-manager
 * bin dirs (nvm/asdf/volta), but they invoke the CLI with an absolute node
 * path — npm sits next to that running node binary, so prefer the sibling
 * before falling back to the bare PATH lookup.
 */
export function npmCommand(platform = process.platform, execPath = process.execPath): string {
  const name = platform === "win32" ? "npm.cmd" : "npm";
  const sibling = join(dirname(execPath), name);
  return existsSync(sibling) ? sibling : name;
}

/**
 * A promoted live root must keep the Menu Bar restart coordinator usable:
 * coordinator.json / switcher.json can be missing from the live root after a
 * repair, and without them the Menu Bar Tweakers pane reports "Tweakers
 * Unavailable" and blocks the mode/reload controls. Never fail the refresh
 * for this — warn instead.
 */
export async function restoreModeCoordinatorMetadata(
  ensure: typeof ensureModeCoordinatorConfigured = ensureModeCoordinatorConfigured,
): Promise<void> {
  try {
    const coordinator = await ensure();
    if (!coordinator.configured) {
      console.warn(`Restart coordinator metadata was not restored: ${coordinator.reason ?? "unknown reason"}`);
    }
  } catch (error) {
    console.warn(`Restart coordinator metadata was not restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface RefreshHandoffAdapters {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  argv: string[];
  execPath: string;
  cwd: string;
  now(): number;
  submit(command: string, args: string[]): { status: number | null };
}

interface RefreshHandoffState {
  source: RefreshSource;
  developmentSourceRoot: string | null;
}

export function handoffRefreshLocalToLaunchd(
  userRoot: string,
  overrides: Partial<RefreshHandoffAdapters> = {},
  state: RefreshHandoffState = { source: "current", developmentSourceRoot: null },
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
    source: state.source,
    phase: "preparing",
    developmentSourceRoot: state.developmentSourceRoot,
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
  // even on exit code 0. The EXIT/signal traps unregister the job while
  // preserving the refresh command's real status for launchd diagnostics.
  const command = `${buildTransientLaunchdExitTrap(label)}\n${refreshCommand}`;
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

function buildTransientLaunchdExitTrap(label: string): string {
  const quotedLabel = shellQuote(label);
  return [
    "cleanup_transient_launchd_job() {",
    "  status=$?",
    "  trap - EXIT HUP INT TERM",
    `  launchctl remove ${quotedLabel} >/dev/null 2>&1 || launchctl bootout gui/$(id -u)/${quotedLabel} >/dev/null 2>&1`,
    '  exit "$status"',
    "}",
    "trap cleanup_transient_launchd_job EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
  ].join("\n");
}
