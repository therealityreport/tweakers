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
export function createDesktopUpdateStartupReconciler(
  dependencies: DesktopUpdateStartupDependencies,
  options: DesktopUpdateStartupOptions = {},
): { schedule(): boolean } {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 30));
  const retryMs = Math.max(0, Math.floor(options.retryMs ?? 1_000));
  let scheduled = false;

  const attempt = (attempts: number): void => {
    let ready = false;
    try {
      ready = dependencies.windowReady();
    } catch (error) {
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
    } catch (error) {
      dependencies.onEvent({
        event: "desktop-update-startup-reconcile",
        result: "failed",
        attempts,
        ...errorEvidence(error),
      });
    }
  };

  return {
    schedule(): boolean {
      if (scheduled) return false;
      scheduled = true;
      dependencies.setTimer(() => attempt(1), 0);
      return true;
    },
  };
}

function errorEvidence(error: unknown): { error: string; errorCode?: string } {
  const record = error && typeof error === "object"
    ? error as { message?: unknown; code?: unknown }
    : null;
  return {
    error: typeof record?.message === "string" ? record.message : String(error),
    ...(typeof record?.code === "string" ? { errorCode: record.code } : {}),
  };
}
