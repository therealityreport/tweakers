import type { ApprovalPolicyReconciliation, McpConflict, McpReconciliationPlan, McpSyncTweak, PreservedApprovalPolicy, PreservedMcpOptionsByServerName } from "./mcp-sync";
export type McpSyncTrigger = "startup" | "tweak-reload" | "enabled-state" | "config-change" | "manual-repair";
export interface McpSyncReceipt {
    schemaVersion: 2;
    phase: "prepared" | "complete";
    transactionId: string;
    trigger: McpSyncTrigger;
    startedAt: string;
    completedAt: string;
    status: "updated" | "unchanged" | "conflict" | "error";
    desiredNames: string[];
    appliedNames: string[];
    migrations: Array<{
        from: string;
        to: string;
    }>;
    conflicts: McpConflict[];
    preservedOptions: PreservedMcpOptionsByServerName;
    approvalPolicy: ApprovalPolicyReconciliation;
    preservedApprovalPolicy: PreservedApprovalPolicy | null;
    beforeFingerprint: string;
    afterFingerprint: string;
    /**
     * Raw-byte binding (afterFingerprint) breaks whenever the desktop app stamps
     * volatile bookkeeping (marketplace `last_updated`) into config.toml after a
     * reconcile. This canonical twin hashes the same content with those lines
     * stripped so health probes can bind the receipt across app boots.
     */
    afterFingerprintCanonical?: string;
    plannedAfterFingerprint?: string;
    restartRequired: boolean;
    /**
     * Completion time of the most recent reconciliation that changed the
     * Tweakers-owned MCP configuration. No-op/error receipts preserve it so a
     * required desktop restart cannot be forgotten by a later watcher pass.
     */
    managedConfigurationChangedAt?: string | null;
    error?: string;
}
export declare function userQuestionsMcpReceiptMatchesEnabledState(receipt: Pick<McpSyncReceipt, "status" | "desiredNames" | "appliedNames" | "conflicts" | "approvalPolicy">, enabled: boolean): boolean;
export interface ReconcileMcpConfigOptions {
    configPath: string;
    statePath: string;
    /** Enabled MCP tweaks that should be present after reconciliation. */
    tweaks: McpSyncTweak[];
    /** All installed Tweakers-owned MCP tweaks, including disabled ones. */
    ownedTweaks?: McpSyncTweak[];
    trigger: McpSyncTrigger;
}
export interface ReconcileMcpConfigDependencies {
    beforeCommit?: (attempt: number, configPath: string) => void;
    beforeRename?: (attempt: number, configPath: string) => void;
    /** Runs after the old pathname is atomically captured but before exclusive promotion. */
    afterCapture?: (attempt: number, configPath: string) => void;
    /** Runs after promotion is checked but before the captured old inode is released. */
    beforeBackupRelease?: (attempt: number, configPath: string) => void;
    /** Runs after the last promotion check; the retired inode must remain reachable afterward. */
    afterFinalCheck?: (attempt: number, configPath: string) => void;
    /** Test/diagnostic hook after a verified config commit and before the final receipt. */
    afterCommit?: (configPath: string) => void;
    now?: () => Date;
    transactionId?: () => string;
}
export interface McpReconcilerOptions {
    configPath: string;
    statePath: string;
    getTweaks: () => McpSyncTweak[];
    getOwnedTweaks?: () => McpSyncTweak[];
    debounceMs?: number;
    watchConfig?: boolean;
    onReceipt?: (receipt: McpSyncReceipt) => void;
    onError?: (error: unknown) => void;
    reconcileDependencies?: ReconcileMcpConfigDependencies;
}
export interface McpConfigWatchHandle {
    close(): void | Promise<void>;
}
export interface CreateMcpReconcilerDependencies {
    watchConfig?: (configPath: string, onChange: (changedPath?: string) => void) => McpConfigWatchHandle;
    reconcileConfig?: (options: ReconcileMcpConfigOptions, dependencies?: ReconcileMcpConfigDependencies) => McpSyncReceipt | Promise<McpSyncReceipt>;
}
export interface McpReconciler {
    request(trigger: McpSyncTrigger): Promise<McpSyncReceipt>;
    reconcileNow(trigger: McpSyncTrigger): Promise<McpSyncReceipt>;
    readState(): McpSyncReceipt | null;
    close(): Promise<void>;
}
export declare const MCP_CANDIDATE_RECONCILIATION_ENV = "TWEAKERS_CANDIDATE_MCP_RECONCILIATION";
export declare const MCP_CANDIDATE_CODEX_HOME_ENV = "CODEX_HOME";
export interface ResolveMcpRuntimePathsOptions {
    /** Exact Tweakers user root selected by the loader for this runtime. */
    userRoot: string;
    /** Ordinary OS home. Candidate mode never substitutes this implicitly. */
    homeDirectory: string;
    env?: Readonly<Record<string, string | undefined>>;
}
export interface McpRuntimePaths {
    codexHome: string;
    configPath: string;
    statePath: string;
    candidateIsolated: boolean;
}
/**
 * Resolve the only MCP config and receipt paths the desktop reconciler may use.
 *
 * Ordinary launches intentionally retain the historical ~/.codex/config.toml
 * behavior, even when CODEX_HOME happens to be present. A disposable candidate
 * must explicitly opt in and supply an exact CODEX_HOME below its exact,
 * non-symlink Tweakers user root. Existing symlink components, the real
 * ~/.codex tree, and paths outside the candidate root fail closed before a
 * watcher or reconciler can be created.
 */
export declare function resolveMcpRuntimePaths(options: ResolveMcpRuntimePathsOptions): McpRuntimePaths;
export declare function reconcileMcpConfig(options: ReconcileMcpConfigOptions, dependencies?: ReconcileMcpConfigDependencies): McpSyncReceipt;
export declare function createMcpReconciler(options: McpReconcilerOptions, dependencies?: CreateMcpReconcilerDependencies): McpReconciler;
export declare function readMcpSyncState(statePath: string): McpSyncReceipt | null;
export declare function fingerprint(value: string | Buffer): string;
/**
 * Stamp-immune fingerprint of a Codex config: identical to `fingerprint`
 * except app-stamped volatile `last_updated` lines are removed first. Used
 * only for the receipt's `afterFingerprintCanonical` binding; CAS/retired
 * inode naming keeps raw `fingerprint` semantics.
 */
export declare function canonicalConfigFingerprint(value: string | Buffer): string;
export interface PlanMcpConfigReconciliationOptions {
    ownedTweaks?: McpSyncTweak[];
    preservedOptions?: Readonly<PreservedMcpOptionsByServerName>;
    preservedApprovalPolicy?: Readonly<PreservedApprovalPolicy> | null;
}
export declare function planMcpConfigReconciliation(tweaks: McpSyncTweak[], currentToml: string, options?: PlanMcpConfigReconciliationOptions): McpReconciliationPlan;
