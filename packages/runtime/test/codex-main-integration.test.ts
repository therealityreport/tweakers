import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const mainSource = readFileSync(resolve("packages/runtime/src/main.ts"), "utf8");
const loaderSource = readFileSync(resolve("packages/loader/loader.cjs"), "utf8");

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
    "codexpp:get-codex-versions",
    "codexpp:refresh-codex-versions",
    "codexpp:set-codex-cli-lane",
    "codexpp:install-codex-beta",
    "codexpp:rollback-codex-beta",
    "codexpp:set-codex-feature",
    "codexpp:check-codex-desktop-update",
    "codexpp:install-codex-desktop-update",
  ]) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\(\"${channel}\"`));
  }
  assert.match(mainSource, /assertExactObjectKeys\(payload, \["lane", "confirmOverride"\]/);
  assert.match(mainSource, /assertExactObjectKeys\(payload, \["lane", "name", "enabled"\]/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "install-codex-beta"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "install-codex-desktop-update"\)/);
});

test("renderer cannot supply a path, URL, tag, asset, or command to managed Codex actions", () => {
  for (const channel of [
    "codexpp:install-codex-beta",
    "codexpp:rollback-codex-beta",
    "codexpp:check-codex-desktop-update",
    "codexpp:install-codex-desktop-update",
  ]) {
    const body = extractHandlerBody(mainSource, channel);
    assert.doesNotMatch(body, /payload|path|url|tag|asset|command/i, `${channel} accepts unsafe renderer input`);
  }
});

test("desktop install delegates only to the native Sparkle bridge", () => {
  const body = extractHandlerBody(mainSource, "codexpp:install-codex-desktop-update");
  assert.match(body, /getCodexSparkleBridge\(\)\.installUpdate\(\)/);
  assert.doesNotMatch(body, /ditto|copy|rename|download|exec|spawn|shell/i);
  assert.match(mainSource, /getCodexSparkleBridge\(\)\.wrapExports\(loaded\)/);
});

test("desktop update checks refresh appcast metadata without calling raw native Sparkle", () => {
  const body = extractHandlerBody(mainSource, "codexpp:check-codex-desktop-update");
  assert.match(body, /getCodexVersionsSnapshot\(true\)/);
  assert.doesNotMatch(body, /checkForUpdates|checkForUpdatesInBackground|installUpdate/);
});

test("candidate health probes suppress Dock activation before app readiness", () => {
  const activation = mainSource.indexOf('app.setActivationPolicy("prohibited")');
  const ready = mainSource.indexOf("app.whenReady().then");
  assert.ok(activation >= 0 && activation < ready);
  assert.match(mainSource, /app\.dock\?\.hide\(\)/);
});

test("runtime CLI probes cannot launch a second Electron app instance", () => {
  const launchdLaunch = extractFunctionBody(mainSource, "startInstalledCliWithLaunchd");
  assert.match(mainSource, /function localCliRuntime[\s\S]*?process\.resourcesPath, "cua_node"/);
  assert.match(mainSource, /function localCliRuntime[\s\S]*?ELECTRON_RUN_AS_NODE: "1"/);
  assert.match(launchdLaunch, /localCliRuntime\(cli, args\)/);
  assert.match(launchdLaunch, /runtime\.command, \.\.\.runtime\.args/);
  assert.doesNotMatch(launchdLaunch, /process\.execPath, cli/);
  assert.match(launchdLaunch, /ELECTRON_RUN_AS_NODE=1/);
});

test("Sparkle update mode is committed only after the signed app restore", () => {
  const body = extractFunctionBody(mainSource, "prepareSignedCodexForSparkleInstall");
  const restore = body.indexOf("restorePristineCodexApp(");
  const marker = body.indexOf("writeFileSync(UPDATE_MODE_FILE");
  assert.ok(restore >= 0 && marker > restore, "update mode marker must follow successful signed restore");
  assert.match(mainSource, /execFileSync\("ditto"/);
  assert.match(body, /rmSync\(UPDATE_MODE_FILE, \{ force: true \}\)/);
});

test("appcast cache is version-keyed, bounded to 24 hours, and never persists headers", () => {
  assert.match(mainSource, /CODEX_APPCAST_CACHE_TTL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(mainSource, /codexAppcastCache\?: \{\s*schemaVersion: 1;\s*desktopVersion: string;/);
  const writer = extractFunctionBody(mainSource, "persistCodexAppcast");
  assert.match(writer, /desktopVersion,/);
  assert.match(writer, /marketingVersion: metadata\.marketingVersion/);
  assert.match(writer, /build: metadata\.build/);
  assert.match(writer, /feedUrl,/);
  assert.doesNotMatch(writer, /headers|authorization|token/i);
  const reader = extractFunctionBody(mainSource, "readPersistedCodexAppcast");
  assert.match(reader, /cache\.desktopVersion !== desktopVersion/);
  assert.match(reader, /CODEX_APPCAST_CACHE_TTL_MS/);
});

test("failed appcast refresh keeps safe last-known-good metadata stale", () => {
  const body = extractFunctionBody(mainSource, "getCodexVersionsSnapshot");
  assert.match(body, /persistedAppcast/);
  assert.match(body, /!refreshedAppcast\.error && !refreshedAppcast\.stale/);
  assert.match(body, /codexAppcastMetadata \?\? persistedAppcast/);
  assert.match(body, /stale: true/);
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
