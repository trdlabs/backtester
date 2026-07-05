// Task 1 (R1) — Docker-gated integration test: produceStrategyEvidenceForBundle driver.
//
// Proves: the driver correctly orchestrates materialize → loadBundle (acceptance-gate) →
//   curated run (trusted, in-process) + candidate run (strategy-route, sandbox) →
//   produceStrategyEvidence → signed artifact with verdict='passed'.
//
// Model test: strategy-route.integration.test.ts (T6 twin-equivalence gate).
// Docker guard: same pattern — describe.skipIf(!DOCKER_AVAILABLE); skips cleanly in WSL2.
//
// Fixture: evidence-fixture-1m (30 bars, BTCUSDT 1m, 2025-01-01T00:00:00-00:30Z).
//   Bars 0-19: flat at 100, volume 500k (below 1M threshold — no pump signal).
//   Bar 20: close=115 (15% pump from bar 0), volume=2M → strategy enters SHORT.
//     changePct at bar 20 = (115-100)/100*100=15% >= pumpPct=10%, volume=2M >= minVolume=1M.
//   Bar 21: fill at open=115 (next_bar_open DEFAULT_EXEC).
//   Bars 21-29: price drops 115→91. changePct at each bar < 10% → no re-entry.
//   End of run: forced MTM close at bar 29 close=91. Short PnL = 115-91=24 → WINNING.
//   verdict: total_trades=1 ✓, winRate=1>0 ✓, sharpe>0 ✓, drawdown<1 ✓ → 'passed'.
//
// bundleBytes derivation: Buffer.from(inlineBundle.files[inlineBundle.entry], 'utf8') —
//   raw UTF-8 bytes of the ESM source string the fixture carries. This is the canonical
//   "raw ESM bytes" that sha256BundleRef hashes into bundleHash (NOT JSON.stringify wrapping,
//   which would add spurious quote/escape encoding around the ESM source).
//
// Dev run: pnpm exec vitest run apps/backtester/test/strategy-evidence-driver.integration.test.ts

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import { FixtureDataPort } from '../src/data/reader.js';
import { generateSigningKey, verifySignedEvidenceLocal } from '../src/evidence/signing.js';
import type { EvidenceScope } from '../src/evidence/body.js';
import type { SigningKey } from '../src/evidence/signing.js';
import {
  produceStrategyEvidenceForBundle,
  type StrategyEvidenceDriverInput,
} from '../src/evidence/strategy-evidence-driver.js';
import { FIXTURES_DIR } from './helpers.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = resolve(HERE, 'fixtures/overlay');

function loadInlineBundle(name: string): InlineModuleBundle {
  return JSON.parse(
    readFileSync(resolve(OVERLAY_DIR, 'bundles', name), 'utf8'),
  ) as InlineModuleBundle;
}

function loadRequest(name: string): BacktestRunRequest {
  return JSON.parse(
    readFileSync(resolve(OVERLAY_DIR, 'requests', name), 'utf8'),
  ) as BacktestRunRequest;
}

const inlineBundle = loadInlineBundle('short-after-pump.bundle.json');
// Override datasetRef to point at the evidence fixture (pump-then-drop for a winning short trade).
const baselineReq: BacktestRunRequest = {
  ...loadRequest('baseline.json'),
  datasetRef: 'evidence-fixture-1m',
};

// bundleBytes: raw UTF-8 bytes of the entry-file string the fixture carries.
// inlineBundle.files[inlineBundle.entry] is the ESM source string ('module/index.js' content).
// Buffer.from(..., 'utf8') gives the canonical raw bytes; sha256BundleRef hashes these into
// bundleHash. NOT JSON.stringify — that would add spurious quote-wrapping.
const bundleBytes = Buffer.from(inlineBundle.files[inlineBundle.entry], 'utf8');

// EvidenceScope derived from the (overridden) baseline request period.
const scope: EvidenceScope = {
  datasetRef: baselineReq.datasetRef,
  window: {
    fromMs: Date.parse(baselineReq.period.from),
    toMs: Date.parse(baselineReq.period.to),
  },
  symbols: baselineReq.symbols,
  timeframe: baselineReq.timeframe,
};

// ── H2 guard: non-Docker negative test (fires before materializeBundle) ──────────────────────────
describe('produceStrategyEvidenceForBundle — H2 bundleBytes guard (no Docker required)', () => {
  it('throws when bundleBytes do not match inlineBundle entry file', async () => {
    const key = generateSigningKey();
    const mismatchedBytes = Buffer.from('esm-bundle-bytes-placeholder');
    const input: StrategyEvidenceDriverInput = {
      inlineBundle,
      bundleBytes: mismatchedBytes,
      dataset: {
        datasetRef: baselineReq.datasetRef,
        symbols: baselineReq.symbols,
        timeframe: baselineReq.timeframe,
        period: baselineReq.period,
      },
      baselineRequest: baselineReq,
      scope,
      key,
      backtesterRunId: 'test-driver-h2-guard',
      dataPort: new FixtureDataPort(FIXTURES_DIR),
    };
    await expect(produceStrategyEvidenceForBundle(input)).rejects.toThrow(
      'bundleBytes do not match inlineBundle entry file',
    );
  });
});

describe.skipIf(!DOCKER_AVAILABLE)(
  'produceStrategyEvidenceForBundle — short_after_pump driver (Docker)',
  () => {
    let key: SigningKey;
    let result: Awaited<ReturnType<typeof produceStrategyEvidenceForBundle>>;

    beforeAll(async () => {
      key = generateSigningKey();

      const input: StrategyEvidenceDriverInput = {
        inlineBundle,
        bundleBytes,
        dataset: {
          datasetRef: baselineReq.datasetRef,
          symbols: baselineReq.symbols,
          timeframe: baselineReq.timeframe,
          period: baselineReq.period,
        },
        baselineRequest: baselineReq,
        scope,
        key,
        backtesterRunId: 'test-driver-r1-run-1',
        dataPort: new FixtureDataPort(FIXTURES_DIR),
      };

      result = await produceStrategyEvidenceForBundle(input);
    }, 60_000); // generous: real container boot + 30 bars of synchronous NDJSON IPC

    it('returns verdict="passed"', () => {
      expect(result.verdict).toBe('passed');
    });

    it('bundleHash matches sha256:<hex64> format', () => {
      expect(result.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('signed artifact verifies with the signing key', () => {
      expect(result.signed).toBe(true);
      expect(result.artifact).toBeDefined();
      expect(
        verifySignedEvidenceLocal(result.artifact!, { [key.keyId]: key.publicKeyPem }).ok,
      ).toBe(true);
    });
  },
);
