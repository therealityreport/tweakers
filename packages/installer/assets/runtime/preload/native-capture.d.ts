import type { NativeCaptureApi } from "@therealityreport/tweakers-sdk";
type Adapter = NativeCaptureApi;
/** This adapter delegates to Codex's existing RPC services; it never captures. */
export declare function createNativeCaptureBridge(): {
    api: NativeCaptureApi;
    transport: {
        register(value: Adapter): boolean;
    };
};
export declare const nativeCaptureBridge: {
    api: NativeCaptureApi;
    transport: {
        register(value: Adapter): boolean;
    };
};
export {};
