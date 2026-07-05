/**
 * sdk-release-manifest.ts
 *
 * Pure function `releaseManifest` + CLI entry for generating a JSON release manifest
 * that records the package version, source commit SHA, artifact filename, and SHA-256
 * checksum for each SDK release.
 *
 * Pure function: usable in Vitest without any filesystem access.
 * CLI: positional args: version sourceSha asset sha256 outputPath
 *      Exits 1 if any argument is missing; writes JSON to outputPath on success.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReleaseManifestInput {
  readonly version: string;
  readonly sourceSha: string;
  readonly asset: string;
  readonly sha256: string;
}

// ---------------------------------------------------------------------------
// Pure manifest constructor
// ---------------------------------------------------------------------------

export function releaseManifest(input: ReleaseManifestInput) {
  return {
    package: '@trading-backtester/sdk' as const,
    version: input.version,
    sourceSha: input.sourceSha,
    asset: input.asset,
    sha256: input.sha256,
  };
}

// ---------------------------------------------------------------------------
// CLI entry — only runs when invoked directly
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('sdk-release-manifest.ts') ||
    process.argv[1].endsWith('sdk-release-manifest.js') ||
    process.argv[1].endsWith('sdk-release-manifest.mjs'));

if (isMain) {
  const [, , version, sourceSha, asset, sha256, outputPath] = process.argv;

  const missing: string[] = [];
  if (!version) missing.push('version');
  if (!sourceSha) missing.push('sourceSha');
  if (!asset) missing.push('asset');
  if (!sha256) missing.push('sha256');
  if (!outputPath) missing.push('outputPath');

  if (missing.length > 0) {
    console.error(
      `sdk-release-manifest: missing required arguments: ${missing.join(', ')}\n` +
        'Usage: tsx scripts/sdk-release-manifest.ts <version> <sourceSha> <asset> <sha256> <outputPath>',
    );
    process.exit(1);
  }

  const manifest = releaseManifest({
    version: version!,
    sourceSha: sourceSha!,
    asset: asset!,
    sha256: sha256!,
  });

  const absoluteOutput = resolve(process.cwd(), outputPath!);
  writeFileSync(absoluteOutput, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`sdk-release-manifest: wrote ${absoluteOutput}`);
  process.exit(0);
}
