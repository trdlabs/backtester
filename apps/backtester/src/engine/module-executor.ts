// 018 — контрактный шов исполнения модулей (data-model §1.1, research R3, FR-004/028).
//
// `ModuleExecutor` — тонкая абстракция вызова доверенного модуля. Единственная реализация 018 —
// `InProcessTrustedModuleExecutor`: прямой in-process вызов TS-функции (trusted, БЕЗ sandbox —
// отсутствие изоляции декларируется, не имитируется; принцип XIV). Будущий sandbox-исполнитель
// реализует тот же интерфейс без изменений в `BacktestRunner` (принцип I).

import type { StrategyContext } from '@trading/research-contracts/research';
import type { OverlayDecision, StrategyDecision } from '@trading/research-contracts/research';
import type { HypothesisOverlayModule, LifecycleHook, StrategyModule } from '@trading/research-contracts/research';
import type {
  ActorCommand,
  ActorContext,
  ActorInit,
  ActorInputEvent,
  EventDrivenModule,
  StrategyActor,
} from '@trdlabs/sdk/research-contract';

import type { ResolvedOverlay, ResolvedStrategy } from './artifacts.js';
import type { ActorExecutionHandle, ActorSource } from './actor/execution-handle.js';

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
    /** Hint: предпочтительный размер батча (AIMD-окно исполнителя); отсутствие = maxBars раннера. */
  preferredBatchBars?(): number;
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

/**
 * Canonical "one base decision per item, else idle" reduction (Slice B review finding: this used to
 * exist as three independent copies — `runner.ts`, `module-executor.ts`, `sandbox-executor.ts` — with
 * nothing enforcing agreement). Single source of truth shared by all three; `runner.ts` and
 * `sandbox-executor.ts` import this instead of defining their own. MUST stay byte-identical to the
 * `{ kind: 'idle' }` fallback below — bar-major's result_hash parity with the lockstep runner depends
 * on it.
 */
/**
 * Канонический «ничего не делаем» — ОДИН объект на процесс, а не новый на каждом баре.
 *
 * `{ kind: 'idle' }` создавался в четырёх местах горячего пути: `firstDecision` (раз на бар),
 * `entryBase`, `baseDecision` в записи решения и синтетический базис для `onPositionBar`. На
 * прогоне в 60 тыс. баров это до 180 тыс. одинаковых неизменяемых объектов, каждый из которых
 * живёт до сборки мусора. Профиль показывает сборщик как самую крупную статью после границы
 * изолята — значит дешёвые аллокации здесь не бесплатны.
 *
 * Значение в артефакте не меняется: сериализуется `{"kind":"idle"}` в обоих случаях. Заморозка
 * не «на всякий случай»: общий объект, который кто-то мутирует, — это тихая порча ЧУЖИХ записей
 * решений, и лучше получить исключение в тот же момент, чем расхождение хэша через месяц.
 */
export const IDLE_DECISION: StrategyDecision = Object.freeze({ kind: 'idle' }) as StrategyDecision;

export function firstDecision(decisions: readonly StrategyDecision[]): StrategyDecision {
  return decisions.length > 0 ? decisions[0]! : IDLE_DECISION;
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
      out.push(firstDecision(await this.executeStrategyHook(it.module, 'onBarClose', it.ctx)));
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

  // ───────────────────────────────────────────────────────────────────────────
  // 083 S3 — lifecycle актора для формы `event_driven`.
  //
  // Прямой путь: актор — живой объект В ЭТОМ ЖЕ процессе, поэтому наружу отдаётся непрозрачный
  // дескриптор, а сам инстанс остаётся здесь. Раннер не получает ссылку на актора и не может
  // позвать `onEvent` в обход исполнителя — иначе граница исполнения существовала бы только на
  // словах, и sandbox-путь разошёлся бы с прямым уже в первом отличии.
  // ───────────────────────────────────────────────────────────────────────────

  /** Живые акторы этого исполнителя. Ключ — тот самый непрозрачный дескриптор. */
  readonly #actors = new Map<object, StrategyActor>();

  /**
   * Создать актора и вернуть дескриптор.
   *
   * АТОМАРНОСТЬ ВЛАДЕНИЯ. Запись в таблицу появляется ПОСЛЕ проверки формы актора: отказ до
   * возврата дескриптора не оставляет сессии, которую некому освободить. У прямого пути ресурс —
   * только эта запись, поэтому «убрать за собой» здесь означает «не заводить».
   */
  async createActor(source: ActorSource, init: ActorInit): Promise<ActorExecutionHandle> {
    const module = source.module as Partial<EventDrivenModule> | undefined;
    if (module == null || typeof module.createActor !== 'function') {
      throw new Error(
        `trusted executor: модуль '${source.manifest.id}' объявлен event_driven, но не предоставляет ` +
          'createActor — форма модуля не совпадает с объявленным lifecycle',
      );
    }
    const actor = module.createActor(init) as Partial<StrategyActor> | null;
    if (actor == null || typeof actor.onEvent !== 'function') {
      throw new Error(
        `trusted executor: createActor модуля '${source.manifest.id}' вернул не актора — нет onEvent`,
      );
    }
    const handle = {} as unknown as ActorExecutionHandle;
    this.#actors.set(handle as unknown as object, actor as StrategyActor);
    return handle;
  }

  /** Доставить событие. Возврат не-массива — нарушение контракта модулем, и оно ГРОМКОЕ. */
  async executeActorEvent(
    handle: ActorExecutionHandle,
    event: ActorInputEvent,
    ctx: ActorContext,
  ): Promise<readonly ActorCommand[]> {
    const actor = this.#actors.get(handle as unknown as object);
    if (actor === undefined) {
      throw new Error('trusted executor: дескриптор неизвестен — актор не создавался либо уже освобождён');
    }
    const out = actor.onEvent(event, ctx);
    if (!Array.isArray(out)) {
      // Пустой массив вместо броска проглотил бы команды автора: прогон выглядел бы как «стратегия
      // ничего не решила», а решала она каждый раз.
      throw new Error(`trusted executor: onEvent вернул ${typeof out}, а контракт требует массив команд`);
    }
    return out as readonly ActorCommand[];
  }

  /** Освободить актора. Идемпотентно: повторный вызов на освобождённом — no-op, не бросок. */
  async disposeActor(handle: ActorExecutionHandle): Promise<void> {
    this.#actors.delete(handle as unknown as object);
  }

  /** Число живых акторов — по нему проверяется атомарность владения после отвергнутых созданий. */
  activeActorSessions(): number {
    return this.#actors.size;
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
