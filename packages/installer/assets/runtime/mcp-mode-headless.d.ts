import type { McpConflict, PreservedMcpOptionsByServerName } from "./mcp-sync";
export type McpModeHeadlessOperation = "reconcile" | "prove";
export type McpModeAppExperience = "chatgpt" | "tweakers";
export interface McpModeHeadlessRequest {
    schemaVersion: 1;
    operation: McpModeHeadlessOperation;
    appExperience: McpModeAppExperience;
    configPath: string;
    statePath: string;
    tweaksRoot: string;
    tweakersConfigPath: string;
}
export interface McpModeHeadlessResult {
    schemaVersion: 1;
    operation: McpModeHeadlessOperation;
    appExperience: McpModeAppExperience;
    ok: boolean;
    changed: boolean;
    restartRequired: boolean;
    desiredNames: string[];
    appliedNames: string[];
    conflicts: McpConflict[];
    preservedOptions: PreservedMcpOptionsByServerName;
    beforeFingerprint: string;
    afterFingerprint: string;
    error: string | null;
}
export declare function runMcpModeHeadless(input: unknown): McpModeHeadlessResult;
