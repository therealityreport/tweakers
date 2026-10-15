/** Resources belong to one activation, including while start() is pending. */
export declare class TweakResources {
    private controller;
    private disposers;
    private closing;
    private ended;
    readonly signal: AbortSignal;
    assertActive(): void;
    cancel(): void;
    /** The returned disposer is idempotent, whether called by the tweak or host. */
    add(dispose: () => void | Promise<void>): () => Promise<void>;
    close(): Promise<void>;
}
/** Guard API entrypoints, not returned host objects, against stale async startup. */
export declare function guardTweakApi<T extends object>(api: T, resources: TweakResources): T;
