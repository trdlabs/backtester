// 018 — оркестратор прогона (contracts/runner-api.md §Конвейер, research R5/R8, FR-001/005/006).
//
// Validate-first конвейер (fail-fast): 017 run-request → резолв ссылок в registry → 017 module →
// baseline + variant RunTarget → детерминированный closed-candle проход (канонический внутри-барный
// порядок R8) с overlay-композицией в точках перехвата → сборка `BacktestRunResult` + comparison.
// Любой предпрогонный отказ ⇒ `{status:'rejected', validation}` без симуляции (SC-003).

import { CONTRACT_VERSION, SUPPORTED_MARKET_DATA_KINDS, platformContractContext } from '@trading/research-contracts/research';
import type { Bar } from '@trading/research-contracts/research';
import type { CoverageModel, MarketTapeDataset } from '@trading/research-contracts/research';
import type { StrategyContext, StrategyDecision } from '@trading/research-contracts/research';
import type { BacktestRunRequest, Ref } from '@trading/research-contracts/research';
import type { ValidationCode, ValidationIssue, ValidationResult } from '@trading/research-contracts/research';
import { validate } from './validation/index.js';

import type {
  BacktestRunResult,
  ComparisonSummary,
  DecisionRecord,
  EquityPoint,
  ResolvedOverlay,
  RiskDecision,
  RunEvidence,
  RunOutcome,
  RunSummary,
  RunTarget,
  ResolvedStrategy,
  SimulatedFill,
  Trade,
} from './artifacts.js';
import { type PerBarState, PointInTimeContextBuilder } from './context.js';
import { type CandleDataset, loadCandleDataset } from './dataset.js';
import { ExecutionSimulator } from './execution.js';
import { computeBarFunding } from './funding.js';
import { computeComparison, computeMetrics, effectiveElapsedYears, INITIAL_EQUITY } from './metrics.js';
import { type ModuleExecutor, type ExecutorRouter, createTrustedRouter, firstDecision } from './module-executor.js';
// Type-only (erased at runtime ⇒ 018 НЕ зависит от 019 в рантайме): форма реестра sandbox-политик
// для additive-полей RunDeps. Sandbox-aware router передаётся явно через `deps.router` (строит 019).
import type { SandboxPolicyRegistry } from './sandbox-policy.js';
import { OverlayComposer } from './overlay.js';
import { Portfolio } from './portfolio.js';
import { fundingReadingAt } from './market-tape.js';
import { SUPPORTED_FILL_MODEL_KINDS } from './profiles.js';
import { detectProtection } from './protection.js';
import { type TrustedModuleRegistry } from './registry.js';
import { RiskEngine } from './risk.js';
import { createSeededRng } from '../determinism/rng.js';
import { mergeAccumulators } from './bar-major-aggregate.js';

/** Зависимости прогона (contracts/runner-api.md §RunDeps; 019 additive — всё опционально). */
export interface RunDeps {
  readonly registry: TrustedModuleRegistry;
  readonly executor?: ModuleExecutor; // 018 legacy override (сохраняется)
  readonly dataset?: CandleDataset;
  // 023 — мульти-source рыночная лента (trusted-путь). Если несёт OI/liq, runner строит `ctx.market`
  // по составу ленты; служит и источником свечей (superset `CandleDataset`). Отсутствие → путь 018 неизменен.
  readonly marketTape?: MarketTapeDataset;
  readonly router?: ExecutorRouter; // 019 — sandbox-aware router; дефолт = trusted-only
  readonly sandboxPolicyRef?: Ref; // 019 — дефолт default_sandbox@1.0.0 (используется при сборке router'а)
  readonly sandboxPolicies?: SandboxPolicyRegistry; // 019
  /** 17b: batch flat-stretch onBarClose calls into one sandbox message. Absent ⇒ lockstep (default). */
  readonly barBatching?: { readonly maxBars: number };
  /** 17c: universe-session cap + scaled-policy memory knobs. Absent/disabled ⇒ no cap, no scaled policy (byte-identical). */
  readonly universe?: { readonly enabled: boolean; readonly maxN: number; readonly memBaseMb: number; readonly memPerSymbolMb: number };
  /** Bar-major execution flip: N>1-symbol runs get per-symbol independent portfolios interleaved by union timestamp. Absent/false ⇒ symbol-major (default, byte-identical). N=1 unaffected either way. */
  readonly barMajor?: boolean;
  /** Slice B: collapse the bar-major inner loop into a 3-phase batched form (one executeStrategyHookBarMajor call per union-ts instead of per-symbol onBarClose calls). Absent/false ⇒ Slice A interleave (default, byte-identical). Only meaningful when barMajor is on. */
  readonly barMajorBatch?: boolean;
}

/** Поддерживаемые точки перехвата overlay (MVP). */
const SUPPORTED_INTERCEPTION_POINTS = new Set(['entry', 'signal', 'post_entry_management']);

function refOf(id: string, version: string): Ref {
  return { id, version };
}

function rejected(code: ValidationCode, message: string, path: string): RunOutcome {
  const validation: ValidationResult = {
    status: 'rejected',
    issues: [{ severity: 'error', code, message, path }],
  };
  return { status: 'rejected', validation };
}

/** 023: объявленные ПОДДЕРЖАННЫЕ market-kind'ы (baseline + overlays), дедуп (R6/US4). */
function declaredMarketKinds(
  strategy: ResolvedStrategy,
  overlays: readonly ResolvedOverlay[],
): readonly string[] {
  const kinds = new Set<string>();
  const scan = (dn: Readonly<Record<string, unknown>>): void => {
    for (const k of SUPPORTED_MARKET_DATA_KINDS) if (dn[k] === true) kinds.add(k);
  };
  scan(strategy.manifest.dataNeeds as Readonly<Record<string, unknown>>);
  for (const o of overlays) scan(o.manifest.dataNeeds as Readonly<Record<string, unknown>>);
  return [...kinds];
}

/**
 * 023: kind ПОЛНОСТЬЮ не покрыт ⇔ ни для одного запрошенного символа нет покрытых минут (R6/US4).
 * Частичные пропуски (есть >0 покрытых минут где-либо) — НЕ полностью непокрыт (прогон идёт, gap/undefined).
 * Отсутствие ленты вовсе → полностью непокрыт.
 */
