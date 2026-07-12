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
import { type ModuleExecutor, firstDecision } from '../module-executor.js';
import type { ModuleBundle } from './bundle.js';
import type { SandboxPolicy } from '../sandbox-policy.js';
import { DockerDriver } from './docker-driver.js';
import { SandboxSession, type SessionError } from './sandbox-session.js';
import type { MountConfig } from './mounts.js';
import { DecisionRevalidator } from './decision-revalidator.js';
import { type SandboxErrorArtifact, boundedRedactedDetail } from './errors.js';

/** Зависимости исполнителя (для тестируемости/инъекции harness-каталога). */
export interface SandboxExecutorDeps {
  readonly driver?: DockerDriver;
  readonly harnessDir?: string; // абсолютный путь к dist/src/research/sandbox-harness
  // Опциональный disambiguator имени контейнера, прокидываемый в SessionConfig. Прод НЕ задаёт
  // (см. SessionConfig.containerSuffix) — только тесты, чтобы параллельные файлы с одинаковым
  // runId/символом не создавали одноимённые контейнеры.
  readonly containerSuffix?: string;
  readonly mount?: MountConfig; // bind (default) | volume (DooD). Threaded into each SandboxSession.
  // Universe mode (Task 7): when `enabled`, `sessionFor` collapses to ONE shared session (keyed by a
  // constant, not ctx.symbol) and the config threaded into it carries `universe`/`bundleHash` so
  // SandboxSession runs its per-symbol-init/bookkeeping path (Tasks 4-6). `n`/`memBaseMb`/
  // `memPerSymbolMb` are consumed by the ROUTER (deriveUniversePolicy), not the executor itself —
  // carried here only so the executor can pass `enabled` through to SessionConfig.universe.
  readonly universe?: {
    readonly enabled: boolean;
    readonly n: number;
    readonly memBaseMb: number;
    readonly memPerSymbolMb: number;
  };
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
  private readonly containerSuffix?: string;
  private readonly mount: MountConfig;
  private readonly universe?: SandboxExecutorDeps['universe'];
  private readonly collectedErrors: SandboxErrorArtifact[] = [];

  constructor(
    private readonly bundle: ModuleBundle,
    private readonly policy: SandboxPolicy,
    deps?: SandboxExecutorDeps,
  ) {
    this.driver = deps?.driver ?? new DockerDriver();
    this.harnessDir = deps?.harnessDir ?? defaultHarnessDir();
    this.containerSuffix = deps?.containerSuffix;
    this.mount = deps?.mount ?? { mode: 'bind' };
    this.universe = deps?.universe;
  }

  /** Накопленные ошибки исполнения (для verify/диагностики US6). */
  get errors(): readonly SandboxErrorArtifact[] {
    return this.collectedErrors;
  }

