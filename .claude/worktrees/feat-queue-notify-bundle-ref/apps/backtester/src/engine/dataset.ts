// 018 — загрузчик фикстур свечей + point-in-time data-API (data-model §2, research R6, FR-011/026).
//
// Единственный источник «рынка» — фикстура JSON, резолвится по `datasetRef` (не сеть/Postgres).
// PIT data-API: `closedCandles(lookback)` строго ДО `t`; индикаторы as-of (`≤ t`, MVP `sma`).
// Forward-поверхности структурно нет (инвариант no-lookahead, 017 `PointInTimeDataApi`).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Bar, IndicatorApi, PointInTimeDataApi } from '@trading/research-contracts/research';
import type { IndicatorEngine } from './indicators/index.js';

/** Форма файла-фикстуры свечей (`fixtures/candles/<datasetRef>.json`). */
interface CandleDatasetFile {
  readonly datasetRef: string;
  readonly timeframe: string;
  readonly symbols: Record<string, readonly Bar[]>;
}

/** Загруженный датасет: резолвленные deep-frozen свечи по символам. */
export interface CandleDataset {
  readonly datasetRef: string;
  readonly timeframe: string;
  symbols(): readonly string[];
  candles(symbol: string): readonly Readonly<Bar>[];
}

function findRepoRoot(startUrl: string): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'tsconfig.json'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`dataset: could not locate repo root starting from ${startUrl}`);
}

/** Каталог фикстур свечей по умолчанию (репо-корень + spec-путь). */
export function defaultCandleFixturesDir(): string {
  return join(findRepoRoot(import.meta.url), 'specs', '018-research-backtest-runner', 'fixtures', 'candles');
}

/**
 * Загрузить датасет по `datasetRef` из `fixturesDir` (по умолчанию — spec-фикстуры).
 * `datasetRef` файла должен совпасть с запрошенным; свечи deep-frozen (read-only, US4-AC3).
 */
export function loadCandleDataset(datasetRef: string, fixturesDir?: string): CandleDataset {
  const dir = fixturesDir ?? defaultCandleFixturesDir();
  const file = join(dir, `${datasetRef}.json`);
  if (!existsSync(file)) {
    throw new Error(`loadCandleDataset: dataset fixture not found: ${file}`);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as CandleDatasetFile;
  if (parsed.datasetRef !== datasetRef) {
    throw new Error(
      `loadCandleDataset: datasetRef mismatch (file "${parsed.datasetRef}" ≠ requested "${datasetRef}")`,
    );
  }

  const frozen: Record<string, readonly Readonly<Bar>[]> = {};
  for (const [symbol, bars] of Object.entries(parsed.symbols)) {
    frozen[symbol] = Object.freeze(bars.map((b) => Object.freeze(b)));
  }

  return {
    datasetRef: parsed.datasetRef,
    timeframe: parsed.timeframe,
    symbols: () => Object.keys(frozen),
    candles: (symbol) => {
      const c = frozen[symbol];
      if (c === undefined) {
        throw new Error(`CandleDataset: unknown symbol "${symbol}" in dataset "${datasetRef}"`);
      }
      return c;
    },
  };
}

/** SMA закрытий по окну индексов `[t−period+1, t]` (включительно, `≤ t`); `undefined` если данных мало. */
function smaAsOf(candles: readonly Readonly<Bar>[], t: number, period: number): number | undefined {
  if (!Number.isInteger(period) || period <= 0) return undefined;
  const start = t - period + 1;
  if (start < 0) return undefined;
  let sum = 0;
  for (let i = start; i <= t; i += 1) sum += candles[i].close;
  return sum / period;
}

/** Резолв as-of индикатора по имени (MVP: `sma_<period>`); неизвестное имя → `undefined`. */
function indicatorAsOf(candles: readonly Readonly<Bar>[], t: number, name: string): number | undefined {
  const m = /^sma_(\d+)$/.exec(name);
  if (m !== null) return smaAsOf(candles, t, Number(m[1]));
  return undefined;
}

/**
 * Построить PIT `data`-API на баре `t`: закрытые свечи строго ДО `t` + as-of индикаторы.
 * Возвращаемые срезы заморожены (read-only инвариант).
 */
export function pointInTimeDataApi(candles: readonly Readonly<Bar>[], t: number): PointInTimeDataApi {
  return {
    closedCandles(lookback: number): readonly Readonly<Bar>[] {
      const start = Math.max(0, t - lookback);
      return Object.freeze(candles.slice(start, t));
    },
    indicatorAsOf(name: string): number | undefined {
      return indicatorAsOf(candles, t, name);
    },
  };
}

/**
 * Построить `indicators`-API на баре `t` — engine-backed (020): отдаёт `value()`+`query()`
 * platform-owned движка, привязанного к бару `t` (видит закрытые свечи `[0..t]`).
 *
 * `engine` — per-run инстанс, владеемый `PointInTimeContextBuilder` (один на symbol-run).
 * Legacy-parity сохранена движком: `value('sma', N) === indicatorAsOf('sma_<N>')` (то же окно,
 * тот же порядок суммирования; требует `verify_018_lookahead`).
 */
export function indicatorApiFor(engine: IndicatorEngine, barIndex: number): IndicatorApi {
  return engine.accessorAt(barIndex);
}