function isKindFullyUncovered(
  coverage: CoverageModel | undefined,
  symbols: readonly string[],
  kind: string,
): boolean {
  if (coverage === undefined) return true;
  for (const sym of symbols) {
    const entry = coverage.entries.find((e) => e.symbol === sym && e.kind === kind);
    if (entry !== undefined && entry.coveredMinutes > 0) return false;
  }
  return true;
}

/** Мутабельная запись ордера (статус обновляется при fill); читается как `SimulatedOrder` в артефакте. */
interface MutableOrder {
  id: string;
  decisionBarIndex: number;
  side: 'long' | 'short';
  intent: 'open' | 'close' | 'add';
  status: 'pending' | 'filled' | 'expired';
  /** Режим доливки (только intent `add`); 024 evidence (R4/R5). */
  mode?: 'dca' | 'scale_in';
  /** Доля частичного закрытия 0<p<1 (только частичный intent `close`); 024 evidence (R5). */
  closeFraction?: number;
  /** `'protection'` для синтетического runner-owned protection-ордера; 024 US3 (R5). */
  origin?: 'protection';
}

/** 035 (realism) — one per-bar funding charge while a position was open (append-only; empty on default path). */
export interface FundingLedgerEntry {
  readonly barIndex: number;
  readonly ts: number;
  readonly rate: number;
  readonly covered: boolean;
  readonly cost: number;
}

/** Аккумуляторы артефактов одного таргета. */
export interface RunAccumulators {
  readonly decisionRecords: DecisionRecord[];
  readonly orders: MutableOrder[];
  readonly fills: SimulatedFill[];
  readonly riskDecisions: RiskDecision[];
  readonly trades: Trade[];
  readonly equityCurve: EquityPoint[];
  readonly fundingLedger: FundingLedgerEntry[];
  readonly validationIssues: ValidationIssue[];
}

function orderId(symbol: string, barIndex: number, intent: 'open' | 'close' | 'add'): string {
  return `ord-${symbol}-${barIndex}-${intent}`;
}

/** Снимок состояния портфеля/позиции для контекста на mark-цене. */
function stateAt(portfolio: Portfolio, mark: number): PerBarState {
  const pos = portfolio.position;
  return {
    // 024 (US3): protection-видимость хукам через PositionSnapshot.stop/take (FR-016). Опц. ключи
    // опускаются для позиций без protection → форма снимка байт-идентична 018 (sandbox-форма IPC не меняется).
    position:
      pos === null
        ? null
        : {
            side: pos.side,
            size: pos.size,
            entryPrice: pos.entryPrice,
            ...(pos.stop !== undefined ? { stop: pos.stop } : {}),
            ...(pos.take !== undefined ? { take: pos.take } : {}),
          },
    pendingIntent: null,
    portfolio: { equity: portfolio.equityAt(mark), openPositions: portfolio.openPositions },
  };
}

/** Разбиение overlay'ев таргета по точкам перехвата. */
interface OverlaySplit {
  readonly entry: readonly ResolvedOverlay[];
  readonly post: readonly ResolvedOverlay[];
}

function splitOverlays(overlays: readonly ResolvedOverlay[]): OverlaySplit {
  const entry: ResolvedOverlay[] = [];
  const post: ResolvedOverlay[] = [];
  for (const o of overlays) {
    const ip = o.manifest.interceptionPoint;
    if (ip === 'post_entry_management') post.push(o);
    else entry.push(o); // entry/signal
  }
  return { entry, post };
}

/** Исполнить pending-ордер по `fillBase` (next-bar-open → `bar.open`; same_bar_close → `bar.close`). */
function settlePending(
  bar: Readonly<Bar>,
  barIndex: number,
  portfolio: Portfolio,
  exec: ExecutionSimulator,
  acc: RunAccumulators,
  fillBase: number,
): void {
  const pending = portfolio.pending;
  if (pending === null) return;
  const order = acc.orders.find((o) => o.id === pending.id);

  if (pending.intent === 'open') {
    const calc = exec.computeOpenFill(pending.side, fillBase, pending.sizingPct ?? 1, portfolio.cash);
    portfolio.settleOpen({ fillPrice: calc.fillPrice, fee: calc.fee, size: calc.size, barIndex, ts: bar.ts });
    acc.fills.push({
      orderId: pending.id,
      fillBarIndex: barIndex,
      fillTs: bar.ts,
      fillPrice: calc.fillPrice,
      baseOpen: calc.baseOpen,
      slippageBps: calc.slippageBps,
      feePaid: calc.fee,
      size: calc.size,
    });
  } else if (pending.intent === 'add') {
    // 024 (US1): доливка исполняется по open(t+1) механикой open-fill (R4/§5); вторая позиция не создаётся.
    const calc = exec.computeOpenFill(pending.side, fillBase, pending.sizingPct ?? 1, portfolio.cash);
    portfolio.settleAdd(
      { fillPrice: calc.fillPrice, fee: calc.fee, size: calc.size, barIndex, ts: bar.ts },
      pending.mode ?? 'dca',
    );
    acc.fills.push({
      orderId: pending.id,
      fillBarIndex: barIndex,
      fillTs: bar.ts,
      fillPrice: calc.fillPrice,
      baseOpen: calc.baseOpen,
      slippageBps: calc.slippageBps,
      feePaid: calc.fee,
      size: calc.size,
      kind: 'add',
    });
  } else {
    // close: полное (`settleClose`) либо частичное (`settlePartialClose`) по `pending.closeFraction`.
    // 024 (US2): закрытый размер квантизуется единым источником `closedSizeAt` → fee на закрытую долю.
    const fraction = pending.closeFraction;
    const isPartial = fraction !== undefined;
    const closedSize = portfolio.position === null ? 0 : portfolio.closedSizeAt(fraction ?? 1);
    const calc = exec.computeCloseFill(pending.side, fillBase, closedSize);
    const reason = pending.closeReason ?? 'strategy_exit';
    const trade = isPartial
      ? portfolio.settlePartialClose({ fillPrice: calc.fillPrice, fee: calc.fee, barIndex, ts: bar.ts }, fraction, reason)
      : portfolio.settleClose({ fillPrice: calc.fillPrice, fee: calc.fee, barIndex, ts: bar.ts }, reason);
    acc.fills.push({
      orderId: pending.id,
      fillBarIndex: barIndex,
      fillTs: bar.ts,
      fillPrice: calc.fillPrice,
      baseOpen: calc.baseOpen,
      slippageBps: calc.slippageBps,
      feePaid: calc.fee,
      size: closedSize,
      ...(isPartial ? { kind: 'close' as const } : {}),
    });
    acc.trades.push(trade);
  }

  if (order !== undefined) order.status = 'filled';
}

