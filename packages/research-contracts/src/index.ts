export * from './run.js';
export * from './comparison.js';
export * from './historical.js';

/** 017 run/module contract version. Must stay in lockstep with the kernel for byte parity — the
 *  `contract-merge-guard` test asserts it equals PLATFORM_CONTRACT_VERSION. 083 E1 moved it to
 *  '017.3', ratified platform-side by verify_083_e1_contract_anchor; 017.1/017.2 manifests stay
 *  valid (append-only SUPPORTED_CONTRACT_VERSIONS). */
export const CONTRACT_VERSION = '017.3';

/** The platform's lifted 017 contract version (parity anchor). Root CONTRACT_VERSION must equal it. */
export { CONTRACT_VERSION as PLATFORM_CONTRACT_VERSION } from './research/catalogs.js';

/** 022 artifact-set contract version. */
export const ARTIFACT_CONTRACT_VERSION = '022.2';

/** Module-bundle/registry metadata version (Slice 3 — submitted-bundle sandbox execution). */
export const BUNDLE_CONTRACT_VERSION = '019.1';

/** Networked Research Historical Data API metadata version (Slice 4). */
export const HISTORICAL_DATA_CONTRACT_VERSION = '030.1';

/** Metric names the MVP runner can compute (request-gated). */
export const METRIC_CATALOG = [
  'pnl',
  'return_pct',
  'total_bars',
  'long_bars',
  'win_rate',
  'seed_probe',
] as const;
