// ГЕЙТ: снятие пербарной заморозки контекста не двигает результат — НА ПРОД-ПУТИ.
//
// Почему нужен отдельный гейт, когда уже есть `context-freeze-flag.test.ts`.
//
// Тот доказывает семантику: держа ссылку на `ctx`, стратегия не увидит чужой бар и не испортит
// чужой. Он вызывает построитель контекста напрямую и про очередь, воркера и поток ничего не знает.
//
// Здесь проверяется другое и ровно то, что сломалось бы при этой правке: доходит ли флаг до
// прогона ВООБЩЕ. До неё не доходил — `contextFreeze` считался в `config.ts`, но `StrategyRunDeps`
// его не принимал, и `runStrategyBacktest` терял поле по дороге. При этом
// `deploy/vps/backtester.env.example` уже выставлял `BACKTESTER_CONTEXT_FREEZE_DISABLED=true`:
// развёртывание просило снять заморозку, а она молча оставалась включённой.
//
// Такое расхождение не ловится ни одним гейтом на значения — результат-то верный. Ловится оно
// только замером или проводкой, и вот проводка.
//
// Обе дороги — потоковая и прямая — потому что флаг едет к ним разными путями: прямая берёт его из
// `runFlags`, потоковая — тем же объектом через `ThreadRunFlags` и structured clone. Разъехаться
// они могут независимо.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle } from '@trading/research-contracts';
import { AUTH, buildTestApp } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { __resetTapeCachesForTest } from '../src/data/tape-cache.js';
import { buildTape, makeRequest, T0 } from '../scripts/lib/profile-runner-fixture.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import { runStrategyBacktest } from '../src/engine/run-strategy.js';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type {
  ExecutionProfile,
  StrategyContext,
  StrategyDecision,
  StrategyModule,
} from '@trading/research-contracts/research';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQ = resolve(HERE, 'fixtures/overlay/requests');
const BUN = resolve(HERE, 'fixtures/overlay/bundles');

const loadRequest = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(REQ, n), 'utf8')) as BacktestRunRequest;
const loadBundle = (n: string): ModuleBundle =>
  JSON.parse(readFileSync(resolve(BUN, n), 'utf8')) as ModuleBundle;

/** Поток грузит свой граф только под Node 24 (bt#201) — под 22 шов молча не соберётся. */
const THREAD_SEAM_LOADS = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 24;

async function runThroughQueue(
  runId: string,
  opts: { readonly contextFreeze: boolean; readonly barLoopThread: boolean },
): Promise<string> {
  // Кэш лент — процессный синглтон и переживает `dispose()`; без сброса второй прогон подобрал бы
  // материализацию от первого и сравнивал бы не то, что заявлено.
  __resetTapeCachesForTest();
  const app = await buildTestApp({
    enableOverlayEngine: true,
    workerConcurrency: 1,
    contextFreeze: opts.contextFreeze,
    barLoopThread: opts.barLoopThread,
    // Изолятный бэкенд у всех дорог: `runId` обязан совпадать (входит в хэш), а имя контейнера
    // песочницы строится из runId+модуль+символ — на docker дороги подрались бы за одно имя.
    overlaySandbox: { ...loadConfig().overlaySandbox, backend: 'isolate' },
  });
  try {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: AUTH,
      payload: {
        ...loadRequest('baseline.json'),
        runId,
        engine: 'strategy',
        moduleBundle: loadBundle('short-after-pump.bundle.json'),
        metrics: ['pnl', 'win_rate'],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(await app.drain()).toBe(1);

    const row = await app.store.get(runId);
    expect(row, `строка ${runId} не найдена`).toBeDefined();
    expect(
      row!.status,
      `прогон ${runId} (freeze=${opts.contextFreeze}, поток=${opts.barLoopThread}) ` +
        `не завершился: ${row!.terminalCode ?? '(без кода)'}`,
    ).toBe('completed');
    expect(row!.resultHash).toBeTruthy();
    return row!.resultHash!;
  } finally {
    await app.dispose();
  }
}

/**
 * ПРЯМАЯ ПРОВЕРКА ПРОВОДКИ: доходит ли флаг от `StrategyRunDeps` до построителя контекста.
 *
 * Без неё три гейта ниже позеленели бы и на оборванной проводке: если флаг не доедет НИ ДО ОДНОЙ
 * ветки, обе дороги честно совпадут по хэшу — просто обе будут морозить. Именно так дефект и жил:
 * значения всегда были верны, а флаг ничего не делал.
 *
 * Заморозка наблюдаема прямо — `Object.isFrozen(ctx)`, — поэтому проверять её косвенно незачем.
 */
async function observeFrozen(contextFreeze: boolean | undefined): Promise<boolean[]> {
  const seen: boolean[] = [];
  const manifest = {
    id: 'freeze_probe',
    version: '1.0.0',
    kind: 'strategy' as const,
    name: 'freeze probe',
    summary: 'наблюдает заморожен ли ctx',
    rationale: 'гейт проводки флага',
    author: 'agent',
    contractVersion: CONTRACT_VERSION,
    status: 'research_only' as const,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    params: {},
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: false },
    hooks: ['onBarClose'],
  };
  const make = (): StrategyModule =>
    ({
      manifest,
      onBarClose(ctx: StrategyContext): StrategyDecision {
        seen.push(Object.isFrozen(ctx));
        return { kind: 'idle' };
      },
    }) as unknown as StrategyModule;
  const noCost: ExecutionProfile = {
    id: 'paper_match',
    version: '1.0.0',
    fillModel: { kind: 'same_bar_close' } as never,
    feeModel: { kind: 'fixed_bps', bps: 0 },
    slippageModel: { kind: 'fixed_bps', bps: 0 },
  };
  const spec = { symbols: ['BTCUSDT'], bars: 40, seed: 7, barMajor: false, marketKinds: true };
  const registry = createModuleRegistry({
    strategies: [Object.assign(make(), { moduleFactory: make })],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [noCost],
  });
  const request = { ...makeRequest(spec), moduleRef: { id: manifest.id, version: manifest.version } };
  const outcome = await runStrategyBacktest(request, {
    registry,
    marketTape: buildTape(spec),
    router: createTrustedRouter(),
    ...(contextFreeze !== undefined ? { contextFreeze } : {}),
  } as never);
  // Отклонённый прогон не зовёт хук вовсе, и тогда `seen` пуст — молчаливо «всё сошлось».
  // Поэтому статус проверяется здесь, а причина попадает в сообщение целиком.
  expect(
    outcome.status,
    `прогон зонда отклонён: ${JSON.stringify((outcome as { validation?: unknown }).validation)}`,
  ).toBe('completed');
  return seen;
}

