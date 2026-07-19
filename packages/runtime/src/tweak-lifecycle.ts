export type TweakScope = "renderer" | "main" | "both";

/**
 * Lifecycle states are deliberately more detailed than the user-facing
 * installed/enabled status.  A tweak may be visible as enabled while its
 * asynchronous start is still in flight, or as failed after another tweak
 * has already reached ready.
 */
export const TWEAK_LIFECYCLE_STATUSES = [
  "starting",
  "ready",
  "failed",
  "timed_out",
  "disabled",
  "quarantined",
] as const;
export type TweakLifecycleStatus = (typeof TWEAK_LIFECYCLE_STATUSES)[number];
export type TweakProcess = "main" | "renderer";

export interface TweakLifecycleRecord {
  id: string;
  process: TweakProcess;
  status: TweakLifecycleStatus;
  attemptId: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Consecutive startup attempts cut short by a process exit; reset by a successful ready. */
  interruptedAttempts?: number;
}

export interface TweakLifecycleAttempt {
  id: string;
  pid?: number;
  startedAt: string;
  completedAt?: string;
}

export interface TweakLifecycleJournal {
  schemaVersion: 1;
  currentAttempt: TweakLifecycleAttempt | null;
  records: Record<string, TweakLifecycleRecord>;
}

export function createTweakLifecycleJournal(
  attemptId = `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  pid?: number,
  startedAt = new Date().toISOString(),
): TweakLifecycleJournal {
  return {
    schemaVersion: 1,
    currentAttempt: { id: attemptId, pid, startedAt },
    records: {},
  };
}

export const DEFAULT_TWEAK_STARTUP_TIMEOUT_MS = 5_000;
export const MIN_TWEAK_STARTUP_TIMEOUT_MS = 100;
export const MAX_TWEAK_STARTUP_TIMEOUT_MS = 30_000;

export function normalizeTweakStartupTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TWEAK_STARTUP_TIMEOUT_MS;
  }
  return Math.min(
    MAX_TWEAK_STARTUP_TIMEOUT_MS,
    Math.max(MIN_TWEAK_STARTUP_TIMEOUT_MS, Math.round(value)),
  );
}

/**
 * Race a tweak's startup promise against a bounded timeout.  The original
 * promise is observed after the timeout so a late rejection cannot become an
 * unhandled rejection, while the caller is free to continue loading sibling
 * tweaks immediately.
 */
export async function withStartupTimeout<T>(
  value: PromiseLike<T> | T,
  timeoutMs: number = DEFAULT_TWEAK_STARTUP_TIMEOUT_MS,
): Promise<{ status: "ready"; value: T } | { status: "timed_out" }> {
  const normalizedTimeoutMs = normalizeTweakStartupTimeoutMs(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = Promise.resolve(value);
  const timeout = new Promise<{ status: "timed_out" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), normalizedTimeoutMs);
  });
  try {
    const result = await Promise.race([
      promise.then((resolved) => ({ status: "ready" as const, value: resolved })),
      timeout,
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    // Attach a rejection observer even when timeout won.  This intentionally
    // does not await the late result.
    void promise.catch(() => undefined);
  }
}

/** Convenience form for callers that have a lazy start operation. */
export function runWithStartupTimeout<T>(
  start: () => PromiseLike<T> | T,
  timeoutMs: number = DEFAULT_TWEAK_STARTUP_TIMEOUT_MS,
): Promise<{ status: "ready"; value: T } | { status: "timed_out" }> {
  let value: PromiseLike<T> | T;
  try {
    value = start();
  } catch (error) {
    return Promise.reject(error);
  }
  return withStartupTimeout(value, timeoutMs);
}

export function lifecycleRecordKey(process: TweakProcess, id: string): string {
  return `${process}:${id}`;
}

/**
 * Bind a main-process tweak's `stop()` to the tweak object so cleanup that
 * relies on `this` (per-instance disposers, IPC handle removers) works. The
 * renderer host binds stop the same way (preload/tweak-host.ts); the main
 * runtime historically stored it unbound, silently breaking `this`-based main
 * cleanup for `scope: "both"` tweaks (followup).
 */
export function bindMainTweakStop<T extends { stop?: (...args: unknown[]) => unknown }>(
  tweak: T | null | undefined,
): T["stop"] | undefined {
  if (!tweak || typeof tweak.stop !== "function") return tweak?.stop;
  return tweak.stop.bind(tweak) as T["stop"];
}

/**
 * A whole-app restart racing the sequential tweak-load loop leaves innocent
 * tweaks in "starting"; only repeated interruptions indicate the tweak itself
 * is hanging startup. One interruption is therefore retried, not quarantined.
 */
export const INTERRUPTED_ATTEMPTS_BEFORE_QUARANTINE = 2;

/**
 * Turn a journal from a previous process into explicit records. Only records
 * from the unfinished current attempt are changed; historical ready/failed
 * records remain available for diagnostics. A first interruption becomes a
 * retryable "failed"; INTERRUPTED_ATTEMPTS_BEFORE_QUARANTINE consecutive
 * interruptions quarantine the tweak.
 */
export function recoverInterruptedTweaks(
  journal: TweakLifecycleJournal,
  now = new Date().toISOString(),
): TweakLifecycleJournal {
  const currentAttempt = journal.currentAttempt;
  if (!currentAttempt || currentAttempt.completedAt) return journal;
  const records = { ...journal.records };
  for (const [key, record] of Object.entries(records)) {
    if (record.attemptId !== currentAttempt.id) continue;
    if (record.status !== "starting") continue;
    const interruptedAttempts = (record.interruptedAttempts ?? 0) + 1;
    const quarantine = interruptedAttempts >= INTERRUPTED_ATTEMPTS_BEFORE_QUARANTINE;
    records[key] = {
      ...record,
      status: quarantine ? "quarantined" : "failed",
      interruptedAttempts,
      updatedAt: now,
      finishedAt: now,
      error: record.error ?? (quarantine
        ? `startup was interrupted ${interruptedAttempts} times in a row`
        : "previous startup attempt was interrupted; will retry"),
    };
  }
  return { ...journal, currentAttempt: { ...currentAttempt, completedAt: now }, records };
}

export interface ReloadTweaksDeps {
  logInfo(message: string): void;
  stopAllMainTweaks(): void;
  clearTweakModuleCache(): void;
  loadAllMainTweaks(): void | Promise<void>;
  broadcastReload(): void;
}

export interface SetTweakEnabledAndReloadDeps extends ReloadTweaksDeps {
  setTweakEnabled(id: string, enabled: boolean): void;
}

export function isMainProcessTweakScope(scope: TweakScope | undefined): boolean {
  return scope !== "renderer";
}

let reloadSequence: Promise<void> = Promise.resolve();

export function loadTweaksInitially(
  deps: Pick<ReloadTweaksDeps, "loadAllMainTweaks">,
): Promise<void> {
  const run = async (): Promise<void> => {
    await deps.loadAllMainTweaks();
  };
  const operation = reloadSequence.then(run, run);
  reloadSequence = operation.catch(() => {});
  return operation;
}

export function reloadTweaks(reason: string, deps: ReloadTweaksDeps): Promise<void> {
  const run = async (): Promise<void> => {
    deps.logInfo(`reloading tweaks (${reason})`);
    deps.stopAllMainTweaks();
    deps.clearTweakModuleCache();
    await deps.loadAllMainTweaks();
    deps.broadcastReload();
  };
  const operation = reloadSequence.then(run, run);
  reloadSequence = operation.catch(() => {});
  return operation;
}

export async function setTweakEnabledAndReload(
  id: string,
  enabled: unknown,
  deps: SetTweakEnabledAndReloadDeps,
): Promise<true> {
  const normalizedEnabled = !!enabled;
  deps.setTweakEnabled(id, normalizedEnabled);
  deps.logInfo(`tweak ${id} enabled=${normalizedEnabled}`);
  await reloadTweaks("enabled-toggle", deps);
  return true;
}
