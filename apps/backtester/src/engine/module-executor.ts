// 018 — контрактный шов исполнения модулей (data-model §1.1, research R3, FR-004/028).
//
// `ModuleExecutor` — тонкая абстракция вызова доверенного модуля. Единственная реализация 018 —
// `InProcessTrustedModuleExecutor`: прямой in-process вызов TS-функции (trusted, БЕЗ sandbox —
// отсутствие изоляции декларируется, не имитируется; принцип XIV). Будущий sandbox-исполнитель
// реализует тот же интерфейс без изменений в `BacktestRunner` (принцип I).

import type { StrategyContext } from '@trading/research-contracts/research';
import type { OverlayDecision, StrategyDecision } from '@trading/research-contracts/research';
import type { HypothesisOverlayModule, LifecycleHook, StrategyModule } from '@trading/research-contracts/research';
import type { ResolvedOverlay, ResolvedStrategy } from './artifacts.js';

/** Абстракция вызова доверенного модуля (FR-004). */
export interface ModuleExecutor {
  /** Вызвать decision-producing lifecycle-хук; `[]` если хук отсутствует или вернул `null`. */
  executeStrategyHook(
    module: StrategyModule,
    hook: LifecycleHook,
    ctx: StrategyContext,
  ): Promise<readonly StrategyDecision[]>;
  /** Вызвать overlay `apply`; `[]` если вернул `null`. */
  executeOverlayApply(
    overlay: HypothesisOverlayModule,
    ctx: StrategyContext,
  ): Promise<readonly OverlayDecision[]>;
  /**
   * Slice B (bar-major transport collapse). Один base-decision на item, index-aligned с `items`.
   * trusted: byte-identical деградация — цикл `executeStrategyHook` по одному item. sandbox +
   * universe: один `callHookBarMajor` round-trip на ВЕСЬ батч (реальный collapse); sandbox без
   * universe: collapse невозможен (per-symbol сессии) — тот же lockstep-цикл, что и trusted.
   * Fail-closed: ошибка/невалидное решение для item → `{ kind: 'idle' }` для ЭТОГО item (== то, что
   * дал бы `firstDecision([])` в раннере), без влияния на другие items.
   */
  executeStrategyHookBarMajor(
    items: readonly { module: StrategyModule; ctx: StrategyContext }[],
  ): Promise<readonly StrategyDecision[]>;
  /**
   * Session-lifecycle (НОВОЕ, опционально; 019). trusted: делегирует `module.init?`; sandbox: открыть
   * сессию + init-хук. Поведение 018 неизменно (InProcess делегирует ⇒ `check:018` зелёный).
   */
  initStrategy?(module: StrategyModule, ctx: StrategyContext): Promise<void>;
  /** Session-lifecycle (НОВОЕ, опционально; 019). trusted: `module.dispose?`; sandbox: dispose-хук. */
  disposeStrategy?(module: StrategyModule, ctx: StrategyContext): Promise<void>;
  /** Teardown исполнителя (НОВОЕ, опционально; 019). trusted: no-op; sandbox: `docker rm -f`. */
  close?(): void;
  /**
   * 17b (опционально; только sandbox): пакет flat-баров onBarClose одним IPC-сообщением с ранней
   * остановкой на первом сигнале. Отсутствие метода ⇒ движок остаётся в lockstep.
   *
   * КОНТРАКТ: precondition — `ctxs` непустой (движковый гейт гарантирует ≥2, реализация вправе
   * читать `ctxs[0]`); postcondition — `stoppedAt ∈ [0, ctxs.length - 1]` ВСЕГДА (в т.ч. на
   * fail-closed путях: нарушение уронит хост в `builder.build` за пределами ленты). Бары
   * `0..stoppedAt-1` исполнены с пустыми решениями; `decisions` — ответ бара `stoppedAt`.
   */
  executeStrategyHookBatch?(
    module: StrategyModule,
    ctxs: readonly StrategyContext[],
  ): Promise<{ stoppedAt: number; decisions: readonly StrategyDecision[] }>;
}

