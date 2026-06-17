// 019 — детерминированный content-hash bundle (US1; data-model §2, contracts/module-bundle; FR-002).
//
//   manifestSha256 = sha256(bytes("manifest.json"))
//   files          = sorted([{ path, sha256: sha256(bytes(file)) } for file in payload], by path)
//   bundleHash     = "sha256:" + sha256( canonicalJson({ manifestSha256, files }) )
//
// `canonicalJson` переиспользуется из 018 (sorted-key; здесь только строки/массивы — без квантизации).
// Идентичность bundle = bundleHash; изменение любого байта payload/манифеста ⇒ другой bundle.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../determinism/canonical-json.js';
import type { BundleFileEntry } from './bundle.js';

/** sha256 байт (hex, lower-case). */
export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Результат перевычисления хеша из содержимого на диске. */
export interface ComputedBundleHash {
  readonly bundleHash: string; // 'sha256:<hex>'
  readonly manifestSha256: string;
  readonly files: readonly BundleFileEntry[]; // перевычислено из диска, отсортировано по path
}

/**
 * Перевычислить `bundleHash` из содержимого `bundleDir`, читая каждый объявленный payload-файл.
 * `declaredFiles` задаёт набор путей (их `sha256` игнорируется — пересчитывается из байт на диске),
 * что и обеспечивает детект мутаций (изменённый байт ⇒ другой `bundleHash` ⇒ `bundle_integrity_violation`).
 * Бросает, если объявленный файл отсутствует/нечитаем (вызывающий gate перед этим проверяет наличие).
 */
export function computeBundleHash(
  bundleDir: string,
  declaredFiles: readonly BundleFileEntry[],
): ComputedBundleHash {
  const manifestSha256 = sha256Hex(readFileSync(join(bundleDir, 'manifest.json')));
  const files: BundleFileEntry[] = declaredFiles
    .map((e) => ({ path: e.path, sha256: sha256Hex(readFileSync(join(bundleDir, e.path))) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bundleHash = `sha256:${sha256Hex(canonicalJson({ manifestSha256, files }))}`;
  return { bundleHash, manifestSha256, files };
}
