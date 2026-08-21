import { type RouterConfig } from "./types";
export declare const ACCOUNT_SWITCHER_TWEAK_ID = "co.tweakers.account-switcher";
export declare const ACCOUNT_ROUTER_CONFIG_FILE = "account-router-config.json";
export type RouterLaunchReason = "balanced" | "manual" | "missing-config" | "invalid-config" | "unsupported-protocol";
export interface RouterLaunchSelection {
    mode: "mux" | "direct";
    reason: RouterLaunchReason;
    config: RouterConfig | null;
}
export declare function defaultAccountRouterConfigPath(userRoot: string | undefined): string | null;
export declare function readRouterLaunchSelection(configPath: string | null | undefined, readFile?: (path: string, encoding: BufferEncoding) => string, pathExists?: (path: string) => boolean): RouterLaunchSelection;
/** Strictly validates the redacted v1 config before the parent changes process topology. */
export declare function validateRouterConfig(value: unknown): RouterConfig | null;
