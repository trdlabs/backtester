// Юниты чистой части бенчмарк-станка (control-center `dark-flag-validation`, item 3).
// Сам Docker-прогон в CI не ассертится — как и `bench-workers.mts`, это измерительный скрипт.
//
// Тесты писались по следам ревью PR #160, где выяснилось, что станок мерил не то, что обещал:
// `barBatching` передавался как `boolean` вместо `{ maxBars }`, а Slice B гонялся без
// universe-сессии, без которой коллапс невозможен. Оба флага молча исполняли baseline, а таблица
// показывала PASS. Поэтому здесь пиннится ровно то, что тогда не было закрыто:
//   1. оверрайды вариантов присваиваемы РЕАЛЬНОМУ `RunDeps` (тип-левел тест ловит ту самую ошибку);
//   2. `engagementProblem` объявляет прогон недействительным, если флаг не оставил следа;
//   3. `parseVariants` дотягивает транзитивный референс, а не жёстко `off`.

import { describe, expect, it } from 'vitest';
import type { RunDeps } from '../src/engine/runner.js';
import {
  BATCH_MAX_BARS,
  IDENTITY_BASELINE,
  VARIANTS,
  engagementProblem,
  formatBenchMarkdown,
  identityVerdict,
  median,
  parseIpcProfileLine,
  parseVariants,
  sumIpcProfiles,
  type IpcProfile,
  type RepeatSample,
  type VariantName,
} from '../scripts/lib/bench-reference.js';

const ipc = (o: Partial<IpcProfile> = {}): IpcProfile => ({
  hookCalls: 0,
  symbolInits: 0,
  barMajorBatches: 0,
  hookBatches: 0,
  ipcWaitMs: 0,
  openMs: 0,
  ...o,
});
const sample = (wallMs: number, resultHash: string, o: Partial<RepeatSample> = {}): RepeatSample => ({
  wallMs,
  resultHash,
  ipc: ipc(),
  sessions: 1,
  ...o,
});

describe('VARIANTS', () => {
  // Тот самый тест, которого не хватало: `{ barBatching: true }` здесь не скомпилировалось бы.
  it('оверрайды каждого варианта присваиваемы RunDeps движка', () => {
    const asDeps: Partial<RunDeps>[] = Object.values(VARIANTS).map((v) => v.run);
    expect(asDeps).toHaveLength(5);
  });

  it('17b передаётся как { maxBars }, а не boolean', () => {
    expect(VARIANTS.bar_batching.run.barBatching).toEqual({ maxBars: BATCH_MAX_BARS });
    expect(BATCH_MAX_BARS).toBeGreaterThanOrEqual(2); // ниже 2 движок батч не берёт (runner.ts)
  });

  it('Slice B гоняется с universe — без неё коллапс транспорта невозможен', () => {
    expect(VARIANTS.bar_major_batch.routerUniverse).toBe(true);
    expect(VARIANTS.bar_major_batch.run.universe?.enabled).toBe(true);
    expect(VARIANTS.bar_major_batch.run.barMajorBatch).toBe(true);
  });

  it('есть отдельный вариант universe-без-batch, иначе эффекты 17c и Slice B смешаны', () => {
    expect(VARIANTS.bar_major_universe.routerUniverse).toBe(true);
    expect(VARIANTS.bar_major_universe.run.barMajorBatch).toBeUndefined();
    expect(IDENTITY_BASELINE.bar_major_batch).toBe('bar_major_universe');
  });

  it('взаимоисключимость barBatching и barMajor соблюдена во всех вариантах', () => {
    for (const v of Object.values(VARIANTS)) {
      expect(v.run.barBatching !== undefined && v.run.barMajor === true).toBe(false);
    }
  });
});

describe('parseVariants', () => {
  it('по умолчанию — все пять вариантов, baseline первым', () => {
    expect(parseVariants(undefined)).toEqual([
      'off',
      'bar_batching',
      'bar_major',
      'bar_major_universe',
      'bar_major_batch',
    ]);
  });

  it('дотягивает ТРАНЗИТИВНЫЙ референс запрошенного варианта', () => {
    // bar_major_batch → bar_major_universe → bar_major. Без замыкания вариант остался бы без якоря
    // и сверился бы сам с собой, отрапортовав PASS даже на сломанном Slice B.
    expect(parseVariants('bar_major_batch')).toEqual(['bar_major', 'bar_major_universe', 'bar_major_batch']);
    expect(parseVariants('bar_batching')).toEqual(['off', 'bar_batching']);
  });

  it('пустая строка и пустые сегменты не ломают разбор', () => {
    expect(parseVariants('')).toHaveLength(5);
    expect(parseVariants('off,,bar_major, off ')).toEqual(['off', 'bar_major']);
  });

  it('падает на неизвестном имени с внятным сообщением', () => {
    expect(() => parseVariants('turbo')).toThrow(/неизвестный вариант: turbo/);
  });
});

