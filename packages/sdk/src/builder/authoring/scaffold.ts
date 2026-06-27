import type { ModuleBundle } from '../../contracts/module';
import type { ValidationReport } from '../../contracts/validation';
import { createModuleBundle } from '../bundle';
import { createModuleManifest, type CreateModuleManifestInput } from '../manifest';
import { preflightValidateBundle } from '../preflight';

export interface ScaffoldStrategyBundleInput {
  readonly manifest: CreateModuleManifestInput;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface ScaffoldStrategyBundleResult {
  readonly bundle: ModuleBundle;
  readonly report: ValidationReport;
}

/**
 * One-call authoring path: build the rich manifest, build the bundle, and run structural preflight
 * for the strategy engine ('momentum'). Does NOT throw on validation errors — inspect
 * `report.status`. For overlays, build with `createModuleBundle` + `preflightValidateBundle({ engine:
 * 'overlay' })` directly.
 */
export function scaffoldStrategyBundle(input: ScaffoldStrategyBundleInput): ScaffoldStrategyBundleResult {
  const bundle = createModuleBundle({
    manifest: createModuleManifest(input.manifest),
    entry: input.entry,
    files: input.files,
  });
  const report = preflightValidateBundle(bundle, { engine: 'momentum' });
  return { bundle, report };
}
