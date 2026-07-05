// Slice 6b-A — single source of truth for the indicator-engine drift hash.
//
// Imported by BOTH the overlay-harness build script (which writes the hash into
// `_engine/.build-manifest.json`) and the drift-guard test (which recomputes it and asserts equality).
// ONE definition: if `src/engine/indicators/**` changes without rebuilding `_engine`, the manifest hash
// and this recomputed hash diverge and the drift-guard test fails.
//
// The hash is a sha256 over a CANONICAL (sorted-key) JSON serialization of the file map
// { <repo-relative path> -> <file contents> } covering every file under src/engine/indicators.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // apps/backtester/scripts
const appRoot = dirname(here); // apps/backtester
const INDICATORS_DIR = join(appRoot, 'src', 'engine', 'indicators');

/** Recursively collect every file path under `dir` (absolute), depth-first. */
function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Compute the drift hash over `src/engine/indicators/**`.
 * Returns a hex sha256 string. Paths are normalized to forward-slash, repo-root-relative so the hash
 * is platform-stable. The file map is serialized with sorted keys (canonical JSON) before hashing.
 */
export function computeIndicatorSourceHash() {
  const repoRoot = dirname(dirname(appRoot)); // apps/backtester -> apps -> repo root
  const files = collectFiles(INDICATORS_DIR);
  const map = {};
  for (const abs of files) {
    const key = relative(repoRoot, abs).split('\\').join('/');
    map[key] = readFileSync(abs, 'utf8');
  }
  const sortedKeys = Object.keys(map).sort();
  const canonical = JSON.stringify(sortedKeys.map((k) => [k, map[k]]));
  return createHash('sha256').update(canonical).digest('hex');
}
