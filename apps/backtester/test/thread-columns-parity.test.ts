// ГЕЙТ ПАРИТЕТА КОЛОНОК: лента, уехавшая в поток колонками, обязана дать тот же результат.
//
// Что здесь проверяется и почему двумя разными способами.
//
// Паритет потока (bt#197) до сих пор доказан СТАНКОМ, а не прод-машинерией: станок отдавал потоку
// каталог фикстур, поток открывал его сам и строил ленту заново. Прод так не может — порт данных у
// него не каталог на диске, а клиент платформы, и лента к моменту прогона уже построена на главном
// потоке (`materializeFor` считает по ней `dsFingerprint` для дедуп-гейта ДО прогона). Значит в проде
// через границу поедут ДАННЫЕ, а не рецепт, и именно этот путь — колонки — здесь и закрывается.
//
// СЛОЙ 1 — эквивалентность ленты, без прогона. Лента, собранная из колонок, сравнивается с исходной
// по каноническому байту `toTape()` и `coverage()`. Работает на синтетической ленте, несущей ВСЕ
// необязательные виды (oi / funding / liq / taker), потому что ни одна фикстура репозитория их не
// несёт, а именно на них стоит самая хрупкая часть — composition-following: `marketTapeFromCanonicalRows`
// кладёт колонку вида в источник, только если её несёт хоть одна строка, и `kindCoverage` разводит
// отсутствующий вид (`present:false`, разрыв во всю сетку) и пустой (`present:true`, нулевое покрытие).
//
// СЛОЙ 2 — паритет ПРОГОНА через настоящий поток: один запрос, две дороги (главный поток по ленте из
// кэша; отдельный поток по колонкам из ТОЙ ЖЕ записи кэша), один `result_hash`.
//
// Почему нужны оба, а не любой один. Слой 2 трогает не все поля: `short_after_pump` не читает taker,
// и кодировщик, потерявший taker целиком, прошёл бы хэш-гейт не поморщившись. Слой 1 же ничего не
// говорит о том, доезжают ли данные через `postMessage` живыми. У них разные слепые пятна, и
// перекрываются они только вместе.
//
// Оба слоя ходят через настоящий `overlayTapeCache` — тот самый синглтон, что держит материализации в
// проде. Это не декорация: значение кэша в этой правке расширилось с ленты до материализации
// (лента + колонки), и гейт обязан гонять именно расширенный тип, а не его отдельно стоящую копию.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { CanonicalRowV2, MarketTapeDataset } from '@trading/research-contracts/research';
import { __resetTapeCachesForTest, overlayTapeCache, tapeCacheKey } from '../src/data/tape-cache.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { canonicalJson } from '../src/determinism/canonical-json.js';
import { buildOverlayDatasetWithColumns } from '../src/engine/data-adapter.js';
import { runBacktest } from '../src/engine/runner.js';
import { encodeTapeColumns, tapeFromColumns } from '../src/engine/tape-columns.js';
import { runBacktestInThread } from '../src/engine/thread/run-in-thread.js';
import { buildSandboxStrategyBaselineDeps, materializeReadableBundle } from './helpers-overlay-sandbox.js';
import { resultHash } from './helpers/bar-major-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const FIXTURES_DIR = resolve(APP_DIR, 'fixtures/candles');
const REQUEST_PATH = resolve(APP_DIR, 'test/fixtures/overlay/requests/universe-multi.json');
const BUNDLE_PATH = resolve(APP_DIR, 'test/fixtures/overlay/bundles/short-after-pump.bundle.json');

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Канонический байт ленты: событийная форма плюс модель покрытия.
 *
 * `toTape()` несёт свечи и снимки в фиксированном порядке, `coverage()` — то, чего в ленте НЕТ
 * (какие виды отсутствуют и где разрывы). Второе без первого не заметило бы потерянных значений,
 * первое без второго — потерянной целиком колонки: отсутствующий вид не даёт ни одного события, и
 * `toTape()` у ленты с ним и без него совпадает буква в букву.
 */
