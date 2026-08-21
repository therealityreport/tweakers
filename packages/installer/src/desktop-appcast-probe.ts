import { join } from "node:path";
import { readPlist } from "./plist.js";

/**
 * Bounded Sparkle appcast probe for the desktop-update transaction.
 *
 * The fetch/parse behavior is vendored from the runtime's
 * packages/runtime/src/codex-sparkle-bridge.ts (the installer has no package
 * dependency on the runtime — it bundles it as an asset): HTTPS-only
 * transport with manual redirect handling, hard byte and time bounds, and a
 * release parser that only trusts items carrying an Ed25519-shaped Sparkle
 * enclosure signature, ordered by BigInt build number. Keep the two copies
 * behaviorally aligned when either changes.
 *
 * The probe is advisory and fails open: only an unambiguous, authoritative
 * feed result may short-circuit an update ("current"); every failure or
 * ambiguity reports "unavailable" so the native updater flow runs unchanged.
 */

export const CODEX_PUBLIC_PRODUCTION_APPCAST = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";

export interface DesktopAppcastProbeBaseline {
  marketingVersion: string | null;
  build: string | null;
}

export interface DesktopAppcastProbeResult {
  state: "current" | "update-available" | "unavailable";
  latestMarketingVersion: string | null;
  latestBuild: string | null;
  /** Signed release archive of the winning item; feeds the direct updater. */
  enclosureUrl: string | null;
  enclosureLength: number | null;
  feedUrl: string | null;
  detail: string;
}

export interface DesktopAppcastFetchResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type DesktopAppcastFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: "manual" },
) => Promise<DesktopAppcastFetchResponse>;

export interface DesktopAppcastProbeInput {
  appPath: string;
  baseline: DesktopAppcastProbeBaseline;
  fetch?: DesktopAppcastFetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export async function probeDesktopAppcast(input: DesktopAppcastProbeInput): Promise<DesktopAppcastProbeResult> {
  const feedUrl = readFeedUrl(input.appPath) ?? CODEX_PUBLIC_PRODUCTION_APPCAST;
  if (input.baseline.marketingVersion === null || input.baseline.build === null) {
    return {
      state: "unavailable",
      latestMarketingVersion: null,
      latestBuild: null,
      enclosureUrl: null,
      enclosureLength: null,
      feedUrl,
      detail: "installed baseline is unreadable",
    };
  }
  let latest: { marketingVersion: string; build: string; enclosureUrl: string; enclosureLength: number | null };
  try {
    const xml = await fetchBoundedAppcast(feedUrl, input);
    latest = parseAppcast(xml);
  } catch (error) {
    return {
      state: "unavailable",
      latestMarketingVersion: null,
      latestBuild: null,
      enclosureUrl: null,
      enclosureLength: null,
      feedUrl,
      detail: `appcast ${redactedAppcastFailure(error)}`,
    };
  }
  const comparison = compareAppcastRelease(latest, {
    marketingVersion: input.baseline.marketingVersion,
    build: input.baseline.build,
  });
  return {
    state: comparison > 0 ? "update-available" : "current",
    latestMarketingVersion: latest.marketingVersion,
    latestBuild: latest.build,
    enclosureUrl: latest.enclosureUrl,
    enclosureLength: latest.enclosureLength,
    feedUrl,
    detail: comparison > 0
      ? `appcast latest ${latest.marketingVersion} (${latest.build}) is newer than installed ${input.baseline.marketingVersion} (${input.baseline.build})`
      : `appcast latest ${latest.marketingVersion} (${latest.build}) is not newer than installed ${input.baseline.marketingVersion} (${input.baseline.build})`,
  };
}

function readFeedUrl(appPath: string): string | null {
  try {
    const plist = readPlist(join(appPath, "Contents", "Info.plist"));
    const value = plist.SUFeedURL;
    if (typeof value !== "string") return null;
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function fetchBoundedAppcast(initialUrl: string, input: DesktopAppcastProbeInput): Promise<string> {
  const fetcher = input.fetch ?? defaultAppcastFetch;
  const timeoutMs = boundedInteger(input.timeoutMs, 5_000, 250, 30_000);
  const maxBytes = boundedInteger(input.maxBytes, 1_048_576, 1, 4_194_304);
  const maxRedirects = boundedInteger(input.maxRedirects, 4, 0, 8);
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
        fetcher(url, { signal: controller.signal, redirect: "manual" }),
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

async function defaultAppcastFetch(
  url: string,
  init: { signal: AbortSignal; redirect: "manual" },
): Promise<DesktopAppcastFetchResponse> {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    headers: response.headers,
    arrayBuffer: () => response.arrayBuffer(),
  };
}

function parseAppcast(xml: string): {
  marketingVersion: string;
  build: string;
  enclosureUrl: string;
  enclosureLength: number | null;
} {
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
    // act on an item the native OpenAI updater could not verify at install.
    const enclosureUrl = archiveUrl === null ? null : safeHttpsUrl(archiveUrl);
    if (!marketingVersion || !build || marketingVersion.length > 80 || build.length > 80
      || enclosureUrl === null
      || !isSparkleEd25519Signature(archiveSignature)) return [];
    const announcedLength = Number(readXmlAttribute(enclosure, "length"));
    return [{
      marketingVersion,
      build,
      enclosureUrl,
      enclosureLength: Number.isFinite(announcedLength) && announcedLength > 0 ? announcedLength : null,
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

function compareAppcastRelease(
  left: { build: string; marketingVersion: string },
  right: { build: string; marketingVersion: string },
): number {
  if (/^\d+$/.test(left.build) && /^\d+$/.test(right.build)) {
    const leftBuild = BigInt(left.build);
    const rightBuild = BigInt(right.build);
    if (leftBuild !== rightBuild) return leftBuild > rightBuild ? 1 : -1;
  }
  return left.marketingVersion.localeCompare(right.marketingVersion, undefined, { numeric: true });
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
