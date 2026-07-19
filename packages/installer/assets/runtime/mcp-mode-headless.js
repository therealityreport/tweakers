"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMcpModeHeadless = runMcpModeHeadless;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const mcp_reconciliation_1 = require("./mcp-reconciliation");
const tweak_discovery_1 = require("./tweak-discovery");
function runMcpModeHeadless(input) {
    const request = parseRequest(input);
    const ownedTweaks = discoverOwnedMcpTweaks(request.tweaksRoot);
    const desiredTweaks = request.appExperience === "chatgpt"
        ? []
        : selectEnabledTweaks(ownedTweaks, readTweakersConfig(request.tweakersConfigPath));
    const beforeBytes = readBytes(request.configPath);
    const beforeFingerprint = (0, mcp_reconciliation_1.fingerprint)(beforeBytes);
    if (request.operation === "prove") {
        return buildProofResult({
            request,
            ownedTweaks,
            desiredTweaks,
            beforeFingerprint,
            changedDuringReconcile: false,
            restartRequired: false,
        });
    }
    const receipt = (0, mcp_reconciliation_1.reconcileMcpConfig)({
        configPath: request.configPath,
        statePath: request.statePath,
        tweaks: desiredTweaks,
        ownedTweaks,
        trigger: "manual-repair",
    });
    const afterFingerprint = (0, mcp_reconciliation_1.fingerprint)(readBytes(request.configPath));
    return buildProofResult({
        request,
        ownedTweaks,
        desiredTweaks,
        beforeFingerprint: receipt.beforeFingerprint,
        changedDuringReconcile: beforeFingerprint !== afterFingerprint,
        restartRequired: receipt.restartRequired,
    });
}
function buildProofResult({ request, ownedTweaks, desiredTweaks, beforeFingerprint, changedDuringReconcile, restartRequired, }) {
    const currentBytes = readBytes(request.configPath);
    const state = (0, mcp_reconciliation_1.readMcpSyncState)(request.statePath);
    const plan = (0, mcp_reconciliation_1.planMcpConfigReconciliation)(desiredTweaks, decodeUtf8(currentBytes), {
        ownedTweaks,
        preservedOptions: state?.preservedOptions,
        preservedApprovalPolicy: state?.preservedApprovalPolicy,
    });
    const exactNames = arraysEqual(plan.desiredNames, plan.appliedNames);
    const policyConflict = plan.approvalPolicy.status === "conflict";
    const ok = !plan.changed && plan.conflicts.length === 0 && !policyConflict && exactNames;
    return {
        schemaVersion: 1,
        operation: request.operation,
        appExperience: request.appExperience,
        ok,
        changed: request.operation === "prove" ? plan.changed : changedDuringReconcile,
        restartRequired,
        desiredNames: plan.desiredNames,
        appliedNames: plan.appliedNames,
        conflicts: plan.conflicts,
        preservedOptions: plan.preservedOptions,
        beforeFingerprint,
        afterFingerprint: (0, mcp_reconciliation_1.fingerprint)(currentBytes),
        error: ok
            ? null
            : policyConflict
                ? plan.approvalPolicy.error ?? "Approval policy conflict prevents an exact mode transition"
                : plan.conflicts.length > 0
                    ? "MCP ownership conflict prevents an exact mode transition"
                    : plan.changed
                        ? "MCP configuration does not match the requested app experience"
                        : "Applied MCP server names do not exactly match the desired set",
    };
}
function parseRequest(input) {
    if (!isRecord(input))
        throw new Error("Headless MCP request must be a JSON object");
    const allowed = new Set([
        "schemaVersion",
        "operation",
        "appExperience",
        "configPath",
        "statePath",
        "tweaksRoot",
        "tweakersConfigPath",
    ]);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
        throw new Error(`Unknown headless MCP request field: ${unknown.join(", ")}`);
    if (input.schemaVersion !== 1)
        throw new Error("Unsupported headless MCP request schemaVersion");
    if (input.operation !== "reconcile" && input.operation !== "prove") {
        throw new Error("Headless MCP operation must be reconcile or prove");
    }
    if (input.appExperience !== "chatgpt" && input.appExperience !== "tweakers") {
        throw new Error("Headless MCP appExperience must be chatgpt or tweakers");
    }
    for (const key of ["configPath", "statePath", "tweaksRoot", "tweakersConfigPath"]) {
        const value = input[key];
        if (typeof value !== "string" || !(0, node_path_1.isAbsolute)(value)) {
            throw new Error(`Headless MCP ${key} must be an absolute path`);
        }
    }
    if ((0, node_path_1.resolve)(input.configPath) === (0, node_path_1.resolve)(input.statePath)) {
        throw new Error("Headless MCP configPath and statePath must be different files");
    }
    return input;
}
function discoverOwnedMcpTweaks(tweaksRoot) {
    const owned = (0, tweak_discovery_1.discoverTweaks)(tweaksRoot)
        .filter((tweak) => tweak.manifest.mcp !== undefined)
        .map((tweak) => {
        assertValidMcp(tweak.manifest.id, tweak.manifest.mcp);
        return tweak;
    });
    return owned;
}
function assertValidMcp(id, value) {
    if (!value || typeof value.command !== "string" || value.command.length === 0) {
        throw new Error(`Installed tweak ${id} has an invalid MCP command`);
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== "string"))) {
        throw new Error(`Installed tweak ${id} has invalid MCP arguments`);
    }
    if (value.env !== undefined && (!isRecord(value.env) || Object.values(value.env).some((entry) => typeof entry !== "string"))) {
        throw new Error(`Installed tweak ${id} has an invalid MCP environment`);
    }
}
function readTweakersConfig(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return {};
    const parsed = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
    if (!isRecord(parsed))
        throw new Error("Tweakers config must contain a JSON object");
    return parsed;
}
function selectEnabledTweaks(tweaks, config) {
    if (config.tweaker?.safeMode === true)
        return [];
    return tweaks.filter((tweak) => (config.tweakHealth?.[tweak.manifest.id]?.status !== "quarantined"
        && config.tweaks?.[tweak.manifest.id]?.enabled !== false));
}
function readBytes(path) {
    return (0, node_fs_1.existsSync)(path) ? (0, node_fs_1.readFileSync)(path) : Buffer.alloc(0);
}
function decodeUtf8(value) {
    try {
        return new node_util_1.TextDecoder("utf-8", { fatal: true }).decode(value);
    }
    catch {
        throw new Error("Malformed TOML: config.toml is not valid UTF-8");
    }
}
function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function runCli() {
    try {
        const raw = (0, node_fs_1.readFileSync)(0, "utf8");
        if (Buffer.byteLength(raw) > 64 * 1024)
            throw new Error("Headless MCP request exceeds 64 KiB");
        const result = runMcpModeHeadless(JSON.parse(raw));
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (!result.ok)
            process.exitCode = 2;
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
if (require.main === module)
    runCli();
//# sourceMappingURL=mcp-mode-headless.js.map