/** Durable desktop-update receipt codec; no transaction or lifecycle coordinator. */
import { existsSync, readFileSync } from "node:fs";
import {
  isEnvironmentSelection,
  normalizeEnvironmentSelection,
  type EnvironmentSelection,
} from "./environment-profile.js";
import type { DesktopVersionIdentity } from "./desktop-version.js";

export const DESKTOP_UPDATE_SCHEMA_VERSION = 1 as const;

export type DesktopUpdatePhase =
  | "preparing"
  | "switching_to_chatgpt"
  | "awaiting_native_update"
  | "returning_to_tweakers"
  | "refreshing_runtime"
  | "verifying"
  | "completed"
  | "failed"
  | "rolled_back";

export type DesktopUpdateRefreshSource = "development" | "stable";

export interface DesktopUpdateReceipt {
  schemaVersion: typeof DESKTOP_UPDATE_SCHEMA_VERSION;
  kind: "desktop-update";
  transactionId: string;
  phase: DesktopUpdatePhase;
  ownerPid: number;
  /** Stable OS process-start identity. Missing on legacy receipts. */
  ownerToken?: string | null;
  /** Fresh fencing UUID for each explicit ownership claim. Missing on legacy receipts. */
  ownerGeneration?: string | null;
  source: EnvironmentSelection;
  official: EnvironmentSelection;
  baseline: DesktopVersionIdentity;
  observed: DesktopVersionIdentity | null;
  nativeUpdateHandoffAt: string | null;
  refreshSource: DesktopUpdateRefreshSource | null;
  environmentTransactionId: string | null;
  /** Additive discriminator for receipts created after sealed-pair switching shipped. */
  environmentTransactionKind?: "legacy" | "mode-cache-v2" | null;
  /** PID proven when the official environment was entered before native update. */
  officialMainPid?: number | null;
  safeOfficialMode: boolean;
  resumable: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Immutable time of the current terminal outcome. Additive schema-v1 field:
   * legacy receipts omit it and consumers fall back to updatedAt.
   */
  terminalAt?: string | null;
  /**
   * Audit time for abandoning the last recovery continuation. This must not
   * replace terminalAt or the causal terminal error.
   */
  continuationAbandonedAt?: string | null;
  completedAt: string | null;
  rolledBackAt: string | null;
}

export function readDesktopUpdateReceipt(file: string): DesktopUpdateReceipt | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Desktop update receipt is unreadable at ${file}: ${errorMessage(error)}`);
  }
  const normalized = normalizeNonResumableDesktopUpdateReceipt(value);
  if (!isDesktopUpdateReceipt(normalized)) throw new Error(`Desktop update receipt is invalid at ${file}`);
  return normalized;
}

/**
 * A non-resumable terminal desktop receipt is history only. Normalize its two
 * embedded schema-1 selections so an abandoned legacy update cannot poison
 * unrelated lifecycle work. Resumable and in-flight receipts stay byte-strict
 * because their selections may still control live recovery.
 */
function normalizeNonResumableDesktopUpdateReceipt(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const receipt = value as Record<string, unknown>;
  const terminal = receipt.phase === "completed"
    || receipt.phase === "rolled_back"
    || (receipt.phase === "failed" && receipt.resumable === false);
  if (!terminal) return value;
  const source = normalizeEnvironmentSelection(receipt.source);
  const official = normalizeEnvironmentSelection(receipt.official);
  if (source === null || official === null) return value;
  return { ...receipt, source, official };
}

export function isDesktopUpdateReceipt(value: unknown): value is DesktopUpdateReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<DesktopUpdateReceipt>;
  return receipt.schemaVersion === DESKTOP_UPDATE_SCHEMA_VERSION
    && receipt.kind === "desktop-update"
    && typeof receipt.transactionId === "string"
    && isDesktopUpdatePhase(receipt.phase)
    && typeof receipt.ownerPid === "number"
    && (receipt.ownerToken === undefined || receipt.ownerToken === null
      || typeof receipt.ownerToken === "string")
    && (receipt.ownerGeneration === undefined || receipt.ownerGeneration === null
      || typeof receipt.ownerGeneration === "string")
    && isEnvironmentSelection(receipt.source)
    && isEnvironmentSelection(receipt.official)
    && isDesktopVersion(receipt.baseline)
    && (receipt.observed === null || isDesktopVersion(receipt.observed))
    && (receipt.nativeUpdateHandoffAt === null || isIsoDate(receipt.nativeUpdateHandoffAt))
    && (receipt.refreshSource === null || receipt.refreshSource === "development" || receipt.refreshSource === "stable")
    && (receipt.environmentTransactionId === null || typeof receipt.environmentTransactionId === "string")
    && (receipt.environmentTransactionKind === undefined
      || receipt.environmentTransactionKind === null
      || receipt.environmentTransactionKind === "legacy"
      || receipt.environmentTransactionKind === "mode-cache-v2")
    && (receipt.officialMainPid === undefined || receipt.officialMainPid === null
      || (typeof receipt.officialMainPid === "number" && Number.isInteger(receipt.officialMainPid) && receipt.officialMainPid > 0))
    && typeof receipt.safeOfficialMode === "boolean"
    && typeof receipt.resumable === "boolean"
    && (receipt.error === null || typeof receipt.error === "string")
    && isIsoDate(receipt.createdAt)
    && isIsoDate(receipt.updatedAt)
    && (receipt.terminalAt === undefined || receipt.terminalAt === null || isIsoDate(receipt.terminalAt))
    && (receipt.continuationAbandonedAt === undefined
      || receipt.continuationAbandonedAt === null
      || isIsoDate(receipt.continuationAbandonedAt))
    && (receipt.completedAt === null || isIsoDate(receipt.completedAt))
    && (receipt.rolledBackAt === null || isIsoDate(receipt.rolledBackAt));
}

function isDesktopUpdatePhase(value: unknown): value is DesktopUpdatePhase {
  return typeof value === "string" && [
    "preparing",
    "switching_to_chatgpt",
    "awaiting_native_update",
    "returning_to_tweakers",
    "refreshing_runtime",
    "verifying",
    "completed",
    "failed",
    "rolled_back",
  ].includes(value);
}

function isDesktopVersion(value: unknown): value is DesktopVersionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const version = value as Partial<DesktopVersionIdentity>;
  return (version.marketingVersion === null || typeof version.marketingVersion === "string")
    && (version.build === null || typeof version.build === "string");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
