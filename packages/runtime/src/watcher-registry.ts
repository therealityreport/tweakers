export type WatcherRegistryStatus = "ok" | "warn" | "error";
export type WatcherFreshness = "fresh" | "stale" | "missing" | "unsupported" | "unknown";

export interface WatcherProbe {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  lastExitCode: number | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  statusSchemaVersion: number | null;
  policyVersion: string | null;
  deferredReason: string | null;
  error: string | null;
  supportedStatusSchemas?: number[];
}

export interface WatcherHealthEntry {
  id: "tweakers-repair" | "mcp-lifecycle-reaper" | "mcp-pressure-guard";
  purpose: string;
  authority: "repair-only" | "automatic-process-signals" | "notification-only";
  platformKind: string;
  label: string;
  installedPath: string;
  cadenceSeconds: number;
  triggers: string[];
  installed: boolean;
  loaded: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastExitCode: number | null;
  lastSuccessAt: string | null;
  nextExpectedAt: string | null;
  freshness: WatcherFreshness;
  status: WatcherRegistryStatus;
  statusSchemaVersion: number | null;
  policyVersion: string | null;
  statePath: string | null;
  receiptPath: string | null;
  deferredReason: string | null;
  error: string | null;
  recommendedAction: string | null;
}

export interface WatcherRegistryInput {
  checkedAt: string;
  platformKind: string;
  homeDirectory: string;
  tweakersRoot: string;
  repair: WatcherProbe;
  reaper: WatcherProbe;
  guard: WatcherProbe;
}

interface WatcherDefinition {
  id: WatcherHealthEntry["id"];
  purpose: string;
  authority: WatcherHealthEntry["authority"];
  label: string;
  installedPath: (input: WatcherRegistryInput) => string;
  cadenceSeconds: number;
  triggers: string[];
  statePath: (input: WatcherRegistryInput) => string | null;
  receiptPath: (input: WatcherRegistryInput) => string | null;
  recommendedAction: string;
}

const DEFINITIONS: WatcherDefinition[] = [
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
    purpose: "Observe MCP pressure and publish notification-only warnings.",
    authority: "notification-only",
    label: "com.thomashulihan.codex-mcp-guard",
    installedPath: ({ homeDirectory }) => `${homeDirectory}/Library/LaunchAgents/com.thomashulihan.codex-mcp-guard.plist`,
    cadenceSeconds: 60,
    triggers: ["login", "every-60-seconds"],
    statePath: ({ homeDirectory }) => `${homeDirectory}/.codex/tmp/codex-mcp-guard-notify.json`,
    receiptPath: () => null,
    recommendedAction: "Run Tweakers lifecycle repair and verify the guard heartbeat.",
  },
];

export function buildWatcherRegistry(input: WatcherRegistryInput): WatcherHealthEntry[] {
  const probes: Record<WatcherHealthEntry["id"], WatcherProbe> = {
    "tweakers-repair": input.repair,
    "mcp-lifecycle-reaper": input.reaper,
    "mcp-pressure-guard": input.guard,
  };
  return DEFINITIONS.map((definition) => buildWatcherEntry(
    definition,
    probes[definition.id],
    input,
  ));
}

export function deriveWatcherFreshness(input: {
  checkedAt: string;
  cadenceSeconds: number;
  installed: boolean;
  loaded: boolean;
  lastRunAt: string | null;
  statusSchemaVersion: number | null;
  supportedStatusSchemas?: number[];
}): { freshness: WatcherFreshness; nextExpectedAt: string | null } {
  const {
    checkedAt,
    cadenceSeconds,
    installed,
    loaded,
    lastRunAt,
    statusSchemaVersion,
    supportedStatusSchemas,
  } = input;
  if (!installed || !loaded) return { freshness: "missing", nextExpectedAt: null };
  if (
    supportedStatusSchemas
    && (statusSchemaVersion === null || !supportedStatusSchemas.includes(statusSchemaVersion))
  ) {
    return { freshness: "unsupported", nextExpectedAt: null };
  }
  if (!lastRunAt) return { freshness: "unknown", nextExpectedAt: null };

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

function buildWatcherEntry(
  definition: WatcherDefinition,
  probe: WatcherProbe,
  input: WatcherRegistryInput,
): WatcherHealthEntry {
  const timing = deriveWatcherFreshness({
    checkedAt: input.checkedAt,
    cadenceSeconds: definition.cadenceSeconds,
    installed: probe.installed,
    loaded: probe.loaded,
    lastRunAt: probe.lastRunAt,
    statusSchemaVersion: probe.statusSchemaVersion,
    supportedStatusSchemas: probe.supportedStatusSchemas,
  });
  const status = watcherStatus(probe, timing.freshness);
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
    recommendedAction: status === "ok" ? null : definition.recommendedAction,
  };
}

function watcherStatus(probe: WatcherProbe, freshness: WatcherFreshness): WatcherRegistryStatus {
  if (
    !probe.installed
    || !probe.loaded
    || probe.error
    || (probe.lastExitCode !== null && probe.lastExitCode !== 0)
  ) {
    return "error";
  }
  if (freshness === "unsupported" || freshness === "stale") return "error";
  if (freshness !== "fresh" || probe.deferredReason) return "warn";
  return "ok";
}
