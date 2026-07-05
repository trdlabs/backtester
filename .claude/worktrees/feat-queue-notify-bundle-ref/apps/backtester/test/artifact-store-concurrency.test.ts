import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FileArtifactStore } from '../src/artifacts/store.js';

describe('FileArtifactStore concurrent writes', () => {
  it('writes the same payload concurrently and always reads back intact', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'bt-artifact-conc-'));
    const store = new FileArtifactStore(dir);
    const payload = { a: 1, nested: { values: Array.from({ length: 500 }, (_, i) => i) } };

    const refs = await Promise.all(Array.from({ length: 20 }, () => store.write(payload)));
    // Content-addressed: every concurrent write yields the same ref.
    expect(new Set(refs.map(String)).size).toBe(1);

    const readBack = await store.read(refs[0]!);
    expect(readBack).toEqual(payload); // never a truncated/torn file
  });
});
