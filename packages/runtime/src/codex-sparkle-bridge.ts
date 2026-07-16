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
}

const SAFE_LIFECYCLE = new Set<SparkleLifecycleState>([
  "idle",
  "checking",
  "downloading",
  "ready",
  "installing",
  "failed",
]);

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
  private lastAppcast: SparkleAppcastMetadata | null = null;
  private nativeChecksSuppressed = false;
  private nativeSchedulerDisabled = false;
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
    const feeds = [
      this.state.feedUrl ? { url: this.state.feedUrl, headers: this.headers } : null,
      this.state.fallbackFeedUrl && this.state.fallbackFeedUrl !== this.state.feedUrl
        ? { url: this.state.fallbackFeedUrl, headers: undefined }
        : null,
    ].filter((entry): entry is { url: string; headers: unknown } => entry !== null);

    for (const feed of feeds) {
      try {
        const xml = await this.fetchBoundedAppcast(feed.url, feed.headers);
        const parsed = parseAppcast(xml);
        const metadata: SparkleAppcastMetadata = {
          ...parsed,
          feedUrl: feed.url,
          checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
          stale: false,
          error: null,
        };
        this.lastAppcast = metadata;
        return { ...metadata };
      } catch {
        // Try OpenAI's public fallback. Errors remain intentionally redacted.
      }
    }

    if (this.lastAppcast) {
      return { ...this.lastAppcast, stale: true, error: "Appcast metadata is unavailable." };
    }
    return {
      marketingVersion: "Unavailable",
      build: "Unavailable",
      releaseUrl: null,
      feedUrl: this.state.fallbackFeedUrl ?? this.state.feedUrl ?? "Unavailable",
      checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
      stale: false,
      error: "Appcast metadata is unavailable.",
    };
  }

  private wrapInit(addon: SparkleNativeExports): void {
    const original = addon.init;
    if (typeof original !== "function") return;
    const bridge = this;
    addon.init = function codexPlusPlusSparkleInit(this: unknown, ...args: unknown[]) {
      bridge.captureInit(args);
      try {
        const result = Reflect.apply(original, this, args);
        bridge.state.available = true;
        bridge.state.lastError = null;
        bridge.refreshActionability();
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
   * identity. In a locally signed Tweakers app, both manual and scheduled
   * checks relaunch the foreground ChatGPT executable while looking for that
   * service. Keep native checks inert and use the bounded signed-appcast path
   * for version discovery instead.
   */
  private suppressNativeChecks(addon: SparkleNativeExports): void {
    for (const name of ["checkForUpdates", "checkForUpdatesInBackground"] as const) {
      if (typeof addon[name] !== "function") continue;
      addon[name] = function codexPlusPlusSuppressedSparkleCheck() { return false; };
      this.nativeChecksSuppressed = true;
    }
  }

  private disableNativeScheduler(addon: SparkleNativeExports): void {
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
        addon[name] = function codexPlusPlusSuppressedSparkleSchedule() { return undefined; };
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
    addon[name] = function codexPlusPlusSparkleSinkSetter(this: unknown, sink: (...args: unknown[]) => void) {
      const tee = (...args: unknown[]) => {
        observe(args[0]);
        if (typeof sink === "function") Reflect.apply(sink, undefined, args);
      };
      return Reflect.apply(original, this, [tee]);
    };
  }

  private wrapInstall(
    addon: SparkleNativeExports,
    name: "installLatestUpdate" | "installUpdatesIfAvailable",
  ): void {
    const original = addon[name];
    if (typeof original !== "function") return;
    const bridge = this;
    addon[name] = function codexPlusPlusSparkleInstall(this: unknown, ...args: unknown[]) {
      const prerequisite = bridge.installPrerequisite();
      if (!prerequisite.ok) {
        bridge.refreshActionability();
        return false;
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

  private captureInit(args: unknown[]): void {
    this.state.feedUrl = safeHttpsUrl(args[0]);
    this.headers = args.length >= 2 ? args[1] : undefined;
    this.state.fallbackFeedUrl = safeHttpsUrl(args[2]);
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
      for (let redirects = 0; ; redirects += 1) {
        const response = await Promise.race([
          fetcher(url, { headers, signal: controller.signal, redirect: "manual" }),
          deadline,
        ]);
        requireHttpsUrl(response.url || url);
        if (isRedirectStatus(response.status)) {
          if (redirects >= maxRedirects) throw new Error("too many redirects");
          const location = response.headers.get("location");
          if (!location) throw new Error("redirect missing location");
          url = requireHttpsUrl(new URL(location, url).toString());
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
    if (!marketingVersion || !build || marketingVersion.length > 80 || build.length > 80) return [];
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
