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
    plannedAfterFingerprint?: string;
    restartRequired: boolean;
    error?: string;
}
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
export declare function reconcileMcpConfig(options: ReconcileMcpConfigOptions, dependencies?: ReconcileMcpConfigDependencies): McpSyncReceipt;
export declare function createMcpReconciler(options: McpReconcilerOptions, dependencies?: CreateMcpReconcilerDependencies): McpReconciler;
export declare function readMcpSyncState(statePath: string): McpSyncReceipt | null;
export declare function fingerprint(value: string | Buffer): string;
export interface PlanMcpConfigReconciliationOptions {
    ownedTweaks?: McpSyncTweak[];
    preservedOptions?: Readonly<PreservedMcpOptionsByServerName>;
    preservedApprovalPolicy?: Readonly<PreservedApprovalPolicy> | null;
}
export declare function planMcpConfigReconciliation(tweaks: McpSyncTweak[], currentToml: string, options?: PlanMcpConfigReconciliationOptions): McpReconciliationPlan;
