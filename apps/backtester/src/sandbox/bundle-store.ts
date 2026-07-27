// Content-addressed module registry (the backtester's OWN registry — no platform sharing, ADR §12.5).
// Slice 3 ships a local-filesystem store and an in-memory store (tests); same interface, S3 later.

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ContentHash, ModuleBundle } from '@trading/research-contracts';
import { canonicalJson } from '../determinism/canonical-json';
import { bundleHash } from './bundle';

export interface BundleStore {
  put(bundle: ModuleBundle): Promise<ContentHash>;
  get(hash: ContentHash): Promise<ModuleBundle | undefined>;
  has(hash: ContentHash): Promise<boolean>;
}

const hexOf = (ref: ContentHash): string => ref.slice('sha256:'.length);

export class FileBundleStore implements BundleStore {
  constructor(private readonly baseDir: string) {}

  private pathFor(hash: ContentHash): string {
    return resolve(this.baseDir, `${hexOf(hash)}.json`);
  }

  async put(bundle: ModuleBundle): Promise<ContentHash> {
    const hash = bundleHash(bundle);
    const path = this.pathFor(hash);
    // Content-addressed: существующий файл байт-эквивалентен по построению — не переписывать
    // (конкурентный put того же бандла с неатомарным writeFile давал конкурентному get()
    // обрезанный JSON → ложный «unknown bundle» у воркера).
    try {
      await access(path);
      return hash;
    } catch {
      /* нет файла — пишем */
    }
    await mkdir(this.baseDir, { recursive: true });
    // tmp+rename: rename атомарен в пределах каталога — читатель видит либо ничего, либо целый файл.
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, canonicalJson(bundle), 'utf8');
    await rename(tmp, path);
    return hash;
  }

  async get(hash: ContentHash): Promise<ModuleBundle | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(hash), 'utf8')) as ModuleBundle;
    } catch {
      return undefined;
    }
  }

  async has(hash: ContentHash): Promise<boolean> {
    try {
      await access(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }
}

export class InMemoryBundleStore implements BundleStore {
  private readonly bundles = new Map<ContentHash, string>();

  async put(bundle: ModuleBundle): Promise<ContentHash> {
    const hash = bundleHash(bundle);
    this.bundles.set(hash, canonicalJson(bundle));
    return hash;
  }

  async get(hash: ContentHash): Promise<ModuleBundle | undefined> {
    const raw = this.bundles.get(hash);
    return raw === undefined ? undefined : (JSON.parse(raw) as ModuleBundle);
  }

  async has(hash: ContentHash): Promise<boolean> {
    return this.bundles.has(hash);
  }
}
