export type PromotionRendererMountState = "waiting" | "mounted";
export interface PromotionRendererRootObservation {
    rootPresent: boolean;
    startupLoaderPresent: boolean;
    elementChildCount: number;
}
export interface PromotionRendererMountTracker {
    observe(observation: PromotionRendererRootObservation): PromotionRendererMountState;
    result(): PromotionRendererMountState;
}
export interface PromotionRendererAuthorizationRequest {
    version: 1;
    url: string;
}
export interface PromotionRendererAuthorizationResponse {
    version: 1;
    nonce: string;
    url: string;
}
export type PromotionRendererAuthorizationAttempt = {
    kind: "ordinary";
} | {
    kind: "invalid-candidate";
    reason: string;
} | {
    kind: "candidate";
    nonce: string;
    request: PromotionRendererAuthorizationRequest;
};
/**
 * Classifies the current document before page scripts run. Ordinary windows
 * take the normal preload path. A URL that carries the reserved proof query is
 * fail-closed unless it is the one exact candidate document shape.
 */
export declare function promotionRendererAuthorizationAttempt(href: string): PromotionRendererAuthorizationAttempt;
/** Accepts only the exact synchronous main-process authorization response. */
export declare function promotionRendererAuthorizedNonce(attempt: PromotionRendererAuthorizationAttempt, response: unknown): string | null;
/**
 * Proves the application renderer replaced its static startup loader with real
 * content. A pre-existing non-empty root is insufficient: the tracker must
 * first observe the canonical loader and then observe a non-empty replacement.
 */
export declare function createPromotionRendererMountTracker(): PromotionRendererMountTracker;
