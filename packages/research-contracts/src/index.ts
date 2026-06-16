export * from './run';
export * from './historical';

/** 017 run/module contract version. Must stay in lockstep with trading-platform for byte parity. */
export const CONTRACT_VERSION = '017.2';

/** 022 artifact-set contract version. */
export const ARTIFACT_CONTRACT_VERSION = '022.1';

/** Metric names the MVP runner can compute (request-gated). */
export const METRIC_CATALOG = [
  'pnl',
  'return_pct',
  'total_bars',
  'long_bars',
  'win_rate',
  'seed_probe',
] as const;
