#!/usr/bin/env node
import sade from "sade";
import kleur from "kleur";
import { install } from "./commands/install.js";
import { uninstall } from "./commands/uninstall.js";
import { repair } from "./commands/repair.js";
import {
  cancelCodexUpdate,
  codexUpdateStatus,
  reconcileCodexUpdate,
  resumeCodexUpdate,
  updateCodex,
} from "./commands/update-codex.js";
import { selfUpdate } from "./commands/self-update.js";
import { status } from "./commands/status.js";
import { debug } from "./commands/debug.js";
import { browserUi } from "./commands/browser-ui.js";
import { doctor } from "./commands/doctor.js";
import { mcpLifecycle } from "./commands/mcp-lifecycle.js";
import { safeMode } from "./commands/safe-mode.js";
import { migrate } from "./commands/migrate.js";
import { TWEAKER_VERSION } from "./version.js";
import { buildCliFailureIssueUrl, showPatchFailedAlert } from "./alerts.js";
import { capKnownLogFiles } from "./logging.js";
import { createTweakersVariant } from "./commands/create-variant.js";
import { runWatcherCycle } from "./watcher-cycle.js";
import { ensureUserPaths } from "./paths.js";
import {
  assertEnvironmentCliSuccess,
  environment,
  type EnvironmentCommandOptions,
} from "./commands/environment.js";
import { codexSource, type CodexSourceOptions } from "./commands/codex-source.js";

interface InstallCliOpts {
  app?: string;
  fuse?: boolean;
  resign?: boolean;
  local?: boolean;
  localSigning?: boolean;
  "local-signing"?: boolean;
  watcher?: boolean;
  verbose?: boolean;
  candidateOnly?: boolean;
  "candidate-only"?: boolean;
  coordinatedRefresh?: boolean;
  "coordinated-refresh"?: boolean;
  adHoc?: boolean;
  "ad-hoc"?: boolean;
}

interface RepairCliOpts {
  app?: string;
  quiet?: boolean;
  force?: boolean;
  local?: boolean;
  localSigning?: boolean;
  "local-signing"?: boolean;
  watcher?: boolean;
}

function wrap<T extends (...args: never[]) => unknown | Promise<unknown>>(fn: T): T {
  return ((...args: Parameters<T>) => {
    Promise.resolve()
      .then(() => fn(...args))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        const command = process.argv[2];
        console.error("\n" + kleur.red().bold("✗ Tweakers failed"));
        console.error(msg);
        console.error("");
        console.error(
          kleur.yellow("If the message above does not explain how to fix it, please report this on GitHub:"),
        );
        console.error(buildCliFailureIssueUrl(command, msg));
        maybeShowPatchFailedAlert(msg);
        process.exit(1);
      });
  }) as unknown as T;
}

function runInstall(opts: InstallCliOpts): Promise<void> {
  return install({
    ...opts,
    candidateOnly: opts.candidateOnly ?? opts["candidate-only"],
    candidateOnlyReason: opts.coordinatedRefresh === true || opts["coordinated-refresh"] === true ? "coordinated-refresh" : "explicit",
    localSigning: opts.adHoc === true || opts["ad-hoc"] === true ? false : resolveLocalSigning(opts),
  });
}

function runRepair(opts: RepairCliOpts): Promise<void> {
  return repair({
    ...opts,
    localSigning: resolveLocalSigning(opts),
  });
}

function resolveLocalSigning(opts: {
  local?: boolean;
  localSigning?: boolean;
  "local-signing"?: boolean;
}): boolean | undefined {
  if (opts.local === false || opts.localSigning === false || opts["local-signing"] === false) {
    return false;
  }
  return opts.localSigning ?? opts["local-signing"] ?? opts.local;
}

async function runCreateTweak(target: string, opts: never): Promise<void> {
  const { createTweak } = await import("./commands/create-tweak.js");
  return createTweak(target, opts);
}

async function runValidateTweak(target?: string): Promise<void> {
  const { validateTweak } = await import("./commands/validate-tweak.js");
  return validateTweak(target);
}

async function runDevTweak(target: string | undefined, opts: never): Promise<void> {
  const { devTweak } = await import("./commands/dev-tweak.js");
  return devTweak(target, opts);
}

async function runDevSync(opts: { off?: boolean; quiet?: boolean; watch?: boolean }): Promise<void> {
  const { devSync } = await import("./commands/dev-sync.js");
  return devSync(opts);
}