/**
 * 024 (US3, R7 шаг 2): intrabar protection-check на баре `t`. Активен ⟺ позиция несёт stop/take (R1) —
 * иначе ветка пуста (ранний `return`) и порядок/выходы байт-идентичны 018 (FR-022). При хите —
 * **runner-owned закрытие всего остатка** по gap-aware `fillBase` (R2) → синтетический ордер
 * `origin:'protection'` (id `ord-{sym}-{t}-protection`, не коллизирует со strategy `-close`), fill
 * (`kind:'protection'`), `Trade(stop_hit|take_hit)`. Позиция → flat → пре-эмпт хуков того же бара (FR-021).
 */
function runProtectionCheck(
  bar: Readonly<Bar>,
  barIndex: number,
  symbol: string,
  portfolio: Portfolio,
  exec: ExecutionSimulator,
  acc: RunAccumulators,
): void {
  const pos = portfolio.position;
  if (pos === null || (pos.stop === undefined && pos.take === undefined)) return;
  const hit = detectProtection(pos.side, pos.entryPrice, pos.stop, pos.take, bar);
  if (hit === null) return;

  const calc = exec.computeProtectionFill(pos.side, hit.fillBase, pos.size);
  const id = `ord-${symbol}-${barIndex}-protection`;
  const size = pos.size;
  acc.orders.push({ id, decisionBarIndex: barIndex, side: pos.side, intent: 'close', status: 'filled', origin: 'protection' });
  const trade = portfolio.closePosition({ fillPrice: calc.fillPrice, fee: calc.fee, barIndex, ts: bar.ts }, hit.kind);
  acc.fills.push({
    orderId: id,
    fillBarIndex: barIndex,
    fillTs: bar.ts,
    fillPrice: calc.fillPrice,
    baseOpen: calc.baseOpen,
    slippageBps: calc.slippageBps,
    feePaid: calc.fee,
    size,
    kind: 'protection',
  });
  acc.trades.push(trade);
}

/** Контекст одного таргета (зависимости движка). */
interface SimEngine {
  readonly router: ExecutorRouter;
  readonly risk: RiskEngine;
  readonly exec: ExecutionSimulator;
  readonly composer: OverlayComposer;
}

/** Loop-invariant per-symbol environment shared by every per-bar stage (17b refactor). */
interface BarEnv {
  readonly symbol: string;
  readonly candles: readonly Readonly<Bar>[];
  readonly builder: PointInTimeContextBuilder;
  readonly strategy: ResolvedStrategy;
  readonly overlays: OverlaySplit;
  readonly portfolio: Portfolio;
  readonly engine: SimEngine;
  readonly acc: RunAccumulators;
  readonly module: ResolvedStrategy['module'];
  readonly strategyExec: ModuleExecutor;
  readonly fundingCol: ReturnType<NonNullable<MarketTapeDataset['funding']>> | undefined;
  readonly gridTs: readonly number[];
  /** 17b: flat-stretch batching config, read by `runSymbol`'s loop (Task 4). Absent ⇒ lockstep. */
  readonly batch?: { readonly maxBars: number };
}

/** Stages (1)+(2): settle pending from t-1 at open(t), then intrabar protection check. */
function preBarStages(env: BarEnv, t: number): void {
  const { candles, portfolio, engine, acc, symbol } = env;
  const bar = candles[t];
  if (portfolio.pending !== null && portfolio.pending.decisionBarIndex === t - 1) {
    settlePending(bar, t, portfolio, engine.exec, acc, bar.open);
  }
  runProtectionCheck(bar, t, symbol, portfolio, engine.exec, acc);
}

