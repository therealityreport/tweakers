import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexSparkleBridge,
  createHealthProbeCodexSparkleBridgeOptions,
  type SparkleNativeExports,
} from "../src/codex-sparkle-bridge";

const VALID_SPARKLE_SIGNATURE = Buffer.alloc(64).toString("base64");

function signedEnclosure(build: string, marketingVersion: string): string {
  return `<enclosure url="https://updates.example.test/downloads/${build}.zip" sparkle:edSignature="${VALID_SPARKLE_SIGNATURE}" sparkle:version="${build}" sparkle:shortVersionString="${marketingVersion}" />`;
}

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

test("manual and background checks use safe callbacks while native checks and installs remain suppressed", async () => {
  const { addon, calls, sinks } = fakeAddon();
  const preparations: string[] = [];
  const manualChecks: string[] = [];
  const backgroundChecks: string[] = [];
  const bridge = new CodexSparkleBridge({
    requestManualCheck: () => { manualChecks.push("manual"); },
    requestBackgroundCheck: () => { backgroundChecks.push("background"); },
    getInstallPrerequisite: () => ({ ok: true }),
    prepareForInstall: () => { preparations.push("prepare"); },
  });
  bridge.wrapExports(addon);
  assert.equal(bridge.nativeUpdateControlActive(), false);
  addon.init?.("https://updates.example.test/feed.xml");
  addon.setUpdateReadySink?.(() => {});

  const manualResult = addon.checkForUpdates?.();
  const backgroundResult = addon.checkForUpdatesInBackground?.();
  assert.equal(await bridge.installUpdate(), false);
  sinks.ready(true);
  assert.equal(await bridge.installUpdate(), false);

  assert.deepEqual(calls, ["init:1"]);
  assert.deepEqual(manualChecks, ["manual"]);
  assert.deepEqual(backgroundChecks, ["background"]);
  assert.equal(manualResult, false);
  assert.equal(backgroundResult, false);
  assert.deepEqual(preparations, []);
  assert.equal(bridge.getSnapshot().installPrerequisiteFailure, "Native desktop updates are paused while Tweakers is active; use the signed-app refresh flow.");
});

test("protected quarantine prevents Sparkle from requesting checks or a durable install", async () => {
  const { addon, calls, sinks } = fakeAddon();
  const requested: string[] = [];
  const bridge = new CodexSparkleBridge({
    requestManualCheck: () => { requested.push("manual"); },
    requestBackgroundCheck: () => { requested.push("background"); },
    requestInstall: () => { requested.push("install"); },
    getInstallPrerequisite: () => ({ ok: true }),
    assertProtectedUpdateAllowed: () => { throw new Error("fresh authority required"); },
  });
  bridge.wrapExports(addon);
  addon.init?.("https://updates.example.test/feed.xml");
  addon.setUpdateReadySink?.(() => {});
  bridge.setSafeUpdateAvailable(true);

  assert.equal(addon.checkForUpdates?.(), false);
  assert.equal(addon.checkForUpdatesInBackground?.(), false);
  assert.equal(await bridge.installUpdate(), false);
  sinks.ready(true);
  assert.equal(addon.installLatestUpdate?.(), false);
  assert.deepEqual(requested, []);
  assert.deepEqual(calls, ["init:1"]);
  assert.match(bridge.getSnapshot().installPrerequisiteFailure ?? "", /fresh authority required/);
});

