import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCliFailureIssueUrl,
  buildPatchFailureIssueUrl,
  codexReopenScript,
  isMacAppManagementError,
} from "../src/alerts";
import { findCodexMainCandidates } from "../src/commands/install";
import { createTweak } from "../src/commands/create-tweak";
import { devTweak } from "../src/commands/dev-tweak";
import { safeMode } from "../src/commands/safe-mode";
import {
  ensureCliExecutable,
  formatCommandFailure,
  githubRequestHeaders,
  isNoPublishedReleaseError,
  releaseVersionFromTag,
  shouldDownloadSelfUpdate,
  shouldRunWatcherSelfUpdate,
} from "../src/commands/self-update";
import { validateTweak } from "../src/commands/validate-tweak";
import {
  CODEX_WINDOW_SERVICES_KEY,
  patchCodexWindowServicesSource,
} from "../src/codex-window-services";
import { readSelfUpdateState, writeSelfUpdateState } from "../src/self-update-state";
import { describeInstallationSource } from "../src/source-root";
import {
  currentWindowsWatcherTaskNames,
  legacyWindowsWatcherTaskNames,
  watcherShellScript,
} from "../src/watcher";
import { hashDirectoryTree, stageBundledTweaks } from "../src/commands/install";
import { hasReleaseProvenance, installManagedRuntime, managedCliPath, managedSourceRoot, writeReleaseProvenance } from "../src/managed-runtime";

test("createTweak scaffolds a both-scope tweak", () => {
  withTempDir((root) => {
    const dir = join(root, "my-tweak");

    withSilencedConsole(() =>
      createTweak(dir, {
        id: "com.example.generated",
        name: "Generated",
        repo: "example/generated",
        scope: "both",
      }),
    );

    assert.equal(existsSync(join(dir, "manifest.json")), true);
    assert.equal(existsSync(join(dir, "index.js")), true);
    assert.equal(existsSync(join(dir, "README.md")), true);
    assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).scope, "both");
  });
});

test("createTweak refuses non-empty target directories unless forced empty", () => {
  withTempDir((root) => {
    const dir = join(root, "existing");
    withSilencedConsole(() => createTweak(dir, { repo: "example/existing" }));

    assert.throws(
      () => withSilencedConsole(() => createTweak(dir, { repo: "example/existing" })),
      /not empty/,
    );
  });
});

test("validateTweak accepts a generated tweak", () => {
  withTempDir((root) => {
    const dir = join(root, "valid");

    withSilencedConsole(() => createTweak(dir, { repo: "example/valid", scope: "renderer" }));

    assert.doesNotThrow(() => withSilencedConsole(() => validateTweak(dir)));
  });
});

test("validateTweak rejects missing entry files", () => {
  withTempDir((root) => {
    const dir = join(root, "missing-entry");
    withSilencedConsole(() => createTweak(dir, { repo: "example/missing-entry" }));
    rmSync(join(dir, "index.js"));

    assert.throws(() => withSilencedConsole(() => validateTweak(dir)), /validation failed/);
  });
});

test("validateTweak rejects invalid manifests", () => {
  withTempDir((root) => {
    const dir = join(root, "invalid");
    withSilencedConsole(() => createTweak(dir, { repo: "example/invalid" }));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "bad id" }));

    assert.throws(() => withSilencedConsole(() => validateTweak(dir)), /validation failed/);
  });
});

test("devTweak links a valid tweak into the configured tweaks directory", async () => {
  await withTempEnvAsync(async (envRoot) => {
    await withTempDirAsync(async (root) => {
      const dir = join(root, "linked");
      withSilencedConsole(() => createTweak(dir, { repo: "example/linked" }));

      await withSilencedConsoleAsync(() => devTweak(dir, { watch: false }));

      const link = join(envRoot, "tweaks", "com.example.linked");
      assert.equal(existsSync(link), true);
    });
  });
});

test("devTweak refuses to replace a link pointing elsewhere without --replace", async () => {
  await withTempEnvAsync(async (envRoot) => {
    await withTempDirAsync(async (root) => {
      const first = join(root, "first");
      const second = join(root, "second");
      withSilencedConsole(() => createTweak(first, { repo: "example/first" }));
      withSilencedConsole(() =>
        createTweak(second, {
          id: "com.example.first",
          repo: "example/second",
        }),
      );

      await withSilencedConsoleAsync(() => devTweak(first, { watch: false }));

      await assert.rejects(
        () => withSilencedConsoleAsync(() => devTweak(second, { watch: false })),
        /already exists/,
      );

      const link = join(envRoot, "tweaks", "com.example.first");
      assert.equal(existsSync(link), true);
    });
  });
});

