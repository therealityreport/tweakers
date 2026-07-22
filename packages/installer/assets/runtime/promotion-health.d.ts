export type HealthValue = "pass" | "fail" | "unknown";
export declare const PROMOTION_RENDERER_IPC_CHANNEL = "tweaker:promotion-renderer-proof";
export declare const PROMOTION_RENDERER_AUTH_CHANNEL = "tweaker:promotion-renderer-authorize";
export declare const PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
export declare const PROMOTION_RENDERER_SCHEME = "app";
export declare const PROMOTION_RENDERER_HOST = "-";
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
/** Pure, bounded decision used by the synchronous health-only IPC handler. */
export declare function authorizePromotionRenderer(context: PromotionRendererAuthorizationContext, payload: unknown, nonce: string): PromotionRendererAuthorizationDecision;
/** Pure, bounded gate in front of the proof tracker's one allowed handshake. */
export declare function validatePromotionRendererHandshake(context: PromotionRendererHandshakeContext, payload: unknown, nonce: string): PromotionRendererHandshakeDecision;
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
