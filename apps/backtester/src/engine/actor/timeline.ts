// 083 S3 — ACTOR TIMELINE: append-only поток диспетчеризации актора.
//
// ═══ ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ ═══
//
// Не вторым canonical trace и не реконструкцией из итоговых артефактов. Разница не в объёме, а в
// направлении: артефакты отвечают «чем всё кончилось», timeline — «что происходило и в каком
// порядке». Восстановить второе из первого нельзя в принципе, и попытка выдаёт себя сразу: у
// отвергнутой команды нет никакого следа в артефактах — ни заявки, ни филла, ни сделки. Именно она
// и есть то, ради чего timeline существует.
//
// Отсюда правило записи: пишется В МОМЕНТ обработки события, append-only, из настоящего потока
// scheduler → dispatch. Собранный после прогона «по результатам» timeline был бы пересказом
// артефактов и врал бы ровно там, где нужен.
//
// ═══ ПРИЧИННОСТЬ УКАЗЫВАЕТ НАЗАД, И ЭТО СЛЕДСТВИЕ APPEND-ONLY ═══
//
// Событие порождает другие: заявка → филл, отмена → `cancel.rejected`, таймер → срабатывание. Хочется
// записать «это событие породило вот те», но в append-only потоке будущих `seq` ещё не существует —
// запись пришлось бы дописывать задним числом, то есть перестать быть append-only.
//
// Поэтому связь выражена обратной ссылкой `causedBySeq`: каждая запись называет ту, из которой
// выросла. Множество «что породило это» восстанавливается обходом, а форма остаётся неизменяемой.
// У внешних событий (свеча, рыночные данные) ссылки нет — их не породил никто внутри актора.
//
// ═══ КОМАНДА ЗАПИСЫВАЕТСЯ ЦЕЛИКОМ И ПРИ ЛЮБОМ ИСХОДЕ ═══
//
// Первая редакция писала только вид команды и её идентификатор — «полный payload есть в
// `ActorOrderRecord`, дублировать не надо». Рассуждение неверно, и неверно дважды.
//
// Во-первых, восстановить нечего у целых классов команд: `timer.set`, `timer.cancel`, `annotate` и
// отмена не оставляют следа ни в заявках, ни в журнале бухгалтерии — их материального эффекта там
// просто нет. Во-вторых, отвергнутая и пропущенная команды не оставляют следа НИГДЕ по построению.
//
// И главное: timeline и материальные эффекты — не конкурирующие SSOT. Поток отвечает, что было
// СКОМАНДОВАНО; артефакты — что из этого МАТЕРИАЛИЗОВАЛОСЬ. Это разные факты, и совпадение между
// ними есть утверждение, а не тавтология; именно поэтому его можно проверять.
//
// Отсюда: `ActorCommand` контракта целиком, при любом исходе. Таксономия закрыта типом SDK, а не
// строкой — новый вид команды или события красит СБОРКУ вместо того, чтобы завестись опечаткой.

import { assertContiguous } from '@trdlabs/engine';
import type {
  ActorCommand,
  ActorInputEvent,
  ActorInputEventKind,
  SubscriptionId,
  TimestampUs,
} from '@trdlabs/sdk/research-contract';

import { canonicalJson } from '../../determinism/canonical-json.js';

/**
 * Исход применения одной команды.
 *
 * `skipped` — не синоним `rejected`. Отвергнута команда, которую разобрали и не приняли; пропущена
 * та, до которой не дошли, потому что раньше в батче случился отказ. Слить их значило бы потерять
 * различие «эта команда плохая» и «эта команда не рассматривалась».
 */
export type ActorCommandOutcome =
  | { readonly status: 'applied' }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'skipped'; readonly reason: string };

/** Команда в потоке: КОНТРАКТНАЯ команда целиком плюс исход её применения. */
export interface ActorTimelineCommand {
  readonly command: ActorCommand;
  readonly outcome: ActorCommandOutcome;
}

/**
 * Класс доставки события — определяет, какая идентичность обязана быть записана.
 *
 * Таблицей по ЗАМКНУТОМУ каталогу контракта: новый вид события красит сборку, а не заводится с
 * произвольным правилом. Три класса, а не два, потому что `market.subscription.status_changed`
 * относится к подписке, но НЕ к строке ленты — у смены статуса строки нет.
 */