async function runRefreshLocal(opts: { source?: "smart" | "development" | "stable"; app?: string }): Promise<void> {
  const { refreshLocal } = await import("./commands/refresh-local.js");
  return refreshLocal(opts);
}

async function runMode(target: string, opts: { json?: boolean; yes?: boolean; app?: string }): Promise<void> {
  const { mode } = await import("./commands/mode.js");
  return mode(target, opts);
}

async function runEnvironment(action: string, opts: EnvironmentCommandOptions): Promise<void> {
  const result = await environment(action, opts);
  // The receipt has already been printed, so callers still get the durable
  // diagnosis alongside a truthful exit code.
  assertEnvironmentCliSuccess(action as Parameters<typeof assertEnvironmentCliSuccess>[0], result);
}

async function runRefreshStatus(): Promise<void> {
  const { getLocalRefreshStatus } = await import("./commands/refresh-local.js");
  const { ensureUserPaths } = await import("./paths.js");
  console.log(JSON.stringify(getLocalRefreshStatus(ensureUserPaths().root)));
}

function maybeShowPatchFailedAlert(message: string): void {
  const command = process.argv[2];
  if (command !== "repair") return;
  showPatchFailedAlert(message);
}

const prog = sade("tweaker")
  .version(TWEAKER_VERSION)
  .describe("Tweak system for the Codex desktop app");

capKnownLogFiles();

prog
  .command("install")
  .describe("Patch Codex.app to load the tweak runtime")
  .option("--app", "Path to Codex.app / install dir (auto-detected if omitted)")
  .option("--fuse", "Flip Electron's embedded asar integrity fuse", true)
  .option("--resign", "Code sign Codex.app on macOS", true)
  .option("--local", "Use a stable local signing identity on macOS")
  .option("--local-signing", "Alias for --local")
  .option("--watcher", "Install the auto-repair watcher", true)
  .option("--candidate-only", "Build and validate a disposable signed candidate without changing the live app")
  .option("--coordinated-refresh", "Hold the candidate for the internal quit-and-promote refresh flow")
  .option("--ad-hoc", "Use ad-hoc signing for an explicit candidate-only build; this candidate can never promote")
  .option("--verbose", "Show low-level patching details")
  .action(wrap(runInstall));

prog
  .command("create-variant")
  .describe("Create an isolated Tweakers ChatGPT app while keeping the official app untouched")
  .option("--source", "Verified official OpenAI-signed ChatGPT.app to copy")
  .option("--app", "Target path (default: /Applications/Tweakers ChatGPT.app)")
  .option("--user-root", "Isolated Tweakers state directory")
  .option("--user-data", "Isolated Electron user-data directory")
  .action(wrap(createTweakersVariant));

prog
  .command("uninstall")
  .describe("Restore Codex.app from backup and remove the watcher")
  .option("--app", "Path to Codex.app / install dir")
  .option("--purge", "Delete tweaks, config, logs, backups, and Tweakers user data")
  .action(wrap(uninstall));

prog
  .command("repair")
  .describe("Re-apply the patch (use after a Sparkle auto-update)")
  .option("--app", "Path to Codex.app / install dir")
  .option("--quiet", "Suppress non-error output")
  .option("--force", "Re-apply even if the patch appears intact")
  .option("--local", "Use a stable local signing identity on macOS")
  .option("--local-signing", "Alias for --local")
  .option("--watcher", "Run from the auto-repair watcher")
  .action(wrap(runRepair));

prog
  .command("update-chatgpt")
  .describe("Start the durable official ChatGPT Update and Reload transaction")
  .option("--app", "Path to Codex.app / install dir")
  .option("--json", "Print the schema-v1 transaction receipt as JSON")
  .action(wrap(updateCodex));

// Compatibility alias retained for existing tweaker installs.
prog
  .command("update-codex")
  .describe("Alias for update-chatgpt")
  .option("--app", "Path to Codex.app / install dir")
  .option("--json", "Print the schema-v1 transaction receipt as JSON")
  .action(wrap(updateCodex));

prog
  .command("update-chatgpt-status")
  .describe("Print the durable desktop update transaction status")
  .option("--app", "Path to Codex.app / install dir")
  .option("--json", "Print the schema-v1 transaction receipt as JSON", true)
  .action(wrap(codexUpdateStatus));

prog
  .command("update-chatgpt-resume")
  .describe("Resume a timed-out desktop update while ChatGPT remains in official mode")
  .option("--app", "Path to Codex.app / install dir")
  .option("--json", "Print the schema-v1 transaction receipt as JSON")
  .action(wrap(resumeCodexUpdate));

