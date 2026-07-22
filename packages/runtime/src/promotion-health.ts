import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

export type HealthValue = "pass" | "fail" | "unknown";

export const PROMOTION_RENDERER_IPC_CHANNEL = "tweaker:promotion-renderer-proof";
export const PROMOTION_RENDERER_AUTH_CHANNEL = "tweaker:promotion-renderer-authorize";
export const PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
export const PROMOTION_RENDERER_SCHEME = "app";
export const PROMOTION_RENDERER_HOST = "-";
export const PROMOTION_ORIGINAL_RENDERER_URL = "app://-/index.html";
export const PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL = "tweaker:promotion-original-renderer-authorize";
export const PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL = "tweaker:promotion-original-renderer-proof";
export const PROMOTION_ORIGINAL_RENDERER_STARTUP_TIMEOUT_MS = 20_000;
export const PROMOTION_ORIGINAL_RENDERER_LOAD_TIMEOUT_MS = 75_000;
export const PROMOTION_ORIGINAL_RENDERER_MOUNT_TIMEOUT_MS = 60_000;
export const PROMOTION_ORIGINAL_RENDERER_PRELOAD_TIMEOUT_MS = 55_000;
export const PROMOTION_ORIGINAL_RENDERER_CLEANUP_BUDGET_MS = 5_000;
export const PROMOTION_HEALTH_REQUEST_MAX_AGE_MS = 200_000;
const PROMOTION_ORIGINAL_RENDERER_QUERY_KEYS = new Set(["hostId", "initialRoute"]);

export type PromotionOriginalRendererDeadlinePhase = "startup" | "load" | "mount" | "settled";

export interface PromotionOriginalRendererDeadlineScheduler {
  set(callback: () => void, timeoutMs: number): unknown;
  clear(handle: unknown): void;
}

export interface PromotionOriginalRendererDeadlineController {
  /** Arms the load phase only for the first exact canonical selection. */
  canonicalSelected(): boolean;
  /** Arms the mount phase only for the selected renderer's first completed load. */
  canonicalLoaded(): boolean;
  /** Permanently cancels the currently armed deadline. */
  settle(): void;
  phase(): PromotionOriginalRendererDeadlinePhase;
}

/**
 * One-shot, phase-relative deadline controller for the original renderer.
 * Repeated navigation, eligibility, authorization and load signals cannot
 * rearm or extend any phase.
 */
