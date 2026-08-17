// Env-driven store factory. Default 'filesystem' → host-local File*Store (dev/CI byte-identical).
// 's3' → S3-compatible adapter. `injected` is the test seam (production passes nothing and the
// factory builds a real client via createS3ObjectClient).

import type { AppConfig } from '../config';
import { FileArtifactStore, type ArtifactStore } from '../artifacts/store';
import { FileBundleStore, type BundleStore } from '../sandbox/bundle-store';
import { S3ArtifactStore } from '../artifacts/s3-store';
import { S3BundleStore } from '../sandbox/s3-bundle-store';
import { createS3ObjectClient, type S3ObjectClient } from './s3-client';
import type { ThreadArtifactStoreSpec } from '../engine/thread/run-spec';

async function s3ClientFor(config: AppConfig, injected?: S3ObjectClient): Promise<S3ObjectClient> {
  if (injected) return injected;
  if (!config.s3) throw new Error("store backend 's3' selected but s3 settings are missing");
  return createS3ObjectClient(config.s3);
}

export async function createArtifactStore(
  config: AppConfig,
  injected?: S3ObjectClient,
): Promise<ArtifactStore> {
  if (config.storeBackend === 's3') return new S3ArtifactStore(await s3ClientFor(config, injected));
  return new FileArtifactStore(config.artifactsDir);
}

/**
 * Описать хранилище, которое построил бы `createArtifactStore` из ЭТОЙ конфигурации (блокер №4).
 *
 * Описывается КОНФИГУРАЦИЯ, а не живой объект, и это существенно: описать `FileArtifactStore` по
 * нему самому нельзя (его `baseDir` приватен), а главное — вызывающий обязан сам знать, что
 * работающий store действительно построен из этой конфигурации. Подсунутый в обход неё (тесты,
 * стенды) описанию не подлежит, и `undefined` здесь — честный ответ, а не пробел.
 *
 * `undefined` возвращается и для `s3` без настроек: описание без них не воссоздаёт клиента, а
 * описание, из которого нельзя собрать эквивалент, хуже отсутствия — оно выглядит рабочим.
 */
export function describeArtifactStore(config: AppConfig): ThreadArtifactStoreSpec | undefined {
  if (config.storeBackend === 's3') {
    return config.s3 === undefined ? undefined : { kind: 's3', settings: config.s3 };
  }
  return { kind: 'file', baseDir: config.artifactsDir };
}

/**
 * Собрать хранилище по описанию — сторона ПОТОКА.
 *
 * Тем же конструктором, что и `createArtifactStore`: вторая реализация на стороне потока разошлась
 * бы с первой ровно тогда, когда конструктор поменяют, и разошлась бы молча — формы совпадают.
 */
export async function artifactStoreFromSpec(spec: ThreadArtifactStoreSpec): Promise<ArtifactStore> {
  if (spec.kind === 's3') return new S3ArtifactStore(await createS3ObjectClient(spec.settings));
  return new FileArtifactStore(spec.baseDir);
}

export async function createBundleStore(
  config: AppConfig,
  injected?: S3ObjectClient,
): Promise<BundleStore> {
  if (config.storeBackend === 's3') return new S3BundleStore(await s3ClientFor(config, injected));
  return new FileBundleStore(config.bundlesDir);
}
