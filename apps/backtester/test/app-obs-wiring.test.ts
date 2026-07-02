import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ObsRegistry } from '../src/jobs/obs-registry.js';
import { testConfig } from './helpers.js';

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe('buildApp obs wiring', () => {
  it('sets workerDeps.obs when jobObs is on', async () => {
    const app = await buildApp(testConfig({ jobObs: true }));
    dispose = app.dispose;
    expect(app.workerDeps.obs).toBeInstanceOf(ObsRegistry);
  });

  it('leaves workerDeps.obs undefined when jobObs is off', async () => {
    const app = await buildApp(testConfig({ jobObs: false }));
    dispose = app.dispose;
    expect(app.workerDeps.obs).toBeUndefined();
  });
});
