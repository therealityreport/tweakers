import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWatcherRegistry,
  deriveWatcherFreshness,
  type WatcherProbe,
} from "../src/watcher-registry";

const CHECKED_AT = "2026-07-23T21:00:00.000Z";

test("watcher registry keeps repair, reaper, and guard authority distinct", () => {
  const watchers = buildWatcherRegistry({
    checkedAt: CHECKED_AT,
    platformKind: "darwin",
    homeDirectory: "/Users/test",
    tweakersRoot: "/Users/test/Library/Application Support/codex-plusplus",
    repair: healthyProbe("2026-07-23T20:30:00.000Z", 1, "v1"),
    reaper: healthyProbe("2026-07-23T20:59:30.000Z", 2, "v2"),
    guard: healthyProbe("2026-07-23T20:59:30.000Z", 1, "v1"),
  });

  assert.deepEqual(watchers.map(({ id, authority, cadenceSeconds }) => ({
    id,
    authority,
    cadenceSeconds,
  })), [
    {
      id: "tweakers-repair",
      authority: "repair-only",
      cadenceSeconds: 3_600,
    },
    {
      id: "mcp-lifecycle-reaper",
      authority: "automatic-process-signals",
      cadenceSeconds: 60,
    },
    {
      id: "mcp-pressure-guard",
      authority: "notification-only",
      cadenceSeconds: 60,
    },
  ]);
  assert.equal(watchers.every((watcher) => watcher.status === "ok"), true);
  assert.equal(watchers.find((watcher) => watcher.id === "mcp-pressure-guard")?.receiptPath, null);
});

test("freshness uses each service cadence and permits loaded idle one-shot jobs", () => {
  const repair = deriveWatcherFreshness({
    checkedAt: CHECKED_AT,
    cadenceSeconds: 3_600,
    installed: true,
    loaded: true,
    lastRunAt: "2026-07-23T18:00:01.000Z",
    statusSchemaVersion: 1,
    supportedStatusSchemas: [1],
  });
  const reaper = deriveWatcherFreshness({
    checkedAt: CHECKED_AT,
    cadenceSeconds: 60,
    installed: true,
    loaded: true,
    lastRunAt: "2026-07-23T20:57:01.000Z",
    statusSchemaVersion: 1,
    supportedStatusSchemas: [1, 2],
  });

  assert.equal(repair.freshness, "fresh");
  assert.equal(reaper.freshness, "fresh");
  assert.equal(repair.nextExpectedAt, "2026-07-23T19:00:01.000Z");
  assert.equal(reaper.nextExpectedAt, "2026-07-23T20:58:01.000Z");
});

test("stale or unsupported lifecycle status cannot appear healthy", () => {
  const watchers = buildWatcherRegistry({
    checkedAt: CHECKED_AT,
    platformKind: "darwin",
    homeDirectory: "/Users/test",
    tweakersRoot: "/Users/test/tweakers",
    repair: healthyProbe("2026-07-23T20:30:00.000Z", 1, "v1"),
    reaper: healthyProbe("2026-07-23T20:50:00.000Z", 2, "v2"),
    guard: {
      ...healthyProbe("2026-07-23T20:59:30.000Z", 9, "v1"),
      supportedStatusSchemas: [1],
    },
  });

  const reaper = watchers.find((watcher) => watcher.id === "mcp-lifecycle-reaper");
  const guard = watchers.find((watcher) => watcher.id === "mcp-pressure-guard");
  assert.equal(reaper?.freshness, "stale");
  assert.equal(reaper?.status, "error");
  assert.match(reaper?.recommendedAction ?? "", /second cleanup service/i);
  assert.equal(guard?.freshness, "unsupported");
  assert.equal(guard?.status, "error");
});

test("missing heartbeat is explicit and never inferred from loaded state", () => {
  const missingHeartbeat: WatcherProbe = {
    installed: true,
    loaded: true,
    running: false,
    lastExitCode: 0,
    lastRunAt: null,
    lastSuccessAt: null,
    statusSchemaVersion: null,
    policyVersion: "v1",
    deferredReason: null,
    error: "status missing",
    supportedStatusSchemas: [1],
  };
  const watchers = buildWatcherRegistry({
    checkedAt: CHECKED_AT,
    platformKind: "darwin",
    homeDirectory: "/Users/test",
    tweakersRoot: "/Users/test/tweakers",
    repair: healthyProbe("2026-07-23T20:30:00.000Z", 1, "v1"),
    reaper: healthyProbe("2026-07-23T20:59:30.000Z", 1, "v1"),
    guard: missingHeartbeat,
  });

  const guard = watchers.find((watcher) => watcher.id === "mcp-pressure-guard");
  assert.equal(guard?.loaded, true);
  assert.equal(guard?.running, false);
  assert.equal(guard?.freshness, "unsupported");
  assert.equal(guard?.status, "error");
});

test("declared status schemas reject missing or malformed schema evidence", () => {
  const missing = deriveWatcherFreshness({
    checkedAt: CHECKED_AT,
    cadenceSeconds: 60,
    installed: true,
    loaded: true,
    lastRunAt: "2026-07-23T20:59:30.000Z",
    statusSchemaVersion: null,
    supportedStatusSchemas: [1],
  });
  assert.equal(missing.freshness, "unsupported");

  const watchers = buildWatcherRegistry({
    checkedAt: CHECKED_AT,
    platformKind: "darwin",
    homeDirectory: "/Users/test",
    tweakersRoot: "/Users/test/tweakers",
    repair: healthyProbe("2026-07-23T20:30:00.000Z", 1, "v1"),
    reaper: healthyProbe("2026-07-23T20:59:30.000Z", 1, "v1"),
    guard: {
      ...healthyProbe("2026-07-23T20:59:30.000Z", 1, "v1"),
      statusSchemaVersion: null,
      error: null,
    },
  });
  const guard = watchers.find((watcher) => watcher.id === "mcp-pressure-guard");
  assert.equal(guard?.freshness, "unsupported");
  assert.equal(guard?.status, "error");
});

test("watcher registry contains no process arguments or cleanup eligibility field", () => {
  const watchers = buildWatcherRegistry({
    checkedAt: CHECKED_AT,
    platformKind: "darwin",
    homeDirectory: "/Users/test",
    tweakersRoot: "/Users/test/tweakers",
    repair: healthyProbe("2026-07-23T20:30:00.000Z", 1, "v1"),
    reaper: healthyProbe("2026-07-23T20:59:30.000Z", 1, "v1"),
    guard: healthyProbe("2026-07-23T20:59:30.000Z", 1, "v1"),
  });
  const serialized = JSON.stringify(watchers);

  assert.doesNotMatch(serialized, /argv|commandLine|actionable|eligible/i);
});

function healthyProbe(
  lastRunAt: string,
  statusSchemaVersion: number,
  policyVersion: string,
): WatcherProbe {
  return {
    installed: true,
    loaded: true,
    running: false,
    lastExitCode: 0,
    lastRunAt,
    lastSuccessAt: lastRunAt,
    statusSchemaVersion,
    policyVersion,
    deferredReason: null,
    error: null,
    supportedStatusSchemas: statusSchemaVersion === 2 ? [1, 2] : [1],
  };
}
