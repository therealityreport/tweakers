"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readNativeStorageHomeV1 = readNativeStorageHomeV1;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const broker_socket_1 = require("./broker-socket");
const config_1 = require("./config");
const native_history_1 = require("./native-history");
/** Main-process read scope only; never changes execution or authentication homes. */
function readNativeStorageHomeV1(stateRoot) {
    if (!(0, node_fs_1.existsSync)((0, node_path_1.join)(stateRoot, native_history_1.NATIVE_HISTORY_SOURCE_FILE_V1)))
        return null;
    const config = (0, config_1.readRouterLaunchSelection)((0, node_path_1.join)(stateRoot, "account-router-config.json")).config;
    if (config?.schemaVersion !== 3)
        throw new Error("Native storage source is unavailable.");
    const secret = (0, broker_socket_1.readAccountsBrokerSecret)(stateRoot);
    if (!secret)
        throw new Error("Native storage source is unavailable.");
    try {
        const result = (0, native_history_1.readAndPreflightNativeHistorySourceStaticV1)(stateRoot, config, secret);
        if (result.state !== "ready")
            throw new Error("Native storage source is unavailable.");
        const source = result.binding.source;
        const account = source.accounts.find((entry) => entry.opaqueAccountId === source.metadataAccountId);
        if (!account)
            throw new Error("Native storage source is unavailable.");
        return account.codexHome;
    }
    finally {
        secret.fill(0);
    }
}
//# sourceMappingURL=native-storage.js.map