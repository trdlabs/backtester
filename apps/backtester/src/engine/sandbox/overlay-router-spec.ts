// Конфигурация оверлей-роутера как ПРОСТЫЕ ДАННЫЕ плюс единственная функция, которая её применяет.
//
// Зачем это отдельным модулем. Роутер собирается в двух местах: на главном потоке (`jobs/worker.ts`,
// `overlayRouterFor`) и внутри барного цикла, уехавшего в worker_thread (`engine/thread/`). Пока у
// каждой стороны была своя сборка, они разошлись — и разошлись молча:
//
//   · прод строил реестр через `buildInlineOverlayRegistry`, то есть с доверенными стратегиями,
//     оверлеями и профилями из `TRUSTED_REGISTRY_DEFINITION`, а поток — своей сборкой с
//     `DEFAULT_RISK`/`DEFAULT_EXEC` и без доверенных модулей;
//   · прод передавал `sandboxDeps` с ТОМОМ (режим DooD) и `universe`-масштабирование, а поток —
//     только `harnessDir`, прочитанный из своего `loadConfig()`.
//
// Гейт паритета этого не поймал и не мог: он сравнивал поток со станком, собранным так же, как
// поток. Байты сходились потому, что обе стороны ошибались одинаково.
//
// Лечение — не ещё один тест, а устранение самой возможности разойтись: между сторонами ездит
// ОПИСАНИЕ роутера (только простые данные, переживающие structured clone), а превращает описание в
// роутер одна функция, общая для обеих. Забыть прокинуть том теперь нельзя — он часть описания, и
// его отсутствие видно в типе.

import { createExecutorRouter, type ExecutorRouter } from './routing.js';
import { createSandboxPolicyRegistry, type SandboxPolicy } from '../sandbox-policy.js';
import type { MountConfig } from './mounts.js';

/**
 * Всё, что нужно знать о роутере, в переносимом виде.
 *
 * Здесь намеренно НЕТ `SandboxPolicyRegistry`: у него метод `resolve`, а метод не переживает
 * границу потока. Реестр политик строится из `policy` внутри `createOverlayRouter` — на той
 * стороне, где роутер и нужен.
 */
export interface OverlayRouterSpec {
  readonly policy: SandboxPolicy;
  /**
   * Зависимости исполнителя песочницы. `mount` в режиме DooD указывает на общий том — потерять его
   * означает, что контейнер не увидит ни харнесс, ни бандл.
   */
  readonly sandboxDeps: {
    readonly harnessDir?: string;
    readonly mount?: MountConfig;
    /** Только тесты: разводит имена контейнеров параллельных файлов. Прод не задаёт. */
    readonly containerSuffix?: string;
  };
  readonly sandboxBackend: 'docker' | 'isolate';
  /** Universe-режим: схлопывает пер-символьные сессии в одну. Отсутствие ⇒ сессия на символ. */
  readonly universe?: {
    readonly enabled: boolean;
    readonly n: number;
    readonly memBaseMb: number;
    readonly memPerSymbolMb: number;
  };
}

/** Собрать роутер из описания. ЕДИНСТВЕННОЕ место сборки — и на главном потоке, и в worker_thread. */
export function createOverlayRouter(spec: OverlayRouterSpec): ExecutorRouter {
  return createExecutorRouter({
    sandboxPolicies: createSandboxPolicyRegistry([spec.policy]),
    sandboxPolicyRef: { id: spec.policy.id, version: spec.policy.version },
    sandboxDeps: spec.sandboxDeps,
    sandboxBackend: spec.sandboxBackend,
    ...(spec.universe ? { universe: spec.universe } : {}),
  });
}
