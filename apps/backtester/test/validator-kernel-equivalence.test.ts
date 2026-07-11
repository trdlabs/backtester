// 042 FU3 — equivalence harness: backtester app-validator vs kernel `validate()`
// (@trdlabs/sdk/validation) on the 017 fixtures. Proves behavioural identity per arm
// before delegating to the kernel (single source of validator logic). Permanent drift guard.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { validate as appValidate, type ValidationInput } from '../src/engine/validation/index.js';
import { validate as kernelValidate } from '@trdlabs/sdk/validation';
import { platformContractContext } from '@trading/research-contracts/research';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kernel-equivalence');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const inputKindOf = (fx: Record<string, unknown>): ValidationInput['inputKind'] =>
  'request' in fx ? 'run_request' : 'promotion' in fx ? 'promotion' : 'module';

// Known strategies from VALID fixtures (so invalid bogus-refs still reject honestly).
const known = new Set<string>();
for (const f of readdirSync(join(FX, 'valid'))) {
  const fx = readJson(join(FX, 'valid', f));
  if (fx.manifest?.targetStrategyRef) known.add(fx.manifest.targetStrategyRef);
  if (fx.manifest?.kind === 'strategy' && fx.manifest?.id) known.add(fx.manifest.id);
  if (fx.request?.moduleRef?.id) known.add(fx.request.moduleRef.id);
  for (const o of fx.request?.overlayRefs ?? []) if (o?.id) known.add(o.id);
}
const ctx = platformContractContext([...known]);

// Normalize a ValidationResult to a comparable shape (status + issues sorted by (path, code)).
const norm = (r: { status: string; issues: ReadonlyArray<{ code: string; path: string; severity: string }> }) => ({
  status: r.status,
  issues: [...r.issues]
    .map((i) => ({ code: i.code, path: i.path, severity: i.severity }))
    .sort((a, b) => (a.path + a.code).localeCompare(b.path + b.code)),
});

const byArm: Record<string, string[]> = { module: [], run_request: [], promotion: [] };
for (const dir of ['valid', 'invalid']) {
  for (const f of readdirSync(join(FX, dir)).filter((n) => n.endsWith('.json'))) {
    byArm[inputKindOf(readJson(join(FX, dir, f)))].push(`${dir}/${f}`);
  }
}

describe('042 FU3 — app-validator ↔ kernel validate() equivalence (017 fixtures)', () => {
  for (const arm of ['module', 'promotion', 'run_request'] as const) {
    describe(`arm: ${arm}`, () => {
      for (const rel of byArm[arm]) {
        it(rel, () => {
          const fx = readJson(join(FX, rel));
          const input = { inputKind: arm, ...fx } as ValidationInput;
          const app = norm(appValidate(input, ctx) as never);
          const kernel = norm(kernelValidate(input as never, ctx as never) as never);
          expect(kernel).toEqual(app);
        });
      }
    });
  }
});
