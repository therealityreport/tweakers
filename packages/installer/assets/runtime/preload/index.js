"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const native_capture_1 = require("./native-capture");
/**
 * Renderer preload entry. Runs in an isolated world before Codex's page JS.
 * Responsibilities:
 *   1. Install a React DevTools-shaped global hook to capture the renderer
 *      reference when React mounts. We use this for fiber walking.
 *   2. After DOMContentLoaded, kick off settings-injection logic.
 *   3. Discover renderer-scoped tweaks (via IPC to main) and start them.
 *   4. Listen for `tweaker:tweaks-changed` from main (filesystem watcher) and
 *      hot-reload tweaks without dropping the page.
 */
const electron_1 = require("electron");
const accounts_native_1 = require("./accounts-native");
const react_hook_1 = require("./react-hook");
const settings_injector_1 = require("./settings-injector");
const tweak_host_1 = require("./tweak-host");
const manager_1 = require("./manager");
const desktop_update_indicator_1 = require("./desktop-update-indicator");
const reload_focus_1 = require("./reload-focus");
const renderer_storage_1 = require("../renderer-storage");
const promotion_renderer_mount_1 = require("./promotion-renderer-mount");
const BROWSER_UI_CONNECT_PORT = "tweaker:browser-ui-connect-app-host";
const BROWSER_UI_BRIDGE_REQUEST = "tweaker:browser-ui-bridge-request";
const BROWSER_UI_BRIDGE_RESPONSE = "tweaker:browser-ui-bridge-response";
const BROWSER_UI_MESSAGE_FOR_VIEW = "tweaker:browser-ui-message-for-view";
const BROWSER_UI_WORKER_MESSAGE = "tweaker:browser-ui-worker-message";
const BROWSER_UI_SYSTEM_THEME = "tweaker:browser-ui-system-theme";
const PROMOTION_RENDERER_IPC_CHANNEL = "tweaker:promotion-renderer-proof";
const PROMOTION_RENDERER_AUTH_CHANNEL = "tweaker:promotion-renderer-authorize";
const PROMOTION_RENDERER_MOUNT_TIMEOUT_MS = 4_000;
const DESKTOP_MESSAGE_FROM_VIEW = "codex_desktop:message-from-view";
const DESKTOP_MESSAGE_FOR_VIEW = "codex_desktop:message-for-view";
const DESKTOP_SHOW_CONTEXT_MENU = "codex_desktop:show-context-menu";
const DESKTOP_SHOW_APPLICATION_MENU = "codex_desktop:show-application-menu";
const DESKTOP_GET_SENTRY_INIT_OPTIONS = "codex_desktop:get-sentry-init-options";
const DESKTOP_GET_BUILD_FLAVOR = "codex_desktop:get-build-flavor";
const DESKTOP_GET_USES_OWL_APP_SHELL = "codex_desktop:get-uses-owl-app-shell";
const DESKTOP_GET_SYSTEM_THEME_VARIANT = "codex_desktop:get-system-theme-variant";
const DESKTOP_GET_SHARED_OBJECT_SNAPSHOT = "codex_desktop:get-shared-object-snapshot";
const DESKTOP_GET_FAST_MODE_ROLLOUT_METRICS = "codex_desktop:get-fast-mode-rollout-metrics";
const DESKTOP_SYSTEM_THEME_UPDATED = "codex_desktop:system-theme-variant-updated";
const DESKTOP_TRIGGER_SENTRY_TEST = "codex_desktop:trigger-sentry-test";
function desktopWorkerFromViewChannel(workerId) {
    return `codex_desktop:worker:${workerId}:from-view`;
}
function desktopWorkerForViewChannel(workerId) {
    return `codex_desktop:worker:${workerId}:for-view`;
}
// File-log preload progress so we can diagnose without DevTools. Best-effort:
// failures here must never throw because we'd take the page down with us.
//
// Codex's renderer is sandboxed (sandbox: true), so `require("node:fs")` is
// unavailable. We forward log lines to main via IPC; main writes the file.
function fileLog(stage, extra) {
    const bootDetail = /^(?:preload entry|browser UI host bridge installed|react hook installed|boot start|desktop update indicator started|settings injector started|tweak host started|manager mounted|boot complete)$/.test(stage);
    const msg = `[tweaker preload] ${stage}${extra === undefined ? "" : " " + safeStringify(extra)}`;
    try {
        if (bootDetail)
            console.debug(msg);
        else
            console.error(msg);
    }
    catch { }
    if (bootDetail)
        return;
    try {
        electron_1.ipcRenderer.send("tweaker:preload-log", "info", msg);
    }
    catch { }
}
function safeStringify(v) {
    try {
        return typeof v === "string" ? v : JSON.stringify(v);
    }
    catch {
        return String(v);
    }
}
fileLog("preload entry", { url: location.href });
// React values stay in the page. This transport exposes only the reviewed
// account data operations and a receipt-bound initialization handshake.
if (isTweakerUiDocument(location.href)) {
    try {
        accounts_native_1.accountsNativeBridge.setCompatibility(electron_1.ipcRenderer.sendSync("tweaker:accounts-native-compatibility"));
        electron_1.contextBridge.exposeInMainWorld("__tweakersAccountsTransportV1", accounts_native_1.accountsNativeTransport);
        electron_1.contextBridge.exposeInMainWorld("__tweakersNativeCaptureV1", native_capture_1.nativeCaptureBridge.transport);
    }
    catch {
        accounts_native_1.accountsNativeBridge.setCompatibility({ compatible: false, reason: "Accounts native initialization failed.", hookSetSha256: "" });
    }
}
const promotionAttempt = (0, promotion_renderer_mount_1.promotionRendererAuthorizationAttempt)(location.href);
let promotionNonce = null;
if (promotionAttempt.kind === "candidate") {
    let response = null;
    let rejectionReason = "main authorization rejected";
    try {
        response = electron_1.ipcRenderer.sendSync(PROMOTION_RENDERER_AUTH_CHANNEL, promotionAttempt.request);
    }
    catch {
        rejectionReason = "synchronous authorization failed";
    }
    promotionNonce = (0, promotion_renderer_mount_1.promotionRendererAuthorizedNonce)(promotionAttempt, response);
    if (promotionNonce === null) {
        fileLog("promotion renderer authorization incomplete", { reason: rejectionReason });
    }
}
else if (promotionAttempt.kind === "invalid-candidate") {
    fileLog("promotion renderer authorization incomplete", { reason: promotionAttempt.reason });
}
try {
    installBrowserUiHostBridge();
    fileLog("browser UI host bridge installed");
}
catch (e) {
    fileLog("browser UI host bridge FAILED", String(e));
}
// React hook must be installed *before* Codex's bundle runs.
try {
    (0, react_hook_1.installReactHook)();
    fileLog("react hook installed");
}
catch (e) {
    fileLog("react hook FAILED", String(e));
}
if (promotionNonce) {
    schedulePromotionRendererProof(promotionNonce);
}
else if (promotionAttempt.kind === "ordinary") {
    queueMicrotask(() => {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", boot, { once: true });
        }
        else {
            boot();
        }
    });
}
function schedulePromotionRendererProof(nonce) {
    const mount = (0, promotion_renderer_mount_1.createPromotionRendererMountTracker)();
    let observer = null;
    let timeout = null;
    let settled = false;
    const cleanup = () => {
        observer?.disconnect();
        observer = null;
        if (timeout !== null)
            window.clearTimeout(timeout);
        timeout = null;
    };
    const inspect = () => {
        if (settled)
            return;
        const root = document.getElementById("root");
        const state = mount.observe({
            rootPresent: root !== null,
            startupLoaderPresent: root !== null && root.querySelector(":scope > .startup-loader") !== null,
            elementChildCount: root?.children.length ?? 0,
        });
        if (state !== "mounted")
            return;
        settled = true;
        cleanup();
        const rendererStorageSelfTest = promotionRendererStorageSelfTest(nonce);
        electron_1.ipcRenderer.send(PROMOTION_RENDERER_IPC_CHANNEL, {
            nonce,
            url: location.href,
            lifecycle: "renderer-mounted",
            rendererStorageSelfTest,
        });
        fileLog("promotion renderer mount proof sent", { rendererStorageSelfTest });
    };
    observer = new MutationObserver(inspect);
    observer.observe(document, { childList: true, subtree: true });
    timeout = window.setTimeout(() => {
        if (settled)
            return;
        settled = true;
        cleanup();
        fileLog("promotion renderer mount proof incomplete", {
            reason: "startup loader was not replaced by renderer content",
            timeoutMs: PROMOTION_RENDERER_MOUNT_TIMEOUT_MS,
        });
    }, PROMOTION_RENDERER_MOUNT_TIMEOUT_MS);
    inspect();
}
function promotionRendererStorageSelfTest(nonce) {
    const suffix = `promotion-health-${nonce}`;
    const currentId = `co.tweakers.${suffix}`;
    const currentKey = `tweaker:storage:${currentId}`;
    const legacyKey = `${["codex", "pp"].join("")}:storage:co.promotion-probe.${suffix}`;
    const raw = JSON.stringify({ retained: true, nonce });
    let archiveKey = null;
    let ownsProbeKeys = false;
    try {
        if (localStorage.getItem(currentKey) !== null || localStorage.getItem(legacyKey) !== null)
            return "fail";
        ownsProbeKeys = true;
        localStorage.setItem(legacyKey, raw);
        const prepared = (0, renderer_storage_1.prepareRendererStorageMigration)(currentId, localStorage, nonce);
        if (prepared.status !== "prepared" || prepared.holdPromotion || localStorage.getItem(currentKey) !== raw)
            return "fail";
        const committed = (0, renderer_storage_1.commitRendererStorageMigration)(prepared, localStorage);
        archiveKey = committed.archiveKey;
        if (committed.phase !== "committed" || !archiveKey || localStorage.getItem(legacyKey) !== null)
            return "fail";
        const rolledBack = (0, renderer_storage_1.rollbackRendererStorageMigration)(committed, localStorage);
        return rolledBack.phase === "rolled_back"
            && localStorage.getItem(legacyKey) === raw
            && localStorage.getItem(currentKey) === null
            && localStorage.getItem(archiveKey) === null
            ? "pass"
            : "fail";
    }
    catch {
        return "fail";
    }
    finally {
        if (ownsProbeKeys) {
            try {
                localStorage.removeItem(currentKey);
            }
            catch { }
            try {
                localStorage.removeItem(legacyKey);
            }
            catch { }
            if (archiveKey) {
                try {
                    localStorage.removeItem(archiveKey);
                }
                catch { }
            }
        }
    }
}
function isTweakerUiDocument(href) {
    try {
        const url = new URL(href);
        return url.protocol === "app:" && url.hostname === "-"
            && !url.username && !url.password && !url.port
            && ["/index.html", "/detached-window.html"].includes(url.pathname)
            && url.searchParams.get("initialRoute") !== "/avatar-overlay";
    }
    catch {
        return false;
    }
}
async function boot() {
    // The session preload also runs in checkout, authentication and sandbox
    // documents. Those do not own tweak settings, storage or renderer handlers.
    if (!isTweakerUiDocument(location.href))
        return;
    subscribeReload();
    fileLog("boot start", { readyState: document.readyState });
    try {
        const nativeDescriptor = await electron_1.ipcRenderer.invoke("tweaker:native-services-descriptor");
        if (nativeDescriptor) {
            electron_1.contextBridge.executeInMainWorld({
                func: (descriptor) => {
                    const entry = document.querySelector('script[type="module"][src*="/assets/"]');
                    const url = entry ? new URL(descriptor.asset, entry.src) : new URL(`/assets/${descriptor.asset}`, location.href);
                    void Promise.resolve(`${url.href}`).then(s => __importStar(require(s))).then((module) => {
                        const services = () => {
                            const value = module[descriptor.exportName];
                            if (!value)
                                throw new Error("Native Codex services are still starting");
                            return value;
                        };
                        const bridge = globalThis.__tweakersNativeCaptureV1;
                        bridge?.register({
                            appshots: {
                                getState: () => services().appshot.getState(),
                                setHotkey: (hotkey) => services().appshot.setHotkey(hotkey),
                            },
                            computerHistory: { getState: () => services().chronicle.getState() },
                        });
                    }).catch(error => console.warn("[tweaker] Native capture services unavailable:", error));
                },
                args: [nativeDescriptor],
            });
        }
        (0, desktop_update_indicator_1.startDesktopUpdateIndicator)();
        fileLog("desktop update indicator started");
        (0, settings_injector_1.startSettingsInjector)();
        fileLog("settings injector started");
        await (0, tweak_host_1.startTweakHost)();
        fileLog("tweak host started");
        await (0, manager_1.mountManager)();
        fileLog("manager mounted");
        fileLog("boot complete");
    }
    catch (e) {
        fileLog("boot FAILED", String(e?.stack ?? e));
        console.error("[tweaker] preload boot failed:", e);
    }
    finally {
        bootingTweaks = false;
        if (reloadPending)
            requestTweakReload();
    }
}
// Hot reload: gated behind a small in-flight lock so a flurry of fs events
// doesn't reentrantly tear down the host mid-load.
let reloading = null;
let reloadPending = false;
let bootingTweaks = true;
let storeLifecycleHeld = false;
let storeLifecycleOperation = null;
function subscribeReload() {
    electron_1.ipcRenderer.on("tweaker:tweaks-changed", requestTweakReload);
    electron_1.ipcRenderer.on("tweaker:store-lifecycle", async (_event, request) => {
        if (!request || typeof request.operationId !== "string" || typeof request.instanceToken !== "string"
            || typeof request.tweakId !== "string" || !["shutdown", "activate"].includes(request.phase))
            return;
        let ok = false, error;
        try {
            if (bootingTweaks)
                throw new Error("Renderer startup is still in flight");
            if (storeLifecycleOperation && storeLifecycleOperation !== request.operationId)
                throw new Error("Another store operation owns this renderer");
            storeLifecycleOperation = request.operationId;
            storeLifecycleHeld = true;
            if (reloading)
                await reloading;
            if (request.phase === "shutdown")
                await (0, tweak_host_1.teardownTweakHost)();
            else {
                await (0, tweak_host_1.startTweakHost)(request.tweakId);
                await (0, manager_1.mountManager)();
                storeLifecycleHeld = false;
                storeLifecycleOperation = null;
            }
            ok = true;
        }
        catch (cause) {
            error = String(cause?.message ?? cause);
        }
        electron_1.ipcRenderer.send("tweaker:store-lifecycle-ack", {
            operationId: request.operationId, instanceToken: request.instanceToken, phase: request.phase, ok, error,
        });
    });
}
function requestTweakReload() {
    reloadPending = true;
    if (reloading || bootingTweaks || storeLifecycleHeld)
        return;
    reloading = (async () => {
        const focusSnapshot = (0, reload_focus_1.captureTweakReloadFocus)(document);
        try {
            console.info("[tweaker] hot-reloading tweaks");
            do {
                reloadPending = false;
                await (0, tweak_host_1.teardownTweakHost)();
                await (0, tweak_host_1.startTweakHost)();
                await (0, manager_1.mountManager)();
            } while (reloadPending);
        }
        catch (e) {
            console.error("[tweaker] hot reload failed:", e);
        }
        finally {
            window.requestAnimationFrame(() => {
                (0, reload_focus_1.restoreTweakReloadFocus)(focusSnapshot);
            });
            reloading = null;
        }
    })();
}
function installBrowserUiHostBridge() {
    const workerListeners = new Map();
    electron_1.ipcRenderer.on(BROWSER_UI_CONNECT_PORT, (event) => {
        const [port] = event.ports;
        if (!port)
            return;
        window.postMessage({ type: "connect-app-host", port }, "*", [port]);
    });
    electron_1.ipcRenderer.on(BROWSER_UI_BRIDGE_REQUEST, async (_event, payload) => {
        const request = payload && typeof payload === "object"
            ? payload
            : {};
        const id = typeof request.id === "string" ? request.id : "";
        const method = typeof request.method === "string" ? request.method : "";
        const args = Array.isArray(request.args) ? request.args : [];
        try {
            const value = await runBrowserUiBridgeMethod(method, args, workerListeners);
            electron_1.ipcRenderer.send(BROWSER_UI_BRIDGE_RESPONSE, { id, ok: true, value });
        }
        catch (e) {
            electron_1.ipcRenderer.send(BROWSER_UI_BRIDGE_RESPONSE, {
                id,
                ok: false,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    });
    electron_1.ipcRenderer.on(DESKTOP_MESSAGE_FOR_VIEW, (_event, message) => {
        electron_1.ipcRenderer.send(BROWSER_UI_MESSAGE_FOR_VIEW, message);
    });
    electron_1.ipcRenderer.on(DESKTOP_SYSTEM_THEME_UPDATED, (_event, value) => {
        electron_1.ipcRenderer.send(BROWSER_UI_SYSTEM_THEME, value);
    });
}
async function runBrowserUiBridgeMethod(method, args, workerListeners) {
    switch (method) {
        case "snapshot":
            return electron_1.ipcRenderer.sendSync(DESKTOP_GET_SHARED_OBJECT_SNAPSHOT) ?? {};
        case "systemTheme":
            return electron_1.ipcRenderer.sendSync(DESKTOP_GET_SYSTEM_THEME_VARIANT);
        case "sentryOptions":
            return electron_1.ipcRenderer.sendSync(DESKTOP_GET_SENTRY_INIT_OPTIONS);
        case "buildFlavor":
            return electron_1.ipcRenderer.sendSync(DESKTOP_GET_BUILD_FLAVOR);
        case "usesOwlAppShell":
            return electron_1.ipcRenderer.sendSync(DESKTOP_GET_USES_OWL_APP_SHELL) === true;
        case "sendMessageFromView":
            return electron_1.ipcRenderer.invoke(DESKTOP_MESSAGE_FROM_VIEW, args[0]);
        case "sendWorkerMessageFromView":
            return electron_1.ipcRenderer.invoke(desktopWorkerFromViewChannel(String(args[0])), args[1]);
        case "subscribeWorkerMessages":
            return subscribeBrowserUiWorkerMessages(String(args[0]), workerListeners);
        case "unsubscribeWorkerMessages":
            return unsubscribeBrowserUiWorkerMessages(String(args[0]), workerListeners);
        case "showContextMenu":
            return electron_1.ipcRenderer.invoke(DESKTOP_SHOW_CONTEXT_MENU, args[0]);
        case "showApplicationMenu":
            return electron_1.ipcRenderer.invoke(DESKTOP_SHOW_APPLICATION_MENU, {
                menuId: args[0],
                x: args[1],
                y: args[2],
            });
        case "getFastModeRolloutMetrics":
            return electron_1.ipcRenderer.invoke(DESKTOP_GET_FAST_MODE_ROLLOUT_METRICS, args[0]);
        case "triggerSentryTestError":
            return electron_1.ipcRenderer.invoke(DESKTOP_TRIGGER_SENTRY_TEST);
        default:
            throw new Error(`Unknown Tweakers browser UI bridge method: ${method}`);
    }
}
function subscribeBrowserUiWorkerMessages(workerId, workerListeners) {
    if (!/^[a-zA-Z0-9._:-]+$/.test(workerId))
        throw new Error("invalid worker id");
    if (workerListeners.has(workerId))
        return true;
    const listener = (_event, message) => {
        electron_1.ipcRenderer.send(BROWSER_UI_WORKER_MESSAGE, workerId, message);
    };
    workerListeners.set(workerId, listener);
    electron_1.ipcRenderer.on(desktopWorkerForViewChannel(workerId), listener);
    return true;
}
function unsubscribeBrowserUiWorkerMessages(workerId, workerListeners) {
    const listener = workerListeners.get(workerId);
    if (!listener)
        return true;
    workerListeners.delete(workerId);
    electron_1.ipcRenderer.removeListener(desktopWorkerForViewChannel(workerId), listener);
    return true;
}
//# sourceMappingURL=index.js.map