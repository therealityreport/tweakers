export type SparkleLifecycleState =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "installing"
  | "failed";

export interface SparkleBridgeSnapshot {
  available: boolean;
  lifecycle: SparkleLifecycleState;
  downloadProgressPercent: number | null;
  installProgressPercent: number | null;
  ready: boolean;
  lastError: string | null;
  feedUrl: string | null;
  fallbackFeedUrl: string | null;
  canInstall: boolean;
  installPrerequisiteFailure: string | null;
}

export interface SparkleNativeExports {
  default?: unknown;
  init?: (...args: unknown[]) => unknown;
  checkForUpdates?: (...args: unknown[]) => unknown;
  checkForUpdatesInBackground?: (...args: unknown[]) => unknown;
  automaticallyChecksForUpdates?: boolean;
  updateCheckInterval?: number;
  setAutomaticallyChecksForUpdates?: (value: boolean) => unknown;
  setUpdateCheckInterval?: (seconds: number) => unknown;
  scheduleNextUpdateCheck?: (...args: unknown[]) => unknown;
  resetUpdateCycle?: (...args: unknown[]) => unknown;
  installLatestUpdate?: (...args: unknown[]) => unknown;
  installUpdatesIfAvailable?: (...args: unknown[]) => unknown;
  setUpdateLifecycleStateSink?: (sink: (...args: unknown[]) => void) => unknown;
  setDownloadProgressSink?: (sink: (...args: unknown[]) => void) => unknown;
  setInstallProgressSink?: (sink: (...args: unknown[]) => void) => unknown;
  setUpdateReadySink?: (sink: (...args: unknown[]) => void) => unknown;
  [key: string]: unknown;
}

export interface SparkleInstallPrerequisite {
  ok: boolean;
  reason?: string;
}

export interface SparkleAppcastMetadata {
  marketingVersion: string;
  build: string;
  releaseUrl: string | null;
  feedUrl: string;
  checkedAt: string;
  stale: boolean;
  error: string | null;
}

export interface SparkleFeedCapture {
  feedUrl: string | null;
  fallbackFeedUrl: string | null;
}

export interface SparkleProfileFeed {
  /** Stable key derived from the verified application identity/profile. */
  identityKey: string;
  feedUrl: string;
  fallbackFeedUrl?: string | null;
}

export interface SparkleFetchResponse {
  url: string;
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer | Uint8Array>;
}

export type SparkleFetch = (
  url: string,
  init: { headers?: unknown; signal: AbortSignal; redirect: "manual" },
) => Promise<SparkleFetchResponse>;

export interface CodexSparkleBridgeOptions {
  /** Health-only: wrap native updater exports without entering native code. */
  suppressNativeSideEffects?: boolean;
  /** Runs the bounded Tweakers-owned manual update check without invoking raw Sparkle/XPC. */
  requestManualCheck?: () => void | Promise<void>;
  /** Runs the bounded metadata-only check used by OpenAI's startup/interval timer. */
  requestBackgroundCheck?: () => void | Promise<void>;
  /** Starts Tweakers' durable desktop-update transaction from OpenAI's native Update control. */
  requestInstall?: () => void | Promise<void>;
  /** Restores the verified pristine app and enters update mode immediately before Sparkle installs. */
  prepareForInstall?: () => void | boolean;
  /** Rechecks signed-backup continuity without mutating the live app. */
  /** Return null when actionable, a safe reason string when blocked, or an explicit result. */
  getInstallPrerequisite?: () => SparkleInstallPrerequisite | string | null;
  fetch?: SparkleFetch;
  now?: () => Date;
  appcastTimeoutMs?: number;
  maxAppcastBytes?: number;
  maxAppcastRedirects?: number;
  onNativeControlActivityChanged?: (active: boolean) => void;
  /** Receives only redacted HTTPS URLs after OpenAI's native init succeeds. */
  onFeedCaptured?: (capture: SparkleFeedCapture) => void;
}

const HEALTH_PROBE_UPDATE_DISABLED_REASON = "Desktop updates are disabled during health probes.";

