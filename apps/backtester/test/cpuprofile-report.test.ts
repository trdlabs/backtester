// Юниты чистой части перф-станка раннера (`scripts/lib/cpuprofile-report.ts`).
//
// Разбор `.cpuprofile` — это арифметика по семплам, и ошибиться в ней легко и незаметно: таблица
// всё равно напечатается, просто с неверными долями, и решение о Rust-ядре будет принято по кривым
// числам. Тот же урок, что вынес `bench-reference.ts` в ревью PR #160 (станок молча отрапортовал
// PASS по невключённым флагам), поэтому разбор покрыт отдельно от тяжёлого прогона.

import { describe, expect, it } from 'vitest';
import { shortenUrl, summarizeCpuProfile } from '../scripts/lib/cpuprofile-report.js';

/** Минимальный валидный V8-профиль: два узла, заданные дельты. */
function makeProfile(): unknown {
  return {
    startTime: 1_000,
    endTime: 11_000,
    nodes: [
      { id: 1, callFrame: { functionName: 'hot', url: 'file:///repo/apps/backtester/src/engine/context.ts', lineNumber: 41 } },
      { id: 2, callFrame: { functionName: '', url: 'file:///repo/apps/backtester/src/engine/runner.ts', lineNumber: 0 } },
      { id: 3, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
    ],
    samples: [1, 1, 2, 3],
    timeDeltas: [3_000, 3_000, 2_000, 2_000],
  };
}

describe('summarizeCpuProfile', () => {
  it('складывает self-time по узлу и считает доли от учтённого времени', () => {
    const s = summarizeCpuProfile(makeProfile(), { top: 10 });

    expect(s.sampledMs).toBe(10);
    const hot = s.byFunction.find((r) => r.functionName === 'hot');
    expect(hot?.selfMs).toBe(6);
    expect(hot?.share).toBeCloseTo(0.6, 6);
    // Самая дорогая функция идёт первой — таблица читается сверху вниз.
    expect(s.byFunction[0]?.functionName).toBe('hot');
  });

  it('агрегирует по файлам, схлопывая разные функции одного файла', () => {
    const profile = makeProfile() as { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[] };
    profile.nodes.push({
      id: 4,
      callFrame: { functionName: 'other', url: 'file:///repo/apps/backtester/src/engine/context.ts', lineNumber: 90 },
    });
    (profile as unknown as { samples: number[] }).samples.push(4);
    (profile as unknown as { timeDeltas: number[] }).timeDeltas.push(4_000);

    const s = summarizeCpuProfile(profile, { top: 10 });
    const ctx = s.byFile.find((r) => r.key === 'src/engine/context.ts');
    // 6 мс у `hot` + 4 мс у `other` — по функциям это две строки, по файлам одна.
    expect(ctx?.selfMs).toBe(10);
  });

  it('игнорирует неположительные дельты, а не засчитывает их узлу', () => {
    const profile = makeProfile() as unknown as { samples: number[]; timeDeltas: number[] };
    profile.samples.push(2);
    profile.timeDeltas.push(0);
    const s = summarizeCpuProfile(profile, { top: 10 });
    expect(s.sampledMs).toBe(10);
  });

  it('безымянная функция подписывается как (anonymous), а не пустой строкой', () => {
    const s = summarizeCpuProfile(makeProfile(), { top: 10 });
    expect(s.byFunction.some((r) => r.functionName === '(anonymous)')).toBe(true);
  });

  it('режет выдачу по `top`, оставляя самые дорогие', () => {
    const s = summarizeCpuProfile(makeProfile(), { top: 1 });
    expect(s.byFunction).toHaveLength(1);
    expect(s.byFunction[0]?.functionName).toBe('hot');
  });

  it('отвергает не-профиль, а не отдаёт пустую таблицу', () => {
    expect(() => summarizeCpuProfile({ foo: 1 }, { top: 5 })).toThrow(/not a V8 CPU profile/);
  });
});

describe('shortenUrl', () => {
  it('срезает абсолютный префикс до пути внутри приложения', () => {
    expect(shortenUrl('file:///home/u/repo/apps/backtester/src/engine/runner.ts')).toBe('src/engine/runner.ts');
  });

  it('сводит зависимости к node_modules/<пакет>, чтобы они группировались', () => {
    expect(shortenUrl('file:///repo/node_modules/decimal.js/decimal.mjs')).toBe('node_modules/decimal.js/decimal.mjs');
  });

  it('пустой url — это native-кадр V8', () => {
    expect(shortenUrl('')).toBe('(native)');
  });

  it('встроенные модули ноды остаются как есть', () => {
    expect(shortenUrl('node:internal/crypto/hash')).toBe('node:internal/crypto/hash');
  });
});
