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

import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThreadRunReply, ThreadRunSpec } from './run-spec.js';

/**
 * Путь к entry потока.
 *
 * `new Worker(path)` принимает ФАЙЛ, а не спецификатор модуля, поэтому обычная резолюция
 * `.mjs`→`.mts`, которую делает tsx для импортов, здесь не работает: файла с расширением `.mjs` в
 * дереве исходников просто нет. Отсюда явная проверка — скомпилированный `.mjs` рядом с `.js`,
 * иначе исходный `.mts`.
 */
function workerEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, 'bar-loop-worker.mjs');
  return existsSync(compiled) ? compiled : resolve(here, 'bar-loop-worker.mts');
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
  const worker = new Worker(opts.entry ?? workerEntry(), { execArgv: process.execArgv });
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
    if (!reply.ok) {
      // Стек потока приклеивается к сообщению: иначе он теряется на границе и ошибка внутри цикла
      // выглядела бы как ошибка запуска потока.
      const err = new Error(reply.message);
      if (reply.stack !== undefined) err.stack = `${err.stack ?? ''}\n--- поток ---\n${reply.stack}`;
      throw err;
    }
    return { result: reply.result, sandboxErrors: reply.sandboxErrors };
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
