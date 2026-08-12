// ГЕЙТ: actor timeline — append-only поток диспетчеризации.
//
// Что здесь доказывается и чего здесь НЕ доказывается.
//
// Доказывается: поток связен (непрерывный `seq`, причинность указывает назад, привязка к оси),
// проецируется в артефактную форму без потерь, сериализуется стабильно, и успешный прогон без него
// невозможен.
//
// НЕ доказывается: что поток «правильный по содержанию». Это невозможно проверить снаружи — кто
// пишет поток, тот и решает, какое событие произошло. Проверяемо другое: что запись
// САМОСОГЛАСОВАННА и что её нельзя не написать. Второе важнее: отвергнутая команда не оставляет
// следа больше нигде — ни заявки, ни филла, ни сделки, — и «прогон прошёл, журнала нет»
// неотличимо от «ничего не отвергалось».

import { describe, expect, it } from 'vitest';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';

import {
  ActorTimelineError,
  assertActorTimeline,
  projectActorTimeline,
  serializeActorTimeline,
} from '../src/engine/actor/timeline.js';
import type {
  ActorTimeline,
  ActorTimelineEntry,
  TimelineAxis,
} from '../src/engine/actor/timeline.js';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

const axisOf = (n: number, lastCommitted: readonly number[] = []): TimelineAxis[] =>
  Array.from({ length: n }, (_, i) => ({
    index: i,
    tsUs: timestampUsFromMillis(T0 + i * MINUTE),
    lastCommittedSeq: lastCommitted[i] ?? -1,
  }));

const AXIS = axisOf(2);

const entry = (
  seq: number,
  frontier: number,
  event: string,
  extra: Partial<ActorTimelineEntry> = {},
): ActorTimelineEntry => ({
  seq,
  frontier,
  tsUs: AXIS[frontier]!.tsUs,
  event: { kind: event },
  commands: [],
  ...extra,
});

/**
 * Поток одного минимального прогона: свеча → команда принята → её филл → свеча.
 *
 * Филл несёт `causedBySeq`: он вырос из заявки, поданной на seq 0. Ссылка НАЗАД — в append-only
 * потоке будущих `seq` в момент записи не существует.
 */
const STREAM: ActorTimeline = [
  entry(0, 0, 'candle', {
    commands: [{ kind: 'place', ref: 'o1', outcome: { status: 'applied' } }],
  }),
  entry(1, 0, 'fill', { event: { kind: 'fill', ref: 'o1' }, causedBySeq: 0 }),
  entry(2, 1, 'candle'),
];

