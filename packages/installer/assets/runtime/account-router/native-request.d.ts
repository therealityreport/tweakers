export declare const NATIVE_REQUEST_MAX_RESULT_BYTES: number;
export declare const NATIVE_REQUEST_USAGE_MAX_RESULT_BYTES: number;
export declare const NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES: number;
export type NativeRequestSurfaceV1 = "profile" | "apps" | "plugins" | "mcp" | "usage";
export interface NativeRequestV1 {
    surface: NativeRequestSurfaceV1;
    method: string;
    params: Record<string, unknown>;
}
export declare function parseNativeRequestV1(value: unknown): NativeRequestV1 | null;
/** Exact main-owned child RPCs used after a selected-account browser action. */
export declare function parseNativeBrowserChildRequestV1(method: unknown, params: unknown): {
    method: string;
    params: Record<string, unknown>;
} | null;
export declare function isNativeRequestSurfaceV1(value: unknown): value is NativeRequestSurfaceV1;
export declare function isBoundedNativeResultV1(value: unknown, surface?: NativeRequestSurfaceV1): boolean;
export declare function requestNativeUsageCreditsV1(codexHome: string, method: "usage.credits.read" | "usage.credits.consume", params: Record<string, unknown>): Promise<unknown>;
export declare function requestNativeHttpV1(codexHome: string, surface: "apps" | "plugins", params: Record<string, unknown>): Promise<unknown>;
