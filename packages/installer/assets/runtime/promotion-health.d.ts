export type HealthValue = "pass" | "fail" | "unknown";
export declare const PROMOTION_RENDERER_IPC_CHANNEL = "tweaker:promotion-renderer-proof";
export declare const PROMOTION_RENDERER_AUTH_CHANNEL = "tweaker:promotion-renderer-authorize";
export declare const PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
export declare const PROMOTION_RENDERER_SCHEME = "app";
export declare const PROMOTION_RENDERER_HOST = "-";
export declare const PROMOTION_ORIGINAL_RENDERER_URL = "app://-/index.html";
export declare const PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL = "tweaker:promotion-original-renderer-authorize";
export declare const PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL = "tweaker:promotion-original-renderer-proof";
export declare const PROMOTION_ORIGINAL_RENDERER_STARTUP_TIMEOUT_MS = 20000;
export declare const PROMOTION_ORIGINAL_RENDERER_LOAD_TIMEOUT_MS = 75000;
export declare const PROMOTION_ORIGINAL_RENDERER_MOUNT_TIMEOUT_MS = 60000;
export declare const PROMOTION_ORIGINAL_RENDERER_PRELOAD_TIMEOUT_MS = 55000;
export declare const PROMOTION_ORIGINAL_RENDERER_CLEANUP_BUDGET_MS = 5000;
export declare const PROMOTION_HEALTH_REQUEST_MAX_AGE_MS = 200000;
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
export declare function createPromotionOriginalRendererDeadlineController(options: {
    onTimeout: (phase: Exclude<PromotionOriginalRendererDeadlinePhase, "settled">) => void;
    scheduler?: PromotionOriginalRendererDeadlineScheduler;
    startupTimeoutMs?: number;
    loadTimeoutMs?: number;
    mountTimeoutMs?: number;
}): PromotionOriginalRendererDeadlineController;
/**
 * Accept the production Owl document, including its exact observed query,
 * without accepting a synthetic proof nonce or URL normalization ambiguity.
 */
export declare function canonicalPromotionOriginalRendererUrl(value: unknown): string | null;
export declare function promotionOriginalRendererEvidenceUrl(value: string | null): {
    canonicalUrl: typeof PROMOTION_ORIGINAL_RENDERER_URL | null;
    queryKeys: string[];
};
export declare function promotionOriginalRendererLogUrl(value: unknown): string;
export interface PromotionOriginalRendererAuthorizationContext {
    windowAlive: boolean;
    windowHidden: boolean;
    senderMatches: boolean;
    frameMatches: boolean;
    senderUrl: string;
    consumed: boolean;
}
export type PromotionOriginalRendererAuthorizationDecision = {
    accepted: false;
    reason: string;
    response: null;
} | {
    accepted: true;
    reason: "accepted";
    response: {
        version: 1;
        nonce: string;
        url: string;
    };
};
/**
 * Requires one unambiguous main-process metric for the renderer OS process.
 * ProcessMetric.sandboxed is optional even on supported platforms, so only an
 * explicit true is positive evidence; absent, duplicate, or malformed data
 * fails closed before the authorization nonce can leave the main process.
 */
export declare function hasUniqueSandboxedPromotionRendererProcess(processMetrics: unknown, rendererProcessId: unknown): boolean;
export interface PromotionOriginalRendererBackgroundThrottlingResult {
    ok: boolean;
    previous: boolean | null;
    observed: boolean | null;
}
interface PromotionOriginalRendererBackgroundThrottlingTarget {
    getBackgroundThrottling?: unknown;
    setBackgroundThrottling?: unknown;
}
/** Disable background throttling on the one selected hidden proof renderer. */
export declare function disablePromotionOriginalRendererBackgroundThrottling(target: PromotionOriginalRendererBackgroundThrottlingTarget): PromotionOriginalRendererBackgroundThrottlingResult;
/** Recheck the selected proof renderer without mutating it again. */
export declare function verifyPromotionOriginalRendererBackgroundThrottlingDisabled(target: PromotionOriginalRendererBackgroundThrottlingTarget): {
    ok: boolean;
    observed: boolean | null;
};
/**
 * Authorizes the dedicated original-main preload synchronously. The renderer
 * sends only its unmodified canonical URL; the main process supplies the nonce
 * after binding the sender to the one hidden, safe BrowserWindow.
 */
