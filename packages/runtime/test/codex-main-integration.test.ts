import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const mainSource = readFileSync(resolve("packages/runtime/src/main.ts"), "utf8");
const loaderSource = readFileSync(resolve("packages/loader/loader.cjs"), "utf8");
const installSource = readFileSync(resolve("packages/installer/src/commands/install.ts"), "utf8");
const createVariantSource = readFileSync(resolve("packages/installer/src/commands/create-variant.ts"), "utf8");
const mcpReconciliationSource = readFileSync(resolve("packages/runtime/src/mcp-reconciliation.ts"), "utf8");

test("managed Codex lane is applied while the runtime is evaluated before OpenAI main", () => {
  const installParent = mainSource.indexOf("const codexAppServerParent = installCodexAppServerParent({");
  const apply = mainSource.indexOf("const codexCliBootstrap = applyManagedCodexCliLaneAtBootstrap(");
  const runtimeReady = mainSource.indexOf("installSparkleUpdateHook();");
  assert.ok(installParent >= 0, "missing signed Codex app-server parent bootstrap");
  assert.ok(apply >= 0, "missing synchronous managed-lane bootstrap");
  assert.ok(installParent < apply, "signed parent must be installed before other runtime bootstrap work");
  assert.ok(apply < runtimeReady, "managed lane must be applied during early runtime setup");

  const runtimeRequire = loaderSource.indexOf('require(path.join(runtimeDir, "main.js"))');
  const originalRequire = loaderSource.indexOf('require("./" + originalMain)');
  assert.ok(runtimeRequire >= 0 && runtimeRequire < originalRequire, "runtime must complete before OpenAI main loads");
  const nativeUserData = loaderSource.indexOf("process.env.CODEX_ELECTRON_USER_DATA_PATH = appUserDataRoot");
  assert.ok(
    nativeUserData >= 0 && nativeUserData < originalRequire,
    "derived userData must bind OpenAI's early bootstrap before its single-instance lock",
  );

  const brokerMetadata = loaderSource.indexOf("const accountsBrokerRoot = typeof meta.accountsBrokerRoot");
  const brokerBinding = loaderSource.indexOf("process.env.TWEAKERS_ACCOUNTS_BROKER_ROOT = accountsBrokerRoot");
  assert.ok(brokerMetadata >= 0, "loader must read the sealed manager-global broker root");
  assert.ok(
    brokerBinding > brokerMetadata && brokerBinding < runtimeRequire,
    "loader must bind the manager-global broker before runtime startup",
  );
  assert.match(installSource, /defaultTweakersAccountsBrokerRoot\(targetUserHome\(\)\)/);
  assert.match(installSource, /\{ accountsBrokerRoot \}/);
});

