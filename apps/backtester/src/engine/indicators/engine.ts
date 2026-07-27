// 020 — platform-owned Indicator Engine (data-model §5, research R3/R4).
//
// Per-run, streaming, мемоизированный по каноничному ключу. accessorAt(t) отдаёт IndicatorApi
// (value()+query()), видящий ТОЛЬКО закрытые свечи [0..t] (структурный no-lookahead).
//
// query(req): валидация (кэш по ключу) → get/create streaming-инстанс → докормить свечами ≤ t →
// мемоизированное значение-at-t или undefined. Back-compat: value('sma',N) делегирует движку и
// равно legacy `indicatorAsOf('sma_<N>')` (SMA суммирует то же окно в том же порядке).

import type { Bar, IndicatorApi } from '@trading/research-contracts/research';
import type {
  IndicatorRequest,
  IndicatorValidationResult,
  IndicatorValue,
  SourceField,
} from '@trading/research-contracts/research';

import type { IndicatorBackendAdapter, StreamingIndicator } from './backend/adapter.js';
import { platformNativeAdapter } from './backend/platform-native.js';
import { findDefinition, resolveParams, INDICATOR_CATALOG } from './catalog.js';
import { canonicalKey } from './key.js';
import { IndicatorValidationError, validateIndicatorRequest } from './validation.js';

export interface IndicatorEngine {
  /** Аксессор, привязанный к бару `t` (видимы закрытые свечи [0..t]). */
  accessorAt(barIndex: number): IndicatorApi;
}

/**
 * Сколько значений на ключ держать в `valueCache`. Аксессор движется вперёд по барам, поэтому
 * реально переиспользуются последние: в пределах одного бара стратегия может спросить индикатор
 * несколько раз, между барами — почти никогда.
 */
const VALUE_CACHE_PER_KEY = 8;

interface StreamingState {
  readonly instance: StreamingIndicator;
  fedUpTo: number; // последний скормленный индекс бара (-1 = пусто)
}

/** Создать движок над свечами (дефолтный adapter — platform-native). */
export function createIndicatorEngine(
  candles: readonly Readonly<Bar>[],
  adapter: IndicatorBackendAdapter = platformNativeAdapter,
): IndicatorEngine {
  const catalog = INDICATOR_CATALOG;
  const states = new Map<string, StreamingState>();
  const validationCache = new Map<string, IndicatorValidationResult>();
  const valueCache = new Map<string, Map<number, IndicatorValue | undefined>>();

  /** Резолв + валидация (кэш по ключу). Бросает IndicatorValidationError при rejected. */
  function resolve(
    request: IndicatorRequest,
    barIndex: number,
  ): { key: string; params: Record<string, number>; source: SourceField; def: NonNullable<ReturnType<typeof findDefinition>> } {
    const def = findDefinition(catalog, request.name);
    if (def === undefined) {
      const result = validateIndicatorRequest(catalog, request);
      throw new IndicatorValidationError(result, {
        indicatorName: request.name,
        params: request.params,
        barIndex,
      });
    }
    const params = resolveParams(def, request.params);
    const source: SourceField = request.source ?? def.sourceFields[0];
    const key = canonicalKey(request.name, params, source);

    let result = validationCache.get(key);
    if (result === undefined) {
      result = validateIndicatorRequest(catalog, request);
      validationCache.set(key, result);
    }
    if (result.status === 'rejected') {
      throw new IndicatorValidationError(result, {
        indicatorName: request.name,
        params: request.params,
        barIndex,
      });
    }
    return { key, params, source, def };
  }

  /** Значение индикатора as-of бара `t` (или undefined в warmup). */
  function queryAt(barIndex: number, request: IndicatorRequest): IndicatorValue | undefined {
    const { key, params, source, def } = resolve(request, barIndex);

    const cached = valueCache.get(key);
    if (cached !== undefined && cached.has(barIndex)) return cached.get(barIndex);

    let value: IndicatorValue | undefined;

    let state = states.get(key);
    if (state === undefined) {
      state = { instance: adapter.create(def, params, source), fedUpTo: -1 };
      states.set(key, state);
    }

    if (barIndex >= state.fedUpTo) {
      // Forward: докормить закрытыми свечами по порядку.
      for (let i = state.fedUpTo + 1; i <= barIndex; i += 1) state.instance.update(candles[i]);
      state.fedUpTo = barIndex;
      value = state.instance.value;
    } else {
      // Запрос прошлого бара (нетипично): пересобрать свежий инстанс, реплей [0..t].
      const fresh = adapter.create(def, params, source);
      for (let i = 0; i <= barIndex; i += 1) fresh.update(candles[i]);
      value = fresh.value;
    }

    const bucket = valueCache.get(key) ?? new Map<number, IndicatorValue | undefined>();
    bucket.set(barIndex, value);
    // Кэш ограничен: раньше он рос на запись за бар за индикатор и жил всю сессию, то есть на
    // длинном окне удерживал десятки тысяч записей, которые никто уже не спросит — accessorAt
    // движется вперёд. Вытеснение НЕ меняет ни одного значения: промах по вытесненному прошлому
    // бару уходит в ветку реплея (`barIndex < fedUpTo`), которая считает то же самое тем же
    // кодом. Экономится память и работа GC, а не арифметика.
    if (bucket.size > VALUE_CACHE_PER_KEY) {
      const oldest = bucket.keys().next();
      if (oldest.done !== true) bucket.delete(oldest.value);
    }
    valueCache.set(key, bucket);
    return value;
  }

  /** Legacy scalar: маппинг позиционных args на params (в порядке схемы); невалид → undefined. */
  function valueAt(barIndex: number, name: string, args: readonly number[]): number | undefined {
    const def = findDefinition(catalog, name);
    if (def === undefined) return undefined;
    const keys = Object.keys(def.paramsSchema);
    const params: Record<string, number> = {};
    args.forEach((v, i) => {
      const k = keys[i];
      if (k !== undefined) params[k] = v;
    });
    try {
      const result = queryAt(barIndex, { name, params });
      return typeof result === 'number' ? result : undefined;
    } catch {
      return undefined; // back-compat: legacy value() не бросает
    }
  }

  return {
    accessorAt(barIndex: number): IndicatorApi {
      return {
        value(name: string, ...args: readonly number[]): number | undefined {
          return valueAt(barIndex, name, args);
        },
        query(request: IndicatorRequest): IndicatorValue | undefined {
          return queryAt(barIndex, request);
        },
      };
    },
  };
}
