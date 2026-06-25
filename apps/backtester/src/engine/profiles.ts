// 018 — дефолтные профили риска и исполнения (data-model §3, research R3/R12).
//
// Runner-owned: привязываются на уровне прогона по `id@version`, регистрируются в registry,
// зеркалируются JSON-фикстурой запроса. Формы — 017 `RiskProfile`/`ExecutionProfile`; конкретные
// значения объявлены здесь. Negative-профили (SC-007) добавляются в US6.

import type { ExecutionProfile, RiskProfile } from '@trading/research-contracts/research';

/** Форма `exposureLimits` (017 типизирует как `object`): доля equity на одну позицию. */
export interface ExposureLimits {
  readonly maxPositionNotionalPct: number;
}

/** Форма fee/slippage-модели: фиксированные базисные пункты. */
export interface FixedBpsModel {
  readonly kind: 'fixed_bps';
  readonly bps: number;
}

/** Форма fill-модели по умолчанию: исполнение по `open` следующего бара. */
export interface NextBarOpenFillModel {
  readonly kind: 'next_bar_open';
}

/** Fill at the close of the decision bar (same bar as onBarClose). */
export interface SameBarCloseFillModel {
  readonly kind: 'same_bar_close';
}

/** Funding model: per-minute proration of the tape's 8h-equivalent funding rate (035 realism). */
export interface PerMinuteProrateFundingModel {
  readonly kind: 'per_minute_prorate';
  /** Funding interval the tape rate is expressed over (perps: 8h). The per-minute divisor is intervalHours*60. */
  readonly intervalHours: number;
}

/**
 * Закрытый каталог поддержанных `fillModel.kind` (024, R6). Пре-флайт `runBacktest` отклоняет любой
 * иной kind кодом `unsupported_fill_model_kind` — без молчаливого fallback (конституция XIV).
 * Не-дефолтные fill-модели НЕ реализуются (FR-031); каталог пополняется значением при их появлении.
 */
export const SUPPORTED_FILL_MODEL_KINDS = ['next_bar_open', 'same_bar_close'] as const;

/**
 * Закрытый каталог поддержанных `fundingModel.kind` (035, R6). Прогон отклоняет любой иной kind —
 * без молчаливого fallback (конституция XIV). Каталог пополняется значением при появлении нового вида.
 */
export const SUPPORTED_FUNDING_MODEL_KINDS = ['per_minute_prorate'] as const;

/**
 * Форма `dcaLimits`/`scaleInLimits` (017 типизирует слоты как `object`; R4). Раздельные поля одной
 * формы → режимы `dca`/`scale_in` различимы в risk-политике и счётчиках (FR-002/008).
 */
export interface AddLimits {
  /** Макс. число доливок за жизнь позиции (этот режим). */
  readonly maxAdds: number;
  /** Потолок нотионала одной доливки (доля cash-equity-прокси). */
  readonly maxAddNotionalPct: number;
  /** Потолок кумулятивного нотионала позиции (доля cash-equity-прокси). */
  readonly maxTotalNotionalPct: number;
}

/**
 * `DEFAULT_RISK` — portfolio-wide hard-authority профиль (FR-016/017).
 * Сторона ∉ `allowedSides` → reject; `openPositions ≥ maxConcurrentPositions` → reject;
 * `maxPositionNotionalPct` — доля equity для sizing и верхняя граница экспозиции;
 * stop/take-hint вне `*Bounds` → clamp.
 */
export const DEFAULT_RISK: RiskProfile = {
  id: 'default_risk',
  version: '1.0.0',
  maxConcurrentPositions: 1,
  exposureLimits: { maxPositionNotionalPct: 1.0 } satisfies ExposureLimits,
  allowedSides: ['long', 'short'],
  stopBounds: { min: 0.001, max: 0.5 },
  takeBounds: { min: 0.001, max: 1.0 },
};

/**
 * `DEFAULT_EXEC` — assumptions исполнения (FR-019/021).
 * fill по `open(t+1)`; fee/slippage — ненулевые фикс. bps (SC-005): slippage неблагоприятно к
 * стороне (buy `open·(1+5/1e4)`, sell `open·(1−5/1e4)`), fee `notional·10/1e4`.
 */
export const DEFAULT_EXEC: ExecutionProfile = {
  id: 'default_exec',
  version: '1.0.0',
  fillModel: { kind: 'next_bar_open' } satisfies NextBarOpenFillModel,
  feeModel: { kind: 'fixed_bps', bps: 10 } satisfies FixedBpsModel,
  slippageModel: { kind: 'fixed_bps', bps: 5 } satisfies FixedBpsModel,
};

/**
 * `REALISM_EXEC` (035 realism) — реалистичные assumptions стоимости для анализа. fill по `next_bar_open`,
 * taker-близкая комиссия (5 bps/сторона), adverse slippage (5 bps), поминутное пропорциональное начисление
 * фандинга по 8h-эквиваленту ленты. Opt-in: наличие `fundingModel` активирует начисление; дефолтный путь
 * (`DEFAULT_EXEC`, без `fundingModel`) остаётся байт-идентичным. bps комиссии/slippage — настраиваемые
 * параметры анализа.
 */
