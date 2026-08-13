// ГЕЙТЫ ГОРЯЧЕГО ЦИКЛА (083 S3, срез 1).
//
// Три свойства, которые ломаются молча и потому проверяются здесь, а не наблюдаются:
//
//  1. frontier дренируется ДО КОНЦА. Событие, порождённое командой, обязано доехать в том же
//     business-моменте. Уехав на следующий бар, оно не сломает ни один тест на числа — актор просто
//     узнает об отказе своей команды через минуту рыночного времени и переиграет решение не там.
//  2. `readiness` ОДНА на контекст автора и на `validate`. Два источника разошлись бы ровно в
//     интересном случае: автор прочитал `ready`, отправил `place`, хост отклонил как прогревающегося.
//  3. warm-up-запрет — обычный rejection через `applyBatch`. Pre-filter дал бы тишину, и прогрев
//     стал бы неотличим от «автор ничего не отправлял».

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type {
  ActorCommand,
  ActorContext,
  ActorInputEvent,
  MarketDataRequirement,
  TimestampUs,
} from '@trdlabs/sdk/research-contract';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';

import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import { projectActorRun } from '../src/engine/actor/projection.js';
import { serializeActorTimeline } from '../src/engine/actor/timeline.js';
import type { ActorTapeCapabilities } from '../src/engine/actor/admission.js';
import { runEventDrivenSymbol } from '../src/engine/actor/run-symbol.js';
import type { EventDrivenSymbolInput } from '../src/engine/actor/run-symbol.js';
import type { ActorBar } from '../src/engine/actor/frontier-runner.js';
import type {
  ActorExecutionHandle,
  ActorLifecycleExecutor,
} from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = 1_700_000_000_000;

const bars = (n: number): readonly ActorBar[] =>
  Array.from({ length: n }, (_, i) => ({
    tsUs: timestampUsFromMillis(T0 + i * MINUTE_MS),
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
  }));

const requirement = (lookback: number): MarketDataRequirement =>
  ({
    kind: 'candles',
    id: 'req-candles',
    instrument: { venue: 'bybit', symbol: 'BTCUSDT' },
    interval: MINUTE_US,
    lookback,
    revisionPolicy: { mode: 'final_only' },
    priceType: 'trade',
  }) as unknown as MarketDataRequirement;

const strategy = (lookback: number): ResolvedStrategy =>
  ({
    manifest: {
      id: 'frontier-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData: [requirement(lookback)],
    },
    module: {},
  }) as unknown as ResolvedStrategy;

const COSTS = { feeBps: 5, slippageBps: 0, initialEquity: 10_000 };

/** Что актор увидел и что он на это ответил — обе стороны наблюдаемы для проб ниже. */
interface Seen {
  readonly kind: ActorInputEvent['kind'];
  readonly readiness: ActorContext['readiness'];
  readonly tsUs: TimestampUs;
}

function makeRun(opts: {
  lookback: number;
  barCount: number;
  onEvent?: (event: ActorInputEvent, ctx: ActorContext, seen: readonly Seen[]) => readonly ActorCommand[];
  createFails?: boolean;
  bodyThrowsAfterAwait?: boolean;
}) {
  const seen: Seen[] = [];
  const calls = { create: 0, dispose: 0 };
  const handle = { __actorExecutionHandle: 'ActorExecutionHandle' } as unknown as ActorExecutionHandle;

  const executor: ActorLifecycleExecutor = {
    createActor: async () => {
      calls.create += 1;
      if (opts.createFails === true) throw new Error('изолят не поднялся');
      return handle;
    },
    executeActorEvent: async (_h, event, ctx) => {
      // `await` внутри доставки — настоящая форма sandbox-пути: хук живёт за границей изолята.
      await Promise.resolve();
      seen.push({ kind: event.kind, readiness: ctx.readiness, tsUs: ctx.clock.nowUs() });
      if (opts.bodyThrowsAfterAwait === true && event.kind === 'market.candle.closed') {
        throw new Error('стратегия упала после await');
      }
      return opts.onEvent?.(event, ctx, seen) ?? [];
    },
    disposeActor: async () => {
      calls.dispose += 1;
    },
  };

  const tape: ActorTapeCapabilities = {
    candleVenue: proveCandleVenue({ datasetRef: 'frontier-fixture-1m', candleVenue: 'bybit' }),
    symbol: 'BTCUSDT',
    barIntervalUs: MINUTE_US,
    barCount: opts.barCount,
  };
  const admission = admitActorMarketData(strategy(opts.lookback), tape);
  if (admission.refusal !== null) throw new Error(`фикстура не прошла допуск: ${admission.refusal.message}`);

  const input: EventDrivenSymbolInput = {
    executor,
    source: { manifest: strategy(opts.lookback).manifest, module: {} },
    actorId: 'actor-btcusdt-0',
    symbol: 'BTCUSDT',
    seed: 7,
    params: {},
    admission,
    bars: bars(opts.barCount),
    costs: COSTS,
  };
  return { input, seen, calls, run: () => runEventDrivenSymbol(input) };
}