async function processBar(env: BarEnv, t: number, base: StrategyDecision | null): Promise<void> {
  const { symbol, candles, builder, overlays, portfolio, engine, acc, module, strategyExec, fundingCol, gridTs } = env;
  const { router, risk, exec, composer } = engine;
  const bar = candles[t];

  // NOTE (17b): stages (1)+(2) intentionally do NOT live here — they run BEFORE the executor call
  // in lockstep, so they live in preBarStages() and the caller invokes preBarStages(t) → obtain
  // base → processBar(t, base). processBar covers stages (3)..(5) only. This split keeps the
  // lockstep order byte-identical and lets the batch path interleave the same pre-stages per bar.

  // (3) apply base → entry/signal overlay'и → risk → pending(open).
  // 17b: base приходит от вызывающего (runSymbol сегодня; batch-путь — Task 4) и может быть `null`
  // (пропуск executor-хука); совпадает с fallback'ом самого firstDecision (`{kind:'idle'}`).
  const ctx = builder.build(t, stateAt(portfolio, bar.close));
  const comp = await composer.compose(base ?? { kind: 'idle' }, overlays.entry, async (o) => {
    const ds = await router.forOverlay(o).executeOverlayApply(o.module, ctx);
    return ds.length > 0 ? ds[0] : null;
  });
  if (comp.error !== undefined) {
    acc.validationIssues.push({ severity: 'error', code: comp.error.code, message: comp.error.message, path: `/overlayComposition/${symbol}/${t}/onBarClose` });
  }
  let riskDecision: RiskDecision | null = null;
  const final = comp.finalDecision;
  if (final !== null && portfolio.isFlat && portfolio.pending === null) {
    if (final.kind === 'enter') {
      const outcome = risk.evaluate(final, t, portfolio.openPositions);
      acc.riskDecisions.push(outcome.record);
      riskDecision = outcome.record;
      if (outcome.action !== 'reject') {
        const id = orderId(symbol, t, 'open');
        // 024 (US3): нормализованные protection-дистанции переносятся на pending → активны на входе
        // (после settleOpen). Отсутствие → ключи опущены → байт-идентичность 018.
        const prot = {
          ...(outcome.stop !== undefined ? { stop: outcome.stop } : {}),
          ...(outcome.take !== undefined ? { take: outcome.take } : {}),
        };
        acc.orders.push({ id, decisionBarIndex: t, side: final.side, intent: 'open', status: 'pending' });
        portfolio.placePending({ id, symbol, side: final.side, intent: 'open', decisionBarIndex: t, sizingPct: outcome.sizingPct, ...prot });
      }
    } else if (final.kind === 'add_to_position') {
      // 024 (US1): `add_to_position` при flat → детерминированный reject `add_without_position`;
      // новая позиция НЕ открывается (ни ордера, ни pending).
      const outcome = risk.evaluate(final, t, portfolio.openPositions);
      acc.riskDecisions.push(outcome.record);
      riskDecision = outcome.record;
    } else if (final.kind === 'update_protection') {
      // 024 (US3): `update_protection` при flat → reject `update_without_position` (запись, без мутации).
      const outcome = risk.evaluate(final, t, portfolio.openPositions);
      acc.riskDecisions.push(outcome.record);
      riskDecision = outcome.record;
    }
  }
  acc.decisionRecords.push({
    barIndex: t,
    barTs: bar.ts,
    symbol,
    hook: 'onBarClose',
    baseDecision: base ?? { kind: 'idle' },
    overlayEffects: comp.effects,
    finalDecision: final,
    riskDecision,
  });

  // (3) post_entry_management: запускается, если позиция открыта И есть хук ИЛИ post-overlay'и.
  //     Отсутствующий базовый хук ⇒ синтетический `{kind:'idle'}` (overlay применяется к своей точке).
  if (portfolio.position !== null && (module.onPositionBar !== undefined || overlays.post.length > 0)) {
    const ctxPos = builder.build(t, stateAt(portfolio, bar.close));
    const posBase: StrategyDecision =
      module.onPositionBar !== undefined
        ? firstDecision(await strategyExec.executeStrategyHook(module, 'onPositionBar', ctxPos))
        : { kind: 'idle' };
    const compPos = await composer.compose(posBase, overlays.post, async (o) => {
      const ds = await router.forOverlay(o).executeOverlayApply(o.module, ctxPos);
      return ds.length > 0 ? ds[0] : null;
    });
    if (compPos.error !== undefined) {
      acc.validationIssues.push({ severity: 'error', code: compPos.error.code, message: compPos.error.message, path: `/overlayComposition/${symbol}/${t}/onPositionBar` });
    }
    let posRisk: RiskDecision | null = null;
    const posFinal = compPos.finalDecision;
    if (posFinal !== null && portfolio.position !== null && portfolio.pending === null) {
      if (posFinal.kind === 'exit') {
        // 024 (US2): risk нормализует `exit.percent` (R3). reject (`invalid_exit_percent`) → нет ордера;
        // accept partial → `closeFraction` несётся в ордер/pending; accept/clamp full → ключ опущен.
        const outcome = risk.evaluate(posFinal, t, portfolio.openPositions);
        acc.riskDecisions.push(outcome.record);
        posRisk = outcome.record;
        if (outcome.action !== 'reject') {
          const pos = portfolio.position;
          const id = orderId(symbol, t, 'close');
          const frac = outcome.closeFraction !== undefined ? { closeFraction: outcome.closeFraction } : {};
          acc.orders.push({ id, decisionBarIndex: t, side: pos.side, intent: 'close', status: 'pending', ...frac });
          portfolio.placePending({ id, symbol, side: pos.side, intent: 'close', decisionBarIndex: t, closeReason: posFinal.target, ...frac });
        }
      } else if (posFinal.kind === 'add_to_position') {
        // 024 (US1): доливка существующей позиции — risk(add) → placePending(add) → settleAdd по open(t+1).
        const pos = portfolio.position;
        const posCtx = { size: pos.size, entryPrice: pos.entryPrice, addCount: pos.addCount ?? 0, cash: portfolio.cash };
        const outcome = risk.evaluate(posFinal, t, portfolio.openPositions, posCtx);
        acc.riskDecisions.push(outcome.record);
        posRisk = outcome.record;
        if (outcome.action !== 'reject') {
          const id = orderId(symbol, t, 'add');
          acc.orders.push({ id, decisionBarIndex: t, side: pos.side, intent: 'add', status: 'pending', mode: outcome.mode });
          portfolio.placePending({ id, symbol, side: pos.side, intent: 'add', decisionBarIndex: t, sizingPct: outcome.sizingPct, mode: outcome.mode });
        }
      } else if (posFinal.kind === 'update_protection') {
        // 024 (US3): применяется к `_position` немедленно; по порядку прохода (protection-check бара t
        // уже прошёл) активно со СЛЕДУЮЩЕГО бара (структурный no-lookahead, R7). Без pending/ордера.
        const outcome = risk.evaluate(posFinal, t, portfolio.openPositions);
        acc.riskDecisions.push(outcome.record);
        posRisk = outcome.record;
        if (outcome.action !== 'reject') {
          portfolio.updateProtection(outcome.stop, outcome.take);
        }
      }
    }
    acc.decisionRecords.push({
      barIndex: t,
      barTs: bar.ts,
      symbol,
      hook: 'onPositionBar',
      baseDecision: posBase,
      overlayEffects: compPos.effects,
      finalDecision: posFinal,
      riskDecision: posRisk,
    });
  }

  // same_bar_close: settle a pending placed THIS bar at close(t) — no cross-bar deferral, no look-ahead.
  if (exec.settlesSameBar() && portfolio.pending !== null && portfolio.pending.decisionBarIndex === t) {
    settlePending(bar, t, portfolio, exec, acc, bar.close);
  }

  // (4.5) 035 (realism) — end-of-bar funding accrual. Opt-in: only when the profile carries a
  // fundingModel. End-of-bar placement ⇒ equityAt(close) already includes this bar's funding (no lag).
  // Correct boundary semantics under next_bar_open: entry bar held full → charged; exit bar held 0 → skipped.
  if (exec.fundingEnabled() && portfolio.position !== null) {
    const pos = portfolio.position;
    const reading = fundingReadingAt(fundingCol, gridTs, bar.ts, t);
    const covered = reading.state !== 'missing';
    const rate = covered && reading.point !== undefined ? reading.point.fundingRate : 0;
    // P2-19: prorate over the ACTUAL interval since the previous processed bar (ts[t] - ts[t-1]), NOT a
    // single gridMinutes extrapolated from the first two bars — a start gap must not 2× every bar, and a
    // mid-run gap must charge its real interval. t is always ≥ 1 here (under next_bar_open a position
    // cannot exist on bar 0), so no first-interval extrapolation is needed; covered=false still → 0.
    const barMinutes = t >= 1 ? (gridTs[t]! - gridTs[t - 1]!) / 60_000 : 0;
    const cost = computeBarFunding({
      side: pos.side,
      size: pos.size,
      mark: bar.close,
      rate8h: rate,
      covered,
      barMinutes,
      intervalHours: exec.fundingIntervalHours(),
    }).toNumber();
    portfolio.chargeFunding(cost);
    acc.fundingLedger.push({ barIndex: t, ts: bar.ts, rate, covered, cost });
  }

  // (5) EquityPoint — mark-to-market по close бара.
  acc.equityCurve.push({ barIndex: t, barTs: bar.ts, equity: portfolio.equityAt(bar.close) });
}

