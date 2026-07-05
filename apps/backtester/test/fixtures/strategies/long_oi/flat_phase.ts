/**
 * 026 Long OI StrategyModule — `onBarClose` flat-фаза (module-interface.md, R3).
 *
 * Действует только при `ctx.position == null`. FSM: IDLE → (dump) WATCHING → (entry) `enter` /
 * (timeout) COOLDOWN → IDLE. Реконсиляция: если позиция только что закрылась (`phase===IN_POSITION`,
 * но `ctx.position==null`) → COOLDOWN. Логика ПОРТИРОВАНА из legacy `dump_long/{detector,rules,reducer,
 * state}.ts` (НЕ импорт). Пороги — из `ctx.params` (resolveParams), не из config.ts. Чистый модуль.
 *
 * **C1 (деградация рыночных данных):** при `ctx.market===undefined` / `undefined`-слоте OI/liq во время
 * entry-оценки — no-throw / no-zero-substitution / no-NaN → детерминированный `annotate{reason}`.
 */

import type { Bar, StrategyContext } from '@trading-platform/sdk/research-contract';
import type { StrategyDecision } from '@trading-platform/sdk/research-contract';
import type { LongOiParams } from './params.js';
import type { LongOiModuleState, LongOiWatchSignal } from './state.js';
import {
  detectDump,
  evaluateEntry,
  liqLongNow,
  oiWindow3,
  recentCandles,
  resolveParams,
} from './signals.js';

const MIN = 60_000;

function enterCooldown(state: LongOiModuleState, ts: number, p: LongOiParams): void {
  state.phase = 'COOLDOWN';
  state.watch = null;
  state.miniWatch = null;
  state.cooldownUntil = ts + p.watch.cooldownMinutes * MIN;
  state.tp1Done = false;
  state.bePending = false;
  state.breakEvenArmed = false;
  state.openedAt = null;
  state.dcaCount = 0;
  state.lastEntryPrice = null;
  state.entryDiagnostics = null;
}

function armWatch(state: LongOiModuleState, signal: LongOiWatchSignal, bar: Readonly<Bar>, p: LongOiParams): void {
  state.phase = 'WATCHING';
  state.watch = {
    signal,
    startedAt: bar.ts,
    expireAt: bar.ts + p.watch.maxMinutes * MIN,
    localLowAfterSignal: Math.min(signal.signalPrice, bar.low),
    localHighAfterSignal: Math.max(signal.signalPrice, bar.high),
  };
}

/**
 * Пропуск warmup-сигнала (live; в бэктесте `firstLiveCandleTs` отсутствует → инертно). Зеркалит legacy
 * `shouldSkipWarmupSignal`. Возвращает причину (`warmup_signal_too_old`/`warmup_signal_already_bounced`)
 * либо `null`.
 */
function warmupSkipReason(signal: LongOiWatchSignal, barTs: number, p: LongOiParams): string | null {
  const firstLiveTs = p.warmup.firstLiveCandleTs;
  if (!firstLiveTs) return null;
  const fromWarmup = signal.lowTs < firstLiveTs || signal.highestTs < firstLiveTs;
  if (!fromWarmup) return null;
  const ageMin = (barTs - signal.lowTs) / MIN;
  const bouncePct = signal.bounceFromLowPct || 0;
  if (ageMin > p.warmup.maxSignalAgeMin) return 'warmup_signal_too_old';
  if (bouncePct > p.warmup.maxBounceFromLowPct) return 'warmup_signal_already_bounced';
  return null;
}

const IDLE: StrategyDecision = { kind: 'idle' };

export function onBarClose(ctx: StrategyContext, state: LongOiModuleState): StrategyDecision[] {
  // Flat-FSM дормантна в позиции (раннер всё равно исполняет enter только при isFlat).
  if (ctx.position != null) return [IDLE];

  const p = resolveParams(ctx);
  const ts = ctx.bar.ts;

  // Реконсиляция: позиция только что закрылась → COOLDOWN (legacy moveToCooldown на выходе).
  if (state.phase === 'IN_POSITION') {
    enterCooldown(state, ts, p);
    return [IDLE];
  }

  if (state.phase === 'COOLDOWN') {
    if (ts >= state.cooldownUntil) {
      state.phase = 'IDLE';
      state.cooldownUntil = 0;
    }
    return [IDLE];
  }

  if (state.phase === 'IDLE') {
    const window = recentCandles(ctx, p.dump.lookbackMin);
    const signal = detectDump(window, p);
    if (signal) {
      const skip = warmupSkipReason(signal, ts, p);
      if (skip) {
        return [{ kind: 'annotate', tags: ['warmup_signal_skipped', skip], metrics: { signalTs: signal.ts } }];
      }
      armWatch(state, signal, ctx.bar, p);
      return [{ kind: 'annotate', tags: ['dump_detected', signal.triggerMode], metrics: { triggerPct: signal.triggerPct, signalTs: signal.ts } }];
    }
    return [IDLE];
  }

  // WATCHING
  const watch = state.watch;
  if (watch === null) {
    // защитная реконсиляция — потерянное watch-состояние
    state.phase = 'IDLE';
    return [IDLE];
  }
  // отслеживание локальных экстремумов после сигнала
  if (ctx.bar.low < watch.localLowAfterSignal) watch.localLowAfterSignal = ctx.bar.low;
  if (ctx.bar.high > watch.localHighAfterSignal) watch.localHighAfterSignal = ctx.bar.high;

  // watch-timeout → COOLDOWN
  if (ts >= watch.expireAt) {
    enterCooldown(state, ts, p);
    return [IDLE];
  }

  // entry-оценка требует рыночных данных (OI-окно + текущие liq) — C1-деградация
  const oi3 = oiWindow3(ctx);
  if (oi3 === null) {
    return [{ kind: 'annotate', tags: ['watch_tick', ctx.market === undefined ? 'missing_market_data' : 'missing_open_interest'], metrics: {} }];
  }
  const liqLong = liqLongNow(ctx);
  if (liqLong === null) {
    return [{ kind: 'annotate', tags: ['watch_tick', 'missing_liquidations'], metrics: {} }];
  }
  const candles3 = recentCandles(ctx, 3);
  if (candles3.length < 3) return [IDLE];

  const ev = evaluateEntry(
    { candles3, oi3, liqLongUsd: liqLong, oiNow: oi3[2], localLow: watch.localLowAfterSignal },
    p,
  );
  if (ev.ok) {
    // diagnostic-subset входа (числовой) для fail_fast/диагностики
    state.entryDiagnostics = {
      fastEntry: ev.fastEntry ? 1 : 0,
      oiRecovery: ev.oiRecovery,
      bouncePct: ev.bouncePct,
      liqRatioPct: ev.liqRatioPct,
      triggerPct: watch.signal.triggerPct,
      signalTs: watch.signal.ts,
    };
    // enter; host открывает позицию по open(t+1). Phase остаётся WATCHING до появления ctx.position.
    return [{ kind: 'enter', side: 'long', tags: ['long_oi_entry'] }];
  }
  // отклонённый watch-tick — без рыночного действия
  return [IDLE];
}
