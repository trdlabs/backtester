// 083 S3 — ГЕЙТ ЦЕЛОСТНОСТИ потока (ADR-0014 §3), с негативными пробами на каждый способ его обойти.
//
// Положительная проба здесь почти ничего не стоит: записали — прочитали — сошлось. Ценность файла в
// НЕГАТИВНЫХ, и каждая закрывает свой способ потерять истину о прогоне, не заметив этого по
// результату:
//
//   • содержимое подменено на диске (стор отдаёт не то, что писали);
//   • ссылка указывает на чужой, но существующий и корректный артефакт;
//   • ссылка указывает на поток ТОГО ЖЕ актора — самосогласованный, с теми же дескрипторами и тем
//     же числом строк, но из другого прогона: самый тонкий случай, потому что все признаки, по
//     которым артефакт сверялся с прогоном поштучно, у него сходятся;
//   • артефакта нет вовсе, а ссылка на него есть;
//   • ссылок меньше, чем акторов;
//   • сериализация потеряла actor identity либо дескрипторы подписок.
//
// Общее у них одно: РЕЗУЛЬТАТ ПРОГОНА ВЫГЛЯДИТ НОРМАЛЬНО во всех шести случаях. Именно поэтому гейт
// обязателен, а не рекомендован: он единственный, кто эти состояния отличает от здорового.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { ArtifactReference, ContentHash } from '@trdlabs/backtester-sdk/artifacts';
import type { ActorCommand, ActorInputEvent, MarketDataRequirement } from '@trdlabs/sdk/research-contract';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';

import { InMemoryArtifactStore, type ArtifactStore } from '../src/artifacts/store.js';
import { contentRef } from '../src/determinism/hash.js';
import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import { runEventDrivenSymbol } from '../src/engine/actor/run-symbol.js';
import type { ActorBar } from '../src/engine/actor/frontier-runner.js';
import type { ActorExecutionRecord } from '../src/engine/actor/execution-record.js';
import type {
  ActorExecutionHandle,
  ActorLifecycleExecutor,
} from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';
import { riskBinding } from './helpers/actor-risk.js';
import {
  ACTOR_TIMELINE_ARTIFACT_TYPE,
  ActorTimelineIntegrityError,
  assertActorTimelineIntegrity,
  buildActorTimelineDocument,
  persistActorTimelines,
  type ActorTimelineDocument,
} from '../src/engine/actor/timeline-artifact.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = 1_700_000_000_000;

const bars = (n: number): readonly ActorBar[] =>
  Array.from({ length: n }, (_, i) => ({
    tsUs: timestampUsFromMillis(T0 + i * MINUTE_MS),
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    volume: 0,
  }));

const strategy = (): ResolvedStrategy =>
  ({
    manifest: {
      id: 'timeline-artifact-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData: [
        {
          kind: 'candles',
          id: 'req-candles',
          instrument: { venue: 'bybit', symbol: 'BTCUSDT' },
          interval: MINUTE_US,
          lookback: 0,
          revisionPolicy: { mode: 'final_only' },
          priceType: 'trade',
        } as unknown as MarketDataRequirement,
      ],
    },
    module: {},
  }) as unknown as ResolvedStrategy;

/**
 * Настоящий прогон: поток обязан родиться из диспетчеризации, а не быть собранным в тесте.
 *
 * `clientOrderId` вынесен в параметр не ради удобства: он даёт ВТОРОЙ настоящий прогон того же
 * актора той же конфигурации, отличающийся только содержимым строк. Собери такой документ руками —
 * и проба доказывала бы, что гейт отвергает рукотворную форму, а не что он отличает чужой поток от
 * своего.
 */
