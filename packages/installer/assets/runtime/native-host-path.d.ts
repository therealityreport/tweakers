export declare const APP_STAGED_NATIVE_HOST_RELATIVE_PATH: string;
export interface RuntimeNativeHostPathInput {
    resourcesPath: string;
    runtimeDir: string;
    /** Packaged/signed app processes must never dlopen from the external runtime. */
    packaged: boolean;
    /** Permits the external runtime only for an explicit unpackaged dev/health process. */
    allowExternalDevelopmentFallback: boolean;
    exists?: (path: string) => boolean;
}
export declare function resolveRuntimeNativeHostPath(input: RuntimeNativeHostPathInput): string;
