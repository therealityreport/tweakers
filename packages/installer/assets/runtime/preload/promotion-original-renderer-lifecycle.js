"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPromotionOriginalRendererMountLifecycle = createPromotionOriginalRendererMountLifecycle;
/**
 * Browser-only, one-shot lifecycle for the original renderer preload proof.
 * Authorization may start observation early, but the timeout clock and any
 * successful proof remain gated on the document's actual load event.
 */
function createPromotionOriginalRendererMountLifecycle(options) {
    const scheduler = options.scheduler ?? {
        set(callback, timeoutMs) {
            return setTimeout(callback, timeoutMs);
        },
        clear(handle) {
            clearTimeout(handle);
        },
    };
    let phase = "loading";
    let mounted = false;
    let handle = null;
    const settle = (callback) => {
        if (phase === "settled")
            return;
        if (handle !== null)
            scheduler.clear(handle);
        handle = null;
        phase = "settled";
        callback?.();
    };
    return {
        mountObserved() {
            if (phase === "settled" || mounted)
                return false;
            mounted = true;
            if (phase === "mount")
                settle(options.onMounted);
            return true;
        },
        windowLoaded() {
            if (phase !== "loading")
                return false;
            phase = "mount";
            if (mounted) {
                settle(options.onMounted);
            }
            else {
                handle = scheduler.set(() => {
                    if (phase !== "mount")
                        return;
                    handle = null;
                    phase = "settled";
                    options.onTimeout();
                }, options.timeoutMs);
            }
            return true;
        },
        settle() {
            settle();
        },
        phase() {
            return phase;
        },
    };
}
//# sourceMappingURL=promotion-original-renderer-lifecycle.js.map