describe('форма и проекция', () => {
  it('проецируется в барные индексы и миллисекунды, поле в поле', () => {
    expect(projectActorTimeline(STREAM, AXIS)).toEqual([
      {
        seq: 0,
        barIndex: 0,
        ts: T0,
        event: 'candle',
        commands: [{ kind: 'place', ref: 'o1', status: 'applied' }],
      },
      { seq: 1, barIndex: 0, ts: T0, event: 'fill', eventRef: 'o1', causedBySeq: 0, commands: [] },
      { seq: 2, barIndex: 1, ts: T0 + MINUTE, event: 'candle', commands: [] },
    ]);
  });

  it('необязательные ключи отсутствуют, а не равны undefined', () => {
    const [row] = projectActorTimeline(STREAM, AXIS);
    expect('eventRef' in row!).toBe(false);
    expect('causedBySeq' in row!).toBe(false);
    // У принятой команды причины нет — и ключа тоже.
    expect('reason' in row!.commands[0]!).toBe(false);
  });

  it('причина отказа доезжает, и это единственный её носитель', () => {
    // У отвергнутой команды нет ни заявки, ни филла, ни сделки. Если её не записал поток — её не
    // записал никто.
    const rejected: ActorTimeline = [
      entry(0, 0, 'candle', {
        commands: [
          { kind: 'place', ref: 'o1', outcome: { status: 'rejected', reason: 'exposure limit' } },
          { kind: 'place', ref: 'o2', outcome: { status: 'skipped', reason: 'suffix after reject' } },
        ],
      }),
      entry(1, 1, 'candle'),
    ];
    expect(projectActorTimeline(rejected, AXIS)[0]!.commands).toEqual([
      { kind: 'place', ref: 'o1', status: 'rejected', reason: 'exposure limit' },
      { kind: 'place', ref: 'o2', status: 'skipped', reason: 'suffix after reject' },
    ]);
  });

  it('«отвергнута» и «пропущена» — разные статусы, а не синонимы', () => {
    // Отвергнута команда, которую разобрали и не приняли; пропущена — та, до которой не дошли
    // (§3.8: prefix committed / suffix skipped). Слить их значило бы потерять различие «эта команда
    // плохая» и «эта команда не рассматривалась».
    const statuses = projectActorTimeline(
      [
        entry(0, 0, 'candle', {
          commands: [
            { kind: 'place', outcome: { status: 'rejected', reason: 'r' } },
            { kind: 'place', outcome: { status: 'skipped', reason: 's' } },
          ],
        }),
        entry(1, 1, 'candle'),
      ],
      AXIS,
    )[0]!.commands.map((c) => c.status);
    expect(new Set(statuses).size).toBe(2);
  });
});

describe('сериализация стабильна', () => {
  it('одинаковый вход → побайтово одинаковый выход', () => {
    expect(serializeActorTimeline(projectActorTimeline(STREAM, AXIS))).toBe(
      serializeActorTimeline(projectActorTimeline(STREAM, AXIS)),
    );
  });

  it('порядок записи сохраняется — сериализатор упорядочивает КЛЮЧИ, а не элементы', () => {
    // Проверка проверки к предыдущему: без неё «стабильно» зеленело бы и у сериализатора,
    // сортирующего поток по seq и потому теряющего порядок доставки, если он вдруг иной.
    const parsed = JSON.parse(serializeActorTimeline(projectActorTimeline(STREAM, AXIS))) as {
      seq: number;
    }[];
    expect(parsed.map((r) => r.seq)).toEqual([0, 1, 2]);
  });
});

describe('gap/duplicate guard непрерывности seq', () => {
  const rejects = (timeline: ActorTimeline, axis: readonly TimelineAxis[], match: RegExp): void => {
    expect(() => assertActorTimeline(timeline, axis)).toThrow(ActorTimelineError);
    expect(() => assertActorTimeline(timeline, axis)).toThrow(match);
  };

  it('разрыв — потерянное событие', () => {
    // Сообщение обязано различать разрыв и повтор: это разные поломки причинности, и чинят их
    // по-разному. Гард движковый — своя копия неизбежно разошлась бы с ним в том, что считать чем.
    rejects([entry(0, 0, 'candle'), entry(2, 1, 'candle')], AXIS, /разрыв seq/);
  });

  it('повтор — событие доставлено дважды', () => {
    rejects(
      [entry(0, 0, 'candle'), entry(0, 0, 'candle'), entry(1, 1, 'candle')],
      AXIS,
      /повтор seq/,
    );
  });

  it('убывающий seq тоже читается как повтор', () => {
    rejects([entry(1, 0, 'candle'), entry(0, 1, 'candle')], AXIS, /повтор seq/);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: непрерывный поток проходит', () => {
    expect(() => assertActorTimeline(STREAM, AXIS)).not.toThrow();
  });

  it('поток может начинаться не с нуля — восстановление из чекпойнта', () => {
    // Непрерывность не означает «с нуля»: после восстановления `seq` продолжается. Требовать нуля
    // значило бы запретить возобновление.
    expect(() =>
      assertActorTimeline([entry(41, 0, 'candle'), entry(42, 1, 'candle')], AXIS),
    ).not.toThrow();
  });

  it('отрицательный первый seq отвергается', () => {
    rejects([entry(-1, 0, 'candle'), entry(0, 1, 'candle')], AXIS, /неотрицательным/);
  });
});

