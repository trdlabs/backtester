// Volume mode: deliver the in-image overlay harness into the shared named volume so the sandbox can
// mount it by volume name (DooD-safe). Copy once, keyed by a content hash of the harness tree, so the
// mount is immutable and multiple backtester versions can coexist on one shared volume.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Recursively widen a tree to world r/X (dirs 0755 traversable, files 0644 readable). */
function makeWorldReadableSync(path: string): void {
  const info = statSync(path);
  chmodSync(path, info.isDirectory() ? 0o755 : 0o644);
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) makeWorldReadableSync(join(path, entry));
  }
}

/** Stable sha256 over (relpath + bytes) of every file in the tree, sorted by relpath. */
function hashDir(root: string): string {
  const h = createHash('sha256');
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.isFile()) out.push(full);
    }
    return out;
  };
  const files = walk(root)
    .map((f) => relative(root, f).split(sep).join('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const rel of files) {
    h.update(rel, 'utf8');
    h.update('\0');
    h.update(readFileSync(join(root, ...rel.split('/'))));
    h.update('\0');
  }
  // 64 bits of sha256 — ample to keep distinct harness versions from colliding on a shared volume.
  return h.digest('hex').slice(0, 16);
}

/** Ensure the harness tree is present under <mountpoint>/harness/<hash>; return that abs path. */
export function ensureHarnessInVolume(harnessDir: string, mountpoint: string): string {
  const harnessRoot = join(mountpoint, 'harness');
  mkdirSync(harnessRoot, { recursive: true });
  chmodSync(harnessRoot, 0o755);

  const dest = join(harnessRoot, hashDir(harnessDir));
  if (!existsSync(dest)) {
    // Unique per call: two concurrent first-time materializations in the same process (same pid)
    // must not share a temp dir, or their parallel copies would corrupt each other.
    const tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    rmSync(tmp, { recursive: true, force: true });
    cpSync(harnessDir, tmp, { recursive: true });
    makeWorldReadableSync(tmp);
    try {
      renameSync(tmp, dest); // atomic publish on the same filesystem
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(dest)) throw e; // not a lost race — surface the real failure
    }
  }
  return dest;
}
