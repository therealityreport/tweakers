import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const repoRoot = process.cwd();
const runtimeSource = readFileSync(resolve(repoRoot, "packages/runtime/src/main.ts"), "utf8");
const lifecycleSource = readFileSync(
  resolve(repoRoot, "packages/runtime/src/tweak-lifecycle.ts"),
  "utf8",
);
const bundledRuntime = readFileSync(
  resolve(repoRoot, "packages/installer/assets/runtime/main.js"),
  "utf8",
);

const fullReloadSequence = [
  "stopAllMainTweaks",
  "clearTweakModuleCache",
  "loadAllMainTweaks",
  "broadcastReload",
];

test("source toggle handler returns the serialized lifecycle reload", () => {
  const body = extractHandlerBody(runtimeSource, "tweaker:set-tweak-enabled");

  assert.match(body, /setTweakEnabledAndReload\(id,\s*enabled,\s*tweakLifecycleDeps\)/);
  assert.doesNotMatch(body, /mcpReconciler\?\.request/);
  assert.match(body, /return setTweakEnabledAndReload/);
});

test("bundled toggle handler returns the serialized lifecycle reload", () => {
  const body = extractHandlerBody(bundledRuntime, "tweaker:set-tweak-enabled");

  assert.match(body, /setTweakEnabledAndReload\(id,\s*enabled,\s*tweakLifecycleDeps\)/);
  assert.doesNotMatch(body, /mcpReconciler\?\.request/);
  assert.match(body, /return setTweakEnabledAndReload/);
});

test("source lifecycle helper normalizes enabled value before persisting", () => {
  const body = extractFunctionBody(lifecycleSource, "setTweakEnabledAndReload");

  assert.match(body, /const normalizedEnabled = !!enabled/);
  assert.match(body, /setTweakEnabled\(id,\s*normalizedEnabled\)/);
  assert.match(body, /enabled=\$\{normalizedEnabled\}/);
});

test("bundled lifecycle helper normalizes enabled value before persisting", () => {
  const body = extractFunctionBody(bundledRuntime, "setTweakEnabledAndReload");

  assert.match(body, /const normalizedEnabled = !!enabled/);
  assert.match(body, /setTweakEnabled\(id,\s*normalizedEnabled\)/);
  assert.match(body, /enabled=\$\{normalizedEnabled\}/);
});

test("source lifecycle helper returns only after reloading", () => {
  const body = extractFunctionBody(lifecycleSource, "setTweakEnabledAndReload");

  assertCallOrder(body, ["reloadTweaks", "return true"]);
  assert.match(body, /await reloadTweaks/);
});

test("bundled lifecycle helper returns only after reloading", () => {
  const body = extractFunctionBody(bundledRuntime, "setTweakEnabledAndReload");

  assertCallOrder(body, ["reloadTweaks", "return true"]);
  assert.match(body, /await reloadTweaks/);
});

test("source manual force reload delegates to lifecycle helper", () => {
  const body = extractHandlerBody(runtimeSource, "tweaker:reload-tweaks");

  assertCallOrder(body, ["reloadTweaks", "return "]);
  assert.match(body, /await reloadTweaks/);
});

test("bundled manual force reload delegates to lifecycle helper", () => {
  const body = extractHandlerBody(bundledRuntime, "tweaker:reload-tweaks");

  assertCallOrder(body, ["reloadTweaks", "return "]);
  assert.match(body, /await reloadTweaks/);
});

test("source lifecycle reload helper uses the full main reload sequence", () => {
  const body = extractFunctionBody(lifecycleSource, "reloadTweaks");

  assertCallOrder(body, fullReloadSequence);
});

test("bundled lifecycle reload helper uses the full main reload sequence", () => {
  const body = extractFunctionBody(bundledRuntime, "reloadTweaks");

  assertCallOrder(body, fullReloadSequence);
});

test("source filesystem watcher reload delegates to lifecycle helper", () => {
  const body = extractFunctionBody(runtimeSource, "scheduleReload");

  assertCallOrder(body, ["reloadTweaks"]);
});

test("source filesystem watcher defers reload while a dev snapshot is publishing", () => {
  assert.match(runtimeSource, /if \(devPublicationInProgress\(\)\) return/);
  assert.match(runtimeSource, /statSync\(DEV_PUBLISH_LOCK\)\.mtimeMs/);
});

