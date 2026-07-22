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
export function createPromotionOriginalRendererMountLifecycle(options: {
  onLoadObserved: () => void;
  onMounted: () => void;
  onTimeout: () => void;
  timeoutMs: number;
  scheduler?: PromotionOriginalRendererMountScheduler;
}): PromotionOriginalRendererMountLifecycle {
  const scheduler = options.scheduler ?? {
    set(callback, timeoutMs) {
      return setTimeout(callback, timeoutMs);
    },
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  let phase: PromotionOriginalRendererMountPhase = "loading";
  let mounted = false;
  let loadObserved = false;
  let handle: unknown = null;

  const settle = (callback?: () => void): void => {
    if (phase === "settled") return;
    if (handle !== null) scheduler.clear(handle);
    handle = null;
    phase = "settled";
    callback?.();
  };

  return {
    mountObserved() {
      if (phase === "settled" || mounted) return false;
      mounted = true;
      if (phase === "mount") settle(options.onMounted);
      return true;
    },
    windowLoaded() {
      if (phase !== "loading" || loadObserved) return false;
      loadObserved = true;
      try {
        options.onLoadObserved();
      } catch (error) {
        phase = "settled";
        throw error;
      }
      phase = "mount";
      if (mounted) {
        settle(options.onMounted);
      } else {
        handle = scheduler.set(() => {
          if (phase !== "mount") return;
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
