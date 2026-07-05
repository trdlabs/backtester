import { describe, expect, it } from 'vitest';
import { boundedErrorDetail } from '../src/jobs/bounded-error-detail.js';

describe('boundedErrorDetail', () => {
  it('extracts Error messages', () => {
    expect(boundedErrorDetail(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error inputs', () => {
    expect(boundedErrorDetail('raw string')).toBe('raw string');
    expect(boundedErrorDetail(42)).toBe('42');
    expect(boundedErrorDetail(undefined)).toBe('undefined');
  });

  it('normalizes newlines and control chars to single spaces and collapses whitespace', () => {
    expect(boundedErrorDetail(new Error('a\nb\r\n\tc\x00d   e'))).toBe('a b c d e');
  });

  it('truncates to max', () => {
    expect(boundedErrorDetail(new Error('x'.repeat(500)))).toHaveLength(300);
    expect(boundedErrorDetail(new Error('x'.repeat(500)), 50)).toHaveLength(50);
  });
});
