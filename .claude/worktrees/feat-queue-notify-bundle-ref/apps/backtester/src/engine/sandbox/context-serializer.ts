// 019 — ContextSnapshotSerializer (US2; data-model §5; FR-012/013).
//
// 017 `StrategyContext` → чисто-данные `ContextSnapshot` (без функций / live-ссылок host). Через
// границу sandbox проходит ТОЛЬКО snapshot; live-объект структурно невозможен. Свечи НЕ передаются
// массивом — на шаг `t` host шлёт только `newBar` (закрытая свеча t), harness аккумулирует буфер ≤ t.

import type {
  Bar,
  IntentSnapshot,
  PortfolioSnapshot,
  PositionSnapshot,
  StrategyContext,
} from '@trading/research-contracts/research';
import type { LiqPoint, OiPoint } from '@trading/research-contracts/research';

/** Чисто-данные snapshot контекста хука (host → harness). */
export interface ContextSnapshot {
  readonly run: { readonly runId: string; readonly mode: string; readonly seed: number };
  readonly params: Readonly<Record<string, unknown>>;
  readonly symbol: string;
  readonly barIndex: number;
  readonly bar: Bar; // 017 закрытая свеча t
  readonly position: PositionSnapshot | null;
  readonly pendingIntent: IntentSnapshot | null;
  readonly portfolio: PortfolioSnapshot;
  readonly clockNow: number; // = bar.ts (sim-clock; не функция)
  // 023 (additive, US5/§9) — point-in-time рыночные снимки минуты t (если лента несёт kind).
  // Окна реконструируются в harness из аккумулированных newOi/newLiq-буферов. Кодировка:
  // поле ОПУЩЕНО = kind'а нет в ленте; null = gap минуты t; объект = покрытое значение
  // (liq covered-no-events → {longUsd:0,shortUsd:0}). Следует составу ленты, НЕ dataNeeds (FR-018).
  readonly oiAsOf?: OiPoint | null;
  readonly liqAsOf?: LiqPoint | null;
}

/** Скопировать `Bar` в чистый объект (без заморозки/прото-ссылок). */
export function plainBar(bar: Readonly<Bar>): Bar {
  return { ts: bar.ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
}

function plainPosition(p: Readonly<PositionSnapshot> | null): PositionSnapshot | null {
  if (p === null) return null;
  const out: { side: 'long' | 'short'; size: number; entryPrice: number; stop?: number; take?: number } = {
    side: p.side,
    size: p.size,
    entryPrice: p.entryPrice,
  };
  if (p.stop !== undefined) out.stop = p.stop;
  if (p.take !== undefined) out.take = p.take;
  return out;
}

function plainIntent(i: Readonly<IntentSnapshot> | null): IntentSnapshot | null {
  if (i === null) return null;
  const out: { kind: string; side?: 'long' | 'short'; createdTs: number } = {
    kind: i.kind,
    createdTs: i.createdTs,
  };
  if (i.side !== undefined) out.side = i.side;
  return out;
}

/**
 * Сериализовать 017 `StrategyContext` на баре `barIndex` в чисто-данные `ContextSnapshot`.
 * `params` уже plain-data (017 deep-frozen record значений). `clockNow` = `ctx.clock.now()` (sim-clock).
 */
export function serializeContext(ctx: StrategyContext, barIndex: number): ContextSnapshot {
  const base: ContextSnapshot = {
    run: { runId: ctx.run.runId, mode: ctx.run.mode, seed: ctx.run.seed },
    params: ctx.params,
    symbol: ctx.symbol,
    barIndex,
    bar: plainBar(ctx.bar),
    position: plainPosition(ctx.position),
    pendingIntent: plainIntent(ctx.pendingIntent),
    portfolio: { equity: ctx.portfolio.equity, openPositions: ctx.portfolio.openPositions },
    clockNow: ctx.clock.now(),
  };
  // 023: рыночные поля — ТОЛЬКО когда лента несёт kind (composition-following). Наличие kind детектим
  // через непустое окно за t (oiWindow(1).length>0 ⇔ OI в ленте); поле опускаем иначе. null = gap(t).
  const m = ctx.market;
  if (m === undefined) return base;
  const oiPresent = m.oiWindow(1).length > 0;
  const liqPresent = m.liqWindow(1).length > 0;
  return {
    ...base,
    ...(oiPresent ? { oiAsOf: m.oiAsOf() ?? null } : {}),
    ...(liqPresent ? { liqAsOf: m.liqAsOf() ?? null } : {}),
  };
}
