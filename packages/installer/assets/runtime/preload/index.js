"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const react_hook_1 = require("./react-hook");
const settings_injector_1 = require("./settings-injector");
const tweak_host_1 = require("./tweak-host");
const manager_1 = require("./manager");
const desktop_update_indicator_1 = require("./desktop-update-indicator");
const reload_focus_1 = require("./reload-focus");
const BROWSER_UI_CONNECT_PORT = "tweaker:browser-ui-connect-app-host";
const BROWSER_UI_BRIDGE_REQUEST = "tweaker:browser-ui-bridge-request";
const BROWSER_UI_BRIDGE_RESPONSE = "tweaker:browser-ui-bridge-response";
const BROWSER_UI_MESSAGE_FOR_VIEW = "tweaker:browser-ui-message-for-view";
const BROWSER_UI_WORKER_MESSAGE = "tweaker:browser-ui-worker-message";
const BROWSER_UI_SYSTEM_THEME = "tweaker:browser-ui-system-theme";
const PROMOTION_RENDERER_IPC_CHANNEL = "tweaker:promotion-renderer-proof";
const PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
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
    const msg = `[tweaker preload] ${stage}${extra === undefined ? "" : " " + safeStringify(extra)}`;
    try {
        console.error(msg);
    }
    catch { }
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
const promotionNonce = promotionRendererNonce(location.href);
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
else {
    queueMicrotask(() => {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", boot, { once: true });
        }
        else {
            boot();
        }
    });
}
function promotionRendererNonce(href) {
    try {
        const parsed = new URL(href);
        if (parsed.protocol !== "app:" || parsed.hostname !== "-" || parsed.pathname !== "/index.html")
            return null;
        const nonce = parsed.searchParams.get(PROMOTION_RENDERER_NONCE_QUERY);
        return nonce && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
            ? nonce
            : null;
    }
    catch {
        return null;
    }
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
    queueMicrotask(() => {
        const observationRoot = document.documentElement;
        if (!observationRoot) {
            fileLog("promotion renderer mount proof incomplete", { reason: "document root unavailable" });
            return;
        }
        observer = new MutationObserver(inspect);
        observer.observe(observationRoot, { childList: true, subtree: true });
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
    });
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
async function boot() {
    fileLog("boot start", { readyState: document.readyState });
    try {
        (0, desktop_update_indicator_1.startDesktopUpdateIndicator)();
        fileLog("desktop update indicator started");
        (0, settings_injector_1.startSettingsInjector)();
        fileLog("settings injector started");
        await (0, tweak_host_1.startTweakHost)();
        fileLog("tweak host started");
        await (0, manager_1.mountManager)();
        fileLog("manager mounted");
        subscribeReload();
        fileLog("boot complete");
    }
    catch (e) {
        fileLog("boot FAILED", String(e?.stack ?? e));
        console.error("[tweaker] preload boot failed:", e);
    }
}
// Hot reload: gated behind a small in-flight lock so a flurry of fs events
// doesn't reentrantly tear down the host mid-load.
let reloading = null;
function subscribeReload() {
    electron_1.ipcRenderer.on("tweaker:tweaks-changed", () => {
        if (reloading)
            return;
        reloading = (async () => {
            const focusSnapshot = (0, reload_focus_1.captureTweakReloadFocus)(document);
            try {
                console.info("[tweaker] hot-reloading tweaks");
                (0, tweak_host_1.teardownTweakHost)();
                await (0, tweak_host_1.startTweakHost)();
                await (0, manager_1.mountManager)();
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
    });
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