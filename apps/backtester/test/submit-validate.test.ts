// Unit tests for submit.ts::validate() — metric-catalog routing by engine.
// TDD: written before the implementation fixes (Gap 1 + Gap 2 tests are RED first).
// Run: pnpm exec vitest run apps/backtester/test/submit-validate.test.ts

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunSubmitRequest } from '@trading/research-contracts';
import { InMemoryJobStore } from '../src/jobs/job-store.js';
import { SubmitError, submitRun, type SubmitDeps } from '../src/jobs/submit.js';

function minimalDeps(): SubmitDeps {
  return {
    store: new InMemoryJobStore(),
    clock: () => 1_000_000,
    uid: () => randomUUID(),
    defaultQueueTimeoutMs: 60_000,
    defaultRunTimeoutMs: 300_000,
    enableOverlayEngine: true,
  };
}

const BASE_REQ: Omit<RunSubmitRequest, 'engine' | 'metrics'> = {
  mode: 'research',
  moduleRef: { id: 'smoke', version: '1.0.0' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
  seed: 42,
};

function req(over: Partial<RunSubmitRequest> = {}): RunSubmitRequest {
  return { ...(BASE_REQ as RunSubmitRequest), ...over };
}

/** Call submitRun and assert a SubmitError is thrown; return it. */
async function expectSubmitError(deps: SubmitDeps, body: RunSubmitRequest): Promise<SubmitError> {
  const caught = await submitRun(deps, body).catch((e) => e);
  if (!(caught instanceof SubmitError)) {
    throw new Error(`Expected SubmitError but got: ${caught}`);
  }
  return caught;
}

describe('submit validate — engine:strategy metric catalog (Gap 1 + Gap 2)', () => {
  // ── Gap 1 ─────────────────────────────────────────────────────────────────
  it('Gap 1 — engine:strategy + overlay metric (sharpe) is ACCEPTED', async () => {
    // RED before fix: falls through to VALID_METRICS (momentum catalog),
    //   so 'sharpe' → unknown_metric 400.
    // GREEN after fix: strategy routes to VALID_OVERLAY_METRICS.
    await expect(
      submitRun(minimalDeps(), req({ engine: 'strategy', metrics: ['sharpe'] })),
    ).resolves.toBeDefined();
  });

  // ── Gap 2 ─────────────────────────────────────────────────────────────────
  it('Gap 2 — engine:strategy + empty metrics[] is REJECTED 400', async () => {
    // RED before fix: empty array passes validate() — no unknown items, no throw.
    //   The job is created and later fails in-engine with platform-017 incomplete_run_request.
    // GREEN after fix: empty metrics rejected at submit with 400.
    const e = await expectSubmitError(minimalDeps(), req({ engine: 'strategy', metrics: [] }));
    expect(e.statusCode).toBe(400);
    expect(e.message).toMatch(/non-empty/);
  });

  // ── Regressions ───────────────────────────────────────────────────────────
  it('regression — engine:strategy + truly-invalid metric is still REJECTED 400', async () => {
    const e = await expectSubmitError(
      minimalDeps(),
      req({ engine: 'strategy', metrics: ['__no_such_metric__'] }),
    );
    expect(e.statusCode).toBe(400);
    expect(e.message).toMatch(/unknown_metric/);
  });

  it('regression — engine:overlay + overlay metric (sharpe) is still ACCEPTED', async () => {
    await expect(
      submitRun(minimalDeps(), req({ engine: 'overlay', metrics: ['sharpe'] })),
    ).resolves.toBeDefined();
  });

  it('regression — engine:overlay + empty metrics[] still PASSES (overlay unchanged)', async () => {
    // Overlay currently allows metrics:[] — must not change.
    await expect(
      submitRun(minimalDeps(), req({ engine: 'overlay', metrics: [] })),
    ).resolves.toBeDefined();
  });

  it('regression — no engine (momentum) + sharpe is still REJECTED 400 (momentum catalog unchanged)', async () => {
    const e = await expectSubmitError(minimalDeps(), req({ metrics: ['sharpe'] }));
    expect(e.statusCode).toBe(400);
    expect(e.message).toMatch(/unknown_metric/);
  });

  it('regression — no engine (momentum) + empty metrics[] still PASSES (runBody() default)', async () => {
    // runBody() defaults to metrics:[] — must not break existing momentum submits.
    await expect(
      submitRun(minimalDeps(), req({ metrics: [] })),
    ).resolves.toBeDefined();
  });

  // ── curatedBaselineRef (backtester-only) ──────────────────────────────────
  it("accepts engine:'strategy' submit with curatedBaselineRef (backtester-only field)", async () => {
    // curatedBaselineRef is a backtester-only field like `engine` — validate() checks only
    // specific named fields and never rejects unknown ones, so this must be accepted.
    await expect(
      submitRun(
        minimalDeps(),
        req({
          engine: 'strategy',
          metrics: ['sharpe'],
          curatedBaselineRef: { id: 'short_after_pump', version: '0.1.0' },
        }),
      ),
    ).resolves.toBeDefined();
  });
});

describe('submit validate — E1a expanded metric catalog', () => {
  const E1A = [
    'sortino',
    'expectancy',
    'sqn',
    'cagr',
    'calmar',
    'returns_stddev',
    'returns_skew',
    'returns_kurtosis',
    'returns_count',
  ];

  for (const metric of E1A) {
    it(`engine:overlay + E1a metric (${metric}) is ACCEPTED`, async () => {
      await expect(
        submitRun(minimalDeps(), req({ engine: 'overlay', metrics: [metric] })),
      ).resolves.toBeDefined();
    });

    it(`engine:strategy + E1a metric (${metric}) is ACCEPTED`, async () => {
      await expect(
        submitRun(
          minimalDeps(),
          req({
            engine: 'strategy',
            metrics: [metric],
            curatedBaselineRef: { id: 'short_after_pump', version: '0.1.0' },
          }),
        ),
      ).resolves.toBeDefined();
    });
  }
});
