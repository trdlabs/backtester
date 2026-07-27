import { describe, expect, it } from 'vitest';

import { countCpusInList, evaluateBenchEnvironment, minOf } from '../scripts/lib/bench-gate.js';

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

  it('minOf берёт минимум, а не первый или средний', () => {
    expect(minOf([9, 3, 7])).toBe(3);
    expect(() => minOf([])).toThrow(/нет ни одного замера/);
  });
});
