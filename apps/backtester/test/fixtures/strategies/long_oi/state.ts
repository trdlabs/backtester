/**
 * 026 Long OI StrategyModule — детерминированный реплеируемый FSM (LongOiModuleState), data-model §4.
 *
 * Чистый модуль: импорт ТОЛЬКО type-only из `@trdlabs/sdk/research-contract` (017/023) + чистые helpers.
 * Без I/O (fs/crypto/path), без wall-clock (только `ctx.clock`/`ctx.bar.ts`), без RNG вне `ctx.rng`.
 *
 * Состояние делится на:
 *  - **Serialize** (path-dependent скаляры): фаза/watch/miniWatch/tp1Done/BE/openedAt/dcaCount/
 *    lastEntryPrice/cooldownUntil/entry-diag — мутируются ТОЛЬКО в хуках (constitution II).
 *  - **Recompute из ctx** (минимизировать surface): series/`klines1m` ← `ctx.data.closedCandles`;
 *    текущие OI/liq ← `ctx.market.oiAsOf/liqAsOf`; `avgEntry`/`size` ← `ctx.position`. НЕ хранится в state.
 *
 * `LongOiWatchSignal` — ПОРТ формы legacy `src/types/signal.ts Signal` (импорт legacy запрещён
 * forbidden-boundary; единый источник alpha-логики — поведенческая карта, не импорт).
 */

import type { StrategyContext, Bar } from '@trdlabs/sdk/research-contract';
import type { OiPoint, LiqPoint } from '@trdlabs/sdk/research-contract';

// ───────────────────────────────────────────────────────────────────────────
// Фаза FSM
// ───────────────────────────────────────────────────────────────────────────

export type LongOiPhase = 'IDLE' | 'WATCHING' | 'IN_POSITION' | 'COOLDOWN';

// ───────────────────────────────────────────────────────────────────────────
// Dump-сигнал (порт формы legacy Signal; источник арминга watch)
// ───────────────────────────────────────────────────────────────────────────

