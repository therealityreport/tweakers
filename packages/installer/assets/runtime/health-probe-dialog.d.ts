export interface HealthProbeDialogRecord {
    api: "showMessageBox" | "showMessageBoxSync" | "showErrorBox";
    message: string;
    detail: string;
}
export interface HealthProbeDialogTarget {
    showMessageBox?: unknown;
    showMessageBoxSync?: unknown;
    showErrorBox?: unknown;
}
/**
 * Stop a disposable health process from ever painting a modal panel.
 *
 * A health probe launches a SECOND, hidden instance of the desktop app with
 * OpenAI's real bootstrap running inside it, and the promotion proof ends by
 * terminating the Codex app-server that bootstrap spawned. OpenAI's supervisor
 * reacts to that (self-inflicted, expected) app-server death by calling
 * `dialog.showMessageBox` — an app-modal NSAlert with no parent window, which
 * `setActivationPolicy("prohibited")` and `dock.hide()` do not suppress. The
 * alert blocks the probe's main thread, so the probe never exits, and the
 * installer's blocking `spawnSync` sits on it until HEALTH_PROBE_PROCESS_TIMEOUT_MS.
 * Measured live on 2026-08-09: promotion proof at 03:37:36.825Z followed by the
 * next launch 170.75s later, and 10:42:57.715Z followed 171.06s later — both
 * pinned to the 170s timeout, i.e. the probe had to be killed. A third run only
 * took 53s because the user clicked the dialog by hand.
 *
 * Suppression is reported, never silent: every intercepted dialog is handed to
 * `onSuppressed` so it lands in the runtime log instead of on the user's screen.
 *
 * Strictly gated on `healthCheckOnly`. An ordinary launch must keep every real
 * error dialog OpenAI shows.
 */
export declare function applyHealthProbeDialogSuppression(input: {
    dialog: HealthProbeDialogTarget;
    healthCheckOnly: boolean;
    onSuppressed: (record: HealthProbeDialogRecord) => void;
}): boolean;
