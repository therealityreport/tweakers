import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const STARTUP_POLICY_BUNDLE_ID = "com.therealityreport.tweakers" as const;
export interface StartupPolicyAuthorizationV1 {
  /** V2 retains the same four read-only messages during bounded preparation. */
  version: 1 | 2;
  scope: "startup-policy";
  clientKind: "tweakers";
  bundleIdentity: typeof STARTUP_POLICY_BUNDLE_ID;
  sessionNonce: string;
  nonce: string;
  expiresAt: number;
}
export interface StartupPolicyHandshakeV1 {
  version: 1;
  kind: "startup-policy-handshake";
  authorization: StartupPolicyAuthorizationV1;
  proof: string;
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
const safeNonce = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);

export function isStartupPolicyAuthorization(value: unknown, now = Date.now()): value is StartupPolicyAuthorizationV1 {
  return Number.isSafeInteger(now)
    && exact(value, ["version", "scope", "clientKind", "bundleIdentity", "sessionNonce", "nonce", "expiresAt"])
    && [1, 2].includes(value.version as number) && value.scope === "startup-policy" && value.clientKind === "tweakers"
    && value.bundleIdentity === STARTUP_POLICY_BUNDLE_ID && safeNonce(value.sessionNonce)
    && typeof value.nonce === "string" && /^[A-Za-z0-9_-]{32}$/.test(value.nonce)
    && Number.isSafeInteger(value.expiresAt) && (value.expiresAt as number) > now
    && (value.expiresAt as number) - now <= (value.version === 2 ? 600_000 : 60_000);
}

export function createStartupPolicyAuthorization(sessionNonce: string, now = Date.now(), preparationMs = 30_000): StartupPolicyAuthorizationV1 {
  if (!safeNonce(sessionNonce) || !Number.isSafeInteger(now) || !Number.isSafeInteger(preparationMs)
    || preparationMs < 1 || preparationMs > 600_000 || !Number.isSafeInteger(now + preparationMs)) throw new Error("Invalid startup policy authorization input");
  return { version: preparationMs > 30_000 ? 2 : 1, scope: "startup-policy", clientKind: "tweakers", bundleIdentity: STARTUP_POLICY_BUNDLE_ID,
    sessionNonce, nonce: randomBytes(24).toString("base64url"), expiresAt: now + preparationMs };
}

function canonicalAuthorization(value: StartupPolicyAuthorizationV1): string {
  return JSON.stringify({ version: value.version, scope: value.scope, clientKind: value.clientKind,
    bundleIdentity: value.bundleIdentity, sessionNonce: value.sessionNonce, nonce: value.nonce, expiresAt: value.expiresAt });
}

export function createStartupPolicyHandshakeProof(secret: Buffer, authorization: StartupPolicyAuthorizationV1): string {
  if (secret.length !== 32 || !isStartupPolicyAuthorization(authorization, authorization.expiresAt - 30_000)) throw new Error("Invalid startup policy proof input");
  return createHmac("sha256", secret).update("startup-policy-v1\0").update(canonicalAuthorization(authorization)).digest("hex");
}

export function createStartupPolicyHandshake(secret: Buffer, authorization: StartupPolicyAuthorizationV1): StartupPolicyHandshakeV1 {
  return { version: 1, kind: "startup-policy-handshake", authorization: { ...authorization }, proof: createStartupPolicyHandshakeProof(secret, authorization) };
}

/** Replay ownership belongs to the connection owner, separately from proof verification. */
export function verifyStartupPolicyHandshake(secret: Buffer, value: unknown, now = Date.now()): value is StartupPolicyHandshakeV1 {
  if (secret.length !== 32 || !exact(value, ["version", "kind", "authorization", "proof"])
    || value.version !== 1 || value.kind !== "startup-policy-handshake" || !isStartupPolicyAuthorization(value.authorization, now)
    || typeof value.proof !== "string" || !/^[a-f0-9]{64}$/.test(value.proof)) return false;
  const expected = createStartupPolicyHandshakeProof(secret, value.authorization);
  return timingSafeEqual(Buffer.from(value.proof, "hex"), Buffer.from(expected, "hex"));
}

export type StartupPolicySessionStateV1 = "initialize" | "initialized" | "configRequirements/read" | "config/read" | "complete" | "failed";
const sequence: StartupPolicySessionStateV1[] = ["initialize", "initialized", "configRequirements/read", "config/read", "complete"];

function validInitialize(params: unknown): boolean {
  return exact(params, ["clientInfo", "capabilities"])
    && exact(params.clientInfo, ["name", "title", "version"])
    && params.clientInfo.name === "codex_desktop" && params.clientInfo.title === "Codex Desktop"
    && typeof params.clientInfo.version === "string" && params.clientInfo.version.trim().length > 0
    && params.clientInfo.version.length <= 128
    && exact(params.capabilities, ["experimentalApi"]) && params.capabilities.experimentalApi === true;
}

/** A capability for these four startup messages only; it grants no renderer identity. */
export class StartupPolicySessionV1 {
  private index = 0;
  private pending = false;
  private failed = false;
  get state(): StartupPolicySessionStateV1 { return this.failed ? "failed" : sequence[this.index]!; }
  get completed(): boolean { return this.state === "complete"; }

  prepare(frame: unknown): boolean {
    if (this.failed || this.pending || this.state === "complete") { this.fail(); return false; }
    const notification = this.state === "initialized";
    const has = (key: string) => !!frame && typeof frame === "object" && Object.hasOwn(frame, key);
    const keys = [...(has("jsonrpc") ? ["jsonrpc"] : []), ...(notification
      ? ["method", ...(has("params") ? ["params"] : [])]
      : ["id", "method", "params"])];
    if (!exact(frame, keys) || (has("jsonrpc") && frame.jsonrpc !== "2.0") || frame.method !== this.state
      || (!notification && !(typeof frame.id === "string" && frame.id.length <= 256
        || typeof frame.id === "number" && Number.isSafeInteger(frame.id)))) { this.fail(); return false; }
    const valid = this.state === "initialize" ? validInitialize(frame.params)
      : notification ? !has("params") || exact(frame.params, [])
      : this.state === "configRequirements/read" ? exact(frame.params, [])
      : exact(frame.params, ["includeLayers"]) && frame.params.includeLayers === false;
    if (!valid) { this.fail(); return false; }
    this.pending = true;
    return true;
  }

  /** Call only after the parent has delivered a successful response (or accepted notification). */
  complete(success: boolean): boolean {
    if (this.failed || !this.pending || success !== true) { this.fail(); return false; }
    this.pending = false;
    this.index += 1;
    return true;
  }
  fail(): void { this.failed = true; this.pending = false; }
}
