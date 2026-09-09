"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAccountsBrokerSetupState = readAccountsBrokerSetupState;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("./config");
const broker_socket_1 = require("./broker-socket");
const state_store_1 = require("./state-store");
/** Main-only diagnosis. Never return private paths or create missing state. */
function readAccountsBrokerSetupState(root) {
    if (!root || !(0, node_path_1.isAbsolute)(root) || (0, node_path_1.resolve)(root) !== root)
        return "unavailable";
    try {
        const directory = (0, node_fs_1.lstatSync)(root);
        if (!directory.isDirectory() || directory.isSymbolicLink()
            || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
            return "unavailable";
        for (const file of ["account-router-config.json", "control-secret.v1"]) {
            (0, node_fs_1.lstatSync)((0, node_path_1.join)(root, file));
        }
        (0, state_store_1.assertPrivateRegularFile)((0, node_path_1.join)(root, "account-router-config.json"), 256 * 1024);
        if ((0, config_1.readRouterLaunchSelection)((0, node_path_1.join)(root, "account-router-config.json")).config?.schemaVersion !== 3)
            return "unavailable";
        const secret = (0, broker_socket_1.readAccountsBrokerSecret)(root);
        if (!secret)
            return "unavailable";
        secret.fill(0);
        return "registered";
    }
    catch (error) {
        return error.code === "ENOENT" ? "setup-required" : "unavailable";
    }
}
//# sourceMappingURL=broker-readiness.js.map