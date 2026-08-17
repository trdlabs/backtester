// ПРОИСХОЖДЕНИЕ СВЕЧЕЙ У НАСТОЯЩИХ ПОРТОВ (083 S3, снятие cc#365) — потребительская половина.
//
// ═══ ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, А ЧТО НЕТ ═══
//
// Цепь снятия блокера длиннее, чем кажется: рекордер пишет источник в состав дня →
// `platform` отдаёт его в покрытии → `@trdlabs/sdk` объявляет поле в `HistoricalCoverageEntry` →
// порт бэктестера кладёт его в `DatasetDescriptor` → `proveCandleVenue` превращает в
// доказательство. Здесь закрыто ПОСЛЕДНЕЕ звено и только оно.
//
// ═══ ПОЧЕМУ ОТСУТСТВИЕ ОБЯЗАНО БЫТЬ ОТКАЗОМ ═══
//
// У писателя значение сегодня берётся с подстановкой (`args['price-source'] || 'bybit'`), то есть
// «оператор назвал bybit» и «оператор промолчал» по значению НЕРАЗЛИЧИМЫ. Единственное, что
// потребитель может сделать честно, — не подставлять ничего своего: нет ключа, значит нет
// доказательства, значит отказ. Дефолт на этой стороне превратил бы молчание писателя в
// утверждение читателя.

import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@trading/research-contracts';

import { MockPlatformDataPort } from '../src/data/mock-platform-data-port.js';
import { proveCandleVenue } from '../src/engine/actor/admission.js';

const T0 = 1_700_000_000_000;

/** Ответ мока на `/historical/coverage` — ровно та форма, которую разбирает порт. */
const coverage = (over: Record<string, unknown> = {}): unknown => ({
  availability: 'available',
  entries: [
    {
      symbol: 'BTCUSDT',
      timeframe: '1m',
      fromMs: T0,
      toMs: T0 + 60_000,
      barCount: 2,
      availability: 'available',
      ...over,
    },
  ],
});

function portOver(body: unknown): MockPlatformDataPort {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
  return new MockPlatformDataPort({ baseUrl: 'http://mock.invalid', fetchImpl });
}

describe('mock-platform: происхождение доезжает до дескриптора', () => {
  it('объявленное венью проброшено — В ПАРЕ с флагом однородности', async () => {
    const [d] = await portOver(
      coverage({ candleVenue: 'bybit', candleVenueHomogeneous: true }),
    ).listDatasets();
    expect(d?.candleVenue).toBe('bybit');
  });

  it('имя БЕЗ флага однородности не принимается: половина факта неотличима от целого', async () => {
    // Такая пара возможна только при рассинхроне версий (старый сервер, новый клиент). Сервер,
    // назвавший венью и промолчавший про однородность, сообщил половину факта — а имя выглядит
    // одинаково и при однородных сутках, и при собранных из двух источников.
    //
    // Проверяется ЗДЕСЬ, а не в прувере: этот порт разговаривает с сервером и умеет отличить его от
    // фикстуры, где отсутствие флага законно, — прувер такого различения не имеет.
    const [d] = await portOver(coverage({ candleVenue: 'bybit' })).listDatasets();
    expect(Object.prototype.hasOwnProperty.call(d as DatasetDescriptor, 'candleVenue')).toBe(false);
  });

  it('НЕобъявленное остаётся без ключа, а не пустым', async () => {
    // Проверяется отсутствие КЛЮЧА, а не равенство `undefined`: `{candleVenue: undefined}` пережил
    // бы JSON-сериализацию как потеря, а отсутствие ключа — как отсутствие. Ниже по цепи разница
    // становится разницей между «неизвестно» и «объявлено пустым».
    const [d] = await portOver(coverage()).listDatasets();
    expect(Object.prototype.hasOwnProperty.call(d as DatasetDescriptor, 'candleVenue')).toBe(false);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: дескриптор вообще собран', async () => {
    // Иначе обе пробы выше зеленели бы на пустом списке.
    const list = await portOver(
      coverage({ candleVenue: 'bybit', candleVenueHomogeneous: true }),
    ).listDatasets();
    expect(list).toHaveLength(1);
    expect(list[0]?.datasetRef).toBe('BTCUSDT:1m');
    expect(list[0]?.rowCount).toBe(2);
  });
});