function tapeBytes(tape: MarketTapeDataset): string {
  return canonicalJson({ tape: tape.toTape(), coverage: tape.coverage(), symbols: tape.symbols() });
}

// --- СЛОЙ 1: эквивалентность ленты на всех видах ---------------------------------------------------

describe('гейт колонок — лента из колонок эквивалентна исходной', () => {
  /** Фикстура, несущая ВСЕ необязательные виды: ни одна фикстура репозитория их не несёт. */
  function writeRichFixture(): { dir: string; datasetRef: string; rows: CanonicalRowV2[] } {
    const dir = mkdtempSync(join(tmpdir(), 'tcp-rich-'));
    tempDirs.push(dir);
    const datasetRef = 'tcp-rich-1m';
    const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);
    const rows: CanonicalRowV2[] = [];
    for (const symbol of ['AAAUSDT', 'BBBUSDT']) {
      for (let i = 0; i < 30; i += 1) {
        const px = 100 + Math.sin(i / 4) * 3;
        // Виды намеренно РАЗРЕЖЕНЫ и по-разному: oi через бар, funding раз в десять, liq только у
        // одного символа, taker с present-zero. Плотная лента, где всё есть на каждой минуте, не
        // отличила бы «потеряли разрыв» от «всё на месте».
        const hasOi = i % 2 === 0;
        const hasFunding = i % 10 === 3;
        const hasLiq = symbol === 'AAAUSDT' && i % 7 === 1;
        const hasTaker = i % 3 === 0;
        rows.push({
          schema_version: 2,
          minute_ts: T0 + i * 60_000,
          symbol,
          open: px,
          high: px + 0.5,
          low: px - 0.5,
          close: px + 0.25,
          volume: 1_000 + i,
          turnover: 100_000 + i,
          oi_total_usd: hasOi ? 5_000_000 + i * 1_000 : null,
          has_oi: hasOi,
          funding_rate: hasFunding ? (i % 20 === 3 ? 0.0001 : -0.0002) : null,
          has_funding: hasFunding,
          liq_long_usd: hasLiq ? 12_345.5 : null,
          liq_short_usd: hasLiq ? 6_789.25 : null,
          has_liquidations: hasLiq,
          // present-zero: наблюдение есть, значение ноль — это НЕ отсутствие.
          taker_buy_volume_usd: hasTaker ? (i % 6 === 0 ? 0 : 42_000 + i) : null,
          taker_sell_volume_usd: hasTaker ? (i % 6 === 0 ? 0 : 41_000 + i) : null,
          has_taker_flow: hasTaker,
        });
      }
    }
    writeFileSync(join(dir, `${datasetRef}.json`), JSON.stringify({ datasetRef, timeframe: '1m', rows }));
    return { dir, datasetRef, rows };
  }

  it('все виды: канонический байт ленты и модели покрытия совпадает', async () => {
    const { dir, datasetRef } = writeRichFixture();
    const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);

    // Через ПРОДОВУЮ точку входа и ПРОДОВЫЙ кэш — не через прямой вызов кодировщика.
    __resetTapeCachesForTest();
    const key = tapeCacheKey({
      datasetRef,
      symbols: ['AAAUSDT', 'BBBUSDT'],
      timeframe: '1m',
      from: new Date(T0).toISOString(),
      to: new Date(T0 + 30 * 60_000).toISOString(),
    });
    const materialized = await overlayTapeCache.getOrBuild(key, () =>
      buildOverlayDatasetWithColumns(new FixtureDataPort(dir), {
        datasetRef,
        symbols: ['AAAUSDT', 'BBBUSDT'],
        timeframe: '1m',
        period: { from: new Date(T0).toISOString(), to: new Date(T0 + 30 * 60_000).toISOString() },
      }),
    );

    expect(materialized.columns).toBeDefined();
    const cols = materialized.columns!;
    // Сравнение двух пустых лент прошло бы «успешно» и не доказало бы ничего — поэтому непустота
    // проверяется отдельно и до сравнения.
    expect(cols.rowCount).toBe(60);
    expect(materialized.tape.symbols()).toEqual(['AAAUSDT', 'BBBUSDT']);
    // Метки ленты едут ВНУТРИ колонок — иначе поток мог бы получить колонки от одной ленты и
    // таймфрейм от другой, обойдя привязку к дескриптору (P2-19).
    expect(cols.datasetRef).toBe(datasetRef);
    expect(cols.timeframe).toBe('1m');
    // Все четыре вида должны присутствовать — иначе фикстура не проверяет то, ради чего написана.
    expect(cols.oi).toBeDefined();
    expect(cols.funding).toBeDefined();
    expect(cols.liq).toBeDefined();
    expect(cols.taker).toBeDefined();

    expect(tapeBytes(tapeFromColumns(cols))).toBe(tapeBytes(materialized.tape));
  });

  it('лента только со свечами: отсутствие вида переживает круг и не становится пустым видом', async () => {
    // Разница между «вида нет» и «вид есть, но пуст» не видна в `toTape()` — ни то ни другое не
    // даёт событий. Видна она в `coverage()`, и потому сравнение идёт по обоим.
    //
    // Селектор берётся ИЗ ФИКСТУРЫ ЗАПРОСА, а не пишется здесь руками. Первая редакция теста
    // выставила период на год мимо данных, лента вышла пустой с обеих сторон, и сравнение прошло —
    // доказав ровно ничего. Отсюда же и проверка непустоты ниже: сравнение двух пустот обязано
    // падать, а не считаться паритетом.
    const port = new FixtureDataPort(FIXTURES_DIR);
    const sel = JSON.parse(readFileSync(REQUEST_PATH, 'utf8')) as {
      symbols: string[];
      timeframe: string;
      datasetRef: string;
      period: { from: string; to: string };
    };
    const { tape, columns } = await buildOverlayDatasetWithColumns(port, {
      datasetRef: sel.datasetRef,
      symbols: sel.symbols,
      timeframe: sel.timeframe,
      period: sel.period,
    });
    expect(columns).toBeDefined();
    expect(columns!.rowCount).toBeGreaterThan(0);
    expect(tape.symbols().length).toBe(sel.symbols.length);
    expect(columns!.oi).toBeUndefined();
    expect(columns!.taker).toBeUndefined();

    const rebuilt = tapeFromColumns(columns!);
    expect(tapeBytes(rebuilt)).toBe(tapeBytes(tape));
    // Прямая проверка того, что стоит за байтом: вид отсутствует, а не пуст.
    const oiEntry = rebuilt.coverage().entries.find((e) => e.kind === 'openInterest');
    expect(oiEntry?.present).toBe(false);
  });

  it('колонки переживают structured clone — то, что делает с ними граница потока', () => {
    // Проверяется отдельно от прогона, потому что отказ здесь выглядел бы как «поток дал другой
    // результат», а причина была бы в переносе, а не в исполнении.
    const rows: CanonicalRowV2[] = [
      {
        schema_version: 2,
        minute_ts: Date.UTC(2024, 0, 1),
        symbol: 'AAAUSDT',
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 10,
        turnover: 15,
        oi_total_usd: 777,
        has_oi: true,
        funding_rate: -0.0001,
        has_funding: true,
        liq_long_usd: null,
        liq_short_usd: 3,
        has_liquidations: true,
        taker_buy_volume_usd: 0,
        taker_sell_volume_usd: 0,
        has_taker_flow: true,
      },
    ];
    const cols = encodeTapeColumns('ds', '1m', rows);
    const cloned = structuredClone(cols);
    // Исходные буферы ОБЯЗАНЫ остаться живыми: колонки лежат в разделяемом кэше, и перенос
    // (в отличие от копии) опустошил бы запись для следующего прогона.
    expect(cols.minuteTs.length).toBe(1);
    expect(tapeBytes(tapeFromColumns(cloned))).toBe(tapeBytes(tapeFromColumns(cols)));
  });
});

