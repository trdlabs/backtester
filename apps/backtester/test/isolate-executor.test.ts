// POC (analysis/18 вариант A) — IsolateModuleExecutor: strategy-бандл в isolated-vm in-process.
//
// Тесты гоняют РЕАЛЬНЫЙ собранный изолят-харнесс (_isolate/harness.js — тот же rehydrate + _engine,
// что у docker-пути; строится vitest pretest-чейном) и РЕАЛЬНЫЙ isolated-vm (native addon —
// прямой dependency сервиса). Бандлы — временные bundleDir'ы на диске (канон ModuleBundle:
// {bundleDir, manifest, descriptor}, тело исполняется ТОЛЬКО в изоляте — FR-010).

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ModuleManifest, StrategyContext, StrategyModule } from '@trading/research-contracts/research';
import { DEFAULT_SANDBOX, type SandboxPolicy } from '../src/engine/sandbox-policy.js';
import type { ModuleBundle } from '../src/engine/sandbox/bundle.js';
import { IsolateModuleExecutor } from '../src/engine/sandbox/isolate-executor.js';
import { createIndicatorEngine } from '../src/engine/indicators/engine.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Временный bundleDir (self-contained ESM; extraFiles — доп. файлы module/*). */
function writeBundle(
  source: string,
  hooks: readonly string[] = ['onBarClose'],
  extraFiles: Record<string, string> = {},
  opts: { badSha?: boolean } = {},
): ModuleBundle {
  const dir = mkdtempSync(join(tmpdir(), 'isolate-poc-bundle-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'module'), { recursive: true });
  const files: { path: string; sha256: string }[] = [];
  const all: Record<string, string> = { 'module/index.js': source, ...extraFiles };
  for (const [rel, content] of Object.entries(all)) {
    writeFileSync(join(dir, rel), content);
    files.push({
      path: rel,
      sha256: opts.badSha === true ? 'f'.repeat(64) : createHash('sha256').update(content).digest('hex'),
    });
  }
  return {
    bundleDir: dir,
    manifest: {
      id: 'isolate_poc_probe',
      version: '1.0.0',
      kind: 'strategy',
      hooks: hooks as ModuleManifest['hooks'],
    } as unknown as ModuleManifest,
    descriptor: {
      contractVersion: '1.0.0',
      kind: 'strategy',
      entryPoint: 'module/index.js',
      files,
      bundleHash: `sha256:${'ab'.repeat(32)}`,
    },
  };
}

const dummyModule = {} as unknown as StrategyModule;

/** Минимальный StrategyContext-дабл (зеркало sandbox-executor-bar-major.test.ts makeCtx). */
function makeCtx(symbol: string, ts: number, seed = 1): StrategyContext {
  return {
    run: { runId: 'run-isolate-poc-1', mode: 'backtest', seed },
    params: {},
    symbol,
    bar: { ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    position: null,
    pendingIntent: null,
    portfolio: { equity: 1000, openPositions: 0 },
    clock: { now: () => ts },
    data: {},
    indicators: {},
    rng: { next: () => 0.5 },
  } as unknown as StrategyContext;
}

describe('IsolateModuleExecutor (POC — analysis/18 вариант A)', () => {
  it('исполняет onBarClose ESM-бандла в изоляте и возвращает его решение', async () => {
    // Бандл пробует rehydrate-контур: closedCandles(1000).length на первом баре = 0
    // (буфер [newBar], t=0, closedCandles строго ДО t) — пробивает, что ctx собран харнессом.
    const bundle = writeBundle(
      `export default function createStrategyModule() {
         return {
           onBarClose(ctx) {
             return { kind: 'annotate', tags: ['closed_' + ctx.data.closedCandles(1000).length] };
           },
         };
       }`,
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      expect(exec.errors).toEqual([]);
      const decisions = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
      expect(exec.errors).toEqual([]);
      expect(decisions).toEqual([{ kind: 'annotate', tags: ['closed_0'] }]);
    } finally {
      exec.close();
    }
  });

  it('sync-бесконечный цикл в хуке → sandbox_timeout fail-closed, последующие вызовы падают быстро (защёлка)', async () => {
    const bundle = writeBundle(
      `export default function createStrategyModule() {
         return { onBarClose() { for (;;) {} } };
       }`,
    );
    const tightPolicy: SandboxPolicy = {
      ...DEFAULT_SANDBOX,
      limits: { ...DEFAULT_SANDBOX.limits, wallTimeMsPerCall: 250 },
    };
    const exec = new IsolateModuleExecutor(bundle, tightPolicy);
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      const t0 = Date.now();
      const decisions = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
      expect(decisions).toEqual([]);
      expect(exec.errors.map((e) => e.code)).toEqual(['sandbox_timeout']);
      // Защёлка: следующий вызов НЕ исполняет хук заново (иначе ждали бы ещё один таймаут-квант).
      const t1 = Date.now();
      const again = await exec.executeStrategyHook(dummyModule, 'onBarClose', makeCtx('BTCUSDT', 120_000));
      expect(again).toEqual([]);
      expect(Date.now() - t1).toBeLessThan(200);
      expect(exec.errors.map((e) => e.code)).toEqual(['sandbox_timeout', 'sandbox_timeout']);
      expect(t1 - t0).toBeGreaterThanOrEqual(240); // первый вызов реально ждал wall-квант
    } finally {
      exec.close();
    }
  });

  it('session-seeded rng детерминирован: одинаковый seed → одинаковая последовательность, другой seed → другая', async () => {
    const src = `export default function createStrategyModule() {
       return { onBarClose(ctx) { return { kind: 'annotate', tags: ['rng_' + ctx.rng.next().toFixed(9)] }; } };
     }`;
    const draws = async (seed: number): Promise<string[]> => {
      const exec = new IsolateModuleExecutor(writeBundle(src), DEFAULT_SANDBOX);
      try {
        const tags: string[] = [];
        await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000, seed));
        for (let i = 0; i < 3; i += 1) {
          const d = await exec.executeStrategyHook(dummyModule, 'onBarClose', makeCtx('BTCUSDT', 60_000 * (i + 1), seed));
          tags.push((d[0] as unknown as { tags: string[] }).tags[0]!);
        }
        return tags;
      } finally {
        exec.close();
      }
    };
    const a = await draws(42);
    const b = await draws(42);
    const c = await draws(43);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('повторный хук того же бара НЕ дублирует newBar (бухгалтерия перехода бара)', async () => {
    const bundle = writeBundle(
      `export default function createStrategyModule() {
         const seen = [];
         return {
           onBarClose(ctx) { return { kind: 'annotate', tags: ['closed_' + ctx.data.closedCandles(1000).length] }; },
           onPositionBar(ctx) { return { kind: 'annotate', tags: ['closed_' + ctx.data.closedCandles(1000).length] }; },
         };
       }`,
      ['onBarClose', 'onPositionBar'],
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      // bar t: буфер [bar0] → closed = 0
      const d1 = await exec.executeStrategyHook(dummyModule, 'onBarClose', makeCtx('BTCUSDT', 60_000));
      // ТОТ ЖЕ бар, другой хук: newBar НЕ подаётся повторно → closed остаётся 0
      const d2 = await exec.executeStrategyHook(dummyModule, 'onPositionBar', makeCtx('BTCUSDT', 60_000));
      // следующий бар: буфер [bar0, bar1] → closed = 1
      const d3 = await exec.executeStrategyHook(dummyModule, 'onBarClose', makeCtx('BTCUSDT', 120_000));
      expect([d1, d2, d3].map((d) => (d[0] as unknown as { tags: string[] }).tags[0])).toEqual([
        'closed_0',
        'closed_0',
        'closed_1',
      ]);
      expect(exec.errors).toEqual([]);
    } finally {
      exec.close();
    }
  });

  it('обращение к отсутствующему ambient API (fetch) → sandbox_crashed fail-closed, [] решений', async () => {
    const bundle = writeBundle(
      `export default function createStrategyModule() {
         return { onBarClose() { return fetch('https://example.com'); } };
       }`,
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      const decisions = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
      expect(decisions).toEqual([]);
      expect(exec.errors).toHaveLength(1);
      expect(exec.errors[0]!.code).toBe('sandbox_crashed');
      expect(exec.errors[0]!.detail).toMatch(/fetch/);
    } finally {
      exec.close();
    }
  });

  it('ctx.indicators.value("sma", 3) в изоляте байт-в-байт равен host-движку (тот же _engine-код)', async () => {
    const bundle = writeBundle(
      `export default function createStrategyModule() {
         return {
           onBarClose(ctx) {
             const v = ctx.indicators.value('sma', 3);
             return { kind: 'annotate', tags: ['sma_' + (v === undefined ? 'warmup' : String(v))] };
           },
         };
       }`,
    );
    const closes = [1.5, 2.5, 4.5, 5.0];
    const bars = closes.map((close, i) => ({ ts: 60_000 * (i + 1), open: close - 0.5, high: close + 0.5, low: close - 1, close, volume: 10 }));
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', bars[0]!.ts));
      const tags: string[] = [];
      for (const bar of bars) {
        const ctx = { ...makeCtx('BTCUSDT', bar.ts), bar } as unknown as StrategyContext;
        const d = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
        tags.push((d[0] as unknown as { tags: string[] }).tags[0]!);
      }
      expect(exec.errors).toEqual([]);
      // Host-референс: ТОТ ЖЕ движок (src/engine/indicators — источник _engine) над теми же барами.
      const engine = createIndicatorEngine(bars);
      const expected = bars.map((_, t) => {
        const v = engine.accessorAt(t).value('sma', 3);
        return `sma_${v === undefined ? 'warmup' : String(v)}`;
      });
      expect(tags).toEqual(expected);
      expect(tags[3]).toBe(`sma_${(2.5 + 4.5 + 5.0) / 3}`); // и абсолютная точка, не только парность
    } finally {
      exec.close();
    }
  });

  it('синхронный и асинхронный заходы дают ОДИНАКОВЫЕ решения (парность sync↔async)', async () => {
    // Синхронный путь (`evalClosureSync`) включается вне главного потока и снимает измеренные
    // +116…+217 мкс/бар (bt#191/196). Включать его можно только доказав, что он не двигает ни
    // одного значения, — поэтому оба пути гоняются здесь В ОДНОМ процессе над одной лентой.
    const src = `export default function createStrategyModule() {
       return {
         onBarClose(ctx) {
           const v = ctx.indicators.value('sma', 3);
           return { kind: 'annotate', tags: ['b' + ctx.bar.close + '_sma_' + (v === undefined ? 'w' : String(v)) + '_r' + ctx.rng.next()] };
         },
       };
     }`;
    const closes = [1.5, 2.5, 4.5, 5.0, 6.25];
    const bars = closes.map((close, i) => ({ ts: 60_000 * (i + 1), open: close - 0.5, high: close + 0.5, low: close - 1, close, volume: 10 }));

    const collect = async (syncCalls: boolean): Promise<string[]> => {
      const exec = new IsolateModuleExecutor(writeBundle(src), DEFAULT_SANDBOX, { syncCalls });
      try {
        await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', bars[0]!.ts));
        const out: string[] = [];
        for (const bar of bars) {
          const ctx = { ...makeCtx('BTCUSDT', bar.ts), bar } as unknown as StrategyContext;
          const d = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
          out.push((d[0] as unknown as { tags: string[] }).tags[0]!);
        }
        expect(exec.errors).toEqual([]);
        return out;
      } finally {
        exec.close();
      }
    };

    const asyncTags = await collect(false);
    const syncTags = await collect(true);
    // Теги несут цену бара, значение индикатора И очередной отсчёт rng — то есть расхождение в
    // любом из трёх (в том числе в порядке потребления rng) провалит сравнение.
    expect(syncTags).toEqual(asyncTags);
    expect(syncTags).toHaveLength(bars.length);
  });

  it('синхронный заход fail-closed по нативному таймауту (хостовая гонка ему не нужна)', { timeout: 15_000 }, async () => {
    // Хостовая гонка на синхронном пути снята намеренно: она ставилась против повисшего ПРОМИСА в
    // изоляте, а синхронный вызов промиса не возвращает. Стоп-краном остаётся нативный `timeout`,
    // и этот тест проверяет, что он действительно срабатывает — иначе снятие гонки было бы
    // ослаблением гарда, а не устранением его повода.
    const bundle = writeBundle(
      `export default function createStrategyModule() {
         return { onBarClose() { for (;;) {} } };
       }`,
    );
    const tightPolicy = { ...DEFAULT_SANDBOX, limits: { ...DEFAULT_SANDBOX.limits, wallTimeMsPerCall: 500 } };
    const exec = new IsolateModuleExecutor(bundle, tightPolicy, { syncCalls: true });
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      const decisions = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
      expect(decisions).toEqual([]);
      expect(exec.errors.some((e) => e.code === 'sandbox_timeout')).toBe(true);
    } finally {
      exec.close();
    }
  });

  it(
    'бесконечный цикл в TOP-LEVEL коде бандла → fail-closed под таймаутом, воркер не виснет (ревью C1)',
    { timeout: 15_000 },
    async () => {
      const bundle = writeBundle(`for (;;) {} export default function createStrategyModule() { return {}; }`);
      const tightPolicy: SandboxPolicy = {
        ...DEFAULT_SANDBOX,
        limits: { ...DEFAULT_SANDBOX.limits, wallTimeMsPerCall: 400 },
      };
      const exec = new IsolateModuleExecutor(bundle, tightPolicy);
      try {
        const ctx = makeCtx('BTCUSDT', 60_000);
        await exec.initStrategy(dummyModule, ctx); // не должен зависнуть
        expect(exec.errors.length).toBeGreaterThan(0);
        expect(['bundle_load_failed', 'sandbox_timeout']).toContain(exec.errors[0]!.code);
        const decisions = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
        expect(decisions).toEqual([]);
      } finally {
        exec.close();
      }
    },
  );

  it('бандл подменяет __isolateHarness (общий global) → sandbox_output_malformed, НЕ необработанное исключение (ревью C2)', async () => {
    const bundle = writeBundle(
      `globalThis.__isolateHarness = { initSymbol: () => 42, hook: () => ({ boom: true }) };
       export default function createStrategyModule() { return { onBarClose() { return { kind: 'idle' }; } }; }`,
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      const decisions = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
      expect(decisions).toEqual([]); // fail-closed, никаких исключений наружу
      expect(exec.errors.length).toBeGreaterThan(0);
      expect(exec.errors.every((e) => e.code === 'sandbox_output_malformed')).toBe(true);
    } finally {
      exec.close();
    }
  });

  it('подменённый харнесс возвращает array-like decisions (не массив) → malformed, не течёт в движок', async () => {
    const bundle = writeBundle(
      `globalThis.__isolateHarness = {
         initSymbol: () => JSON.stringify({ ok: true }),
         hook: () => JSON.stringify({ ok: true, decisions: { length: 1, 0: { kind: 'idle' } } }),
       };
       export default function createStrategyModule() { return { onBarClose() { return { kind: 'idle' }; } }; }`,
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      const decisions = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
      expect(decisions).toEqual([]);
      expect(exec.errors.some((e) => e.code === 'sandbox_output_malformed')).toBe(true);
    } finally {
      exec.close();
    }
  });

  it("import 'fs' в бандле → bundle_load_failed (только относительные импорты)", async () => {
    const bundle = writeBundle(
      `import { readFileSync } from 'fs';
       export default function createStrategyModule() { return {}; }`,
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      expect(exec.errors).toHaveLength(1);
      expect(exec.errors[0]!.code).toBe('bundle_load_failed');
      expect(exec.errors[0]!.detail).toMatch(/forbidden/);
    } finally {
      exec.close();
    }
  });

  it('импорт файла вне descriptor.files → bundle_load_failed (whitelist)', async () => {
    // module/other.js существует НА ДИСКЕ, но не заявлен в descriptor.files → компиляция запрещена.
    const bundle = writeBundle(
      `import { x } from './other.js';
       export default function createStrategyModule() { return { onBarClose() { return { kind: 'annotate', tags: [x] }; } }; }`,
    );
    writeFileSync(join(bundle.bundleDir, 'module', 'other.js'), `export const x = 'leak';`);
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      expect(exec.errors).toHaveLength(1);
      expect(exec.errors[0]!.code).toBe('bundle_load_failed');
      expect(exec.errors[0]!.detail).toMatch(/descriptor\.files/);
    } finally {
      exec.close();
    }
  });

  it('sha256 файла не совпадает с descriptor.files → bundle_load_failed (integrity)', async () => {
    const bundle = writeBundle(
      `export default function createStrategyModule() { return { onBarClose() { return { kind: 'idle' }; } }; }`,
      ['onBarClose'],
      {},
      { badSha: true },
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      expect(exec.errors).toHaveLength(1);
      expect(exec.errors[0]!.code).toBe('bundle_load_failed');
      expect(exec.errors[0]!.detail).toMatch(/sha256/);
    } finally {
      exec.close();
    }
  });

  it('async-хук → sandbox_crashed fail-closed (sync-only контракт изолята)', async () => {
    const bundle = writeBundle(
      `export default function createStrategyModule() {
         return { async onBarClose() { return { kind: 'idle' }; } };
       }`,
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      const ctx = makeCtx('BTCUSDT', 60_000);
      await exec.initStrategy(dummyModule, ctx);
      const decisions = await exec.executeStrategyHook(dummyModule, 'onBarClose', ctx);
      expect(decisions).toEqual([]);
      expect(exec.errors).toHaveLength(1);
      expect(exec.errors[0]!.code).toBe('sandbox_crashed');
      expect(exec.errors[0]!.detail).toMatch(/async/);
    } finally {
      exec.close();
    }
  });

  it('второй символ при object-default-export → bundle_load_failed (shared-instance хазард, ревью I1)', async () => {
    // Non-function default = ОБЩИЙ объект: на per-symbol контейнерах docker это две копии,
    // в одном изоляте — один объект на все символы → тихий разрыв байт-идентичности. Fail-fast.
    const bundle = writeBundle(
      `export default { onBarClose(ctx) { return { kind: 'idle' }; } };`,
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      expect(exec.errors).toEqual([]); // первый символ — ок (как non-universe docker)
      await exec.initStrategy(dummyModule, makeCtx('ETHUSDT', 60_000));
      expect(exec.errors).toHaveLength(1);
      expect(exec.errors[0]!.code).toBe('bundle_load_failed');
      expect(exec.errors[0]!.detail).toMatch(/factory|symbol/i);
    } finally {
      exec.close();
    }
  });
});

