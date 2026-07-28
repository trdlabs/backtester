import { describe, expect, it } from 'vitest';

import { assertStableSamples, countCpusInList, evaluateBenchEnvironment, minOf } from '../scripts/lib/bench-gate.js';

const QUIET = {
  loadavg1: 0.4,
  cores: 4,
  allowedCpus: 2,
  maxLoadavg: 2,
  allowUnpinned: false,
} as const;

describe('bench-gate', () => {
  it('пропускает тихий закреплённый стенд', () => {
    expect(evaluateBenchEnvironment(QUIET)).toEqual({ ok: true, reasons: [] });
  });

  it('отказывает при load average выше порога', () => {
    const verdict = evaluateBenchEnvironment({ ...QUIET, loadavg1: 2.01 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('load average');
  });

  it('порог — это «выше», а не «не ниже»: ровно на пороге замер ещё валиден', () => {
    expect(evaluateBenchEnvironment({ ...QUIET, loadavg1: 2 }).ok).toBe(true);
  });

  it('отказывает незакреплённому процессу', () => {
    const verdict = evaluateBenchEnvironment({ ...QUIET, allowedCpus: 4 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('taskset');
  });

  it('BENCH_ALLOW_UNPINNED снимает только проверку аффинити, но не проверку нагрузки', () => {
    expect(evaluateBenchEnvironment({ ...QUIET, allowedCpus: 4, allowUnpinned: true }).ok).toBe(true);
    const loaded = evaluateBenchEnvironment({
      ...QUIET,
      allowedCpus: 4,
      allowUnpinned: true,
      loadavg1: 9,
    });
    expect(loaded.ok).toBe(false);
    expect(loaded.reasons).toHaveLength(1);
  });

  it('копит все причины отказа, а не первую', () => {
    const verdict = evaluateBenchEnvironment({ ...QUIET, loadavg1: 9, allowedCpus: 4 });
    expect(verdict.reasons).toHaveLength(2);
  });

  it('разбирает Cpus_allowed_list с диапазонами и перечислением', () => {
    expect(countCpusInList('0-3')).toBe(4);
    expect(countCpusInList('2,3')).toBe(2);
    expect(countCpusInList('0-1,3')).toBe(3);
    expect(countCpusInList(' 0 ')).toBe(1);
  });

  describe('assertStableSamples — воспроизводимость минимума', () => {
    // Гейт завершает процесс, поэтому проверяем через подмену exit: тест не должен уметь
    // «пройти» просто потому, что процесс умер.
    function verdictOf(samples: readonly number[], maxDrift?: number): 'ok' | 'rejected' {
      const realExit = process.exit;
      const realError = console.error;
      let rejected = false;
      process.exit = (() => {
        rejected = true;
        throw new Error('__exit__');
      }) as typeof process.exit;
      console.error = () => {};
      try {
        assertStableSamples('test', samples, maxDrift);
      } catch (e) {
        if (!(e instanceof Error) || e.message !== '__exit__') throw e;
      } finally {
        process.exit = realExit;
        console.error = realError;
      }
      return rejected ? 'rejected' : 'ok';
    }

    it('пропускает воспроизводимый минимум, несмотря на широкий размах max/min', () => {
      // Ровно случай аллоцирующего станка: максимумы разъехались втрое (GC), но минимум
      // половин один и тот же — оценка воспроизводима, отказывать не за что.
      expect(verdictOf([100, 300, 101, 290])).toBe('ok');
    });

    it('отказывает, когда минимум половин разъехался', () => {
      expect(verdictOf([100, 101, 140, 145])).toBe('rejected');
    });

    it('молчит на выборке короче четырёх — половинки не несут информации', () => {
      expect(verdictOf([100, 999, 100])).toBe('ok');
    });

    it('допуск настраивается', () => {
      expect(verdictOf([100, 100, 120, 120], 1.5)).toBe('ok');
      expect(verdictOf([100, 100, 120, 120], 1.05)).toBe('rejected');
    });
  });

  it('minOf берёт минимум, а не первый или средний', () => {
    expect(minOf([9, 3, 7])).toBe(3);
    expect(() => minOf([])).toThrow(/нет ни одного замера/);
  });
});
