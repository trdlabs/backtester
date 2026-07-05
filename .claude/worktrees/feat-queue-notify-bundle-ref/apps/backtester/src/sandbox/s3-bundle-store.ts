// S3-compatible BundleStore — same content-addressing (bundleHash + canonicalJson) as the
// filesystem store. Key layout: bundles/<hex>.json.

import type { ContentHash, ModuleBundle } from '@trading/research-contracts';
import { canonicalJson } from '../determinism/canonical-json';
import { bundleHash } from './bundle';
import type { BundleStore } from './bundle-store';
import type { S3ObjectClient } from '../storage/s3-client';

const hexOf = (ref: ContentHash): string => ref.slice('sha256:'.length);
const keyFor = (hash: ContentHash): string => `bundles/${hexOf(hash)}.json`;

export class S3BundleStore implements BundleStore {
  constructor(private readonly client: S3ObjectClient) {}

  async put(bundle: ModuleBundle): Promise<ContentHash> {
    const hash = bundleHash(bundle);
    await this.client.put(keyFor(hash), canonicalJson(bundle));
    return hash;
  }

  async get(hash: ContentHash): Promise<ModuleBundle | undefined> {
    const raw = await this.client.get(keyFor(hash));
    return raw === undefined ? undefined : (JSON.parse(raw) as ModuleBundle);
  }

  async has(hash: ContentHash): Promise<boolean> {
    return this.client.head(keyFor(hash));
  }
}