test("independent bootstrap publishes v5 readiness only after exact broker authority, Actual Size, and current-process live health", () => {
  assert.match(mainSource, /assertTweakersVariantBootstrap\(\{ fileSystem: originalFs/);
  assert.match(mainSource, /const RUNTIME_READY_EXPECTATION_FILE = join\(userRoot, "runtime-ready-expectation\.json"\)/);
  assert.match(mainSource, /const INDEPENDENT_TWEAKERS_LIVE_HEALTH_FILE = join\(userRoot, "independent-live-health\.json"\)/);
  assert.match(mainSource, /record\.schemaVersion === 5/);
  assert.match(mainSource, /record\.promotionId/);
  assert.match(mainSource, /record\.activePromotionReceiptSha256/);
  assert.match(mainSource, /kind: "tweakers-independent-runtime-ready-expectation"/);
  assert.match(mainSource, /kind: "tweakers-independent-runtime-ready"/);
  assert.match(mainSource, /brokerAuthorityExpectation: RuntimeReadyBrokerAuthorityExpectation/);
  assert.match(mainSource, /appearanceExpectation: RuntimeReadyAppearanceBinding/);
  assert.match(mainSource, /globalRootState: "absent" \| "valid-v3"/);
  assert.match(mainSource, /configSha256: string \| null/);
  assert.match(mainSource, /currentRuntimeReadyBrokerAuthorityExpectation/);
  assert.match(mainSource, /readRouterLaunchSelection\(configPath\)/);
  assert.match(mainSource, /createHash\("sha256"\)\.update\(bytesAfter\)\.digest\("hex"\)/);
  assert.match(mainSource, /globalRootState: "absent", configSha256: null/);
  assert.match(mainSource, /Array\.isArray\(record\.expectedTweakIds\)/);
  assert.match(mainSource, /processStartToken,/);
  assert.match(mainSource, /settingsMounted: true/);
  assert.match(mainSource, /sharedHistoryBrokerState: runtimeReadyBrokerState/);
  assert.match(mainSource, /runtimeReadyBrokerState === null \|\| runtimeReadyBrokerState !== expectedBrokerState/);
  assert.match(mainSource, /ipcMain\.on\("tweaker:settings-mounted"/);
  assert.match(mainSource, /isExactIndependentTweakersPrimaryMainFrame\(event\.sender, event\.senderFrame\)/);
  assert.match(mainSource, /publishIndependentTweakersRuntimeReadyReceipt\(RUNTIME_READY_FILE, receipt\)/);
  const publisher = extractFunctionBody(mainSource, "tryWriteRuntimeReadyReceipt");
  assert.doesNotMatch(publisher, /rmSync\(RUNTIME_READY_EXPECTATION_FILE|unlinkSync\(RUNTIME_READY_EXPECTATION_FILE/);
  assert.match(publisher, /sameRuntimeReadyBrokerAuthorityExpectation/);
  assert.match(publisher, /expectedRuntimeReadyBrokerState/);
  assert.match(publisher, /requestRuntimeReadyBrokerConnection/);
  assert.match(publisher, /scheduleIndependentTweakersLiveHealthCapture/);
  assert.match(publisher, /brokerAuthorityExpectation: brokerAuthority/);
  assert.match(publisher, /schemaVersion: 5/);
  assert.match(publisher, /runtimeReadyAppearanceBinding\(independentTweakersLiveHealth\.appearance\)/);
  assert.match(publisher, /independentTweakersLiveHealth\.appearance\.windowId !== primary\.id/);
  assert.match(publisher, /sameRuntimeReadyAppearanceBinding\(appearance, expectation\.appearanceExpectation\)/);
  assert.match(publisher, /primaryIndependentTweakersNativeZoomAtActualSize\(primary\)/);
  assert.match(publisher, /appearance,/);
  assert.match(
    createVariantSource,
    /verifyIndependentTweakersRuntimeReadyReceipt\([\s\S]*?assertIndependentTweakersRuntimeReadyExpectationAt\([\s\S]*?removeIndependentTweakersRuntimeReadyExpectation\(/,
    "the manager must authenticate the unchanged expectation before it removes the challenge",
  );
  const initializedTweaks = extractFunctionBody(mainSource, "runtimeReadyInitializedTweakIds");
  assert.match(initializedTweaks, /lifecycleRecordKey\("renderer", id\)/);
  assert.match(initializedTweaks, /mainRecord\?\.attemptId === lifecycleAttemptId/);
  assert.match(initializedTweaks, /rendererRecord\?\.attemptId === lifecycleAttemptId/);
  assert.doesNotMatch(mainSource, /runtimeReadyRendererTweakIds/);

  const lifecycleHealth = extractFunctionBody(mainSource, "exactLifecycleHealth");
  assert.match(lifecycleHealth, /record\?\.attemptId === lifecycleAttemptId \? record\.status : undefined/);
  assert.match(lifecycleHealth, /if \(status === "ready"\) continue/);

  const authority = extractFunctionBody(mainSource, "currentRuntimeReadyBrokerAuthorityExpectation");
  assert.match(authority, /lstatSync\(accountsBrokerRoot\)/);
  assert.match(authority, /rootBefore\.isDirectory\(\) \|\| rootBefore\.isSymbolicLink\(\)/);
  assert.match(authority, /rootBefore\.uid !== ownerUid/);
  assert.match(authority, /\(rootBefore\.mode & 0o077\) !== 0/);
  assert.match(authority, /configBefore = lstatSync\(configPath\)/);
  assert.match(authority, /configBefore\.isFile\(\) \|\| configBefore\.isSymbolicLink\(\)/);
  assert.match(authority, /configBefore\.nlink !== 1/);
  assert.match(authority, /configBefore\.uid !== ownerUid/);
  assert.match(authority, /\(configBefore\.mode & 0o077\) !== 0/);
  assert.match(authority, /rootBefore\.dev !== rootAfter\.dev \|\| rootBefore\.ino !== rootAfter\.ino/);
  assert.match(authority, /bytesBefore\.equals\(bytesAfter\)/);
  assert.match(authority, /error as NodeJS\.ErrnoException \| null\)\?\.code === "ENOENT"/);
  assert.equal((authority.match(/globalRootState: "absent"/g) ?? []).length, 1, "only a missing broker root is absent");
  assert.equal((mainSource.match(/runtime-ready expectation is unavailable/g) ?? []).length, 1, "expectation failure logs once");

  const health = extractFunctionBody(mainSource, "captureIndependentTweakersLiveHealth");
  assert.match(health, /kind: "tweakers-independent-live-health"/);
  assert.match(health, /pid: process\.pid/);
  assert.match(health, /processStartToken,/);
  assert.match(health, /appSignatureSha256/);
  assert.match(health, /accountsBrokerConfigSha256: brokerAuthority\.configSha256/);
  assert.match(health, /exactLifecycleHealth\(\)/);
  assert.match(health, /appearance: \{ status: "not_observed", normalized: false, windowId: null, before: null, after: null \}/);
  const beforeWrite = health.indexOf("publishIndependentTweakersLiveHealth({\n    ...provisional,");
  const reset = health.indexOf("primary.webContents.setZoomLevel(0)");
  const afterWrite = health.lastIndexOf("publishIndependentTweakersLiveHealth({\n    ...provisional,");
  assert.ok(beforeWrite >= 0 && reset > beforeWrite && afterWrite > reset, "health must persist before and after any native zoom normalization");
  assert.match(health, /primary\.webContents\.setZoomLevel\(0\)/);
  assert.match(health, /primary\.webContents\.setZoomFactor\(1\)/);
  assert.match(health, /nativeZoomNeedsNormalization\(before\)/);
  assert.match(health, /independentTweakersZoomNormalized/);
  assert.match(health, /const normalized = nativeZoomObservedAtActualSize\(after\)/);
  assert.match(health, /independentTweakersZoomNormalized = normalized/);
  assert.doesNotMatch(health, /getFocusedWindow|BrowserWindow\.getAllWindows\(\)\.find/);

  const appearanceGate = extractFunctionBody(mainSource, "primaryIndependentTweakersNativeZoomAtActualSize");
  assert.match(appearanceGate, /getZoomLevel/);
  assert.match(appearanceGate, /getZoomFactor/);
  assert.match(appearanceGate, /nativeZoomNeedsNormalization/);

  const lifecycleHandlerStart = mainSource.indexOf('ipcMain.on("tweaker:tweak-lifecycle"');
  const lifecycleHandler = mainSource.slice(
    lifecycleHandlerStart,
    mainSource.indexOf('ipcMain.on("tweaker:settings-mounted"', lifecycleHandlerStart),
  );
  assert.ok(lifecycleHandlerStart >= 0, "renderer lifecycle handler is missing");
  assert.match(lifecycleHandler, /derivedVariant && !isExactIndependentTweakersPrimaryMainFrame\(event\.sender, event\.senderFrame\)/);
  assert.ok(
    lifecycleHandler.indexOf("recordTweakLifecycle") < lifecycleHandler.indexOf("tryWriteRuntimeReadyReceipt"),
    "current lifecycle state must be recorded before readiness is evaluated",
  );
  const settingsMountedHandlerStart = mainSource.indexOf('ipcMain.on("tweaker:settings-mounted"');
  const settingsMountedHandler = mainSource.slice(
    settingsMountedHandlerStart,
    mainSource.indexOf('ipcMain.handle("tweaker:get-tweak-lifecycle"', settingsMountedHandlerStart),
  );
  assert.ok(settingsMountedHandlerStart >= 0, "settings-mounted handler is missing");
  assert.match(settingsMountedHandler, /isExactIndependentTweakersPrimaryMainFrame\(event\.sender, event\.senderFrame\)/);

  const exactPrimary = extractFunctionBody(mainSource, "exactIndependentTweakersPrimaryWindow");
  assert.match(exactPrimary, /isExactIndependentTweakersProcess\(\)/);
  assert.match(exactPrimary, /services\?\.getPrimaryWindow/);
  assert.match(exactPrimary, /windowManager\?\.getPrimaryWindow/);
  assert.doesNotMatch(exactPrimary, /getFocusedWindow|\.find\(/);
  const exactProcess = extractFunctionBody(mainSource, "isExactIndependentTweakersProcess");
  assert.match(exactProcess, /INDEPENDENT_TWEAKERS_APP_ROOT/);
  assert.match(exactProcess, /INDEPENDENT_TWEAKERS_BUNDLE_ID/);

  const metrics = extractFunctionBody(mainSource, "readIndependentTweakersAppearanceMetrics");
  for (const key of [
    "electronZoomLevel",
    "electronZoomFactor",
    "cssWindowZoom",
    "rootZoom",
    "bodyZoom",
    "rootFontSizePx",
    "bodyFontSizePx",
    "visualViewportScale",
    "devicePixelRatio",
    "displayScaleFactor",
    "bounds",
  ]) assert.match(metrics, new RegExp(key));
  assert.match(metrics, /--codex-window-zoom/);

  const liveHealthPublisher = extractFunctionBody(mainSource, "publishIndependentTweakersLiveHealth");
  assert.match(liveHealthPublisher, /publishIndependentTweakersRuntimeReadyReceipt\(INDEPENDENT_TWEAKERS_LIVE_HEALTH_FILE, health\)/);
  assert.match(liveHealthPublisher, /tweaker:independent-live-health-changed/);
  assert.match(liveHealthPublisher, /primary\.webContents\.mainFrame\.send/);
  assert.match(liveHealthPublisher, /independentTweakersLiveHealthProjection\(health\)/);
  assert.doesNotMatch(liveHealthPublisher, /webContents\.send\(/);

  const healthProjection = extractFunctionBody(mainSource, "independentTweakersLiveHealthProjection");
  assert.match(healthProjection, /appearance: health\.appearance/);
  assert.match(healthProjection, /observedAt: health\.observedAt/);
  assert.doesNotMatch(healthProjection, /appRoot|appAsar|appSignature|runtimeFingerprint|accountsBroker|processStartToken|initializedTweakIds|lifecycleFailures/);
  const healthHandler = extractHandlerBody(mainSource, "tweaker:get-independent-live-health");
  assert.match(healthHandler, /isExactIndependentTweakersPrimaryMainFrame\(event\.sender, event\.senderFrame\)/);
  assert.match(healthHandler, /independentTweakersLiveHealthProjection\(independentTweakersLiveHealth\)/);
  assert.doesNotMatch(healthHandler, /return independentTweakersLiveHealth;/);

  const brokerProbe = extractFunctionBody(mainSource, "requestRuntimeReadyBrokerConnection");
  assert.equal((brokerProbe.match(/requestId:/g) ?? []).length, 1, "broker proof has one non-replayed request ID");
});

test("stale prior-run lifecycle records cannot satisfy current runtime readiness", () => {
  const body = extractFunctionBody(mainSource, "runtimeReadyInitializedTweakIds");
  const compiled = transpileModule(`
    function lifecycleRecordKey(processKind, id) { return processKind + ":" + id; }
    function runtimeReadyInitializedTweakIds() {${body}}
    return runtimeReadyInitializedTweakIds;
  `, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  const readIds = new Function(
    "runtimeReadyMainInitialized",
    "runtimeReadyPreloadInitialized",
    "tweakState",
    "isTweakEnabled",
    "lifecycleJournal",
    "lifecycleAttemptId",
    compiled,
  ) as (
    runtimeReadyMainInitialized: boolean,
    runtimeReadyPreloadInitialized: boolean,
    tweakState: { discovered: Array<{ manifest: { id: string; scope: "renderer" } }> },
    isTweakEnabled: (id: string) => boolean,
    lifecycleJournal: { records: Record<string, { status: "ready"; attemptId: string }> },
    lifecycleAttemptId: string,
  ) => () => string[] | null;
  const expectedTweakIds = Array.from({ length: 11 }, (_, index) => `co.test.tweak-${index}`);
  const tweakState = {
    discovered: expectedTweakIds.map((id) => ({ manifest: { id, scope: "renderer" as const } })),
  };
  const enabled = () => true;
  const staleRecords = Object.fromEntries(expectedTweakIds.map((id) => [
    `renderer:${id}`,
    { status: "ready" as const, attemptId: "prior-run" },
  ]));
  const currentRecords = Object.fromEntries(expectedTweakIds.map((id) => [
    `renderer:${id}`,
    { status: "ready" as const, attemptId: "current-run" },
  ]));
  assert.deepEqual(
    readIds(true, true, tweakState, enabled, { records: staleRecords }, "current-run")(),
    null,
  );
  assert.deepEqual(
    readIds(true, true, tweakState, enabled, { records: currentRecords }, "current-run")(),
    [...expectedTweakIds].sort((left, right) => left.localeCompare(right)),
  );
});

test("reserved shared-history target mapping stays sender-bound and returns only public handles", () => {
  const channel = "tweaker:shared-history-map-native-target";
  assert.match(mainSource, new RegExp(`const SHARED_HISTORY_MAP_NATIVE_TARGET_CHANNEL = "${channel}"`));
  const handlerStart = mainSource.indexOf("ipcMain.handle(SHARED_HISTORY_MAP_NATIVE_TARGET_CHANNEL");
  const handler = mainSource.slice(handlerStart, mainSource.indexOf("ipcMain.on(\"tweaker:tweak-lifecycle\"", handlerStart));
  assert.ok(handlerStart >= 0, "reserved shared-history target IPC handler is missing");
  assert.match(handler, /ownedCodexRenderer\(event\.sender\.id\)/);
  assert.match(handler, /sender !== event\.sender/);
  assert.match(handler, /sharedHistoryTargetUnavailable\(\)/);
  assert.match(handler, /mapSharedHistoryNativeTarget\(sender\.id, payload\)/);

  const mapper = extractFunctionBody(mainSource, "mapSharedHistoryNativeTarget");
  assert.match(mapper, /parseSharedHistoryNativeTargetRequest/);
  assert.match(mapper, /accountsBrokerClientForRenderer/);
  assert.match(mapper, /adapter\.mapBoundNativeTargets/);
  assert.match(mapper, /publicSharedHistoryTargetResponse/);
  assert.doesNotMatch(mapper, /invokeAccountsBroker|BrokerCommandV1|console\.|log\(/);

  const parser = extractFunctionBody(mainSource, "parseSharedHistoryNativeTargetRequest");
  assert.match(parser, /SHARED_HISTORY_MAX_NATIVE_TARGET_IDS/);
  assert.match(parser, /new Set\(value\.assistantTurnNativeIds\)/);
  assert.match(parser, /isBoundedNativeTargetId/);

  const response = extractFunctionBody(mainSource, "publicSharedHistoryTargetResponse");
  assert.match(response, /isPublicSharedHistoryConversationId/);
  assert.match(response, /isPublicSharedHistoryTurnId/);
  assert.match(response, /\["conversationId", "status", "turnIds", "version"\]/);
  assert.match(response, /return \{ version: 1, status: "mapped", conversationId: value\.conversationId, turnIds \}/);
  assert.doesNotMatch(response, /nativeTurnId|value\.turns/);
});

test("accounts broker clients keep a renderer-private peer binding and clean up only their own lease", () => {
  const factory = extractFunctionBody(mainSource, "accountsBrokerClientForRenderer");
  assert.match(factory, /const renderer = ownedCodexRenderer\(webContentsId\)/);
  assert.match(factory, /const rendererRef = createOpaqueRendererRef\(accountsBrokerSecret, webContentsId, binding\)/);
  assert.match(factory, /rendererRef,\n\s*appToolsRef/);
  assert.match(factory, /new AccountsBrokerRendererAdapterV1\(\{ secret: accountsBrokerSecret, client: socket, rendererRef \}\)/);
  assert.match(factory, /replaceAccountsBrokerClient\(webContentsId, client\)/);
  assert.match(factory, /renderer\.once\("destroyed", \(\) => disposeAccountsBrokerClient\(webContentsId, client\)\)/);

  const replace = extractFunctionBody(mainSource, "replaceAccountsBrokerClient");
  assert.match(replace, /accountsBrokerClients\.set\(webContentsId, client\)/);
  assert.match(replace, /previous && previous !== client/);
  assert.match(replace, /closeAccountsBrokerClient\(previous\)/);

  const dispose = extractFunctionBody(mainSource, "disposeAccountsBrokerClient");
  assert.match(dispose, /expected && client !== expected/);
  assert.match(dispose, /accountsBrokerClients\.delete\(webContentsId\)/);
  assert.match(dispose, /closeAccountsBrokerClient\(client\)/);
});

test("MCP OAuth is consumed by the bound main process and never returned to a tweak or renderer", () => {
  // These functions deliberately use typed object parameters. `extractFunctionBody`
  // finds the first type-literal brace in that signature, so slice their exact
  // source sections instead of accidentally asserting against parameter types.
  const invokerStart = mainSource.indexOf("async function invokeAccountsBroker");
  const handoffStart = mainSource.indexOf("async function consumeMcpOAuthAuthorizationHandoff");
  const validatorStart = mainSource.indexOf("function validatedMcpOAuthAuthorizationHandoff");
  const safeUrlStart = mainSource.indexOf("function isHostSafeOAuthUrl");
  const handoffEnd = mainSource.indexOf("\nfunction isMcpOAuthAuthorizationRequest", handoffStart);
  const validatorEnd = mainSource.indexOf("\nfunction isHostSafeOAuthUrl", validatorStart);
  const safeUrlEnd = mainSource.indexOf("\nfunction isMainRecord", safeUrlStart);
  assert.ok(invokerStart >= 0 && handoffStart > invokerStart, "missing broker invoker or OAuth handoff");
  assert.ok(handoffEnd > handoffStart && validatorEnd > validatorStart && safeUrlEnd > safeUrlStart, "missing OAuth validation boundaries");
  const invoker = mainSource.slice(invokerStart, handoffStart);
  assert.match(invoker, /isMcpOAuthAuthorizationRequest\(envelope\)/);
  assert.match(invoker, /accountsBrokerInvocationContexts\.get\(input\)/);
  assert.match(invoker, /consumeMcpOAuthAuthorizationHandoff\(invocation, envelope, client, response\)/);

  const handoff = mainSource.slice(handoffStart, handoffEnd);
  assert.match(handoff, /validatedMcpOAuthAuthorizationHandoff\(envelope, response\)/);
  assert.match(handoff, /isCurrentAccountsBrokerRendererInvocation\(input, client\)/);
  assert.match(handoff, /await shell\.openExternal\(handoff\.oauthUrl\)/);
  assert.ok(handoff.indexOf("if (!handoff)") < handoff.indexOf("await shell.openExternal"), "missing or unsafe handoffs must fail before opening a browser");
  assert.ok(handoff.indexOf("isCurrentAccountsBrokerRendererInvocation") < handoff.indexOf("await shell.openExternal"), "a stale renderer response must fail before opening a browser");
  assert.match(handoff, /result: \{ accountId: handoff\.accountId, connections: \[handoff\.connection\] \}/);

  const validator = mainSource.slice(validatorStart, validatorEnd);
  assert.match(validator, /result\.accountId !== params\.accountId/);
  assert.match(validator, /connection\.connectionId !== params\.connectionId/);
  assert.match(validator, /connection\.surface !== "mcp"/);
  assert.match(validator, /isHostSafeOAuthUrl\(result\.oauthUrl\)/);
  const safeUrl = mainSource.slice(safeUrlStart, safeUrlEnd);
  assert.match(safeUrl, /url\.protocol !== "https:"/);
  assert.match(safeUrl, /access_\?token/);
});

test("Accounts IPC distinguishes missing setup from service outages only for an owned renderer", async () => {
  const start = mainSource.indexOf("async function invokeAccountsBroker");
  const end = mainSource.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start);
  const compiled = transpileModule(mainSource.slice(start, end + 2), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  const request = { version: 1, requestId: "accounts-profile", command: "profile.read" };
  for (const scenario of [
    { mode: "blocked", owned: true, setup: "setup-required", connected: false, expected: "broker_setup_required", retryable: false },
    { mode: "blocked", owned: true, setup: "unavailable", connected: false, expected: "broker_unavailable", retryable: true },
    { mode: "legacy", owned: true, setup: "setup-required", connected: false, expected: "broker_unavailable", retryable: true },
    { mode: "blocked", owned: false, setup: "setup-required", connected: false, expected: "broker_unavailable", retryable: true },
    { mode: "global-v3", owned: true, setup: "registered", connected: true, expected: "broker_unavailable", retryable: true },
  ]) {
    let inspectedSetup = false;
    const bindings = {
      accountsBrokerClientForRenderer: () => scenario.connected ? { adapter: { invoke: async () => { throw new Error("socket unavailable"); } } } : null,
      markRuntimeReadyBrokerState: () => {},
      accountsAuthorityMode: scenario.mode,
      ownedCodexRenderer: () => scenario.owned ? {} : null,
      readAccountsBrokerSetupState: () => { inspectedSetup = true; return scenario.setup; },
      accountsBrokerRoot: "/private/fixture-account-root",
      accountsBrokerRequestId: () => request.requestId,
    };
    const invoke = new Function(...Object.keys(bindings), `${compiled}\nreturn invokeAccountsBroker;`)(...Object.values(bindings));
    const response = await invoke({ webContentsId: 19 }, request);
    assert.deepEqual(response, {
      version: 1, requestId: request.requestId, ok: false,
      error: { code: scenario.expected, retryable: scenario.retryable },
    });
    assert.doesNotMatch(JSON.stringify(response), /private|fixture-account-root|socket/);
    if (!scenario.owned || scenario.mode === "legacy") assert.equal(inspectedSetup, false);
  }
});

test("OAuth document binding rejects a same-WebContents navigation before its provider response", () => {
  const start = mainSource.indexOf("function isSameAccountsBrokerDocument");
  const end = mainSource.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "missing testable OAuth document comparison");
  const source = mainSource.slice(start, end + 2);
  const compiled = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  const isSameDocument = new Function(`${compiled}\nreturn isSameAccountsBrokerDocument;`)() as (
    input: { webContentsId: number; mainFrame: object; documentUrl: string; navigationEpoch: number },
    current: { webContentsId: number; mainFrame: object; documentUrl: string; navigationEpoch: number } | null,
  ) => boolean;
  const originalFrame = {};
  const invocation = { webContentsId: 91, mainFrame: originalFrame, documentUrl: "https://chatgpt.com/", navigationEpoch: 7 };
  assert.equal(isSameDocument(invocation, { ...invocation }), true);
  assert.equal(
    isSameDocument(invocation, { ...invocation, navigationEpoch: 8 }),
    false,
    "did-start-navigation must suppress an OAuth response before a same-WebContents reload commits",
  );
  assert.equal(isSameDocument(invocation, { ...invocation, mainFrame: {} }), false);
  assert.equal(isSameDocument(invocation, { ...invocation, documentUrl: "https://chatgpt.com/new" }), false);
});

test("Accounts authority is projected by main before renderer IPC and blocks broker access outside global-v3", () => {
  assert.match(mainSource, /const accountsAuthorityMode = resolveAccountsAuthorityMode\(\{[\s\S]*?brokerRootConfigured: accountsBrokerRootConfigured/);
  assert.match(mainSource, /const accountsBrokerRootResolution = resolveAccountsBrokerRootResolution\(\{ userRoot, derivedVariant \}\)/);
  assert.match(mainSource, /const accountsBrokerRoot = accountsBrokerRootResolution\.root/);
  assert.match(mainSource, /const accountsBrokerRootConfigured = accountsBrokerRootResolution\.configured/);

  const parentStart = mainSource.indexOf("const codexAppServerParent = installCodexAppServerParent({");
  const parentEnd = mainSource.indexOf("\n});\n\n// Renderer identities", parentStart);
  const parentBootstrap = mainSource.slice(parentStart, parentEnd);
  assert.ok(parentStart >= 0 && parentEnd > parentStart, "missing app-server parent bootstrap");
  assert.match(parentBootstrap, /brokerRootConfigured: accountsBrokerRootConfigured/);

  const factory = extractFunctionBody(mainSource, "accountsBrokerClientForRenderer");
  assert.match(factory, /accountsAuthorityMode !== "global-v3"/);
  assert.match(factory, /!accountsBrokerRoot \|\| !accountsBrokerSecret \|\| !renderer/);

  const apiStart = mainSource.indexOf("function makeCodexApi");
  const apiEnd = mainSource.indexOf("    native:", apiStart);
  const accountsApi = mainSource.slice(apiStart, apiEnd);
  assert.match(accountsApi, /authorityMode: \(\) => accountsAuthorityMode/);
  assert.doesNotMatch(accountsApi, /brokerRoot|configPath|secret/i);
});

test("Codex IPC exposes only the approved narrow action channels", () => {
  for (const channel of [
    "tweaker:get-codex-versions",
    "tweaker:refresh-codex-versions",
    "tweaker:install-codex-beta",
    "tweaker:rollback-codex-beta",
    "tweaker:set-codex-feature",
    "tweaker:reapply-tweakers",
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
  assert.match(mainSource, /assertNoIpcArguments\(args, "get-environment-status"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "choose-alpha-environment"\)/);
  assert.match(mainSource, /assertNoIpcArguments\(args, "get-environment-transaction"\)/);
  assert.match(mainSource, /assertExactObjectKeys\(payload, \["appExperience", "releaseProfile"\]/);
  assert.match(mainSource, /assertExactObjectKeys\(payload, \["transactionId"\]/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("tweaker:set-codex-cli-lane"/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("tweaker:install-codex-desktop-update"/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("tweaker:(?:check|get|start|resume|cancel)-codex-desktop-update/);
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
  ]) {
    const body = extractHandlerBody(mainSource, channel);
    assert.doesNotMatch(body, /payload|path|url|tag|asset|command/i, `${channel} accepts unsafe renderer input`);
  }
});

test("derived Tweakers mode blocks generic mutation while preserving only refresh actions", () => {
  assert.match(mainSource, /const derivedVariant = !desktopUpdateStartupEnabled\(process\.env,/);
  assert.match(mainSource, /bundleIdentifier: runningAppRoot \? readBundleIdentifier\(runningAppRoot\) : null/);
  const blockedHandlers = [
    "tweaker:install-codex-beta",
    "tweaker:rollback-codex-beta",
    "tweaker:get-environment-status",
    "tweaker:choose-alpha-environment",
    "tweaker:get-environment-transaction",
    "tweaker:prepare-environment",
    "tweaker:commit-environment",
    "tweaker:cancel-environment",
    "tweaker:rollback-environment",
    "tweaker:recover-environment",
    "tweaker:run-tweaker-update",
    "tweaker:repair-auto-maintenance",
    "tweaker:repair-mcp",
  ];
  for (const channel of blockedHandlers) {
    const body = extractHandlerBody(mainSource, channel);
    assert.match(body, /derivedVariant/);
    assert.match(body, /derivedVariant(?:ActionBlocked|DesktopUpdateResult|TweakerUpdateCheck|LocalRefreshStatus)/i);
  }
  const reapply = extractHandlerBody(mainSource, "tweaker:reapply-tweakers");
  assert.match(reapply, /"refresh\.independent"/);
  assert.match(reapply, /"refresh\.injected"/);
  assert.match(reapply, /readTweakersManagerStatus\(\)/);
  assert.match(reapply, /readTweakersManagerOfficialSourceRegistration\(\)/);
  assert.match(reapply, /startTweakersManagerOfficialSourceRegistration\(\)/);
  assert.match(reapply, /registrationRequired: true/);
  assert.match(reapply, /nextAction: "refresh\.independent"/);
  assert.match(reapply, /blocked: true/);
  assert.doesNotMatch(reapply, /startTweakersManagerAction\("official-source\.register"\)/);
  assert.match(reapply, /does not invoke ChatGPT's native updater/);
  assert.doesNotMatch(reapply, /desktop-update|checkForUpdates|installUpdate|download|ditto|exec\(|spawn\(|shell/i);
  assert.match(
    extractHandlerBody(mainSource, "tweaker:refresh-codex-versions"),
    /if \(derivedVariant\) return getCodexVersionsSnapshot\(false\)/,
  );

  const refreshStatus = extractFunctionBody(mainSource, "localRefreshStatus");
  assert.match(refreshStatus, /if \(derivedVariant\) return/);
  assertCallOrder(refreshStatus, ["derivedVariant", "probeLocalRefreshStatus"]);
  const starter = extractFunctionBody(mainSource, "startLocalRefresh");
  assertCallOrder(starter, ["derivedVariant", "localRefreshStatus"]);
  const launcher = extractFunctionBody(mainSource, "startInstalledCli");
  assertCallOrder(launcher, ["derivedVariant", "startInstalledCliWithLaunchd"]);
  const jsonRunner = extractFunctionBody(mainSource, "runInstalledCliJson");
  assertCallOrder(jsonRunner, ["derivedVariant", "localRefreshStatus"]);
  assert.match(mainSource, /function startInstalledCliWithLaunchd[\s\S]*?if \(derivedVariant\) return false/);
  const appcastWriter = extractFunctionBody(mainSource, "persistCodexAppcast");
  assert.match(appcastWriter, /if \(healthCheckOnly \|\| derivedVariant\) return/);
});

test("independent Settings read only manager state and never fall back to legacy environment or maintenance lanes", () => {
  const commitPending = extractFunctionBody(mainSource, "independentRuntimeReadyCommitPending");
  assert.match(commitPending, /derivedVariant/);
  assert.match(commitPending, /readRuntimeReadyExpectation\(\) !== null/);

  const startupDeferral = extractFunctionBody(mainSource, "independentManagerStatusDeferredForRuntimeReady");
  assert.match(startupDeferral, /!runtimeReadyPublished/);
  assert.match(startupDeferral, /independentRuntimeReadyCommitPending\(\)/);

  const tweakList = extractHandlerBody(mainSource, "tweaker:list-tweaks");
  assert.match(tweakList, /if \(!independentRuntimeReadyCommitPending\(\)\)/);
  assertCallOrder(tweakList, ["independentRuntimeReadyCommitPending", "ensureTweakUpdateCheck"]);

  const managerStatus = extractFunctionBody(mainSource, "independentManagerStatusProjection");
  assert.match(managerStatus, /if \(!derivedVariant\)/);
  assert.match(managerStatus, /readTweakersManagerStatus\(\)/);
  assert.match(managerStatus, /INDEPENDENT_MANAGER_STARTUP_REASON/);
  assertCallOrder(managerStatus, ["independentManagerStatusDeferredForRuntimeReady", "readTweakersManagerStatus"]);
  assert.match(managerStatus, /read-only until manager authority is restored/);
  assert.doesNotMatch(managerStatus, /runInstalledCliJson|startInstalledCli|spawn|watcher|refresh-variant/i);

  const statusHandler = extractHandlerBody(mainSource, "tweaker:get-independent-manager-status");
  assert.match(statusHandler, /assertNoIpcArguments/);
  assert.match(statusHandler, /independentManagerStatusProjection\(\)/);

  for (const channel of [
    "tweaker:get-environment-status",
    "tweaker:get-environment-transaction",
    "tweaker:get-watcher-health",
    "tweaker:check-tweaker-update",
    "tweaker:run-tweaker-update",
    "tweaker:repair-auto-maintenance",
  ]) {
    const body = extractHandlerBody(mainSource, channel);
    assert.match(body, /derivedVariant/);
  }
  const environment = extractHandlerBody(mainSource, "tweaker:get-environment-status");
  assertCallOrder(environment, ["derivedVariant", "runInstalledCliJson"]);
  const watcher = extractHandlerBody(mainSource, "tweaker:get-watcher-health");
  assertCallOrder(watcher, ["derivedVariant", "getAndPublishWatcherHealth"]);
  const selfUpdate = extractHandlerBody(mainSource, "tweaker:run-tweaker-update");
  assertCallOrder(selfUpdate, ["derivedVariant", "startInstalledCli"]);
  const target = extractFunctionBody(mainSource, "selectedCodexDesktopUpdateTarget");
  assert.match(target, /INDEPENDENT_MANAGER_STARTUP_REASON/);
  assertCallOrder(target, ["independentManagerStatusDeferredForRuntimeReady", "readTweakersManagerStatus"]);

  assert.doesNotMatch(mainSource, /use refresh-variant/);
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
  assert.match(commit, /assertEnvironmentCommitRequest\(payload\)/);
  assert.match(commit, /"submit"/);
  assert.match(commit, /"--transaction",\s*payload\.transactionId/);
  assert.match(commit, /"--approval-at",\s*payload\.approvalAt/);
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

test("Manager IPC uses the independent sender guard and an exact section allowlist", () => {
  const managerOpen = extractHandlerBody(mainSource, "tweaker:manager-open");
  const doctorOpen = extractHandlerBody(mainSource, "tweaker:doctor-open");
  assert.match(managerOpen, /assertNoIpcArguments\(args, "manager-open"\)/);
  assert.match(managerOpen, /isExactIndependentTweakersPrimaryMainFrame\(event\.sender, event\.senderFrame\)/);
  assert.match(managerOpen, /section === undefined \? "overview" : section/);
  assert.match(managerOpen, /isTweakersManagerSection\(selectedSection\)/);
  assert.match(managerOpen, /openTweakersManager\(selectedSection\)/);
  assert.match(doctorOpen, /openTweakersDoctor\(\)/);
});

test("official ChatGPT owns native Sparkle while health and independent processes use only the inert wrapper", () => {
  const configure = extractFunctionBody(mainSource, "configureCodexSparkleForProcess");
  assert.match(configure, /if \(healthCheckOnly\) \{[\s\S]*?configureCodexSparkleBridge\(createHealthProbeCodexSparkleBridgeOptions\(\)\)/);
  assert.match(configure, /else if \(derivedVariant\)/);
  assert.match(configure, /requestManualCheck: \(\) => \{ const report = readTweakersDoctor\(\); runTweakersDoctorAction\(\{ schemaVersion: 1, action: "scan", fingerprint: report\.fingerprint \}\); openTweakersManager\("updates"\); \}/);
  assert.match(configure, /onUpdateAvailable: \(\) => \{ try \{ const report = readTweakersDoctor\(\); runTweakersDoctorAction\(\{ schemaVersion: 1, action: "scan", scanTrigger: "available_update", fingerprint: report\.fingerprint \}\); \}/);
  assert.match(configure, /requestInstall: \(\) => openTweakersManager\("updates"\)/);
  assert.doesNotMatch(configure, /requestBackgroundCheck|prepareForInstall|onFeedCaptured/);
  const hook = extractFunctionBody(mainSource, "installSparkleUpdateHook");
  assert.match(hook, /!healthCheckOnly && !derivedVariant/);
  assert.match(hook, /getCodexSparkleBridge\(\)\.wrapExports\(loaded\)/);
  assert.doesNotMatch(mainSource, /Menu\.setApplicationMenu = function tweakerSetApplicationMenu/);
  assert.doesNotMatch(mainSource, /createDesktopUpdateStartupReconciler|update-chatgpt-reconcile|update-chatgpt(?:-resume|-cancel)?/);
  assert.doesNotMatch(mainSource, /tweaker:(?:check|get|start|resume|cancel)-codex-desktop-update/);
  assert.doesNotMatch(mainSource, /prepareSignedCodexForSparkleInstall|restorePristineCodexApp|SIGNED_CODEX_BACKUP|UPDATE_MODE_FILE/);
  assert.doesNotMatch(mainSource, /execFileSync\("ditto"|execFileSync\("\/bin\/cp"/);
  assert.match(mainSource, /configureCodexSparkleForProcess\(\);\s*if \(healthCheckOnly \|\| derivedVariant\) installSparkleUpdateHook\(\);/);
});

test("runtime owns one watched MCP reconciler with status and repair IPC", () => {
  assert.match(mainSource, /const mcpReconciler = healthCheckOnly \|\| derivedVariant \? null : createMcpReconciler\(\{/);
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
  assert.match(mainSource, /const mcpReconciler = healthCheckOnly \|\| derivedVariant \? null : createMcpReconciler\(\{/);
  assert.match(mainSource, /if \(mcpReconciler\) \{[\s\S]*?await mcpReconciler\.reconcileNow\(mcpTrigger\)/);
  assert.match(mainSource, /ipcMain\.handle\("tweaker:set-tweak-enabled", async[\s\S]*?setTweakEnabledAndReload/);
  assert.match(mainSource, /MCP repair is unavailable during a health-only probe/);
});

test("normal derived launches select their isolated Codex home without starting an MCP writer", () => {
  assert.match(mcpReconciliationSource, /MCP_DERIVED_VARIANT_ENV = "TWEAKERS_DERIVED_VARIANT"/);
  assert.match(
    mcpReconciliationSource,
    /env\[MCP_DERIVED_VARIANT_ENV\] === "1"[\s\S]*?const derivedCodexHome = env\[MCP_CANDIDATE_CODEX_HOME_ENV\]/,
  );
  assert.match(mainSource, /const MCP_RUNTIME_PATHS = resolveMcpRuntimePaths\(\{[\s\S]*?env: process\.env/);
  assert.match(mainSource, /const mcpReconciler = healthCheckOnly \|\| derivedVariant \? null : createMcpReconciler\(\{/);
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
  assert.match(launchdLaunch, /\[runtime\.command, \.\.\.runtime\.args\]\.map\(shellQuote\)\.join\(" "\)/);
  assert.match(launchdLaunch, /launchctl",\s*\["bootstrap"/);
  assert.match(launchdLaunch, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.doesNotMatch(launchdLaunch, /process\.execPath, cli/);
  assert.match(launchdLaunch, /ELECTRON_RUN_AS_NODE=1/);
  for (const exactRootVariable of [
    "TWEAKERS_HOME",
    "TWEAKER_HOME",
    "TWEAKERS_USER_ROOT",
    "TWEAKER_USER_ROOT",
  ]) {
    assert.match(localRuntime, new RegExp(`${exactRootVariable}: userRoot!`));
    assert.match(launchdLaunch, new RegExp(`${exactRootVariable}=\\$\\{shellQuote\\(userRoot!\\)\\}`));
  }
  assert.match(localRuntime, /\[LEGACY_USER_ROOT_ENV\]: userRoot!/);
  assert.match(launchdLaunch, /\$\{LEGACY_USER_ROOT_ENV\}=\$\{shellQuote\(userRoot!\)\}/);
});

test("Sparkle update mode cannot be staged by Tweakers", () => {
  assert.doesNotMatch(mainSource, /prepareSignedCodexForSparkleInstall|restorePristineCodexApp/);
  assert.doesNotMatch(mainSource, /update-mode\.json|update-chatgpt/);
});

test("environment runtime proof is emitted only for injected ChatGPT launches", () => {
  assert.match(
    mainSource,
    /if \(!healthCheckOnly && !derivedVariant\) writeEnvironmentRuntimeProof\(\);/,
  );
  const writer = extractFunctionBody(mainSource, "writeEnvironmentRuntimeProof");
  assert.match(writer, /managed-runtime/);
  assert.match(writer, /environment-runtime-proof/);
});

test("appcast cache is version-keyed, bounded to 24 hours, and health probes cannot persist it", () => {
  assert.match(mainSource, /CODEX_APPCAST_CACHE_TTL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(mainSource, /codexAppcastCache\?: \{\s*schemaVersion: 1;\s*desktopVersion: string;/);
  const writer = extractFunctionBody(mainSource, "persistCodexAppcast");
  const healthGuard = writer.indexOf("if (healthCheckOnly || derivedVariant) return;");
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
  assert.doesNotMatch(mainSource, /onFeedCaptured: persistCapturedCodexDesktopProfileFeed/);
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

function assertCallOrder(body: string, calls: string[]): void {
  let previous = -1;
  for (const call of calls) {
    const next = body.indexOf(call);
    assert.ok(next > previous, `expected ${call} after prior guard step`);
    previous = next;
  }
}
