import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const DESKTOP_UPDATE_HEARTBEAT_SCHEMA_VERSION = 1 as const;
export const DESKTOP_UPDATE_HEARTBEAT_STALE_MS = 90_000;

export interface DesktopUpdateHeartbeat {
  schemaVersion: typeof DESKTOP_UPDATE_HEARTBEAT_SCHEMA_VERSION;
  transactionId: string;
  ownerPid: number;
  ownerToken: string;
  ownerGeneration: string;
  phase: string;
  beatAt: string;
}

export interface DesktopUpdateOwnerReceipt {
  transactionId: string;
  phase: string;
  ownerPid: number;
  ownerToken?: string | null;
  ownerGeneration?: string | null;
  updatedAt: string;
}

export interface DesktopUpdateOwnerLivenessInput {
  receipt: DesktopUpdateOwnerReceipt;
  heartbeat: DesktopUpdateHeartbeat | null;
  nowMs: number;
  processAlive(pid: number): boolean;
  readProcessStartToken(pid: number): string | null;
  staleAfterMs?: number;
}

export function desktopUpdateOwnerIsLive(input: DesktopUpdateOwnerLivenessInput): boolean {
  const { receipt } = input;
  if (!input.processAlive(receipt.ownerPid)) return false;

  // Receipts written before owner generations existed intentionally keep the
  // previous PID-only behavior until an explicit resume/reconcile claim.
  if (!receipt.ownerGeneration) return true;

  if (!receipt.ownerToken
    || input.readProcessStartToken(receipt.ownerPid) !== receipt.ownerToken) {
    return false;
  }

  // A stale heartbeat can only authorize takeover during the safe native
  // updater long poll. Bounded phases retain their live process owner.
  if (receipt.phase !== "awaiting_native_update") return true;

  const staleAfterMs = input.staleAfterMs ?? DESKTOP_UPDATE_HEARTBEAT_STALE_MS;
  const heartbeat = input.heartbeat;
  if (heartbeatMatchesReceipt(heartbeat, receipt)) {
    const beatMs = Date.parse(heartbeat.beatAt);
    if (Number.isFinite(beatMs) && beatMs <= input.nowMs) {
      return input.nowMs - beatMs <= staleAfterMs;
    }
    return false;
  }

  const receiptMs = Date.parse(receipt.updatedAt);
  return Number.isFinite(receiptMs)
    && receiptMs <= input.nowMs
    && input.nowMs - receiptMs <= staleAfterMs;
}

export function heartbeatMatchesReceipt(
  heartbeat: DesktopUpdateHeartbeat | null,
  receipt: DesktopUpdateOwnerReceipt,
): heartbeat is DesktopUpdateHeartbeat {
  return heartbeat !== null
    && heartbeat.transactionId === receipt.transactionId
    && heartbeat.ownerPid === receipt.ownerPid
    && heartbeat.ownerToken === receipt.ownerToken
    && heartbeat.ownerGeneration === receipt.ownerGeneration
    && heartbeat.phase === receipt.phase;
}

export function readDesktopUpdateHeartbeat(file: string): DesktopUpdateHeartbeat | null {
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isDesktopUpdateHeartbeat(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeDesktopUpdateHeartbeat(
  file: string,
  heartbeat: DesktopUpdateHeartbeat,
): void {
  if (!isDesktopUpdateHeartbeat(heartbeat)) {
    throw new Error("Refusing to write an invalid desktop update heartbeat");
  }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  let descriptor: number | null = null;
  try {
    rmSync(temporary, { force: true });
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(heartbeat)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Already closed after a successful fsync.
      }
    }
    rmSync(temporary, { force: true });
  }
}

export function removeDesktopUpdateHeartbeat(file: string): void {
  rmSync(file, { force: true });
}

function isDesktopUpdateHeartbeat(value: unknown): value is DesktopUpdateHeartbeat {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const heartbeat = value as Partial<DesktopUpdateHeartbeat>;
  return heartbeat.schemaVersion === DESKTOP_UPDATE_HEARTBEAT_SCHEMA_VERSION
    && typeof heartbeat.transactionId === "string"
    && Number.isInteger(heartbeat.ownerPid)
    && (heartbeat.ownerPid ?? 0) > 0
    && typeof heartbeat.ownerToken === "string"
    && heartbeat.ownerToken.length > 0
    && typeof heartbeat.ownerGeneration === "string"
    && heartbeat.ownerGeneration.length > 0
    && typeof heartbeat.phase === "string"
    && typeof heartbeat.beatAt === "string"
    && Number.isFinite(Date.parse(heartbeat.beatAt));
}
