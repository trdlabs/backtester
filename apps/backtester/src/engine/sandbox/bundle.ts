// 019 — контракт `ModuleBundle` и загрузчик layout (US1; data-model §1, contracts/module-bundle; FR-001/003).
//
// ModuleBundle — immutable research-only артефакт untrusted/agent-generated модуля: предсобранный ESM
// payload + 017-манифест + entry point + версия контракта + content-hash. `loadBundle` ЧИТАЕТ только
// два JSON-конверта (manifest.json + bundle.json) и резолвит абсолютный layout; тело модуля (`module/`)
// НЕ импортируется и НЕ исполняется (граница безопасности — runtime-изоляция, не host-side загрузка).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ModuleManifest } from '@trading/research-contracts/research';

/** Один payload-файл bundle: путь относительно bundleDir + sha256 его байт. */
export interface BundleFileEntry {
  readonly path: string;
  readonly sha256: string;
}

/** `bundle.json` — 019-дескриптор поверх 017-манифеста (data-model §1; module-bundle.schema.json). */
export interface BundleDescriptor {
  readonly contractVersion: string; // сверяется с поддерживаемым 017-набором
  readonly kind: 'strategy' | 'overlay'; // зеркалит manifest.kind
  readonly entryPoint: string; // относительный путь внутри module/ (по умолчанию module/index.js)
  readonly files: readonly BundleFileEntry[]; // ВСЕ payload-файлы (manifest.json + module/**), сорт. по path
  readonly bundleHash: string; // 'sha256:<hex>' — см. bundle-hash.ts
}

/** Host-side представление принятого/резолвнутого bundle. */
export interface ModuleBundle {
  readonly bundleDir: string; // абсолютный путь (host-only; НЕ пересекает границу sandbox)
  readonly manifest: ModuleManifest; // 017
  readonly descriptor: BundleDescriptor;
}

function parseJsonFile(absPath: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    throw new Error(`loadBundle: cannot read ${label} (${absPath})`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`loadBundle: ${label} is not valid JSON (${absPath}): ${(e as Error).message}`);
  }
}

/**
 * Загрузить bundle из директории: читает `manifest.json` (017) + `bundle.json` (019) и резолвит
 * абсолютный layout. Тело `module/` не читается/не исполняется здесь — это делает sandbox-исполнитель
 * (US2) внутри контейнера. Бросает, если директория отсутствует или конверты непарсимы (минимум,
 * без которого нечего валидировать); прочие нарушения структуры/целостности/манифеста — забота
 * acceptance-gate (`validateBundle`), который аккумулирует полный набор причин.
 */
export function loadBundle(bundleDir: string): ModuleBundle {
  const abs = resolve(bundleDir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`loadBundle: bundle directory not found: ${abs}`);
  }
  const manifest = parseJsonFile(join(abs, 'manifest.json'), 'manifest.json') as ModuleManifest;
  const descriptor = parseJsonFile(join(abs, 'bundle.json'), 'bundle.json') as BundleDescriptor;
  return { bundleDir: abs, manifest, descriptor };
}