describe('engagementProblem — флаг обязан оставить след', () => {
  it('17b без единого отправленного батча — недействительный замер', () => {
    expect(engagementProblem('bar_batching', sample(100, 'h'), 'h')).toMatch(/hookBatches=0/);
    expect(engagementProblem('bar_batching', sample(100, 'h', { ipc: ipc({ hookBatches: 7 }) }), 'h')).toBeUndefined();
  });

  it('Slice B без barMajorBatches — недействительный замер', () => {
    expect(engagementProblem('bar_major_batch', sample(100, 'h'), 'h')).toMatch(/barMajorBatches=0/);
    expect(
      engagementProblem('bar_major_batch', sample(100, 'h', { ipc: ipc({ barMajorBatches: 30 }) }), 'h'),
    ).toBeUndefined();
  });

  it('bar_major, совпавший с off, — признак невключённого флага (счётчика у него нет)', () => {
    expect(engagementProblem('bar_major', sample(100, 'hOFF'), 'hOFF')).toMatch(/не сработал/);
    expect(engagementProblem('bar_major', sample(100, 'hBM'), 'hOFF')).toBeUndefined();
  });

  it('universe-вариант обязан собрать одну сессию на несколько символов', () => {
    expect(engagementProblem('bar_major_universe', sample(100, 'h', { sessions: 1 }), 'hOFF')).toBeUndefined();
    expect(
      engagementProblem('bar_major_universe', sample(100, 'h', { sessions: 3, ipc: ipc({ symbolInits: 1 }) }), 'hOFF'),
    ).toMatch(/universe-сессия не собралась/);
  });

  it('baseline всегда «задействован»', () => {
    expect(engagementProblem('off', sample(100, 'h'), 'h')).toBeUndefined();
  });
});

describe('parseIpcProfileLine', () => {
  it('разбирает строку профиля сессии, включая счётчик батчей 17b', () => {
    const line = JSON.stringify({
      evt: 'ipc_profile',
      kind: 'strategy',
      symbol: 'BTCUSDT',
      hookCalls: 10,
      symbolInits: 1,
      barMajorBatches: 4,
      hookBatches: 2,
      ipcWaitMs: 250,
      openMs: 900,
      avgIpcWaitMsPerHook: 25, // лишнее поле движка не мешает
    });
    expect(parseIpcProfileLine(line)).toEqual(
      ipc({ hookCalls: 10, symbolInits: 1, barMajorBatches: 4, hookBatches: 2, ipcWaitMs: 250, openMs: 900 }),
    );
  });

  it('отсутствующие и нечисловые поля становятся нулями, а не NaN', () => {
    const line = JSON.stringify({ evt: 'ipc_profile', hookCalls: 'много', barMajorBatches: null });
    expect(parseIpcProfileLine(line)).toEqual(ipc());
  });

  it('игнорирует посторонние строки, не-JSON и чужие события', () => {
    expect(parseIpcProfileLine('[config] что-то')).toBeUndefined();
    expect(parseIpcProfileLine('{битый json')).toBeUndefined();
    expect(parseIpcProfileLine(JSON.stringify({ evt: 'other', hookCalls: 5 }))).toBeUndefined();
  });
});

