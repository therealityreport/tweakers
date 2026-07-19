export type CodexDesktopReleaseProfile = "stable" | "alpha";
export interface CodexDesktopUpdateTarget {
    profile: CodexDesktopReleaseProfile;
    available: boolean;
    unavailableReason: string | null;
    setupRequired?: "register-beta" | "launch-beta" | null;
    /** Verified profile identity used to isolate persisted appcast state. */
    identityKey?: string | null;
    /** Profile-scoped captured feed. Alpha never receives the stable fallback. */
    feedUrl?: string | null;
    fallbackFeedUrl?: string | null;
}
export interface CodexDesktopVersionIdentity {
    marketingVersion: string | null;
    build: string | null;
}
export interface CodexDesktopUpdateMetadata {
    installed: CodexDesktopVersionIdentity;
    latest: CodexDesktopVersionIdentity;
    checkedAt: string;
    stale: boolean;
    error: string | null;
    updateAvailable: boolean;
}
export type CodexDesktopUpdateCheckStatus = "update-available" | "current" | "stale" | "unavailable" | "error";
export interface CodexDesktopUpdateCheckResult {
    schemaVersion: 1;
    status: CodexDesktopUpdateCheckStatus;
    profile: CodexDesktopReleaseProfile | null;
    installed: CodexDesktopVersionIdentity;
    latest: CodexDesktopVersionIdentity;
    checkedAt: string;
    reason: string | null;
    retryRequested: boolean;
    updateAndReloadRequested: boolean;
    nativeUpdateControlActive?: boolean;
    javaScriptUpdaterManagerAvailable?: boolean;
    javaScriptUpdaterManagerReason?: string | null;
    setupRequired?: "register-beta" | "launch-beta" | null;
}
/** Electron MessageBoxOptions subset kept free of Electron so the service is unit-testable. */
export interface CodexDesktopUpdateDialog {
    type: "none" | "info" | "error";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
}
export interface CodexDesktopUpdateServiceDependencies {
    resolveTarget(): Promise<CodexDesktopUpdateTarget>;
    refreshMetadata(target: CodexDesktopUpdateTarget): Promise<CodexDesktopUpdateMetadata>;
    showDialog(dialog: CodexDesktopUpdateDialog): Promise<{
        response: number;
    }>;
    startUpdateAndReload(): void | Promise<void>;
    scheduleRetry?(retry: () => void): void;
    /** Publishes each completed metadata check to renderer and native UI surfaces. */
    onResult?(result: CodexDesktopUpdateCheckResult): void;
}
export interface CodexDesktopUpdateService {
    /** Menu and Config callers share the exact in-flight promise and native dialog. */
    checkAndPresent(): Promise<CodexDesktopUpdateCheckResult>;
    /** Safe metadata-only check for proactive notifications; never opens a dialog. */
    checkSilently(): Promise<CodexDesktopUpdateCheckResult>;
    /** Last completed metadata result, retained so newly mounted UI cannot miss it. */
    getSnapshot(): CodexDesktopUpdateCheckResult | null;
}
export declare function createCodexDesktopUpdateService(dependencies: CodexDesktopUpdateServiceDependencies): CodexDesktopUpdateService;
