"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDesktopUpdateStartupReconciler = createDesktopUpdateStartupReconciler;
/**
 * Schedule one bounded startup reconciliation after Electron is ready. A
 * missing visible window or launcher failure is diagnostic evidence only; it
 * must never abort the desktop app's module initialization.
 */
function createDesktopUpdateStartupReconciler(dependencies, options = {}) {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 30));
    const retryMs = Math.max(0, Math.floor(options.retryMs ?? 1_000));
    let scheduled = false;
    const attempt = (attempts) => {
        let ready = false;
        try {
            ready = dependencies.windowReady();
        }
        catch (error) {
            dependencies.onEvent({
                event: "desktop-update-startup-reconcile",
                result: "failed",
                attempts,
                ...errorEvidence(error),
            });
            return;
        }
        if (!ready) {
            if (attempts >= maxAttempts) {
                dependencies.onEvent({
                    event: "desktop-update-startup-reconcile",
                    result: "window-unavailable",
                    attempts,
                });
                return;
            }
            dependencies.setTimer(() => attempt(attempts + 1), retryMs);
            return;
        }
        try {
            dependencies.launch();
            dependencies.onEvent({
                event: "desktop-update-startup-reconcile",
                result: "submitted",
                attempts,
            });
        }
        catch (error) {
            dependencies.onEvent({
                event: "desktop-update-startup-reconcile",
                result: "failed",
                attempts,
                ...errorEvidence(error),
            });
        }
    };
    return {
        schedule() {
            if (scheduled)
                return false;
            scheduled = true;
            dependencies.setTimer(() => attempt(1), 0);
            return true;
        },
    };
}
function errorEvidence(error) {
    const record = error && typeof error === "object"
        ? error
        : null;
    return {
        error: typeof record?.message === "string" ? record.message : String(error),
        ...(typeof record?.code === "string" ? { errorCode: record.code } : {}),
    };
}
//# sourceMappingURL=desktop-update-startup.js.map