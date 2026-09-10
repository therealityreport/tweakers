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
 * Publish the runtime half of the manager-owned readiness challenge.
 *
 * The expectation deliberately remains in place after this atomic write. The
 * manager authenticates both files and is the sole owner allowed to remove the
 * expectation after accepting the receipt.
 */
export declare function publishIndependentTweakersRuntimeReadyReceipt(receiptPath: string, receipt: unknown, pid?: number): void;
export declare function desktopUpdateStartupEnabled(environment?: NodeJS.ProcessEnv, identity?: {
    bundleIdentifier?: string | null;
    appPath?: string | null;
    verifiedDerivedAppPath?: string | null;
}): boolean;
type VariantGenerationKind = "file" | "directory";
interface VariantGenerationFingerprint {
    kind: VariantGenerationKind;
    mode: number;
    sha256: string;
}
/** Test seam for the early derived-variant bootstrap guard. */
export interface TweakersVariantBootstrapOptions {
    environment?: NodeJS.ProcessEnv;
    resourcesPath?: string;
    /**
     * Electron's normal fs facade treats app.asar as a virtual directory. The
     * installed app passes original-fs here so the generation receipt is bound
     * to the physical archive bytes rather than Electron's unpacked view.
     */
    fileSystem?: TweakersVariantFilesystem;
}
export interface TweakersVariantFilesystem {
    existsSync(path: string): boolean;
    lstatSync(path: string): {
        isDirectory(): boolean;
        isFile(): boolean;
        isSymbolicLink(): boolean;
        mode: number | bigint;
        uid?: number;
    };
    readFileSync(path: string): Buffer;
    readdirSync(path: string, options: {
        withFileTypes: true;
    }): Array<{
        name: string;
    }>;
    readlinkSync(path: string): string;
}
/** Mirrors the installer's immutable-generation digest without importing installer code at runtime. */
export declare function fingerprintTweakersVariantGeneration(path: string, fileSystem?: TweakersVariantFilesystem): VariantGenerationFingerprint;
/**
 * Refuse a derived app before any tweak or app-server startup if its active
 * generation is not exactly committed and immutable. The broker calls this
 * after it has established the loader-provided user-root/runtime environment.
 */
export declare function assertTweakersVariantBootstrap(options?: TweakersVariantBootstrapOptions): void;
/**
 * Schedule one bounded startup reconciliation after Electron is ready. A
 * missing visible window or launcher failure is diagnostic evidence only; it
 * must never abort the desktop app's module initialization.
 */
export declare function createDesktopUpdateStartupReconciler(dependencies: DesktopUpdateStartupDependencies, options?: DesktopUpdateStartupOptions): {
    schedule(): boolean;
};
export {};
