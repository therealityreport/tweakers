import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HealthValue = "pass" | "fail" | "unknown";

export const PROMOTION_RENDERER_IPC_CHANNEL = "tweaker:promotion-renderer-proof";

export interface PromotionRendererProofResult {
  hostReady: HealthValue;
  rendererStorageSelfTest: HealthValue;
}

export interface PromotionRendererProofTracker {
  windowCreated(observation: {
    webContentsId: number;
    url: string;
    preloadPath: string | null;
  }): void;
  didFinishLoad(observation: { webContentsId: number; url: string }): void;
  didFailLoad(observation: {
    webContentsId: number;
    errorCode: number;
    errorDescription: string;
    url: string;
  }): void;
  renderProcessGone(observation: {
    webContentsId: number;
    reason: string;
    exitCode: number;
  }): void;
  rendererHandshake(observation: {
    webContentsId: number;
    nonce: string;
    url: string;
    lifecycle: string;
    rendererStorageSelfTest: HealthValue;
  }): void;
  result(): PromotionRendererProofResult;
}

/**
 * Tracks the candidate's real renderer without importing Electron into tests.
 * Every positive signal is bound to one nonce, URL, preload, and webContents.
 */
export function createPromotionRendererProofTracker(expected: {
  nonce: string;
  url: string;
  preloadPath: string;
}): PromotionRendererProofTracker {
  let expectedWebContentsId: number | null = null;
  let windowCreated = false;
  let didFinishLoad = false;
  let handshake = false;
  let failed = false;
  let rendererStorageSelfTest: HealthValue = "unknown";

  const expectedRenderer = (webContentsId: number): boolean => (
    expectedWebContentsId !== null && webContentsId === expectedWebContentsId
  );
  const validId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

  return {
    windowCreated(observation) {
      if (expectedWebContentsId !== null) {
        failed = true;
        return;
      }
      expectedWebContentsId = validId(observation.webContentsId) ? observation.webContentsId : null;
      windowCreated = expectedWebContentsId !== null
        && observation.url === expected.url
        && observation.preloadPath === expected.preloadPath;
      if (!windowCreated) failed = true;
    },
    didFinishLoad(observation) {
      if (!expectedRenderer(observation.webContentsId)) return;
      if (observation.url !== expected.url) {
        failed = true;
        return;
      }
      didFinishLoad = true;
    },
    didFailLoad(observation) {
      if (!expectedRenderer(observation.webContentsId)) return;
      // Any did-fail-load on the proof renderer, including ERR_FAILED (-2),
      // invalidates the one-shot proof even if a later navigation succeeds.
      void observation.errorCode;
      void observation.errorDescription;
      void observation.url;
      failed = true;
      rendererStorageSelfTest = "fail";
    },
    renderProcessGone(observation) {
      if (!expectedRenderer(observation.webContentsId)) return;
      void observation.reason;
      void observation.exitCode;
      failed = true;
      rendererStorageSelfTest = "fail";
    },
    rendererHandshake(observation) {
      if (!expectedRenderer(observation.webContentsId)) return;
      if (
        observation.nonce !== expected.nonce
        || observation.url !== expected.url
        || observation.lifecycle !== "renderer-mounted"
        || !validHealthValue(observation.rendererStorageSelfTest)
      ) {
        failed = true;
        rendererStorageSelfTest = "fail";
        return;
      }
      handshake = true;
      rendererStorageSelfTest = observation.rendererStorageSelfTest;
    },
    result() {
      if (failed) return { hostReady: "fail", rendererStorageSelfTest: "fail" };
      return {
        hostReady: windowCreated && didFinishLoad && handshake ? "pass" : "unknown",
        rendererStorageSelfTest: handshake ? rendererStorageSelfTest : "unknown",
      };
    },
  };
}

interface LegacyHealthRequest {
  schemaVersion: 1;
  requestedAt: string;
  app: { version: string; build: string; hash: string };
  runtimeHash: string;
  requiredPermissions: string[];
}

export const PROMOTION_SURFACE_NAMES = [
  "app",
  "runtime",
  "tweakTree",
  "tweakersConfig",
  "codexConfig",
  "namespaceData",
  "mainStorage",
  "policy",
] as const;

export type PromotionSurfaceName = typeof PROMOTION_SURFACE_NAMES[number];

export interface PromotionSurfaceExpectation {
  preimageHash: string;
  afterHash: string;
}

export interface UserQuestionsPromotionExpectation {
  id: string;
  version: string;
  payloadHash: string;
}

