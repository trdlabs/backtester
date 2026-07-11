import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  API_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
  BUNDLE_CONTRACT_VERSION,
  type ModuleBundle,
  type RunSubmitRequest,
} from '../src/contracts/index';

describe('public contracts', () => {
  it('pins the current contract versions', () => {
    expect(API_CONTRACT_VERSION).toBe('017.2');
    expect(BUNDLE_CONTRACT_VERSION).toBe('019.1');
    expect(ARTIFACT_CONTRACT_VERSION).toBe('022.2');
  });

  it('types submitted bundles and runs', () => {
    expectTypeOf<RunSubmitRequest['moduleBundle']>()
      .toEqualTypeOf<ModuleBundle | undefined>();
  });
});
