export type EnvironmentAppExperience = "chatgpt" | "tweakers";
export type EnvironmentReleaseProfile = "stable" | "alpha";
export interface EnvironmentSelectionPair {
    appExperience: EnvironmentAppExperience;
    releaseProfile: EnvironmentReleaseProfile;
}
export type EnvironmentConfirmationDecision = "confirm" | "cancel";
export interface EnvironmentConfigEffects<Receipt> {
    prepare(selection: EnvironmentSelectionPair): Promise<Receipt>;
    confirm(selection: EnvironmentSelectionPair, receipt: Receipt): Promise<EnvironmentConfirmationDecision>;
    commit(receipt: Receipt): Promise<void>;
    cancel(receipt: Receipt): Promise<void>;
}
export type EnvironmentConfigPhase = "idle" | "preparing" | "awaiting-confirmation" | "committing" | "cancelling";
export interface EnvironmentConfigSnapshot {
    selected: EnvironmentSelectionPair;
    pending: EnvironmentSelectionPair;
    hasPendingChanges: boolean;
    busy: boolean;
    phase: EnvironmentConfigPhase;
    error: string | null;
}
export type EnvironmentApplyOutcome<Receipt> = {
    outcome: "no-change" | "busy";
} | {
    outcome: "submitted" | "cancelled";
    receipt: Receipt;
} | {
    outcome: "prepare-failed";
    error: string;
} | {
    outcome: "confirmation-failed" | "commit-failed" | "cancel-failed";
    receipt: Receipt;
    error: string;
};
export interface EnvironmentConfigController<Receipt> {
    readonly snapshot: EnvironmentConfigSnapshot;
    setSelected(selection: EnvironmentSelectionPair): void;
    restorePending(selection: EnvironmentSelectionPair): void;
    stageAppExperience(value: EnvironmentAppExperience): void;
    stageReleaseProfile(value: EnvironmentReleaseProfile): void;
    clearError(): void;
    applyAndRestart(): Promise<EnvironmentApplyOutcome<Receipt>>;
    resumePrepared(selection: EnvironmentSelectionPair, receipt: Receipt): Promise<EnvironmentApplyOutcome<Receipt>>;
}
export interface EnvironmentConfigControllerOptions {
    onChange?: (snapshot: EnvironmentConfigSnapshot) => void;
}
export declare function createEnvironmentConfigController<Receipt>(selected: EnvironmentSelectionPair, effects: EnvironmentConfigEffects<Receipt>, options?: EnvironmentConfigControllerOptions): EnvironmentConfigController<Receipt>;
export type DesktopUpdateStatus = "update-available" | "current" | "stale" | "unavailable" | "error";
export declare function desktopUpdateStatusPresentation(status: DesktopUpdateStatus | undefined): {
    label: string;
    tone: "ok" | "warn" | "error";
};
export interface EnvironmentFocusTarget {
    readonly isConnected: boolean;
    focus(): void;
}
export declare function restoreEnvironmentFocus(opener: EnvironmentFocusTarget | null, fallback: () => EnvironmentFocusTarget | null): "opener" | "fallback" | "none";
export interface ConfigCardUpdateToken {
    readonly card: string;
    readonly generation: number;
}
/**
 * Keeps asynchronous Config cards independent while rejecting a stale result
 * from an older request for the same card.
 */
export declare class ConfigCardUpdateCoordinator<Value> {
    #private;
    begin(card: string): ConfigCardUpdateToken;
    complete(token: ConfigCardUpdateToken, value: Value): boolean;
    isCurrent(token: ConfigCardUpdateToken): boolean;
    invalidate(card: string): void;
    value(card: string): Value | undefined;
    snapshot(): Record<string, Value>;
}
