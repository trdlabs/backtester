// 017/020 — worked-пример standalone-стратегии (SC-001-А, US1-AC1): «шорт после +10% за 20 мин при
// достаточном объёме». Контракт-конформный код: manifest (kind:'strategy'), onBarClose →
// enter(side:'short'). Использует ТОЛЬКО point-in-time контекст (no-lookahead).
//
// 020: индикаторы (RSI/MACD/ATR/Bollinger) берутся через платформенный `ctx.indicators.query(...)`
// (SC-001, US1-AC3) — НЕ через indicator-библиотеку (0 vendor-импортов; backend ненаблюдаем).
// Памп-сигнал (% за окно) — собственный point-in-time расчёт по `closedCandles`, не каталог-индикатор.

import {
  CONTRACT_VERSION,
  type StrategyContext,
  type StrategyDecision,
  type StrategyModule,
} from '@trading/research-contracts/research';

const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pumpPct', 'windowMin', 'minVolume'],
  properties: {
    pumpPct: { type: 'number' },
    windowMin: { type: 'number' },
    minVolume: { type: 'number' },
  },
};

export const shortAfterPump: StrategyModule = {
  manifest: {
    id: 'short_after_pump',
    version: '0.1.0',
    kind: 'strategy',
    name: 'Short after pump',
    summary: 'Шорт после резкого роста цены при достаточном объёме',
    rationale: 'Резкий памп без фундаментала часто откатывает; вход в шорт по подтверждённому росту.',
    author: 'agent',
    contractVersion: CONTRACT_VERSION,
    status: 'research_only',
    paramsSchema,
    params: { pumpPct: 10, windowMin: 20, minVolume: 1_000_000 },
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true },
    hooks: ['onBarClose'],
  },

  onBarClose(ctx: StrategyContext): StrategyDecision {
    const windowMin = Number(ctx.params.windowMin ?? 20);
    const pumpPct = Number(ctx.params.pumpPct ?? 10);
    const minVolume = Number(ctx.params.minVolume ?? 0);

    // Платформенные индикаторы через стабильный ctx.indicators (warmup → undefined).
    const rsi = ctx.indicators.query({ name: 'rsi', params: { period: 14 } });
    const macd = ctx.indicators.query({ name: 'macd' });
    const atr = ctx.indicators.query({ name: 'atr', params: { period: 14 } });
    const bollinger = ctx.indicators.query({ name: 'bollinger', params: { period: 20, stddev: 2 } });

    const history = ctx.data.closedCandles(windowMin);
    if (history.length < windowMin) return { kind: 'idle' };

    const past = history[0];
    const changePct = ((ctx.bar.close - past.close) / past.close) * 100;
    if (changePct >= pumpPct && ctx.bar.volume >= minVolume) {
      const parts = [`pump ${changePct.toFixed(1)}% >= ${pumpPct}% при объёме ${ctx.bar.volume}`];
      if (typeof rsi === 'number') parts.push(`RSI=${rsi.toFixed(1)}`);
      if (typeof macd === 'object' && 'histogram' in macd) {
        parts.push(`MACD.hist=${macd.histogram.toFixed(4)}`);
      }
      if (typeof atr === 'number') parts.push(`ATR=${atr.toFixed(4)}`);
      if (typeof bollinger === 'object' && 'upper' in bollinger) {
        parts.push(`BB.upper=${bollinger.upper.toFixed(2)}`);
      }
      return { kind: 'enter', side: 'short', rationale: parts.join('; ') };
    }
    return { kind: 'idle' };
  },
};

/** Валидные sample-решения примера (для author-supplied проверки decision-схемы). */
export const shortAfterPumpSamples: readonly StrategyDecision[] = [
  { kind: 'enter', side: 'short' },
  { kind: 'idle' },
];
