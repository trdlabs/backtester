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
      { runBacktest },
      { buildOverlayDataset },
      { FixtureDataPort },
      { createExecutorRouter, createModuleRegistry },
      { loadBundle },
      { createSandboxPolicyRegistry },
      { DEFAULT_EXEC, DEFAULT_RISK },
      { loadConfig },
      { tapeFromColumns },
    ] = await Promise.all([
      import('../runner.js'),
      import('../data-adapter.js'),
      import('../../data/reader.js'),
      import('../sandbox/routing.js'),
      import('../sandbox/bundle.js'),
      import('../sandbox-policy.js'),
      import('../profiles.js'),
      import('../../config.js'),
      import('../tape-columns.js'),
    ]);

    const policy = loadConfig().overlaySandbox.policy;

    // Реестр и роутер строятся ЗДЕСЬ — они непередаваемы через границу потока по построению.
    const registry = createModuleRegistry({
      strategyBundles: [loadBundle(spec.bundleDir)],
      riskProfiles: [DEFAULT_RISK],
      executionProfiles: [DEFAULT_EXEC],
      sandboxPolicies: [policy],
    });
    const router = createExecutorRouter({
      sandboxPolicies: createSandboxPolicyRegistry([policy]),
      sandboxPolicyRef: { id: policy.id, version: policy.version },
      sandboxDeps: { harnessDir: loadConfig().overlaySandbox.harnessDir },
      sandboxBackend: spec.sandboxBackend,
    });

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
      const result = await runBacktest(spec.request as never, {
        registry,
        router,
        marketTape,
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
