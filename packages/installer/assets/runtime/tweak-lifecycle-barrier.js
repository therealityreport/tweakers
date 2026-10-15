"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTweakLifecycleBarrier = createTweakLifecycleBarrier;
/** Instance tokens must identify one document/runtime generation, not just a window. */
function createTweakLifecycleBarrier(options) {
    if (typeof options.operationId !== "string" || !options.operationId || !["shutdown", "activate"].includes(options.phase)) {
        throw new Error("Lifecycle barrier requires an operation ID and valid phase");
    }
    const expected = new Set(options.expectedInstanceTokens);
    if (expected.size !== options.expectedInstanceTokens.length || [...expected].some(token => typeof token !== "string" || !token)) {
        throw new Error("Lifecycle barrier requires unique nonempty instance tokens");
    }
    const requested = options.timeoutMs ?? 5_000;
    if (!Number.isFinite(requested) || requested <= 0)
        throw new Error("Lifecycle barrier timeout must be positive");
    const timeoutMs = Math.min(30_000, Math.max(1, Math.round(requested)));
    const acknowledged = new Set();
    let settled = false;
    let timer;
    let resolve;
    let reject;
    const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
    // A sender can fail synchronously before its caller starts awaiting completion.
    void completion.catch(() => undefined);
    const finish = (error) => {
        if (settled)
            return;
        settled = true;
        if (timer)
            clearTimeout(timer);
        if (error)
            reject(error);
        else
            resolve();
    };
    if (expected.size === 0)
        finish();
    else
        timer = setTimeout(() => finish(new Error(`Lifecycle ${options.phase} timed out for operation ${options.operationId}; pending: ${[...expected].filter(token => !acknowledged.has(token)).join(", ")}`)), timeoutMs);
    return {
        completion,
        acknowledge(ack) {
            if (settled || ack.operationId !== options.operationId || ack.phase !== options.phase
                || !expected.has(ack.instanceToken) || acknowledged.has(ack.instanceToken))
                return false;
            if (ack.ok !== true) {
                finish(new Error(`Lifecycle ${options.phase} failed for ${ack.instanceToken}: ${ack.error ?? "acknowledgement failed"}`));
                return true;
            }
            acknowledged.add(ack.instanceToken);
            if (acknowledged.size === expected.size)
                finish();
            return true;
        },
        invalidate(instanceToken, reason = "instance navigated or was destroyed") {
            if (expected.has(instanceToken))
                finish(new Error(`Lifecycle ${options.phase} invalidated for ${instanceToken}: ${reason}`));
        },
        cancel(reason = "operation cancelled") { finish(new Error(`Lifecycle ${options.phase}: ${reason}`)); },
    };
}
//# sourceMappingURL=tweak-lifecycle-barrier.js.map