import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureHarnessInVolume } from '../src/engine/sandbox/harness-volume.js';

describe('ensureHarnessInVolume', () => {
  it('materializes the harness into the volume and is idempotent', () => {
    const harnessDir = mkdtempSync(resolve(tmpdir(), 'bt-harness-src-'));
    mkdirSync(join(harnessDir, 'sub'), { recursive: true });
    writeFileSync(join(harnessDir, 'entry.mjs'), 'export const x = 1;\n');
    writeFileSync(join(harnessDir, 'sub', 'f.txt'), 'hi\n');
    const mountpoint = mkdtempSync(resolve(tmpdir(), 'bt-mount-'));

    const dest1 = ensureHarnessInVolume(harnessDir, mountpoint);
    expect(existsSync(join(dest1, 'entry.mjs'))).toBe(true);
    expect(readFileSync(join(dest1, 'sub', 'f.txt'), 'utf8')).toBe('hi\n');

    // Second call: dest already exists -> idempotent no-op, same path.
    const dest2 = ensureHarnessInVolume(harnessDir, mountpoint);
    expect(dest2).toBe(dest1);
  });
});