export const REALISM_EXEC: ExecutionProfile = {
  id: 'realism_exec',
  version: '1.0.0',
  fillModel: { kind: 'next_bar_open' } satisfies NextBarOpenFillModel,
  feeModel: { kind: 'fixed_bps', bps: 5 } satisfies FixedBpsModel,
  slippageModel: { kind: 'fixed_bps', bps: 5 } satisfies FixedBpsModel,
  fundingModel: { kind: 'per_minute_prorate', intervalHours: 8 } satisfies PerMinuteProrateFundingModel,
};

/**
 * `DCA_RISK` (024, R4) — исследовательский профиль, разрешающий доливку. Объявляет **раздельные**
 * `dcaLimits`/`scaleInLimits` (разные потолки → режимы различимы в risk/evidence). `DEFAULT_RISK` их
 * НЕ объявляет → `add_to_position` по дефолту запрещён → дефолтный путь не меняется (boundaries §3).
 */
export const DCA_RISK: RiskProfile = {
  id: 'dca_risk',
  version: '1.0.0',
  maxConcurrentPositions: 1,
  exposureLimits: { maxPositionNotionalPct: 0.5 } satisfies ExposureLimits,
  allowedSides: ['long', 'short'],
  stopBounds: { min: 0.001, max: 0.5 },
  takeBounds: { min: 0.001, max: 1.0 },
  dcaLimits: { maxAdds: 3, maxAddNotionalPct: 0.25, maxTotalNotionalPct: 1.0 } satisfies AddLimits,
  scaleInLimits: { maxAdds: 2, maxAddNotionalPct: 0.4, maxTotalNotionalPct: 1.2 } satisfies AddLimits,
};

/**
 * `UNSUPPORTED_FILL_EXEC` (024, R6) — execution-профиль с неподдержанным `fillModel.kind` для фикстуры
 * диспетча (#12). `runBacktest` пре-флайт-reject'ит его кодом `unsupported_fill_model_kind` (0 ордеров/
 * fill'ов). Существует только для негативной проверки; не-дефолтная модель НЕ реализуется (FR-031).
 */
export const UNSUPPORTED_FILL_EXEC: ExecutionProfile = {
  id: 'unsupported_fill_exec',
  version: '1.0.0',
  fillModel: { kind: 'twap' },
  feeModel: { kind: 'fixed_bps', bps: 10 } satisfies FixedBpsModel,
  slippageModel: { kind: 'fixed_bps', bps: 5 } satisfies FixedBpsModel,
};

/**
 * `TIGHT_ADD_RISK` (024, US5) — узкие add-лимиты для проверки, что hint'ы НЕ обходят risk-authority:
 * избыточный `sizingHint` → clamp к `maxAddNotionalPct`; вторая доливка → reject по `maxAdds=1`.
 * Объявляет оба режима (раздельные лимиты) для проверки различимости dca/scale_in под давлением.
 */
export const TIGHT_ADD_RISK: RiskProfile = {
  id: 'tight_add_risk',
  version: '1.0.0',
  maxConcurrentPositions: 1,
  exposureLimits: { maxPositionNotionalPct: 0.5 } satisfies ExposureLimits,
  allowedSides: ['long', 'short'],
  stopBounds: { min: 0.001, max: 0.5 },
  takeBounds: { min: 0.001, max: 1.0 },
  dcaLimits: { maxAdds: 1, maxAddNotionalPct: 0.05, maxTotalNotionalPct: 0.6 } satisfies AddLimits,
  scaleInLimits: { maxAdds: 1, maxAddNotionalPct: 0.05, maxTotalNotionalPct: 0.6 } satisfies AddLimits,
};

// --- Negative-профили для демонстрации risk-authority (data-model §3.1, SC-007) ---

/** `long_only_risk` — запрещает short (`short_after_pump` под ним → reject всех входов). */
export const LONG_ONLY_RISK: RiskProfile = {
  id: 'long_only_risk',
  version: '1.0.0',
  maxConcurrentPositions: 1,
  exposureLimits: { maxPositionNotionalPct: 1.0 } satisfies ExposureLimits,
  allowedSides: ['long'],
  stopBounds: { min: 0.001, max: 0.5 },
  takeBounds: { min: 0.001, max: 1.0 },
};

/** `tight_stop_risk` — узкие `stopBounds` (out-of-bounds stop-hint → clamp к границе). */
export const TIGHT_STOP_RISK: RiskProfile = {
  id: 'tight_stop_risk',
  version: '1.0.0',
  maxConcurrentPositions: 1,
  exposureLimits: { maxPositionNotionalPct: 1.0 } satisfies ExposureLimits,
  allowedSides: ['long', 'short'],
  stopBounds: { min: 0.01, max: 0.02 },
  takeBounds: { min: 0.001, max: 1.0 },
};