export function createPromotionOriginalRendererDeadlineController(options: {
  onTimeout: (phase: Exclude<PromotionOriginalRendererDeadlinePhase, "settled">) => void;
  scheduler?: PromotionOriginalRendererDeadlineScheduler;
  startupTimeoutMs?: number;
  loadTimeoutMs?: number;
  mountTimeoutMs?: number;
}): PromotionOriginalRendererDeadlineController {
  const scheduler = options.scheduler ?? {
    set(callback, timeoutMs) {
      const handle = setTimeout(callback, timeoutMs);
      handle.unref?.();
      return handle;
    },
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  const startupTimeoutMs = options.startupTimeoutMs ?? PROMOTION_ORIGINAL_RENDERER_STARTUP_TIMEOUT_MS;
  const loadTimeoutMs = options.loadTimeoutMs ?? PROMOTION_ORIGINAL_RENDERER_LOAD_TIMEOUT_MS;
  const mountTimeoutMs = options.mountTimeoutMs ?? PROMOTION_ORIGINAL_RENDERER_MOUNT_TIMEOUT_MS;
  let phase: PromotionOriginalRendererDeadlinePhase = "startup";
  let handle: unknown = null;

  const arm = (expectedPhase: Exclude<PromotionOriginalRendererDeadlinePhase, "settled">, timeoutMs: number): void => {
    handle = scheduler.set(() => {
      if (phase !== expectedPhase) return;
      handle = null;
      phase = "settled";
      options.onTimeout(expectedPhase);
    }, timeoutMs);
  };
  arm("startup", startupTimeoutMs);

  return {
    canonicalSelected() {
      if (phase !== "startup") return false;
      if (handle !== null) scheduler.clear(handle);
      phase = "load";
      arm("load", loadTimeoutMs);
      return true;
    },
    canonicalLoaded() {
      if (phase !== "load") return false;
      if (handle !== null) scheduler.clear(handle);
      phase = "mount";
      arm("mount", mountTimeoutMs);
      return true;
    },
    settle() {
      if (phase === "settled") return;
      if (handle !== null) scheduler.clear(handle);
      handle = null;
      phase = "settled";
    },
    phase() {
      return phase;
    },
  };
}

/**
 * Accept the production Owl document, including its exact observed query,
 * without accepting a synthetic proof nonce or URL normalization ambiguity.
 */
export function canonicalPromotionOriginalRendererUrl(value: unknown): string | null {
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
  if (hostId !== null && (!/^[A-Za-z0-9._:-]{1,256}$/.test(hostId))) return null;
  if (initialRoute !== null && (
    initialRoute.length === 0
    || initialRoute.length > 2_048
    || !initialRoute.startsWith("/")
    || /[\u0000-\u001f\u007f]/.test(initialRoute)
  )) return null;
  return value;
}

export function promotionOriginalRendererEvidenceUrl(value: string | null): {
  canonicalUrl: typeof PROMOTION_ORIGINAL_RENDERER_URL | null;
  queryKeys: string[];
} {
  if (value === null || canonicalPromotionOriginalRendererUrl(value) === null) {
    return { canonicalUrl: null, queryKeys: [] };
  }
  return {
    canonicalUrl: PROMOTION_ORIGINAL_RENDERER_URL,
    queryKeys: [...new URL(value).searchParams.keys()].sort(),
  };
}

export function promotionOriginalRendererLogUrl(value: unknown): string {
  if (typeof value !== "string") return "[redacted-url]";
  const evidence = promotionOriginalRendererEvidenceUrl(value);
  if (evidence.canonicalUrl === null) return "[redacted-url]";
  return evidence.queryKeys.length === 0
    ? evidence.canonicalUrl
    : `${evidence.canonicalUrl}?[${evidence.queryKeys.join(",")}:redacted]`;
}

export interface PromotionOriginalRendererAuthorizationContext {
  windowAlive: boolean;
  windowHidden: boolean;
  senderMatches: boolean;
  frameMatches: boolean;
  senderUrl: string;
  consumed: boolean;
}

export type PromotionOriginalRendererAuthorizationDecision =
  | { accepted: false; reason: string; response: null }
  | { accepted: true; reason: "accepted"; response: { version: 1; nonce: string; url: string } };

/**
 * Requires one unambiguous main-process metric for the renderer OS process.
 * ProcessMetric.sandboxed is optional even on supported platforms, so only an
 * explicit true is positive evidence; absent, duplicate, or malformed data
 * fails closed before the authorization nonce can leave the main process.
 */
export function hasUniqueSandboxedPromotionRendererProcess(
  processMetrics: unknown,
  rendererProcessId: unknown,
): boolean {
  if (
    typeof rendererProcessId !== "number"
    || !Number.isSafeInteger(rendererProcessId)
    || rendererProcessId <= 0
    || !Array.isArray(processMetrics)
    || processMetrics.length > 4_096
  ) return false;
  let matchingMetric: Record<string, unknown> | null = null;
  for (const metric of processMetrics) {
    if (!plainRecord(metric) || metric.pid !== rendererProcessId) continue;
    if (matchingMetric !== null) return false;
    matchingMetric = metric;
  }
  return matchingMetric?.sandboxed === true;
}

/**
 * Authorizes the dedicated original-main preload synchronously. The renderer
 * sends only its unmodified canonical URL; the main process supplies the nonce
 * after binding the sender to the one hidden, safe BrowserWindow.
 */
export function authorizePromotionOriginalRenderer(
  context: PromotionOriginalRendererAuthorizationContext,
  payload: unknown,
  nonce: string,
): PromotionOriginalRendererAuthorizationDecision {
  if (!context.windowAlive) return { accepted: false, reason: "proof window unavailable", response: null };
  if (!context.windowHidden) return { accepted: false, reason: "proof window visible", response: null };
  if (!context.senderMatches) return { accepted: false, reason: "sender mismatch", response: null };
  if (!context.frameMatches) return { accepted: false, reason: "frame mismatch", response: null };
  const canonicalUrl = canonicalPromotionOriginalRendererUrl(context.senderUrl);
  if (canonicalUrl === null) {
    return { accepted: false, reason: "sender URL mismatch", response: null };
  }
  if (context.consumed) return { accepted: false, reason: "authorization already consumed", response: null };
  if (!plainRecord(payload) || !exactKeys(payload, ["rendererSandboxed", "url", "version"])) {
    return { accepted: false, reason: "payload invalid", response: null };
  }
  if (payload.version !== 1 || payload.url !== canonicalUrl || payload.rendererSandboxed !== true) {
    return { accepted: false, reason: "payload binding invalid", response: null };
  }
  if (!PROMOTION_RENDERER_NONCE_PATTERN.test(nonce)) {
    return { accepted: false, reason: "nonce invalid", response: null };
  }
  return {
    accepted: true,
    reason: "accepted",
    response: { version: 1, nonce, url: canonicalUrl },
  };
}

export interface PromotionOriginalRendererWindowObservation {
  webContentsId: number;
  url: string;
  isDefaultSession: boolean;
  /** Omission means Electron's default and must be proven in-renderer later. */
  sandbox?: boolean;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  originalPreloadValid: boolean;
}

export interface PromotionOriginalRendererProofSummary {
  capturedWindowCount: number;
  canonicalWebContentsId: number | null;
  canonicalUrl: string | null;
  authorized: boolean;
  didFinishLoad: boolean;
  mounted: boolean;
  originalPreload: boolean;
  preloadFailed: boolean;
  loadFailed: boolean;
  rendererExited: boolean;
  cleanup: "pending" | "pass" | "fail";
  failureReason: string | null;
}

export interface PromotionOriginalRendererProofTracker {
  windowCaptured(): void;
  eligibleWindow(observation: PromotionOriginalRendererWindowObservation): void;
  preloadError(webContentsId: number): void;
  authorization(webContentsId: number): void;
  didFinishLoad(webContentsId: number, url: string): void;
  rendererHandshake(observation: {
    webContentsId: number;
    nonce: string;
    url: string;
    lifecycle: string;
    rendererSandboxed: boolean;
    rendererStorageSelfTest: HealthValue;
  }): void;
  fail(reason: string, webContentsId?: number): void;
  cleanup(success: boolean): void;
  complete(): boolean;
  result(): PromotionRendererProofResult;
  summary(): PromotionOriginalRendererProofSummary;
}

/** Only the selected canonical main frame may poison provisional-load health. */
export function shouldFailPromotionOriginalRendererProvisionalLoad(input: {
  isMainFrame: boolean;
  webContentsId: number;
  canonicalWebContentsId: number | null;
}): boolean {
  return input.isMainFrame === true
    && Number.isSafeInteger(input.webContentsId)
    && input.webContentsId > 0
    && input.canonicalWebContentsId === input.webContentsId;
}

/** Pure state machine for the original Codex renderer promotion gate. */
export function createPromotionOriginalRendererProofTracker(
  nonce: string,
): PromotionOriginalRendererProofTracker {
  let capturedWindowCount = 0;
  let canonicalWebContentsId: number | null = null;
  let canonicalUrl: string | null = null;
  let authorized = false;
  let didFinishLoad = false;
  let mounted = false;
  let originalPreload = false;
  let preloadFailed = false;
  let loadFailed = false;
  let rendererExited = false;
  let rendererStorageSelfTest: HealthValue = "unknown";
  let cleanup: PromotionOriginalRendererProofSummary["cleanup"] = "pending";
  let failureReason: string | null = null;
  const preloadErrorIds = new Set<number>();
  const isCanonical = (id: number): boolean => canonicalWebContentsId === id;
  const permanentlyFail = (reason: string): void => {
    if (
      reason === "canonical renderer load failed"
      || reason === "canonical renderer provisional load failed"
    ) loadFailed = true;
    if (reason === "canonical renderer process exited") rendererExited = true;
    if (reason === "canonical original preload failed") preloadFailed = true;
    if (failureReason === null) {
      failureReason = reason.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
    }
    rendererStorageSelfTest = "fail";
  };
  return {
    windowCaptured() {
      capturedWindowCount += 1;
    },
    eligibleWindow(observation) {
      if (
        canonicalPromotionOriginalRendererUrl(observation.url) === null
        || !Number.isSafeInteger(observation.webContentsId)
        || observation.webContentsId <= 0
        || !observation.isDefaultSession
        || (observation.sandbox !== true && observation.sandbox !== undefined)
        || observation.contextIsolation !== true
        || observation.nodeIntegration !== false
        || observation.originalPreloadValid !== true
      ) {
        permanentlyFail("eligible renderer was not canonical and sandbox-safe");
        return;
      }
      if (
        canonicalWebContentsId !== null
        && (canonicalWebContentsId !== observation.webContentsId || canonicalUrl !== observation.url)
      ) {
        permanentlyFail(canonicalWebContentsId !== observation.webContentsId
          ? "duplicate eligible renderer"
          : "canonical renderer URL changed");
        return;
      }
      canonicalWebContentsId = observation.webContentsId;
      canonicalUrl = observation.url;
      originalPreload = true;
      if (preloadErrorIds.has(observation.webContentsId)) permanentlyFail("canonical original preload failed");
    },
    preloadError(webContentsId) {
      preloadErrorIds.add(webContentsId);
      if (isCanonical(webContentsId)) permanentlyFail("canonical original preload failed");
    },
    authorization(webContentsId) {
      if (!isCanonical(webContentsId)) {
        permanentlyFail("authorization sender was not canonical");
        return;
      }
      if (authorized) {
        permanentlyFail("authorization replayed");
        return;
      }
      authorized = true;
    },
    didFinishLoad(webContentsId, url) {
      if (!isCanonical(webContentsId)) return;
      if (url !== canonicalUrl) {
        permanentlyFail("canonical renderer finished at wrong URL");
        return;
      }
      didFinishLoad = true;
    },
    rendererHandshake(observation) {
      if (!isCanonical(observation.webContentsId)) {
        permanentlyFail("mount sender was not canonical");
        return;
      }
      if (mounted) {
        permanentlyFail("mount handshake replayed");
        return;
      }
      if (
        !authorized
        || observation.nonce !== nonce
        || observation.url !== canonicalUrl
        || observation.lifecycle !== "renderer-mounted"
        || observation.rendererSandboxed !== true
        || !validHealthValue(observation.rendererStorageSelfTest)
      ) {
        permanentlyFail(observation.rendererSandboxed === false
          ? "renderer was not effectively sandboxed"
          : "mount handshake binding invalid");
        return;
      }
      mounted = true;
      rendererStorageSelfTest = observation.rendererStorageSelfTest;
      if (rendererStorageSelfTest !== "pass") permanentlyFail("renderer storage self-test failed");
    },
    fail(reason, webContentsId) {
      if (webContentsId !== undefined && !isCanonical(webContentsId)) return;
      permanentlyFail(reason);
    },
    cleanup(success) {
      cleanup = success ? "pass" : "fail";
      if (!success) permanentlyFail("promotion renderer cleanup failed");
    },
    complete() {
      return failureReason !== null || (authorized && didFinishLoad && mounted && rendererStorageSelfTest === "pass");
    },
    result() {
      const proofComplete = authorized && didFinishLoad && mounted && rendererStorageSelfTest === "pass";
      if (failureReason !== null || cleanup === "fail") {
        return { hostReady: "fail", rendererStorageSelfTest: "fail", proofSummary: this.summary() };
      }
      return {
        hostReady: proofComplete && cleanup === "pass" ? "pass" : "unknown",
        rendererStorageSelfTest: mounted ? rendererStorageSelfTest : "unknown",
        proofSummary: this.summary(),
      };
    },
    summary() {
      return {
        capturedWindowCount,
        canonicalWebContentsId,
        canonicalUrl,
        authorized,
        didFinishLoad,
        mounted,
        originalPreload,
        preloadFailed,
        loadFailed,
        rendererExited,
        cleanup,
        failureReason,
      };
    },
  };
}

export interface PromotionRendererAuthorizationContext {
  windowAlive: boolean;
  senderMatches: boolean;
  frameMatches: boolean;
  senderUrl: string;
  expectedUrl: string;
  consumed: boolean;
}

export type PromotionRendererAuthorizationDecision =
  | { accepted: false; reason: string; response: null }
  | { accepted: true; reason: "accepted"; response: { version: 1; nonce: string; url: string } };

export interface PromotionRendererHandshakeContext {
  windowAlive: boolean;
  senderMatches: boolean;
  frameMatches: boolean;
  senderUrl: string;
  expectedUrl: string;
  authorizationConsumed: boolean;
  handshakeConsumed: boolean;
}

export type PromotionRendererHandshakeDecision =
  | { accepted: false; reason: string; observation: null }
  | {
    accepted: true;
    reason: "accepted";
    observation: {
      nonce: string;
      url: string;
      lifecycle: "renderer-mounted";
      rendererStorageSelfTest: HealthValue;
    };
  };

export type PromotionOriginalRendererHandshakeDecision =
  | { accepted: false; reason: string; observation: null }
  | {
    accepted: true;
    reason: "accepted";
    observation: {
      nonce: string;
      url: string;
      lifecycle: "renderer-mounted";
      rendererSandboxed: boolean;
      rendererStorageSelfTest: HealthValue;
    };
  };

export type PromotionOriginalRendererMountTimeoutDecision =
  | { accepted: false; reason: string; observation: null }
  | {
    accepted: true;
    reason: "accepted";
    observation: {
      nonce: string;
      url: string;
      lifecycle: "renderer-mount-timeout";
      rendererSandboxed: true;
    };
  };

/** Pure, bounded decision used by the synchronous health-only IPC handler. */
export function authorizePromotionRenderer(
  context: PromotionRendererAuthorizationContext,
  payload: unknown,
  nonce: string,
): PromotionRendererAuthorizationDecision {
  if (!context.windowAlive) return { accepted: false, reason: "proof window unavailable", response: null };
  if (!context.senderMatches) return { accepted: false, reason: "sender mismatch", response: null };
  if (!context.frameMatches) return { accepted: false, reason: "frame mismatch", response: null };
  if (context.senderUrl !== context.expectedUrl) return { accepted: false, reason: "sender URL mismatch", response: null };
  if (context.consumed) return { accepted: false, reason: "authorization already consumed", response: null };
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { accepted: false, reason: "payload invalid", response: null };
  }
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "url,version") {
    return { accepted: false, reason: "payload keys invalid", response: null };
  }
  if (value.version !== 1 || value.url !== context.expectedUrl) {
    return { accepted: false, reason: "payload binding invalid", response: null };
  }
  if (!PROMOTION_RENDERER_NONCE_PATTERN.test(nonce)) {
    return { accepted: false, reason: "nonce invalid", response: null };
  }
  return {
    accepted: true,
    reason: "accepted",
    response: { version: 1, nonce, url: context.expectedUrl },
  };
}