test("devTweak replaces an existing dev link when requested", async () => {
  await withTempEnvAsync(async (envRoot) => {
    await withTempDirAsync(async (root) => {
      const first = join(root, "replace-first");
      const second = join(root, "replace-second");
      withSilencedConsole(() => createTweak(first, { repo: "example/replace-first" }));
      withSilencedConsole(() =>
        createTweak(second, {
          id: "com.example.replace-first",
          repo: "example/replace-second",
        }),
      );

      await withSilencedConsoleAsync(() => devTweak(first, { watch: false }));
      await withSilencedConsoleAsync(() => devTweak(second, { replace: true, watch: false }));

      const link = join(envRoot, "tweaks", "com.example.replace-first");
      assert.equal(existsSync(join(link, "manifest.json")), true);
      assert.match(readFileSync(join(link, "manifest.json"), "utf8"), /replace-second/);
    });
  });
});

test("devTweak rejects invalid tweak directories", async () => {
  await withTempEnvAsync(async () => {
    await withTempDirAsync(async (root) => {
      await assert.rejects(
        () => withSilencedConsoleAsync(() => devTweak(root, { watch: false })),
        /manifest not found/,
      );
    });
  });
});

test("safeMode enables safe mode without changing per-tweak flags", async () => {
  await withTempEnvAsync(async (envRoot) => {
    writeFileSync(
      join(envRoot, "config.json"),
      JSON.stringify({ tweaks: { "com.example.keep": { enabled: true } } }),
    );

    withSilencedConsole(() => safeMode());

    const config = JSON.parse(readFileSync(join(envRoot, "config.json"), "utf8"));
    assert.equal(config.tweaker.safeMode, true);
    assert.equal(config.tweaks["com.example.keep"].enabled, true);
    assert.equal(existsSync(join(envRoot, "tweaks", ".tweaker-safe-mode-reload")), true);
  });
});

test("safeMode disables safe mode with --off", async () => {
  await withTempEnvAsync(async (envRoot) => {
    writeFileSync(
      join(envRoot, "config.json"),
      JSON.stringify({ tweaker: { safeMode: true } }),
    );

    withSilencedConsole(() => safeMode({ off: true }));

    const config = JSON.parse(readFileSync(join(envRoot, "config.json"), "utf8"));
    assert.equal(config.tweaker.safeMode, false);
  });
});

test("safeMode status does not create config", async () => {
  await withTempEnvAsync(async (envRoot) => {
    withSilencedConsole(() => safeMode({ status: true }));

    assert.equal(existsSync(join(envRoot, "config.json")), false);
  });
});

test("safeMode rejects conflicting flags", async () => {
  await withTempEnvAsync(async () => {
    assert.throws(() => withSilencedConsole(() => safeMode({ on: true, off: true })), /only one/);
  });
});

