// Сторона ХОСТА: запускает барный цикл в отдельном потоке и ждёт результат.
//
// Что именно это даёт (и чего НЕ даёт). Пока поток считает, главный поток свободен: таймеры тикают,
// хартбит лизы живёт, отмена наблюдаема. Это структурно закрывает P3-5 из `jobs/worker.ts`, где
// сегодня стоит митигация «продлить лизу перед входом в цикл» и оговорка, что один синхронный
// прогон длиннее TTL всё равно её отпустит. Ускорения сам по себе перенос не даёт — он делает
// безопасным синхронный вызов в изолят, который ускорение и приносит.
//
// Поток на прогон, а не пул. Изолят живёт внутри потока и держит состояние сессии бандла; общий
// поток на несколько прогонов означал бы общий изолят на разные бандлы, то есть ровно тот
// shared-instance хазард, из-за которого universe-режим в POC отвергается fail-closed. Цена —
// старт потока на прогон; на фоне прогона в секунды это шум, и она измерима отдельно.

import { Worker } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThreadRunReply, ThreadRunSpec } from './run-spec.js';

/**
 * Путь к entry потока — исходный `.mts`, он же TypeScript.
 *
 * Раньше здесь стояла проверка «есть ли рядом скомпилированный `.mjs`». Она была написана под
 * сборку, которой в этом репозитории нет: приложение нигде не компилируется в JS, а прод-образ
 * запускает `tsx apps/backtester/src/index.ts` напрямую по исходникам. Ветка не срабатывала ни разу
 * и только создавала впечатление, будто где-то существует собранный вариант.
 *
 * ВНИМАНИЕ, ОГРАНИЧЕНИЕ СРЕДЫ (замерено, не предположение). Поток грузит свой граф только под
 * Node 24. Под Node 22 — а это版 прод-образа (`node:22-slim`) и версия CI — хуки tsx в worker_thread
 * не активируются НИ ПРИ КАКОЙ передаче флагов: `.mts` разбирает встроенный стриппер типов Node, а
 * переотображение `.js`→`.ts` при импорте (фича именно tsx) не происходит, и первый же
 * `import('../runner.js')` падает с `Cannot find module`. Проверено прямым перебором вариантов
 * `execArgv`; с `--no-experimental-strip-types` поток отвечает «Unknown file extension .mts», что и
 * доказывает: tsx там не живёт. До перевода образа на Node 24 путь потока в проде нерабочий.
 */
export function workerEntry(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'bar-loop-worker.mts');
}

/**
 * `execArgv` для потока: наследуем родительские, но гарантируем загрузчик TypeScript.
 *
 * Entry потока — исходный `.mts`, а исходнику загрузчик нужен ВСЕГДА: встроенный стриппер типов
 * Node разберёт синтаксис, но не переотобразит `../runner.js` в `../runner.ts` — это делает именно
 * tsx. Унаследовать загрузчик можно, только если родитель сам запущен под tsx; когда родителя
 * поднял кто-то другой (vitest трансформирует модули своим конвейером и в `execArgv` ничего не
 * кладёт), наследовать нечего, и поток падал бы на первом же импорте.
 *
 * Поэтому загрузчик добавляется по факту его отсутствия, а не по признаку «мы в тестах». Прод
 * запускается `tsx src/index.ts`, загрузчик там уже есть, и ветка добавления не срабатывает.
 */
export function defaultExecArgv(entry: string): string[] {
  if (!entry.endsWith('.mts') && !entry.endsWith('.ts')) return [...process.execArgv];
  const hasTsLoader = process.execArgv.some((a) => a.includes('tsx'));
  return hasTsLoader ? [...process.execArgv] : ['--import', 'tsx', ...process.execArgv];
}

export interface RunInThreadOptions {
  /** Путь к entry потока (тесты/станки подменяют). */
  readonly entry?: string;
  /**
   * Потолок ожидания ответа. Отсутствие ⇒ ждём столько, сколько нужно: собственные гарды прогона
   * (per-call и session wall-time песочницы) точнее любого внешнего таймера, а лишний потолок
   * поверх них давал бы вторую, несогласованную причину смерти прогона.
   */
  readonly timeoutMs?: number;
  /**
   * `execArgv` потока. По умолчанию наследуется родительский — под `tsx` оттуда приходит загрузчик
   * TypeScript, без которого поток не импортирует исходники.
   *
   * Переопределять приходится там, где у родителя загрузчика нет, а entry всё ещё исходный `.mts`:
   * так устроен vitest — он трансформирует модули сам, своим конвейером, и в `process.execArgv`
   * ничего для дочернего процесса не кладёт. Прод сюда не попадает: там рядом лежит собранный
   * `.mjs`, и загрузчик ему не нужен вовсе.
   */
  readonly execArgv?: readonly string[];
}

/**
 * Разобрать ответ потока в исход прогона.
 *
 * Вынесено отдельной функцией, потому что путей к ответу два — одноразовый поток
 * (`runBacktestInThread`) и тёплый пул (`BarLoopThreadPool`), — а разбор обязан быть один. Две
 * копии этой логики разъехались бы на том, как именно ошибка внутри цикла отличается от ошибки
 * запуска потока, и один и тот же сбой выглядел бы по-разному в зависимости от пути.
 */
export function unwrapThreadReply(reply: ThreadRunReply): ThreadRunOutcome {
  if (!reply.ok) {
    // Стек потока приклеивается к сообщению: иначе он теряется на границе и ошибка внутри цикла
    // выглядела бы как ошибка запуска потока.
    const err = new Error(reply.message);
    if (reply.stack !== undefined) err.stack = `${err.stack ?? ''}\n--- поток ---\n${reply.stack}`;
    throw err;
  }
  return { result: reply.result, sandboxErrors: reply.sandboxErrors };
}

export interface ThreadRunOutcome {
  readonly result: unknown;
  readonly sandboxErrors: readonly unknown[];
}

/**
 * Выполнить прогон в отдельном потоке.
 *
 * Поток создаётся, получает спеку, отвечает один раз и завершается. `execArgv` наследуется явно:
 * под tsx загрузчик TypeScript приходит именно оттуда, и без передачи поток не сумел бы
 * импортировать исходники (проверено спайком до постройки шва).
 */
export async function runBacktestInThread(
  spec: ThreadRunSpec,
  opts: RunInThreadOptions = {},
): Promise<ThreadRunOutcome> {
  const entry = opts.entry ?? workerEntry();
  const worker = new Worker(entry, {
    execArgv: opts.execArgv !== undefined ? [...opts.execArgv] : defaultExecArgv(entry),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await new Promise<ThreadRunReply>((res, rej) => {
      worker.once('message', res);
      worker.once('error', rej);
      worker.once('exit', (code) => {
        // Ответ приходит раньше выхода; сюда попадаем только если поток умер, не ответив.
        rej(new Error(`bar-loop worker exited with code ${code} before replying`));
      });
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => rej(new Error(`bar-loop worker timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
        timer.unref?.();
      }
      worker.postMessage(spec);
    });
    return unwrapThreadReply(reply);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
