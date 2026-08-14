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
export interface SparkleFeedCapture {
    feedUrl: string | null;
    fallbackFeedUrl: string | null;
}
export interface SparkleProfileFeed {
    /** Stable key derived from the verified application identity/profile. */
    identityKey: string;
    feedUrl: string;
    fallbackFeedUrl?: string | null;
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
    /** Health-only: wrap native updater exports without entering native code. */
    suppressNativeSideEffects?: boolean;
    /** Runs the bounded Tweakers-owned manual update check without invoking raw Sparkle/XPC. */
    requestManualCheck?: () => void | Promise<void>;
    /** Runs the bounded metadata-only check used by OpenAI's startup/interval timer. */
    requestBackgroundCheck?: () => void | Promise<void>;
    /** Starts Tweakers' durable desktop-update transaction from OpenAI's native Update control. */
    requestInstall?: () => void | Promise<void>;
    /** Restores the verified pristine app and enters update mode immediately before Sparkle installs. */
    prepareForInstall?: () => void | boolean;
    /** Rechecks signed-backup continuity without mutating the live app. */
    /** Return null when actionable, a safe reason string when blocked, or an explicit result. */
    getInstallPrerequisite?: () => SparkleInstallPrerequisite | string | null;
    /** Protected shells may prohibit every autonomous update until fresh authority exists. */
    assertProtectedUpdateAllowed?: () => void;
    fetch?: SparkleFetch;
    now?: () => Date;
    appcastTimeoutMs?: number;
    maxAppcastBytes?: number;
    maxAppcastRedirects?: number;
    onNativeControlActivityChanged?: (active: boolean) => void;
    /** Receives only redacted HTTPS URLs after OpenAI's native init succeeds. */
    onFeedCaptured?: (capture: SparkleFeedCapture) => void;
}
/**
 * Keeps OpenAI's native updater entry points wrapped but observational during
 * one-shot health execution. No returned callback reaches networking, UI,
 * persistence, app replacement, or signed-app preparation.
 */
export declare function createHealthProbeCodexSparkleBridgeOptions(): CodexSparkleBridgeOptions;
export declare const CODEX_PUBLIC_PRODUCTION_APPCAST = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
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
    private readonly lastAppcasts;
    private nativeChecksSuppressed;
    private nativeSchedulerDisabled;
    private safeUpdateAvailable;
    private readonly downstreamSinks;
    private state;
    constructor(options?: CodexSparkleBridgeOptions);
    configure(options: CodexSparkleBridgeOptions): void;
    wrapExports(loaded: unknown): void;
    getSnapshot(): SparkleBridgeSnapshot;
    nativeUpdateControlActive(): boolean;
    /**
     * Reuses OpenAI's own animated update control for a release discovered by
     * Tweakers' metadata-only checker. Its install action is redirected to the
     * durable environment transaction, never to raw Sparkle in the patched app.
     */
    setSafeUpdateAvailable(available: boolean): void;
    installUpdate(): Promise<boolean>;
    /**
     * Read display-only release metadata from the feed OpenAI supplied to
     * Sparkle. Authorization headers never leave this method or enter its result.
     */
    fetchAppcastMetadata(): Promise<SparkleAppcastMetadata>;
    /**
     * Fetch metadata only from a feed captured for one verified app identity.
     * There is deliberately no production fallback here: Alpha must never read
     * Stable metadata, even when its captured feed is unavailable.
     */
    fetchProfileAppcastMetadata(profileFeed: SparkleProfileFeed): Promise<SparkleAppcastMetadata>;
    private fetchAppcastCandidates;
    private wrapInit;
    /**
     * Sparkle's XPC bootstrap assumes the outer app still has OpenAI's signing
     * identity. In a locally signed Tweakers app, raw checks relaunch the
     * foreground ChatGPT executable while looking for that service. Redirect the
     * visible manual command and OpenAI's background timer to Tweakers' bounded
     * services while keeping raw native checks inert.
     */
    private suppressNativeChecks;
    private disableNativeScheduler;
    private wrapSink;
    private wrapInstall;
    private replaySafeUpdateToSink;
    private emitDownstream;
    private restoreSafeUpdateAfterInstallFailure;
    private captureInit;
    private capturedFeedForPersistence;
    private fetchBoundedAppcast;
    private observeLifecycle;
    private installPrerequisite;
    private assertUpdateAllowed;
    private refreshActionability;
    private fail;
}
export declare function getCodexSparkleBridge(): CodexSparkleBridge;
export declare function configureCodexSparkleBridge(options: CodexSparkleBridgeOptions): CodexSparkleBridge;
/** Test-only reset through the same public instance boundary. */
export declare function resetCodexSparkleBridgeForTests(options?: CodexSparkleBridgeOptions): CodexSparkleBridge;
