"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildWatcherRegistry = buildWatcherRegistry;
exports.deriveWatcherFreshness = deriveWatcherFreshness;
const DEFINITIONS = [
    {
        id: "tweakers-repair",
        purpose: "Repair Tweakers after app updates and managed-runtime drift.",
        authority: "repair-only",
        label: "com.therealityreport.tweakers.watcher",
        installedPath: ({ homeDirectory }) => `${homeDirectory}/Library/LaunchAgents/com.therealityreport.tweakers.watcher.plist`,
        cadenceSeconds: 3_600,
        triggers: ["login", "app-asar-change", "hourly"],
        statePath: ({ tweakersRoot }) => `${tweakersRoot}/auto-repair-state.json`,
        receiptPath: ({ tweakersRoot }) => `${tweakersRoot}/auto-repair-state.json`,
        recommendedAction: "Run Tweakers repair and verify the repair-watcher definition.",
    },
    {
        id: "mcp-lifecycle-reaper",
        purpose: "Classify MCP process trees and execute the strict local cleanup policy.",
        authority: "automatic-process-signals",
        label: "com.thomashulihan.codex-mcp-idle-reaper",
        installedPath: ({ homeDirectory }) => `${homeDirectory}/Library/LaunchAgents/com.thomashulihan.codex-mcp-idle-reaper.plist`,
        cadenceSeconds: 60,
        triggers: ["login", "every-60-seconds"],
        statePath: ({ homeDirectory }) => `${homeDirectory}/.codex/tmp/codex-mcp-lifecycle-state.json`,
        receiptPath: ({ homeDirectory }) => `${homeDirectory}/.codex/tmp/codex-mcp-lifecycle-actions.jsonl`,
        recommendedAction: "Run Tweakers lifecycle repair; do not start a second cleanup service.",
    },
    {
        id: "mcp-pressure-guard",
        purpose: "Observe MCP process health and publish non-mutating notifications.",
        authority: "observation-and-notification-only",
        label: "com.thomashulihan.codex-mcp-guard",
        installedPath: ({ homeDirectory }) => `${homeDirectory}/Library/LaunchAgents/com.thomashulihan.codex-mcp-guard.plist`,
        cadenceSeconds: 60,
        triggers: ["login", "every-60-seconds"],
        statePath: ({ homeDirectory }) => `${homeDirectory}/.codex/tmp/codex-mcp-guard-status.json`,
        receiptPath: () => null,
        recommendedAction: "Run Tweakers lifecycle repair and verify the guard heartbeat.",
    },
];
function buildWatcherRegistry(input) {
    const probes = {
        "tweakers-repair": input.repair,
        "mcp-lifecycle-reaper": input.reaper,
        "mcp-pressure-guard": input.guard,
    };
    return DEFINITIONS.map((definition) => buildWatcherEntry(definition, probes[definition.id], input));
}
function deriveWatcherFreshness(input) {
    const { checkedAt, cadenceSeconds, installed, loaded, disabled, lastRunAt, statusSchemaVersion, supportedStatusSchemas, } = input;
    if (disabled === true && !loaded) {
        return { freshness: "intentionally_disabled", nextExpectedAt: null };
    }
    if (!installed || !loaded)
        return { freshness: "missing", nextExpectedAt: null };
    if (supportedStatusSchemas
        && (statusSchemaVersion === null || !supportedStatusSchemas.includes(statusSchemaVersion))) {
        return { freshness: "unsupported", nextExpectedAt: null };
    }
    if (!lastRunAt)
        return { freshness: "unknown", nextExpectedAt: null };
    const checked = Date.parse(checkedAt);
    const lastRun = Date.parse(lastRunAt);
    if (!Number.isFinite(checked) || !Number.isFinite(lastRun) || lastRun > checked + 5_000) {
        return { freshness: "unknown", nextExpectedAt: null };
    }
    const nextExpected = lastRun + cadenceSeconds * 1_000;
    const staleAfter = lastRun + cadenceSeconds * 3_000;
    return {
        freshness: checked <= staleAfter ? "fresh" : "stale",
        nextExpectedAt: new Date(nextExpected).toISOString(),
    };
}
function buildWatcherEntry(definition, probe, input) {
    const timing = deriveWatcherFreshness({
        checkedAt: input.checkedAt,
        cadenceSeconds: definition.cadenceSeconds,
        installed: probe.installed,
        loaded: probe.loaded,
        disabled: probe.disabled,
        lastRunAt: probe.lastRunAt,
        statusSchemaVersion: probe.statusSchemaVersion,
        supportedStatusSchemas: definition.id === "mcp-pressure-guard" ? [3] : probe.supportedStatusSchemas,
    });
    const lifecycleDisposition = guardLifecycleDisposition(definition.id, probe);
    const status = watcherStatus(probe, timing.freshness, lifecycleDisposition);
    return {
        id: definition.id,
        purpose: definition.purpose,
        authority: definition.authority,
        platformKind: input.platformKind,
        label: definition.label,
        installedPath: definition.installedPath(input),
        cadenceSeconds: definition.cadenceSeconds,
        triggers: definition.triggers,
        installed: probe.installed,
        loaded: probe.loaded,
        disabled: probe.disabled ?? null,
        running: probe.running,
        lastRunAt: probe.lastRunAt,
        lastExitCode: probe.lastExitCode,
        lastSuccessAt: probe.lastSuccessAt,
        nextExpectedAt: timing.nextExpectedAt,
        freshness: timing.freshness,
        status,
        statusSchemaVersion: probe.statusSchemaVersion,
        policyVersion: probe.policyVersion,
        statePath: definition.statePath(input),
        receiptPath: definition.receiptPath(input),
        deferredReason: probe.deferredReason,
        error: probe.error,
        legacyStatusSchemaVersion: probe.legacyStatusSchemaVersion ?? null,
        lifecycleDisposition,
        recommendedAction: status === "ok" ? null : definition.recommendedAction,
    };
}
function guardLifecycleDisposition(watcherId, probe) {
    if (watcherId !== "mcp-pressure-guard")
        return "active";
    if (probe.disabled === true && !probe.loaded)
        return "intentionally_disabled";
    if (probe.disabled === true && probe.loaded)
        return "inconsistent";
    if (probe.disabled === false && !probe.loaded)
        return "inconsistent";
    return probe.disabled === null ? "unknown" : "active";
}
function watcherStatus(probe, freshness, lifecycleDisposition) {
    if (lifecycleDisposition === "intentionally_disabled")
        return "ok";
    if (lifecycleDisposition === "inconsistent" || lifecycleDisposition === "unknown")
        return "error";
    if (!probe.installed
        || !probe.loaded
        || probe.error
        || (probe.lastExitCode !== null && probe.lastExitCode !== 0)) {
        return "error";
    }
    if (freshness === "unsupported" || freshness === "stale")
        return "error";
    if (freshness !== "fresh" || probe.deferredReason)
        return "warn";
    return "ok";
}
//# sourceMappingURL=watcher-registry.js.map