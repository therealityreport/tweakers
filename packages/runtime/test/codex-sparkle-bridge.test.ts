import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexSparkleBridge,
  type SparkleNativeExports,
} from "../src/codex-sparkle-bridge";

function fakeAddon() {
  const calls: string[] = [];
  const sinks: Record<string, (...args: unknown[]) => void> = {};
  const addon: SparkleNativeExports = {
    init: (...args: unknown[]) => calls.push(`init:${args.length}`),
    checkForUpdates: () => calls.push("check"),
    checkForUpdatesInBackground: () => calls.push("check-background"),
    installLatestUpdate: () => calls.push("install-latest"),
    setUpdateLifecycleStateSink: (sink: (...args: unknown[]) => void) => { sinks.lifecycle = sink; },
    setDownloadProgressSink: (sink: (...args: unknown[]) => void) => { sinks.download = sink; },
    setUpdateReadySink: (sink: (...args: unknown[]) => void) => { sinks.ready = sink; },
  };
  return { addon, calls, sinks };
}

test("wraps Sparkle init and exposes only safe feed metadata", () => {
  const { addon, calls } = fakeAddon();
  const bridge = new CodexSparkleBridge();
  bridge.wrapExports(addon);

  const headers = { Authorization: "Bearer secret" };
  addon.init?.("https://updates.example.test/internal.xml", headers, "https://updates.example.test/public.xml");

  assert.deepEqual(calls, ["init:3"]);
  assert.deepEqual(bridge.getSnapshot(), {
    available: true,
    lifecycle: "idle",
    downloadProgressPercent: null,
    installProgressPercent: null,
    ready: false,
    lastError: null,
    feedUrl: "https://updates.example.test/internal.xml",
    fallbackFeedUrl: "https://updates.example.test/public.xml",
    canInstall: false,
    installPrerequisiteFailure: "Native desktop updates are paused while Tweakers is active; use the signed-app refresh flow.",
  });
  assert.doesNotMatch(JSON.stringify(bridge.getSnapshot()), /secret|Authorization/);
});

test("tees native lifecycle sinks without replacing OpenAI callbacks", () => {
  const { addon, sinks } = fakeAddon();
  const bridge = new CodexSparkleBridge();
  bridge.wrapExports(addon);

  const observed: unknown[][] = [];
  addon.setUpdateLifecycleStateSink?.((...args: unknown[]) => observed.push(args));
  addon.setDownloadProgressSink?.((...args: unknown[]) => observed.push(args));
  addon.setUpdateReadySink?.((...args: unknown[]) => observed.push(args));
  sinks.lifecycle("downloading");
  sinks.download(37.5);
  sinks.ready(true);

  assert.deepEqual(observed, [["downloading"], [37.5], [true]]);
  assert.equal(bridge.getSnapshot().lifecycle, "ready");
  assert.equal(bridge.getSnapshot().downloadProgressPercent, 37.5);
  assert.equal(bridge.getSnapshot().ready, true);
});

test("native checks are suppressed and install remains behind safe actionability gates", async () => {
  const { addon, calls, sinks } = fakeAddon();
  const preparations: string[] = [];
  const bridge = new CodexSparkleBridge({
    getInstallPrerequisite: () => ({ ok: true }),
    prepareForInstall: () => { preparations.push("prepare"); },
  });
  bridge.wrapExports(addon);
  addon.init?.("https://updates.example.test/feed.xml");
  addon.setUpdateReadySink?.(() => {});

  addon.checkForUpdates?.();
  addon.checkForUpdatesInBackground?.();
  assert.equal(await bridge.installUpdate(), false);
  sinks.ready(true);
  assert.equal(await bridge.installUpdate(), false);

  assert.deepEqual(calls, ["init:1"]);
  assert.deepEqual(preparations, []);
  assert.equal(bridge.getSnapshot().installPrerequisiteFailure, "Native desktop updates are paused while Tweakers is active; use the signed-app refresh flow.");
});

test("invalid signed-backup prerequisite blocks every native install entry point", async () => {
  const calls: string[] = [];
  const addon: SparkleNativeExports = {
    init: () => {},
    installUpdatesIfAvailable: () => calls.push("install"),
    setUpdateReadySink: (sink: (...args: unknown[]) => void) => sink(true),
  };
  const bridge = new CodexSparkleBridge({
    getInstallPrerequisite: () => ({ ok: false, reason: "Signed Codex.app backup is missing." }),
  });
  bridge.wrapExports(addon);
  addon.init?.("https://updates.example.test/feed.xml");
  addon.setUpdateReadySink?.(() => {});

  assert.equal(await bridge.installUpdate(), false);
  assert.deepEqual(calls, []);
  assert.equal(bridge.getSnapshot().installPrerequisiteFailure, "Signed Codex.app backup is missing.");
});

