import { existsSync } from "node:fs";
import { join } from "node:path";

export const APP_STAGED_NATIVE_HOST_RELATIVE_PATH = join(
  "tweakers",
  "native",
  "tweaker_native_host.node",
);

export interface RuntimeNativeHostPathInput {
  resourcesPath: string;
  runtimeDir: string;
  /** Packaged/signed app processes must never dlopen from the external runtime. */
  packaged: boolean;
  /** Permits the external runtime only for an explicit unpackaged dev/health process. */
  allowExternalDevelopmentFallback: boolean;
  exists?: (path: string) => boolean;
}

export function resolveRuntimeNativeHostPath(input: RuntimeNativeHostPathInput): string {
  const staged = join(input.resourcesPath, APP_STAGED_NATIVE_HOST_RELATIVE_PATH);
  const exists = input.exists ?? existsSync;
  if (exists(staged)) return staged;
  if (!input.packaged && input.allowExternalDevelopmentFallback) {
    return join(input.runtimeDir, "native", "tweaker_native_host.node");
  }
  // Return the required production location even when absent so NativeBridge
  // reports a useful missing-host diagnostic without probing unsafe fallbacks.
  return staged;
}
