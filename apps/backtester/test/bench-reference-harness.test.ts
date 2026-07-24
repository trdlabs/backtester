// Юниты чистой части бенчмарк-станка (control-center `dark-flag-validation`, item 3).
// Сам Docker-прогон в CI не ассертится — как и `bench-workers.mts`, это измерительный скрипт.
// Здесь проверяется всё, что может тихо соврать в отчёте: матрица вариантов, разбор IPC-профиля,
// агрегация повторов и вердикт byte-identity.

import { describe, expect, it } from 'vitest';
import {
  IDENTITY_BASELINE,
  VARIANTS,
  formatBenchMarkdown,
  identityVerdict,
  median,
  parseIpcProfileLine,
  parseVariants,
  sumIpcProfiles,
  type IpcProfile,
  type RepeatSample,
} from '../scripts/lib/bench-reference.js';

const ipc = (o: Partial<IpcProfile> = {}): IpcProfile => ({
  hookCalls: 0,
  symbolInits: 0,
  barMajorBatches: 0,
  ipcWaitMs: 0,
  openMs: 0,
  ...o,
});
const sample = (wallMs: number, resultHash: string): RepeatSample => ({ wallMs, resultHash, ipc: ipc() });

describe('parseVariants', () => {
  it('по умолчанию — все четыре варианта, baseline первым', () => {
    expect(parseVariants(undefined)).toEqual(['off', 'bar_batching', 'bar_major', 'bar_major_batch']);
  });

  it('разбирает список через запятую и всегда ставит off первым', () => {
    expect(parseVariants('bar_major,off')).toEqual(['off', 'bar_major']);
    expect(parseVariants('bar_major_batch')).toEqual(['off', 'bar_major_batch']);
  });

  it('падает на неизвестном имени с внятным сообщением', () => {
    expect(() => parseVariants('turbo')).toThrow(/неизвестный вариант: turbo/);
  });
});

describe('VARIANTS', () => {
  it('взаимоисключимость barBatching и barMajor соблюдена во всех вариантах', () => {
    for (const v of Object.values(VARIANTS)) expect(v.barBatching && v.barMajor).toBe(false);
  });

  it('bar_major_batch — чистый суб-режим bar_major', () => {
    expect(VARIANTS.bar_major_batch).toEqual({ barBatching: false, barMajor: true, barMajorBatch: true });
  });
});

describe('parseIpcProfileLine', () => {
  it('разбирает строку профиля сессии', () => {
    const line = JSON.stringify({
      evt: 'ipc_profile',
      kind: 'strategy',
      symbol: 'BTCUSDT',
      hookCalls: 10,
      symbolInits: 1,
      barMajorBatches: 4,
      ipcWaitMs: 250,
      openMs: 900,
    });
    expect(parseIpcProfileLine(line)).toEqual(
      ipc({ hookCalls: 10, symbolInits: 1, barMajorBatches: 4, ipcWaitMs: 250, openMs: 900 }),
    );
  });

  it('игнорирует посторонние строки, не-JSON и чужие события', () => {
    expect(parseIpcProfileLine('[config] что-то')).toBeUndefined();
    expect(parseIpcProfileLine('{битый json')).toBeUndefined();
    expect(parseIpcProfileLine(JSON.stringify({ evt: 'other', hookCalls: 5 }))).toBeUndefined();
  });
});