/**
 * Keeps OpenAI's native updater entry points wrapped but observational during
 * one-shot health execution. No returned callback reaches networking, UI,
 * persistence, app replacement, or signed-app preparation.
 */
export function createHealthProbeCodexSparkleBridgeOptions(): CodexSparkleBridgeOptions {
  return Object.freeze({
    suppressNativeSideEffects: true,
    requestManualCheck: () => undefined,
    requestBackgroundCheck: () => undefined,
    requestInstall: () => undefined,
    prepareForInstall: () => false,
    getInstallPrerequisite: () => ({
      ok: false,
      reason: HEALTH_PROBE_UPDATE_DISABLED_REASON,
    }),
    onFeedCaptured: () => undefined,
    onNativeControlActivityChanged: () => undefined,
  });
}

const SAFE_LIFECYCLE = new Set<SparkleLifecycleState>([
  "idle",
  "checking",
  "downloading",
  "ready",
  "installing",
  "failed",
]);

export const CODEX_PUBLIC_PRODUCTION_APPCAST = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";

interface AppcastFeedCandidate {
  label: string;
  url: string;
  metadataUrl?: string;
  headers: unknown;
}

/**
 * A narrow observer/action seam around OpenAI's native Sparkle addon.
 *
 * OpenAI continues to own initialization and its callbacks. The bridge only
 * tees the native sinks, retains authorization headers in this object, and
 * exposes a redacted snapshot to the rest of Tweakers.
 */
export class CodexSparkleBridge {
  private options: CodexSparkleBridgeOptions;
  private readonly wrapped = new WeakSet<object>();
  private native: SparkleNativeExports | null = null;
  private headers: unknown = undefined;
  private readonly lastAppcasts = new Map<string, SparkleAppcastMetadata>();
  private nativeChecksSuppressed = false;
  private nativeSchedulerDisabled = false;
  private safeUpdateAvailable = false;
  private readonly downstreamSinks: Partial<Record<
    "setUpdateLifecycleStateSink" | "setDownloadProgressSink" | "setInstallProgressSink" | "setUpdateReadySink",
    (...args: unknown[]) => void
  >> = {};
  private state: SparkleBridgeSnapshot = {
    available: false,
    lifecycle: "idle",
    downloadProgressPercent: null,
    installProgressPercent: null,
    ready: false,
    lastError: null,
    feedUrl: null,
    fallbackFeedUrl: null,
    canInstall: false,
    installPrerequisiteFailure: "The native updater is unavailable.",
  };

  constructor(options: CodexSparkleBridgeOptions = {}) {
    this.options = options;
  }

  configure(options: CodexSparkleBridgeOptions): void {
    this.options = options;
    this.refreshActionability();
  }

  wrapExports(loaded: unknown): void {
    if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function")) return;
    const object = loaded as object;
    if (this.wrapped.has(object)) return;
    this.wrapped.add(object);

    const addon = loaded as SparkleNativeExports;
    this.native = addon;
    this.suppressNativeChecks(addon);
    this.disableNativeScheduler(addon);
    this.wrapInit(addon);
    this.wrapSink(addon, "setUpdateLifecycleStateSink", (value) => this.observeLifecycle(value));
    this.wrapSink(addon, "setDownloadProgressSink", (value) => {
      this.state.downloadProgressPercent = safePercent(value);
    });
    this.wrapSink(addon, "setInstallProgressSink", (value) => {
      this.state.installProgressPercent = safePercent(value);
      if (this.state.installProgressPercent !== null) this.state.lifecycle = "installing";
    });
    this.wrapSink(addon, "setUpdateReadySink", (value) => {
      this.state.ready = value === true;
      if (this.state.ready) this.state.lifecycle = "ready";
      else if (this.state.lifecycle === "ready") this.state.lifecycle = "idle";
      this.refreshActionability();
    });
    this.wrapInstall(addon, "installLatestUpdate");
    this.wrapInstall(addon, "installUpdatesIfAvailable");
    // Loading the addon is not sufficient: OpenAI's init must succeed before
    // checks or installs are actionable.
    this.state.available = false;
    this.refreshActionability();

    if (addon.default && addon.default !== loaded) this.wrapExports(addon.default);
  }

