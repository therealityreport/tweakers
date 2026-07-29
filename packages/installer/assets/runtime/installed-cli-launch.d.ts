export type InstalledCliCommandKind = "start" | "resume" | "reconcile" | "cancel" | "other";
export interface InstalledCliCommandClassification {
    commandKind: InstalledCliCommandKind;
    cutover: boolean;
}
export declare const MAX_LAUNCHCTL_OUTPUT_BYTES: number;
export interface LaunchdSubmitResult {
    status: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string | null;
    stderr?: string | null;
    error?: Error;
}
export interface LaunchdSubmitOptions {
    encoding: "utf8";
    maxBuffer: number;
    stdio: ["ignore", "pipe", "pipe"];
}
export interface InstalledCliLaunchEvent {
    event: "desktop-update-launch";
    commandKind: InstalledCliCommandKind;
    jobLabel: string;
    submitResult: "submitted" | "failed";
    status: number | null;
    error?: string;
}
export interface InstalledCliLaunchdInput {
    classification: InstalledCliCommandClassification;
    label: string;
    cwd: string;
    command: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
}
export interface InstalledCliLaunchdDependencies {
    submit(command: string, args: readonly string[], options: LaunchdSubmitOptions): LaunchdSubmitResult;
    onEvent?(event: InstalledCliLaunchEvent): void;
}
export declare class DesktopUpdateLaunchSubmissionError extends Error {
    readonly commandKind: InstalledCliCommandKind;
    readonly jobLabel: string;
    readonly code = "TWEAKERS_DESKTOP_UPDATE_LAUNCH_SUBMISSION_FAILED";
    constructor(commandKind: InstalledCliCommandKind, jobLabel: string, detail: string);
}
export declare function classifyInstalledCliCommand(args: readonly string[]): InstalledCliCommandClassification;
export declare function submitInstalledCliWithLaunchd(input: InstalledCliLaunchdInput, dependencies: InstalledCliLaunchdDependencies): boolean;
export declare function buildTransientLaunchdExitTrap(label: string): string;
