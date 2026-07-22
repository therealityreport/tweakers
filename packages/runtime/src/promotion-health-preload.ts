import { ipcRenderer } from "electron";
import { verifyRendererStorageRollback } from "./renderer-storage";
import { createPromotionOriginalRendererMountLifecycle } from "./preload/promotion-original-renderer-lifecycle";
import { createPromotionRendererMountTracker } from "./preload/promotion-renderer-mount";

// Keep this dedicated sandbox preload browser-only. Importing the main-process
// promotion module would pull node:fs/crypto/path into a renderer bundle.
// Source-integration tests bind these exact constants to the main module.
const PROMOTION_ORIGINAL_RENDERER_URL = "app://-/index.html";
const PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL = "tweaker:promotion-original-renderer-authorize";
const PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL = "tweaker:promotion-original-renderer-proof";
const PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
const PROMOTION_ORIGINAL_RENDERER_QUERY_KEYS = new Set(["hostId", "initialRoute"]);
const effectiveRendererSandboxed = process.sandboxed === true;

// Kept five seconds below the main-process mount phase so this exact, bound
// failure is observed and cleaned up before the outer mount deadline can fire.
const MOUNT_TIMEOUT_MS = 55_000;

type Authorization = { version: 1; nonce: string; url: string };

function canonicalOriginalRendererUrl(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 8_192
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "app:"
    || parsed.hostname !== "-"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.port !== ""
    || parsed.pathname !== "/index.html"
    || parsed.hash !== ""
    || parsed.searchParams.has(PROMOTION_RENDERER_NONCE_QUERY)
    || parsed.toString() !== value
  ) return null;
  const queryKeys = [...parsed.searchParams.keys()];
  if (
    queryKeys.some((key) => !PROMOTION_ORIGINAL_RENDERER_QUERY_KEYS.has(key))
    || new Set(queryKeys).size !== queryKeys.length
  ) return null;
  const hostId = parsed.searchParams.get("hostId");
  const initialRoute = parsed.searchParams.get("initialRoute");
  if (hostId !== null && !/^[A-Za-z0-9._:-]{1,256}$/.test(hostId)) return null;
  if (initialRoute !== null && (
    initialRoute.length === 0
    || initialRoute.length > 2_048
    || !initialRoute.startsWith("/")
    || /[\u0000-\u001f\u007f]/.test(initialRoute)
  )) return null;
  return value;
}

function parseExactAuthorization(value: unknown, expectedUrl: string): Authorization | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "nonce,url,version"
    && record.version === 1
    && typeof record.nonce === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.nonce)
    && record.url === expectedUrl
    ? record as Authorization
    : null;
}

// This entry is registered only for the disposable original-main health mode.
// It runs before page parsing and trusts no environment, argv, or URL nonce.
const unmodifiedUrl = location.href;
const canonicalUrl = canonicalOriginalRendererUrl(unmodifiedUrl);
let authorization: unknown = null;
if (canonicalUrl !== null) {
  try {
    authorization = ipcRenderer.sendSync(PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL, {
      version: 1,
      url: canonicalUrl,
      rendererSandboxed: effectiveRendererSandboxed,
    });
  } catch {
    authorization = null;
  }
}

const parsedAuthorization = canonicalUrl === null
  ? null
  : parseExactAuthorization(authorization, canonicalUrl);
if (parsedAuthorization) {
  observeOriginalRendererMount(parsedAuthorization);
}

function observeOriginalRendererMount(authorized: Authorization): void {
  const mount = createPromotionRendererMountTracker();
  let observer: MutationObserver | null = null;
  const stopObserving = (): void => {
    window.removeEventListener("load", onWindowLoad);
    observer?.disconnect();
  };
  const lifecycle = createPromotionOriginalRendererMountLifecycle({
    timeoutMs: MOUNT_TIMEOUT_MS,
    onMounted() {
      stopObserving();
      ipcRenderer.send(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, {
        nonce: authorized.nonce,
        url: unmodifiedUrl,
        lifecycle: "renderer-mounted",
        rendererSandboxed: effectiveRendererSandboxed,
        rendererStorageSelfTest: verifyRendererStorageRollback(localStorage, authorized.nonce),
      });
    },
    onTimeout() {
      stopObserving();
      ipcRenderer.send(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, {
        nonce: authorized.nonce,
        url: unmodifiedUrl,
        lifecycle: "renderer-mount-timeout",
        rendererSandboxed: effectiveRendererSandboxed,
      });
    },
  });

  function onWindowLoad(): void {
    lifecycle.windowLoaded();
  }

  function inspect(): void {
    if (lifecycle.phase() === "settled") return;
    const root = document.getElementById("root");
    const state = mount.observe({
      rootPresent: root !== null,
      startupLoaderPresent: root !== null && root.querySelector(":scope > .startup-loader") !== null,
      elementChildCount: root?.children.length ?? 0,
    });
    if (state !== "mounted") return;
    lifecycle.mountObserved();
  }

  observer = new MutationObserver(inspect);
  window.addEventListener("load", onWindowLoad, { once: true });
  // The preload normally runs before load, but this closes the registration
  // race without granting another deadline or emitting twice.
  if (document.readyState === "complete") onWindowLoad();
  observer.observe(document, { childList: true, subtree: true });
  inspect();
}
