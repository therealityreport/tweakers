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
 * Proves the application renderer replaced its static startup loader with real
 * content. A pre-existing non-empty root is insufficient: the tracker must
 * first observe the canonical loader and then observe a non-empty replacement.
 */
export declare function createPromotionRendererMountTracker(): PromotionRendererMountTracker;