// --- СЛОЙ 2: паритет прогона через настоящий поток -------------------------------------------------

/**
 * Поток грузит свой граф только под Node 24 — и это ЗАМЕРЕНО, а не предположено.
 *
 * Под Node 22 хуки tsx в worker_thread не активируются ни при какой передаче `execArgv`: `.mts`
 * разбирает встроенный стриппер типов Node, а переотображение `.js`→`.ts` при импорте — фича именно
 * tsx — не происходит, и первый же `import('../runner.js')` внутри потока падает с
 * `Cannot find module`. Решающая проверка: с `--no-experimental-strip-types` поток отвечает
 * «Unknown file extension .mts», то есть tsx там не живёт вовсе.
 *
 * Это ограничение НЕ теста, а всей затеи с потоком: прод-образ — `node:22-slim`, CI тоже на 22,
 * и до перевода их на Node 24 путь потока в проде нерабочий. Пропуск здесь не прячет проблему —
 * он её называет; сама проблема открыта отдельным вопросом к владельцу.
 */
const THREAD_SEAM_LOADS = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 24;

describe.skipIf(!THREAD_SEAM_LOADS)('гейт колонок — прогон по колонкам в потоке даёт тот же result_hash', () => {
  it(
    'один запрос, две дороги, один хэш',
    async () => {
      const request = JSON.parse(readFileSync(REQUEST_PATH, 'utf8')) as {
        symbols: string[];
        timeframe: string;
        datasetRef: string;
        period: { from: string; to: string };
      };
      const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));
      const sp = await materializeReadableBundle(bundle);

      // ОДНА запись кэша кормит обе дороги — именно так это будет в проде: лента строится один раз,
      // главный поток считает по ней отпечаток, поток получает её колонки.
      __resetTapeCachesForTest();
      const materialized = await overlayTapeCache.getOrBuild(
        tapeCacheKey({
          datasetRef: request.datasetRef,
          symbols: request.symbols,
          timeframe: request.timeframe,
          from: request.period.from,
          to: request.period.to,
        }),
        () =>
          buildOverlayDatasetWithColumns(new FixtureDataPort(FIXTURES_DIR), {
            datasetRef: request.datasetRef,
            symbols: request.symbols,
            timeframe: request.timeframe,
            period: request.period,
          }),
      );
      expect(materialized.columns).toBeDefined();

      // Дорога 1 — главный поток, лента из кэша, изолятный бэкенд.
      const { registry, router } = buildSandboxStrategyBaselineDeps({ spDir: sp.bundleDir, sandboxBackend: 'isolate' });
      let mainHash: string;
      try {
        const out = await runBacktest(request as never, { registry, router, marketTape: materialized.tape } as never);
        const errors = router.errors();
        expect(errors, `ошибки песочницы на главном потоке: ${JSON.stringify(errors).slice(0, 600)}`).toEqual([]);
        mainHash = resultHash(out);
      } finally {
        router.closeAll();
      }

      // Дорога 2 — отдельный поток, КОЛОНКИ из той же записи кэша.
      //
      // `execArgv` задаётся явно: vitest трансформирует TypeScript своим конвейером и не кладёт
      // загрузчик в `process.execArgv`, поэтому унаследованный набор оставил бы поток без
      // возможности импортировать исходники. В проде entry — собранный `.mjs`, и загрузчик не нужен.
      const threaded = await runBacktestInThread(
        {
          request,
          bundleDir: sp.bundleDir,
          sandboxBackend: 'isolate',
          dataPort: { kind: 'columns', columns: materialized.columns! },
        },
        { execArgv: ['--import', 'tsx'] },
      );
      expect(
        threaded.sandboxErrors,
        `ошибки песочницы в потоке: ${JSON.stringify(threaded.sandboxErrors).slice(0, 600)}`,
      ).toEqual([]);

      expect(resultHash(threaded.result as never)).toBe(mainHash);

      // Запись кэша обязана пережить прогон: если бы колонки уехали переносом, а не копией, буферы
      // здесь оказались бы отсоединёнными — и следующий прогон получил бы пустую ленту молча.
      expect(materialized.columns!.minuteTs.length).toBeGreaterThan(0);
      expect(tapeBytes(tapeFromColumns(materialized.columns!))).toBe(tapeBytes(materialized.tape));
    },
    180_000,
  );
});
