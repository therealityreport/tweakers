export type TweakLifecyclePhase = "shutdown" | "activate";
export interface TweakLifecycleAcknowledgement {
    operationId: string;
    phase: TweakLifecyclePhase;
    instanceToken: string;
    ok: boolean;
    error?: string;
}
export interface TweakLifecycleBarrierOptions {
    operationId: string;
    phase: TweakLifecyclePhase;
    expectedInstanceTokens: readonly string[];
    timeoutMs?: number;
}
export interface TweakLifecycleBarrier {
    readonly completion: Promise<void>;
    /** False means the acknowledgement did not belong to a pending participant. */
    acknowledge(ack: TweakLifecycleAcknowledgement): boolean;
    /** Navigation/destruction invalidates a required participant while the barrier is pending. */
    invalidate(instanceToken: string, reason?: string): void;
    cancel(reason?: string): void;
}
/** Instance tokens must identify one document/runtime generation, not just a window. */
export declare function createTweakLifecycleBarrier(options: TweakLifecycleBarrierOptions): TweakLifecycleBarrier;
