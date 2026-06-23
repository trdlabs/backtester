import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ensureHarnessInVolume } from '../src/engine/sandbox/harness-volume.js';

function makeHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), 'btx-harness-src-'));
  writeFileSync(join(dir, 'entry.mjs'), '// entry\n');
  mkdirSync(join(dir, '_engine'));
  writeFileSync(join(dir, '_engine', 'engine.js'), 'export const x = 1;\n');
  return dir;
}

describe('ensureHarnessInVolume', () => {
  it('copies the harness tree under <mountpoint>/harness/<hash>, world-readable', () => {
    const src = makeHarness();
    const mp = mkdtempSync(join(tmpdir(), 'btx-mp-'));
    const dest = ensureHarnessInVolume(src, mp);

    expect(dest.startsWith(join(mp, 'harness'))).toBe(true);
    expect(relative(mp, dest).startsWith('..')).toBe(false); // under the mountpoint
    expect(readFileSync(join(dest, 'entry.mjs'), 'utf8')).toContain('// entry');
    expect(readFileSync(join(dest, '_engine', 'engine.js'), 'utf8')).toContain('export const x');
    expect(statSync(join(mp, 'harness')).mode & 0o777).toBe(0o755);
    expect(statSync(dest).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, 'entry.mjs')).mode & 0o777).toBe(0o644);
  });

  it('is idempotent and stable: same source → same dest path on a second call', () => {
    const src = makeHarness();
    const mp = mkdtempSync(join(tmpdir(), 'btx-mp-'));
    const a = ensureHarnessInVolume(src, mp);
    const b = ensureHarnessInVolume(src, mp);
    expect(a).toBe(b);
    expect(existsSync(a)).toBe(true);
  });
});