  getSnapshot(): SparkleBridgeSnapshot {
    this.refreshActionability();
    return { ...this.state };
  }

  nativeUpdateControlActive(): boolean {
    return this.safeUpdateAvailable && typeof this.downstreamSinks.setUpdateReadySink === "function";
  }

  /**
   * Reuses OpenAI's own animated update control for a release discovered by
   * Tweakers' metadata-only checker. Its install action is redirected to the
   * durable environment transaction, never to raw Sparkle in the patched app.
   */
  setSafeUpdateAvailable(available: boolean): void {
    this.safeUpdateAvailable = available;
    this.state.ready = available;
    if (available) {
      this.state.lifecycle = "ready";
      this.emitDownstream("setUpdateReadySink", true);
      this.emitDownstream("setUpdateLifecycleStateSink", "ready");
    } else {
      if (this.state.lifecycle === "ready") this.state.lifecycle = "idle";
      this.emitDownstream("setUpdateReadySink", false);
      this.emitDownstream("setUpdateLifecycleStateSink", this.state.lifecycle);
    }
    this.refreshActionability();
  }

  async installUpdate(): Promise<boolean> {
    this.refreshActionability();
    if (!this.state.canInstall || !this.native) return false;
    const fn = this.native.installLatestUpdate ?? this.native.installUpdatesIfAvailable;
    if (typeof fn !== "function") return false;
    try {
      const result = await Reflect.apply(fn, this.native, []);
      return result !== false;
    } catch {
      this.state.lifecycle = this.state.ready ? "ready" : "idle";
      this.fail("Native updater install failed.");
      return false;
    }
  }

  /**
   * Read display-only release metadata from the feed OpenAI supplied to
   * Sparkle. Authorization headers never leave this method or enter its result.
   */
  async fetchAppcastMetadata(): Promise<SparkleAppcastMetadata> {
    const candidates = [
      this.state.feedUrl ? { label: "captured feed", url: this.state.feedUrl, headers: this.headers } : null,
      this.state.fallbackFeedUrl && this.state.fallbackFeedUrl !== this.state.feedUrl
        ? { label: "captured fallback feed", url: this.state.fallbackFeedUrl, headers: undefined }
        : null,
      { label: "public production feed", url: CODEX_PUBLIC_PRODUCTION_APPCAST, headers: undefined },
    ].filter((entry): entry is { label: string; url: string; headers: unknown } => entry !== null);
    const feeds = candidates.filter((feed, index) => (
      candidates.findIndex((candidate) => candidate?.url === feed.url) === index
    ));
    return this.fetchAppcastCandidates("stable", feeds, CODEX_PUBLIC_PRODUCTION_APPCAST);
  }

  /**
   * Fetch metadata only from a feed captured for one verified app identity.
   * There is deliberately no production fallback here: Alpha must never read
   * Stable metadata, even when its captured feed is unavailable.
   */
  async fetchProfileAppcastMetadata(profileFeed: SparkleProfileFeed): Promise<SparkleAppcastMetadata> {
    const feedUrl = requirePersistableHttpsUrl(profileFeed.feedUrl);
    const fallbackFeedUrl = profileFeed.fallbackFeedUrl
      ? requirePersistableHttpsUrl(profileFeed.fallbackFeedUrl)
      : null;
    const livePrimary = this.state.feedUrl
      && persistableHttpsUrl(this.state.feedUrl) === feedUrl
      ? this.state.feedUrl
      : feedUrl;
    const liveFallback = fallbackFeedUrl && this.state.fallbackFeedUrl
      && persistableHttpsUrl(this.state.fallbackFeedUrl) === fallbackFeedUrl
      ? this.state.fallbackFeedUrl
      : fallbackFeedUrl;
    const candidates: AppcastFeedCandidate[] = [{
      label: "captured profile feed",
      url: livePrimary,
      metadataUrl: feedUrl,
      headers: livePrimary === this.state.feedUrl ? this.headers : undefined,
    }];
    if (liveFallback && liveFallback !== livePrimary) {
      candidates.push({
        label: "captured profile fallback feed",
        url: liveFallback,
        metadataUrl: fallbackFeedUrl!,
        headers: undefined,
      });
    }
    return this.fetchAppcastCandidates(`profile:${profileFeed.identityKey}`, candidates, feedUrl);
  }