/** Pure, bounded gate in front of the proof tracker's one allowed handshake. */
export function validatePromotionRendererHandshake(
  context: PromotionRendererHandshakeContext,
  payload: unknown,
  nonce: string,
): PromotionRendererHandshakeDecision {
  if (!context.windowAlive) return { accepted: false, reason: "proof window unavailable", observation: null };
  if (!context.senderMatches) return { accepted: false, reason: "sender mismatch", observation: null };
  if (!context.frameMatches) return { accepted: false, reason: "frame mismatch", observation: null };
  if (context.senderUrl !== context.expectedUrl) return { accepted: false, reason: "sender URL mismatch", observation: null };
  if (!context.authorizationConsumed) return { accepted: false, reason: "authorization required", observation: null };
  if (context.handshakeConsumed) return { accepted: false, reason: "handshake already consumed", observation: null };
  if (!plainRecord(payload)) return { accepted: false, reason: "payload invalid", observation: null };
  if (!exactKeys(payload, ["nonce", "rendererStorageSelfTest", "lifecycle", "url"])) {
    return { accepted: false, reason: "payload keys invalid", observation: null };
  }
  if (payload.nonce !== nonce || payload.url !== context.expectedUrl || payload.lifecycle !== "renderer-mounted") {
    return { accepted: false, reason: "payload binding invalid", observation: null };
  }
  if (!validHealthValue(payload.rendererStorageSelfTest)) {
    return { accepted: false, reason: "storage result invalid", observation: null };
  }
  return {
    accepted: true,
    reason: "accepted",
    observation: {
      nonce,
      url: context.expectedUrl,
      lifecycle: "renderer-mounted",
      rendererStorageSelfTest: payload.rendererStorageSelfTest,
    },
  };
}

