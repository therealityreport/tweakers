"use strict";
/**
 * Renderer-side tweak host. We:
 *   1. Ask main for the tweak list (with resolved entry path).
 *   2. For each renderer-scoped (or "both") tweak, fetch its source via IPC
 *      and execute it as a CommonJS-shaped function.
 *   3. Provide it the renderer half of the API.
 *
 * Codex runs the renderer with sandbox: true, so Node's `require()` is
 * restricted to a tiny whitelist (electron + a few polyfills). That means we
 * cannot `require()` arbitrary tweak files from disk. Instead we pull the
 * source string from main and evaluate it with `new Function` inside the
 * preload context. Tweak authors who need npm deps must bundle them in.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rendererStorage = void 0;
exports.startTweakHost = startTweakHost;
exports.teardownTweakHost = teardownTweakHost;
const electron_1 = require("electron");
const settings_injector_1 = require("./settings-injector");
const react_hook_1 = require("./react-hook");
const host_surfaces_1 = require("./host-surfaces");
const tweak_lifecycle_1 = require("../tweak-lifecycle");
const renderer_storage_1 = require("../renderer-storage");
const loaded = new Map();
let cachedPaths = null;
async function startTweakHost() {
    const tweaks = (await electron_1.ipcRenderer.invoke("tweaker:list-tweaks"));
    const paths = (await electron_1.ipcRenderer.invoke("tweaker:user-paths"));
    cachedPaths = paths;
    // Push the list to the settings injector so the Tweaks page can render
    // cards even before any tweak's start() runs (and for disabled tweaks
    // that we never load).
    (0, settings_injector_1.setListedTweaks)(tweaks);
    // Stash for the settings injector's empty-state message.
    window.__tweaker_tweaks_dir__ =
        paths.tweaksDir;
    for (const t of tweaks) {
        if (t.manifest.scope === "main") {
            sendLifecycle(t.manifest.id, "disabled", "main-scoped tweak");
            continue;
        }
        if (!t.entryExists) {
            sendLifecycle(t.manifest.id, "disabled", "missing entry");
            continue;
        }
        if (!t.enabled) {
            sendLifecycle(t.manifest.id, t.status === "quarantined" ? "quarantined" : "disabled");
            continue;
        }
        sendLifecycle(t.manifest.id, "starting");
        try {
            const result = await (0, tweak_lifecycle_1.runWithStartupTimeout)(() => loadTweak(t, paths), tweak_lifecycle_1.DEFAULT_TWEAK_STARTUP_TIMEOUT_MS);
            if (result.status === "timed_out") {
                sendLifecycle(t.manifest.id, "timed_out", `startup exceeded ${tweak_lifecycle_1.DEFAULT_TWEAK_STARTUP_TIMEOUT_MS}ms`);
                console.error("[tweaker] tweak startup timed out:", t.manifest.id);
            }
            else {
                sendLifecycle(t.manifest.id, "ready");
            }
        }
        catch (e) {
            sendLifecycle(t.manifest.id, "failed", e);
            console.error("[tweaker] tweak load failed:", t.manifest.id, e);
            try {
                electron_1.ipcRenderer.send("tweaker:preload-log", "error", "tweak load failed: " + t.manifest.id + ": " + String(e?.stack ?? e));
            }
            catch { }
        }
    }
    console.info(`[tweaker] renderer host loaded ${loaded.size} tweak(s):`, [...loaded.keys()].join(", ") || "(none)");
    electron_1.ipcRenderer.send("tweaker:preload-log", "info", `renderer host loaded ${loaded.size} tweak(s): ${[...loaded.keys()].join(", ") || "(none)"}`);
}
function sendLifecycle(id, status, error) {
    const rendererLifecycle = status === "disabled" && error === "missing entry" ? "failed"
        : status === "starting" ? "starting"
            : status === "failed" ? "failed"
                : status === "timed_out" ? "timed_out"
                    : status === "quarantined" ? "quarantined"
                        : "enabled";
    (0, settings_injector_1.updateListedTweakLifecycle)(id, rendererLifecycle, error === undefined ? undefined : error instanceof Error ? error.message : String(error));
    try {
        electron_1.ipcRenderer.send("tweaker:tweak-lifecycle", {
            id,
            process: "renderer",
            status,
            ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
        });
    }
    catch {
        // Lifecycle telemetry must never take down the renderer host.
    }
}
/**
 * Stop every renderer-scope tweak so a subsequent `startTweakHost()` will
 * re-evaluate fresh source. Module cache isn't relevant since we eval
 * source strings directly — each load creates a fresh scope.
 */
