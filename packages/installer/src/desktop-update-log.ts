import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { DesktopUpdatePhase } from "./desktop-update-transaction.js";

export const DESKTOP_UPDATE_LOG_SCHEMA_VERSION = 1 as const;
export const MAX_DESKTOP_UPDATE_ERROR_CHARS = 2_048;
export const MAX_DESKTOP_UPDATE_LOG_BYTES = 10 * 1024 * 1024;

export type DesktopUpdateLogEvent =
  | "owner_started"
  | "phase_transition"
  | "owner_completed"
  | "handled_failure";

export interface DesktopUpdateLogInput {
  transactionId: string;
  phase: DesktopUpdatePhase;
  ownerPid: number;
  ownerToken: string | null;
  ownerGeneration: string | null;
  event: DesktopUpdateLogEvent;
  error?: unknown;
  jobLabel?: string | null;
}

export interface DesktopUpdateLogRecord {
  schemaVersion: typeof DESKTOP_UPDATE_LOG_SCHEMA_VERSION;
  ts: string;
  transactionId: string;
  phase: DesktopUpdatePhase;
  ownerPid: number;
  ownerToken: string | null;
  ownerGeneration: string | null;
  event: DesktopUpdateLogEvent;
  error?: string;
  jobLabel?: string;
}

export interface DesktopUpdateLogOptions {
  now?: () => string;
  userRoot?: string;
  homeDir?: string;
  maxErrorChars?: number;
  maxBytes?: number;
}

export function appendDesktopUpdateLog(
  logPath: string,
  input: DesktopUpdateLogInput,
  options: DesktopUpdateLogOptions = {},
): DesktopUpdateLogRecord {
  const roots = redactionRoots(options.userRoot, options.homeDir ?? homedir());
  const record: DesktopUpdateLogRecord = {
    schemaVersion: DESKTOP_UPDATE_LOG_SCHEMA_VERSION,
    ts: options.now?.() ?? new Date().toISOString(),
    transactionId: redact(input.transactionId, roots),
    phase: input.phase,
    ownerPid: input.ownerPid,
    ownerToken: input.ownerToken === null ? null : redact(input.ownerToken, roots),
    ownerGeneration: input.ownerGeneration === null ? null : redact(input.ownerGeneration, roots),
    event: input.event,
    ...(input.error === undefined
      ? {}
      : {
          error: bound(
            redact(errorText(input.error), roots),
            options.maxErrorChars ?? MAX_DESKTOP_UPDATE_ERROR_CHARS,
          ),
        }),
    ...(input.jobLabel === null || input.jobLabel === undefined
      ? {}
      : { jobLabel: redact(input.jobLabel, roots) }),
  };

  const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  mkdirSync(dirname(logPath), { recursive: true });
  rotateBeforeAppend(
    logPath,
    line.byteLength,
    options.maxBytes ?? MAX_DESKTOP_UPDATE_LOG_BYTES,
  );
  const fd = openSync(logPath, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
  return record;
}

function rotateBeforeAppend(logPath: string, incomingBytes: number, maxBytes: number): void {
  if (!existsSync(logPath)) return;
  const cap = Math.max(0, Math.floor(maxBytes));
  const size = statSync(logPath).size;
  if (size + incomingBytes <= cap) return;

  const existing = readFileSync(logPath);
  const retainedBytes = Math.max(0, cap - incomingBytes);
  const tail = existing.subarray(Math.max(0, existing.byteLength - retainedBytes));
  // Byte rotation intentionally permits the first retained line to be partial.
  // Readers must skip that fragment and can still consume every later JSONL row.
  writeFileSync(logPath, tail, { mode: 0o600 });
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function redactionRoots(userRoot: string | undefined, homeDir: string): Array<{
  path: string;
  replacement: string;
}> {
  const roots = [
    userRoot ? { path: userRoot, replacement: "[user-root]" } : null,
    homeDir ? { path: homeDir, replacement: "[home]" } : null,
  ].filter((value): value is { path: string; replacement: string } => value !== null);
  return roots
    .filter((root, index) => roots.findIndex((candidate) => candidate.path === root.path) === index)
    .sort((left, right) => right.path.length - left.path.length);
}

function redact(text: string, roots: ReadonlyArray<{ path: string; replacement: string }>): string {
  let redacted = text;
  for (const root of roots) {
    redacted = redacted.split(root.path).join(root.replacement);
  }
  return redacted;
}

function bound(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  if (limit === 0) return "";
  return `${text.slice(0, limit - 1)}…`;
}
