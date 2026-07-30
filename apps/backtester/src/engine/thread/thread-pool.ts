// ТЁПЛЫЙ ПУЛ ПОТОКОВ барного цикла: поток переиспользуется, изолят — свежий на каждый прогон.
//
// ЗАЧЕМ. Поток-на-прогон платит постоянную цену входа. Замер разложил её (`profile-thread-startup`,
// 180 бар-вычислений, без закрепления ядер):
//
//   создание потока и загрузка entry   ~205 мс
//   импорт графа модулей барного цикла ~210 мс
//   реестр, роутер, лента из колонок     ~3 мс
//
// То есть ~415 мс из ~418 — это цена ПОТОКА, а не прогона: она платится за то, чтобы поднять
// изолированную копию модульного графа под загрузчиком TypeScript. Переиспользуя поток, её платят
// один раз за жизнь процесса. Повторный проход по тем же импортам стоит ~13 мс — модули уже в кэше.
//
// Замечено попутно и тоже говорит в пользу пула: при потоке-на-прогон создание потока в
// долгоживущем процессе ДОРОЖАЕТ от повтора к повтору (117 → 156 → 181 мс на пяти повторах при
// тихой машине). Пул создаёт потоки один раз и этой деградации не накапливает.
//
// ПОЧЕМУ ЭТО НЕ ЛОМАЕТ ИЗОЛЯЦИЮ. Опасение, из-за которого изначально был выбран поток-на-прогон,
// касается ИЗОЛЯТА, а не потока: общий изолят на разные бандлы — тот самый shared-instance хазард,
// из-за которого universe-режим в POC отвергается fail-closed. Но изолят живёт внутри роутера,
// который создаётся и уничтожается НА КАЖДОЕ сообщение (`bar-loop-worker.mts` строит его из спеки и
// закрывает в `finally`). Переиспользуется только загруженный модульный граф — код, а не состояние.
//
// Это утверждение проверяется не рассуждением, а гейтом: два РАЗНЫХ бандла через один тёплый поток
// обязаны дать те же хэши, что и через свежие потоки (`test/thread-pool.test.ts`).
//
// ПОЧЕМУ ПОРОГА ПО ЧИСЛУ БАРОВ НЕТ. Он был бы нужен, если бы цена входа оставалась. Считался он как
// «цена входа ÷ выигрыш на бар» и выходил около трёх тысяч бар-вычислений — на порядок ниже любого
// настоящего прогона (две недели минутных свечей по трём символам это 60 тысяч). Хуже того, он
// ЗАВИСИТ ОТ СТРАТЕГИИ: выигрыш потока — это плата за одно пересечение границы изолята, и чем
// больше стратегия считает внутри хука, тем меньше остаётся экономить (bt#196: 144 мкс при пустом
// хуке против 18 мкс при ~1 мс счёта). Константа, которую пришлось бы калибровать заново на каждую
// новую стратегию, — плохая конструкция. Пул убирает саму причину порога.

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { defaultExecArgv, workerEntry } from './run-in-thread.js';
import type { ThreadRunReply, ThreadRunSpec } from './run-spec.js';

/** Один тёплый поток пула вместе с признаком занятости. */
interface PooledWorker {
  readonly worker: Worker;
  busy: boolean;
  /** Поток, доживший до ошибки, в пул не возвращается — его состояние неизвестно. */
  poisoned: boolean;
}

export interface ThreadPoolOptions {
  /** Путь к entry потока. Отсутствие ⇒ тот же, что у `runBacktestInThread`. */
  readonly entry?: string;
  /** `execArgv` для создаваемых потоков. Отсутствие ⇒ тот же расчёт, что у `runBacktestInThread`. */
  readonly execArgv?: readonly string[];
  /**
   * Потолок числа одновременно живущих потоков.
   *
   * Больше ядер — вредно, а не «немного медленнее»: барный цикл упирается в счёт, и лишние потоки
   * не добавляют вычислительной мощности, а отнимают её на переключения и вымывание кэша.
   */
  readonly maxWorkers: number;
}

/**
 * Разумный потолок пула по умолчанию.
 *
 * `availableParallelism()` честнее `os.cpus().length`: он учитывает маску привязки к ядрам. Но
 * КВОТУ CGROUP он не читает, поэтому в контейнере с одним выделенным ядром на 32-ядерной машине
 * вернёт 32. Значит это разумный дефолт для локальной разработки, а НЕ источник истины для
 * развёртывания — там размер обязан приходить явной настройкой.
 */
