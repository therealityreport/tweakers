import { type OpaqueAccountId, type RouterConfigV2, type RouterConfigV3, type RouterState } from "./types";
/** Offline-published evidence names. The runtime only verifies them. */
export declare const ACCOUNT_HISTORY_ADOPTION_INTENT_FILE: "history-adoption-intent.v1.json";
export declare const ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE: "history-adoption-receipt.v1.json";
export declare const ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE: "history-adoption-owners.v1.json";
export declare const HISTORY_ADOPTION_MAX_ARTIFACT_BYTES: number;
export declare const HISTORY_ADOPTION_MAX_OWNERS_BYTES: number;
declare const DATABASE_NAMES: readonly ["goals_1.sqlite", "logs_2.sqlite", "memories_1.sqlite", "queue_1.sqlite", "state_5.sqlite", "thread_history_1.sqlite"];
declare const HISTORY_NAMES: readonly ["archived_sessions", "session_index.jsonl", "sessions"];
type DatabaseName = typeof DATABASE_NAMES[number];
type HistoryName = typeof HISTORY_NAMES[number];
type HmacSha256 = `hmac-sha256:${string}`;
export interface HistoryAdoptionIntentV1 {
    schemaVersion: 1;
    kind: "account-router-history-adoption-intent";
    protocolFingerprint: `sha256:${string}`;
    poolFingerprint: `sha256:${string}`;
    configGeneration: number;
    configFingerprint: `sha256:${string}`;
    legacyOwnerOpaqueAccountId: OpaqueAccountId;
    createdAt: string;
    hmac: HmacSha256;
}
export interface HistoryAdoptionOwnersV1 {
    schemaVersion: 1;
    kind: "account-router-history-adoption-owners";
    protocolFingerprint: `sha256:${string}`;
    poolFingerprint: `sha256:${string}`;
    legacyOwnerOpaqueAccountId: OpaqueAccountId;
    threadIds: readonly string[];
    threadOwnersFingerprint: `sha256:${string}`;
    adoptedAt: string;
    hmac: HmacSha256;
}
export interface HistoryAdoptionDatabaseEntry {
    name: DatabaseName;
    present: boolean;
    sha256: `sha256:${string}` | null;
    bytes: number;
    integrity: "ok" | null;
}
export interface HistoryAdoptionHistoryEntry {
    name: HistoryName;
    present: boolean;
    sha256: `sha256:${string}` | null;
    bytes: number;
    fileCount: number;
}
export interface HistoryAdoptionReceiptV1 {
    schemaVersion: 1;
    kind: "account-router-history-adoption-receipt";
    protocolFingerprint: `sha256:${string}`;
    poolFingerprint: `sha256:${string}`;
    intentFingerprint: `sha256:${string}`;
    legacyOwnerOpaqueAccountId: OpaqueAccountId;
    sourceFingerprint: `sha256:${string}`;
    destinationFingerprint: `sha256:${string}`;
    databases: readonly HistoryAdoptionDatabaseEntry[];
    histories: readonly HistoryAdoptionHistoryEntry[];
    importedThreadCount: number;
    threadOwnersFingerprint: `sha256:${string}`;
    backupFingerprint: `sha256:${string}`;
    adoptedAt: string;
    hmac: HmacSha256;
}
export type HistoryAdoptionFailure = "history_adoption_required" | "history_adoption_invalid" | "history_adoption_hmac_invalid" | "history_adoption_config_mismatch" | "history_adoption_state_mismatch" | "history_adoption_artifact_mismatch";
export interface HistoryAdoptionEvidence {
    intent: HistoryAdoptionIntentV1;
    owners: HistoryAdoptionOwnersV1;
    receipt: HistoryAdoptionReceiptV1;
}
export type HistoryAdoptionValidationResult = {
    ok: true;
    evidence: HistoryAdoptionEvidence;
} | {
    ok: false;
    reason: HistoryAdoptionFailure;
};
/** Recursively key-sorted JSON shared with the offline publisher, without an import boundary. */
export declare function canonicalJson(value: unknown): string;
export declare function historyAdoptionPoolFingerprint(protocolFingerprint: `sha256:${string}`, accountOpaqueIds: readonly OpaqueAccountId[]): `sha256:${string}`;
export declare function historyAdoptionIntentFingerprint(intent: Omit<HistoryAdoptionIntentV1, "hmac"> | HistoryAdoptionIntentV1): `sha256:${string}`;
export declare function historyAdoptionThreadOwnersFingerprint(threadIds: readonly string[], legacyOwnerOpaqueAccountId: OpaqueAccountId): `sha256:${string}`;
export declare function parseHistoryAdoptionIntent(bytes: Buffer | string): HistoryAdoptionIntentV1;
export declare function parseHistoryAdoptionOwners(bytes: Buffer | string): HistoryAdoptionOwnersV1;
export declare function parseHistoryAdoptionReceipt(bytes: Buffer | string): HistoryAdoptionReceiptV1;
export declare function verifyHistoryAdoptionIntent(intent: HistoryAdoptionIntentV1, secret: Buffer): boolean;
export declare function verifyHistoryAdoptionOwners(owners: HistoryAdoptionOwnersV1, secret: Buffer): boolean;
export declare function verifyHistoryAdoptionReceipt(receipt: HistoryAdoptionReceiptV1, secret: Buffer): boolean;
/**
 * Validates immutable offline evidence against the active v2 intent and the
 * strict durable owner state. It deliberately accepts later non-historical
 * thread owner growth; only the signed manifest subset is required here.
 */
export declare function validateHistoryAdoptionEvidence(config: RouterConfigV2 | RouterConfigV3, state: RouterState, secret: Buffer, raw: {
    intent: Buffer;
    owners: Buffer;
    receipt: Buffer;
}): HistoryAdoptionValidationResult;
/**
 * Startup only checks artifact shape and private ownership; replaying hashes
 * would both be expensive and invalidate ordinary future history writes.
 */
export declare function validateHistoryAdoptionArtifacts(receipt: HistoryAdoptionReceiptV1, ownerCodexHome: string, ownerSqliteHome: string): boolean;
export {};
