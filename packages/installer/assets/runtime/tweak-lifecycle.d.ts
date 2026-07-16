export type TweakScope = "renderer" | "main" | "both";
/**
 * Lifecycle states are deliberately more detailed than the user-facing
 * installed/enabled status.  A tweak may be visible as enabled while its
 * asynchronous start is still in flight, or as failed after another tweak
 * has already reached ready.
 */
export declare const TWEAK_LIFECYCLE_STATUSES: readonly ["starting", "ready", "failed", "timed_out", "disabled", "quarantined"];
export type TweakLifecycleStatus = (typeof TWEAK_LIFECYCLE_STATUSES)[number];
export type TweakProcess = "main" | "renderer";
export interface TweakLifecycleRecord {
    id: string;
    process: TweakProcess;
    status: TweakLifecycleStatus;
    attemptId: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    /** Consecutive startup attempts cut short by a process exit; reset by a successful ready. */
    interruptedAttempts?: number;
}
export interface TweakLifecycleAttempt {
    id: string;
    pid?: number;
    startedAt: string;
    completedAt?: string;
}
export interface TweakLifecycleJournal {
    schemaVersion: 1;
    currentAttempt: TweakLifecycleAttempt | null;
    records: Record<string, TweakLifecycleRecord>;
}
export declare function createTweakLifecycleJournal(attemptId?: string, pid?: number, startedAt?: string): TweakLifecycleJournal;
export declare const DEFAULT_TWEAK_STARTUP_TIMEOUT_MS = 5000;
export declare const MIN_TWEAK_STARTUP_TIMEOUT_MS = 100;
export declare const MAX_TWEAK_STARTUP_TIMEOUT_MS = 30000;
export declare function normalizeTweakStartupTimeoutMs(value: unknown): number;
/**
 * Race a tweak's startup promise against a bounded timeout.  The original
 * promise is observed after the timeout so a late rejection cannot become an
 * unhandled rejection, while the caller is free to continue loading sibling
 * tweaks immediately.
 */
export declare function withStartupTimeout<T>(value: PromiseLike<T> | T, timeoutMs?: number): Promise<{
    status: "ready";
    value: T;
} | {
    status: "timed_out";
}>;
/** Convenience form for callers that have a lazy start operation. */
export declare function runWithStartupTimeout<T>(start: () => PromiseLike<T> | T, timeoutMs?: number): Promise<{
    status: "ready";
    value: T;
} | {
    status: "timed_out";
}>;
export declare function lifecycleRecordKey(process: TweakProcess, id: string): string;
/**
 * Bind a main-process tweak's `stop()` to the tweak object so cleanup that
 * relies on `this` (per-instance disposers, IPC handle removers) works. The
 * renderer host binds stop the same way (preload/tweak-host.ts); the main
 * runtime historically stored it unbound, silently breaking `this`-based main
 * cleanup for `scope: "both"` tweaks (followup).
 */
export declare function bindMainTweakStop<T extends {
    stop?: (...args: unknown[]) => unknown;
}>(tweak: T | null | undefined): T["stop"] | undefined;
/**
 * A whole-app restart racing the sequential tweak-load loop leaves innocent
 * tweaks in "starting"; only repeated interruptions indicate the tweak itself
 * is hanging startup. One interruption is therefore retried, not quarantined.
 */
export declare const INTERRUPTED_ATTEMPTS_BEFORE_QUARANTINE = 2;
/**
 * Turn a journal from a previous process into explicit records. Only records
 * from the unfinished current attempt are changed; historical ready/failed
 * records remain available for diagnostics. A first interruption becomes a
 * retryable "failed"; INTERRUPTED_ATTEMPTS_BEFORE_QUARANTINE consecutive
 * interruptions quarantine the tweak.
 */
export declare function recoverInterruptedTweaks(journal: TweakLifecycleJournal, now?: string): TweakLifecycleJournal;
export interface ReloadTweaksDeps {
    logInfo(message: string): void;
    stopAllMainTweaks(): void;
    clearTweakModuleCache(): void;
    loadAllMainTweaks(): void;
    broadcastReload(): void;
}
export interface SetTweakEnabledAndReloadDeps extends ReloadTweaksDeps {
    setTweakEnabled(id: string, enabled: boolean): void;
}
export declare function isMainProcessTweakScope(scope: TweakScope | undefined): boolean;
export declare function reloadTweaks(reason: string, deps: ReloadTweaksDeps): void;
export declare function setTweakEnabledAndReload(id: string, enabled: unknown, deps: SetTweakEnabledAndReloadDeps): true;
