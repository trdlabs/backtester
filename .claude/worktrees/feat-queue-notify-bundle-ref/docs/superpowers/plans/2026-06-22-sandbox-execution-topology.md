# Sandbox Execution Topology (DooD named-volume) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the overlay sandbox runner work both containerized-with-DooD (demo) and as a host process (dev) by mounting the per-run bundle + harness through a shared named Docker volume instead of host bind-mounts, and install the `docker` CLI + overlay harness into the backtester image.

**Architecture:** Introduce a `MountSource` discriminated union (`bind` | `volume`) and branch the `docker run` arg builder on it. An env-driven `MountConfig` selects the mode: with `BACKTESTER_SANDBOX_OVERLAY_VOLUME` + `..._VOLUME_MOUNTPOINT` set → volume mode (writes bundle into `<mountpoint>/bundles`, copies harness into `<mountpoint>/harness/<hash>`, mounts per-run subpaths via `--mount …,volume-subpath=…,readonly`); neither set → bind mode (today's `-v hostpath:…:ro`, unchanged). The in-container harness `entry.mjs` is untouched because content still lands at `/sandbox/bundle` and `/sandbox/harness`.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 22/24, vitest, Docker CLI ≥25 (host 29.5.3), pnpm workspace.

## Global Constraints

- **Docker ≥25 required** for `--mount type=volume,…,volume-subpath=…` (host is 29.5.3; pin the in-image CLI ≥25).
- **Contract names (verbatim):** volume `btx-sandbox`; backtester-side mountpoint `/sandbox-shared`; socket `/var/run/docker.sock`; env vars `BACKTESTER_SANDBOX_OVERLAY_VOLUME`, `BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT`.
- **Lockdown flags — preserve every one, unchanged:** `--network none`, `--read-only`, `--tmpfs /tmp:rw,noexec,nosuid,size=…`, `--memory` (=`--memory-swap`), `--cpus`, `--pids-limit`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--user <non-root>`, no `-e`, `node --disallow-code-generation-from-strings`.
- **Lifecycle — unchanged:** NO `--rm`; explicit `docker rm -f` in `close()`. One ephemeral sandbox container per session.
- **No in-process bypass** for research overlays — isolation is non-negotiable.
- **Scope:** only `apps/backtester/src/engine/sandbox/*` (overlay path). Legacy `apps/backtester/src/sandbox/*` (momentum path) stays bind-only and is documented as not DooD-safe — do NOT modify it.
- **Volume-mode dirs must be world-readable/traversable** (mode `0755` dirs, `0644` files) so the sandbox `nobody` (65534) user can read the `:ro` mount.
- Bind-mode run-arg output must stay **byte-for-byte identical** to today's (no characterization regression).

---

### Task 1: `mounts.ts` — MountSource / MountConfig + pure helpers

**Files:**
- Create: `apps/backtester/src/engine/sandbox/mounts.ts`
- Test: `apps/backtester/test/sandbox-mounts.test.ts`

**Interfaces:**
- Produces:
  - `type MountSource = { kind:'bind'; hostPath:string } | { kind:'volume'; volume:string; subpath:string }`
  - `type MountConfig = { mode:'bind' } | { mode:'volume'; volume:string; mountpoint:string }`
  - `function toMountSource(cfg: MountConfig, dir: string): MountSource`
  - `function mountConfigFor(volume: string | undefined, mountpoint: string | undefined): MountConfig`

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/sandbox-mounts.test.ts
import { describe, expect, it } from 'vitest';
import { toMountSource, mountConfigFor } from '../src/engine/sandbox/mounts.js';

describe('mountConfigFor', () => {
  it('returns bind when neither volume nor mountpoint is set', () => {
    expect(mountConfigFor(undefined, undefined)).toEqual({ mode: 'bind' });
  });
  it('returns volume when both are set', () => {
    expect(mountConfigFor('btx-sandbox', '/sandbox-shared')).toEqual({
      mode: 'volume', volume: 'btx-sandbox', mountpoint: '/sandbox-shared',
    });
  });
  it('throws on half-config (only volume)', () => {
    expect(() => mountConfigFor('btx-sandbox', undefined)).toThrow(/both .* or neither/i);
  });
  it('throws on half-config (only mountpoint)', () => {
    expect(() => mountConfigFor(undefined, '/sandbox-shared')).toThrow(/both .* or neither/i);
  });
});

describe('toMountSource', () => {
  it('bind mode → hostPath passthrough', () => {
    expect(toMountSource({ mode: 'bind' }, '/tmp/btx-bundle-AAA')).toEqual({
      kind: 'bind', hostPath: '/tmp/btx-bundle-AAA',
    });
  });
  it('volume mode → subpath relative to mountpoint', () => {
    const cfg = { mode: 'volume', volume: 'btx-sandbox', mountpoint: '/sandbox-shared' } as const;
    expect(toMountSource(cfg, '/sandbox-shared/bundles/btx-bundle-AAA')).toEqual({
      kind: 'volume', volume: 'btx-sandbox', subpath: 'bundles/btx-bundle-AAA',
    });
  });
  it('volume mode → throws when dir is not under the mountpoint', () => {
    const cfg = { mode: 'volume', volume: 'btx-sandbox', mountpoint: '/sandbox-shared' } as const;
    expect(() => toMountSource(cfg, '/tmp/elsewhere')).toThrow(/under the volume mountpoint/i);
  });
  it('volume mode → throws when dir equals the mountpoint (empty subpath)', () => {
    const cfg = { mode: 'volume', volume: 'btx-sandbox', mountpoint: '/sandbox-shared' } as const;
    expect(() => toMountSource(cfg, '/sandbox-shared')).toThrow(/under the volume mountpoint/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/sandbox-mounts.test.ts`
Expected: FAIL — cannot resolve `../src/engine/sandbox/mounts.js`.

(Tests run from repo root via the root `vitest.config.ts`; `vitest run <path>` filters to that file. The package is `@trading-backtester/service`. The overlay `_engine` is built automatically by vitest's global-setup, so no manual prebuild is needed for direct file runs.)

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backtester/src/engine/sandbox/mounts.ts
// Mount-source abstraction: one docker-run arg builder works in both bind (dev/host-process)
// and volume (demo/DooD) modes. A named volume is resolved by the daemon by name, regardless of
// the caller's filesystem — which removes the host↔container bind-mount path aliasing under DooD.

import { isAbsolute, relative } from 'node:path';

/** How a content dir reaches the sandbox container. */
export type MountSource =
  | { readonly kind: 'bind'; readonly hostPath: string }
  | { readonly kind: 'volume'; readonly volume: string; readonly subpath: string };

/** Selected mount mode for a sandbox run. */
export type MountConfig =
  | { readonly mode: 'bind' }
  | { readonly mode: 'volume'; readonly volume: string; readonly mountpoint: string };

/** Resolve the mount mode from optional volume + mountpoint (env-driven). Both or neither. */
export function mountConfigFor(volume: string | undefined, mountpoint: string | undefined): MountConfig {
  if (volume !== undefined && mountpoint !== undefined) {
    return { mode: 'volume', volume, mountpoint };
  }
  if (volume === undefined && mountpoint === undefined) {
    return { mode: 'bind' };
  }
  throw new Error(
    'sandbox volume config: set both BACKTESTER_SANDBOX_OVERLAY_VOLUME and ' +
      'BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT, or neither',
  );
}

/** Turn a dir on the backtester's filesystem into the MountSource for the sandbox `docker run`. */
export function toMountSource(cfg: MountConfig, dir: string): MountSource {
  if (cfg.mode === 'bind') return { kind: 'bind', hostPath: dir };
  const sub = relative(cfg.mountpoint, dir);
  if (sub === '' || sub.startsWith('..') || isAbsolute(sub)) {
    throw new Error(`toMountSource: ${dir} is not under the volume mountpoint ${cfg.mountpoint}`);
  }
  return { kind: 'volume', volume: cfg.volume, subpath: sub };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/sandbox-mounts.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/mounts.ts apps/backtester/test/sandbox-mounts.test.ts
git commit -m "feat(sandbox): MountSource/MountConfig + toMountSource/mountConfigFor (bind|volume)"
```

---

### Task 2: Branch `buildDockerRunArgs` on MountSource + thread MountConfig through session/executor

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/docker-driver.ts` (`DockerRunOptions`, `buildDockerRunArgs`)
- Modify: `apps/backtester/src/engine/sandbox/sandbox-session.ts` (constructor + `open()`)
- Modify: `apps/backtester/src/engine/sandbox/sandbox-executor.ts` (`SandboxExecutorDeps` + `sessionFor`)
- Test: `apps/backtester/test/docker-run-args.test.ts` (new)

**Interfaces:**
- Consumes: `MountSource`, `MountConfig`, `toMountSource` (Task 1).
- Produces:
  - `interface DockerRunOptions { readonly name: string; readonly bundle: MountSource; readonly harness: MountSource }`
  - `buildDockerRunArgs(policy: SandboxPolicy, opts: DockerRunOptions): readonly string[]`
  - `SandboxExecutorDeps` gains `readonly mount?: MountConfig` (default `{ mode: 'bind' }`).
  - `SandboxSession` constructor gains a 6th param `mount: MountConfig`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/docker-run-args.test.ts
import { describe, expect, it } from 'vitest';
import { buildDockerRunArgs } from '../src/engine/sandbox/docker-driver.js';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';

const LOCKDOWN = [
  '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--user', DEFAULT_SANDBOX.isolation.user,
];

describe('buildDockerRunArgs — bind mode (host-process / dev)', () => {
  const args = buildDockerRunArgs(DEFAULT_SANDBOX, {
    name: 'sbx-run1',
    bundle: { kind: 'bind', hostPath: '/tmp/btx-bundle-AAA' },
    harness: { kind: 'bind', hostPath: '/app/apps/backtester/sandbox-harness-overlay' },
  });
  it('emits the legacy -v :ro bind-mounts for bundle and harness', () => {
    expect(args).toContain('/tmp/btx-bundle-AAA:/sandbox/bundle:ro');
    expect(args).toContain('/app/apps/backtester/sandbox-harness-overlay:/sandbox/harness:ro');
  });
  it('preserves every lockdown flag and the harness entrypoint', () => {
    expect(args).toEqual(expect.arrayContaining(LOCKDOWN));
    expect(args).toContain('--disallow-code-generation-from-strings');
    expect(args).toContain('/sandbox/harness/entry.mjs');
    expect(args).not.toContain('--rm');
  });
});

describe('buildDockerRunArgs — volume mode (DooD / demo)', () => {
  const args = buildDockerRunArgs(DEFAULT_SANDBOX, {
    name: 'sbx-run1',
    bundle: { kind: 'volume', volume: 'btx-sandbox', subpath: 'bundles/btx-bundle-AAA' },
    harness: { kind: 'volume', volume: 'btx-sandbox', subpath: 'harness/deadbeef' },
  });
  it('emits volume-subpath --mount for bundle and harness, readonly', () => {
    expect(args).toContain('type=volume,src=btx-sandbox,dst=/sandbox/bundle,volume-subpath=bundles/btx-bundle-AAA,readonly');
    expect(args).toContain('type=volume,src=btx-sandbox,dst=/sandbox/harness,volume-subpath=harness/deadbeef,readonly');
  });
  it('does NOT emit any host bind-mount for bundle or harness', () => {
    expect(args.some((a) => a.endsWith(':/sandbox/bundle:ro'))).toBe(false);
    expect(args.some((a) => a.endsWith(':/sandbox/harness:ro'))).toBe(false);
  });
  it('preserves every lockdown flag', () => {
    expect(args).toEqual(expect.arrayContaining(LOCKDOWN));
    expect(args).toContain('--disallow-code-generation-from-strings');
    expect(args).not.toContain('--rm');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/docker-run-args.test.ts`
Expected: FAIL — `buildDockerRunArgs` still expects `bundleDir`/`harnessDir`; the volume-mode strings are absent (TS type error on the test object, or assertion failures).

- [ ] **Step 3: Implement — `docker-driver.ts`**

Replace the `DockerRunOptions` interface and `buildDockerRunArgs` (lines ~23–89) with:

```ts
import type { MountSource } from './mounts.js';

/** Параметры запуска контейнера сессии: имя + источники mount'ов bundle/harness. */
export interface DockerRunOptions {
  readonly name: string;
  readonly bundle: MountSource;   // → /sandbox/bundle:ro
  readonly harness: MountSource;  // → /sandbox/harness:ro
}

/** Сформировать `-v host:dst:ro` (bind) или `--mount …,volume-subpath=…,readonly` (volume). */
function mountArgs(src: MountSource, dst: string): readonly string[] {
  if (src.kind === 'bind') return ['-v', `${src.hostPath}:${dst}:ro`];
  return ['--mount', `type=volume,src=${src.volume},dst=${dst},volume-subpath=${src.subpath},readonly`];
}

/** Построить аргументы `docker run …` из политики (контракт sandbox-ipc-protocol §docker-инвокация). */
export function buildDockerRunArgs(policy: SandboxPolicy, opts: DockerRunOptions): readonly string[] {
  const { isolation: iso, limits } = policy;
  // NB: НЕ '--rm' — контейнер остаётся в 'exited' до явного `docker rm -f` (close()), чтобы host мог
  // прочитать .State.OOMKilled/.ExitCode для различения sandbox_memory_exceeded vs sandbox_crashed (T031).
  return [
    'run', '-i',
    '--name', opts.name,
    '--network', iso.network,
    '--read-only',
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=${iso.tmpfsSizeBytes}`,
    '--memory', String(limits.memoryBytes),
    '--memory-swap', String(limits.memoryBytes),
    '--cpus', String(limits.cpus),
    '--pids-limit', String(iso.pidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', iso.user,
    // env НЕ пробрасывается (нет -e) ⇒ секреты не наследуются (FR-017)
    ...mountArgs(opts.bundle, '/sandbox/bundle'),
    ...mountArgs(opts.harness, '/sandbox/harness'),
    iso.image,
    'node', '--disallow-code-generation-from-strings', '/sandbox/harness/entry.mjs',
  ];
}
```

- [ ] **Step 4: Implement — `sandbox-session.ts`**

Add the import and a constructor param, and build the MountSources in `open()`.

At the top imports, add:
```ts
import { toMountSource, type MountConfig } from './mounts.js';
```

In the constructor (currently 5 params ending with `private readonly harnessDir: string`), add a 6th:
```ts
    private readonly harnessDir: string,
    private readonly mount: MountConfig = { mode: 'bind' },
  ) {}
```

In `open()`, replace the `spawnSession` call:
```ts
    try {
      const bundleMount = toMountSource(this.mount, bundleDir);
      const harnessMount = toMountSource(this.mount, this.harnessDir);
      this.container = this.driver.spawnSession(this.policy, {
        name,
        bundle: bundleMount,
        harness: harnessMount,
      });
    } catch (e) {
      return this.fail({ code: 'sandbox_crashed', detail: `docker spawn failed: ${(e as Error).message}` });
    }
```

- [ ] **Step 5: Implement — `sandbox-executor.ts`**

Add the import:
```ts
import type { MountConfig } from './mounts.js';
```

Extend `SandboxExecutorDeps` with:
```ts
  readonly mount?: MountConfig; // bind (default) | volume (DooD). Threaded into each SandboxSession.
```

Add a private field + default in the constructor (next to `harnessDir`):
```ts
  private readonly mount: MountConfig;
```
```ts
    this.harnessDir = deps?.harnessDir ?? defaultHarnessDir();
    this.mount = deps?.mount ?? { mode: 'bind' };
```

In `sessionFor`, pass `this.mount` as the new 6th `SandboxSession` arg (after `this.harnessDir`):
```ts
        this.driver,
        this.harnessDir,
        this.mount,
      );
```

(`routing.ts` needs no change — `createExecutorRouter` already forwards the whole `sandboxDeps` object into `new SandboxModuleExecutor(bundle, policy, deps.sandboxDeps)`, so a `mount` field flows through automatically.)

- [ ] **Step 6: Run the run-args test + the full sandbox suite**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/docker-run-args.test.ts apps/backtester/test/sandbox-mounts.test.ts`
Expected: PASS.

Run (typecheck + no regression on existing sandbox tests): `pnpm exec vitest run apps/backtester/test`
Expected: PASS (existing Docker-gated tests behave as before — bind mode is the default, output unchanged).

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/engine/sandbox/docker-driver.ts apps/backtester/src/engine/sandbox/sandbox-session.ts apps/backtester/src/engine/sandbox/sandbox-executor.ts apps/backtester/test/docker-run-args.test.ts
git commit -m "feat(sandbox): branch docker run-args on MountSource; thread MountConfig (bind default)"
```

---

### Task 3: `materializeBundle` — optional base dir (write bundle into the volume)

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/bundle-materialize.ts`
- Test: `apps/backtester/test/overlay-sandbox-materialize.test.ts` (append a case)

**Interfaces:**
- Produces: `materializeBundle(inline: InlineModuleBundle, baseDir?: string): Promise<MaterializedBundle>`. When `baseDir` is given, the temp bundle dir is created under it (dir created `0755` if missing); default stays `os.tmpdir()`.

- [ ] **Step 1: Write the failing test**

Append to `apps/backtester/test/overlay-sandbox-materialize.test.ts` (inside the top `describe`):

```ts
  it('honours an explicit baseDir (writes the bundle under it, world-readable)', async () => {
    const { mkdtempSync, statSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = mkdtempSync(join(tmpdir(), 'btx-volbase-'));

    const inline = loadInlineBundle('short-after-pump');
    const { bundleDir, cleanup } = await materializeBundle(inline, base);

    expect(bundleDir.startsWith(base)).toBe(true);
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(true);
    expect(statSync(bundleDir).mode & 0o777).toBe(0o755);

    await cleanup();
    expect(existsSync(bundleDir)).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/overlay-sandbox-materialize.test.ts`
Expected: FAIL — `materializeBundle` ignores the 2nd arg; `bundleDir.startsWith(base)` is false (it landed in `os.tmpdir()`).

- [ ] **Step 3: Implement**

In `bundle-materialize.ts`, change the imports to add `mkdir` (already imported) and update the signature + the first line of the body:

```ts
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
```

(`chmod`, `mkdir`, `mkdtemp`, `tmpdir`, `join` are already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/overlay-sandbox-materialize.test.ts`
Expected: PASS (existing cases + the new baseDir case).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/bundle-materialize.ts apps/backtester/test/overlay-sandbox-materialize.test.ts
git commit -m "feat(sandbox): materializeBundle accepts an explicit baseDir (volume mode)"
```

---

### Task 4: `harness-volume.ts` — copy the overlay harness into the volume (idempotent)

**Files:**
- Create: `apps/backtester/src/engine/sandbox/harness-volume.ts`
- Test: `apps/backtester/test/harness-volume.test.ts` (new)

**Interfaces:**
- Produces: `function ensureHarnessInVolume(harnessDir: string, mountpoint: string): string` — copies `harnessDir` → `<mountpoint>/harness/<contentHash>` if absent (idempotent), makes it world-readable, ensures `<mountpoint>/harness` is `0755`, returns the in-volume absolute path (always under `mountpoint`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/harness-volume.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ensureHarnessInVolume } from '../src/engine/sandbox/harness-volume.js';

function makeHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), 'btx-harness-src-'));
  writeFileSync(join(dir, 'entry.mjs'), '// entry\n');
  mkdirSync(join(dir, '_engine'));
  writeFileSync(join(dir, '_engine', 'engine.js'), 'export const x = 1;\n');
  return dir;
}

describe('ensureHarnessInVolume', () => {
  it('copies the harness tree under <mountpoint>/harness/<hash>, world-readable', () => {
    const src = makeHarness();
    const mp = mkdtempSync(join(tmpdir(), 'btx-mp-'));
    const dest = ensureHarnessInVolume(src, mp);

    expect(dest.startsWith(join(mp, 'harness'))).toBe(true);
    expect(relative(mp, dest).startsWith('..')).toBe(false); // under the mountpoint
    expect(readFileSync(join(dest, 'entry.mjs'), 'utf8')).toContain('// entry');
    expect(readFileSync(join(dest, '_engine', 'engine.js'), 'utf8')).toContain('export const x');
    expect(statSync(dest).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, 'entry.mjs')).mode & 0o777).toBe(0o644);
  });

  it('is idempotent and stable: same source → same dest path on a second call', () => {
    const src = makeHarness();
    const mp = mkdtempSync(join(tmpdir(), 'btx-mp-'));
    const a = ensureHarnessInVolume(src, mp);
    const b = ensureHarnessInVolume(src, mp);
    expect(a).toBe(b);
    expect(existsSync(a)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/harness-volume.test.ts`
Expected: FAIL — cannot resolve `../src/engine/sandbox/harness-volume.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backtester/src/engine/sandbox/harness-volume.ts
// Volume mode: deliver the in-image overlay harness into the shared named volume so the sandbox can
// mount it by volume name (DooD-safe). Copy once, keyed by a content hash of the harness tree, so the
// mount is immutable and multiple backtester versions can coexist on one shared volume.

import { createHash } from 'node:crypto';
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
  return h.digest('hex').slice(0, 16);
}

/** Ensure the harness tree is present under <mountpoint>/harness/<hash>; return that abs path. */
export function ensureHarnessInVolume(harnessDir: string, mountpoint: string): string {
  const harnessRoot = join(mountpoint, 'harness');
  mkdirSync(harnessRoot, { recursive: true });
  chmodSync(harnessRoot, 0o755);

  const dest = join(harnessRoot, hashDir(harnessDir));
  if (!existsSync(dest)) {
    const tmp = `${dest}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    cpSync(harnessDir, tmp, { recursive: true });
    makeWorldReadableSync(tmp);
    try {
      renameSync(tmp, dest); // atomic publish on the same filesystem
    } catch {
      rmSync(tmp, { recursive: true, force: true }); // lost a race; the other writer's dest stands
    }
  }
  return dest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/harness-volume.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/harness-volume.ts apps/backtester/test/harness-volume.test.ts
git commit -m "feat(sandbox): ensureHarnessInVolume — content-hashed idempotent harness copy"
```

---

### Task 5: `config.ts` — overlay volume/mountpoint env + half-config fail-fast

**Files:**
- Modify: `apps/backtester/src/config.ts` (`OverlaySandboxSettings` + `loadConfig`)
- Test: `apps/backtester/test/overlay-sandbox-config.test.ts` (append cases)

**Interfaces:**
- Consumes: `mountConfigFor` (Task 1) — used to validate half-config at load time.
- Produces: `OverlaySandboxSettings` gains `readonly volume?: string` and `readonly volumeMountpoint?: string`, populated from `BACKTESTER_SANDBOX_OVERLAY_VOLUME` / `BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT`. `loadConfig` throws if exactly one is set.

- [ ] **Step 1: Write the failing test**

Append to `apps/backtester/test/overlay-sandbox-config.test.ts` (inside the `describe`):

```ts
  it('defaults volume + volumeMountpoint to undefined (bind mode)', () => {
    const c = loadConfig({});
    expect(c.overlaySandbox.volume).toBeUndefined();
    expect(c.overlaySandbox.volumeMountpoint).toBeUndefined();
  });

  it('reads BACKTESTER_SANDBOX_OVERLAY_VOLUME + _VOLUME_MOUNTPOINT (volume mode)', () => {
    const c = loadConfig({
      BACKTESTER_SANDBOX_OVERLAY_VOLUME: 'btx-sandbox',
      BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT: '/sandbox-shared',
    });
    expect(c.overlaySandbox.volume).toBe('btx-sandbox');
    expect(c.overlaySandbox.volumeMountpoint).toBe('/sandbox-shared');
  });

  it('fails fast on half-config (volume set, mountpoint missing)', () => {
    expect(() => loadConfig({ BACKTESTER_SANDBOX_OVERLAY_VOLUME: 'btx-sandbox' })).toThrow(
      /both .* or neither/i,
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/overlay-sandbox-config.test.ts`
Expected: FAIL — `volume`/`volumeMountpoint` are not on the config; the half-config case does not throw.

- [ ] **Step 3: Implement**

In `config.ts`, add the import:
```ts
import { mountConfigFor } from './engine/sandbox/mounts';
```

Extend `OverlaySandboxSettings`:
```ts
  /** Shared named volume for DooD bundle/harness delivery (demo). Unset → bind mode (dev). */
  readonly volume?: string;
  /** Backtester-side mountpoint of `volume` (e.g. /sandbox-shared). Set iff `volume` is set. */
  readonly volumeMountpoint?: string;
```

In `loadConfig`, just before building the returned object, validate + read:
```ts
  const overlayVolume = env.BACKTESTER_SANDBOX_OVERLAY_VOLUME;
  const overlayVolumeMountpoint = env.BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT;
  mountConfigFor(overlayVolume, overlayVolumeMountpoint); // throws on half-config (fail-fast)
```

In the returned `overlaySandbox` object literal, add (after `policy`):
```ts
      ...(overlayVolume !== undefined ? { volume: overlayVolume } : {}),
      ...(overlayVolumeMountpoint !== undefined ? { volumeMountpoint: overlayVolumeMountpoint } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/overlay-sandbox-config.test.ts`
Expected: PASS (existing + 3 new cases).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/overlay-sandbox-config.test.ts
git commit -m "feat(config): overlay sandbox volume + mountpoint env (fail-fast on half-config)"
```

---

### Task 6: `worker.ts` — activate volume mode (deps assembler + bundle baseDir)

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (`sandboxBundleFor`, `overlayRouterFor`)
- Test: `apps/backtester/test/overlay-sandbox-deps.test.ts` (new)

**Interfaces:**
- Consumes: `mountConfigFor` (Task 1), `ensureHarnessInVolume` (Task 4), `SandboxExecutorDeps.mount` (Task 2), `materializeBundle(inline, baseDir?)` (Task 3), `OverlaySandboxSettings` (Task 5).
- Produces (exported for test): `function overlaySandboxDeps(s: OverlaySandboxSettings): SandboxExecutorDeps` — bind mode → `{ harnessDir: s.harnessDir }`; volume mode → `{ harnessDir: ensureHarnessInVolume(s.harnessDir, mountpoint), mount }`. And `function bundleBaseDir(s: OverlaySandboxSettings): string | undefined` — volume mode → `join(mountpoint, 'bundles')`, else `undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/overlay-sandbox-deps.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlaySandboxDeps, bundleBaseDir } from '../src/jobs/worker.js';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';

function settings(extra: Record<string, unknown>) {
  return {
    harnessDir: makeHarness(),
    image: DEFAULT_SANDBOX.isolation.image,
    policy: DEFAULT_SANDBOX,
    ...extra,
  } as any;
}
function makeHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), 'btx-h-'));
  writeFileSync(join(dir, 'entry.mjs'), '// entry\n');
  return dir;
}

describe('overlaySandboxDeps', () => {
  it('bind mode (no volume): harnessDir passthrough, no mount', () => {
    const s = settings({});
    const deps = overlaySandboxDeps(s);
    expect(deps.harnessDir).toBe(s.harnessDir);
    expect(deps.mount).toBeUndefined();
    expect(bundleBaseDir(s)).toBeUndefined();
  });

  it('volume mode: harness copied under mountpoint, mount=volume, baseDir under mountpoint', () => {
    const mp = mkdtempSync(join(tmpdir(), 'btx-mp-'));
    const s = settings({ volume: 'btx-sandbox', volumeMountpoint: mp });
    const deps = overlaySandboxDeps(s);
    expect(deps.harnessDir!.startsWith(join(mp, 'harness'))).toBe(true);
    expect(deps.mount).toEqual({ mode: 'volume', volume: 'btx-sandbox', mountpoint: mp });
    expect(bundleBaseDir(s)).toBe(join(mp, 'bundles'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/overlay-sandbox-deps.test.ts`
Expected: FAIL — `overlaySandboxDeps` / `bundleBaseDir` are not exported from `worker.ts`.

- [ ] **Step 3: Implement — `worker.ts`**

Add imports:
```ts
import { join } from 'node:path';
import { mountConfigFor } from '../engine/sandbox/mounts';
import { ensureHarnessInVolume } from '../engine/sandbox/harness-volume';
import type { SandboxExecutorDeps } from '../engine/sandbox/sandbox-executor';
```

Add the two helpers (above `processNextQueued`):
```ts
/** Per-run base dir for materialized bundles: under the shared volume in volume mode, else tmpdir. */
export function bundleBaseDir(s: OverlaySandboxSettings): string | undefined {
  const mount = mountConfigFor(s.volume, s.volumeMountpoint);
  return mount.mode === 'volume' ? join(mount.mountpoint, 'bundles') : undefined;
}

/** Sandbox executor deps for the overlay router: bind (dev) or volume (DooD). */
export function overlaySandboxDeps(s: OverlaySandboxSettings): SandboxExecutorDeps {
  const mount = mountConfigFor(s.volume, s.volumeMountpoint);
  if (mount.mode === 'bind') return { harnessDir: s.harnessDir };
  const harnessDir = ensureHarnessInVolume(s.harnessDir, mount.mountpoint);
  return { harnessDir, mount };
}
```

Change `overlayRouterFor` to use the assembler:
```ts
function overlayRouterFor(deps: WorkerDeps): ExecutorRouter {
  const policy = deps.overlaySandbox.policy;
  return createExecutorRouter({
    sandboxPolicies: createSandboxPolicyRegistry([policy]),
    sandboxPolicyRef: { id: policy.id, version: policy.version },
    sandboxDeps: overlaySandboxDeps(deps.overlaySandbox),
  });
}
```

Change `sandboxBundleFor` to materialize into the volume base dir when in volume mode:
```ts
async function sandboxBundleFor(deps: WorkerDeps, hash: ContentHash): Promise<SandboxBundleHandle> {
  if (!deps.bundleStore) {
    throw new RunnerError('sandbox_unavailable', 'sandbox execution is not configured');
  }
  const bundle = await deps.bundleStore.get(hash);
  if (!bundle) throw new RunnerError('missing_module', `unknown bundle: ${hash}`);
  const materialized = await materializeBundle(bundle, bundleBaseDir(deps.overlaySandbox));
  return { bundle: loadBundle(materialized.bundleDir), cleanup: materialized.cleanup };
}
```

- [ ] **Step 4: Run test + full backtester suite**

Run: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test/overlay-sandbox-deps.test.ts`
Expected: PASS.

Run: `pnpm exec vitest run apps/backtester/test`
Expected: PASS — existing worker/overlay tests green (bind mode default unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/test/overlay-sandbox-deps.test.ts
git commit -m "feat(worker): wire overlay sandbox volume mode (deps assembler + bundle baseDir)"
```

---

### Task 7: Dockerfile — install `docker` CLI + overlay harness + build `_engine`

**Files:**
- Modify: `Dockerfile`

**Interfaces:**
- Produces: a backtester image that has `docker` on PATH and the overlay harness at `apps/backtester/sandbox-harness-overlay/` (with a built `_engine/`).

- [ ] **Step 1: Add a failing verification (no code yet)**

Build the current image and confirm the two gaps, so the fix is evidence-based:

Run:
```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
docker build -t btx-test:pre .
docker run --rm --entrypoint sh btx-test:pre -c 'command -v docker || echo NO_DOCKER; ls apps/backtester/sandbox-harness-overlay/_engine 2>&1 | head -1'
```
Expected (pre-fix): prints `NO_DOCKER` and a "No such file or directory" for `_engine`.

- [ ] **Step 2: Implement — edit `Dockerfile`**

Add a CLI stage reference at the top (after the header comment, before `FROM node:22-slim`):
```dockerfile
# Docker CLI only (no daemon) for the DooD sandbox runner — pinned >=25 for `--mount volume-subpath`.
FROM docker:27-cli AS dockercli
```

After `RUN corepack enable`, copy the CLI in:
```dockerfile
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
```

Replace the harness COPY block (the line `COPY apps/backtester/sandbox-harness apps/backtester/sandbox-harness/`) with both harnesses + the build scripts, and build `_engine` after `pnpm install`:
```dockerfile
# sandbox harnesses are required at runtime (strategy + overlay sandbox execution)
COPY apps/backtester/sandbox-harness apps/backtester/sandbox-harness/
COPY apps/backtester/sandbox-harness-overlay apps/backtester/sandbox-harness-overlay/
COPY apps/backtester/scripts apps/backtester/scripts/
```

After the existing `RUN pnpm --filter @trading-backtester/sdk build` line, add the overlay `_engine` build:
```dockerfile
# Build the overlay harness _engine (gitignored; compiled from src/engine/indicators/**).
RUN node apps/backtester/scripts/build-sandbox-harness-overlay.mjs
```

> NOTE for the implementer: `build-sandbox-harness-overlay.mjs` runs `node_modules/.bin/tsc`. The image installs with `pnpm install --frozen-lockfile --ignore-scripts` BEFORE `ENV NODE_ENV=production`, so devDeps (incl. typescript) are present. If `tsc` is missing at build (e.g. lockfile prunes it), fall back: run the build on the host (`node apps/backtester/scripts/build-sandbox-harness-overlay.mjs`) and `COPY apps/backtester/sandbox-harness-overlay/_engine apps/backtester/sandbox-harness-overlay/_engine/` instead of the in-image `RUN`. Pick one; do not ship both.

- [ ] **Step 3: Build + verify the fix**

Run:
```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
docker build -t btx-test:post .
docker run --rm --entrypoint sh btx-test:post -c 'docker --version && ls apps/backtester/sandbox-harness-overlay/_engine/engine.js && ls apps/backtester/sandbox-harness-overlay/_engine/.build-manifest.json'
```
Expected (post-fix): prints `Docker version 27.x`, the `engine.js` path, and the `.build-manifest.json` path — no errors.

- [ ] **Step 4: Clean up test images**

Run: `docker image rm btx-test:pre btx-test:post 2>/dev/null || true`

- [ ] **Step 5: Commit**

```bash
git add Dockerfile
git commit -m "build(sandbox): docker CLI + overlay harness (_engine) in the backtester image"
```

---

## Final verification (after all tasks)

- [ ] Run the whole backtester suite: `cd /home/alexxxnikolskiy/projects/trading-backtester && pnpm exec vitest run apps/backtester/test` → all green.
- [ ] Typecheck (if a script exists): `pnpm -C apps/backtester exec tsc --noEmit` (or the repo's configured typecheck) → no errors.
- [ ] Confirm bind-mode run-args are byte-for-byte unchanged (the `docker-run-args.test.ts` bind cases assert this).
- [ ] Spot-check: `git log --oneline` shows 7 focused commits; legacy `src/sandbox/*` untouched (`git diff --name-only main... | grep 'src/sandbox/'` is empty).

## Companion (trading-lab) — separate branch/PR, sequenced AFTER this plan lands

Not part of this plan's tasks; recorded so the contract is unambiguous. Detailed in its own trading-lab spec/plan:
- `docker-compose.yml` + `docker-compose.demo.yml`: mount `/var/run/docker.sock` into `backtester`; declare volume `btx-sandbox`; mount it at `/sandbox-shared`; set `BACKTESTER_SANDBOX_OVERLAY_VOLUME=btx-sandbox` + `BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT=/sandbox-shared`; use the docker-CLI-bearing image.
- Dev orchestration script (minimal-docker): `docker compose up -d postgres redis mock-platform` + app services as host processes (backtester on host → bind mode).
