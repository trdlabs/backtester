// S3-compatible ArtifactStore — same content-addressing (contentRef + canonicalJson) as the
// filesystem store, so ContentHash values are byte-identical. Key layout: artifacts/<hex>.json.

import type { ContentHash } from '@trading-backtester/sdk/artifacts';
import { canonicalJson } from '../determinism/canonical-json';
import { contentRef } from '../determinism/hash';
import type { ArtifactStore } from './store';
import type { S3ObjectClient } from '../storage/s3-client';

const hexOf = (ref: ContentHash): string => ref.slice('sha256:'.length);
const keyFor = (ref: ContentHash): string => `artifacts/${hexOf(ref)}.json`;

export class S3ArtifactStore implements ArtifactStore {
  constructor(private readonly client: S3ObjectClient) {}

  async write(payload: unknown): Promise<ContentHash> {
    const ref = contentRef(payload);
    await this.client.put(keyFor(ref), canonicalJson(payload));
    return ref;
  }

  async read(ref: ContentHash): Promise<unknown> {
    const raw = await this.client.get(keyFor(ref));
    if (raw === undefined) throw new Error(`artifact not found: ${ref}`);
    return JSON.parse(raw);
  }

  async has(ref: ContentHash): Promise<boolean> {
    return this.client.head(keyFor(ref));
  }
}
