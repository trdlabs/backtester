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
// ═══ ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ ═══
//
// Полных payload'ов команд. Принятая команда оставляет след в `ActorOrderRecord` и в журнале
// бухгалтерии; дублировать её здесь значило бы завести второй источник истины о том, что было
// заявлено. Записывается то, чего больше нет НИГДЕ: вид команды, её идентичность и исход —
// применена, отвергнута с причиной, пропущена как суффикс после отказа (§3.8: prefix committed /
// suffix skipped / no rollback).

import { assertContiguous } from '@trdlabs/engine';
import type { TimestampUs } from '@trdlabs/sdk/research-contract';

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

/** Команда в потоке: вид, идентичность и исход. Payload не дублируется — см. шапку. */
export interface ActorTimelineCommand {
  readonly kind: string;
  /** `clientOrderId`, идентификатор таймера — то, по чему команду можно связать со следствием. */
  readonly ref?: string;
  readonly outcome: ActorCommandOutcome;
}

/** Входное событие: вид и идентичность там, где она есть. */
export interface ActorTimelineEvent {
  readonly kind: string;
  readonly ref?: string;
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
  readonly event: ActorTimelineEvent;
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
  readonly event: string;
  readonly eventRef?: string;
  readonly causedBySeq?: number;
  readonly commands: readonly {
    readonly kind: string;
    readonly ref?: string;
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

    for (const c of entry.commands) {
      if (c.outcome.status !== 'applied' && c.outcome.reason.trim() === '') {
        fail(`seq ${entry.seq}: команда ${c.kind} со статусом ${c.outcome.status} без причины`);
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
    // Односторонне: зафиксировать МОЖНО меньше, чем доставлено (суффикс батча пропускается без
    // отката, §3.8), но не больше. Frontier, объявивший зафиксированным seq, которого поток не
    // видел, — расхождение двух половин записи.
    const maxSeq = maxSeqPerFrontier.get(f.index)!;
    if (f.lastCommittedSeq > maxSeq) {
      fail(
        `frontier ${f.index}: lastCommittedSeq ${f.lastCommittedSeq} больше максимального seq ` +
          `потока в этом frontier’е (${maxSeq}) — зафиксировано то, что не доставлялось`,
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
      event: entry.event.kind,
      ...(entry.event.ref !== undefined ? { eventRef: entry.event.ref } : {}),
      ...(entry.causedBySeq !== undefined ? { causedBySeq: entry.causedBySeq } : {}),
      commands: entry.commands.map((c) => ({
        kind: c.kind,
        ...(c.ref !== undefined ? { ref: c.ref } : {}),
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
