// 019 — SandboxModuleExecutor (US2; data-model §0/§8.2, contracts/sandbox-executor-api; FR-008/009/010/015).
//
// Реализация 018 `ModuleExecutor` seam, исполняющая хуки untrusted-bundle в Docker-контейнере на
// сессию (один на символ). Драйвит strategy/overlay-хуки через SandboxSession, ревалидирует
// возвращённые решения `DecisionRevalidator`'ом ДО risk/execution. Любой сбой/невалидное решение →
// fail-closed ([], 0 ордеров) + накопление `SandboxErrorArtifact` (диагностика; FR-025). Host НЕ
// импортирует код модуля — общение только через сериализованный IPC (FR-010).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StrategyContext } from '@trading/research-contracts/research';
import type { OverlayDecision, StrategyDecision } from '@trading/research-contracts/research';
import type {
  HypothesisOverlayModule,
  LifecycleHook,
  StrategyModule,
} from '@trading/research-contracts/research';
import type { ModuleExecutor } from '../module-executor.js';
import type { ModuleBundle } from './bundle.js';
import type { SandboxPolicy } from '../sandbox-policy.js';
import { DockerDriver } from './docker-driver.js';
import { SandboxSession, type SessionError } from './sandbox-session.js';
import { DecisionRevalidator } from './decision-revalidator.js';
import { type SandboxErrorArtifact, boundedRedactedDetail } from './errors.js';

/** Зависимости исполнителя (для тестируемости/инъекции harness-каталога). */
export interface SandboxExecutorDeps {
  readonly driver?: DockerDriver;
  readonly harnessDir?: string; // абсолютный путь к dist/src/research/sandbox-harness
}

/** Каталог собранного harness по умолчанию (dist/src/research/sandbox-harness). */
export function defaultHarnessDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sandbox-harness');
}

/** Исполнитель хуков bundle в sandbox-контейнере; реализует 018 ModuleExecutor seam. */
export class SandboxModuleExecutor implements ModuleExecutor {
  private readonly sessions = new Map<string, SandboxSession>();
  private readonly revalidator = new DecisionRevalidator();
  private readonly driver: DockerDriver;
  private readonly harnessDir: string;
  private readonly collectedErrors: SandboxErrorArtifact[] = [];

  constructor(
    private readonly bundle: ModuleBundle,
    private readonly policy: SandboxPolicy,
    deps?: SandboxExecutorDeps,
  ) {
    this.driver = deps?.driver ?? new DockerDriver();
    this.harnessDir = deps?.harnessDir ?? defaultHarnessDir();
  }

  /** Накопленные ошибки исполнения (для verify/диагностики US6). */
  get errors(): readonly SandboxErrorArtifact[] {
    return this.collectedErrors;
  }

  private sessionFor(ctx: StrategyContext): SandboxSession {
    let s = this.sessions.get(ctx.symbol);
    if (s === undefined) {
      s = new SandboxSession(
        this.bundle,
        this.policy,
        {
          runId: ctx.run.runId,
          symbol: ctx.symbol,
          seed: ctx.run.seed,
          params: ctx.params,
          kind: this.bundle.manifest.kind === 'overlay' ? 'overlay' : 'strategy',
        },
        this.driver,
        this.harnessDir,
      );
      this.sessions.set(ctx.symbol, s);
    }
    return s;
  }

  private record(err: SessionError, ctx: StrategyContext): void {
    const moduleRef = { id: this.bundle.manifest.id, version: this.bundle.manifest.version };
    // bounded (≤ maxStderrBytes + truncation-маркер) + redacted (0 секретов/env/abs-путей).
    const detail = boundedRedactedDetail(err.detail, this.policy.limits.maxStderrBytes);
    this.collectedErrors.push({
      code: err.code,
      severity: 'error',
      moduleRef,
      runId: ctx.run.runId,
      hook: err.hook as LifecycleHook | undefined,
      symbol: ctx.symbol,
      barIndex: err.barIndex,
      detail,
    });
    // Surface the fail-closed sandbox error: otherwise it is silent (the host returns [] and the run
    // continues DEGRADED — the variant behaves like baseline → all-zero metric deltas downstream,
    // which is hard to attribute). Detail is already bounded + redacted, so this is safe to log.
    console.warn(
      `[sandbox] fail-closed module=${moduleRef.id}@${moduleRef.version} hook=${err.hook ?? '?'}` +
        ` symbol=${ctx.symbol} run=${ctx.run.runId} code=${err.code} detail=${detail}`,
    );
  }

  initStrategy(_module: StrategyModule, ctx: StrategyContext): void {
    const s = this.sessionFor(ctx);
    const opened = s.open();
    if (!opened.ok) {
      if (opened.error !== undefined) this.record(opened.error, ctx);
      return;
    }
    if (this.bundle.manifest.hooks.includes('init')) {
      const r = s.callHook('init', ctx);
      if (!r.ok && r.error !== undefined) this.record(r.error, ctx);
    }
  }

  executeStrategyHook(
    _module: StrategyModule,
    hook: LifecycleHook,
    ctx: StrategyContext,
  ): readonly StrategyDecision[] {
    const r = this.sessionFor(ctx).callHook(hook, ctx);
    if (!r.ok) {
      if (r.error !== undefined) this.record(r.error, ctx);
      return [];
    }
    const rv = this.revalidator.revalidateStrategy(r.decisions);
    if (!rv.ok) {
      this.record({ code: 'decision_schema_invalid', detail: rv.message, hook }, ctx);
      return [];
    }
    return rv.decisions;
  }

  executeOverlayApply(_overlay: HypothesisOverlayModule, ctx: StrategyContext): readonly OverlayDecision[] {
    const r = this.sessionFor(ctx).callHook('apply', ctx);
    if (!r.ok) {
      if (r.error !== undefined) this.record(r.error, ctx);
      return [];
    }
    const rv = this.revalidator.revalidateOverlay(r.decisions);
    if (!rv.ok) {
      this.record({ code: 'decision_schema_invalid', detail: rv.message, hook: 'apply' }, ctx);
      return [];
    }
    return rv.decisions;
  }

  disposeStrategy(_module: StrategyModule, ctx: StrategyContext): void {
    const s = this.sessions.get(ctx.symbol);
    if (s !== undefined && this.bundle.manifest.hooks.includes('dispose')) {
      const r = s.callHook('dispose', ctx);
      if (!r.ok && r.error !== undefined) this.record(r.error, ctx);
    }
  }

  /** Teardown всех сессий (docker rm -f) — детерминированная очистка. */
  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
