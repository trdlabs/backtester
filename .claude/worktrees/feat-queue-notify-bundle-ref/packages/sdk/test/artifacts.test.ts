import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isContentHash,
  type ArtifactManifest,
  type ContentHash,
} from '../src/artifacts/index';

describe('artifact contracts', () => {
  it('accepts only lowercase sha256 content references', () => {
    expect(isContentHash(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isContentHash(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(isContentHash('sha256:short')).toBe(false);
  });

  it('keeps manifest content hashes typed', () => {
    expectTypeOf<ArtifactManifest['descriptors'][number]['contentHash']>()
      .toEqualTypeOf<ContentHash>();
  });
});
