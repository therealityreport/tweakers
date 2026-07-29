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

import { ipcRenderer } from "electron";
import { registerSection, registerPage, clearSections, setListedTweaks, updateListedTweakLifecycle } from "./settings-injector";
import { fiberForNode } from "./react-hook";
import { hostUiApi } from "./host-surfaces";
import { DEFAULT_TWEAK_STARTUP_TIMEOUT_MS, runWithStartupTimeout } from "../tweak-lifecycle";
import type { TweakHealthRecord, TweakStatus, TweakStoreEntry } from "../tweak-store";
import type {
  CodexCdpStatus,
  CodexCdpTarget,
  CodexRuntimeCapabilities,
  CodexRuntimeInfo,
  CodexViewRef,
  CodexWindowRef,
  NativeHelperLaunchOptions,
  NativeHelperRef,
  NativeModuleKind,
  NativeModuleLoadOptions,
  NativeModuleRef,
  NativePanelCreateOptions,
  NativePanelRef,
  NativeViewAttachOptions,
  NativeViewRef,
  TweakManifest,
  TweakApi,
  ReactFiberNode,
  Tweak,
} from "@therealityreport/tweakers-sdk";
import { createRendererStorage } from "../renderer-storage";

interface ListedTweak {
  manifest: TweakManifest;
  entry: string;
  dir: string;
  entryExists: boolean;
  installed: boolean;
  enabled: boolean;
  status: TweakStatus;
  health: TweakHealthRecord | null;
  catalog: TweakStoreEntry | null;
  update: {
    checkedAt: string;
    repo: string;
    currentVersion: string;
    latestVersion: string | null;
    latestTag: string | null;
    releaseUrl: string | null;
    updateAvailable: boolean;
    error?: string;
  } | null;
}

interface UserPaths {
  userRoot: string;
  runtimeDir: string;
  tweaksDir: string;
  logDir: string;
}

interface ElectronBridge {
  getBuildFlavor?: () => string | null;
  usesOwlAppShell?: () => boolean;
}

const loaded = new Map<string, { stop?: () => void }>();
let cachedPaths: UserPaths | null = null;

export async function startTweakHost(): Promise<void> {
  const tweaks = (await ipcRenderer.invoke("tweaker:list-tweaks")) as ListedTweak[];
  const paths = (await ipcRenderer.invoke("tweaker:user-paths")) as UserPaths;
  cachedPaths = paths;
  // Push the list to the settings injector so the Tweaks page can render
  // cards even before any tweak's start() runs (and for disabled tweaks
  // that we never load).
  setListedTweaks(tweaks);
  // Stash for the settings injector's empty-state message.
  (window as unknown as { __tweaker_tweaks_dir__?: string }).__tweaker_tweaks_dir__ =
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
      const result = await runWithStartupTimeout(
        () => loadTweak(t, paths),
        DEFAULT_TWEAK_STARTUP_TIMEOUT_MS,
      );
      if (result.status === "timed_out") {
        sendLifecycle(t.manifest.id, "timed_out", `startup exceeded ${DEFAULT_TWEAK_STARTUP_TIMEOUT_MS}ms`);
        console.error("[tweaker] tweak startup timed out:", t.manifest.id);
      } else {
        sendLifecycle(t.manifest.id, "ready");
      }
    } catch (e) {
      sendLifecycle(t.manifest.id, "failed", e);
      console.error("[tweaker] tweak load failed:", t.manifest.id, e);
      try {
        ipcRenderer.send(
          "tweaker:preload-log",
          "error",
          "tweak load failed: " + t.manifest.id + ": " + String((e as Error)?.stack ?? e),
        );
      } catch {}
    }
  }

  console.info(
    `[tweaker] renderer host loaded ${loaded.size} tweak(s):`,
    [...loaded.keys()].join(", ") || "(none)",
  );
  ipcRenderer.send(
    "tweaker:preload-log",
    "info",
    `renderer host loaded ${loaded.size} tweak(s): ${[...loaded.keys()].join(", ") || "(none)"}`,
  );
}