async function realRecord(
  actorId = 'actor-btcusdt',
  clientOrderId = 'o1',
): Promise<ActorExecutionRecord> {
  let step = 0;
  const executor: ActorLifecycleExecutor = {
    createActor: async () => ({ __h: 1 }) as unknown as ActorExecutionHandle,
    executeActorEvent: async (_h, event: ActorInputEvent): Promise<readonly ActorCommand[]> => {
      if (event.kind !== 'market.candle.closed') return [];
      step += 1;
      if (step === 1) {
        return [{ kind: 'place', clientOrderId, side: 'buy', qtyUsd: 1000, type: 'market' } as unknown as ActorCommand];
      }
      return [];
    },
    disposeActor: async () => {},
  };
  const tape = bars(4);
  const admission = admitActorMarketData(strategy(), {
    candleVenue: proveCandleVenue({ datasetRef: 'timeline-fixture', candleVenue: 'bybit' }),
    symbol: 'BTCUSDT',
    barIntervalUs: MINUTE_US,
    barCount: tape.length,
    // Лента этих проб — только свечи: агрегатов она не несёт, и допуск обязан это
    // увидеть, а не додумать. Значение явное, потому что дефолта у поля нет.
    carries: () => false,
  });
  if (admission.refusal !== null) throw new Error(admission.refusal.message);
  return runEventDrivenSymbol({
    executor,
    source: { manifest: strategy().manifest, module: {} },
    actorId,
    symbol: 'BTCUSDT',
    seed: 1,
    params: {},
    admission,
    bars: tape,
    costs: { feeBps: 0, slippageBps: 0, initialEquity: 10_000 },
    risk: riskBinding(10_000),
  });
}

/** Стор, подменяющий содержимое ПОСЛЕ записи — то есть ровно то, чего боится ADR-0014. */
class TamperedStore implements ArtifactStore {
  constructor(
    private readonly inner: ArtifactStore,
    private readonly tamper: (payload: unknown) => unknown,
  ) {}
  write(payload: unknown): Promise<ContentHash> {
    return this.inner.write(payload);
  }
  async read(ref: ContentHash): Promise<unknown> {
    return this.tamper(await this.inner.read(ref));
  }
  has(ref: ContentHash): Promise<boolean> {
    return this.inner.has(ref);
  }
}

describe('поток доезжает до артефакта и сверяется', () => {
  it('записанный поток проходит гейт целостности', async () => {
    const doc = buildActorTimelineDocument(await realRecord());
    const store = new InMemoryArtifactStore();
    const refs = await persistActorTimelines(store, [doc]);
    await expect(assertActorTimelineIntegrity(store, refs, [doc])).resolves.toBeUndefined();
  });

  it('ПРОВЕРКА ПРОВЕРКИ: поток непуст и несёт идентичность актора', async () => {
    // Иначе положительная проба зеленела бы и на пустом документе — то есть доказывала бы, что
    // гейт пропускает ничто.
    const doc = buildActorTimelineDocument(await realRecord());
    expect(doc.rows.length).toBeGreaterThan(0);
    expect(doc.actorId).toBe('actor-btcusdt');
    // Хостовый источник обязан быть среди дескрипторов: половина событий потока рождается в хосте.
    expect(doc.subscriptions.some((s) => s.subscriptionId === 'host')).toBe(true);
  });

  it('ссылка помечена своим типом артефакта и несёт число строк', async () => {
    const doc = buildActorTimelineDocument(await realRecord());
    const store = new InMemoryArtifactStore();
    const [ref] = await persistActorTimelines(store, [doc]);
    expect(ref!.artifactType).toBe(ACTOR_TIMELINE_ARTIFACT_TYPE);
    expect(ref!.artifactId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref!.approxItemCount).toBe(doc.rows.length);
  });
});