function normalizeStrategy(
  out: StrategyDecision | readonly StrategyDecision[] | null | undefined,
): readonly StrategyDecision[] {
  if (out == null) return [];
  return Array.isArray(out) ? (out as readonly StrategyDecision[]) : [out as StrategyDecision];
}

function normalizeOverlay(
  out: OverlayDecision | readonly OverlayDecision[] | null | undefined,
): readonly OverlayDecision[] {
  if (out == null) return [];
  return Array.isArray(out) ? (out as readonly OverlayDecision[]) : [out as OverlayDecision];
}

/** Same "first or idle" reduction as `runner.ts`'s (unexported) `firstDecision`; kept in sync by inspection. */
function firstDecisionOf(decisions: readonly StrategyDecision[]): StrategyDecision {
  return decisions.length > 0 ? decisions[0]! : { kind: 'idle' };
}

/**
 * Прямой in-process trusted-исполнитель. Нормализует `decision | decision[] | null` → массив.
 * `init`/`dispose` (void) вызываются runner'ом напрямую — они не producing-decision хуки.
 */
export class InProcessTrustedModuleExecutor implements ModuleExecutor {
  async executeStrategyHook(
    module: StrategyModule,
    hook: LifecycleHook,
    ctx: StrategyContext,
  ): Promise<readonly StrategyDecision[]> {
    const fn =
      hook === 'onBarClose'
        ? module.onBarClose
        : hook === 'onPositionBar'
          ? module.onPositionBar
          : hook === 'onPendingIntentBar'
            ? module.onPendingIntentBar
            : undefined;
    if (fn === undefined) return [];
    return normalizeStrategy(fn(ctx));
  }

  async executeOverlayApply(
    overlay: HypothesisOverlayModule,
    ctx: StrategyContext,
  ): Promise<readonly OverlayDecision[]> {
    return normalizeOverlay(overlay.apply(ctx));
  }

  /**
   * trusted: no batch collapse available (nothing to collapse over — direct in-process calls) —
   * loop `executeStrategyHook` per item, byte-identical to calling it individually.
   */
  async executeStrategyHookBarMajor(
    items: readonly { module: StrategyModule; ctx: StrategyContext }[],
  ): Promise<readonly StrategyDecision[]> {
    const out: StrategyDecision[] = [];
    for (const it of items) {
      out.push(firstDecisionOf(await this.executeStrategyHook(it.module, 'onBarClose', it.ctx)));
    }
    return out;
  }

  /** trusted: прямой вызов `module.init?` (поведение 018 неизменно). */
  async initStrategy(module: StrategyModule, ctx: StrategyContext): Promise<void> {
    module.init?.(ctx);
  }

  /** trusted: прямой вызов `module.dispose?` (поведение 018 неизменно). */
  async disposeStrategy(module: StrategyModule, ctx: StrategyContext): Promise<void> {
    module.dispose?.(ctx);
  }

  /** trusted: нет контейнера — teardown не нужен. */
  close(): void {
    /* no-op */
  }
}

/**
 * Router выбора исполнителя по провенансу резолвнутого модуля (seam для 019). Определён ЗДЕСЬ (а не
 * в 019), чтобы `runner.ts` не зависел от пакета sandbox (избегаем цикла). Дефолт — trusted-only
 * (`createTrustedRouter`): поведение 018 байт-в-байт. 019 предоставляет sandbox-aware реализацию.
 */
export interface ExecutorRouter {
  forStrategy(resolved: ResolvedStrategy): ModuleExecutor;
  forOverlay(resolved: ResolvedOverlay): ModuleExecutor;
  /** Teardown всех исполнителей/сессий (вызывается runner'ом в `finally`). */
  closeAll(): void;
}

/** Trusted-only router: всегда отдаёт один in-process исполнитель (вывод 018 неизменен). */
export function createTrustedRouter(executor?: ModuleExecutor): ExecutorRouter {
  const exec = executor ?? new InProcessTrustedModuleExecutor();
  return {
    forStrategy: () => exec,
    forOverlay: () => exec,
    closeAll: () => exec.close?.(),
  };
}
