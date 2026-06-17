// 019 — acceptance-gate untrusted bundle (US1; data-model §9, contracts/module-bundle; FR-003..007).
//
// Детерминированный входной гейт: отклоняет небезопасный/некорректный bundle ДО любой загрузки/
// исполнения и принимает валидный как `research_only`. Порядок проверок:
//   1. структура   → bundle_incomplete / bundle_entrypoint_invalid
//   2. версия      → unsupported_contract_version (017) — для descriptor.contractVersion
//   3. целостность → bundle_integrity_violation (перевычисление bundleHash)
//   4. 017-манифест→ schema_invalid / forbidden_capability / unsupported_contract_version / … (017-валидатор)
//   5. (опц.) статический скан import-specifier'ов — НЕ авторитетен (FR-006), здесь не реализован как блокер.
// Аккумулирует ПОЛНЫЙ набор причин (FR-007). Для `rejected` — 0 строк кода исполнено (SC-009):
// gate читает только байты файлов (для хеша/манифеста), `module/` никогда не импортируется.

import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import type { ContractContext } from '@trading/research-contracts/research';
import { validate } from '../validation/index.js';
import type { ModuleBundle } from './bundle.js';
import { computeBundleHash } from './bundle-hash.js';
import type { BundleValidationResult, SandboxIssue } from './errors.js';

/** entryPoint должен резолвиться внутри `module/` (без traversal за пределы bundleDir/module). */
function entryPointResolves(bundleDir: string, entryPoint: string): boolean {
  const norm = normalize(entryPoint);
  const moduleRoot = resolve(bundleDir, 'module');
  const abs = resolve(bundleDir, norm);
  if (abs !== moduleRoot && !abs.startsWith(moduleRoot + sep)) return false;
  return existsSync(abs) && statSync(abs).isFile();
}

function fileExists(abs: string): boolean {
  return existsSync(abs) && statSync(abs).isFile();
}

/**
 * Acceptance-gate: провалидировать `bundle` против контракта 017 и 019-структуры/целостности.
 * @param contractContext — `platformContractContext([knownStrategyRef…])` (authoritative 017-источник версий/каталогов).
 */
export function validateBundle(
  bundle: ModuleBundle,
  contractContext: ContractContext,
): BundleValidationResult {
  const { bundleDir, descriptor, manifest } = bundle;
  const issues: SandboxIssue[] = [];

  // --- 1. структура: все объявленные файлы присутствуют ---
  let allFilesPresent = true;
  for (const f of descriptor.files) {
    if (!fileExists(join(bundleDir, f.path))) {
      issues.push({
        severity: 'error',
        code: 'bundle_incomplete',
        message: `required payload file missing: ${f.path}`,
        path: '/files',
      });
      allFilesPresent = false;
    }
  }
  // --- 1. структура: entryPoint резолвится внутри module/ ---
  if (!entryPointResolves(bundleDir, descriptor.entryPoint)) {
    issues.push({
      severity: 'error',
      code: 'bundle_entrypoint_invalid',
      message: `entryPoint does not resolve inside module/: ${descriptor.entryPoint}`,
      path: '/entryPoint',
    });
  }

  // --- 2. версия: descriptor.contractVersion ∈ supported (017) ---
  // (manifest.contractVersion проверяется 017-валидатором на шаге 4 — без дублирования причины.)
  if (!contractContext.supportedContractVersions.includes(descriptor.contractVersion)) {
    issues.push({
      severity: 'error',
      code: 'unsupported_contract_version',
      message: `descriptor.contractVersion "${descriptor.contractVersion}" not in supported set`,
      path: '/contractVersion',
    });
  }

  // --- 3. целостность: перевычислить bundleHash == descriptor.bundleHash ---
  // Только при наличии всех файлов (иначе хеш недетерминируем — причина уже зафиксирована как incomplete).
  let verifiedBundleHash: string | undefined;
  if (allFilesPresent) {
    try {
      const { bundleHash } = computeBundleHash(bundleDir, descriptor.files);
      if (bundleHash !== descriptor.bundleHash) {
        issues.push({
          severity: 'error',
          code: 'bundle_integrity_violation',
          message: 'recomputed bundleHash does not match descriptor.bundleHash',
          path: '/bundleHash',
        });
      } else {
        verifiedBundleHash = bundleHash;
      }
    } catch (e) {
      issues.push({
        severity: 'error',
        code: 'bundle_integrity_violation',
        message: `bundleHash recomputation failed: ${(e as Error).message}`,
        path: '/bundleHash',
      });
    }
  }

  // --- 4. 017-манифест через переиспользуемый валидатор (НЕ модифицируется) ---
  const manifestResult = validate({ inputKind: 'module', manifest }, contractContext);
  for (const iss of manifestResult.issues) {
    issues.push({
      severity: iss.severity,
      code: iss.code,
      message: iss.message,
      path: `/manifest${iss.path}`,
    });
  }

  // --- статус + стабильная сортировка причин (по path, затем code) ---
  issues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const hasError = issues.some((i) => i.severity === 'error');
  const hasWarning = issues.some((i) => i.severity === 'warning');

  if (hasError) {
    return { status: 'rejected', issues };
  }
  return {
    status: hasWarning ? 'accepted_with_warnings' : 'accepted',
    issues,
    normalizedManifest: manifestResult.normalized,
    bundleHash: verifiedBundleHash,
  };
}