describe('негативные гейты: каждый способ потерять истину о прогоне', () => {
  it('ПОДМЕНА СОДЕРЖИМОГО: хеш прочитанного не сходится со ссылкой', async () => {
    // Главная проба файла. Стор content-addressed, и соблазн счесть сверку лишней силён: «ссылка и
    // есть хеш». Но read отдаёт содержимое файла, а не доказательство, что файл оправдывает своё
    // имя. Здесь подменена ОДНА строка потока — результат прогона при этом безупречен.
    const doc = buildActorTimelineDocument(await realRecord());
    const store = new TamperedStore(new InMemoryArtifactStore(), (payload) => {
      const d = payload as ActorTimelineDocument;
      return { ...d, rows: d.rows.slice(0, -1) };
    });
    const refs = await persistActorTimelines(store, [doc]);
    await expect(assertActorTimelineIntegrity(store, refs, [doc])).rejects.toThrow(
      /подменён: хеш прочитанного/,
    );
  });

  it('ПОДМЕНА ССЫЛКИ: указывает на существующий и корректный, но ЧУЖОЙ поток', async () => {
    // Тонкий случай: артефакт есть, читается, хеш сходится сам с собой. Не сходится только то,
    // ЧЕЙ это поток. Без сверки actorId такая подмена невидима вовсе.
    const mine = buildActorTimelineDocument(await realRecord('actor-btcusdt'));
    const alien = buildActorTimelineDocument(await realRecord('actor-ethusdt'));
    const store = new InMemoryArtifactStore();
    const alienRefs = await persistActorTimelines(store, [alien]);
    await expect(assertActorTimelineIntegrity(store, alienRefs, [mine])).rejects.toThrow(
      /принадлежит актору «actor-ethusdt», которого в этом прогоне нет/,
    );
  });

  it('ПОДМЕНА НА ПОТОК ТОГО ЖЕ АКТОРА: поштучные признаки сходятся, документ другой', async () => {
    // Самый тонкий случай — и единственный, который гейт пропускал до 2026-08-16. Артефакт
    // настоящий, самосогласованный, того же актора, с теми же дескрипторами и тем же числом строк.
    // Отличается он только СОДЕРЖИМЫМ строк, а значит ни одна поштучная сверка его не ловит. Так
    // выглядит повторный прогон той же конфигурации, чья ссылка попала в результат вместо своей:
    // прогон объяснён потоком, который ему не принадлежит, и по результату это невидимо.
    const mine = buildActorTimelineDocument(await realRecord('actor-btcusdt', 'o1'));
    const other = buildActorTimelineDocument(await realRecord('actor-btcusdt', 'o2'));

    // ПРОВЕРКА ПРОВЕРКИ, и здесь она несущая: без неё проба зеленела бы по любой причине — «актор
    // не тот», «дескрипторы не те», «строк не столько», — то есть повторно проверяла бы уже
    // закрытые случаи, а этот так и остался бы непокрытым.
    expect(other.actorId).toBe(mine.actorId);
    expect(contentRef(other.subscriptions)).toBe(contentRef(mine.subscriptions));
    expect(other.rows.length).toBe(mine.rows.length);
    expect(contentRef(other)).not.toBe(contentRef(mine));

    const store = new InMemoryArtifactStore();
    const refs = await persistActorTimelines(store, [other]);
    await expect(assertActorTimelineIntegrity(store, refs, [mine])).rejects.toThrow(
      /ссылка .* указывает не на тот документ/,
    );
  });

  // ── Порядок проверок в гейте НОРМАТИВЕН, и эти две пробы его держат ──────────────────────────
  //
  // Замыкающая сверка «ссылка указывает не на тот документ» строго сильнее сверок дескрипторов и
  // числа строк: она ловит и их случаи тоже. Поэтому обе стоят ВЫШЕ неё — иначе перестали бы
  // срабатывать вовсе, оставшись ветками с недостижимым условием.
  //
  // Без этих проб порядок держался бы одним комментарием: перенеси замыкающую сверку наверх — и
  // ничего не покраснеет, потому что отвергнут артефакт будет по-прежнему, просто другим,
  // менее точным сообщением. Пробы пинят ДИАГНОЗ, и в этом весь их смысл; сам факт отвержения
  // проверен соседними.
  //
  // Документы здесь собраны правкой готового, а не вторым прогоном: нужен ровно вход, попадающий
  // в конкретную ветку. Правдоподобие класса доказывается не тут, а соседней пробой «поток того же
  // актора», где оба документа настоящие.

  it('ПОРЯДОК: расхождение дескрипторов называется своим именем, а не общим', async () => {
    const mine = buildActorTimelineDocument(await realRecord());
    expect(mine.subscriptions.length).toBeGreaterThan(1);
    const skewed: ActorTimelineDocument = { ...mine, subscriptions: mine.subscriptions.slice(0, -1) };
    const store = new InMemoryArtifactStore();
    const refs = await persistActorTimelines(store, [skewed]);
    await expect(assertActorTimelineIntegrity(store, refs, [mine])).rejects.toThrow(
      /дескрипторы подписок в артефакте не совпадают/,
    );
  });

  it('ПОРЯДОК: расхождение числа строк называется своим именем, а не общим', async () => {
    const mine = buildActorTimelineDocument(await realRecord());
    const shorter: ActorTimelineDocument = { ...mine, rows: mine.rows.slice(0, -1) };
    const store = new InMemoryArtifactStore();
    const refs = await persistActorTimelines(store, [shorter]);
    await expect(assertActorTimelineIntegrity(store, refs, [mine])).rejects.toThrow(
      /строк потока против/,
    );
  });

  it('ОТСУТСТВИЕ АРТЕФАКТА: ссылка есть, содержимого нет', async () => {
    const doc = buildActorTimelineDocument(await realRecord());
    const store = new InMemoryArtifactStore();
    const refs = await persistActorTimelines(store, [doc]);
    // Ссылка та же, хранилище пустое — ровно то, как выглядит потерянный артефакт.
    await expect(assertActorTimelineIntegrity(new InMemoryArtifactStore(), refs, [doc])).rejects.toThrow(
      /отсутствует в хранилище/,
    );
  });

  it('ССЫЛОК МЕНЬШЕ, ЧЕМ АКТОРОВ: прогон объяснён не полностью', async () => {
    const a = buildActorTimelineDocument(await realRecord('actor-a'));
    const b = buildActorTimelineDocument(await realRecord('actor-b'));
    const store = new InMemoryArtifactStore();
    const refs = await persistActorTimelines(store, [a]);
    await expect(assertActorTimelineIntegrity(store, refs, [a, b])).rejects.toThrow(
      /ссылок на поток 1, а акторов 2/,
    );
  });

  it('ПОТЕРЯ ДЕСКРИПТОРОВ ПОДПИСОК: subscriptionId строк сопоставлять не с чем', async () => {
    // Сериализация, потерявшая дескрипторы, оставляет поток формально целым: строки на месте, хеш
    // сходится. Беспризорной становится ровно связь «событие → чем разрешено».
    const doc = buildActorTimelineDocument(await realRecord());
    const store = new TamperedStore(new InMemoryArtifactStore(), (payload) => {
      const d = payload as ActorTimelineDocument;
      return { ...d, subscriptions: d.subscriptions.filter((s) => s.subscriptionId !== 'host') };
    });
    const refs = await persistActorTimelines(store, [doc]);
    // Подмена содержимого ловится РАНЬШЕ сверки дескрипторов — и это правильный порядок: сначала
    // «содержимое не то», потом «оно не то вот чем». Гейт называет первую причину.
    await expect(assertActorTimelineIntegrity(store, refs, [doc])).rejects.toThrow(
      ActorTimelineIntegrityError,
    );
  });

  it('ПОТЕРЯ ACTOR IDENTITY отвергается ещё при сборке документа', async () => {
    const record = await realRecord();
    const nameless = { ...record, actorId: '  ' } as ActorExecutionRecord;
    expect(() => buildActorTimelineDocument(nameless)).toThrow(/без actorId/);
  });

  it('ПУСТЫЕ ПОДПИСКИ отвергаются при сборке: артефакт перестал бы объяснять сам себя', async () => {
    const record = await realRecord();
    const bare = { ...record, subscriptions: [] } as ActorExecutionRecord;
    expect(() => buildActorTimelineDocument(bare)).toThrow(/пустой список подписок/);
  });
});

