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

  // Regression (F1, 2026-07-26): the overlay's `_engine/` is a gitignored, build-generated tree
  // (`pnpm run build:sandbox-harness-overlay`). A deploy that skips that build ships an overlay whose
  // `rehydrate.mjs` imports a missing `./_engine/engine.js`; the container then dies at ESM resolve as
  // a cryptic per-run `bundle_load_failed`. Materialization must fail fast at the source with an
  // actionable message instead — so a missing build surfaces once, clearly, not once per strategy run.
  it('throws an actionable error when the source overlay is missing _engine/engine.js', () => {
    const src = mkdtempSync(join(tmpdir(), 'btx-harness-incomplete-'));
    writeFileSync(join(src, 'entry.mjs'), '// entry\n'); // entrypoint present, _engine/ never built
    const mp = mkdtempSync(join(tmpdir(), 'btx-mp-'));

    expect(() => ensureHarnessInVolume(src, mp)).toThrowError(/_engine\/engine\.js/);
    expect(() => ensureHarnessInVolume(src, mp)).toThrowError(/build:sandbox-harness-overlay/);
    // Nothing partial published on rejection.
    expect(existsSync(join(mp, 'harness'))).toBe(false);
  });

  it('throws when the source overlay is missing entry.mjs', () => {
    const src = mkdtempSync(join(tmpdir(), 'btx-harness-noentry-'));
    mkdirSync(join(src, '_engine'));
    writeFileSync(join(src, '_engine', 'engine.js'), 'export const x = 1;\n');
    const mp = mkdtempSync(join(tmpdir(), 'btx-mp-'));
    expect(() => ensureHarnessInVolume(src, mp)).toThrowError(/entry\.mjs/);
  });
});