export declare function authorizePromotionOriginalRenderer(context: PromotionOriginalRendererAuthorizationContext, payload: unknown, nonce: string): PromotionOriginalRendererAuthorizationDecision;
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
export declare function shouldFailPromotionOriginalRendererProvisionalLoad(input: {
    isMainFrame: boolean;
    webContentsId: number;
    canonicalWebContentsId: number | null;
}): boolean;
/** Pure state machine for the original Codex renderer promotion gate. */
export declare function createPromotionOriginalRendererProofTracker(nonce: string): PromotionOriginalRendererProofTracker;
export interface PromotionRendererAuthorizationContext {
    windowAlive: boolean;
    senderMatches: boolean;
    frameMatches: boolean;
    senderUrl: string;
    expectedUrl: string;
    consumed: boolean;
}
export type PromotionRendererAuthorizationDecision = {
    accepted: false;
    reason: string;
    response: null;
} | {
    accepted: true;
    reason: "accepted";
    response: {
        version: 1;
        nonce: string;
        url: string;
    };
};
export interface PromotionRendererHandshakeContext {
    windowAlive: boolean;
    senderMatches: boolean;
    frameMatches: boolean;
    senderUrl: string;
    expectedUrl: string;
    authorizationConsumed: boolean;
    handshakeConsumed: boolean;
}
export interface PromotionOriginalRendererProofEventContext extends PromotionRendererHandshakeContext {
    loadObservedConsumed: boolean;
}
export type PromotionRendererHandshakeDecision = {
    accepted: false;
    reason: string;
    observation: null;
} | {
    accepted: true;
    reason: "accepted";
    observation: {
        nonce: string;
        url: string;
        lifecycle: "renderer-mounted";
        rendererStorageSelfTest: HealthValue;
    };
};
export type PromotionOriginalRendererHandshakeDecision = {
    accepted: false;
    reason: string;
    observation: null;
} | {
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
export type PromotionOriginalRendererMountTimeoutDecision = {
    accepted: false;
    reason: string;
    observation: null;
} | {
    accepted: true;
    reason: "accepted";
    observation: {
        nonce: string;
        url: string;
        lifecycle: "renderer-mount-timeout";
        rendererSandboxed: true;
    };
};
export type PromotionOriginalRendererLoadObservedDecision = {
    accepted: false;
    reason: string;
    observation: null;
} | {
    accepted: true;
    reason: "accepted";
    observation: {
        nonce: string;
        url: string;
        lifecycle: "renderer-load-observed";
        rendererSandboxed: true;
    };
};
/** Pure, bounded decision used by the synchronous health-only IPC handler. */
export declare function authorizePromotionRenderer(context: PromotionRendererAuthorizationContext, payload: unknown, nonce: string): PromotionRendererAuthorizationDecision;
/** Pure, bounded gate in front of the proof tracker's one allowed handshake. */
export declare function validatePromotionRendererHandshake(context: PromotionRendererHandshakeContext, payload: unknown, nonce: string): PromotionRendererHandshakeDecision;
/**
 * Validates the original-main preload's mount proof. Unlike the synthetic
 * renderer proof, this requires the renderer to report Electron's effective
 * sandbox state so an omitted default WebPreference cannot be mistaken for
 * an explicit sandbox disablement or accepted without a positive signal.
 */
export declare function validatePromotionOriginalRendererHandshake(context: PromotionOriginalRendererProofEventContext, payload: unknown, nonce: string): PromotionOriginalRendererHandshakeDecision;
/**
 * Bind the preload's one-shot window-load observation to the selected hidden
 * renderer before either terminal mount event may be accepted.
 */
export declare function validatePromotionOriginalRendererLoadObserved(context: PromotionOriginalRendererProofEventContext, payload: unknown, nonce: string): PromotionOriginalRendererLoadObservedDecision;
/**
 * Validates the preload's fail-closed mount timeout on the same exact sender,
 * frame, URL, authorization, nonce and effective-sandbox boundary as success.
 */
export declare function validatePromotionOriginalRendererMountTimeout(context: PromotionOriginalRendererProofEventContext, payload: unknown, nonce: string): PromotionOriginalRendererMountTimeoutDecision;
export interface PromotionRendererProtocolRequest {
    url: string;
}
export type PromotionRendererReadFile = (path: string) => Buffer;
/**
 * Selects the real production renderer origin. The health-only main process
 * owns a temporary app:// handler that serves bytes from its candidate ASAR.
 */
export declare function promotionRendererDocumentUrl(nonce: string): string;
/**
 * Maps one app://- request to a relative file below the candidate webview.
 * Inspect the raw URL before URL parsing can normalize dot segments, decode the
 * path exactly once, and reject any residual encoding that could hide a second
 * traversal/backslash/NUL decode.
 */
export declare function promotionRendererAssetRoute(requestUrl: string): string | null;
export declare function promotionRendererAssetMimeType(relativePath: string): string;
/** Creates the health process's ASAR-aware, read-only app:// responder. */
export declare function createPromotionRendererProtocolResponder(webviewRoot: string, readFile?: PromotionRendererReadFile): (request: PromotionRendererProtocolRequest) => Response;
export declare function promotionRendererLoadRejection(error: unknown, requestedUrl: string): {
    errorCode: number;
    errorDescription: string;
    url: string;
};
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
    didFinishLoad(observation: {
        webContentsId: number;
        url: string;
    }): void;
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
export declare function createPromotionRendererProofTracker(expected: {
    nonce: string;
    url: string;
    preloadPath: string;
}): PromotionRendererProofTracker;
export declare const PROMOTION_SURFACE_NAMES: readonly ["app", "runtime", "tweakTree", "tweakersConfig", "codexConfig", "namespaceData", "mainStorage", "policy"];
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
    app: {
        version: string;
        build: string;
        hash: string;
    };
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
export declare function hasAuthenticatedSessionCookie(cookies: SessionCookieObservation[], now?: number): boolean;
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
export declare function hasAuthenticatedCodexToken(auth: CodexAuthObservation | null | undefined): boolean;
export declare function readCodexAuth(codexHome?: string): CodexAuthObservation | null;
export declare function answerPromotionHealthRequest(userRoot: string, probes: RuntimePromotionProbes, options?: {
    now?: Date;
    maxAgeMs?: number;
}): Promise<boolean>;
export {};
