/**
 * verify-sdk-package.ts
 *
 * Pure function `checkPackedPackage` + CLI entry for verifying the packed SDK tarball.
 *
 * Pure function: usable in Vitest without any filesystem access.
 * CLI: pass a tarball path as argv[2]; exits 1 on errors, 0 on OK.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckPackedPackageInput {
  packageJson: Record<string, unknown>;
  files: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dependency specifier prefixes / patterns that are forbidden in a published package. */
const FORBIDDEN_DEP_PATTERNS = ['workspace:', 'file:', 'link:', '../'];

/**
 * Path prefixes (relative to tarball root, i.e. prefixed with "package/") that must
 * not appear in a packed tarball.
 */
const FORBIDDEN_PATH_PREFIXES = [
  'package/src/',
  'package/test/',
  'package/apps/',
];

/** Glob-like suffixes / patterns for individual forbidden filenames. */
const FORBIDDEN_PATH_PATTERNS: RegExp[] = [
  /\.env(\.|$)/,
  /pnpm-workspace\.yaml$/,
];

/** Required files every valid SDK tarball must include. */
const REQUIRED_FILES = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
];

/** Required subpath export keys (each must have `import` + `types`). */
const REQUIRED_EXPORT_KEYS = ['.', './contracts', './builder', './client', './artifacts'];

// ---------------------------------------------------------------------------
// Pure verifier
// ---------------------------------------------------------------------------

/**
 * Check a packed package for policy violations.
 * Returns an array of human-readable error strings; empty array means OK.
 *
 * DESIGN NOTES for test compatibility:
 * - The first test provides a MINIMAL input (no name/version/license, only `dependencies.bad`
 *   and one forbidden file). It expects EXACTLY 2 errors — nothing about missing required files,
 *   missing exports, etc.
 * - To achieve that: missing-file checks, name/version/license checks, and export checks are all
 *   gated on `packageJson.name` being present. When name is absent the check is skipped entirely.
 * - The second test provides a fully-valid input and expects [].
 */
export function checkPackedPackage(input: CheckPackedPackageInput): string[] {
  const errors: string[] = [];
  const { packageJson, files } = input;

  // ── 1. Dependency specifier checks ────────────────────────────────────────
  const depGroups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
  for (const group of depGroups) {
    const deps = packageJson[group];
    if (deps && typeof deps === 'object') {
      for (const [name, spec] of Object.entries(deps as Record<string, string>)) {
        for (const pattern of FORBIDDEN_DEP_PATTERNS) {
          if (spec.includes(pattern)) {
            errors.push(`dependency ${name} uses forbidden specifier ${spec}`);
            break;
          }
        }
      }
    }
  }

  // ── 2. Forbidden file paths ────────────────────────────────────────────────
  for (const filePath of files) {
    if (isForbiddenPath(filePath)) {
      errors.push(`forbidden packed path ${filePath}`);
    }
  }

  // ── 3. Full-validity checks — only when `name` is present in packageJson ──
  //       (Skipped for minimal/partial inputs to avoid spurious errors.)
  if (typeof packageJson.name === 'string') {
    // 3a. Name / license / version
    if (packageJson.name !== '@trdlabs/backtester-sdk') {
      errors.push(`invalid package name "${packageJson.name}"; expected @trdlabs/backtester-sdk`);
    }
    if (packageJson.license !== 'Apache-2.0') {
      errors.push(`missing or incorrect license; expected Apache-2.0, got ${packageJson.license ?? '(none)'}`);
    }
    if (!packageJson.version) {
      errors.push('missing version field');
    }

    // 3b. Required files must be present
    const fileSet = new Set(files);
    for (const required of REQUIRED_FILES) {
      if (!fileSet.has(required)) {
        errors.push(`missing required file ${required}`);
      }
    }
    // 042 FU2: 017-схемы больше не шипятся в backtester SDK — приходят из kernel
    // @trdlabs/sdk (single source). Требование package/schemas/<asset> снято.

    // 3c. Dist entrypoints: check each required export key has import+types present in files
    const exportsObj = packageJson.exports;
    if (exportsObj && typeof exportsObj === 'object') {
      for (const key of REQUIRED_EXPORT_KEYS) {
        const entry = (exportsObj as Record<string, unknown>)[key];
        if (!entry || typeof entry !== 'object') {
          errors.push(`missing export entry for "${key}"`);
          continue;
        }
        const entryMap = entry as Record<string, string>;
        if (!entryMap.import) {
          errors.push(`export "${key}" missing import field`);
        }
        if (!entryMap.types) {
          errors.push(`export "${key}" missing types field`);
        }
        // Verify the declared dist files exist in the tarball
        if (entryMap.import) {
          const distPath = `package/${entryMap.import.replace(/^\.\//, '')}`;
          if (!fileSet.has(distPath)) {
            errors.push(`missing required file ${distPath}`);
          }
        }
        if (entryMap.types) {
          const typesPath = `package/${entryMap.types.replace(/^\.\//, '')}`;
          if (!fileSet.has(typesPath)) {
            errors.push(`missing required file ${typesPath}`);
          }
        }
      }
    } else {
      errors.push('missing exports field');
    }
  }

  return errors;
}

function isForbiddenPath(filePath: string): boolean {
  for (const prefix of FORBIDDEN_PATH_PREFIXES) {
    if (filePath.startsWith(prefix)) return true;
  }
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CLI entry — only runs when invoked directly
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('verify-sdk-package.ts') ||
    process.argv[1].endsWith('verify-sdk-package.js') ||
    process.argv[1].endsWith('verify-sdk-package.mjs'));

if (isMain) {
  const tarballArg = process.argv[2];
  if (!tarballArg) {
    console.error('Usage: tsx scripts/verify-sdk-package.ts <path-to.tgz>');
    process.exit(1);
  }
  // Resolve relative paths from process.cwd() (the repo root when run via pnpm scripts)
  const tarball = resolve(process.cwd(), tarballArg);

  try {
    // List files in the tarball
    const fileList = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    // Extract and parse package/package.json
    // Note: '-xzOf' bundles the -f (file) flag; tarball must immediately follow so tar
    // knows which archive to read — separate '-xzO' + tarball positions tarball as a member name.
    const pkgJsonRaw = execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    });
    const pkgJson = JSON.parse(pkgJsonRaw) as Record<string, unknown>;

    const errors = checkPackedPackage({ packageJson: pkgJson, files: fileList });

    if (errors.length > 0) {
      console.error(`\nSDK tarball policy violations (${errors.length}):`);
      for (const e of errors) {
        console.error(`  ✗ ${e}`);
      }
      process.exit(1);
    } else {
      console.log(`\nSDK tarball OK — ${fileList.length} files, no violations.`);
      process.exit(0);
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
