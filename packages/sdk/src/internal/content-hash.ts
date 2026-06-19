import { createHash } from 'node:crypto';
import type { ContentHash } from './shared-types';
import type { ModuleBundle } from '../contracts/module';
import { canonicalJson } from './canonical-json';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function contentRef(payload: unknown): ContentHash {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

export function canonicalBundleHash(bundle: ModuleBundle): ContentHash {
  return contentRef(bundle);
}
