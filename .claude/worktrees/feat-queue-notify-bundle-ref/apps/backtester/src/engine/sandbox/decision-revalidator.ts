// 019 — DecisionRevalidator (US2; data-model §6, research R7; FR-015).
//
// Host-side ревалидация возвращённых из sandbox решений ПО 017-СХЕМАМ, ДО risk/execution.
// Переиспользует 017 `schema-registry.validateRef` по ветке union (по `kind`). Никакой новой
// decision-схемы 019 НЕ вводит (DRY; контракт 017 неизменен). Неизвестный/отсутствующий `kind`
// или schema-fail → `decision_schema_invalid` → путь прерывается, ордер НЕ создаётся (fail-closed).

import type { OverlayDecision, StrategyDecision } from '@trading/research-contracts/research';
import { SCHEMA_IDS, createSchemaRegistry, jsonPointerOf } from '../validation/schema-registry.js';

/** kind решения стратегии → имя ветки в strategy-decision.schema.json (как в 017 validate-module). */
const STRATEGY_DEFS: Readonly<Record<string, string>> = {
  enter: 'EnterDecision',
  exit: 'ExitDecision',
  add_to_position: 'AddToPositionDecision',
  update_protection: 'UpdateProtectionDecision',
  annotate: 'AnnotateDecision',
  idle: 'IdleDecision',
};

/** kind решения overlay → имя ветки в overlay-decision.schema.json. */
const OVERLAY_DEFS: Readonly<Record<string, string>> = {
  pass: 'OverlayPassDecision',
  veto: 'OverlayVetoDecision',
  patch: 'OverlayPatchDecision',
  annotate: 'OverlayAnnotateDecision',
};

/** Результат ревалидации: либо валидные типизированные решения, либо причина отказа (один код). */
export type RevalidationResult<T> =
  | { readonly ok: true; readonly decisions: readonly T[] }
  | { readonly ok: false; readonly message: string };

function kindOf(d: unknown): string | undefined {
  if (typeof d !== 'object' || d === null) return undefined;
  const k = (d as { kind?: unknown }).kind;
  return typeof k === 'string' ? k : undefined;
}

/**
 * Ревалидатор решений по 017-схемам. Кэширует один `SchemaRegistry` (компиляция core-схем — один раз).
 */
export class DecisionRevalidator {
  private readonly registry = createSchemaRegistry();

  private revalidate(
    raw: readonly unknown[],
    schema: 'strategy-decision' | 'overlay-decision',
    defs: Readonly<Record<string, string>>,
  ): RevalidationResult<unknown> {
    for (let i = 0; i < raw.length; i += 1) {
      const d = raw[i];
      const kind = kindOf(d);
      if (kind === undefined || defs[kind] === undefined) {
        return { ok: false, message: `decision[${i}]: unknown or missing kind "${String(kind)}"` };
      }
      const refId = `${SCHEMA_IDS[schema]}#/definitions/${defs[kind]}`;
      const errs = this.registry.validateRef(refId, d);
      if (errs.length > 0) {
        const first = errs[0];
        return {
          ok: false,
          message: `decision[${i}] (${kind}) schema-invalid at ${jsonPointerOf(first)}: ${first.message ?? 'invalid'}`,
        };
      }
    }
    return { ok: true, decisions: raw };
  }

  /** Ревалидировать решения strategy-хука. */
  revalidateStrategy(raw: readonly unknown[]): RevalidationResult<StrategyDecision> {
    return this.revalidate(raw, 'strategy-decision', STRATEGY_DEFS) as RevalidationResult<StrategyDecision>;
  }

  /** Ревалидировать решения overlay `apply`. */
  revalidateOverlay(raw: readonly unknown[]): RevalidationResult<OverlayDecision> {
    return this.revalidate(raw, 'overlay-decision', OVERLAY_DEFS) as RevalidationResult<OverlayDecision>;
  }
}
