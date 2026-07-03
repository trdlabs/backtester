// Minimal in-memory job observability counters. No histogram/percentiles — count/sum/max per phase.
// Constructed only when BACKTESTER_JOB_OBS is on, so it never affects the flag-off (golden) path.

export type DedupClass = 'off' | 'evidence_bypass' | 'bypass' | 'hit' | 'miss' | 'stale_recompute';

export interface JobObsSample {
  runId: string;
  engine: string;
  outcome: string;
  terminalCode?: string;
  dedup: DedupClass;
  queueWaitMs: number | null;
  materializeMs: number | null;
  engineMs: number | null;
  totalMs: number;
  /** Bounded error detail (boundedErrorDetail) when the job failed with a thrown error. */
  readonly errorDetail?: string;
}

export interface PhaseStat {
  count: number;
  sum: number;
  max: number;
}

export interface JobObsSnapshot {
  startedAtMs: number;
  jobs: { total: number; byOutcome: Record<string, number> };
  dedup: Record<DedupClass, number>;
  phases: { queueWaitMs: PhaseStat; materializeMs: PhaseStat; engineMs: PhaseStat; totalMs: PhaseStat };
}

const DEDUP_CLASSES: DedupClass[] = ['off', 'evidence_bypass', 'bypass', 'hit', 'miss', 'stale_recompute'];

function emptyPhase(): PhaseStat {
  return { count: 0, sum: 0, max: 0 };
}

function fold(stat: PhaseStat, value: number | null): void {
  if (value === null) return;
  stat.count += 1;
  stat.sum += value;
  if (value > stat.max) stat.max = value;
}

export class ObsRegistry {
  private total = 0;
  private readonly byOutcome: Record<string, number> = {};
  private readonly dedup: Record<DedupClass, number>;
  private readonly phases = {
    queueWaitMs: emptyPhase(),
    materializeMs: emptyPhase(),
    engineMs: emptyPhase(),
    totalMs: emptyPhase(),
  };

  constructor(private readonly startedAtMs: number) {
    this.dedup = Object.fromEntries(DEDUP_CLASSES.map((c) => [c, 0])) as Record<DedupClass, number>;
  }

  recordJob(s: JobObsSample): void {
    this.total += 1;
    this.byOutcome[s.outcome] = (this.byOutcome[s.outcome] ?? 0) + 1;
    this.dedup[s.dedup] += 1;
    fold(this.phases.queueWaitMs, s.queueWaitMs);
    fold(this.phases.materializeMs, s.materializeMs);
    fold(this.phases.engineMs, s.engineMs);
    fold(this.phases.totalMs, s.totalMs);
  }

  snapshot(): JobObsSnapshot {
    return {
      startedAtMs: this.startedAtMs,
      jobs: { total: this.total, byOutcome: { ...this.byOutcome } },
      dedup: { ...this.dedup },
      phases: {
        queueWaitMs: { ...this.phases.queueWaitMs },
        materializeMs: { ...this.phases.materializeMs },
        engineMs: { ...this.phases.engineMs },
        totalMs: { ...this.phases.totalMs },
      },
    };
  }
}
