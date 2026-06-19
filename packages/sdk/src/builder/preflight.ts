// Preflight bundle validation — STRUCTURAL ONLY. Never imports or executes bundle source.
// Issue codes are authoritative-compatible with the service's `validateBundle`
// (apps/backtester/src/sandbox/bundle.ts): schema_invalid, unsupported_module_kind,
// unsupported_contract_version, bundle_entrypoint_invalid (used for BOTH bad file paths and a
// missing/absent entry). No `bundle_path_invalid` code is invented.

import type { BacktestEngine, ModuleBundle, ModuleKind } from '../contracts/module';
import type { ValidationIssue, ValidationReport, ValidationStatus } from '../contracts/validation';
import { BUNDLE_CONTRACT_VERSION } from '../internal/versions';

export interface PreflightOptions {
  readonly engine: BacktestEngine;
}

const SUPPORTED_KINDS: readonly ModuleKind[] = ['strategy', 'overlay'];

/**
 * A file path is unsafe if it is absolute (POSIX `/...` or Windows drive `C:/...`), empty,
 * contains backslashes, a colon (drive letter / scheme), NUL bytes, or any `.`/`..` path
 * segment. The segment-exact `.`/`..` check is intentional and narrower than a naive
 * `includes('..')` substring (a filename like `a..b` is valid) — do not "simplify" it to a
 * substring match to mirror the service's older check.
 */
function isUnsafePath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.startsWith('/')) return true;
  if (path.includes('\\')) return true;
  if (path.includes('\0')) return true;
  if (path.includes(':')) return true; // Windows drive (C:) or scheme-like absolute path
  const segments = path.split('/');
  return segments.some((seg) => seg === '..' || seg === '.');
}

/** The engine selected for a run must match the declared module kind. */
function engineMatchesKind(engine: BacktestEngine, kind: ModuleKind): boolean {
  if (engine === 'overlay') return kind === 'overlay';
  // 'momentum' engine consumes strategy modules.
  return kind === 'strategy';
}

/**
 * Structural validation of a candidate bundle. Never imports/executes source. Returns a
 * `ValidationReport` with `executed: false` and issues sorted by `(path ?? '', code)`.
 */
export function preflightValidateBundle(input: unknown, options: PreflightOptions): ValidationReport {
  const issues: ValidationIssue[] = [];

  if (!input || typeof input !== 'object') {
    issues.push({ code: 'schema_invalid', severity: 'error', message: 'bundle must be an object' });
    return report(issues);
  }

  const b = input as Partial<ModuleBundle>;
  const m = b.manifest;

  if (!m || typeof m.id !== 'string' || typeof m.version !== 'string') {
    issues.push({
      code: 'schema_invalid',
      severity: 'error',
      message: 'manifest {id, version} is required',
    });
  }

  if (m && m.kind !== 'strategy' && m.kind !== 'overlay') {
    issues.push({
      code: 'unsupported_module_kind',
      severity: 'error',
      message: 'manifest.kind must be "strategy" or "overlay"',
    });
  }

  if (m && m.bundleContractVersion !== BUNDLE_CONTRACT_VERSION) {
    issues.push({
      code: 'unsupported_contract_version',
      severity: 'error',
      message: `bundleContractVersion must be ${BUNDLE_CONTRACT_VERSION}`,
    });
  }

  // Engine vs declared kind (only meaningful when the kind is itself supported).
  if (m && SUPPORTED_KINDS.includes(m.kind as ModuleKind) && !engineMatchesKind(options.engine, m.kind as ModuleKind)) {
    issues.push({
      code: 'unsupported_module_kind',
      severity: 'error',
      message: `engine "${options.engine}" requires a ${options.engine === 'overlay' ? 'overlay' : 'strategy'} module, got "${m.kind}"`,
    });
  }

  if (typeof b.entry !== 'string' || b.entry.length === 0) {
    issues.push({
      code: 'bundle_entrypoint_invalid',
      severity: 'error',
      message: 'entry is required and must be a non-empty string',
    });
  } else if (isUnsafePath(b.entry)) {
    issues.push({
      code: 'bundle_entrypoint_invalid',
      severity: 'error',
      path: b.entry,
      message: `invalid entry path: ${b.entry}`,
    });
  }

  if (!b.files || typeof b.files !== 'object') {
    issues.push({ code: 'schema_invalid', severity: 'error', message: 'files is required' });
  } else {
    for (const key of Object.keys(b.files)) {
      if (isUnsafePath(key)) {
        issues.push({
          code: 'bundle_entrypoint_invalid',
          severity: 'error',
          path: key,
          message: `invalid file path: ${key}`,
        });
      }
    }
    if (typeof b.entry === 'string' && b.entry.length > 0 && !(b.entry in b.files)) {
      issues.push({
        code: 'bundle_entrypoint_invalid',
        severity: 'error',
        path: b.entry,
        message: `entry "${b.entry}" not in files`,
      });
    }
  }

  return report(issues);
}

function report(issues: ValidationIssue[]): ValidationReport {
  const sorted = [...issues].sort((a, c) => {
    const pa = a.path ?? '';
    const pc = c.path ?? '';
    if (pa !== pc) return pa < pc ? -1 : 1;
    return a.code < c.code ? -1 : a.code > c.code ? 1 : 0;
  });
  const status = computeStatus(sorted);
  return { status, issues: sorted, executed: false };
}

function computeStatus(issues: readonly ValidationIssue[]): ValidationStatus {
  if (issues.some((i) => i.severity === 'error')) return 'rejected';
  if (issues.some((i) => i.severity === 'warning')) return 'accepted_with_warnings';
  return 'accepted';
}