/**
 * Validates the original-main preload's mount proof. Unlike the synthetic
 * renderer proof, this requires the renderer to report Electron's effective
 * sandbox state so an omitted default WebPreference cannot be mistaken for
 * an explicit sandbox disablement or accepted without a positive signal.
 */
export function validatePromotionOriginalRendererHandshake(
  context: PromotionRendererHandshakeContext,
  payload: unknown,
  nonce: string,
): PromotionOriginalRendererHandshakeDecision {
  if (!context.windowAlive) return { accepted: false, reason: "proof window unavailable", observation: null };
  if (!context.senderMatches) return { accepted: false, reason: "sender mismatch", observation: null };
  if (!context.frameMatches) return { accepted: false, reason: "frame mismatch", observation: null };
  if (context.senderUrl !== context.expectedUrl) return { accepted: false, reason: "sender URL mismatch", observation: null };
  if (!context.authorizationConsumed) return { accepted: false, reason: "authorization required", observation: null };
  if (context.handshakeConsumed) return { accepted: false, reason: "handshake already consumed", observation: null };
  if (!plainRecord(payload)) return { accepted: false, reason: "payload invalid", observation: null };
  if (!exactKeys(payload, ["nonce", "rendererSandboxed", "rendererStorageSelfTest", "lifecycle", "url"])) {
    return { accepted: false, reason: "payload keys invalid", observation: null };
  }
  if (payload.nonce !== nonce || payload.url !== context.expectedUrl || payload.lifecycle !== "renderer-mounted") {
    return { accepted: false, reason: "payload binding invalid", observation: null };
  }
  if (typeof payload.rendererSandboxed !== "boolean") {
    return { accepted: false, reason: "sandbox result invalid", observation: null };
  }
  if (!validHealthValue(payload.rendererStorageSelfTest)) {
    return { accepted: false, reason: "storage result invalid", observation: null };
  }
  return {
    accepted: true,
    reason: "accepted",
    observation: {
      nonce,
      url: context.expectedUrl,
      lifecycle: "renderer-mounted",
      rendererSandboxed: payload.rendererSandboxed,
      rendererStorageSelfTest: payload.rendererStorageSelfTest,
    },
  };
}

/**
 * Validates the preload's fail-closed mount timeout on the same exact sender,
 * frame, URL, authorization, nonce and effective-sandbox boundary as success.
 */
export function validatePromotionOriginalRendererMountTimeout(
  context: PromotionRendererHandshakeContext,
  payload: unknown,
  nonce: string,
): PromotionOriginalRendererMountTimeoutDecision {
  if (!context.windowAlive) return { accepted: false, reason: "proof window unavailable", observation: null };
  if (!context.senderMatches) return { accepted: false, reason: "sender mismatch", observation: null };
  if (!context.frameMatches) return { accepted: false, reason: "frame mismatch", observation: null };
  if (context.senderUrl !== context.expectedUrl) return { accepted: false, reason: "sender URL mismatch", observation: null };
  if (!context.authorizationConsumed) return { accepted: false, reason: "authorization required", observation: null };
  if (context.handshakeConsumed) return { accepted: false, reason: "proof event already consumed", observation: null };
  if (!plainRecord(payload)) return { accepted: false, reason: "payload invalid", observation: null };
  if (!exactKeys(payload, ["nonce", "rendererSandboxed", "lifecycle", "url"])) {
    return { accepted: false, reason: "payload keys invalid", observation: null };
  }
  if (
    payload.nonce !== nonce
    || payload.url !== context.expectedUrl
    || payload.lifecycle !== "renderer-mount-timeout"
    || payload.rendererSandboxed !== true
  ) {
    return { accepted: false, reason: "payload binding invalid", observation: null };
  }
  return {
    accepted: true,
    reason: "accepted",
    observation: {
      nonce,
      url: context.expectedUrl,
      lifecycle: "renderer-mount-timeout",
      rendererSandboxed: true,
    },
  };
}

