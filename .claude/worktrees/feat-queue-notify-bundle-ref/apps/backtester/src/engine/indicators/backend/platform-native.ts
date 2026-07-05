// 020 — дефолтный backend-адаптер поверх чистых formulas/* (MVP runtime; zero-dep).
//
// id:'platform-native'. create(def, params, source) → StreamingIndicator: формула обязательных 6
// + извлечение source из бара (для scalar-source формул) либо прямая передача бара (OHLC: atr).
// Нормализация warmup → undefined и «весь объект undefined, пока не готов» — на стороне формул.

import type { Bar } from '@trading/research-contracts/research';
import type {
  IndicatorDefinition,
  SourceField,
} from '@trading/research-contracts/research';
import { createBollinger } from '../formulas/bollinger.js';
import { createEma } from '../formulas/ema.js';
import { createMacd } from '../formulas/macd.js';
import { createRsi } from '../formulas/rsi.js';
import { createSma } from '../formulas/sma.js';
import { createAtr } from '../formulas/atr.js';
import { createAdx } from '../formulas/adx.js';
import { createStochastic } from '../formulas/stochastic.js';

import type { IndicatorBackendAdapter, StreamingIndicator } from './adapter.js';

/** Извлечь скалярный source из закрытой свечи. */
function sourceValue(bar: Readonly<Bar>, source: SourceField): number {
  switch (source) {
    case 'close':
      return bar.close;
    case 'open':
      return bar.open;
    case 'high':
      return bar.high;
    case 'low':
      return bar.low;
    case 'volume':
      return bar.volume;
    case 'hlc3':
      return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4':
      return (bar.open + bar.high + bar.low + bar.close) / 4;
  }
}

/** Обёртка scalar-source формулы в StreamingIndicator (извлекает source из бара). */
function fromSource(
  formula: { update(x: number): void; readonly value: StreamingIndicator['value'] },
  source: SourceField,
): StreamingIndicator {
  return {
    update(bar: Readonly<Bar>): void {
      formula.update(sourceValue(bar, source));
    },
    get value(): StreamingIndicator['value'] {
      return formula.value;
    },
  };
}

/** Обёртка bar-формулы (OHLC) в StreamingIndicator. */
function fromBar(formula: {
  update(bar: Readonly<Bar>): void;
  readonly value: StreamingIndicator['value'];
}): StreamingIndicator {
  return {
    update(bar: Readonly<Bar>): void {
      formula.update(bar);
    },
    get value(): StreamingIndicator['value'] {
      return formula.value;
    },
  };
}

export const platformNativeAdapter: IndicatorBackendAdapter = {
  id: 'platform-native',
  create(
    def: IndicatorDefinition,
    params: Readonly<Record<string, number>>,
    source: SourceField,
  ): StreamingIndicator {
    switch (def.name) {
      case 'sma':
        return fromSource(createSma(params.period), source);
      case 'ema':
        return fromSource(createEma(params.period), source);
      case 'rsi':
        return fromSource(createRsi(params.period), source);
      case 'macd':
        return fromSource(createMacd(params.fast, params.slow, params.signal), source);
      case 'bollinger':
        return fromSource(createBollinger(params.period, params.stddev), source);
      case 'atr':
        return fromBar(createAtr(params.period));
      case 'adx':
        return fromBar(createAdx(params.period));
      case 'stochastic':
        return fromBar(createStochastic(params.k, params.d, params.smooth));
      default:
        // Каталог↔engine consistency: имя в каталоге, но без формулы здесь — баг конфигурации.
        throw new Error(`platform-native: no formula for indicator "${def.name}"`);
    }
  },
};