function teardownTweakHost() {
    for (const [id, t] of loaded) {
        try {
            t.stop?.();
        }
        catch (e) {
            console.warn("[tweaker] tweak stop failed:", id, e);
        }
        finally {
            void electron_1.ipcRenderer.invoke("tweaker:codex-view-dispose-tweak", id).catch(() => { });
            void electron_1.ipcRenderer.invoke("tweaker:native-dispose-tweak", id).catch(() => { });
        }
    }
    loaded.clear();
    (0, settings_injector_1.clearSections)();
}
async function loadTweak(t, paths) {
    const source = (await electron_1.ipcRenderer.invoke("tweaker:read-tweak-source", t.entry));
    // Evaluate as CJS-shaped: provide module/exports/api. Tweak code may use
    // `module.exports = { start, stop }` or `exports.start = ...` or pure ESM
    // default export shape (we accept both).
    const module = { exports: {} };
    const exports = module.exports;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function("module", "exports", "console", `${source}\n//# sourceURL=tweaker-tweak://${encodeURIComponent(t.manifest.id)}/${encodeURIComponent(t.entry)}`);
    fn(module, exports, console);
    const mod = module.exports;
    const tweak = mod.default ?? mod;
    if (typeof tweak?.start !== "function") {
        throw new Error(`tweak ${t.manifest.id} has no start()`);
    }
    const api = makeRendererApi(t.manifest, paths);
    await tweak.start(api);
    loaded.set(t.manifest.id, { stop: tweak.stop?.bind(tweak) });
}
function makeRendererApi(manifest, paths) {
    const id = manifest.id;
    const assertIpcPermission = () => {
        if (!manifest.permissions?.includes("ipc")) {
            throw new Error(`tweak ${id} must declare ipc permission`);
        }
    };
    const log = (level, ...a) => {
        const consoleFn = level === "debug" ? console.debug
            : level === "warn" ? console.warn
                : level === "error" ? console.error
                    : console.log;
        consoleFn(`[tweaker][${id}]`, ...a);
        // Also mirror to main's log file so we can diagnose tweak behavior
        // without attaching DevTools. Stringify each arg defensively.
        try {
            const parts = a.map((v) => {
                if (typeof v === "string")
                    return v;
                if (v instanceof Error)
                    return `${v.name}: ${v.message}`;
                try {
                    return JSON.stringify(v);
                }
                catch {
                    return String(v);
                }
            });
            electron_1.ipcRenderer.send("tweaker:preload-log", level, `[tweak ${id}] ${parts.join(" ")}`);
        }
        catch {
            /* swallow — never let logging break a tweak */
        }
    };
    return {
        manifest,
        process: "renderer",
        log: {
            debug: (...a) => log("debug", ...a),
            info: (...a) => log("info", ...a),
            warn: (...a) => log("warn", ...a),
            error: (...a) => log("error", ...a),
        },
        storage: (0, exports.rendererStorage)(id),
        settings: {
            register: (s) => (0, settings_injector_1.registerSection)({ ...s, id: `${id}:${s.id}` }),
            registerPage: (p) => (0, settings_injector_1.registerPage)(id, manifest, { ...p, id: `${id}:${p.id}` }),
            openPage: (pageId) => (0, settings_injector_1.openRegisteredPage)(id, `${id}:${pageId}`),
        },
        react: {
            getFiber: (n) => (0, react_hook_1.fiberForNode)(n),
            findOwnerByName: (n, name) => {
                let f = (0, react_hook_1.fiberForNode)(n);
                while (f) {
                    const t = f.type;
                    if (t && (t.displayName === name || t.name === name))
                        return f;
                    f = f.return;
                }
                return null;
            },
            waitForElement: (sel, timeoutMs = 5000) => new Promise((resolve, reject) => {
                const existing = document.querySelector(sel);
                if (existing)
                    return resolve(existing);
                const deadline = Date.now() + timeoutMs;
                const obs = new MutationObserver(() => {
                    const el = document.querySelector(sel);
                    if (el) {
                        obs.disconnect();
                        resolve(el);
                    }
                    else if (Date.now() > deadline) {
                        obs.disconnect();
                        reject(new Error(`timeout waiting for ${sel}`));
                    }
                });
                obs.observe(document.documentElement, { childList: true, subtree: true });
            }),
            host: host_surfaces_1.hostUiApi,
        },
        ipc: {
            on: (c, h) => {
                assertIpcPermission();
                const wrapped = (_e, ...args) => h(...args);
                electron_1.ipcRenderer.on(`tweaker:${id}:${c}`, wrapped);
                return () => electron_1.ipcRenderer.removeListener(`tweaker:${id}:${c}`, wrapped);
            },
            send: (c, ...args) => {
                assertIpcPermission();
                electron_1.ipcRenderer.send(`tweaker:${id}:${c}`, ...args);
            },
            invoke: (c, ...args) => {
                assertIpcPermission();
                if (id === "co.tweakers.thread-summary-profiles" && c === "profiles.read") {
                    return electron_1.ipcRenderer.invoke("tweaker:cross-tweak-read", id, "co.tweakers.projects", "profiles.read", args[0]);
                }
                if (id === "co.tweakers.followup" && c === "policy") {
                    return electron_1.ipcRenderer.invoke("tweaker:cross-tweak-read", id, "co.tweakers.projects", "followup.policy.read", args[0]);
                }
                return electron_1.ipcRenderer.invoke(`tweaker:${id}:${c}`, ...args);
            },
        },
        fs: rendererFs(id, paths),
        codex: rendererCodexApi(id),
    };
}
function rendererCodexApi(tweakId) {
    return {
        runtime: {
            getInfo: async () => {
                const info = await electron_1.ipcRenderer.invoke("tweaker:codex-runtime-info");
                const bridge = rendererElectronBridge();
                return {
                    ...info,
                    buildFlavor: bridge?.getBuildFlavor?.() ?? info.buildFlavor,
                    usesOwlAppShell: bridge?.usesOwlAppShell?.() ?? info.usesOwlAppShell,
                };
            },
            getCapabilities: () => electron_1.ipcRenderer.invoke("tweaker:codex-runtime-capabilities"),
        },
        windows: {
            create: (options) => electron_1.ipcRenderer.invoke("tweaker:codex-window-create", options),
            getPrimary: () => electron_1.ipcRenderer.invoke("tweaker:codex-window-primary"),
            focus: (windowId) => electron_1.ipcRenderer.invoke("tweaker:codex-window-focus", windowId),
            show: (windowId) => electron_1.ipcRenderer.invoke("tweaker:codex-window-show", windowId),
        },
        views: {
            create: async (options) => {
                const ref = await electron_1.ipcRenderer.invoke("tweaker:codex-view-create", tweakId, options);
                return rendererCodexViewRef(tweakId, ref.id, ref.webContentsId, ref.parentWindowId);
            },
        },
        cdp: {
            getStatus: () => electron_1.ipcRenderer.invoke("tweaker:codex-cdp-status"),
            listTargets: () => electron_1.ipcRenderer.invoke("tweaker:codex-cdp-targets"),
        },
        native: {
            loadModule: async (options) => {
                const ref = await electron_1.ipcRenderer.invoke("tweaker:native-load-module", tweakId, options);
                return rendererNativeModuleRef(tweakId, ref.id, ref.kind);
            },
            createPanel: async (options) => {
                const ref = await electron_1.ipcRenderer.invoke("tweaker:native-create-panel", tweakId, options);
                return rendererNativePanelRef(tweakId, ref.id, ref.windowId);
            },
            attachView: async (options) => {
                const ref = await electron_1.ipcRenderer.invoke("tweaker:native-attach-view", tweakId, options);
                return rendererNativeViewRef(tweakId, ref.id);
            },
            launchHelper: async (options) => {
                const ref = await electron_1.ipcRenderer.invoke("tweaker:native-launch-helper", tweakId, options);
                return rendererNativeHelperRef(tweakId, ref.id, ref.pid);
            },
        },
        refresh: {
            getStatus: () => electron_1.ipcRenderer.invoke("tweaker:get-refresh-status"),
            start: (source = "smart") => electron_1.ipcRenderer.invoke("tweaker:start-local-refresh", source),
            onStatusChanged: (listener) => {
                const handler = () => { void electron_1.ipcRenderer.invoke("tweaker:get-refresh-status").then(listener); };
                electron_1.ipcRenderer.on("tweaker:refresh-status-changed", handler);
                return () => electron_1.ipcRenderer.removeListener("tweaker:refresh-status-changed", handler);
            },
        },
        capture: {
            getPermissionStatus: () => {
                throw new Error("api.codex.capture is main-only; use a main-scoped tweak");
            },
            requestAccessibility: () => {
                throw new Error("api.codex.capture is main-only; use a main-scoped tweak");
            },
            openPermissionSettings: () => {
                throw new Error("api.codex.capture is main-only; use a main-scoped tweak");
            },
            captureFrontmostWindow: () => {
                throw new Error("api.codex.capture is main-only; use a main-scoped tweak");
            },
        },
        hotkeys: {
            registerCaptureHotkey: () => {
                throw new Error("api.codex.hotkeys is main-only; use a main-scoped tweak");
            },
        },
        createBrowserView: (_options) => {
            throw new Error("api.codex.createBrowserView is main-only; use a main-scoped tweak");
        },
        createWindow: (options) => electron_1.ipcRenderer.invoke("tweaker:codex-window-create", options),
    };
}
function rendererCodexViewRef(tweakId, id, webContentsId, parentWindowId) {
    return {
        id,
        webContentsId,
        parentWindowId,
        setBounds: (bounds) => electron_1.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "setBounds", bounds),
        setVisible: (visible) => electron_1.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "setVisible", visible),
        bringToFront: () => electron_1.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "bringToFront"),
        loadRoute: (route, hostId) => electron_1.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "loadRoute", route, hostId),
        loadUrl: (url) => electron_1.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "loadUrl", url),
        dispose: () => electron_1.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "dispose"),
    };
}
function rendererNativeModuleRef(tweakId, id, kind) {
    return {
        id,
        kind,
        request: (method, payload, timeoutMs) => electron_1.ipcRenderer.invoke("tweaker:native-module-request", tweakId, id, method, payload, timeoutMs),
        dispose: () => electron_1.ipcRenderer.invoke("tweaker:native-module-dispose", tweakId, id),
    };
}
function rendererNativePanelRef(tweakId, id, windowId) {
    return {
        id,
        windowId,
        setBounds: (bounds) => electron_1.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "setBounds", bounds),
        show: () => electron_1.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "show"),
        hide: () => electron_1.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "hide"),
        dispose: () => electron_1.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "dispose"),
    };
}
function rendererNativeViewRef(tweakId, id) {
    return {
        id,
        setBounds: (bounds) => electron_1.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "view", id, "setBounds", bounds),
        setVisible: (visible) => electron_1.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "view", id, "setVisible", visible),
        dispose: () => electron_1.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "view", id, "dispose"),
    };
}
function rendererNativeHelperRef(tweakId, id, pid) {
    return {
        id,
        pid,
        send: (message) => electron_1.ipcRenderer.invoke("tweaker:native-helper-call", tweakId, id, "send", message),
        request: (message, timeoutMs) => electron_1.ipcRenderer.invoke("tweaker:native-helper-call", tweakId, id, "request", message, timeoutMs),
        stop: () => electron_1.ipcRenderer.invoke("tweaker:native-helper-call", tweakId, id, "stop"),
    };
}
function rendererElectronBridge() {
    const value = window.electronBridge;
    return value && typeof value === "object" ? value : null;
}
const rendererStorage = (id, storage = localStorage) => (0, renderer_storage_1.createRendererStorage)(id, storage);
exports.rendererStorage = rendererStorage;
function rendererFs(id, _paths) {
    // Sandboxed renderer can't use Node fs directly — proxy through main IPC.
    return {
        dataDir: `<remote>/tweak-data/${id}`,
        read: (p) => electron_1.ipcRenderer.invoke("tweaker:tweak-fs", "read", id, p),
        write: (p, c) => electron_1.ipcRenderer.invoke("tweaker:tweak-fs", "write", id, p, c),
        exists: (p) => electron_1.ipcRenderer.invoke("tweaker:tweak-fs", "exists", id, p),
    };
}
//# sourceMappingURL=tweak-host.js.map