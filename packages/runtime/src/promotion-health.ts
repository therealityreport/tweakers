import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type HealthValue = "pass" | "fail" | "unknown";

interface HealthRequest {
  schemaVersion: 1;
  requestedAt: string;
  app: { version: string; build: string; hash: string };
  runtimeHash: string;
  requiredPermissions: string[];
}

export interface RuntimePromotionProbes {
  authenticatedSession(): HealthValue | Promise<HealthValue>;
  declaredPermission(permission: string): HealthValue | Promise<HealthValue>;
}

export interface SessionCookieObservation {
  name: string;
  domain?: string;
  value?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

export function hasAuthenticatedSessionCookie(cookies: SessionCookieObservation[], now = Date.now()): boolean {
  return cookies.some((cookie) => {
    const domain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase();
    const knownDomain = domain === "chatgpt.com" || domain.endsWith(".chatgpt.com") ||
      domain === "openai.com" || domain.endsWith(".openai.com");
    const knownSessionName = /^(?:__Secure-|__Host-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(cookie.name);
    const notExpired = cookie.expirationDate === undefined || cookie.expirationDate * 1_000 > now;
    return knownDomain && knownSessionName && cookie.secure === true && cookie.httpOnly === true &&
      typeof cookie.value === "string" && cookie.value.length > 0 && notExpired;
  });
}

export interface CodexAuthObservation {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  } | null;
}

/**
 * The Codex / ChatGPT desktop app does NOT authenticate with a web
 * next-auth.session-token cookie. It signs in with a Codex account token stored
 * in `~/.codex/auth.json` (auth_mode "chatgpt") or an API key. The id_token is
 * short-lived and refreshed roughly hourly, so a durable session is proven by a
 * refresh token / account id (or an API key) — never by the id_token's expiry.
 */
export function hasAuthenticatedCodexToken(auth: CodexAuthObservation | null | undefined): boolean {
  if (!auth || typeof auth !== "object") return false;
  const apiKey = typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0;
  const tokens = auth.tokens ?? undefined;
  const durableSession = !!tokens && (
    (typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0) ||
    (typeof tokens.account_id === "string" && tokens.account_id.length > 0 &&
      typeof tokens.access_token === "string" && tokens.access_token.length > 0)
  );
  return apiKey || durableSession;
}

export function readCodexAuth(codexHome?: string): CodexAuthObservation | null {
  try {
    const home = codexHome || process.env.CODEX_HOME || join(homedir(), ".codex");
    return JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as CodexAuthObservation;
  } catch {
    return null;
  }
}

export async function answerPromotionHealthRequest(
  userRoot: string,
  probes: RuntimePromotionProbes,
  options: { now?: Date; maxAgeMs?: number } = {},
): Promise<boolean> {
  const requestFile = join(userRoot, "health", "request.json");
  const receiptFile = join(userRoot, "health", "promotion.json");
  let request: HealthRequest;
  try {
    const stat = lstatSync(requestFile);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    request = JSON.parse(readFileSync(requestFile, "utf8")) as HealthRequest;
    const now = (options.now ?? new Date()).getTime();
    const requestedAt = Date.parse(request.requestedAt);
    if (request.schemaVersion !== 1 || !Number.isFinite(requestedAt) || requestedAt > now + 5_000 || now - requestedAt > (options.maxAgeMs ?? 60_000)) return false;
    if (!request.app || typeof request.runtimeHash !== "string" || !Array.isArray(request.requiredPermissions)) return false;
  } catch {
    return false;
  }

  const safe = async (probe: () => HealthValue | Promise<HealthValue>): Promise<HealthValue> => {
    try {
      const value = await probe();
      return value === "pass" || value === "fail" || value === "unknown" ? value : "unknown";
    } catch {
      return "unknown";
    }
  };
  const permissions = Object.fromEntries(await Promise.all(request.requiredPermissions.map(async (permission) => [
    permission,
    await safe(() => probes.declaredPermission(permission)),
  ])));
  const receipt = {
    schemaVersion: 1,
    observedAt: (options.now ?? new Date()).toISOString(),
    app: request.app,
    runtimeHash: request.runtimeHash,
    hostReady: "pass" as const,
    authenticatedSession: await safe(() => probes.authenticatedSession()),
    declaredPermissions: permissions,
  };
  mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 });
  const temporary = `${receiptFile}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, receiptFile);
  chmodSync(receiptFile, 0o600);
  try { unlinkSync(requestFile); } catch { /* one-shot request already consumed */ }
  return true;
}
