export declare const ACCEPTANCE_CONFIG_ENV = "TWEAKERS_ACCEPTANCE_CONFIG_FILE";
export declare const ACCEPTANCE_TWEAK_IDS: readonly ["co.tweakers.developer-tools", "co.tweakers.followup", "co.tweakers.usage-limit-resets-tracker"];
type Config = Record<string, unknown>;
export interface AcceptanceConfig {
    readonly path: string;
    readonly directory: string;
    readonly rejectedWrites: number;
    /** True once `close()` ran (the launch is ending); later diagnostics are skipped, not drift. */
    readonly closed: boolean;
    /** True once a read or write detected drift; `onDrift` has then fired exactly once. */
    readonly drifted: boolean;
    read(): Config;
    write(value: Config): void;
    close(): void;
}
/** Acceptance diagnostics stay in memory. No diagnostic descendant is a sink,
 * even when a valid acceptance directory contains a linked diagnostic leaf.
 * After the override is closed during quit there is nothing left to verify,
 * so the operation is skipped silently instead of raising inside a quit hook. */
export declare function runRuntimeDiagnosticDiskOperation<T>(acceptance: AcceptanceConfig | null, operation: () => T): T | undefined;
/** The override changes settings only: no data-root, account, or backend routing. */
export declare function resolveAcceptanceConfig(input: {
    userRoot: string;
    derivedVariant: boolean;
    healthCheckOnly: boolean;
    environment?: NodeJS.ProcessEnv;
    /** Called once, before the drift error is rethrown, so the host can stop the
     * launch deliberately instead of letting an event handler crash the process. */
    onDrift?: (error: Error) => void;
}): AcceptanceConfig | null;
export {};
