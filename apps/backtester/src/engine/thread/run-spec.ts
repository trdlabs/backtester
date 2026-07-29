// Сериализуемая спека прогона для барного цикла в отдельном потоке.
//
// ГЛАВНОЕ ПРОЕКТНОЕ РЕШЕНИЕ: через границу потока едет РЕЦЕПТ, а не данные.
//
// `RunDeps` держит живые объекты — реестр модулей, роутер с исполнителями, ленту с методами. Ни
// один из них не переживает `postMessage`: structured clone копирует данные, но не замыкания и не
// нативные дескрипторы. Копировать же саму ленту (десятки мегабайт свечей на реальном прогоне)
// пришлось бы на каждый запуск, и выигрыш от переноса цикла съело бы копирование.
//
// Поэтому поток получает описание того, ЧТО построить, и строит это сам: открывает свой порт
// данных, материализует ленту, собирает реестр и роутер. Всё, что здесь перечислено, — простые
// данные, которые structured clone переносит без потерь.
//
// Зачем перенос вообще нужен — две независимые причины:
//   1) `worker.ts` (P3-5): барный цикл CPU-bound и не отдаёт управление, поэтому голодает хартбит
//      лизы; длинный universe-прогон может отпустить лизу, и другой воркер переисполнит задачу.
//      Митигация сегодня — продление лизы перед входом в цикл; структурное закрытие — вынос цикла
//      с главного потока, где таймеры смогут тикать.
//   2) синхронный вызов в изолят (`evalClosureSync`) снимает измеренные ~150 мкс/бар штрафа
//      асинхронного пути (bt#191/196), но блокирует поток на время хука. В отдельном потоке эта
//      блокировка никого не задевает.

/** Откуда поток берёт свечи. Дискриминированный союз — прод-порты добавляются вариантами. */
export type ThreadDataPortSpec = {
  readonly kind: 'fixture';
  /** Каталог фикстур (`FixtureDataPort`). */
  readonly dir: string;
};

/** Что материализовать в ленту (аргументы `buildOverlayDataset`). */
export interface ThreadDatasetSpec {
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: { readonly from: string; readonly to: string };
}

/** Флаги прогона — подмножество `RunDeps`, состоящее ТОЛЬКО из простых данных. */
export interface ThreadRunFlags {
  readonly barBatching?: { readonly maxBars: number };
  readonly barMajor?: boolean;
  readonly barMajorBatch?: boolean;
  readonly contextFreeze?: boolean;
}

/** Полная спека: всё, что нужно потоку, чтобы собрать зависимости и выполнить прогон. */
export interface ThreadRunSpec {
  /** `BacktestRunRequest` как простые данные (пришёл из JSON, туда же и уедет). */
  readonly request: unknown;
  /** Каталог материализованного бандла стратегии на диске — поток читает его сам. */
  readonly bundleDir: string;
  /** Бэкенд исполнения недоверенного кода внутри потока. */
  readonly sandboxBackend: 'docker' | 'isolate';
  readonly dataPort: ThreadDataPortSpec;
  readonly dataset: ThreadDatasetSpec;
  readonly flags?: ThreadRunFlags;
}

/**
 * Ответ потока.
 *
 * Ошибка едет разобранной на строки, а не объектом `Error`: structured clone переносит `Error`, но
 * не подклассы и не собственные поля, и на той стороне типизированная ошибка молча выродилась бы в
 * безымянную. Лучше явная пара «сообщение + стек», чем незаметная потеря типа.
 */
export type ThreadRunReply =
  | { readonly ok: true; readonly result: unknown; readonly sandboxErrors: readonly unknown[] }
  | { readonly ok: false; readonly message: string; readonly stack?: string };
