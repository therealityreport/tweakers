interface MessageOptions { message?: string; cancelId?: number; buttons?: string[] }
interface DialogPort { showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }> }
/** Intercept only the inherited terminal startup error, never ordinary dialogs. */
export function installIndependentStartupRecovery(dialog: DialogPort, openDoctor: () => void): () => void {
  const original = dialog.showMessageBox;
  const replacement: DialogPort["showMessageBox"] = async (...args) => {
    const options = args[args.length - 1] as MessageOptions | undefined;
    if (options && typeof options.message === "string" && /^(?:ChatGPT|Codex|Tweakers) failed to start\.$/.test(options.message)) {
      try {
        openDoctor();
        // Bootstrap receives its original Quit index. The standalone recovery
        // process survives that failed application's exit and owns Retry/Repair.
        return { response: options.cancelId ?? Math.max(0, (options.buttons?.length ?? 1) - 1), checkboxChecked: false };
      } catch {
        await original.call(dialog, { ...options, message: "Tweakers needs recovery.", buttons: ["Quit"], cancelId: 0,
          detail: "Open Tweakers Doctor from the managed launcher, or run tweaker doctor --target independent --ui." });
        return { response: options.cancelId ?? Math.max(0, (options.buttons?.length ?? 1) - 1), checkboxChecked: false };
      }
    }
    return original.apply(dialog, args);
  };
  dialog.showMessageBox = replacement;
  return () => { if (dialog.showMessageBox === replacement) dialog.showMessageBox = original; };
}
