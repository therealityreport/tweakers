export type SettingsProbeOutcome = "found" | "missing" | "rejected" | "suppressed";
export interface SettingsProbeMetrics {
    requestCount: number;
    coalescedRequestCount: number;
    backoffEventCount: number;
    activeTimerCount: number;
    probeCount: number;
    cumulativeProbeTimeMs: number;
    consecutiveMisses: number;
    currentBackoffMs: number;
    lastOutcome: SettingsProbeOutcome | null;
}
interface SettingsProbeSchedulerOptions {
    probe: () => SettingsProbeOutcome;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    onProbe?: (outcome: SettingsProbeOutcome, metrics: SettingsProbeMetrics) => void;
    /** Called at the scheduler's bounded retry cadence when a probe throws. */
    onProbeError?: (error: unknown) => void;
}
/**
 * Coalesces renderer mutation storms into bounded Settings probes.
 *
 * Missing Settings is probed at most four times per second, then once per
 * second after ten misses. A navigation request bypasses the current timer and
 * resets the miss backoff.
 */
export declare class SettingsProbeScheduler {
    private readonly probe;
    private readonly now;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly onProbe?;
    private readonly onProbeError?;
    private timer;
    private timerDueAt;
    private lastProbeAt;
    private running;
    private pending;
    private stopped;
    private metricsState;
    constructor(options: SettingsProbeSchedulerOptions);
    request(options?: {
        immediate?: boolean;
        resetBackoff?: boolean;
    }): void;
    stop(): void;
    metrics(): SettingsProbeMetrics;
    private runProbe;
    private nextDelayMs;
    private nextMissBackoffMs;
    private cancelTimer;
}
export {};
