import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  captureWatcherPromotionSnapshot,
  pauseWatcherForPromotion,
  resumeWatcherAfterPromotion,
  type WatcherPromotionSnapshot,
} from "./watcher.js";

export const WATCHER_PROMOTION_SCHEMA_VERSION = 1 as const;

export type WatcherPromotionPhase = "pausing" | "paused" | "resuming" | "resumed" | "failed";

export interface WatcherPromotionReceipt {
  schemaVersion: typeof WATCHER_PROMOTION_SCHEMA_VERSION;
  kind: "watcher-promotion";
  transactionId: string;
  phase: WatcherPromotionPhase;
  sourceAppRoot: string;
  requestedAppRoot: string;
  activeTargetAppRoot: string | null;
  sourceExpectedFingerprint: string;
  targetExpectedFingerprint: string | null;
  snapshot: WatcherPromotionSnapshot;
  createdAt: string;
  updatedAt: string;
  pausedAt: string | null;
  resumedAt: string | null;
  error: string | null;
}

export interface WatcherPromotionDeps {
  now?: () => string;
  capture?: () => WatcherPromotionSnapshot;
  pause?: (snapshot: WatcherPromotionSnapshot) => void;
  resume?: (appRoot: string, snapshot: WatcherPromotionSnapshot) => void;
}

export function beginWatcherPromotion(
  file: string,
  input: {
    transactionId: string;
    sourceAppRoot: string;
    requestedAppRoot: string;
    sourceExpectedFingerprint: string;
  },
  deps: WatcherPromotionDeps = {},
): WatcherPromotionReceipt {
  const now = deps.now ?? (() => new Date().toISOString());
  const capture = deps.capture ?? captureWatcherPromotionSnapshot;
  const pause = deps.pause ?? pauseWatcherForPromotion;
  const existing = readWatcherPromotionReceipt(file);
  if (existing !== null && existing.transactionId === input.transactionId) {
    if (existing.phase === "paused") return existing;
    if (existing.phase === "pausing") return finishPause(file, existing, pause, now);
    if (existing.phase === "resuming") {
      throw new Error(
        `Watcher promotion ${input.transactionId} is still resuming; recover it before starting another cutover step`,
      );
    }
    if (existing.phase === "failed") {
      if (existing.activeTargetAppRoot === null) {
        throw new Error(`Watcher promotion ${input.transactionId} previously failed: ${existing.error ?? "unknown failure"}`);
      }
      const retryPause: WatcherPromotionReceipt = {
        ...existing,
        phase: "pausing",
        activeTargetAppRoot: null,
        targetExpectedFingerprint: null,
        updatedAt: now(),
        error: null,
      };
      writeWatcherPromotionReceipt(file, retryPause);
      return finishPause(file, retryPause, pause, now);
    }
  } else if (existing !== null && !isTerminalWatcherPromotionPhase(existing.phase)) {
    throw new Error(
      `Watcher promotion ${existing.transactionId} is still ${existing.phase}; refusing transaction ${input.transactionId}`,
    );
  }

  const timestamp = now();
  const receipt: WatcherPromotionReceipt = {
    schemaVersion: WATCHER_PROMOTION_SCHEMA_VERSION,
    kind: "watcher-promotion",
    transactionId: input.transactionId,
    phase: "pausing",
    sourceAppRoot: input.sourceAppRoot,
    requestedAppRoot: input.requestedAppRoot,
    activeTargetAppRoot: null,
    sourceExpectedFingerprint: input.sourceExpectedFingerprint,
    targetExpectedFingerprint: null,
    snapshot: capture(),
    createdAt: timestamp,
    updatedAt: timestamp,
    pausedAt: null,
    resumedAt: null,
    error: null,
  };
  writeWatcherPromotionReceipt(file, receipt);
  return finishPause(file, receipt, pause, now);
}

export function finishWatcherPromotion(
  file: string,
  input: { transactionId: string; targetAppRoot: string; targetExpectedFingerprint: string },
  deps: WatcherPromotionDeps = {},
): WatcherPromotionReceipt {
  const now = deps.now ?? (() => new Date().toISOString());
  const resume = deps.resume ?? ((appRoot, snapshot) => { resumeWatcherAfterPromotion(appRoot, snapshot); });
  const existing = readWatcherPromotionReceipt(file);
  if (existing === null || existing.transactionId !== input.transactionId) {
    throw new Error(`Watcher promotion receipt does not match environment transaction ${input.transactionId}`);
  }
  if (existing.phase === "resumed") {
    if (existing.activeTargetAppRoot !== input.targetAppRoot
      || existing.targetExpectedFingerprint !== input.targetExpectedFingerprint) {
      throw new Error("Watcher promotion was already resumed for different target evidence");
    }
    return existing;
  }
  if (existing.phase === "failed"
    && (existing.activeTargetAppRoot !== input.targetAppRoot
      || existing.targetExpectedFingerprint !== input.targetExpectedFingerprint)) {
    throw new Error("Failed watcher resume evidence does not match the requested retry target");
  }
  if (existing.phase !== "paused" && existing.phase !== "resuming" && existing.phase !== "failed") {
    throw new Error(`Watcher promotion ${input.transactionId} cannot resume from phase ${existing.phase}`);
  }
  let receipt: WatcherPromotionReceipt = {
    ...existing,
    phase: "resuming",
    activeTargetAppRoot: input.targetAppRoot,
    targetExpectedFingerprint: input.targetExpectedFingerprint,
    updatedAt: now(),
    error: null,
  };
  writeWatcherPromotionReceipt(file, receipt);
  try {
    resume(input.targetAppRoot, receipt.snapshot);
    receipt = {
      ...receipt,
      phase: "resumed",
      updatedAt: now(),
      resumedAt: now(),
    };
    writeWatcherPromotionReceipt(file, receipt);
    return receipt;
  } catch (error) {
    receipt = {
      ...receipt,
      phase: "failed",
      updatedAt: now(),
      error: errorMessage(error),
    };
    writeWatcherPromotionReceipt(file, receipt);
    throw new Error(`Could not resume watcher after promotion: ${receipt.error}`);
  }
}

