// 083 S3 — допуск на actor-путь. Полностью FAIL-CLOSED в этом срезе.
//
// ДВЕ ОСИ, И ОНИ НЕ ОДНА (решение владельца, спека §3.6):
//   • СЕМАНТИКУ выбирает только `manifest.lifecycle`. `event_driven` — объявленная форма стратегии,
//     часть контракта с 017.3/017.4;
//   • `BACKTESTER_EVENT_DRIVEN_ENABLED` (default off) лишь РАЗРЕШАЕТ раскатку.
//
// Слить их в один флаг значило бы получить конфигурацию, при которой одна стратегия имеет разную
// семантику на разных хостах, причём невидимо: манифест не меняется.
//
// ГЛАВНОЕ ПРАВИЛО СРЕЗА: ни один набор условий НЕ проваливается в legacy. `event_driven`, который
// нельзя исполнить здесь, — это отказ, а не «выполним по-старому». Тихо исполнить его по
// single_position-пути значит подменить объявленную семантику молча: прогон завершится, числа
// получатся, и ничто не скажет, что исполнялось не то, что объявлено.

import type { ResolvedStrategy } from '../artifacts.js';
import { supportsActorLifecycle, type ActorLifecycleExecutor } from './execution-handle.js';

/** Причина, по которой actor-путь не открыт. `null` — открыт. */
export interface ActorAdmissionRefusal {
  readonly code: 'unsupported_lifecycle';
  /**
   * Пустой JSON Pointer — НОРМАТИВНАЯ ссылка на запрос целиком (RFC 6901 §5, `@trdlabs/sdk@0.15.0`).
   *
   * Нарушающего узла здесь нет: запрос корректен, манифест безупречен, не совпадает окружение.
   * Указать `/moduleRef` значило бы обвинить валидный узел и отправить автора чинить то, что не
   * сломано.
   */
  readonly path: '';
  readonly message: string;
}

export interface ActorAdmissionInput {
  readonly strategy: ResolvedStrategy;
  /** `BACKTESTER_EVENT_DRIVEN_ENABLED`: разрешение раскатки, НЕ выбор семантики. */
  readonly eventDrivenEnabled: boolean;
  /** `BACKTESTER_BAR_BATCHING`: окно из k МЕТОК ВРЕМЕНИ одного символа. */
  readonly barBatching: boolean;
  /** `BACKTESTER_BAR_MAJOR_BATCH`: k СИМВОЛОВ одной метки, то есть k акторов. */
  readonly barMajorBatch: boolean;
  /** Исполнитель, которым пошёл бы прогон. Способность проверяется ДО создания env и init. */
  readonly executor: Partial<ActorLifecycleExecutor>;
}

/** Объявляет ли манифест event-driven форму. Единственный источник выбора семантики. */
export function isEventDriven(strategy: ResolvedStrategy): boolean {
  return (strategy.manifest as { lifecycle?: unknown }).lifecycle === 'event_driven';
}

const refuse = (message: string): ActorAdmissionRefusal => ({
  code: 'unsupported_lifecycle',
  path: '',
  message,
});

/**
 * Решить, допускается ли прогон на actor-путь.
 *
 * Возвращает `null` ТОЛЬКО для не-event-driven стратегий (их ведёт legacy-путь без изменений).
 * Для `event_driven` в этом срезе всегда возвращается отказ — см. последний пункт.
 *
 * Порядок проверок — от самой конкретной причины к самой общей: оператор должен получить ту,
 * которую может исправить, а не первую попавшуюся.
 */
export function admitActorRun(input: ActorAdmissionInput): ActorAdmissionRefusal | null {
  if (!isEventDriven(input.strategy)) return null; // legacy single_position — не наша забота

  const id = `${input.strategy.manifest.id}@${input.strategy.manifest.version}`;

  if (!input.eventDrivenEnabled) {
    return refuse(
      `манифест ${id} объявляет lifecycle: 'event_driven', но BACKTESTER_EVENT_DRIVEN_ENABLED ` +
        'выключен. Legacy fallback НЕ применяется: исполнить event_driven по single_position-пути ' +
        'значит подменить объявленную семантику молча.',
    );
  }

  if (input.barBatching) {
    return refuse(
      `BACKTESTER_BAR_BATCHING несовместим с lifecycle: 'event_driven' (${id}). Окно из k баров — ` +
        'это k РАЗНЫХ business-моментов, и батч исполняет хук сразу для всех до последовательных ' +
        'эффектов: авторское состояние продвигается на k моментов вне гейта границы. Это обход ' +
        'семантики, а не транспортная оптимизация. Коалесценция законна только для событий ОДНОГО ' +
        'времени.',
    );
  }

  if (input.barMajorBatch) {
    return refuse(
      `BACKTESTER_BAR_MAJOR_BATCH пока несовместим с lifecycle: 'event_driven' (${id}). Он ` +
        'коалесцирует k СИМВОЛОВ одной метки времени, то есть k независимых акторов, а ActorHost ' +
        'имеет scope actor instance. Требуется отдельная multi-host композиция.',
    );
  }

  if (!supportsActorLifecycle(input.executor)) {
    return refuse(
      `исполнитель, выбранный для ${id}, не умеет lifecycle актора (create → execute → dispose). ` +
        'Деградация в onBarClose НЕ применяется: это другая семантика.',
    );
  }

  // ── Отсутствие проекции — ПОСЛЕДНИЙ по конкретности и ПЕРВЫЙ по силе ────────
  //
  // Стоит выше проверки `marketData` НАМЕРЕННО, и порядок здесь не косметика.
  //
  // Контракт 017.4 требует от `event_driven` объявить хотя бы одно требование `marketData`
  // (`validate-module.ts`, код `missing_market_data_requirement`), а модульная валидация в
  // `runBacktest` идёт ДО этого допуска. Значит у КАЖДОГО манифеста, доехавшего сюда,
  // `marketData` непуст — и проверка ниже срабатывала бы всегда, а этот отказ не срабатывал бы
  // никогда. Оператор получал бы «объявлен marketData» и шёл править манифест, которого нечем
  // исполнить в принципе.
  //
  // Пока проекции ledger → артефакты нет, НИЧЕГО не исполняется, поэтому именно это и надо
  // сказать. Отказ снимается в одном месте — здесь, — когда проекция появится; тогда проверка
  // `marketData` ниже станет действующей.
  //
  // Почему не «успешный прогон с пустыми артефактами»: у отказа есть код, причина и адресат, у
  // пустого успеха нет ничего, а обнаружится он у того, кто сравнивает результаты двух lifecycle
  // и видит правдоподобные числа.
  // ТРЕБОВАНИЕ К СЛЕДУЮЩЕМУ СРЕЗУ, записанное здесь потому, что снимать отказ будут отсюда.
  // Вместе с проекцией обязана появиться проверка `manifest.marketData`: первая итерация подаёт
  // актору только свечное событие, и исполнить манифест с объявленными рыночными требованиями
  // значило бы отдать автору не тот вход, который он объявил, — получив правдоподобные числа. Кода
  // для неё здесь СЕЙЧАС нет намеренно: недостижимая ветка выглядит как работающая защита и
  // читается как уже принятое решение.
  return refuse(
    `lifecycle: 'event_driven' (${id}) совместим со всеми условиями хоста, но actor-путь пока не ` +
      'отдаёт результат: проекция ledger → артефакты не подключена. Успешный прогон с пустыми ' +
      'артефактами хуже отказа — у отказа есть причина и адресат.',
  );
}
