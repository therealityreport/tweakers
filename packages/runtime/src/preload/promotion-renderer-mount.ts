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
const PROMOTION_RENDERER_BINDING_PREFIX = "--tweaker-promotion-renderer-proof=";
const PROMOTION_RENDERER_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Creates the one renderer-process argument that binds a proof window to its
 * main-generated nonce and exact candidate ASAR URL. Electron exposes argv in
 * sandboxed preloads even though it does not expose process.resourcesPath.
 */
export function promotionRendererBindingArgument(nonce: string, url: string): string {
  if (!PROMOTION_RENDERER_NONCE_PATTERN.test(nonce)) throw new Error("invalid promotion renderer nonce");
  const parsed = new URL(url);
  const queryEntries = [...parsed.searchParams.entries()];
  if (
    parsed.protocol !== "file:"
    || parsed.hash !== ""
    || queryEntries.length !== 1
    || queryEntries[0]?.[0] !== PROMOTION_RENDERER_NONCE_QUERY
    || queryEntries[0][1] !== nonce
  ) throw new Error("invalid promotion renderer URL binding");
  return `${PROMOTION_RENDERER_BINDING_PREFIX}${encodeURIComponent(JSON.stringify({
    version: 1,
    nonce,
    url: parsed.toString(),
  }))}`;
}

/** Accepts only the exact URL/nonce binding supplied to this proof renderer. */
export function promotionRendererNonce(href: string, argv: readonly string[]): string | null {
  try {
    const bindings = argv.filter((argument) => argument.startsWith(PROMOTION_RENDERER_BINDING_PREFIX));
    if (bindings.length !== 1) return null;
    const encoded = bindings[0]!.slice(PROMOTION_RENDERER_BINDING_PREFIX.length);
    if (encoded.length === 0) return null;
    const decoded = JSON.parse(decodeURIComponent(encoded)) as unknown;
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const binding = decoded as Record<string, unknown>;
    if (Object.keys(binding).sort().join(",") !== "nonce,url,version") return null;
    if (binding.version !== 1 || typeof binding.nonce !== "string" || typeof binding.url !== "string") return null;
    if (!PROMOTION_RENDERER_NONCE_PATTERN.test(binding.nonce) || binding.url !== href) return null;

    const parsed = new URL(binding.url);
    if (parsed.protocol !== "file:" || parsed.hash !== "") return null;
    const queryEntries = [...parsed.searchParams.entries()];
    if (queryEntries.length !== 1 || queryEntries[0]?.[0] !== PROMOTION_RENDERER_NONCE_QUERY) return null;
    const nonce = queryEntries[0][1];
    return nonce === binding.nonce ? nonce : null;
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