/** Сигнал dump-детекта, армящий watch. Порт формы `src/types/signal.ts Signal` (НЕ импорт). */
export interface LongOiWatchSignal {
  /** Ts свечи-сигнала. */
  ts: number;
  /** Цена сигнала (обычно close свечи-сигнала). */
  signalPrice: number;
  /** Режим триггера (`high_to_low`|`open_to_close`). */
  triggerMode: string;
  /** % срабатывания триггера. */
  triggerPct: number;
  /** Падение open→close (%). */
  dumpPctOpenClose: number;
  /** Падение high→low (%). */
  dumpPctHighLow: number;
  /** Максимум окна. */
  highest: number;
  /** Ts максимума. */
  highestTs: number;
  /** Минимум окна. */
  lowest: number;
  /** Ts минимума. */
  lowTs: number;
  /** Отскок от лоу на момент сигнала (%). */
  bounceFromLowPct: number;
  /** Первый open окна. */
  firstOpen: number;
  /** Последний close (свеча-сигнал). */
  lastClose: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Под-состояния watch / miniWatch
// ───────────────────────────────────────────────────────────────────────────

/** Состояние WATCHING (после арминга dump-сигналом, до входа/таймаута). */
export interface LongOiWatchState {
  signal: LongOiWatchSignal;
  /** Ts арминга watch. */
  startedAt: number;
  /** Ts истечения watch (→ COOLDOWN). */
  expireAt: number;
  /** Локальный минимум после сигнала (отслеживается по-барово). */
  localLowAfterSignal: number;
  /** Локальный максимум после сигнала. */
  localHighAfterSignal: number;
}

/** Состояние miniWatch (поиск DCA-доливки внутри позиции). */
export interface LongOiMiniWatchState {
  /** Новый локальный минимум для переподтверждения DCA. */
  localLowAfterSignal: number;
  /** Счётчик DCA-циклов (для пороговой логики доливок). */
  dcaCycleCount: number;
}

/**
 * Диагностический subset, фиксируемый на входе (entry). Diagnostic-only, сериализуем.
 * Открытая форма (как `watchDiag`/`failFastDiag` в 025) — конкретные ключи заполняются flat_phase (T006).
 */
export type LongOiEntryDiagnostics = Record<string, unknown>;

// ───────────────────────────────────────────────────────────────────────────
// §4 LongOiModuleState — корневое сериализуемое состояние модуля
// ───────────────────────────────────────────────────────────────────────────

/**
 * Path-dependent FSM-состояние. Чистые данные (JSON-сериализуемо: только скаляры/массивы/объекты,
 * без Set/Map/функций) — для реплея/снапшота. Мутируется только в хуках из read-only ctx.
 */
export interface LongOiModuleState {
  /** Текущая фаза FSM. */
  phase: LongOiPhase;
  /** Состояние WATCHING (null вне фазы watch). */
  watch: LongOiWatchState | null;
  /** Состояние miniWatch для DCA (null вне позиции/без активного поиска доливки). */
  miniWatch: LongOiMiniWatchState | null;
  /** TP1 достигнут (для арминга BE и подавления повторного TP1). */
  tp1Done: boolean;
  /**
   * BE-`update_protection` ожидает эмиссии на следующем position-баре. Раннер берёт `firstDecision`
   * хука, поэтому TP1-партиал (`exit.percent`) и BE (`update_protection`) НЕ могут эмитироваться одним
   * баром — BE откладывается на следующий бар (после settle частичного закрытия).
   */
  bePending: boolean;
  /** Защита сдвинута в безубыток после TP1 (BE-`update_protection` уже эмитирован). */
  breakEvenArmed: boolean;
  /** Ts открытия позиции (для time-exit/fail-fast окон); null вне позиции. */
  openedAt: number | null;
  /** Число выполненных DCA-доливок. */
  dcaCount: number;
  /** Цена последнего входа/доливки (якорь порога следующей DCA); null вне позиции. */
  lastEntryPrice: number | null;
  /** Ts окончания COOLDOWN (0 = нет cooldown). */
  cooldownUntil: number;
  /** Диагностический subset входа (diagnostic-only); null вне позиции. */
  entryDiagnostics: LongOiEntryDiagnostics | null;
}

/** Начальное состояние: IDLE, без watch/позиции/cooldown. */
export function createInitialState(): LongOiModuleState {
  return {
    phase: 'IDLE',
    watch: null,
    miniWatch: null,
    tp1Done: false,
    bePending: false,
    breakEvenArmed: false,
    openedAt: null,
    dcaCount: 0,
    lastEntryPrice: null,
    cooldownUntil: 0,
    entryDiagnostics: null,
  };
}

/**
 * Детерминированный снимок состояния (deep-copy чистых данных) для реплея/сравнения.
 * State — JSON-сериализуем по конструкции; round-trip даёт стабильный клон без shared-ссылок.
 */
export function serializeState(state: LongOiModuleState): LongOiModuleState {
  return JSON.parse(JSON.stringify(state)) as LongOiModuleState;
}

// ───────────────────────────────────────────────────────────────────────────
// Recompute-хелперы из ctx (НЕ хранятся в state; минимизация surface, R3/data-model §4)
// ───────────────────────────────────────────────────────────────────────────

/** Снимок позиции, выведенный из `ctx.position` (host-owned economics). */
export interface PositionView {
  side: 'long' | 'short';
  /** Средневзвешенная цена входа (host-снимок). */
  avgEntry: number;
  /** Текущий размер позиции. */
  size: number;
}

/**
 * Серии закрытых свечей строго ДО текущего бара (`klines1m`), из `ctx.data.closedCandles(lookback)`.
 * Порядок — как у контракта (старые→новые по конвенции 017). Деградация (C1): отсутствие данных →
 * пустой массив, без throw.
 */
export function recomputeCandles(ctx: StrategyContext, lookback: number): readonly Readonly<Bar>[] {
  return ctx.data.closedCandles(lookback);
}

/**
 * Текущий OI as-of, из `ctx.market.oiAsOf()`. Деградация (C1): OHLCV-only лента (`ctx.market`
 * отсутствует) ИЛИ gap (`undefined`) → `undefined` — no-throw, БЕЗ подстановки `0`, без NaN.
 * Carry-forward запрещён (gap остаётся `undefined`).
 */
export function recomputeOi(ctx: StrategyContext): OiPoint | undefined {
  return ctx.market?.oiAsOf();
}

/**
 * Текущие liquidations as-of, из `ctx.market.liqAsOf()`. covered-no-events → `{longUsd:0,shortUsd:0}`;
 * gap/OHLCV-only → `undefined`. Деградация (C1): no-throw / no-zero-substitution / no-NaN.
 */
export function recomputeLiq(ctx: StrategyContext): LiqPoint | undefined {
  return ctx.market?.liqAsOf();
}

/**
 * Снимок позиции из `ctx.position`. `avgEntry` = host-снимок `entryPrice`; `size`/`side` — как у host.
 * Вне позиции (`ctx.position===null`) → `null`. Economics/сайзинг/филлы — host-owned (не в state).
 */
export function recomputePositionView(ctx: StrategyContext): PositionView | null {
  const p = ctx.position;
  if (p == null) return null;
  return { side: p.side, avgEntry: p.entryPrice, size: p.size };
}
