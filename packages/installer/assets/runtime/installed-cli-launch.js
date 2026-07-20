"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopUpdateLaunchSubmissionError = exports.MAX_LAUNCHCTL_OUTPUT_BYTES = void 0;
exports.classifyInstalledCliCommand = classifyInstalledCliCommand;
exports.submitInstalledCliWithLaunchd = submitInstalledCliWithLaunchd;
exports.buildTransientLaunchdExitTrap = buildTransientLaunchdExitTrap;
exports.MAX_LAUNCHCTL_OUTPUT_BYTES = 64 * 1024;
const MAX_LAUNCHCTL_EVIDENCE_CHARS = 4_096;
class DesktopUpdateLaunchSubmissionError extends Error {
    commandKind;
    jobLabel;
    code = "TWEAKERS_DESKTOP_UPDATE_LAUNCH_SUBMISSION_FAILED";
    constructor(commandKind, jobLabel, detail) {
        super(`launchctl submit failed for desktop-update ${commandKind}: ${detail}`);
        this.commandKind = commandKind;
        this.jobLabel = jobLabel;
        this.name = "DesktopUpdateLaunchSubmissionError";
    }
}
exports.DesktopUpdateLaunchSubmissionError = DesktopUpdateLaunchSubmissionError;
function classifyInstalledCliCommand(args) {
    switch (args[0]) {
        case "update-chatgpt":
            return { commandKind: "start", cutover: true };
        case "update-chatgpt-resume":
            return { commandKind: "resume", cutover: true };
        case "update-chatgpt-reconcile":
            return { commandKind: "reconcile", cutover: true };
        case "update-chatgpt-cancel":
            return { commandKind: "cancel", cutover: false };
        default:
            return { commandKind: "other", cutover: false };
    }
}
function submitInstalledCliWithLaunchd(input, dependencies) {
    const shellCommand = buildInstalledCliShell(input);
    let result;
    try {
        result = dependencies.submit("launchctl", ["submit", "-l", input.label, "--", "/bin/sh", "-c", shellCommand], {
            encoding: "utf8",
            maxBuffer: exports.MAX_LAUNCHCTL_OUTPUT_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
        });
    }
    catch (error) {
        result = {
            status: null,
            error: error instanceof Error ? error : new Error(String(error)),
        };
    }
    if (result.status === 0) {
        dependencies.onEvent?.({
            event: "desktop-update-launch",
            commandKind: input.classification.commandKind,
            jobLabel: input.label,
            submitResult: "submitted",
            status: 0,
        });
        return true;
    }
    const detail = launchctlFailureDetail(result);
    dependencies.onEvent?.({
        event: "desktop-update-launch",
        commandKind: input.classification.commandKind,
        jobLabel: input.label,
        submitResult: "failed",
        status: result.status,
        error: detail,
    });
    if (input.classification.cutover) {
        throw new DesktopUpdateLaunchSubmissionError(input.classification.commandKind, input.label, detail);
    }
    return false;
}
function buildTransientLaunchdExitTrap(label) {
    const quotedLabel = shellQuote(label);
    return [
        "cleanup_transient_launchd_job() {",
        "  status=$?",
        "  trap - EXIT HUP INT TERM",
        `  launchctl remove ${quotedLabel} >/dev/null 2>&1 || launchctl bootout gui/$(id -u)/${quotedLabel} >/dev/null 2>&1`,
        '  exit "$status"',
        "}",
        "trap cleanup_transient_launchd_job EXIT",
        "trap 'exit 129' HUP",
        "trap 'exit 130' INT",
        "trap 'exit 143' TERM",
    ].join("\n");
}
function buildInstalledCliShell(input) {
    const assignments = Object.entries(input.environment).map(([name, value]) => {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
            throw new Error(`Invalid launch environment variable name: ${name}`);
        }
        return `${name}=${shellQuote(value)}`;
    });
    return [
        buildTransientLaunchdExitTrap(input.label),
        `cd ${shellQuote(input.cwd)} || exit $?`,
        ["env", ...assignments, input.command, ...input.args].map(shellQuoteWord).join(" "),
    ].join("\n");
}
function launchctlFailureDetail(result) {
    const raw = result.error?.message
        ?? cleanOutput(result.stderr)
        ?? cleanOutput(result.stdout)
        ?? (result.signal ? `signal ${result.signal}` : `status ${result.status ?? "unknown"}`);
    return raw.length <= MAX_LAUNCHCTL_EVIDENCE_CHARS
        ? raw
        : `${raw.slice(0, MAX_LAUNCHCTL_EVIDENCE_CHARS - 1)}…`;
}
function cleanOutput(value) {
    const cleaned = value?.trim();
    return cleaned ? cleaned : null;
}
function shellQuoteWord(value) {
    const assignment = /^([A-Z_][A-Z0-9_]*)=(.*)$/s.exec(value);
    return assignment ? `${assignment[1]}=${assignment[2]}` : shellQuote(value);
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
//# sourceMappingURL=installed-cli-launch.js.map