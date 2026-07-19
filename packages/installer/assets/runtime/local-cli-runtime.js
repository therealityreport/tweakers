"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nodeExecutableFromCliShim = nodeExecutableFromCliShim;
exports.resolveLocalCliRuntime = resolveLocalCliRuntime;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/** Read the exact Node executable captured when Tweakers installed its shim. */
function nodeExecutableFromCliShim(source) {
    const match = source.match(/^exec\s+"([^"]+)"\s+"[^"]+"\s+"\$@"\s*$/m);
    return match?.[1]?.trim() || null;
}
function resolveLocalCliRuntime(input) {
    const shim = (0, node_path_1.join)(input.userRoot, "bin", "tweaker");
    try {
        const shimNode = nodeExecutableFromCliShim((0, node_fs_1.readFileSync)(shim, "utf8"));
        if (shimNode && (0, node_fs_1.existsSync)(shimNode)) {
            return { command: shimNode, args: [input.cli, ...input.args], env: input.env };
        }
    }
    catch {
        // A missing/legacy shim falls through to the bundled runtime below.
    }
    const bundledNode = (0, node_path_1.join)(input.resourcesPath, "cua_node", "bin", "node");
    if ((0, node_fs_1.existsSync)(bundledNode)) {
        return { command: bundledNode, args: [input.cli, ...input.args], env: input.env };
    }
    return {
        command: input.execPath,
        args: [input.cli, ...input.args],
        env: { ...input.env, ELECTRON_RUN_AS_NODE: "1" },
    };
}
//# sourceMappingURL=local-cli-runtime.js.map