const DELIVERY_CLASS: Readonly<Record<ActorInputEventKind, 'tape' | 'subscription' | 'internal'>> = {
  'market.candle.closed': 'tape',
  'market.open_interest.observed': 'tape',
  'market.liquidations.bucket_closed': 'tape',
  'market.taker_volume.bucket_closed': 'tape',
  'market.funding.observed': 'tape',
  'market.subscription.status_changed': 'subscription',
  'order.accepted': 'internal',
  'order.denied': 'internal',
  'order.rejected': 'internal',
  'order.canceled': 'internal',
  'cancel.rejected': 'internal',
  'order.expired': 'internal',
  fill: 'internal',
  'timer.fired': 'internal',
  'trading_state.changed': 'internal',
};

/**
 * Точная идентичность доставки рыночного события.
 *
 * `subscriptionId` — ссылка на элемент `ActorInit.subscriptions`, а не свободная строка (контракт,
 * doc у `ActorEnvelope`). `row` — строка ленты, названная СИМВОЛОМ И МЕТКОЙ, а не индексом: индекс
 * съезжает при любой правке ленты и указывает потом на чужие данные молча.
 */
export interface ActorMarketDelivery {
  readonly subscriptionId: SubscriptionId;
  readonly row?: { readonly symbol: string; readonly tsUs: TimestampUs };
}

/**
 * Одна запись потока — один доставленный актору `seq`.
 *
 * `seq` actor-local и НЕПРЕРЫВЕН (§3.5). Именно здесь это утверждение впервые становится
 * проверяемым: ось frontier'ов видит только конечные точки, а разрыв внутри frontier'а её не
 * двигает. Поток видит каждое событие поимённо, и потому гард живёт тут.
 */
export interface ActorTimelineEntry {
  readonly seq: number;
  readonly frontier: number;
  /** Business-время `U` своего frontier'а. */
  readonly tsUs: TimestampUs;
  /**
   * КОНТРАКТНОЕ СОБЫТИЕ ЦЕЛИКОМ.
   *
   * Первая редакция писала вид и ссылку, рассуждая «рыночный payload уже в ленте». Рассуждение
   * верно ровно для рыночных данных и ложно для всего остального: `reason` у `order.denied`,
   * `dueTsUs` у `timer.fired`, `previous`/`state` у `trading_state.changed`, статус подписки и сами
   * числа филла В ЛЕНТЕ НЕ ЛЕЖАТ. Для них поток — единственный носитель, и вид без payload'а
   * означал бы, что событие записано, а что в нём было — нет.
   */
  readonly event: ActorInputEvent;
  /** Идентичность доставки. Обязательна для рыночных видов, запрещена для внутренних. */
  readonly delivery?: ActorMarketDelivery;
  readonly commands: readonly ActorTimelineCommand[];
  /** `seq` записи, из которой это событие выросло. Отсутствует у внешних. */
  readonly causedBySeq?: number;
}

/** Поток целиком, в порядке доставки. Порядок нормативен: он и есть причинный порядок. */
export type ActorTimeline = readonly ActorTimelineEntry[];

/** Строка артефакта: те же факты в барных индексах и миллисекундах. */
export interface ActorTimelineRow {
  readonly seq: number;
  readonly barIndex: number;
  readonly ts: number;
  readonly event: ActorInputEvent;
  readonly delivery?: ActorMarketDelivery;
  readonly causedBySeq?: number;
  readonly commands: readonly {
    readonly command: ActorCommand;
    readonly status: ActorCommandOutcome['status'];
    readonly reason?: string;
  }[];
}

export type ActorTimelineArtifact = readonly ActorTimelineRow[];

/** Ось, к которой поток обязан быть привязан. Приходит из `ActorExecutionRecord`. */
export interface TimelineAxis {
  readonly index: number;
  readonly tsUs: TimestampUs;
  readonly lastCommittedSeq: number;
}

/**
 * Отказ проверки потока. Отдельный класс от `ActorProjectionError`: это заявление о ПОТОКЕ, а не об
 * артефактах, и чинит его тот, кто пишет диспетчеризацию.
 */
export class ActorTimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActorTimelineError';
  }
}

const US_PER_MS = 1000;