test("health-probe options keep every native updater action inert after initialization", async () => {
  const rawCalls: string[] = [];
  const networkCalls: string[] = [];
  const downstreamCalls: string[] = [];
  const addon: SparkleNativeExports = {
    init: () => { rawCalls.push("init"); },
    checkForUpdates: () => { rawCalls.push("raw-manual"); },
    checkForUpdatesInBackground: () => { rawCalls.push("raw-background"); },
    installLatestUpdate: () => { rawCalls.push("raw-install-latest"); return true; },
    installUpdatesIfAvailable: () => { rawCalls.push("raw-install-available"); return true; },
    setAutomaticallyChecksForUpdates: () => { rawCalls.push("raw-auto-check-setter"); },
    setUpdateCheckInterval: () => { rawCalls.push("raw-interval-setter"); },
    scheduleNextUpdateCheck: () => { rawCalls.push("raw-schedule"); },
    resetUpdateCycle: () => { rawCalls.push("raw-reset"); },
    setUpdateLifecycleStateSink: () => { rawCalls.push("raw-lifecycle-sink-setter"); },
    setDownloadProgressSink: () => { rawCalls.push("raw-download-sink-setter"); },
    setInstallProgressSink: () => { rawCalls.push("raw-install-sink-setter"); },
    setUpdateReadySink: () => { rawCalls.push("raw-ready-sink-setter"); },
  };
  const healthOptions = createHealthProbeCodexSparkleBridgeOptions();
  assert.equal(Object.isFrozen(healthOptions), true);
  assert.deepEqual(Object.keys(healthOptions).sort(), [
    "getInstallPrerequisite",
    "onFeedCaptured",
    "onNativeControlActivityChanged",
    "prepareForInstall",
    "requestBackgroundCheck",
    "requestInstall",
    "requestManualCheck",
    "suppressNativeSideEffects",
  ]);
  assert.equal(healthOptions.suppressNativeSideEffects, true);
  assert.equal("fetch" in healthOptions, false);

  const bridge = new CodexSparkleBridge({
    ...healthOptions,
    fetch: async (url) => {
      networkCalls.push(url);
      throw new Error("health probe attempted a network request");
    },
  });
  bridge.wrapExports(addon);
  const initResult = addon.init?.(
    "https://updates.example.test/private.xml",
    { Authorization: "Bearer ephemeral" },
    "https://updates.example.test/public.xml",
  );

  addon.setAutomaticallyChecksForUpdates?.(true);
  addon.setUpdateCheckInterval?.(3_600);
  addon.scheduleNextUpdateCheck?.();
  addon.resetUpdateCycle?.();
  addon.setUpdateLifecycleStateSink?.(() => { downstreamCalls.push("lifecycle"); });
  addon.setDownloadProgressSink?.(() => { downstreamCalls.push("download"); });
  addon.setInstallProgressSink?.(() => { downstreamCalls.push("install"); });
  addon.setUpdateReadySink?.(() => { downstreamCalls.push("ready"); });

  assert.equal(initResult, undefined);
  assert.equal(addon.checkForUpdates?.(), false);
  assert.equal(addon.checkForUpdatesInBackground?.(), false);
  assert.equal(addon.installLatestUpdate?.(), false);
  assert.equal(addon.installUpdatesIfAvailable?.(), false);
  assert.equal(await bridge.installUpdate(), false);

  assert.deepEqual(rawCalls, []);
  assert.deepEqual(downstreamCalls, []);
  assert.deepEqual(networkCalls, []);
  assert.equal(addon.automaticallyChecksForUpdates, false);
  assert.equal(addon.updateCheckInterval, 0);
  const snapshot = bridge.getSnapshot();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.feedUrl, null);
  assert.equal(snapshot.fallbackFeedUrl, null);
  assert.equal((bridge as unknown as { headers?: unknown }).headers, undefined);
  assert.equal(bridge.getSnapshot().canInstall, false);
  assert.equal(
    bridge.getSnapshot().installPrerequisiteFailure,
    "The native updater is unavailable.",
  );
});

