import type { ModuleBundle, ModuleManifest } from '../contracts/module';

export interface CreateModuleBundleInput {
  readonly manifest: ModuleManifest;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Build a frozen `ModuleBundle`. File keys are sorted into a NEW frozen record so the
 * result is insertion-order independent and pure/deterministic. Path safety (traversal,
 * absolute paths, NUL bytes, backslashes) is enforced by `preflightValidateBundle`, not here —
 * `createModuleBundle` stays a pure normalizer with no rejection branches.
 */
export function createModuleBundle(input: CreateModuleBundleInput): ModuleBundle {
  const sortedKeys = Object.keys(input.files).sort();
  const files: Record<string, string> = {};
  for (const key of sortedKeys) {
    files[key] = input.files[key];
  }
  return Object.freeze({
    manifest: input.manifest,
    entry: input.entry,
    files: Object.freeze(files),
  });
}