describe('sumIpcProfiles / median', () => {
  it('складывает профили по всем сессиям', () => {
    expect(sumIpcProfiles([ipc({ hookCalls: 3, hookBatches: 1 }), ipc({ hookCalls: 4, ipcWaitMs: 5 })])).toEqual(
      ipc({ hookCalls: 7, hookBatches: 1, ipcWaitMs: 5 }),
    );
  });

  it('медиана нечётной и чётной выборки; пустая — NaN', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('identityVerdict', () => {
  it('референсы заданы по флагу, а не «всё против off»', () => {
    expect(IDENTITY_BASELINE).toEqual({
      off: 'off',
      bar_batching: 'off',
      bar_major: 'bar_major',
      bar_major_universe: 'bar_major',
      bar_major_batch: 'bar_major_universe',
    });
  });

  it('PASS: транспортные флаги повторили свои референсы', () => {
    const v = identityVerdict([
      { variant: 'off', samples: [sample(100, 'h1'), sample(110, 'h1')] },
      { variant: 'bar_batching', samples: [sample(90, 'h1')] },
      { variant: 'bar_major', samples: [sample(80, 'hBM')] },
      { variant: 'bar_major_universe', samples: [sample(75, 'hBM')] },
      { variant: 'bar_major_batch', samples: [sample(70, 'hBM')] },
    ]);
    expect(v.pass).toBe(true);
    expect(v.unanchored).toEqual([]);
  });

  it('семантическое расхождение bar_major с off НЕ считается нарушением byte-identity', () => {
    const v = identityVerdict([
      { variant: 'off', samples: [sample(100, 'h1')] },
      { variant: 'bar_major', samples: [sample(80, 'hBM')] },
    ]);
    expect(v.pass).toBe(true);
  });

  it('FAIL: Slice B разошёлся со своим референсом', () => {
    const v = identityVerdict([
      { variant: 'bar_major', samples: [sample(80, 'hBM')] },
      { variant: 'bar_major_universe', samples: [sample(75, 'hBM')] },
      { variant: 'bar_major_batch', samples: [sample(70, 'hX')] },
    ]);
    expect(v.pass).toBe(false);
    expect(v.mismatches).toEqual([
      { variant: 'bar_major_batch', hash: 'hX', baseline: 'bar_major_universe', expected: 'hBM' },
    ]);
  });

  it('FAIL: 17b разошёлся с off (транспортный флаг обязан быть прозрачным)', () => {
    const v = identityVerdict([
      { variant: 'off', samples: [sample(100, 'h1')] },
      { variant: 'bar_batching', samples: [sample(90, 'h2')] },
    ]);
    expect(v.pass).toBe(false);
    expect(v.mismatches).toEqual([{ variant: 'bar_batching', hash: 'h2', baseline: 'off', expected: 'h1' }]);
  });

  it('нестабильность между повторами — тоже FAIL', () => {
    const v = identityVerdict([{ variant: 'off', samples: [sample(100, 'h1'), sample(100, 'hX')] }]);
    expect(v.pass).toBe(false);
  });

  it('вариант без своего референса помечается unanchored (вердикт неполный)', () => {
    const v = identityVerdict([{ variant: 'bar_major_batch', samples: [sample(70, 'hX'), sample(71, 'hX')] }]);
    expect(v.unanchored).toEqual(['bar_major_batch']);
  });

  it('пустая выборка — ошибка', () => {
    expect(() => identityVerdict([])).toThrow(/сверять byte-identity не с чем/);
  });
});

describe('formatBenchMarkdown', () => {
  const meta = { request: 'r.json', bundle: 'b.json', symbols: 3, repeats: 1, host: 'test' };

  it('печатает вердикт, самосравнение помечает отдельно от проверки', () => {
    const md = formatBenchMarkdown(
      [
        { variant: 'off', samples: [sample(200, 'h1')] },
        { variant: 'bar_major', samples: [sample(100, 'hBM')] },
      ],
      meta,
    );
    expect(md).toContain('byte-identity: PASS');
    expect(md).toContain('— (сам с собой)'); // bar_major не «проверен», а «стабилен»
    expect(md).toContain('отличается от `off` побайтово');
  });

  it('невключённый флаг виден в таблице колонкой «флаг задействован»', () => {
    const md = formatBenchMarkdown(
      [
        { variant: 'off', samples: [sample(200, 'h1')] },
        { variant: 'bar_batching', samples: [sample(190, 'h1')] }, // hookBatches=0 → не задействован
      ],
      meta,
    );
    const row = md.split('\n').find((l) => l.startsWith('| `bar_batching`'))!;
    expect(row).toContain('❌');
  });

  it('на расхождении печатает FAIL и список вариантов', () => {
    const md = formatBenchMarkdown(
      [
        { variant: 'off', samples: [sample(200, 'h1')] },
        { variant: 'bar_batching', samples: [sample(100, 'h2', { ipc: ipc({ hookBatches: 3 }) })] },
      ],
      meta,
    );
    expect(md).toContain('byte-identity: FAIL');
    expect(md).toContain('`bar_batching` → `h2`');
  });

  it('bar_major, совпавший с off, помечается предупреждением, а не тишиной', () => {
    const md = formatBenchMarkdown(
      [
        { variant: 'off', samples: [sample(200, 'h1')] },
        { variant: 'bar_major', samples: [sample(210, 'h1')] },
      ],
      meta,
    );
    expect(md).toContain('флаг НЕ сработал');
  });

  it('вариант без сэмплов не роняет таблицу', () => {
    const variants: { variant: VariantName; samples: RepeatSample[] }[] = [
      { variant: 'off', samples: [sample(200, 'h1')] },
      { variant: 'bar_batching', samples: [] },
    ];
    expect(() => formatBenchMarkdown(variants, meta)).not.toThrow();
  });
});
