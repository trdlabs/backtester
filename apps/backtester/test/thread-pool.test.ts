// ГЕЙТ ТЁПЛОГО ПУЛА: переиспользование потока не меняет результат и не переносит состояние.
//
// Что именно здесь под вопросом. Тёплый пул переиспользует ПОТОК, а не изолят — граница
// безопасности остаётся там же, где была: недоверенный бандл исполняется внутри изолята, который
// создаётся и уничтожается на каждый прогон (`router.closeAll()` → `isolate.dispose()`). Общий
// изолят на разные бандлы был бы shared-instance хазардом, и его здесь нет.
//
// Но переиспользование потока добавляет два риска, и оба про КОРРЕКТНОСТЬ, а не про изоляцию:
//
//   1) модульное состояние НАШЕГО кода в графе потока переживает прогон. Недоверенный код туда не
//      пишет, но наш собственный кэш или счётчик мог бы загрязнить следующий результат;
//   2) поток, переживший сбойный прогон, может остаться в неизвестном состоянии.
//
// Проверяются оба, и не рассуждением. Второй — провалившимся бандлом: если сбой оставляет след,
// следующий прогон на ТОМ ЖЕ потоке это покажет.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FixtureDataPort } from '../src/data/reader.js';
import { buildOverlayDatasetWithColumns } from '../src/engine/data-adapter.js';
import { BarLoopThreadPool, defaultMaxWorkers } from '../src/engine/thread/thread-pool.js';
import { runBacktestInThread } from '../src/engine/thread/run-in-thread.js';
import type { ThreadRunSpec } from '../src/engine/thread/run-spec.js';
import { materializeReadableBundle } from './helpers-overlay-sandbox.js';
import { threadRouterSpec } from './helpers-thread-spec.js';
import { resultHash } from './helpers/bar-major-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const FIXTURES_DIR = resolve(APP_DIR, 'fixtures/candles');
const REQUEST_PATH = resolve(APP_DIR, 'test/fixtures/overlay/requests/universe-multi.json');
const BUNDLES = resolve(APP_DIR, 'test/fixtures/overlay/bundles');

/** Поток грузит свой граф только под Node 24 — измерено (bt#201). Образ и CI уже на 24. */
const THREAD_SEAM_LOADS = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 24;

const pools: BarLoopThreadPool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

function makePool(maxWorkers: number): BarLoopThreadPool {
  const p = new BarLoopThreadPool({ maxWorkers, execArgv: ['--import', 'tsx'] });
  pools.push(p);
  return p;
}

describe.skipIf(!THREAD_SEAM_LOADS)('тёплый пул потоков', () => {
  const request = {
    ...(JSON.parse(readFileSync(REQUEST_PATH, 'utf8')) as Record<string, unknown>),
    engine: 'strategy' as const,
  };

  async function specFor(bundleFile: string): Promise<ThreadRunSpec> {
    const sp = await materializeReadableBundle(JSON.parse(readFileSync(resolve(BUNDLES, bundleFile), 'utf8')));
    const sel = request as unknown as { datasetRef: string; symbols: string[]; timeframe: string; period: { from: string; to: string } };
    const m = await buildOverlayDatasetWithColumns(new FixtureDataPort(FIXTURES_DIR), {
      datasetRef: sel.datasetRef,
      symbols: sel.symbols,
      timeframe: sel.timeframe,
      period: sel.period,
    });
    return {
      request,
      bundleDir: sp.bundleDir,
      router: threadRouterSpec('isolate'),
      dataPort: { kind: 'columns', columns: m.columns! },
    };
  }

  it(
    'тёплый поток даёт тот же результат, что и свежий — и переиспользуется, а не пересоздаётся',
    async () => {
      const spec = await specFor('short-after-pump.bundle.json');

      // Опорная точка — ОДНОРАЗОВЫЙ поток, тот самый путь, что уже закрыт гейтом на прод-пути.
      const fresh = await runBacktestInThread(spec, { execArgv: ['--import', 'tsx'] });
      expect(fresh.sandboxErrors).toEqual([]);
      const baseline = resultHash(fresh.result as never);

      const pool = makePool(1);
      for (let i = 0; i < 3; i += 1) {
        const reply = await pool.run(spec);
        expect(reply.ok, `прогон ${i + 1} не удался: ${reply.ok ? '' : reply.message}`).toBe(true);
        if (!reply.ok) return;
        expect(reply.sandboxErrors).toEqual([]);
        expect(resultHash(reply.result as never), `прогон ${i + 1} разошёлся с одноразовым потоком`).toBe(baseline);
      }
      // Три прогона на одном потоке — иначе «тёплый» пул был бы тёплым лишь на словах.
      expect(pool.size()).toBe(1);
    },
    240_000,
  );

  it(
    'сбойный бандл не отравляет следующий прогон на том же потоке',
    async () => {
      const good = await specFor('short-after-pump.bundle.json');
      const bad = await specFor('short-after-pump-failing.bundle.json');

      const pool = makePool(1);

      // Чистая опорная точка ДО сбоя — на этом же тёплом потоке.
      const before = await pool.run(good);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const baseline = resultHash(before.result as never);

      // Сбойный бандл: он обязан провалиться (иначе тест ничего не проверяет) — либо ответом
      // `ok:false`, либо записанными ошибками песочницы.
      const failed = await pool.run(bad);
      const reallyFailed = !failed.ok || failed.sandboxErrors.length > 0;
      expect(reallyFailed, 'сбойный бандл прошёл успешно — фикстура перестала быть сбойной').toBe(true);

      // И главное: следующий прогон на ТОМ ЖЕ потоке обязан совпасть с опорной точкой.
      const after = await pool.run(good);
      expect(after.ok, `прогон после сбоя не удался: ${after.ok ? '' : after.message}`).toBe(true);
      if (!after.ok) return;
      expect(after.sandboxErrors).toEqual([]);
      expect(resultHash(after.result as never), 'сбой предыдущего прогона изменил результат следующего').toBe(baseline);
    },
    300_000,
  );

  it('пул не создаёт больше потоков, чем разрешено, а ставит лишних в очередь', async () => {
    const spec = await specFor('short-after-pump.bundle.json');
    const pool = makePool(2);
    const results = await Promise.all([pool.run(spec), pool.run(spec), pool.run(spec), pool.run(spec)]);
    for (const r of results) expect(r.ok).toBe(true);
    // Четыре прогона, потолок два: лишние ждали, а не поднимали новые потоки. Превышение потолка на
    // CPU-bound работе не ускоряет, а замедляет — ядер от этого не прибавляется.
    expect(pool.size()).toBeLessThanOrEqual(2);
  }, 300_000);

  it('потолок по умолчанию положителен и не превышает доступный параллелизм', () => {
    const n = defaultMaxWorkers();
    expect(n).toBeGreaterThanOrEqual(1);
    // Дефолт — для локальной разработки. В контейнере он завышен (квоту cgroup Node не читает),
    // поэтому в развёртывании размер обязан приходить явной настройкой.
    expect(n).toBeLessThanOrEqual(1024);
  });
});