/** Setup half of `runSymbol` (17b/Task-3 refactor): grid/funding derivation, session init, `BarEnv` construction. Callers must ensure `candles.length >= 1`. */
async function buildBarEnv(
  symbol: string,
  candles: readonly Readonly<Bar>[],
  builder: PointInTimeContextBuilder,
  strategy: ResolvedStrategy,
  overlays: OverlaySplit,
  portfolio: Portfolio,
  engine: SimEngine,
  acc: RunAccumulators,
  marketTape: MarketTapeDataset | undefined,
  barBatching: { readonly maxBars: number } | undefined,
): Promise<BarEnv> {
  const n = candles.length;
  const { router, risk, exec, composer } = engine;
  const fundingCol = exec.fundingEnabled() ? marketTape?.funding(symbol) : undefined;
  const gridTs = exec.fundingEnabled() ? candles.map((b) => b.ts) : [];
  const module = strategy.module;
  const strategyExec = router.forStrategy(strategy);

  // 019: session-lifecycle через seam. trusted → module.init?(ctx) (поведение 018 неизменно);
  // sandbox → открыть контейнер + init-хук. Вызывается всегда (sandbox-сессия открывается и без 'init').
  await strategyExec.initStrategy?.(module, builder.build(0, stateAt(portfolio, candles[0].close)));

  return { symbol, candles, builder, strategy, overlays, portfolio, engine, acc, module, strategyExec, fundingCol, gridTs, ...(barBatching ? { batch: barBatching } : {}) };
}

/** End-of-data half of `runSymbol` (17b/Task-3 refactor): expire leftover pending, forced MTM close, session dispose. Assumes `env.candles.length >= 1`. */
async function finalizeSymbol(env: BarEnv): Promise<void> {
  const { candles, portfolio, acc, strategyExec, module, builder } = env;
  const n = candles.length;

  // End-of-data: leftover pending (решение на ПОСЛЕДНЕМ баре, нет next-bar для settle) → expired
  // (без сделки, без ошибки; FR-020, US5-AC3).
  const expired = portfolio.expirePending();
  if (expired !== null) {
    const order = acc.orders.find((o) => o.id === expired.id);
    if (order !== undefined) order.status = 'expired';
  }

  // End-of-data forced MTM открытой позиции.
  const last = candles[n - 1];
  const forced = portfolio.forcedMtmClose(n - 1, last.ts, last.close);
  if (forced !== null) acc.trades.push(forced);

  // 019: dispose через seam (trusted → module.dispose?; sandbox → dispose-хук, если объявлен).
  await strategyExec.disposeStrategy?.(module, builder.build(n - 1, stateAt(portfolio, last.close)));
}

/** Детерминированный проход одного символа (внутри-барный порядок R8) с overlay-композицией. */
async function runSymbol(
  symbol: string,
  candles: readonly Readonly<Bar>[],
  builder: PointInTimeContextBuilder,
  strategy: ResolvedStrategy,
  overlays: OverlaySplit,
  portfolio: Portfolio,
  engine: SimEngine,
  acc: RunAccumulators,
  marketTape: MarketTapeDataset | undefined,
  barBatching: { readonly maxBars: number } | undefined,
): Promise<void> {
  const n = candles.length;
  if (n === 0) return;
  const env = await buildBarEnv(symbol, candles, builder, strategy, overlays, portfolio, engine, acc, marketTape, barBatching);
  const { strategyExec, module } = env;

  for (let t = 0; t < n; t += 1) {
    preBarStages(env, t);

    const batchCfg = env.batch;
    if (
      batchCfg !== undefined &&
      batchCfg.maxBars >= 2 &&
      strategyExec.executeStrategyHookBatch !== undefined &&
      portfolio.position === null &&
      portfolio.pending === null &&
      overlays.entry.length === 0 &&
      overlays.post.length === 0 &&
      t + 1 < n
    ) {
      // Flat stretch: snapshots for t..t+k are a pure function of the tape (portfolio constant).
      const upTo = Math.min(n, t + batchCfg.maxBars);
      const ctxs: StrategyContext[] = [];
      for (let j = t; j < upTo; j += 1) {
        ctxs.push(builder.build(j, stateAt(portfolio, candles[j].close)));
      }
      const { stoppedAt, decisions } = await strategyExec.executeStrategyHookBatch(module, ctxs);
      // Empty prefix: SAME per-bar body with base = null (byte-identical bookkeeping).
      for (let j = 0; j < stoppedAt; j += 1) {
        await processBar(env, t + j, null);
        if (j < stoppedAt - 1) preBarStages(env, t + j + 1); // no-ops while flat; keeps stage order
      }
      if (stoppedAt > 0) preBarStages(env, t + stoppedAt);
      await processBar(env, t + stoppedAt, firstDecision(decisions));
      t += stoppedAt; // loop's t += 1 completes the stoppedAt + 1 advance
      continue;
    }

    const ctx = builder.build(t, stateAt(portfolio, candles[t].close));
    const base = firstDecision(await strategyExec.executeStrategyHook(module, 'onBarClose', ctx));
    await processBar(env, t, base);
  }

  await finalizeSymbol(env);
}