function sendLifecycle(
  id: string,
  status: "starting" | "ready" | "failed" | "timed_out" | "disabled" | "quarantined",
  error?: unknown,
): void {
  const rendererLifecycle = status === "disabled" && error === "missing entry" ? "failed"
    : status === "starting" ? "starting"
    : status === "failed" ? "failed"
    : status === "timed_out" ? "timed_out"
    : status === "quarantined" ? "quarantined"
    : "enabled";
  updateListedTweakLifecycle(id, rendererLifecycle, error === undefined ? undefined : error instanceof Error ? error.message : String(error));
  try {
    ipcRenderer.send("tweaker:tweak-lifecycle", {
      id,
      process: "renderer",
      status,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    });
  } catch {
    // Lifecycle telemetry must never take down the renderer host.
  }
}

/**
 * Stop every renderer-scope tweak so a subsequent `startTweakHost()` will
 * re-evaluate fresh source. Module cache isn't relevant since we eval
 * source strings directly — each load creates a fresh scope.
 */
export function teardownTweakHost(): void {
  for (const [id, t] of loaded) {
    try {
      t.stop?.();
    } catch (e) {
      console.warn("[tweaker] tweak stop failed:", id, e);
    } finally {
      void ipcRenderer.invoke("tweaker:codex-view-dispose-tweak", id).catch(() => {});
      void ipcRenderer.invoke("tweaker:native-dispose-tweak", id).catch(() => {});
    }
  }
  loaded.clear();
  clearSections();
}

async function loadTweak(t: ListedTweak, paths: UserPaths): Promise<void> {
  const source = (await ipcRenderer.invoke(
    "tweaker:read-tweak-source",
    t.entry,
  )) as string;

  // Evaluate as CJS-shaped: provide module/exports/api. Tweak code may use
  // `module.exports = { start, stop }` or `exports.start = ...` or pure ESM
  // default export shape (we accept both).
  const module = { exports: {} as { default?: Tweak } & Tweak };
  const exports = module.exports;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(
    "module",
    "exports",
    "console",
    `${source}\n//# sourceURL=tweaker-tweak://${encodeURIComponent(t.manifest.id)}/${encodeURIComponent(t.entry)}`,
  );
  fn(module, exports, console);
  const mod = module.exports as { default?: Tweak } & Tweak;
  const tweak: Tweak = (mod as { default?: Tweak }).default ?? (mod as Tweak);
  if (typeof tweak?.start !== "function") {
    throw new Error(`tweak ${t.manifest.id} has no start()`);
  }
  const api = makeRendererApi(t.manifest, paths);
  await tweak.start(api);
  loaded.set(t.manifest.id, { stop: tweak.stop?.bind(tweak) });
}

