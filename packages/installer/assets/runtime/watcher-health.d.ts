type CheckStatus = "ok" | "warn" | "error";
export interface WatcherHealthCheck {
    name: string;
    status: CheckStatus;
    detail: string;
}
export interface WatcherHealth {
    checkedAt: string;
    status: CheckStatus;
    title: string;
    summary: string;
    watcher: string;
    checks: WatcherHealthCheck[];
    latestCompletedCycle?: WatcherCycleReceipt;
}
export interface LaunchdLoadedState {
    loaded: boolean;
    running: boolean;
    lastExitCode: number | null;
    command?: string | null;
}
export interface WatcherCycleReceipt {
    schemaVersion: 1;
    cycleId: string;
    startedAt: string;
    completedAt: string;
    update: {
        status: "succeeded" | "failed" | "skipped" | "pending";
        error: string | null;
    };
    repair: {
        status: "succeeded" | "failed" | "skipped" | "pending";
        error: string | null;
    };
    outcome: "completed" | "failed";
    error: string | null;
}
export interface RuntimeFingerprintSet {
    generated: string | null;
    managed: string | null;
    active: string | null;
}
export interface RuntimeFingerprintHealth extends RuntimeFingerprintSet {
    status: "current" | "managed-pending" | "runtime-pending" | "unknown";
}
export declare function getWatcherHealth(userRoot: string): WatcherHealth;
export declare function analyzeLaunchdWatcherDefinition(input: {
    appRoot: string;
    plist: string;
    plistPath: string;
    loaded: LaunchdLoadedState;
}): WatcherHealthCheck[];
export declare function analyzeScheduledTaskWatcher(taskExists: (name: string) => boolean): WatcherHealthCheck[];
export declare function analyzeWatcherLogTail(tail: string): WatcherHealthCheck;
export declare function analyzeWatcherCycleReceipt(receipt: WatcherCycleReceipt): WatcherHealthCheck;
export declare function classifyRuntimeFingerprints(values: RuntimeFingerprintSet): RuntimeFingerprintHealth;
export declare function parseLaunchdLoadedCommand(output: string): string | null;
export {};
