import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Keep in sync with the workspace members (pnpm-workspace.yaml `packages:` + apps/*).
const MANIFESTS = [
  'package.json',
  'apps/backtester/package.json',
  'packages/research-contracts/package.json',
  'packages/sdk/package.json',
];
// devDependencies are intentionally excluded: a sibling file:/link: devDep never lands in production.
const PROD_GROUPS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

describe('no production sibling file:/link: dependencies', () => {
  for (const rel of MANIFESTS) {
    it(`${rel} has no sibling file:../ or link:../ production dep`, () => {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const group of PROD_GROUPS) {
        for (const [name, spec] of Object.entries(pkg[group] ?? {})) {
          expect(/^(file:|link:)\.\./.test(spec), `${rel} ${group}.${name} = ${spec}`).toBe(false);
        }
      }
    });
  }
});
