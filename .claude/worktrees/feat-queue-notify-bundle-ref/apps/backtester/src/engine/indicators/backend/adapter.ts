// 020 — контракт backend-адаптера (data-model §9; принцип XIV, swappable).
//
// Vendor (trading-signals и пр.) допустим только за этим контрактом (trusted-only,
// документарно). MVP-дефолт — `platform-native` (zero-dep, поверх formulas/*).

import type { Bar } from '@trading/research-contracts/research';
import type {
  IndicatorDefinition,
  IndicatorValue,
  SourceField,
} from '@trading/research-contracts/research';

/** Один streaming-инстанс индикатора: ест закрытые свечи по порядку, отдаёт as-of значение. */
export interface StreamingIndicator {
  /** Скормить одну закрытую свечу (строго по возрастанию индекса). */
  update(bar: Readonly<Bar>): void;
  /** Текущее as-of значение; `undefined` в warmup (multi-output — весь объект). */
  readonly value: IndicatorValue | undefined;
}

/** Фабрика streaming-инстансов под конкретный backend. */
export interface IndicatorBackendAdapter {
  readonly id: string; // 'platform-native' (MVP-дефолт)
  create(
    def: IndicatorDefinition,
    params: Readonly<Record<string, number>>,
    source: SourceField,
  ): StreamingIndicator;
}
