export interface HealthProbeDialogRecord {
  api: "showMessageBox" | "showMessageBoxSync" | "showErrorBox";
  message: string;
  detail: string;
}

interface MessageBoxOptions {
  message?: unknown;
  detail?: unknown;
  buttons?: unknown;
  cancelId?: unknown;
  defaultId?: unknown;
}

export interface HealthProbeDialogTarget {
  showMessageBox?: unknown;
  showMessageBoxSync?: unknown;
  showErrorBox?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The index a suppressed message box reports as "clicked".
 *
 * Callers await a choice, so a suppressed dialog must still answer one.
 * Cancel is the only safe answer: it is the button OpenAI's own code treats as
 * "do nothing", where the default is frequently a destructive action (the
 * observed "ChatGPT failed to start." alert defaults to "Check for Updates"
 * and cancels to "Quit" — and this process is about to exit anyway).
 */
function cancelIndex(options: MessageBoxOptions): number {
  if (typeof options.cancelId === "number" && Number.isInteger(options.cancelId) && options.cancelId >= 0) {
    return options.cancelId;
  }
  const buttons = Array.isArray(options.buttons) ? options.buttons.length : 0;
  return buttons > 0 ? buttons - 1 : 0;
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
export function applyHealthProbeDialogSuppression(input: {
  dialog: HealthProbeDialogTarget;
  healthCheckOnly: boolean;
  onSuppressed: (record: HealthProbeDialogRecord) => void;
}): boolean {
  if (!input.healthCheckOnly) return false;
  const { dialog, onSuppressed } = input;

  const originals = {
    showMessageBox: dialog.showMessageBox,
    showMessageBoxSync: dialog.showMessageBoxSync,
    showErrorBox: dialog.showErrorBox,
  };

  // Both arities are in use: showMessageBox([browserWindow, ]options).
  const optionsOf = (args: unknown[]): MessageBoxOptions => {
    const last = args[args.length - 1];
    return last && typeof last === "object" ? last as MessageBoxOptions : {};
  };

  dialog.showMessageBox = (...args: unknown[]): Promise<{ response: number; checkboxChecked: boolean }> => {
    const options = optionsOf(args);
    onSuppressed({ api: "showMessageBox", message: text(options.message), detail: text(options.detail) });
    return Promise.resolve({ response: cancelIndex(options), checkboxChecked: false });
  };

  dialog.showMessageBoxSync = (...args: unknown[]): number => {
    const options = optionsOf(args);
    onSuppressed({ api: "showMessageBoxSync", message: text(options.message), detail: text(options.detail) });
    return cancelIndex(options);
  };

  dialog.showErrorBox = (title: unknown, content: unknown): void => {
    onSuppressed({ api: "showErrorBox", message: text(title), detail: text(content) });
  };

  // Fail closed, like the mock-Keychain switch: a probe that could still paint
  // a modal panel can still hang the installer behind it.
  for (const [api, original] of Object.entries(originals)) {
    if (original !== undefined && dialog[api as keyof HealthProbeDialogTarget] === original) {
      throw new Error(`health-only Electron process could not suppress dialog.${api}`);
    }
  }
  return true;
}
