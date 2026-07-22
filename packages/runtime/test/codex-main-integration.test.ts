import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const mainSource = readFileSync(resolve("packages/runtime/src/main.ts"), "utf8");
const loaderSource = readFileSync(resolve("packages/loader/loader.cjs"), "utf8");
const menuSource = readFileSync(resolve("packages/runtime/src/codex-desktop-update-menu.ts"), "utf8");

test("managed Codex lane is applied while the runtime is evaluated before OpenAI main", () => {
  const installParent = mainSource.indexOf("installCodexAppServerParent();");
  const apply = mainSource.indexOf("const codexCliBootstrap = applyManagedCodexCliLaneAtBootstrap(");
  const runtimeReady = mainSource.indexOf("installSparkleUpdateHook();");
  assert.ok(installParent >= 0, "missing signed Codex app-server parent bootstrap");
  assert.ok(apply >= 0, "missing synchronous managed-lane bootstrap");
  assert.ok(installParent < apply, "signed parent must be installed before other runtime bootstrap work");
  assert.ok(apply < runtimeReady, "managed lane must be applied during early runtime setup");

  const runtimeRequire = loaderSource.indexOf('require(path.join(runtimeDir, "main.js"))');
  const originalRequire = loaderSource.indexOf('require("./" + originalMain)');
  assert.ok(runtimeRequire >= 0 && runtimeRequire < originalRequire, "runtime must complete before OpenAI main loads");
});

