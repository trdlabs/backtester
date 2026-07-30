// Описание оверлей-роутера для тестов и станков — собранное ТЕМИ ЖЕ функциями, что и в проде.
//
// Смысл помощника ровно в одном: у зовущих сторон не должно быть своей версии конфигурации. Именно
// собственные версии и развели поток с прод-путём — станок собирал роутер по-своему, поток по-своему,
// байты сходились, а совпадали при этом две одинаковые ошибки. Здесь `sandboxDeps` берутся у
// `overlaySandboxDeps` (той самой, что зовёт `jobs/worker.ts`), а политика — из `loadConfig()`,
// то есть из того же места, откуда её берут прод-зависимости.

import { loadConfig } from '../src/config.js';
import type { OverlayRouterSpec } from '../src/engine/sandbox/overlay-router-spec.js';
import { overlaySandboxDeps } from '../src/jobs/worker.js';

// Тот же разводящий суффикс, что и в `helpers-overlay-sandbox.ts`: два параллельных файла vitest
// переиспользуют один `runId` и символ, поэтому детерминированное имя контейнера столкнулось бы.
let seq = 0;
const nextContainerSuffix = (): string => `t${process.pid}-thr${(seq += 1)}`;

/**
 * Описание роутера для прогона в отдельном потоке.
 *
 * `universe` не задаётся: тесты, которым он нужен, передают своё. Отсутствие означает сессию на
 * символ — то же самое, что и в проде при выключенном universe-режиме.
 */
export function threadRouterSpec(
  backend: 'docker' | 'isolate',
  universe?: OverlayRouterSpec['universe'],
): OverlayRouterSpec {
  const config = loadConfig();
  return {
    policy: config.overlaySandbox.policy,
    sandboxDeps: { ...overlaySandboxDeps(config.overlaySandbox), containerSuffix: nextContainerSuffix() },
    sandboxBackend: backend,
    ...(universe ? { universe } : {}),
  };
}
