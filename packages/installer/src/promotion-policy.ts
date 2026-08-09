import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  canonicalPromotionPolicyText,
  PROMOTION_POLICY_FILE_MAX_BYTES,
  PROMOTION_POLICY_HASH_DOMAIN,
} from "@therealityreport/tweakers-sdk";
import { targetUserOwnership } from "./ownership.js";

export interface PromotionPolicyReadDependencies {
  /** Test seam for proving opened-file metadata drift fails closed. */
  duringRead?: () => void;
  /** Test seam for proving an atomic path replacement cannot pass observation. */
  afterRead?: () => void;
}

export type PromotionPolicyFingerprintFailureReason =
  | "open_failed"
  | "unsafe_metadata"
  | "changed_during_read"
  | "path_changed"
  | "invalid_utf8"
  | "invalid_json"
  | "duplicate_json_key"
  | "invalid_schema"
  | "unexpected_error";

export class PromotionPolicyFingerprintError extends Error {
  readonly code = "PROMOTION_POLICY_FINGERPRINT_FAILED";

  constructor(readonly reason: PromotionPolicyFingerprintFailureReason, message: string) {
    super(message);
    this.name = "PromotionPolicyFingerprintError";
  }
}

/** Final forensic allowlist: exact trusted modes, with no special bits. */
export function trustedPromotionPolicyMode(mode: number): boolean {
  const permissions = mode & 0o7777;
  return permissions === 0o600 || permissions === 0o640 || permissions === 0o644;
}

/** Semantic, bounded and no-follow policy proof used by installer expectations. */
export function fingerprintPromotionPolicyPath(
  path: string,
  deps: PromotionPolicyReadDependencies = {},
): string {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw policyFailure("open_failed", "Promotion policy state could not be opened safely");
  }
  try {
    let before: ReturnType<typeof fstatSync>;
    try {
      before = fstatSync(fd);
    } catch {
      throw policyFailure("open_failed", "Promotion policy state metadata could not be read");
    }
    const owner = targetUserOwnership();
    if (
      !before.isFile()
      || before.size <= 0
      || before.size > PROMOTION_POLICY_FILE_MAX_BYTES
      || !trustedPromotionPolicyMode(before.mode)
      || (owner !== null && before.uid !== owner.uid)
    ) {
      throw policyFailure("unsafe_metadata", "Promotion policy state must use trusted bounded file metadata");
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(fd);
    } catch {
      throw policyFailure("changed_during_read", "Promotion policy state could not be read stably");
    }
    deps.duringRead?.();
    let after: ReturnType<typeof fstatSync>;
    try {
      after = fstatSync(fd);
    } catch {
      throw policyFailure("changed_during_read", "Promotion policy state changed during observation");
    }
    if (
      bytes.byteLength !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.uid !== after.uid
      || (before.mode & 0o7777) !== (after.mode & 0o7777)
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw policyFailure("changed_during_read", "Promotion policy state changed during observation");
    }
    deps.afterRead?.();
    let current: ReturnType<typeof lstatSync>;
    try {
      current = lstatSync(path);
    } catch {
      throw policyFailure("path_changed", "Promotion policy state path changed during observation");
    }
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.dev !== after.dev
      || current.ino !== after.ino
      || current.uid !== after.uid
      || (current.mode & 0o7777) !== (after.mode & 0o7777)
      || current.size !== after.size
      || current.mtimeMs !== after.mtimeMs
      || current.ctimeMs !== after.ctimeMs
    ) {
      throw policyFailure("path_changed", "Promotion policy state path changed during observation");
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw policyFailure("invalid_utf8", "Promotion policy state must be valid UTF-8");
    }
    let canonical: string;
    try {
      canonical = canonicalPromotionPolicyText(raw);
    } catch (error) {
      throw classifyCanonicalPolicyFailure(error);
    }
    return createHash("sha256").update(PROMOTION_POLICY_HASH_DOMAIN).update(canonical).digest("hex");
  } finally {
    closeSync(fd);
  }
}

function policyFailure(
  reason: PromotionPolicyFingerprintFailureReason,
  message: string,
): PromotionPolicyFingerprintError {
  return new PromotionPolicyFingerprintError(reason, message);
}

function classifyCanonicalPolicyFailure(error: unknown): PromotionPolicyFingerprintError {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("duplicate JSON key")) {
    return policyFailure("duplicate_json_key", "Promotion policy state contains a duplicate JSON key");
  }
  if (message.includes("valid JSON")) {
    return policyFailure("invalid_json", "Promotion policy state must be valid JSON");
  }
  return policyFailure("invalid_schema", "Promotion policy state schema is invalid");
}

/**
 * Codex config promotion proof. The desktop app stamps volatile bookkeeping
 * into config.toml on every boot (`last_updated = "…"` in marketplace
 * tables), so a raw byte hash can never survive the candidate health probe,
 * which must boot the app to observe the surface. Hash the content with those
 * volatile lines removed; every substantive edit (servers, enabled flags,
 * env, args) still changes the fingerprint. Paired with the runtime twin in
 * packages/runtime/src/promotion-policy.ts — keep both byte-identical.
 */
export function fingerprintPromotionCodexConfigPath(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  const canonical = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => !/^\s*last_updated\s*=/.test(line))
    .join("\n");
  return createHash("sha256")
    .update("tweakers-promotion-codex-config-v1\0")
    .update(canonical)
    .digest("hex");
}
