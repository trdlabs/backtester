import { describe, expect, it } from 'vitest';
import { canTransition } from '../src/jobs/lifecycle.js';

describe('lifecycle — requeue', () => {
  it('allows running -> queued (lease requeue)', () => {
    expect(canTransition('running', 'queued')).toBe(true);
  });
  it('still forbids terminal -> queued', () => {
    expect(canTransition('completed', 'queued')).toBe(false);
  });
});