test("window services patch separates the exposed service from the next setup call", () => {
  const source =
    "let M=FM({buildFlavor:a,allowDevtools:p,globalState:j.globalState,getGlobalStateForHost:j.getGlobalStateForHost,desktopRoot:j.desktopRoot,preloadPath:j.preloadPath,repoRoot:j.repoRoot,disposables:k}),N=e=>M.isTrustedIpcSender(e.sender);wD({buildFlavor:a,isTrustedIpcEvent:N}),n.ipcMain.on(Li,e=>{})";

  const patched = patchCodexWindowServicesSource(source);

  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "service-factory-fingerprint");
  assert.match(
    patched.source,
    /;globalThis\.__tweaker_window_services__=M;globalThis\.[^=]+=M;wD\(\{buildFlavor:a/,
  );
  assert.doesNotMatch(patched.source, /__tweaker_window_services__=MwD/);
});

test("window services patch repairs the missing-separator state from Codex 26.429", () => {
  const source =
    "let M=FM({buildFlavor:a,allowDevtools:p,globalState:j.globalState,getGlobalStateForHost:j.getGlobalStateForHost,desktopRoot:j.desktopRoot,preloadPath:j.preloadPath,repoRoot:j.repoRoot,disposables:k}),N=e=>M.isTrustedIpcSender(e.sender);;globalThis.__tweaker_window_services__=MwD({buildFlavor:a,isTrustedIpcEvent:N}),n.ipcMain.on(Li,e=>{})";

  const patched = patchCodexWindowServicesSource(source);

  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "repair-missing-separator");
  assert.match(
    patched.source,
    /;globalThis\.__tweaker_window_services__=M;wD\(\{buildFlavor:a/,
  );
  assert.doesNotMatch(patched.source, /__tweaker_window_services__=MwD/);
});

test("window services patch does not depend on Codex minified function names", () => {
  const source =
    "let services=Qa({buildFlavor:a,allowDevtools:p,allowDebugMenu:h,globalState:j.globalState,getGlobalStateForHost:j.getGlobalStateForHost,desktopRoot:j.desktopRoot,preloadPath:j.preloadPath,repoRoot:j.repoRoot,canHideLastLocalWindowToTray:()=>O,disposables:k}),trusted=e=>services.isTrustedIpcSender(e.sender);Zd({buildFlavor:a,isTrustedIpcEvent:trusted})";

  const patched = patchCodexWindowServicesSource(source);

  assert.ok(patched);
  assert.equal(patched.serviceVar, "services");
  assert.match(
    patched.source,
    /;globalThis\.__tweaker_window_services__=services;globalThis\.[^=]+=services;Zd\(\{buildFlavor:a/,
  );
});

test("window services patch handles reordered factory object properties", () => {
  const source =
    "let M=FM({allowDevtools:p,allowDebugMenu:h,globalState:j.globalState,getGlobalStateForHost:j.getGlobalStateForHost,desktopRoot:j.desktopRoot,preloadPath:j.preloadPath,repoRoot:j.repoRoot,disposables:k,buildFlavor:a}),N=e=>M.isTrustedIpcSender(e.sender);wD({buildFlavor:a,isTrustedIpcEvent:N})";

  const patched = patchCodexWindowServicesSource(source);

  assert.ok(patched);
  assert.equal(patched.serviceVar, "M");
  assert.match(
    patched.source,
    /;globalThis\.__tweaker_window_services__=M;globalThis\.[^=]+=M;wD\(\{buildFlavor:a/,
  );
});

test("window services patch handles quoted factory object properties", () => {
  const source =
    "let M=FM({'buildFlavor':a,'allowDevtools':p,'allowDebugMenu':h,'globalState':j.globalState,'getGlobalStateForHost':j.getGlobalStateForHost,'desktopRoot':j.desktopRoot,'preloadPath':j.preloadPath,'repoRoot':j.repoRoot,'disposables':k});next()";

  const patched = patchCodexWindowServicesSource(source);

  assert.ok(patched);
  assert.equal(patched.serviceVar, "M");
  assert.match(patched.source, /;globalThis\.__tweaker_window_services__=M;globalThis\.[^=]+=M;next\(\)/);
});

test("window services patch is idempotent when the marker is already present", () => {
  const source = `let M=FM({buildFlavor:a,allowDevtools:p,globalState:j.globalState,getGlobalStateForHost:j.getGlobalStateForHost,desktopRoot:j.desktopRoot,preloadPath:j.preloadPath,repoRoot:j.repoRoot,disposables:k});globalThis.${CODEX_WINDOW_SERVICES_KEY}=M;wD({buildFlavor:a})`;

  const patched = patchCodexWindowServicesSource(source);

  assert.ok(patched);
  assert.equal(patched.changed, false);
  assert.equal(patched.source, source);
});

test("window services patch falls back to lifecycle registration fingerprint", () => {
  const source = [
    "let M=oG({theme:a,featureFlags:b});",
    "_B({isWindows:E,quitState:ee,windows:M,applicationMenuManager:oe.applicationMenuManager,ensureHostWindow:M.ensureHostWindow,hotkeyWindowLifecycleManager:M.hotkeyWindowLifecycleManager,globalDictationLifecycleManager:M.globalDictationLifecycleManager,globalStatesByHostId:j.globalStatesByHostId,flushAndDisposeContexts:I.flushAndDisposeContexts,disposables:k,appEvent:F.appEvent,errorReporter:g});",
  ].join("");

  const patched = patchCodexWindowServicesSource(source);

  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "lifecycle-registration-fingerprint");
  assert.equal(patched.serviceVar, "M");
  assert.match(patched.source, /;globalThis\.__tweaker_window_services__=M;$/);
});

test("window services patch ignores unrelated buildFlavor factories", () => {
  const source = "let x=Fn({buildFlavor:a,foo:b,bar:c});Other({buildFlavor:a})";

  assert.equal(patchCodexWindowServicesSource(source), null);
});

test("Codex main candidates include nested recovered Vite bundle files", () => {
  withTempDir((root) => {
    const buildDir = join(root, ".vite", "build");
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(root, "bootstrap.js"), "");
    writeFileSync(join(buildDir, "main-abc123.js"), "");
    writeFileSync(join(buildDir, "src-abc123.js"), "");
    writeFileSync(join(buildDir, "app-session-abc123.js"), "");
    writeFileSync(join(buildDir, "renderer-abc123.js"), "");
    writeFileSync(join(buildDir, "preload.js"), "");
    mkdirSync(join(buildDir, "chunks"), { recursive: true });
    writeFileSync(join(buildDir, "chunks", "main-window-services-abc123.js"), "");
    writeFileSync(join(buildDir, "chunks", "worker-service-abc123.js"), "");

    assert.deepEqual(findCodexMainCandidates(root, "bootstrap.js"), [
      join(root, "bootstrap.js"),
      join(buildDir, "main-abc123.js"),
      join(buildDir, "chunks", "main-window-services-abc123.js"),
      join(buildDir, "app-session-abc123.js"),
      join(buildDir, "src-abc123.js"),
      join(buildDir, "renderer-abc123.js"),
      join(buildDir, "preload.js"),
      join(buildDir, "chunks", "worker-service-abc123.js"),
    ]);
  });
});

test("patch failure report URL includes a prefilled GitHub issue", () => {
  const url = new URL(buildPatchFailureIssueUrl("Codex window services hook point not found"));

  assert.equal(url.origin + url.pathname, "https://github.com/therealityreport/tweakers/issues/new");
  assert.equal(url.searchParams.get("title"), "Tweakers failed to patch Codex after update");
  assert.match(url.searchParams.get("body") ?? "", /Codex window services hook point not found/);
  assert.match(url.searchParams.get("body") ?? "", /Platform:/);
});

test("CLI failure report URL includes command and environment details", () => {
  const url = new URL(buildCliFailureIssueUrl("install", "codesign not installed"));

  assert.equal(url.origin + url.pathname, "https://github.com/therealityreport/tweakers/issues/new");
  assert.equal(url.searchParams.get("title"), "Tweakers install failed");
  assert.match(url.searchParams.get("body") ?? "", /tweaker install/);
  assert.match(url.searchParams.get("body") ?? "", /codesign not installed/);
  assert.match(url.searchParams.get("body") ?? "", /Tweakers:/);
  assert.match(url.searchParams.get("body") ?? "", /Node:/);
});

test("Codex reopen script launches by path after a LaunchServices reconcile", () => {
  const script = codexReopenScript("/Applications/Codex.app", "com.openai.codex", 1000);

  assert.match(script, /delay 1\.00/);
  // Reconcile LaunchServices against the concrete path before reopening so a
  // stale bundle-id registration can never resolve to a second Dock tile.
  assert.match(script, /Support\/lsregister -f '\/Applications\/Codex\.app'/);
  assert.match(script, /\/usr\/bin\/open '\/Applications\/Codex\.app'/);
  // Exactly one launch strategy: no bundle-id launch that could target a stale
  // registration after a Contents swap.
  assert.doesNotMatch(script, /\/usr\/bin\/open -b/);
  assert.match(script, /tell application id "com\.openai\.codex" to activate/);
});

test("Codex reopen script opens in the background without activating when activation is off", () => {
  const script = codexReopenScript("/Applications/Codex.app", "com.openai.codex", 1000, false);

  assert.match(script, /Support\/lsregister -f '\/Applications\/Codex\.app'/);
  assert.match(script, /\/usr\/bin\/open -g '\/Applications\/Codex\.app'/);
  assert.doesNotMatch(script, /\/usr\/bin\/open -b/);
  assert.doesNotMatch(script, /to activate/);
});

test("App Management failures use the dedicated repair alert path", () => {
  assert.equal(
    isMacAppManagementError("macOS App Management is blocking modification of /Applications/Codex.app."),
    true,
  );
  assert.equal(isMacAppManagementError("Codex window services hook point not found"), false);
});

test("self-update release tags only download newer semver releases", () => {
  assert.equal(releaseVersionFromTag("v0.1.3"), "0.1.3");
  assert.equal(releaseVersionFromTag("0.1.3"), "0.1.3");
  assert.equal(releaseVersionFromTag("main"), null);
  assert.equal(shouldDownloadSelfUpdate("0.1.2", "v0.1.3"), true);
  assert.equal(shouldDownloadSelfUpdate("0.1.2", "v0.1.2"), false);
  assert.equal(shouldDownloadSelfUpdate("0.1.2", "v0.1.1"), false);
  assert.equal(shouldDownloadSelfUpdate("0.1.2", "main"), true);
  assert.equal(shouldDownloadSelfUpdate("0.1.2", "v0.1.2", true), true);
});

test("private release requests use GitHub authentication without requiring it for public repos", () => {
  assert.deepEqual(githubRequestHeaders(null), { "User-Agent": "tweakers-self-update" });
  assert.deepEqual(githubRequestHeaders("secret-token"), {
    "User-Agent": "tweakers-self-update",
    Authorization: "Bearer secret-token",
    Accept: "application/vnd.github+json",
  });
  assert.equal(isNoPublishedReleaseError(new Error("No published GitHub release found for example/repo")), true);
  assert.equal(isNoPublishedReleaseError(new Error("No published releases found for example/repo")), true);
  assert.equal(isNoPublishedReleaseError(new Error("Release check failed: 500 Server Error")), false);
});

test("self-update state persists human-readable diagnostics", () => {
  withTempDir((root) => {
    const file = join(root, "self-update-state.json");
    writeSelfUpdateState(file, {
      checkedAt: "2026-05-01T00:00:00.000Z",
      completedAt: "2026-05-01T00:00:01.000Z",
      status: "failed",
      currentVersion: "0.1.3",
      latestVersion: "0.1.4",
      targetRef: "v0.1.4",
      releaseUrl: "https://github.com/therealityreport/tweakers/releases/tag/v0.1.4",
      repo: "therealityreport/tweakers",
      channel: "stable",
      sourceRoot: root,
      error: "download failed",
    });

    const state = readSelfUpdateState(file);
    assert.equal(state?.status, "failed");
    assert.equal(state?.latestVersion, "0.1.4");
    assert.equal(state?.error, "download failed");
  });
});

test("watcher self-update checks stay hourly while repair can run more often", () => {
  withTempDir((root) => {
    const file = join(root, "self-update-state.json");
    const checkedAt = Date.parse("2026-05-01T00:00:00.000Z");
    writeSelfUpdateState(file, {
      checkedAt: new Date(checkedAt).toISOString(),
      completedAt: new Date(checkedAt + 1_000).toISOString(),
      status: "up-to-date",
      currentVersion: "0.1.4",
      latestVersion: "0.1.4",
      targetRef: "v0.1.4",
      releaseUrl: "https://github.com/therealityreport/tweakers/releases/tag/v0.1.4",
      repo: "therealityreport/tweakers",
      channel: "stable",
      sourceRoot: root,
    });

    assert.equal(shouldRunWatcherSelfUpdate(file, checkedAt + 5 * 60_000), false);
    assert.equal(shouldRunWatcherSelfUpdate(file, checkedAt + 60 * 60_000), true);
  });
});

test("watcher delegates the complete cycle to the receipt-owning command", () => {
  const script = watcherShellScript(undefined, "/tmp/Tweakers/managed-runtime/current/packages/installer/dist/cli.js");

  assert.match(script, /watcher-run/);
  assert.doesNotMatch(script, /update --watcher --quiet --no-repair/);
  assert.doesNotMatch(script, /repair --watcher --quiet/);
  assert.match(script, /managed-runtime\/current\/packages\/installer\/dist\/cli\.js/);
  assert.doesNotMatch(script, /Projects\/tweakers/);
});

test("managed runtime is atomically copied outside the development checkout", () => {
  withTempDir((root) => {
    const source = join(root, "repo");
    const userRoot = join(root, "user");
    mkdirSync(join(source, ".git"), { recursive: true });
    mkdirSync(join(source, "packages", "installer", "dist"), { recursive: true });
    mkdirSync(join(source, "packages", "sdk", "dist"), { recursive: true });
    writeFileSync(join(source, ".git", "config"), "private\n");
    writeFileSync(join(source, "local-notes.txt"), "do not copy\n");
    writeFileSync(join(source, "packages", "installer", "dist", "cli.js"), "v1\n");
    writeFileSync(join(source, "packages", "sdk", "package.json"), "{}\n");
    writeFileSync(join(source, "packages", "sdk", "dist", "index.js"), "export {};\n");

    const installed = installManagedRuntime(source, userRoot);

    assert.equal(installed, managedSourceRoot(userRoot));
    assert.equal(readFileSync(managedCliPath(userRoot), "utf8"), "v1\n");
    assert.equal(existsSync(join(installed, "packages", "sdk", "dist", "index.js")), true);
    assert.equal(existsSync(join(installed, ".git")), false);
    assert.equal(existsSync(join(installed, "local-notes.txt")), false);
    assert.equal(hasReleaseProvenance(installed, "v1.0.0"), false);
    writeReleaseProvenance(installed, "v1.0.0");
    assert.equal(hasReleaseProvenance(installed, "v1.0.0"), true);
  });
});

test("Windows watcher task names keep the current interval and documented legacy aliases", () => {
  assert.deepEqual(currentWindowsWatcherTaskNames(), [
    "tweaker-watcher",
    "tweaker-watcher-interval",
  ]);
  assert.deepEqual(legacyWindowsWatcherTaskNames(), [
    "tweaker-watcher-hourly",
    "tweaker-watcher-daily",
    "codex-plusplus-watcher",
    "codex-plusplus-watcher-interval",
    "codex-plusplus-watcher-hourly",
    "codex-plusplus-watcher-daily",
  ]);
});

test("watcher held branch never uses the helper-blind closed check (regression tripwire)", () => {
  const source = readFileSync(new URL("../src/commands/install.ts", import.meta.url), "utf8");

  // The old wait loop deadlocked on orphaned helpers ("background" status).
  // Behavior is covered in watcher-held.test.ts; this only pins the removal.
  assert.doesNotMatch(source, /getOpenReport\(locateCodex\(liveAppRoot\)\)\.status !== "closed"/);
  assert.match(source, /process\.env\.TWEAKER_WATCHER === "1"/);
  assert.match(source, /runHeldPromotion\(/);
  assert.match(source, /coordinatedQuit: false/);
});

test("launchd watcher script retains history and timestamps each run", () => {
  const script = watcherShellScript("/tmp/tweaker/watch'er.log");

  assert.match(script, /^touch '\/tmp\/tweaker\/watch'\\''er\.log'; sleep 3; /);
  assert.match(script, /Tweakers watcher start/);
  assert.doesNotMatch(script, /: >/);
  assert.match(script, /watcher-run/);
});

test("self-update marks the installed CLI executable on unix", () => {
  if (process.platform === "win32") return;

  withTempDir((root) => {
    const dist = join(root, "packages", "installer", "dist");
    mkdirSync(dist, { recursive: true });
    const cli = join(dist, "cli.js");
    writeFileSync(cli, "#!/usr/bin/env node\n", { mode: 0o644 });

    ensureCliExecutable(root);

    assert.equal(statSync(cli).mode & 0o111, 0o111);
  });
});

test("runtime drift detection hashes file contents and paths", () => {
  withTempDir((left) => withTempDir((right) => {
    writeFileSync(join(left, "runtime.js"), "one");
    writeFileSync(join(right, "runtime.js"), "one");
    assert.equal(hashDirectoryTree(left), hashDirectoryTree(right));
    writeFileSync(join(right, "runtime.js"), "two");
    assert.notEqual(hashDirectoryTree(left), hashDirectoryTree(right));
  }));
});

test("repair staging refreshes bundled tweak code without touching unrelated tweaks", () => {
  withTempDir((runtime) => withTempDir((installed) => {
    mkdirSync(join(runtime, "tweaks", "one"), { recursive: true });
    writeFileSync(join(runtime, "catalog.json"), JSON.stringify({ entries: [{ id: "co.example.one", source: { kind: "bundled", path: "tweaks/one" } }] }));
    writeFileSync(join(runtime, "tweaks", "one", "index.js"), "new");
    mkdirSync(join(installed, "one")); writeFileSync(join(installed, "one", "index.js"), "old");
    mkdirSync(join(installed, "co.example.one")); writeFileSync(join(installed, "co.example.one", "index.js"), "duplicate");
    mkdirSync(join(installed, "custom")); writeFileSync(join(installed, "custom", "index.js"), "keep");
    stageBundledTweaks(installed, runtime);
    assert.equal(readFileSync(join(installed, "one", "index.js"), "utf8"), "new");
    assert.equal(existsSync(join(installed, "co.example.one")), false);
    assert.equal(readFileSync(join(installed, "custom", "index.js"), "utf8"), "keep");
  }));
});

test("repair staging prunes superseded project-owned folders after a namespace change", () => {
  withTempDir((runtime) => withTempDir((installed) => {
    mkdirSync(join(runtime, "tweaks", "one"), { recursive: true });
    writeFileSync(join(runtime, "catalog.json"), JSON.stringify({ entries: [{ id: "co.tweakers.one", source: { kind: "bundled", path: "tweaks/one" } }] }));
    writeFileSync(join(runtime, "tweaks", "one", "index.js"), "new");

    mkdirSync(join(installed, "co.private.one"));
    writeFileSync(join(installed, "co.private.one", "manifest.json"), JSON.stringify({
      id: "co.private.one",
      githubRepo: "therealityreport/tweakers",
    }));
    mkdirSync(join(installed, "custom"));
    writeFileSync(join(installed, "custom", "manifest.json"), JSON.stringify({
      id: "com.example.custom",
      githubRepo: "example/custom",
    }));

    const logs: string[] = [];
    stageBundledTweaks(installed, runtime, { log: (message) => logs.push(message) });

    assert.equal(existsSync(join(installed, "co.private.one")), false);
    assert.equal(existsSync(join(installed, "custom")), true);
    assert.ok(logs.some((message) => message.includes("pruned superseded Tweakers folder")));
  }));
});

test("repair staging prunes retired bundled tweaks unless they are dev links", () => {
  withTempDir((runtime) => withTempDir((installed) => withTempDir((devRoot) => {
    mkdirSync(join(runtime, "tweaks", "one"), { recursive: true });
    writeFileSync(join(runtime, "catalog.json"), JSON.stringify({ entries: [{ id: "co.example.one", source: { kind: "bundled", path: "tweaks/one" } }] }));
    writeFileSync(join(runtime, "tweaks", "one", "index.js"), "new");
    // Stale staged copies of the retired mode-switcher tweak (both spellings)
    // left behind by an older install: without pruning they keep loading as a
    // second, non-functional App Mode control.
    mkdirSync(join(installed, "mode-switcher"));
    writeFileSync(join(installed, "mode-switcher", "index.js"), "retired");
    mkdirSync(join(installed, "co.tweakers.mode-switcher"));
    writeFileSync(join(installed, "co.tweakers.mode-switcher", "index.js"), "retired");
    mkdirSync(join(installed, "custom"));
    writeFileSync(join(installed, "custom", "index.js"), "keep");

    const logs: string[] = [];
    stageBundledTweaks(installed, runtime, { log: (m) => logs.push(m) });

    assert.equal(existsSync(join(installed, "mode-switcher")), false);
    assert.equal(existsSync(join(installed, "co.tweakers.mode-switcher")), false);
    assert.equal(readFileSync(join(installed, "custom", "index.js"), "utf8"), "keep");
    assert.ok(logs.some((m) => m.includes("pruned retired bundled tweak mode-switcher")));

    // A dev link into the configured source root is the developer's live
    // checkout — the retirement prune must leave it to dev-sync's sweep.
    mkdirSync(join(devRoot, "mode-switcher"), { recursive: true });
    writeFileSync(join(devRoot, "mode-switcher", "index.js"), "dev");
    symlinkSync(join(devRoot, "mode-switcher"), join(installed, "mode-switcher"), "dir");
    stageBundledTweaks(installed, runtime, { devTweaksRoot: devRoot });
    assert.ok(lstatSync(join(installed, "mode-switcher")).isSymbolicLink());
  })));
});

test("repair staging preserves validated legacy dev snapshot directories", () => {
  withTempDir((runtime) => withTempDir((installed) => {
    mkdirSync(join(runtime, "tweaks", "one"), { recursive: true });
    writeFileSync(join(runtime, "catalog.json"), JSON.stringify({ entries: [{ id: "co.example.one", source: { kind: "bundled", path: "tweaks/one" } }] }));
    writeFileSync(join(runtime, "tweaks", "one", "index.js"), "stale bundled");
    mkdirSync(join(installed, "one"));
    writeFileSync(join(installed, "one", "index.js"), "validated dev snapshot");
    writeFileSync(join(installed, [".codex", "pp-dev-snapshot.json"].join("")), JSON.stringify({ folders: ["one"] }));

    stageBundledTweaks(installed, runtime);

    assert.equal(readFileSync(join(installed, "one", "index.js"), "utf8"), "validated dev snapshot");
  }));
});

test("staging preserves dev symlinks into the configured source root only", () => {
  withTempDir((runtime) => withTempDir((installed) => withTempDir((devRoot) => {
    mkdirSync(join(runtime, "tweaks", "one"), { recursive: true });
    mkdirSync(join(runtime, "tweaks", "two"), { recursive: true });
    writeFileSync(join(runtime, "catalog.json"), JSON.stringify({ entries: [
      { id: "co.example.one", source: { kind: "bundled", path: "tweaks/one" } },
      { id: "co.example.two", source: { kind: "bundled", path: "tweaks/two" } },
    ] }));
    writeFileSync(join(runtime, "tweaks", "one", "index.js"), "bundled");
    writeFileSync(join(runtime, "tweaks", "two", "index.js"), "bundled");

    // Dev link into the configured root: must survive.
    mkdirSync(join(devRoot, "one"), { recursive: true });
    writeFileSync(join(devRoot, "one", "index.js"), "dev");
    symlinkSync(join(devRoot, "one"), join(installed, "one"), "dir");
    // Arbitrary symlink elsewhere: still replaced.
    mkdirSync(join(devRoot, "..", "unrelated"), { recursive: true });
    symlinkSync(join(devRoot, "..", "unrelated"), join(installed, "two"), "dir");

    const logs: string[] = [];
    stageBundledTweaks(installed, runtime, { devTweaksRoot: devRoot, log: (m) => logs.push(m) });

    assert.ok(lstatSync(join(installed, "one")).isSymbolicLink());
    assert.equal(readFileSync(join(installed, "one", "index.js"), "utf8"), "dev");
    assert.ok(logs.some((m) => m.includes("one")));
    assert.ok(!lstatSync(join(installed, "two")).isSymbolicLink());
    assert.equal(readFileSync(join(installed, "two", "index.js"), "utf8"), "bundled");
  })));
});

test("watcher repair reconciles dev tweaks in both intact and reinstall paths", () => {
  const source = readFileSync(new URL("../src/commands/repair.ts", import.meta.url), "utf8");

  assert.match(source, /cleanupStaleHelperGeneration\(codex\.appRoot, opts(?:, dependencies)?\);\s*\n\s*syncDevTweaks\(/);
  assert.match(source, /coordinatedQuit,\s*\n\s*reconcileCliShims: false,\s*\n\s*\}\);\s*\n\s*syncDevTweaks\(/);
  assert.match(source, /stageBundledTweaks\)\(paths\.tweaks, paths\.runtime, \{\s*\n\s*devTweaksRoot: readDevTweaksRoot\(paths\.configFile\)/);
});

test("self-update command failures include a bounded output tail", () => {
  const message = formatCommandFailure("/usr/bin/node", ["/tmp/tweaker/cli.js", "repair"], {
    status: 1,
    signal: null,
    stdout: "stdout detail",
    stderr: "nested repair error",
  });

  assert.match(message, /\/usr\/bin\/node \/tmp\/tweaker\/cli\.js repair failed with exit code 1/);
  assert.match(message, /stderr:\nnested repair error/);
  assert.match(message, /stdout:\nstdout detail/);
});

test("repair preserves stable signing unless ad-hoc was explicitly recorded", () => {
  const source = readFileSync(new URL("../src/commands/repair.ts", import.meta.url), "utf8");

  assert.match(source, /localSigning:\s*opts\.localSigning \?\? \(state\?\.signingMode !== "adhoc"\)/);
});

test("cli documents local signing and safe mode recovery", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

  assert.match(source, /\.option\("--local", "Use a stable local signing identity on macOS"\)/);
  assert.match(source, /localSigning:\s*resolveLocalSigning\(opts\)/);
  assert.match(source, /opts\.local === false \|\| opts\.localSigning === false \|\| opts\["local-signing"\] === false/);
  assert.match(source, /Leave safe mode with: tweaker safe-mode --off/);
  assert.match(source, /process\.argv\.length <= 2 \? \[\.\.\.process\.argv, "--help"\] : process\.argv/);
});

test("install uses local signing by default for promotable candidates", () => {
  const source = readFileSync(new URL("../src/commands/install.ts", import.meta.url), "utf8");

  assert.match(source, /let localSigning = opts\.localSigning !== false/);
  assert.match(source, /signingMode = opts\.localSigning === false \? "adhoc" : "local-identity"/);
});

test("install never silently falls back to an ad-hoc promotable candidate", () => {
  const source = readFileSync(new URL("../src/commands/install.ts", import.meta.url), "utf8");

  assert.match(source, /Tweakers Local Signing is required for promotable candidates/);
  assert.doesNotMatch(source, /falling back to ad-hoc signing/);
  assert.match(source, /Ad-hoc signing is allowed only with explicit --candidate-only and can never be promoted/);
});

test("installation source labels local checkouts", () => {
  withTempDir((root) => {
    mkdirSync(join(root, ".git"));
    assert.equal(describeInstallationSource(root).kind, "local-dev");
  });
  assert.equal(
    describeInstallationSource("/opt/homebrew/Cellar/tweaker/0.1.4").kind,
    "homebrew",
  );
});

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweaker-tweak-command-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweaker-tweak-command-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempEnvAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweaker-dev-env-"));
  const originalHome = process.env.TWEAKER_HOME;
  process.env.TWEAKER_HOME = root;
  try {
    await fn(root);
  } finally {
    if (originalHome === undefined) delete process.env.TWEAKER_HOME;
    else process.env.TWEAKER_HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  }
}

function withSilencedConsole(fn: () => void): void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function withSilencedConsoleAsync(fn: () => Promise<void>): Promise<void> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}
