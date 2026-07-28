// PERF — гейт на загрязнённый замер.
//
// Зачем он существует. Прошлые замеры этого движка испортила не слабость машины, а конкуренция за
// CPU: 312 мкс/бар против 42 на той же конфигурации (control-center `docs/analysis/19`,
// «Оговорка о замерах»). Разница в 7 раз — это больше, чем эффект любой оптимизации, которую
// волны A–C собираются доказывать. Значит цифра, снятая на шумной машине, не просто неточна:
// она способна показать ускорение там, где его нет, и наоборот.
//
// Поэтому гейт РЕФЬЮЗИТ, а не предупреждает. Станок, напечатавший число под нагрузкой, оставляет
// это число в отчёте навсегда, и постфактум отличить его от чистого нельзя. Единственная защита —
// сделать печать невозможной.
//
// Гейт проверяет две вещи:
//   1) load average (1 мин) не выше порога — по умолчанию половина ядер;
//   2) процесс закреплён за подмножеством ядер (`taskset -c 2,3`), то есть не делит их с прочей
//      работой планировщика.
//
// Обе проверки — отказ. Второй можно снять `BENCH_ALLOW_UNPINNED=true` (например, в контейнере,
// где аффинити уже задано снаружи); первый снять нельзя — в этом весь смысл.

import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

export interface BenchEnvironment {
  /** load average за 1 минуту */
  readonly loadavg1: number;
  /** всего ядер на машине */
  readonly cores: number;
  /** сколько ядер разрешено процессу (аффинити) */
  readonly allowedCpus: number;
  /** порог load average, выше которого замер считается загрязнённым */
  readonly maxLoadavg: number;
  /** разрешить прогон без закрепления за ядрами */
  readonly allowUnpinned: boolean;
}

export interface BenchVerdict {
  readonly ok: boolean;
  /** причины отказа; пусто, когда `ok` */
  readonly reasons: readonly string[];
}

/**
 * Чистая функция вердикта — вынесена отдельно, чтобы гейт можно было проверить тестом, а не
 * доверять ему на слово. Ровно та же логика, что и в `assertQuietBench`.
 */
