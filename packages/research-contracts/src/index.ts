export * from './run.js';
export * from './comparison.js';
export * from './historical.js';

/** 017 run/module contract version. Must stay in lockstep with the kernel for byte parity — the
 *  `contract-merge-guard` test asserts it equals PLATFORM_CONTRACT_VERSION.
 *
 *  Что такое «анкер». `PLATFORM_CONTRACT_VERSION` ниже реэкспортируется из `./research/catalogs.js`,
 *  а тот — прямо из `@trdlabs/sdk/research-contract`. То есть анкер и есть константа ядра, и подъём
 *  зависимости двигает его сам; эта строка обязана за ним поспевать. Отдельного гейта в другом
 *  репозитории тут нет — `verify_083_e1_contract_anchor` был разовой ратификацией 017.3 на стороне
 *  платформы, а не звеном этой цепочки.
 *
 *  083 E1 перевёл на '017.3'; 083 S1 — на '017.4' (актор-контракт); Д3 3.3в — на '017.5' вместе с
 *  SDK 0.19.0 (preflight). 017.1/017.2/017.3/017.4 манифесты
 *  остаются валидными (append-only SUPPORTED_CONTRACT_VERSIONS).
 *
 *  Смена этой строки перебазирует КАЖДЫЙ committed result-голден: `runner.ts` кладёт её в
 *  `RunEvidence`, а evidence входит в канонический payload прогона. Двигать её в отрыве от
 *  доказательства миграции (`contract-017-4-migration.test.ts`) нельзя. */
export const CONTRACT_VERSION = '017.5';

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
