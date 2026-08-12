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
   * Венью, которое датасет объявляет о СВОИХ данных (083 S3). Единственное доступное потребителю
   * доказательство происхождения: в самих строках его нет — свечи пишет один адаптер биржи,
   * выбранный на деплое рекордера и в строку не попадающий, а OI/funding/ликвидации агрегированы по
   * нескольким венью.
   *
   * Опционально намеренно и БЕЗ дефолта: датасет, не объявивший венью, обязан читаться как
   * «происхождение неизвестно» и отвергаться там, где оно значимо (`proveTapeVenue`, actor-путь
   * бэктестера). Дефолт превратил бы молчание в утверждение.
   */
  readonly venue?: string;
}
