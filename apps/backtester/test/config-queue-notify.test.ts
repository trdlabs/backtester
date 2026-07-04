import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('queue-notify config', () => {
  it('defaults off', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).queueNotify).toBe(false);
  });
  it('true only for exact "true"', () => {
    expect(loadConfig({ BACKTESTER_QUEUE_NOTIFY: 'true' } as NodeJS.ProcessEnv).queueNotify).toBe(true);
    expect(loadConfig({ BACKTESTER_QUEUE_NOTIFY: '1' } as NodeJS.ProcessEnv).queueNotify).toBe(false);
  });
});
