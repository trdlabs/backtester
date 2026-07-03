// 019 — SandboxSession (US2; research R5, data-model §4; FR-011).
//
// Один долгоживущий контейнер на (модуль, символ): open → init → hook×N → dispose → close.
// Instance модуля и его состояние живут ВНУТРИ контейнера (harness) между хуками; host на каждый
// вызов инжектирует свежий read-only snapshot (state не пересекает границу). Любое нарушение →
// fail-closed: контейнер убивается, последующие вызовы немедленно возвращают пустой результат + код.

import type { StrategyContext } from '@trading/research-contracts/research';
import type { ModuleBundle } from './bundle.js';
import type { SandboxPolicy } from '../sandbox-policy.js';
import { DockerDriver, type SpawnedContainer, sessionContainerName } from './docker-driver.js';
import { AsyncIpcChannel } from './async-ipc-channel.js';
import { serializeContext, plainBar } from './context-serializer.js';
import type { SandboxValidationCode } from './errors.js';
import { toMountSource, type MountConfig } from './mounts.js';

/** Ошибка одного вызова (стабильный код + bounded detail + хук-контекст). */
export interface SessionError {
  readonly code: SandboxValidationCode;
  readonly detail: string;
  readonly hook?: string;
  readonly barIndex?: number;
}

/** Результат вызова хука: при ok — decisions (для ревалидации); иначе fail-closed + error. */
export interface HookResult {
  readonly ok: boolean;
  readonly decisions: readonly unknown[];
  readonly error?: SessionError;
}

// Допуск на СТАРТ контейнера (docker run + node + import bundle) — инфраструктурная задержка,
// НЕ относится к compute-квоте хука (FR-020 ограничивает время ВЫЧИСЛЕНИЯ хука). Амортизируется
// одним стартом на сессию; per-hook deadline (wallTimeMsPerCall) применяется ПОСЛЕ старта.
const CONTAINER_STARTUP_GRACE_MS = 30_000;

/** Параметры открытия сессии. */
export interface SessionConfig {
  readonly runId: string;
  readonly symbol: string;
  readonly seed: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly kind: 'strategy' | 'overlay';
  // Опциональный disambiguator имени контейнера. Прод НЕ задаёт (имя детерминировано по FR-024 —
  // runId уникален по построению). Используется только тестами, где несколько параллельных файлов
  // переиспользуют один и тот же runId/символ и иначе создавали бы одноимённые контейнеры.
  readonly containerSuffix?: string;
}

/** Сессия sandbox-исполнения одного модуля на одном символе. */
export class SandboxSession {
  private container?: SpawnedContainer;
  private channel?: AsyncIpcChannel;
  private seq = 0;
  private barIndex = -1;
  private lastBarTs: number | undefined;
  private sessionDeadlineEpoch = Number.POSITIVE_INFINITY;
  private failed = false;
  private lastError?: SessionError;
  // BACKTESTER_IPC_PROFILE=true: accumulate per-session IPC-wait/open timings, dumped on close().
  private static readonly profileEnabled = process.env.BACKTESTER_IPC_PROFILE === 'true';
  private profOpenMs = 0;
  private profIpcWaitMs = 0;
  private profHookCalls = 0;
  private profClosed = false;

  constructor(
    private readonly bundle: ModuleBundle,
    private readonly policy: SandboxPolicy,
    private readonly cfg: SessionConfig,
    private readonly driver: DockerDriver,
    private readonly harnessDir: string,
    private readonly mount: MountConfig = { mode: 'bind' },
  ) {}

  /** Был ли зафиксирован сбой (для агрегации в executor). */
  get error(): SessionError | undefined {
    return this.lastError;
  }

  private fail(error: SessionError): HookResult {
    this.failed = true;
    this.lastError = error;
    this.close();
    return { ok: false, decisions: [], error };
  }

  /** Открыть контейнер и проинициализировать harness (загрузка bundle + инстанцирование). */
  async open(): Promise<HookResult> {
    const profT0 = SandboxSession.profileEnabled ? performance.now() : 0;
    const res = await this.openInner();
    if (SandboxSession.profileEnabled) this.profOpenMs += performance.now() - profT0;
    return res;
  }

  private async openInner(): Promise<HookResult> {
    const { manifest, descriptor, bundleDir } = this.bundle;
    const name = sessionContainerName(
      this.cfg.runId,
      manifest.id,
      manifest.version,
      this.cfg.symbol,
      this.cfg.containerSuffix,
    );
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
    this.channel = new AsyncIpcChannel(
      this.container.child.stdin,
      this.container.child.stdout,
      this.container.child.stderr,
      this.policy.limits,
    );

    this.channel.send({
      t: 'init',
      runId: this.cfg.runId,
      moduleRef: { id: manifest.id, version: manifest.version },
      symbol: this.cfg.symbol,
      kind: this.cfg.kind,
      seed: this.cfg.seed,
      params: this.cfg.params,
      manifestHooks: manifest.hooks,
      entryPoint: descriptor.entryPoint,
    });
    // Старт контейнера + загрузка bundle: startup-grace (не compute-квота). Compute-бюджет сессии
    // (wallTimeMsPerSession) стартует ПОСЛЕ успешного init.
    const outcome = await this.channel.receive(Date.now() + CONTAINER_STARTUP_GRACE_MS);
    if (outcome.kind === 'ok') {
      this.sessionDeadlineEpoch = Date.now() + this.policy.limits.wallTimeMsPerSession;
      return { ok: true, decisions: [] };
    }
    return this.fail(this.mapFailure(outcome, 'init', 'bundle_load_failed'));
  }

