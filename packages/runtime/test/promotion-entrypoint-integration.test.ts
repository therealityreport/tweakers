import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const mainSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"), "utf8");
const promotionHealthSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/promotion-health.ts"), "utf8");
const promotionAsarSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/promotion-asar.ts"), "utf8");
const promotionPolicySource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/promotion-policy.ts"), "utf8");
const preloadSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/preload/index.ts"), "utf8");
const originalHealthPreloadSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/promotion-health-preload.ts"), "utf8");
const rendererMountSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/preload/promotion-renderer-mount.ts"), "utf8");

function sourceBlock(start: string, end: string): string {
  const first = mainSource.indexOf(start);
  const last = mainSource.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing source marker: ${start}`);
  assert.notEqual(last, -1, `missing source marker: ${end}`);
  return mainSource.slice(first, last);
}

test("main promotion responder maps the exact eight schema-v2 surfaces from candidate-safe roots", () => {
  const block = sourceBlock("function promotionSurfaceHash", "/** Parse only the bounded ASAR");
  const cases = [...block.matchAll(/case "([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(cases, [
    "app",
    "runtime",
    "tweakTree",
    "tweakersConfig",
    "codexConfig",
    "namespaceData",
    "mainStorage",
    "policy",
  ]);
  assert.match(block, /fingerprintPromotionPath\(runtimeDir!\)/);
  assert.match(block, /fingerprintPromotionPath\(TWEAKS_DIR\)/);
  assert.match(block, /fingerprintPromotionPath\(CONFIG_FILE\)/);
  assert.match(block, /fingerprintPromotionPath\(CODEX_CONFIG_FILE\)/);
  assert.match(block, /MCP_RUNTIME_PATHS\.codexHome/);
  assert.doesNotMatch(block, /homedir\(/);

  const isolation = sourceBlock("function assertPromotionProbeIsolation", "function promotionSurfaceHash");
  assert.match(isolation, /!healthCheckOnly/);
  assert.match(isolation, /candidateRequested && !MCP_RUNTIME_PATHS\.candidateIsolated/);
});

test("main responder proves candidate identity, real renderer lifecycle, broker, schema, MCP receipt, and contained auth", () => {
  const schemeRegistration = sourceBlock("const healthCheckOnly =", "// Defense in depth for one-shot macOS health processes.");
  assert.match(schemeRegistration, /if \(healthCheckOnly && !healthOriginalMain\)/);
  assert.match(schemeRegistration, /protocol\.registerSchemesAsPrivileged/);
  for (const privilege of ["standard", "secure", "supportFetchAPI", "corsEnabled", "stream", "codeCache"]) {
    assert.match(schemeRegistration, new RegExp(`${privilege}: true`));
  }
  assert.ok(
    mainSource.indexOf("protocol.registerSchemesAsPrivileged") < mainSource.indexOf("app.whenReady().then"),
    "health protocol privilege registration must happen before app readiness",
  );

  const userQuestions = sourceBlock("function promotionUserQuestionsHealth", "const desktopUpdateStartupReconciler");
  assert.match(userQuestions, /USER_QUESTIONS_TWEAK_ID/);
  assert.match(userQuestions, /fingerprintUserQuestionsPath\(root\)/);
  assert.match(userQuestions, /typeof lifecycle\.start === "function" && typeof lifecycle\.stop === "function"/);
  assert.match(userQuestions, /broker\.decodeFrame\(broker\.encodeFrame\(request\)\)/);
  assert.match(userQuestions, /schema\.validateAskInput/);
  assert.match(userQuestions, /rendererStorageSelfTest: HealthValue/);
  assert.match(userQuestions, /userQuestionsMcpConflictCount\(\)/);
  assert.doesNotMatch(userQuestions, /new Map<string, string>/);

  const renderer = sourceBlock("async function runPromotionRendererProof", "const desktopUpdateStartupReconciler");
  assert.match(renderer, /new BrowserWindow\(\{/);
  assert.match(renderer, /show: false/);
  assert.match(renderer, /preload: PRELOAD_PATH/);
  assert.doesNotMatch(renderer, /additionalArguments/);
  assert.match(renderer, /sandbox: true/);
  assert.match(renderer, /contextIsolation: true/);
  assert.match(renderer, /nodeIntegration: false/);
  assert.match(renderer, /loadURL\(url\)/);
  assert.match(renderer, /promotionRendererDocumentUrl\(nonce\)/);
  assert.match(renderer, /session\.defaultSession\.protocol/);
  assert.match(renderer, /isProtocolHandled\(PROMOTION_RENDERER_SCHEME\)/);
  assert.match(renderer, /createPromotionRendererProtocolResponder\(join\(process\.resourcesPath, "app\.asar", "webview"\)\)/);
  assert.match(renderer, /healthProtocol\.handle/);
  assert.match(renderer, /healthProtocol\.unhandle\(PROMOTION_RENDERER_SCHEME\)/);
  assert.ok(
    renderer.indexOf("healthProtocol.handle") < renderer.indexOf("new BrowserWindow"),
    "health protocol handler must exist before the proof window loads",
  );
  assert.ok(
    renderer.indexOf("} finally {") < renderer.indexOf("healthProtocol.unhandle"),
    "health protocol handler must be removed in the proof's finally block",
  );
  assert.match(renderer, /promotionRendererLoadRejection\(error, url\)/);
  assert.match(renderer, /promotion renderer loadURL rejected/);
  assert.doesNotMatch(renderer, /new URL\("app:\/\/-\/index\.html"\)/);
  assert.match(renderer, /did-fail-load/);
  assert.match(renderer, /render-process-gone/);
  assert.match(renderer, /promotion renderer process exited/);
  assert.match(renderer, /promotion renderer mount\/handshake succeeded/);
  assert.match(renderer, /PROMOTION_RENDERER_IPC_CHANNEL/);
  assert.match(renderer, /PROMOTION_RENDERER_AUTH_CHANNEL/);
  assert.match(renderer, /event\.returnValue = null/);
  assert.match(renderer, /event\.senderFrame !== null/);
  assert.match(renderer, /event\.senderFrame === proofWindow!\.webContents\.mainFrame/);
  assert.match(renderer, /senderUrl: event\.senderFrame\?\.url \?\? ""/);
  assert.match(renderer, /authorizationConsumed = true/);
  assert.match(renderer, /serializedResponse = JSON\.stringify\(decision\.response\)/);
  assert.match(renderer, /event\.returnValue = serializedResponse!/);
  assert.match(renderer, /promotion renderer authorization accepted/);
  assert.match(renderer, /promotion renderer authorization rejected/);
  const authorizationHandler = renderer.slice(
    renderer.indexOf("const onAuthorization ="),
    renderer.indexOf("ipcMain.on(PROMOTION_RENDERER_AUTH_CHANNEL"),
  );
  assert.equal((authorizationHandler.match(/event\.returnValue\s*=/g) ?? []).length, 3);
  assert.doesNotMatch(authorizationHandler.slice(0, authorizationHandler.indexOf("try {")), /event\.returnValue\s*=/);
  assert.match(authorizationHandler, /catch \{\s*event\.returnValue = null;/);
  assert.match(authorizationHandler, /if \(!decision\.accepted\) \{\s*event\.returnValue = null;/);
  assert.ok(
    renderer.indexOf("ipcMain.on(PROMOTION_RENDERER_AUTH_CHANNEL") < renderer.indexOf("new BrowserWindow"),
    "authorization listener must exist before the proof window",
  );
  assert.ok(
    renderer.indexOf("} finally {") < renderer.indexOf("ipcMain.removeListener(PROMOTION_RENDERER_AUTH_CHANNEL"),
    "authorization listener must be removed in the proof's finally block",
  );
  const handshakeHandler = renderer.slice(
    renderer.indexOf("const onHandshake ="),
    renderer.indexOf("const onAuthorization ="),
  );
  assert.match(handshakeHandler, /event\.senderFrame !== null/);
  assert.match(handshakeHandler, /event\.senderFrame === proofWindow!\.webContents\.mainFrame/);
  assert.match(handshakeHandler, /senderUrl: event\.senderFrame\?\.url \?\? ""/);
  assert.match(handshakeHandler, /authorizationConsumed/);
  assert.match(handshakeHandler, /handshakeConsumed/);
  assert.match(handshakeHandler, /promotion renderer lifecycle handshake rejected/);
  assert.match(handshakeHandler, /promotion renderer lifecycle handshake accepted/);
  assert.ok(
    handshakeHandler.indexOf("handshakeConsumed = true") < handshakeHandler.indexOf("tracker.rendererHandshake"),
    "the one allowed handshake must be consumed before the tracker records it",
  );
  assert.ok(
    handshakeHandler.indexOf("handshakeConsumed = true") < handshakeHandler.indexOf("settleHandshake?.()"),
    "the one allowed handshake must be consumed before settling the proof",
  );
  assert.match(renderer, /createPromotionRendererProofTracker\(\{ nonce, url, preloadPath: PRELOAD_PATH \}\)/);

  assert.match(preloadSource, /promotionRendererAuthorizationAttempt\(location\.href\)/);
  assert.match(preloadSource, /ipcRenderer\.sendSync\(PROMOTION_RENDERER_AUTH_CHANNEL, promotionAttempt\.request\)/);
  assert.match(preloadSource, /promotionRendererAuthorizedNonce\(promotionAttempt, response\)/);
  assert.ok(
    preloadSource.indexOf("ipcRenderer.sendSync(PROMOTION_RENDERER_AUTH_CHANNEL") < preloadSource.indexOf("installReactHook()"),
    "candidate authorization must complete synchronously before page-script hook setup",
  );
  assert.doesNotMatch(preloadSource, /process\.argv/);
  assert.doesNotMatch(preloadSource, /process\.resourcesPath/);
  assert.doesNotMatch(preloadSource, /endsWith\("\/app\.asar\/webview\/index\.html"\)/);
  assert.match(preloadSource, /new MutationObserver\(inspect\)/);
  assert.match(preloadSource, /observer\.observe\(document, \{ childList: true, subtree: true \}\)/);
  assert.doesNotMatch(preloadSource, /document\.documentElement/);
  assert.doesNotMatch(preloadSource, /document root unavailable/);
  const rendererMountSchedule = preloadSource.slice(
    preloadSource.indexOf("function schedulePromotionRendererProof"),
    preloadSource.indexOf("function promotionRendererStorageSelfTest"),
  );
  assert.ok(
    rendererMountSchedule.indexOf("observer.observe(document") < rendererMountSchedule.lastIndexOf("inspect();"),
    "document observation must begin before the first inspection",
  );
  assert.ok(
    rendererMountSchedule.indexOf("window.setTimeout") < rendererMountSchedule.lastIndexOf("inspect();"),
    "the bounded timeout must begin before the first inspection",
  );
  assert.match(preloadSource, /:scope > \.startup-loader/);
  assert.match(preloadSource, /lifecycle: "renderer-mounted"/);
  assert.match(preloadSource, /promotion renderer mount proof incomplete/);
  assert.match(preloadSource, /promotion renderer authorization incomplete/);
  assert.match(preloadSource, /prepareRendererStorageMigration\(currentId, localStorage, nonce\)/);
  assert.match(preloadSource, /ipcRenderer\.send\(PROMOTION_RENDERER_IPC_CHANNEL/);
  assert.match(rendererMountSource, /sawStartupLoader/);
  assert.match(rendererMountSource, /elementChildCount > 0/);
  assert.match(rendererMountSource, /kind: "ordinary"/);
  assert.match(rendererMountSource, /kind: "invalid-candidate"/);
  assert.match(rendererMountSource, /Object\.keys\(value\)\.sort\(\)\.join\(","\) !== "nonce,url,version"/);
  assert.match(rendererMountSource, /queryEntries\.length !== 1/);
  assert.match(promotionHealthSource, /new URL\(`\$\{PROMOTION_RENDERER_SCHEME\}:\/\/\$\{PROMOTION_RENDERER_HOST\}\/index\.html`\)/);
  assert.match(promotionHealthSource, /decodeURIComponent\(rawPath\)/);
  assert.match(promotionHealthSource, /\/%\[0-9a-f\]\{2\}\/i/);
  assert.match(promotionHealthSource, /readFile: PromotionRendererReadFile = readFileSync/);
  assert.match(promotionHealthSource, /new Response\(null, \{ status: 404 \}\)/);

  const mcp = sourceBlock("function userQuestionsMcpConflictCount", "function promotionUserQuestionsHealth");
  assert.match(mcp, /receipt\.phase !== "complete"/);
  assert.match(mcp, /receipt\.afterFingerprint/);
  assert.match(mcp, /userQuestionsMcpReceiptMatchesEnabledState/);
  assert.match(mcp, /isTweakEnabled\(USER_QUESTIONS_TWEAK_ID\)/);

  const responder = sourceBlock("void answerPromotionHealthRequest", ").then((answered)");
  assert.match(responder, /readCodexAuth\(MCP_RUNTIME_PATHS\.codexHome\)/);
  assert.match(responder, /rendererReady: \(\) => rendererProof\.hostReady/);
  assert.match(responder, /rendererProof: \(\) => rendererProof\.proofSummary \?\? null/);
  assert.match(responder, /promotionSurface: promotionSurfaceHash/);
  assert.match(responder, /userQuestionsHealth: \(\) => promotionUserQuestionsHealth\(rendererProof\.rendererStorageSelfTest\)/);
  assert.match(responder, /maxAgeMs: PROMOTION_HEALTH_REQUEST_MAX_AGE_MS/);
});

test("original-main health mode observes Codex's hidden real window without owning protocol or window creation", () => {
  const controller = sourceBlock("function createPromotionOriginalMainProbe", "// Construct this controller");
  assert.doesNotMatch(controller, /new BrowserWindow/);
  assert.doesNotMatch(controller, /protocol\.(?:handle|registerSchemesAsPrivileged)/);
  assert.match(controller, /app\.on\("session-created", onSessionCreated\)/);
  assert.match(controller, /app\.on\("browser-window-created", onBrowserWindowCreated\)/);
  assert.match(controller, /app\.once\("ready", onAppReady\)/);
  assert.match(controller, /registerSession\(session\.defaultSession, "defaultSession-ready"\)/);
  assert.match(controller, /app\.removeListener\("ready", onAppReady\)/);
  assert.match(controller, /registerPreloadScript/);
  assert.match(controller, /PROMOTION_HEALTH_PRELOAD_PATH/);
  assert.match(controller, /createPromotionOriginalRendererDeadlineController/);
  assert.match(controller, /promotion original renderer startup timed out/);
  assert.match(controller, /promotion original renderer load timed out/);
  assert.match(controller, /promotion original renderer mount timed out/);
  assert.match(controller, /deadlineController\?\.canonicalLoaded\(\)/);
  assert.match(controller, /deadlineController\.canonicalSelected\(\)/);
  assert.match(controller, /if \(selectedId === contents\.id && canonicalWindow === null\) \{[\s\S]*?canonicalWindow = window;[\s\S]*?requireBackgroundThrottlingDisabled\(contents, "selection", true\)/);
  assert.match(promotionHealthSource, /target\.getBackgroundThrottling/);
  assert.match(promotionHealthSource, /target\.setBackgroundThrottling/);
  assert.match(controller, /promotion original renderer background throttling checked/);
  assert.match(controller, /previous: canonicalBackgroundThrottlingPrevious/);
  assert.match(controller, /phase,/);
  assert.match(controller, /requireBackgroundThrottlingDisabled\(contents, "did-finish-load"\)/);
  assert.doesNotMatch(controller, /promotion original renderer watchdog expired/);
  assert.match(controller, /window\.setFocusable\(false\)/);
  assert.match(controller, /window\.hide\(\)/);
  assert.match(controller, /originalOpacitySetters/);
  assert.match(controller, /setOriginalOpacity\(0\)/);
  assert.match(controller, /window\.getOpacity\(\) === 0/);
  assert.match(controller, /promotion original BrowserWindow opacity suppressed/);
  assert.match(controller, /captured window opacity interception did not stick/);
  assert.match(controller, /\["show", "showInactive", "focus", "restore"\] as const/);
  assert.match(controller, /suppressWindowActivationMethod\(window, method, removers\)/);
  assert.match(controller, /captured window \$\{method\} interception unavailable/);
  assert.match(controller, /captured window \$\{method\} interception failed/);
  assert.match(controller, /captured window \$\{method\} interception did not stick/);
  assert.match(controller, /if \(mutableWindow\[method\] === suppressed\) mutableWindow\[method\] = original/);
  assert.match(controller, /if \(initiallyVisible\) fail\(`captured window \$\{contents\.id\} was initially visible`\)/);
  assert.match(controller, /fail\(`captured window \$\{contents\.id\} emitted show`\)/);
  assert.match(controller, /fail\(`captured window \$\{contents\.id\} emitted focus`\)/);
  assert.match(controller, /canonical renderer became visible and could not be re-hidden/);
  assert.match(controller, /promotion original BrowserWindow delayed activation re-hidden/);
  assert.match(controller, /canonical renderer transparency guard failed/);
  assert.match(controller, /typeof preloadPath !== "string" \|\| !isAbsolute\(preloadPath\)/);
  assert.match(controller, /preloadPath !== exactPath/);
  assert.match(controller, /exactPath === resolve\(PROMOTION_HEALTH_PRELOAD_PATH\)/);
  assert.match(controller, /resolve\(process\.resourcesPath, "app\.asar"\)/);
  assert.match(controller, /containedPath\.startsWith\("\.\."\)/);
  assert.match(controller, /existsSync\(exactPath\) && lstatSync\(exactPath\)\.isFile\(\)/);
  assert.match(controller, /originalPreloadValid,/);
  assert.match(controller, /tracker\.eligibleWindow\(\{[\s\S]*?url: canonicalUrl,/);
  assert.match(controller, /sandbox: preferences\.sandbox,/);
  assert.match(controller, /validatePromotionOriginalRendererHandshake/);
  assert.match(controller, /validatePromotionOriginalRendererLoadObserved/);
  assert.match(controller, /validatePromotionOriginalRendererMountTimeout/);
  assert.match(controller, /requireBackgroundThrottlingDisabled\(event\.sender, "renderer-load-observed"\)/);
  assert.match(controller, /requireBackgroundThrottlingDisabled\(event\.sender, "renderer-mounted"\)/);
  assert.match(controller, /requireBackgroundThrottlingDisabled\(event\.sender, "renderer-mount-timeout"\)/);
  assert.match(controller, /promotion original renderer load observation accepted/);
  const loadObservationBranch = controller.slice(
    controller.indexOf('if (lifecycle === "renderer-load-observed")'),
    controller.indexOf('if (lifecycle === "renderer-mount-timeout")'),
  );
  assert.match(loadObservationBranch, /loadObservedConsumed = true/);
  assert.doesNotMatch(loadObservationBranch, /handshakeConsumed = true/);
  assert.match(controller, /promotion original renderer mount timed out/);
  assert.match(controller, /canonical renderer mount timed out/);
  assert.match(controller, /rendererSandboxed: decision\.observation\.rendererSandboxed/);
  const originalAuthorization = controller.slice(
    controller.indexOf("const onAuthorization ="),
    controller.indexOf("const onHandshake ="),
  );
  assert.match(originalAuthorization, /process\.platform === "darwin"/);
  assert.match(originalAuthorization, /event\.sender\.getOSProcessId\(\)/);
  assert.match(originalAuthorization, /app\.getAppMetrics\(\)/);
  assert.match(originalAuthorization, /hasUniqueSandboxedPromotionRendererProcess/);
  assert.match(originalAuthorization, /canonical renderer sandbox process proof failed/);
  assert.ok(
    originalAuthorization.indexOf("hasUniqueSandboxedPromotionRendererProcess")
      < originalAuthorization.indexOf("authorizationConsumed = true"),
    "the OS-level sandbox proof must pass before the nonce is released",
  );
  assert.match(controller, /promotion original renderer eligible window observed[\s\S]*?url: promotionOriginalRendererLogUrl\(canonicalUrl\)/);
  assert.match(controller, /preloadErrorWebContentsIds\.add\(contents\.id\)/);
  assert.match(controller, /tracker\.preloadError\(contents\.id\)/);
  assert.match(controller, /"preload-error"/);
  assert.match(controller, /promotion original renderer preload failed/);
  assert.match(controller, /event\.returnValue = JSON\.stringify\(decision\.response\)/);
  assert.match(controller, /"did-start-navigation"/);
  assert.match(controller, /"dom-ready"/);
  assert.match(controller, /promotion original renderer DOM ready/);
  assert.match(controller, /"did-stop-loading"/);
  assert.match(controller, /promotion original renderer stopped loading/);
  assert.match(controller, /"did-fail-load"/);
  assert.match(controller, /"did-fail-provisional-load"/);
  assert.match(controller, /shouldFailPromotionOriginalRendererProvisionalLoad/);
  assert.match(controller, /canonical renderer provisional load failed/);
  assert.match(controller, /"render-process-gone"/);
  assert.match(controller, /cleanupTrackedParents\(\)/);
  assert.match(controller, /unregisterPreloadScript/);
  assert.match(controller, /window\.destroy\(\)/);
  assert.match(controller, /if \(cleaningUp\) \{[\s\S]*lateWindowDuringCleanup = true;[\s\S]*window\.destroy\(\)/);
  assert.match(controller, /if \(cleanupFinished\) app\.exit\(1\)/);
  assert.doesNotMatch(controller, /removeListener\("browser-window-created", onBrowserWindowCreated\)/);
  assert.ok(
    controller.indexOf("window.destroy()") < controller.indexOf("for (const removers of windowCleanup.values())"),
    "captured windows must be destroyed before activation interceptors are restored",
  );

  const ready = sourceBlock("app.whenReady().then", "if (!healthCheckOnly) {\n  app.on(\"session-created\"");
  assert.match(ready, /originalMainPromotionProbe\?\.registerSession\(session\.defaultSession/);
  assert.match(ready, /healthOriginalMain\s*\? await originalMainPromotionProbe!\.run\(\)/);
  assert.ok(
    mainSource.indexOf("const originalMainPromotionProbe =") < mainSource.indexOf("app.whenReady().then"),
    "the original-main controller and its ready listener must be created before the whenReady fallback",
  );
  assert.match(mainSource, /healthOriginalMain && process\.platform === "darwin" && !codexAppServerParent\.installed/);
  assert.match(mainSource, /if \(!healthCheckOnly\) removeLegacyModeSwitcherState\(userRoot\)/);
  assert.match(mainSource, /persistFailure: healthCheckOnly \? undefined : \(message\) =>/);
  assert.match(mainSource, /if \(!healthCheckOnly\) codexCliManager\.recover\(\)/);

  assert.match(originalHealthPreloadSource, /location\.href/);
  assert.match(originalHealthPreloadSource, /sendSync\(PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL/);
  assert.match(originalHealthPreloadSource, /rendererSandboxed: effectiveRendererSandboxed/);
  assert.match(originalHealthPreloadSource, /const MOUNT_TIMEOUT_MS = 55_000/);
  assert.match(originalHealthPreloadSource, /lifecycle: "renderer-load-observed"/);
  assert.match(originalHealthPreloadSource, /onLoadObserved\(\)/);
  assert.match(originalHealthPreloadSource, /window\.addEventListener\("load", onWindowLoad, \{ once: true \}\)/);
  assert.match(originalHealthPreloadSource, /document\.readyState === "complete"/);
  assert.match(originalHealthPreloadSource, /lifecycle: "renderer-mount-timeout"/);
  assert.match(originalHealthPreloadSource, /const PROMOTION_ORIGINAL_RENDERER_URL = "app:\/\/-\/index\.html"/);
  assert.match(originalHealthPreloadSource, /const PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL = "tweaker:promotion-original-renderer-authorize"/);
  assert.match(originalHealthPreloadSource, /const PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL = "tweaker:promotion-original-renderer-proof"/);
  assert.doesNotMatch(originalHealthPreloadSource, /from "\.\/promotion-health"/);
  assert.match(originalHealthPreloadSource, /value\.length > 1_024/);
  assert.match(originalHealthPreloadSource, /JSON\.parse\(value\)/);
  assert.match(originalHealthPreloadSource, /observer\.observe\(document/);
  assert.match(originalHealthPreloadSource, /:scope > \.startup-loader/);
  assert.match(originalHealthPreloadSource, /verifyRendererStorageRollback/);
  assert.match(originalHealthPreloadSource, /const effectiveRendererSandboxed = process\.sandboxed === true/);
  assert.match(originalHealthPreloadSource, /rendererSandboxed: effectiveRendererSandboxed/);
  assert.doesNotMatch(originalHealthPreloadSource, /process\.(?:env|argv)/);
  assert.match(originalHealthPreloadSource, /searchParams\.has\(PROMOTION_RENDERER_NONCE_QUERY\)/);
});

test("original-main health mode observes Codex's hidden real window without owning protocol or window creation", () => {
  const controller = sourceBlock("function createPromotionOriginalMainProbe", "// Construct this controller");
  assert.doesNotMatch(controller, /new BrowserWindow/);
  assert.doesNotMatch(controller, /protocol\.(?:handle|registerSchemesAsPrivileged)/);
  assert.match(controller, /app\.on\("session-created", onSessionCreated\)/);
  assert.match(controller, /app\.on\("browser-window-created", onBrowserWindowCreated\)/);
  assert.match(controller, /app\.once\("ready", onAppReady\)/);
  assert.match(controller, /registerSession\(session\.defaultSession, "defaultSession-ready"\)/);
  assert.match(controller, /app\.removeListener\("ready", onAppReady\)/);
  assert.match(controller, /registerPreloadScript/);
  assert.match(controller, /PROMOTION_HEALTH_PRELOAD_PATH/);
  assert.match(controller, /setTimeout\(\(\) => \{\s*fail\("promotion original renderer watchdog expired"\);\s*\}, 25_000\)/);
  assert.match(controller, /window\.setFocusable\(false\)/);
  assert.match(controller, /window\.hide\(\)/);
  assert.match(controller, /\["show", "showInactive", "focus", "restore"\] as const/);
  assert.match(controller, /suppressWindowActivationMethod\(window, method, removers\)/);
  assert.match(controller, /captured window \$\{method\} interception unavailable/);
  assert.match(controller, /captured window \$\{method\} interception failed/);
  assert.match(controller, /captured window \$\{method\} interception did not stick/);
  assert.match(controller, /if \(mutableWindow\[method\] === suppressed\) mutableWindow\[method\] = original/);
  assert.match(controller, /if \(initiallyVisible\) fail\(`captured window \$\{contents\.id\} was initially visible`\)/);
  assert.match(controller, /fail\(`captured window \$\{contents\.id\} emitted show`\)/);
  assert.match(controller, /fail\(`captured window \$\{contents\.id\} emitted focus`\)/);
  assert.match(controller, /typeof preloadPath !== "string" \|\| !isAbsolute\(preloadPath\)/);
  assert.match(controller, /preloadPath !== exactPath/);
  assert.match(controller, /exactPath === resolve\(PROMOTION_HEALTH_PRELOAD_PATH\)/);
  assert.match(controller, /resolve\(process\.resourcesPath, "app\.asar"\)/);
  assert.match(controller, /containedPath\.startsWith\("\.\."\)/);
  assert.match(controller, /existsSync\(exactPath\) && lstatSync\(exactPath\)\.isFile\(\)/);
  assert.match(controller, /originalPreloadValid,/);
  assert.match(controller, /tracker\.eligibleWindow\(\{[\s\S]*?url: canonicalUrl,/);
  assert.match(controller, /promotion original renderer eligible window observed[\s\S]*?url: promotionOriginalRendererLogUrl\(canonicalUrl\)/);
  assert.match(controller, /preloadErrorWebContentsIds\.add\(contents\.id\)/);
  assert.match(controller, /tracker\.preloadError\(contents\.id\)/);
  assert.match(controller, /"preload-error"/);
  assert.match(controller, /promotion original renderer preload failed/);
  assert.match(controller, /event\.returnValue = JSON\.stringify\(decision\.response\)/);
  assert.match(controller, /"did-start-navigation"/);
  assert.match(controller, /"did-fail-load"/);
  assert.match(controller, /"render-process-gone"/);
  assert.match(controller, /cleanupTrackedParents\(\)/);
  assert.match(controller, /unregisterPreloadScript/);
  assert.match(controller, /window\.destroy\(\)/);
  assert.match(controller, /if \(cleaningUp\) \{[\s\S]*lateWindowDuringCleanup = true;[\s\S]*window\.destroy\(\)/);
  assert.match(controller, /if \(cleanupFinished\) app\.exit\(1\)/);
  assert.doesNotMatch(controller, /removeListener\("browser-window-created", onBrowserWindowCreated\)/);
  assert.ok(
    controller.indexOf("window.destroy()") < controller.indexOf("for (const removers of windowCleanup.values())"),
    "captured windows must be destroyed before activation interceptors are restored",
  );

  const ready = sourceBlock("app.whenReady().then", "if (!healthCheckOnly) {\n  app.on(\"session-created\"");
  assert.match(ready, /originalMainPromotionProbe\?\.registerSession\(session\.defaultSession/);
  assert.match(ready, /healthOriginalMain\s*\? await originalMainPromotionProbe!\.run\(\)/);
  assert.ok(
    mainSource.indexOf("const originalMainPromotionProbe =") < mainSource.indexOf("app.whenReady().then"),
    "the original-main controller and its ready listener must be created before the whenReady fallback",
  );
  assert.match(mainSource, /healthOriginalMain && process\.platform === "darwin" && !codexAppServerParent\.installed/);
  assert.match(mainSource, /if \(!healthCheckOnly\) removeLegacyModeSwitcherState\(userRoot\)/);
  assert.match(mainSource, /persistFailure: healthCheckOnly \? undefined : \(message\) =>/);
  assert.match(mainSource, /if \(!healthCheckOnly\) codexCliManager\.recover\(\)/);

  assert.match(originalHealthPreloadSource, /location\.href/);
  assert.match(originalHealthPreloadSource, /sendSync\(PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL/);
  assert.match(originalHealthPreloadSource, /const PROMOTION_ORIGINAL_RENDERER_URL = "app:\/\/-\/index\.html"/);
  assert.match(originalHealthPreloadSource, /const PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL = "tweaker:promotion-original-renderer-authorize"/);
  assert.match(originalHealthPreloadSource, /const PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL = "tweaker:promotion-original-renderer-proof"/);
  assert.doesNotMatch(originalHealthPreloadSource, /from "\.\/promotion-health"/);
  assert.match(originalHealthPreloadSource, /value\.length > 1_024/);
  assert.match(originalHealthPreloadSource, /JSON\.parse\(value\)/);
  assert.match(originalHealthPreloadSource, /observer\.observe\(document/);
  assert.match(originalHealthPreloadSource, /:scope > \.startup-loader/);
  assert.match(originalHealthPreloadSource, /verifyRendererStorageRollback/);
  assert.doesNotMatch(originalHealthPreloadSource, /process\.(?:env|argv)/);
  assert.match(originalHealthPreloadSource, /searchParams\.has\(PROMOTION_RENDERER_NONCE_QUERY\)/);
});

test("ASAR and tree probes are bounded, deterministic, and do not import installer state", () => {
  const asar = sourceBlock("function promotionAppHeaderHash", "/** Mode- and link-aware deterministic hash paired with install.ts. */");
  assert.match(asar, /join\(process\.resourcesPath, "app\.asar"\)/);
  assert.match(asar, /hashRawAsarHeader\(archivePath, originalFs\)/);
  assert.doesNotMatch(asar, /app\.getAppPath\(\)/);
  assert.match(promotionAsarSource, /headerSize > 64 \* 1024 \* 1024/);
  assert.match(promotionAsarSource, /JSON\.parse\(headerString\)/);
  assert.match(promotionAsarSource, /createHash\("sha256"\)\.update\(headerString\)/);

  const fingerprint = sourceBlock("function fingerprintPromotionPath", "/** Exact payload hash paired with user-questions-source.ts");
  assert.match(fingerprint, /readdirSync\(entryPath\)\.sort\(\)/);
  assert.match(fingerprint, /readlinkSync\(entryPath\)/);
  assert.match(fingerprint, /stat\.mode & 0o777/);
  assert.doesNotMatch(fingerprint, /installer/);
});

test("promotion policy runtime stays standalone and uses its semantic no-follow proof", () => {
  assert.doesNotMatch(promotionPolicySource, /@therealityreport\/tweakers-sdk/);
  assert.match(promotionPolicySource, /O_NOFOLLOW/);
  assert.match(promotionPolicySource, /PROMOTION_POLICY_FILE_MAX_BYTES/);
  assert.match(promotionPolicySource, /mcpFormElicitationsEnabled/);
  assert.match(promotionPolicySource, /localAgentMode/);
  for (const field of [
    "activePermissionProfile",
    "approvalPolicy",
    "sandboxPolicy",
    "approvalsReviewer",
    "runtimeWorkspaceRoots",
  ]) {
    assert.match(promotionPolicySource, new RegExp(`policySlot\\(record, "${field}"\\)`));
  }
});

test("policy fingerprint failures emit only the stable sanitized targeted event and rethrow", () => {
  const block = sourceBlock("function promotionPolicySurfaceHash", "/** Parse only the bounded ASAR");
  assert.match(block, /log\("error", "promotion policy fingerprint failed", \{/);
  assert.match(block, /surface: "policy"/);
  assert.match(block, /reason: promotionPolicyFingerprintFailureReason\(error\)/);
  assert.match(block, /throw error/);
  assert.doesNotMatch(block, /error\.(?:message|stack)|String\(error\)/);
  assert.match(mainSource, /!SANITIZED_PROMOTION_POLICY_FAILURES\.has\(error\)/);
  for (const reason of [
    "open_failed",
    "unsafe_metadata",
    "changed_during_read",
    "path_changed",
    "invalid_utf8",
    "invalid_json",
    "duplicate_json_key",
    "invalid_schema",
  ]) {
    assert.match(promotionPolicySource, new RegExp(`"${reason}"`));
  }
});