prog
  .command("update-chatgpt-reconcile")
  .describe("Reconcile an interrupted desktop update without relaunching ChatGPT")
  .option("--app", "Path to Codex.app / install dir")
  .option("--json", "Print the transaction receipt or explicit idle result as JSON")
  .action(wrap(reconcileCodexUpdate));

prog
  .command("update-chatgpt-cancel")
  .describe("Cancel an active desktop update continuation")
  .option("--app", "Path to Codex.app / install dir")
  .option("--json", "Print the schema-v1 transaction receipt as JSON")
  .action(wrap(cancelCodexUpdate));

prog
  .command("codex-source <action>")
  .describe("Inspect or prepare official Codex source for the bundled control lane or an explicit stable/edge lane")
  .option("--app", "Exact ChatGPT.app path used to probe the bundled backend")
  .option("--channel", "Source channel: bundled (default), stable, or edge")
  .option("--force", "Bypass the daily advisory throttle (detect only)")
  .option("--frontend-source-app", "Exact pristine internal ChatGPT.app source (build only)")
  .option("--patch-series", "Comma-separated exact absolute patch files (build only)")
  .option("--chrome-plugin-root", "Exact Chrome DevTools plugin release root (build only)")
  .option("--playwright-plugin-root", "Exact Playwright plugin release root (build only)")
  .option("--fleet-manifest", "Exact full-fleet lifecycle/catalog/artifact manifest (build only)")
  .option("--transaction-id", "Durable source transaction ID")
  .option("--restart-window-opens-at", "Approved restart-window opening timestamp (freeze only)")
  .option("--restart-window-closes-at", "Approved restart-window closing timestamp (freeze only)")
  .option("--live-codex-home", "Exact live CODEX_HOME (cutover/rollback only)")
  .option("--live-config", "Exact live config.toml (cutover/rollback only)")
  .option("--watcher-receipt", "Exact watcher handoff receipt path (cutover/rollback only)")
  .option("--approval-file", "Exact restart approval file (cutover/rollback only)")
  .option("--json", "Print machine-readable output", true)
  .action(wrap((action: string, options: CodexSourceOptions) => codexSource(action, options)));

prog
  .command("update")
  .describe("Install the latest published Tweakers release; keep the managed runtime when no release exists")
  .option("--repo", "GitHub repo to download (default: therealityreport/tweakers)")
  .option("--ref", "Git ref to download (default: latest GitHub release)")
  .option("--repair", "Run repair after updating", true)
  .option("--quiet", "Suppress non-error output")
  .option("--watcher", "Run in watcher mode and respect automatic refresh settings")
  .option("--force", "Download and rebuild even if the selected release is already installed")
  .action(wrap(selfUpdate));

prog
  .command("self-update")
  .describe("Legacy alias for update")
  .option("--repo", "GitHub repo to download (default: therealityreport/tweakers)")
  .option("--ref", "Git ref to download (default: latest GitHub release)")
  .option("--repair", "Run repair after updating", true)
  .option("--quiet", "Suppress non-error output")
  .option("--watcher", "Run in watcher mode and respect automatic refresh settings")
  .option("--force", "Download and rebuild even if the selected release is already installed")
  .action(wrap(selfUpdate));

prog
  .command("mode <target>")
  .describe("Switch ChatGPT.app between the pristine official app (chatgpt) and the patched app (tweakers), or show mode status")
  .option("--json", "Print machine-readable output (status only)")
  .option("--yes", "Skip the confirmation prompt")
  .option("--app", "Path to ChatGPT.app / install dir")
  .action(wrap(runMode));

prog
  .command("environment <action>")
  .describe("Inspect, prepare, complete, and recover a durable Stable/Alpha and ChatGPT/Tweakers environment transaction")
  .option("--app-experience", "App experience: chatgpt or tweakers")
  .option("--release-profile", "Release profile: stable or alpha")
  .option("--bundled-derived-receipt", "Validated bundled-derived Codex receipt (prepare only)")
  .option("--transaction", "Durable environment transaction ID")
  .option("--app-path", "Exact absolute path to a user-selected OpenAI Beta .app (register-alpha only)")
  .option("--app", "Alias for --app-path")
  .option("--observe", "Read persisted and observed environment state without taking the lifecycle lock")
  .option("--dry-run", "Preview environment transaction artifacts eligible for garbage collection")
  .option("--apply", "Delete only artifacts that remain eligible after locked revalidation")
  .option("--json", "Print exactly one machine-readable JSON value")
  .action(wrap(runEnvironment));