  private sessionFor(ctx: StrategyContext): SandboxSession {
    // Universe mode: ONE shared session (keyed by a constant) serves every symbol instead of one
    // session per symbol — the collapse this task implements. Flag off (undefined/false) keys by
    // ctx.symbol, byte-identical to pre-Task-7 behavior.
    const key = this.universe?.enabled === true ? '__universe__' : ctx.symbol;
    let s = this.sessions.get(key);
    if (s === undefined) {
      s = new SandboxSession(
        this.bundle,
        this.policy,
        {
          runId: ctx.run.runId,
          symbol: ctx.symbol, // seeds the first symbol; universe mode inits each symbol per-hook
          seed: ctx.run.seed,
          params: ctx.params,
          kind: this.bundle.manifest.kind === 'overlay' ? 'overlay' : 'strategy',
          containerSuffix: this.containerSuffix,
          universe: this.universe?.enabled === true,
          bundleHash: this.bundle.descriptor.bundleHash,
        },
        this.driver,
        this.harnessDir,
        this.mount,
      );
      this.sessions.set(key, s);
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

  async initStrategy(_module: StrategyModule, ctx: StrategyContext): Promise<void> {
    const s = this.sessionFor(ctx);
    const opened = await s.open();
    if (!opened.ok) {
      if (opened.error !== undefined) this.record(opened.error, ctx);
      return;
    }
    if (this.bundle.manifest.hooks.includes('init')) {
      const r = await s.callHook('init', ctx);
      if (!r.ok && r.error !== undefined) this.record(r.error, ctx);
    }
  }

  async executeStrategyHook(
    _module: StrategyModule,
    hook: LifecycleHook,
    ctx: StrategyContext,
  ): Promise<readonly StrategyDecision[]> {
    const r = await this.sessionFor(ctx).callHook(hook, ctx);
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

  /**
   * 17b: batch variant of `executeStrategyHook` — one IPC message covering a flat stretch, with
   * early stop on the first non-empty decision. Fail-closed mirror of `executeStrategyHook`'s
   * record+empty semantics: a session error records the diagnostic and returns an empty-decision
   * result whose `stoppedAt` is clamped into `[0, ctxs.length - 1]` (never negative) so the engine
   * always makes forward progress by at least one bar, exactly like a lockstep failure would.
   */
  async executeStrategyHookBatch(
    _module: StrategyModule,
    ctxs: readonly StrategyContext[],
  ): Promise<{ stoppedAt: number; decisions: readonly StrategyDecision[] }> {
    const r = await this.sessionFor(ctxs[0]!).callHookBatch(ctxs);
    if (!r.ok) {
      if (r.error !== undefined) this.record(r.error, ctxs[Math.max(0, r.stoppedAt + 1)] ?? ctxs[0]!);
      // Fail-closed mirror of lockstep: completed prefix bars stand; the failing bar contributes
      // empty decisions; the run continues (subsequent calls fail fast on the dead session).
      return { stoppedAt: Math.max(0, Math.min(r.stoppedAt + 1, ctxs.length - 1)), decisions: [] };
    }
    const rv = this.revalidator.revalidateStrategy(r.decisions);
    if (!rv.ok) {
      this.record({ code: 'decision_schema_invalid', detail: rv.message, hook: 'onBarClose' }, ctxs[r.stoppedAt]!);
      return { stoppedAt: r.stoppedAt, decisions: [] };
    }
    return { stoppedAt: r.stoppedAt, decisions: rv.decisions };
  }

  /**
   * Slice B: bar-major transport collapse. Universe mode → ONE shared session, ONE `callHookBarMajor`
   * round-trip covering every item (the real collapse); results come back index-aligned with `items`
   * (incl. latched-symbol remap, done inside `callHookBarMajor` — do NOT re-partition here). Each
   * per-item error/invalid-schema result is recorded + degrades to `{ kind: 'idle' }` for THAT item
   * only, mirroring `executeStrategyHookBatch`'s revalidate/record shape.
   *
   * Non-universe sandbox: per-symbol sessions mean no batch collapse is possible — fall back to the
   * same lockstep loop as the trusted executor (byte-identical decisions, just no IPC savings).
   */
  async executeStrategyHookBarMajor(
    items: readonly { module: StrategyModule; ctx: StrategyContext }[],
  ): Promise<readonly StrategyDecision[]> {
    if (items.length === 0) return [];
    if (this.universe?.enabled === true) {
      const session = this.sessionFor(items[0]!.ctx); // universe → one shared session
      const results = await session.callHookBarMajor(items.map((it) => it.ctx));
      return results.map((r, i) => {
        if (!r.ok) {
          if (r.error !== undefined) this.record(r.error, items[i]!.ctx);
          return { kind: 'idle' } as StrategyDecision; // fail-closed base (== firstDecision([]))
        }
        const rv = this.revalidator.revalidateStrategy(r.decisions);
        if (!rv.ok) {
          this.record({ code: 'decision_schema_invalid', detail: rv.message, hook: 'onBarClose' }, items[i]!.ctx);
          return { kind: 'idle' } as StrategyDecision;
        }
        return firstDecision(rv.decisions);
      });
    }
    // non-universe sandbox → no batch collapse possible (per-symbol sessions); loop lockstep.
    const out: StrategyDecision[] = [];
    for (const it of items) {
      out.push(firstDecision(await this.executeStrategyHook(it.module, 'onBarClose', it.ctx)));
    }
    return out;
  }

  async executeOverlayApply(_overlay: HypothesisOverlayModule, ctx: StrategyContext): Promise<readonly OverlayDecision[]> {
    const r = await this.sessionFor(ctx).callHook('apply', ctx);
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

  async disposeStrategy(_module: StrategyModule, ctx: StrategyContext): Promise<void> {
    const key = this.universe?.enabled === true ? '__universe__' : ctx.symbol;
    const s = this.sessions.get(key);
    if (s !== undefined && this.bundle.manifest.hooks.includes('dispose')) {
      const r = await s.callHook('dispose', ctx);
      if (!r.ok && r.error !== undefined) this.record(r.error, ctx);
    }
  }

  /** Teardown всех сессий (docker rm -f) — детерминированная очистка. */
  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
