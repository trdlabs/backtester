// 020 — детерминированный каталог возможностей (contracts/indicator-catalog.md, data-model §1/§7).
//
// Единственный источник правды о поддержке: что в каталоге — валидируемо И исполнимо;
// чего нет — `indicator_unsupported`. Стабильный порядок; backend-agnostic.
// Каталог содержит committed-набор из 8: обязательные 6 (sma, ema, rsi, macd, atr, bollinger)
// + adx + stochastic (US4, T035).
//
// `warmup(params)` ожидает РАЗРЕШЁННЫЕ params (с применёнными default'ами) — движок резолвит
// дефолты перед вызовом (см. engine.ts / validation defaults).

import type {
  IndicatorCatalog,
  IndicatorDefinition,
} from '@trading/research-contracts/research';

const SMA: IndicatorDefinition = {
  name: 'sma',
  paramsSchema: { period: { type: 'int', min: 1 } },
  outputShape: 'scalar',
  sourceFields: ['close', 'open', 'high', 'low', 'hlc3'],
  warmup: (p) => p.period,
};

const EMA: IndicatorDefinition = {
  name: 'ema',
  paramsSchema: { period: { type: 'int', min: 1 } },
  outputShape: 'scalar',
  sourceFields: ['close', 'open', 'high', 'low', 'hlc3'],
  warmup: (p) => p.period, // seed = SMA первых period
};

const RSI: IndicatorDefinition = {
  name: 'rsi',
  paramsSchema: { period: { type: 'int', min: 1, default: 14 } },
  outputShape: 'scalar',
  sourceFields: ['close'],
  warmup: (p) => p.period + 1, // Wilder; close-to-close
};

const MACD: IndicatorDefinition = {
  name: 'macd',
  paramsSchema: {
    fast: { type: 'int', min: 1, default: 12 },
    slow: { type: 'int', min: 1, default: 26 },
    signal: { type: 'int', min: 1, default: 9 },
  },
  outputShape: 'macd',
  sourceFields: ['close'],
  warmup: (p) => p.slow + p.signal - 1,
};

const ATR: IndicatorDefinition = {
  name: 'atr',
  paramsSchema: { period: { type: 'int', min: 1, default: 14 } },
  outputShape: 'scalar',
  sourceFields: ['high', 'low', 'close'], // OHLC; используются по формуле
  warmup: (p) => p.period + 1, // Wilder, нужен prevClose
};

const BOLLINGER: IndicatorDefinition = {
  name: 'bollinger',
  paramsSchema: {
    period: { type: 'int', min: 1, default: 20 },
    stddev: { type: 'number', exclusiveMin: 0, default: 2 },
  },
  outputShape: 'bollinger',
  sourceFields: ['close', 'open', 'high', 'low', 'hlc3'],
  warmup: (p) => p.period,
};

const ADX: IndicatorDefinition = {
  name: 'adx',
  paramsSchema: { period: { type: 'int', min: 1, default: 14 } },
  outputShape: 'scalar',
  sourceFields: ['high', 'low', 'close'], // OHLC; используются по формуле
  warmup: (p) => 2 * p.period - 1, // Wilder DX→ADX составной
};

const STOCHASTIC: IndicatorDefinition = {
  name: 'stochastic',
  paramsSchema: {
    k: { type: 'int', min: 1, default: 14 },
    d: { type: 'int', min: 1, default: 3 },
    smooth: { type: 'int', min: 1, default: 1 },
  },
  outputShape: 'stochastic',
  sourceFields: ['high', 'low', 'close'], // OHLC
  warmup: (p) => p.k + p.smooth + p.d - 2,
};

/** Детерминированный committed-каталог (8; стабильный порядок). */
export const INDICATOR_CATALOG: IndicatorCatalog = [SMA, EMA, RSI, MACD, ATR, BOLLINGER, ADX, STOCHASTIC];

/** Найти определение по имени (или `undefined`). */
export function findDefinition(
  catalog: IndicatorCatalog,
  name: string,
): IndicatorDefinition | undefined {
  return catalog.find((d) => d.name === name);
}

/** Разрешить params: применить default'ы из схемы поверх предоставленных значений. */
export function resolveParams(
  def: IndicatorDefinition,
  params: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const [key, spec] of Object.entries(def.paramsSchema)) {
    if (spec.default !== undefined) resolved[key] = spec.default;
  }
  if (params !== undefined) {
    for (const [key, value] of Object.entries(params)) resolved[key] = value;
  }
  return resolved;
}
