import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LONG_OI_MODULE, createLongOiModule } from './fixtures/strategies/long_oi/module.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, 'fixtures/strategies/long_oi');

describe('vendored long_oi module', () => {
  it('resolves and is a StrategyModule', () => {
    expect(typeof LONG_OI_MODULE.onBarClose).toBe('function');
    expect(LONG_OI_MODULE.manifest).toBeDefined();
    expect(typeof createLongOiModule).toBe('function');
    // fresh state per call (no shared mutable module state)
    expect(createLongOiModule()).not.toBe(LONG_OI_MODULE);
  });

  it('matches its committed checksums (drift guard)', () => {
    const lines = readFileSync(resolve(DIR, 'CHECKSUMS.txt'), 'utf8').trim().split('\n');
    const expected = new Map(lines.map((l) => { const [h, f] = l.split('  '); return [f, h]; }));
    const tsFiles = readdirSync(DIR).filter((f) => f.endsWith('.ts')).sort();
    for (const f of tsFiles) {
      const h = createHash('sha256').update(readFileSync(resolve(DIR, f))).digest('hex');
      expect(`${f}: ${h}`).toBe(`${f}: ${expected.get(f)}`);
    }
    // every vendored .ts is covered by the checksum manifest
    expect(tsFiles.every((f) => expected.has(f))).toBe(true);
  });
});
