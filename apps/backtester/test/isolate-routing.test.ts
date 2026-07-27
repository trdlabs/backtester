// POC (analysis/18 вариант A) — выбор sandbox-бэкенда в ExecutorRouter: 'docker' (дефолт,
// байт-идентичный прежнему поведению) | 'isolate' (IsolateModuleExecutor in-process).

import { describe, expect, it } from 'vitest';
import type { ModuleManifest } from '@trading/research-contracts/research';
import type { ModuleBundle } from '../src/engine/sandbox/bundle.js';
import { createExecutorRouter } from '../src/engine/sandbox/routing.js';
import { SandboxModuleExecutor } from '../src/engine/sandbox/sandbox-executor.js';
import { IsolateModuleExecutor } from '../src/engine/sandbox/isolate-executor.js';

const bundle: ModuleBundle = {
  bundleDir: '/nonexistent/poc-routing-bundle',
  manifest: { id: 'poc_routing', version: '1.0.0', kind: 'strategy', hooks: ['onBarClose'] } as unknown as ModuleManifest,
  descriptor: {
    contractVersion: '1.0.0',
    kind: 'strategy',
    entryPoint: 'module/index.js',
    files: [],
    bundleHash: `sha256:${'cd'.repeat(32)}`,
  },
};

const resolved = {
  module: {} as never,
  manifest: bundle.manifest,
  provenance: 'bundle' as const,
  bundle,
};

describe('createExecutorRouter — sandboxBackend (POC analysis/18 A)', () => {
  it("дефолт (флага нет) → docker-исполнитель, байт-идентично прежнему поведению", () => {
    const router = createExecutorRouter({});
    expect(router.forStrategy(resolved)).toBeInstanceOf(SandboxModuleExecutor);
    router.closeAll();
  });

  it("sandboxBackend:'isolate' → IsolateModuleExecutor для bundle-provenance", () => {
    const router = createExecutorRouter({ sandboxBackend: 'isolate' });
    expect(router.forStrategy(resolved)).toBeInstanceOf(IsolateModuleExecutor);
    router.closeAll();
  });

  it("isolate + universe → fail-fast (комбинация не поддержана POC)", () => {
    const router = createExecutorRouter({
      sandboxBackend: 'isolate',
      universe: { enabled: true, n: 4, memBaseMb: 128, memPerSymbolMb: 8 },
    });
    expect(() => router.forStrategy(resolved)).toThrow(/universe/);
    router.closeAll();
  });
});
