/**
 * 026 Long OI StrategyModule — `onPositionBar` in-position-фаза (module-interface.md / decision-mapping.md, R3).
 *
 * Действует при `ctx.position != null`. Раннер берёт `firstDecision` хука → ровно ОДНО действие на бар;
 * приоритет: полные выходы (tp2/hard_stop/time_exit) → отложенный BE-`update_protection` → TP1 (по
 * `tp1Action`) → DCA → fail_fast → idle. BE-защита host-owned (раннер закрывает остаток intrabar при
 * хите стопа) — модуль НЕ эмитирует `be_stop`-exit (движение защиты = ИСКЛЮЧИТЕЛЬНО `update_protection`,
 * SC-008). Логика ПОРТИРОВАНА из legacy `dump_long/{reducer,fail_fast,rules}.ts` (НЕ импорт).
 *
 * **A2 BE-формула:** `update_protection{ stop: ctx.position.entryPrice }` (числовая цена, без fee/slippage).
 * **C1:** недоступные OI-данные при DCA-оценке → доливка не эмитируется (no-throw), фаза продолжается.
 */

import type { StrategyContext } from '@trdlabs/sdk/research-contract';
import type { StrategyDecision } from '@trdlabs/sdk/research-contract';
import type { LongOiModuleState } from './state.js';
import {
  evaluateDca,
  evaluateFailFast,
  oiWindow3,
  recentCandles,
  resolveParams,
  shouldHardStop,
  shouldTakeTp,
} from './signals.js';

const MIN = 60_000;
const IDLE: StrategyDecision = { kind: 'idle' };

/** Инициализация state при первом баре только что открытой позиции (settle входа произошёл). */
function initPosition(state: LongOiModuleState, ctx: StrategyContext, avgEntry: number): void {
  state.phase = 'IN_POSITION';
  state.openedAt = ctx.bar.ts;
  state.dcaCount = 0;
  state.tp1Done = false;
  state.bePending = false;
  state.breakEvenArmed = false;
  state.lastEntryPrice = avgEntry;
  state.watch = null;
  state.miniWatch = { localLowAfterSignal: Math.min(ctx.bar.low, avgEntry), dcaCycleCount: 0 };
}

export function onPositionBar(ctx: StrategyContext, state: LongOiModuleState): StrategyDecision[] {
  const pos = ctx.position;
  if (pos == null) return [IDLE]; // защитный инвариант (раннер вызывает только в позиции)

  const p = resolveParams(ctx);
  const avgEntry = pos.entryPrice;
  const px = ctx.bar.close;

  // Реконсиляция новой позиции (openedAt ещё не выставлен ⇒ settle входа только что прошёл).
  if (state.phase !== 'IN_POSITION' || state.openedAt == null) {
    initPosition(state, ctx, avgEntry);
  }

  // ── Полные выходы (наивысший приоритет) ─────────────────────────────────
  if (shouldTakeTp(avgEntry, px, p.tpLadder.tp2Pct)) return [{ kind: 'exit', target: 'tp2' }];
  if (shouldHardStop(avgEntry, px, p.hardStopPct)) return [{ kind: 'exit', target: 'hard_stop' }];
  const heldMs = ctx.bar.ts - (state.openedAt ?? ctx.bar.ts);
  if (heldMs >= p.maxHoldMin * MIN) return [{ kind: 'exit', target: 'time_exit' }];

  // ── Отложенный BE-update_protection (бар после TP1; firstDecision-ограничение) ──
  if (state.bePending) {
    state.bePending = false;
    state.breakEvenArmed = true;
    return [{ kind: 'update_protection', stop: avgEntry }]; // A2: числовая цена = entryPrice
  }

  // ── TP1 (параметрический tp1Action) ─────────────────────────────────────
  if (!state.tp1Done && shouldTakeTp(avgEntry, px, p.tpLadder.tp1Pct)) {
    state.tp1Done = true;
    const armBe = p.protection.moveProtectionToBEAfterTp1;
    switch (p.tpLadder.tp1Action) {
      case 'full_exit':
        return [{ kind: 'exit', target: 'tp1' }]; // полный выход (без percent)
      case 'milestone_only':
        if (armBe) state.bePending = true; // BE эмитируется следующим баром
        return [{ kind: 'annotate', tags: ['tp1_milestone'], metrics: { tp1Pct: p.tpLadder.tp1Pct } }];
      case 'partial_exit':
      default:
        if (armBe) state.bePending = true; // BE-update_protection — следующим баром
        return [{ kind: 'exit', target: 'tp1', percent: p.tpLadder.tp1ExitPercent }];
    }
  }

  // ── DCA (порт reducer mini-watch + rules.dcaCheck) ──────────────────────
  const miniWatch = state.miniWatch;
  if (miniWatch !== null) {
    if (ctx.bar.low < miniWatch.localLowAfterSignal) miniWatch.localLowAfterSignal = ctx.bar.low;
    const lastEntryPrice = state.lastEntryPrice ?? avgEntry;
    const dropFromLastEntryPct =
      lastEntryPrice > 0 ? ((lastEntryPrice - miniWatch.localLowAfterSignal) / lastEntryPrice) * 100 : 0;
    const dropThreshold = p.dca.dropPcts[Math.min(state.dcaCount, p.dca.dropPcts.length - 1)] ?? 0;
    if (state.dcaCount < p.dca.maxAdds && dropFromLastEntryPct >= dropThreshold) {
      const oi3 = oiWindow3(ctx); // C1: недоступно → доливка пропускается (no-throw)
      const candles3 = recentCandles(ctx, 3);
      if (oi3 !== null && candles3.length >= 3) {
        const ev = evaluateDca(
          { candles3, oi3, localLow: miniWatch.localLowAfterSignal, currentPrice: px, dcaCount: state.dcaCount },
          p,
        );
        if (ev.ok) {
          state.dcaCount += 1;
          state.lastEntryPrice = px;
          miniWatch.localLowAfterSignal = px;
          miniWatch.dcaCycleCount = state.dcaCount;
          const mult = p.dca.sizeMultipliers[Math.min(state.dcaCount - 1, p.dca.sizeMultipliers.length - 1)];
          const sizingHint = typeof mult === 'number' ? mult : undefined;
          return [{ kind: 'add_to_position', mode: 'dca', ...(sizingHint !== undefined ? { sizingHint } : {}) }];
        }
      }
    }
  }

  // ── Fail-fast (pre-TP1; по дефолту enabled=false → инертно) ─────────────
  const ff = evaluateFailFast(
    {
      klines: recentCandles(ctx, p.maxHoldMin + 2),
      avgEntry,
      openedAt: state.openedAt ?? ctx.bar.ts,
      tp1Done: state.tp1Done,
      currentClose: px,
    },
    p,
  );
  if (ff) return [{ kind: 'exit', target: 'fail_fast' }];

  return [IDLE];
}