test("source runtime exposes refresh status and starts the detached refresh CLI", () => {
  assert.match(runtimeSource, /ipcMain\.handle\("tweaker:get-refresh-status"/);
  assert.match(runtimeSource, /ipcMain\.handle\("tweaker:start-local-refresh"/);
  assert.match(runtimeSource, /startLocalRefresh\(requested\)/);
  assert.match(runtimeSource, /startInstalledCli\(dispatch\.cli, \["refresh-local", \.\.\.dispatch\.args\.slice\(1\)\]\)/);
  assert.match(runtimeSource, /tweaker:refresh-status-changed/);
  assert.match(runtimeSource, /chokidar\.watch\(\[/);
  assert.match(runtimeSource, /resolveLocalCliRuntime\(\{/);
  assert.match(runtimeSource, /localCliRuntime\(cli, \["refresh-status"\]\)/);
});

test("source refresh binding never resolves a promotion CLI from persisted development registration", () => {
  const cli = extractFunctionBody(runtimeSource, "localRefreshCli");
  const binding = extractFunctionBody(runtimeSource, "resolveLocalRefreshSourceBinding");

  assert.match(cli, /LOCAL_REFRESH_SOURCE_BINDING\.cli/);
  assert.doesNotMatch(cli, /developmentSourceRoot|readState\(/);
  assert.match(binding, /readInstallerState\(\)\?\.sourceRoot/);
  assert.match(binding, /realpathSync\(frozenRoot\)/);
  assert.match(binding, /developmentRoot: exactRoot/);
});

test("registered dirty primary is disabled when it differs from the frozen runtime source", () => {
  const normalize = extractFunctionBody(runtimeSource, "normalizeLocalRefreshStatus");

  assert.match(normalize, /status\.developmentSourceRoot !== frozenRoot/);
  assert.match(normalize, /available: false/);
  assert.match(normalize, /source: "current"/);
  assert.match(normalize, /Unsafe refresh source/);
  assert.doesNotMatch(normalize, /writeState|developmentSourceRoot\s*=/);
});

test("verified development refresh preserves the exact CLI, root, and argv through dispatch", () => {
  const dispatch = extractFunctionBody(runtimeSource, "buildLocalRefreshDispatch");
  const start = extractFunctionBody(runtimeSource, "startLocalRefresh");

  assert.match(dispatch, /status\.developmentSourceRoot !== developmentRoot/);
  assert.match(dispatch, /cli: binding\.cli/);
  assert.match(
    dispatch,
    /"refresh-local",\s*"--source", "development",\s*"--development-root", developmentRoot,\s*"--app", appRoot/s,
  );
  assert.match(start, /buildLocalRefreshDispatch\(status, requested, appRoot\)/);
  assert.match(start, /dispatch\.args\[0\] !== "refresh-local"/);
  assert.match(start, /startInstalledCli\(dispatch\.cli, \["refresh-local", \.\.\.dispatch\.args\.slice\(1\)\]\)/);
});

test("refresh dispatch rejects a dirty primary and carries the exact frozen root at runtime", () => {
  const start = runtimeSource.indexOf("function buildLocalRefreshDispatch");
  const end = runtimeSource.indexOf("async function startLocalRefresh", start);
  assert.ok(start >= 0 && end > start, "missing refresh dispatch source");
  const compiled = ts.transpileModule(
    `${runtimeSource.slice(start, end)}\n(globalThis as any).__dispatch = buildLocalRefreshDispatch;`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const frozenRoot = "/isolated/t11/tweakers";
  const cli = `${frozenRoot}/packages/installer/dist/cli.js`;
  const sandbox: Record<string, unknown> = {
    LOCAL_REFRESH_SOURCE_BINDING: { cli, developmentRoot: frozenRoot, unsafeReason: null },
  };
  runInNewContext(compiled, sandbox);
  const dispatch = sandbox.__dispatch as (
    status: Record<string, unknown>,
    requested: string,
    appRoot: string,
  ) => { cli: string; args: string[] };
  const base = {
    available: true,
    source: "development",
    phase: "idle",
    detail: "Development checkout has unapplied runtime changes",
    error: null,
    checkedAt: "2026-07-21T00:00:00.000Z",
  };

  assert.throws(() => dispatch({
    ...base,
    developmentSourceRoot: "/Users/example/Projects/tweakers",
  }, "smart", "/Applications/ChatGPT.app"), /not frozen to this runtime/);

  const result = JSON.parse(JSON.stringify(dispatch({
    ...base,
    developmentSourceRoot: frozenRoot,
  }, "smart", "/Applications/ChatGPT.app"))) as { cli: string; args: string[] };
  assert.deepEqual(result, {
    cli,
    args: [
      "refresh-local",
      "--source", "development",
      "--development-root", frozenRoot,
      "--app", "/Applications/ChatGPT.app",
    ],
  });
});

test("bundled filesystem watcher reload delegates to lifecycle helper", () => {
  const body = extractFunctionBody(bundledRuntime, "scheduleReload");

  assertCallOrder(body, ["reloadTweaks"]);
});

function extractHandlerBody(source: string, channel: string): string {
  const marker = `"${channel}"`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing IPC handler marker: ${channel}`);

  const arrowIndex = source.indexOf("=>", markerIndex);
  assert.notEqual(arrowIndex, -1, `missing IPC handler arrow: ${channel}`);

  return extractBlockStartingAt(source, source.indexOf("{", arrowIndex));
}

function extractFunctionBody(source: string, name: string): string {
  const marker = `function ${name}`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing function: ${name}`);

  return extractBlockStartingAt(source, source.indexOf("{", markerIndex));
}

function extractBlockStartingAt(source: string, startBrace: number): string {
  assert.notEqual(startBrace, -1, "missing opening brace");

  let depth = 0;
  for (let i = startBrace; i < source.length; i++) {
    const char = source[i];
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth === 0) return source.slice(startBrace + 1, i);
  }

  assert.fail("missing closing brace");
}

function assertCallOrder(body: string, calls: string[]): void {
  let previous = -1;
  for (const call of calls) {
    const needle = call.startsWith("return ") ? call : `${call}(`;
    const current = body.indexOf(needle);
    assert.notEqual(current, -1, `missing ${call}`);
    assert.ok(current > previous, `${call} is out of order`);
    previous = current;
  }
}
