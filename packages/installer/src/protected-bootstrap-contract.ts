/**
 * Installer-local structural reader for the immutable pre-main receipts.
 *
 * The implementation authority remains runtime/protected-bootstrap; this
 * small mirror deliberately avoids importing the runtime TypeScript source
 * across package rootDir boundaries. It accepts only the exact canonical
 * receipt bytes emitted by the runtime module, verified through the shared
 * stable JSON digest algorithm below.
 */
import { createHash } from "node:crypto";

export interface ProtectedLaunchIdentityContract {
  appPath: string;
  appContentsSha256: string;
  appAsarSha256: string;
  asarHeaderSha256: string;
  loaderPath: string;
  loaderSha256: string;
  metadataSha256: string;
  runtimeMainPath: string;
  runtimeMainSha256: string;
  backendPath: string;
  backendSha256: string;
  backendVersion: string;
  backendArchitecture: "arm64";
  signatureReceiptSha256: string;
  policyDigest: string;
}

export interface AppliedPendingLaunchGrantContract {
  schemaVersion: 1;
  kind: "applied-pending-launch-grant";
  transactionId: string;
  attempt: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  authoritySha256: string;
  acceptedBuildReceiptSha256: string;
  environment: { schemaVersion: 2; uiFeatures: "off" | "on"; mcpSafetyProvider: "managed-turn-idle"; recoveryState: "normal-protected" };
  identity: ProtectedLaunchIdentityContract;
  consumedBy: { desktopPid: number; desktopKernelStart: string; consumedAt: string } | null;
}

export interface ProtectedBootstrapPreflightReceiptContract {
  schemaVersion: 1;
  kind: "protected-bootstrap-preflight";
  transactionId: string;
  attempt: number;
  nonce: string | null;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  reason: string | null;
  environment: AppliedPendingLaunchGrantContract["environment"] | null;
  identitySha256: string | null;
  backend: { path: string; sha256: string; version: string; architecture: "arm64" } | null;
  consumedAt: string | null;
  emittedAt: string;
  receiptSha256: string;
}

const SHA = /^[a-f0-9]{64}$/i;
const TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NONCE = /^[A-Za-z0-9._-]{16,256}$/;
const exactPath = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && !value.includes("\0");
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function protectedLaunchIdentitySha256Contract(identity: ProtectedLaunchIdentityContract): string {
  if (!isProtectedLaunchIdentityContract(identity)) throw new Error("Protected launch identity is invalid");
  return createHash("sha256").update(JSON.stringify({
    appPath: identity.appPath,
    appContentsSha256: identity.appContentsSha256.toLowerCase(),
    appAsarSha256: identity.appAsarSha256.toLowerCase(),
    asarHeaderSha256: identity.asarHeaderSha256.toLowerCase(),
    loaderPath: identity.loaderPath,
    loaderSha256: identity.loaderSha256.toLowerCase(),
    metadataSha256: identity.metadataSha256.toLowerCase(),
    runtimeMainPath: identity.runtimeMainPath,
    runtimeMainSha256: identity.runtimeMainSha256.toLowerCase(),
    backendPath: identity.backendPath,
    backendSha256: identity.backendSha256.toLowerCase(),
    backendVersion: identity.backendVersion,
    backendArchitecture: "arm64",
    signatureReceiptSha256: identity.signatureReceiptSha256.toLowerCase(),
    policyDigest: identity.policyDigest.toLowerCase(),
  })).digest("hex");
}

export function isAppliedPendingLaunchGrantV1Contract(value: unknown): value is AppliedPendingLaunchGrantContract {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "applied-pending-launch-grant"
    || !TX.test(String(value.transactionId ?? "")) || !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1
    || !NONCE.test(String(value.nonce ?? "")) || !iso(value.issuedAt) || !iso(value.expiresAt)
    || !SHA.test(String(value.authoritySha256 ?? "")) || !SHA.test(String(value.acceptedBuildReceiptSha256 ?? ""))
    || !isEnvironment(value.environment) || !isProtectedLaunchIdentityContract(value.identity)) return false;
  if (Date.parse(value.expiresAt as string) <= Date.parse(value.issuedAt as string)) return false;
  const consumed = value.consumedBy;
  return consumed === null || (record(consumed) && Number.isSafeInteger(consumed.desktopPid)
    && (consumed.desktopPid as number) > 0 && typeof consumed.desktopKernelStart === "string" && iso(consumed.consumedAt));
}

export function isProtectedBootstrapPreflightReceiptContract(value: unknown): value is ProtectedBootstrapPreflightReceiptContract {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "protected-bootstrap-preflight"
    || !TX.test(String(value.transactionId ?? "")) || !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1
    || (value.nonce !== null && !NONCE.test(String(value.nonce ?? "")))
    || !["PASS", "FAIL", "INCONCLUSIVE"].includes(String(value.verdict))
    || (value.reason !== null && typeof value.reason !== "string")
    || (value.environment !== null && !isEnvironment(value.environment))
    || (value.identitySha256 !== null && !SHA.test(String(value.identitySha256)))
    || !iso(value.emittedAt) || !SHA.test(String(value.receiptSha256 ?? ""))) return false;
  const backend = value.backend;
  if (backend !== null && (!record(backend) || !exactPath(backend.path) || !SHA.test(String(backend.sha256))
    || typeof backend.version !== "string" || !backend.version.trim() || backend.architecture !== "arm64")) return false;
  if (value.consumedAt !== null && !iso(value.consumedAt)) return false;
  if (value.verdict === "PASS" && (value.nonce === null || value.reason !== null || value.environment === null
    || value.identitySha256 === null || backend === null || value.consumedAt === null)) return false;
  const { receiptSha256, ...withoutDigest } = value;
  return String(receiptSha256).toLowerCase() === canonicalDigest(withoutDigest);
}

function isEnvironment(value: unknown): value is AppliedPendingLaunchGrantContract["environment"] {
  return record(value) && value.schemaVersion === 2 && (value.uiFeatures === "off" || value.uiFeatures === "on")
    && value.mcpSafetyProvider === "managed-turn-idle" && value.recoveryState === "normal-protected";
}

function isProtectedLaunchIdentityContract(value: unknown): value is ProtectedLaunchIdentityContract {
  if (!record(value)) return false;
  const paths = [value.appPath, value.loaderPath, value.runtimeMainPath, value.backendPath];
  const digests = [value.appContentsSha256, value.appAsarSha256, value.asarHeaderSha256, value.loaderSha256,
    value.metadataSha256, value.runtimeMainSha256, value.backendSha256, value.signatureReceiptSha256, value.policyDigest];
  return paths.every(exactPath) && digests.every((digest) => SHA.test(String(digest)))
    && typeof value.backendVersion === "string" && value.backendVersion.trim().length > 0 && value.backendArchitecture === "arm64";
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
}
