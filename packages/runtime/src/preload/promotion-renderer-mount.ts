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

const PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
const PROMOTION_RENDERER_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROMOTION_RENDERER_AUTH_RESPONSE_MAX_CHARS = 1_024;

export interface PromotionRendererAuthorizationRequest {
  version: 1;
  url: string;
}

export interface PromotionRendererAuthorizationResponse {
  version: 1;
  nonce: string;
  url: string;
}

export type PromotionRendererAuthorizationAttempt =
  | { kind: "ordinary" }
  | { kind: "invalid-candidate"; reason: string }
  | {
    kind: "candidate";
    nonce: string;
    request: PromotionRendererAuthorizationRequest;
  };

/**
 * Classifies the current document before page scripts run. Ordinary windows
 * take the normal preload path. A URL that carries the reserved proof query is
 * fail-closed unless it is the one exact candidate document shape.
 */
export function promotionRendererAuthorizationAttempt(href: string): PromotionRendererAuthorizationAttempt {
  try {
    const parsed = new URL(href);
    const queryEntries = [...parsed.searchParams.entries()];
    const hasReservedQuery = queryEntries.some(([key]) => key === PROMOTION_RENDERER_NONCE_QUERY);
    if (!hasReservedQuery) return { kind: "ordinary" };
    if (
      parsed.protocol !== "app:"
      || parsed.hostname !== "-"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.port !== ""
      || parsed.pathname !== "/index.html"
      || parsed.hash !== ""
      || queryEntries.length !== 1
      || queryEntries[0]?.[0] !== PROMOTION_RENDERER_NONCE_QUERY
    ) return { kind: "invalid-candidate", reason: "candidate URL shape invalid" };
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
  } catch {
    return { kind: "ordinary" };
  }
}

/** Accepts only the exact synchronous main-process authorization response. */
export function promotionRendererAuthorizedNonce(
  attempt: PromotionRendererAuthorizationAttempt,
  response: unknown,
): string | null {
  if (
    attempt.kind !== "candidate"
    || typeof response !== "string"
    || response.length === 0
    || response.length > PROMOTION_RENDERER_AUTH_RESPONSE_MAX_CHARS
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(response) as unknown;
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const value = decoded as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "nonce,url,version") return null;
    if (value.version !== 1 || typeof value.nonce !== "string" || typeof value.url !== "string") return null;
    if (!PROMOTION_RENDERER_NONCE_PATTERN.test(value.nonce)) return null;
    if (value.nonce !== attempt.nonce || value.url !== attempt.request.url) return null;
    const parsed = new URL(value.url);
    const entries = [...parsed.searchParams.entries()];
    if (
      parsed.protocol !== "app:"
      || parsed.hostname !== "-"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.port !== ""
      || parsed.pathname !== "/index.html"
      || parsed.hash !== ""
      || entries.length !== 1
      || entries[0]?.[0] !== PROMOTION_RENDERER_NONCE_QUERY
      || entries[0][1] !== value.nonce
      || parsed.toString() !== value.url
    ) return null;
    return value.nonce;
  } catch {
    return null;
  }
}

/**
 * Proves the application renderer replaced its static startup loader with real
 * content. A pre-existing non-empty root is insufficient: the tracker must
 * first observe the canonical loader and then observe a non-empty replacement.
 */
export function createPromotionRendererMountTracker(): PromotionRendererMountTracker {
  let sawStartupLoader = false;
  let mounted = false;

  return {
    observe(observation) {
      if (mounted) return "mounted";
      if (!observation.rootPresent) return "waiting";
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
