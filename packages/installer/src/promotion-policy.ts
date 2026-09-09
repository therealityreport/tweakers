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

export interface PromotionPolicyPathComparison {
  preparedFingerprint: string;
  liveFingerprint: string;
  compatible: boolean;
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
  const canonical = readCanonicalPromotionPolicyPath(path, deps);
  return createHash("sha256").update(PROMOTION_POLICY_HASH_DOMAIN).update(canonical).digest("hex");
}

/**
 * Compare the prepared policy snapshot with the live state after the desktop
 * has intentionally quit and flushed its atoms.
 *
 * Existing prepared task identities remain fail-closed: removal or any
 * authorization change is incompatible. Codex may append a new task while a
 * candidate is being checked, because that task did not exist in the prepared
 * authorization surface. The desktop also persists the exact managed
 * full-access selection from `{ id: ":danger-full-access", extends: null }`
 * to `null` while retaining the durable approval and sandbox policies; those
 * two representations are equivalent only for that exact selection.
 */
export function comparePromotionPolicyPaths(
  preparedPath: string,
  livePath: string,
): PromotionPolicyPathComparison {
  const preparedCanonical = readCanonicalPromotionPolicyPath(preparedPath);
  const liveCanonical = readCanonicalPromotionPolicyPath(livePath);
  return {
    preparedFingerprint: promotionPolicyFingerprint(preparedCanonical),
    liveFingerprint: promotionPolicyFingerprint(liveCanonical),
    compatible: compatiblePromotionPolicyProjection(preparedCanonical, liveCanonical),
  };
}

function readCanonicalPromotionPolicyPath(
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
    return canonical;
  } finally {
    closeSync(fd);
  }
}

function promotionPolicyFingerprint(canonical: string): string {
  return createHash("sha256").update(PROMOTION_POLICY_HASH_DOMAIN).update(canonical).digest("hex");
}

interface CanonicalPolicySlot<T> {
  present: boolean;
  value?: T;
}

interface CanonicalThreadPermissionRecord {
  activePermissionProfile: CanonicalPolicySlot<unknown>;
  approvalPolicy: CanonicalPolicySlot<unknown>;
  sandboxPolicy: CanonicalPolicySlot<unknown>;
  approvalsReviewer: CanonicalPolicySlot<unknown>;
  runtimeWorkspaceRoots: CanonicalPolicySlot<unknown>;
}

interface CanonicalPromotionPolicyProjection {
  schemaVersion: number;
  mcpFormElicitationsEnabled: CanonicalPolicySlot<unknown>;
  persistedAtoms: {
    present: boolean;
    agentModes: {
      present: boolean;
      local: CanonicalPolicySlot<unknown>;
    };
    threadPermissions: CanonicalPolicySlot<Array<[string, CanonicalThreadPermissionRecord]>>;
  };
}

function compatiblePromotionPolicyProjection(preparedCanonical: string, liveCanonical: string): boolean {
  const prepared = JSON.parse(preparedCanonical) as CanonicalPromotionPolicyProjection;
  const live = JSON.parse(liveCanonical) as CanonicalPromotionPolicyProjection;
  if (prepared.schemaVersion !== live.schemaVersion
    || JSON.stringify(prepared.mcpFormElicitationsEnabled) !== JSON.stringify(live.mcpFormElicitationsEnabled)
    || JSON.stringify(prepared.persistedAtoms.agentModes.local)
      !== JSON.stringify(live.persistedAtoms.agentModes.local)) {
    return false;
  }

  const preparedThreads = canonicalThreadPermissionMap(prepared.persistedAtoms.threadPermissions);
  const liveThreads = canonicalThreadPermissionMap(live.persistedAtoms.threadPermissions);
  for (const [threadId, preparedRecord] of preparedThreads) {
    const liveRecord = liveThreads.get(threadId);
    if (liveRecord === undefined
      || JSON.stringify(normalizeManagedFullAccessSelection(preparedRecord))
        !== JSON.stringify(normalizeManagedFullAccessSelection(liveRecord))) {
      return false;
    }
  }
  return true;
}

function canonicalThreadPermissionMap(
  slot: CanonicalPolicySlot<Array<[string, CanonicalThreadPermissionRecord]>>,
): Map<string, CanonicalThreadPermissionRecord> {
  return new Map(slot.present ? slot.value ?? [] : []);
}

function normalizeManagedFullAccessSelection(
  record: CanonicalThreadPermissionRecord,
): CanonicalThreadPermissionRecord {
  if (!isExactManagedFullAccessProfile(record.activePermissionProfile)) return record;
  return {
    ...record,
    activePermissionProfile: { present: true, value: null },
  };
}

function isExactManagedFullAccessProfile(slot: CanonicalPolicySlot<unknown>): boolean {
  if (!slot.present || slot.value === null || typeof slot.value !== "object" || Array.isArray(slot.value)) {
    return false;
  }
  const profile = slot.value as Record<string, unknown>;
  const keys = Object.keys(profile).sort();
  return keys.length === 2
    && keys[0] === "extends"
    && keys[1] === "id"
    && profile.id === ":danger-full-access"
    && profile.extends === null;
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
