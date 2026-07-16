export type SparkleLifecycleState = "idle" | "checking" | "downloading" | "ready" | "installing" | "failed";
export interface SparkleBridgeSnapshot {
    available: boolean;
    lifecycle: SparkleLifecycleState;
    downloadProgressPercent: number | null;
    installProgressPercent: number | null;
    ready: boolean;
    lastError: string | null;
    feedUrl: string | null;
    fallbackFeedUrl: string | null;
    canInstall: boolean;
    installPrerequisiteFailure: string | null;
}
export interface SparkleNativeExports {
    default?: unknown;
    init?: (...args: unknown[]) => unknown;
    checkForUpdates?: (...args: unknown[]) => unknown;
    checkForUpdatesInBackground?: (...args: unknown[]) => unknown;
    automaticallyChecksForUpdates?: boolean;
    updateCheckInterval?: number;
    setAutomaticallyChecksForUpdates?: (value: boolean) => unknown;
    setUpdateCheckInterval?: (seconds: number) => unknown;
    scheduleNextUpdateCheck?: (...args: unknown[]) => unknown;
    resetUpdateCycle?: (...args: unknown[]) => unknown;
    installLatestUpdate?: (...args: unknown[]) => unknown;
    installUpdatesIfAvailable?: (...args: unknown[]) => unknown;
    setUpdateLifecycleStateSink?: (sink: (...args: unknown[]) => void) => unknown;
    setDownloadProgressSink?: (sink: (...args: unknown[]) => void) => unknown;
    setInstallProgressSink?: (sink: (...args: unknown[]) => void) => unknown;
    setUpdateReadySink?: (sink: (...args: unknown[]) => void) => unknown;
    [key: string]: unknown;
}
export interface SparkleInstallPrerequisite {
    ok: boolean;
    reason?: string;
}
export interface SparkleAppcastMetadata {
    marketingVersion: string;
    build: string;
    releaseUrl: string | null;
    feedUrl: string;
    checkedAt: string;
    stale: boolean;
    error: string | null;
}
export interface SparkleFetchResponse {
    url: string;
    status: number;
    ok: boolean;
    headers: {
        get(name: string): string | null;
    };
    arrayBuffer(): Promise<ArrayBuffer | Uint8Array>;
}
export type SparkleFetch = (url: string, init: {
    headers?: unknown;
    signal: AbortSignal;
    redirect: "manual";
}) => Promise<SparkleFetchResponse>;
export interface CodexSparkleBridgeOptions {
    /** Restores the verified pristine app and enters update mode immediately before Sparkle installs. */
    prepareForInstall?: () => void | boolean;
    /** Rechecks signed-backup continuity without mutating the live app. */
    /** Return null when actionable, a safe reason string when blocked, or an explicit result. */
    getInstallPrerequisite?: () => SparkleInstallPrerequisite | string | null;
    fetch?: SparkleFetch;
    now?: () => Date;
    appcastTimeoutMs?: number;
    maxAppcastBytes?: number;
    maxAppcastRedirects?: number;
}
/**
 * A narrow observer/action seam around OpenAI's native Sparkle addon.
 *
 * OpenAI continues to own initialization and its callbacks. The bridge only
 * tees the native sinks, retains authorization headers in this object, and
 * exposes a redacted snapshot to the rest of Tweakers.
 */
export declare class CodexSparkleBridge {
    private options;
    private readonly wrapped;
    private native;
    private headers;
    private lastAppcast;
    private nativeChecksSuppressed;
    private nativeSchedulerDisabled;
    private state;
    constructor(options?: CodexSparkleBridgeOptions);
    configure(options: CodexSparkleBridgeOptions): void;
    wrapExports(loaded: unknown): void;
    getSnapshot(): SparkleBridgeSnapshot;
    installUpdate(): Promise<boolean>;
    /**
     * Read display-only release metadata from the feed OpenAI supplied to
     * Sparkle. Authorization headers never leave this method or enter its result.
     */
    fetchAppcastMetadata(): Promise<SparkleAppcastMetadata>;
    private wrapInit;
    /**
     * Sparkle's XPC bootstrap assumes the outer app still has OpenAI's signing
     * identity. In a locally signed Tweakers app, both manual and scheduled
     * checks relaunch the foreground ChatGPT executable while looking for that
     * service. Keep native checks inert and use the bounded signed-appcast path
     * for version discovery instead.
     */
    private suppressNativeChecks;
    private disableNativeScheduler;
    private wrapSink;
    private wrapInstall;
    private captureInit;
    private fetchBoundedAppcast;
    private observeLifecycle;
    private installPrerequisite;
    private refreshActionability;
    private fail;
}
export declare function getCodexSparkleBridge(): CodexSparkleBridge;
export declare function configureCodexSparkleBridge(options: CodexSparkleBridgeOptions): CodexSparkleBridge;
/** Test-only reset through the same public instance boundary. */
export declare function resetCodexSparkleBridgeForTests(options?: CodexSparkleBridgeOptions): CodexSparkleBridge;
