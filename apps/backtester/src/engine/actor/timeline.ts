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
// ═══ КОНВЕРТ КОНТРАКТА, А НЕ СВОЯ ФОРМА ═══
//
// Запись хранит `ActorEnvelope<ActorInputEvent>` целиком. Соблазн разобрать его на удобные поля и
// добавить «свою» идентичность строки ленты был, и он неверен: локальная параллельная форма чужого
// типа расходится с ним при первой же правке контракта, причём молча — структурная совместимость
// лишнего и недостающего не замечает одинаково.
//
// Отдельной `row` (символ + метка) больше нет, и она была ИЗБЫТОЧНОЙ, а не полезной: символ задаёт
// подписка (`subscriptionId` — ссылка на элемент `ActorInit.subscriptions`), а метку и ревизию
// строки несёт сам `ObservedValue` события (`effectiveTsUs`, `revision`). То есть обе половины
// «идентичности строки» уже записаны, а третья копия рядом — это ровно возможность разойтись с
// каждой из них.
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
  ActorEnvelope,
  ActorInputEvent,
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
 * Одна запись потока — один доставленный актору `seq`.
 *
 * `seq` actor-local и НЕПРЕРЫВЕН (§3.5). Именно здесь это утверждение впервые становится
 * проверяемым: ось frontier'ов видит только конечные точки, а разрыв внутри frontier'а её не
 * двигает. Поток видит каждое событие поимённо, и потому гард живёт тут.
 */
export interface ActorTimelineEntry {
  /**
   * КОНТРАКТНЫЙ КОНВЕРТ ЦЕЛИКОМ: `seq`, `eventTsUs`, `subscriptionId`, событие.
   *
   * Не разобранный на поля и не сокращённый. Прежняя редакция хранила `seq`, свою метку `tsUs`,
   * событие и СВОЙ тип идентичности доставки — то есть локальную параллельную форму конверта, в
   * которой `subscriptionId` был условным. Условным его сделал я, а не контракт: `ActorEnvelope<E>`
   * требует его для ЛЮБОГО `E`. Локальное исключение для внутренних событий — это своя семантика
   * поверх чужого типа, и расходиться с ним она начала бы при первой же правке контракта.
   *
   * Собственной метки времени здесь тоже больше нет: `eventTsUs` конверта И ЕСТЬ frontier диспатча
   * `U` (doc контракта у `ActorEnvelope`), и вторая метка рядом была её копией с возможностью
   * разойтись.
   */
  readonly envelope: ActorEnvelope<ActorInputEvent>;
  readonly frontier: number;
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
  readonly subscriptionId: string;
  readonly event: ActorInputEvent;
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

  const first = timeline[0]!.envelope.seq;
  if (!Number.isSafeInteger(first) || first < 0) {
    fail(`первый seq потока ${first} — обязан быть неотрицательным safe-целым`);
  }

  // Непрерывность — движковым гардом, а не своей копией: он разводит разрыв и повтор по СМЫСЛУ
  // («потеряно событие» против «доставлено дважды»), и вторая реализация неизбежно разошлась бы
  // с ним в том, что именно считать нарушением.
  try {
    assertContiguous(
      timeline.map((e) => e.envelope.seq),
      first,
    );
  } catch (cause) {
    fail(`непрерывность seq нарушена: ${(cause as Error).message}`);
  }

  const seqs = new Set(timeline.map((e) => e.envelope.seq));
  const maxSeqPerFrontier = new Map<number, number>();
  let prevFrontier = -1;

  for (let i = 0; i < timeline.length; i += 1) {
    const entry = timeline[i]!;
    const { seq, eventTsUs, event } = entry.envelope;
    const f = axis[entry.frontier];
    if (f === undefined || f.index !== entry.frontier) {
      fail(`seq ${seq}: ссылка на frontier ${entry.frontier}, которого нет (всего ${axis.length})`);
    }
    // `eventTsUs` конверта — это frontier диспатча `U` (контракт). Расхождение с осью означает,
    // что событие приписано не своему моменту.
    if (Number(eventTsUs) !== Number(f.tsUs)) {
      fail(
        `seq ${seq}: eventTsUs ${Number(eventTsUs)} не равен business-времени своего frontier’а ${Number(f.tsUs)}`,
      );
    }
    // Поток идёт вперёд по business-времени: запись, вернувшаяся в прошлый frontier, означает, что
    // журналирование шло не в порядке диспетчеризации, и причинный порядок больше не читается.
    if (entry.frontier < prevFrontier) {
      fail(`seq ${seq}: frontier ${entry.frontier} после ${prevFrontier} — поток идёт назад`);
    }
    prevFrontier = entry.frontier;
    maxSeqPerFrontier.set(entry.frontier, seq);

    if (entry.causedBySeq !== undefined) {
      // Причинность в append-only потоке указывает НАЗАД — вперёд её записать нечем: будущих `seq`
      // в момент записи не существует. Ссылка вперёд либо на себя означает, что поток собран
      // задним числом, то есть перестал быть тем, ради чего заведён.
      if (entry.causedBySeq >= seq) {
        fail(
          `seq ${seq}: causedBySeq ${entry.causedBySeq} не меньше собственного seq — ` +
            'в append-only потоке причина всегда записана РАНЬШЕ следствия',
        );
      }
      if (!seqs.has(entry.causedBySeq)) {
        fail(`seq ${seq}: causedBySeq ${entry.causedBySeq} не встречается в потоке`);
      }
    }

    for (const c of entry.commands) {
      if (c.outcome.status !== 'applied' && c.outcome.reason.trim() === '') {
        fail(`seq ${seq}: команда ${c.command.kind} со статусом ${c.outcome.status} без причины`);
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
    const tsUs = Number(entry.envelope.eventTsUs);
    if (tsUs % US_PER_MS !== 0) {
      fail(
        `seq ${entry.envelope.seq}: метка ${tsUs} мкс не кратна миллисекунде — перевод был бы с потерей`,
      );
    }
    return {
      seq: entry.envelope.seq,
      barIndex: entry.frontier,
      ts: tsUs / US_PER_MS,
      subscriptionId: entry.envelope.subscriptionId,
      event: entry.envelope.event,
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