/** Детерминированный closed-candle проход одного таргета → `BacktestRunResult` (research R8). */
async function simulateTarget(
  target: RunTarget,
  request: BacktestRunRequest,
  dataset: CandleDataset,
  engine: SimEngine,
  riskProfileRef: Ref,
  executionProfileRef: Ref,
  marketTape: MarketTapeDataset | undefined,
  barBatching: { readonly maxBars: number } | undefined,
  barMajor: boolean,
  barMajorBatch: boolean,
): Promise<BacktestRunResult> {
  const acc: RunAccumulators = {
    decisionRecords: [],
    orders: [],
    fills: [],
    riskDecisions: [],
    trades: [],
    equityCurve: [],
    fundingLedger: [],
    validationIssues: [],
  };

  const portfolio = new Portfolio(INITIAL_EQUITY);
  const params = {
    ...((target.strategy.manifest.params as Record<string, unknown> | undefined) ?? {}),
    ...((request.params as Record<string, unknown> | undefined) ?? {}),
  };
  const overlays = splitOverlays(target.overlays);

  let barsProcessed = 0;
  if (barMajor && request.symbols.length > 1) {
    barsProcessed = await runBarMajor(target, request, dataset, engine, acc, params, overlays, marketTape, barMajorBatch);
  } else {
    for (const symbol of request.symbols) {
      const candles = dataset.candles(symbol);
      const builder = new PointInTimeContextBuilder({
        run: { runId: target.runId, mode: request.mode, seed: request.seed },
        params,
        symbol,
        candles,
        rng: createSeededRng(request.seed),
        // 023: лента передаётся в builder; ctx.market выставляется по составу ленты (composition-following).
        ...(marketTape !== undefined ? { marketTape } : {}),
      });
      // Per-symbol изоляция module-state: если стратегия несёт `moduleFactory` (trusted), инстанцируем
      // её свежей на КАЖДЫЙ символ — FSM-state в замыкании `createStrategyModule` не протекает между
      // символами (паритет с sandbox, где каждый символ исполняется в своей сессии). Без фабрики —
      // переиспользуем единственный `module` (поведение single-symbol неизменно).
      const symbolStrategy =
        target.strategy.moduleFactory !== undefined
          ? { ...target.strategy, module: target.strategy.moduleFactory(params) }
          : target.strategy;
      await runSymbol(symbol, candles, builder, symbolStrategy, overlays, portfolio, engine, acc, marketTape, barBatching);
      barsProcessed += candles.length;
    }
  }

  // 023: coverage заполняется ТОЛЬКО когда лента реально несёт OI/liquidations (есть present-entry).
  // bar_close-only лента (как и OHLCV-only) → coverage undefined → байт-идентичность 018 (SC-001).
  const cov = marketTape !== undefined ? marketTape.coverage() : undefined;
  const coverage = cov !== undefined && cov.entries.some((e) => e.present) ? cov : undefined;
  // Task 5: bar-major (N>1) capitalises N per-symbol accounts equally; symbol-major/N=1 stays
  // undefined so the evidence key is omitted and outputs remain byte-identical (SC-001 style).
  const capitalModel: RunEvidence['capitalModel'] =
    barMajor && request.symbols.length > 1
      ? {
          model: 'equal_weight_per_symbol' as const,
          perSymbolInitialEquity: INITIAL_EQUITY,
          symbolCount: request.symbols.length,
          aggregateBaseline: INITIAL_EQUITY * request.symbols.length,
        }
      : undefined;
  return assembleResult(target, request, acc, barsProcessed, riskProfileRef, executionProfileRef, coverage, capitalModel);
}

/** Bar-major driver: per-symbol Portfolio, interleaved by union timestamp, aggregated into `acc`. */
async function runBarMajor(
  target: RunTarget,
  request: BacktestRunRequest,
  dataset: CandleDataset,
  engine: SimEngine,
  acc: RunAccumulators,
  params: Record<string, unknown>,
  overlays: OverlaySplit,
  marketTape: MarketTapeDataset | undefined,
  barMajorBatch: boolean,
): Promise<number> {
  const envs: BarEnv[] = [];
  const perAcc: RunAccumulators[] = [];
  const finalized = new Set<BarEnv>();
  try {
    // Phase 1 — setup: one BarEnv (own Portfolio + own acc) per NON-EMPTY symbol.
    for (const symbol of request.symbols) {
      const candles = dataset.candles(symbol);
      if (candles.length === 0) continue; // parity with runSymbol's `n===0` early return — no init for a data-less symbol
      const builder = new PointInTimeContextBuilder({
        run: { runId: target.runId, mode: request.mode, seed: request.seed },
        params, symbol, candles, rng: createSeededRng(request.seed),
        ...(marketTape !== undefined ? { marketTape } : {}),
      });
      const symbolStrategy = target.strategy.moduleFactory !== undefined
        ? { ...target.strategy, module: target.strategy.moduleFactory(params) }
        : target.strategy;
      const symAcc: RunAccumulators = {
        decisionRecords: [], orders: [], fills: [], riskDecisions: [],
        trades: [], equityCurve: [], fundingLedger: [], validationIssues: [],
      };
      const portfolio = new Portfolio(INITIAL_EQUITY);
      // barBatching is undefined in bar-major (flags mutually exclusive).
      const env = await buildBarEnv(symbol, candles, builder, symbolStrategy, overlays, portfolio, engine, symAcc, marketTape, undefined);
      envs.push(env);
      perAcc.push(symAcc);
    }

    // Phase 2 — bar-major loop over the sorted union timeline; per-symbol cursor.
    const cursor = envs.map(() => 0);
    const tsSet = new Set<number>();
    for (const env of envs) for (const c of env.candles) tsSet.add(c.ts);
    const unionTs = [...tsSet].sort((a, b) => a - b);
    for (const ts of unionTs) {
      if (barMajorBatch) {
        // 3-phase: preBarStages+build for all present symbols → ONE batched onBarClose → processBar all.
        // Byte-identical to the interleave below: per-symbol portfolios/accs are independent, so the
        // cross-symbol reorder within a bar cannot change any symbol's result.
        const active: Array<{ env: BarEnv; t: number; ctx: StrategyContext }> = [];
        for (let s = 0; s < envs.length; s += 1) {
          const env = envs[s];
          const t = cursor[s];
          if (env.candles[t]?.ts !== ts) continue;
          preBarStages(env, t);
          active.push({ env, t, ctx: env.builder.build(t, stateAt(env.portfolio, env.candles[t].close)) });
          cursor[s] += 1;
        }
        if (active.length === 0) continue;
        const bases = await active[0]!.env.strategyExec.executeStrategyHookBarMajor(
          active.map((a) => ({ module: a.env.module, ctx: a.ctx })),
        );
        for (let i = 0; i < active.length; i += 1) await processBar(active[i]!.env, active[i]!.t, bases[i]!);
      } else {
        for (let s = 0; s < envs.length; s += 1) {   // Slice A interleave — unchanged
          const env = envs[s];
          const t = cursor[s];
          if (env.candles[t]?.ts !== ts) continue;   // symbol absent at this ts
          preBarStages(env, t);
          const ctx = env.builder.build(t, stateAt(env.portfolio, env.candles[t].close));
          const base = firstDecision(await env.strategyExec.executeStrategyHook(env.module, 'onBarClose', ctx));
          await processBar(env, t, base);
          cursor[s] += 1;
        }
      }
    }

    // Phase 3 — teardown per symbol in request.symbols order.
    let barsProcessed = 0;
    for (const env of envs) {
      await finalizeSymbol(env);
      finalized.add(env);
      barsProcessed += env.candles.length;
    }

    // Phase 4 — aggregate N per-symbol accs into the outer acc.
    const merged = mergeAccumulators(perAcc);
    acc.decisionRecords.push(...merged.decisionRecords);
    acc.orders.push(...merged.orders);
    acc.fills.push(...merged.fills);
    acc.riskDecisions.push(...merged.riskDecisions);
    acc.trades.push(...merged.trades);
    acc.equityCurve.push(...merged.equityCurve);
    acc.fundingLedger.push(...merged.fundingLedger);
    acc.validationIssues.push(...merged.validationIssues);
    return barsProcessed;
  } finally {
    // Best-effort teardown of any env built but not finalized (setup/loop threw mid-way): bar-major
    // holds N live module instances at once, so a partial failure must not leak per-symbol resources.
    // Sandbox container sessions are also closed by runBacktest's `finally { router.closeAll(); }`;
    // this covers the trusted `module.dispose` seam and is idempotent-safe via the `finalized` guard.
    for (const env of envs) {
      if (finalized.has(env)) continue;
      try {
        await env.strategyExec.disposeStrategy?.(
          env.module,
          env.builder.build(env.candles.length - 1, stateAt(env.portfolio, env.candles[env.candles.length - 1].close)),
        );
      } catch {
        /* best-effort cleanup — swallow so the original error propagates */
      }
    }
  }
}

