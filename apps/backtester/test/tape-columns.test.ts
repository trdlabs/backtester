// Колоночная кодировка канонических строк — гейт точности round-trip.
//
// Зачем вообще кодировка. Барный цикл уезжает в отдельный поток (bt#197/198), а лента через границу
// не переносится: у неё методы, а structured clone копирует только данные. Строить ленту в потоке
// заново нельзя — главный поток всё равно строит свою (`dsFingerprint` считается ДО прогона), и
// вторая постройка обошла бы `overlayTapeCache`. Значит через границу едут ДАННЫЕ, и замер bt#199
// показал, чем именно: колонки типизированных массивов против канонических строк — 2.9 МБ / 1 мс
// против 12.5 МБ / 164–211 мс.
//
// Почему тест именно на round-trip, а не на «прогон дал тот же хэш». Прогон трогает не все поля:
// `short_after_pump` не читает taker, и кодировщик, молча потерявший taker-колонку, прошёл бы
// хэш-гейт целиком. Здесь проверяется само представление — независимо от того, что читает стратегия.
//
// Три вещи, которые легко потерять и которые тест ловит поимённо:
//   1) `has_*` флаг и nullness значения — РАЗНЫЕ факты. Строка с `has_oi=false, oi_total_usd=null` и
//      строка с `has_oi=true, oi_total_usd=null` обязаны отличаться после round-trip.
//   2) present-zero. `taker={0,0}` при `has_taker_flow=true` — валидное наблюдение, а не отсутствие.
//   3) Отсутствие вида целиком ≠ пустая колонка. `marketTapeFromCanonicalRows` включает колонку в
//      источник только если её несёт хоть одна строка (composition-following), а `kindCoverage`
//      разводит эти два случая: отсутствующий вид даёт `present:false` и gap во всю сетку, пустой —
//      `present:true` с нулевым покрытием.

import { describe, expect, it } from 'vitest';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import { decodeTapeColumns, encodeTapeColumns, tapeFromColumns } from '../src/engine/tape-columns.js';

const T0 = 1_700_000_000_000;

/** Строка со всеми видами выключенными — база, поверх которой тесты включают что нужно. */
function bareRow(symbol: string, i: number): CanonicalRowV2 {
  return {
    schema_version: 2,
    minute_ts: T0 + i * 60_000,
    symbol,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1_000 + i,
    turnover: 100_000 + i,
    oi_total_usd: null,
    funding_rate: null,
    liq_long_usd: null,
    liq_short_usd: null,
    has_oi: false,
    has_funding: false,
    has_liquidations: false,
    taker_buy_volume_usd: null,
    taker_sell_volume_usd: null,
    has_taker_flow: false,
  };
}

const roundTrip = (rows: readonly CanonicalRowV2[]): CanonicalRowV2[] =>
  decodeTapeColumns(encodeTapeColumns('ds', '1m', undefined, rows));

