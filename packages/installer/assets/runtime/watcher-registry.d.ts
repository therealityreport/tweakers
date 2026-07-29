export type WatcherRegistryStatus = "ok" | "warn" | "error";
export type WatcherFreshness = "fresh" | "stale" | "missing" | "unsupported" | "unknown";
export interface WatcherProbe {
    installed: boolean;
    loaded: boolean;
    running: boolean;
    lastExitCode: number | null;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    statusSchemaVersion: number | null;
    policyVersion: string | null;
    deferredReason: string | null;
    error: string | null;
    supportedStatusSchemas?: number[];
}
export interface WatcherHealthEntry {
    id: "tweakers-repair" | "mcp-lifecycle-reaper" | "mcp-pressure-guard";
    purpose: string;
    authority: "repair-only" | "automatic-process-signals" | "notification-only";
    platformKind: string;
    label: string;
    installedPath: string;
    cadenceSeconds: number;
    triggers: string[];
    installed: boolean;
    loaded: boolean;
    running: boolean;
    lastRunAt: string | null;
    lastExitCode: number | null;
    lastSuccessAt: string | null;
    nextExpectedAt: string | null;
    freshness: WatcherFreshness;
    status: WatcherRegistryStatus;
    statusSchemaVersion: number | null;
    policyVersion: string | null;
    statePath: string | null;
    receiptPath: string | null;
    deferredReason: string | null;
    error: string | null;
    recommendedAction: string | null;
}
export interface WatcherRegistryInput {
    checkedAt: string;
    platformKind: string;
    homeDirectory: string;
    tweakersRoot: string;
    repair: WatcherProbe;
    reaper: WatcherProbe;
    guard: WatcherProbe;
}
export declare function buildWatcherRegistry(input: WatcherRegistryInput): WatcherHealthEntry[];
export declare function deriveWatcherFreshness(input: {
    checkedAt: string;
    cadenceSeconds: number;
    installed: boolean;
    loaded: boolean;
    lastRunAt: string | null;
    statusSchemaVersion: number | null;
    supportedStatusSchemas?: number[];
}): {
    freshness: WatcherFreshness;
    nextExpectedAt: string | null;
};
