import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  SWITCHER_LABEL,
  ensureSwitcherInstalled,
  installedSwitcherApp,
  installedSwitcherBinary,
  removeSwitcher,
  renderSwitcherLaunchAgentPlist,
  resolveSwitcherCliInvocation,
  switcherConfigFile,
  switcherLaunchAgentPlist,
  switcherStatus,
  type SwitcherSetupDeps,
} from "../src/switcher-setup";
import { readPlist } from "../src/plist";

async function withTweakersHome(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweakers-switcher-setup-"));
  const previous = process.env.TWEAKERS_HOME;
  process.env.TWEAKERS_HOME = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.TWEAKERS_HOME;
    else process.env.TWEAKERS_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Minimal prebuilt-switcher-asset stand-in. */
function makeAssetApp(dir: string, binaryBody = "#!binary-v1"): string {
  const app = join(dir, "Tweakers Switcher.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "Tweakers Switcher"), binaryBody);
  writeFileSync(join(app, "Contents", "Info.plist"), "<plist/>");
  return app;
}

function makeDeps(root: string, overrides: Partial<SwitcherSetupDeps> = {}): {
  deps: SwitcherSetupDeps;
  events: string[];
} {
  const events: string[] = [];
  const deps: SwitcherSetupDeps = {
    platform: () => "darwin",
    assetApp: makeAssetApp(join(root, "assets")),
    launchAgentsDir: join(root, "LaunchAgents"),
    logPath: join(root, "log", "switcher.log"),
    sign: (appRoot) => {
      events.push(`sign:${appRoot}`);
    },
    launchctl: (args) => {
      events.push(`launchctl:${args.join(" ")}`);
    },
    isAgentLoaded: () => true,
    cliInvocation: () => ["/usr/bin/node", "/opt/tweakers/cli.js"],
    ...overrides,
  };
  return { deps, events };
}

/* ------------------------------------------------------------------------- */
/* LaunchAgent plist rendering                                               */
/* ------------------------------------------------------------------------- */

test("switcher LaunchAgent plist renders RunAtLoad plus crash-only KeepAlive", async () => {
  await withTweakersHome(async (root) => {
    const binary = "/x/bin/Tweakers Switcher.app/Contents/MacOS/Tweakers Switcher";
    const log = join(root, "switcher.log");
    const plistPath = join(root, "agent.plist");
    writeFileSync(plistPath, renderSwitcherLaunchAgentPlist(binary, log, root));

    const parsed = readPlist(plistPath);
    assert.equal(parsed.Label, SWITCHER_LABEL);
    assert.deepEqual(parsed.ProgramArguments, [binary]);
    assert.equal(parsed.RunAtLoad, true);
    // Restart only after a crash: a clean "Quit Switcher" (exit 0) stays quit.
    assert.deepEqual(parsed.KeepAlive, { SuccessfulExit: false });
    assert.equal(parsed.StandardOutPath, log);
    assert.equal(parsed.StandardErrorPath, log);
    // launchd never carries shell overrides: the resolved user root is baked
    // in so an override-root install (TWEAKERS_HOME) resolves the same root
    // as the installer that set it up.
    assert.deepEqual(parsed.EnvironmentVariables, { TWEAKERS_HOME: root });
  });
});

test("copy-assets never deletes a committed asset when its source is missing", () => {
  // The prebuilt switcher legitimately has no dist on non-darwin hosts and
  // after `npm run clean` — deleting the destination before the source check
  // would silently strip the checked-in asset from the working tree.
  const source = readFileSync(new URL("../scripts/copy-assets.mjs", import.meta.url), "utf8");
  const skip = source.indexOf("if (!existsSync(src))");
  const remove = source.indexOf("rmSync(dest");
  assert.ok(skip >= 0, "copy-assets must check the source before copying");
  assert.ok(remove > skip, "the missing-source skip must run before rmSync(dest)");
});

/* ------------------------------------------------------------------------- */
/* ensureSwitcherInstalled                                                   */
/* ------------------------------------------------------------------------- */

test("ensureSwitcherInstalled copies, configures, signs, and loads in order", async () => {
  await withTweakersHome(async (root) => {
    const { deps, events } = makeDeps(root);

    const result = await ensureSwitcherInstalled(deps);
    assert.deepEqual(result, { installed: true });

    // App copy landed under <root>/bin/.
    const binary = installedSwitcherBinary(root);
    assert.equal(readFileSync(binary, "utf8"), "#!binary-v1");

    // CLI sidecar carries the injected argv prefix.
    const config = JSON.parse(readFileSync(switcherConfigFile(root), "utf8")) as {
      schemaVersion: number;
      cli: string[];
    };
    assert.equal(config.schemaVersion, 1);
    assert.deepEqual(config.cli, ["/usr/bin/node", "/opt/tweakers/cli.js"]);

    // LaunchAgent plist points at the installed binary and carries the
    // resolved user root for launchd's minimal environment.
    const plistPath = switcherLaunchAgentPlist(join(root, "LaunchAgents"));
    const parsed = readPlist(plistPath);
    assert.equal(parsed.Label, SWITCHER_LABEL);
    assert.deepEqual(parsed.ProgramArguments, [binary]);
    assert.deepEqual(parsed.KeepAlive, { SuccessfulExit: false });
    assert.deepEqual(parsed.EnvironmentVariables, { TWEAKERS_HOME: root });

    // Sign the copy BEFORE loading the agent; load goes through gui/$UID.
    const signIndex = events.findIndex((event) => event === `sign:${installedSwitcherApp(root)}`);
    const bootstrapIndex = events.findIndex((event) => /^launchctl:bootstrap gui\/\d+ /.test(event));
    assert.ok(signIndex >= 0, `sign event missing in ${JSON.stringify(events)}`);
    assert.ok(bootstrapIndex > signIndex, `expected sign before bootstrap in ${JSON.stringify(events)}`);
    assert.ok(events.some((event) => /^launchctl:bootout gui\/\d+ /.test(event)));
    assert.ok(events.some((event) => new RegExp(`^launchctl:enable gui/\\d+/${SWITCHER_LABEL}$`).test(event)));
  });
});

test("ensureSwitcherInstalled is an idempotent refresh (new copy, reloaded agent)", async () => {
  await withTweakersHome(async (root) => {
    const { deps, events } = makeDeps(root);
    assert.equal((await ensureSwitcherInstalled(deps)).installed, true);

    // The shipped asset changed (e.g. a Tweakers update) — rerun refreshes.
    writeFileSync(join(deps.assetApp!, "Contents", "MacOS", "Tweakers Switcher"), "#!binary-v2");
    events.length = 0;

    const result = await ensureSwitcherInstalled(deps);
    assert.deepEqual(result, { installed: true });
    assert.equal(readFileSync(installedSwitcherBinary(root), "utf8"), "#!binary-v2");
    // The agent is reloaded so launchd runs the refreshed binary.
    assert.ok(events.some((event) => /^launchctl:bootout /.test(event)));
    assert.ok(events.some((event) => /^launchctl:bootstrap /.test(event)));
  });
});

test("ensureSwitcherInstalled reports failure reasons instead of throwing", async () => {
  await withTweakersHome(async (root) => {
    // Missing asset.
    const missing = await ensureSwitcherInstalled(
      makeDeps(root, { assetApp: join(root, "nope", "Tweakers Switcher.app") }).deps,
    );
    assert.equal(missing.installed, false);
    assert.match(missing.reason ?? "", /asset is missing/);

    // Signing failure aborts before any launchctl call.
    const { deps: signFail, events: signEvents } = makeDeps(root, {
      sign: () => {
        throw new Error("no signing identity");
      },
    });
    const signed = await ensureSwitcherInstalled(signFail);
    assert.equal(signed.installed, false);
    assert.match(signed.reason ?? "", /could not sign the switcher app: no signing identity/);
    assert.equal(signEvents.some((event) => event.startsWith("launchctl:")), false);

    // launchd refusing every load path surfaces as a load failure.
    const { deps: loadFail } = makeDeps(root, {
      launchctl: () => {
        throw new Error("launchd says no");
      },
    });
    const loaded = await ensureSwitcherInstalled(loadFail);
    assert.equal(loaded.installed, false);
    assert.match(loaded.reason ?? "", /could not load the switcher LaunchAgent/);
  });
});

test("ensureSwitcherInstalled and removeSwitcher refuse on non-macOS platforms", async () => {
  await withTweakersHome(async (root) => {
    const { deps } = makeDeps(root, { platform: () => "linux" });
    const installed = await ensureSwitcherInstalled(deps);
    assert.equal(installed.installed, false);
    assert.match(installed.reason ?? "", /only supported on macOS/);

    const removed = await removeSwitcher(deps);
    assert.equal(removed.removed, false);
    assert.match(removed.reason ?? "", /only supported on macOS/);
  });
});

/* ------------------------------------------------------------------------- */
/* removeSwitcher                                                            */
/* ------------------------------------------------------------------------- */

test("removeSwitcher boots the agent out and deletes app, plist, and config", async () => {
  await withTweakersHome(async (root) => {
    const { deps, events } = makeDeps(root);
    assert.equal((await ensureSwitcherInstalled(deps)).installed, true);
    events.length = 0;

    const result = await removeSwitcher(deps);
    assert.deepEqual(result, { removed: true });
    assert.equal(existsSync(installedSwitcherApp(root)), false);
    assert.equal(existsSync(switcherConfigFile(root)), false);
    assert.equal(existsSync(switcherLaunchAgentPlist(join(root, "LaunchAgents"))), false);
    assert.ok(events.some((event) => /^launchctl:bootout /.test(event)));

    // Idempotent: a second removal is a quiet no-op that never calls launchd.
    events.length = 0;
    const again = await removeSwitcher(deps);
    assert.equal(again.removed, false);
    assert.match(again.reason ?? "", /not installed/);
    assert.deepEqual(events, []);
  });
});

/* ------------------------------------------------------------------------- */
/* switcherStatus                                                            */
/* ------------------------------------------------------------------------- */

test("switcherStatus reports installed only when app, plist, and agent are live", async () => {
  await withTweakersHome(async (root) => {
    const { deps } = makeDeps(root);

    // Nothing installed yet.
    const empty = await switcherStatus(deps);
    assert.equal(empty.installed, false);
    assert.match(empty.reason ?? "", /app is not installed/);

    assert.equal((await ensureSwitcherInstalled(deps)).installed, true);
    assert.deepEqual(await switcherStatus(deps), { installed: true });

    // Loaded-agent check is part of "installed" — a dead agent is not enough.
    const unloaded = await switcherStatus({ ...deps, isAgentLoaded: () => false });
    assert.equal(unloaded.installed, false);
    assert.match(unloaded.reason ?? "", /not loaded/);

    // Status never installs anything: the check leaves no new files behind.
    rmSync(installedSwitcherApp(root), { recursive: true, force: true });
    const gone = await switcherStatus(deps);
    assert.equal(gone.installed, false);
    assert.equal(existsSync(installedSwitcherApp(root)), false);
  });
});

/* ------------------------------------------------------------------------- */
/* install() wiring                                                          */
/* ------------------------------------------------------------------------- */

test("install() promotion wires a nonfatal switcher refresh", () => {
  const source = readFileSync(new URL("../src/commands/install.ts", import.meta.url), "utf8");
  // The switcher rides along with every promotion, but promotion must never
  // fail over the menu-bar helper — the refresh only warns.
  assert.match(source, /await ensureSwitcherInstalled\(\)/);
  assert.match(source, /Menu-bar switcher install skipped/);
  assert.match(source, /Menu-bar switcher install failed/);
});

/* ------------------------------------------------------------------------- */
/* CLI invocation resolution                                                 */
/* ------------------------------------------------------------------------- */

test("resolveSwitcherCliInvocation prefers the managed CLI and falls back to the live entry", async () => {
  await withTweakersHome(async (root) => {
    // Managed runtime present: the invocation targets it directly.
    const managed = join(root, "managed-runtime", "current", "packages", "installer", "dist", "cli.js");
    mkdirSync(join(root, "managed-runtime", "current", "packages", "installer", "dist"), { recursive: true });
    writeFileSync(managed, "// cli");
    assert.deepEqual(resolveSwitcherCliInvocation(root), [process.execPath, managed]);

    // No managed runtime: fall back to the currently running entry point.
    rmSync(join(root, "managed-runtime"), { recursive: true, force: true });
    const fallback = resolveSwitcherCliInvocation(root);
    assert.equal(fallback[0], process.execPath);
    assert.equal(fallback[fallback.length - 1], resolve(process.argv[1]));
  });
});
