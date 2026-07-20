import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readDesktopUpdateReceipt,
  type DesktopUpdateReceipt,
} from "./desktop-update-transaction.js";
import { desktopReceiptBlocksLifecycle } from "./desktop-update-state.js";
import type { UserPaths } from "./paths.js";

export const DESKTOP_UPDATE_DIAGNOSTIC_STALE_MS = 5 * 60_000;
export const DESKTOP_UPDATE_DEBUG_TAIL_BYTES = 32 * 1024;
export const DESKTOP_UPDATE_DEBUG_TAIL_LINES = 40;

export interface DesktopUpdateDiagnostics {
  receiptPath: string;
  archiveRoot: string;
  heartbeatPath: string;
  logPath: string;
  receipt: DesktopUpdateReceipt | null;
  receiptError: string | null;
  blocking: boolean;
  stale: boolean;
  unsafe: boolean;
  logTail: string[];
}

export function collectDesktopUpdateDiagnostics(
  paths: Pick<UserPaths, "root"> & Partial<UserPaths>,
  options: {
    nowMs?: number;
    maxTailBytes?: number;
    maxTailLines?: number;
    homeDir?: string;
  } = {},
): DesktopUpdateDiagnostics {
  const receiptPath = paths.desktopUpdateReceiptFile
    ?? join(paths.root, "transactions", "desktop-update.json");
  const archiveRoot = paths.desktopUpdateArchiveRoot
    ?? join(paths.root, "transactions", "desktop-update");
  const heartbeatPath = paths.desktopUpdateHeartbeatFile
    ?? join(paths.root, "transactions", "desktop-update.heartbeat.json");
  const logPath = paths.desktopUpdateLogFile
    ?? join(paths.root, "log", "desktop-update.log");
  let receipt: DesktopUpdateReceipt | null = null;
  let receiptError: string | null = null;
  try {
    receipt = readDesktopUpdateReceipt(receiptPath);
  } catch (error) {
    receiptError = error instanceof Error ? error.message : String(error);
  }
  const blocking = receiptError !== null
    || (receipt !== null && desktopReceiptBlocksLifecycle(receipt));
  const updatedAt = receipt === null ? Number.NaN : Date.parse(receipt.updatedAt);
  const nowMs = options.nowMs ?? Date.now();
  const stale = blocking
    && Number.isFinite(updatedAt)
    && updatedAt <= nowMs
    && nowMs - updatedAt > DESKTOP_UPDATE_DIAGNOSTIC_STALE_MS;
  const unsafe = receiptError !== null
    || (
      receipt !== null
      && receipt.phase === "failed"
      && (
        receipt.safeOfficialMode !== true
        || /\brollback failed\b/i.test(receipt.error ?? "")
      )
    );

  return {
    receiptPath,
    archiveRoot,
    heartbeatPath,
    logPath,
    receipt,
    receiptError,
    blocking,
    stale,
    unsafe,
    logTail: readBoundedRedactedLogTail(logPath, {
      userRoot: paths.root,
      homeDir: options.homeDir ?? homedir(),
      maxBytes: options.maxTailBytes ?? DESKTOP_UPDATE_DEBUG_TAIL_BYTES,
      maxLines: options.maxTailLines ?? DESKTOP_UPDATE_DEBUG_TAIL_LINES,
    }),
  };
}

export function readBoundedRedactedLogTail(
  logPath: string,
  options: {
    userRoot: string;
    homeDir: string;
    maxBytes: number;
    maxLines: number;
  },
): string[] {
  if (!existsSync(logPath)) return [];
  try {
    const content = readFileSync(logPath);
    const maxBytes = Math.max(0, Math.floor(options.maxBytes));
    const start = Math.max(0, content.byteLength - maxBytes);
    let text = content.subarray(start).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    const roots = [
      { path: options.userRoot, replacement: "[user-root]" },
      { path: options.homeDir, replacement: "[home]" },
    ]
      .filter((entry, index, all) => (
        entry.path.length > 0
        && all.findIndex((candidate) => candidate.path === entry.path) === index
      ))
      .sort((left, right) => right.path.length - left.path.length);
    for (const root of roots) text = text.split(root.path).join(root.replacement);
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-Math.max(0, Math.floor(options.maxLines)));
  } catch {
    return [];
  }
}
