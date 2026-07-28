import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('BACKTESTER_CONTEXT_FREEZE_DISABLED config', () => {
  it('по умолчанию заморозка включена — прежнее поведение', () => {
    expect(loadConfig({}).contextFreeze).toBe(true);
  });

  it('снимается только точной строкой "true"', () => {
    expect(loadConfig({ BACKTESTER_CONTEXT_FREEZE_DISABLED: 'true' }).contextFreeze).toBe(false);
    // Мусор и опечатки не должны молча выключать диагностику: всё, кроме точного "true",
    // оставляет прежнее поведение.
    for (const noise of ['1', 'on', 'yes', 'TRUE', '', 'false']) {
      expect(loadConfig({ BACKTESTER_CONTEXT_FREEZE_DISABLED: noise }).contextFreeze).toBe(true);
    }
  });
});
