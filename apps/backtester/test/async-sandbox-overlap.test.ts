import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { BacktestRunRequest, ModuleBundle } from '@trading/research-contracts';
import { AUTH, buildTestApp } from './helpers.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQ = resolve(HERE, 'fixtures/overlay/requests');
const BUN = resolve(HERE, 'fixtures/overlay/bundles');
const loadRequest = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(REQ, n), 'utf8')) as BacktestRunRequest;
const loadBundle = (n: string): ModuleBundle =>
  JSON.parse(readFileSync(resolve(BUN, n), 'utf8')) as ModuleBundle;

const N = 4;
const countSandboxContainers = (): number => {
  try {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.includes('overlap-')).length;
  } catch {
    return 0;
  }
};

describe.skipIf(!DOCKER_AVAILABLE)('async sandbox overlap (real containers)', () => {
  it('drains N overlay+bundle runs with ≥2 containers alive concurrently', async () => {
    const app = await buildTestApp({ enableOverlayEngine: true, workerConcurrency: N });
    try {
      const variant = loadRequest('variant.json');
      const bundle = loadBundle('early-exit-short-after-pump.bundle.json');
      for (let i = 0; i < N; i += 1) {
        const res = await app.server.inject({
          method: 'POST', url: '/v1/runs', headers: AUTH,
          payload: { ...variant, runId: `overlap-${i}`, seed: 7000 + i, engine: 'overlay', moduleBundle: bundle },
        });
        expect(res.statusCode).toBe(202);
      }
      let peak = 0;
      const poll = setInterval(() => { peak = Math.max(peak, countSandboxContainers()); }, 25);
      const processed = await app.drain();
      clearInterval(poll);
      expect(processed).toBe(N);
      expect(peak).toBeGreaterThanOrEqual(2);
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