  private async fetchAppcastCandidates(
    cacheKey: string,
    feeds: AppcastFeedCandidate[],
    unavailableFeedUrl: string,
  ): Promise<SparkleAppcastMetadata> {
    const failures: string[] = [];

    for (const feed of feeds) {
      try {
        const xml = await this.fetchBoundedAppcast(feed.url, feed.headers);
        const parsed = parseAppcast(xml);
        const metadata: SparkleAppcastMetadata = {
          ...parsed,
          feedUrl: feed.metadataUrl ?? feed.url,
          checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
          stale: false,
          error: null,
        };
        this.lastAppcasts.set(cacheKey, metadata);
        this.state.lastError = null;
        return { ...metadata };
      } catch (error) {
        failures.push(`${feed.label}: ${redactedAppcastFailure(error)}`);
      }
    }

    const failure = `Appcast metadata is unavailable (${failures.join("; ")}).`;
    this.fail(failure);

    const lastAppcast = this.lastAppcasts.get(cacheKey);
    if (lastAppcast) {
      return { ...lastAppcast, stale: true, error: failure };
    }
    return {
      marketingVersion: "Unavailable",
      build: "Unavailable",
      releaseUrl: null,
      feedUrl: unavailableFeedUrl,
      checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
      stale: false,
      error: failure,
    };
  }

  private wrapInit(addon: SparkleNativeExports): void {
    const original = addon.init;
    if (typeof original !== "function") return;
    const bridge = this;
    addon.init = function tweakerSparkleInit(this: unknown, ...args: unknown[]) {
      if (bridge.options.suppressNativeSideEffects) {
        bridge.headers = undefined;
        bridge.state.available = false;
        bridge.state.lifecycle = "idle";
        bridge.state.downloadProgressPercent = null;
        bridge.state.installProgressPercent = null;
        bridge.state.ready = false;
        bridge.state.feedUrl = null;
        bridge.state.fallbackFeedUrl = null;
        bridge.state.lastError = null;
        bridge.refreshActionability();
        return undefined;
      }
      bridge.captureInit(args);
      try {
        const result = Reflect.apply(original, this, args);
        bridge.state.available = true;
        bridge.state.lastError = null;
        bridge.refreshActionability();
        const capture = bridge.capturedFeedForPersistence();
        if (capture.feedUrl) {
          try {
            bridge.options.onFeedCaptured?.(capture);
          } catch {
            // Persistence is observational and must never break OpenAI's
            // successful native updater initialization.
          }
        }
        return result;
      } catch (error) {
        bridge.state.available = false;
        bridge.headers = undefined;
        bridge.fail("Native updater initialization failed.");
        throw error;
      }
    };
  }

  /**
   * Sparkle's XPC bootstrap assumes the outer app still has OpenAI's signing
   * identity. In a locally signed Tweakers app, raw checks relaunch the
   * foreground ChatGPT executable while looking for that service. Redirect the
   * visible manual command and OpenAI's background timer to Tweakers' bounded
   * services while keeping raw native checks inert.
   */
  private suppressNativeChecks(addon: SparkleNativeExports): void {
    if (typeof addon.checkForUpdates === "function") {
      const bridge = this;
      addon.checkForUpdates = function tweakerManualUpdateCheck() {
        try {
          const result = bridge.options.requestManualCheck?.();
          if (result && typeof (result as PromiseLike<void>).then === "function") {
            void Promise.resolve(result).catch(() => {
              bridge.fail("Manual desktop update check failed.");
            });
          }
        } catch {
          bridge.fail("Manual desktop update check failed.");
        }
        return false;
      };
      this.nativeChecksSuppressed = true;
    }
    if (typeof addon.checkForUpdatesInBackground === "function") {
      const bridge = this;
      addon.checkForUpdatesInBackground = function tweakerBackgroundUpdateCheck() {
        try {
          const result = bridge.options.requestBackgroundCheck?.();
          if (result && typeof (result as PromiseLike<void>).then === "function") {
            void Promise.resolve(result).catch(() => {
              bridge.fail("Background desktop update check failed.");
            });
          }
        } catch {
          bridge.fail("Background desktop update check failed.");
        }
        return false;
      };
      this.nativeChecksSuppressed = true;
    }
  }

