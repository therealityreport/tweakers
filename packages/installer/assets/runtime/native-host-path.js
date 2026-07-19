"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APP_STAGED_NATIVE_HOST_RELATIVE_PATH = void 0;
exports.resolveRuntimeNativeHostPath = resolveRuntimeNativeHostPath;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
exports.APP_STAGED_NATIVE_HOST_RELATIVE_PATH = (0, node_path_1.join)("tweakers", "native", "tweaker_native_host.node");
function resolveRuntimeNativeHostPath(input) {
    const staged = (0, node_path_1.join)(input.resourcesPath, exports.APP_STAGED_NATIVE_HOST_RELATIVE_PATH);
    const exists = input.exists ?? node_fs_1.existsSync;
    if (exists(staged))
        return staged;
    if (!input.packaged && input.allowExternalDevelopmentFallback) {
        return (0, node_path_1.join)(input.runtimeDir, "native", "tweaker_native_host.node");
    }
    // Return the required production location even when absent so NativeBridge
    // reports a useful missing-host diagnostic without probing unsafe fallbacks.
    return staged;
}
//# sourceMappingURL=native-host-path.js.map