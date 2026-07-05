// 020 — каноничный ключ индикатора (data-model §2, research R4).
//
// Детерминированная строка из name + отсортированных по имени params + разрешённого source.
// Семантически идентичные запросы → один ключ → один streaming-инстанс/одна запись кэша.

import type { SourceField } from '@trading/research-contracts/research';

/**
 * Каноничный ключ запроса. `params` сериализуются в порядке возрастания имён ключа
 * (стабильный порядок не зависит от порядка вставки); числа — через `String(n)`.
 */
export function canonicalKey(
  name: string,
  params: Readonly<Record<string, number>>,
  source: SourceField,
): string {
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`);
  return `${name}|${parts.join(',')}|${source}`;
}
