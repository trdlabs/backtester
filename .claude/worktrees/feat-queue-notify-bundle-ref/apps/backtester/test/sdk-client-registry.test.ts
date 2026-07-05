import { describe, expect, it } from 'vitest';
import { BacktesterClient } from '../../../packages/sdk/src/client/index';
import type { FetchLike, FetchLikeResponse } from '../../../packages/sdk/src/client/client';
import type { RegistryDescriptor } from '../../../packages/sdk/src/contracts/index';

describe('BacktesterClient.discoverRegistry', () => {
  it('GETs /v1/registry with bearer auth and returns the descriptor', async () => {
    const descriptor: RegistryDescriptor = {
      contractVersion: '017.2',
      baselines: [{ id: 'short_after_pump', version: '0.1.0' }],
      overlays: [], riskProfiles: [], execProfiles: [],
      metricCatalogs: { momentum: [], overlay: ['pnl'] },
      overlayRunPresets: [{
        id: 'default-overlay',
        baselineRef: { id: 'short_after_pump', version: '0.1.0' },
        riskProfileRef: { id: 'default_risk', version: '1.0.0' },
        executionProfileRef: { id: 'default_exec', version: '1.0.0' },
        metrics: ['pnl'],
      }],
    };
    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, auth: init?.headers?.['authorization'] });
      return { ok: true, status: 200, json: async () => descriptor, text: async () => '' } satisfies FetchLikeResponse;
    };
    const client = new BacktesterClient({ baseUrl: 'http://bt.test', token: 'test-token', fetchImpl });
    const got = await client.discoverRegistry();
    expect(got).toEqual(descriptor);
    expect(calls.at(-1)?.url).toBe('http://bt.test/v1/registry');
    expect(calls.at(-1)?.method).toBe('GET');
    expect(calls.at(-1)?.auth).toBe('Bearer test-token');
  });
});
