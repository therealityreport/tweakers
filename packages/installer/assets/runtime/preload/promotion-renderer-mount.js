"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPromotionRendererMountTracker = createPromotionRendererMountTracker;
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