  private disableNativeScheduler(addon: SparkleNativeExports): void {
    if (this.options.suppressNativeSideEffects) {
      let acted = false;
      for (const name of [
        "setAutomaticallyChecksForUpdates",
        "setUpdateCheckInterval",
        "scheduleNextUpdateCheck",
        "resetUpdateCycle",
      ] as const) {
        try {
          if (typeof addon[name] !== "function") continue;
          addon[name] = function tweakerInertHealthScheduler() { return undefined; };
          acted = true;
        } catch {
          // A missing optional seam remains harmless because native init and
          // both native check methods are also inert in health mode.
        }
      }
      for (const [name, value] of [
        ["automaticallyChecksForUpdates", false],
        ["updateCheckInterval", 0],
      ] as const) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(addon, name);
          if (!descriptor || descriptor.configurable) {
            Object.defineProperty(addon, name, {
              configurable: true,
              enumerable: descriptor?.enumerable ?? true,
              get: () => value,
              set: () => undefined,
            });
            acted = true;
          } else if ("value" in descriptor && descriptor.writable) {
            (addon as Record<string, unknown>)[name] = value;
            acted = true;
          }
        } catch {
          // Never invoke a native accessor merely to adjust optional health
          // metadata. Check and init entry points remain independently inert.
        }
      }
      this.nativeSchedulerDisabled ||= acted;
      return;
    }

    let acted = false;

    try {
      if (typeof addon.setAutomaticallyChecksForUpdates === "function") {
        Reflect.apply(addon.setAutomaticallyChecksForUpdates, addon, [false]);
        acted = true;
      } else if (
        "automaticallyChecksForUpdates" in addon
        && addon.automaticallyChecksForUpdates !== false
      ) {
        addon.automaticallyChecksForUpdates = false;
        acted = true;
      }
    } catch {
      // Optional native scheduler seams are best-effort across app versions.
    }

    try {
      if (typeof addon.setUpdateCheckInterval === "function") {
        Reflect.apply(addon.setUpdateCheckInterval, addon, [0]);
        acted = true;
      } else if ("updateCheckInterval" in addon) {
        addon.updateCheckInterval = 0;
        acted = true;
      }
    } catch {
      // Optional native scheduler seams are best-effort across app versions.
    }

    for (const name of ["scheduleNextUpdateCheck", "resetUpdateCycle"] as const) {
      try {
        if (typeof addon[name] !== "function") continue;
        addon[name] = function tweakerSuppressedSparkleSchedule() { return undefined; };
        acted = true;
      } catch {
        // Optional native scheduler seams are best-effort across app versions.
      }
    }

    this.nativeSchedulerDisabled ||= acted;
  }

  private wrapSink(
    addon: SparkleNativeExports,
    name: "setUpdateLifecycleStateSink" | "setDownloadProgressSink" | "setInstallProgressSink" | "setUpdateReadySink",
    observe: (value: unknown) => void,
  ): void {
    const original = addon[name];
    if (typeof original !== "function") return;
    if (this.options.suppressNativeSideEffects) {
      addon[name] = function tweakerInertHealthSinkSetter() { return undefined; };
      return;
    }
    const bridge = this;
    addon[name] = function tweakerSparkleSinkSetter(this: unknown, sink: unknown) {
      const wasActive = bridge.nativeUpdateControlActive();
      if (typeof sink === "function") bridge.downstreamSinks[name] = sink as (...args: unknown[]) => void;
      else delete bridge.downstreamSinks[name];
      const tee = (...args: unknown[]) => {
        observe(args[0]);
        if (typeof sink === "function") Reflect.apply(sink, undefined, args);
      };
      const result = Reflect.apply(original, this, [tee]);
      if (bridge.safeUpdateAvailable) bridge.replaySafeUpdateToSink(name);
      if (name === "setUpdateReadySink") {
        const isActive = bridge.nativeUpdateControlActive();
        if (isActive !== wasActive) bridge.options.onNativeControlActivityChanged?.(isActive);
      }
      return result;
    };
  }

  private wrapInstall(
    addon: SparkleNativeExports,
    name: "installLatestUpdate" | "installUpdatesIfAvailable",
  ): void {
    const original = addon[name];
    if (typeof original !== "function") return;
    const bridge = this;
    addon[name] = function tweakerSparkleInstall(this: unknown, ...args: unknown[]) {
      const prerequisite = bridge.installPrerequisite();
      if (!prerequisite.ok) {
        bridge.refreshActionability();
        return false;
      }
      if (bridge.safeUpdateAvailable && bridge.options.requestInstall) {
        bridge.safeUpdateAvailable = false;
        bridge.state.lifecycle = "installing";
        bridge.state.ready = false;
        bridge.state.lastError = null;
        bridge.emitDownstream("setUpdateReadySink", false);
        bridge.emitDownstream("setUpdateLifecycleStateSink", "installing");
        try {
          const requested = bridge.options.requestInstall();
          if (requested && typeof (requested as PromiseLike<void>).then === "function") {
            void Promise.resolve(requested).catch(() => bridge.restoreSafeUpdateAfterInstallFailure());
          }
          return true;
        } catch {
          bridge.restoreSafeUpdateAfterInstallFailure();
          return false;
        }
      }
      try {
        if (bridge.options.prepareForInstall?.() === false) {
          bridge.fail("Signed Codex.app backup preparation failed.");
          return false;
        }
        bridge.state.lifecycle = "installing";
        bridge.state.lastError = null;
        return Reflect.apply(original, this, args);
      } catch {
        bridge.state.lifecycle = bridge.state.ready ? "ready" : "idle";
        bridge.fail("Signed Codex.app backup preparation failed.");
        return false;
      }
    };
  }

  private replaySafeUpdateToSink(
    name: "setUpdateLifecycleStateSink" | "setDownloadProgressSink" | "setInstallProgressSink" | "setUpdateReadySink",
  ): void {
    if (name === "setUpdateReadySink") this.emitDownstream(name, true);
    if (name === "setUpdateLifecycleStateSink") this.emitDownstream(name, "ready");
  }

  private emitDownstream(
    name: "setUpdateLifecycleStateSink" | "setDownloadProgressSink" | "setInstallProgressSink" | "setUpdateReadySink",
    value: unknown,
  ): void {
    const sink = this.downstreamSinks[name];
    if (typeof sink !== "function") return;
    try {
      Reflect.apply(sink, undefined, [value]);
    } catch {
      // OpenAI owns these display callbacks; a renderer teardown must not
      // interfere with updater state or the durable transaction.
    }
  }

  private restoreSafeUpdateAfterInstallFailure(): void {
    this.state.lastError = "Desktop update handoff failed.";
    this.setSafeUpdateAvailable(true);
  }

  private captureInit(args: unknown[]): void {
    this.state.feedUrl = safeHttpsUrl(args[0]);
    this.headers = args.length >= 2 ? args[1] : undefined;
    this.state.fallbackFeedUrl = safeHttpsUrl(args[2]);
  }

  private capturedFeedForPersistence(): SparkleFeedCapture {
    return {
      feedUrl: persistableHttpsUrl(this.state.feedUrl),
      fallbackFeedUrl: persistableHttpsUrl(this.state.fallbackFeedUrl),
    };
  }

  private async fetchBoundedAppcast(initialUrl: string, headers: unknown): Promise<string> {
    const fetcher = this.options.fetch ?? defaultSparkleFetch;
    const timeoutMs = boundedInteger(this.options.appcastTimeoutMs, 5_000, 250, 30_000);
    const maxBytes = boundedInteger(this.options.maxAppcastBytes, 1_048_576, 1, 4_194_304);
    const maxRedirects = boundedInteger(this.options.maxAppcastRedirects, 4, 0, 8);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("appcast timeout"));
      }, timeoutMs);
    });
    try {
      let url = requireHttpsUrl(initialUrl);
      let requestHeaders = headers;
      for (let redirects = 0; ; redirects += 1) {
        const response = await Promise.race([
          fetcher(url, { headers: requestHeaders, signal: controller.signal, redirect: "manual" }),
          deadline,
        ]);
        requireHttpsUrl(response.url || url);
        if (isRedirectStatus(response.status)) {
          if (redirects >= maxRedirects) throw new Error("too many redirects");
          const location = response.headers.get("location");
          if (!location) throw new Error("redirect missing location");
          const nextUrl = requireHttpsUrl(new URL(location, url).toString());
          if (new URL(nextUrl).origin !== new URL(url).origin) requestHeaders = undefined;
          url = nextUrl;
          continue;
        }
        if (!response.ok) throw new Error("appcast request failed");
        const announced = Number(response.headers.get("content-length"));
        if (Number.isFinite(announced) && announced > maxBytes) throw new Error("appcast too large");
        const body = await Promise.race([response.arrayBuffer(), deadline]);
        const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
        if (bytes.byteLength > maxBytes) throw new Error("appcast too large");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private observeLifecycle(value: unknown): void {
    const lifecycle = typeof value === "string" && SAFE_LIFECYCLE.has(value as SparkleLifecycleState)
      ? value as SparkleLifecycleState
      : null;
    if (lifecycle) this.state.lifecycle = lifecycle;
  }

  private installPrerequisite(): SparkleInstallPrerequisite {
    try {
      const result = this.options.getInstallPrerequisite?.();
      if (result === undefined || result === null) return { ok: true };
      if (typeof result === "string") return { ok: false, reason: result };
      return result;
    } catch {
      return { ok: false, reason: "Signed Codex.app backup verification failed." };
    }
  }

  private refreshActionability(): void {
    const nativeInstall = typeof this.native?.installLatestUpdate === "function"
      || typeof this.native?.installUpdatesIfAvailable === "function";
    const prerequisite = this.installPrerequisite();
    if (!this.state.available) {
      this.state.canInstall = false;
      this.state.installPrerequisiteFailure = "The native updater is unavailable.";
    } else if (!nativeInstall) {
      this.state.canInstall = false;
      this.state.installPrerequisiteFailure = "The native updater cannot install updates.";
    } else if (!prerequisite.ok) {
      this.state.canInstall = false;
      this.state.installPrerequisiteFailure = prerequisite.reason ?? "Signed Codex.app backup is unavailable.";
    } else if (this.safeUpdateAvailable && typeof this.options.requestInstall === "function") {
      this.state.canInstall = true;
      this.state.installPrerequisiteFailure = null;
    } else if (this.nativeChecksSuppressed) {
      this.state.canInstall = false;
      this.state.installPrerequisiteFailure = "Native desktop updates are paused while Tweakers is active; use the signed-app refresh flow.";
    } else if (!this.state.ready) {
      this.state.canInstall = false;
      this.state.installPrerequisiteFailure = "An update is not ready to install.";
    } else {
      this.state.canInstall = true;
      this.state.installPrerequisiteFailure = null;
    }
  }

  private fail(message: string): void {
    this.state.lastError = message;
  }
}

let singleton = new CodexSparkleBridge();

export function getCodexSparkleBridge(): CodexSparkleBridge {
  return singleton;
}

export function configureCodexSparkleBridge(options: CodexSparkleBridgeOptions): CodexSparkleBridge {
  singleton.configure(options);
  return singleton;
}

/** Test-only reset through the same public instance boundary. */
export function resetCodexSparkleBridgeForTests(options: CodexSparkleBridgeOptions = {}): CodexSparkleBridge {
  singleton = new CodexSparkleBridge(options);
  return singleton;
}

function safePercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function persistableHttpsUrl(value: unknown): string | null {
  const safe = safeHttpsUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function requirePersistableHttpsUrl(value: unknown): string {
  const safe = persistableHttpsUrl(value);
  if (!safe || safe !== value) throw new Error("Captured profile appcast URL is invalid");
  return safe;
}

async function defaultSparkleFetch(
  url: string,
  init: { headers?: unknown; signal: AbortSignal; redirect: "manual" },
): Promise<SparkleFetchResponse> {
  const response = await fetch(url, {
    headers: init.headers as HeadersInit | undefined,
    signal: init.signal,
    redirect: init.redirect,
  });
  return response;
}

function parseAppcast(xml: string): Pick<SparkleAppcastMetadata, "marketingVersion" | "build" | "releaseUrl"> {
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml) || !/<\/channel\s*>/i.test(xml)) {
    throw new Error("invalid appcast");
  }
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)];
  const releases = items.flatMap((match) => {
    const item = match[1] ?? "";
    const enclosure = item.match(/<enclosure\b[^>]*>/i)?.[0] ?? "";
    const marketingVersion = readXmlAttribute(enclosure, "shortVersionString")
      ?? readXmlElement(item, "shortVersionString");
    const build = readXmlAttribute(enclosure, "version") ?? readXmlElement(item, "version");
    const archiveUrl = readXmlAttribute(enclosure, "url");
    const archiveSignature = readXmlAttribute(enclosure, "edSignature");
    // Metadata is authenticated by the trusted HTTPS feed. Requiring a valid
    // Ed25519-shaped Sparkle enclosure signature additionally ensures we never
    // advertise an item the native OpenAI updater could not verify at install.
    // The signature covers the archive bytes, not the surrounding XML fields.
    if (!marketingVersion || !build || marketingVersion.length > 80 || build.length > 80
      || !archiveUrl || safeHttpsUrl(archiveUrl) === null
      || !isSparkleEd25519Signature(archiveSignature)) return [];
    const releaseCandidate = readXmlElement(item, "releaseNotesLink") ?? readXmlElement(item, "link");
    return [{
      marketingVersion,
      build,
      releaseUrl: releaseCandidate ? safeHttpsUrl(releaseCandidate) : null,
    }];
  });
  if (releases.length === 0) throw new Error("appcast has no release");
  releases.sort((left, right) => compareAppcastRelease(right, left));
  return releases[0]!;
}

