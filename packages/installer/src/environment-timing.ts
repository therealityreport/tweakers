/**
 * Additive schema-v1 transaction timing evidence.  Wall-clock ISO values are
 * durable ordering evidence; elapsed values are calculated from a monotonic
 * clock and are therefore never derived from subtracting two wall-clock dates.
 */
export const ENVIRONMENT_TIMING_PHASES = [
  "cache-inspection",
  "preparation",
  "approval-helper-launch",
  "watcher-pause",
  "quit",
  "exchange-apply",
  "projection",
  "reopen",
  "readiness-proof",
  "watcher-publication",
  "terminal-persist",
] as const;

export type EnvironmentTimingPhase = typeof ENVIRONMENT_TIMING_PHASES[number];

export interface EnvironmentTimingPhaseEvidence {
  startedAt: string;
  completedAt: string | null;
  /** Monotonic elapsed time accumulated for this phase. */
  durationMs: number | null;
}

export interface EnvironmentTimingEvidence {
  /** Remains additive to the transaction's schema-v1 receipt. */
  schemaVersion: 1;
  /** Set only by the deliberate confirmation path, before commit/helper work. */
  approvalAt: string | null;
  /** Set only after a successful target proof and an initial terminal persist. */
  readyAt: string | null;
  phases: Partial<Record<EnvironmentTimingPhase, EnvironmentTimingPhaseEvidence>>;
}

export interface EnvironmentTimingClock {
  nowIso(): string;
  monotonicMs(): number;
}

export const systemEnvironmentTimingClock: EnvironmentTimingClock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

export function createEnvironmentTiming(approvalAt: string | null = null): EnvironmentTimingEvidence {
  return { schemaVersion: 1, approvalAt, readyAt: null, phases: {} };
}

/** Keeps monotonic origins in process memory; receipts persist only safe evidence. */
export class EnvironmentTimingRecorder {
  private readonly starts = new Map<EnvironmentTimingPhase, number>();

  constructor(private readonly clock: EnvironmentTimingClock = systemEnvironmentTimingClock) {}

  start(
    timing: EnvironmentTimingEvidence,
    phase: EnvironmentTimingPhase,
  ): EnvironmentTimingEvidence {
    if (this.starts.has(phase)) return timing;
    this.starts.set(phase, this.clock.monotonicMs());
    return {
      ...timing,
      phases: {
        ...timing.phases,
        [phase]: timing.phases[phase] ?? {
          startedAt: this.clock.nowIso(),
          completedAt: null,
          durationMs: null,
        },
      },
    };
  }

  complete(
    timing: EnvironmentTimingEvidence,
    phase: EnvironmentTimingPhase,
  ): EnvironmentTimingEvidence {
    const started = this.starts.get(phase);
    const evidence = timing.phases[phase];
    if (started === undefined || evidence === undefined) return timing;
    this.starts.delete(phase);
    const elapsed = Math.max(0, this.clock.monotonicMs() - started);
    return {
      ...timing,
      phases: {
        ...timing.phases,
        [phase]: {
          ...evidence,
          completedAt: this.clock.nowIso(),
          durationMs: (evidence.durationMs ?? 0) + elapsed,
        },
      },
    };
  }

  completeInstant(timing: EnvironmentTimingEvidence, phase: EnvironmentTimingPhase): EnvironmentTimingEvidence {
    return this.complete(this.start(timing, phase), phase);
  }

  markReady(timing: EnvironmentTimingEvidence): EnvironmentTimingEvidence {
    return timing.readyAt === null ? { ...timing, readyAt: this.clock.nowIso() } : timing;
  }
}

export interface EnvironmentTimingBenchmarkSample {
  direction: string;
  durationMs: number;
  phase: "committed" | "rolled-back" | "failed" | "cancelled";
}

export interface EnvironmentTimingBenchmarkDirection {
  count: number;
  p50Ms: number;
  empiricalP95Ms: number;
  maxMs: number;
  failures: number;
}

/**
 * Summarize terminal timing samples without excluding failures.  Empirical
 * p95 selects ceil(.95 * n), avoiding interpolation that would invent times.
 */
export function summarizeEnvironmentTiming(
  samples: readonly EnvironmentTimingBenchmarkSample[],
): Record<string, EnvironmentTimingBenchmarkDirection> {
  const grouped = new Map<string, EnvironmentTimingBenchmarkSample[]>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) continue;
    const values = grouped.get(sample.direction) ?? [];
    values.push(sample);
    grouped.set(sample.direction, values);
  }
  return Object.fromEntries([...grouped.entries()].map(([direction, values]) => {
    const sorted = values.map((value) => value.durationMs).sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
    return [direction, {
      count: sorted.length,
      p50Ms: percentile(0.5),
      empiricalP95Ms: percentile(0.95),
      maxMs: sorted[sorted.length - 1]!,
      failures: values.filter((value) => value.phase !== "committed").length,
    }];
  }));
}
