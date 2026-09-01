import { type RouterConfig, type RouterConfigV2 } from "./types";
export declare const ACCOUNT_SWITCHER_TWEAK_ID = "co.tweakers.account-switcher";
export declare const ACCOUNT_ROUTER_CONFIG_FILE = "account-router-config.json";
export type RouterLaunchReason = "balanced" | "quota_aware" | "manual" | "history-adoption-required" | "missing-config" | "invalid-config" | "unsupported-protocol";
export interface RouterLaunchSelection {
    mode: "mux" | "direct";
    reason: RouterLaunchReason;
    config: RouterConfig | null;
}
export declare function defaultAccountRouterConfigPath(userRoot: string | undefined): string | null;
export declare function readRouterLaunchSelection(configPath: string | null | undefined, readFile?: (path: string, encoding: BufferEncoding) => string, pathExists?: (path: string) => boolean): RouterLaunchSelection;
/** Strictly validates the redacted v1 config before the parent changes process topology. */
export declare function validateRouterConfig(value: unknown): RouterConfig | null;
/**
 * The same stable serialization must be used by the v2 config writer. It
 * purposefully excludes `fingerprint` and `updatedAt`; timestamp-only writes
 * therefore cannot pretend to be a new routing generation.
 */
export declare function routerConfigFingerprint(config: Omit<RouterConfigV2, "fingerprint"> | RouterConfigV2): `sha256:${string}`;
export declare function isRouterConfigV2(config: RouterConfig): config is RouterConfigV2;
