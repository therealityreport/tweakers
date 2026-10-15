"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_LOG_BYTES = void 0;
exports.appendCappedLog = appendCappedLog;
const node_fs_1 = require("node:fs");
exports.MAX_LOG_BYTES = 10 * 1024 * 1024;
function appendCappedLog(path, line, maxBytes = exports.MAX_LOG_BYTES, retainedArchives = 1) {
    const incoming = Buffer.from(line);
    const rotate = () => {
        for (let index = retainedArchives; index > 1; index -= 1) {
            try {
                (0, node_fs_1.renameSync)(`${path}.${index - 1}`, `${path}.${index}`);
            }
            catch { /* absent archive */ }
        }
        (0, node_fs_1.renameSync)(path, `${path}.1`);
    };
    if (incoming.byteLength >= maxBytes) {
        try {
            (0, node_fs_1.statSync)(path);
            rotate();
        }
        catch {
            // If rotation fails, overwrite the primary log below.
        }
        (0, node_fs_1.writeFileSync)(path, incoming.subarray(incoming.byteLength - maxBytes));
        return;
    }
    try {
        const size = (0, node_fs_1.statSync)(path).size;
        if (size + incoming.byteLength > maxBytes) {
            rotate();
        }
    }
    catch {
        // If stat or rotation fails, still try to append below; logging must be best-effort.
    }
    (0, node_fs_1.appendFileSync)(path, incoming);
}
//# sourceMappingURL=logging.js.map