// ─── 17b-батчинг в изоляте (loop-in-isolate, analysis/18 постскриптум-2) ───────────────────────
describe('IsolateModuleExecutor — executeStrategyHookBatch (один evalClosure на пачку)', () => {
  const IDLE_PROBE = `export default function createStrategyModule() {
     return { onBarClose(ctx) { return null; } };
   }`;
  const ANNOTATE_AT = (k: number): string => `export default function createStrategyModule() {
     let i = -1;
     return { onBarClose(ctx) { i += 1; return i === ${k} ? { kind: 'annotate', tags: ['hit_' + i] } : null; } };
   }`;

  function ctxsFor(symbol: string, n: number, fromTs = 60_000): StrategyContext[] {
    return Array.from({ length: n }, (_, i) => makeCtx(symbol, fromTs + i * 60_000));
  }

  it('пачка idle-баров уходит ОДНИМ hookBatch-вызовом (не N hook-вызовов)', async () => {
    const exec = new IsolateModuleExecutor(writeBundle(IDLE_PROBE), DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      const r = await exec.executeStrategyHookBatch(dummyModule, ctxsFor('BTCUSDT', 5));
      expect(r).toEqual({ stoppedAt: 4, decisions: [] });
      const stats = await exec.harnessStats();
      expect(stats.batchCalls).toBe(1); // ключевое: ОДИН заход в изолят
      expect(stats.hookCalls).toBe(0); // и ноль пербарных
      expect(exec.errors).toEqual([]);
    } finally {
      exec.close();
    }
  });

  it('ранний стоп на непустом решении + отмотка бухгалтерии: следующий lockstep-бар видит корректный буфер', async () => {
    const exec = new IsolateModuleExecutor(writeBundle(ANNOTATE_AT(2)), DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      const r = await exec.executeStrategyHookBatch(dummyModule, ctxsFor('BTCUSDT', 5));
      expect(r.stoppedAt).toBe(2);
      expect(r.decisions).toEqual([{ kind: 'annotate', tags: ['hit_2'] }]);
      // Потреблены ровно бары 0..2; следующий lockstep-вызов бара 3 должен подать newBar для ts бара 3
      // (отмотка host-бухгалтерии) и увидеть буфер из 4 баров → closedCandles = 3.
      const d = await exec.executeStrategyHook(dummyModule, 'onBarClose', makeCtx('BTCUSDT', 60_000 + 3 * 60_000));
      expect(exec.errors).toEqual([]);
      expect(d).toEqual([]); // ANNOTATE_AT(2): счётчик i=3 → null
      const stats = await exec.harnessStats();
      expect(stats.bufferLen).toBe(4); // [b0,b1,b2] из батча + b3 lockstep
    } finally {
      exec.close();
    }
  });

  it('бросок хука на баре j → clamped stop, ошибка записана, сессия защёлкнута', async () => {
    const THROW_AT_1 = `export default function createStrategyModule() {
       let i = -1;
       return { onBarClose() { i += 1; if (i === 1) throw new Error('boom at 1'); return null; } };
     }`;
    const exec = new IsolateModuleExecutor(writeBundle(THROW_AT_1), DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      const r = await exec.executeStrategyHookBatch(dummyModule, ctxsFor('BTCUSDT', 5));
      expect(r.decisions).toEqual([]);
      expect(r.stoppedAt).toBeGreaterThanOrEqual(0); // clamped, движок делает шаг вперёд
      expect(exec.errors.length).toBeGreaterThan(0);
      const again = await exec.executeStrategyHook(dummyModule, 'onBarClose', makeCtx('BTCUSDT', 999_000));
      expect(again).toEqual([]); // защёлка
    } finally {
      exec.close();
    }
  });

  it('async-хук в батче → fail-closed БЕЗ зависания', { timeout: 10_000 }, async () => {
    const ASYNC = `export default function createStrategyModule() {
       return { async onBarClose() { return null; } };
     }`;
    const exec = new IsolateModuleExecutor(writeBundle(ASYNC), DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      const r = await exec.executeStrategyHookBatch(dummyModule, ctxsFor('BTCUSDT', 3));
      expect(r.decisions).toEqual([]);
      expect(exec.errors.some((e) => /async/.test(e.detail))).toBe(true);
    } finally {
      exec.close();
    }
  });

  it('парность: батч и lockstep дают идентичные решения и состояние буфера', async () => {
    const runVia = async (mode: 'batch' | 'lockstep') => {
      const exec = new IsolateModuleExecutor(writeBundle(ANNOTATE_AT(3)), DEFAULT_SANDBOX);
      try {
        await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
        const all: unknown[] = [];
        if (mode === 'batch') {
          let t = 0;
          while (t < 6) {
            const { stoppedAt, decisions } = await exec.executeStrategyHookBatch(
              dummyModule,
              ctxsFor('BTCUSDT', 6 - t, 60_000 + t * 60_000),
            );
            all.push(...decisions);
            t += stoppedAt + 1;
          }
        } else {
          for (let t = 0; t < 6; t += 1) {
            all.push(...(await exec.executeStrategyHook(dummyModule, 'onBarClose', makeCtx('BTCUSDT', 60_000 + t * 60_000))));
          }
        }
        const stats = await exec.harnessStats();
        return { all, bufferLen: stats.bufferLen };
      } finally {
        exec.close();
      }
    };
    const a = await runVia('batch');
    const b = await runVia('lockstep');
    expect(a.all).toEqual(b.all);
    expect(a.bufferLen).toBe(b.bufferLen);
    expect(a.bufferLen).toBe(6);
  });
});

