/** Resources belong to one activation, including while start() is pending. */
export class TweakResources {
  private controller = new AbortController();
  private disposers = new Set<() => void | Promise<void>>();
  private closing: Promise<void> | null = null;
  private ended = false;
  readonly signal = this.controller.signal;

  assertActive(): void {
    if (this.ended) throw new Error("Tweak activation has ended");
  }

  cancel(): void { this.controller.abort(); }

  /** The returned disposer is idempotent, whether called by the tweak or host. */
  add(dispose: () => void | Promise<void>): () => Promise<void> {
    this.assertActive();
    let result: Promise<void> | undefined;
    const once = () => {
      if (!result) {
        result = Promise.resolve().then(dispose).finally(() => this.disposers.delete(once));
      }
      return result;
    };
    this.disposers.add(once);
    return once;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.ended = true;
    this.cancel();
    const pending = [...this.disposers].reverse();
    // Invoke every cleanup in LIFO order even if another disposer never settles.
    this.closing = Promise.allSettled(pending.map(dispose => dispose())).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Tweak resource cleanup failed");
    });
    return this.closing;
  }
}

/** Guard API entrypoints, not returned host objects, against stale async startup. */
export function guardTweakApi<T extends object>(api: T, resources: TweakResources): T {
  const cache = new WeakMap<object, object>();
  const wrap = (value: object): object => {
    const existing = cache.get(value);
    if (existing) return existing;
    const proxy = new Proxy(value, {
      get(target, key) {
        const member = Reflect.get(target, key);
        if (key === "lifecycle" || key === "log" || key === "manifest") return member;
        if (typeof member === "function") return (...args: unknown[]) => {
          resources.assertActive();
          return member.apply(target, args);
        };
        if (member && typeof member === "object" && Object.getPrototypeOf(member) === Object.prototype) return wrap(member);
        return member;
      },
    });
    cache.set(value, proxy);
    return proxy;
  };
  return wrap(api) as T;
}