function fail(message: string): never {
  throw new ActorTimelineError(message);
}

/**
 * Проверить поток целиком.
 *
 * Пустой поток при непустой оси — ОТКАЗ, а не «нечего проверять». Frontier существует потому, что в
 * этот момент что-то наблюдалось; прогон с frontier'ами и без единой записи означает, что
 * диспетчеризацию не журналировали, и успешный прогон в таком виде принимать нельзя — след
 * исчезает ровно у того, что не оставляет следов больше нигде.
 */
export function assertActorTimeline(timeline: ActorTimeline, axis: readonly TimelineAxis[]): void {
  if (axis.length === 0) {
    if (timeline.length > 0) fail('поток непуст при пустой оси frontier’ов');
    return;
  }
  if (timeline.length === 0) {
    fail(
      `поток пуст при ${axis.length} frontier’ах — успешный actor-прогон без timeline недопустим: ` +
        'отвергнутые команды не оставляют следа больше нигде',
    );
  }

  const first = timeline[0]!.seq;
  if (!Number.isSafeInteger(first) || first < 0) {
    fail(`первый seq потока ${first} — обязан быть неотрицательным safe-целым`);
  }

  // Непрерывность — движковым гардом, а не своей копией: он разводит разрыв и повтор по СМЫСЛУ
  // («потеряно событие» против «доставлено дважды»), и вторая реализация неизбежно разошлась бы
  // с ним в том, что именно считать нарушением.
  try {
    assertContiguous(
      timeline.map((e) => e.seq),
      first,
    );
  } catch (cause) {
    fail(`непрерывность seq нарушена: ${(cause as Error).message}`);
  }

  const seqs = new Set(timeline.map((e) => e.seq));
  const maxSeqPerFrontier = new Map<number, number>();
  let prevFrontier = -1;

  for (let i = 0; i < timeline.length; i += 1) {
    const entry = timeline[i]!;
    const f = axis[entry.frontier];
    if (f === undefined || f.index !== entry.frontier) {
      fail(`seq ${entry.seq}: ссылка на frontier ${entry.frontier}, которого нет (всего ${axis.length})`);
    }
    if (Number(entry.tsUs) !== Number(f.tsUs)) {
      fail(
        `seq ${entry.seq}: метка ${Number(entry.tsUs)} не равна business-времени своего frontier’а ${Number(f.tsUs)}`,
      );
    }
    // Поток идёт вперёд по business-времени: запись, вернувшаяся в прошлый frontier, означает, что
    // журналирование шло не в порядке диспетчеризации, и причинный порядок больше не читается.
    if (entry.frontier < prevFrontier) {
      fail(`seq ${entry.seq}: frontier ${entry.frontier} после ${prevFrontier} — поток идёт назад`);
    }
    prevFrontier = entry.frontier;
    maxSeqPerFrontier.set(entry.frontier, entry.seq);

    if (entry.causedBySeq !== undefined) {
      // Причинность в append-only потоке указывает НАЗАД — вперёд её записать нечем: будущих `seq`
      // в момент записи не существует. Ссылка вперёд либо на себя означает, что поток собран
      // задним числом, то есть перестал быть тем, ради чего заведён.
      if (entry.causedBySeq >= entry.seq) {
        fail(
          `seq ${entry.seq}: causedBySeq ${entry.causedBySeq} не меньше собственного seq — ` +
            'в append-only потоке причина всегда записана РАНЬШЕ следствия',
        );
      }
      if (!seqs.has(entry.causedBySeq)) {
        fail(`seq ${entry.seq}: causedBySeq ${entry.causedBySeq} не встречается в потоке`);
      }
    }

    // Идентичность доставки обязана соответствовать классу события. Рыночное без неё нельзя
    // связать ни с подпиской, ни со строкой ленты; внутреннее с ней утверждало бы подписку,
    // которой у него нет.
    const cls = DELIVERY_CLASS[entry.event.kind];
    if (cls === 'internal' && entry.delivery !== undefined) {
      fail(`seq ${entry.seq}: у внутреннего события ${entry.event.kind} записана доставка подписки`);
    }
    if (cls !== 'internal' && entry.delivery === undefined) {
      fail(`seq ${entry.seq}: у события ${entry.event.kind} нет идентичности доставки`);
    }
    if (cls === 'tape' && entry.delivery?.row === undefined) {
      fail(`seq ${entry.seq}: у рыночного события ${entry.event.kind} не записана строка ленты`);
    }
    if (cls === 'subscription' && entry.delivery?.row !== undefined) {
      fail(
        `seq ${entry.seq}: у смены статуса подписки записана строка ленты — у неё строки нет`,
      );
    }

    for (const c of entry.commands) {
      if (c.outcome.status !== 'applied' && c.outcome.reason.trim() === '') {
        fail(`seq ${entry.seq}: команда ${c.command.kind} со статусом ${c.outcome.status} без причины`);
      }
    }
  }

  // Каждый frontier обязан быть представлен: он и открылся-то потому, что событие пришло. Пропуск
  // означает, что журналирование оборвалось посреди прогона, — а это неотличимо от «в этот момент
  // ничего не происходило», если не проверять.
  for (const f of axis) {
    if (!maxSeqPerFrontier.has(f.index)) {
      fail(`frontier ${f.index} не представлен в потоке ни одной записью`);
    }
    // РАВЕНСТВО, а не «не больше». Первая редакция допускала отставание, ссылаясь на пропуск
    // суффикса батча (§3.8) — и это была подмена уровней. Пропуск относится к КОМАНДАМ внутри
    // события и уже выражен в `commands[].outcome`; само событие при этом доставлено и
    // зафиксировано. `seq` считает события, а не команды, поэтому отставание watermark'а означает
    // ровно одно: frontier закрылся, не зафиксировав того, что ему доставили.
    //
    // Проекция работает только с УСПЕШНО завершёнными прогонами (у прерванного артефактов нет), а
    // значит и все frontier'ы здесь завершены — послаблению неоткуда взяться.
    const maxSeq = maxSeqPerFrontier.get(f.index)!;
    if (f.lastCommittedSeq !== maxSeq) {
      fail(
        `frontier ${f.index}: lastCommittedSeq ${f.lastCommittedSeq} не равен максимальному ` +
          `доставленному seq (${maxSeq}) — завершённый frontier обязан зафиксировать всё, что ему ` +
          'доставлено; пропуск суффикса относится к командам события, а не к самому событию',
      );
    }
  }
}

