import type { TweakMcpServer } from "@therealityreport/tweakers-sdk";
export declare const MCP_MANAGED_START = "# BEGIN TWEAKER MANAGED MCP SERVERS";
export declare const MCP_MANAGED_END = "# END TWEAKER MANAGED MCP SERVERS";
export declare const USER_QUESTIONS_MCP_SERVER_NAME = "co-tweakers-user-questions";
export declare const RESERVED_MANAGED_MCP_ENV_KEYS: readonly ["TWEAKER_TWEAK_DATA_DIR", "TWEAKER_TWEAK_ID"];
export interface McpSyncTweak {
    dir: string;
    /** Canonical writable data directory; required when equivalent source roots share one config. */
    dataDir?: string;
    manifest: {
        id: string;
        mcp?: TweakMcpServer;
    };
}
export interface BuiltManagedMcpBlock {
    block: string;
    serverNames: string[];
    skippedServerNames: string[];
}
export interface ManagedMcpSyncResult extends BuiltManagedMcpBlock {
    changed: boolean;
}
export interface McpConflict {
    observedName: string;
    canonicalName: string;
    reason: "canonical-collision" | "legacy-shape-mismatch" | "ambiguous-legacy";
}
export interface PreservedMcpOptions {
    defaultToolsApprovalMode?: "approve";
}
export type PreservedMcpOptionsByServerName = Record<string, PreservedMcpOptions>;
export interface PreservedApprovalPolicy {
    present: boolean;
    rawAssignment: string | null;
}
export interface ApprovalPolicyReconciliation {
    status: "managed" | "restored" | "unchanged" | "conflict";
    beforeRaw: string | null;
    afterRaw: string | null;
    preservedOriginalRaw: string | null;
    preservedOriginalPresent: boolean;
    sandboxModeBeforeRaw: string | null;
    sandboxModeAfterRaw: string | null;
    restartRequired: boolean;
    error?: string;
}
export interface ManagedMcpReconciliationOptions {
    /** Every installed Tweakers-owned MCP declaration, including disabled tweaks. */
    ownedTweaks?: McpSyncTweak[];
    /** Validated policy metadata retained while an owned server is intentionally absent. */
    preservedOptions?: Readonly<PreservedMcpOptionsByServerName>;
}
export interface McpReconciliationPlan {
    nextToml: string;
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
    changed: boolean;
    restartRequired: boolean;
}
export declare function withMcpConfigMutationLock<T>(configPath: string, mutate: () => T): T;
export declare function syncManagedMcpServers({ configPath, tweaks, }: {
    configPath: string;
    tweaks: McpSyncTweak[];
}): ManagedMcpSyncResult;
export declare function buildManagedMcpBlock(tweaks: McpSyncTweak[], existingToml?: string): BuiltManagedMcpBlock;
export declare function planManagedMcpReconciliation(tweaks: McpSyncTweak[], currentToml?: string, options?: ManagedMcpReconciliationOptions): McpReconciliationPlan;
/**
 * Observe policy fields for reconciliation receipts without changing them.
 * Policy mutation belongs exclusively to the User Questions Preview/Apply/
 * Restore transaction; ordinary MCP startup and enable/disable reconciliation
 * may only register or remove the server block.
 */
export declare function observeUserQuestionsApprovalPolicy(currentToml: string, preserved?: Readonly<PreservedApprovalPolicy> | null): ApprovalPolicyReconciliation;
export declare function sanitizePreservedApprovalPolicy(value: unknown): PreservedApprovalPolicy | null;
export declare function sanitizePreservedMcpOptions(value: unknown, allowedServerNames: Iterable<string>): PreservedMcpOptionsByServerName;
export declare function mergeManagedMcpBlock(currentToml: string, managedBlock: string): string;
export declare function stripManagedMcpBlock(toml: string): string;
/**
 * True when the document contains a stray managed END marker that
 * stripManagedMcpBlock would heal — an END (current or legacy generation)
 * appearing before any BEGIN. Callers that suppress rewrites when nothing
 * "real" changed must treat such a document as needing a rewrite, or the
 * heal is planned and discarded forever while the corruption persists.
 */
export declare function hasStrayManagedMcpEndMarker(toml: string): boolean;
export declare function mcpServerNameFromTweakId(id: string): string;
/**
 * Validate the complete document before MCP code inspects or rewrites any
 * section. This intentionally validates syntax without normalizing the parsed
 * representation so manual configuration can still be preserved byte-for-byte.
 */
export declare function assertValidTomlDocument(toml: string): void;
