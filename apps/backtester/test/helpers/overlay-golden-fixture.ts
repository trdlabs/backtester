// Фикстура overlay-голденов, вынесенная из `overlay-golden.test.ts`, чтобы ОДИН и тот же сценарий
// исполняли и тест, и derivation-скрипт (`apps/backtester/scripts/derive_goldens.mjs`). Два
// параллельных определения «как получить golden» разъехались бы — а именно на них держится
// доказательство, что перебазировка хеша ничего не спрятала.
//
// Живёт в non-`.test.ts` модуле: импорт тест-файла ради константы заодно исполнил бы его
// `describe`/`it` (тест-файлы Vitest — обычные ES-модули).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BacktestRunRequest } from '@trading/research-contracts';

import { buildOverlayDataset } from '../../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../../src/engine/run-overlay.js';
import { buildTrustedRegistry } from '../../src/engine/trusted-registry.js';
import { FixtureDataPort } from '../../src/data/reader.js';
import { FIXTURES_DIR } from '../helpers.js';

const OVERLAY_REQUESTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures/overlay/requests',
);

export function loadOverlayRequest(name: string): BacktestRunRequest {
  return JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, name), 'utf8')) as BacktestRunRequest;
}

export async function overlayGoldenDeps(req: BacktestRunRequest) {
  const registry = buildTrustedRegistry();
  const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
    datasetRef: req.datasetRef,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
  });
  return { registry, marketTape };
}

/** Прогон, чей canonical payload и есть overlay-golden. */
export async function runOverlayGolden(
  req: BacktestRunRequest,
  deps: Awaited<ReturnType<typeof overlayGoldenDeps>>,
): Promise<unknown> {
  return runOverlayBacktest(req, deps);
}
