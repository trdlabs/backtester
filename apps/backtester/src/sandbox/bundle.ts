// Module bundle identity + validation. A bundle is content-addressed by `bundleHash` (sha256 of its
// canonical JSON) — the same bundle always hashes the same, which is what makes "same bundle → same
// result_hash" hold and what keys the registry. See ADR §12.5 (variant A: own registry only).

import type { ContentHash } from '@trdlabs/backtester-sdk/artifacts';
import type { ModuleBundle } from '@trdlabs/backtester-sdk/contracts';
import { BUNDLE_CONTRACT_VERSION, isUnsafeBundlePath } from '@trdlabs/backtester-sdk/contracts';
import { contentRef } from '../determinism/hash';

export function bundleHash(bundle: ModuleBundle): ContentHash {
  return contentRef(bundle);
}

export interface BundleIssue {
  readonly code: string;
  readonly message: string;
}

/** Structural validation only (the kernel/container is the security boundary, not this check). */
export function validateBundle(input: unknown): BundleIssue[] {
  const issues: BundleIssue[] = [];
  if (!input || typeof input !== 'object') {
    return [{ code: 'schema_invalid', message: 'bundle must be an object' }];
  }
  const b = input as Partial<ModuleBundle>;
  const m = b.manifest;
  if (!m || typeof m.id !== 'string' || typeof m.version !== 'string') {
    issues.push({ code: 'schema_invalid', message: 'manifest {id, version} is required' });
  }
  if (m && m.kind !== 'strategy' && m.kind !== 'overlay') {
    issues.push({ code: 'unsupported_module_kind', message: 'manifest.kind must be "strategy" or "overlay"' });
  }
  if (m && m.bundleContractVersion !== BUNDLE_CONTRACT_VERSION) {
    issues.push({
      code: 'unsupported_contract_version',
      message: `bundleContractVersion must be ${BUNDLE_CONTRACT_VERSION}`,
    });
  }
  if (typeof b.entry !== 'string' || b.entry.length === 0) {
    issues.push({ code: 'schema_invalid', message: 'entry is required' });
  } else if (isUnsafeBundlePath(b.entry)) {
    issues.push({ code: 'bundle_entrypoint_invalid', message: `invalid entry path: ${b.entry}` });
  }
  if (!b.files || typeof b.files !== 'object') {
    issues.push({ code: 'schema_invalid', message: 'files is required' });
  } else {
    for (const key of Object.keys(b.files)) {
      // P1-5: shared predicate with the SDK preflight so the two validators can never drift.
      if (isUnsafeBundlePath(key)) {
        issues.push({ code: 'bundle_entrypoint_invalid', message: `invalid file path: ${key}` });
      }
    }
    if (typeof b.entry === 'string' && !(b.entry in b.files)) {
      issues.push({ code: 'bundle_entrypoint_invalid', message: `entry "${b.entry}" not in files` });
    }
  }
  return issues;
}