describe('tape-columns — round-trip канонических строк', () => {
  it('пустой вход даёт пустой выход и сохраняет метки ленты', () => {
    const cols = encodeTapeColumns('pump-fixture-1m', '1m', undefined, []);
    expect(cols.rowCount).toBe(0);
    expect(cols.datasetRef).toBe('pump-fixture-1m');
    expect(cols.timeframe).toBe('1m');
    expect(decodeTapeColumns(cols)).toEqual([]);
  });

  it('строки только со свечами восстанавливаются поле в поле', () => {
    const rows = [bareRow('BTCUSDT', 0), bareRow('BTCUSDT', 1), bareRow('ETHUSDT', 0)];
    expect(roundTrip(rows)).toEqual(rows);
  });

  it('порядок строк сохраняется, включая чередование символов', () => {
    const rows = [bareRow('BTCUSDT', 0), bareRow('ETHUSDT', 0), bareRow('BTCUSDT', 1), bareRow('ETHUSDT', 1)];
    const back = roundTrip(rows);
    expect(back.map((r) => `${r.symbol}@${r.minute_ts}`)).toEqual(rows.map((r) => `${r.symbol}@${r.minute_ts}`));
  });

  it('все необязательные виды со значениями переживают round-trip', () => {
    const rows: CanonicalRowV2[] = [
      {
        ...bareRow('BTCUSDT', 0),
        oi_total_usd: 1_234_567.25,
        has_oi: true,
        funding_rate: -0.000_125,
        has_funding: true,
        liq_long_usd: 5_000.5,
        liq_short_usd: 7_500.75,
        has_liquidations: true,
        taker_buy_volume_usd: 42_000.125,
        taker_sell_volume_usd: 41_999.875,
        has_taker_flow: true,
      },
    ];
    expect(roundTrip(rows)).toEqual(rows);
  });

  it('флаг и nullness — разные факты: has_oi=true при oi_total_usd=null не схлопывается', () => {
    // Контракт говорит «null ⟺ has_oi=false», но кодировщик не имеет права ОПИРАТЬСЯ на это:
    // выводя одно из другого, он молча чинил бы битые данные и прятал бы источник расхождения.
    const rows: CanonicalRowV2[] = [
      { ...bareRow('BTCUSDT', 0), has_oi: true, oi_total_usd: null },
      { ...bareRow('BTCUSDT', 1), has_oi: false, oi_total_usd: 999 },
    ];
    const back = roundTrip(rows);
    expect(back[0].has_oi).toBe(true);
    expect(back[0].oi_total_usd).toBeNull();
    expect(back[1].has_oi).toBe(false);
    expect(back[1].oi_total_usd).toBe(999);
  });

  it('present-zero не превращается в отсутствие', () => {
    const rows: CanonicalRowV2[] = [
      {
        ...bareRow('BTCUSDT', 0),
        taker_buy_volume_usd: 0,
        taker_sell_volume_usd: 0,
        has_taker_flow: true,
        liq_long_usd: 0,
        liq_short_usd: 0,
        has_liquidations: true,
        funding_rate: 0,
        has_funding: true,
      },
    ];
    const back = roundTrip(rows);
    expect(back[0].taker_buy_volume_usd).toBe(0);
    expect(back[0].has_taker_flow).toBe(true);
    expect(back[0].funding_rate).toBe(0);
    expect(back[0].has_funding).toBe(true);
    expect(back[0].liq_long_usd).toBe(0);
    expect(back[0].has_liquidations).toBe(true);
  });

  it('отрицательный funding и отрицательный ноль сохраняются', () => {
    const rows: CanonicalRowV2[] = [
      { ...bareRow('BTCUSDT', 0), funding_rate: -0.0003, has_funding: true },
      { ...bareRow('BTCUSDT', 1), funding_rate: -0, has_funding: true },
    ];
    const back = roundTrip(rows);
    expect(back[0].funding_rate).toBe(-0.0003);
    // Object.is различает -0 и 0; типизированный массив хранит знак, и терять его нельзя.
    expect(Object.is(back[1].funding_rate, -0)).toBe(true);
  });

  it('блок вида отсутствует, когда его не несёт ни одна строка — и появляется, когда несёт', () => {
    // Это ровно то, на чём стоит composition-following в `marketTapeFromCanonicalRows`: колонка
    // попадает в источник ленты только при наличии данных, и от этого зависит coverage-модель.
    const none = encodeTapeColumns('ds', '1m', undefined, [bareRow('BTCUSDT', 0)]);
    expect(none.oi).toBeUndefined();
    expect(none.funding).toBeUndefined();
    expect(none.liq).toBeUndefined();
    expect(none.taker).toBeUndefined();

    const some = encodeTapeColumns('ds', '1m', undefined, [
      bareRow('BTCUSDT', 0),
      { ...bareRow('BTCUSDT', 1), oi_total_usd: 10, has_oi: true },
    ]);
    expect(some.oi).toBeDefined();
    expect(some.funding).toBeUndefined();
    // Строка без OI внутри присутствующего блока обязана вернуться с null, а не с нулём.
    expect(decodeTapeColumns(some)[0].oi_total_usd).toBeNull();
  });

  it('частичный liq (одна сторона null) не схлопывается в обе', () => {
    const rows: CanonicalRowV2[] = [
      { ...bareRow('BTCUSDT', 0), liq_long_usd: 100, liq_short_usd: null, has_liquidations: true },
    ];
    const back = roundTrip(rows);
    expect(back[0].liq_long_usd).toBe(100);
    expect(back[0].liq_short_usd).toBeNull();
  });

  it('отказ, а не молчаливое переполнение, когда символов больше, чем вмещает идентификатор', () => {
    // Uint16 держит 65 536 значений. Больше — не «немного неточно», а перепутанные символы, поэтому
    // граница закрыта исключением: невозможное состояние должно падать, а не печататься.
    const rows = Array.from({ length: 65_537 }, (_, i) => bareRow(`SYM${i}`, 0));
    expect(() => encodeTapeColumns('ds', '1m', undefined, rows)).toThrow(/символ/i);
  });

  it('символы восстанавливаются по именам, а не по индексам — повтор имени делит идентификатор', () => {
    const rows = [bareRow('BTCUSDT', 0), bareRow('ETHUSDT', 0), bareRow('BTCUSDT', 1)];
    const cols = encodeTapeColumns('ds', '1m', undefined, rows);
    expect(cols.symbolNames).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect([...cols.symbolIds]).toEqual([0, 1, 0]);
    expect(decodeTapeColumns(cols).map((r) => r.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'BTCUSDT']);
  });
});

describe('происхождение свечей переживает границу потока', () => {
  // Колонки — ЕДИНСТВЕННЫЙ канал, которым лента попадает в поток: `MarketTapeDataset` через
  // `postMessage` не проходит, и лента там строится заново из колонок. Значит потеря провенанса
  // именно здесь была бы невидима на главном потоке и проявилась бы отказом «происхождение не
  // доказано» ровно там, где дескриптор его объявил, — то есть выглядела бы законно.

  it('объявленное венью доезжает до восстановленной ленты', () => {
    const cols = encodeTapeColumns('ds', '1m', 'bybit', [bareRow('BTCUSDT', 0)]);
    expect(cols.candleVenue).toBe('bybit');
    expect(tapeFromColumns(cols).candleVenue).toBe('bybit');
  });

  it('НЕобъявленное остаётся необъявленным — ключа нет, а не «пусто»', () => {
    // Подстановка была бы неотличима от объявления: любое венью само по себе законно, и допуск
    // принял бы происхождение, которого никто не утверждал. Проверяется ОТСУТСТВИЕ КЛЮЧА, а не
    // равенство `undefined`: `{candleVenue: undefined}` пережил бы `JSON`-сериализацию как потеря,
    // а отсутствие ключа — как отсутствие.
    const cols = encodeTapeColumns('ds', '1m', undefined, [bareRow('BTCUSDT', 0)]);
    expect(Object.prototype.hasOwnProperty.call(cols, 'candleVenue')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(tapeFromColumns(cols), 'candleVenue')).toBe(false);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: сама лента строится, а не молча пустует', () => {
    // Иначе обе пробы выше зеленели бы и на ленте, у которой нет вообще ничего.
    const tape = tapeFromColumns(encodeTapeColumns('ds', '1m', 'bybit', [bareRow('BTCUSDT', 0)]));
    expect(tape.datasetRef).toBe('ds');
    expect(tape.timeframe).toBe('1m');
    expect(tape.symbols()).toEqual(['BTCUSDT']);
  });
});
