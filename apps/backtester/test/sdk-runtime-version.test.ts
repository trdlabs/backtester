import { SDK_VERSION } from '@trdlabs/sdk';
import { expect, test } from 'vitest';

test('uses @trdlabs/sdk 0.13.0 at runtime', () => {
  expect(SDK_VERSION).toBe('0.13.0');
});
