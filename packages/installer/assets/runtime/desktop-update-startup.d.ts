export interface DesktopUpdateStartupEvent {
    event: "desktop-update-startup-reconcile";
    result: "submitted" | "window-unavailable" | "failed";
    attempts: number;
    error?: string;
    errorCode?: string;
}
export interface DesktopUpdateStartupDependencies {
    windowReady(): boolean;
    launch(): void;
    setTimer(callback: () => void, delayMs: number): unknown;
    onEvent(event: DesktopUpdateStartupEvent): void;
}
export interface DesktopUpdateStartupOptions {
    maxAttempts?: number;
    retryMs?: number;
}
/**
 * Schedule one bounded startup reconciliation after Electron is ready. A
 * missing visible window or launcher failure is diagnostic evidence only; it
 * must never abort the desktop app's module initialization.
 */
export declare function createDesktopUpdateStartupReconciler(dependencies: DesktopUpdateStartupDependencies, options?: DesktopUpdateStartupOptions): {
    schedule(): boolean;
};