describe('прувер отвечает на дескриптор так, как обязан', () => {
  it('объявленное венью доказано и названо источником', async () => {
    const [d] = await portOver(
      coverage({ candleVenue: 'bybit', candleVenueHomogeneous: true }),
    ).listDatasets();
    const proven = proveCandleVenue({
      datasetRef: d!.datasetRef,
      ...(d!.candleVenue !== undefined ? { candleVenue: d!.candleVenue } : {}),
    });
    expect(proven.proven).toBe(true);
    expect(proven.proven === true && proven.venue).toBe('bybit');
  });

  it('НЕобъявленное — отказ, и причина названа', async () => {
    const [d] = await portOver(coverage()).listDatasets();
    const proven = proveCandleVenue({
      datasetRef: d!.datasetRef,
      ...(d!.candleVenue !== undefined ? { candleVenue: d!.candleVenue } : {}),
    });
    expect(proven.proven).toBe(false);
    expect(proven.proven === false && proven.reason).toMatch(/не объявляет происхождение свечей/);
  });

  it('НЕОДНОРОДНЫЕ сутки — отказ ОТЛИЧИМЫЙ от «неизвестно»', () => {
    // Различение машиночитаемое, а не только текстом. «Неизвестно» и «источников было несколько» —
    // разные состояния: второе есть ЗНАНИЕ о данных, и чинится оно пересборкой суток, а не
    // дозаписью метаданных. Свести их в одну ветку значило бы потерять доказанный факт.
    const out = proveCandleVenue({
      datasetRef: 'mixed-day',
      candleVenueHomogeneous: false,
    });
    expect(out.proven).toBe(false);
    expect(out.proven === false && out.unknownBecause).toBe('heterogeneous');
    expect(out.proven === false && out.reason).toMatch(/НЕОДНОРОДЕН/);
  });

  it('перечень венью СОХРАНЯЕТСЯ в отказе — знание не складывается в «неизвестно»', () => {
    // «Источников было несколько, вот они» — установленный факт. Отказ без перечня заставил бы
    // владельца датасета выяснять состав заново, хотя он уже известен тому, кто отказ породил.
    const out = proveCandleVenue({
      datasetRef: 'mixed-day',
      candleVenueHomogeneous: false,
      candleVenues: ['okx', 'bybit'],
    });
    expect(out.proven === false && out.venues).toEqual(['okx', 'bybit']);
    // В тексте перечень отсортирован: сообщение отказа обязано быть одинаковым при одинаковом
    // составе, иначе два прогона по одним суткам дадут два разных текста.
    expect(out.proven === false && out.reason).toMatch(/\(bybit, okx\)/);
  });

  it('перечня нет — отказ остаётся, но ключа venues тоже нет', () => {
    // Пустой массив читался бы как «источников ноль», а это другое утверждение.
    const out = proveCandleVenue({ datasetRef: 'mixed-day', candleVenueHomogeneous: false });
    expect(out.proven).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'venues')).toBe(false);
  });

  it('неоднородность перевешивает ПРИСУТСТВУЮЩЕЕ имя', () => {
    // По согласованной форме при неоднородности имя не пишется. Полагаться на дисциплину писателя
    // нельзя: приехавшее имя будет именем ОДНОГО из источников и совпадёт с чьим-нибудь
    // требованием, доказав происхождение, которого у части минут не было.
    const out = proveCandleVenue({
      datasetRef: 'mixed-day',
      candleVenue: 'bybit',
      candleVenueHomogeneous: false,
    });
    expect(out.proven).toBe(false);
    expect(out.proven === false && out.unknownBecause).toBe('heterogeneous');
  });

  it('ПРОВЕРКА ПРОВЕРКИ: та же лента без флага неоднородности ДОКАЗАНА', () => {
    // Иначе пробы выше зеленели бы на пруверe, который отвергает всё подряд.
    const out = proveCandleVenue({ datasetRef: 'mixed-day', candleVenue: 'bybit' });
    expect(out.proven).toBe(true);
  });

  it('отсутствие объявления различимо как «неизвестно», а не как неоднородность', () => {
    const out = proveCandleVenue({ datasetRef: 'silent-day' });
    expect(out.proven === false && out.unknownBecause).toBe('undeclared');
  });

  it('пробел вместо венью — тоже отказ, а не доказательство', async () => {
    // Пробел выглядит заполненным значением и прошёл бы проверку «ключ есть». Доказательством
    // объявляется ЗНАЧЕНИЕ, а не факт присутствия ключа.
    const [d] = await portOver(
      coverage({ candleVenue: '   ', candleVenueHomogeneous: true }),
    ).listDatasets();
    const proven = proveCandleVenue({ datasetRef: d!.datasetRef, candleVenue: d!.candleVenue! });
    expect(proven.proven).toBe(false);
  });
});
