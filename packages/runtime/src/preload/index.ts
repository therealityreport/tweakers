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

import { ipcRenderer } from "electron";
import { installReactHook } from "./react-hook";
import { startSettingsInjector } from "./settings-injector";
import { startTweakHost, teardownTweakHost } from "./tweak-host";
import { mountManager } from "./manager";
import { startDesktopUpdateIndicator } from "./desktop-update-indicator";
import {
  captureTweakReloadFocus,
  restoreTweakReloadFocus,
} from "./reload-focus";

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

function desktopWorkerFromViewChannel(workerId: string): string {
  return `codex_desktop:worker:${workerId}:from-view`;
}

function desktopWorkerForViewChannel(workerId: string): string {
  return `codex_desktop:worker:${workerId}:for-view`;
}

// File-log preload progress so we can diagnose without DevTools. Best-effort:
// failures here must never throw because we'd take the page down with us.
//
// Codex's renderer is sandboxed (sandbox: true), so `require("node:fs")` is
// unavailable. We forward log lines to main via IPC; main writes the file.
function fileLog(stage: string, extra?: unknown): void {
  const msg = `[tweaker preload] ${stage}${
    extra === undefined ? "" : " " + safeStringify(extra)
  }`;
  try {
    console.error(msg);
  } catch {}
  try {
    ipcRenderer.send("tweaker:preload-log", "info", msg);
  } catch {}
}
function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

fileLog("preload entry", { url: location.href });

const promotionNonce = promotionRendererNonce(location.href);
try {
  installBrowserUiHostBridge();
  fileLog("browser UI host bridge installed");
} catch (e) {
  fileLog("browser UI host bridge FAILED", String(e));
}

// React hook must be installed *before* Codex's bundle runs.
try {
  installReactHook();
  fileLog("react hook installed");
} catch (e) {
  fileLog("react hook FAILED", String(e));
}

if (promotionNonce) {
  schedulePromotionRendererProof(promotionNonce);
} else {
  queueMicrotask(() => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
  });
}

function promotionRendererNonce(href: string): string | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "app:" || parsed.hostname !== "-" || parsed.pathname !== "/index.html") return null;
    const nonce = parsed.searchParams.get(PROMOTION_RENDERER_NONCE_QUERY);
    return nonce && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
      ? nonce
      : null;
  } catch {
    return null;
  }
}

