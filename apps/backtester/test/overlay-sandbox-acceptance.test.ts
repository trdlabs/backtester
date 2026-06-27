import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bundleHash } from '../src/sandbox/bundle.js'; // Slice-3 bundleHash = contentRef; reuse for identity
import type { ModuleBundle } from '@trading/research-contracts';

function loadInlineBundle(name: string): ModuleBundle {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/overlay/bundles/${name}.bundle.json`, import.meta.url), 'utf8'),
  ) as ModuleBundle;
}

describe('lifted hooks-bundle fixtures', () => {
  for (const [name, id, hooks] of [
    ['short-after-pump', 'short_after_pump', ['onBarClose']],
    ['early-exit-short-after-pump', 'early_exit_short_after_pump', ['apply']],
  ] as const) {
    it(`${name}: parses, declares hooks, content-addresses stably`, () => {
      const b = loadInlineBundle(name);
      expect(b.manifest.id).toBe(id);
      expect((b.manifest as unknown as { hooks?: string[] }).hooks).toEqual(hooks);
      expect(b.files[b.entry]).toContain('export'); // module source present
      const again = loadInlineBundle(name); // fresh JSON.parse of the same fixture
      expect(bundleHash(again)).toBe(bundleHash(b)); // content-addressed identity is stable across independent parses
      expect(bundleHash(b)).toMatch(/^sha256:/);
    });
  }
});