function makeRendererApi(manifest: TweakManifest, paths: UserPaths): TweakApi {
  const id = manifest.id;
  const assertIpcPermission = () => {
    if (!manifest.permissions?.includes("ipc")) {
      throw new Error(`tweak ${id} must declare ipc permission`);
    }
  };
  const log = (level: "debug" | "info" | "warn" | "error", ...a: unknown[]) => {
    const consoleFn =
      level === "debug" ? console.debug
      : level === "warn" ? console.warn
      : level === "error" ? console.error
      : console.log;
    consoleFn(`[tweaker][${id}]`, ...a);
    // Also mirror to main's log file so we can diagnose tweak behavior
    // without attaching DevTools. Stringify each arg defensively.
    try {
      const parts = a.map((v) => {
        if (typeof v === "string") return v;
        if (v instanceof Error) return `${v.name}: ${v.message}`;
        try { return JSON.stringify(v); } catch { return String(v); }
      });
      ipcRenderer.send(
        "tweaker:preload-log",
        level,
        `[tweak ${id}] ${parts.join(" ")}`,
      );
    } catch {
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
    storage: rendererStorage(id),
    settings: {
      register: (s) => registerSection({ ...s, id: `${id}:${s.id}` }),
      registerPage: (p) =>
        registerPage(id, manifest, { ...p, id: `${id}:${p.id}` }),
    },
    react: {
      getFiber: (n) => fiberForNode(n) as ReactFiberNode | null,
      findOwnerByName: (n, name) => {
        let f = fiberForNode(n) as ReactFiberNode | null;
        while (f) {
          const t = f.type as { displayName?: string; name?: string } | null;
          if (t && (t.displayName === name || t.name === name)) return f;
          f = f.return;
        }
        return null;
      },
      waitForElement: (sel, timeoutMs = 5000) =>
        new Promise((resolve, reject) => {
          const existing = document.querySelector(sel);
          if (existing) return resolve(existing);
          const deadline = Date.now() + timeoutMs;
          const obs = new MutationObserver(() => {
            const el = document.querySelector(sel);
            if (el) {
              obs.disconnect();
              resolve(el);
            } else if (Date.now() > deadline) {
              obs.disconnect();
              reject(new Error(`timeout waiting for ${sel}`));
            }
          });
          obs.observe(document.documentElement, { childList: true, subtree: true });
        }),
      host: hostUiApi,
    },
    ipc: {
      on: (c, h) => {
        assertIpcPermission();
        const wrapped = (_e: unknown, ...args: unknown[]) => h(...args);
        ipcRenderer.on(`tweaker:${id}:${c}`, wrapped);
        return () => ipcRenderer.removeListener(`tweaker:${id}:${c}`, wrapped);
      },
      send: (c, ...args) => {
        assertIpcPermission();
        ipcRenderer.send(`tweaker:${id}:${c}`, ...args);
      },
      invoke: <T>(c: string, ...args: unknown[]) => {
        assertIpcPermission();
        if (id === "co.tweakers.thread-summary-profiles" && c === "profiles.read") {
          return ipcRenderer.invoke(
            "tweaker:cross-tweak-read",
            id,
            "co.tweakers.projects",
            "profiles.read",
            args[0],
          ) as Promise<T>;
        }
        if (id === "co.tweakers.followup" && c === "policy") {
          return ipcRenderer.invoke(
            "tweaker:cross-tweak-read",
            id,
            "co.tweakers.projects",
            "followup.policy.read",
            args[0],
          ) as Promise<T>;
        }
        return ipcRenderer.invoke(`tweaker:${id}:${c}`, ...args) as Promise<T>;
      },
    },
    fs: rendererFs(id, paths),
    codex: rendererCodexApi(id),
  };
}

function rendererCodexApi(tweakId: string): NonNullable<TweakApi["codex"]> {
  return {
    runtime: {
      getInfo: async () => {
        const info = await ipcRenderer.invoke("tweaker:codex-runtime-info") as CodexRuntimeInfo;
        const bridge = rendererElectronBridge();
        return {
          ...info,
          buildFlavor: bridge?.getBuildFlavor?.() ?? info.buildFlavor,
          usesOwlAppShell: bridge?.usesOwlAppShell?.() ?? info.usesOwlAppShell,
        };
      },
      getCapabilities: () =>
        ipcRenderer.invoke("tweaker:codex-runtime-capabilities") as Promise<CodexRuntimeCapabilities>,
    },
    windows: {
      create: (options) =>
        ipcRenderer.invoke("tweaker:codex-window-create", options) as Promise<CodexWindowRef>,
      getPrimary: () =>
        ipcRenderer.invoke("tweaker:codex-window-primary") as Promise<CodexWindowRef | null>,
      focus: (windowId) =>
        ipcRenderer.invoke("tweaker:codex-window-focus", windowId) as Promise<boolean>,
      show: (windowId) =>
        ipcRenderer.invoke("tweaker:codex-window-show", windowId) as Promise<boolean>,
    },
    views: {
      create: async (options) => {
        const ref = await ipcRenderer.invoke(
          "tweaker:codex-view-create",
          tweakId,
          options,
        ) as { id: string; webContentsId: number; parentWindowId: number | null };
        return rendererCodexViewRef(tweakId, ref.id, ref.webContentsId, ref.parentWindowId);
      },
    },
    cdp: {
      getStatus: () =>
        ipcRenderer.invoke("tweaker:codex-cdp-status") as Promise<CodexCdpStatus>,
      listTargets: () =>
        ipcRenderer.invoke("tweaker:codex-cdp-targets") as Promise<CodexCdpTarget[]>,
    },
    native: {
      loadModule: async (options) => {
        const ref = await ipcRenderer.invoke(
          "tweaker:native-load-module",
          tweakId,
          options,
        ) as { id: string; kind: NativeModuleKind };
        return rendererNativeModuleRef(tweakId, ref.id, ref.kind);
      },
      createPanel: async (options) => {
        const ref = await ipcRenderer.invoke(
          "tweaker:native-create-panel",
          tweakId,
          options,
        ) as { id: string; windowId: number | null };
        return rendererNativePanelRef(tweakId, ref.id, ref.windowId);
      },
      attachView: async (options) => {
        const ref = await ipcRenderer.invoke(
          "tweaker:native-attach-view",
          tweakId,
          options,
        ) as { id: string };
        return rendererNativeViewRef(tweakId, ref.id);
      },
      launchHelper: async (options) => {
        const ref = await ipcRenderer.invoke(
          "tweaker:native-launch-helper",
          tweakId,
          options,
        ) as { id: string; pid: number };
        return rendererNativeHelperRef(tweakId, ref.id, ref.pid);
      },
    },
    refresh: {
      getStatus: () => ipcRenderer.invoke("tweaker:get-refresh-status"),
      start: (source = "smart") => ipcRenderer.invoke("tweaker:start-local-refresh", source),
      onStatusChanged: (listener) => {
        const handler = () => { void ipcRenderer.invoke("tweaker:get-refresh-status").then(listener); };
        ipcRenderer.on("tweaker:refresh-status-changed", handler);
        return () => ipcRenderer.removeListener("tweaker:refresh-status-changed", handler);
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
    createWindow: (options) =>
      ipcRenderer.invoke("tweaker:codex-window-create", options) as Promise<CodexWindowRef>,
  };
}

function rendererCodexViewRef(
  tweakId: string,
  id: string,
  webContentsId: number,
  parentWindowId: number | null,
): CodexViewRef {
  return {
    id,
    webContentsId,
    parentWindowId,
    setBounds: (bounds) =>
      ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "setBounds", bounds) as Promise<void>,
    setVisible: (visible) =>
      ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "setVisible", visible) as Promise<void>,
    bringToFront: () =>
      ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "bringToFront") as Promise<void>,
    loadRoute: (route, hostId) =>
      ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "loadRoute", route, hostId) as Promise<void>,
    loadUrl: (url) =>
      ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "loadUrl", url) as Promise<void>,
    dispose: () =>
      ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "dispose") as Promise<void>,
  };
}

