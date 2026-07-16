"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTERRUPTED_ATTEMPTS_BEFORE_QUARANTINE = exports.MAX_TWEAK_STARTUP_TIMEOUT_MS = exports.MIN_TWEAK_STARTUP_TIMEOUT_MS = exports.DEFAULT_TWEAK_STARTUP_TIMEOUT_MS = exports.TWEAK_LIFECYCLE_STATUSES = void 0;
exports.createTweakLifecycleJournal = createTweakLifecycleJournal;
exports.normalizeTweakStartupTimeoutMs = normalizeTweakStartupTimeoutMs;
exports.withStartupTimeout = withStartupTimeout;
exports.runWithStartupTimeout = runWithStartupTimeout;
exports.lifecycleRecordKey = lifecycleRecordKey;
exports.bindMainTweakStop = bindMainTweakStop;
exports.recoverInterruptedTweaks = recoverInterruptedTweaks;
exports.isMainProcessTweakScope = isMainProcessTweakScope;
exports.reloadTweaks = reloadTweaks;
exports.setTweakEnabledAndReload = setTweakEnabledAndReload;
/**
 * Lifecycle states are deliberately more detailed than the user-facing
 * installed/enabled status.  A tweak may be visible as enabled while its
 * asynchronous start is still in flight, or as failed after another tweak
 * has already reached ready.
 */
exports.TWEAK_LIFECYCLE_STATUSES = [
    "starting",
    "ready",
    "failed",
    "timed_out",
    "disabled",
    "quarantined",
];
function createTweakLifecycleJournal(attemptId = `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`, pid, startedAt = new Date().toISOString()) {
    return {
        schemaVersion: 1,
        currentAttempt: { id: attemptId, pid, startedAt },
        records: {},
    };
}
exports.DEFAULT_TWEAK_STARTUP_TIMEOUT_MS = 5_000;
exports.MIN_TWEAK_STARTUP_TIMEOUT_MS = 100;
exports.MAX_TWEAK_STARTUP_TIMEOUT_MS = 30_000;
function normalizeTweakStartupTimeoutMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return exports.DEFAULT_TWEAK_STARTUP_TIMEOUT_MS;
    }
    return Math.min(exports.MAX_TWEAK_STARTUP_TIMEOUT_MS, Math.max(exports.MIN_TWEAK_STARTUP_TIMEOUT_MS, Math.round(value)));
}
/**
 * Race a tweak's startup promise against a bounded timeout.  The original
 * promise is observed after the timeout so a late rejection cannot become an
 * unhandled rejection, while the caller is free to continue loading sibling
 * tweaks immediately.
 */
async function withStartupTimeout(value, timeoutMs = exports.DEFAULT_TWEAK_STARTUP_TIMEOUT_MS) {
    const normalizedTimeoutMs = normalizeTweakStartupTimeoutMs(timeoutMs);
    let timer;
    const promise = Promise.resolve(value);
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed_out" }), normalizedTimeoutMs);
    });
    try {
        const result = await Promise.race([
            promise.then((resolved) => ({ status: "ready", value: resolved })),
            timeout,
        ]);
        return result;
    }
    finally {
        if (timer)
            clearTimeout(timer);
        // Attach a rejection observer even when timeout won.  This intentionally
        // does not await the late result.
        void promise.catch(() => undefined);
    }
}
/** Convenience form for callers that have a lazy start operation. */
function runWithStartupTimeout(start, timeoutMs = exports.DEFAULT_TWEAK_STARTUP_TIMEOUT_MS) {
    let value;
    try {
        value = start();
    }
    catch (error) {
        return Promise.reject(error);
    }
    return withStartupTimeout(value, timeoutMs);
}
function lifecycleRecordKey(process, id) {
    return `${process}:${id}`;
}
/**
 * Bind a main-process tweak's `stop()` to the tweak object so cleanup that
 * relies on `this` (per-instance disposers, IPC handle removers) works. The
 * renderer host binds stop the same way (preload/tweak-host.ts); the main
 * runtime historically stored it unbound, silently breaking `this`-based main
 * cleanup for `scope: "both"` tweaks (followup).
 */
function bindMainTweakStop(tweak) {
    if (!tweak || typeof tweak.stop !== "function")
        return tweak?.stop;
    return tweak.stop.bind(tweak);
}
/**
 * A whole-app restart racing the sequential tweak-load loop leaves innocent
 * tweaks in "starting"; only repeated interruptions indicate the tweak itself
 * is hanging startup. One interruption is therefore retried, not quarantined.
 */
exports.INTERRUPTED_ATTEMPTS_BEFORE_QUARANTINE = 2;
/**
 * Turn a journal from a previous process into explicit records. Only records
 * from the unfinished current attempt are changed; historical ready/failed
 * records remain available for diagnostics. A first interruption becomes a
 * retryable "failed"; INTERRUPTED_ATTEMPTS_BEFORE_QUARANTINE consecutive
 * interruptions quarantine the tweak.
 */
function recoverInterruptedTweaks(journal, now = new Date().toISOString()) {
    const currentAttempt = journal.currentAttempt;
    if (!currentAttempt || currentAttempt.completedAt)
        return journal;
    const records = { ...journal.records };
    for (const [key, record] of Object.entries(records)) {
        if (record.attemptId !== currentAttempt.id)
            continue;
        if (record.status !== "starting")
            continue;
        const interruptedAttempts = (record.interruptedAttempts ?? 0) + 1;
        const quarantine = interruptedAttempts >= exports.INTERRUPTED_ATTEMPTS_BEFORE_QUARANTINE;
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
function isMainProcessTweakScope(scope) {
    return scope !== "renderer";
}
function reloadTweaks(reason, deps) {
    deps.logInfo(`reloading tweaks (${reason})`);
    deps.stopAllMainTweaks();
    deps.clearTweakModuleCache();
    deps.loadAllMainTweaks();
    deps.broadcastReload();
}
function setTweakEnabledAndReload(id, enabled, deps) {
    const normalizedEnabled = !!enabled;
    deps.setTweakEnabled(id, normalizedEnabled);
    deps.logInfo(`tweak ${id} enabled=${normalizedEnabled}`);
    reloadTweaks("enabled-toggle", deps);
    return true;
}
//# sourceMappingURL=tweak-lifecycle.js.map