export function defaultMaxWorkers(): number {
  return Math.max(1, availableParallelism());
}

/**
 * Пул тёплых потоков. Один поток обслуживает один прогон за раз.
 *
 * Ожидание свободного потока — очередь, а не отказ: превышение потолка означает, что ядер меньше,
 * чем желающих считать, и правильная реакция на это — подождать, а не запустить всех сразу и
 * замедлить каждого.
 */
export class BarLoopThreadPool {
  private readonly workers: PooledWorker[] = [];
  private readonly waiting: Array<(w: PooledWorker) => void> = [];
  private closed = false;

  private readonly entry: string;
  private readonly execArgv: readonly string[];

  constructor(private readonly opts: ThreadPoolOptions) {
    // Entry и загрузчик берутся у ШВА, а не считаются здесь заново: две реализации одного решения —
    // ровно тот механизм, которым в этой же подсистеме уже разъезжались поток и прод-путь (bt#202).
    this.entry = opts.entry ?? workerEntry();
    this.execArgv = opts.execArgv ?? defaultExecArgv(this.entry);
  }

  /** Выполнить прогон на любом свободном тёплом потоке. */
  async run(spec: ThreadRunSpec): Promise<ThreadRunReply> {
    if (this.closed) throw new Error('BarLoopThreadPool: пул закрыт');
    const pooled = await this.acquire();
    try {
      return await this.exchange(pooled, spec);
    } finally {
      this.release(pooled);
    }
  }

  /** Число живых потоков — для наблюдаемости и тестов. */
  size(): number {
    return this.workers.length;
  }

  /** Завершить все потоки. После вызова пул непригоден. */
  async close(): Promise<void> {
    this.closed = true;
    const all = this.workers.splice(0, this.workers.length);
    await Promise.all(all.map((p) => p.worker.terminate()));
  }

  private async acquire(): Promise<PooledWorker> {
    const free = this.workers.find((w) => !w.busy && !w.poisoned);
    if (free !== undefined) {
      free.busy = true;
      return free;
    }
    if (this.workers.length < this.opts.maxWorkers) {
      const pooled: PooledWorker = {
        worker: new Worker(this.entry, { execArgv: [...this.execArgv] }),
        busy: true,
        poisoned: false,
      };
      // Поток пула живёт дольше запроса, поэтому его смерть не должна валить процесс необработанным
      // событием: помечаем и выбрасываем при следующем обращении.
      pooled.worker.on('error', () => {
        pooled.poisoned = true;
      });
      pooled.worker.on('exit', () => {
        pooled.poisoned = true;
      });
      this.workers.push(pooled);
      return pooled;
    }
    return new Promise<PooledWorker>((resolve) => this.waiting.push(resolve));
  }

  private release(pooled: PooledWorker): void {
    if (pooled.poisoned || this.closed) {
      const i = this.workers.indexOf(pooled);
      if (i >= 0) this.workers.splice(i, 1);
      void pooled.worker.terminate();
      pooled.busy = false;
      // Ожидающему достанется новый поток на следующем `acquire` — будим его через общий путь.
      const next = this.waiting.shift();
      if (next !== undefined) void this.acquire().then(next);
      return;
    }
    pooled.busy = false;
    const next = this.waiting.shift();
    if (next !== undefined) {
      pooled.busy = true;
      next(pooled);
    }
  }

  /**
   * Один обмен «спека → ответ» на занятом потоке.
   *
   * Слушатели снимаются в `finally` обязательно: поток живёт дальше и обслужит следующий прогон, а
   * накопленные подписки утекали бы и, что хуже, доставили бы чужой ответ не тому ожидающему.
   */
  private exchange(pooled: PooledWorker, spec: ThreadRunSpec): Promise<ThreadRunReply> {
    return new Promise<ThreadRunReply>((resolve, reject) => {
      const onMessage = (reply: ThreadRunReply): void => {
        cleanup();
        resolve(reply);
      };
      const onError = (err: Error): void => {
        pooled.poisoned = true;
        cleanup();
        reject(err);
      };
      const onExit = (code: number): void => {
        pooled.poisoned = true;
        cleanup();
        reject(new Error(`bar-loop worker exited with code ${code} before replying`));
      };
      const cleanup = (): void => {
        pooled.worker.off('message', onMessage);
        pooled.worker.off('error', onError);
        pooled.worker.off('exit', onExit);
      };
      pooled.worker.on('message', onMessage);
      pooled.worker.on('error', onError);
      pooled.worker.on('exit', onExit);
      pooled.worker.postMessage(spec);
    });
  }
}
