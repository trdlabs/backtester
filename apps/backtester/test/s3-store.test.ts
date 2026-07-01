import { describe, expect, it } from 'vitest';
import { createFakeS3Client } from './support/fake-s3';
import { S3ArtifactStore } from '../src/artifacts/s3-store';
import { InMemoryArtifactStore } from '../src/artifacts/store';
import { S3BundleStore } from '../src/sandbox/s3-bundle-store';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store';
import { bundleHash } from '../src/sandbox/bundle';
import { createModuleManifest } from '@trading-backtester/sdk/builder';
import type { ModuleBundle } from '@trading-backtester/sdk/contracts';

describe('S3ObjectClient fake contract', () => {
  it('put→get round-trips, head reflects presence, absent get is undefined', async () => {
    const client = createFakeS3Client();
    expect(await client.head('k')).toBe(false);
    expect(await client.get('k')).toBeUndefined();
    await client.put('k', 'value');
    expect(await client.head('k')).toBe(true);
    expect(await client.get('k')).toBe('value');
  });
});

describe('S3ArtifactStore', () => {
  it('write→read round-trips and has() tracks presence', async () => {
    const store = new S3ArtifactStore(createFakeS3Client());
    const payload = { runId: 'r1', metrics: { pnl: 1 } };
    const ref = await store.write(payload);
    expect(ref).toMatch(/^sha256:/);
    expect(await store.has(ref)).toBe(true);
    expect(await store.read(ref)).toEqual(payload);
  });

  it('read of an absent ref throws', async () => {
    const store = new S3ArtifactStore(createFakeS3Client());
    await expect(store.read('sha256:deadbeef')).rejects.toThrow(/not found/);
  });

  it('stores under the artifacts/<hex>.json key', async () => {
    const backing = new Map<string, string>();
    const store = new S3ArtifactStore(createFakeS3Client(backing));
    const ref = await store.write({ a: 1 });
    const hex = ref.slice('sha256:'.length);
    expect([...backing.keys()]).toEqual([`artifacts/${hex}.json`]);
  });

  it('DETERMINISM: identical ContentHash to InMemoryArtifactStore for the same payload', async () => {
    const payload = { x: 1, y: [2, 3], z: 'k' };
    const s3Ref = await new S3ArtifactStore(createFakeS3Client()).write(payload);
    const memRef = await new InMemoryArtifactStore().write(payload);
    expect(s3Ref).toBe(memRef);
  });
});

function makeBundle(): ModuleBundle {
  const manifest = createModuleManifest({
    id: 'b',
    version: '1.0.0',
    kind: 'strategy',
    name: 'fixture',
    summary: 's',
    rationale: 'r',
    hooks: ['onBarClose'],
    paramsSchema: { type: 'object' },
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true },
  });
  return { manifest, entry: 'module.mjs', files: { 'module.mjs': 'export function signals(c){return c.map(()=>false);}' } };
}

describe('S3BundleStore', () => {
  it('put→get round-trips and returns the same hash as bundleHash', async () => {
    const store = new S3BundleStore(createFakeS3Client());
    const b = makeBundle();
    const hash = await store.put(b);
    expect(hash).toBe(bundleHash(b));
    expect(await store.has(hash)).toBe(true);
    expect(await store.get(hash)).toEqual(b);
  });

  it('get of an absent hash is undefined', async () => {
    const store = new S3BundleStore(createFakeS3Client());
    expect(await store.get('sha256:deadbeef')).toBeUndefined();
  });

  it('stores under the bundles/<hex>.json key', async () => {
    const backing = new Map<string, string>();
    const hash = await new S3BundleStore(createFakeS3Client(backing)).put(makeBundle());
    const hex = hash.slice('sha256:'.length);
    expect([...backing.keys()]).toEqual([`bundles/${hex}.json`]);
  });

  it('DETERMINISM: identical hash to InMemoryBundleStore for the same bundle', async () => {
    const b = makeBundle();
    const s3Hash = await new S3BundleStore(createFakeS3Client()).put(b);
    const memHash = await new InMemoryBundleStore().put(b);
    expect(s3Hash).toBe(memHash);
  });
});