test("safe metadata drives OpenAI's ready control and redirects its install click", async () => {
  const { addon, calls, sinks } = fakeAddon();
  const rendered: Array<[string, unknown]> = [];
  const installs: string[] = [];
  const bridge = new CodexSparkleBridge({
    requestInstall: () => { installs.push("durable-install"); },
    getInstallPrerequisite: () => ({ ok: true }),
  });
  bridge.wrapExports(addon);
  addon.init?.("https://updates.example.test/feed.xml");
  addon.setUpdateLifecycleStateSink?.((value) => rendered.push(["lifecycle", value]));
  addon.setUpdateReadySink?.((value) => rendered.push(["ready", value]));

  bridge.setSafeUpdateAvailable(true);
  assert.equal(bridge.nativeUpdateControlActive(), true);
  assert.equal(bridge.getSnapshot().lifecycle, "ready");
  assert.equal(bridge.getSnapshot().canInstall, true);
  assert.deepEqual(rendered.slice(-2), [["ready", true], ["lifecycle", "ready"]]);

  assert.equal(await bridge.installUpdate(), true);
  assert.deepEqual(installs, ["durable-install"]);
  assert.doesNotMatch(calls.join("\n"), /install-latest/);
  assert.deepEqual(rendered.slice(-2), [["ready", false], ["lifecycle", "installing"]]);

  // Native sink traffic remains safe and observable after the synthetic state.
  sinks.lifecycle("idle");
  assert.equal(rendered.at(-1)?.[1], "idle");
});

test("matches OpenAI 26.707 startup timer and menu call topology", () => {
  const nativeCalls: string[] = [];
  const presentedChecks: string[] = [];
  const backgroundChecks: string[] = [];
  const addon: SparkleNativeExports = {
    init: () => { nativeCalls.push("init"); },
    checkForUpdates: () => { nativeCalls.push("native-manual"); },
    checkForUpdatesInBackground: () => { nativeCalls.push("native-background"); },
  };
  const bridge = new CodexSparkleBridge({
    requestManualCheck: () => { presentedChecks.push("presented"); },
    requestBackgroundCheck: () => { backgroundChecks.push("background"); },
  });
  bridge.wrapExports(addon);

  // OpenAI 26.707's initializeMacSparkle calls this closure once during
  // startup and later from its JS interval. Neither call may open a dialog.
  const openAiBackgroundCheck = () => addon.checkForUpdatesInBackground?.();
  addon.init?.("https://updates.example.test/feed.xml");
  openAiBackgroundCheck();
  openAiBackgroundCheck();

  // The application-menu handler reaches the distinct foreground method.
  const openAiMenuCheck = () => addon.checkForUpdates?.();
  const menuResult = openAiMenuCheck();

  assert.deepEqual(nativeCalls, ["init"]);
  assert.deepEqual(presentedChecks, ["presented"]);
  assert.deepEqual(backgroundChecks, ["background", "background"]);
  assert.equal(menuResult, false);
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
    ${signedEnclosure("240", "2.4.0")}
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

test("publishes only redacted feed capture after native init succeeds", () => {
  const captures: unknown[] = [];
  const bridge = new CodexSparkleBridge({ onFeedCaptured: (capture) => captures.push(capture) });
  const addon: SparkleNativeExports = { init: () => {} };
  bridge.wrapExports(addon);
  addon.init?.(
    "https://beta.example.test/appcast.xml?token=secret#fragment",
    { Authorization: "Bearer private" },
    "https://beta.example.test/public.xml?tracking=1",
  );

  assert.deepEqual(captures, [{
    feedUrl: "https://beta.example.test/appcast.xml",
    fallbackFeedUrl: "https://beta.example.test/public.xml",
  }]);
  assert.doesNotMatch(JSON.stringify(captures), /secret|private|token|tracking|Authorization/);

  const failedCaptures: unknown[] = [];
  const failedBridge = new CodexSparkleBridge({ onFeedCaptured: (capture) => failedCaptures.push(capture) });
  const failedAddon: SparkleNativeExports = { init: () => { throw new Error("init failed"); } };
  failedBridge.wrapExports(failedAddon);
  assert.throws(() => failedAddon.init?.("https://beta.example.test/appcast.xml"), /init failed/);
  assert.deepEqual(failedCaptures, []);

  const observerFailureBridge = new CodexSparkleBridge({
    onFeedCaptured: () => { throw new Error("storage unavailable"); },
  });
  const observerFailureAddon: SparkleNativeExports = { init: () => "initialized" };
  observerFailureBridge.wrapExports(observerFailureAddon);
  assert.equal(observerFailureAddon.init?.("https://beta.example.test/appcast.xml"), "initialized");
  assert.equal(observerFailureBridge.getSnapshot().available, true);
});

test("profile appcast checks use ephemeral matching headers without Stable fallback or stale sharing", async () => {
  const requests: Array<{ url: string; headers: unknown }> = [];
  let failAlpha = false;
  const bridge = new CodexSparkleBridge({
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers });
      if (failAlpha) throw new Error("offline");
      return response(url, `<rss><channel><item>${signedEnclosure("901", "9.0.1-alpha")}</item></channel></rss>`);
    },
  });
  const addon: SparkleNativeExports = { init: () => {} };
  bridge.wrapExports(addon);
  addon.init?.("https://beta.example.test/appcast.xml?token=ephemeral", { Authorization: "Bearer private" });

  const alpha = await bridge.fetchProfileAppcastMetadata({
    identityKey: "verified-alpha-a",
    feedUrl: "https://beta.example.test/appcast.xml",
  });
  assert.equal(alpha.feedUrl, "https://beta.example.test/appcast.xml");
  assert.equal((requests[0]?.headers as Record<string, string>).Authorization, "Bearer private");
  assert.doesNotMatch(JSON.stringify(alpha), /ephemeral|private|Authorization/);

  failAlpha = true;
  const otherIdentity = await bridge.fetchProfileAppcastMetadata({
    identityKey: "verified-alpha-b",
    feedUrl: "https://other-beta.example.test/appcast.xml",
  });
  assert.equal(otherIdentity.marketingVersion, "Unavailable");
  assert.equal(otherIdentity.stale, false);
  assert.match(otherIdentity.error ?? "", /captured profile feed: request failed/);
  assert.doesNotMatch(otherIdentity.error ?? "", /public production feed/);
});