function assembleResult(
  target: RunTarget,
  request: BacktestRunRequest,
  acc: RunAccumulators,
  barsProcessed: number,
  riskProfileRef: Ref,
  executionProfileRef: Ref,
  coverage: CoverageModel | undefined,
  capitalModel?: RunEvidence['capitalModel'],
): BacktestRunResult {
  // P3-7: elapsed for cagr/calmar comes from the REALLY-PROCESSED unique bar timestamps (equity
  // curve), not the requested period — a partially-covered window must not deflate the annualization.
  const elapsedYears = effectiveElapsedYears(acc.equityCurve);
  const metrics = computeMetrics(request.metrics, acc.equityCurve, acc.trades, { elapsedYears });
  const overlayRefs: readonly Ref[] = target.overlays.map((o) => refOf(o.manifest.id, o.manifest.version));

  const summary: RunSummary = {
    targetKind: target.kind,
    moduleRef: refOf(target.strategy.manifest.id, target.strategy.manifest.version),
    overlayRefs,
    symbols: request.symbols,
    barsProcessed,
    ordersCount: acc.orders.length,
    closedTradesCount: acc.trades.length,
  };

  const evidence: RunEvidence = {
    seed: request.seed,
    datasetRef: request.datasetRef,
    contractVersion: CONTRACT_VERSION,
    moduleVersions: [refOf(target.strategy.manifest.id, target.strategy.manifest.version), ...overlayRefs],
    riskProfileRef,
    executionProfileRef,
    simulatedOrders: acc.orders,
    simulatedFills: acc.fills,
    riskDecisions: acc.riskDecisions,
    equityCurve: acc.equityCurve,
    deferredRobustness: (request.robustnessChecks ?? []).map((check) => ({
      check,
      status: 'validated_but_not_computed' as const,
    })),
    // 023: только при наличии (OHLCV-only → undefined → ключ не добавляется → байт-идентичность 018).
    ...(coverage !== undefined ? { coverage } : {}),
    // 035 (realism): только при наличии зарядов (DEFAULT_EXEC → пусто → ключ не добавляется → байт-идентичность).
    ...(acc.fundingLedger.length > 0 ? { fundingLedger: acc.fundingLedger } : {}),
    // Bar-major only (Task 5): только при N>1 bar-major → ключ не добавляется на symbol-major/N=1 → байт-идентичность.
    ...(capitalModel !== undefined ? { capitalModel } : {}),
  };

  return {
    runId: target.runId,
    summary,
    metrics,
    trades: acc.trades,
    decisionRecords: acc.decisionRecords,
    validationIssues: acc.validationIssues,
    artifactRefs: [],
    evidence,
  };
}

