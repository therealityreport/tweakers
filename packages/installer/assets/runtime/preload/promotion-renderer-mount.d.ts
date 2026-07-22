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
/**
 * Creates the one renderer-process argument that binds a proof window to its
 * main-generated nonce and exact candidate ASAR URL. Electron exposes argv in
 * sandboxed preloads even though it does not expose process.resourcesPath.
 */
export declare function promotionRendererBindingArgument(nonce: string, url: string): string;
/** Accepts only the exact URL/nonce binding supplied to this proof renderer. */
export declare function promotionRendererNonce(href: string, argv: readonly string[]): string | null;
/**
 * Proves the application renderer replaced its static startup loader with real
 * content. A pre-existing non-empty root is insufficient: the tracker must
 * first observe the canonical loader and then observe a non-empty replacement.
 */
export declare function createPromotionRendererMountTracker(): PromotionRendererMountTracker;