function schedulePromotionRendererProof(nonce: string): void {
  const mount = createPromotionRendererMountTracker();
  let observer: MutationObserver | null = null;
  let timeout: number | null = null;
  let settled = false;

  const cleanup = (): void => {
    observer?.disconnect();
    observer = null;
    if (timeout !== null) window.clearTimeout(timeout);
    timeout = null;
  };
  const inspect = (): void => {
    if (settled) return;
    const root = document.getElementById("root");
    const state = mount.observe({
      rootPresent: root !== null,
      startupLoaderPresent: root !== null && root.querySelector(":scope > .startup-loader") !== null,
      elementChildCount: root?.children.length ?? 0,
    });
    if (state !== "mounted") return;
    settled = true;
    cleanup();
    const rendererStorageSelfTest = promotionRendererStorageSelfTest(nonce);
    ipcRenderer.send(PROMOTION_RENDERER_IPC_CHANNEL, {
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
      if (settled) return;
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

function promotionRendererStorageSelfTest(nonce: string): "pass" | "fail" {
  const suffix = `promotion-health-${nonce}`;
  const currentId = `co.tweakers.${suffix}`;
  const currentKey = `tweaker:storage:${currentId}`;
  const legacyKey = `${["codex", "pp"].join("")}:storage:co.promotion-probe.${suffix}`;
  const raw = JSON.stringify({ retained: true, nonce });
  let archiveKey: string | null = null;
  let ownsProbeKeys = false;
  try {
    if (localStorage.getItem(currentKey) !== null || localStorage.getItem(legacyKey) !== null) return "fail";
    ownsProbeKeys = true;
    localStorage.setItem(legacyKey, raw);
    const prepared = prepareRendererStorageMigration(currentId, localStorage, nonce);
    if (prepared.status !== "prepared" || prepared.holdPromotion || localStorage.getItem(currentKey) !== raw) return "fail";
    const committed = commitRendererStorageMigration(prepared, localStorage);
    archiveKey = committed.archiveKey;
    if (committed.phase !== "committed" || !archiveKey || localStorage.getItem(legacyKey) !== null) return "fail";
    const rolledBack = rollbackRendererStorageMigration(committed, localStorage);
    return rolledBack.phase === "rolled_back"
      && localStorage.getItem(legacyKey) === raw
      && localStorage.getItem(currentKey) === null
      && localStorage.getItem(archiveKey) === null
      ? "pass"
      : "fail";
  } catch {
    return "fail";
  } finally {
    if (ownsProbeKeys) {
      try { localStorage.removeItem(currentKey); } catch {}
      try { localStorage.removeItem(legacyKey); } catch {}
      if (archiveKey) {
        try { localStorage.removeItem(archiveKey); } catch {}
      }
    }
  }
}

async function boot() {
  fileLog("boot start", { readyState: document.readyState });
  try {
    startDesktopUpdateIndicator();
    fileLog("desktop update indicator started");
    startSettingsInjector();
    fileLog("settings injector started");
    await startTweakHost();
    fileLog("tweak host started");
    await mountManager();
    fileLog("manager mounted");
    subscribeReload();
    fileLog("boot complete");
  } catch (e) {
    fileLog("boot FAILED", String((e as Error)?.stack ?? e));
    console.error("[tweaker] preload boot failed:", e);
  }
}

// Hot reload: gated behind a small in-flight lock so a flurry of fs events
// doesn't reentrantly tear down the host mid-load.
let reloading: Promise<void> | null = null;
function subscribeReload(): void {
  ipcRenderer.on("tweaker:tweaks-changed", () => {
    if (reloading) return;
    reloading = (async () => {
      const focusSnapshot = captureTweakReloadFocus(document);
      try {
        console.info("[tweaker] hot-reloading tweaks");
        teardownTweakHost();
        await startTweakHost();
        await mountManager();
      } catch (e) {
        console.error("[tweaker] hot reload failed:", e);
      } finally {
        window.requestAnimationFrame(() => {
          restoreTweakReloadFocus(focusSnapshot);
        });
        reloading = null;
      }
    })();
  });
}

function installBrowserUiHostBridge(): void {
  const workerListeners = new Map<string, (...args: unknown[]) => void>();

  ipcRenderer.on(BROWSER_UI_CONNECT_PORT, (event) => {
    const [port] = event.ports;
    if (!port) return;
    window.postMessage({ type: "connect-app-host", port }, "*", [port]);
  });

  ipcRenderer.on(BROWSER_UI_BRIDGE_REQUEST, async (_event, payload) => {
    const request = payload && typeof payload === "object"
      ? payload as { id?: unknown; method?: unknown; args?: unknown }
      : {};
    const id = typeof request.id === "string" ? request.id : "";
    const method = typeof request.method === "string" ? request.method : "";
    const args = Array.isArray(request.args) ? request.args : [];
    try {
      const value = await runBrowserUiBridgeMethod(method, args, workerListeners);
      ipcRenderer.send(BROWSER_UI_BRIDGE_RESPONSE, { id, ok: true, value });
    } catch (e) {
      ipcRenderer.send(BROWSER_UI_BRIDGE_RESPONSE, {
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  ipcRenderer.on(DESKTOP_MESSAGE_FOR_VIEW, (_event, message) => {
    ipcRenderer.send(BROWSER_UI_MESSAGE_FOR_VIEW, message);
  });

  ipcRenderer.on(DESKTOP_SYSTEM_THEME_UPDATED, (_event, value) => {
    ipcRenderer.send(BROWSER_UI_SYSTEM_THEME, value);
  });
}

async function runBrowserUiBridgeMethod(
  method: string,
  args: unknown[],
  workerListeners: Map<string, (...args: unknown[]) => void>,
): Promise<unknown> {
  switch (method) {
    case "snapshot":
      return ipcRenderer.sendSync(DESKTOP_GET_SHARED_OBJECT_SNAPSHOT) ?? {};
    case "systemTheme":
      return ipcRenderer.sendSync(DESKTOP_GET_SYSTEM_THEME_VARIANT);
    case "sentryOptions":
      return ipcRenderer.sendSync(DESKTOP_GET_SENTRY_INIT_OPTIONS);
    case "buildFlavor":
      return ipcRenderer.sendSync(DESKTOP_GET_BUILD_FLAVOR);
    case "usesOwlAppShell":
      return ipcRenderer.sendSync(DESKTOP_GET_USES_OWL_APP_SHELL) === true;
    case "sendMessageFromView":
      return ipcRenderer.invoke(DESKTOP_MESSAGE_FROM_VIEW, args[0]);
    case "sendWorkerMessageFromView":
      return ipcRenderer.invoke(desktopWorkerFromViewChannel(String(args[0])), args[1]);
    case "subscribeWorkerMessages":
      return subscribeBrowserUiWorkerMessages(String(args[0]), workerListeners);
    case "unsubscribeWorkerMessages":
      return unsubscribeBrowserUiWorkerMessages(String(args[0]), workerListeners);
    case "showContextMenu":
      return ipcRenderer.invoke(DESKTOP_SHOW_CONTEXT_MENU, args[0]);
    case "showApplicationMenu":
      return ipcRenderer.invoke(DESKTOP_SHOW_APPLICATION_MENU, {
        menuId: args[0],
        x: args[1],
        y: args[2],
      });
    case "getFastModeRolloutMetrics":
      return ipcRenderer.invoke(DESKTOP_GET_FAST_MODE_ROLLOUT_METRICS, args[0]);
    case "triggerSentryTestError":
      return ipcRenderer.invoke(DESKTOP_TRIGGER_SENTRY_TEST);
    default:
      throw new Error(`Unknown Tweakers browser UI bridge method: ${method}`);
  }
}

function subscribeBrowserUiWorkerMessages(
  workerId: string,
  workerListeners: Map<string, (...args: unknown[]) => void>,
): boolean {
  if (!/^[a-zA-Z0-9._:-]+$/.test(workerId)) throw new Error("invalid worker id");
  if (workerListeners.has(workerId)) return true;
  const listener = (_event: unknown, message: unknown) => {
    ipcRenderer.send(BROWSER_UI_WORKER_MESSAGE, workerId, message);
  };
  workerListeners.set(workerId, listener);
  ipcRenderer.on(desktopWorkerForViewChannel(workerId), listener);
  return true;
}

function unsubscribeBrowserUiWorkerMessages(
  workerId: string,
  workerListeners: Map<string, (...args: unknown[]) => void>,
): boolean {
  const listener = workerListeners.get(workerId);
  if (!listener) return true;
  workerListeners.delete(workerId);
  ipcRenderer.removeListener(desktopWorkerForViewChannel(workerId), listener);
  return true;
}
