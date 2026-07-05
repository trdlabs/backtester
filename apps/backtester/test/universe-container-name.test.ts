import { describe, expect, it } from 'vitest';
import { universeContainerName } from '../src/engine/sandbox/docker-driver.js';

describe('universeContainerName', () => {
  it('includes kind + bundle-hash so strategy and overlay do not collide', () => {
    const strat = universeContainerName('run-1', 'strategy', 'sha256:abcdef0123456789');
    const over = universeContainerName('run-1', 'overlay', 'sha256:abcdef0123456789');
    expect(strat).not.toBe(over);
    expect(strat).toContain('strategy');
    expect(over).toContain('overlay');
    expect(strat.startsWith('sbx-run-1-strategy-')).toBe(true);
  });
  it('sanitizes and caps at 200 chars', () => {
    const n = universeContainerName('run/with:bad', 'strategy', 'sha256:' + 'a'.repeat(64), 'x'.repeat(300));
    expect(n).toMatch(/^[a-zA-Z0-9_.-]+$/);
    expect(n.length).toBeLessThanOrEqual(200);
  });
});