/** Публичный вход runner'а (contracts/runner-api.md). Валидирует, резолвит, симулирует baseline+variant. */
export async function runBacktest(request: BacktestRunRequest, deps: RunDeps): Promise<RunOutcome> {
  // 1. 017 run-request validation (fail-fast). До валидации поля request НЕ читаем (incomplete
  //    request не должен ронять runner до ValidationResult). validateRunRequest не использует
  //    knownStrategyRefs → пустой context безопасен.
  const reqValidation = validate({ inputKind: 'run_request', request }, platformContractContext([]));
  if (reqValidation.status === 'rejected') {
    return { status: 'rejected', validation: reqValidation };
  }

  // 2. Резолв baseline-модуля / профилей в registry.
  const strategy = deps.registry.resolveStrategy(request.moduleRef);
  if (strategy === undefined) {
    return rejected('invalid_module_ref', `moduleRef не найден в registry: ${request.moduleRef.id}@${request.moduleRef.version}`, '/moduleRef');
  }
  if (request.riskProfileRef === undefined) {
    return rejected('missing_risk_profile', 'riskProfileRef не привязан', '/riskProfileRef');
  }
  const riskProfile = deps.registry.resolveRiskProfile(request.riskProfileRef);
  if (riskProfile === undefined) {
    return rejected('missing_risk_profile', `riskProfileRef не найден в registry: ${request.riskProfileRef.id}@${request.riskProfileRef.version}`, '/riskProfileRef');
  }
  if (request.executionProfileRef === undefined) {
    return rejected('invalid_module_ref', 'executionProfileRef не привязан', '/executionProfileRef');
  }
  const execProfile = deps.registry.resolveExecutionProfile(request.executionProfileRef);
  if (execProfile === undefined) {
    return rejected('invalid_module_ref', `executionProfileRef не найден в registry: ${request.executionProfileRef.id}@${request.executionProfileRef.version}`, '/executionProfileRef');
  }

  // 024 (US4/R6, FR-010/011/012, SC-009): пре-флайт диспетч `fillModel.kind`. `next_bar_open` → путь
  // 018 без изменений (байт-идентично); иной/неподдержанный kind → reject `unsupported_fill_model_kind`
  // (0 ордеров/fill'ов, no silent fallback — конституция XIV). До симуляции и до конструирования
  // ExecutionSimulator (защитный ассерт в его конструкторе оттого недостижим).
  {
    const fillKind = (execProfile.fillModel as { kind?: unknown }).kind;
    if (typeof fillKind !== 'string' || !(SUPPORTED_FILL_MODEL_KINDS as readonly string[]).includes(fillKind)) {
      return rejected('unsupported_fill_model_kind', `неподдержанный fillModel.kind: ${String(fillKind)}`, '/executionProfile/fillModel/kind');
    }
  }

  // 3. 017 module validation baseline (manifest-only; knownStrategyRefs=[baseline.id]).
  const modValidation = validate({ inputKind: 'module', manifest: strategy.manifest }, platformContractContext([strategy.manifest.id]));
  if (modValidation.status === 'rejected') {
    return { status: 'rejected', validation: modValidation };
  }

  // 4. Резолв + валидация + совместимость overlay'ев (variant).
  const overlayRefs = request.overlayRefs ?? [];
  const resolvedOverlays: ResolvedOverlay[] = [];
  for (let i = 0; i < overlayRefs.length; i += 1) {
    const ref = overlayRefs[i];
    const ro = deps.registry.resolveOverlay(ref);
    if (ro === undefined) {
      return rejected('invalid_module_ref', `overlayRef не найден в registry: ${ref.id}@${ref.version}`, `/overlayRefs/${i}`);
    }
    // 017 module validation overlay (knownStrategyRefs=[baseline.id] → targetStrategyRef совместимость).
    const ov = validate({ inputKind: 'module', manifest: ro.manifest }, platformContractContext([strategy.manifest.id]));
    if (ov.status === 'rejected') {
      return { status: 'rejected', validation: ov };
    }
    // Поддерживаемая точка перехвата (017 её не проверяет — зона runner'а).
    const ip = ro.manifest.interceptionPoint;
    if (typeof ip !== 'string' || !SUPPORTED_INTERCEPTION_POINTS.has(ip)) {
      return rejected('overlay_composition_invalid', `неподдерживаемый interceptionPoint: ${String(ip)}`, `/overlayRefs/${i}`);
    }
    resolvedOverlays.push(ro);
  }

  // 5. Симуляция baseline + (опц.) variant.
  // Router: явный 019 sandbox-aware (deps.router) либо trusted-only дефолт (поведение 018 неизменно).
  // closeAll() в finally → детерминированная очистка всех sandbox-сессий даже при исключении.
  // 023: если передана мульти-source лента — она и источник свечей (superset CandleDataset), и
  // источник ctx.market. Иначе — неизменный OHLCV-only путь 018 (loadCandleDataset).
  const marketTape = deps.marketTape;
  const dataset = deps.dataset ?? marketTape ?? loadCandleDataset(request.datasetRef);

  // 023 preflight-гейт (US4/R6, FR-013/014, SC-005): для КАЖДОГО объявленного поддержанного market-kind
  // (baseline/overlay) проверить покрытие за запрошенные символы. Полностью непокрытый kind → reject ДО
  // симуляции (0 ордеров/fill'ов). Частичные пропуски — НЕ reject (прогон идёт, gap/undefined + coverage).
  // OHLCV-only без таких деклараций → цикл пуст → путь 018 неизменен.
  {
    const declaredKinds = declaredMarketKinds(strategy, resolvedOverlays);
    if (declaredKinds.length > 0) {
      const coverage = marketTape !== undefined ? marketTape.coverage() : undefined;
      for (const kind of declaredKinds) {
        if (isKindFullyUncovered(coverage, request.symbols, kind)) {
          return rejected(
            'missing_required_market_data',
            `объявленный market-kind "${kind}" полностью не покрыт датасетом за запрошенные символы/период`,
            `/dataNeeds/${kind}`,
          );
        }
      }
    }
  }

  // 17c (universe-session cap): reject BEFORE router/engine construction — no sandbox container is
  // ever spawned for an over-cap request (pre-exec validation, not the HTTP submit handler; SC-003).
  if (deps.universe?.enabled === true && request.symbols.length > deps.universe.maxN) {
    return rejected(
      'incomplete_run_request',
      `universe run has ${request.symbols.length} symbols, exceeding the configured limit of ${deps.universe.maxN}`,
      '/symbols',
    );
  }

  const router = deps.router ?? createTrustedRouter(deps.executor);
  const composer = new OverlayComposer();
  const engine: SimEngine = {
    router,
    risk: new RiskEngine(riskProfile),
    exec: new ExecutionSimulator(execProfile),
    composer,
  };

  try {
    const baseline = await simulateTarget(
      { kind: 'baseline', runId: request.runId, strategy, overlays: [] },
      request,
      dataset,
      engine,
      request.riskProfileRef,
      request.executionProfileRef,
      marketTape,
      deps.barBatching,
      deps.barMajor === true,
      deps.barMajorBatch === true,
    );

    let variant: BacktestRunResult | null = null;
    let comparison: ComparisonSummary | null = null;
    if (resolvedOverlays.length > 0) {
      variant = await simulateTarget(
        { kind: 'variant', runId: `${request.runId}::variant`, strategy, overlays: resolvedOverlays },
        request,
        dataset,
        engine,
        request.riskProfileRef,
        request.executionProfileRef,
        marketTape,
        deps.barBatching,
        deps.barMajor === true,
        deps.barMajorBatch === true,
      );
      comparison = computeComparison(baseline, variant);
    }

    return { status: 'completed', baseline, variant, comparison };
  } finally {
    router.closeAll();
  }
}
