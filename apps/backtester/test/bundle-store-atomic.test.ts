// FileBundleStore.put — атомарность content-addressed записи (root cause «unknown bundle» при
// конкурентных сабмитах одного бандла: неатомарный writeFile давал конкурентному get() обрезанный
// JSON). Пин: повторный put существующего хеша НЕ переписывает файл (short-circuit), запись идёт
// через tmp+rename (партиал невозможен по построению rename-атомарности).
import { mkdtempSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileBundleStore } from '../src/sandbox/bundle-store.js';
import type { ModuleBundle } from '@trading/research-contracts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const bundle = {
  entry: 'index.js',
  files: { 'index.js': 'export default function f(){return {};}' },
  manifest: { id: 'atomic_probe', version: '1.0.0', kind: 'strategy', hooks: ['onBarClose'] },
} as unknown as ModuleBundle;

describe('FileBundleStore.put — атомарность', () => {
  it('повторный put того же бандла не переписывает файл (mtime неизменен) и не оставляет tmp-мусора', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-store-atomic-')); dirs.push(dir);
    const store = new FileBundleStore(dir);
    const hash = await store.put(bundle);
    const path = join(dir, `${hash.replace('sha256:', '')}.json`);
    const before = statSync(path).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await store.put(bundle); // конкурентный/повторный put — short-circuit, файл не трогается
    expect(statSync(path).mtimeMs).toBe(before);
    expect(await store.get(hash)).toBeTruthy();
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
