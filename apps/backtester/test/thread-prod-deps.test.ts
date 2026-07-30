// ГЕЙТ: барный цикл в отдельном потоке собирает ТЕ ЖЕ зависимости, что и прод-путь.
//
// Почему этот гейт понадобился отдельно от гейта паритета колонок. Тот сравнивал поток со СТАНКОМ,
// а станок был устроен так же, как поток, — и байты сходились потому, что обе стороны ошибались
// одинаково. Пока это не вскрылось, поток три раза подряд расходился с `jobs/worker.ts` молча:
//
//   1) РЕЕСТР. Прод зовёт `buildInlineOverlayRegistry([], [bundle])` — доверенные стратегии,
//      оверлеи и профили из `TRUSTED_REGISTRY_DEFINITION`. Поток собирал свой: только бандл,
//      `DEFAULT_RISK`/`DEFAULT_EXEC`, без доверенных модулей. Запрос, ссылающийся на доверенный
//      модуль или на недефолтный профиль, в потоке просто не разрешился бы.
//   2) РОУТЕР. Прод передаёт `sandboxDeps` с ТОМОМ (режим DooD) и `universe`-масштабирование.
//      Поток брал `harnessDir` из собственного `loadConfig()` и терял и то и другое: в DooD
//      контейнер не увидел бы ни харнесса, ни бандла.
//   3) ТОЧКА ВХОДА. Прод зовёт `runStrategyBacktest`, который срезает `engine` и `overlayRefs` ДО
//      раннера (поле `engine` не входит в контракт 017 и не должно попадать в хэшируемый результат).
//      Поток звал `runBacktest` напрямую. Фикстуры станков поля `engine` не несут — его добавляет
//      HTTP-приём, — поэтому расхождение проявилось бы только на настоящем задании из очереди.
//
// Лечение выбрано структурное, а не тестовое: конфигурация роутера стала ОПИСАНИЕМ из простых
// данных (`OverlayRouterSpec`), которое считает главный поток, а превращает в роутер одна функция
// `createOverlayRouter`, общая для обеих сторон. Тест ниже сторожит именно это свойство — что
// описание полное и что вторая сборка роутера в кодовой базе не завелась снова.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createOverlayRouter, type OverlayRouterSpec } from '../src/engine/sandbox/overlay-router-spec.js';
import { overlayRouterSpecFor, overlaySandboxDeps } from '../src/jobs/worker.js';
import { buildInlineOverlayRegistry, strategyBundleRegistry } from '../src/engine/trusted-registry.js';
import type { ThreadRunSpec } from '../src/engine/thread/run-spec.js';

// Точка монтирования — НАСТОЯЩИЙ временный каталог, а не выдуманный путь: `overlaySandboxDeps` в
// режиме тома действительно создаёт внутри него каталог харнесса, и на фиктивном пути падает с
// EACCES. Это, кстати, само по себе полезное свойство — описание не «декларация о намерениях», а
// результат работы, которую прод уже проделал.
const mountRoots: string[] = [];
function freshMountpoint(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tpd-mnt-'));
  mountRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of mountRoots) rmSync(d, { recursive: true, force: true });
});

/** Минимальные `WorkerDeps` для сборки описания — берутся только поля, которые оно читает. */
function depsWith(overrides: {
  backend?: 'docker' | 'isolate';
  volume?: string;
  volumeMountpoint?: string;
  universe?: { enabled: boolean; maxN: number; memBaseMb: number; memPerSymbolMb: number };
}): Parameters<typeof overlayRouterSpecFor>[0] {
  const config = loadConfig();
  return {
    overlaySandbox: {
      ...config.overlaySandbox,
      ...(overrides.backend !== undefined ? { backend: overrides.backend } : {}),
      ...(overrides.volume !== undefined ? { volume: overrides.volume } : {}),
      ...(overrides.volumeMountpoint !== undefined ? { volumeMountpoint: overrides.volumeMountpoint } : {}),
    },
    ...(overrides.universe ? { universe: overrides.universe } : {}),
  } as unknown as Parameters<typeof overlayRouterSpecFor>[0];
}