const PROMOTION_RENDERER_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PromotionRendererProtocolRequest {
  url: string;
}

export type PromotionRendererReadFile = (path: string) => Buffer;

/**
 * Selects the real production renderer origin. The health-only main process
 * owns a temporary app:// handler that serves bytes from its candidate ASAR.
 */
export function promotionRendererDocumentUrl(nonce: string): string {
  const url = new URL(`${PROMOTION_RENDERER_SCHEME}://${PROMOTION_RENDERER_HOST}/index.html`);
  url.searchParams.set(PROMOTION_RENDERER_NONCE_QUERY, nonce);
  return url.toString();
}

/**
 * Maps one app://- request to a relative file below the candidate webview.
 * Inspect the raw URL before URL parsing can normalize dot segments, decode the
 * path exactly once, and reject any residual encoding that could hide a second
 * traversal/backslash/NUL decode.
 */
export function promotionRendererAssetRoute(requestUrl: string): string | null {
  const prefix = `${PROMOTION_RENDERER_SCHEME}://${PROMOTION_RENDERER_HOST}`;
  if (!requestUrl.startsWith(`${prefix}/`)) return null;

  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${PROMOTION_RENDERER_SCHEME}:`
    || parsed.hostname !== PROMOTION_RENDERER_HOST
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.port !== ""
    || parsed.hash !== ""
  ) return null;

  const pathAndQuery = requestUrl.slice(prefix.length);
  const queryIndex = pathAndQuery.indexOf("?");
  const fragmentIndex = pathAndQuery.indexOf("#");
  const pathEnd = [queryIndex, fragmentIndex]
    .filter((index) => index >= 0)
    .reduce((smallest, index) => Math.min(smallest, index), pathAndQuery.length);
  const rawPath = pathAndQuery.slice(0, pathEnd);
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("\\") || rawPath.includes("\0")) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    decodedPath.includes("\\")
    || decodedPath.includes("\0")
    || /%[0-9a-f]{2}/i.test(decodedPath)
  ) return null;

  const segments = decodedPath.slice(1).split("/");
  if (
    segments.length === 0
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) return null;
  return segments.join("/");
}

export function promotionRendererAssetMimeType(relativePath: string): string {
  switch (extname(relativePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json":
    case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".ttf": return "font/ttf";
    case ".otf": return "font/otf";
    case ".wasm": return "application/wasm";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

/** Creates the health process's ASAR-aware, read-only app:// responder. */
export function createPromotionRendererProtocolResponder(
  webviewRoot: string,
  readFile: PromotionRendererReadFile = readFileSync,
): (request: PromotionRendererProtocolRequest) => Response {
  return (request) => {
    const relativePath = promotionRendererAssetRoute(request.url);
    if (!relativePath) return new Response(null, { status: 404 });
    try {
      const bytes = readFile(join(webviewRoot, ...relativePath.split("/")));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": promotionRendererAssetMimeType(relativePath),
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}

export function promotionRendererLoadRejection(
  error: unknown,
  requestedUrl: string,
): { errorCode: number; errorDescription: string; url: string } {
  const value = error !== null && typeof error === "object"
    ? error as { errno?: unknown; url?: unknown }
    : null;
  return {
    errorCode: typeof value?.errno === "number" ? value.errno : -2,
    errorDescription: error instanceof Error ? error.message : String(error),
    url: typeof value?.url === "string" && value.url.length > 0 ? value.url : requestedUrl,
  };
}

export interface PromotionRendererProofResult {
  hostReady: HealthValue;
  rendererStorageSelfTest: HealthValue;
  /** Targeted original-main detail is logged; the installer receipt remains schema compatible. */
  proofSummary?: PromotionOriginalRendererProofSummary;
}

export interface PromotionRendererProofTracker {
  windowCreated(observation: {
    webContentsId: number;
    url: string;
    preloadPath: string | null;
  }): void;
  didFinishLoad(observation: { webContentsId: number; url: string }): void;
  didFailLoad(observation: {
    webContentsId: number;
    errorCode: number;
    errorDescription: string;
    url: string;
  }): void;
  renderProcessGone(observation: {
    webContentsId: number;
    reason: string;
    exitCode: number;
  }): void;
  rendererHandshake(observation: {
    webContentsId: number;
    nonce: string;
    url: string;
    lifecycle: string;
    rendererStorageSelfTest: HealthValue;
  }): void;
  result(): PromotionRendererProofResult;
}

/**
 * Tracks the candidate's real renderer without importing Electron into tests.
 * Every positive signal is bound to one nonce, URL, preload, and webContents.
 */
export function createPromotionRendererProofTracker(expected: {
  nonce: string;
  url: string;
  preloadPath: string;
}): PromotionRendererProofTracker {
  let expectedWebContentsId: number | null = null;
  let windowCreated = false;
  let didFinishLoad = false;
  let handshake = false;
  let failed = false;
  let rendererStorageSelfTest: HealthValue = "unknown";

  const expectedRenderer = (webContentsId: number): boolean => (
    expectedWebContentsId !== null && webContentsId === expectedWebContentsId
  );
  const validId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

  return {
    windowCreated(observation) {
      if (expectedWebContentsId !== null) {
        failed = true;
        return;
      }
      expectedWebContentsId = validId(observation.webContentsId) ? observation.webContentsId : null;
      windowCreated = expectedWebContentsId !== null
        && observation.url === expected.url
        && observation.preloadPath === expected.preloadPath;
      if (!windowCreated) failed = true;
    },
    didFinishLoad(observation) {
      if (!expectedRenderer(observation.webContentsId)) return;
      if (observation.url !== expected.url) {
        failed = true;
        return;
      }
      didFinishLoad = true;
    },
    didFailLoad(observation) {
      if (!expectedRenderer(observation.webContentsId)) return;
      // Any did-fail-load on the proof renderer, including ERR_FAILED (-2),
      // invalidates the one-shot proof even if a later navigation succeeds.
      void observation.errorCode;
      void observation.errorDescription;
      void observation.url;
      failed = true;
      rendererStorageSelfTest = "fail";
    },
    renderProcessGone(observation) {
      if (!expectedRenderer(observation.webContentsId)) return;
      void observation.reason;
      void observation.exitCode;
      failed = true;
      rendererStorageSelfTest = "fail";
    },
    rendererHandshake(observation) {
      if (!expectedRenderer(observation.webContentsId)) return;
      if (
        observation.nonce !== expected.nonce
        || observation.url !== expected.url
        || observation.lifecycle !== "renderer-mounted"
        || !validHealthValue(observation.rendererStorageSelfTest)
      ) {
        failed = true;
        rendererStorageSelfTest = "fail";
        return;
      }
      handshake = true;
      rendererStorageSelfTest = observation.rendererStorageSelfTest;
    },
    result() {
      if (failed) return { hostReady: "fail", rendererStorageSelfTest: "fail" };
      return {
        hostReady: windowCreated && didFinishLoad && handshake ? "pass" : "unknown",
        rendererStorageSelfTest: handshake ? rendererStorageSelfTest : "unknown",
      };
    },
  };
}

interface LegacyHealthRequest {
  schemaVersion: 1;
  requestedAt: string;
  app: { version: string; build: string; hash: string };
  runtimeHash: string;
  requiredPermissions: string[];
}

export const PROMOTION_SURFACE_NAMES = [
  "app",
  "runtime",
  "tweakTree",
  "tweakersConfig",
  "codexConfig",
  "namespaceData",
  "mainStorage",
  "policy",
] as const;

export type PromotionSurfaceName = typeof PROMOTION_SURFACE_NAMES[number];

export interface PromotionSurfaceExpectation {
  preimageHash: string;
  afterHash: string;
}

export interface UserQuestionsPromotionExpectation {
  id: string;
  version: string;
  payloadHash: string;
}

export interface PromotionHealthRequestV2 {
  schemaVersion: 2;
  requestedAt: string;
  app: { version: string; build: string; hash: string };
  requiredPermissions: string[];
  surfaces: Record<PromotionSurfaceName, PromotionSurfaceExpectation>;
  userQuestions: UserQuestionsPromotionExpectation;
}

export interface UserQuestionsHealthObservation {
  id: string;
  version: string;
  payloadHash: string;
  mainLifecycle: HealthValue;
  brokerSelfTest: HealthValue;
  schemaSelfTest: HealthValue;
  rendererStorageSelfTest: HealthValue;
  mcpConflictCount: number;
}

export interface RuntimePromotionProbes {
  authenticatedSession(): HealthValue | Promise<HealthValue>;
  declaredPermission(permission: string): HealthValue | Promise<HealthValue>;
  /** A nonce-bound real BrowserWindow/preload lifecycle proof. Missing means unknown. */
  rendererReady?(): HealthValue | Promise<HealthValue>;
  /** Bounded targeted renderer load/failure/exit/mount evidence for the existing V2 receipt. */
  rendererProof?(): PromotionOriginalRendererProofSummary | null | Promise<PromotionOriginalRendererProofSummary | null>;
  /** V2 observations are injected so disposable candidates never infer or read live config paths. */
  promotionSurface?(surface: PromotionSurfaceName): string | Promise<string>;
  userQuestionsHealth?(): UserQuestionsHealthObservation | Promise<UserQuestionsHealthObservation>;
}

export interface SessionCookieObservation {
  name: string;
  domain?: string;
  value?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

export function hasAuthenticatedSessionCookie(cookies: SessionCookieObservation[], now = Date.now()): boolean {
  return cookies.some((cookie) => {
    const domain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase();
    const knownDomain = domain === "chatgpt.com" || domain.endsWith(".chatgpt.com") ||
      domain === "openai.com" || domain.endsWith(".openai.com");
    const knownSessionName = /^(?:__Secure-|__Host-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(cookie.name);
    const notExpired = cookie.expirationDate === undefined || cookie.expirationDate * 1_000 > now;
    return knownDomain && knownSessionName && cookie.secure === true && cookie.httpOnly === true &&
      typeof cookie.value === "string" && cookie.value.length > 0 && notExpired;
  });
}

export interface CodexAuthObservation {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  } | null;
}

/**
 * The Codex / ChatGPT desktop app does NOT authenticate with a web
 * next-auth.session-token cookie. It signs in with a Codex account token stored
 * in `~/.codex/auth.json` (auth_mode "chatgpt") or an API key. The id_token is
 * short-lived and refreshed roughly hourly, so a durable session is proven by a
 * refresh token / account id (or an API key) — never by the id_token's expiry.
 */
export function hasAuthenticatedCodexToken(auth: CodexAuthObservation | null | undefined): boolean {
  if (!auth || typeof auth !== "object") return false;
  const apiKey = typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0;
  const tokens = auth.tokens ?? undefined;
  const durableSession = !!tokens && (
    (typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0) ||
    (typeof tokens.account_id === "string" && tokens.account_id.length > 0 &&
      typeof tokens.access_token === "string" && tokens.access_token.length > 0)
  );
  return apiKey || durableSession;
}

export function readCodexAuth(codexHome?: string): CodexAuthObservation | null {
  try {
    const home = codexHome || process.env.CODEX_HOME || join(homedir(), ".codex");
    return JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as CodexAuthObservation;
  } catch {
    return null;
  }
}

export async function answerPromotionHealthRequest(
  userRoot: string,
  probes: RuntimePromotionProbes,
  options: { now?: Date; maxAgeMs?: number } = {},
): Promise<boolean> {
  const requestFile = join(userRoot, "health", "request.json");
  const receiptFile = join(userRoot, "health", "promotion.json");
  let request: LegacyHealthRequest | PromotionHealthRequestV2;
  try {
    const stat = lstatSync(requestFile);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    request = JSON.parse(readFileSync(requestFile, "utf8")) as LegacyHealthRequest | PromotionHealthRequestV2;
    const now = (options.now ?? new Date()).getTime();
    const requestedAt = Date.parse(request.requestedAt);
    if (
      !Number.isFinite(requestedAt)
      || requestedAt > now + 5_000
      || now - requestedAt > (options.maxAgeMs ?? PROMOTION_HEALTH_REQUEST_MAX_AGE_MS)
    ) return false;
    if (!validPromotionRequest(request)) return false;
  } catch {
    return false;
  }

  const safe = async (probe: () => HealthValue | Promise<HealthValue>): Promise<HealthValue> => {
    try {
      const value = await probe();
      return value === "pass" || value === "fail" || value === "unknown" ? value : "unknown";
    } catch {
      return "unknown";
    }
  };
  const permissions = Object.fromEntries(await Promise.all(request.requiredPermissions.map(async (permission) => [
    permission,
    await safe(() => probes.declaredPermission(permission)),
  ])));
  const authenticatedSession = await safe(() => probes.authenticatedSession());
  const receipt = request.schemaVersion === 1
    ? {
      schemaVersion: 1 as const,
      observedAt: (options.now ?? new Date()).toISOString(),
      app: request.app,
      runtimeHash: request.runtimeHash,
      hostReady: "pass" as const,
      authenticatedSession,
      declaredPermissions: permissions,
    }
    : await buildV2Receipt(request, probes, permissions, authenticatedSession, options.now ?? new Date(), safe);
  mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 });
  const temporary = `${receiptFile}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, receiptFile);
  chmodSync(receiptFile, 0o600);
  try { unlinkSync(requestFile); } catch { /* one-shot request already consumed */ }
  return true;
}