test("fetches bounded appcast metadata with ephemeral primary-feed headers", async () => {
  const requests: Array<{ url: string; headers: unknown }> = [];
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title>Codex 2.4.0</title>
    <link>https://updates.example.test/releases/2.4.0</link>
    <enclosure sparkle:version="240" sparkle:shortVersionString="2.4.0" />
  </item></channel></rss>`;
  const bridge = new CodexSparkleBridge({
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers });
      return response(url, xml);
    },
  });
  const addon: SparkleNativeExports = { init: () => {} };
  bridge.wrapExports(addon);
  addon.init?.("https://updates.example.test/internal.xml", { Authorization: "Bearer private" }, "https://updates.example.test/public.xml");

  assert.deepEqual(await bridge.fetchAppcastMetadata(), {
    marketingVersion: "2.4.0",
    build: "240",
    releaseUrl: "https://updates.example.test/releases/2.4.0",
    feedUrl: "https://updates.example.test/internal.xml",
    checkedAt: "2026-07-13T12:00:00.000Z",
    stale: false,
    error: null,
  });
  assert.equal((requests[0]?.headers as Record<string, string>).Authorization, "Bearer private");
  assert.doesNotMatch(JSON.stringify(await bridge.fetchAppcastMetadata()), /private|Authorization/);
});

test("appcast falls back without private headers after malformed, oversized, or failed primary feed", async () => {
  for (const primary of ["malformed", "oversized", "failed"] as const) {
    const requests: Array<{ url: string; headers: unknown }> = [];
    const bridge = new CodexSparkleBridge({
      maxAppcastBytes: 200,
      fetch: async (url, init) => {
        requests.push({ url, headers: init.headers });
        if (url.includes("internal")) {
          if (primary === "failed") throw new Error("Bearer private");
          if (primary === "oversized") return response(url, "x".repeat(256), { "content-length": "256" });
          return response(url, "<rss><broken>");
        }
        return response(url, `<rss><channel><item><link>https://updates.example.test/r</link><enclosure sparkle:version="7" sparkle:shortVersionString="1.7.0" /></item></channel></rss>`);
      },
    });
    const addon: SparkleNativeExports = { init: () => {} };
    bridge.wrapExports(addon);
    addon.init?.("https://updates.example.test/internal.xml", { Authorization: "Bearer private" }, "https://updates.example.test/public.xml");

    const metadata = await bridge.fetchAppcastMetadata();
    assert.equal(metadata.marketingVersion, "1.7.0");
    assert.equal(metadata.feedUrl, "https://updates.example.test/public.xml");
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.headers, undefined);
    assert.doesNotMatch(JSON.stringify(metadata), /private|Authorization/);
  }
});

test("appcast rejects every non-HTTPS redirect and returns safe stale metadata", async () => {
  let mode: "fresh" | "redirect" = "fresh";
  const bridge = new CodexSparkleBridge({
    fetch: async (url) => mode === "redirect"
      ? response(url, "", { location: "http://unsafe.example.test/feed.xml" }, 302)
      : response(url, `<rss><channel><item><link>https://updates.example.test/r</link><enclosure sparkle:version="8" sparkle:shortVersionString="1.8.0" /></item></channel></rss>`),
  });
  const addon: SparkleNativeExports = { init: () => {} };
  bridge.wrapExports(addon);
  addon.init?.("https://updates.example.test/feed.xml");
  assert.equal((await bridge.fetchAppcastMetadata()).stale, false);

  mode = "redirect";
  const stale = await bridge.fetchAppcastMetadata();
  assert.equal(stale.stale, true);
  assert.equal(stale.marketingVersion, "1.8.0");
  assert.equal(stale.error, "Appcast metadata is unavailable.");
});

function response(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  status = 200,
) {
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    arrayBuffer: async () => Buffer.from(body),
  };
}

test("native scheduler is disabled, not just the JS check bindings", () => {
  const automaticallyChecksForUpdates: boolean[] = [];
  const updateCheckIntervals: number[] = [];
  const scheduled: string[] = [];
  const checks: string[] = [];
  const addon = {
    automaticallyChecksForUpdates: true,
    updateCheckInterval: 3600,
    setAutomaticallyChecksForUpdates: (value: boolean) => {
      automaticallyChecksForUpdates.push(value);
    },
    setUpdateCheckInterval: (seconds: number) => {
      updateCheckIntervals.push(seconds);
    },
    scheduleNextUpdateCheck: () => scheduled.push("scheduled"),
    checkForUpdates: () => checks.push("check"),
  } satisfies SparkleNativeExports;
  const bridge = new CodexSparkleBridge();

  bridge.wrapExports(addon);
  const checkResult = addon.checkForUpdates?.();
  addon.scheduleNextUpdateCheck?.();

  assert.deepEqual(automaticallyChecksForUpdates, [false]);
  assert.deepEqual(updateCheckIntervals, [0]);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(checks, []);
  assert.equal(checkResult, false);

  const propertyOnlyAddon = {
    automaticallyChecksForUpdates: true,
    updateCheckInterval: 3600,
  } satisfies SparkleNativeExports;

  bridge.wrapExports(propertyOnlyAddon);

  assert.equal(propertyOnlyAddon.automaticallyChecksForUpdates, false);
  assert.equal(propertyOnlyAddon.updateCheckInterval, 0);
});