describe('зависимости потока — описание роутера полно и переносимо', () => {
  it('описание переживает structured clone без потерь — иначе поток получит не то, что посчитал прод', () => {
    // Это не формальность: именно здесь ловится случай, когда в описание однажды положат живой
    // объект (реестр политик, драйвер docker, функцию). Такой объект `postMessage` либо потеряет,
    // либо отвергнет, и обнаружится это на первом настоящем прогоне, а не здесь.
    const spec = overlayRouterSpecFor(
      depsWith({ backend: 'isolate', volume: 'sbx-vol', volumeMountpoint: freshMountpoint() }),
      3,
    );
    expect(structuredClone(spec)).toEqual(spec);
  });

  it('том режима DooD попадает в описание — не потерять его дороже всего', () => {
    const mountpoint = freshMountpoint();
    const spec = overlayRouterSpecFor(depsWith({ volume: 'sbx-vol', volumeMountpoint: mountpoint }), 1);
    expect(spec.sandboxDeps.mount).toEqual({ mode: 'volume', volume: 'sbx-vol', mountpoint });
    // Харнесс в режиме тома лежит ВНУТРИ точки монтирования, а не там, где он на хосте.
    expect(spec.sandboxDeps.harnessDir?.startsWith(mountpoint)).toBe(true);
  });

  it('bind-режим не выдумывает том', () => {
    const spec = overlayRouterSpecFor(depsWith({}), 1);
    expect(spec.sandboxDeps.mount).toBeUndefined();
    expect(spec.sandboxDeps.harnessDir).toBe(overlaySandboxDeps(loadConfig().overlaySandbox).harnessDir);
  });

  it('universe попадает в описание с фактическим числом символов этого прогона', () => {
    const universe = { enabled: true, maxN: 50, memBaseMb: 128, memPerSymbolMb: 16 };
    const spec = overlayRouterSpecFor(depsWith({ universe }), 7);
    // В описании роутера `n` — сколько символов В ЭТОМ прогоне (по нему масштабируется память
    // сессии), а НЕ потолок `maxN` из настроек. Перепутать их — значит выдать сессии не ту память.
    expect(spec.universe).toEqual({ enabled: true, n: 7, memBaseMb: 128, memPerSymbolMb: 16 });
  });

  it('universe отсутствует, когда режим выключен или число символов неизвестно', () => {
    const universe = { enabled: false, maxN: 50, memBaseMb: 128, memPerSymbolMb: 16 };
    expect(overlayRouterSpecFor(depsWith({ universe }), 7).universe).toBeUndefined();
    expect(overlayRouterSpecFor(depsWith({ universe: { ...universe, enabled: true } }), undefined).universe).toBeUndefined();
  });

  it('бэкенд в описании задан всегда — «отсутствует» не должно трактоваться на двух сторонах', () => {
    // `createExecutorRouter` ветвится только на `=== 'isolate'`, поэтому `undefined` для него равен
    // `'docker'`. Но описание уезжает в другой поток, и неразрешённый дефолт пришлось бы понимать
    // одинаково в двух местах — а это ровно тот механизм, которым расхождения и заводятся.
    expect(overlayRouterSpecFor(depsWith({}), 1).sandboxBackend).toBe('docker');
    expect(overlayRouterSpecFor(depsWith({ backend: 'isolate' }), 1).sandboxBackend).toBe('isolate');
  });

  it('одно и то же описание собирается в роутер на обеих сторонах одной функцией', () => {
    // Свойство, ради которого всё и затевалось: сборка роутера в кодовой базе ровно одна. Если
    // где-то заведётся вторая, этот тест её не увидит — но увидит проверка ниже по составу типа:
    // `ThreadRunSpec.router` обязан быть именно `OverlayRouterSpec`, а не своей структурой.
    const spec = overlayRouterSpecFor(depsWith({ backend: 'isolate' }), 1);
    const router = createOverlayRouter(spec);
    try {
      expect(router.errors()).toEqual([]);
    } finally {
      router.closeAll();
    }
    // Типовая привязка: спека прогона несёт РОВНО тот же тип описания, что считает прод.
    const asThreadSpec: Pick<ThreadRunSpec, 'router'> = { router: spec };
    const roundTripped: OverlayRouterSpec = structuredClone(asThreadSpec).router;
    expect(roundTripped).toEqual(spec);
  });
});

describe('зависимости потока — бандл остаётся НЕДОВЕРЕННЫМ', () => {
  const BUNDLE_PATH = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures/overlay/bundles/short-after-pump.bundle.json',
  );

  it('бандл стратегии регистрируется как bundle, а не как доверенный модуль', () => {
    // Это ЕДИНСТВЕННАЯ проверка, ловящая перепутанные аргументы `buildInlineOverlayRegistry`, и
    // сравнением хэшей её не заменить — что показано прямым опытом. Фикстурный бандл называется
    // `short_after_pump`, и ровно такая же стратегия есть в доверенном реестре; при перепутанном
    // порядке аргументов ссылка разрешается в ДОВЕРЕННЫЙ одноимённый двойник, прогон идёт
    // in-process мимо песочницы — и даёт тот же `result_hash`, потому что twin-equivalence как раз
    // это и гарантирует. Гейт молчит, а недоверенный код исполняется вне изоляции.
    //
    // В проде пользовательский бандл доверенного двойника не имеет и ссылка просто не разрешилась
    // бы. Но полагаться на это нельзя: защита, работающая лишь потому, что у злоумышленника нет
    // одноимённого модуля, — не защита.
    const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));
    const ref = { id: bundle.manifest.id, version: bundle.manifest.version };

    // Проверяется ИМЕННО общая форма — та, что зовут обе стороны, а не её содержимое по образцу.
    const correct = strategyBundleRegistry(bundle).resolveStrategy(ref);
    expect(correct?.provenance).toBe('bundle');

    // Тот же вызов с перепутанными аргументами — чтобы было видно, что проверка различает.
    const swapped = buildInlineOverlayRegistry([bundle], []).resolveStrategy(ref);
    expect(swapped?.provenance).toBe('trusted');
  });
});
