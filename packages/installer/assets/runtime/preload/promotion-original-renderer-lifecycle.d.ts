export type PromotionOriginalRendererMountPhase = "loading" | "mount" | "settled";
export interface PromotionOriginalRendererMountScheduler {
    set(callback: () => void, timeoutMs: number): unknown;
    clear(handle: unknown): void;
}
export interface PromotionOriginalRendererMountLifecycle {
    /** Remembers an early mount, but cannot emit success before window load. */
    mountObserved(): boolean;
    /** Starts the one-shot post-load timeout or flushes a remembered mount. */
    windowLoaded(): boolean;
    settle(): void;
    phase(): PromotionOriginalRendererMountPhase;
}
/**
 * Browser-only, one-shot lifecycle for the original renderer preload proof.
 * Authorization may start observation early, but the timeout clock and any
 * successful proof remain gated on the document's actual load event.
 */
export declare function createPromotionOriginalRendererMountLifecycle(options: {
    onMounted: () => void;
    onTimeout: () => void;
    timeoutMs: number;
    scheduler?: PromotionOriginalRendererMountScheduler;
}): PromotionOriginalRendererMountLifecycle;
