import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Shared single-definition hash fn — also used by the build script to write the manifest.
import { computeIndicatorSourceHash } from '../scripts/indicator-source-hash.mjs';

// Slice 6b-A — drift guard: the overlay harness's `_engine/` is compiled from src/engine/indicators/**
// (the single source). The build script records a hash of that source tree in `.build-manifest.json`.
// If the .ts source changes without rebuilding `_engine`, the manifest hash diverges from the
// recomputed hash and this test fails — forcing a rebuild so trusted↔sandbox stay byte-identical.
// `_engine` is gitignored + built by vitest globalSetup, so the manifest is present when this runs.
describe('overlay sandbox harness _engine', () => {
  it('is built from src/engine/indicators (no drift)', () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../sandbox-harness-overlay/_engine/.build-manifest.json', import.meta.url),
        'utf8',
      ),
    );
    expect(manifest.sourceHash).toBe(computeIndicatorSourceHash());
  });
});