describe('проводка флага заморозки доходит до построителя контекста', () => {
  it('contextFreeze=false отдаёт НЕзамороженный ctx, true и отсутствие — замороженный', async () => {
    const thawed = await observeFrozen(false);
    const frozen = await observeFrozen(true);
    const absent = await observeFrozen(undefined);

    expect(thawed.length, 'зонд обязан быть вызван хотя бы раз').toBeGreaterThan(0);
    expect(thawed.every((f) => f === false), 'при contextFreeze=false ctx не должен быть заморожен').toBe(true);
    expect(frozen.every((f) => f === true), 'при contextFreeze=true ctx обязан быть заморожен').toBe(true);
    // Отсутствие поля обязано вести себя как `true` — иначе правка тихо сменила бы поведение всем,
    // кто флаг не передаёт (станки, тесты, любой сторонний вызов).
    expect(absent).toEqual(frozen);
  }, 60_000);
});

describe('прод-путь: снятие заморозки контекста не двигает результат', () => {
  it(
    'прямая ветка даёт один resultHash при обоих значениях флага',
    async () => {
      // Один и тот же `runId` у обеих дорог — он входит в запрос, а запрос в хэш. Разные id дали бы
      // разные хэши, и расхождение выглядело бы как дефект флага, будучи дефектом теста.
      const RUN_ID = 'cf-prod-main';
      const frozen = await runThroughQueue(RUN_ID, { contextFreeze: true, barLoopThread: false });
      const thawed = await runThroughQueue(RUN_ID, { contextFreeze: false, barLoopThread: false });
      expect(thawed).toBe(frozen);
    },
    180_000,
  );

  it.skipIf(!THREAD_SEAM_LOADS)(
    'потоковая ветка даёт один resultHash при обоих значениях флага',
    async () => {
      const RUN_ID = 'cf-prod-thread';
      const frozen = await runThroughQueue(RUN_ID, { contextFreeze: true, barLoopThread: true });
      const thawed = await runThroughQueue(RUN_ID, { contextFreeze: false, barLoopThread: true });
      expect(thawed).toBe(frozen);
    },
    180_000,
  );

  it.skipIf(!THREAD_SEAM_LOADS)(
    'поток и главный поток сходятся при СНЯТОЙ заморозке',
    async () => {
      // Отдельная проверка, потому что предыдущие две допускают согласованную ошибку: если флаг не
      // доедет НИ ДО ОДНОЙ ветки, обе пары совпадут, и гейт позеленеет на неработающей проводке.
      // Сравнение веток между собой при снятой заморозке этого не спасает само по себе — но вместе
      // с замером (68.8 → 56.9 мкс/бар) закрывает вопрос: работающая проводка обязана дать и
      // одинаковый хэш, и разную стоимость.
      const RUN_ID = 'cf-prod-cross';
      const onMain = await runThroughQueue(RUN_ID, { contextFreeze: false, barLoopThread: false });
      const onThread = await runThroughQueue(RUN_ID, { contextFreeze: false, barLoopThread: true });
      expect(onThread).toBe(onMain);
    },
    180_000,
  );
});