describe('sumIpcProfiles / median', () => {
  it('складывает профили по всем сессиям', () => {
    expect(sumIpcProfiles([ipc({ hookCalls: 3, ipcWaitMs: 10 }), ipc({ hookCalls: 4, ipcWaitMs: 5 })])).toEqual(
      ipc({ hookCalls: 7, ipcWaitMs: 15 }),
    );
  });

  it('медиана нечётной и чётной выборки', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('identityVerdict', () => {
  it('`bar_batching` сверяется с `off`, `bar_major_batch` — с `bar_major`', () => {
    expect(IDENTITY_BASELINE).toEqual({
      off: 'off',
      bar_batching: 'off',
      bar_major: 'bar_major',
      bar_major_batch: 'bar_major',
    });
  });

  it('PASS: транспортные флаги повторили свои референсы', () => {
    const v = identityVerdict([
      { variant: 'off', samples: [sample(100, 'h1'), sample(110, 'h1')] },
      { variant: 'bar_batching', samples: [sample(90, 'h1')] },
      { variant: 'bar_major', samples: [sample(80, 'hBM')] },
      { variant: 'bar_major_batch', samples: [sample(70, 'hBM')] },
    ]);
    expect(v.pass).toBe(true);
    expect(v.mismatches).toEqual([]);
    expect(v.baselineHashes).toEqual({ off: 'h1', bar_major: 'hBM' });
  });

  it('семантическое расхождение bar_major с off НЕ считается нарушением byte-identity', () => {
    const v = identityVerdict([
      { variant: 'off', samples: [sample(100, 'h1')] },
      { variant: 'bar_major', samples: [sample(80, 'hBM')] },
    ]);
    expect(v.pass).toBe(true);
  });

  it('FAIL: bar_major_batch разошёлся со своим референсом bar_major', () => {
    const v = identityVerdict([
      { variant: 'off', samples: [sample(100, 'h1')] },
      { variant: 'bar_major', samples: [sample(80, 'hBM')] },
      { variant: 'bar_major_batch', samples: [sample(70, 'hX')] },
    ]);
    expect(v.pass).toBe(false);
    expect(v.mismatches).toEqual([{ variant: 'bar_major_batch', hash: 'hX', baseline: 'bar_major', expected: 'hBM' }]);
  });

  it('FAIL: bar_batching разошёлся с off (транспортный флаг обязан быть прозрачным)', () => {
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
    expect(v.mismatches).toEqual([{ variant: 'off', hash: 'hX', baseline: 'off', expected: 'h1' }]);
  });

  it('вариант без своего референса в выборке помечается unanchored и сверяется сам с собой', () => {
    const v = identityVerdict([{ variant: 'bar_major_batch', samples: [sample(70, 'hX'), sample(71, 'hX')] }]);
    expect(v.pass).toBe(true);
    expect(v.unanchored).toEqual(['bar_major_batch']);
  });

  it('пустая выборка — ошибка', () => {
    expect(() => identityVerdict([])).toThrow(/сверять byte-identity не с чем/);
  });
});

describe('formatBenchMarkdown', () => {
  it('печатает speedup к baseline и вердикт', () => {
    const md = formatBenchMarkdown(
      [
        { variant: 'off', samples: [sample(200, 'h1')] },
        { variant: 'bar_major_batch', samples: [sample(100, 'h1')] },
      ],
      { request: 'universe-multi.json', bundle: 'short-after-pump.bundle.json', symbols: 3, repeats: 1, host: 'wsl2 4 cores' },
    );
    expect(md).toContain('2.00×');
    expect(md).toContain('byte-identity: PASS');
  });

  it('на расхождении печатает FAIL и список вариантов', () => {
    const md = formatBenchMarkdown(
      [
        { variant: 'off', samples: [sample(200, 'h1')] },
        { variant: 'bar_batching', samples: [sample(100, 'h2')] },
      ],
      { request: 'r.json', bundle: 'b.json', symbols: 3, repeats: 1, host: 'test' },
    );
    expect(md).toContain('byte-identity: FAIL');
    expect(md).toContain('`bar_batching` → `h2`');
  });

  it('расхождение bar_major с off выносится отдельной строкой как смена модели, а не как FAIL', () => {
    const md = formatBenchMarkdown(
      [
        { variant: 'off', samples: [sample(200, 'h1')] },
        { variant: 'bar_major', samples: [sample(300, 'hBM')] },
      ],
      { request: 'r.json', bundle: 'b.json', symbols: 3, repeats: 1, host: 'test' },
    );
    expect(md).toContain('byte-identity: PASS');
    expect(md).toContain('ОТЛИЧАЕТСЯ от `off` побайтово');
  });
});
