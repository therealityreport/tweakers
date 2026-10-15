export declare const ACCEPTANCE_CONFIG_ENV = "TWEAKERS_ACCEPTANCE_CONFIG_FILE";
export declare const ACCEPTANCE_TWEAK_IDS: readonly ["co.tweakers.developer-tools", "co.tweakers.followup", "co.tweakers.usage-limit-resets-tracker"];
type Config = Record<string, unknown>;
export interface AcceptanceConfig {
    readonly path: string;
    readonly directory: string;
    readonly rejectedWrites: number;
    read(): Config;
    write(value: Config): void;
    close(): void;
}
/** Acceptance diagnostics stay in memory. No diagnostic descendant is a sink,
 * even when a valid acceptance directory contains a linked diagnostic leaf. */
export declare function runRuntimeDiagnosticDiskOperation<T>(acceptance: AcceptanceConfig | null, operation: () => T): T | undefined;
/** The override changes settings only: no data-root, account, or backend routing. */
export declare function resolveAcceptanceConfig(input: {
    userRoot: string;
    derivedVariant: boolean;
    healthCheckOnly: boolean;
    environment?: NodeJS.ProcessEnv;
}): AcceptanceConfig | null;
export {};