test("Codex IPC exposes only the approved narrow action channels", () => {
  for (const channel of [
    "tweaker:get-codex-versions",
    "tweaker:refresh-codex-versions",
    "tweaker:install-codex-beta",
    "tweaker:rollback-codex-beta",
    "tweaker:set-codex-feature",
    "tweaker:check-codex-desktop-update",
    "tweaker:get-codex-desktop-update",
    "tweaker:start-codex-desktop-update",
    "tweaker:get-codex-desktop-update-transaction",
    "tweaker:resume-codex-desktop-update",
    "tweaker:cancel-codex-desktop-update",
    "tweaker:get-environment-status",
    "tweaker:choose-alpha-environment",
    "tweaker:get-environment-transaction",
    "tweaker:prepare-environment",
    "tweaker:commit-environment",
    "tweaker:rollback-environment",
    "tweaker:recover-environment",
    "tweaker:cancel-environment",
    "tweaker:get-tweaks-health",
  ]) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\(\"${channel}\"`));
  }
  assert.match(mainSource, /assertExactObjectKeys\(payload, \["lane", "name", "enabled"\]/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "install-codex-beta"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "get-codex-desktop-update"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "start-codex-desktop-update"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "get-codex-desktop-update-transaction"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "resume-codex-desktop-update"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "cancel-codex-desktop-update"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "get-environment-status"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "choose-alpha-environment"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "get-environment-transaction"\)/);
  assert.match(mainSource, /assertExactObjectKeys\(payload, \["appExperience", "releaseProfile"\]/);
  assert.match(mainSource, /assertExactObjectKeys\(payload, \["transactionId"\]/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("tweaker:set-codex-cli-lane"/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("tweaker:install-codex-desktop-update"/);
});

test("Tweaks health IPC compares stored catalog, runtime, and live tweak manifests", () => {
  const body = extractFunctionBody(mainSource, "buildTweakHealthSnapshot");
  assert.match(mainSource, /ipcMain\.handle\("tweaker:get-tweaks-health", \(\) => buildTweakHealthSnapshot\(\)\)/);
  assert.match(body, /readBundledTweakCatalog\(\)/);
  assert.match(body, /TWEAKS_DIR/);
  assert.match(body, /readRuntimeTweakVersion\(entry\)/);
  assert.match(body, /catalogVersion/);
  assert.match(body, /liveDriftCount/);
  assert.match(body, /runtimeDriftCount/);
  assert.match(body, /mcpRestartRequired/);
  assert.doesNotMatch(body, /fetchLatestRelease|startInstalledCli|spawn|exec/i);
});

test("renderer cannot supply a path, URL, tag, asset, or command to managed Codex actions", () => {
  for (const channel of [
    "tweaker:install-codex-beta",
    "tweaker:rollback-codex-beta",
    "tweaker:check-codex-desktop-update",
    "tweaker:get-codex-desktop-update",
    "tweaker:start-codex-desktop-update",
    "tweaker:get-codex-desktop-update-transaction",
    "tweaker:resume-codex-desktop-update",
    "tweaker:cancel-codex-desktop-update",
  ]) {
    const body = extractHandlerBody(mainSource, channel);
    assert.doesNotMatch(body, /payload|path|url|tag|asset|command/i, `${channel} accepts unsafe renderer input`);
  }
});

test("desktop Update and Reload delegates only to the durable installer transaction", () => {
  const body = extractHandlerBody(mainSource, "tweaker:start-codex-desktop-update");
  assert.match(body, /startCodexDesktopUpdateTransaction\(\)/);
  assert.doesNotMatch(body, /checkForUpdates|installUpdate|ditto|copy|rename|download|exec|spawn|shell/i);
  const starter = extractFunctionBody(mainSource, "startCodexDesktopUpdateTransaction");
  assert.match(starter, /startInstalledCli\(cli, \["update-chatgpt", "--json"\]\)/);
  assert.match(mainSource, /getCodexSparkleBridge\(\)\.wrapExports\(loaded\)/);
});

test("environment IPC stages fixed selections and submits only a validated durable transaction", () => {
  const status = extractHandlerBody(mainSource, "tweaker:get-environment-status");
  assert.match(status, /\["environment", "status", "--observe", "--json"\]/);
  const transaction = extractHandlerBody(mainSource, "tweaker:get-environment-transaction");
  assert.match(transaction, /\["environment", "transaction", "--json"\]/);

  const prepare = extractHandlerBody(mainSource, "tweaker:prepare-environment");
  assert.match(prepare, /assertEnvironmentRequest\(payload\)/);
  assert.match(prepare, /await buildDevelopmentEnvironmentControlPlane\(\)/);
  assert.match(prepare, /payload\.appExperience === "tweakers" && payload\.releaseProfile === "alpha"/);
  assert.match(prepare, /ensureManagedAlphaEnvironmentBackend\(\)/);
  assert.match(prepare, /"--app-experience",\s*payload\.appExperience/);
  assert.match(prepare, /"--release-profile",\s*payload\.releaseProfile/);
  assert.match(prepare, /ENVIRONMENT_PREPARE_TIMEOUT_MS/);
  assert.match(
    mainSource,
    /buildDevelopmentEnvironmentControlPlane[\s\S]*spawn\(command, \["run", "build"\][\s\S]*packages", "installer", "dist", "cli\.js"/,
  );

  const commit = extractHandlerBody(mainSource, "tweaker:commit-environment");
  assert.match(commit, /assertEnvironmentTransactionRequest\(payload\)/);
  assert.match(commit, /"submit"/);
  assert.match(commit, /"--transaction",\s*payload\.transactionId/);
  const cancel = extractHandlerBody(mainSource, "tweaker:cancel-environment");
  assert.match(cancel, /assertEnvironmentTransactionRequest\(payload\)/);
  assert.match(cancel, /"cancel"/);

  for (const body of [prepare, commit, cancel]) {
    assert.doesNotMatch(body, /payload\.(?:path|url|tag|asset|command|cli|receipt)/i);
  }
  assert.match(mainSource, /await codexCliManager\.installBeta\(\)/);
  assert.match(mainSource, /await codexCliManager\.validateCurrent\(\)/);
});

test("environment helper diagnostics stop treating a dead helper as in-flight forever", () => {
  assert.match(mainSource, /ENVIRONMENT_HELPER_STALE_MS = 60_000/);
  assert.match(mainSource, /Environment helper did not start/);
  assert.match(mainSource, /Environment helper stopped before reporting an outcome/);
});

test("native Alpha chooser owns the path and invokes strict registration", () => {
  const chooser = extractHandlerBody(mainSource, "tweaker:choose-alpha-environment");
  assert.match(chooser, /dialog\.showOpenDialog/);
  assert.match(chooser, /openDirectory/);
  assert.match(chooser, /environment",\s*"register-alpha"/);
  assert.match(chooser, /--app-path/);
  assert.doesNotMatch(chooser, /payload/);
});

test("menu and Config use the same safe desktop update service without raw native Sparkle", () => {
  const body = extractHandlerBody(mainSource, "tweaker:check-codex-desktop-update");
  assert.match(body, /codexDesktopUpdateService\.checkAndPresent\(\)/);
  assert.doesNotMatch(body, /checkForUpdates|checkForUpdatesInBackground|installUpdate/);
  assert.match(mainSource, /requestManualCheck: async \(\) =>/);
  assert.match(mainSource, /requestCodexDesktopManualCheck\("native-sparkle"\)/);
  assert.match(mainSource, /requestBackgroundCheck: runProactiveDesktopUpdateCheck/);
  assert.match(mainSource, /requestInstall: startCodexDesktopUpdateTransaction/);
  const retained = extractHandlerBody(mainSource, "tweaker:get-codex-desktop-update");
  assert.match(retained, /getSnapshot\(\)/);
  assert.doesNotMatch(retained, /publishCodexDesktopUpdateResult|checkSilently/);
  assert.match(mainSource, /tweaker:codex-desktop-update-changed/);
  assert.match(mainSource, /installCodexDesktopUpdateMenuReplay\(\)/);
  assert.match(mainSource, /Menu\.setApplicationMenu = function tweakerSetApplicationMenu/);
  assert.match(mainSource, /Menu\.buildFromTemplate\(template\)/);
  assert.match(mainSource, /syncCodexDesktopUpdateMenuBeforeAttach[\s\S]*Reflect\.apply\(setApplicationMenu/);
  assert.match(menuSource, /updateAvailable \? "Update Available…" : "Check for Updates…"/);
});

test("proactive desktop update checks are metadata-only, deduplicated, and excluded from health probes", () => {
  const checker = extractFunctionBody(mainSource, "runProactiveDesktopUpdateCheck");
  assert.match(checker, /codexDesktopUpdateService\.checkSilently\(\)/);
  assert.match(checker, /result\.status !== "update-available"/);
  assert.match(checker, /codexDesktopUpdateNotification/);
  assert.match(checker, /Notification\.isSupported\(\)/);
  assert.doesNotMatch(checker, /checkAndPresent|showMessageBox|startCodexDesktopUpdateTransaction/);

  const readyStart = mainSource.indexOf("app.whenReady().then(() => {");
  const readyEnd = mainSource.indexOf("app.on(\"will-quit\"", readyStart);
  assert.ok(readyStart >= 0 && readyEnd > readyStart, "missing app-ready bootstrap block");
  const ready = mainSource.slice(readyStart, readyEnd);
  assert.match(ready, /if \(healthCheckOnly\)[\s\S]*?else \{[\s\S]*?scheduleProactiveDesktopUpdateChecks\(\)/);
  assert.match(mainSource, /PROACTIVE_DESKTOP_UPDATE_INTERVAL_MS = 6 \* 60 \* 60 \* 1_000/);
});

test("health probes select the inert Sparkle contract while normal launches retain the managed update flow", () => {
  const configure = extractFunctionBody(mainSource, "configureCodexSparkleForProcess");
  const healthStart = configure.indexOf("if (healthCheckOnly)");
  const healthEnd = configure.indexOf("return;", healthStart);
  assert.ok(healthStart >= 0 && healthEnd > healthStart, "missing bounded health-only Sparkle branch");
  const health = configure.slice(healthStart, healthEnd);
  assert.match(health, /configureCodexSparkleBridge\(createHealthProbeCodexSparkleBridgeOptions\(\)\)/);
  assert.doesNotMatch(
    health,
    /requestCodexDesktopManualCheck|runProactiveDesktopUpdateCheck|startCodexDesktopUpdateTransaction|prepareSignedCodexForSparkleInstall|codexDesktopInstallPrerequisiteFailure|persistCapturedCodexDesktopProfileFeed|publishCodexDesktopUpdateResult|broadcastCodexDesktopUpdateResult|Notification\.|fetch\(/,
  );

  const normal = configure.slice(healthEnd + "return;".length);
  assert.match(normal, /requestCodexDesktopManualCheck\("native-sparkle"\)/);
  assert.match(normal, /requestBackgroundCheck: runProactiveDesktopUpdateCheck/);
  assert.match(normal, /requestInstall: startCodexDesktopUpdateTransaction/);
  assert.match(normal, /prepareForInstall: prepareSignedCodexForSparkleInstall/);
  assert.match(normal, /getInstallPrerequisite: codexDesktopInstallPrerequisiteFailure/);
  assert.match(normal, /onFeedCaptured: persistCapturedCodexDesktopProfileFeed/);
  assert.match(normal, /broadcastCodexDesktopUpdateResult\(published\)/);
  assert.match(mainSource, /configureCodexSparkleForProcess\(\);\s*installSparkleUpdateHook\(\);/);
});

test("startup desktop-update reconciliation is guarded, bounded, and uses the cutover launcher", () => {
  assert.match(mainSource, /createDesktopUpdateStartupReconciler\(\{/);
  assert.match(mainSource, /BrowserWindow\.getAllWindows\(\)\.some/);
  assert.match(
    mainSource,
    /startInstalledCli\(cli, \["update-chatgpt-reconcile", "--json"\]\)/,
  );
  const readyStart = mainSource.indexOf("app.whenReady().then(() => {");
  const readyEnd = mainSource.indexOf('app.on("will-quit"', readyStart);
  const ready = mainSource.slice(readyStart, readyEnd);
  assert.match(
    ready,
    /else \{[\s\S]*?scheduleProactiveDesktopUpdateChecks\(\);[\s\S]*?process\.platform === "darwin"[\s\S]*?desktopUpdateStartupReconciler\.schedule\(\)/,
  );
});

test("runtime owns one watched MCP reconciler with status and repair IPC", () => {
  assert.match(mainSource, /const mcpReconciler = healthCheckOnly \? null : createMcpReconciler\(\{/);
  assert.match(mainSource, /configPath: CODEX_CONFIG_FILE/);
  assert.match(mainSource, /reconcileNow\(mcpTrigger\)/);
  assert.match(mainSource, /ipcMain\.handle\("tweaker:get-mcp-sync-state"/);
  assert.match(mainSource, /ipcMain\.handle\("tweaker:repair-mcp"/);
  assert.match(mainSource, /mcpReconciler\?\.close\(\)/);
  assert.match(mainSource, /receipt\.conflicts\.map/);
  assert.match(mainSource, /conflict\.observedName.*conflict\.canonicalName.*conflict\.reason/s);
  assert.doesNotMatch(mainSource, /syncManagedMcpServers\(/);
});

test("candidate health probes cannot watch, reconcile, or repair the real MCP config", () => {
  assert.match(mainSource, /const mcpReconciler = healthCheckOnly \? null : createMcpReconciler\(\{/);
  assert.match(mainSource, /if \(mcpReconciler\) \{[\s\S]*?await mcpReconciler\.reconcileNow\(mcpTrigger\)/);
  assert.match(mainSource, /ipcMain\.handle\("tweaker:set-tweak-enabled", async[\s\S]*?setTweakEnabledAndReload/);
  assert.match(mainSource, /MCP repair is unavailable during a health-only probe/);
});

test("candidate health probes suppress Dock activation before app readiness", () => {
  const activation = mainSource.indexOf('app.setActivationPolicy("prohibited")');
  const ready = mainSource.indexOf("app.whenReady().then");
  assert.ok(activation >= 0 && activation < ready);
  assert.match(mainSource, /app\.dock\?\.hide\(\)/);
});

test("candidate health probes cannot register preload, start browser UI, or load main tweaks", () => {
  const readyStart = mainSource.indexOf("app.whenReady().then(() => {");
  const readyEnd = mainSource.indexOf('app.on("will-quit"', readyStart);
  assert.ok(readyStart >= 0 && readyEnd > readyStart, "missing app-ready bootstrap block");
  const ready = mainSource.slice(readyStart, readyEnd);
  assert.match(
    ready,
    /if \(!healthCheckOnly\) \{[\s\S]*?registerPreload\(session\.defaultSession[\s\S]*?maybeStartBrowserUiServer\(/,
  );

  assert.match(
    mainSource,
    /if \(!healthCheckOnly\) \{\s*app\.on\("session-created"[\s\S]*?registerPreload\(s, "session-created"\)/,
  );
  assert.match(
    mainSource,
    /if \(!healthCheckOnly\) \{\s*setImmediate\(\(\) => \{[\s\S]*?loadTweaksInitially\(tweakLifecycleDeps\)/,
  );

  const preload = extractFunctionBody(mainSource, "registerPreload");
  assert.match(preload, /^\s*if \(healthCheckOnly\) return;/);
  const mainTweaks = extractFunctionBody(mainSource, "loadAllMainTweaks");
  assert.match(mainTweaks, /^\s*if \(healthCheckOnly\) return;/);
});

test("runtime CLI probes cannot launch a second Electron app instance", () => {
  const localRuntimeStart = mainSource.indexOf("function localCliRuntime");
  const localRuntimeEnd = mainSource.indexOf("function localRefreshCli", localRuntimeStart);
  assert.ok(localRuntimeStart >= 0 && localRuntimeEnd > localRuntimeStart);
  const localRuntime = mainSource.slice(localRuntimeStart, localRuntimeEnd);
  const launchdLaunch = extractFunctionBody(mainSource, "startInstalledCliWithLaunchd");
  assert.match(mainSource, /function localCliRuntime[\s\S]*?resolveLocalCliRuntime\(\{/);
  assert.match(launchdLaunch, /localCliRuntime\(cli, args\)/);
  assert.match(launchdLaunch, /command: runtime\.command/);
  assert.match(launchdLaunch, /args: runtime\.args/);
  assert.doesNotMatch(launchdLaunch, /process\.execPath, cli/);
  assert.match(launchdLaunch, /ELECTRON_RUN_AS_NODE: "1"/);
  for (const exactRootVariable of [
    "TWEAKERS_HOME",
    "TWEAKER_HOME",
    "TWEAKERS_USER_ROOT",
    "TWEAKER_USER_ROOT",
  ]) {
    assert.match(localRuntime, new RegExp(`${exactRootVariable}: userRoot!`));
    assert.match(launchdLaunch, new RegExp(`${exactRootVariable}: userRoot!`));
  }
  assert.match(localRuntime, /\[LEGACY_USER_ROOT_ENV\]: userRoot!/);
  assert.match(launchdLaunch, /\[LEGACY_USER_ROOT_ENV\]: userRoot!/);
});

test("Sparkle update mode is committed only after the signed app restore", () => {
  const body = extractFunctionBody(mainSource, "prepareSignedCodexForSparkleInstall");
  const restore = body.indexOf("restorePristineCodexApp(");
  const marker = body.indexOf("writeFileSync(UPDATE_MODE_FILE");
  assert.ok(restore >= 0 && marker > restore, "update mode marker must follow successful signed restore");
  assert.match(mainSource, /execFileSync\("ditto"/);
  assert.match(body, /rmSync\(UPDATE_MODE_FILE, \{ force: true \}\)/);
});

test("appcast cache is version-keyed, bounded to 24 hours, and health probes cannot persist it", () => {
  assert.match(mainSource, /CODEX_APPCAST_CACHE_TTL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(mainSource, /codexAppcastCache\?: \{\s*schemaVersion: 1;\s*desktopVersion: string;/);
  const writer = extractFunctionBody(mainSource, "persistCodexAppcast");
  const healthGuard = writer.indexOf("if (healthCheckOnly) return;");
  const stateRead = writer.indexOf("const state = readState();");
  assert.ok(healthGuard >= 0, "health-only appcast persistence guard is missing");
  assert.ok(stateRead > healthGuard, "health-only guard must run before config state is read or written");
  assert.match(writer, /desktopVersion,/);
  assert.match(writer, /marketingVersion: metadata\.marketingVersion/);
  assert.match(writer, /build: metadata\.build/);
  assert.match(writer, /feedUrl,/);
  assert.match(writer, /writeState\(state\)/);
  assert.doesNotMatch(writer, /headers|authorization|token/i);
  const reader = extractFunctionBody(mainSource, "readPersistedCodexAppcast");
  assert.match(reader, /cache\.desktopVersion !== desktopVersion/);
  assert.match(reader, /CODEX_APPCAST_CACHE_TTL_MS/);
});

test("failed appcast refresh keeps safe last-known-good metadata stale", () => {
  const body = extractFunctionBody(mainSource, "getCodexVersionsSnapshot");
  assert.match(body, /persistedAppcast/);
  assert.match(body, /!refreshedAppcast\.error && !refreshedAppcast\.stale/);
  assert.match(body, /codexAppcastMetadataByIdentity\.get\(desktopAppcastMemoryKey\) \?\? persistedAppcast/);
  assert.match(body, /stale: true/);
});

test("desktop appcasts are isolated by verified release profile and Alpha never falls through to Stable", () => {
  const target = extractFunctionBody(mainSource, "selectedCodexDesktopUpdateTarget");
  assert.match(target, /verifiedCodexDesktopProfileIdentity\(registry, profile\)/);
  assert.match(target, /readCapturedCodexDesktopProfileFeed/);
  const refresh = extractFunctionBody(mainSource, "refreshCodexDesktopUpdateMetadata");
  assert.match(refresh, /target\.profile === "alpha"/);
  assert.match(refresh, /fetchProfileAppcastMetadata/);
  assert.match(refresh, /fetchAppcastMetadata\(\)/);
  assert.match(mainSource, /codexAppcastMetadataByIdentity/);
  assert.match(mainSource, /codexDesktopAppcastMemoryKey/);
  assert.match(mainSource, /onFeedCaptured: persistCapturedCodexDesktopProfileFeed/);
});

test("release-channel defaults remain Stable desktop, bundled CLI, and Stable Tweakers updates", () => {
  const target = extractFunctionBody(mainSource, "selectedCodexDesktopUpdateTarget");
  assert.match(target, /let profile: CodexDesktopUpdateTarget\["profile"\] = "stable"/);
  const selectedLane = extractFunctionBody(mainSource, "selectedCodexLane");
  assert.match(selectedLane, /codexCliBootstrap\.effectiveLane/);
  assert.match(mainSource, /updateChannel: s\.tweaker\?\.updateChannel \?\? "stable"/);
  const snapshot = extractFunctionBody(mainSource, "getCodexVersionsSnapshot");
  assert.match(snapshot, /restartRequired: false/);
  assert.doesNotMatch(mainSource, /codexLaneChangedThisProcess/);
});

test("Codex version snapshots report the exact measured active backend separately from lane releases", () => {
  const body = extractFunctionBody(mainSource, "getCodexVersionsSnapshot");
  assert.match(body, /activeCliPath = codexCliBootstrap\.binary \?\? bundledPath/);
  assert.match(body, /probeCli\(activeCliPath\)/);
  assert.match(body, /activeCli:\s*\{/);
  assert.match(body, /path: activeCliProbe\.path/);
  assert.match(body, /version: activeCliProbe\.version/);
  assert.match(body, /versionChannel: codexVersionChannel\(activeCliProbe\.version\)/);
  assert.match(body, /source: activeCliSource/);
  assert.match(body, /resolveTerminalCodexBinary/);
  assert.match(body, /loginShellPath: terminalCodexFromLoginShell\(\)/);
  const loginShellProbe = extractFunctionBody(mainSource, "terminalCodexFromLoginShell");
  assert.match(loginShellProbe, /spawnSync\(shellPath, \["-lic", "command -v codex"\]/);
  assert.match(loginShellProbe, /timeout: 5_000/);
  assert.match(body, /terminalCli:\s*\{/);
  assert.match(body, /version: terminalProbe\?\.version \?\? null/);
  assert.match(body, /Math\.min\(\.\.\.lookupCheckedAt\)/);
  assert.match(body, /managedAlphaVersion = managerState\.current\?\.version \?\? betaProbe\?\.version/);
  assert.match(body, /versionChannel: codexVersionChannel\(managedAlphaVersion\)/);
});

function extractHandlerBody(source: string, channel: string): string {
  const markerIndex = source.indexOf(`"${channel}"`);
  assert.notEqual(markerIndex, -1, `missing IPC handler: ${channel}`);
  const arrowIndex = source.indexOf("=>", markerIndex);
  return extractBlock(source, source.indexOf("{", arrowIndex));
}

function extractFunctionBody(source: string, name: string): string {
  const markerIndex = source.indexOf(`function ${name}`);
  assert.notEqual(markerIndex, -1, `missing function: ${name}`);
  return extractBlock(source, source.indexOf("{", markerIndex));
}

function extractBlock(source: string, openingBrace: number): string {
  assert.notEqual(openingBrace, -1, "missing opening brace");
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  assert.fail("missing closing brace");
}
