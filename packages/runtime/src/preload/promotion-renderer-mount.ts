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
