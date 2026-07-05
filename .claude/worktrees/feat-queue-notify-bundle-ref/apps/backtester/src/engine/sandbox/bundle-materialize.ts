// Slice-6b-A — мост inline → on-disk bundle (Task 7, CP2).
//
// Бэктестеровский inline `ModuleBundle` (@trading/research-contracts: { manifest, entry, files })
// — это WIRE-конверт: манифест + ESM-исходники в памяти. Платформенный (lifted) sandbox-загрузчик
// `loadBundle(bundleDir)`/acceptance-gate читают bundle С ДИСКА: `manifest.json` + `bundle.json`
// (019-дескриптор) + payload-файлы под `module/`. `materializeBundle` пишет этот layout во временную
// директорию и синтезирует дескриптор так, чтобы `computeBundleHash` гейта совпал по построению.
//
// БЕЗ submit/worker-обвязки — только материализация (валидация — забота вызывающего через
// `loadBundle` + `validateBundle`). Никакого исполнения тела модуля здесь нет.

import { chmod, mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import type { BundleDescriptor, BundleFileEntry } from './bundle.js';
import { computeBundleHash } from './bundle-hash.js';

/** Материализованный на диске bundle: абсолютный `bundleDir` + idempotent-cleanup. */
export interface MaterializedBundle {
  readonly bundleDir: string;
  cleanup(): Promise<void>;
}

/**
 * Read-only вид на РАНТАЙМ-объект манифеста. Inline `ModuleBundle.manifest` типизирован узким WIRE
 * `ModuleManifest` (`{ id, version, kind:'strategy', bundleContractVersion }`), но рантайм-объект из
 * 017-фикстуры несёт полный набор полей (`contractVersion`, `kind:'overlay'`, `hooks`, …). Дескриптору
 * нужны ровно `contractVersion` (017-версия, сверяемая с `SUPPORTED_CONTRACT_VERSIONS`) и `kind`
 * (зеркалит manifest.kind). Читаем их через локальный вид — без аддитивного расширения WIRE-контракта.
 */
interface RuntimeManifestView {
  readonly contractVersion?: unknown;
  readonly kind?: unknown;
  readonly bundleContractVersion?: unknown;
}

/** Recursively widen a materialized tree to world `r`/`X` (dirs traversable, files readable). */
async function makeWorldReadable(path: string): Promise<void> {
  const info = await stat(path);
  await chmod(path, info.isDirectory() ? 0o755 : 0o644);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await makeWorldReadable(join(path, entry));
    }
  }
}

function assertSafeRelativePath(path: string): void {
  if (isAbsolute(path)) {
    throw new Error(`materializeBundle: absolute payload path is not allowed: ${path}`);
  }
  const norm = normalize(path);
  if (norm === '..' || norm.startsWith(`..${sep}`) || norm.includes(`${sep}..${sep}`) || norm.endsWith(`${sep}..`)) {
    throw new Error(`materializeBundle: path traversal is not allowed: ${path}`);
  }
}

/**
 * Материализовать inline `ModuleBundle` во временную `bundleDir` так, чтобы платформенный
 * `loadBundle(bundleDir)` распарсил layout, а `validateBundle(...)` принял его:
 *
 *  - каждый `inline.files[path]` → `<bundleDir>/<path>` (с созданием поддиректорий; обход `..`/abs отклонён);
 *  - `<bundleDir>/manifest.json` = `JSON.stringify(inline.manifest, null, 2)` (полный 017-манифест из рантайм-объекта);
 *  - `<bundleDir>/bundle.json` = 019-`BundleDescriptor`:
 *      • `contractVersion` = `manifest.contractVersion` (017; ∈ `SUPPORTED_CONTRACT_VERSIONS`),
 *      • `kind`            = `manifest.kind` ('strategy'|'overlay'),
 *      • `entryPoint`      = `inline.entry`,
 *      • `files`           = `{ path, sha256 }` для каждого payload-файла, отсорт. по path,
 *      • `bundleHash`      = лифтнутый `computeBundleHash(bundleDir, files)` ПОСЛЕ записи всех файлов —
 *                            recompute-and-compare гейта проходит по построению.
 *
 * Возвращает `{ bundleDir, cleanup }`; `cleanup()` рекурсивно удаляет временную директорию.
 */
