import { describe, expect, it } from 'vitest';
import { createFakeS3Client } from './support/fake-s3';
import { S3ArtifactStore } from '../src/artifacts/s3-store';
import { InMemoryArtifactStore } from '../src/artifacts/store';

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
