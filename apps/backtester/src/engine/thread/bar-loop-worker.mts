// Сторона ПОТОКА: собирает зависимости из спеки и выполняет барный цикл.
//
// Здесь и только здесь живёт изолят с недоверенным бандлом. Главный поток о нём ничего не знает и
// не блокируется, пока хук считает, — ради этого перенос и делается (см. `run-spec.ts`).
//
// Импорты — динамические и ВНУТРИ обработчика, а не на верхнем уровне модуля. Причина
// практическая: `isolated-vm` — нативный аддон, и его загрузка привязана к изоляту потока; статика
// на верхнем уровне выполнилась бы до того, как поток сообщит хосту о готовности, и любой сбой
// загрузки выглядел бы как молчаливая смерть потока вместо внятной ошибки в ответе.

import { parentPort } from 'node:worker_threads';
import type { ThreadRunReply, ThreadRunSpec } from './run-spec.js';

if (parentPort === null) {
  throw new Error('bar-loop-worker: запущен вне worker_threads (parentPort отсутствует)');
}
const port = parentPort;

async function runSpec(spec: ThreadRunSpec): Promise<ThreadRunReply> {
  try {
    const [
      { runStrategyBacktest },
      { buildOverlayDataset },
      { FixtureDataPort },
      { createOverlayRouter },
      { loadBundle },
      { strategyBundleRegistry },
      { tapeFromColumns },
    ] = await Promise.all([
      import('../run-strategy.js'),
      import('../data-adapter.js'),
      import('../../data/reader.js'),
      import('../sandbox/overlay-router-spec.js'),
      import('../sandbox/bundle.js'),
      import('../trusted-registry.js'),
      import('../tape-columns.js'),
    ]);

    // Реестр и роутер непередаваемы через границу потока (у них методы), поэтому строятся ЗДЕСЬ —
    // но ТЕМИ ЖЕ функциями, что и на главном потоке, и из описания, посчитанного ТАМ.
    //
    // Прежняя редакция собирала их по-своему: реестр без доверенных стратегий и оверлеев, с
    // `DEFAULT_RISK`/`DEFAULT_EXEC` вместо профилей из `TRUSTED_REGISTRY_DEFINITION`, а роутер — с
    // `harnessDir` из собственного `loadConfig()` и без тома с universe. Совпадало это с прод-путём
    // только на одной конкретной стратегии и только в bind-режиме; гейт паритета сравнивал поток со
    // станком, устроенным так же, и потому молчал.
    const registry = strategyBundleRegistry(loadBundle(spec.bundleDir));
    const router = createOverlayRouter(spec.router);

    // Лента собирается ТОЙ ЖЕ фабрикой, что и на главном потоке, каким бы путём ни пришли данные:
    // `tapeFromColumns` внутри зовёт `marketTapeFromCanonicalRows`, а `buildOverlayDataset` — её же.
    // Вторая реализация сборки на этой стороне разъехалась бы с первой ровно тогда, когда фабрику
    // поменяют, и разъехалась бы молча.
    let marketTape;
    if (spec.dataPort.kind === 'columns') {
      marketTape = tapeFromColumns(spec.dataPort.columns);
    } else {
      if (spec.dataset === undefined) {
        throw new Error('bar-loop-worker: dataPort.kind="fixture" требует spec.dataset');
      }
      const dataPort = new FixtureDataPort(spec.dataPort.dir);
      marketTape = await buildOverlayDataset(dataPort, {
        datasetRef: spec.dataset.datasetRef,
        symbols: [...spec.dataset.symbols],
        timeframe: spec.dataset.timeframe,
        period: spec.dataset.period,
      });
    }

    try {
      // `runStrategyBacktest`, а НЕ `runBacktest` напрямую — та же точка входа, что у прод-ветки
      // стратегии. Разница не косметическая: она срезает `engine` и `overlayRefs` ДО раннера, потому
      // что `engine` не является полем контракта 017 (`additionalProperties:false` отклонит запрос) и
      // не должен попадать в хэшируемый `RunOutcome`. Фикстуры станков этих полей не несут — их
      // добавляет HTTP-приём, — поэтому прежний прямой вызов проходил тесты и сломался бы на первом
      // же настоящем задании из очереди.
      // Хранилище собирается ЗДЕСЬ из описания — блокер №4. Оно не проходит через `postMessage`
      // (интерфейс с методами), а возвращать документы на главный поток для записи нельзя: ссылки
      // на артефакты входят в `assembleResult`, то есть в хеш результата, и дописывать их
      // постфактум значило бы ослабить порядок «записать → сверить → собрать» ровно там, где гейт
      // ADR-0014 и существует. С описанием порядок остаётся ЛОКАЛЬНЫМ и одинаковым на обеих
      // ветках.
      //
      // Отсутствие описания здесь НЕ подменяется ничем: actor-путь отвергается хостом ДО запуска
      // потока, а legacy хранилища не читает вовсе. Подставить сюда `InMemoryArtifactStore` значило
      // бы записать артефакты в экземпляр, умирающий вместе с потоком, при внешне успешном
      // прогоне.
      const artifactStore =
        spec.artifactStore === undefined
          ? undefined
          : await (await import('../../storage/stores.js')).artifactStoreFromSpec(spec.artifactStore);

      const result = await runStrategyBacktest(spec.request as never, {
        registry,
        router,
        marketTape,
        ...(artifactStore !== undefined ? { artifactStore } : {}),
        ...(spec.flags ?? {}),
      } as never);
      // Ошибки песочницы переживают `closeAll()` по построению роутера — снимаем ДО teardown, но
      // после прогона, ровно как это делает вызывающая сторона на главном потоке.
      const sandboxErrors = router.errors().map((e) => ({ ...e }));
      return { ok: true, result, sandboxErrors };
    } finally {
      router.closeAll();
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      ...(e instanceof Error && e.stack !== undefined ? { stack: e.stack } : {}),
    };
  }
}

port.on('message', (spec: ThreadRunSpec) => {
  void runSpec(spec).then(
    (reply) => port.postMessage(reply),
    // runSpec не бросает по построению; ветка — страховка от того, чтобы поток не умер молча.
    (e: unknown) => port.postMessage({ ok: false, message: `bar-loop-worker: ${String(e)}` } satisfies ThreadRunReply),
  );
});