function rendererNativeModuleRef(
  tweakId: string,
  id: string,
  kind: NativeModuleKind,
): NativeModuleRef {
  return {
    id,
    kind,
    request: (method, payload, timeoutMs) =>
      ipcRenderer.invoke(
        "tweaker:native-module-request",
        tweakId,
        id,
        method,
        payload,
        timeoutMs,
      ),
    dispose: () =>
      ipcRenderer.invoke("tweaker:native-module-dispose", tweakId, id) as Promise<void>,
  };
}

function rendererNativePanelRef(tweakId: string, id: string, windowId: number | null): NativePanelRef {
  return {
    id,
    windowId,
    setBounds: (bounds) =>
      ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "setBounds", bounds) as Promise<void>,
    show: () =>
      ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "show") as Promise<void>,
    hide: () =>
      ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "hide") as Promise<void>,
    dispose: () =>
      ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "dispose") as Promise<void>,
  };
}

function rendererNativeViewRef(tweakId: string, id: string): NativeViewRef {
  return {
    id,
    setBounds: (bounds) =>
      ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "view", id, "setBounds", bounds) as Promise<void>,
    setVisible: (visible) =>
      ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "view", id, "setVisible", visible) as Promise<void>,
    dispose: () =>
      ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "view", id, "dispose") as Promise<void>,
  };
}

function rendererNativeHelperRef(tweakId: string, id: string, pid: number): NativeHelperRef {
  return {
    id,
    pid,
    send: (message) =>
      ipcRenderer.invoke("tweaker:native-helper-call", tweakId, id, "send", message) as Promise<void>,
    request: (message, timeoutMs) =>
      ipcRenderer.invoke(
        "tweaker:native-helper-call",
        tweakId,
        id,
        "request",
        message,
        timeoutMs,
      ),
    stop: () =>
      ipcRenderer.invoke("tweaker:native-helper-call", tweakId, id, "stop") as Promise<void>,
  };
}

function rendererElectronBridge(): ElectronBridge | null {
  const value = (window as unknown as { electronBridge?: unknown }).electronBridge;
  return value && typeof value === "object" ? value as ElectronBridge : null;
}

export const rendererStorage = (id: string, storage: Storage = localStorage) => createRendererStorage(id, storage);

function rendererFs(id: string, _paths: UserPaths) {
  // Sandboxed renderer can't use Node fs directly — proxy through main IPC.
  return {
    dataDir: `<remote>/tweak-data/${id}`,
    read: (p: string) =>
      ipcRenderer.invoke("tweaker:tweak-fs", "read", id, p) as Promise<string>,
    write: (p: string, c: string) =>
      ipcRenderer.invoke("tweaker:tweak-fs", "write", id, p, c) as Promise<void>,
    exists: (p: string) =>
      ipcRenderer.invoke("tweaker:tweak-fs", "exists", id, p) as Promise<boolean>,
  };
}
