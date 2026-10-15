"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TweakResources = void 0;
exports.guardTweakApi = guardTweakApi;
/** Resources belong to one activation, including while start() is pending. */
class TweakResources {
    controller = new AbortController();
    disposers = new Set();
    closing = null;
    ended = false;
    signal = this.controller.signal;
    assertActive() {
        if (this.ended)
            throw new Error("Tweak activation has ended");
    }
    cancel() { this.controller.abort(); }
    /** The returned disposer is idempotent, whether called by the tweak or host. */
    add(dispose) {
        this.assertActive();
        let result;
        const once = () => {
            if (!result) {
                result = Promise.resolve().then(dispose).finally(() => this.disposers.delete(once));
            }
            return result;
        };
        this.disposers.add(once);
        return once;
    }
    close() {
        if (this.closing)
            return this.closing;
        this.ended = true;
        this.cancel();
        const pending = [...this.disposers].reverse();
        // Invoke every cleanup in LIFO order even if another disposer never settles.
        this.closing = Promise.allSettled(pending.map(dispose => dispose())).then(results => {
            const errors = results.filter((result) => result.status === "rejected").map(result => result.reason);
            if (errors.length)
                throw new AggregateError(errors, "Tweak resource cleanup failed");
        });
        return this.closing;
    }
}
exports.TweakResources = TweakResources;
/** Guard API entrypoints, not returned host objects, against stale async startup. */
function guardTweakApi(api, resources) {
    const cache = new WeakMap();
    const wrap = (value) => {
        const existing = cache.get(value);
        if (existing)
            return existing;
        const proxy = new Proxy(value, {
            get(target, key) {
                const member = Reflect.get(target, key);
                if (key === "lifecycle" || key === "log" || key === "manifest")
                    return member;
                if (typeof member === "function")
                    return (...args) => {
                        resources.assertActive();
                        return member.apply(target, args);
                    };
                if (member && typeof member === "object" && Object.getPrototypeOf(member) === Object.prototype)
                    return wrap(member);
                return member;
            },
        });
        cache.set(value, proxy);
        return proxy;
    };
    return wrap(api);
}
//# sourceMappingURL=tweak-resources.js.map