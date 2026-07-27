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
