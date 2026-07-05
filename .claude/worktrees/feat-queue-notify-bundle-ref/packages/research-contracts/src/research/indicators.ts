// 020 — контрактные типы platform-owned Indicator Engine (additive; data-model §2/§3/§6/§7).
//
// Чистые типы (стираются при компиляции). 017/018/019-контракты по форме не трогаются;
// расширение 017 `IndicatorApi` (+ query) живёт в `./context.ts` и подключает типы отсюда.

// ── §2. Запрос индикатора ───────────────────────────────────────────────────

/** Поле-источник, по которому считается индикатор (default берётся из каталога). */
export type SourceField = 'close' | 'open' | 'high' | 'low' | 'volume' | 'hlc3' | 'ohlc4';

/** Нормализованный per-bar запрос индикатора. Стабильный ключ мемоизации/детерминизма. */
export interface IndicatorRequest {
  readonly name: string; // валидируется по каталогу (FR-020)
  readonly params?: Readonly<Record<string, number>>; // напр. { period: 14 } (FR-021)
  readonly source?: SourceField; // напр. 'close'; дефолт — из каталога (FR-022)
}

// ── §3. Типизированные выходы ────────────────────────────────────────────────

export interface MacdValue {
  readonly macd: number;
  readonly signal: number;
  readonly histogram: number;
}
export interface BollingerValue {
  readonly lower: number;
  readonly middle: number;
  readonly upper: number;
}
export interface StochasticValue {
  readonly k: number;
  readonly d: number;
}

/**
 * Значение индикатора as-of бара. `undefined` — warmup (для multi-output — весь объект,
 * пока не готовы все поля). Наружу не выходят NaN/null/vendor-объекты (SC-004/SC-009).
 */
export type IndicatorValue = number | MacdValue | BollingerValue | StochasticValue;

// ── §7. Каталог возможностей (discovery-метаданные) ──────────────────────────

export type OutputShape = 'scalar' | 'macd' | 'bollinger' | 'stochastic';

export interface ParamSpec {
  readonly type: 'int' | 'number';
  readonly min?: number; // напр. min:1
  readonly exclusiveMin?: number; // напр. stddev > 0
  readonly default?: number;
}

export interface IndicatorDefinition {
  readonly name: string;
  readonly paramsSchema: Readonly<Record<string, ParamSpec>>; // детерминированная схема
  readonly outputShape: OutputShape;
  readonly sourceFields: readonly SourceField[]; // поддержанные; [0] = default
  readonly warmup: (params: Readonly<Record<string, number>>) => number; // бары до ready
}

export type IndicatorCatalog = readonly IndicatorDefinition[];

// ── §6. Валидация ─────────────────────────────────────────────────────────────

export type IndicatorValidationCode =
  | 'indicator_unsupported' // имя вне каталога (FR-020)
  | 'indicator_params_invalid' // params не проходят схему (FR-021)
  | 'indicator_source_unsupported'; // source не поддержан индикатором (FR-022)

export interface IndicatorIssue {
  readonly severity: 'error' | 'warning'; // семантика 017 Severity
  readonly code: IndicatorValidationCode;
  readonly message: string;
  readonly path: string; // JSON Pointer (RFC 6901): '', '/params/period', '/source'
}

export interface IndicatorValidationResult {
  readonly status: 'accepted' | 'rejected';
  readonly issues: readonly IndicatorIssue[]; // ПОЛНЫЙ набор причин, сорт. по (path, code)
}
