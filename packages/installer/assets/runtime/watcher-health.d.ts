import { type WatcherHealthEntry } from "./watcher-registry";
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
    watchers: WatcherHealthEntry[];
}
export interface WatcherHealthProbeDependencies {
    homeDirectory?: string;
    platformKind?: NodeJS.Platform;
    launchdState?: (label: string) => LaunchdLoadedState;
    pathExists?: (path: string) => boolean;
    modifiedAt?: (path: string) => string | null;
    readJsonDocument?: (path: string) => Record<string, unknown> | null;
}
export interface PublishedWatcherHealth {
    schema: "tweakers.health.v1";
    schemaVersion: 1;
    checkedAt: string;
    status: CheckStatus;
    watchers: WatcherHealthEntry[];
}
export interface WatcherHealthPublisherDependencies {
    writeAtomic?: (path: string, document: PublishedWatcherHealth) => void;
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
/**
 * Verified fingerprint metadata for one packaged runtime tree. Consumers use
 * this to prove the exact files that were validated, not merely the digest
 * recorded in the runtime manifest.
 */
export interface RuntimeFingerprintEvidence {
    fingerprint: string;
    fileCount: number;
}
export declare function getWatcherHealth(userRoot: string, probeDependencies?: WatcherHealthProbeDependencies): WatcherHealth;
/**
 * Reads the canonical health truth and publishes a privacy-bounded snapshot
 * for read-only consumers such as Menu Bar. A failing current snapshot never
 * replaces the last-known-good watcher snapshot.
 */
export declare function getAndPublishWatcherHealth(userRoot: string, probeDependencies?: WatcherHealthProbeDependencies, publisherDependencies?: WatcherHealthPublisherDependencies): WatcherHealth;
export declare function publishWatcherHealthSnapshot(userRoot: string, health: WatcherHealth, dependencies?: WatcherHealthPublisherDependencies): PublishedWatcherHealth;
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
export declare function readRuntimeFingerprintEvidence(root: string): RuntimeFingerprintEvidence | null;
export {};
