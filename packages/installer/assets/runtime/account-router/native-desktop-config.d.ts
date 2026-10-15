import { type DesktopAppToolsContextV1 } from "./desktop-app-tools";
export declare const NATIVE_DESKTOP_CONFIG_PROOF_V1 = "__tweakers_native_desktop_config_v1";
/** Called only by the reviewed native main builder, before renderer composition. */
export declare function attestNativeDesktopConfigV1(secret: Buffer, context: DesktopAppToolsContextV1, config: unknown): Record<string, unknown>;
/** Detach only exact signed entries; every other override keeps normal policy checks. */
export declare function detachNativeDesktopConfigV1(secret: Buffer, context: DesktopAppToolsContextV1 | null, value: unknown): {
    config: Record<string, unknown>;
    native: Record<string, unknown>;
};
