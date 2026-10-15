export type TweakLifecyclePhase = "shutdown" | "activate";

export interface TweakLifecycleAcknowledgement {
  operationId: string;
  phase: TweakLifecyclePhase;
  instanceToken: string;
  ok: boolean;
  error?: string;
}

export interface TweakLifecycleBarrierOptions {
  operationId: string;
  phase: TweakLifecyclePhase;
  expectedInstanceTokens: readonly string[];
  timeoutMs?: number;
}

export interface TweakLifecycleBarrier {
  readonly completion: Promise<void>;
  /** False means the acknowledgement did not belong to a pending participant. */
  acknowledge(ack: TweakLifecycleAcknowledgement): boolean;
  /** Navigation/destruction invalidates a required participant while the barrier is pending. */
  invalidate(instanceToken: string, reason?: string): void;
  cancel(reason?: string): void;
}

/** Instance tokens must identify one document/runtime generation, not just a window. */
export function createTweakLifecycleBarrier(options: TweakLifecycleBarrierOptions): TweakLifecycleBarrier {
  if (typeof options.operationId !== "string" || !options.operationId || !["shutdown", "activate"].includes(options.phase)) {
    throw new Error("Lifecycle barrier requires an operation ID and valid phase");
  }
  const expected = new Set(options.expectedInstanceTokens);
  if (expected.size !== options.expectedInstanceTokens.length || [...expected].some(token => typeof token !== "string" || !token)) {
    throw new Error("Lifecycle barrier requires unique nonempty instance tokens");
  }
  const requested = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Lifecycle barrier timeout must be positive");
  const timeoutMs = Math.min(30_000, Math.max(1, Math.round(requested)));
  const acknowledged = new Set<string>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // A sender can fail synchronously before its caller starts awaiting completion.
  void completion.catch(() => undefined);
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (error) reject(error); else resolve();
  };
  if (expected.size === 0) finish();
  else timer = setTimeout(() => finish(new Error(
    `Lifecycle ${options.phase} timed out for operation ${options.operationId}; pending: ${[...expected].filter(token => !acknowledged.has(token)).join(", ")}`,
  )), timeoutMs);
  return {
    completion,
    acknowledge(ack) {
      if (settled || ack.operationId !== options.operationId || ack.phase !== options.phase
        || !expected.has(ack.instanceToken) || acknowledged.has(ack.instanceToken)) return false;
      if (ack.ok !== true) {
        finish(new Error(`Lifecycle ${options.phase} failed for ${ack.instanceToken}: ${ack.error ?? "acknowledgement failed"}`));
        return true;
      }
      acknowledged.add(ack.instanceToken);
      if (acknowledged.size === expected.size) finish();
      return true;
    },
    invalidate(instanceToken, reason = "instance navigated or was destroyed") {
      if (expected.has(instanceToken)) finish(new Error(`Lifecycle ${options.phase} invalidated for ${instanceToken}: ${reason}`));
    },
    cancel(reason = "operation cancelled") { finish(new Error(`Lifecycle ${options.phase}: ${reason}`)); },
  };
}