describe('порядок ссылок — функция содержимого, а не порядка обхода', () => {
  it('два порядка предъявления дают ОДИНАКОВЫЕ ссылки', async () => {
    // Иначе два одинаковых прогона давали бы разные манифесты из-за того, в каком порядке хост
    // обошёл символы, — и сравнение прогонов перестало бы быть сравнением их содержимого.
    const a = buildActorTimelineDocument(await realRecord('actor-a'));
    const b = buildActorTimelineDocument(await realRecord('actor-b'));
    const first = await persistActorTimelines(new InMemoryArtifactStore(), [a, b]);
    const second = await persistActorTimelines(new InMemoryArtifactStore(), [b, a]);
    expect(second.map((r) => r.artifactId)).toEqual(first.map((r) => r.artifactId));
  });
});

describe('гейт различает СВОИ ссылки среди чужих', () => {
  it('посторонние типы артефактов не считаются потоками', async () => {
    // Прогон несёт и другие артефакты (metrics, trades). Гейт обязан смотреть только на свои —
    // иначе он падал бы на здоровом прогоне ровно потому, что тот полон.
    const doc = buildActorTimelineDocument(await realRecord());
    const store = new InMemoryArtifactStore();
    const refs = await persistActorTimelines(store, [doc]);
    const withNoise: readonly ArtifactReference[] = [
      { artifactId: `sha256:${'0'.repeat(64)}` as ContentHash, artifactType: 'metrics', availability: 'available' },
      ...refs,
    ];
    await expect(assertActorTimelineIntegrity(store, withNoise, [doc])).resolves.toBeUndefined();
  });
});
