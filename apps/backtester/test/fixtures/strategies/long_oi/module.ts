/**
 * 026 Long OI StrategyModule — сборка единого 017-модуля (data-model §1, module-interface.md).
 *
 * `{ manifest, init, onBarClose, onPositionBar }` с одним экземпляром `LongOiModuleState` per-run.
 * **Per-symbol изоляция**: раннер 024 вызывает `init(ctx)` в начале каждого символа (`runSymbol` →
 * `initStrategy`), поэтому `init` пере-создаёт state — состояние одного символа не утекает в другой.
 * Для строгого детерминизма прогона хост может также создавать свежий модуль через `createLongOiModule()`.
 *
 * Чистый модуль: импорт только `@trading-platform/sdk/research-contract` (type-only) + собственные helpers. Регистрация
 * в module-registry (`createTrustedRegistry({strategies:[…]})`) выполняется хостом по `id@version`.
 */

import type { StrategyContext } from '@trading-platform/sdk/research-contract';
import type { StrategyDecision } from '@trading-platform/sdk/research-contract';
import type { StrategyModule } from '@trading-platform/sdk/research-contract';
import { onBarClose as flatOnBarClose } from './flat_phase.js';
import { LONG_OI_MANIFEST } from './manifest.js';
import { onPositionBar as positionOnPositionBar } from './position_phase.js';
import { createInitialState, type LongOiModuleState } from './state.js';

/** Создать экземпляр модуля с собственным (изолированным) FSM-состоянием. */
export function createLongOiModule(): StrategyModule {
  let state: LongOiModuleState = createInitialState();
  return {
    manifest: LONG_OI_MANIFEST,
    // Раннер вызывает init в начале каждого символа → детерминированный сброс FSM (per-symbol изоляция).
    init: (_ctx: StrategyContext): void => {
      state = createInitialState();
    },
    onBarClose: (ctx: StrategyContext): readonly StrategyDecision[] => flatOnBarClose(ctx, state),
    onPositionBar: (ctx: StrategyContext): readonly StrategyDecision[] => positionOnPositionBar(ctx, state),
  };
}

/** Готовый экземпляр для registry-resolve по `id@version` (бэктест-хост). */
export const LONG_OI_MODULE: StrategyModule = createLongOiModule();