export interface PromotionHealthRequestV2 {
  schemaVersion: 2;
  requestedAt: string;
  app: { version: string; build: string; hash: string };
  requiredPermissions: string[];
  surfaces: Record<PromotionSurfaceName, PromotionSurfaceExpectation>;
  userQuestions: UserQuestionsPromotionExpectation;
}

export interface UserQuestionsHealthObservation {
  id: string;
  version: string;
  payloadHash: string;
  mainLifecycle: HealthValue;
  brokerSelfTest: HealthValue;
  schemaSelfTest: HealthValue;
  rendererStorageSelfTest: HealthValue;
  mcpConflictCount: number;
}

export interface RuntimePromotionProbes {
  authenticatedSession(): HealthValue | Promise<HealthValue>;
  declaredPermission(permission: string): HealthValue | Promise<HealthValue>;
  /** A nonce-bound real BrowserWindow/preload lifecycle proof. Missing means unknown. */
  rendererReady?(): HealthValue | Promise<HealthValue>;
  /** V2 observations are injected so disposable candidates never infer or read live config paths. */
  promotionSurface?(surface: PromotionSurfaceName): string | Promise<string>;
  userQuestionsHealth?(): UserQuestionsHealthObservation | Promise<UserQuestionsHealthObservation>;
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
  let request: LegacyHealthRequest | PromotionHealthRequestV2;
  try {
    const stat = lstatSync(requestFile);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    request = JSON.parse(readFileSync(requestFile, "utf8")) as LegacyHealthRequest | PromotionHealthRequestV2;
    const now = (options.now ?? new Date()).getTime();
    const requestedAt = Date.parse(request.requestedAt);
    if (!Number.isFinite(requestedAt) || requestedAt > now + 5_000 || now - requestedAt > (options.maxAgeMs ?? 60_000)) return false;
    if (!validPromotionRequest(request)) return false;
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
  const authenticatedSession = await safe(() => probes.authenticatedSession());
  const receipt = request.schemaVersion === 1
    ? {
      schemaVersion: 1 as const,
      observedAt: (options.now ?? new Date()).toISOString(),
      app: request.app,
      runtimeHash: request.runtimeHash,
      hostReady: "pass" as const,
      authenticatedSession,
      declaredPermissions: permissions,
    }
    : await buildV2Receipt(request, probes, permissions, authenticatedSession, options.now ?? new Date(), safe);
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

async function buildV2Receipt(
  request: PromotionHealthRequestV2,
  probes: RuntimePromotionProbes,
  permissions: Record<string, HealthValue>,
  authenticatedSession: HealthValue,
  now: Date,
  safe: (probe: () => HealthValue | Promise<HealthValue>) => Promise<HealthValue>,
): Promise<object> {
  const surfaces = Object.fromEntries(await Promise.all(PROMOTION_SURFACE_NAMES.map(async (surface) => {
    const expected = request.surfaces[surface];
    let observedHash = "unknown";
    try {
      const observed = await probes.promotionSurface?.(surface);
      if (validPromotionHash(observed)) observedHash = observed;
    } catch { /* fail closed below */ }
    return [surface, {
      preimageHash: expected.preimageHash,
      expectedHash: expected.afterHash,
      observedHash,
      status: observedHash === expected.afterHash ? "pass" : observedHash === "unknown" ? "unknown" : "fail",
    }];
  }))) as Record<PromotionSurfaceName, {
    preimageHash: string;
    expectedHash: string;
    observedHash: string;
    status: HealthValue;
  }>;
  let observedUserQuestions: UserQuestionsHealthObservation | null = null;
  try {
    const observed = await probes.userQuestionsHealth?.();
    if (validUserQuestionsObservation(observed)) observedUserQuestions = observed;
  } catch { /* fail closed below */ }
  const expectedUserQuestions = request.userQuestions;
  const hostReady = await safe(() => probes.rendererReady?.() ?? "unknown");
  const identity = observedUserQuestions &&
    observedUserQuestions.id === expectedUserQuestions.id &&
    observedUserQuestions.version === expectedUserQuestions.version &&
    observedUserQuestions.payloadHash === expectedUserQuestions.payloadHash
    ? "pass" : observedUserQuestions ? "fail" : "unknown";
  const userQuestions = {
    expected: expectedUserQuestions,
    observed: observedUserQuestions ? {
      id: observedUserQuestions.id,
      version: observedUserQuestions.version,
      payloadHash: observedUserQuestions.payloadHash,
    } : null,
    identity,
    mainLifecycle: observedUserQuestions?.mainLifecycle ?? "unknown",
    brokerSelfTest: observedUserQuestions?.brokerSelfTest ?? "unknown",
    schemaSelfTest: observedUserQuestions?.schemaSelfTest ?? "unknown",
    rendererStorageSelfTest: observedUserQuestions?.rendererStorageSelfTest ?? "unknown",
    mcpConflictCount: observedUserQuestions?.mcpConflictCount ?? null,
    zeroMcpConflicts: observedUserQuestions
      ? observedUserQuestions.mcpConflictCount === 0 ? "pass" : "fail"
      : "unknown",
  };
  const allSurfacesPass = Object.values(surfaces).every((surface) => surface.status === "pass");
  const allPermissionsPass = Object.values(permissions).every((permission) => permission === "pass");
  const userQuestionsPass = [
    userQuestions.identity,
    userQuestions.mainLifecycle,
    userQuestions.brokerSelfTest,
    userQuestions.schemaSelfTest,
    userQuestions.rendererStorageSelfTest,
    userQuestions.zeroMcpConflicts,
  ].every((value) => value === "pass");
  return {
    schemaVersion: 2,
    observedAt: now.toISOString(),
    app: request.app,
    hostReady,
    authenticatedSession,
    declaredPermissions: permissions,
    surfaces,
    userQuestions,
    promotionReady: hostReady === "pass" && allSurfacesPass && allPermissionsPass && userQuestionsPass && authenticatedSession === "pass"
      ? "pass" : "fail",
  };
}

function validPromotionRequest(value: unknown): value is LegacyHealthRequest | PromotionHealthRequestV2 {
  if (!plainRecord(value)) return false;
  if (value.schemaVersion === 1) {
    if (!exactKeys(value, ["schemaVersion", "requestedAt", "app", "runtimeHash", "requiredPermissions"])) return false;
    return validApp(value.app) && typeof value.runtimeHash === "string" && validPermissions(value.requiredPermissions);
  }
  if (value.schemaVersion !== 2 || !exactKeys(value, ["schemaVersion", "requestedAt", "app", "requiredPermissions", "surfaces", "userQuestions"])) return false;
  if (!validApp(value.app) || !validPermissions(value.requiredPermissions) || !plainRecord(value.surfaces)) return false;
  if (!exactKeys(value.surfaces, [...PROMOTION_SURFACE_NAMES])) return false;
  const surfaces = value.surfaces as Record<string, unknown>;
  for (const surface of PROMOTION_SURFACE_NAMES) {
    const expectation = surfaces[surface];
    if (!plainRecord(expectation) || !exactKeys(expectation, ["preimageHash", "afterHash"])) return false;
    if (!validPromotionHash(expectation.preimageHash) || !validPromotionHash(expectation.afterHash)) return false;
  }
  if ((surfaces.app as Record<string, unknown>).afterHash !== (value.app as { hash: string }).hash) return false;
  if (!plainRecord(value.userQuestions) || !exactKeys(value.userQuestions, ["id", "version", "payloadHash"])) return false;
  return value.userQuestions.id === "co.tweakers.user-questions" &&
    typeof value.userQuestions.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.userQuestions.version) &&
    validPromotionHash(value.userQuestions.payloadHash) && value.userQuestions.payloadHash !== "missing";
}

function validApp(value: unknown): boolean {
  return plainRecord(value) && exactKeys(value, ["version", "build", "hash"]) &&
    typeof value.version === "string" && value.version.length > 0 &&
    typeof value.build === "string" && value.build.length > 0 &&
    typeof value.hash === "string" && value.hash.length > 0;
}

function validPermissions(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && new Set(value).size === value.length &&
    value.every((permission) => typeof permission === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(permission));
}

function validPromotionHash(value: unknown): value is string {
  return value === "missing" || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

function validUserQuestionsObservation(value: unknown): value is UserQuestionsHealthObservation {
  if (!plainRecord(value) || !exactKeys(value, [
    "id", "version", "payloadHash", "mainLifecycle", "brokerSelfTest", "schemaSelfTest", "rendererStorageSelfTest", "mcpConflictCount",
  ])) return false;
  return typeof value.id === "string" && typeof value.version === "string" && validPromotionHash(value.payloadHash) &&
    validHealthValue(value.mainLifecycle) && validHealthValue(value.brokerSelfTest) && validHealthValue(value.schemaSelfTest) &&
    validHealthValue(value.rendererStorageSelfTest) &&
    Number.isInteger(value.mcpConflictCount) && (value.mcpConflictCount as number) >= 0;
}

function validHealthValue(value: unknown): value is HealthValue {
  return value === "pass" || value === "fail" || value === "unknown";
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