function isSparkleEd25519Signature(value: string | null): boolean {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.byteLength === 64 && bytes.toString("base64") === value;
  } catch {
    return false;
  }
}

function readXmlAttribute(element: string, localName: string): string | null {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = element.match(new RegExp(`(?:[\\w.-]+:)?${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ? decodeXmlText(match[2].trim()) : null;
}

function readXmlElement(xml: string, localName: string): string | null {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`, "i"));
  if (!match?.[1]) return null;
  const value = decodeXmlText(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
  return value || null;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function compareAppcastRelease(left: { build: string; marketingVersion: string }, right: { build: string; marketingVersion: string }): number {
  if (/^\d+$/.test(left.build) && /^\d+$/.test(right.build)) {
    const leftBuild = BigInt(left.build);
    const rightBuild = BigInt(right.build);
    if (leftBuild !== rightBuild) return leftBuild > rightBuild ? 1 : -1;
  }
  return left.marketingVersion.localeCompare(right.marketingVersion, undefined, { numeric: true });
}

function requireHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("appcast transport must be HTTPS");
  return url.toString();
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function redactedAppcastFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/timeout/i.test(message)) return "timed out";
  if (/too many redirects/i.test(message)) return "too many redirects";
  if (/redirect missing location/i.test(message)) return "redirect missing location";
  if (/transport must be HTTPS/i.test(message)) return "insecure redirect rejected";
  if (/too large/i.test(message)) return "response too large";
  if (/invalid appcast|no release/i.test(message)) return "invalid signed appcast";
  if (/request failed/i.test(message)) return "request failed";
  return "request failed";
}