async function buildV2Receipt(
  request: PromotionHealthRequestV2,
  probes: RuntimePromotionProbes,
  permissions: Record<string, HealthValue>,
  authenticatedSession: HealthValue,
  now: Date,
  safe: (probe: () => HealthValue | Promise<HealthValue>) => Promise<HealthValue>,
): Promise<object> {
  const surfaces = Object.fromEntries(await Promise.all(PROMOTION_SURFACE_NAMES.map(async (surface) => {
    const expected = request.surfaces[surface];
    let observedHash = "unknown";
    try {
      const observed = await probes.promotionSurface?.(surface);
      if (validPromotionHash(observed)) observedHash = observed;
    } catch { /* fail closed below */ }
    return [surface, {
      preimageHash: expected.preimageHash,
      expectedHash: expected.afterHash,
      observedHash,
      status: observedHash === expected.afterHash ? "pass" : observedHash === "unknown" ? "unknown" : "fail",
    }];
  }))) as Record<PromotionSurfaceName, {
    preimageHash: string;
    expectedHash: string;
    observedHash: string;
    status: HealthValue;
  }>;
  let observedUserQuestions: UserQuestionsHealthObservation | null = null;
  try {
    const observed = await probes.userQuestionsHealth?.();
    if (validUserQuestionsObservation(observed)) observedUserQuestions = observed;
  } catch { /* fail closed below */ }
  const expectedUserQuestions = request.userQuestions;
  const hostReady = await safe(() => probes.rendererReady?.() ?? "unknown");
  let observedRendererProof = unavailableRendererProofSummary();
  try {
    const observed = await probes.rendererProof?.();
    if (validRendererProofSummary(observed)) observedRendererProof = observed;
  } catch { /* fail closed below */ }
  const rendererProof = rendererProofReceiptSummary(observedRendererProof);
  const identity = observedUserQuestions &&
    observedUserQuestions.id === expectedUserQuestions.id &&
    observedUserQuestions.version === expectedUserQuestions.version &&
    observedUserQuestions.payloadHash === expectedUserQuestions.payloadHash
    ? "pass" : observedUserQuestions ? "fail" : "unknown";
  const userQuestions = {
    expected: expectedUserQuestions,
    observed: observedUserQuestions ? {
      id: observedUserQuestions.id,
      version: observedUserQuestions.version,
      payloadHash: observedUserQuestions.payloadHash,
    } : null,
    identity,
    mainLifecycle: observedUserQuestions?.mainLifecycle ?? "unknown",
    brokerSelfTest: observedUserQuestions?.brokerSelfTest ?? "unknown",
    schemaSelfTest: observedUserQuestions?.schemaSelfTest ?? "unknown",
    rendererStorageSelfTest: observedUserQuestions?.rendererStorageSelfTest ?? "unknown",
    mcpConflictCount: observedUserQuestions?.mcpConflictCount ?? null,
    zeroMcpConflicts: observedUserQuestions
      ? observedUserQuestions.mcpConflictCount === 0 ? "pass" : "fail"
      : "unknown",
  };
  const allSurfacesPass = Object.values(surfaces).every((surface) => surface.status === "pass");
  const allPermissionsPass = Object.values(permissions).every((permission) => permission === "pass");
  const userQuestionsPass = [
    userQuestions.identity,
    userQuestions.mainLifecycle,
    userQuestions.brokerSelfTest,
    userQuestions.schemaSelfTest,
    userQuestions.rendererStorageSelfTest,
    userQuestions.zeroMcpConflicts,
  ].every((value) => value === "pass");
  const rendererProofPass = passingRendererProofSummary(observedRendererProof);
  return {
    schemaVersion: 2,
    observedAt: now.toISOString(),
    app: request.app,
    hostReady,
    rendererProof,
    authenticatedSession,
    declaredPermissions: permissions,
    surfaces,
    userQuestions,
    promotionReady: hostReady === "pass" && rendererProofPass && allSurfacesPass && allPermissionsPass && userQuestionsPass && authenticatedSession === "pass"
      ? "pass" : "fail",
  };
}