/**
 * Спроецировать поток в артефактную форму: барные индексы и миллисекунды.
 *
 * Ничего не сортирует и не сворачивает — порядок записи и есть причинный порядок. Проверка потока
 * вызывается здесь же: спроецировать непроверенный поток значит выдать наружу форму, про которую
 * никто не утверждал, что она связна.
 */
export function projectActorTimeline(
  timeline: ActorTimeline,
  axis: readonly TimelineAxis[],
): ActorTimelineArtifact {
  assertActorTimeline(timeline, axis);
  return timeline.map((entry) => {
    const tsUs = Number(entry.tsUs);
    if (tsUs % US_PER_MS !== 0) {
      fail(`seq ${entry.seq}: метка ${tsUs} мкс не кратна миллисекунде — перевод был бы с потерей`);
    }
    return {
      seq: entry.seq,
      barIndex: entry.frontier,
      ts: tsUs / US_PER_MS,
      event: entry.event,
      ...(entry.delivery !== undefined ? { delivery: entry.delivery } : {}),
      ...(entry.causedBySeq !== undefined ? { causedBySeq: entry.causedBySeq } : {}),
      commands: entry.commands.map((c) => ({
        command: c.command,
        status: c.outcome.status,
        ...(c.outcome.status !== 'applied' ? { reason: c.outcome.reason } : {}),
      })),
    };
  });
}

/**
 * Сериализовать поток канонически.
 *
 * Тем же сериализатором, что и остальные артефакты прогона: у потока нет причин иметь СВОЮ форму
 * байтов — иначе он не сравнивается с самим собой между прогонами теми же средствами, что всё
 * прочее, и «стабильный порядок» пришлось бы доказывать отдельно.
 *
 * Сортировки нет: порядок записи и есть причинный порядок, а `canonicalJson` упорядочивает КЛЮЧИ,
 * не элементы массива.
 */
export function serializeActorTimeline(artifact: ActorTimelineArtifact): string {
  return canonicalJson(artifact);
}
