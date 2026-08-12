import type { RunMode, RunPeriod } from './run';

export interface CapabilityDescriptor {
  readonly contractVersion: string;
  readonly artifactContractVersion: string;
  readonly supportedMetrics: readonly string[];
  readonly supportedModes: readonly RunMode[];
  readonly maxConcurrency: number;
}

export interface DatasetDescriptor {
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: RunPeriod;
  readonly rowCount: number;
  /**
   * Венью, с которого записаны СВЕЧИ этого датасета (083 S3).
   *
   * НАЗВАНО ПО РЯДУ, А НЕ ПО ДАТАСЕТУ, потому что общего венью у датасета нет: свечи пишет один
   * адаптер биржи, а OI, funding и ликвидации агрегированы по нескольким венью. Поле `venue`
   * обещало бы происхождение всех рядов сразу — то есть больше, чем когда-либо будет доказано.
   *
   * Единственное доступное потребителю доказательство: в самих строках происхождения нет — выбор
   * адаптера делается на деплое рекордера и в строку не попадает.
   *
   * Опционально намеренно и БЕЗ дефолта: датасет, не объявивший его, обязан читаться как
   * «происхождение неизвестно» и отвергаться там, где оно значимо (`proveCandleVenue`, actor-путь
   * бэктестера). Дефолт превратил бы молчание в утверждение.
   */
  readonly candleVenue?: string;
}