test("appcast metadata rejects unsigned, malformed-signature, and non-HTTPS archive items", async () => {
  for (const enclosure of [
    '<enclosure url="https://updates.example.test/u.zip" sparkle:version="1" sparkle:shortVersionString="1.0.0" />',
    '<enclosure url="https://updates.example.test/u.zip" sparkle:edSignature="not-a-signature" sparkle:version="1" sparkle:shortVersionString="1.0.0" />',
    `<enclosure url="http://updates.example.test/u.zip" sparkle:edSignature="${VALID_SPARKLE_SIGNATURE}" sparkle:version="1" sparkle:shortVersionString="1.0.0" />`,
  ]) {
    const bridge = new CodexSparkleBridge({
      fetch: async (url) => response(url, `<rss><channel><item>${enclosure}</item></channel></rss>`),
    });
    const addon: SparkleNativeExports = { init: () => {} };
    bridge.wrapExports(addon);
    addon.init?.("https://updates.example.test/feed.xml");
    const result = await bridge.fetchAppcastMetadata();
    assert.equal(result.marketingVersion, "Unavailable");
    assert.match(result.error ?? "", /captured feed: invalid signed appcast/);
    assert.match(result.error ?? "", /public production feed: invalid signed appcast/);
  }
});

test("appcast redirects retain private headers only on the same origin", async () => {
  const authorization = { Authorization: "Bearer private" };
  const requests: Array<{ url: string; headers: unknown }> = [];
  const bridge = new CodexSparkleBridge({
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers });
      return url.endsWith("/start.xml")
        ? response(url, "", { location: "/same-origin.xml" }, 302)
        : response(url, `<rss><channel><item>${signedEnclosure("9", "1.9.0")}</item></channel></rss>`);
    },
  });
  const addon: SparkleNativeExports = { init: () => {} };
  bridge.wrapExports(addon);
  addon.init?.("https://updates.example.test/start.xml", authorization);

  assert.equal((await bridge.fetchAppcastMetadata()).marketingVersion, "1.9.0");
  assert.deepEqual(requests, [
    { url: "https://updates.example.test/start.xml", headers: authorization },
    { url: "https://updates.example.test/same-origin.xml", headers: authorization },
  ]);
});

