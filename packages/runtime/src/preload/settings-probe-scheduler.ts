export type SettingsProbeOutcome = "found" | "missing" | "rejected" | "suppressed";

export interface SettingsProbeMetrics {
  requestCount: number;
  coalescedRequestCount: number;
  backoffEventCount: number;
  activeTimerCount: number;
  probeCount: number;
  cumulativeProbeTimeMs: number;
  consecutiveMisses: number;
  currentBackoffMs: number;
  lastOutcome: SettingsProbeOutcome | null;
}

interface SettingsProbeSchedulerOptions {
  probe: () => SettingsProbeOutcome;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onProbe?: (outcome: SettingsProbeOutcome, metrics: SettingsProbeMetrics) => void;
  /** Called at the scheduler's bounded retry cadence when a probe throws. */
  onProbeError?: (error: unknown) => void;
}

const ORDINARY_MISS_BACKOFF_MS = 250;
const SUSTAINED_MISS_BACKOFF_MS = 1_000;
const FOUND_UPDATE_BACKOFF_MS = 100;
const SUSTAINED_MISS_THRESHOLD = 10;

/**
 * Coalesces renderer mutation storms into bounded Settings probes.
 *
 * Missing Settings is probed at most four times per second, then once per
 * second after ten misses. A navigation request bypasses the current timer and
 * resets the miss backoff.
 */
export class SettingsProbeScheduler {
  private readonly probe: () => SettingsProbeOutcome;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<SettingsProbeSchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<SettingsProbeSchedulerOptions["clearTimer"]>;
  private readonly onProbe?: SettingsProbeSchedulerOptions["onProbe"];
  private readonly onProbeError?: SettingsProbeSchedulerOptions["onProbeError"];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = 0;
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  private running = false;
  private pending = false;
  private stopped = false;
  private metricsState: SettingsProbeMetrics = {
    requestCount: 0,
    coalescedRequestCount: 0,
    backoffEventCount: 0,
    activeTimerCount: 0,
    probeCount: 0,
    cumulativeProbeTimeMs: 0,
    consecutiveMisses: 0,
    currentBackoffMs: 0,
    lastOutcome: null,
  };

  constructor(options: SettingsProbeSchedulerOptions) {
    this.probe = options.probe;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.onProbe = options.onProbe;
    this.onProbeError = options.onProbeError;
  }

  request(options: { immediate?: boolean; resetBackoff?: boolean } = {}): void {
    if (this.stopped) return;
    this.metricsState.requestCount += 1;
    if (options.resetBackoff) {
      this.metricsState.consecutiveMisses = 0;
      this.metricsState.currentBackoffMs = 0;
    }
    if (this.running) {
      this.metricsState.coalescedRequestCount += 1;
      this.pending = true;
      return;
    }
    if (options.immediate) {
      this.cancelTimer();
      this.runProbe();
      return;
    }

    const delayMs = this.nextDelayMs();
    const dueAt = Math.max(this.now(), this.lastProbeAt + delayMs);
    if (this.timer !== null && this.timerDueAt <= dueAt) {
      this.metricsState.coalescedRequestCount += 1;
      return;
    }
    this.cancelTimer();
    this.timerDueAt = dueAt;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timerDueAt = 0;
      this.runProbe();
    }, Math.max(0, dueAt - this.now()));
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
    this.cancelTimer();
  }

  metrics(): SettingsProbeMetrics {
    return {
      ...this.metricsState,
      activeTimerCount: this.timer === null ? 0 : 1,
    };
  }

  private runProbe(): void {
    if (this.stopped || this.running) return;
    this.running = true;
    this.pending = false;
    const startedAt = this.now();
    let outcome: SettingsProbeOutcome = "missing";
    let probeError: unknown;
    let probeFailed = false;
    try {
      outcome = this.probe();
    } catch (error) {
      // A broken renderer subtree is transient. Treat it like a missing
      // surface so the existing bounded retry path can recover.
      probeError = error;
      probeFailed = true;
    } finally {
      const finishedAt = this.now();
      this.lastProbeAt = finishedAt;
      this.metricsState.probeCount += 1;
      this.metricsState.cumulativeProbeTimeMs += Math.max(0, finishedAt - startedAt);
      this.metricsState.lastOutcome = outcome;
      if (outcome === "found") {
        this.metricsState.consecutiveMisses = 0;
        this.metricsState.currentBackoffMs = FOUND_UPDATE_BACKOFF_MS;
      } else {
        const previousBackoffMs = this.metricsState.currentBackoffMs;
        this.metricsState.consecutiveMisses += 1;
        this.metricsState.currentBackoffMs = this.nextMissBackoffMs();
        if (previousBackoffMs !== SUSTAINED_MISS_BACKOFF_MS
          && this.metricsState.currentBackoffMs === SUSTAINED_MISS_BACKOFF_MS) {
          this.metricsState.backoffEventCount += 1;
        }
      }
      this.running = false;
    }
    if (probeFailed) this.onProbeError?.(probeError);
    this.onProbe?.(outcome, this.metrics());

    if (outcome !== "found" || this.pending) this.request();
  }

  private nextDelayMs(): number {
    if (this.metricsState.lastOutcome === "found") return FOUND_UPDATE_BACKOFF_MS;
    return this.nextMissBackoffMs();
  }

  private nextMissBackoffMs(): number {
    return this.metricsState.consecutiveMisses >= SUSTAINED_MISS_THRESHOLD
      ? SUSTAINED_MISS_BACKOFF_MS
      : ORDINARY_MISS_BACKOFF_MS;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
    this.timerDueAt = 0;
  }
}
