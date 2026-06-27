export { createModuleManifest } from './manifest';
export type { CreateModuleManifestInput } from './manifest';
export { createModuleBundle } from './bundle';
export type { CreateModuleBundleInput } from './bundle';
export { preflightValidateBundle, type PreflightOptions } from './preflight';
export { computeInlineBundleHash, computeBundleHash } from './hash';
export {
  AUTHORING_DOC_VERSION,
  getAuthoringDoc,
  OVERLAY_AUTHORING_DOC,
  STRATEGY_AUTHORING_DOC,
} from './authoring/doc';
export { STRATEGY_EXAMPLE_BUNDLE, STRATEGY_EXAMPLE_SOURCE } from './authoring/examples/strategy-example';