prog
  .command("status")
  .describe("Show patch status, paths, version")
  .action(status);

prog
  .command("doctor")
  .describe("Diagnose common issues (signature, fuses, asar integrity, perms)")
  .option("--deep", "Verify lifecycle asset bytes, modes, and action receipts")
  .option("--json", "Print exactly one machine-readable JSON value")
  .action(wrap(doctor));

prog
  .command("mcp-lifecycle <action>")
  .describe("Inspect, preview, repair current managed services, or explicitly adopt the exact recognized predecessor")
  .option("--apply", "Apply the selected verified repair or explicit predecessor adoption and reload the exact existing labels")
  .option("--deep", "Verify installed asset bytes, modes, status, and receipts")
  .option("--json", "Print exactly one machine-readable JSON value")
  .option("--source", "Explicit canonical package root")
  .action(wrap(mcpLifecycle));

prog
  .command("debug")
  .describe("Show install, runtime, data paths, open state, and bridge status")
  .option("--app", "Path to Codex.app / install dir")
  .action(wrap(debug));

prog
  .command("browser")
  .describe("Open the Codex UI in a browser tab backed by a hidden host")
  .option("--app", "Path to Codex.app / install dir")
  .option("--port", "Local browser UI port", 8765)
  .option("--open", "Open the browser tab after launch", true)
  .option("--keep-window", "Leave the desktop window visible")
  .action(wrap(browserUi));

prog
  .command("create-tweak <target>")
  .describe("Scaffold a new local tweak")
  .option("--id", "Manifest id, e.g. com.you.my-tweak")
  .option("--name", "Human-readable tweak name")
  .option("--repo", "GitHub repo in owner/repo form")
  .option("--scope", "renderer, main, or both")
  .option("--force", "Write into an existing empty directory")
  .action(wrap(runCreateTweak));

prog
  .command("validate-tweak [target]")
  .describe("Validate a tweak manifest and entry point")
  .action(wrap(runValidateTweak));

prog
  .command("dev [target]")
  .describe("Link a local tweak into the Tweakers tweaks directory")
  .option("--name", "Override linked directory name; defaults to manifest id")
  .option("--replace", "Replace an existing symlink at the target tweak id")
  .option("--no-watch", "Link once and exit instead of watching for changes")
  .action(wrap(runDevTweak));

prog
  .command("dev-sync")
  .describe("Validate, build, and publish the development checkout without changing Git state")
  .option("--watch", "Watch the checkout and publish each successful validated build")
  .option("--off", "Disable dev mode and restore the bundled tweak copies")
  .option("--quiet", "Suppress output")
  .action(wrap(runDevSync));

prog
  .command("refresh-local")
  .describe("Validate, quit, refresh, and reopen the local ChatGPT app")
  .option("--source", "Refresh source: smart, development, or stable", "smart")
  .option("--app", "Path to ChatGPT.app / install dir")
  .action(wrap(runRefreshLocal));

prog.command("refresh-status").describe("Print local ChatGPT refresh status as JSON").action(wrap(runRefreshStatus));

prog.command("tweaks").describe("List and manage installed tweaks").action(() => console.log("Tweaks are stored in the user data directory."));
prog.command("migrate")
  .describe("Dry-run or apply the legacy Projects/GitHub Accounts migration")
  .option("--dry-run", "Inventory and report exact actions without writing")
  .option("--apply", "Apply the reported migration; legacy roots remain unchanged")
  .option("--legacy-root", "Explicit legacy root (otherwise known roots are detected)")
  .option("--target-root", "Tweakers user root (defaults to the active user root)")
  .action(wrap(migrate));
prog.command("watcher-run").describe("Run one internal watcher cycle").action(wrap(() =>
  runWatcherCycle({ userRoot: ensureUserPaths().root }).then(() => undefined)
));

prog
  .command("safe-mode")
  .describe("Temporarily disable all tweaks without deleting them. Leave safe mode with: tweaker safe-mode --off")
  .option("--on", "Enable safe mode (default)")
  .option("--off", "Disable safe mode and return to normal tweak loading")
  .option("--status", "Print current safe mode status")
  .action(wrap(safeMode));

const argv = process.argv.length <= 2 ? [...process.argv, "--help"] : process.argv;

prog.parse(argv, {
  unknown: (flag) => {
    console.error(kleur.red(`Unknown flag: ${flag}`));
    process.exit(1);
  },
});