export async function materializeBundle(
  inline: InlineModuleBundle,
  baseDir?: string,
): Promise<MaterializedBundle> {
  if (baseDir !== undefined) {
    // Volume mode: the bundle must live under the shared-volume mountpoint so the daemon can resolve
    // it by volume name under DooD. Ensure the parent exists and is traversable by the sandbox user.
    await mkdir(baseDir, { recursive: true });
    await chmod(baseDir, 0o755);
  }
  const bundleDir = await mkdtemp(join(baseDir ?? tmpdir(), 'btx-bundle-'));
  const cleanup = async (): Promise<void> => {
    await rm(bundleDir, { recursive: true, force: true });
  };

  try {
    // --- payload-файлы (module/**): запись с созданием поддиректорий + гард обхода ---
    const filePaths = Object.keys(inline.files);
    for (const relPath of filePaths) {
      assertSafeRelativePath(relPath);
      const abs = join(bundleDir, relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, inline.files[relPath], 'utf8');
    }

    // --- manifest.json: ЧИСТЫЙ 017-манифест ---
    // Inline WIRE-`ModuleManifest` несёт `bundleContractVersion` (019-bundle-поле), которого НЕТ в
    // 017 `module-manifest.schema.json` (`additionalProperties:false`) — оставлять его в manifest.json
    // → `schema_invalid` от 017-валидатора. 019-версия живёт в дескрипторе (bundle.json), не в манифесте,
    // поэтому отделяем её здесь; остальные 017-поля (hooks/kind/contractVersion/…) пишутся как есть.
    const runtimeManifest = inline.manifest as unknown as RuntimeManifestView;
    const { bundleContractVersion: _bundleContractVersion, ...manifest017 } =
      inline.manifest as unknown as Record<string, unknown>;
    await writeFile(join(bundleDir, 'manifest.json'), JSON.stringify(manifest017, null, 2), 'utf8');

    // --- 019-дескриптор ---
    // contractVersion дескриптора — 017-версия (сверяется с `SUPPORTED_CONTRACT_VERSIONS`); берём
    // `manifest.contractVersion`, с fallback на `bundleContractVersion`, если первого нет.
    const contractVersion =
      typeof runtimeManifest.contractVersion === 'string'
        ? runtimeManifest.contractVersion
        : typeof runtimeManifest.bundleContractVersion === 'string'
          ? runtimeManifest.bundleContractVersion
          : '';
    const kind: BundleDescriptor['kind'] = runtimeManifest.kind === 'overlay' ? 'overlay' : 'strategy';

    // declaredFiles: пути из inline.files, отсорт. по path (sha256 пересчитает computeBundleHash из байт).
    const declaredFiles: BundleFileEntry[] = filePaths
      .map((path) => ({ path, sha256: '' }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // bundleHash: лифтнутый computeBundleHash поверх уже записанного на диск layout — гейтовый
    // recompute-and-compare совпадёт по построению. computed.files несёт реальные sha256 (отсорт.).
    const computed = computeBundleHash(bundleDir, declaredFiles);

    const descriptor: BundleDescriptor = {
      contractVersion,
      kind,
      entryPoint: inline.entry,
      files: computed.files,
      bundleHash: computed.bundleHash,
    };

    await writeFile(join(bundleDir, 'bundle.json'), JSON.stringify(descriptor, null, 2), 'utf8');

    // Sandbox containers run as an unprivileged user against a :ro mount — bundle dirs must be
    // world-readable (mkdtemp defaults to 0700).
    await makeWorldReadable(bundleDir);

    return { bundleDir, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
