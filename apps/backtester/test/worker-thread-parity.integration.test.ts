// ГЕЙТ ПАРИТЕТА НА ПРОД-ПУТИ: одно задание через очередь, две дороги, один `resultHash`.
//
// Чем он отличается от всего, что было раньше, и почему это важно.
//
// Паритет потока проверялся трижды, и все три раза — НЕ на прод-пути. Станок (bt#192/197) собирал
// зависимости сам; гейт колонок (bt#200) звал раннер напрямую. Обе проверки сравнивали поток с
// конструкцией, устроенной так же, как поток, и потому пропустили три расхождения подряд: реестр
// без доверенных модулей, роутер без тома и universe, вызов `runBacktest` вместо
// `runStrategyBacktest` (bt#202).
//
// Здесь же задание проходит целиком: HTTP-приём → очередь → `processNextQueued` → `materializeFor`
// → ветка стратегии → финализация. Ничего не подменяется, кроме одного флага конфигурации. Если
// путь потока хоть в чём-то расходится с обычным, разойдётся `resultHash` — то самое число, которое
// платформа считает результатом прогона.
//
// Что гейт НЕ проверяет и почему это сказано вслух: `resultHash` не различает исполнение в песочнице
// и in-process — twin-equivalence гарантирует им совпадение. Эта дыра закрыта отдельно, проверкой
// происхождения модуля в `thread-prod-deps.test.ts`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle } from '@trading/research-contracts';
import { AUTH, buildTestApp } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { __resetTapeCachesForTest } from '../src/data/tape-cache.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQ = resolve(HERE, 'fixtures/overlay/requests');
const BUN = resolve(HERE, 'fixtures/overlay/bundles');

const loadRequest = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(REQ, n), 'utf8')) as BacktestRunRequest;
const loadBundle = (n: string): ModuleBundle =>
  JSON.parse(readFileSync(resolve(BUN, n), 'utf8')) as ModuleBundle;

/**
 * Поток грузит свой граф только под Node 24 — измерено, не предположено (bt#201). Под 22 хуки tsx в
 * worker_thread не активируются ни при какой передаче `execArgv`. Образ и CI уже на 24; условие
 * оставлено страховкой: если версию откатят, гейт не позеленеет молча, а откажется исполняться.
 */
const THREAD_SEAM_LOADS = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 24;

/** Прогнать задание через настоящую очередь и вернуть `resultHash` терминальной строки. */
async function runThroughQueue(runId: string, barLoopThread: boolean): Promise<string> {
  // Кэш лент — процессный синглтон, и он переживает `dispose()`. Без сброса второй прогон получил
  // бы материализацию, построенную при ДРУГОМ значении флага (то есть, возможно, без колонок), и
  // гейт проверял бы не то, что думает.
  __resetTapeCachesForTest();
  const app = await buildTestApp({
    enableOverlayEngine: true,
    workerConcurrency: 1,
    barLoopThread,
    // ИЗОЛЯТНЫЙ бэкенд у ОБЕИХ дорог, и это не срезание угла, а следствие устройства гейта.
    //
    // `runId` у дорог обязан совпадать (он входит в хэшируемый результат), а имя контейнера
    // песочницы строится из runId + модуль + символ. Значит обе дороги на docker-бэкенде просят
    // ОДНО И ТО ЖЕ имя контейнера. В изоляции второй прогон успевает — первый контейнер уже удалён;
    // под полной нагрузкой демон не успевает, и тест падает с `Conflict. The container name ... is
    // already in use`. Это дефект конструкции теста, а не флак: коллизия заложена в него по
    // построению и лишь маскируется скоростью машины.
    //
    // Изолят живёт в процессе, контейнеров не создаёт, и вопрос снимается целиком. Предметом гейта
    // это не жертвует: проверяется ВРЕЗКА (флаг → колонки в кэш → поток → финализация), а не
    // бэкенд. Эквивалентность docker и isolate доказана отдельно и побитово (bt#192), поэтому
    // подменять здесь один на другой законно — и заодно гейт перестаёт требовать Docker.
    overlaySandbox: { ...loadConfig().overlaySandbox, backend: 'isolate' },
  });
  try {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: AUTH,
      payload: {
        ...loadRequest('baseline.json'),
        runId,
        engine: 'strategy',
        moduleBundle: loadBundle('short-after-pump.bundle.json'),
        metrics: ['pnl', 'win_rate'],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(await app.drain()).toBe(1);

    const row = await app.store.get(runId);
    expect(row, `строка ${runId} не найдена`).toBeDefined();
    expect(
      row!.status,
      `прогон ${runId} (barLoopThread=${barLoopThread}) не завершился: ${row!.terminalCode ?? '(без кода)'}`,
    ).toBe('completed');
    expect(typeof row!.resultHash).toBe('string');
    expect(row!.resultHash).toBeTruthy();
    return row!.resultHash!;
  } finally {
    await app.dispose();
  }
}

describe.skipIf(!THREAD_SEAM_LOADS)(
  'паритет прод-пути — барный цикл в потоке не двигает результат',
  () => {
    it(
      'одно задание через очередь двумя дорогами даёт один resultHash',
      async () => {
        // `runId` у обеих дорог ОДИН И ТОТ ЖЕ, и это принципиально: он входит в запрос, а запрос —
        // в хэшируемый результат. Первая редакция теста дала дорогам разные id и получила разные
        // хэши; расхождение выглядело как дефект потока, а было дефектом теста. Поймал это
        // контрольный опыт — две ОДИНАКОВЫЕ дороги с разными id тоже разошлись.
        //
        // Одинаковый id безопасен: каждая дорога поднимает своё приложение со своим хранилищем и
        // своими каталогами, так что это не повторная попытка одной строки очереди, а одно и то же
        // задание, поданное дважды в независимые окружения.
        const RUN_ID = 'wtp-parity-1';
        const onMain = await runThroughQueue(RUN_ID, false);
        const onThread = await runThroughQueue(RUN_ID, true);

        expect(onThread).toBe(onMain);
      },
      180_000, // две дороги; изолят в процессе, контейнеров нет
    );
  },
);