  /** Вызвать lifecycle-хук модуля внутри сессии; вернуть сырые decisions (ревалидация — в executor). */
  async callHook(hook: string, ctx: StrategyContext): Promise<HookResult> {
    if (this.failed) {
      return { ok: false, decisions: [], error: this.lastError };
    }
    if (this.channel === undefined) {
      const opened = await this.open();
      if (!opened.ok) return opened;
    }
    const channel = this.channel;
    if (channel === undefined) return { ok: false, decisions: [], error: this.lastError };

    // newBar: при переходе на новый бар (ts) — закрытая свеча t; повторный хук того же бара → null.
    let newBar = null as ReturnType<typeof plainBar> | null;
    // 023: инкрементальная подача OI/liq минуты t (зеркало newBar), ТОЛЬКО на переходе бара и ТОЛЬКО
    // если лента несёт kind (composition-following). null = gap(t); undefined (опущено) = kind'а нет.
    let newOi: { ts: number; oiTotalUsd: number } | null | undefined;
    let newLiq: { ts: number; longUsd: number; shortUsd: number } | null | undefined;
    if (ctx.bar.ts !== this.lastBarTs) {
      this.barIndex += 1;
      this.lastBarTs = ctx.bar.ts;
      newBar = plainBar(ctx.bar);
      const m = ctx.market;
      if (m !== undefined) {
        if (m.oiWindow(1).length > 0) newOi = m.oiAsOf() ?? null;
        if (m.liqWindow(1).length > 0) newLiq = m.liqAsOf() ?? null;
      }
    }
    this.seq += 1;
    channel.send({
      t: 'hook',
      seq: this.seq,
      hook,
      snapshot: serializeContext(ctx, this.barIndex),
      newBar,
      ...(newOi !== undefined ? { newOi } : {}),
      ...(newLiq !== undefined ? { newLiq } : {}),
    });

    const profT0 = SandboxSession.profileEnabled ? performance.now() : 0;
    const outcome = await channel.receive(this.callDeadline());
    if (SandboxSession.profileEnabled) {
      this.profIpcWaitMs += performance.now() - profT0;
      this.profHookCalls += 1;
    }
    if (outcome.kind === 'ok') return { ok: true, decisions: outcome.decisions };
    return this.fail(this.mapFailure(outcome, hook, 'sandbox_crashed'));
  }

  /** Закрыть контейнер: EOF на stdin + принудительная детерминированная очистка (idempotent). */
  close(): void {
    if (SandboxSession.profileEnabled && !this.profClosed && this.profHookCalls > 0) {
      this.profClosed = true;
      console.error(JSON.stringify({
        evt: 'ipc_profile',
        kind: this.cfg.kind,
        symbol: this.cfg.symbol,
        hookCalls: this.profHookCalls,
        ipcWaitMs: Math.round(this.profIpcWaitMs),
        openMs: Math.round(this.profOpenMs),
        avgIpcWaitMsPerHook: Number((this.profIpcWaitMs / this.profHookCalls).toFixed(3)),
      }));
    }
    const c = this.container;
    if (c === undefined) return;
    this.container = undefined;
    this.channel = undefined;
    // Close stdin THROUGH the stream (not closeSync on a raw fd): the AsyncIpcChannel holds a
    // live Writable over child.stdin, so closing the bare fd underneath it left a dangling
    // socket on a reused fd → EBADF cross-talk into the next session's container.
    try {
      c.child.stdin.destroy();
    } catch {
      /* already torn down */
    }
    this.driver.dispose(c.name);
  }

  private callDeadline(): number {
    return Math.min(Date.now() + this.policy.limits.wallTimeMsPerCall, this.sessionDeadlineEpoch);
  }

  /** Преобразовать неуспешный receive в SessionError со стабильным кодом. */
  private mapFailure(
    outcome: Exclude<Awaited<ReturnType<AsyncIpcChannel['receive']>>, { kind: 'ok' }>,
    hook: string,
    eofCode: SandboxValidationCode,
  ): SessionError {
    const stderr = this.channel?.stderrText() ?? '';
    const barIndex = this.barIndex >= 0 ? this.barIndex : undefined;
    const e = (code: SandboxValidationCode, detail: string, h: string = hook): SessionError => ({
      code,
      detail,
      hook: h,
      barIndex,
    });
    switch (outcome.kind) {
      case 'timeout':
        return e('sandbox_timeout', `hook "${hook}" exceeded wall-time; ${stderr}`);
      case 'overflow':
        return e('sandbox_output_overflow', `output quota exceeded; ${stderr}`);
      case 'malformed':
        return e('sandbox_output_malformed', `${outcome.detail}; ${stderr}`);
      case 'eof': {
        // Контейнер вышел: различаем OOM (cgroup) от прочего краша через docker inspect (T031).
        const state = this.container !== undefined ? this.driver.inspectState(this.container.name) : undefined;
        if (state !== undefined && (state.oomKilled || state.exitCode === 137)) {
          return e('sandbox_memory_exceeded', `OOM-killed (exit ${state.exitCode}); ${stderr}`);
        }
        return e(eofCode, `container exited unexpectedly; ${stderr}`);
      }
      case 'err':
        return e(outcome.code as SandboxValidationCode, outcome.detail || stderr, outcome.hook ?? hook);
      default: {
        const exhaustive: never = outcome;
        return e('sandbox_crashed', `unknown outcome ${String(exhaustive)}`);
      }
    }
  }
}
