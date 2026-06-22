// Slice-6b-A — Task 7: материализация inline `ModuleBundle` → temp `bundleDir`, принимаемый
// платформенным (lifted) 017/019 acceptance-gate. Чистый host-код — Docker НЕ требуется.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleBundle } from '@trading/research-contracts';
import { platformContractContext } from '@trading/research-contracts/research';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { loadBundle } from '../src/engine/sandbox/bundle.js';
import { validateBundle } from '../src/engine/sandbox/acceptance-gate.js';

function loadInlineBundle(name: string): ModuleBundle {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/overlay/bundles/${name}.bundle.json`, import.meta.url), 'utf8'),
  ) as ModuleBundle;
}

describe('materialize inline bundle → temp bundleDir + 017/019 acceptance-gate', () => {
  for (const [name, expectedKind] of [
    ['short-after-pump', 'strategy'],
    ['early-exit-short-after-pump', 'overlay'],
  ] as const) {
    it(`materializes ${name} (kind:${expectedKind}) and the acceptance-gate accepts it`, async () => {
      const inline = loadInlineBundle(name);
      const { bundleDir, cleanup } = await materializeBundle(inline);

      expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(bundleDir, 'bundle.json'))).toBe(true);
      expect(existsSync(join(bundleDir, inline.entry))).toBe(true);

      const loaded = loadBundle(bundleDir);
      // дескриптор зеркалит manifest.kind и несёт 017-версию контракта (∈ supported set).
      expect(loaded.descriptor.kind).toBe(expectedKind);
      expect(loaded.descriptor.contractVersion).toBe('017.1');
      expect(loaded.descriptor.entryPoint).toBe(inline.entry);
      expect(loaded.descriptor.bundleHash).toMatch(/^sha256:/);

      // Известные strategy-ref'ы: сам модуль + (для overlay) его targetStrategyRef — иначе 017-гейт
      // overlay даёт unknown_strategy_ref. Это контекст вызывающего, а не дефект материализации.
      const targetRef = (loaded.manifest as { targetStrategyRef?: string }).targetStrategyRef;
      const knownRefs = targetRef ? [loaded.manifest.id, targetRef] : [loaded.manifest.id];
      const result = validateBundle(loaded, platformContractContext(knownRefs));
      expect(result.status).toBe('accepted'); // 017-манифест + целостность OK
      expect(result.issues).toEqual([]);
      expect(result.bundleHash).toBe(loaded.descriptor.bundleHash);

      // Sandbox containers run as nobody — bundle tree must be world-readable.
      expect(statSync(bundleDir).mode & 0o777).toBe(0o755);
      expect(statSync(join(bundleDir, inline.entry)).mode & 0o777).toBe(0o644);

      await cleanup();
      expect(existsSync(bundleDir)).toBe(false);
      await cleanup(); // idempotent (force)
    });
  }

  it('rejects a tampered bundle (integrity: recomputed bundleHash != descriptor.bundleHash)', async () => {
    const inline = loadInlineBundle('short-after-pump');
    const { bundleDir, cleanup } = await materializeBundle(inline);

    // Мутируем payload-файл ПОСЛЕ записи дескриптора: перевычисленный sha256 разойдётся с зафиксированным
    // bundleHash → bundle_integrity_violation.
    const entryAbs = join(bundleDir, inline.entry);
    writeFileSync(entryAbs, `${readFileSync(entryAbs, 'utf8')}\n// tampered\n`, 'utf8');

    const loaded = loadBundle(bundleDir);
    const result = validateBundle(loaded, platformContractContext([loaded.manifest.id]));

    expect(result.status).not.toBe('accepted');
    expect(result.status).toBe('rejected');
    expect(result.issues.some((i) => i.code === 'bundle_integrity_violation')).toBe(true);

    await cleanup();
  });

  it('honours an explicit baseDir (writes the bundle under it, world-readable)', async () => {
    const { mkdtempSync, statSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = mkdtempSync(join(tmpdir(), 'btx-volbase-'));

    const inline = loadInlineBundle('short-after-pump');
    const { bundleDir, cleanup } = await materializeBundle(inline, base);

    expect(bundleDir.startsWith(base)).toBe(true);
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(true);
    expect(statSync(bundleDir).mode & 0o777).toBe(0o755);

    await cleanup();
    expect(existsSync(bundleDir)).toBe(false);
  });
});