describe('успешный прогон без потока невозможен', () => {
  it('пустой поток при непустой оси — отказ', () => {
    expect(() => assertActorTimeline([], AXIS)).toThrow(/успешный actor-прогон без timeline/);
  });

  it('frontier без единой записи — отказ', () => {
    // Frontier открылся потому, что событие пришло. Пропуск означает, что журналирование
    // оборвалось посреди прогона, — и это неотличимо от «в этот момент ничего не происходило».
    expect(() => assertActorTimeline([entry(0, 0, 'candle')], AXIS)).toThrow(
      /frontier 1 не представлен/,
    );
  });

  it('пустая ось с пустым потоком — не отказ', () => {
    expect(() => assertActorTimeline([], [])).not.toThrow();
  });
});

describe('привязка к оси и причинность', () => {
  const rejects = (timeline: ActorTimeline, axis: readonly TimelineAxis[], match: RegExp): void => {
    expect(() => assertActorTimeline(timeline, axis)).toThrow(match);
  };

  it('ссылка на несуществующий frontier', () => {
    rejects([entry(0, 0, 'candle'), { ...entry(1, 0, 'candle'), frontier: 7 }], AXIS, /которого нет/);
  });

  it('метка не равна business-времени своего frontier’а', () => {
    rejects(
      [entry(0, 0, 'candle'), { ...entry(1, 1, 'candle'), tsUs: AXIS[0]!.tsUs }],
      AXIS,
      /не равна business-времени/,
    );
  });

  it('поток идёт назад по frontier’ам', () => {
    rejects(
      [entry(0, 0, 'candle'), entry(1, 1, 'candle'), entry(2, 0, 'candle')],
      AXIS,
      /поток идёт назад/,
    );
  });

  it('причинность ВПЕРЁД отвергается — append-only так не умеет', () => {
    // В момент записи будущих `seq` не существует. Ссылка вперёд означает, что поток собран задним
    // числом, то есть перестал быть тем, ради чего заведён.
    rejects(
      [entry(0, 0, 'candle', { causedBySeq: 1 }), entry(1, 1, 'candle')],
      AXIS,
      /причина всегда записана РАНЬШЕ/,
    );
  });

  it('ссылка на себя отвергается', () => {
    rejects(
      [entry(0, 0, 'candle', { causedBySeq: 0 }), entry(1, 1, 'candle')],
      AXIS,
      /причина всегда записана РАНЬШЕ/,
    );
  });

  it('ссылка на seq вне потока отвергается', () => {
    rejects(
      [entry(5, 0, 'candle'), entry(6, 1, 'candle', { causedBySeq: 3 })],
      AXIS,
      /не встречается в потоке/,
    );
  });

  it('отказ без причины отвергается', () => {
    rejects(
      [
        entry(0, 0, 'candle', {
          commands: [{ kind: 'place', outcome: { status: 'rejected', reason: '  ' } }],
        }),
        entry(1, 1, 'candle'),
      ],
      AXIS,
      /без причины/,
    );
  });

  it('lastCommittedSeq больше доставленного — отказ', () => {
    // Односторонне: зафиксировать можно МЕНЬШЕ, чем доставлено (суффикс батча пропускается без
    // отката), но не больше. Обратное означает, что две половины записи рассказывают разное.
    rejects(STREAM, axisOf(2, [1, 9]), /зафиксировано то, что не доставлялось/);
  });

  it('lastCommittedSeq МЕНЬШЕ доставленного — законно', () => {
    // Проверка проверки: правило одностороннее, и двустороннее запретило бы штатный пропуск
    // суффикса после отказа.
    expect(() => assertActorTimeline(STREAM, axisOf(2, [0, 2]))).not.toThrow();
  });
});
