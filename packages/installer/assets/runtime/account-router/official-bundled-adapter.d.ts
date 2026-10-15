import { type DesktopAppToolsContextV1 } from "./desktop-app-tools";
/** Bind this capability in the signed runtime sealing performed by the installer. */
export declare const OFFICIAL_BUNDLED_ADAPTER_VERSION_V1: "official-bundled-adapter-v1";
/** Source compatibility is verified; managed custody and live acceptance remain separate guards. */
export declare const OFFICIAL_BUNDLED_ADAPTER_READY_V1 = true;
export declare const OFFICIAL_FOLLOW_NATIVE_PLUGIN_MUTATION_HOLD_V1: "Tweakers follows native Codex's installed plugin list. Install, remove, or update plugins in native Codex, then refresh Tweakers's shared definitions.";
export declare function officialFollowNativePluginMutationV1(method: string, params: unknown): boolean;
export declare function officialOwnedConfigMutationAllowedV1(method: string, params: unknown, executionHome: string): boolean;
export declare const OFFICIAL_BUNDLED_PLUGIN_ADMISSION_HOLD_V1: "Stock account child held: its verified shared plugin library or account service is unavailable. Refresh shared definitions and the selected account connection.";
export interface OfficialInstalledPluginV1 {
    id: string;
    enabled: boolean;
    version: string | null;
}
export interface OfficialPluginInventoryV1 {
    schema_version: 1;
    native_base_root: string;
    plugins: OfficialInstalledPluginV1[];
}
/** Backend registration changes get new custody; signed prior generations remain recovery material. */
export declare function officialPluginLedgerRootV1(overlay: string, modeFingerprint: string): string;
export declare function officialPluginInventoryFromResponseV1(value: unknown, root: string): OfficialPluginInventoryV1 | null;
export declare function isOfficialPluginInventoryV1(value: unknown, root: string): value is OfficialPluginInventoryV1;
export interface OfficialBundledAccountPlanV1 {
    args: string[];
    threadConfig: Record<string, unknown>;
    oauthIsolation: "file" | "blocked";
    oauthBlockReason?: string;
    sharedHttpNames: string[];
    blockedMcpNames: string[];
    withheldPlugins: Record<string, string>;
    sourceEnablement: Record<string, boolean>;
}
/** Read-only plan: native definitions and all credentials stay in their original homes. */
export declare function officialBundledAccountPlanV1(input: {
    sourceHome: string;
    accountHome: string;
    settingsHome?: string;
    definitionHome?: string;
    args: readonly string[];
    inventory: OfficialPluginInventoryV1;
    localLibrary?: boolean;
    /** Parent-owned verified generation, including non-MCP custody holds. */
    withheldPlugins?: Readonly<Record<string, string>>;
}): OfficialBundledAccountPlanV1;
export declare function officialSharedPluginResponseV1(inventory: OfficialPluginInventoryV1, plan: OfficialBundledAccountPlanV1): unknown;
export declare function officialOwnedAccountHomeV1(stateRoot: string, account: string, home: string): boolean;
/** Generation fence exposes a digest, never source configuration or credentials. */
export declare function officialSourceConfigFingerprintV1(home: string): string;
/** UI names remain canonical; execution paths and native hash proofs stay untouched. */
export declare function officialCanonicalPluginResponseV1(value: unknown, inventory: OfficialPluginInventoryV1, method?: string, plan?: OfficialBundledAccountPlanV1): unknown;
export declare function officialExecutionPluginParamsV1(method: string, value: unknown, inventory: OfficialPluginInventoryV1, home: string): unknown;
/** Keep policy while replacing executable authority with the main-owned tool. */
export declare function officialDesktopAppToolsConfigV1(value: unknown, context: DesktopAppToolsContextV1 | null, includePluginPolicy?: boolean): Record<string, unknown>;
/** Chat overrides may change policy and trust, never install executable definitions. */
export declare function officialThreadPluginConfigAllowedV1(value: unknown): boolean;
/** Preserve explicit chat policy while retaining source and credential isolation holds. */
export declare function officialThreadPluginParamsV1(value: unknown, plan: OfficialBundledAccountPlanV1, inventory: OfficialPluginInventoryV1, home: string, attestedNativeConfig?: Record<string, unknown>): unknown;