function rendererProofReceiptSummary(value: PromotionOriginalRendererProofSummary): object {
  const evidenceUrl = promotionOriginalRendererEvidenceUrl(value.canonicalUrl);
  return {
    ...value,
    canonicalUrl: evidenceUrl.canonicalUrl,
    queryKeys: evidenceUrl.queryKeys,
  };
}

function unavailableRendererProofSummary(): PromotionOriginalRendererProofSummary {
  return {
    capturedWindowCount: 0,
    canonicalWebContentsId: null,
    canonicalUrl: null,
    authorized: false,
    didFinishLoad: false,
    mounted: false,
    originalPreload: false,
    preloadFailed: false,
    loadFailed: false,
    rendererExited: false,
    cleanup: "pending",
    failureReason: "renderer proof unavailable",
  };
}

function validRendererProofSummary(value: unknown): value is PromotionOriginalRendererProofSummary {
  if (!plainRecord(value) || !exactKeys(value, [
    "capturedWindowCount",
    "canonicalWebContentsId",
    "canonicalUrl",
    "authorized",
    "didFinishLoad",
    "mounted",
    "originalPreload",
    "preloadFailed",
    "loadFailed",
    "rendererExited",
    "cleanup",
    "failureReason",
  ])) return false;
  if (
    !Number.isSafeInteger(value.capturedWindowCount)
    || (value.capturedWindowCount as number) < 0
    || (value.capturedWindowCount as number) > 64
    || (value.canonicalWebContentsId !== null && (
      !Number.isSafeInteger(value.canonicalWebContentsId)
      || (value.canonicalWebContentsId as number) <= 0
    ))
    || (value.canonicalUrl !== null && canonicalPromotionOriginalRendererUrl(value.canonicalUrl) === null)
    || typeof value.authorized !== "boolean"
    || typeof value.didFinishLoad !== "boolean"
    || typeof value.mounted !== "boolean"
    || typeof value.originalPreload !== "boolean"
    || typeof value.preloadFailed !== "boolean"
    || typeof value.loadFailed !== "boolean"
    || typeof value.rendererExited !== "boolean"
    || !["pending", "pass", "fail"].includes(value.cleanup as string)
    || (value.failureReason !== null && (
      typeof value.failureReason !== "string"
      || value.failureReason.length === 0
      || value.failureReason.length > 256
      || /[\u0000-\u001f\u007f]/.test(value.failureReason)
    ))
  ) return false;
  return true;
}

