interface DialogPort {
    showMessageBox: (...args: unknown[]) => Promise<{
        response: number;
        checkboxChecked: boolean;
    }>;
}
/** Intercept only the inherited terminal startup error, never ordinary dialogs. */
export declare function installIndependentStartupRecovery(dialog: DialogPort, openDoctor: () => void): () => void;
export {};
