"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTerminalCodexBinary = resolveTerminalCodexBinary;
const node_path_1 = require("node:path");
/**
 * Resolve the independently installed Terminal CLI without confusing it with
 * the Codex binary embedded in the desktop app. The standalone installer owns
 * ~/.local/bin/codex, so that stable user-facing shim takes precedence over
 * app-process PATH drift.
 */
function resolveTerminalCodexBinary(options) {
    const excluded = new Set(options.excludedPaths ?? []);
    const candidates = [
        options.preferredPath,
        (0, node_path_1.join)(options.home, ".local", "bin", "codex"),
        ...(options.pathValue ?? "")
            .split(node_path_1.delimiter)
            .filter(Boolean)
            .map((directory) => (0, node_path_1.join)(directory, "codex")),
    ];
    const seen = new Set();
    for (const candidate of candidates) {
        if (!candidate || seen.has(candidate) || excluded.has(candidate))
            continue;
        seen.add(candidate);
        if (options.isExecutable(candidate))
            return candidate;
    }
    return null;
}
//# sourceMappingURL=codex-terminal-cli.js.map