// ─── AIMD-окно батча (защита от eager-build амплификации на annotate-плотных стратегиях) ──────
describe('IsolateModuleExecutor — адаптивное окно батча', () => {
  const IDLE = `export default function createStrategyModule() { return { onBarClose() { return null; } }; }`;
  const ANNOTATE_ALWAYS = `export default function createStrategyModule() {
     return { onBarClose(ctx) { return { kind: 'annotate', tags: ['t'] }; } };
   }`;
  const ctxsFor = (n: number, fromTs = 60_000): StrategyContext[] =>
    Array.from({ length: n }, (_, i) => makeCtx('BTCUSDT', fromTs + i * 60_000));

  it('окно растёт на полном потреблении: 32 idle-бара = 3 batch-захода (8→16→8-остаток)', async () => {
    const exec = new IsolateModuleExecutor(writeBundle(IDLE), DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      let t = 0;
      while (t < 32) {
        const { stoppedAt } = await exec.executeStrategyHookBatch(dummyModule, ctxsFor(32 - t, 60_000 + t * 60_000));
        t += stoppedAt + 1;
      }
      const stats = await exec.harnessStats();
      expect(stats.batchCalls).toBe(3);
      expect(stats.bufferLen).toBe(32);
    } finally {
      exec.close();
    }
  });

  it('ранний стоп НЕ маршалит весь хвост: 200 ctxs при стопе на баре 0 → в изолят ушло ≤ 8 баров', async () => {
    const exec = new IsolateModuleExecutor(writeBundle(ANNOTATE_ALWAYS), DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      const { stoppedAt, decisions } = await exec.executeStrategyHookBatch(dummyModule, ctxsFor(200));
      expect(stoppedAt).toBe(0);
      expect(decisions).toEqual([{ kind: 'annotate', tags: ['t'] }]);
      const stats = await exec.harnessStats();
      expect(stats.batchBarsReceived).toBeLessThanOrEqual(8);
    } finally {
      exec.close();
    }
  });
});