test("appcast redirects permanently strip private headers after crossing origins", async () => {
  const authorization = { Authorization: "Bearer private" };
  const requests: Array<{ url: string; headers: unknown }> = [];
  const bridge = new CodexSparkleBridge({
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers });
      if (url.endsWith("/start.xml")) {
        return response(url, "", { location: "https://cdn.example.test/feed.xml" }, 302);
      }
      if (url === "https://cdn.example.test/feed.xml") {
        return response(url, "", { location: "https://updates.example.test/final.xml" }, 302);
      }
      return response(url, `<rss><channel><item>${signedEnclosure("10", "2.0.0")}</item></channel></rss>`);
    },
  });
  const addon: SparkleNativeExports = { init: () => {} };
  bridge.wrapExports(addon);
  addon.init?.("https://updates.example.test/start.xml", authorization);

  assert.equal((await bridge.fetchAppcastMetadata()).marketingVersion, "2.0.0");
  assert.deepEqual(requests, [
    { url: "https://updates.example.test/start.xml", headers: authorization },
    { url: "https://cdn.example.test/feed.xml", headers: undefined },
    { url: "https://updates.example.test/final.xml", headers: undefined },
  ]);
});

test("appcast falls back without private headers after malformed, oversized, or failed primary feed", async () => {
  for (const primary of ["malformed", "oversized", "failed"] as const) {
    const requests: Array<{ url: string; headers: unknown }> = [];
    const bridge = new CodexSparkleBridge({
      maxAppcastBytes: 500,
      fetch: async (url, init) => {
        requests.push({ url, headers: init.headers });
        if (url.includes("internal")) {
          if (primary === "failed") throw new Error("Bearer private");
          if (primary === "oversized") return response(url, "x".repeat(600), { "content-length": "600" });
          return response(url, "<rss><broken>");
        }
        return response(url, `<rss><channel><item><link>https://updates.example.test/r</link>${signedEnclosure("7", "1.7.0")}</item></channel></rss>`);
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
      : response(url, `<rss><channel><item><link>https://updates.example.test/r</link>${signedEnclosure("8", "1.8.0")}</item></channel></rss>`),
  });
  const addon: SparkleNativeExports = { init: () => {} };
  bridge.wrapExports(addon);
  addon.init?.("https://updates.example.test/feed.xml");
  assert.equal((await bridge.fetchAppcastMetadata()).stale, false);

  mode = "redirect";
  const stale = await bridge.fetchAppcastMetadata();
  assert.equal(stale.stale, true);
  assert.equal(stale.marketingVersion, "1.8.0");
  assert.match(stale.error ?? "", /captured feed: insecure redirect rejected/);
  assert.match(stale.error ?? "", /public production feed: insecure redirect rejected/);
});

test("uses the public production appcast when native init was never observed", async () => {
  const requests: Array<{ url: string; headers: unknown }> = [];
  const bridge = new CodexSparkleBridge({
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers });
      return response(url, `<rss><channel><item>${signedEnclosure("42", "4.2.0")}</item></channel></rss>`);
    },
  });

  const metadata = await bridge.fetchAppcastMetadata();

  assert.equal(metadata.marketingVersion, "4.2.0");
  assert.equal(metadata.feedUrl, "https://persistent.oaistatic.com/codex-app-prod/appcast.xml");
  assert.deepEqual(requests, [{
    url: "https://persistent.oaistatic.com/codex-app-prod/appcast.xml",
    headers: undefined,
  }]);
});

test("clears a prior bridge error after a later appcast succeeds", async () => {
  let succeeds = false;
  const bridge = new CodexSparkleBridge({
    fetch: async (url) => {
      if (!succeeds) throw new Error("secret transport detail");
      return response(url, `<rss><channel><item>${signedEnclosure("50", "5.0.0")}</item></channel></rss>`);
    },
  });

  const failed = await bridge.fetchAppcastMetadata();
  assert.match(failed.error ?? "", /public production feed: request failed/);
  assert.match(bridge.getSnapshot().lastError ?? "", /public production feed: request failed/);
  assert.doesNotMatch(failed.error ?? "", /secret/);

  succeeds = true;
  assert.equal((await bridge.fetchAppcastMetadata()).marketingVersion, "5.0.0");
  assert.equal(bridge.getSnapshot().lastError, null);
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