function passingRendererProofSummary(value: PromotionOriginalRendererProofSummary): boolean {
  return value.capturedWindowCount >= 1
    && value.canonicalWebContentsId !== null
    && value.canonicalUrl !== null
    && value.authorized
    && value.didFinishLoad
    && value.mounted
    && value.originalPreload
    && !value.preloadFailed
    && !value.loadFailed
    && !value.rendererExited
    && value.cleanup === "pass"
    && value.failureReason === null;
}

function validPromotionRequest(value: unknown): value is LegacyHealthRequest | PromotionHealthRequestV2 {
  if (!plainRecord(value)) return false;
  if (value.schemaVersion === 1) {
    if (!exactKeys(value, ["schemaVersion", "requestedAt", "app", "runtimeHash", "requiredPermissions"])) return false;
    return validApp(value.app) && typeof value.runtimeHash === "string" && validPermissions(value.requiredPermissions);
  }
  if (value.schemaVersion !== 2 || !exactKeys(value, ["schemaVersion", "requestedAt", "app", "requiredPermissions", "surfaces", "userQuestions"])) return false;
  if (!validApp(value.app) || !validPermissions(value.requiredPermissions) || !plainRecord(value.surfaces)) return false;
  if (!exactKeys(value.surfaces, [...PROMOTION_SURFACE_NAMES])) return false;
  const surfaces = value.surfaces as Record<string, unknown>;
  for (const surface of PROMOTION_SURFACE_NAMES) {
    const expectation = surfaces[surface];
    if (!plainRecord(expectation) || !exactKeys(expectation, ["preimageHash", "afterHash"])) return false;
    if (!validPromotionHash(expectation.preimageHash) || !validPromotionHash(expectation.afterHash)) return false;
  }
  if ((surfaces.app as Record<string, unknown>).afterHash !== (value.app as { hash: string }).hash) return false;
  if (!plainRecord(value.userQuestions) || !exactKeys(value.userQuestions, ["id", "version", "payloadHash"])) return false;
  return value.userQuestions.id === "co.tweakers.user-questions" &&
    typeof value.userQuestions.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.userQuestions.version) &&
    validPromotionHash(value.userQuestions.payloadHash) && value.userQuestions.payloadHash !== "missing";
}

function validApp(value: unknown): boolean {
  return plainRecord(value) && exactKeys(value, ["version", "build", "hash"]) &&
    typeof value.version === "string" && value.version.length > 0 &&
    typeof value.build === "string" && value.build.length > 0 &&
    typeof value.hash === "string" && value.hash.length > 0;
}

function validPermissions(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && new Set(value).size === value.length &&
    value.every((permission) => typeof permission === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(permission));
}

function validPromotionHash(value: unknown): value is string {
  return value === "missing" || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

function validUserQuestionsObservation(value: unknown): value is UserQuestionsHealthObservation {
  if (!plainRecord(value) || !exactKeys(value, [
    "id", "version", "payloadHash", "mainLifecycle", "brokerSelfTest", "schemaSelfTest", "rendererStorageSelfTest", "mcpConflictCount",
  ])) return false;
  return typeof value.id === "string" && typeof value.version === "string" && validPromotionHash(value.payloadHash) &&
    validHealthValue(value.mainLifecycle) && validHealthValue(value.brokerSelfTest) && validHealthValue(value.schemaSelfTest) &&
    validHealthValue(value.rendererStorageSelfTest) &&
    Number.isInteger(value.mcpConflictCount) && (value.mcpConflictCount as number) >= 0;
}

function validHealthValue(value: unknown): value is HealthValue {
  return value === "pass" || value === "fail" || value === "unknown";
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