/** Рыночная заявка на первом же полученном событии — минимальный торгующий актор. */
const placeOnce = (): ((e: ActorInputEvent, c: ActorContext, seen: readonly Seen[]) => readonly ActorCommand[]) => {
  let sent = false;
  return (event) => {
    if (event.kind !== 'market.candle.closed' || sent) return [];
    sent = true;
    return [{ kind: 'place', type: 'market', clientOrderId: 'o1', side: 'buy', qtyUsd: 1000 } as ActorCommand];
  };
};

describe('frontier дренируется до пустоты ДО следующего business-момента', () => {
  it('каскадное событие приезжает в ТОМ ЖЕ frontier, что и породившая команда', async () => {
    const { run } = makeRun({ lookback: 0, barCount: 3, onEvent: placeOnce() });
    const record = await run();

    const accepted = record.timeline.find((e) => e.envelope.event.kind === 'order.accepted');
    const candle0 = record.timeline.find((e) => e.envelope.event.kind === 'market.candle.closed');
    expect(accepted).toBeDefined();
    // Тот же frontier, а не следующий: иначе актор узнал бы о приёме заявки через минуту.
    expect(accepted!.frontier).toBe(candle0!.frontier);
    // И причинность записана: каскад помнит, чьим следствием он является.
    expect(accepted!.causedBySeq).toBe(candle0!.envelope.seq);
  });

  it('timeline монотонен по frontier: ни одна запись не «догоняет» предыдущий момент', async () => {
    const { run } = makeRun({ lookback: 0, barCount: 4, onEvent: placeOnce() });
    const record = await run();
    const frontiers = record.timeline.map((e) => e.frontier);
    expect(frontiers).toEqual([...frontiers].sort((a, b) => a - b));
  });

  it('seq непрерывен по всему прогону, а не только внутри одного frontier', async () => {
    const { run } = makeRun({ lookback: 0, barCount: 4, onEvent: placeOnce() });
    const record = await run();
    const seqs = record.timeline.map((e) => e.envelope.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it('lastCommittedSeq каждого frontier равен максимальному доставленному в нём', async () => {
    const { run } = makeRun({ lookback: 0, barCount: 3, onEvent: placeOnce() });
    const record = await run();
    for (const frontier of record.frontiers) {
      const inFrontier = record.timeline.filter((e) => e.frontier === frontier.index);
      expect(inFrontier.length).toBeGreaterThan(0);
      expect(frontier.lastCommittedSeq).toBe(Math.max(...inFrontier.map((e) => e.envelope.seq)));
    }
  });
});

describe('warm-up: события ДОСТАВЛЯЮТСЯ, торговые права — нет', () => {
  it('прогревочные бары доходят до актора', async () => {
    // Не доставлять их значило бы сделать первый торговый бар недетерминированным: его решение
    // зависело бы от того, сколько истории актор случайно успел увидеть.
    const { seen, run } = makeRun({ lookback: 2, barCount: 4 });
    await run();
    const candles = seen.filter((s) => s.kind === 'market.candle.closed');
    expect(candles).toHaveLength(4);
    expect(candles.map((s) => s.readiness)).toEqual(['warming_up', 'warming_up', 'ready', 'ready']);
  });

  it('place до готовности отклоняется — и отказ ВИДЕН в timeline', async () => {
    const { run } = makeRun({ lookback: 2, barCount: 4, onEvent: placeOnce() });
    const record = await run();

    const placeEntry = record.timeline.find((e) => e.commands.some((c) => c.command.kind === 'place'));
    expect(placeEntry).toBeDefined();
    const outcome = placeEntry!.commands.find((c) => c.command.kind === 'place')!.outcome;
    expect(outcome.status).toBe('rejected');
    expect(outcome.status === 'rejected' ? outcome.reason : '').toMatch(/прогрев/);

    // Отказ прошёл ОБЫЧНОЙ дорогой applyBatch: событие отказа доехало актору каскадом.
    expect(record.timeline.some((e) => e.envelope.event.kind === 'order.denied')).toBe(true);
    // И заявки не появилось: отклонённая команда не имеет частичных эффектов.
    expect(record.orders).toEqual([]);
    expect(record.journal).toEqual([]);
  });

  it('та же стратегия при lookback=0 торгует с первого события', async () => {
    // Проверка проверки: без неё «place отклоняется» зеленело бы и у раннера, отклоняющего всегда.
    const { run } = makeRun({ lookback: 0, barCount: 3, onEvent: placeOnce() });
    const record = await run();
    const placeEntry = record.timeline.find((e) => e.commands.some((c) => c.command.kind === 'place'))!;
    expect(placeEntry.commands.find((c) => c.command.kind === 'place')!.outcome.status).toBe('applied');
    expect(record.journal.filter((j) => j.kind === 'fill')).toHaveLength(1);
  });

  it('lookback === barCount: вся лента доставлена, торговых прав нет ни на одном баре', async () => {
    const { seen, run } = makeRun({ lookback: 3, barCount: 3, onEvent: placeOnce() });
    const record = await run();
    expect(seen.filter((s) => s.kind === 'market.candle.closed')).toHaveLength(3);
    expect(seen.every((s) => s.readiness === 'warming_up')).toBe(true);
    expect(record.journal).toEqual([]);
  });
});

describe('одно readiness на контекст и на валидацию', () => {
  it('автор видит РОВНО то значение, по которому судят его команду', async () => {
    // Разъезд этих двух значений — главный дефект, который здесь исключается: он не ломает числа,
    // он делает поведение необъяснимым для автора стратегии.
    const observed: { readiness: string; outcome: string }[] = [];
    const { run } = makeRun({
      lookback: 2,
      barCount: 4,
      onEvent: (event, ctx) => {
        if (event.kind !== 'market.candle.closed') return [];
        observed.push({ readiness: ctx.readiness, outcome: '' });
        return [
          { kind: 'place', type: 'market', clientOrderId: `o${observed.length}`, side: 'buy', qtyUsd: 100 } as ActorCommand,
        ];
      },
    });
    const record = await run();

    for (const entry of record.timeline) {
      const place = entry.commands.find((c) => c.command.kind === 'place');
      if (place === undefined) continue;
      const frontier = entry.frontier;
      const wasReady = frontier >= 2;
      expect(place.outcome.status).toBe(wasReady ? 'applied' : 'rejected');
    }
    expect(observed.map((o) => o.readiness)).toEqual(['warming_up', 'warming_up', 'ready', 'ready']);
  });
});

describe('запись прогона несёт идентичность актора', () => {
  it('actorId, symbol и ФАКТИЧЕСКИЕ подписки', async () => {
    const { input, run } = makeRun({ lookback: 0, barCount: 2 });
    const record = await run();
    expect(record.actorId).toBe('actor-btcusdt-0');
    expect(record.symbol).toBe('BTCUSDT');
    // Тот же экземпляр, что уехал в ActorInit: реконструкция по манифесту ответила бы на другой
    // вопрос — «что объявлено», а не «что разрешено и доставлено».
    expect(record.subscriptions).toBe(input.admission.subscriptions);
  });

  it('ось frontier-ов совпадает с лентой по числу и по меткам', async () => {
    const { input, run } = makeRun({ lookback: 0, barCount: 5 });
    const record = await run();
    expect(record.frontiers.map((f) => f.index)).toEqual([0, 1, 2, 3, 4]);
    expect(record.frontiers.map((f) => f.tsUs)).toEqual(input.bars!.map((b) => b.tsUs));
    expect(record.equity).toHaveLength(5);
  });
});

describe('ИНТЕГРАЦИЯ: запись раннера проходит существующую проекцию', () => {
  // Главный гейт среза. Проекция — не «ещё один потребитель», а совокупность всех сверок агрегата:
  // ось frontier'ов, побайтовое сравнение финального ledger'а со свёрткой журнала, вывод сделок
  // движком и непрерывность timeline. Запись, которую она принимает, описывает ОДНУ историю; запись,
  // собранную «на глаз», она отвергает.

  it('прогон без сделок проецируется и отдаёт timeline', async () => {
    const { run } = makeRun({ lookback: 0, barCount: 4 });
    const artifacts = projectActorRun(await run());
    expect(artifacts.orders).toEqual([]);
    expect(artifacts.trades).toEqual([]);
    expect(artifacts.equityCurve).toHaveLength(4);
    // Timeline доезжает до артефактов, а не только проверяется по дороге.
    expect(artifacts.timeline.length).toBeGreaterThan(0);
    expect(serializeActorTimeline(artifacts.timeline)).toContain('market.candle.closed');
  });

  it('прогон со входом и выходом даёт сделку, сведённую движком', async () => {
    // ВЫХОД ПОДАЁТСЯ КАК `reduceOnly`, и это не деталь фикстуры. Размер заявки фиксируется при
    // ПОДАЧЕ по последней увиденной цене, а исполняется она на следующем баре по другой — значит
    // «продать на тот же нотионал» закрывает позицию НЕ ПОЛНОСТЬЮ и оставляет хвост. Ровно для
    // этого в контракте есть `reduceOnly`: он клампится остатком позиции и закрывает её точно.
    let step = 0;
    const { run } = makeRun({
      lookback: 0,
      barCount: 6,
      onEvent: (event) => {
        if (event.kind !== 'market.candle.closed') return [];
        step += 1;
        if (step === 1) {
          return [{ kind: 'place', type: 'market', clientOrderId: 'in', side: 'buy', qtyUsd: 1000 } as ActorCommand];
        }
        if (step === 4) {
          return [
            {
              kind: 'place',
              type: 'market',
              clientOrderId: 'out',
              side: 'sell',
              qtyUsd: 2000,
              reduceOnly: true,
            } as ActorCommand,
          ];
        }
        return [];
      },
    });
    const record = await run();
    // Обе заявки исполнились — значит бухгалтерия непуста и сверка ledger'а осмысленна.
    expect(record.journal.filter((j) => j.kind === 'fill')).toHaveLength(2);
    // Выход СОКРАТИЛ, а не перевернул: заявка на 2000 при позиции на ~1000 исполнена по остатку.
    expect(record.finalLedger.qty).toBe(0);

    const artifacts = projectActorRun(record);
    expect(artifacts.orders.map((o) => o.id)).toEqual(['in', 'out']);
    expect(artifacts.fills).toHaveLength(2);
    expect(artifacts.trades).toHaveLength(1);
    // Сверка `ledger.realizedPnl` ↔ сделки живёт в проекции; здесь достаточно того, что она прошла.
    expect(artifacts.validationIssues).toEqual([]);
  });

  it('ХАРАКТЕРИЗАЦИЯ ОТКРЫТОГО ДЕФЕКТА: частичный выход роняет проекцию на 1 ULP', async () => {
    // НЕ ЖЕЛАЕМОЕ ПОВЕДЕНИЕ, а пин факта. Гейт `assertTradesReconcile` сравнивает две движковые
    // величины через `Object.is`: свёрнутый по сделкам `realizedPnl` и якорный из ledger'а. Считает
    // обе движок, но РАЗНЫМ порядком суммирования — при незакрытом остатке они расходятся в
    // последнем разряде (27.98060422525056 против 27.980604225250556, ~1e-16 относительной разницы).
    //
    // До этого среза гейт зеленел на удаче: числа фикстуры случайно совпадали побитово. Сменился
    // размер заявки — совпадение пропало. Точное равенство двух РАЗНЫХ порядков сложения не является
    // выполнимым инвариантом, поэтому проба пиннит наблюдаемое сегодня: прогон с частичным выходом
    // падает отказом проекции. Решение (допуск в гейте либо единый порядок свёртки в движке) — за
    // владельцем, и проба обязана покраснеть в тот момент, когда его примут.
    let step = 0;
    const { run } = makeRun({
      lookback: 0,
      barCount: 6,
      onEvent: (event) => {
        if (event.kind !== 'market.candle.closed') return [];
        step += 1;
        if (step === 1) {
          return [{ kind: 'place', type: 'market', clientOrderId: 'in', side: 'buy', qtyUsd: 1000 } as ActorCommand];
        }
        if (step === 4) {
          return [{ kind: 'place', type: 'market', clientOrderId: 'out', side: 'sell', qtyUsd: 1000 } as ActorCommand];
        }
        return [];
      },
    });
    const record = await run();
    // Позиция закрыта НЕ ПОЛНОСТЬЮ — именно остаток и разводит два порядка суммирования.
    expect(record.finalLedger.qty).toBeGreaterThan(0);
    expect(() => projectActorRun(record)).toThrow(/сделки и леджер разошлись/);
  });
});

describe('жизненный цикл переживает горячий цикл', () => {
  it('бросок стратегии ПОСЛЕ await сохраняет исходную ошибку и освобождает актора', async () => {
    const { calls, run } = makeRun({ lookback: 0, barCount: 2, bodyThrowsAfterAwait: true });
    await expect(run()).rejects.toThrow('стратегия упала после await');
    expect(calls.create).toBe(1);
    expect(calls.dispose).toBe(1);
  });

  it('отказ создания не зовёт dispose даже с непустой лентой', async () => {
    const { calls, run } = makeRun({ lookback: 0, barCount: 3, createFails: true });
    await expect(run()).rejects.toThrow('изолят не поднялся');
    expect(calls.dispose).toBe(0);
  });
});
