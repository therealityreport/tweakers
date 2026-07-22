"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promotionRendererAuthorizationAttempt = promotionRendererAuthorizationAttempt;
exports.promotionRendererAuthorizedNonce = promotionRendererAuthorizedNonce;
exports.createPromotionRendererMountTracker = createPromotionRendererMountTracker;
const PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
const PROMOTION_RENDERER_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Classifies the current document before page scripts run. Ordinary windows
 * take the normal preload path. A URL that carries the reserved proof query is
 * fail-closed unless it is the one exact candidate document shape.
 */
function promotionRendererAuthorizationAttempt(href) {
    try {
        const parsed = new URL(href);
        const queryEntries = [...parsed.searchParams.entries()];
        const hasReservedQuery = queryEntries.some(([key]) => key === PROMOTION_RENDERER_NONCE_QUERY);
        if (!hasReservedQuery)
            return { kind: "ordinary" };
        if (parsed.protocol !== "app:"
            || parsed.hostname !== "-"
            || parsed.username !== ""
            || parsed.password !== ""
            || parsed.port !== ""
            || parsed.pathname !== "/index.html"
            || parsed.hash !== ""
            || queryEntries.length !== 1
            || queryEntries[0]?.[0] !== PROMOTION_RENDERER_NONCE_QUERY)
            return { kind: "invalid-candidate", reason: "candidate URL shape invalid" };
        const nonce = queryEntries[0][1];
        if (!PROMOTION_RENDERER_NONCE_PATTERN.test(nonce)) {
            return { kind: "invalid-candidate", reason: "candidate nonce invalid" };
        }
        if (parsed.toString() !== href) {
            return { kind: "invalid-candidate", reason: "candidate URL is not canonical" };
        }
        return {
            kind: "candidate",
            nonce,
            request: { version: 1, url: href },
        };
    }
    catch {
        return { kind: "ordinary" };
    }
}
/** Accepts only the exact synchronous main-process authorization response. */
function promotionRendererAuthorizedNonce(attempt, response) {
    if (attempt.kind !== "candidate" || response === null || typeof response !== "object" || Array.isArray(response)) {
        return null;
    }
    const value = response;
    if (Object.keys(value).sort().join(",") !== "nonce,url,version")
        return null;
    if (value.version !== 1 || typeof value.nonce !== "string" || typeof value.url !== "string")
        return null;
    if (!PROMOTION_RENDERER_NONCE_PATTERN.test(value.nonce))
        return null;
    if (value.nonce !== attempt.nonce || value.url !== attempt.request.url)
        return null;
    try {
        const parsed = new URL(value.url);
        const entries = [...parsed.searchParams.entries()];
        if (parsed.protocol !== "app:"
            || parsed.hostname !== "-"
            || parsed.username !== ""
            || parsed.password !== ""
            || parsed.port !== ""
            || parsed.pathname !== "/index.html"
            || parsed.hash !== ""
            || entries.length !== 1
            || entries[0]?.[0] !== PROMOTION_RENDERER_NONCE_QUERY
            || entries[0][1] !== value.nonce
            || parsed.toString() !== value.url)
            return null;
        return value.nonce;
    }
    catch {
        return null;
    }
}
/**
 * Proves the application renderer replaced its static startup loader with real
 * content. A pre-existing non-empty root is insufficient: the tracker must
 * first observe the canonical loader and then observe a non-empty replacement.
 */
function createPromotionRendererMountTracker() {
    let sawStartupLoader = false;
    let mounted = false;
    return {
        observe(observation) {
            if (mounted)
                return "mounted";
            if (!observation.rootPresent)
                return "waiting";
            if (observation.startupLoaderPresent) {
                sawStartupLoader = true;
                return "waiting";
            }
            if (sawStartupLoader && Number.isSafeInteger(observation.elementChildCount) && observation.elementChildCount > 0) {
                mounted = true;
            }
            return mounted ? "mounted" : "waiting";
        },
        result() {
            return mounted ? "mounted" : "waiting";
        },
    };
}
//# sourceMappingURL=promotion-renderer-mount.js.map