describe('IsolateModuleExecutor — preferredBatchBars (hint окна для раннера)', () => {
  it('отдаёт текущее AIMD-окно; раннер строит ровно столько ctx', async () => {
    const IDLE_OBJ = `export default function createStrategyModule() { return { onBarClose() { return { kind: 'idle' }; } }; }`;
    const exec = new IsolateModuleExecutor(writeBundle(IDLE_OBJ), DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      expect(exec.preferredBatchBars()).toBe(8); // старт
      const ctxs = Array.from({ length: 8 }, (_, i) => makeCtx('BTCUSDT', 60_000 * (i + 1)));
      const r = await exec.executeStrategyHookBatch(dummyModule, ctxs);
      expect(r).toEqual({ stoppedAt: 7, decisions: [] }); // idle-объекты не рвут батч
      expect(exec.preferredBatchBars()).toBe(16); // окно выросло
    } finally {
      exec.close();
    }
  });
});

describe('IsolateModuleExecutor — блокеры ревью батча', () => {
  const ctxsFor2 = (n: number): StrategyContext[] =>
    Array.from({ length: n }, (_, i) => makeCtx('BTCUSDT', 60_000 * (i + 1)));

  it('невалидный idle-подобный ({kind:"idle", reason}) НЕ глотается — доходит до ревалидатора', async () => {
    const bundle = writeBundle(
      `export default function createStrategyModule() {
         return { onBarClose() { return { kind: 'idle', reason: 'no signal' }; } };
       }`,
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      const r = await exec.executeStrategyHookBatch(dummyModule, ctxsFor2(4));
      expect(r.decisions).toEqual([]); // fail-closed
      expect(exec.errors.some((e) => e.code === 'decision_schema_invalid')).toBe(true); // а не тихий скип
    } finally {
      exec.close();
    }
  });

  it('кап maxDecisionBytes действует и на батч-пути (sandbox_output_overflow)', async () => {
    const bundle = writeBundle(
      `export default function createStrategyModule() {
         return { onBarClose() { return { kind: 'annotate', tags: ['x'.repeat(200000)] }; } };
       }`,
    );
    const exec = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX); // maxDecisionBytes 65536
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      const r = await exec.executeStrategyHookBatch(dummyModule, ctxsFor2(4));
      expect(r.decisions).toEqual([]);
      expect(exec.errors.some((e) => e.code === 'sandbox_output_overflow')).toBe(true);
    } finally {
      exec.close();
    }
  });

  it('wall-бюджет масштабируется по окну: тяжёлый-но-легитимный хук (~8мс/бар × 16 баров) проходит', async () => {
    const BUSY = `export default function createStrategyModule() {
       return { onBarClose() { const t0 = Date.now(); while (Date.now() - t0 < 8) {} return null; } };
     }`;
    const tight: SandboxPolicy = { ...DEFAULT_SANDBOX, limits: { ...DEFAULT_SANDBOX.limits, wallTimeMsPerCall: 50 } };
    const exec = new IsolateModuleExecutor(writeBundle(BUSY), tight);
    try {
      await exec.initStrategy(dummyModule, makeCtx('BTCUSDT', 60_000));
      // прогреть окно до 16: два полных батча по window
      let t = 0;
      while (t < 24) {
        const { stoppedAt } = await exec.executeStrategyHookBatch(dummyModule, ctxsFor2(24).slice(t));
        expect(exec.errors).toEqual([]); // НЕ sandbox_timeout: бюджет = perCall × bars
        t += stoppedAt + 1;
      }
    } finally {
      exec.close();
    }
  });
});