/** Finish an interrupted pause/resume idempotently before operator recovery. */
export function recoverWatcherPromotion(
  file: string,
  deps: WatcherPromotionDeps = {},
): WatcherPromotionReceipt | null {
  const receipt = readWatcherPromotionReceipt(file);
  if (receipt === null || receipt.phase === "paused" || receipt.phase === "resumed" || receipt.phase === "failed") {
    return receipt;
  }
  if (receipt.phase === "pausing") {
    return finishPause(
      file,
      receipt,
      deps.pause ?? pauseWatcherForPromotion,
      deps.now ?? (() => new Date().toISOString()),
    );
  }
  if (receipt.activeTargetAppRoot === null || receipt.targetExpectedFingerprint === null) {
    throw new Error("Interrupted watcher resume is missing its exact target evidence");
  }
  return finishWatcherPromotion(file, {
    transactionId: receipt.transactionId,
    targetAppRoot: receipt.activeTargetAppRoot,
    targetExpectedFingerprint: receipt.targetExpectedFingerprint,
  }, deps);
}

export function readWatcherPromotionReceipt(file: string): WatcherPromotionReceipt | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Watcher promotion receipt is unreadable at ${file}: ${errorMessage(error)}`);
  }
  if (!isWatcherPromotionReceipt(value)) {
    throw new Error(`Watcher promotion receipt is invalid at ${file}`);
  }
  return value;
}

export function writeWatcherPromotionReceipt(file: string, receipt: WatcherPromotionReceipt): void {
  if (!isWatcherPromotionReceipt(receipt)) throw new Error("Refusing to write an invalid watcher promotion receipt");
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function finishPause(
  file: string,
  initial: WatcherPromotionReceipt,
  pause: (snapshot: WatcherPromotionSnapshot) => void,
  now: () => string,
): WatcherPromotionReceipt {
  let receipt = initial;
  try {
    pause(receipt.snapshot);
    receipt = {
      ...receipt,
      phase: "paused",
      updatedAt: now(),
      pausedAt: now(),
      error: null,
    };
    writeWatcherPromotionReceipt(file, receipt);
    return receipt;
  } catch (error) {
    receipt = {
      ...receipt,
      phase: "failed",
      updatedAt: now(),
      error: errorMessage(error),
    };
    writeWatcherPromotionReceipt(file, receipt);
    throw new Error(`Could not pause watcher for promotion: ${receipt.error}`);
  }
}

function isTerminalWatcherPromotionPhase(phase: WatcherPromotionPhase): boolean {
  return phase === "resumed" || phase === "failed";
}

function isWatcherPromotionReceipt(value: unknown): value is WatcherPromotionReceipt {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Partial<WatcherPromotionReceipt>;
  return receipt.schemaVersion === WATCHER_PROMOTION_SCHEMA_VERSION
    && receipt.kind === "watcher-promotion"
    && typeof receipt.transactionId === "string"
    && ["pausing", "paused", "resuming", "resumed", "failed"].includes(receipt.phase ?? "")
    && typeof receipt.sourceAppRoot === "string"
    && typeof receipt.requestedAppRoot === "string"
    && (receipt.activeTargetAppRoot === null || typeof receipt.activeTargetAppRoot === "string")
    && typeof receipt.sourceExpectedFingerprint === "string"
    && (receipt.targetExpectedFingerprint === null || typeof receipt.targetExpectedFingerprint === "string")
    && isWatcherPromotionSnapshot(receipt.snapshot)
    && typeof receipt.createdAt === "string"
    && typeof receipt.updatedAt === "string"
    && (receipt.pausedAt === null || typeof receipt.pausedAt === "string")
    && (receipt.resumedAt === null || typeof receipt.resumedAt === "string")
    && (receipt.error === null || typeof receipt.error === "string");
}

function isWatcherPromotionSnapshot(value: unknown): value is WatcherPromotionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Partial<WatcherPromotionSnapshot>;
  return snapshot.schemaVersion === 1
    && snapshot.kind === "watcher-promotion-snapshot"
    && ["launchd", "login-item", "scheduled-task", "systemd", "none"].includes(snapshot.watcherKind ?? "")
    && typeof snapshot.configured === "boolean"
    && typeof snapshot.loaded === "boolean"
    && typeof snapshot.enabled === "boolean"
    && (snapshot.definitionPath === null || typeof snapshot.definitionPath === "string")
    && (snapshot.definitionDigest === null || typeof snapshot.definitionDigest === "string")
    && typeof snapshot.capturedAt === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