export function evaluateBenchEnvironment(env: BenchEnvironment): BenchVerdict {
  const reasons: string[] = [];

  if (env.loadavg1 > env.maxLoadavg) {
    reasons.push(
      `load average ${env.loadavg1.toFixed(2)} выше порога ${env.maxLoadavg.toFixed(2)} ` +
        `(${env.cores} ядер) — машина занята, тайминги будут завышены в разы`,
    );
  }

  if (!env.allowUnpinned && env.allowedCpus >= env.cores) {
    reasons.push(
      `процесс не закреплён за ядрами (доступно ${env.allowedCpus} из ${env.cores}) — ` +
        `запускайте под \`taskset -c 2,3\` или снимите проверку BENCH_ALLOW_UNPINNED=true`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}

/** Разбирает `Cpus_allowed_list` из /proc/self/status: «0-1,3» → 3. */
export function countCpusInList(list: string): number {
  let total = 0;
  for (const part of list.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const dash = trimmed.indexOf('-');
    if (dash === -1) {
      total += 1;
      continue;
    }
    const lo = Number(trimmed.slice(0, dash));
    const hi = Number(trimmed.slice(dash + 1));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue;
    total += hi - lo + 1;
  }
  return total;
}

function readLoadavg1(): number {
  // Не os.loadavg(): под WSL и в контейнерах он читает тот же /proc/loadavg, но молча отдаёт нули
  // на платформах без поддержки — а «ноль» здесь означал бы «машина свободна» и открыл бы гейт.
  const raw = readFileSync('/proc/loadavg', 'utf8');
  const first = Number(raw.split(/\s+/)[0]);
  if (!Number.isFinite(first)) throw new Error(`не удалось прочитать /proc/loadavg: ${raw}`);
  return first;
}

function readAllowedCpus(fallback: number): number {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const line = status.split('\n').find((l) => l.startsWith('Cpus_allowed_list:'));
    if (line === undefined) return fallback;
    const parsed = countCpusInList(line.slice('Cpus_allowed_list:'.length));
    return parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function readBenchEnvironment(): BenchEnvironment {
  const cores = cpus().length;
  const defaultMax = Math.max(1, cores / 2);
  return {
    loadavg1: readLoadavg1(),
    cores,
    allowedCpus: readAllowedCpus(cores),
    maxLoadavg: Number(process.env.BENCH_MAX_LOADAVG ?? defaultMax),
    allowUnpinned: process.env.BENCH_ALLOW_UNPINNED === 'true',
  };
}

/**
 * Вызывается станком ДО первого замера. При загрязнении печатает причины в stderr и завершает
 * процесс кодом 3 — до того, как будет напечатано хоть одно число.
 */
export function assertQuietBench(label: string): BenchEnvironment {
  const env = readBenchEnvironment();
  const verdict = evaluateBenchEnvironment(env);
  if (!verdict.ok) {
    console.error(`\n[${label}] ЗАМЕР ОТКЛОНЁН — стенд загрязнён:`);
    for (const reason of verdict.reasons) console.error(`  · ${reason}`);
    console.error(
      '\nЦифра, снятая под нагрузкой, неотличима от чистой в отчёте задним числом, поэтому станок\n' +
        'не печатает её вовсе. Дождитесь тишины (`cat /proc/loadavg`) и повторите.\n',
    );
    process.exit(3);
  }
  console.log(
    `[${label}] стенд: la1=${env.loadavg1.toFixed(2)} (порог ${env.maxLoadavg.toFixed(2)}), ` +
      `ядер ${env.allowedCpus}/${env.cores}${env.allowUnpinned ? ' (без закрепления, разрешено явно)' : ''}`,
  );
  return env;
}

/**
 * Отказ по НЕВОСПРОИЗВОДИМОСТИ минимума.
 *
 * Порога по load average оказалось мало. Замеры волны B показали это в лоб: при la 1.5–2.0 (то
 * есть внутри разрешённого коридора) один и тот же код давал 82.9, 60.4 и 70.0 мкс/бар от прогона
 * к прогону. Пока так, сравнение «до/после» не значит ничего, каким бы ни был load average.
 *
 * Проверять при этом надо НЕ размах max/min. Станки много аллоцируют, GC-паузы ложатся случайно и
 * задирают максимум на любой, даже идеально тихой машине — размах ×3 там норма, а не загрязнение.
 * Именно поэтому отчитываемся минимумом. Значит и проверять надо ровно ту величину, которую
 * печатаем: повторы делятся пополам, и минимумы половин сравниваются между собой. Если оценка
 * воспроизводима, они близки; если по стенду прошлась чужая работа, разъедутся.
 */
export function assertStableSamples(
  label: string,
  samples: readonly number[],
  maxDrift = Number(process.env.BENCH_MAX_MIN_DRIFT ?? 1.15),
): void {
  if (samples.length < 4) return; // на трёх повторах половинки не несут информации
  const half = samples.length >> 1;
  const a = minOf(samples.slice(0, half));
  const b = minOf(samples.slice(half));
  const drift = Math.max(a, b) / Math.min(a, b);
  if (drift > maxDrift) {
    console.error(
      `\n[${label}] ЗАМЕР ОТКЛОНЁН — минимум невоспроизводим: половины дали ${a.toFixed(1)} и ${b.toFixed(1)} ` +
        `(расхождение ×${drift.toFixed(2)} при допуске ×${maxDrift.toFixed(2)})\n` +
        `  повторы: ${samples.map((x) => x.toFixed(0)).join(', ')}\n\n` +
        'Невоспроизводимый минимум означает, что по стенду прошлась чужая работа: печатать такое\n' +
        'число нельзя — оно неотличимо от чистого в отчёте задним числом. Дождитесь тишины.\n',
    );
    process.exit(4);
  }
}

/**
 * Минимум из k повторов, а не среднее. Сценарии много аллоцируют, GC-паузы ложатся случайно и
 * раздувают среднее; минимум — самая чистая оценка стоимости самой работы.
 */
export function minOf(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('minOf: нет ни одного замера');
  let best = samples[0]!;
  for (const s of samples) if (s < best) best = s;
  return best;
}
